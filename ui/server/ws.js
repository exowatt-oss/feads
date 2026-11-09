/**
 * @import { Server } from 'node:http'
 * @import { RawData, WebSocket } from 'ws'
 * @import { MessageType } from '../app/protocol.js'
 */
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  AgentRemovalError,
  inspectAgentRemoval,
  removeAgentActor,
  touchAgent
} from '../../boards/agents.mjs';
import { listFlares } from '../../boards/flares.mjs';
import { getRegistryPath, openRegistry } from '../../boards/registry.mjs';
import { isRequest, makeError, makeOk } from '../app/protocol.js';
import {
  accountsOn,
  accountsOnSync,
  boardSpaces,
  decide,
  loadAccountsModules,
  principalOf,
  principalSummary,
  readableBoardIds,
  scopeBoardFields,
  scopeIdentityBoard
} from './accounts.js';
import {
  bindConnectionBoard,
  bindSeedBoard,
  findNearestBoardDir,
  getConnectionBoardDir,
  hasConnectionBoard,
  releaseConnectionBoard,
  resolveInitialBoardDir
} from './active-board.js';
import {
  clearAgentTokenCookie,
  isSecureRequest,
  readAgentTokenCookie
} from './agent-cookie.js';
import {
  agentwatchScopeFor,
  collectAgentwatchInputs,
  scopeAgentwatchSnapshot
} from './agentwatch-routes.js';
import { fetchAgentwatchSnapshot } from './agentwatch.js';
import {
  ALL_BOARD_ID,
  ALL_SCOPE_KEY,
  allBoardsPickerEntry,
  allBoardsWorkspaceState,
  fetchListForAllBoards,
  invalidateAggregateBoard,
  isAllBoardsWorkspace,
  resolveIssueBoard
} from './all-board.js';
import { getGitUserName, runBd, runBdJson } from './bd.js';
import { findRegistryBoard, listRegistryBoards } from './board-registry.js';
import { createBoardWatcherPool } from './board-watchers.js';
import { watchBuildIdentity } from './build-identity.js';
import { resolveWorkspaceDatabase } from './db.js';
import {
  SURFACE,
  decideFor,
  listRoster,
  listRosterRows,
  resolveIdentity
} from './identity.js';
import { fetchListForSubscription } from './list-adapters.js';
import { debug } from './logging.js';
import {
  ackNotificationsForActor,
  listNotificationsForActor,
  listUsersDirectory,
  notificationScopeFor
} from './notifications-engine.js';
import { peopleDirectoryFor } from './people-directory.js';
import {
  boardIdForDir,
  getPgStore,
  onPgEvent,
  pgErrorEnvelope
} from './pg-store.js';
import {
  createPlatformSsoVerifier,
  parseAuthCookie,
  validateBrowserOrigin
} from './platform-sso.js';
import { getAvailableWorkspaces } from './registry-watcher.js';
import { resolveSsoIdentity } from './sso-identity.js';
import {
  captureBoard,
  epicGraphPayload,
  readEpicHistory,
  storyBoardKey
} from './story-snapshots.js';
import { SubscriptionRegistry, keyOf, registry } from './subscriptions.js';
import {
  validateAckNotificationsPayload,
  validateListAgentsPayload,
  validateListNotificationsPayload,
  validateRemoveUserPayload,
  validateSetBoardPayload,
  validateSubscribeListPayload
} from './validators.js';
import {
  accountsConnection,
  authenticateAccountsUpgrade,
  bindAccountsConnection,
  canDeliverBoard,
  messageBoardAllowed,
  releaseAccountsConnection,
  resolveAccountsConnection
} from './ws-accounts.js';

const log = debug('ws');

/**
 * Notification types the dashboard (a human surface) shows — mirrors
 * `HUMAN_NOTIFICATION_TYPES` in boards/notifications.mjs, which the ws layer
 * does not import directly (the boards modules load lazily).
 */
const HUMAN_NOTIFICATION_TYPE_SET = new Set(['mention']);

/**
 * permessage-deflate for the dashboard socket (feads).
 *
 * List snapshots are JSON arrays of near-identical objects — a board switch
 * moved ~570 KB uncompressed and deflates ~6x. Only frames above `threshold`
 * are compressed (acks, pings and single-issue upserts are not worth it), at a
 * fast level, with
 * a bounded zlib concurrency so a burst of snapshots cannot queue unbounded
 * work. Per-write upserts (~1-2 KB) stay uncompressed: through zlib's queue
 * they gained latency for no meaningful byte savings (measured).
 * `serverNoContextTakeover` keeps per-connection memory flat (no 32 KB
 * sliding window retained between messages) at a small ratio cost; clients
 * that do not offer the extension keep getting plain frames.
 *
 * `FEADS_WS_DEFLATE=0` turns it off.
 */
const WS_DEFLATE =
  process.env.FEADS_WS_DEFLATE === '0'
    ? false
    : {
        threshold: 4096,
        concurrencyLimit: 10,
        serverNoContextTakeover: true,
        zlibDeflateOptions: { level: 3, memLevel: 8 }
      };

const SILO_SLUG_RE = /^[a-z][a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const RESERVED_SILO_SLUGS = new Set([
  'mcp',
  'api',
  'admin',
  'www',
  'apps',
  'feads'
]);
const MAX_SSO_LEASE_MS = 60_000;
const DEFAULT_SSO_LEASE_MS = 60_000;
const DEFAULT_SSO_READ_CACHE_MS = 60_000;
const DEFAULT_SSO_REVALIDATE_MS = 30_000;
const AGENTWATCH_DEBOUNCE_MS = 200;
const AGENTWATCH_HEARTBEAT_MS = 20_000;

/** @type {Set<WebSocket>} */
const AGENTWATCH_WATCHERS = new Set();
/** @type {ReturnType<typeof setTimeout> | null} */
let AGENTWATCH_REFRESH_TIMER = null;
/** @type {ReturnType<typeof setInterval> | null} */
let AGENTWATCH_HEARTBEAT_TIMER = null;
/** @type {unknown} */
let AGENTWATCH_LAST_SNAPSHOT = undefined;
let AGENTWATCH_REFRESH_GENERATION = 0;

/** @param {unknown} value */
function validSiloSlug(value) {
  return (
    typeof value === 'string' &&
    SILO_SLUG_RE.test(value) &&
    !RESERVED_SILO_SLUGS.has(value)
  );
}

/**
 * Issue types `create-issue` accepts. The same set the `bd` branch validates
 * against, named once so the two branches cannot drift into accepting different
 * things (`decision` is a real bd type but has never been offered by this
 * surface, and adding it here would silently widen the API).
 */
const CREATABLE_TYPES = new Set(['bug', 'feature', 'task', 'epic', 'chore']);

/**
 * Debounced refresh scheduling for active list subscriptions, per board.
 *
 * feads: this used to be a single timer, because the daemon had a single board.
 * It is keyed by board scope key now for the same reason everything else in this
 * file is — a change on the board one connection is looking at must not spend the
 * debounce window of a board another connection is looking at, and must not
 * refresh its lists either.
 *
 * @type {Map<string, ReturnType<typeof setTimeout>>}
 */
const REFRESH_TIMERS = new Map();
let REFRESH_DEBOUNCE_MS = 75;

/**
 * Mutation refresh window gates, per board. While a board's gate is active,
 * watcher-driven refresh scheduling for that board is suppressed. The gate
 * resolves either when a watcher event arrives (via scheduleListRefresh) or when a
 * timeout elapses, at which point a single refresh pass over that board's active
 * list subscriptions is run.
 *
 * Per board rather than global: a write to board A used to suppress board B's
 * watcher refresh for up to half a second and then refresh B as a side effect of
 * A's gate resolving. Nothing about a mutation on one board says anything about
 * another.
 */
/**
 * @typedef {Object} MutationGate
 * @property {boolean} resolved
 * @property {(reason: 'watcher'|'timeout') => void} resolve
 * @property {ReturnType<typeof setTimeout>} timer
 */
/** @type {Map<string, MutationGate>} */
const MUTATION_GATES = new Map();

/**
 * Start a mutation window gate for a board if it has none. The gate resolves on
 * the next watcher event for that board or after `timeout_ms`, then triggers a
 * single refresh run across that board's active list subscriptions.
 *
 * Fire-and-forget; callers should not await this.
 *
 * @param {string} board_key - Board scope key; see `boardScopeKey`.
 * @param {number} [timeout_ms]
 */
function triggerMutationRefreshOnce(board_key, timeout_ms = 500) {
  const key = String(board_key || '');
  // feads: the gate is a workaround for a change signal that does not arrive.
  // On a Dolt board `fs.watch` cannot see the write — it lands inside
  // `embeddeddolt/<db>/.dolt/noms` — so the watcher never fires and every mutation paid
  // the full timeout before its own effect became visible (measured: reply
  // 457ms, visible 2191ms). Postgres has no such gap: the write's own
  // `pg_notify` is already in flight, and any other writer's arrives the same
  // way. Scheduling the ordinary debounced refresh is both faster and simpler,
  // and it is not a race — a refresh that runs before the NOTIFY lands still
  // reads the committed row, and the NOTIFY then coalesces into the same 75ms
  // window.
  if (getPgStore()) {
    scheduleListRefresh(key);
    return;
  }
  if (MUTATION_GATES.has(key)) {
    return;
  }
  /** @type {(r: 'watcher'|'timeout') => void} */
  let doResolve = () => {};
  const p = new Promise((resolve) => {
    doResolve = resolve;
  });
  /** @type {MutationGate} */
  const gate = {
    resolved: false,
    resolve: (reason) => {
      if (gate.resolved) {
        return;
      }
      gate.resolved = true;
      try {
        doResolve(reason);
      } catch {
        // ignore resolve errors
      }
    },
    timer: setTimeout(() => {
      try {
        gate.resolve('timeout');
      } catch {
        // ignore
      }
    }, timeout_ms)
  };
  gate.timer.unref?.();
  MUTATION_GATES.set(key, gate);

  // After resolution, run a single refresh across this board's active subs and
  // clear the gate.
  void p.then(async () => {
    log('mutation window resolved → refresh active subs on %s', key);
    try {
      await refreshBoardSubscriptions(key);
    } catch {
      // ignore refresh errors
    } finally {
      // feads: a mutation on this board is a mutation on the aggregate view.
      nudgeAllBoardsScope(key);
      try {
        clearTimeout(gate.timer);
      } catch {
        // ignore
      }
      if (MUTATION_GATES.get(key) === gate) {
        MUTATION_GATES.delete(key);
      }
    }
  });
}

/**
 * Group every active list subscription by the board its connection is looking at.
 *
 * The board is read from the connection rather than stored on the subscription,
 * because a connection has exactly one board at a time and `applyBoardSelection`
 * re-points all of its subscriptions when that changes. One source of truth means
 * a subscription cannot be left describing a board the connection has left.
 *
 * @returns {Map<string, { board: WorkspaceState, specs: Map<string, { type: string, params?: Record<string,string|number|boolean> }> }>}
 */
function collectActiveBoardSpecs() {
  /** @type {Map<string, { board: WorkspaceState, specs: Map<string, any> }>} */
  const by_board = new Map();
  const wss = CURRENT_WSS;
  if (!wss) {
    return by_board;
  }
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) {
      continue;
    }
    const s = ensureSubs(/** @type {any} */ (ws));
    if (!s.list_subs || s.list_subs.size === 0) {
      continue;
    }
    const board = workspaceFor(/** @type {any} */ (ws));
    if (!board) {
      continue;
    }
    const scope = boardScopeKey(board);
    let group = by_board.get(scope);
    if (!group) {
      group = { board, specs: new Map() };
      by_board.set(scope, group);
    }
    for (const { key, spec } of s.list_subs.values()) {
      if (!group.specs.has(key)) {
        group.specs.set(key, spec);
      }
    }
  }
  return by_board;
}

/**
 * Run refresh for one board's active list subscription specs and publish deltas.
 *
 * @param {string} board_key
 */
async function refreshBoardSubscriptions(board_key) {
  const group = collectActiveBoardSpecs().get(String(board_key || ''));
  if (!group) {
    // Every connection on this board closed or moved on while the refresh was
    // pending. Nothing to fetch, and nobody to send it to.
    return;
  }
  await Promise.all(
    Array.from(group.specs.values()).map(async (spec) => {
      try {
        await refreshAndPublish(group.board, spec);
      } catch {
        // ignore refresh errors per spec
      }
    })
  );
}

/**
 * Schedule a coalesced refresh of active list subscriptions.
 *
 * feads: `board_key` narrows the refresh to one board, which is what a per-board
 * file watcher passes. Omitting it means "something changed and I do not know
 * where", which refreshes every board in use — the honest fallback for a caller
 * that has no board to name, and what the exported symbol meant before boards
 * were per connection.
 *
 * @param {string} [board_key] - Board scope key; see `boardScopeKey`.
 */
export function scheduleListRefresh(board_key) {
  if (board_key === undefined) {
    // Every board somebody is subscribed to, plus every board with a mutation gate
    // waiting: a gate is a promise to refresh once, and a board whose only
    // subscriber has just gone would otherwise leave one hanging until its timeout.
    /** @type {Set<string>} */
    const keys = new Set(collectActiveBoardSpecs().keys());
    for (const key of MUTATION_GATES.keys()) {
      keys.add(key);
    }
    for (const key of keys) {
      scheduleBoardRefresh(key);
    }
    return;
  }
  scheduleBoardRefresh(String(board_key));
}

/**
 * Schedule a coalesced refresh for one board.
 *
 * @param {string} board_key
 */
function scheduleBoardRefresh(board_key) {
  // Suppress watcher-driven refreshes during this board's mutation gate; resolve
  // the gate once.
  const gate = MUTATION_GATES.get(board_key);
  if (gate) {
    try {
      gate.resolve('watcher');
    } catch {
      // ignore
    }
    return;
  }
  const pending = REFRESH_TIMERS.get(board_key);
  if (pending) {
    clearTimeout(pending);
  }
  const timer = setTimeout(() => {
    REFRESH_TIMERS.delete(board_key);
    // Fire and forget; callers don't await scheduling
    void refreshBoardSubscriptions(board_key);
  }, REFRESH_DEBOUNCE_MS);
  timer.unref?.();
  REFRESH_TIMERS.set(board_key, timer);
  // feads: whatever changed this board also changed the aggregate view — and
  // the aggregate's cached slice of it.
  if (board_key !== ALL_SCOPE_KEY) {
    invalidateAggregateBoard(boardIdForDir(board_key));
  }
  nudgeAllBoardsScope(board_key);
}

/**
 * The board scope keys that correspond to a Postgres board id (feads).
 *
 * The two namespaces meet only here. Internally a board is its `.beads`
 * directory — see `boardScopeKey` for why that, and not the registry id — while
 * the database keys everything by board id, so a NOTIFY has to be translated
 * back before it can name a refresh target.
 *
 * The translation is a *lookup over boards in use* rather than a registry
 * query, deliberately: the only scope keys that can be refreshed are ones some
 * connection is subscribed on, so the set to search is small, always current,
 * and needs no I/O. Boards with a pending mutation gate are included for the
 * same reason `scheduleListRefresh()` includes them.
 *
 * @param {string} board_id - The board id from a NOTIFY payload.
 * @returns {Set<string>}
 */
