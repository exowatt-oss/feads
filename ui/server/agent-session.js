/**
 * feads addition — signing in and signing up from the browser.
 *
 * Three routes: `POST /api/agent/login` (paste a token you already have),
 * `POST /api/agent/signup` (create a brand new agent identity), and
 * `POST /api/agent/logout`. All three do exactly one thing to the browser — set or
 * clear the HttpOnly cookie described in `agent-cookie.js`. Everything afterwards —
 * who the connection is, what it may do — is `identity.js`'s job, unchanged: the
 * cookie is just another way to present the credential it already understood.
 *
 * ## Sign in: two kinds of token, dispatched by prefix
 *
 * The person pasting has one of two strings, and the difference matters:
 *
 * - **`fdsa_…`, an agent token.** The primary flow, and it is a *read*: the token is
 *   verified against the registry and stored. No registry write, no new agent, no
 *   new row. That is what makes the promised property true — the human pastes the
 *   same token their agent uses, so the browser resolves to the same agent, sees the
 *   same board, and is held to the same tier. Registering a *second* identity for
 *   the human would have produced a different agent that merely looked similar, and
 *   then a `user` could not delete its own agent's items, because `created_by` would
 *   not match.
 * - **`fdsi_…`, an invite.** Redeemed once, minting an agent token which is then
 *   stored.
 *
 * Anything else is refused with no cookie set. Guessing — treating an unprefixed
 * string as one kind or the other — would turn a paste of the wrong thing into a
 * confusing registry error instead of "that is not a feads token".
 *
 * ## Sign up: one call, and the human holds the agent's token
 *
 * `signupAgent` mints an invite and redeems it in one go, returning the resulting
 * **agent** token. That is the right primitive for a browser sign-up rather than
 * mint-then-hand-over, because the human ends up holding the very token their agent
 * will present — so "you see what your agent sees" is literally true from the first
 * second, and there is no window in which an unredeemed invite sits in a page
 * waiting to be lost. It also revokes its own invite if redemption fails, so the
 * failure path is not reimplemented here.
 *
 * Creating a `user` identity is open to everyone, anonymous visitors included; that
 * is the only way a first-time visitor can obtain an identity at all, and requiring
 * an identity to get one is a closed loop. The **admin** tier is not offered here and
 * `boards/authz.mjs` refuses it for an anonymous caller regardless, because
 * self-service admin would make the delete rules decorative. The route asks the
 * policy anyway rather than assuming: under `FEADS_REQUIRE_AGENT=1` the stance is
 * `deny` and sign-up is refused.
 *
 * ## This writes the registry, in process, on purpose
 *
 * An earlier draft shelled out to `scripts/feads-agent.mjs` on the theory that the
 * UI server should only ever *read* the registry and that redemption's single-use
 * guarantee needed a single writer. **That reasoning was wrong and is deliberately
 * retired — do not restore it.** The guarantee is SQL: `BEGIN IMMEDIATE`, a
 * conditional `UPDATE … WHERE redeemed_at = 0`, and a partial unique index on the
 * live actor name, over a WAL database. It holds across processes, so it never
 * depended on there being only one writer, and a subprocess bought nothing but
 * latency, a second copy of the error taxonomy, and a dependency on a CLI a published
 * package does not ship.
 *
 * The registry file itself is still never *created* here, matching `identity.js`:
 * authorship of the registry and of board rows belongs to the CLI, and a board has to
 * be registered before an agent can reference it. A missing registry is reported, not
 * fixed — and note that it is also the case in which `identity.js` degrades the
 * stance to operator, so the login panel is not even offered.
 *
 * ## Where the token may and may not go
 *
 * Sign-in with an *agent token* never returns a token: the human already has it, so
 * echoing it would be pure exposure — the client composes its "connect your agent"
 * snippet from the value it already has in the form field. **Sign-up does** return
 * one, exactly once, and has to: only a hash is stored, so a token nobody was shown
 * is a token nobody can use, and the whole purpose of signing up is to hand it to an
 * agent. Sign-in with an *invite* is the same case in disguise — redemption mints an
 * agent token the reader has never seen — so that response carries the minted token
 * too, and the client swaps it into the snippet in place of the spent invite. That
 * is the only place a token crosses back to the browser, and the client keeps it in a
 * variable for the life of the panel and never in `localStorage` (see
 * `agent-login.js`).
 *
 * Nothing here logs a token, and any message relayed from the registry is scrubbed of
 * one first. `boards/agents.mjs` does not currently put a token in an error message,
 * but a response body is the wrong place to find out that it started.
 *
 * ## What logging in does not do
 *
 * It does not create a session, bind a device, or record an IP. Possession of the
 * token is the entire credential, the same as for an agent presenting it over MCP.
 * And it does not make this a security boundary: the shell next to the browser can
 * still run `bd delete` with no cookie at all. What it buys is that the dashboard
 * *acts as somebody* — the same somebody as the agent whose token it is.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRequestIdentity } from './accounts-http.js';
import { accountsOn, scopeIdentityBoard } from './accounts.js';
import { getSeedBoardDir } from './active-board.js';
import {
  agentTokenCookie,
  clearAgentTokenCookie,
  isSecureRequest,
  readAgentTokenCookie
} from './agent-cookie.js';
import {
  findRegistryBoard,
  findRegistryBoardByWorkspace
} from './board-registry.js';
import { decideFor, resolveIdentity } from './identity.js';
import { debug } from './logging.js';
import { resolveMcpEndpoint } from './mcp-endpoint.js';
import {
  isSiloBrowserMutationAllowed,
  resolveHttpActor
} from './notifications-engine.js';
import {
  assertValidSiloEnvironment,
  createPlatformSsoVerifier,
  isExactOrigin,
  siloMode
} from './platform-sso.js';
import {
  internalSsoEmail,
  isInternalSsoRequest,
  resolveSsoIdentityFromRegistry
} from './sso-identity.js';

const log = debug('agent-session');

/**
 * @typedef {{ ok: true, token: string, actor: string }} MintOk
 */

