/**
 * Agentwatch over HTTP, for programmatic readers that hold an agent token (P3's
 * Agents panel). The dashboard keeps its pushed WebSocket feed; this route is the
 * same snapshot, built from the same inputs and projected through the same
 * per-viewer scope, served once per request.
 *
 * @import { Express, Request, Response } from 'express'
 */
import { aliasMap, isServiceUser, listUsers } from '../../boards/accounts.mjs';
import { listAgents } from '../../boards/agents.mjs';
import { listFlares } from '../../boards/flares.mjs';
import { openRegistry } from '../../boards/registry.mjs';
import { listRuntimePresence } from '../../boards/runtime-presence.mjs';
import {
  accountsOn,
  accountsOnSync,
  loadAccountsModules,
  readableBoardIds
} from './accounts.js';
import { fetchAgentwatchSnapshot } from './agentwatch.js';
import { debug } from './logging.js';
import { resolveHttpActor } from './notifications-engine.js';
import { getPgStore, pgErrorEnvelope } from './pg-store.js';
import { activePresenceErrors } from './runtime-presence-outcomes.js';

const log = debug('agentwatch-routes');

const ALIAS_FOLD_TTL_MS = 60_000;

/** @type {{ at: number, key: string, value: Map<string, string> | null } | null} */
let ALIAS_FOLD_CACHE = null;

/**
 * @typedef {{ boards: Set<string> | null, actors: Set<string> | null }} AgentwatchScope
 */

/**
 * Read one advisory registry list. Flares, runtime presence and the roster are
 * all advisory: any registry failure returns an empty list rather than degrading
 * the snapshot.
 *
 * @param {string} what
 * @param {(db: any) => unknown[]} read
 * @param {Record<string, string | undefined>} [env]
 * @returns {unknown[]}
 */
