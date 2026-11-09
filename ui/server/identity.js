/**
 * feads addition — which registered agent is acting behind a dashboard request,
 * and what `boards/authz.mjs` lets it do.
 *
 * The dashboard is one of three surfaces (with the `feads-agent` CLI and the
 * Python MCP server) that can act on a board, and all three ask the same policy
 * module the same question. Nothing in here decides anything: it resolves an
 * identity, hands it to `decide()`, and reports the answer. Adding a rule here
 * would be the start of exactly the two-implementations drift that
 * `boards/authz-cases.json` exists to prevent.
 *
 * ## What this does and does not enforce
 *
 * Same boundary as `boards/authz.mjs`: this binds requests that arrive through
 * the dashboard's WebSocket. It does not bind the shell next to it, where `bd
 * delete` is a local Go binary talking to a local Dolt database with no auth
 * layer to hook. So this is an *integrity* control — it stops an agent driving
 * the UI from deleting work it does not own by mistake — not a security
 * boundary against a hostile local process. Nothing about presenting a
 * credential in a browser changes that: a cookie is a nicer way to *say* who you
 * are, not a fence around the database. `FEADS_REQUIRE_AGENT` is what a hosted
 * deployment sets once the service holds the database instead of the caller, and
 * that is the point at which this becomes a boundary.
 *
 * ## The browser is read-only until it presents something
 *
 * The dashboard's stance toward an unidentified caller is `read_only`, not the
 * CLI's `operator`: it may read every board and change nothing. That is a
 * different judgement from the CLI's, and `boards/authz.mjs` takes both because
 * the *affordance* differs. A shell has no login box and is the only path that
 * can mint the first invite, so refusing it would make the model
 * unbootstrappable; a browser can show a login box, so "look at the board, paste
 * a token to act" is an honest offer rather than a ceremony.
 *
 * `FEADS_REQUIRE_AGENT=1` upgrades that to `deny`, and `stanceFor` is what makes
 * the flag able only to tighten. Two situations degrade it the other way, to
 * `operator`, and both share one reason — **read-only is only coherent where
 * logging in is possible**:
 *
 * - no `boards/` module (a published beads-ui package), so there is no policy,
 *   no registry and no token to paste;
 * - no registry *file* on the machine, so no agent has ever been registered and
 *   none can be until the CLI creates one.
 *
 * In either case a `read_only` stance would leave a dashboard that can never be
 * written to and a login box that can never be satisfied. Degrading to operator
 * keeps plain beads-ui — someone who never adopted the agent registry — working
 * exactly as it did.
 *
 * ## A cookie is not a fourth kind of credential
 *
 * The browser presents its token in an HttpOnly cookie, which the WebSocket
 * handshake and each HTTP request carry. That token is passed to the shared
 * `resolveAgentIdentity` **in the token slot** — the same slot
 * `FEADS_AGENT_TOKEN` fills — rather than resolved by any logic of its own. So
 * the order stays "token, then session", `resolution_cases` stays the one
 * contract for it, and a cookie holding a revoked agent's token is
 * `credential_rejected` for exactly the same reason an environment variable
 * holding it is. The only new rule is which of the two wins, and the cookie
 * does: it is the credential the person in front of the browser just chose,
 * while the environment variable is whatever shell happened to launch the
 * daemon.
 *
 * That also makes identity **per connection**, not per process. A dashboard
 * serving two browsers must answer differently for each, so nothing here reads
 * `process.env` for a credential on its own behalf — the caller passes both the
 * cookie token and the environment.
 *
 * ## No credential is not a rejected credential
 *
 * That permissive default has one exception, and getting it wrong inverts
 * revocation. `verifyAgentToken` returns null for a token that is unknown,
 * malformed, *or belongs to a revoked agent* — so if a failed token verification
 * were reported the same way as "presented nothing", a revoked `user` would land
 * in operator mode and gain the ability to delete anything. Revoking it would
 * **promote** it.
 *
 * So resolution reports two distinct failures, and `credential_rejected` denies
 * unconditionally — including with `FEADS_REQUIRE_AGENT` unset, because the
 * permissive fallback exists for callers who never claimed an identity, not for
 * one whose claim was refused:
 *
 * | presented | resolves to | mode |
 * | --- | --- | --- |
 * | nothing | nobody, read-only | `anonymous` |
 * | nothing, and no registry exists | the operator | `operator` |
 * | a token that verifies | that agent, at its tier | `agent` |
 * | a token that does not | nobody, denied | `rejected` |
 *
 * Which credential wins, and which failures count as a rejection, is not decided
 * here: `resolveAgentIdentity` in `boards/agents.mjs` is the one implementation
 * of that order, shared with the CLI and mirrored by the MCP server, and
 * governed by the `resolution_cases` group of `boards/authz-cases.json`.
 * Resolution turned out to be as security-sensitive as the policy — it was
 * drift *there*, not in `decide()`, that let revocation read as a promotion — so
 * it gets a fixture of its own and this module gets none of its own opinions
 * about it.
 *
 * ## Degradation
 *
 * Every export resolves rather than throwing, following `board-registry.js`: a
 * dashboard on a checkout without `boards/`, or on a Node without
 * `node:sqlite`, must still serve issues. Two independent loads, because they
 * fail for different reasons — `authz.mjs` is dependency-free and only missing
 * when the module tree is, while the registry additionally needs `node:sqlite`
 * and a database on disk.
 *
 * When the *policy* itself cannot be loaded, every action is allowed as the
 * operator. That looks alarming written down, so note what such a checkout is:
 * no `boards/` module means no registry, no invites and no agents, so no caller
 * could ever present an identity and honoring `FEADS_REQUIRE_AGENT` there would
 * brick the dashboard permanently rather than secure it.
 */