/**
 * @typedef {{ ok: false, status: number, code: string, message: string }} MintFailure
 */

/**
 * @typedef {Object} SessionRouteOptions
 * @property {string} [root_dir] - Workspace the new agent is recorded against, for
 * the roster's `workspace_dir` column.
 * @property {() => Promise<{ agents: any, registry: any } | null>} [loadRegistry] -
 * Test seam, the same shape `identity.js` uses.
 * @property {(board_dir?: string) => Promise<string>} [resolveBoardId] - Test seam
 * for "which board is this sign-up for".
 * @property {(options: { token?: string }) => Promise<import('./identity.js').ResolvedIdentity>} [resolve]
 *   - Test seam for identity resolution.
 * @property {Record<string, string | undefined>} [env] - Trusted deployment
 * environment and test seam.
 * @property {ReturnType<typeof createPlatformSsoVerifier>} [ssoVerifier]
 * @property {any} [accountsVerifier] - Accounts-mode SSO verifier (tests).
 */

/**
 * Load the registry modules.
 *
 * Dynamic and failure-tolerant for the same reason as `identity.js`: a published
 * beads-ui package has no `boards/` sibling. There the answer is not to guess but
 * "there is no registry here to sign in to", which is what the routes report.
 *
 * @returns {Promise<{ agents: any, registry: any } | null>}
 */
async function loadRegistryModules() {
  try {
    const [agents, registry] = await Promise.all([
      import('../../boards/agents.mjs'),
      import('../../boards/registry.mjs')
    ]);
    return { agents, registry };
  } catch (err) {
    log('agent registry module unavailable: %o', err);
    return null;
  }
}

/**
 * Run `fn` against an open registry, or answer `null` when there is none.
 *
 * Opened and closed per request rather than held, matching `identity.js`: these are
 * two SQLite statements on a login, and holding a handle open across an idle daemon
 * would keep a WAL reader alive for no benefit.
 *
 * `openRegistry()` would create and migrate the file, so its absence is checked
 * first. An absent registry means "nobody has registered anything", not "make one" —
 * see the module header.
 *
 * @template T
 * @param {SessionRouteOptions} options
 * @param {(agents: any, db: any) => T} fn
 * @returns {Promise<T | null>}
 */