function readAdvisory(what, read, env) {
  try {
    const db = openRegistry(env ? { env } : {});
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch (err) {
    log('agentwatch %s read failed (ignored): %o', what, err);
    return [];
  }
}

/**
 * Lower-cased alias → canonical person actor, from the accounts alias map (the
 * one the notification engine routes mentions through). Service accounts stay
 * their own lanes, so their actors and aliases are left out; unowned legacy
 * agents are nobody's alias and never appear in the map.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Map<string, string>}
 */
export function personAliasFold(db) {
  /** @type {Set<string>} */
  const services = new Set();
  for (const user of listUsers(db)) {
    if (user && isServiceUser(user)) {
      services.add(String(user.actor || '').toLowerCase());
    }
  }
  /** @type {Map<string, string>} */
  const fold = new Map();
  for (const [alias, actor] of aliasMap(db)) {
    if (!services.has(String(actor).toLowerCase())) {
      fold.set(alias, actor);
    }
  }
  return fold;
}

/**
 * The alias fold for this process's Agentwatch snapshot: `null` unless accounts
 * mode governs the instance (base and silo non-accounts behave as before).
 * Cached in-process and rebuilt at most every 60 s; a failed rebuild keeps the
 * previous map (or none) and is retried after the same interval.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {number} [now]
 * @returns {Map<string, string> | null}
 */
export function agentwatchAliasFold(env, now = Date.now()) {
  const environment = env || process.env;
  if (!accountsOnSync(environment)) {
    return null;
  }
  const key = String(environment.FEADS_REGISTRY_DB || '');
  const cached =
    ALIAS_FOLD_CACHE && ALIAS_FOLD_CACHE.key === key ? ALIAS_FOLD_CACHE : null;
  if (cached && now - cached.at < ALIAS_FOLD_TTL_MS) {
    return cached.value;
  }
  let value = cached ? cached.value : null;
  try {
    const db = openRegistry(env ? { env } : {});
    try {
      value = personAliasFold(db);
    } finally {
      db.close();
    }
  } catch (err) {
    log('agentwatch alias map unavailable (lanes stay unfolded): %o', err);
  }
  ALIAS_FOLD_CACHE = { at: now, key, value };
  return value;
}

/** Drop the cached alias fold (tests). */
export function resetAgentwatchAliasFoldForTests() {
  ALIAS_FOLD_CACHE = null;
}

/**
 * The inputs Agentwatch merges into the issue snapshot: presence flares (live
 * heartbeats), agent runtime sessions, the registered-agent roster, recently
 * rejected runtime heartbeats (this process), and — accounts mode only — the
 * alias fold that puts a person's agents on one lane.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function collectAgentwatchInputs(env) {
  return {
    flares: readAdvisory('flare', (db) => listFlares(db), env),
    runtime_presence: readAdvisory(
      'runtime presence',
      (db) => listRuntimePresence(db),
      env
    ),
    roster: readAdvisory('roster', (db) => listAgents(db), env),
    presence_errors: activePresenceErrors(),
    aliases: agentwatchAliasFold(env)
  };
}

/**
 * What one viewer may see of Agentwatch in accounts mode: the boards it can read
 * and the actors it shares a space with. `null` means no projection applies.
 *
 * @param {any} resolved - The caller's resolved identity.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<AgentwatchScope | null>}
 */
export async function agentwatchScopeFor(resolved, env = process.env) {
  if (!resolved?.principal || !(await accountsOn(env))) {
    return null;
  }
  const mods = await loadAccountsModules();
  const db = openRegistry({ env });
  try {
    return {
      boards: await readableBoardIds(resolved, env),
      actors: mods
        ? mods.accounts.directoryActors(
            db,
            resolved.principal,
            mods.access.accessibleSpaces
          )
        : new Set()
    };
  } finally {
    db.close();
  }
}

/**
 * Project an Agentwatch snapshot onto one viewer's scope: agents it shares a
 * space with, and only issues/discussions/flares on boards it can read. A lane's
 * `item_count` is its uncapped `board_item_counts` summed over readable boards
 * (the bounded issue list when a lane carries no counts), and `aliases` names
 * only actors the viewer may see. Folding happened before this projection, so
 * a lane is admitted by its canonical person actor.
 *
 * @param {any} snapshot
 * @param {AgentwatchScope | null | undefined} scope
 */
export function scopeAgentwatchSnapshot(snapshot, scope) {
  if (!scope || !snapshot || typeof snapshot !== 'object') return snapshot;
  /** @param {any} item */
  const readable = (item) =>
    scope.boards === null || scope.boards.has(String(item?.board_id || ''));
  /** @param {string} actor */
  const visible = (actor) => scope.actors === null || scope.actors.has(actor);
  const agents = (Array.isArray(snapshot.agents) ? snapshot.agents : [])
    .filter((/** @type {any} */ a) => visible(String(a?.actor || '')))
    .map((/** @type {any} */ a) => {
      const issues = (Array.isArray(a.issues) ? a.issues : []).filter(readable);
      /** @type {Record<string, any>} */
      const lane = {
        ...a,
        issues,
        item_count: issues.length,
        flare: a.flare && readable(a.flare) ? a.flare : null
      };
      const counts = a.board_item_counts;
      if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
        /** @type {Record<string, number>} */
        const board_item_counts = {};
        let item_count = 0;
        for (const [board_id, value] of Object.entries(counts)) {
          const count = Number(value);
          if (readable({ board_id }) && Number.isFinite(count) && count > 0) {
            board_item_counts[board_id] = count;
            item_count += count;
          }
        }
        lane.board_item_counts = board_item_counts;
        lane.item_count = Math.max(item_count, issues.length);
      }
      if (Array.isArray(a.aliases)) {
        const aliases = a.aliases.filter((/** @type {any} */ alias) =>
          visible(String(alias))
        );
        if (aliases.length > 0) {
          lane.aliases = aliases;
        } else {
          delete lane.aliases;
        }
      }
      return lane;
    });
  const discussions = (
    Array.isArray(snapshot.discussions) ? snapshot.discussions : []
  ).filter(readable);
  return {
    ...snapshot,
    stats: {
      ...(snapshot.stats || {}),
      registered_agents: agents.length,
      active_issues: agents.reduce(
        (/** @type {number} */ t, /** @type {any} */ a) => t + a.item_count,
        0
      ),
      shared_discussions: discussions.length
    },
    agents,
    discussions
  };
}

/**
 * Attach `GET /api/agentwatch`. Answers `{ ok, actor, snapshot }`, 401 for an
 * unidentified caller and 503 when the Postgres data layer is not configured.
 *
 * @param {Express} app
 * @param {{ env?: Record<string, string | undefined>, ssoVerifier?: any, accountsVerifier?: any }} [options]
 */
export function attachAgentwatchRoutes(app, options = {}) {
  const env = options.env || process.env;
  const http_auth = {
    env,
    ssoVerifier: options.ssoVerifier,
    ...(options.accountsVerifier
      ? { accountsVerifier: options.accountsVerifier }
      : {})
  };

  /**
   * @param {Request} req
   * @param {Response} res
   */
  app.get('/api/agentwatch', async (req, res) => {
    const auth = await resolveHttpActor(req, http_auth);
    if (!auth.actor && !auth.system) {
      res.status(401).json({ ok: false, error: 'not_identified' });
      return;
    }
    const store = getPgStore(env);
    if (!store) {
      res.status(503).json({ ok: false, error: 'pg_unavailable' });
      return;
    }
    let snapshot;
    try {
      snapshot = await fetchAgentwatchSnapshot(
        store,
        collectAgentwatchInputs(env)
      );
    } catch (err) {
      const error = pgErrorEnvelope(err);
      log('agentwatch snapshot failed: %s %o', error.message, error);
      res.status(500).json({ ok: false, error: error.code });
      return;
    }
    const scope = await agentwatchScopeFor(auth.resolved, env);
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      actor: auth.actor || null,
      snapshot: scopeAgentwatchSnapshot(snapshot, scope)
    });
  });
}
