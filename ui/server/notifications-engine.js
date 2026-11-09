/**
 * feads addition — the notification engine and the dashboard's access to the
 * notification store.
 *
 * The engine is the sole minter of notification rows (see
 * boards/notifications.mjs for why they are derived by diffing rather than
 * hooked into any single write path). It runs inside the dashboard daemon —
 * the one long-lived process on the machine — and does three things:
 *
 *   1. Polls every known board for change (a stat fingerprint, NOT the ws
 *      layer's connection-refcounted fs watchers — see boardFingerprint for
 *      why a watcher cannot work here; and independent of connections because
 *      an agent commenting over MCP with no browser tab open must still
 *      notify).
 *   2. On change (or an explicit nudge from a ws mutation handler, or the
 *      periodic sweep), runs one `bd export` for the board and hands the
 *      parsed lines to the pure diff in boards/notifications.mjs.
 *   3. Persists the minted rows and tells the caller, so the ws layer can
 *      push them to whoever is connected right now.
 *
 * Everything degrades to "no notifications" instead of throwing, exactly like
 * board-registry.js and for the same reason: a checkout without the boards
 * module, or a Node without node:sqlite, must cost the dashboard nothing but
 * this feature.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  mutationOriginAllowed,
  resolveRequestIdentity
} from './accounts-http.js';
import { accountsOn, readableBoardIds, readableSpaceIds } from './accounts.js';
import { readAgentTokenCookie } from './agent-cookie.js';
import { runBd } from './bd.js';
import { debug } from './logging.js';
import { boardIdForDir, getPgStore, onPgEvent } from './pg-store.js';
import {
  createPlatformSsoVerifier,
  isExactOrigin,
  siloMode
} from './platform-sso.js';
import {
  internalSsoEmail,
  isInternalSsoRequest,
  resolveSsoIdentityFromRegistry
} from './sso-identity.js';

const log = debug('notifications');
const FEADS_AGENT_TOKEN_PREFIX = 'fdsa_';
let store_error_logged = false;

/**
 * Log the first store failure even when DEBUG is not enabled in production.
 *
 * @param {string} message
 * @param {unknown} err
 */
function logStoreError(message, err) {
  log(message, err);
  if (!store_error_logged) {
    store_error_logged = true;
    console.error(`[feads notifications] ${message}`, err);
  }
}

/**
 * @typedef {import('../../boards/notifications.mjs').NotificationRow} NotificationRow
 */

/**
 * @typedef {Object} EngineBoard
 * @property {string} board_dir - The board's `.beads` directory.
 * @property {string} cwd - Workspace root to run `bd` in.
 * @property {string} board_id - Registry id, `''` when unregistered.
 */

/**
 * Load the boards modules lazily; `null` disables the feature.
 *
 * @returns {Promise<{ registry: any, notifications: any, agents: any, accounts: any } | null>}
 */
async function loadBoardsModules() {
  try {
    const [registry, notifications, agents, accounts] = await Promise.all([
      import('../../boards/registry.mjs'),
      import('../../boards/notifications.mjs'),
      import('../../boards/agents.mjs'),
      import('../../boards/accounts.mjs')
    ]);
    return { registry, notifications, agents, accounts };
  } catch (err) {
    logStoreError(
      'boards modules unavailable, notifications disabled: %o',
      err
    );
    return null;
  }
}

/**
 * Run `fn` against an open registry and the notifications module.
 *
 * The dashboard opens read-write: it is the registry's designated writer (it
 * already is for sign-ups), and `openRegistry` migrates the schema in, which
 * is how the notifications tables arrive on an existing installation.
 *
 * @template T
 * @param {(mods: { registry: any, notifications: any, agents: any, accounts: any }, db: any) => T} fn
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<T | null>}
 */