import fs from 'node:fs';
import { debug } from './logging.js';

const log = debug('identity');

/**
 * What this surface treats an unidentified caller as, before the environment gets
 * a say. See the header: the browser can offer a login box, so read-only is an
 * honest offer rather than a ceremony.
 *
 * Held here rather than passed in by `ws.js` so no call site can forget it. A
 * handler that resolved an identity with the default stance missing would silently
 * hand an anonymous browser the operator's rights, which is the one mistake this
 * module exists to make impossible.
 */
export const SURFACE_STANCE = 'read_only';

/**
 * Which surface this is, reported to the client by `whoami`.
 *
 * Not stored anywhere and not a registry column: it is a property of *how this
 * request arrived*, not of the agent. The same agent token presented over MCP is
 * the same agent — what differs is that a browser session is a human looking at an
 * agent's board, which is worth saying on screen ("you are viewing as <actor>")
 * and worth an agent knowing on the other side, since a request arriving here
 * rather than through MCP came from a person.
 */
export const SURFACE = 'browser';

/**
 * @typedef {'read'|'write'|'delete'|'mint_invite'|'manage_agents'|'view_roster'} Action
 */

/**
 * Client-safe projection of a registered agent — what `whoami` returns.
 *
 * @typedef {Object} AgentIdentity
 * @property {string} agent_id
 * @property {string} actor - The value the agent uses as `BEADS_ACTOR`, which
 * is what `created_by` on an item is compared against.
 * @property {string} display_name
 * @property {string} role
 * @property {string} board_id
 * @property {number} last_seen_at
 */

/**
 * One row of the agent roster.
 *
 * @typedef {Object} RosterRow
 * @property {string} agent_id
 * @property {string} actor
 * @property {string} display_name
 * @property {string} role
 * @property {string} board_id
 * @property {string} host
 * @property {string} workspace_dir
 * @property {string} session_id
 * @property {string} kind
 * @property {number} registered_at
 * @property {number} last_seen_at
 * @property {number} revoked_at
 * @property {string} revoke_reason
 */

/**
 * @typedef {'operator'|'read_only'|'deny'} Stance
 */

/**
 * @typedef {Object} ResolvedIdentity
 * @property {Record<string, any>} [principal] - Accounts mode only: who space RBAC judges.
 * @property {AgentIdentity | null} identity - Safe to send to a client.
 * @property {Record<string, any> | null} agent - The registry row, as `decide()`
 * wants it. Server-side only: it carries `token_hash`'s absence by virtue of
 * `agents.mjs` never selecting that column, but it is not shaped for the wire.
 * @property {'agent'|'operator'|'anonymous'|'rejected'} mode
 * @property {Stance} stance - The stance actually in force for this resolution,
 * after `FEADS_REQUIRE_AGENT` and after the degradations in the header. Carried
 * on the resolution for the same reason `credential_rejected` is: every policy
 * question has to be asked with it, and a call site that computed it separately
 * could compute it differently.
 * @property {boolean} require_identity
 * @property {boolean} credential_rejected - A credential was presented and did
 * not verify. Carried on the resolution rather than passed separately at each
 * call site, so a caller cannot forget to forward it — forgetting is what
 * reinstates the revocation inversion.
 * @property {string} via - Which credential answered: `token`, `session`,
 * `rejected` or `none`, straight from `resolveAgentIdentity`. Diagnostic, not a
 * policy input — nothing branches on it — but it is the field the shared
 * `resolution_cases` fixture is keyed on, so carrying it is what lets the UI
 * assert its resolution against the same rows the CLI and MCP do.
 */