function boardKeysForPgBoardId(board_id) {
  /** @type {Set<string>} */
  const keys = new Set();
  const wanted = String(board_id || '');
  if (wanted.length === 0) {
    return keys;
  }
  for (const key of collectActiveBoardSpecs().keys()) {
    if (boardIdForDir(key) === wanted) {
      keys.add(key);
    }
  }
  for (const key of MUTATION_GATES.keys()) {
    if (boardIdForDir(key) === wanted) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Clear the pending Agentwatch refresh timer.
 *
 * @returns {void}
 */
function clearAgentwatchRefreshTimer() {
  if (AGENTWATCH_REFRESH_TIMER) {
    clearTimeout(AGENTWATCH_REFRESH_TIMER);
    AGENTWATCH_REFRESH_TIMER = null;
  }
  if (AGENTWATCH_HEARTBEAT_TIMER) {
    clearInterval(AGENTWATCH_HEARTBEAT_TIMER);
    AGENTWATCH_HEARTBEAT_TIMER = null;
  }
}

/**
 * Keep the snapshot beating while anyone is watching. Flare heartbeats land in
 * the registry from other processes without a Postgres NOTIFY, and relative
 * recency decays on its own, so a watched Agentwatch refreshes on a fixed
 * cadence in addition to the write-driven refreshes. The interval retires
 * itself when the last watcher leaves.
 *
 * @returns {void}
 */
function ensureAgentwatchHeartbeat() {
  if (AGENTWATCH_HEARTBEAT_TIMER !== null || AGENTWATCH_WATCHERS.size === 0) {
    return;
  }
  AGENTWATCH_HEARTBEAT_TIMER = setInterval(() => {
    if (AGENTWATCH_WATCHERS.size === 0) {
      clearAgentwatchRefreshTimer();
      return;
    }
    void refreshAgentwatch();
  }, AGENTWATCH_HEARTBEAT_MS);
  AGENTWATCH_HEARTBEAT_TIMER.unref?.();
}

/**
 * Recompute Agentwatch once for all current watchers and publish one shared
 * snapshot. A failed recomputation deliberately leaves the last successful
 * snapshot untouched and emits no error event to clients.
 *
 * @returns {Promise<void>}
 */
async function refreshAgentwatch() {
  const generation = AGENTWATCH_REFRESH_GENERATION;
  if (AGENTWATCH_WATCHERS.size === 0) {
    return;
  }
  const pg_store = getPgStore();
  if (!pg_store) {
    return;
  }

  let snapshot;
  try {
    snapshot = await fetchAgentwatchSnapshot(
      pg_store,
      collectAgentwatchInputs()
    );
  } catch (err) {
    log(
      'agentwatch snapshot refresh failed (%s); retaining last snapshot: %o',
      AGENTWATCH_LAST_SNAPSHOT === undefined ? 'none available' : 'available',
      err
    );
    return;
  }

  if (
    generation !== AGENTWATCH_REFRESH_GENERATION ||
    AGENTWATCH_WATCHERS.size === 0
  ) {
    return;
  }
  AGENTWATCH_LAST_SNAPSHOT = snapshot;
  for (const ws of AGENTWATCH_WATCHERS) {
    if (ws.readyState !== ws.OPEN) {
      AGENTWATCH_WATCHERS.delete(ws);
      continue;
    }
    if (canDeliverToConnection(ws)) {
      sendEvent(ws, 'agentwatch', scopeAgentwatchFor(ws, snapshot));
    }
  }
}

/**
 * Schedule one coalesced Agentwatch recomputation. Agentwatch is a process-wide
 * view, unlike board list subscriptions, so one query serves every watcher.
 *
 * @returns {void}
 */
function scheduleAgentwatchRefresh() {
  if (AGENTWATCH_WATCHERS.size === 0 || AGENTWATCH_REFRESH_TIMER !== null) {
    return;
  }
  AGENTWATCH_REFRESH_TIMER = setTimeout(() => {
    AGENTWATCH_REFRESH_TIMER = null;
    void refreshAgentwatch();
  }, AGENTWATCH_DEBOUNCE_MS);
  AGENTWATCH_REFRESH_TIMER.unref?.();
}

/**
 * Nudge the process-wide Agentwatch scheduler after an advisory registry write.
 * The existing debounce coalesces concurrent route writes into one shared
 * snapshot for every watcher.
 *
 * @returns {void}
 */
export function nudgeAgentwatchRefresh() {
  try {
    scheduleAgentwatchRefresh();
  } catch {
    // Runtime presence ingestion remains successful if scheduling is unavailable.
  }
}

/**
 * Reset Agentwatch-only module state for isolated unit tests.
 *
 * @returns {void}
 */
export function resetAgentwatchForTests() {
  clearAgentwatchRefreshTimer();
  AGENTWATCH_WATCHERS.clear();
  AGENTWATCH_LAST_SNAPSHOT = undefined;
  AGENTWATCH_REFRESH_GENERATION += 1;
}

// feads: the change signal, in Postgres mode. Registered at module load because
// registration costs nothing (it appends to a set in `pg-store.js`) and because
// there is no later moment that is guaranteed to happen — `handleMessage` is
// callable without `attachWsServer`, and in legacy mode no event ever arrives.
//
// This is the line that makes a write from *another process* — the MCP server,
// a CLI — refresh an open dashboard. Under `bd` that never worked: the per-board
// `fs.watch` cannot see a write landing inside `embeddeddolt/<db>/.dolt/noms`, so the
// only refreshes that ever fired were the ones this process caused itself.
onPgEvent((event) => {
  scheduleAgentwatchRefresh();
  // feads: the aggregate's per-board cache drops exactly this board's rows.
  invalidateAggregateBoard(String(event.board_id || ''));
  const keys = boardKeysForPgBoardId(event.board_id);
  // feads: the All-boards view aggregates every board, including ones no
  // connection is on directly — so a NOTIFY that maps to zero in-use scope
  // keys can still mean its rows changed.
  nudgeAllBoardsScope(String(event.board_id || ''));
  if (keys.size === 0) {
    return;
  }
  log('pg event %s on %s → refresh', event.kind, event.board_id);
  for (const key of keys) {
    scheduleListRefresh(key);
  }
});

/**
 * @typedef {{
 *   show_id?: string | null,
 *   list_subs?: Map<string, { key: string, spec: { type: string, params?: Record<string, string | number | boolean> } }>,
 *   list_revisions?: Map<string, number>,
 *   pending_migration?: { timer: ReturnType<typeof setTimeout>, client_ids: Set<string> } | null
 * }} ConnectionSubs
 */

/** @type {WeakMap<WebSocket, any>} */
const SUBS = new WeakMap();

/**
 * The agent token each connection presented in its cookie (feads).
 *
 * Identity is per *connection*, not per process. One dashboard can be open in two
 * browsers — one logged in as an agent, one not — and the daemon's own
 * `FEADS_AGENT_TOKEN` is a third, weaker answer that must not be handed to either.
 * So the credential is read once, from the `Cookie` header on the HTTP upgrade
 * request, and remembered against the socket.
 *
 * A `WeakMap` rather than a property on the socket, for two reasons. It cannot be
 * reached by anything holding a `ws` without also holding this module's private
 * map, so no serializer, logger or `JSON.stringify(ws)` can pick a token up by
 * accident; and it drops with the socket, so a closed connection's credential is
 * not still in memory.
 *
 * Consequence worth stating: the cookie is read at the *handshake*, so a login
 * does not change what an already-open socket resolves to. That is why the client
 * reloads after logging in — see `agent-login.js`. A browser cannot attach a new
 * cookie to a socket that is already open, so there is nothing to be clever about.
 *
 * @type {WeakMap<WebSocket, { token: string, present: boolean }>}
 */
const CONNECTION_CREDENTIALS = new WeakMap();

/**
 * @typedef {Object} SiloAuthConfig
 * @property {boolean} enabled
 * @property {boolean} invalid
 * @property {Record<string, string | undefined>} env
 * @property {ReturnType<typeof createPlatformSsoVerifier>} verifier
 * @property {string | undefined} registry_path
 * @property {string | undefined} sso_board_id
 * @property {number} sso_lease_ms
 * @property {number} sso_read_cache_ms
 * @property {number} sso_revalidate_ms
 */

/**
 * The authenticated credential and construction-time silo configuration pinned to
 * one socket. SSO sockets retain the canonical email and immutable binding only;
 * provider and Feads cookie values never cross the wire.
 *
 * @typedef {Object} SiloConnectionAuth
 * @property {'token'|'sso'} mode
 * @property {SiloAuthConfig} config
 * @property {string} [token]
 * @property {string} [email]
 * @property {{ agent_id: string, actor: string, role: string, board_id: string, provenance: string }} [binding]
 */
/** @type {WeakMap<WebSocket, SiloConnectionAuth>} */
const CONNECTION_AUTH = new WeakMap();
/** @type {WeakMap<WebSocket, SiloAuthConfig>} */
const CONNECTION_AUTH_CONFIG = new WeakMap();

/**
 * The sanitized oauth2-proxy cookie family and its short provider-session lease.
 * Nothing here is put on the WebSocket object or returned to the browser. The
 * cookie is the canonical family produced by `parseAuthCookie`, never the raw
 * inbound Cookie header.
 *
 * @typedef {Object} SsoSession
 * @property {string} cookie
 * @property {number} verified_at
 * @property {number} lease_expires_at
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {Promise<boolean> | null} verification
 * @property {boolean} invalidated
 */
/** @type {WeakMap<WebSocket, SsoSession>} */
const CONNECTION_SSO_SESSIONS = new WeakMap();
/** @type {WeakSet<WebSocket>} */
const RELEASED_CONNECTIONS = new WeakSet();
/** @type {WeakSet<WebSocket>} */
const FAILED_SILO_CONNECTIONS = new WeakSet();

/**
 * Build WebSocket authentication from trusted deployment settings. A non-empty
 * invalid FEADS_SILO is never treated as the base deployment.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {any} [options]
 * @returns {SiloAuthConfig}
 */
function createSiloAuthConfig(env = process.env, options = {}) {
  const trusted_env = { ...env };
  const raw =
    typeof trusted_env.FEADS_SILO === 'string' ? trusted_env.FEADS_SILO : '';
  const enabled = validSiloSlug(raw);
  const invalid = raw.length > 0 && !enabled;
  const verifier =
    options.sso_verifier && typeof options.sso_verifier.verify === 'function'
      ? /** @type {ReturnType<typeof createPlatformSsoVerifier>} */ (
          options.sso_verifier
        )
      : createPlatformSsoVerifier({
          env: trusted_env,
          ...(typeof options.auth_proxy_internal_url === 'string'
            ? { auth_proxy_internal_url: options.auth_proxy_internal_url }
            : {})
        });
  const configured_lease = Number(options.sso_lease_ms);
  const sso_lease_ms =
    Number.isFinite(configured_lease) && configured_lease > 0
      ? Math.min(Math.floor(configured_lease), MAX_SSO_LEASE_MS)
      : DEFAULT_SSO_LEASE_MS;
  const configured_read_cache = Number(options.sso_read_cache_ms);
  const sso_read_cache_ms =
    Number.isFinite(configured_read_cache) && configured_read_cache > 0
      ? Math.min(
          Math.floor(configured_read_cache),
          MAX_SSO_LEASE_MS,
          sso_lease_ms
        )
      : Math.min(DEFAULT_SSO_READ_CACHE_MS, sso_lease_ms);
  const configured_revalidate = Number(options.sso_revalidate_ms);
  const sso_revalidate_ms =
    Number.isFinite(configured_revalidate) && configured_revalidate > 0
      ? Math.min(Math.floor(configured_revalidate), MAX_SSO_LEASE_MS)
      : Math.min(DEFAULT_SSO_REVALIDATE_MS, sso_lease_ms);
  return {
    enabled,
    invalid,
    env: trusted_env,
    verifier,
    registry_path:
      typeof options.registry_path === 'string'
        ? options.registry_path
        : undefined,
    sso_board_id:
      typeof options.sso_board_id === 'string'
        ? options.sso_board_id
        : undefined,
    sso_lease_ms,
    sso_read_cache_ms,
    sso_revalidate_ms
  };
}

/**
 * Stop the lease timer and discard the private provider session state.
 *
 * @param {WebSocket} ws
 */
function clearSsoSession(ws) {
  const session = CONNECTION_SSO_SESSIONS.get(ws);
  if (!session) {
    return;
  }
  session.invalidated = true;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  CONNECTION_SSO_SESSIONS.delete(ws);
}

/**
 * Schedule the next provider check. The lease date is also checked by every
 * delivery path, so a delayed timer cannot extend the lease accidentally.
 *
 * @param {WebSocket} ws
 */
function scheduleSsoRevalidation(ws) {
  const session = CONNECTION_SSO_SESSIONS.get(ws);
  const auth = CONNECTION_AUTH.get(ws);
  if (!session || !auth || auth.mode !== 'sso' || session.invalidated) {
    return;
  }
  if (session.timer) {
    clearTimeout(session.timer);
  }
  const until_expiry = Math.max(1, session.lease_expires_at - Date.now());
  const delay = Math.min(auth.config.sso_revalidate_ms, until_expiry);
  session.timer = setTimeout(async () => {
    const current = CONNECTION_SSO_SESSIONS.get(ws);
    if (!current || current !== session || current.invalidated) {
      return;
    }
    try {
      const valid = await revalidateSsoSession(ws);
      if (valid) {
        scheduleSsoRevalidation(ws);
      }
    } catch {
      closeSiloSocket(ws);
    }
  }, delay);
  session.timer.unref?.();
}

/**
 * Bind the sanitized provider cookie family and start its bounded lease.
 *
 * @param {WebSocket} ws
 * @param {SiloConnectionAuth} auth
 * @param {string} cookie
 */
function startSsoSession(ws, auth, cookie) {
  const now = Date.now();
  CONNECTION_SSO_SESSIONS.set(ws, {
    cookie,
    verified_at: now,
    lease_expires_at: now + auth.config.sso_lease_ms,
    timer: null,
    verification: null,
    invalidated: false
  });
  scheduleSsoRevalidation(ws);
}

/**
 * Return whether this socket may receive a server-initiated event or
 * subscription delta. This is intentionally synchronous: delivery must never
 * wait for a provider call, and an expired lease must stop delivery first.
 *
 * @param {WebSocket} ws
 * @returns {boolean}
 */
function canDeliverToConnection(ws) {
  if (RELEASED_CONNECTIONS.has(ws)) {
    return false;
  }
  // Accounts mode came on after this socket opened (red-team RT-4): with mode on,
  // every base socket is bound by the accounts upgrade, so an unbound one was
  // accepted while the mode was off and never had its identity or space scope
  // established. It gets nothing more and is closed; the client reconnects
  // through the accounts upgrade.
  if (!siloConnection(ws) && !accountsConnection(ws) && accountsOnSync()) {
    closeAccountsSocket(ws);
    return false;
  }
  // Accounts mode: never push a board the socket can no longer read. The
  // snapshot is refreshed per message and every 30 s (ws-accounts.js).
  const board_id = String(workspaceFor(ws)?.board_id || '');
  if (board_id && board_id !== ALL_BOARD_ID && !canDeliverBoard(ws, board_id)) {
    return false;
  }
  const auth = CONNECTION_AUTH.get(ws);
  if (!auth || auth.mode !== 'sso') {
    return true;
  }
  const session = CONNECTION_SSO_SESSIONS.get(ws);
  if (
    !session ||
    session.invalidated ||
    Date.now() >= session.lease_expires_at
  ) {
    closeSiloSocket(ws);
    return false;
  }
  return true;
}

/**
 * Re-introspect the exact private cookie family and re-check the immutable
 * silo binding. A provider success never changes the socket's identity: an
 * email or binding change invalidates the socket instead.
 *
 * @param {WebSocket} ws
 * @returns {Promise<boolean>}
 */
async function revalidateSsoSession(ws) {
  const auth = CONNECTION_AUTH.get(ws);
  const session = CONNECTION_SSO_SESSIONS.get(ws);
  if (!auth || auth.mode !== 'sso' || !session || session.invalidated) {
    return false;
  }
  if (session.verification) {
    return session.verification;
  }
  const verification = (async () => {
    let result;
    try {
      result = await auth.config.verifier.verify({
        headers: { cookie: session.cookie }
      });
    } catch {
      closeSiloSocket(ws);
      return false;
    }
    if (!result?.ok || !result.principal?.email) {
      closeSiloSocket(ws);
      return false;
    }
    const email = String(result.principal.email).trim().toLowerCase();
    if (email !== String(auth.email || '')) {
      closeSiloSocket(ws);
      return false;
    }
    const binding = await resolveSiloBinding(auth.config, email, {
      provision: false
    });
    if (!binding || !sameSiloBinding(auth, binding)) {
      closeSiloSocket(ws);
      return false;
    }
    const current = CONNECTION_SSO_SESSIONS.get(ws);
    if (!current || current !== session || current.invalidated) {
      return false;
    }
    const now = Date.now();
    current.verified_at = now;
    current.lease_expires_at = now + auth.config.sso_lease_ms;
    return true;
  })();
  session.verification = verification;
  try {
    return await verification;
  } finally {
    if (session.verification === verification) {
      session.verification = null;
    }
  }
}

/**
 * Check the provider lease for a connection identity. Reads may use the bounded
 * cache; mutations always perform an exact cookie re-introspection.
 *
 * @param {WebSocket} ws
 * @param {boolean} exact
 * @returns {Promise<boolean>}
 */
async function ensureSsoLease(ws, exact) {
  const auth = CONNECTION_AUTH.get(ws);
  const session = CONNECTION_SSO_SESSIONS.get(ws);
  if (!auth || auth.mode !== 'sso') {
    return false;
  }
  if (!session || session.invalidated) {
    closeSiloSocket(ws);
    return false;
  }
  const now = Date.now();
  const cache_expires_at = Math.min(
    session.verified_at + auth.config.sso_read_cache_ms,
    session.lease_expires_at
  );
  if (!exact && now < cache_expires_at) {
    return true;
  }
  return revalidateSsoSession(ws);
}

/** @param {SiloAuthConfig} config */
function isSiloConfig(config) {
  return config.enabled || config.invalid;
}

/** @param {string | undefined | null} header */
function hasAgentTokenCookie(header) {
  return String(header || '')
    .split(';')
    .some(
      (part) => part.trim().split('=', 1)[0].trim() === 'feads_agent_token'
    );
}

/** @param {WebSocket} ws */
function siloConfigFor(ws) {
  return (
    CONNECTION_AUTH_CONFIG.get(ws) ||
    CONNECTION_AUTH.get(ws)?.config ||
    createSiloAuthConfig()
  );
}

/** @param {WebSocket} ws */
function siloConnection(ws) {
  return FAILED_SILO_CONNECTIONS.has(ws) || isSiloConfig(siloConfigFor(ws));
}

/**
 * @param {'token'|'sso'|'configuration'} via
 * @returns {import('./identity.js').ResolvedIdentity & { silo_failure?: boolean }}
 */
function siloIdentityFailure(via = 'configuration') {
  return {
    identity: null,
    agent: null,
    mode: 'rejected',
    stance: 'deny',
    require_identity: true,
    credential_rejected: true,
    via,
    silo_failure: true
  };
}

/**
 * @param {Record<string, any>} binding
 * @param {SiloConnectionAuth} auth
 * @returns {import('./identity.js').ResolvedIdentity & { sso?: { linked: true, email: string, actor: string } }}
 */
function resolvedSsoIdentity(binding, auth) {
  const agent_id = String(binding.agent_id || '');
  const actor = String(binding.actor || '');
  const role = String(binding.role || '');
  const email = String(binding.email || auth.email || '');
  const agent = {
    ...binding,
    id: agent_id,
    actor,
    role,
    board_id: String(binding.board_id || ''),
    revoked_at: 0,
    archived_at: 0,
    expires_at: 0
  };
  const require_identity = ['1', 'true', 'yes', 'on'].includes(
    String(auth.config.env.FEADS_REQUIRE_AGENT || '')
      .trim()
      .toLowerCase()
  );
  return {
    identity: {
      agent_id,
      actor,
      display_name: String(binding.display_name || ''),
      role,
      board_id: String(binding.board_id || ''),
      last_seen_at: Number(binding.last_seen_at || 0)
    },
    agent,
    mode: 'agent',
    stance: require_identity ? 'deny' : 'read_only',
    require_identity,
    credential_rejected: false,
    via: 'sso',
    sso: { linked: true, email, actor }
  };
}

/**
 * @param {SiloAuthConfig} config
 * @param {string} email
 * @param {{ provision?: boolean }} [options]
 * @returns {Promise<Record<string, any> | null>}
 */
async function resolveSiloBinding(config, email, options = {}) {
  if (!config.enabled || !email) return null;
  let db;
  try {
    db = openRegistry({ path: config.registry_path, env: config.env });
    if (options.provision !== true) {
      const binding = db
        .prepare('SELECT agent_id FROM auth_bindings WHERE email = ?')
        .get(email);
      if (!binding) {
        return null;
      }
    }
    return resolveSsoIdentity(db, email, {
      env: config.env,
      board_id: config.sso_board_id
    });
  } catch {
    log('sso_binding_unavailable');
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Authentication failures remain failures even if cleanup also fails.
    }
  }
}

/**
 * @param {SiloConnectionAuth} auth
 * @param {Record<string, any>} binding
 * @returns {boolean}
 */
function sameSiloBinding(auth, binding) {
  const pinned = auth.binding;
  return (
    !!pinned &&
    String(binding.agent_id || '') === pinned.agent_id &&
    String(binding.actor || '') === pinned.actor &&
    String(binding.role || '') === pinned.role &&
    String(binding.board_id || '') === pinned.board_id &&
    String(binding.provenance || '') === pinned.provenance &&
    String(binding.email || auth.email || '') === String(auth.email || '')
  );
}

/** @param {WebSocket} ws */
function closeSiloSocket(ws) {
  FAILED_SILO_CONNECTIONS.add(ws);
  clearSsoSession(ws);
  releaseConnection(ws);
  try {
    if (typeof ws.close === 'function' && ws.readyState === ws.OPEN) {
      ws.close(1008, 'authentication failed');
    }
  } catch {
    // Refusal remains the observable answer for test and already-closing sockets.
  }
}

/**
 * Authenticate an upgrade before `WebSocketServer.handleUpgrade` is called.
 * Feads token cookies are deliberately checked first. A present but bad token is
 * a rejected credential, never an invitation to fall through to platform SSO.
 *
 * @param {any} request
 * @param {SiloAuthConfig} config
 * @returns {Promise<{ auth: SiloConnectionAuth, cookie?: string } | null>}
 */
async function authenticateSiloUpgrade(request, config) {
  if (!config.enabled) return null;
  const raw_cookie = request?.headers?.cookie;
  if (hasAgentTokenCookie(raw_cookie)) {
    const token = readAgentTokenCookie(raw_cookie);
    if (!token) return null;
    try {
      const resolved = await resolveIdentity({ token, env: config.env });
      if (
        resolved.mode !== 'agent' ||
        !resolved.identity?.agent_id ||
        !resolved.identity.actor ||
        !resolved.identity.role
      ) {
        return null;
      }
      return { auth: { mode: 'token', config, token } };
    } catch {
      return null;
    }
  }

  // Do not delegate this check to a request-controlled host or to an injected
  // verifier: the browser origin is always compared with trusted deployment
  // configuration, exactly.
  if (!validateBrowserOrigin(request?.headers?.origin, config.env)) return null;

  const cookie = parseAuthCookie(raw_cookie);
  if (!cookie.ok) return null;

  let verification;
  try {
    verification = await config.verifier.verify({
      headers: { cookie: cookie.header }
    });
  } catch {
    return null;
  }
  if (!verification?.ok || !verification.principal?.email) return null;

  const principal_email = String(verification.principal.email)
    .trim()
    .toLowerCase();
  const binding = await resolveSiloBinding(config, principal_email, {
    provision: true
  });
  if (
    !binding ||
    !String(binding.agent_id || '') ||
    !String(binding.actor || '') ||
    !String(binding.role || '') ||
    !String(binding.provenance || '')
  ) {
    return null;
  }
  return {
    auth: {
      mode: 'sso',
      config,
      email: principal_email,
      binding: Object.freeze({
        agent_id: String(binding.agent_id),
        actor: String(binding.actor),
        role: String(binding.role),
        board_id: String(binding.board_id || ''),
        provenance: String(binding.provenance)
      })
    },
    cookie: cookie.header
  };
}

/**
 * Remember the credential a connection presented (feads).
 *
 * Exported so a test can drive `handleMessage` as a logged-in browser without an
 * HTTP server. A socket that was never bound has no cookie, which is the honest
 * answer for one.
 *
 * @param {WebSocket} ws
 * @param {{ headers?: Record<string, any> } | undefined} request - The upgrade
 * request.
 * @returns {void}
 */
export function bindConnectionCredential(ws, request) {
  const cookie = request?.headers?.cookie;
  const token = readAgentTokenCookie(cookie);
  CONNECTION_CREDENTIALS.set(ws, {
    token,
    present: hasAgentTokenCookie(cookie)
  });
  // Length only, never the value — and only whether one arrived at all.
  log('connection credential: %s', token.length > 0 ? 'cookie' : 'none');
}

/**
 * The token this connection presented, or `''`.
 *
 * @param {WebSocket} ws
 * @returns {string}
 */
function credentialFor(ws) {
  return CONNECTION_CREDENTIALS.get(ws)?.token || '';
}

/** @param {WebSocket} ws */
function credentialPresentFor(ws) {
  return CONNECTION_CREDENTIALS.get(ws)?.present === true;
}

/**
 * Resolve who is acting on this connection (feads).
 *
 * The one place that assembles the arguments, so no handler can forget the
 * connection's cookie and silently fall back to the daemon's environment — which
 * would resolve every browser to the same identity.
 *
 * The board is this connection's too, and not for cosmetic reasons: `board_id` is
 * what scopes the roster, so reading it off a shared "current board" was the
 * mechanism by which one tab's switch changed what another tab's `whoami` and
 * `list-agents` answered.
 *
 * @param {WebSocket} ws
 * @param {{ exact_sso?: boolean }} [options]
 * @returns {Promise<import('./identity.js').ResolvedIdentity & { silo_failure?: boolean, sso?: { linked: true, email: string, actor: string } }>}
 */
async function resolveConnectionIdentity(ws, options = {}) {
  const config = siloConfigFor(ws);
  const auth = CONNECTION_AUTH.get(ws);

  // Base/unset FEADS_SILO follows the existing identity resolver exactly. This
  // preserves its token, operator, and anonymous fallbacks byte-for-byte.
  if (!isSiloConfig(config)) {
    // Accounts mode: a socket authenticated at upgrade re-resolves its user (and
    // memberships) per message. Anything else falls through to the legacy
    // resolver, which attaches an accounts principal itself when the mode is on —
    // so a socket opened before the flip is judged like any other caller.
    if (accountsConnection(ws)) {
      return resolveAccountsConnection(ws, { env: config.env });
    }
    return resolveIdentity({
      token: credentialFor(ws),
      board_id: workspaceFor(ws)?.board_id
    });
  }

  // A malformed silo deployment is not a base deployment. It has no safe
  // identity answer and must never reach operator mode.
  if (!config.enabled) {
    return siloIdentityFailure('configuration');
  }

  if (auth?.mode === 'sso') {
    const provider_valid = await ensureSsoLease(ws, options.exact_sso === true);
    if (!provider_valid) {
      return siloIdentityFailure('sso');
    }
    const binding = await resolveSiloBinding(config, String(auth.email || ''), {
      provision: false
    });
    if (!binding || !sameSiloBinding(auth, binding)) {
      return siloIdentityFailure('sso');
    }
    return resolvedSsoIdentity(binding, auth);
  }

  const token = auth?.token || credentialFor(ws);
  if (!token || (credentialPresentFor(ws) === false && !auth?.token)) {
    return siloIdentityFailure('token');
  }
  const resolved = await resolveIdentity({
    token,
    board_id: workspaceFor(ws)?.board_id,
    env: config.env
  });
  if (
    resolved.mode !== 'agent' ||
    !resolved.identity?.agent_id ||
    !resolved.identity.actor ||
    !resolved.identity.role
  ) {
    return siloIdentityFailure('token');
  }
  return resolved;
}

const ACTIVITY_TOUCH_INTERVAL_MS = 60_000;
/** @type {WeakMap<WebSocket, number>} */
const CONNECTION_ACTIVITY_TOUCHES = new WeakMap();

/**
 * Record authenticated browser activity without putting a write inside the
 * identity resolver. The once-per-minute lease is per connection, not per
 * actor, so two tabs do not suppress one another and a busy tab does not churn
 * the registry on every message.
 *
 * @param {WebSocket} ws
 * @param {import('./identity.js').ResolvedIdentity} resolved
 * @returns {Promise<number | null>}
 */
async function touchConnectionActivity(ws, resolved) {
  const agent_id = String(resolved.identity?.agent_id || '');
  if (resolved.mode !== 'agent' || agent_id.length === 0) {
    return null;
  }
  const now = Date.now();
  const last = CONNECTION_ACTIVITY_TOUCHES.get(ws) || 0;
  if (now - last < ACTIVITY_TOUCH_INTERVAL_MS) {
    return null;
  }
  CONNECTION_ACTIVITY_TOUCHES.set(ws, now);

  const config = siloConfigFor(ws);
  const registry_path = config.registry_path || getRegistryPath(config.env);
  // Tests and a first-start server can resolve an identity from another
  // provider before the local registry exists. Do not create a new registry as
  // a side effect of merely reading a WebSocket message.
  if (!fs.existsSync(registry_path)) {
    return null;
  }
  let db;
  try {
    db = openRegistry({ path: registry_path, env: config.env });
    const agent = touchAgent(db, agent_id);
    const touched_at = Number(agent?.last_seen_at || now);
    if (resolved.identity) {
      resolved.identity.last_seen_at = touched_at;
    }
    return touched_at;
  } catch (error) {
    log('last-seen activity touch failed: %o', error);
    return null;
  } finally {
    db?.close();
  }
}

/**
 * A once-per-message resolver for this connection's actor name (feads).
 *
 * Handed to `runBd` as `options.actor` so `$BEADS_ACTOR` on every bd child is the
 * signed-in agent rather than the daemon's launching shell. Lazy because most messages
 * never spawn bd, memoized because some spawn it more than once, and it answers `''`
 * for an anonymous connection — which leaves bd's own resolution in place, the
 * behaviour that was there before.
 *
 * @param {WebSocket} ws
 * @returns {() => Promise<string>}
 */
function connectionActorThunk(
  ws,
  resolve = () => resolveConnectionIdentity(ws)
) {
  /** @type {Promise<string> | null} */
  let memo = null;
  return () => {
    if (memo === null) {
      memo = resolve().then((resolved) => resolved.identity?.actor || '');
    }
    return memo;
  };
}

/** @type {WebSocketServer | null} */
let CURRENT_WSS = null;

/**
 * The notification engine, when the daemon started one (feads).
 *
 * Module scope for the same reason BOARD_WATCHERS is: mutation handlers run
 * outside `attachWsServer`'s closure and want to nudge a prompt rescan after a
 * write instead of waiting for the file watcher. `null` — in tests, or a
 * checkout without the boards module — degrades every nudge to a no-op; the
 * watcher/sweep path still catches everything, just later.
 *
 * @type {{ nudge: (board_dir: string) => void } | null}
 */
let NOTIFICATIONS_ENGINE = null;

/**
 * Hand the ws layer the engine to nudge. Called by the daemon entry point,
 * which owns the engine's lifecycle (index.js), not by attachWsServer — tests
 * that attach a server must not start scans against the real registry.
 *
 * @param {{ nudge: (board_dir: string) => void } | null} engine
 */
export function setNotificationsEngine(engine) {
  NOTIFICATIONS_ENGINE = engine;
}

/**
 * Nudge the engine about a mutation on this connection's board. Fire-and-forget.
 *
 * @param {WebSocket} ws
 * @param {string | null} [board_dir_override] - The board the mutation actually
 * landed on — the message's `bd_options.board_dir`. Matters on the All-boards
 * pseudo-board, whose connection binding is empty by design.
 */
function nudgeNotifications(ws, board_dir_override) {
  if (!NOTIFICATIONS_ENGINE) {
    return;
  }
  const board_dir =
    board_dir_override !== undefined
      ? board_dir_override
      : getConnectionBoardDir(ws);
  if (typeof board_dir === 'string' && board_dir.length > 0) {
    try {
      NOTIFICATIONS_ENGINE.nudge(board_dir);
    } catch (err) {
      log('notification nudge failed: %o', err);
    }
  }
}

/**
 * Push freshly minted notification rows to whoever is connected as their
 * recipient (feads). The engine calls this after persisting; a recipient with
 * no open socket simply finds the rows in its inbox later — the push is a
 * latency optimization, not the delivery mechanism.
 *
 * @param {Array<import('../../boards/notifications.mjs').NotificationRow>} rows
 * @returns {Promise<void>}
 */
export async function pushNotificationRows(rows) {
  const wss = CURRENT_WSS;
  if (!wss || rows.length === 0) {
    return;
  }
  /** @type {Map<string, Array<(typeof rows)[number]>>} */
  const by_recipient = new Map();
  for (const row of rows) {
    // The browser is the human surface: only @mentions light the bell.
    // Agent-only coordination rows still land in the store for MCP/HTTP.
    if (!HUMAN_NOTIFICATION_TYPE_SET.has(String(row.type))) {
      continue;
    }
    const list = by_recipient.get(row.recipient_actor) || [];
    list.push(row);
    by_recipient.set(row.recipient_actor, list);
  }
  if (by_recipient.size === 0) {
    return;
  }
  /** @type {Map<string, Promise<number>>} */
  const unread_by_actor = new Map();
  for (const ws of wss.clients) {
    /** @type {import('./identity.js').ResolvedIdentity} */
    let resolved;
    try {
      resolved = await resolveConnectionIdentity(ws);
    } catch {
      continue;
    }
    const actor = resolved.identity?.actor || '';
    if (!actor) {
      continue;
    }
    // Accounts mode: the inbox is every alias of the person, and only rows from
    // boards this connection may read — the same scope the bell's listing and
    // badge use, so a push can never show (or count) what a list would not.
    const scope = /** @type {any} */ (resolved).principal
      ? await notificationScopeFor(resolved)
      : undefined;
    /** @type {Array<(typeof rows)[number]>} */
    let mine = [];
    if (scope) {
      const recipients = new Set([actor, ...scope.recipients]);
      for (const [recipient, list] of by_recipient) {
        if (!recipients.has(recipient)) continue;
        for (const row of list) {
          const board = String(row.board_id || '');
          const readable =
            scope.board_ids === null ||
            (board ? scope.board_ids.includes(board) : scope.include_boardless);
          if (readable) mine.push(row);
        }
      }
    } else {
      mine = by_recipient.get(actor) || [];
    }
    if (mine.length === 0) {
      continue;
    }
    // One badge count per recipient (and scope) per push, however many tabs.
    const unread_key = scope
      ? `${actor}\u0000${scope.board_ids === null ? '*' : scope.board_ids.join(',')}`
      : actor;
    let unread = unread_by_actor.get(unread_key);
    if (!unread) {
      unread = listNotificationsForActor(actor, {
        limit: 1,
        audience: 'human',
        ...(scope ? { resolved } : {})
      }).then((r) => r.unread_count);
      unread_by_actor.set(unread_key, unread);
    }
    const unread_count = await unread;
    if (!canDeliverToConnection(ws)) {
      continue;
    }
    for (const notification of mine) {
      sendEvent(ws, 'notification', { notification, unread_count });
    }
  }
}

/**
 * Workspace configuration — which board a connection is looking at.
 *
 * feads additions: `board_dir` is the `.beads` directory that connection's `bd`
 * children are pinned to, and `key`/`board_id`/`name`/`description`/`repos` carry
 * the board registry's metadata so the picker can label a board by what it is for
 * rather than by the directory it happens to live in.
 *
 * @typedef {Object} WorkspaceState
 * @property {string} root_dir
 * @property {string} db_path
 * @property {string} board_dir
 * @property {string} key
 * @property {string} board_id
 * @property {string} name
 * @property {string} description
 * @property {string[]} repos
 * @property {string} [space_id] - Accounts mode: the space an All-boards view is bound to.
 */

/**
 * The workspace a *new* connection starts on (feads).
 *
 * Not "the current workspace": there is no such thing any more, and restoring one
 * would restore ex-dh0. See the header of `active-board.js` for the whole
 * argument; the short version is that an anonymous tab could move the board under
 * a logged-in agent's tab, and the fix is per-connection selection rather than a
 * permission check on the switcher.
 *
 * Written once by `attachWsServer` (and corrected in place by
 * `adoptSeedRegistryMetadata` when the board turns out to have a registry entry).
 * A `set-board` from a browser never writes it.
 *
 * @type {WorkspaceState | null}
 */
let SEED_WORKSPACE = null;

/**
 * The workspace each connection selected, if it selected one.
 *
 * A connection that has never selected anything is deliberately absent, so it
 * reads through to `SEED_WORKSPACE` by reference — one representation of "has not
 * chosen", and a later correction to the seed reaches every such connection with
 * nobody fanning it out. `active-board.js` keys its board WeakMap the same way and
 * for the same reasons; the two are written together in `applyBoardSelection`,
 * which is the only writer of either, so they cannot drift.
 *
 * @type {WeakMap<WebSocket, WorkspaceState>}
 */
const CONNECTION_WORKSPACES = new WeakMap();

/**
 * The workspace this connection is looking at.
 *
 * @param {WebSocket} [ws]
 * @returns {WorkspaceState | null}
 */
function workspaceFor(ws) {
  if (ws) {
    const own = CONNECTION_WORKSPACES.get(ws);
    if (own) {
      return own;
    }
  }
  return SEED_WORKSPACE;
}

/**
 * The key a board is scoped by internally — for its subscription registry, its
 * file watcher, its refresh timer and its mutation gate.
 *
 * The *physical* board: its `.beads` directory, or the project root when there is
 * none. Deliberately not `WorkspaceState.key`, which prefers the registry id: an
 * id is absent for an unregistered board and is adopted asynchronously after
 * startup for a registered one, so the same board would be scoped under two
 * different names depending on when you asked — two registries, two watchers, and
 * a connection whose subscriptions live in the one nothing refreshes.
 *
 * @param {WorkspaceState | null} [workspace]
 * @returns {string}
 */
function boardScopeKey(workspace) {
  if (!workspace) {
    return '';
  }
  // feads: the All-boards pseudo-board has no directory; it is scoped under its
  // own reserved key so it gets a registry, a debounce window and a mutation
  // gate like any physical board.
  if (isAllBoardsWorkspace(workspace)) {
    return /** @type {any} */ (workspace).space_id
      ? workspace.key
      : ALL_SCOPE_KEY;
  }
  return workspace.board_dir || workspace.root_dir || '';
}

/**
 * Whether any open connection is looking at the All-boards pseudo-board
 * (feads). Cheap — one walk over open sockets — and asked only when a refresh
 * is being scheduled somewhere else, to decide whether the aggregate view has
 * to hear about it too.
 *
 * @returns {boolean}
 */
function allBoardsScopeInUse() {
  const wss = CURRENT_WSS;
  if (!wss) {
    return false;
  }
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) {
      continue;
    }
    if (isAllBoardsWorkspace(workspaceFor(/** @type {any} */ (ws)))) {
      return true;
    }
  }
  return false;
}