async function withStore(fn, env = process.env) {
  const mods = await loadBoardsModules();
  if (!mods) return null;
  /** @type {any} */
  let db = null;
  let cached = false;
  try {
    if (env === process.env) {
      db = sharedRegistry(mods);
      cached = db !== null;
    }
    if (!db) {
      db =
        env === process.env
          ? mods.registry.openRegistry()
          : mods.registry.openRegistry({ env });
    }
    return fn(mods, db);
  } catch (err) {
    logStoreError('notification store access failed: %o', err);
    if (cached) dropSharedRegistry();
    return null;
  } finally {
    if (!cached) {
      try {
        db?.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

/** Per registry handle (the engine's shared one lives for the process). */
/** @type {WeakMap<object, { at: number, map: Map<string, string> }>} */
let ALIAS_MAP_CACHE = new WeakMap();
const ALIAS_MAP_TTL_MS = 5000;

/**
 * Accounts mode's alias → user-actor map for the recipient resolver, cached for
 * a few seconds: scans run per board change and the map changes only when an
 * owner is assigned. Empty on any failure (aliases then behave as before).
 *
 * @param {{ accounts?: any }} mods
 * @param {any} db
 * @returns {Map<string, string>}
 */
function cachedAliasMap(mods, db) {
  const now = Date.now();
  const hit = db && typeof db === 'object' ? ALIAS_MAP_CACHE.get(db) : null;
  if (hit && now - hit.at < ALIAS_MAP_TTL_MS) {
    return hit.map;
  }
  /** @type {Map<string, string>} */
  let map = new Map();
  try {
    map = mods.accounts?.aliasMap ? mods.accounts.aliasMap(db) : new Map();
  } catch (err) {
    log('alias map unavailable: %o', err);
  }
  if (db && typeof db === 'object') ALIAS_MAP_CACHE.set(db, { at: now, map });
  return map;
}

/** @type {WeakMap<object, { at: number, pg: boolean, reach: ((recipient: string, board_id: string) => boolean) | null }>} */
let REACH_CACHE = new WeakMap();

/**
 * Accounts mode's space gate for minting (`notifications.mjs spaceReach`): who
 * may read which board, cached like the alias map. Built from the same board →
 * space map the inbox reads are scoped by (`data_ids` in Postgres mode). `null`
 * on any failure: the gate then lets every row through, and each inbox read
 * still filters by space, exactly as before the gate existed.
 *
 * @param {{ accounts?: any, notifications?: any }} mods
 * @param {any} db
 * @param {boolean} pg
 * @returns {((recipient: string, board_id: string) => boolean) | null}
 */
function cachedSpaceReach(mods, db, pg) {
  const now = Date.now();
  const hit = db && typeof db === 'object' ? REACH_CACHE.get(db) : null;
  if (hit && hit.pg === pg && now - hit.at < ALIAS_MAP_TTL_MS) {
    return hit.reach;
  }
  /** @type {((recipient: string, board_id: string) => boolean) | null} */
  let reach = null;
  try {
    if (mods.accounts?.boardSpaceMap && mods.notifications?.spaceReach) {
      reach = mods.notifications.spaceReach(
        db,
        mods.accounts.boardSpaceMap(db, { data_ids: pg }),
        String(mods.accounts.DEFAULT_SPACE_ID || 'sp_team_a')
      );
    }
  } catch (err) {
    log('space gate unavailable: %o', err);
  }
  if (db && typeof db === 'object') {
    REACH_CACHE.set(db, { at: now, pg, reach });
  }
  return reach;
}

/** Drop the alias cache (tests; after an owner assignment in this process). */
export function resetNotificationAliasCache() {
  ALIAS_MAP_CACHE = new WeakMap();
  REACH_CACHE = new WeakMap();
}

/**
 * One long-lived registry handle for the process-default environment.
 *
 * `openRegistry` is not free — a file open, three PRAGMAs and the whole
 * idempotent migration, ~0.5 ms — and this module used to pay it per inbox
 * read, per ack, per scan and per pushed notification. The handle is keyed by
 * the resolved path and re-validated by inode on every use, so a registry
 * that was replaced or moved (tests do both) is reopened rather than read
 * through a stale descriptor. WAL mode makes a long-lived reader safe next to
 * the MCP server's writers: each statement sees the latest commit.
 *
 * @type {{ path: string, ino: number, dev: number, db: any } | null}
 */
let SHARED_REGISTRY = null;

/**
 * @param {{ registry: any }} mods
 * @returns {any | null}
 */
function sharedRegistry(mods) {
  /** @type {string} */
  let file;
  /** @type {fs.Stats | null} */
  let st = null;
  try {
    file = mods.registry.getRegistryPath(process.env);
    st = fs.statSync(file);
  } catch {
    // Not there yet (or unreadable): let openRegistry create/report it, and
    // cache nothing until it exists.
    dropSharedRegistry();
    return null;
  }
  if (
    SHARED_REGISTRY &&
    SHARED_REGISTRY.path === file &&
    SHARED_REGISTRY.ino === st.ino &&
    SHARED_REGISTRY.dev === st.dev
  ) {
    return SHARED_REGISTRY.db;
  }
  dropSharedRegistry();
  const db = mods.registry.openRegistry();
  SHARED_REGISTRY = { path: file, ino: st.ino, dev: st.dev, db };
  return db;
}

function dropSharedRegistry() {
  const prev = SHARED_REGISTRY;
  SHARED_REGISTRY = null;
  try {
    prev?.db?.close();
  } catch {
    // already closed
  }
}

/**
 * An actor's inbox plus both pending counts — the `list-notifications`
 * payload. `queue` picks which promise `unread_only` filters on: `'seen'`
 * (default — the bell's read_at) or `'handled'` (the agents' handled_at).
 * Both counts ride along either way so a consumer never re-queries.
 *
 * `audience: 'human'` is the bell's view — @mentions only, rows and counts
 * alike. Agents omit it and get every type plus `unhandled_by_type`.
 *
 * @param {string} actor
 * @param {{ unread_only?: boolean, limit?: number, queue?: 'seen'|'handled',
 *           audience?: 'human'|'agent', types?: string[], resolved?: any,
 *           env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<{ notifications: NotificationRow[], unread_count: number, unhandled_count: number, unhandled_by_type?: Record<string, number> }>}
 */
export async function listNotificationsForActor(actor, options = {}) {
  const audience = options.audience === 'human' ? 'human' : undefined;
  const types = Array.isArray(options.types) ? options.types : undefined;
  const scope = await notificationScopeFor(options.resolved, options.env);
  const result = await withStore(
    (mods, db) => ({
      notifications: mods.notifications.listNotifications(db, {
        actor,
        unread_only: options.unread_only,
        limit: options.limit,
        queue: options.queue,
        audience,
        types,
        scope
      }),
      unread_count: mods.notifications.unreadCount(db, actor, {
        audience,
        scope
      }),
      unhandled_count: mods.notifications.unhandledCount(db, actor, {
        audience,
        scope
      }),
      ...(audience === 'human'
        ? {}
        : {
            unhandled_by_type: mods.notifications.unhandledByType(db, actor, {
              scope
            })
          })
    }),
    options.env
  );
  return result || { notifications: [], unread_count: 0, unhandled_count: 0 };
}

/**
 * Mark rows read for an actor. Rows belonging to anyone else are untouchable
 * by construction — see ackNotifications in boards/notifications.mjs. `mode`
 * is the seen/handled split: the browser's bell acks `'seen'`, the agent
 * surfaces ack `'handled'`.
 *
 * @param {string} actor
 * @param {{ ids?: string[], all?: boolean, mode?: 'seen'|'handled',
 *           audience?: 'human'|'agent', resolved?: any,
 *           env?: Record<string, string | undefined> }} options
 * @returns {Promise<{ acked: number, unread_count: number, unhandled_count: number }>}
 */
export async function ackNotificationsForActor(actor, options) {
  const audience = options.audience === 'human' ? 'human' : undefined;
  const scope = await notificationScopeFor(options.resolved, options.env);
  const result = await withStore(
    (mods, db) => ({
      acked: mods.notifications.ackNotifications(db, {
        actor,
        ids: options.ids,
        all: options.all,
        mode: options.mode,
        audience,
        scope
      }),
      unread_count: mods.notifications.unreadCount(db, actor, {
        audience,
        scope
      }),
      unhandled_count: mods.notifications.unhandledCount(db, actor, {
        audience,
        scope
      })
    }),
    options.env
  );
  return result || { acked: 0, unread_count: 0, unhandled_count: 0 };
}

/**
 * Accounts mode: the inbox scope for a resolved caller — every alias, readable
 * boards only. `undefined` (no scope, legacy query) when the resolution carries
 * no principal, i.e. accounts mode is off.
 *
 * @param {any} resolved
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{ recipients: string[], board_ids: string[] | null, include_boardless: boolean } | undefined>}
 */
export async function notificationScopeFor(resolved, env = process.env) {
  if (!resolved || !resolved.principal) return undefined;
  const p = resolved.principal;
  const boards = await readableBoardIds(resolved, env);
  const spaces = await readableSpaceIds(resolved);
  return {
    recipients: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
    board_ids: boards === null ? null : [...boards],
    include_boardless: spaces === null || spaces.has('sp_team_a')
  };
}

/**
 * The user directory — live registered agents across every board, in the
 * roster-safe projection. What `list-users` serves, and what @mention
 * autocomplete is built from.
 *
 * @param {{ include_revoked?: boolean }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listUsersDirectory(options = {}) {
  const users = await withStore((mods, db) =>
    mods.notifications.listUserDirectory(db, options)
  );
  return users || [];
}

/**
 * Resolve the actor behind an HTTP request to the notification API.
 *
 * Three doors exist on the base instance: a verified bearer and a loopback
 * actor shortcut (both legacy behavior), plus no identity. A valid silo keeps
 * bearer precedence but replaces the spoofable actor shortcut with a verified
 * Feads SSO cookie binding.
 *
 * @param {import('express').Request} req
 * @param {{ env?: Record<string, string | undefined>,
 *           ssoVerifier?: ReturnType<typeof createPlatformSsoVerifier>,
 *           accountsVerifier?: any,
 *           resolveToken?: (token: string) => Promise<any | null> }} [options]
 * @returns {Promise<{ actor: string, agent?: any, resolved?: any, system?: boolean,
 *   via: 'token'|'sso'|'sso_internal'|'local'|'' } &
 *   { credential_rejected?: boolean, error_code?: string } >}
 */
export async function resolveHttpActor(req, options = {}) {
  const env = options.env || process.env;
  const mode = siloMode(env);
  const silo = mode === 'silo';
  const invalid_silo = mode === 'invalid';
  const raw_authorization = req.headers?.authorization;

  // Accounts mode (the excluded hosted-provider design): the base instance
  // authenticates like a silo — explicit token, else verified platform SSO — and
  // the loopback actor shortcut is gone (it would let any local process name any
  // user). Everything downstream reads `resolved.principal` for space scoping.
  if (mode === 'base' && (await accountsOn(env))) {
    const resolved = await resolveRequestIdentity(req, {
      env,
      ...(options.accountsVerifier
        ? { verifier: options.accountsVerifier }
        : {})
    });
    if (!resolved.agent || !resolved.identity) {
      if (resolved.principal?.kind === 'system') {
        return { actor: '', via: 'token', resolved, system: true };
      }
      return rejectHttpActor(resolved.error_code || 'token_rejected');
    }
    return {
      actor: String(resolved.identity.actor || ''),
      agent: resolved.agent,
      via: resolved.http_via === 'sso' ? 'sso' : 'token',
      resolved
    };
  }

  // Keep the base door byte-for-byte in behavior: its case-sensitive Bearer
  // spelling and loopback actor fallback are legacy compatibility contracts.
  if (mode === 'base') {
    const header = String(raw_authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token.length > 0) {
      const resolved = options.resolveToken
        ? await options.resolveToken(token)
        : null;
      const actor = resolved
        ? resolved.agent || resolved
        : await withStore((mods, db) => {
            const agent = mods.agents.verifyAgentToken(db, token);
            return agent || null;
          }, env);
      return {
        actor: actor?.actor || '',
        agent: actor || undefined,
        via: actor ? 'token' : '',
        ...(resolved?.identity ? { resolved } : {})
      };
    }
    const explicit = String(
      (req.body && req.body.actor) || req.query?.actor || ''
    ).trim();
    if (explicit.length > 0 && isLoopbackRequest(req)) {
      return { actor: explicit, via: 'local' };
    }
    return { actor: '', via: '' };
  }

  const authorization = readSiloAuthorization(req);
  if (authorization.ambiguous) {
    return rejectHttpActor('token_rejected');
  }

  // Only a Bearer value with the exact Feads agent namespace is an explicit
  // Feads credential. a reverse proxy may forward a provider Authorization header; that
  // header is deliberately ignored so a valid SSO cookie can still authenticate.
  if (authorization.value) {
    const token = explicitFeadsBearer(authorization.value);
    if (token !== null) {
      const checked = await verifySiloToken(token, env, options.resolveToken);
      if (!checked.available) return rejectHttpActor('registry_unavailable');
      if (!checked.agent) return rejectHttpActor('token_rejected');
      return httpAgent(checked.agent, 'token', checked.resolved);
    }
  }

  if (invalid_silo) return rejectHttpActor('silo_configuration_invalid');

  if (silo && isInternalSsoRequest(req, env)) {
    const email = internalSsoEmail(req.body);
    if (!email) return rejectHttpActor('bad_request');
    try {
      const identity = resolveSsoIdentityFromRegistry(email, { env });
      if (!identity) return rejectHttpActor('sso_required');
      return httpAgent(
        { ...identity, id: identity.agent_id, parent_actor: '' },
        'sso_internal'
      );
    } catch (error) {
      return rejectHttpActor(safeSsoErrorCode(error));
    }
  }

  if (silo) {
    // A Feads token cookie is another explicit credential. Its mere presence is
    // authoritative: a stale cookie must not be rescued by provider SSO.
    const cookie_header = req.headers?.cookie;
    const cookie_token = readAgentTokenCookie(
      typeof cookie_header === 'string' ? cookie_header : undefined
    );
    if (hasAgentTokenCookie(cookie_header)) {
      if (!cookie_token) return rejectHttpActor('token_rejected');
      const checked = await verifySiloToken(
        cookie_token,
        env,
        options.resolveToken
      );
      if (!checked.available) return rejectHttpActor('registry_unavailable');
      if (!checked.agent) return rejectHttpActor('token_rejected');
      return httpAgent(checked.agent, 'token', checked.resolved);
    }

    const verifier = options.ssoVerifier || createPlatformSsoVerifier({ env });
    let verification;
    try {
      verification = await verifier.verify(req);
    } catch {
      return rejectHttpActor('sso_provider_unavailable');
    }
    if (!verification.ok) {
      return rejectHttpActor(platformSsoErrorCode(verification.code));
    }
    try {
      const identity = resolveSsoIdentityFromRegistry(
        verification.principal.email,
        { env }
      );
      if (!identity) return rejectHttpActor('sso_required');
      return httpAgent(
        { ...identity, id: identity.agent_id, parent_actor: '' },
        'sso'
      );
    } catch (error) {
      return rejectHttpActor(safeSsoErrorCode(error));
    }
  }

  const explicit = String(
    (req.body && req.body.actor) || req.query?.actor || ''
  ).trim();
  if (explicit.length > 0 && isLoopbackRequest(req)) {
    return { actor: explicit, via: 'local' };
  }
  return { actor: '', via: '' };
}

/**
 * Read Authorization without allowing Node's array form or duplicate-header
 * concatenation to choose a credential implicitly.
 *
 * @param {import('express').Request} req
 * @returns {{ value: string, ambiguous: boolean }}
 */
function readSiloAuthorization(req) {
  const raw = req.headers?.authorization;
  if (Array.isArray(raw) || (raw !== undefined && typeof raw !== 'string')) {
    return { value: '', ambiguous: true };
  }
  const raw_headers = req.rawHeaders;
  if (Array.isArray(raw_headers)) {
    let count = 0;
    for (let index = 0; index < raw_headers.length; index += 2) {
      if (String(raw_headers[index]).toLowerCase() === 'authorization')
        count += 1;
    }
    if (count > 1) return { value: '', ambiguous: true };
  }
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.includes(',')) return { value: '', ambiguous: value.length > 0 };
  return { value, ambiguous: false };
}

/**
 * @param {string} value
 * @returns {string|null} The Feads token, or null for a non-Feads header.
 */
function explicitFeadsBearer(value) {
  const match = /^Bearer[ \t]+(.+)$/i.exec(value);
  if (!match) return null;
  const token = match[1].trim();
  return token.startsWith(FEADS_AGENT_TOKEN_PREFIX) ? token : null;
}

/**
 * @param {string|string[]|undefined} header
 * @returns {boolean}
 */
function hasAgentTokenCookie(header) {
  if (typeof header !== 'string') return Array.isArray(header);
  return /(?:^|;)\s*feads_agent_token\s*=/.test(header);
}

/**
 * @param {string} token
 * @param {Record<string, string | undefined>} env
 * @param {(token: string) => Promise<any | null>} [resolveToken]
 * @returns {Promise<{ available: boolean, agent: any | null, resolved?: any }>}
 */
async function verifySiloToken(token, env, resolveToken) {
  if (resolveToken) {
    const resolved = await resolveToken(token);
    return {
      available: true,
      agent: resolved?.agent || null,
      resolved: resolved?.identity ? resolved : undefined
    };
  }
  const result = await withStore(
    (mods, db) => ({
      agent: mods.agents.verifyAgentToken(db, token)
    }),
    env
  );
  return result
    ? { available: true, ...result }
    : { available: false, agent: null };
}

/**
 * @param {Record<string, any>} agent
 * @param {'token'|'sso'|'sso_internal'} via
 * @param {any} [resolved]
 * @returns {{ actor: string, agent: any, via: 'token'|'sso'|'sso_internal', resolved?: any }}
 */
function httpAgent(agent, via, resolved) {
  return {
    actor: String(agent.actor || ''),
    agent,
    via,
    ...(resolved ? { resolved } : {})
  };
}

/**
 * @param {string} code
 * @returns {{ actor: string, via: '', credential_rejected: true, error_code: string }}
 */
function rejectHttpActor(code) {
  const safe = String(code || 'not_identified');
  log('silo HTTP authentication rejected: %s', safe);
  return {
    actor: '',
    via: '',
    credential_rejected: true,
    error_code: safe
  };
}

/**
 * @param {string|undefined} code
 * @returns {string}
 */
function platformSsoErrorCode(code) {
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
 * @param {unknown} error
 * @returns {string}
 */
function safeSsoErrorCode(error) {
  const code = String(/** @type {any} */ (error)?.code || '');
  return /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : 'sso_rejected';
}

/**
 * Same standard as server-routes.js: the socket's peer address, never a
 * forwarded header — anyone who can set X-Forwarded-For is exactly who this
 * must exclude. Base behavior intentionally retains its historical 127/8
 * acceptance; the silo SSO path never reaches this shortcut.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isLoopbackRequest(req) {
  const addr = String(req.socket?.remoteAddress || '');
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.')
  );
}

/**
 * State-changing browser calls in a silo need the exact configured public
 * origin. Bearer calls are machine-authenticated and remain CSRF-safe without
 * an Origin header; platform-SSO cookie calls must pass this check.
 *
 * @param {import('express').Request} req
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isSiloMutationOriginAllowed(req, env = process.env) {
  if (siloMode(env) !== 'silo') return true;
  if (isInternalSsoRequest(req, env)) return true;
  const authorization = readSiloAuthorization(req);
  // Only an explicit Feads bearer is a machine credential. Provider
  // Authorization forwarded by a reverse proxy remains an ambient browser credential and
  // therefore still needs the exact browser Origin.
  if (!authorization.ambiguous && authorization.value) {
    return explicitFeadsBearer(authorization.value) !== null;
  }
  return isExactOrigin(req.headers?.origin, env.FEADS_PUBLIC_URL);
}

/**
 * Confirm the resolved actor is suitable for a silo browser mutation.
 *
 * @param {import('express').Request} req
 * @param {{ actor: string, via: string, resolved?: any }} auth
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isSiloBrowserMutationAllowed(req, auth, env = process.env) {
  // Accounts mode: an ambient browser credential (SSO or token cookie) needs the
  // exact public Origin; a bearer does not.
  if (auth?.resolved?.http_via) {
    return mutationOriginAllowed(req, auth.resolved, env);
  }
  if (siloMode(env) !== 'silo') return true;
  if (auth.via === 'sso_internal' && isInternalSsoRequest(req, env)) {
    return true;
  }
  if (!isSiloMutationOriginAllowed(req, env)) return false;
  return auth.via === 'token' || auth.via === 'sso';
}

/**
 * Mount the HTTP notification API. Exists for the MCP server, `bd`, and curl
 * — the *agent* door, as opposed to the browser's ws ops. That difference is
 * semantic, not just transport: HTTP reads default to the **handled** queue
 * (what does an agent still owe?) and the HTTP ack marks rows **handled**,
 * while the browser's ws surface only ever marks them seen. The ack is the
 * one write the registry accepts from outside the dashboard process —
 * proxied through it, as sign-up already is.
 *
 * @param {import('express').Express} app
 * @param {{ env?: Record<string, string | undefined>,
 *           ssoVerifier?: ReturnType<typeof createPlatformSsoVerifier> }} [options]
 */
export function attachNotificationRoutes(app, options = {}) {
  const env = options.env || process.env;
  const authOptions = { env, ssoVerifier: options.ssoVerifier };

  app.get('/api/notifications', async (req, res) => {
    const auth = await resolveHttpActor(req, authOptions);
    const { actor } = auth;
    if (!actor) {
      res.status(401).json({ ok: false, error: 'not_identified' });
      return;
    }
    const unread_only = String(req.query?.unread_only ?? '1') !== '0';
    const limit = Number.parseInt(String(req.query?.limit ?? '50'), 10) || 50;
    // `queue=seen` opts a caller back into the bell's view; agents get the
    // handled queue without asking, because that is the question they poll.
    const queue =
      String(req.query?.queue ?? 'handled') === 'seen' ? 'seen' : 'handled';
    // `audience=human` is the bell's view (mentions only); the default is the
    // agent's — every type. `types=a,b` narrows either.
    const audience =
      String(req.query?.audience ?? '') === 'human' ? 'human' : undefined;
    const types_raw = String(req.query?.types ?? '').trim();
    const types =
      types_raw.length > 0
        ? types_raw
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        : undefined;
    const payload = await listNotificationsForActor(actor, {
      unread_only,
      limit,
      queue,
      audience,
      types,
      env,
      resolved: auth.resolved
    });
    res.status(200).json({ ok: true, actor, ...payload });
  });

  app.post('/api/notifications/ack', async (req, res) => {
    const auth = await resolveHttpActor(req, authOptions);
    if (!auth.actor) {
      const code = auth.error_code || 'not_identified';
      const status =
        code === 'registry_unavailable'
          ? 503
          : code === 'bad_request'
            ? 400
            : 401;
      res.status(status).json({ ok: false, error: code });
      return;
    }
    if (!isSiloBrowserMutationAllowed(req, auth, env)) {
      res.status(403).json({ ok: false, error: 'origin_forbidden' });
      return;
    }
    const { actor } = auth;
    const body = req.body || {};
    const ids = Array.isArray(body.ids)
      ? body.ids.map((/** @type {unknown} */ v) => String(v))
      : undefined;
    const all = body.all === true;
    if (!all && (!ids || ids.length === 0)) {
      res.status(400).json({
        ok: false,
        error: 'payload requires ids: string[] or all: true'
      });
      return;
    }
    // The HTTP ack is an agent saying "handled" — notifications_ack's contract
    // ("ack means handled, not read"). The browser's seen-ack never comes
    // through here; it rides the ws op.
    const result = await ackNotificationsForActor(actor, {
      ids,
      all,
      mode: 'handled',
      env,
      resolved: auth.resolved
    });
    res.status(200).json({ ok: true, actor, ...result });
  });
}

/**
 * A change fingerprint for a board directory: the mtimes and sizes of the
 * small set of files a write always moves.
 *
 * Why not fs.watch: the board is an embedded Dolt repository, so a write from
 * any door lands deep inside `embeddeddolt/<db>/.dolt/noms/` — invisible to a
 * non-recursive watch of `.beads`. And a *recursive* watch is worse: `bd
 * export` — the very read the scan performs — itself appends to the noms
 * journal, so every scan would fire the watcher that schedules the next scan,
 * forever. Stat-polling a fingerprint and re-recording it *after* our own
 * export breaks that loop by construction: the engine never reacts to writes
 * it just made, only to ones that arrived since.
 *
 * @param {string} board_dir
 * @returns {string}
 */
export function boardFingerprint(board_dir) {
  /** @type {string[]} */
  const parts = [];
  /** @param {string} p */
  const stamp = (p) => {
    try {
      const st = fs.statSync(p);
      parts.push(`${p}:${st.mtimeMs}:${st.size}`);
    } catch {
      // absent is a valid state; its absence is itself part of the fingerprint
    }
  };
  // Embedded Dolt: the noms manifest + journal move on every write.
  try {
    const dolt_root = path.join(board_dir, 'embeddeddolt');
    for (const db of fs.readdirSync(dolt_root)) {
      stamp(path.join(dolt_root, db, '.dolt', 'noms', 'manifest'));
      stamp(path.join(dolt_root, db, '.dolt', 'noms', 'journal.idx'));
      stamp(path.join(dolt_root, db, '.dolt', 'repo_state.json'));
    }
  } catch {
    // not a Dolt board
  }
  // SQLite boards: the database file and its WAL.
  try {
    for (const f of fs.readdirSync(board_dir)) {
      if (f.endsWith('.db') || f.endsWith('.db-wal')) {
        stamp(path.join(board_dir, f));
      }
    }
  } catch {
    // board directory unreadable/absent — the empty fingerprint says so
  }
  return parts.join('|');
}

/**
 * Create the engine. Call `start()` to begin polling; `nudge(board_dir)`
 * after a mutation for a prompt rescan; `stop()` to release everything.
 *
 * @param {Object} options
 * @param {() => Promise<EngineBoard[]>} options.listBoards - Every board to
 * watch: the registry's plus the seed the daemon booted on.
 * @param {(rows: NotificationRow[]) => void} [options.onNotify] - Called with
 * freshly minted rows, after they are persisted.
 * @param {typeof runBd} [options.run]
 * @param {number} [options.sweep_interval_ms] - Periodic safety-net rescan +
 * board-list refresh. Default 5 minutes.
 * @param {number} [options.poll_interval_ms] - How often each board's change
 * fingerprint is stat-polled. Default 3 seconds; `0` disables polling (tests
 * that drive scans explicitly).
 * @param {(board_dir: string) => string} [options.fingerprint]
 * @returns {{ start: () => Promise<void>, stop: () => void, nudge: (board_dir: string) => void, scanAll: () => Promise<void> }}
 */
export function createNotificationsEngine(options) {
  const run = options.run || runBd;
  const sweep_ms = options.sweep_interval_ms ?? 300000;
  // feads: in Postgres mode there is nothing to stat-poll — the change signal
  // is `LISTEN feads_events`, which is both immediate and exact, where the
  // fingerprint was a 3-second guess repeated per board forever. An explicit
  // `poll_interval_ms` still wins, so a test can pin either behaviour.
  const pg_mode = !options.run && Boolean(getPgStore());
  const poll_ms = options.poll_interval_ms ?? (pg_mode ? 0 : 3000);
  const fingerprint = options.fingerprint || boardFingerprint;
  const onNotify = options.onNotify || (() => {});

  /** @type {(() => void) | null} */
  let unsubscribe_pg = null;

  /** @type {Map<string, { board: EngineBoard, poller: ReturnType<typeof setInterval> | null }>} */
  const boards = new Map();
  /** @type {Map<string, string>} */
  const fingerprints = new Map();
  /** @type {Map<string, Promise<void>>} */
  const in_flight = new Map();
  /** @type {Set<string>} */
  const dirty = new Set();
  /**
   * Issues a scan should read, per board key, accumulated between scans. A
   * `null` entry means "everything" — an event that named no issue, the
   * sweep, a first sight. Postgres only: a `bd export` is all-or-nothing.
   *
   * @type {Map<string, Set<string> | null>}
   */
  const pending = new Map();
  /**
   * The last cursor each board's scan persisted. Saves a `notify_state` read
   * and a parse of the whole board's cursor per scan; the engine is that
   * table's only writer, so the copy cannot go stale behind its back.
   *
   * @type {Map<string, any>}
   */
  const state_cache = new Map();
  /** @type {ReturnType<typeof setInterval> | null} */
  let sweep_timer = null;
  let stopped = false;
  let prune_counter = 0;

  /** @param {EngineBoard} board */
  const keyFor = (board) => path.resolve(board.board_dir || board.cwd || '');

  /**
   * Scan one board, serialized per board: a scan requested while one is
   * running marks the board dirty and reruns once, not N times.
   *
   * @param {EngineBoard} board
   * @param {string} [issue_id] - The issue a change event named; omitted, the
   * scan covers the whole board.
   * @returns {Promise<void>}
   */
  function scanBoard(board, issue_id = '') {
    const key = keyFor(board);
    // Accumulate what the next scan must read. An id-less request widens the
    // next scan to the whole board; ids are only honoured in Postgres mode.
    const id = pg_mode ? String(issue_id || '') : '';
    if (id.length === 0) {
      pending.set(key, null);
    } else if (!pending.has(key)) {
      pending.set(key, new Set([id]));
    } else {
      pending.get(key)?.add(id);
    }
    return runScan(board, key);
  }

  /**
   * @param {EngineBoard} board
   * @param {string} key
   * @returns {Promise<void>}
   */
  function runScan(board, key) {
    const running = in_flight.get(key);
    if (running) {
      dirty.add(key);
      return running;
    }
    const job = (async () => {
      try {
        await scanOnce(board, key);
      } catch (err) {
        log('scan failed for %s: %o', key, err);
        // Whatever that scan was reading is unaccounted for now: the next
        // one (event or sweep) reads the whole board.
        pending.set(key, null);
      } finally {
        in_flight.delete(key);
        // The rerun reads what accumulated in `pending` meanwhile — not the
        // whole board, which is what calling scanBoard() bare would ask for.
        if (dirty.delete(key) && !stopped) {
          void runScan(board, key);
        }
      }
    })();
    in_flight.set(key, job);
    return job;
  }

  /**
   * @param {EngineBoard} board
   * @param {string} key
   */
  async function scanOnce(board, key) {
    /** @type {any[] | null} */
    let pg_issues = null;
    /** @type {{ code: number, stdout: string, stderr: string } | null} */
    let res = null;
    // What this scan reads: the ids events named since the last one, or the
    // whole board. A partial scan needs a cursor in memory to fold into;
    // without one (first scan since start) it widens to a full one.
    const wanted = pending.has(key) ? pending.get(key) : null;
    pending.delete(key);
    /** @type {string[] | null} */
    const partial_ids =
      pg_mode && wanted && wanted.size > 0 && state_cache.has(key)
        ? [...wanted]
        : null;
    /** @type {any[] | null} */
    let holders = null;
    if (pg_mode) {
      // One query where there was a `bd export` per board per change — and,
      // since 2026-10, one query over just the issues the change named: the
      // NOTIFY carries the id, so a comment on one issue no longer re-reads
      // every issue and every comment on its board.
      const store = getPgStore();
      if (!store) {
        return;
      }
      const board_id = await store.resolveBoardId(board.board_dir);
      pg_issues = partial_ids
        ? await store.exportIssues(board_id, { ids: partial_ids })
        : await store.exportIssues(board_id, { with_artifacts: true });
      // Overlap is checked across every board's live work, but only when
      // something scanned holds artifacts — the common write does not.
      const any_artifacts = pg_issues.some(
        (it) =>
          it.metadata &&
          typeof it.metadata === 'object' &&
          Object.keys(it.metadata).length > 0
      );
      if (any_artifacts && typeof store.liveArtifactHolders === 'function') {
        try {
          holders = await store.liveArtifactHolders();
        } catch (err) {
          log('artifact holders query failed: %o', err);
          holders = null;
        }
      }
    } else {
      res = await run(['export'], {
        cwd: board.cwd,
        board_dir: board.board_dir,
        timeout_ms: 60000
      });
      // Recorded after the export finished writing (a Dolt "read" appends to the
      // noms journal), so the poller never chases the scan's own footprints. An
      // external write that lands *during* the export window can be absorbed
      // into this fingerprint unseen — the periodic sweep is the backstop.
      fingerprints.set(key, fingerprint(board.board_dir));
      if (res.code !== 0) {
        log(
          'bd export failed for %s (code %d): %s',
          key,
          res.code,
          String(res.stderr || '').slice(0, 200)
        );
        return;
      }
    }
    /** @type {NotificationRow[]} */
    const minted = [];
    // Accounts mode: a person's aliases are one recipient, so their own act
    // through one alias never notifies another (mira commenting on an issue
    // alex-laptop owns).
    const accounts_on = await accountsOn();
    await withStore((mods, db) => {
      const n = mods.notifications;
      const issues = pg_issues
        ? pg_issues.map((it) =>
            it.metadata && typeof it.metadata === 'object'
              ? { ...it, artifacts: n.exportArtifacts(it.metadata) }
              : it
          )
        : n.parseExportForNotifications(res ? res.stdout : '');
      const prev = state_cache.get(key) || n.loadNotifyState(db, key);
      if (!prev) {
        // First sight of this board: set the cursor, tell nobody. Everything
        // that already happened predates the inbox.
        const baseline = n.stateFromExport(issues);
        n.saveNotifyState(db, key, baseline);
        state_cache.set(key, baseline);
        log('baseline recorded for %s (%d issues)', key, issues.length);
        return;
      }
      const { notifications, next_state } = n.computeBoardEvents({
        prev,
        issues,
        resolver: n.createRecipientResolver(db, {
          aliases: accounts_on ? cachedAliasMap(mods, db) : null,
          reach: accounts_on
            ? cachedSpaceReach(
                mods,
                db,
                // The inbox reads' rule (accounts.js boardSpaces), so the gate
                // and the reads agree on which board a row belongs to.
                String(process.env.FEADS_PG_DSN || '').trim().length > 0
              )
            : null
        }),
        artifact_index: holders
          ? holders.map((h) => ({
              issue_id: h.issue_id,
              board_id: h.board_id,
              title: h.title,
              status: h.status,
              holder: h.holder,
              artifacts: n.exportArtifacts(h.metadata)
            }))
          : undefined,
        board_id: board.board_id || '',
        now: Date.now()
      });
      const stored = n.insertNotifications(db, notifications) || notifications;
      const cursor = partial_ids
        ? n.mergeBoardState(prev, issues, partial_ids)
        : next_state;
      n.saveNotifyState(db, key, cursor);
      state_cache.set(key, cursor);
      minted.push(...stored);
      prune_counter += 1;
      if (prune_counter % 200 === 1) {
        const dropped = n.pruneNotifications(db);
        if (dropped > 0) log('pruned %d read notification(s)', dropped);
      }
    });
    if (minted.length > 0) {
      log('%d notification(s) minted on %s', minted.length, key);
      try {
        onNotify(minted);
      } catch (err) {
        log('onNotify failed: %o', err);
      }
    }
  }

  /** Refresh the board set: watch new boards, drop vanished ones. */
  async function ensureBoards() {
    /** @type {EngineBoard[]} */
    let listed = [];
    try {
      listed = await options.listBoards();
    } catch (err) {
      log('listBoards failed: %o', err);
      return;
    }
    const seen = new Set();
    for (const board of listed) {
      const key = keyFor(board);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      if (boards.has(key)) continue;
      /** @type {ReturnType<typeof setInterval> | null} */
      let poller = null;
      if (poll_ms > 0) {
        poller = setInterval(() => {
          if (in_flight.has(key)) return;
          const fp = fingerprint(board.board_dir);
          if (fp !== fingerprints.get(key)) {
            log('change detected on %s → scan', key);
            void scanBoard(board);
          }
        }, poll_ms);
        poller.unref?.();
      }
      boards.set(key, { board, poller });
      void scanBoard(board);
    }
    for (const [key, entry] of boards) {
      if (!seen.has(key)) {
        if (entry.poller) clearInterval(entry.poller);
        boards.delete(key);
        fingerprints.delete(key);
      }
    }
  }

  /**
   * Scan the board a Postgres NOTIFY named. The event carries a board *id* and
   * this engine is keyed by board *directory*, so the id is matched against the
   * boards already being watched rather than looked up — the set is small and
   * an id nobody watches is nothing to scan.
   *
   * @param {string} board_id - Board id from the event.
   */
  function scanByBoardId(board_id, issue_id = '') {
    for (const { board } of boards.values()) {
      if (boardIdForDir(board.board_dir) === board_id) {
        void scanBoard(board, issue_id);
      }
    }
  }

  return {
    async start() {
      stopped = false;
      await ensureBoards();
      if (pg_mode) {
        // Replaces the per-board stat poll: a write from any door — this
        // dashboard, the MCP server, a CLI — announces itself, so a mention
        // lands in the inbox in the time it takes to run one query instead of
        // within three seconds if the fingerprint happened to move.
        unsubscribe_pg = onPgEvent((event) => {
          if (!stopped) {
            scanByBoardId(event.board_id, event.issue_id);
          }
        });
      }
      // The sweep stays in both modes. It is the backstop for everything the
      // change signal can miss — a board registered mid-session, a NOTIFY
      // dropped while the listen connection was reconnecting.
      sweep_timer = setInterval(() => {
        void ensureBoards();
        for (const { board } of boards.values()) {
          void scanBoard(board);
        }
      }, sweep_ms);
      sweep_timer.unref?.();
      log('engine started (%d board(s), pg=%s)', boards.size, pg_mode);
    },
    stop() {
      stopped = true;
      if (unsubscribe_pg) {
        unsubscribe_pg();
        unsubscribe_pg = null;
      }
      if (sweep_timer) clearInterval(sweep_timer);
      sweep_timer = null;
      for (const entry of boards.values()) {
        if (entry.poller) clearInterval(entry.poller);
      }
      boards.clear();
      fingerprints.clear();
      pending.clear();
      state_cache.clear();
    },
    /**
     * Rescan the board a mutation just landed on, without waiting for its
     * watcher. Unknown keys fall back to a full pass — better one spurious
     * sweep than a missed event on a board registered mid-session.
     *
     * @param {string} board_dir
     */
    nudge(board_dir) {
      const key = path.resolve(String(board_dir || ''));
      const entry = boards.get(key);
      if (entry) {
        void scanBoard(entry.board);
        return;
      }
      void ensureBoards().then(() => {
        const found = boards.get(key);
        if (found) void scanBoard(found.board);
      });
    },
    async scanAll() {
      await ensureBoards();
      for (const { board } of boards.values()) {
        void scanBoard(board);
      }
      // Drain to quiescence, dirty reruns included, so a caller (or test) that
      // awaits this observes the store, not a scan that is still landing.
      while (in_flight.size > 0) {
        await Promise.all([...in_flight.values()]);
      }
    }
  };
}