/**
 * @typedef {Object} IdentityOptions
 * @property {string} [board_id] - Active board's registry id, for roster
 * scoping. Never used to scope identity resolution — see `resolveAgentRow`.
 * @property {boolean} [include_revoked] - Roster only.
 * @property {string} [token] - The agent token this *connection* presented, from
 * its cookie. Outranks `env.FEADS_AGENT_TOKEN` — see `effectiveEnv`.
 * @property {Stance} [unidentified] - Override the surface's stance. Exists for
 * tests and for a future surface with different affordances; ordinary call sites
 * leave it alone and get `SURFACE_STANCE`.
 * @property {Record<string, string | undefined>} [env]
 * @property {boolean} [skip_accounts] - Resolve without attaching an accounts principal.
 * @property {() => Promise<any | null>} [loadAuthz] - Test seam.
 * @property {() => Promise<{ agents: any, registry: any } | null>} [loadRegistry]
 *   - Test seam. Injecting the registry is how the enforcement path is tested
 *   without a `~/.feads/registry.db` on the machine running the tests.
 */

/**
 * Load the policy module.
 *
 * Dynamic for the same reason `board-registry.js` loads the registry lazily: a
 * published beads-ui package does not ship `boards/`, and a missing sibling
 * tree must cost the dashboard nothing but the agent feature.
 *
 * @returns {Promise<any | null>}
 */
async function loadAuthz() {
  try {
    return await import('../../boards/authz.mjs');
  } catch (err) {
    log('authz module unavailable: %o', err);
    return null;
  }
}

/**
 * @returns {Promise<{ agents: any, registry: any } | null>}
 */