/**
 * Fetch a subscription's rows for the board a connection is looking at
 * (feads) — the one seam where "which board" turns into "which fetch". A
 * physical board reads itself; the All-boards pseudo-board fans out across
 * every registered board and merges.
 *
 * @param {WorkspaceState | null} board
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 * @returns {ReturnType<typeof fetchListForSubscription>}
 */
async function fetchListForBoard(board, spec) {
  if (String(spec.type) === 'flares') {
    const params = spec.params || {};
    const space_boards = await spaceBoardFilter(board);
    const boards = isAllBoardsWorkspace(board)
      ? (await listRegistryBoards()).filter(
          (entry) =>
            entry.exists &&
            (!space_boards || space_boards.has(String(entry.id)))
        )
      : board?.board_id
        ? [{ id: board.board_id }]
        : [];
    const items = [];
    for (const entry of boards) {
      const db = openRegistry();
      try {
        items.push(
          ...listFlares(db, {
            board_id: entry.id,
            issue_id: String(params.issue_id || '')
          })
        );
      } finally {
        db.close();
      }
    }
    return { ok: true, items };
  }
  if (isAllBoardsWorkspace(board)) {
    return fetchListForAllBoards(spec, { only: await spaceBoardFilter(board) });
  }
  return fetchListForSubscription(spec, {
    cwd: board?.root_dir,
    board_dir: board?.board_dir
  });
}

/**
 * One subscription registry per board (feads).
 *
 * The registry caches each list's items so a refresh can be published as a delta.
 * With a single board that could be a singleton; with N connections on M boards it
 * cannot, because two connections subscribed to `ready-work` on different boards
 * would share one cache, and each refresh would diff one board's issues against
 * the other's and emit deletes for issues that never left. The keys are
 * `keyOf(spec)`, unchanged — the *board* is the registry you look the key up in.
 *
 * The `''` bucket is the imported singleton, and `attachWsServer` aliases the seed
 * board's scope key onto it as well. That keeps the exported `registry` meaningful
 * for the common single-board case (and for the tests that assert against it)
 * while still isolating every additional board.
 *
 * This is also why the old `registry.clear()` on a board switch is gone: it existed
 * to stop the new board being diffed against the old one's cache, which per-board
 * registries make impossible — and it did so by dropping *every* client's
 * subscriptions, which is exactly the cross-connection damage this work removes.
 *
 * @type {Map<string, SubscriptionRegistry>}
 */
const BOARD_REGISTRIES = new Map([['', registry]]);

/**
 * The subscription registry for a board.
 *
 * @param {string} board_key
 * @returns {SubscriptionRegistry}
 */
function registryForBoard(board_key) {
  const key = String(board_key || '');
  let found = BOARD_REGISTRIES.get(key);
  if (!found) {
    found = new SubscriptionRegistry();
    BOARD_REGISTRIES.set(key, found);
  }
  return found;
}

/**
 * Every distinct registry, for a sweep that must not miss one.
 *
 * A `Set` because the seed board's scope key and `''` are aliases of the same
 * object, and `onDisconnect` twice on the same registry is harmless but pointless.
 *
 * @returns {Set<SubscriptionRegistry>}
 */
function allRegistries() {
  return new Set(BOARD_REGISTRIES.values());
}

/**
 * Per-board file watchers (feads).
 *
 * `null` until `attachWsServer` runs, and that matters: `handleMessage` is
 * callable on its own (several test suites do exactly that), and a board switch
 * must not start an `fs.watch` for a server that was never attached. A watcher is
 * an OS handle that keeps the event loop alive, so creating one off the back of a
 * bare message handler would be a leak nobody asked for.
 *
 * @type {ReturnType<typeof createBoardWatcherPool> | null}
 */
let BOARD_WATCHERS = null;

/**
 * Which build this process is running (feads), or `null` when the daemon was attached
 * without one.
 *
 * Module-level rather than per connection, and that is not the same mistake as the
 * board was: a build is a property of the *process*, identically true for every client.
 * The per-connection thing is only whether a given browser's bundle matches it, and
 * that comparison is made in the browser, which is the only place that knows which
 * bundle it loaded.
 *
 * @type {{ report: () => any } | null}
 */
let BUILD_IDENTITY = null;

/**
 * Send a server-initiated event to one connection.
 *
 * @param {WebSocket} ws
 * @param {MessageType} type
 * @param {unknown} [payload]
 */
function sendEvent(ws, type, payload) {
  if (!canDeliverToConnection(ws) || ws.readyState !== ws.OPEN) {
    return;
  }
  try {
    ws.send(
      JSON.stringify({
        id: `evt-${Date.now()}`,
        ok: true,
        type,
        payload
      })
    );
  } catch (err) {
    log('send %s failed: %o', type, err);
  }
}

/**
 * Broadcast a server-initiated event to all open clients.
 *
 * Lives at module scope (rather than only inside `attachWsServer`) because
 * message handlers run outside that closure.
 *
 * feads: a *board change* no longer comes through here. It used to, and that was
 * the visible half of ex-dh0 — one tab switching boards told every other tab to
 * tear down and re-subscribe, so a second tab quietly followed the first one's
 * switch. A board change is now addressed to the connection it happened to; see
 * `applyBoardSelection` and `applySeedSelection`.
 *
 * @param {MessageType} type
 * @param {unknown} [payload]
 */
function broadcastEvent(type, payload) {
  const wss = CURRENT_WSS;
  if (!wss) {
    return;
  }
  for (const ws of wss.clients) {
    sendEvent(ws, type, payload);
  }
}

/**
 * A board selection, before it is applied (feads).
 *
 * Omit `board_dir` to discover the board from `root_dir`.
 *
 * @typedef {Object} BoardSelection
 * @property {string} root_dir - Project root `bd` should run in.
 * @property {string} [board_dir] - Board directory to pin `bd` to.
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [description]
 * @property {string[]} [repos]
 * @property {boolean} [all_boards] - The All-boards pseudo-board (feads); when
 * set, every path field is ignored.
 * @property {string} [space_id] - Accounts mode: the aggregate's space.
 */

/**
 * Turn a selection into workspace state. No side effects — the two appliers below
 * share it so a browser's switch and the daemon's own seed cannot resolve the same
 * selection differently.
 *
 * @param {BoardSelection} selection
 * @returns {WorkspaceState}
 */
function toWorkspaceState(selection) {
  if (selection.all_boards) {
    const state = allBoardsWorkspaceState();
    // Accounts mode: the aggregate is per space, so its scope key is too — one
    // space's aggregate can never be pushed to a socket viewing another.
    if (selection.space_id) {
      return {
        ...state,
        key: `${ALL_BOARD_ID}:${selection.space_id}`,
        space_id: selection.space_id
      };
    }
    return state;
  }
  const root_dir = path.resolve(selection.root_dir);
  const db = resolveWorkspaceDatabase({ cwd: root_dir });
  // Discovery, not $BEADS_DIR: an inherited BEADS_DIR is only ever the *seed*
  // board, and honoring it here would make every switch a no-op.
  const board_dir =
    selection.board_dir === undefined
      ? findNearestBoardDir(root_dir)
      : selection.board_dir;
  const board_id = selection.id || '';
  return {
    root_dir,
    db_path: db.path,
    board_dir,
    key: board_id || board_dir || root_dir,
    board_id,
    name: selection.name || '',
    description: selection.description || '',
    repos: selection.repos || []
  };
}

/**
 * @param {WorkspaceState | null} previous
 * @param {WorkspaceState} next
 * @returns {boolean}
 */
function boardChanged(previous, next) {
  return (
    next.db_path !== (previous?.db_path || '') ||
    next.board_dir !== (previous?.board_dir || '')
  );
}

/**
 * Make a board the one *this connection* is looking at (feads) — pin its `bd`
 * children to it, move its file watcher and its subscriptions across, and tell it
 * (and only it) that its board changed.
 *
 * Both `set-board` and `set-workspace` funnel through here so the two cannot
 * drift into applying a switch differently.
 *
 * Everything here is scoped to `ws`. That is the fix for ex-dh0: an anonymous tab
 * calling `set-board` used to move the daemon's one board, so a logged-in agent's
 * tab silently started reading and writing a different database. Gating the
 * message would have been the wrong tool — the `read_only` stance grants reading
 * *every* board, so refusing the switcher would have cut that down to whichever
 * board the daemon started on. **Making any part of this global again is that same
 * defect**, so do not.
 *
 * @param {WebSocket} ws
 * @param {BoardSelection} selection
 * @returns {{ changed: boolean, workspace: WorkspaceState }}
 */
function applyBoardSelection(ws, selection) {
  const previous = workspaceFor(ws);
  const next = toWorkspaceState(selection);
  const changed = boardChanged(previous, next);

  CONNECTION_WORKSPACES.set(ws, next);
  // feads: the All-boards pseudo-board binds `bd` children to *nothing* — an
  // empty string drops any inherited BEADS_DIR — so an unrouted handler fails
  // honestly instead of writing to whichever board the daemon started on.
  bindConnectionBoard(ws, isAllBoardsWorkspace(next) ? '' : next.board_dir);

  if (!changed) {
    return { changed, workspace: next };
  }

  log(
    'connection board changed: %s → %s (bd pinned to %o)',
    previous?.db_path || '(none)',
    next.db_path,
    next.board_dir || '(discovery)'
  );

  if (BOARD_WATCHERS) {
    // Retain before releasing. The two boards are different by construction here,
    // so the order does not matter for correctness, but retaining first means a
    // board that both the old and the new selection resolve to is never closed and
    // immediately reopened.
    //
    // feads: the All-boards pseudo-board has no directory to watch — its
    // refreshes ride on every physical board's triggers (see the nudge in
    // `scheduleBoardRefresh`) — so it is neither retained nor released here.
    if (!isAllBoardsWorkspace(next)) {
      BOARD_WATCHERS.retain(
        { key: boardScopeKey(next), root_dir: next.root_dir },
        ws
      );
    }
    if (previous && !isAllBoardsWorkspace(previous)) {
      BOARD_WATCHERS.release(boardScopeKey(previous), ws);
    }
  }

  migrateConnectionSubscriptions(ws, previous, next);
  // Addressed to the initiator, never broadcast: a second tab following this one's
  // switch is the same class of bug as the one being fixed here.
  sendEvent(ws, 'workspace-changed', next);
  scheduleListRefresh(boardScopeKey(next));

  return { changed, workspace: next };
}

/**
 * Move `ws`'s list subscriptions from the board it was looking at to the board it
 * is looking at now (feads).
 *
 * Two things have to happen and they are easy to mistake for one. The connection
 * must stop being a subscriber of the *old* board's registry — otherwise a change
 * there keeps pushing it issues from a board it has left — and it must become a
 * subscriber of the new board's registry under the same client ids, so the lists
 * already on its screen are the ones that get refreshed.
 *
 * `onDisconnect` is reused for the first half rather than a `detach` per spec: it
 * removes the socket from every entry *and* evicts entries that are left with no
 * subscribers, so a board nobody is looking at stops holding a cache. A per-spec
 * `detach` leaves the emptied entries behind by design.
 *
 * The re-snapshot is deliberately not awaited. The attachment move above is
 * synchronous, so the "not subscribed to a board it is not looking at" invariant
 * holds the instant `set-board` replies; the fetch that follows only decides how
 * quickly the new board's rows appear. The browser also tears down and
 * re-subscribes on its own after a switch (see `handleWorkspaceChange` in
 * `app/main.js`) — this exists so that a client which does not is still correct
 * rather than frozen.
 *
 * @param {WebSocket} ws
 * @param {WorkspaceState | null} previous
 * @param {WorkspaceState} next
 * @returns {void}
 */