async function withRegistry(options, fn) {
  const mods = await (options.loadRegistry || loadRegistryModules)();
  if (!mods) {
    return null;
  }
  /** @type {string} */
  let registry_path;
  try {
    registry_path = mods.registry.getRegistryPath(options.env || process.env);
  } catch (err) {
    log('cannot resolve registry path: %o', err);
    return null;
  }
  if (!fs.existsSync(registry_path)) {
    log('no registry at %s', registry_path);
    return null;
  }
  /** @type {any} */
  let db = null;
  try {
    db = mods.registry.openRegistry({ env: options.env || process.env });
    return fn(mods.agents, db);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Remove a token from anything about to be sent or logged.
 *
 * Defensive, not decorative: the value is a 128-bit credential, and an error path is
 * exactly where it would leak without anyone noticing.
 *
 * @param {string} text
 * @param {string} [secret]
 * @returns {string}
 */
function scrub(text, secret) {
  const token = String(secret || '').trim();
  const message = String(text || '');
  if (token.length === 0) {
    return message;
  }
  return message.split(token).join('«token»');
}

/**
 * The first line of a registry error, which is the part written for a human.
 *
 * `boards/agents.mjs` follows a message with indented "try this instead" lines naming
 * shell commands. Those are right for a terminal and wrong for a browser panel, where
 * they read as instructions the reader cannot follow from where they are.
 *
 * @param {string} message
 * @returns {string}
 */
function firstLine(message) {
  const lines = String(message || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[0] || '';
}

/**
 * Turn a thrown registry error into an HTTP answer.
 *
 * `TokenError` carries a machine-readable `reason`, which is why it is branched on
 * rather than the message: `redeemed` and `expired` need different words, and both
 * need to read as "ask for another one" rather than as a server fault.
 *
 * Matched on `name` rather than with `instanceof`. The class is reached through a
 * dynamic import and a test seam may supply its own module instance, in which case
 * `instanceof` is false for an error that is one — and the fallback for that is a
 * 500, which would misreport an ordinary expired invite as a bug.
 *
 * @param {unknown} err
 * @param {string} [secret]
 * @returns {MintFailure}
 */
function failureFor(err, secret) {
  const error = /** @type {any} */ (err);
  const message = firstLine(scrub(String(error?.message || ''), secret));
  if (error?.name === 'TokenError') {
    log('registry refused a token: %s', error.reason);
    return {
      ok: false,
      status: 401,
      code: 'token_rejected',
      message:
        error.reason === 'redeemed'
          ? 'that invite has already been used — invites are single-use, so ask ' +
            'for a fresh one, or set up a new agent instead'
          : error.reason === 'expired'
            ? 'that invite has expired — ask for a fresh one, or set up a new agent'
            : error.reason === 'revoked'
              ? 'that invite was revoked'
              : 'that is not an invite this board recognizes'
    };
  }
  // A name already in use is the one ordinary failure of sign-up, and the only one
  // the reader can fix from the form in front of them. Recognized by the message
  // because `createInvite` throws a plain Error for it.
  if (/already registered|already exists/i.test(message)) {
    log('name collision on signup');
    return {
      ok: false,
      status: 409,
      code: 'name_taken',
      message: message || 'that name is already taken on this board'
    };
  }
  log('registry write failed: %s', message);
  return {
    ok: false,
    status: 500,
    code: 'registry_failed',
    message: message || 'the agent registry could not complete that request'
  };
}

/**
 * How a sign-up reached this server, and what that means for the registry row.
 *
 * The `agents` row records where an identity *came from*, and that is the one thing it
 * exists to record — so it has to be right even though this endpoint is now called by
 * more than one thing. The MCP server proxies sign-up here rather than reimplementing
 * the registry writer (there is one implementation of redemption and its single-use
 * guarantee, and it should stay that way), and before this map every MCP-originated
 * agent was recorded as a human in a browser. The roster was lying about provenance.
 *
 * ## Why an enum and not the fields themselves
 *
 * The obvious shape — let the caller send `kind` and `created_by` — is unsafe, because
 * provenance is only worth recording if it cannot be chosen freely. A caller that could
 * write `created_by` could attribute a new identity to an actor who never created it,
 * and a caller that could write `kind` could label an automated sign-up as a person.
 * Both fields are therefore *derived* from a whitelisted surface name, and a `kind` or
 * `created_by` in the request body is ignored rather than honoured.
 *
 * ## Why an unknown value is an error
 *
 * Defaulting a typo to `browser` would mislabel provenance silently, which is strictly
 * worse than refusing: the row would look authoritative and be wrong, and nothing
 * downstream could tell. A 400 is noticed by whoever made the typo, at the moment they
 * made it.
 *
 * @type {Record<string, { kind: string, created_by: string }>}
 */
const SIGNUP_SURFACES = {
  // A person in a browser, holding the token they are about to hand to an agent. See
  // `SURFACE` in identity.js for the per-request half of the same distinction.
  browser: { kind: 'human', created_by: 'browser-signup' },
  // An agent registering itself over MCP. `kind: 'agent'` because no human was in the
  // loop; the provenance string names the surface rather than the agent, since the
  // caller was unidentified by definition — it is signing up.
  mcp: { kind: 'agent', created_by: 'mcp-signup' }
};

/** The surface assumed when a caller names none, so existing callers are unaffected. */
const DEFAULT_SIGNUP_SURFACE = 'browser';

/**
 * The registry id of the board a sign-up should register its agent against.
 *
 * Sign-up needs one, because `agents.board_id` references `boards.id` — an agent
 * cannot be registered against a board the registry has never heard of.
 *
 * ## Which board, now that boards are per connection
 *
 * There is no such thing as "the active board" any more, and this comment is the place
 * that sentence would otherwise have quietly become false. Board selection lives on the
 * WebSocket connection (see `active-board.js`), because two browser tabs can be looking
 * at two different boards. These are HTTP routes: a POST has no socket, so it has no
 * per-connection board, and nothing in its body is authenticated as belonging to any
 * particular tab — so this cannot go looking for "the caller's board" the way `ws.js`
 * can.
 *
 * So the caller *names* the board, and the seed board is the fallback:
 *
 * - **`board_dir` from the request body** — the `.beads` directory the caller is
 *   working on. A browser tab holds it in its workspace state; the MCP server knows the
 *   board it is operating against. Without it, signing up while viewing board B would
 *   register the agent against whichever board the daemon *started* on, and the new
 *   agent would then be invisible on the board its owner was looking at. That is a
 *   worse failure than it sounds, because the roster is board-scoped: the sign-up
 *   appears to succeed and the agent is simply nowhere.
 * - **the seed board** — the board the daemon started on, from `$BEADS_DIR` or
 *   discovery — when the body names none. That is the right answer for a caller with no
 *   board of its own: an unattached `curl`, or a client too old to send the field. It is
 *   emphatically *not* "whatever board somebody last selected in some tab", which is
 *   what this used to read and what made a sign-up land wherever the last switcher click
 *   happened to leave things.
 *
 * A named directory is looked up in the registry and only resolves if it is registered;
 * an unregistered one falls through to the caller's `409 board_unregistered` rather than
 * silently landing the agent somewhere else. So this grants nothing new — the set of
 * reachable boards is exactly what it was when a caller could reach any of them by
 * switching the (then global) board first and posting afterwards.
 *
 * ## Three ways to spell the same directory
 *
 * A caller that *has* a board in mind should be homed on it, and the failure worth
 * avoiding is a near-miss falling back to the seed. Callers spell it three ways, so
 * three are tried in order of directness:
 *
 *   1. as given — a registry id, or the `.beads` directory itself;
 *   2. `<dir>/.beads` — a caller naming its project root, which is what a human types
 *      and what a workspace-scoped client knows;
 *   3. a board whose registered `workspace_dir` is that tree — the case a checkout
 *      whose board lives elsewhere (`--workspace`) could not express at all.
 *
 * A near-miss resolving to the *wrong* board is not a risk here: each step matches an
 * exact path against a registered one, so the alternative to a match is no match, and
 * the fallback below is what "no match" already meant.
 *
 * Read at request time rather than captured at startup, so a seed correction — or a
 * board registered after the daemon booted — is honoured.
 *
 * Exported so the resolution order above can be proven against a real registry. The
 * routes reach it through `options.resolveBoardId`, whose default it is.
 *
 * @param {string} [board_dir] - The board the caller says it is looking at.
 * @returns {Promise<string>}
 */
export async function boardIdFor(board_dir) {
  const named = String(board_dir || '').trim();
  const dir = named.length > 0 ? named : getSeedBoardDir();
  if (!dir) {
    return '';
  }
  const board =
    (await findRegistryBoard(dir)) ||
    (await findRegistryBoard(path.join(dir, '.beads'))) ||
    (await findRegistryBoardByWorkspace(dir));
  return board ? String(board.id || '') : '';
}

/**
 * The caveat every identity answer carries about the `board_id` it reports.
 *
 * Canonical text lives in `boards/agents.mjs` beside the column it describes, and is
 * read through a dynamic import for the reason every other `boards/` read here is: a
 * published beads-ui package has no `boards/` sibling, and the dashboard must still
 * serve. When it cannot be loaded the responses simply carry no note — a missing
 * caveat is a degradation, a crashed login is not.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function homeBoardNote() {
  try {
    const agents = await import('../../boards/agents.mjs');
    return agents.HOME_BOARD_NOTE || {};
  } catch (err) {
    log('home-board note unavailable: %o', err);
    return {};
  }
}

/**
 * Refuse with a JSON error envelope shaped like the WebSocket protocol's.
 *
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {void}
 */
function fail(res, status, code, message) {
  res.status(status).json({ ok: false, error: { code, message } });
}

/**
 * @param {string} code
 * @returns {string}
 */
function safeHttpAuthMessage(code) {
  switch (code) {
    case 'token_rejected':
      return 'the Feads token was not accepted';
    case 'sso_required':
      return 'a verified silo SSO session is required';
    case 'sso_provider_unavailable':
      return 'the silo SSO provider could not be reached';
    case 'sso_provider_unauthorized':
      return 'the silo SSO session was not accepted';
    case 'sso_provider_invalid':
    case 'sso_cookie_rejected':
      return 'the silo SSO session was invalid';
    case 'binding_rejected':
      return 'the silo SSO binding is no longer valid';
    case 'binding_conflict':
      return 'the silo SSO binding has a conflict';
    case 'legacy_binding_required':
      return 'the silo SSO identity needs operator migration';
    case 'registry_unavailable':
      return 'the agent registry could not be reached';
    case 'bad_request':
      return 'the request was not valid';
    default:
      return 'the caller could not be authenticated';
  }
}

/**
 * Turn a central HTTP actor result into the policy resolver shape when the
 * caller came through SSO rather than the browser token resolver seam.
 *
 * @param {{ actor: string, agent: any, via: string }} auth
 * @returns {any}
 */
function resolvedForHttpActor(auth) {
  const agent = auth.agent;
  const identity = {
    agent_id: String(agent.id || agent.agent_id || ''),
    actor: String(agent.actor || ''),
    display_name: String(agent.display_name || ''),
    role: String(agent.role || 'user'),
    board_id: String(agent.board_id || ''),
    last_seen_at: Number(agent.last_seen_at || 0),
    parent_agent_id: agent.parent_agent_id || null,
    parent_actor: String(agent.parent_actor || ''),
    expires_at: Number(agent.expires_at || 0)
  };
  return {
    identity,
    agent,
    mode: 'agent',
    stance: 'read_only',
    require_identity: false,
    credential_rejected: false,
    via: auth.via
  };
}

/**
 * Resolve the browser's platform SSO identity without creating a Feads token.
 *
 * @param {import('express').Request} req
 * @param {Record<string, string | undefined>} env
 * @param {ReturnType<typeof createPlatformSsoVerifier>} verifier
 * @param {(options: { token?: string, env?: Record<string, string | undefined> }) => Promise<any>} resolve
 * @returns {Promise<{ ok: true, identity: import('./sso-identity.js').SsoIdentity } | { ok: false, code: string }>}
 */
async function resolveBrowserSsoIdentity(req, env, verifier, resolve) {
  if (siloMode(env) !== 'silo') return { ok: false, code: 'sso_required' };
  if (!isExactOrigin(req.headers.origin, env.FEADS_PUBLIC_URL)) {
    return { ok: false, code: 'origin_forbidden' };
  }
  const cookie_token = readAgentTokenCookie(req.headers.cookie);
  if (cookie_token) {
    const token_resolution = await resolve({ token: cookie_token, env });
    if (token_resolution.credential_rejected) {
      return { ok: false, code: 'token_rejected' };
    }
  }
  let verification;
  try {
    verification = await verifier.verify(req);
  } catch {
    return { ok: false, code: 'sso_provider_unavailable' };
  }
  if (!verification.ok) {
    return { ok: false, code: browserSsoFailureCode(verification.code) };
  }
  try {
    const identity = resolveSsoIdentityFromRegistry(
      verification.principal.email,
      { env }
    );
    return identity
      ? { ok: true, identity }
      : { ok: false, code: 'sso_required' };
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code || 'sso_rejected');
    log(
      'browser SSO identity rejected: %s',
      /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : 'sso_rejected'
    );
    return {
      ok: false,
      code: /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : 'sso_rejected'
    };
  }
}

/**
 * @param {string|undefined} code
 * @returns {string}
 */
function browserSsoFailureCode(code) {
  switch (String(code || '')) {
    case 'cookie_missing':
      return 'sso_required';
    case 'cookie_duplicate':
    case 'cookie_malformed':
    case 'cookie_incomplete':
    case 'cookie_oversized':
      return 'sso_cookie_rejected';
    case 'unauthorized':
      return 'sso_provider_unauthorized';
    case 'timeout':
    case 'unavailable':
    case 'upstream_status':
      return 'sso_provider_unavailable';
    case 'invalid_response':
    case 'invalid_principal':
    case 'redirect_rejected':
      return 'sso_provider_invalid';
    default:
      return 'sso_provider_rejected';
  }
}

/**
 * Build a same-origin oauth2-proxy sign-out target without claiming that Feads
 * cleared the platform session. Invalid/missing public configuration omits the
 * target rather than constructing it from a request host.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string|undefined}
 */
function ssoLogoutTarget(env) {
  if (siloMode(env) !== 'silo' || typeof env.FEADS_PUBLIC_URL !== 'string') {
    return undefined;
  }
  try {
    const publicUrl = new URL(env.FEADS_PUBLIC_URL);
    if (
      (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') ||
      publicUrl.username ||
      publicUrl.password
    ) {
      return undefined;
    }
    return new URL('/oauth2/sign_out', publicUrl.origin).toString();
  } catch {
    return undefined;
  }
}

/**
 * Mount the login, signup, SSO bootstrap and logout routes on an express app.
 *
 * @param {import('express').Express} app
 * @param {SessionRouteOptions} [options]
 * @returns {void}
 */
export function attachAgentSessionRoutes(app, options = {}) {
  const env = options.env || process.env;
  assertValidSiloEnvironment(env);
  const verifier = options.ssoVerifier || createPlatformSsoVerifier({ env });
  const resolve = options.resolve || resolveIdentity;
  const boardId = options.resolveBoardId || boardIdFor;
  const root_dir = String(options.root_dir || '');
  const silo = siloMode(env) === 'silo';

  /**
   * Store a verified token in the cookie and answer with the identity it resolves to.
   *
   * Both entry points end here, so neither can set a cookie holding a token that has
   * not been verified. That matters most for sign-up: a cookie the next request
   * refuses would show a login that "worked" followed by a page saying you are
   * anonymous.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {string} token
   * @param {Record<string, unknown>} extra - Fields for the success body.
   * @returns {Promise<void>}
   */
  async function establishSession(req, res, token, extra) {
    const resolved = await resolve({ token, env });
    if (!resolved.identity) {
      log('session refused: %s (via %s)', resolved.mode, resolved.via);
      if (resolved.credential_rejected) {
        fail(
          res,
          401,
          'token_rejected',
          'that token was not accepted — the agent may have been revoked, or the ' +
            'token may be stale'
        );
      } else {
        fail(
          res,
          503,
          'no_registry',
          'no agent registry is reachable on this machine, so a token cannot be ' +
            'checked'
        );
      }
      return;
    }
    res.setHeader(
      'Set-Cookie',
      agentTokenCookie(token, { secure: isSecureRequest(req) })
    );
    const mcp = resolveMcpEndpoint(env);
    log('session established for %s', resolved.identity.actor);
    res.status(200).json({
      ok: true,
      // The same projection `whoami` sends, and for the same reason: it is built
      // field by field in identity.js, so no registry column — least of all
      // `token_hash` — can reach a client by being added upstream. Under accounts
      // mode its board is named only to a caller who can read that board.
      identity: await scopeIdentityBoard(resolved.identity, resolved, env),
      mode: resolved.mode,
      // Where the agent should point its MCP client. Not a secret, and sent on both
      // paths because "you are signed in, now connect your agent" is the next thing
      // a reader needs either way.
      mcp_url: mcp.url,
      mcp_reason: mcp.reason,
      // What the `board_id` inside that identity means. Sent from the one place both
      // sign-in and sign-up end, because both hand back an identity carrying a board
      // and both are read as "so this is where I work".
      ...(await homeBoardNote()),
      ...extra
    });
  }

  app.post('/api/agent/sso/resolve', (req, res) => {
    if (!silo) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    if (!isInternalSsoRequest(req, env)) {
      fail(
        res,
        401,
        'not_authenticated',
        'the internal SSO door was not accepted'
      );
      return;
    }
    const email = internalSsoEmail(req.body);
    if (!email) {
      fail(res, 400, 'bad_request', 'sso_email is required');
      return;
    }
    try {
      const identity = resolveSsoIdentityFromRegistry(email, { env });
      if (!identity) {
        fail(res, 401, 'sso_required', safeHttpAuthMessage('sso_required'));
        return;
      }
      res.status(200).json({
        ok: true,
        live: true,
        provenance: 'sso',
        identity
      });
    } catch (error) {
      const code = String(/** @type {any} */ (error)?.code || 'sso_rejected');
      log(
        'internal SSO identity rejected: %s',
        /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : 'sso_rejected'
      );
      fail(
        res,
        401,
        /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : 'sso_rejected',
        safeHttpAuthMessage(code)
      );
    }
  });

  app.post('/api/agent/sso/bootstrap', async (req, res) => {
    if (!silo && (await accountsOn(env))) {
      // Accounts mode: the same preflight the silo dashboard runs, so the browser
      // learns "signed in as …" or "refused, because …" before it opens a socket.
      if (!isExactOrigin(req.headers.origin, env.FEADS_PUBLIC_URL)) {
        res.status(403).json({ ok: false, error: 'origin_forbidden' });
        return;
      }
      const resolved = await resolveRequestIdentity(req, {
        env,
        ...(options.accountsVerifier
          ? { verifier: options.accountsVerifier }
          : {})
      });
      if (resolved.mode !== 'agent' || !resolved.identity) {
        const code = String(resolved.error_code || 'sso_rejected');
        fail(res, 401, code, safeHttpAuthMessage(code));
        return;
      }
      res.status(200).json({
        ok: true,
        live: true,
        provenance: 'sso',
        identity: await scopeIdentityBoard(resolved.identity, resolved, env)
      });
      return;
    }
    if (!silo) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    if (!isExactOrigin(req.headers.origin, env.FEADS_PUBLIC_URL)) {
      res.status(403).json({ ok: false, error: 'origin_forbidden' });
      return;
    }
    const outcome = await resolveBrowserSsoIdentity(
      req,
      env,
      verifier,
      resolve
    );
    if (!outcome.ok) {
      const status = outcome.code === 'origin_forbidden' ? 403 : 401;
      fail(res, status, outcome.code, safeHttpAuthMessage(outcome.code));
      return;
    }
    res.status(200).json({
      ok: true,
      live: true,
      provenance: 'sso',
      identity: outcome.identity
    });
  });

  app.post(
    '/api/agent/login',
    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {Promise<void>}
     */
    async (req, res) => {
      const presented = String(
        /** @type {any} */ (req.body || {}).token || ''
      ).trim();
      if (presented.length === 0) {
        fail(res, 400, 'bad_request', 'paste the token your agent uses');
        return;
      }

      // No policy gate on this route, deliberately: signing in is authentication, not
      // an action on the board, and it is precisely how a caller satisfies
      // `FEADS_REQUIRE_AGENT`. Gating it would make the deny stance unescapable.
      const accounts_on = !silo && (await accountsOn(env));
      const outcome = await withRegistry(options, (agents, db) => {
        const agent_prefix = String(agents.AGENT_TOKEN_PREFIX || '');
        const invite_prefix = String(agents.INVITE_TOKEN_PREFIX || '');

        if (agent_prefix && presented.startsWith(agent_prefix)) {
          // Verified but not stored here: `establishSession` re-resolves through the
          // shared resolver, which is the one implementation of "who is this". This
          // check exists so a bad paste is reported as a bad token rather than as
          // whatever the resolver's degraded answer happens to be.
          const agent = agents.verifyAgentToken(db, presented);
          if (!agent) {
            return /** @type {MintFailure} */ ({
              ok: false,
              status: 401,
              code: 'token_rejected',
              message:
                'that token was not accepted — the agent may have been revoked, ' +
                'or the token may be stale'
            });
          }
          return /** @type {MintOk} */ ({
            ok: true,
            token: presented,
            actor: String(agent.actor || '')
          });
        }

        if (
          invite_prefix &&
          presented.startsWith(invite_prefix) &&
          accounts_on
        ) {
          return /** @type {MintFailure} */ ({
            ok: false,
            status: 410,
            code: 'invites_retired',
            message:
              'invites are retired on this instance — sign in with an external SSO provider and use ' +
              'Access → Connect an agent'
          });
        }
        if (invite_prefix && presented.startsWith(invite_prefix)) {
          try {
            const result = agents.registerAgent(db, {
              token: presented,
              host: os.hostname(),
              workspace_dir: root_dir,
              // No `session_id`, and that omission is load-bearing. The registry
              // resolves *any* caller presenting a recorded session id to that
              // agent, so writing the daemon's own `CLAUDE_CODE_SESSION_ID` here
              // would hand this identity to the server process — and then every
              // cookie-less request, from any browser, would resolve as whoever
              // signed up first.
              kind: 'agent'
            });
            return /** @type {MintOk} */ ({
              ok: true,
              token: String(result.token || ''),
              actor: String(result.agent?.actor || '')
            });
          } catch (err) {
            return failureFor(err, presented);
          }
        }

        // The prefixes are named because the two are easy to mix up and the paste
        // came from a place where both appear.
        return /** @type {MintFailure} */ ({
          ok: false,
          status: 400,
          code: 'unknown_token_kind',
          message:
            'that does not look like a feads token — an agent token starts with ' +
            `${agent_prefix} and an invite with ${invite_prefix}`
        });
      });

      if (!outcome) {
        fail(
          res,
          503,
          'no_registry',
          'no agent registry is reachable on this machine, so there is nothing ' +
            'to sign in to — this dashboard is acting as the operator'
        );
        return;
      }
      if (!outcome.ok) {
        // An existing cookie is deliberately left alone on every failure path: a
        // mistyped paste should not also sign you out of a session that worked.
        fail(res, outcome.status, outcome.code, outcome.message);
        return;
      }
      if (outcome.token.length === 0) {
        fail(
          res,
          500,
          'registry_failed',
          'the invite was redeemed but no agent token came back'
        );
        return;
      }

      const redeemed = outcome.token !== presented;
      await establishSession(req, res, outcome.token, {
        redeemed,
        // On redemption the registry just minted a token the reader has never
        // seen, and only its hash is stored — this response is the one moment
        // it can cross to the browser, where the login panel embeds it in the
        // connection snippet (`agent-login.js` reads `json.token` when
        // `redeemed` is true; without this the snippet renders an empty
        // `Bearer `). A pasted token is still never echoed back.
        ...(redeemed ? { token: outcome.token } : {})
      });
    }
  );

  app.post(
    '/api/agent/signup',
    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {Promise<void>}
     */
    async (req, res) => {
      if (!silo && (await accountsOn(env))) {
        fail(
          res,
          410,
          'signup_retired',
          'open agent sign-up is retired on this instance — sign in with an external SSO provider ' +
            'and use Access → Connect an agent'
        );
        return;
      }
      const body = /** @type {any} */ (req.body || {});
      const display_name = String(body.display_name || '').trim();
      const actor = String(body.actor || '').trim();
      if (display_name.length === 0) {
        fail(
          res,
          400,
          'bad_request',
          'give the agent a name so its work can be attributed to it'
        );
        return;
      }

      // Where this sign-up came from, whitelisted. Note what is *not* read from the
      // body: `kind` and `created_by`. Both are derived from this enum, because
      // free-text provenance is spoofable and a row that can name any actor as its
      // creator records nothing. See SIGNUP_SURFACES.
      const surface_name = String(
        body.surface || DEFAULT_SIGNUP_SURFACE
      ).trim();
      const surface = SIGNUP_SURFACES[surface_name];
      if (!surface) {
        fail(
          res,
          400,
          'bad_request',
          `unknown surface "${surface_name}" — expected one of ` +
            `${Object.keys(SIGNUP_SURFACES).join(', ')}`
        );
        return;
      }

      // Identity resolved per *request*, from this request's own cookie — the
      // dashboard serves many browsers and `process.env` describes none of them.
      // Asked with `role: 'user'` and never `admin`: the browser does not offer the
      // admin tier, and the policy refuses it for an anonymous caller anyway, so
      // sending it could only produce a UI that implies otherwise.
      const resolved = await resolve({
        token: readAgentTokenCookie(req.headers.cookie),
        env
      });
      if (silo && (!resolved.identity || resolved.via !== 'token')) {
        if (resolved.credential_rejected) {
          fail(
            res,
            401,
            'token_rejected',
            safeHttpAuthMessage('token_rejected')
          );
        } else {
          fail(
            res,
            403,
            'sso_required',
            'silo sign-up requires a verified Feads token; use SSO bootstrap first'
          );
        }
        return;
      }
      const decision = await decideFor(resolved, 'mint_invite', {
        role: 'user'
      });
      if (!decision.allowed) {
        log('signup refused: %s', decision.reason);
        fail(res, 403, 'forbidden', decision.reason);
        return;
      }

      // The board the tab is looking at, or the seed when it named none. See
      // `boardIdFor` for why the caller gets to name it and why that grants nothing.
      const board_id = await boardId(String(body.board_dir || '').trim());
      if (board_id.length === 0) {
        // `agents.board_id` references `boards.id`, so there is nothing to register
        // against. Registering the board is a deliberate act with a name and a
        // description, which is why it is not done implicitly here.
        fail(
          res,
          409,
          'board_unregistered',
          'the board on screen is not in the feads registry, so an agent cannot ' +
            'be registered against it — register the board first, then reload'
        );
        return;
      }

      const outcome = await withRegistry(options, (agents, db) => {
        try {
          const result = agents.signupAgent(db, {
            board_id,
            display_name,
            actor: actor.length > 0 ? actor : undefined,
            host: os.hostname(),
            workspace_dir: root_dir,
            // A resolved identity still wins: when an already-signed-in agent creates
            // another, naming it is more informative than naming the surface, and it is
            // not spoofable because it came from a verified credential rather than the
            // body. The surface's string is the fallback for the ordinary case, where the
            // caller is by definition unidentified — it is signing up.
            created_by: resolved.identity?.actor || surface.created_by,
            // Derived from the whitelisted surface, never taken from the body. This row
            // records where the identity *came from*: `human` for a person in a browser,
            // `agent` for one registering itself over MCP. It is not a claim about who
            // presents the token next — the whole point of the browser flow is that the
            // human gives it to their agent — and the registry has no column that could
            // express that, nor should it grow one. See `SURFACE` in identity.js for the
            // per-request half of the same distinction.
            kind: surface.kind
          });
          return /** @type {MintOk} */ ({
            ok: true,
            token: String(result.token || ''),
            actor: String(result.agent?.actor || display_name)
          });
        } catch (err) {
          return failureFor(err);
        }
      });

      if (!outcome) {
        fail(
          res,
          503,
          'no_registry',
          'no agent registry is reachable on this machine, so an agent cannot be ' +
            'created here'
        );
        return;
      }
      if (!outcome.ok) {
        fail(res, outcome.status, outcome.code, outcome.message);
        return;
      }
      if (outcome.token.length === 0) {
        fail(
          res,
          500,
          'registry_failed',
          'the agent was created but no token came back, so it cannot be handed ' +
            'to an agent — revoke it and try again'
        );
        return;
      }

      await establishSession(req, res, outcome.token, {
        created: true,
        // The one place a token crosses back to the browser, and it must: only a
        // hash is stored, so this is the only moment it can ever be shown. The
        // client is responsible for saying so — see `agent-login.js`.
        token: outcome.token
      });
    }
  );

  app.post('/api/agent/delegate', async (req, res) => {
    const auth = await resolveHttpActor(req, {
      env,
      ssoVerifier: verifier,
      resolveToken: async (token) => resolve({ token, env })
    });
    if (!auth.actor || !auth.agent) {
      const code = auth.error_code || 'forbidden';
      const status =
        code === 'registry_unavailable'
          ? 503
          : code === 'bad_request'
            ? 400
            : 403;
      fail(res, status, code, safeHttpAuthMessage(code));
      return;
    }
    if (!isSiloBrowserMutationAllowed(req, auth, env)) {
      fail(res, 403, 'origin_forbidden', 'the browser origin was not accepted');
      return;
    }
    const resolved =
      auth.resolved || resolvedForHttpActor(/** @type {any} */ (auth));
    const decision = await decideFor(
      resolved,
      /** @type {any} */ ('delegate_agent')
    );
    if (!decision.allowed || !resolved.identity || !resolved.agent) {
      fail(res, 403, 'forbidden', decision.reason);
      return;
    }
    const body = /** @type {any} */ (req.body || {});
    const handle = String(body.handle || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(handle) || handle.includes('/')) {
      fail(
        res,
        400,
        'bad_request',
        'handle must match [a-z0-9._-] and may not contain /'
      );
      return;
    }
    const outcome = await withRegistry(options, (agents, db) => {
      try {
        const result = agents.delegateAgent(db, {
          parent_agent_id: resolved.agent.id,
          handle,
          display_name: body.display_name || handle,
          ttl_ms: body.ttl_ms,
          host: os.hostname(),
          workspace_dir: root_dir
        });
        return /** @type {any} */ ({ ok: true, result });
      } catch (err) {
        return failureFor(err);
      }
    });
    if (!outcome) {
      fail(res, 503, 'no_registry', 'no agent registry is reachable');
      return;
    }
    if (!outcome.ok) {
      fail(res, outcome.status, outcome.code, outcome.message);
      return;
    }
    res.status(200).json({
      ok: true,
      created: true,
      token: outcome.result.token,
      token_shown_once: true,
      // The child inherits its owner's spaces; its board (the parent's anchor) is
      // named only when the owner can read it.
      identity: await scopeIdentityBoard(outcome.result.agent, resolved, env),
      parent_actor: resolved.identity.actor
    });
  });

  app.post(
    '/api/agent/logout',
    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {void}
     */
    (req, res) => {
      if (silo && !isExactOrigin(req.headers.origin, env.FEADS_PUBLIC_URL)) {
        fail(
          res,
          403,
          'origin_forbidden',
          'the browser origin was not accepted'
        );
        return;
      }
      // There is no Feads server-side session to end. This clears only the
      // Feads token cookie; the platform SSO session belongs to oauth2-proxy.
      res.setHeader(
        'Set-Cookie',
        clearAgentTokenCookie({ secure: isSecureRequest(req) })
      );
      log('logout: agent cookie cleared');
      const logout_target = ssoLogoutTarget(env);
      res.status(200).json({
        ok: true,
        ...(logout_target ? { sso_logout_url: logout_target } : {})
      });
    }
  );
}