async function loadRegistry() {
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
 * Run `fn` against an open registry, or return `null` when there is none.
 *
 * Opened and closed per call rather than held: a revocation or a role change has
 * to take effect on the next request, not on the next dashboard restart. The
 * cost is one small SQLite open per gated operation, and gated operations are
 * deletes and roster reads, not the push path.
 *
 * @template T
 * @param {IdentityOptions} options
 * @param {(agents: any, db: any) => T} fn
 * @returns {Promise<T | null>}
 */
async function withRegistry(options, fn) {
  const mods = await (options.loadRegistry || loadRegistry)();
  if (!mods) {
    return null;
  }
  /** @type {string} */
  let registry_path;
  try {
    registry_path = mods.registry.getRegistryPath();
  } catch (err) {
    log('cannot resolve registry path: %o', err);
    return null;
  }
  // openRegistry() would create and migrate the file. An absent registry means
  // "nobody has registered an agent", not "make one" — registry authorship
  // belongs to the CLI, exactly as in board-registry.js.
  if (!fs.existsSync(registry_path)) {
    log('no registry at %s', registry_path);
    return null;
  }
  /** @type {any} */
  let db = null;
  try {
    db = mods.registry.openRegistry();
    return fn(mods.agents, db);
  } catch (err) {
    log('agent registry read failed (%s): %o', registry_path, err);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * The environment the shared resolver should see for *this* connection.
 *
 * A cookie token is not a new kind of credential, so it does not get a new
 * resolution path: it is spliced into the slot `FEADS_AGENT_TOKEN` occupies and
 * `resolveAgentIdentity` decides everything else, exactly as it does for the CLI.
 * The alternative — verifying the cookie here and only falling back to the shared
 * resolver — would be a second implementation of the order that
 * `resolution_cases` pins, and a second implementation of that order is what made
 * revoking an agent read as a promotion once already.
 *
 * The cookie wins over the environment variable, and the asymmetry is deliberate:
 * the cookie is what the person in front of the browser just chose, while
 * `FEADS_AGENT_TOKEN` is whatever shell happened to launch the daemon. A human
 * pasting a token into the login box must not be silently overruled by the
 * server's own environment — that would look like the login had failed.
 *
 * When there is no cookie the environment is handed through **untouched**, rather
 * than copied with the same values, so `resolveAgentIdentity` cannot tell the
 * difference between a plain daemon and this code path.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} [token]
 * @returns {Record<string, string | undefined>}
 */
function effectiveEnv(env, token) {
  const presented = String(token || '').trim();
  if (presented.length === 0) {
    return env;
  }
  return { ...env, FEADS_AGENT_TOKEN: presented };
}

/**
 * Resolve the acting agent's registry row against an open registry.
 *
 * Delegates the whole order — token before session, and which failures count as
 * a rejection — to `resolveAgentIdentity`, which the CLI shares and the MCP
 * server mirrors, and which `resolution_cases` governs. There is no local
 * fallback when that export is absent: a `boards/` old enough to lack it is one
 * whose resolution this build cannot reproduce faithfully, and approximating it
 * is how the surfaces drifted apart in the first place. It degrades to
 * unidentified, the same answer as an unreachable registry.
 *
 * `board_id` is deliberately **not** forwarded, though `resolveAgentIdentity`
 * accepts it. Scoping the session lookup to the board currently on screen would
 * resolve to nobody the moment the dashboard switched boards — and with nothing
 * presented, nobody means operator mode, so a `user` would gain privilege by
 * changing the picker. The policy decides what an agent may do to a board it is
 * not registered on; resolution must not pre-empt that by losing the identity.
 * The CLI can pass it safely because there a board is named per command rather
 * than switched under a live session.
 *
 * @param {any} agents - The `boards/agents.mjs` module.
 * @param {any} db
 * @param {Record<string, string | undefined>} env
 * @returns {{ row: Record<string, any> | null, credential_rejected: boolean, via: string }}
 */
function resolveAgentRow(agents, db, env) {
  if (typeof agents.resolveAgentIdentity !== 'function') {
    log(
      'boards/agents.mjs has no resolveAgentIdentity — treating as unidentified'
    );
    return { row: null, credential_rejected: false, via: 'none' };
  }
  const resolution = agents.resolveAgentIdentity(db, env);
  const row = resolution?.agent || null;
  const via = String(resolution?.via || 'none');
  log('resolved via %s → %s', via, row?.actor || '(nobody)');
  return {
    row,
    credential_rejected: resolution?.credential_rejected === true,
    via
  };
}

/**
 * Project a registry row onto the wire.
 *
 * Built field by field rather than spread. `agents.mjs` already keeps
 * `token_hash` out of every SELECT, so this is the second of two independent
 * reasons a hash cannot reach a client — and the one that still holds if a
 * future column is added to that list.
 *
 * @param {Record<string, any>} row
 * @returns {AgentIdentity}
 */
function toIdentity(row) {
  return {
    agent_id: String(row.id || ''),
    actor: String(row.actor || ''),
    display_name: String(row.display_name || ''),
    role: String(row.role || ''),
    board_id: String(row.board_id || ''),
    last_seen_at: Number(row.last_seen_at || 0),
    parent_agent_id: row.parent_agent_id ? String(row.parent_agent_id) : null,
    parent_actor: String(row.parent_actor || ''),
    expires_at: Number(row.expires_at || 0)
  };
}

/**
 * @param {Record<string, any>} row
 * @returns {RosterRow}
 */
function toRosterRow(row) {
  return {
    ...toIdentity(row),
    host: String(row.host || ''),
    workspace_dir: String(row.workspace_dir || ''),
    session_id: String(row.session_id || ''),
    kind: String(row.kind || ''),
    registered_at: Number(row.registered_at || 0),
    revoked_at: Number(row.revoked_at || 0),
    revoke_reason: String(row.revoke_reason || ''),
    parent_agent_id: row.parent_agent_id ? String(row.parent_agent_id) : null,
    parent_actor: String(row.parent_actor || ''),
    expires_at: Number(row.expires_at || 0),
    archived_at: Number(row.archived_at || 0)
  };
}

/**
 * The stance actually in force, given the policy module, the environment and
 * whether a login could even succeed here.
 *
 * Read through `authz.mjs` when it is loadable so the dashboard and the CLI cannot
 * disagree about what counts as set — `stanceFor` is also what makes
 * `FEADS_REQUIRE_AGENT` able only to *tighten* a surface's own default.
 *
 * The two degradations to `operator` are the header's "read-only is only coherent
 * where logging in is possible". Both are silent-failure shaped if you get them
 * wrong: a `read_only` dashboard with no reachable registry would refuse every
 * write while showing a login box that nothing can satisfy, and the person in
 * front of it would have no way to tell that from a bug.
 *
 * **`FEADS_REQUIRE_AGENT` is never degraded away**, and the ordering below is what
 * guarantees it. The flag is an explicit instruction from whoever deployed this,
 * so it outranks a *default* the surface chose for itself; letting an unreachable
 * registry relax it would mean a hosted deployment that mistyped its registry path
 * failed **open** — every anonymous caller promoted to operator, at exactly the
 * moment nothing works and nobody is looking at stances. The degradation exists to
 * keep a local dashboard usable, not to overrule its operator.
 *
 * The one case where the flag genuinely cannot be honored is a checkout with no
 * `boards/` module, because `requireIdentityFromEnv` lives there too. That is
 * pre-existing behaviour and it stays: such a build has no registry, no invites and
 * no agents, so there is no identity for the flag to require.
 *
 * @param {any | null} authz
 * @param {Record<string, string | undefined>} env
 * @param {Stance} surface_default
 * @param {boolean} registry_reachable
 * @returns {Stance}
 */
function stanceOf(authz, env, surface_default, registry_reachable) {
  if (!authz || typeof authz.stanceFor !== 'function') {
    // A `boards/` too old to know about stances would ignore the `unidentified`
    // option and treat every unidentified caller as the operator, so reporting
    // anything else here would describe a rule that is not being applied.
    log(
      'no stance support in boards/authz.mjs — unidentified callers are operator'
    );
    return 'operator';
  }
  const stance = authz.stanceFor(surface_default, env);
  if (stance === 'deny') {
    return 'deny';
  }
  if (!registry_reachable) {
    log('no reachable agent registry — unidentified callers are operator');
    return 'operator';
  }
  return stance;
}

/**
 * The mode `decide()` will report for a resolution, so `whoami` and the gate
 * cannot describe the same caller differently.
 *
 * @param {Record<string, any> | null} row
 * @param {boolean} credential_rejected
 * @param {Stance} stance
 * @returns {'agent'|'operator'|'anonymous'|'rejected'}
 */
function modeOf(row, credential_rejected, stance) {
  if (row) return 'agent';
  if (credential_rejected) return 'rejected';
  return stance === 'operator' ? 'operator' : 'anonymous';
}

/**
 * Resolve the agent acting on this connection.
 *
 * Resolves to an anonymous read-only caller — not a rejection — when nothing was
 * presented, because nothing presented is nothing to refuse. When the registry is
 * unreachable it resolves to the *operator* instead: see `stanceOf`, and note that
 * the two cases differ only in the stance, never in whether a credential was
 * refused. A credential that *was* presented and did not verify resolves to
 * `rejected` regardless of stance.
 *
 * @param {IdentityOptions} [options]
 * @returns {Promise<ResolvedIdentity>}
 */
export async function resolveIdentity(options = {}) {
  const env = options.env || process.env;
  const authz = await (options.loadAuthz || loadAuthz)();

  const resolution = await withRegistry(options, (agents, db) =>
    resolveAgentRow(agents, db, effectiveEnv(env, options.token))
  );
  const row = resolution?.row || null;
  const credential_rejected = resolution?.credential_rejected === true;
  const stance = stanceOf(
    authz,
    env,
    options.unidentified || SURFACE_STANCE,
    resolution !== null
  );
  const require_identity = stance === 'deny';

  const via = resolution?.via || 'none';

  // Accounts mode (the excluded hosted-provider design): attach the
  // principal space RBAC judges. A system key is not an agent — the shared order
  // above rightly rejected it as one — so it is recognised here, read-only.
  const accounts =
    options.skip_accounts === true || typeof options.loadRegistry === 'function'
      ? undefined
      : await accountsPrincipalFor(env, options.token, row, stance);
  if (accounts?.system) {
    return {
      identity: null,
      agent: null,
      mode: 'anonymous',
      stance,
      require_identity,
      credential_rejected: false,
      via: 'system_key',
      principal: accounts.principal
    };
  }

  if (!row) {
    return {
      identity: null,
      agent: null,
      // Must match what `decide()` reports for the same input: `whoami` tells
      // the UI which mode it is in, and the UI decides what to show from that.
      mode: modeOf(null, credential_rejected, stance),
      stance,
      require_identity,
      credential_rejected,
      via,
      ...(accounts ? { principal: accounts.principal } : {})
    };
  }
  return {
    identity: toIdentity(row),
    agent: row,
    mode: 'agent',
    stance,
    require_identity,
    credential_rejected: false,
    via,
    ...(accounts ? { principal: accounts.principal } : {})
  };
}

/**
 * The accounts principal for a resolution, or `undefined` when accounts mode is off.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} token
 * @param {Record<string, any> | null} row
 * @param {Stance} stance
 * @returns {Promise<{ principal: Record<string, any>, system?: boolean } | undefined>}
 */
async function accountsPrincipalFor(env, token, row, stance) {
  const { accountsOn, withAccounts } = await import('./accounts.js');
  if (!(await accountsOn(env))) return undefined;
  const presented = String(token || env.FEADS_AGENT_TOKEN || '').trim();
  const out = await withAccounts(
    (m, db) => {
      if (presented) {
        const r = m.accounts.resolveTokenPrincipal(db, presented, { env });
        if (!r) return { principal: { kind: 'anonymous' } };
        return {
          principal: r.principal,
          system: r.principal.kind === 'system'
        };
      }
      if (row) {
        const r = m.accounts.principalForAgentRow(db, row, { env });
        return { principal: r ? r.principal : { kind: 'anonymous' } };
      }
      return {
        principal:
          stance === 'operator'
            ? { kind: 'operator', via: 'none' }
            : { kind: 'anonymous' }
      };
    },
    { env, fallback: { principal: { kind: 'anonymous' } } }
  );
  return out || { principal: { kind: 'anonymous' } };
}

/**
 * Resolve an SSO-verified (or MCP-edge) email under accounts mode, provisioning a
 * roster user on first contact unless `provision` is false. A refusal (not on the
 * roster, disabled) is a rejected credential — never anonymous, never operator.
 *
 * @param {{ email: string, env?: Record<string, string | undefined>,
 *           via?: 'sso'|'worker_email', provision?: boolean }} input
 * @returns {Promise<ResolvedIdentity & { principal?: Record<string, any>, error_code?: string }>}
 */
export async function resolveEmailIdentity(input) {
  const env = input.env || process.env;
  const { withAccounts } = await import('./accounts.js');
  const via = input.via === 'worker_email' ? 'worker_email' : 'sso';
  const require_identity = true;
  /** @type {any} */
  const out = await withAccounts(
    /** @returns {any} */ (m, db) => {
      try {
        const r = m.accounts.resolveEmailPrincipal(db, input.email, {
          env,
          via,
          provision: input.provision !== false
        });
        return { ok: true, agent: r.agent, principal: r.principal };
      } catch (error) {
        const code = String(/** @type {any} */ (error)?.code || 'sso_rejected');
        return {
          ok: false,
          code: /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : 'sso_rejected'
        };
      }
    },
    { env, fallback: { ok: false, code: 'registry_unavailable' } }
  );
  if (!out || !out.ok) {
    return {
      identity: null,
      agent: null,
      mode: 'rejected',
      stance: 'deny',
      require_identity,
      credential_rejected: true,
      via: 'rejected',
      principal: { kind: 'anonymous' },
      error_code: out?.code || 'sso_rejected'
    };
  }
  return {
    identity: toIdentity(out.agent),
    agent: out.agent,
    mode: 'agent',
    stance: 'deny',
    require_identity,
    credential_rejected: false,
    via,
    principal: out.principal
  };
}

/**
 * The options every policy question is asked with.
 *
 * One place builds this so neither `credential_rejected` nor the stance can be
 * dropped at one call site and honored at another. Both failure modes are silent:
 * a delete that forgot `credential_rejected` would restore the revocation
 * inversion while `whoami` still reported `rejected`, and a write that forgot the
 * stance would let an anonymous browser through while the login panel was still on
 * screen telling it that it could not.
 *
 * `require_identity` is sent alongside `unidentified` even though one is derived
 * from the other. It is the field an older `boards/authz.mjs` understands, and
 * because it is derived they cannot disagree — whereas dropping it would quietly
 * stop honoring `FEADS_REQUIRE_AGENT` against such a build.
 *
 * @param {ResolvedIdentity} resolved
 * @returns {{ unidentified: Stance, require_identity: boolean, credential_rejected: boolean }}
 */
function policyOptions(resolved) {
  // The `require_identity` fallback matters only if a resolution ever reaches here
  // without a stance; `resolveIdentity` always sets one. Written defensively
  // because the failure would be an unnoticed *widening*, not an error.
  const stance = /** @type {Stance} */ (
    resolved.stance ||
      (resolved.require_identity === true ? 'deny' : SURFACE_STANCE)
  );
  return {
    unidentified: stance,
    require_identity: stance === 'deny',
    credential_rejected: resolved.credential_rejected === true
  };
}

/**
 * Ask the policy whether a resolved caller may do something.
 *
 * @param {ResolvedIdentity} resolved
 * @param {Action} action
 * @param {{ created_by?: string, id?: string, role?: string }} [resource] - Read
 * per action: `created_by` for `delete`, `role` for `mint_invite`. The policy
 * ignores whichever it does not need.
 * @param {IdentityOptions} [options]
 * @returns {Promise<{ allowed: boolean, reason: string, mode: 'agent'|'operator'|'anonymous'|'rejected' }>}
 */
export async function decideFor(resolved, action, resource = {}, options = {}) {
  // The dynamic import is module-cache-hot after `resolveIdentity`, so asking
  // again costs nothing and keeps this callable on its own.
  const authz = await (options.loadAuthz || loadAuthz)();
  if (!authz) {
    // A rejected credential is still refused here. Without the policy module
    // there is no registry to have issued the token, so a token that "did not
    // verify" is a caller presenting a credential this build cannot honour —
    // which is not the never-claimed-anything case the fallback is for.
    if (resolved.credential_rejected === true) {
      return {
        allowed: false,
        reason:
          'a credential was presented and no authorization policy module is ' +
          'available to verify it',
        mode: 'rejected'
      };
    }
    return {
      allowed: true,
      reason:
        'operator mode: no authorization policy module is available, so no ' +
        'caller could hold an identity to check',
      mode: 'operator'
    };
  }
  return authz.decide(
    resolved.agent,
    action,
    resource,
    policyOptions(resolved)
  );
}

/**
 * @typedef {Object} Roster
 * @property {boolean} allowed
 * @property {string} reason
 * @property {'all'|'self'|'none'} scope
 * @property {string} board_id
 * @property {RosterRow[]} agents
 * @property {'agent'|'operator'|'anonymous'|'rejected'} mode
 * @property {Stance} stance
 * @property {boolean} require_identity
 * @property {boolean} credential_rejected
 */

/**
 * The agent roster, narrowed to what the caller may see.
 *
 * Scoping goes through `rosterScopeFor`, never the bare `rosterScope`. The
 * difference is the trap: `rosterScope` is a pure tier lookup and answers
 * `none` for a null agent, so an operator run through it renders an *empty*
 * roster — indistinguishable, on screen, from "no agents are registered".
 * `rosterScopeFor` adds the operator rule (`all`, because a local caller owns
 * the database), honors `FEADS_REQUIRE_AGENT`, and answers `none` for a rejected
 * credential — which is the whole point of telling it about one.
 *
 * An anonymous read-only caller gets `none` too, and that is not an oversight in
 * "read-only may read everything": who else is registered, on which host, in which
 * workspace, is administrative data about other people's agents rather than board
 * content, so it does not ride along with a read-only view of the board.
 *
 * @param {IdentityOptions} [options]
 * @returns {Promise<Roster>}
 */
export async function listRoster(options = {}) {
  const env = options.env || process.env;
  const authz = await (options.loadAuthz || loadAuthz)();
  const surface_default = options.unidentified || SURFACE_STANCE;
  const board_id = String(options.board_id || '');

  const result = await withRegistry(options, (agents, db) => {
    const resolution = resolveAgentRow(
      agents,
      db,
      effectiveEnv(env, options.token)
    );
    const row = resolution.row;
    // Reachable by construction: this callback only runs with an open registry.
    const stance = stanceOf(authz, env, surface_default, true);
    /** @type {ResolvedIdentity} */
    const resolved = {
      identity: row ? toIdentity(row) : null,
      agent: row,
      mode: modeOf(row, resolution.credential_rejected, stance),
      stance,
      require_identity: stance === 'deny',
      credential_rejected: resolution.credential_rejected,
      via: resolution.via
    };
    const policy = policyOptions(resolved);
    const gate = authz
      ? authz.decide(row, 'view_roster', {}, policy)
      : { allowed: true, reason: 'no policy module', mode: resolved.mode };
    /** Shared by every early return below. */
    const envelope = {
      board_id,
      mode: resolved.mode,
      stance,
      require_identity: resolved.require_identity,
      credential_rejected: resolved.credential_rejected
    };
    if (!gate.allowed) {
      return {
        ...envelope,
        allowed: false,
        reason: gate.reason,
        scope: /** @type {'none'} */ ('none'),
        agents: /** @type {RosterRow[]} */ ([])
      };
    }

    const scope = rosterScopeOf(authz, row, policy);
    if (scope === 'self') {
      // Answered from the row already in hand rather than by querying the
      // active board: an agent registered on board A must still be able to see
      // itself while the dashboard is showing board B.
      return {
        ...envelope,
        allowed: true,
        reason: gate.reason,
        scope,
        agents: row ? [toRosterRow(row)] : []
      };
    }
    if (scope === 'none') {
      return {
        ...envelope,
        allowed: true,
        reason: gate.reason,
        scope,
        agents: /** @type {RosterRow[]} */ ([])
      };
    }

    if (board_id.length === 0) {
      // `listAgents` treats a falsy board_id as "no filter" and would return
      // every agent on every board. Presenting that under the heading of the
      // board on screen would be a lie, and an unregistered board cannot have
      // agents anyway: `agents.board_id` references `boards.id`.
      return {
        ...envelope,
        allowed: true,
        reason:
          'the active board has no registry entry, so no agent can be ' +
          'registered against it — register the board first',
        scope,
        agents: /** @type {RosterRow[]} */ ([])
      };
    }

    const rows = agents.listAgents(db, {
      board_id,
      include_revoked: options.include_revoked === true
    });
    return {
      ...envelope,
      allowed: true,
      reason: gate.reason,
      scope,
      agents: rows.map(toRosterRow)
    };
  });

  if (result) {
    return result;
  }
  // No registry: nobody is registered, which is an empty roster rather than a
  // refusal. Nothing could have been presented for the registry to refuse, so
  // the caller is unidentified rather than rejected, and the scope is whatever
  // the policy says an unidentified caller gets. The stance degrades to operator
  // here for the reason `stanceOf` gives — with no registry there is nothing to
  // log in *to*, so read-only would be an offer nobody could take up.
  const stance = stanceOf(authz, env, surface_default, false);
  const require_identity = stance === 'deny';
  return {
    allowed: !require_identity,
    reason: require_identity
      ? 'FEADS_REQUIRE_AGENT is set and no agent registry is reachable'
      : 'no agent registry on this machine — nothing is registered yet',
    scope: rosterScopeOf(authz, null, {
      unidentified: stance,
      require_identity,
      credential_rejected: false
    }),
    board_id,
    agents: [],
    mode: modeOf(null, false, stance),
    stance,
    require_identity,
    credential_rejected: false
  };
}

/**
 * Every agent row in the registry, as roster rows (accounts mode).
 *
 * Unscoped on purpose: accounts mode decides the roster with `directory_read`
 * and narrows the rows to the people sharing a space with the caller, which is
 * the caller's job (`scopeDirectoryRows` in ws.js) — this only reads them.
 *
 * @param {IdentityOptions} [options]
 * @returns {Promise<RosterRow[]>}
 */
export async function listRosterRows(options = {}) {
  const rows = await withRegistry(options, (agents, db) =>
    agents
      .listAgents(db, { include_revoked: options.include_revoked === true })
      .map(toRosterRow)
  );
  return rows || [];
}

/**
 * Roster scope for a resolved caller, per the policy.
 *
 * Thin on purpose — it exists only to give the degraded "no policy module" case
 * an answer, and that answer is `all` for the same reason `decideFor` allows
 * there: a checkout with no `boards/` module has no registry to scope against.
 * A rejected credential is the exception, for the same reason it is there.
 *
 * @param {any | null} authz
 * @param {Record<string, any> | null} row
 * @param {{ unidentified?: Stance, require_identity: boolean, credential_rejected: boolean }} policy
 * @returns {'all'|'self'|'none'}
 */
function rosterScopeOf(authz, row, policy) {
  if (!authz) {
    return !row && policy.credential_rejected ? 'none' : 'all';
  }
  return authz.rosterScopeFor(row, policy).scope;
}