function migrateConnectionSubscriptions(ws, previous, next) {
  const s = ensureSubs(ws);
  /** @type {Map<string, { key: string, spec: any }> | undefined} */
  const subs = s.list_subs;
  if (!subs || subs.size === 0) {
    return;
  }
  const from = registryForBoard(boardScopeKey(previous));
  const to = registryForBoard(boardScopeKey(next));
  if (from === to) {
    return;
  }
  try {
    from.onDisconnect(ws);
  } catch {
    // ignore sweep errors
  }
  /** @type {Map<string, any>} */
  const specs = new Map();
  for (const [client_id, sub] of Array.from(subs.entries())) {
    const { key } = to.attach(sub.spec, ws);
    subs.set(client_id, { key, spec: sub.spec });
    specs.set(key, sub.spec);
  }
  log('moved %d subscription(s) to %s', specs.size, boardScopeKey(next));
  // feads: the re-snapshot is deferred by a beat and cancelled per client id
  // the browser re-subscribes (or drops) in the meantime. The dashboard always
  // tears down and re-subscribes after a switch, so sending the migrated
  // snapshot too doubled every board switch: two fetches and two full
  // snapshots per list. A client that does not re-subscribe still gets its
  // snapshot, MIGRATION_SNAPSHOT_DELAY_MS later.
  if (s.pending_migration) {
    clearTimeout(s.pending_migration.timer);
  }
  /** @type {Set<string>} */
  const client_ids = new Set(subs.keys());
  const timer = setTimeout(() => {
    if (s.pending_migration?.timer === timer) {
      s.pending_migration = null;
    }
    if (workspaceFor(ws) !== next) {
      return; // switched again since; that switch owns the snapshot
    }
    /** @type {Map<string, any>} */
    const still = new Map();
    for (const client_id of client_ids) {
      const sub = subs.get(client_id);
      if (sub) {
        still.set(sub.key, sub.spec);
      }
    }
    for (const spec of still.values()) {
      void refreshAndPublish(next, spec, { snapshot_to: ws }).catch(() => {
        // ignore refresh errors; the client re-subscribes on its own too
      });
    }
  }, MIGRATION_SNAPSHOT_DELAY_MS);
  timer.unref?.();
  s.pending_migration = { timer, client_ids };
}

/**
 * How long a moved subscription waits for its client to re-subscribe before
 * the server sends the new board's snapshot itself. See
 * `migrateConnectionSubscriptions`.
 */
const MIGRATION_SNAPSHOT_DELAY_MS = 300;

/**
 * A client (re-)subscribed or dropped `client_id`: the pending migration
 * snapshot for it is no longer needed.
 *
 * @param {WebSocket} ws
 * @param {string} client_id
 */
function settleMigratedSubscription(ws, client_id) {
  const pending = ensureSubs(ws).pending_migration;
  if (pending) {
    pending.client_ids.delete(client_id);
  }
}

/**
 * Nudge the All-boards pseudo-board after a physical board's refresh trigger
 * (feads). Every signal that means "board X changed" — a watcher event, a
 * Postgres NOTIFY, a mutation gate resolving — also means "the aggregate view
 * changed", but only when somebody is actually looking at it.
 *
 * @param {string} board_key - The physical board's scope key.
 */
function nudgeAllBoardsScope(board_key) {
  if (
    board_key === ALL_SCOPE_KEY ||
    board_key.startsWith(`${ALL_SCOPE_KEY}:`)
  ) {
    return;
  }
  if (!allBoardsScopeInUse()) {
    return;
  }
  for (const key of allBoardsScopeKeysInUse()) {
    scheduleBoardRefresh(key);
  }
}

/**
 * Every aggregate scope key some open socket is on (`*`, or `*:<space>` under
 * accounts mode).
 *
 * @returns {Set<string>}
 */
function allBoardsScopeKeysInUse() {
  /** @type {Set<string>} */
  const keys = new Set();
  const wss = CURRENT_WSS;
  if (!wss) return keys;
  for (const sock of wss.clients) {
    if (sock.readyState !== sock.OPEN) continue;
    const ws_state = workspaceFor(/** @type {any} */ (sock));
    if (isAllBoardsWorkspace(ws_state)) keys.add(boardScopeKey(ws_state));
  }
  return keys;
}

/**
 * Move the board *new* connections start on (feads).
 *
 * Not reachable from the WebSocket protocol: only `attachWsServer`'s returned
 * `setWorkspace` calls this, which is a programmatic caller with no connection to
 * speak for. Changing the seed is therefore announced to the connections that are
 * still following it — the ones that never chose a board of their own — and to
 * nobody else, since a connection that has chosen is not affected in any way.
 *
 * @param {BoardSelection} selection
 * @returns {{ changed: boolean, workspace: WorkspaceState }}
 */
function applySeedSelection(selection) {
  const previous = SEED_WORKSPACE;
  const next = toWorkspaceState(selection);
  const changed = boardChanged(previous, next);
  SEED_WORKSPACE = next;
  bindSeedBoard(next.board_dir);

  if (!changed) {
    return { changed, workspace: next };
  }
  log(
    'seed board changed: %s → %s (bd pinned to %o)',
    previous?.db_path || '(none)',
    next.db_path,
    next.board_dir || '(discovery)'
  );
  const wss = CURRENT_WSS;
  if (wss) {
    for (const client of wss.clients) {
      if (hasConnectionBoard(client)) {
        continue;
      }
      if (BOARD_WATCHERS) {
        BOARD_WATCHERS.retain(
          { key: boardScopeKey(next), root_dir: next.root_dir },
          client
        );
        if (previous) {
          BOARD_WATCHERS.release(boardScopeKey(previous), client);
        }
      }
      migrateConnectionSubscriptions(
        /** @type {any} */ (client),
        previous,
        next
      );
      sendEvent(/** @type {any} */ (client), 'workspace-changed', next);
    }
  }
  scheduleListRefresh(boardScopeKey(next));
  return { changed, workspace: next };
}

/**
 * Point the seed board's scope key at the imported `registry` singleton.
 *
 * Cosmetic-looking and not: the exported singleton is what `subscriptions.js`
 * documents as "the registry used by the ws server", and a single-board dashboard
 * should still be using it rather than an anonymous one this module made up.
 *
 * Called only from `attachWsServer`, for the board the daemon starts on, and the
 * `has` guard means a second attach on the same board does not re-alias. A *later*
 * seed change (`setWorkspace`) deliberately does not alias: two seed boards
 * sharing the singleton's cache would be the same cross-board diffing that
 * per-board registries exist to prevent.
 *
 * @param {WorkspaceState} workspace
 * @returns {void}
 */
function aliasSeedRegistry(workspace) {
  const scope = boardScopeKey(workspace);
  if (scope.length > 0 && !BOARD_REGISTRIES.has(scope)) {
    BOARD_REGISTRIES.set(scope, registry);
  }
}

/**
 * Every board the dashboard can offer, registry boards included (feads).
 *
 * The SQLite registry wins over `~/.beads/registry.json` and the in-memory
 * registrations for the same board, since only it knows the board's name,
 * description and repos. Boards whose directory has gone are still listed, but
 * flagged `exists: false` so the picker can show them without offering them.
 *
 * @param {WorkspaceState | null} current - The asking connection's board, which
 * has to be in the list even when nothing registered it — see below.
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function listAvailableBoards(current) {
  /** @type {Map<string, Record<string, unknown>>} */
  const by_key = new Map();

  // feads: the All-boards pseudo-board leads the list whenever there is more
  // than one real board to aggregate — with a single board it would be that
  // board with extra steps.
  const registry_boards = await listRegistryBoards();
  if (registry_boards.filter((b) => b.exists).length > 1) {
    by_key.set(ALL_BOARD_ID, allBoardsPickerEntry());
  }

  for (const workspace of getAvailableWorkspaces()) {
    const root_dir = path.resolve(String(workspace.path || ''));
    const board_dir = findNearestBoardDir(root_dir);
    const key = board_dir || root_dir;
    by_key.set(key, {
      ...workspace,
      board_dir,
      key,
      id: '',
      name: '',
      description: '',
      repos: [],
      exists: true,
      source: 'daemon'
    });
  }

  for (const board of registry_boards) {
    const root_dir = board.workspace_dir || path.dirname(board.board_dir);
    by_key.set(board.board_dir, {
      path: root_dir,
      database: board.board_dir,
      pid: 0,
      version: 'registry',
      board_dir: board.board_dir,
      key: board.id || board.board_dir,
      id: board.id,
      name: board.name,
      description: board.description,
      repos: board.repos,
      exists: board.exists,
      source: 'registry'
    });
  }

  // The asking connection's board must always be offered, even when nothing
  // registered it: the daemon can be started with BEADS_DIR pointing outside its
  // own cwd, and a selection missing from `available` leaves the picker unable to
  // show it.
  if (current) {
    const current_key = current.board_dir || current.root_dir;
    if (!by_key.has(current_key) && !by_key.has(current.key)) {
      by_key.set(current_key, {
        path: current.root_dir,
        database: current.board_dir || current.db_path,
        pid: process.pid,
        version: 'active',
        board_dir: current.board_dir,
        key: current.key,
        id: current.board_id,
        name: current.name,
        description: current.description,
        repos: current.repos,
        exists: true,
        source: 'active'
      });
    }
  }

  return Array.from(by_key.values()).sort((a, b) => {
    // The All-boards entry stays on top; the rest sort by name.
    if (a.id === ALL_BOARD_ID) {
      return -1;
    }
    if (b.id === ALL_BOARD_ID) {
      return 1;
    }
    return String(a.name || a.path).localeCompare(String(b.name || b.path));
  });
}

/**
 * Fill in the seed board's registry metadata, if it has an entry (feads).
 *
 * Only the seed needs this. Every other selection came *from* the registry (or
 * from a directory the caller named, which has no metadata to adopt), so it
 * already carries its name and repos; the seed is the one board the daemon picked
 * for itself, from `$BEADS_DIR` or discovery, knowing nothing about it.
 *
 * Connections that have not chosen a board read `SEED_WORKSPACE` by reference, so
 * replacing the object here is enough for all of them. It changes `key`, which is
 * why `boardScopeKey` is defined on `board_dir` instead — see there.
 *
 * @param {string} board_dir
 * @returns {Promise<void>}
 */
async function adoptSeedRegistryMetadata(board_dir) {
  if (!board_dir) {
    return;
  }
  const board = await findRegistryBoard(board_dir);
  const current = SEED_WORKSPACE;
  // The seed may have moved while the registry read was in flight.
  if (!board || !current || current.board_dir !== board.board_dir) {
    return;
  }
  SEED_WORKSPACE = {
    ...current,
    key: board.id || current.key,
    board_id: board.id,
    name: board.name,
    description: board.description,
    repos: board.repos
  };
}

/**
 * Turn a validated `set-board` payload into a board selection (feads).
 *
 * @param {{ id: string, board_dir: string, path: string }} request
 * @returns {Promise<{ ok: true, selection: BoardSelection } | { ok: false, code: string, message: string }>}
 */
async function resolveBoardSelection(request) {
  // feads: the All-boards pseudo-board is a selection, not a directory.
  if (request.id === ALL_BOARD_ID) {
    return { ok: true, selection: { root_dir: '', all_boards: true } };
  }
  const lookup = request.id || request.board_dir;
  if (lookup) {
    const board = await findRegistryBoard(lookup);
    if (board) {
      if (!board.exists) {
        return {
          ok: false,
          code: 'board_missing',
          message: `board "${board.id}" points at ${board.board_dir}, which no longer exists`
        };
      }
      return {
        ok: true,
        selection: {
          root_dir: board.workspace_dir || path.dirname(board.board_dir),
          board_dir: board.board_dir,
          id: board.id,
          name: board.name,
          description: board.description,
          repos: board.repos
        }
      };
    }
    // An unregistered directory is still selectable — the registry is a catalog,
    // not a gate — but an unknown id has nothing to fall back to.
    if (!request.board_dir) {
      return {
        ok: false,
        code: 'not_found',
        message: `no board registered with id "${request.id}"`
      };
    }
    const board_dir = path.resolve(request.board_dir);
    return {
      ok: true,
      selection: {
        root_dir: path.dirname(board_dir),
        board_dir,
        name: path.basename(path.dirname(board_dir))
      }
    };
  }

  return { ok: true, selection: { root_dir: path.resolve(request.path) } };
}

/**
 * Read an issue's creator (feads).
 *
 * `created_by` is bd's own record of which actor filed the item, populated from
 * that agent's `BEADS_ACTOR` — the same string the registry minted — so it is
 * directly comparable to the acting agent's actor with no mapping in between.
 *
 * Returns `''` when it cannot be read, which the policy treats as
 * "unattributed" and refuses for a `user`. That is the safe direction: a
 * failed lookup must not read as ownership.
 *
 * @param {string} id
 * @param {{ cwd?: string, board_dir?: string | null }} bd_options
 * @returns {Promise<string>}
 */
async function fetchIssueCreator(id, bd_options) {
  const store = getPgStore();
  if (store) {
    try {
      const board_id = await store.resolveBoardId(bd_options.board_dir);
      return await store.issueCreator(board_id, id);
    } catch (err) {
      log('cannot read creator of %s for the delete check: %o', id, err);
      return '';
    }
  }
  const shown = await runBdJson(['show', id, '--json'], bd_options);
  if (!shown || shown.code !== 0) {
    log('cannot read creator of %s for the delete check', id);
    return '';
  }
  const json = /** @type {any} */ (shown.stdoutJson);
  // bd has shipped both shapes over time: a bare issue object, and one wrapped
  // in `{ issue: ... }`. Accepting both here costs a line and avoids a silent
  // "no creator recorded" refusal on whichever shape this build emits.
  const issue =
    json && typeof json === 'object' && json.issue ? json.issue : json;
  return issue && typeof issue.created_by === 'string' ? issue.created_by : '';
}

/**
 * Refuse a request the policy does not allow (feads).
 *
 * The choke point for everything except `delete-issue`, which needs a second ask
 * (see `authorizeIssueDelete`). Returns `true` when it has already answered the
 * socket, so a handler reads as `if (await refuse(...)) return;`.
 *
 * ## Which messages go through here, and which do not
 *
 * Gated: every handler that changes board data (`create-issue`, `update-*`,
 * `edit-text`, `dep-add`/`dep-remove`, `label-add`/`label-remove`, `add-comment`)
 * as `write`, `delete-issue` as `delete`, and the two that *read* board data
 * (`subscribe-list`, `get-comments`) as `read`. Gating the reads is what makes
 * `FEADS_REQUIRE_AGENT=1` mean something on this surface rather than being a
 * client-side blank screen: with the `deny` stance an anonymous caller cannot even
 * open a subscription, so no pushes follow. Under the ordinary `read_only` stance
 * a read is allowed, so this costs one policy question per subscribe.
 *
 * Not gated, each for a stated reason:
 *
 * - `whoami` — it is the login affordance. Gating the message that tells a client
 *   it needs to log in would leave it unable to find out.
 * - `ping`, `unsubscribe-list` — transport and cleanup, no board data.
 * - `list-agents` — gated, but inside `listRoster`, which has to scope the answer
 *   as well as permit it. Routing it through here too would ask twice.
 * - `set-board`, `set-workspace`, `list-workspaces`, `get-workspace` — these
 *   *select* what to read. The read-only stance grants reading **every** board, so
 *   refusing the message that changes which board is on screen would quietly
 *   reduce that to whichever board the daemon started on. They touch no bd data;
 *   what they mutate is which board *this connection* is looking at, and nothing
 *   else — see `applyBoardSelection`. That is what closes the gap this comment used
 *   to describe (ex-dh0: an anonymous viewer moving an identified agent's board out
 *   from under it), and it is why the answer was per-connection selection rather
 *   than a permission check here. Board *names* stay readable to an anonymous
 *   caller as a consequence, which is the small price for a page that renders
 *   enough of itself to show a login box.
 *
 * A refusal is an ordinary error reply. Closing the socket would take the whole
 * dashboard down over one denied click.
 *
 * @param {WebSocket} ws
 * @param {{ id: string, type: MessageType }} req
 * @param {import('./identity.js').Action} action
 * @param {{ created_by?: string, id?: string }} [resource]
 * @param {import('./identity.js').ResolvedIdentity} [resolved]
 * @returns {Promise<boolean>} Whether the request was refused.
 */
async function refuse(ws, req, action, resource = {}, resolved) {
  const identity = resolved || (await resolveConnectionIdentity(ws));
  const silo_actor = identity.identity?.actor || '';
  if (siloConnection(ws) && silo_actor.length === 0) {
    const reason = 'a live verified silo actor is required for this operation';
    log('%s refused: %s', req.type, reason);
    if (!(/** @type {any} */ (identity).silo_failure)) {
      ws.send(
        JSON.stringify(
          makeError(req, 'forbidden', reason, { mode: 'rejected', action })
        )
      );
    }
    if (/** @type {any} */ (identity).silo_failure) closeSiloSocket(ws);
    return true;
  }
  const decision = await decideFor(identity, action, resource);
  if (decision.allowed) {
    return false;
  }
  log('%s refused: %s', req.type, decision.reason);
  ws.send(
    JSON.stringify(
      makeError(req, 'forbidden', decision.reason, {
        mode: decision.mode,
        action
      })
    )
  );
  if (/** @type {any} */ (identity).silo_failure) closeSiloSocket(ws);
  return true;
}

/**
 * Decide whether the acting caller may delete an issue (feads).
 *
 * Asks the policy twice, and the second ask is the interesting part. `decide()`
 * is consulted first with no creator: if that already allows the delete — an
 * admin, or operator mode — then no creator could change the answer, and the
 * `bd show` is skipped. Only a refusal is provisional, because the *reason*
 * might be the missing creator, so the creator is fetched and the same question
 * asked again.
 *
 * The alternative, branching on `role === 'admin'` here to decide whether the
 * lookup is needed, would put a copy of the tier rules in the UI server. The
 * policy answering its own "does this matter?" question is what keeps
 * `boards/authz-cases.json` the only place the tiers are defined.
 *
 * A caller with no resolved agent is refused by the first ask and never reaches
 * the lookup, so no `bd show` is run for one. Ownership is a property of an
 * *identity*, so there is nothing a creator could tell us about a caller that has
 * none: a rejected credential, an anonymous read-only browser and a denied caller
 * are all refused for reasons the item cannot change, and the operator was already
 * allowed above.
 *
 * @param {WebSocket} ws
 * @param {string} id
 * @param {{ cwd?: string, board_dir?: string | null }} bd_options
 * @param {import('./identity.js').ResolvedIdentity} [resolved]
 * @returns {Promise<{ allowed: boolean, reason: string, mode: 'agent'|'operator'|'anonymous'|'rejected' }>}
 */
async function authorizeIssueDelete(ws, id, bd_options, resolved) {
  const identity = resolved || (await resolveConnectionIdentity(ws));
  if (/** @type {any} */ (identity).principal && (await accountsOn())) {
    // Accounts mode: the creator (any alias), a space admin or a superadmin.
    const mods = await loadAccountsModules();
    const board_id = boardIdForDir(bd_options.board_dir);
    const space = (await boardSpaces()).get(board_id) || '';
    const created_by = await fetchIssueCreator(id, bd_options);
    const d = mods
      ? mods.access.decideAccess(principalOf(identity), 'item_delete', {
          space,
          created_by
        })
      : { allowed: false, reason: 'accounts modules unavailable' };
    return { allowed: d.allowed, reason: d.reason, mode: identity.mode };
  }
  if (siloConnection(ws) && !(identity.identity?.actor || '')) {
    return {
      allowed: false,
      reason: 'a live verified silo actor is required for this operation',
      mode: 'rejected'
    };
  }
  const provisional = await decideFor(identity, 'delete', { id });
  if (provisional.allowed) {
    return provisional;
  }
  if (!identity.agent) {
    return provisional;
  }
  const created_by = await fetchIssueCreator(id, bd_options);
  if (created_by.length === 0) {
    return provisional;
  }
  return decideFor(identity, 'delete', { id, created_by });
}

/**
 * Open the post-mutation refresh window for a board (feads).
 *
 * Swallows scheduling errors on purpose: a write that committed must not be
 * reported to the client as failed because the refresh it kicked off could not
 * be scheduled. Used by the Postgres branches; the `bd` branches keep their
 * inline `try`/`catch` so that path stays byte-for-byte what it was.
 *
 * @param {WorkspaceState | null} workspace - The connection's board.
 * @returns {void}
 */
function afterMutation(workspace) {
  try {
    triggerMutationRefreshOnce(boardScopeKey(workspace));
  } catch {
    // ignore
  }
}

/**
 * Mark a child agent as present when it writes to an issue. This is deliberately
 * fire-and-forget: flares are advisory and must never turn a successful board
 * mutation into an error (or add latency to its response).
 */
/**
 * @param {WebSocket} ws
 * @param {WorkspaceState | null} workspace
 * @param {string} issue_id
 * @param {import('./identity.js').ResolvedIdentity} [resolved]
 */
function implicitFlare(ws, workspace, issue_id, resolved) {
  void (async () => {
    try {
      const identity = resolved || (await resolveConnectionIdentity(ws));
      const agent = identity.identity
        ? /** @type {any} */ (identity.identity)
        : null;
      const board_id = String(workspace?.board_id || '');
      if (siloConnection(ws) && !(agent?.actor || '')) return;
      if (!agent?.parent_agent_id || !board_id || !issue_id) return;
      const db = openRegistry();
      try {
        const { raiseFlare } = await import('../../boards/flares.mjs');
        raiseFlare(db, {
          agent_id: agent.agent_id,
          actor: agent.actor,
          parent_actor: agent.parent_actor || '',
          board_id,
          issue_id: String(issue_id)
        });
      } finally {
        db.close();
      }
      nudgeFlareSubscriptions(boardScopeKey(workspace));
    } catch (err) {
      log('implicit flare failed (ignored): %o', err);
    }
  })();
}

/** Best-effort refresh for advisory flare subscribers after a registry write. */
export function nudgeFlareSubscriptions(board_id = '') {
  try {
    scheduleListRefresh(String(board_id || ''));
  } catch {
    /* advisory */
  }
  // Agentwatch treats flares as agent heartbeats, so a flare write is a
  // recency change worth publishing.
  scheduleAgentwatchRefresh();
}

/**
 * Run one Postgres operation on behalf of a connection (feads).
 *
 * The single choke point every pg-mode handler goes through, so three things
 * are decided once instead of nine times: which board the write lands on (this
 * connection's, resolved from its `.beads` directory), who is acting (the
 * connection's registered actor, which is what `created_by`, comment
 * authorship, @mentions and the events stream all key on), and what a failure
 * looks like on the wire.
 *
 * Returns `undefined` when it has already answered the socket with an error, so
 * a handler reads as `const out = await runPgOp(...); if (out === undefined)
 * return;` — the same shape as the `if (res.code !== 0) { …; return; }` the
 * `bd` branch uses right next to it.
 *
 * @template T
 * @param {WebSocket} ws
 * @param {{ id: string, type: MessageType }} req
 * @param {string | null | undefined} board_dir - The board this message acts
 * on — the message's `bd_options.board_dir`, which the All-boards router may
 * have re-pointed at the issue's home board. Not read from the connection
 * here, precisely so that routing decision is honored.
 * @param {(store: import('./pg-store.js').PgStore, board_id: string, actor: string) => Promise<T>} fn
 * @param {import('./identity.js').ResolvedIdentity} [resolved]
 * @returns {Promise<{ value: T } | undefined>}
 */
async function runPgOp(ws, req, board_dir, fn, resolved) {
  const store = getPgStore();
  if (!store) {
    ws.send(
      JSON.stringify(
        makeError(req, 'pg_error', 'postgres data layer is not configured')
      )
    );
    return undefined;
  }
  try {
    const board_id = await store.resolveBoardId(board_dir);
    const identity = resolved || (await resolveConnectionIdentity(ws));
    const actor = identity.identity?.actor || '';
    // In a silo, no database callback may run without the same verified actor
    // that authorized this message. Base mode deliberately keeps its operator
    // fallback and empty actor behavior.
    if (siloConnection(ws) && actor.length === 0) {
      const reason =
        'a live verified silo actor is required for this operation';
      ws.send(
        JSON.stringify(
          makeError(req, 'forbidden', reason, { mode: 'rejected' })
        )
      );
      if (/** @type {any} */ (identity).silo_failure) closeSiloSocket(ws);
      return undefined;
    }
    return { value: await fn(store, board_id, actor) };
  } catch (err) {
    const error = pgErrorEnvelope(err);
    log('%s failed: %s %o', req.type, error.message, error);
    ws.send(
      JSON.stringify(makeError(req, error.code, error.message, error.details))
    );
    return undefined;
  }
}

/**
 * Get or initialize the subscription state for a socket.
 *
 * @param {WebSocket} ws
 * @returns {any}
 */
function ensureSubs(ws) {
  let s = SUBS.get(ws);
  if (!s) {
    s = {
      show_id: null,
      list_subs: new Map(),
      list_revisions: new Map()
    };
    SUBS.set(ws, s);
  }
  return s;
}

/**
 * Get next monotonically increasing revision for a subscription key on this connection.
 *
 * @param {WebSocket} ws
 * @param {string} key
 */
/**
 * @param {WebSocket} ws
 * @param {string} key
 */
function nextListRevision(ws, key) {
  const s = ensureSubs(ws);
  const m = s.list_revisions || new Map();
  s.list_revisions = m;
  const prev = m.get(key) || 0;
  const next = prev + 1;
  m.set(key, next);
  return next;
}

/**
 * Emit per-subscription envelopes to a specific client id on a socket.
 * Helpers for snapshot / upsert / delete.
 */
/**
 * @param {WebSocket} ws
 * @param {string} client_id
 * @param {string} key
 * @param {Array<Record<string, unknown>>} issues
 */
function emitSubscriptionSnapshot(ws, client_id, key, issues) {
  if (!canDeliverToConnection(ws)) {
    return;
  }
  const revision = nextListRevision(ws, key);
  const payload = {
    type: /** @type {const} */ ('snapshot'),
    id: client_id,
    revision,
    issues: key.startsWith('flares') ? undefined : issues,
    flares: key.startsWith('flares') ? issues : undefined
  };
  const msg = JSON.stringify({
    id: `evt-${Date.now()}`,
    ok: true,
    type: /** @type {MessageType} */ ('snapshot'),
    payload
  });
  try {
    ws.send(msg);
  } catch (err) {
    log('emit snapshot send failed key=%s id=%s: %o', key, client_id, err);
  }
}

/**
 * @param {WebSocket} ws
 * @param {string} client_id
 * @param {string} key
 * @param {Record<string, unknown>} issue
 */
function emitSubscriptionUpsert(ws, client_id, key, issue) {
  if (!canDeliverToConnection(ws)) {
    return;
  }
  const revision = nextListRevision(ws, key);
  const payload = {
    type: 'upsert',
    id: client_id,
    revision,
    issue: key.startsWith('flares') ? undefined : issue,
    flare: key.startsWith('flares') ? issue : undefined
  };
  const msg = JSON.stringify({
    id: `evt-${Date.now()}`,
    ok: true,
    type: /** @type {MessageType} */ ('upsert'),
    payload
  });
  try {
    ws.send(msg);
  } catch (err) {
    log('emit upsert send failed key=%s id=%s: %o', key, client_id, err);
  }
}

/**
 * @param {WebSocket} ws
 * @param {string} client_id
 * @param {string} key
 * @param {string} issue_id
 */
function emitSubscriptionDelete(ws, client_id, key, issue_id) {
  if (!canDeliverToConnection(ws)) {
    return;
  }
  const revision = nextListRevision(ws, key);
  const payload = {
    type: 'delete',
    id: client_id,
    revision,
    issue_id
  };
  const msg = JSON.stringify({
    id: `evt-${Date.now()}`,
    ok: true,
    type: /** @type {MessageType} */ ('delete'),
    payload
  });
  try {
    ws.send(msg);
  } catch (err) {
    log('emit delete send failed key=%s id=%s: %o', key, client_id, err);
  }
}

// issues-changed removed in v2: detail and lists are pushed via subscriptions

/**
 * Refresh a subscription spec on one board: fetch via adapter, apply to that
 * board's registry and emit per-subscription full-issue envelopes to its
 * subscribers. Serialized per key, within that board.
 *
 * feads: `board` is what makes this per-board rather than per-daemon. It supplies
 * both the working directory and the `board_dir` the `bd` child is pinned to, so a
 * refresh triggered by board A's watcher cannot read board B — which is what would
 * happen if this still read a shared "current workspace".
 *
 * @param {WorkspaceState} board
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 * @param {{ snapshot_to?: WebSocket }} [options] - `snapshot_to` gets a full
 * snapshot even when the delta is empty. Used by a connection that has just moved
 * onto this board: the board's cache is already populated by whoever else is on it,
 * so the delta would be empty and the new arrival would receive nothing at all.
 */
async function refreshAndPublish(board, spec, options = {}) {
  const scope = boardScopeKey(board);
  const board_registry = registryForBoard(scope);
  const key = keyOf(spec);
  await board_registry.withKeyLock(key, async () => {
    const res = await fetchListForBoard(board, spec);
    if (!res.ok) {
      log('refresh failed for %s: %s %o', key, res.error.message, res.error);
      return;
    }
    const items = applyClosedIssuesFilter(spec, res.items);
    const prev_size = board_registry.get(key)?.itemsById.size || 0;
    const delta = board_registry.applyItems(key, items);
    const entry = board_registry.get(key);
    if (!entry || entry.subscribers.size === 0) {
      return;
    }
    /** @type {Map<string, any>} */
    const by_id = new Map();
    for (const it of items) {
      if (it && typeof it.id === 'string') {
        by_id.set(it.id, it);
      }
    }
    for (const ws of entry.subscribers) {
      if (!canDeliverToConnection(ws) || ws.readyState !== ws.OPEN) continue;
      const s = ensureSubs(ws);
      const subs = s.list_subs || new Map();
      /** @type {string[]} */
      const client_ids = [];
      for (const [cid, v] of subs.entries()) {
        if (v.key === key) client_ids.push(cid);
      }
      if (client_ids.length === 0) continue;
      if (prev_size === 0 || options.snapshot_to === ws) {
        for (const cid of client_ids) {
          emitSubscriptionSnapshot(ws, cid, key, items);
        }
        continue;
      }
      for (const cid of client_ids) {
        for (const id of [...delta.added, ...delta.updated]) {
          const issue = by_id.get(id);
          if (issue) {
            emitSubscriptionUpsert(ws, cid, key, issue);
          }
        }
        for (const id of delta.removed) {
          emitSubscriptionDelete(ws, cid, key, id);
        }
      }
    }
  });
}

/**
 * Apply pre-diff filtering for closed-issues lists based on spec.params.since (epoch ms).
 *
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 * @param {Array<{ id: string, updated_at: number, closed_at: number | null } & Record<string, unknown>>} items
 */
function applyClosedIssuesFilter(spec, items) {
  if (String(spec.type) !== 'closed-issues') {
    return items;
  }
  const p = spec.params || {};
  const since = typeof p.since === 'number' ? p.since : 0;
  if (!Number.isFinite(since) || since <= 0) {
    return items;
  }
  /** @type {typeof items} */
  const out = [];
  for (const it of items) {
    const ca = it.closed_at;
    if (typeof ca === 'number' && Number.isFinite(ca) && ca >= since) {
      out.push(it);
    }
  }
  return out;
}

/**
 * Attach a WebSocket server to an existing HTTP server.
 *
 * @param {Server} http_server
 * @param {Object} [options]
 * @param {string} [options.path]
 * @param {number} [options.heartbeat_ms]
 * @param {number} [options.refresh_debounce_ms]
 * @param {string} [options.root_dir]
 * @param {(board: { key: string, root_dir: string }, notify: () => void) => { close: () => void }} [options.create_watcher]
 *   - feads: how to watch one board's files. Replaces the single pre-built
 *   `watcher` this used to take, which could only ever be bound to one board and so
 *   stopped being expressible once two connections could be looking at two boards.
 *   Injected mainly so tests can assert the watcher accounting without opening real
 *   `fs.watch` handles, which keep the event loop alive.
 * @param {{ report: () => any }} [options.build_identity]
 *   - feads: which build this process is running, from `createBuildIdentity`. Passed
 *   in by `index.js` so this and the HTTP routes describe the same boot snapshot.
 *   Omitted means the daemon has no build identity to report, and `build-info` is
 *   simply not sent — a `handleMessage`-only test should not be paying for a walk of
 *   the source tree.
 * @param {number} [options.build_poll_ms]
 * @param {number} [options.sso_lease_ms] - Maximum provider lease, capped at 60s.
 * @param {number} [options.sso_read_cache_ms] - Read cache, capped at 60s and the lease.
 * @param {number} [options.sso_revalidate_ms] - Idle lease revalidation interval.
 * @param {Record<string, string | undefined>} [options.env]
 * @param {any} [options.sso_verifier]
 * @param {string} [options.registry_path]
 * @param {string} [options.sso_board_id]
 * @param {any} [options.accounts_verifier] - Accounts-mode SSO verifier (tests).
 * @returns {{ wss: WebSocketServer, broadcast: (type: MessageType, payload?: unknown) => void, scheduleListRefresh: (board_key?: string) => void, setWorkspace: (root_dir: string) => { changed: boolean, workspace: WorkspaceState }, watchers: ReturnType<typeof createBoardWatcherPool>, buildWatch: { stop: () => void, check: () => void } | null }}
 */
export function attachWsServer(http_server, options = {}) {
  const ws_path = options.path || '/ws';
  const auth_config = createSiloAuthConfig(options.env || process.env, options);

  // Initialize the workspace new connections start on.
  const initial_root = options.root_dir || process.cwd();
  // feads: seed from $BEADS_DIR when the launcher exported one, else from
  // discovery, so the board served before any switch is the one bd would have
  // picked on its own.
  const initial_board_dir = resolveInitialBoardDir(initial_root, process.env);
  SEED_WORKSPACE = toWorkspaceState({
    root_dir: initial_root,
    board_dir: initial_board_dir
  });
  bindSeedBoard(initial_board_dir);
  aliasSeedRegistry(SEED_WORKSPACE);
  // feads: fire-and-forget so a slow/absent registry never delays startup. Until
  // it resolves the board is still served, just labelled by directory.
  void adoptSeedRegistryMetadata(initial_board_dir);

  const heartbeat_ms = options.heartbeat_ms ?? 30000;
  if (typeof options.refresh_debounce_ms === 'number') {
    const n = options.refresh_debounce_ms;
    if (Number.isFinite(n) && n >= 0) {
      REFRESH_DEBOUNCE_MS = n;
    }
  }

  // feads: one file watcher per board somebody is looking at, reference-counted by
  // the connections looking at it. Created here rather than at module scope so that
  // `handleMessage` called on its own — with no server attached — never starts one.
  //
  // feads: in Postgres mode the pool is kept — the retain/release accounting is
  // what proves no connection is left holding a board it has walked away from —
  // but it watches nothing. There is no file to watch: the data lives in
  // Postgres and the change signal is `LISTEN feads_events`. Opening `fs.watch`
  // handles on `.beads` directories would cost OS handles and keep the event
  // loop alive to deliver events nothing would act on.
  const watchers = createBoardWatcherPool({
    ...(options.create_watcher
      ? { create: options.create_watcher }
      : getPgStore()
        ? { create: () => ({ close() {} }) }
        : {}),
    onChange: (board_key) => {
      log('db change detected on %s → schedule refresh', board_key);
      scheduleListRefresh(board_key);
    }
  });
  BOARD_WATCHERS = watchers;
  BUILD_IDENTITY = options.build_identity || null;

  // Base mode intentionally keeps the old ws constructor and its cookie behavior.
  // A silo must own the HTTP upgrade explicitly so no WebSocket frame can reach
  // `connection` before token or browser SSO authentication succeeds.
  // Accounts mode on the base instance authenticates the upgrade too (SSO cookie
  // or token cookie) — decided per upgrade, because the mode lives in the registry
  // and can be flipped without a restart. Off: `verifyClient` admits everything,
  // exactly as before.
  const accountsVerifyClient = (
    /** @type {any} */ info,
    /** @type {(ok: boolean, code?: number) => void} */ done
  ) => {
    void (async () => {
      const env = auth_config.env;
      if (!(await accountsOn(env))) {
        done(true);
        return;
      }
      const auth = await authenticateAccountsUpgrade(info.req, {
        env,
        ...(options.accounts_verifier
          ? { verifier: options.accounts_verifier }
          : {})
      });
      if (!auth) {
        done(false, 401);
        return;
      }
      info.req.__feadsAccountsAuth = auth;
      done(true);
    })().catch(() => done(false, 401));
  };
  const wss =
    auth_config.enabled || auth_config.invalid
      ? new WebSocketServer({ noServer: true, perMessageDeflate: WS_DEFLATE })
      : new WebSocketServer({
          server: http_server,
          path: ws_path,
          perMessageDeflate: WS_DEFLATE,
          verifyClient: accountsVerifyClient
        });
  CURRENT_WSS = wss;

  // Accounts mode: an upgrade that a verified SSO session won over a leftover
  // `feads_agent_token` cookie expires that cookie on the 101, so the browser
  // stops presenting it (HTTP does the same on every accounts route).
  wss.on('headers', (headers, request) => {
    const accounts_auth = /** @type {any} */ (request)?.__feadsAccountsAuth;
    if (accounts_auth?.token_cookie_ignored) {
      headers.push(
        `Set-Cookie: ${clearAgentTokenCookie({ secure: isSecureRequest(request) })}`
      );
    }
  });

  /**
   * @param {any} socket
   * @param {number} status
   * @returns {void}
   */
  const rejectUpgrade = (socket, status = 401) => {
    try {
      if (typeof socket.write === 'function') {
        const phrase = status === 404 ? 'Not Found' : 'Unauthorized';
        socket.write(
          `HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
        );
      }
    } catch {
      // The socket is still destroyed below.
    }
    try {
      socket.destroy?.();
    } catch {
      // Ignore an already closed transport.
    }
  };

  /** @type {((request: any, socket: any, head: Buffer) => void) | null} */
  let upgrade_handler = null;
  if (auth_config.enabled || auth_config.invalid) {
    upgrade_handler = (request, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(String(request?.url || ''), 'http://feads.invalid')
          .pathname;
      } catch {
        rejectUpgrade(socket, 404);
        return;
      }
      if (pathname !== ws_path) {
        rejectUpgrade(socket, 404);
        return;
      }
      if (auth_config.invalid) {
        rejectUpgrade(socket);
        return;
      }
      void (async () => {
        const authenticated = await authenticateSiloUpgrade(
          request,
          auth_config
        );
        if (!authenticated) {
          rejectUpgrade(socket);
          return;
        }
        try {
          wss.handleUpgrade(request, socket, head, (client) => {
            CONNECTION_AUTH_CONFIG.set(client, authenticated.auth.config);
            CONNECTION_AUTH.set(client, authenticated.auth);
            if (authenticated.auth.mode === 'sso' && authenticated.cookie) {
              startSsoSession(client, authenticated.auth, authenticated.cookie);
            }
            wss.emit('connection', client, request);
          });
        } catch {
          rejectUpgrade(socket);
        }
      })().catch(() => rejectUpgrade(socket));
    };
    http_server.on('upgrade', upgrade_handler);
  }

  // feads: tell every open client when the build changes. Server-initiated, because a
  // browser holding a stale bundle cannot be relied on to ask — the code that would do
  // the asking is the code that is out of date. Broadcast rather than per-connection
  // here: a rebuild or a source edit is a fact about the daemon, identical for every
  // client, unlike a board switch.
  const buildWatch = BUILD_IDENTITY
    ? watchBuildIdentity(BUILD_IDENTITY, {
        interval_ms: options.build_poll_ms,
        onChange: (report) => {
          log(
            'build changed → bundle %s, server_stale=%s',
            report.bundle_id,
            report.server_stale
          );
          broadcastEvent('build-info', report);
        }
      })
    : null;

  // Heartbeat: track if client answered the last ping
  wss.on('connection', (ws, request) => {
    RELEASED_CONNECTIONS.delete(ws);
    FAILED_SILO_CONNECTIONS.delete(ws);
    log('client connected');
    // @ts-expect-error add marker property
    ws.isAlive = true;

    // feads: the handshake is the only moment this connection's cookie is
    // available, so read it now rather than per message.
    const accounts_auth = /** @type {any} */ (request)?.__feadsAccountsAuth;
    // A token cookie that a verified SSO session overrode is not this socket's
    // credential on any path, so it is never bound.
    bindConnectionCredential(
      ws,
      accounts_auth?.token_cookie_ignored ? { headers: {} } : request
    );
    if (accounts_auth) {
      bindAccountsConnection(ws, accounts_auth, {
        env: auth_config.env,
        ...(options.accounts_verifier
          ? { verifier: options.accounts_verifier }
          : {}),
        onRevoked: closeAccountsSocket,
        boardOf: (/** @type {any} */ sock) =>
          String(workspaceFor(sock)?.board_id || '')
      });
    }

    // Initialize subscription state for this connection
    ensureSubs(ws);

    // feads: a new connection starts on the seed board, so it holds that board's
    // watcher from the moment it connects — without this, a dashboard where nobody
    // has touched the picker would have no watcher at all and would never notice a
    // change. The connection is deliberately *not* recorded in
    // `CONNECTION_WORKSPACES`: it has chosen nothing yet, and reading through to the
    // seed is what lets a late registry-metadata correction reach it.
    const seed = SEED_WORKSPACE;
    if (seed) {
      watchers.retain(
        { key: boardScopeKey(seed), root_dir: seed.root_dir },
        ws
      );
    }

    // feads: which build this daemon is running, before the client asks anything.
    // Sent on connect rather than only on change because the interesting case is a
    // browser that has *just* loaded a stale bundle against a stale process — there is
    // no change event coming, both have been wrong since before the socket existed.
    if (BUILD_IDENTITY) {
      try {
        sendEvent(ws, 'build-info', BUILD_IDENTITY.report());
      } catch (err) {
        log('build-info on connect failed: %o', err);
      }
    }

    ws.on('pong', () => {
      // @ts-expect-error marker
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      handleMessage(ws, data);
    });

    ws.on('close', () => {
      releaseConnection(ws);
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      // @ts-expect-error marker
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      // @ts-expect-error marker
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeat_ms);

  interval.unref?.();

  wss.on('close', () => {
    clearInterval(interval);
    if (upgrade_handler && typeof http_server.off === 'function') {
      http_server.off('upgrade', upgrade_handler);
    }
  });

  /**
   * Broadcast a server-initiated event to all open clients.
   *
   * @param {MessageType} type
   * @param {unknown} [payload]
   */
  function broadcast(type, payload) {
    broadcastEvent(type, payload);
  }

  /**
   * Change the workspace new connections start on.
   *
   * feads: this used to change *the* workspace, because there was one. There is no
   * connection behind this call — it is the daemon's own programmatic entry point —
   * so what it can honestly move is the seed, and connections that have chosen a
   * board of their own are left alone. See `applySeedSelection`.
   *
   * @param {string} new_root_dir - Absolute path to the new workspace root.
   * @returns {{ changed: boolean, workspace: WorkspaceState }}
   */
  function setWorkspace(new_root_dir) {
    return applySeedSelection({ root_dir: new_root_dir });
  }

  return {
    wss,
    broadcast,
    scheduleListRefresh,
    setWorkspace,
    // feads: exposed so a caller that owns the daemon's lifetime can close every
    // board watcher, and so a test can assert none was leaked.
    watchers,
    // feads: `check()` is exposed so a test drives the comparison directly instead of
    // waiting out a poll interval, and `stop()` so a shutdown can end it.
    buildWatch
    // v2: list subscription refresh handles updates
  };
}

/**
 * Let go of everything a closing connection held (feads).
 *
 * Five things, and each of them is a leak or a cross-talk bug if it is missed:
 * its Agentwatch membership, its place in every board's subscription registry (a
 * closed socket left in a subscriber set is written to on every refresh), its
 * share of the board watchers (an `fs.watch` handle nobody released keeps the
 * event loop alive for the life of the process), its board binding, and its
 * workspace.
 *
 * Every registry is swept, not just the one for the board it was last on: a
 * connection that closed while a switch was in flight can be attached to two, and
 * the sweep is cheap — one `Map` walk over the boards in use.
 *
 * @param {WebSocket} ws
 * @returns {void}
 */
function releaseConnection(ws) {
  RELEASED_CONNECTIONS.add(ws);
  releaseAccountsConnection(ws);
  AGENTWATCH_WATCHERS.delete(ws);
  if (AGENTWATCH_WATCHERS.size === 0) {
    clearAgentwatchRefreshTimer();
  }
  clearSsoSession(ws);
  for (const board_registry of allRegistries()) {
    try {
      board_registry.onDisconnect(ws);
    } catch {
      // ignore cleanup errors
    }
  }
  try {
    BOARD_WATCHERS?.releaseAll(ws);
  } catch {
    // ignore cleanup errors
  }
  releaseConnectionBoard(ws);
  CONNECTION_WORKSPACES.delete(ws);
  CONNECTION_CREDENTIALS.delete(ws);
  CONNECTION_AUTH.delete(ws);
  CONNECTION_AUTH_CONFIG.delete(ws);
}

/**
 * Handle an incoming message frame and respond to the same socket.
 *
 * @param {WebSocket} ws
 * @param {RawData} data
 */
/**
 * Message types that act on exactly one issue, and therefore on exactly one
 * board (feads). On the All-boards pseudo-board these are re-pointed at the
 * issue's home board before their handler runs. `subscribe-list` is absent on
 * purpose: subscriptions belong to the aggregate view itself (its fetch path
 * routes `issue-detail` internally).
 */
const ALL_BOARDS_ROUTED_TYPES = new Set([
  'update-assignee',
  'update-priority',
  'update-status',
  'edit-text',
  'add-comment',
  'get-comments',
  'delete-issue',
  'dep-add',
  'dep-remove',
  'label-add',
  'label-remove',
  'epic-graph',
  'epic-history'
]);

/**
 * The subset of routed types that write. After one of these lands, the home
 * board's own subscribers need a refresh too — the mutation gate the handler
 * opens is scoped to the *aggregate* view, which is the board this connection
 * is on.
 */
const ALL_BOARDS_MUTATING_TYPES = new Set([
  'update-assignee',
  'update-priority',
  'update-status',
  'edit-text',
  'add-comment',
  'delete-issue',
  'dep-add',
  'dep-remove',
  'label-add',
  'label-remove'
]);

/**
 * Every message that can mutate durable state performs a fresh provider
 * introspection for an SSO socket. The resolver is still memoized once per
 * message, so authorization and attribution use the same identity.
 */
const SSO_EXACT_MESSAGE_TYPES = new Set([
  ...ALL_BOARDS_MUTATING_TYPES,
  'create-issue',
  'ack-notifications',
  'remove-user'
]);

/**
 * Route one message from an All-boards connection to the board that owns the
 * issue it names (feads). Mutates `bd_options` in place — the same object every
 * handler below reads — so the handlers need no knowledge of the pseudo-board.
 *
 * Returns `'answered'` when this function already replied on the socket (a
 * refusal or a routing failure) and `'pass'` when the handler should proceed.
 *
 * @param {WebSocket} ws
 * @param {{ id: string, type: MessageType, payload?: unknown }} req
 * @param {{ cwd?: string, board_dir?: string | null, actor?: () => Promise<string> }} bd_options
 * @param {(() => Promise<any>) | null} [resolveMessageIdentity] - Accounts mode:
 * the caller, so an issue on a board it cannot reach answers exactly like one
 * that does not exist.
 * @returns {Promise<'answered' | 'pass'>}
 */
async function routeAllBoardsMessage(
  ws,
  req,
  bd_options,
  resolveMessageIdentity = null
) {
  const type = String(req.type);
  if (type === 'create-issue') {
    ws.send(
      JSON.stringify(
        makeError(
          req,
          'all_boards_no_create',
          'The All view spans every board — switch to a specific board to create an issue.'
        )
      )
    );
    return 'answered';
  }
  if (!ALL_BOARDS_ROUTED_TYPES.has(type)) {
    return 'pass';
  }
  const payload = /** @type {any} */ (req.payload || {});
  // Every routed type names its issue as `id`, except the dep pair, whose
  // issues both live on one board — bd cannot link across databases.
  const id = String(payload.id || payload.a || '').trim();
  if (id.length === 0) {
    // Let the handler's own validation produce its usual bad_request.
    return 'pass';
  }
  const board = await resolveIssueBoard(id);
  // Accounts mode: "on a board you cannot reach" and "on no board at all" are one
  // answer, word for word — anything else is an existence oracle for other spaces.
  const accounts =
    resolveMessageIdentity !== null && !siloConnection(ws) && accountsOnSync();
  const hidden =
    accounts &&
    (!board ||
      !(await messageBoardAllowed(
        await resolveMessageIdentity(),
        String(board.id),
        ACCOUNTS_WRITES.has(type)
      )));
  if (!board || hidden) {
    ws.send(
      JSON.stringify(
        makeError(
          req,
          'not_found',
          accounts
            ? `issue "${id}" is not available to you`
            : `no board owns issue "${id}"`
        )
      )
    );
    return 'answered';
  }
  bd_options.cwd = board.root_dir;
  bd_options.board_dir = board.board_dir;
  if (ALL_BOARDS_MUTATING_TYPES.has(type)) {
    // Refresh the home board's own subscribers once the write has had time to
    // land. Postgres mode does not need this (the write's NOTIFY reaches every
    // scope), but `bd` mode has no cross-scope signal. Idempotent and cheap if
    // the write fails.
    const timer = setTimeout(() => {
      scheduleListRefresh(board.board_dir);
    }, 600);
    timer.unref?.();
  }
  return 'pass';
}

/**
 * Handle an incoming message frame and respond to the same socket.
 *
 * @param {WebSocket} ws
 * @param {RawData} data
 */
export async function handleMessage(ws, data) {
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(data.toString());
  } catch {
    const reply = {
      id: 'unknown',
      ok: false,
      type: 'bad-json',
      error: { code: 'bad_json', message: 'Invalid JSON' }
    };
    ws.send(JSON.stringify(reply));
    return;
  }

  if (!isRequest(json)) {
    log('invalid request');
    const reply = {
      id: 'unknown',
      ok: false,
      type: 'bad-request',
      error: { code: 'bad_request', message: 'Invalid request envelope' }
    };
    ws.send(JSON.stringify(reply));
    return;
  }

  const req = json;
  /** @type {Promise<import('./identity.js').ResolvedIdentity> | null} */
  let message_resolution = null;
  const resolveMessageIdentity = () => {
    if (message_resolution === null) {
      message_resolution = resolveConnectionIdentity(ws, {
        exact_sso: SSO_EXACT_MESSAGE_TYPES.has(String(req.type))
      }).then(async (resolved) => {
        await touchConnectionActivity(ws, resolved);
        return resolved;
      });
    }
    return message_resolution;
  };

  // Pin every bd invocation made during this message to the workspace *this
  // connection* is looking at. Without the cwd, runBd/runBdJson fall back to
  // process.cwd() and bd reports "no beads database found" for any workspace
  // selected via set-workspace. See mantoni/beads-ui#87.
  //
  // feads: `board_dir` is the other half, and it is the one that stops one browser
  // tab's board switch from redirecting another tab's reads and writes (ex-dh0).
  // Assembled once, here, and passed to every handler below, so a handler cannot
  // run `bd` against a board other than its caller's by forgetting to thread it —
  // and the fallback if one ever did is the seed board, not "whatever was selected
  // last", which is what made the old failure invisible.
  // feads: `actor` is the third thing every bd child of this message needs, and it is
  // here for the same reason the other two are. bd stamps `created_by`, comment
  // authorship and the audit trail from `$BEADS_ACTOR`, and the daemon's own comes
  // from the shell that launched it — so a bead filed by a signed-in browser was
  // recorded as the host, not the agent, while the *authorization* for that same write
  // had already been decided against the connection's real identity (#feads-tb5). Two
  // records of one fact, disagreeing.
  //
  // A thunk, not a value: resolving it reads the registry, and most messages are reads
  // that never spawn bd. `runBd` calls it at spawn time; memoized so a handler that
  // runs bd twice (a mutation and the `show` that reports the result) pays once.
  // Accounts mode: a socket whose board the caller cannot read (the server's seed
  // board, for someone outside its space) is moved to one it can, before anything
  // reads `workspace` — so the picker, subscriptions and replies agree.
  if (!siloConnection(ws) && accountsOnSync() && !accountsConnection(ws)) {
    // Accounts mode came on after this socket opened (red-team RT-4): it was
    // never bound by the accounts upgrade, so nothing it asks is answered. It
    // is told to reconnect (through that upgrade) and closed.
    ws.send(
      JSON.stringify(
        makeError(
          req,
          'not_identified',
          'accounts mode is on — reconnect to sign in'
        )
      )
    );
    closeAccountsSocket(ws);
    return;
  }
  if (
    !siloConnection(ws) &&
    req.type !== 'ping' &&
    req.type !== 'set-board' &&
    req.type !== 'set-workspace' &&
    accountsOnSync()
  ) {
    await rehomeUnreadableConnection(ws, resolveMessageIdentity);
  }
  const workspace = workspaceFor(ws);
  const bd_options = {
    cwd: workspace?.root_dir,
    board_dir: getConnectionBoardDir(ws),
    actor: connectionActorThunk(ws, resolveMessageIdentity),
    require_actor: siloConnection(ws)
  };

  // feads: which data layer answers this message. Read once so every handler
  // below branches on the same value — `getPgStore()` is cheap, but a handler
  // that asked twice could in principle straddle a store swap and write through
  // one layer while replying from the other.
  const pg_store = getPgStore();

  // feads: the All-boards pseudo-board is a view, not a database. A message
  // that acts on one issue is routed here to the board that owns the id —
  // after this block, `bd_options` points at the issue's home board and every
  // handler below works unchanged. Creation has no id to route by, so it is
  // refused with directions instead of failing deeper down as a bd error.
  if (isAllBoardsWorkspace(workspace)) {
    const routed = await routeAllBoardsMessage(
      ws,
      req,
      bd_options,
      resolveMessageIdentity
    );
    if (routed === 'answered') {
      return;
    }
  }

  // Accounts mode: deny by default before any handler touches board data. The
  // synchronous mode check keeps a message handled in one tick when it is off.
  if (
    !siloConnection(ws) &&
    accountsOnSync() &&
    (await accountsMessageGate(ws, req, bd_options, resolveMessageIdentity)) ===
      'answered'
  ) {
    return;
  }

  // Dispatch known types here as we implement them. For now, only a ping utility.
  if (req.type === /** @type {MessageType} */ ('ping')) {
    ws.send(JSON.stringify(makeOk(req, { ts: Date.now() })));
    return;
  }

  // watch-agentwatch: the initial snapshot is fetched before this socket is
  // attached, so a failed query cannot leave a half-open watcher behind.
  if (req.type === 'watch-agentwatch') {
    if (await refuse(ws, req, 'read', {}, await resolveMessageIdentity())) {
      return;
    }
    if (!pg_store) {
      ws.send(
        JSON.stringify(
          makeError(req, 'pg_error', 'postgres data layer is not configured')
        )
      );
      return;
    }

    let snapshot;
    try {
      snapshot = await fetchAgentwatchSnapshot(
        pg_store,
        collectAgentwatchInputs()
      );
    } catch (err) {
      const error = pgErrorEnvelope(err);
      log('agentwatch snapshot failed: %s %o', error.message, error);
      ws.send(
        JSON.stringify(makeError(req, error.code, error.message, error.details))
      );
      return;
    }

    if (!canDeliverToConnection(ws)) {
      return;
    }
    await rememberAgentwatchScope(ws, await resolveMessageIdentity());
    AGENTWATCH_WATCHERS.add(ws);
    AGENTWATCH_LAST_SNAPSHOT = snapshot;
    ensureAgentwatchHeartbeat();
    ws.send(JSON.stringify(makeOk(req, scopeAgentwatchFor(ws, snapshot))));
    return;
  }

  // unwatch-agentwatch is transport cleanup and therefore deliberately does not
  // pass through the read gate. It is safe and idempotent for every caller.
  if (req.type === 'unwatch-agentwatch') {
    AGENTWATCH_WATCHERS.delete(ws);
    if (AGENTWATCH_WATCHERS.size === 0) {
      clearAgentwatchRefreshTimer();
    }
    ws.send(JSON.stringify(makeOk(req, { watching: false })));
    return;
  }

  // subscribe-list: payload { id: string, type: string, params?: object }
  if (req.type === 'subscribe-list') {
    const payload_id = /** @type {any} */ (req.payload)?.id || '';
    log('subscribe-list %s', payload_id);
    const validation = validateSubscribeListPayload(
      /** @type {any} */ (req.payload || {})
    );
    if (!validation.ok) {
      ws.send(
        JSON.stringify(makeError(req, validation.code, validation.message))
      );
      return;
    }
    // feads: the read gate. Allowed under the browser's ordinary `read_only`
    // stance; the point is `FEADS_REQUIRE_AGENT=1`, where refusing the
    // subscription is what stops the push stream before it starts.
    if (await refuse(ws, req, 'read', {}, await resolveMessageIdentity())) {
      return;
    }
    const client_id = validation.id;
    const spec = validation.spec;
    const key = keyOf(spec);
    settleMigratedSubscription(ws, client_id);

    /**
     * Reply with an error and avoid attaching the subscription when
     * initialization fails.
     *
     * @param {string} code
     * @param {string} message
     * @param {Record<string, unknown>|undefined} details
     */
    const replyWithError = (code, message, details = undefined) => {
      ws.send(JSON.stringify(makeError(req, code, message, details)));
    };

    // feads: the connection's own board, and its registry. Two connections
    // subscribed to the same list on different boards must not share a cache, or
    // each refresh diffs one board's issues against the other's.
    const board_registry = registryForBoard(boardScopeKey(workspace));

    /** @type {Awaited<ReturnType<typeof fetchListForSubscription>> | null} */
    let initial = null;
    try {
      initial = await fetchListForBoard(workspace, spec);
    } catch (err) {
      log('subscribe-list snapshot error for %s: %o', key, err);
      const message =
        (err && /** @type {any} */ (err).message) || 'Failed to load list';
      replyWithError('bd_error', String(message), { key });
      return;
    }

    if (!initial.ok) {
      log(
        'initial snapshot failed for %s: %s %o',
        key,
        initial.error.message,
        initial.error
      );
      const details = { ...(initial.error.details || {}), key };
      replyWithError(initial.error.code, initial.error.message, details);
      return;
    }

    if (!canDeliverToConnection(ws)) {
      return;
    }

    // feads: a detail subscription for an issue this board does not have is an
    // error, not an empty list. The detail modal renders *only* from this
    // subscription's snapshot, so answering ok+[] here is how a wrong-board
    // deep link (or a connection silently reset to the seed board by a
    // reconnect) turned into a modal stuck on "Loading…" forever — the client
    // was told everything went fine and given nothing to render. `not_found`
    // is what lets it react: switch to the All-boards view, or say so.
    if (String(spec.type) === 'issue-detail' && initial.items.length === 0) {
      const wanted = String((spec.params || {}).id || '');
      replyWithError('not_found', `issue "${wanted}" is not on this board`, {
        key,
        issue_id: wanted
      });
      return;
    }

    const s = ensureSubs(ws);
    const { key: attached_key } = board_registry.attach(spec, ws);
    s.list_subs?.set(client_id, { key: attached_key, spec });

    try {
      await board_registry.withKeyLock(attached_key, async () => {
        const items = applyClosedIssuesFilter(
          spec,
          initial ? initial.items : []
        );
        void board_registry.applyItems(attached_key, items);
        emitSubscriptionSnapshot(ws, client_id, attached_key, items);
      });
    } catch (err) {
      log('subscribe-list snapshot error for %s: %o', attached_key, err);
      s.list_subs?.delete(client_id);
      try {
        board_registry.detach(spec, ws);
      } catch {
        // ignore detach errors
      }
      replyWithError('bd_error', 'Failed to publish snapshot', { key });
      return;
    }

    if (canDeliverToConnection(ws)) {
      ws.send(
        JSON.stringify(makeOk(req, { id: client_id, key: attached_key }))
      );
    }
    return;
  }

  // unsubscribe-list: payload { id: string }
  if (req.type === 'unsubscribe-list') {
    log('unsubscribe-list %s', /** @type {any} */ (req.payload)?.id || '');
    const { id: client_id } = /** @type {any} */ (req.payload || {});
    if (typeof client_id !== 'string' || client_id.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bad_request', 'payload.id must be a non-empty string')
        )
      );
      return;
    }
    settleMigratedSubscription(ws, client_id);
    const s = ensureSubs(ws);
    const sub = s.list_subs?.get(client_id) || null;
    let removed = false;
    if (sub) {
      try {
        // feads: the connection's *current* board's registry, which is where this
        // subscription lives even if it was opened on a different board —
        // `applyBoardSelection` moves them across on every switch, so there is one
        // place to look rather than a board recorded per subscription that could
        // disagree with the connection's.
        removed = registryForBoard(boardScopeKey(workspace)).detach(
          sub.spec,
          ws
        );
      } catch {
        removed = false;
      }
      s.list_subs?.delete(client_id);
    }
    ws.send(
      JSON.stringify(
        makeOk(req, {
          id: client_id,
          unsubscribed: removed
        })
      )
    );
    return;
  }

  // Removed: subscribe-updates and subscribe-issues. No-ops in v2.

  // list-issues and epic-status were removed in favor of push-only subscriptions

  // Removed: show-issue. Details flow is push-only via `subscribe-list { type: 'issue-detail' }`.

  // type updates are not exposed via UI; no handler

  // update-assignee
  if (req.type === 'update-assignee') {
    const { id, assignee } = /** @type {any} */ (req.payload || {});
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof assignee !== 'string'
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, assignee: string }'
          )
        )
      );
      return;
    }
    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        (store, board_id, actor) =>
          store.updateAssignee(board_id, id, assignee, { actor }),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, out.value)));
      afterMutation(workspace);
      return;
    }
    // Pass empty string to clear assignee when requested
    const res = await runBd(['update', id, '--assignee', assignee], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    return;
  }

  // update-status
  if (req.type === 'update-status') {
    log('update-status');
    const { id, status } = /** @type {any} */ (req.payload);
    const allowed = new Set(['open', 'in_progress', 'closed']);
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof status !== 'string' ||
      !allowed.has(status)
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            "payload requires { id: string, status: 'open'|'in_progress'|'closed' }"
          )
        )
      );
      return;
    }
    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        (store, board_id, actor) =>
          store.updateStatus(board_id, id, status, { actor }),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, out.value)));
      afterMutation(workspace);
      implicitFlare(ws, workspace, id, await resolveMessageIdentity());
      // A close is the event dependents are waiting to hear about; don't leave
      // it to the next sweep.
      nudgeNotifications(ws, bd_options.board_dir);
      return;
    }
    const res = await runBd(['update', id, '--status', status], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    implicitFlare(ws, workspace, id, await resolveMessageIdentity());
    // After mutation, refresh active subscriptions once (watcher or timeout)
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    // A close is the event dependents are waiting to hear about; don't leave
    // it to the watcher's debounce.
    nudgeNotifications(ws, bd_options.board_dir);
    return;
  }

  // update-priority
  if (req.type === 'update-priority') {
    log('update-priority');
    const { id, priority } = /** @type {any} */ (req.payload);
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof priority !== 'number' ||
      priority < 0 ||
      priority > 4
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, priority: 0..4 }'
          )
        )
      );
      return;
    }
    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        (store, board_id, actor) =>
          store.updatePriority(board_id, id, priority, { actor }),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, out.value)));
      afterMutation(workspace);
      return;
    }
    const res = await runBd(
      ['update', id, '--priority', String(priority)],
      bd_options
    );
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    return;
  }

  // edit-text
  if (req.type === 'edit-text') {
    log('edit-text');
    const { id, field, value } = /** @type {any} */ (req.payload);
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      (field !== 'title' &&
        field !== 'description' &&
        field !== 'acceptance' &&
        field !== 'notes' &&
        field !== 'design') ||
      typeof value !== 'string'
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            "payload requires { id: string, field: 'title'|'description'|'acceptance'|'notes'|'design', value: string }"
          )
        )
      );
      return;
    }
    // Map UI fields to bd CLI flags
    // title       → --title
    // description → --description
    // acceptance  → --acceptance-criteria
    // notes       → --notes
    // design      → --design
    const flag =
      field === 'title'
        ? '--title'
        : field === 'description'
          ? '--description'
          : field === 'acceptance'
            ? '--acceptance-criteria'
            : field === 'notes'
              ? '--notes'
              : '--design';
    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        (store, board_id, actor) =>
          store.editText(board_id, id, field, value, { actor }),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, out.value)));
      afterMutation(workspace);
      return;
    }
    const res = await runBd(['update', id, flag, value], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    return;
  }

  // create-issue
  if (req.type === 'create-issue') {
    log('create-issue');
    const { title, type, priority, description } = /** @type {any} */ (
      req.payload || {}
    );
    if (typeof title !== 'string' || title.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { title: string, ... }'
          )
        )
      );
      return;
    }
    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        async (store, board_id, actor) =>
          store.createIssue(board_id, {
            title,
            ...(typeof type === 'string' && CREATABLE_TYPES.has(type)
              ? { issue_type: type }
              : {}),
            ...(typeof priority === 'number' && priority >= 0 && priority <= 4
              ? { priority }
              : {}),
            ...(typeof description === 'string' && description.length > 0
              ? { description }
              : {}),
            // Attribution matches `add-comment`: the connection's registered
            // actor when there is one, so `created_by` is the same handle the
            // roster, @mentions and the delete-ownership check all use. The git
            // name is the local operator's fallback, and it is what `bd` would
            // have recorded for the same caller.
            actor: actor || (siloConnection(ws) ? '' : await getGitUserName())
          }),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      // Reply with a minimal ack — the same one the bd path sends. The new row
      // reaches the client through the list refresh below, not through here.
      ws.send(JSON.stringify(makeOk(req, { created: true })));
      afterMutation(workspace);
      return;
    }
    const args = ['create', title];
    if (typeof type === 'string' && CREATABLE_TYPES.has(type)) {
      args.push('-t', type);
    }
    if (typeof priority === 'number' && priority >= 0 && priority <= 4) {
      args.push('-p', String(priority));
    }
    if (typeof description === 'string' && description.length > 0) {
      args.push('-d', description);
    }
    const res = await runBd(args, bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    // Reply with a minimal ack
    ws.send(JSON.stringify(makeOk(req, { created: true })));
    // Refresh active subscriptions once (watcher or timeout)
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    return;
  }

  // dep-add: payload { a: string, b: string, view_id?: string }
  if (req.type === 'dep-add') {
    const { a, b, view_id } = /** @type {any} */ (req.payload || {});
    if (
      typeof a !== 'string' ||
      a.length === 0 ||
      typeof b !== 'string' ||
      b.length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { a: string, b: string }'
          )
        )
      );
      return;
    }
    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const view =
        typeof view_id === 'string' && view_id.length > 0 ? view_id : a;
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        async (store, board_id, actor) => {
          await store.depAdd(board_id, a, b, { actor });
          return store.showIssue(board_id, view);
        },
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, out.value)));
      afterMutation(workspace);
      return;
    }
    const res = await runBd(['dep', 'add', a, b], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const id = typeof view_id === 'string' && view_id.length > 0 ? view_id : a;
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    return;
  }

  // dep-remove: payload { a: string, b: string, view_id?: string }
  //
  // feads — deliberately NOT gated, and this note is here so nobody "fixes" the
  // omission. The word "remove" is the trap: this drops an edge between two
  // items and destroys nothing an agent filed, so under the two-tier model it is
  // `write`, which both tiers hold. Gating it would make a `user` unable to
  // unblock its own work the moment someone else drew the dependency — the exact
  // collaboration the board exists to support. Only `delete-issue` destroys an
  // item, and only it is gated.
  if (req.type === 'dep-remove') {
    const { a, b, view_id } = /** @type {any} */ (req.payload || {});
    if (
      typeof a !== 'string' ||
      a.length === 0 ||
      typeof b !== 'string' ||
      b.length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { a: string, b: string }'
          )
        )
      );
      return;
    }
    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const view =
        typeof view_id === 'string' && view_id.length > 0 ? view_id : a;
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        async (store, board_id, actor) => {
          await store.depRemove(board_id, a, b, { actor });
          return store.showIssue(board_id, view);
        },
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, out.value)));
      afterMutation(workspace);
      return;
    }
    const res = await runBd(['dep', 'remove', a, b], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const id = typeof view_id === 'string' && view_id.length > 0 ? view_id : a;
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    return;
  }

  // label-add: payload { id: string, label: string }
  if (req.type === 'label-add') {
    const { id, label } = /** @type {any} */ (req.payload || {});
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof label !== 'string' ||
      label.trim().length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, label: non-empty string }'
          )
        )
      );
      return;
    }
    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        (store, board_id, actor) =>
          store.labelAdd(board_id, id, label.trim(), { actor }),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, out.value)));
      afterMutation(workspace);
      return;
    }
    const res = await runBd(['label', 'add', id, label.trim()], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    return;
  }

  // label-remove: payload { id: string, label: string }
  //
  // feads — deliberately NOT gated, same reasoning as dep-remove above: taking a
  // label off an item mutates it, so it is `write`, which both tiers hold. Note
  // this is asymmetric with `delete-issue` on purpose. Ownership only limits
  // *destruction*, and a `user` that could not relabel another agent's bead
  // could not triage a shared board at all.
  if (req.type === 'label-remove') {
    const { id, label } = /** @type {any} */ (req.payload || {});
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof label !== 'string' ||
      label.trim().length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, label: non-empty string }'
          )
        )
      );
      return;
    }
    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        (store, board_id, actor) =>
          store.labelRemove(board_id, id, label.trim(), { actor }),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, out.value)));
      afterMutation(workspace);
      return;
    }
    const res = await runBd(['label', 'remove', id, label.trim()], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    return;
  }

  // get-comments: payload { id: string }
  if (req.type === 'get-comments') {
    const { id } = /** @type {any} */ (req.payload || {});
    if (typeof id !== 'string' || id.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bad_request', 'payload requires { id: string }')
        )
      );
      return;
    }
    if (await refuse(ws, req, 'read', {}, await resolveMessageIdentity())) {
      return;
    }
    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        (store, board_id) => store.listComments(board_id, id),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, out.value)));
      return;
    }
    const res = await runBdJson(['comments', id, '--json'], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, res.stdoutJson || [])));
    return;
  }

  // epic-graph (feads): payload { id: string } — the current dependency graph
  // of one epic, from a fresh capture of the caller's board. The capture also
  // persists a history line for every changed epic on that board, so opening a
  // story view is itself a snapshot point — the replay always has a frame for
  // "when somebody looked".
  if (req.type === 'epic-graph') {
    const { id } = /** @type {any} */ (req.payload || {});
    if (typeof id !== 'string' || id.trim().length === 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bad_request', 'payload requires { id: string }')
        )
      );
      return;
    }
    if (await refuse(ws, req, 'read', {}, await resolveMessageIdentity())) {
      return;
    }
    /** @type {Awaited<ReturnType<typeof captureBoard>>} */
    let snapshots;
    try {
      snapshots = await captureBoard({
        board_dir: bd_options.board_dir ?? null,
        cwd: bd_options.cwd
      });
    } catch (err) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bd_error',
            (err && /** @type {any} */ (err).message) || 'capture failed'
          )
        )
      );
      return;
    }
    const graph = epicGraphPayload(snapshots, id.trim());
    if (!graph) {
      ws.send(
        JSON.stringify(
          makeError(req, 'not_found', `No epic ${id.trim()} on this board`)
        )
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, graph)));
    return;
  }

  // epic-history (feads): payload { id: string } — the recorded snapshot series
  // for one epic on the caller's board. Pure disk read; the recorder in
  // `story-snapshots.js` is what writes it.
  if (req.type === 'epic-history') {
    const { id } = /** @type {any} */ (req.payload || {});
    if (typeof id !== 'string' || id.trim().length === 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bad_request', 'payload requires { id: string }')
        )
      );
      return;
    }
    if (await refuse(ws, req, 'read', {}, await resolveMessageIdentity())) {
      return;
    }
    const board_key = storyBoardKey({
      board_dir: bd_options.board_dir ?? null,
      cwd: bd_options.cwd
    });
    /** @type {ReturnType<typeof readEpicHistory>} */
    let history;
    try {
      history = readEpicHistory(board_key, id.trim());
    } catch (err) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bd_error',
            (err && /** @type {any} */ (err).message) || 'history read failed'
          )
        )
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, { epic_id: id.trim(), ...history })));
    return;
  }

  // add-comment: payload { id: string, text: string }
  if (req.type === 'add-comment') {
    const { id, text } = /** @type {any} */ (req.payload || {});
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof text !== 'string' ||
      text.trim().length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, text: non-empty string }'
          )
        )
      );
      return;
    }

    if (await refuse(ws, req, 'write', {}, await resolveMessageIdentity())) {
      return;
    }

    // Author attribution (feads): the connection's registered actor when there
    // is one, so a comment is signed with the same handle that `created_by`,
    // the roster, and @mentions all use — a mention of the git user.name would
    // reach nobody. The git name remains the fallback for the local operator.
    const resolved = await resolveMessageIdentity();
    const author =
      resolved.identity?.actor ||
      (siloConnection(ws) ? '' : await getGitUserName());

    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        (store, board_id) =>
          store.addComment(board_id, id, text.trim(), { actor: author }),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      // The updated comments list, exactly as the bd path replies.
      ws.send(JSON.stringify(makeOk(req, out.value)));
      afterMutation(workspace);
      implicitFlare(ws, workspace, id, await resolveMessageIdentity());
      nudgeNotifications(ws, bd_options.board_dir);
      return;
    }

    const args = ['comments', 'add', id, text.trim()];
    if (author) {
      args.push('--author', author);
    }

    const res = await runBd(args, bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }

    // Return updated comments list
    const comments = await runBdJson(['comments', id, '--json'], bd_options);
    if (comments.code !== 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bd_error', comments.stderr || 'bd failed')
        )
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, comments.stdoutJson || [])));
    implicitFlare(ws, workspace, id, await resolveMessageIdentity());
    // A comment is a mutation like any other: open the refresh gate so other
    // subscribers see the new comment_count, and rescan promptly so mentions
    // land while the conversation is still warm.
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    nudgeNotifications(ws, bd_options.board_dir);
    return;
  }

  // delete-issue: payload { id: string }
  if (req.type === 'delete-issue') {
    const { id } = /** @type {any} */ (req.payload || {});
    if (typeof id !== 'string' || id.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bad_request', 'payload requires { id: string }')
        )
      );
      return;
    }
    // feads: the one destructive operation on this socket, and the only one whose
    // answer can depend on the *item* rather than only on the caller — which is
    // why it does not go through `refuse` but asks twice. A refusal is an ordinary
    // error reply: crashing the socket would take the whole dashboard down over
    // one denied click.
    const delete_identity = await resolveMessageIdentity();
    const decision = await authorizeIssueDelete(
      ws,
      id,
      bd_options,
      delete_identity
    );
    if (!decision.allowed) {
      log('delete of %s refused: %s', id, decision.reason);
      ws.send(
        JSON.stringify(
          makeError(req, 'forbidden', decision.reason, {
            id,
            mode: decision.mode,
            action: 'delete'
          })
        )
      );
      if (/** @type {any} */ (delete_identity).silo_failure)
        closeSiloSocket(ws);
      return;
    }
    if (pg_store) {
      const out = await runPgOp(
        ws,
        req,
        bd_options.board_dir,
        (store, board_id, actor) => store.deleteIssue(board_id, id, { actor }),
        await resolveMessageIdentity()
      );
      if (out === undefined) {
        return;
      }
      ws.send(JSON.stringify(makeOk(req, { deleted: true, id })));
      afterMutation(workspace);
      return;
    }
    const res = await runBd(['delete', id, '--force'], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bd_error', res.stderr || 'bd delete failed')
        )
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, { deleted: true, id })));
    try {
      triggerMutationRefreshOnce(boardScopeKey(workspace));
    } catch {
      // ignore
    }
    return;
  }

  // whoami (feads): who the server thinks is acting, and under which mode.
  //
  // Never an error reply, including for a rejected credential. `mode:
  // 'rejected'` with `identity: null` is the answer the dashboard needs in order
  // to *say* the credential was refused; an error envelope would be indistinct
  // from a transport failure and the UI would fall back to looking like operator
  // mode, which is the silence this whole distinction exists to break.
  // Deliberately not gated. It is the login affordance: a client that cannot ask
  // who it is cannot be told that it needs to sign in.
  if (req.type === 'whoami') {
    const resolved = await resolveMessageIdentity();
    if (/** @type {any} */ (resolved).silo_failure) {
      closeSiloSocket(ws);
      return;
    }
    const sso = /** @type {any} */ (resolved).sso;
    log(
      'whoami → %s (%s)',
      resolved.identity?.actor || `(${resolved.mode})`,
      resolved.mode
    );
    ws.send(
      JSON.stringify(
        makeOk(req, {
          // Accounts mode names the identity's board only to a caller who can
          // read it (a user's principal row is anchored on the default board).
          identity: await scopeIdentityBoard(resolved.identity, resolved),
          mode: resolved.mode,
          ...(sso ? { sso } : {}),
          // The stance is what the UI needs to tell "read-only, here is a login
          // box" apart from "refused outright", which share `mode: 'anonymous'`.
          // Derivable from `require_identity`, but sending it means the client is
          // not re-deriving a rule the server already applied.
          stance: resolved.stance,
          surface: SURFACE,
          require_identity: resolved.require_identity,
          credential_rejected: resolved.credential_rejected,
          .../** @type {any} */ (
            resolved.principal
              ? { accounts: await principalSummary(resolved) }
              : {}
          )
        })
      )
    );
    return;
  }

  // list-agents (feads): payload { include_revoked?: boolean }
  //
  // Scope is the server's decision, not the client's — a `user` asking for the
  // roster gets its own row back, and no payload field can widen that.
  if (req.type === 'list-agents') {
    const validation = validateListAgentsPayload(req.payload);
    if (!validation.ok) {
      ws.send(
        JSON.stringify(makeError(req, validation.code, validation.message))
      );
      return;
    }
    // feads: the roster is board-scoped, and the board is *this connection's*. A
    // shared "current board" here is how one tab's switch changed which agents
    // another tab was shown. Note `board_id` is `''` for a board with no registry
    // entry, and `listRoster` answers an empty roster for that rather than treating
    // a falsy id as "no filter" — which would list every agent on every board under
    // the heading of the one on screen.
    const roster_identity = await resolveMessageIdentity();
    if (siloConnection(ws)) {
      if (!roster_identity.identity?.actor) {
        ws.send(
          JSON.stringify(
            makeError(
              req,
              'forbidden',
              'a live verified silo actor is required for the roster',
              {
                mode: 'rejected'
              }
            )
          )
        );
        if (/** @type {any} */ (roster_identity).silo_failure)
          closeSiloSocket(ws);
        return;
      }
      const row = {
        ...roster_identity.identity,
        host: '',
        workspace_dir: '',
        session_id: '',
        kind: 'human',
        registered_at: 0,
        revoked_at: 0,
        revoke_reason: '',
        archived_at: 0
      };
      ws.send(
        JSON.stringify(
          makeOk(req, {
            agents: [row],
            scope: 'self',
            board_id: roster_identity.identity.board_id,
            reason: 'SSO-linked agent sees its own identity',
            mode: roster_identity.mode,
            stance: roster_identity.stance,
            require_identity: roster_identity.require_identity,
            credential_rejected: false
          })
        )
      );
      return;
    }
    // Accounts mode: the caller is whoever this connection resolves to (SSO
    // included, not just a token cookie), and the roster is `directory_read` —
    // every board's agent rows, limited to the people the caller shares a space
    // with exactly as `list-users` is, each row naming only a readable board.
    // The tier roster scope (`user` → self) is the pre-accounts model; here the
    // space is the boundary, so list-agents and list-users agree.
    if (!siloConnection(ws) && (await accountsOn())) {
      const directory = await decide(roster_identity, 'directory_read');
      if (!directory.allowed) {
        ws.send(JSON.stringify(makeError(req, 'forbidden', directory.reason)));
        return;
      }
      const rows = await scopeBoardFields(
        await scopeDirectoryRows(
          await listRosterRows({ include_revoked: validation.include_revoked }),
          roster_identity
        ),
        roster_identity
      );
      log('list-agents (accounts) → %d row(s)', rows.length);
      ws.send(
        JSON.stringify(
          makeOk(req, {
            agents: rows,
            scope: 'all',
            board_id: '',
            reason: 'people who share a space with you',
            mode: roster_identity.mode,
            stance: roster_identity.stance,
            require_identity: roster_identity.require_identity,
            credential_rejected: false
          })
        )
      );
      return;
    }
    const roster = await listRoster({
      token: credentialFor(ws),
      board_id: workspace?.board_id,
      include_revoked: validation.include_revoked
    });
    if (!roster.allowed) {
      ws.send(JSON.stringify(makeError(req, 'forbidden', roster.reason)));
      return;
    }
    log(
      'list-agents → %d row(s), scope=%s',
      roster.agents.length,
      roster.scope
    );
    ws.send(
      JSON.stringify(
        makeOk(req, {
          agents: roster.agents,
          scope: roster.scope,
          board_id: roster.board_id,
          reason: roster.reason,
          mode: roster.mode,
          stance: roster.stance,
          require_identity: roster.require_identity,
          credential_rejected: roster.credential_rejected
        })
      )
    );
    return;
  }

  // remove-user (feads): destructive account removal. The registry preflight is
  // read-only and happens before Postgres so malformed, missing, self, and
  // last-admin requests cannot purge issue data. The second registry call runs
  // only after the all-board Postgres transaction commits.
  if (String(req.type) === 'remove-user') {
    const validation = validateRemoveUserPayload(req.payload);
    if (!validation.ok) {
      ws.send(
        JSON.stringify(makeError(req, validation.code, validation.message))
      );
      return;
    }
    const resolved = await resolveMessageIdentity();
    if (await refuse(ws, req, 'manage_agents', {}, resolved)) {
      return;
    }
    if (!siloConnection(ws) && (await accountsOn())) {
      // Accounts mode: removing someone is `accounts_admin` — a superadmin, from
      // the dashboard. The tier check above alone would admit any credential
      // resolving to a superadmin's (tier admin) row, agent tokens included.
      const admin = await decide(resolved, 'accounts_admin');
      if (!admin.allowed) {
        ws.send(
          JSON.stringify(
            makeError(req, 'forbidden', admin.reason, {
              action: 'accounts_admin'
            })
          )
        );
        return;
      }
      // A service account is not removed like a person's agent: that would revoke
      // its identity row and scrub its history. It is disabled (or its keys
      // revoked) on Access → Service accounts, which keeps both.
      const mods = await loadAccountsModules();
      if (mods && typeof mods.accounts.getServiceAccount === 'function') {
        const db = openRegistry();
        let service = null;
        try {
          service = mods.accounts.getServiceAccount(db, validation.actor);
        } finally {
          db.close();
        }
        if (service) {
          ws.send(
            JSON.stringify(
              makeError(
                req,
                'service_account',
                `${validation.actor} is a service account: disable it or revoke its keys on Access → Service accounts`
              )
            )
          );
          return;
        }
      }
    }
    if (!pg_store || typeof pg_store.purgeActor !== 'function') {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'pg_unavailable',
            'remove-user requires the PostgreSQL data layer; no identity data was changed'
          )
        )
      );
      return;
    }

    const config = siloConfigFor(ws);
    const registry_options = {
      path: config.registry_path,
      env: config.env
    };
    const requester_agent_id = String(resolved.identity?.agent_id || '');
    const requester_actor = String(resolved.identity?.actor || '');
    let preflight;
    try {
      const db = openRegistry(registry_options);
      try {
        preflight = inspectAgentRemoval(db, {
          actor: validation.actor,
          requester_agent_id,
          requester_actor
        });
      } finally {
        db.close();
      }
    } catch (error) {
      if (error instanceof AgentRemovalError) {
        ws.send(
          JSON.stringify(
            makeError(req, error.code, error.message, error.details)
          )
        );
      } else {
        log('remove-user registry preflight failed: %o', error);
        ws.send(
          JSON.stringify(
            makeError(
              req,
              'registry_error',
              'could not inspect the identity registry'
            )
          )
        );
      }
      return;
    }

    // The registry preflight already computed the complete descendant closure.
    // Pass every distinct actor handle to the one PostgreSQL transaction so
    // descendant-authored rows are scrubbed along with the root actor. Keep the
    // first spelling from the registry and compare only case-insensitively; these
    // are safe roster handles, not client-supplied free text.
    /** @type {string[]} */
    const removed_actors = [];
    /** @type {Set<string>} */
    const seen_removed_actors = new Set();
    for (const agent of Array.isArray(preflight.agents)
      ? preflight.agents
      : []) {
      const actor = String(agent?.actor || '').trim();
      const key = actor.toLowerCase();
      if (actor.length === 0 || seen_removed_actors.has(key)) {
        continue;
      }
      seen_removed_actors.add(key);
      removed_actors.push(actor);
    }
    const root_actor_key = preflight.actor.toLowerCase();
    if (!seen_removed_actors.has(root_actor_key)) {
      removed_actors.unshift(preflight.actor);
    }

    let purged;
    try {
      purged = await pg_store.purgeActor(preflight.actor, removed_actors);
    } catch (error) {
      const envelope = pgErrorEnvelope(error);
      log(
        'remove-user PostgreSQL purge failed: %s %o',
        envelope.message,
        error
      );
      ws.send(
        JSON.stringify(
          makeError(req, envelope.code, envelope.message, envelope.details)
        )
      );
      return;
    }

    let registry_result;
    try {
      const db = openRegistry(registry_options);
      try {
        registry_result = removeAgentActor(db, {
          actor: preflight.actor,
          requester_agent_id,
          requester_actor,
          reason: `removed by ${requester_actor || 'operator'}`
        });
      } finally {
        db.close();
      }
    } catch (error) {
      // The PG purge is already committed. Make that fact explicit so an
      // operator does not retry blindly and mistake a registry failure for a
      // no-op; the inert target row is still the next repair target.
      log(
        'remove-user registry scrub failed after PostgreSQL commit: %o',
        error
      );
      const details = {
        purged: true,
        ...(error instanceof AgentRemovalError ? error.details || {} : {})
      };
      ws.send(
        JSON.stringify(
          makeError(
            req,
            error instanceof AgentRemovalError ? error.code : 'registry_error',
            error instanceof AgentRemovalError
              ? error.message
              : 'PostgreSQL data was purged but the identity registry could not be scrubbed',
            details
          )
        )
      );
      return;
    }

    ws.send(
      JSON.stringify(
        makeOk(req, {
          removed: true,
          ...purged,
          removed_actors,
          registry: registry_result
        })
      )
    );
    scheduleAgentwatchRefresh();
    nudgeFlareSubscriptions('');
    return;
  }

  // list-users (feads): the @mention directory — every live registered agent,
  // every board, roster-safe fields only.
  //
  // Deliberately NOT `list-agents`: that one is the operator's roster, scoped
  // by tier (a `user` sees only itself) and carrying host/workspace/session
  // columns. The directory answers a different question — "who can I address?"
  // — and a collaboration surface where users cannot see each other's handles
  // would make mentions admin-only by accident.
  if (req.type === 'list-users') {
    if (await refuse(ws, req, 'read', {}, await resolveMessageIdentity())) {
      return;
    }
    const users = await scopeBoardFields(
      await scopeDirectoryRows(
        await listUsersDirectory(),
        await resolveMessageIdentity()
      ),
      await resolveMessageIdentity()
    );
    // Accounts mode: who each alias belongs to, so the dashboard names
    // `alex-laptop` as its owner. Same directory rule as the rows; absent
    // when accounts mode is off.
    const owners = await ownerDirectoryFor(await resolveMessageIdentity());
    // ...and the person behind each handle (email for the optional directory hover card,
    // service accounts labelled), under the same directory rule.
    const people = owners
      ? await peopleDirectoryFor(await resolveMessageIdentity())
      : null;
    log('list-users → %d row(s)', users.length);
    ws.send(
      JSON.stringify(
        makeOk(
          req,
          owners ? { users, owners, ...(people ? { people } : {}) } : { users }
        )
      )
    );
    return;
  }

  // list-notifications (feads): payload { unread_only?: boolean, limit?: number }
  //
  // The inbox belongs to the connection's identity, so an anonymous connection
  // gets an empty, well-formed answer rather than an error — the bell renders
  // nothing instead of the dashboard failing to load.
  if (req.type === 'list-notifications') {
    const validation = validateListNotificationsPayload(req.payload);
    if (!validation.ok) {
      ws.send(
        JSON.stringify(makeError(req, validation.code, validation.message))
      );
      return;
    }
    const resolved = await resolveMessageIdentity();
    const actor = resolved.identity?.actor || '';
    if (actor.length === 0) {
      if (siloConnection(ws)) {
        ws.send(
          JSON.stringify(
            makeError(
              req,
              'forbidden',
              'a live verified silo actor is required for notifications',
              {
                mode: 'rejected'
              }
            )
          )
        );
        if (/** @type {any} */ (resolved).silo_failure) closeSiloSocket(ws);
        return;
      }
      ws.send(
        JSON.stringify(
          makeOk(req, { notifications: [], unread_count: 0, actor: null })
        )
      );
      return;
    }
    // The browser lists the *seen* queue: the badge answers "has the human
    // looked", not "has an agent acted" — that second queue is the HTTP
    // surface's default and rides along as unhandled_count.
    //
    // And a human sees only what they were @mentioned in (audience 'human'):
    // claims, overlaps and status traffic are coordination for their agents,
    // which read every type over MCP/HTTP.
    const payload = await listNotificationsForActor(actor, {
      unread_only: validation.unread_only,
      limit: validation.limit,
      queue: 'seen',
      audience: 'human',
      .../** @type {any} */ (resolved.principal ? { resolved } : {})
    });
    log(
      'list-notifications → %d row(s), %d unread (%s)',
      payload.notifications.length,
      payload.unread_count,
      actor
    );
    ws.send(JSON.stringify(makeOk(req, { ...payload, actor })));
    return;
  }

  // ack-notifications (feads): payload { ids?: string[], all?: boolean }
  //
  // Requires an identity — there is no inbox to ack without one. The store
  // only ever touches rows addressed to the caller, so ids belonging to
  // someone else are silently skipped rather than authorized here.
  if (req.type === 'ack-notifications') {
    const validation = validateAckNotificationsPayload(req.payload);
    if (!validation.ok) {
      ws.send(
        JSON.stringify(makeError(req, validation.code, validation.message))
      );
      return;
    }
    const resolved = await resolveMessageIdentity();
    const actor = resolved.identity?.actor || '';
    if (actor.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            siloConnection(ws) ? 'forbidden' : 'not_identified',
            siloConnection(ws)
              ? 'a live verified silo actor is required for notifications'
              : 'sign in as a registered agent to manage notifications'
          )
        )
      );
      if (siloConnection(ws) && /** @type {any} */ (resolved).silo_failure)
        closeSiloSocket(ws);
      return;
    }
    // A browser ack means *seen* — a bell click or Mark-all-read clears the
    // badge and nothing else. It must never stamp handled_at: a human reading
    // their own bell is not an answer, and letting it discharge the agents'
    // queue is exactly the bug that once ate a [q] mention 85 seconds after
    // it was posted.
    const result = await ackNotificationsForActor(actor, {
      ids: validation.ids,
      all: validation.all,
      mode: 'seen',
      audience: 'human',
      .../** @type {any} */ (resolved.principal ? { resolved } : {})
    });
    log('ack-notifications → %d acked (%s)', result.acked, actor);
    ws.send(JSON.stringify(makeOk(req, result)));
    return;
  }

  // list-workspaces: returns all available boards — the bd daemon registry plus
  // (feads) the SQLite board registry, which is the only source that knows a
  // board's name, description and repos.
  if (req.type === 'list-workspaces') {
    log('list-workspaces');
    const workspaces = await scopeWorkspaceList(
      await listAvailableBoards(workspace),
      ws,
      resolveMessageIdentity
    );
    ws.send(
      JSON.stringify(
        makeOk(req, {
          workspaces,
          // feads: this connection's board, not a shared one. Two tabs on two
          // boards each see their own selected in the picker.
          current: workspace
        })
      )
    );
    return;
  }

  // get-workspace: returns the board this connection is looking at
  if (req.type === 'get-workspace') {
    log('get-workspace');
    ws.send(JSON.stringify(makeOk(req, workspace)));
    return;
  }

  // set-workspace: payload { path: string }
  if (req.type === 'set-workspace') {
    log('set-workspace');
    const { path: workspace_path } = /** @type {any} */ (req.payload || {});
    if (typeof workspace_path !== 'string' || workspace_path.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { path: string } (absolute workspace path)'
          )
        )
      );
      return;
    }

    if (await accountsOn()) {
      // R on the board the path resolves to; a path naming no registered board
      // (board_id '') is refused by the same check, with the same answer.
      const resolved = await resolveMessageIdentity();
      const board_id = boardIdForDir(
        findNearestBoardDir(path.resolve(workspace_path))
      );
      if (!(await messageBoardAllowed(resolved, board_id, false))) {
        ws.send(
          JSON.stringify(
            makeError(req, 'forbidden', 'that board is not available to you')
          )
        );
        return;
      }
    }
    const selected = applyBoardSelection(ws, { root_dir: workspace_path });
    ws.send(
      JSON.stringify(
        makeOk(req, {
          changed: selected.changed,
          workspace: selected.workspace
        })
      )
    );
    return;
  }

  // set-board (feads): payload { id?: string, board_dir?: string, path?: string }
  //
  // set-workspace only takes a project root, which is not how a board is
  // identified: a registry board records its own `.beads` directory and may sit
  // outside any project root the daemon can see. This selects a board directly.
  if (req.type === 'set-board') {
    log('set-board');
    const validation = validateSetBoardPayload(
      /** @type {any} */ (req.payload || {})
    );
    if (!validation.ok) {
      ws.send(
        JSON.stringify(makeError(req, validation.code, validation.message))
      );
      return;
    }

    const accounts_selection = !siloConnection(ws) && (await accountsOn());
    const resolution = await resolveBoardSelection(validation);
    if (!resolution.ok) {
      // Accounts mode: an unknown board id and a board in another space answer
      // alike, word for word — otherwise set-board is an oracle for which board
      // ids exist. Only a board the caller can read explains why it failed.
      const requested = String(
        validation.id || boardIdForDir(validation.board_dir) || ''
      );
      if (
        accounts_selection &&
        !(await messageBoardAllowed(
          await resolveMessageIdentity(),
          requested,
          false
        ))
      ) {
        ws.send(
          JSON.stringify(
            makeError(req, 'forbidden', 'that board is not available to you')
          )
        );
        return;
      }
      ws.send(
        JSON.stringify(makeError(req, resolution.code, resolution.message))
      );
      return;
    }

    if (await accountsOn()) {
      const scoped = await scopeBoardSelection(
        resolution.selection,
        /** @type {any} */ (req.payload || {}),
        await resolveMessageIdentity()
      );
      if (!scoped) {
        ws.send(
          JSON.stringify(
            makeError(req, 'forbidden', 'that board is not available to you')
          )
        );
        return;
      }
      resolution.selection = scoped;
    }

    const selected = applyBoardSelection(ws, resolution.selection);
    ws.send(
      JSON.stringify(
        makeOk(req, {
          changed: selected.changed,
          workspace: selected.workspace
        })
      )
    );
    return;
  }

  // Unknown type
  const err = makeError(
    req,
    'unknown_type',
    `Unknown message type: ${req.type}`
  );
  ws.send(JSON.stringify(err));
}

// ---------------------------------------------------------------------------
// Accounts mode (the excluded hosted-provider design)
// ---------------------------------------------------------------------------

/** Messages that scope themselves (or touch no board data). */
const ACCOUNTS_SELF_SCOPED = new Set([
  'ping',
  'whoami',
  'get-workspace',
  'list-workspaces',
  'set-board',
  'set-workspace',
  'list-notifications',
  'ack-notifications',
  'list-users',
  'list-agents',
  'watch-agentwatch',
  'unwatch-agentwatch',
  'unsubscribe-list',
  'remove-user'
]);

/** Messages that write board data. */
const ACCOUNTS_WRITES = new Set([
  'update-assignee',
  'update-status',
  'update-priority',
  'edit-text',
  'create-issue',
  'dep-add',
  'dep-remove',
  'label-add',
  'label-remove',
  'add-comment',
  'delete-issue'
]);

/**
 * Deny by default before any handler touches board data. Reads need
 * `space_read` on the board's space, writes `item_write`; a dependency's other
 * end must be writable and in the same space. Anonymous callers are refused
 * everything except `whoami`/`ping` (the login affordance).
 *
 * @param {WebSocket} ws
 * @param {{ id: string, type: MessageType, payload?: unknown }} req
 * @param {{ board_dir?: string | null }} bd_options
 * @param {() => Promise<any>} resolveMessageIdentity
 * @returns {Promise<'answered' | 'pass'>}
 */
async function accountsMessageGate(
  ws,
  req,
  bd_options,
  resolveMessageIdentity
) {
  if (siloConnection(ws) || !(await accountsOn())) return 'pass';
  const type = String(req.type);
  if (
    type === 'ping' ||
    type === 'whoami' ||
    type === 'unwatch-agentwatch' ||
    type === 'unsubscribe-list'
  ) {
    return 'pass';
  }
  const resolved = await resolveMessageIdentity();
  const principal = principalOf(resolved);
  /** @param {string} message */
  const deny = (message) => {
    ws.send(JSON.stringify(makeError(req, 'forbidden', message)));
    if (resolved?.accounts_failure) closeAccountsSocket(ws);
    return /** @type {'answered'} */ ('answered');
  };
  if (principal.kind === 'anonymous') {
    return deny('sign in with an external SSO provider to use Feads');
  }
  if (principal.kind === 'system' && ACCOUNTS_WRITES.has(type)) {
    return deny('this credential is read-only');
  }
  if (
    principal.kind === 'service' &&
    principal.read_only !== false &&
    ACCOUNTS_WRITES.has(type)
  ) {
    return deny('this service account is read-only');
  }
  if (ACCOUNTS_SELF_SCOPED.has(type)) return 'pass';
  const workspace = workspaceFor(ws);
  const write = ACCOUNTS_WRITES.has(type);
  if (isAllBoardsWorkspace(workspace) && !ALL_BOARDS_ROUTED_TYPES.has(type)) {
    const space = String(/** @type {any} */ (workspace).space_id || '');
    const mods = await loadAccountsModules();
    const ok =
      !!space &&
      !!mods &&
      mods.access.decideAccess(principal, write ? 'item_write' : 'space_read', {
        space
      }).allowed;
    return ok ? 'pass' : deny('that space is not available to you');
  }
  const board_id =
    (!isAllBoardsWorkspace(workspace) && workspace?.board_id) ||
    boardIdForDir(bd_options.board_dir);
  if (!(await messageBoardAllowed(resolved, board_id, write))) {
    return deny('that board is not available to you');
  }
  // dep-remove needs W on the dependent issue only (the edge's owner, `a`, on
  // this board): it never reads or writes the other end, so a leftover
  // cross-space edge can be cleaned up by whoever may write its owner, and the
  // answer is the same whether the other end exists, is hidden or is missing.
  if (type === 'dep-add') {
    // Both ends are authorized against the board that actually holds them, and
    // an end no readable board holds — missing, tombstoned, on an unregistered
    // board, on a board in another space — is refused with one answer, so the
    // refusal says nothing about which it was. No edge is ever written blind.
    const other = String(/** @type {any} */ (req.payload || {}).b || '').trim();
    if (other) {
      const other_board = await authoritativeIssueBoard(other);
      const spaces = await boardSpaces();
      const theirs = other_board ? spaces.get(other_board) || '' : '';
      if (
        !other_board ||
        !theirs ||
        !(await messageBoardAllowed(resolved, other_board, true))
      ) {
        return deny(`issue "${other}" is not available to you`);
      }
      if (theirs !== (spaces.get(board_id) || '')) {
        return deny('dependencies cannot cross spaces');
      }
    }
  }
  return 'pass';
}

/**
 * The board that really holds `issue_id`: Postgres's own `issues.board_id` when
 * the store is Postgres (never a prefix guess, never "the first board that
 * answered"), else the bd probe across registered boards. `''` when nothing
 * holds it — and when the lookup fails, so a broken lookup can only refuse.
 *
 * @param {string} issue_id
 * @returns {Promise<string>}
 */
async function authoritativeIssueBoard(issue_id) {
  const store = getPgStore();
  if (store && typeof store.boardOfIssue === 'function') {
    try {
      return String((await store.boardOfIssue(issue_id)) || '');
    } catch (err) {
      log('accounts: issue→board lookup failed for %s: %o', issue_id, err);
      return '';
    }
  }
  const board = await resolveIssueBoard(issue_id);
  return board ? String(board.id) : '';
}

/**
 * Move a socket off a board its caller cannot read, onto the first board it can
 * (the default space's first, else any space's first, by name). Leaves the socket
 * alone when nothing is readable — the gate then refuses every board read.
 *
 * @param {WebSocket} ws
 * @param {() => Promise<any>} resolveMessageIdentity
 * @returns {Promise<void>}
 */
async function rehomeUnreadableConnection(ws, resolveMessageIdentity) {
  const current = workspaceFor(ws);
  if (isAllBoardsWorkspace(current)) return;
  const resolved = await resolveMessageIdentity();
  if (principalOf(resolved).kind === 'anonymous') return;
  const readable = await readableBoardIds(resolved);
  if (readable === null) return;
  const board_id = String(
    current?.board_id || boardIdForDir(getConnectionBoardDir(ws)) || ''
  );
  if (board_id && readable.has(board_id)) return;
  const spaces = await boardSpaces();
  const candidates = (await listRegistryBoards())
    .filter((b) => b.exists && readable.has(String(b.id)))
    .sort((a, b) => {
      const da = spaces.get(String(a.id)) === 'sp_team_a' ? 0 : 1;
      const db = spaces.get(String(b.id)) === 'sp_team_a' ? 0 : 1;
      return (
        da - db || String(a.name || a.id).localeCompare(String(b.name || b.id))
      );
    });
  if (candidates.length === 0) return;
  const resolution = await resolveBoardSelection({
    id: String(candidates[0].id),
    board_dir: '',
    path: ''
  });
  if (!resolution.ok) return;
  log(
    'accounts: re-homing socket from %s to %s',
    board_id || '(none)',
    candidates[0].id
  );
  applyBoardSelection(ws, resolution.selection);
}

/**
 * Close an accounts socket whose identity or board access is gone.
 *
 * @param {any} ws
 */
function closeAccountsSocket(ws) {
  releaseConnection(ws);
  try {
    if (typeof ws.close === 'function' && ws.readyState === ws.OPEN) {
      ws.close(1008, 'access revoked');
    }
  } catch {
    // already closing
  }
}

/**
 * Boards in the aggregate's space (accounts mode), or null when the aggregate is
 * unscoped (accounts off).
 *
 * @param {WorkspaceState | null} board
 * @returns {Promise<Set<string> | null>}
 */
async function spaceBoardFilter(board) {
  const space = String(/** @type {any} */ (board)?.space_id || '');
  if (!space) return null;
  /** @type {Set<string>} */
  const out = new Set();
  for (const [id, sp] of await boardSpaces()) {
    if (sp === space) out.add(id);
  }
  return out;
}

/**
 * Accounts mode: decide a board selection. A physical board must be readable; the
 * All-boards view is bound to one readable space (the requested one, else the
 * default space when readable, else the first readable space).
 *
 * @param {any} selection
 * @param {any} payload
 * @param {any} resolved
 * @returns {Promise<any | null>}
 */
async function scopeBoardSelection(selection, payload, resolved) {
  const mods = await loadAccountsModules();
  if (!mods) return null;
  const principal = principalOf(resolved);
  if (selection.all_boards) {
    const readable = mods.access.accessibleSpaces(principal);
    const wanted = String(payload.space_id || payload.space || '');
    /** @param {string} sp */
    const ok = (sp) => !!sp && (readable === null || readable.has(sp));
    let space = '';
    if (wanted) {
      if (!ok(wanted)) return null;
      space = wanted;
    } else if (ok('sp_team_a')) {
      space = 'sp_team_a';
    } else if (readable && readable.size > 0) {
      space = [...readable].sort()[0];
    }
    if (!space) return null;
    return { ...selection, space_id: space };
  }
  const board_id = String(
    selection.id || boardIdForDir(selection.board_dir) || ''
  );
  return (await messageBoardAllowed(resolved, board_id, false))
    ? selection
    : null;
}

/**
 * Accounts mode: the picker lists only readable registry boards (each carrying its
 * space); server-local workspaces outside the registry are for superadmins only.
 *
 * @param {Array<Record<string, any>>} entries
 * @param {WebSocket} ws
 * @param {() => Promise<any>} resolveMessageIdentity
 */
async function scopeWorkspaceList(entries, ws, resolveMessageIdentity) {
  if (siloConnection(ws) || !(await accountsOn())) return entries;
  const resolved = await resolveMessageIdentity();
  const principal = principalOf(resolved);
  const readable = await readableBoardIds(resolved);
  const spaces = await boardSpaces();
  const readable_count = entries.filter((entry) => {
    const id = String(entry.id || '');
    return id && id !== ALL_BOARD_ID && (readable === null || readable.has(id));
  }).length;
  return entries
    .filter((entry) => {
      const id = String(entry.id || '');
      // Same rule as the unscoped picker: an aggregate of one board is that board.
      if (id === ALL_BOARD_ID)
        return principal.kind !== 'anonymous' && readable_count > 1;
      if (!id)
        return principal.kind === 'user' && principal.is_superadmin === true;
      return readable === null || readable.has(id);
    })
    .map((entry) => ({
      ...entry,
      space_id: spaces.get(String(entry.id || '')) || ''
    }));
}

/**
 * Accounts mode: directory rows limited to people sharing a readable space.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {any} resolved
 */
async function scopeDirectoryRows(rows, resolved) {
  if (!resolved?.principal || !(await accountsOn())) return rows;
  const mods = await loadAccountsModules();
  if (!mods) return [];
  const db = openRegistry();
  try {
    const allowed = mods.accounts.directoryActors(
      db,
      resolved.principal,
      mods.access.accessibleSpaces
    );
    const visible =
      allowed === null
        ? rows
        : rows.filter((r) => allowed.has(String(r.actor || '')));
    // Service accounts are labelled as such (kind 'service' + steward), so no
    // surface mistakes one for a person.
    return typeof mods.accounts.labelServiceRows === 'function'
      ? mods.accounts.labelServiceRows(db, visible)
      : visible;
  } finally {
    db.close();
  }
}

/**
 * Accounts mode: the alias → owner directory a resolved caller may see
 * (`accounts.mjs ownerDirectory`), or `null` when accounts mode is off.
 *
 * @param {any} resolved
 * @returns {Promise<Array<{ actor: string, display_name: string, aliases: string[] }> | null>}
 */
async function ownerDirectoryFor(resolved) {
  if (!(await accountsOn())) return null;
  if (!resolved?.principal) return [];
  const mods = await loadAccountsModules();
  if (!mods || typeof mods.accounts.ownerDirectory !== 'function') return [];
  const db = openRegistry();
  try {
    return mods.accounts.ownerDirectory(
      db,
      resolved.principal,
      mods.access.accessibleSpaces
    );
  } catch (err) {
    log('owner directory unavailable: %o', err);
    return [];
  } finally {
    db.close();
  }
}

/**
 * Per-socket Agentwatch scope (accounts mode): readable boards and visible actors.
 *
 * @type {WeakMap<WebSocket, { boards: Set<string> | null, actors: Set<string> | null }>}
 */
const AGENTWATCH_SCOPES = new WeakMap();

/**
 * @param {WebSocket} ws
 * @param {any} resolved
 */
async function rememberAgentwatchScope(ws, resolved) {
  const scope = await agentwatchScopeFor(resolved);
  if (scope) {
    AGENTWATCH_SCOPES.set(ws, scope);
  } else {
    AGENTWATCH_SCOPES.delete(ws);
  }
}

/**
 * Project an Agentwatch snapshot onto what one socket may see: agents it shares a
 * space with, and only issues/discussions/flares on boards it can read.
 *
 * @param {WebSocket} ws
 * @param {any} snapshot
 */
function scopeAgentwatchFor(ws, snapshot) {
  return scopeAgentwatchSnapshot(snapshot, AGENTWATCH_SCOPES.get(ws));
}
