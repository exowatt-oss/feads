/**
 * A cross-board issue list over HTTP, for programmatic readers that hold an
 * agent token (P3's "My work" feed). Reads Postgres directly and only returns
 * issues on boards the caller can read.
 *
 * @import { Express, Request, Response } from 'express'
 */
import { readableBoardIds } from './accounts.js';
import { listRegistryBoards } from './board-registry.js';
import { debug } from './logging.js';
import { resolveHttpActor } from './notifications-engine.js';
import { getPgStore, pgErrorEnvelope } from './pg-store.js';

const log = debug('issues-routes');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_STATUSES = 8;

/**
 * Open blockers only: a closed `blocks` target no longer holds anything up.
 */
const ISSUES_SQL = `
  SELECT i.id, i.board_id, i.title, i.status, i.issue_type, i.priority,
         i.assignee, i.created_at, i.updated_at, i.closed_at,
         COALESCE(lab.labels, ARRAY[]::text[]) AS labels,
         COALESCE(blk.ids, ARRAY[]::text[])    AS blocked_by
    FROM issues i
    LEFT JOIN LATERAL (
      SELECT array_agg(l.label ORDER BY l.label) AS labels
        FROM labels l WHERE l.issue_id = i.id
    ) lab ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(t.id ORDER BY t.id) AS ids
        FROM deps d JOIN issues t ON t.id = d.depends_on_id
       WHERE d.issue_id = i.id AND d.dep_type = 'blocks'
         AND t.deleted_at IS NULL AND t.status <> 'closed'
    ) blk ON true
   WHERE i.deleted_at IS NULL
     AND ($1::text[] IS NULL OR i.status = ANY($1::text[]))
     AND ($2::text[] IS NULL OR lower(btrim(i.assignee)) = ANY($2::text[]))
     AND ($3::text[] IS NULL OR i.board_id = ANY($3::text[]))
   ORDER BY i.updated_at DESC NULLS LAST, i.id ASC
   LIMIT $4`;

/**
 * Split a comma-separated query value into trimmed, non-empty tokens.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function tokens(value) {
  return String(value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * The actors `assignee=me` stands for: the caller and, in accounts mode, every
 * alias of the person behind it. Lowercased to match the query.
 *
 * @param {{ actor?: string, resolved?: any }} auth
 * @returns {string[]}
 */
function selfActors(auth) {
  const aliases = auth.resolved?.principal?.aliases;
  const actors = [
    String(auth.actor || ''),
    ...(Array.isArray(aliases) ? aliases.map(String) : [])
  ];
  return [
    ...new Set(
      actors.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0)
    )
  ];
}

/**
 * @param {Date | string | null | undefined} value
 */
function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Attach `GET /api/issues`. Query parameters, all optional:
 *
 * - `status`: comma-separated statuses (`in_progress`, `open,in_progress`).
 * - `assignee`: `me` for the caller (and its aliases), or one actor.
 * - `board`: a board id, comma-separated ids, or `*` for every readable board.
 * - `limit`: 1–500, default 100. Newest-updated first.
 *
 * Answers `{ ok, actor, issues }`, 401 for an unidentified caller and 503 when
 * the Postgres data layer is not configured.
 *
 * @param {Express} app
 * @param {{ env?: Record<string, string | undefined>, ssoVerifier?: any, accountsVerifier?: any }} [options]
 */
export function attachIssueRoutes(app, options = {}) {
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
  app.get('/api/issues', async (req, res) => {
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

    const statuses = tokens(req.query.status).slice(0, MAX_STATUSES);
    const assignee = String(req.query.assignee ?? '').trim();
    let actors = null;
    if (assignee === 'me') {
      actors = selfActors(auth);
      if (actors.length === 0) {
        res.status(400).json({ ok: false, error: 'no_actor_for_me' });
        return;
      }
    } else if (assignee.length > 0) {
      actors = [assignee.toLowerCase()];
    }

    const readable = auth.resolved?.principal
      ? await readableBoardIds(auth.resolved, env)
      : null;
    const requested = tokens(req.query.board).filter((b) => b !== '*');
    let boards = readable === null ? null : [...readable];
    if (requested.length > 0) {
      boards = requested.filter((b) => readable === null || readable.has(b));
    }

    const parsed_limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(parsed_limit)
      ? Math.min(Math.max(parsed_limit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    let rows;
    try {
      const result = await store.query(ISSUES_SQL, [
        statuses.length > 0 ? statuses : null,
        actors,
        boards,
        limit
      ]);
      rows = Array.isArray(result?.rows) ? result.rows : [];
    } catch (err) {
      const error = pgErrorEnvelope(err);
      log('issues query failed: %s %o', error.message, error);
      res.status(500).json({ ok: false, error: error.code });
      return;
    }

    const board_names = new Map(
      (await listRegistryBoards()).map((b) => [b.id, b.name])
    );
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      actor: auth.actor || null,
      issues: rows.map((/** @type {any} */ row) => ({
        id: String(row.id),
        title: String(row.title || ''),
        status: String(row.status || 'open'),
        issue_type: String(row.issue_type || 'task'),
        priority: typeof row.priority === 'number' ? row.priority : null,
        assignee: row.assignee ? String(row.assignee) : null,
        labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
        board_id: String(row.board_id || ''),
        board_name: board_names.get(String(row.board_id || '')) || null,
        created_at: isoOrNull(row.created_at),
        updated_at: isoOrNull(row.updated_at),
        closed_at: isoOrNull(row.closed_at),
        blocked_by: Array.isArray(row.blocked_by)
          ? row.blocked_by.map(String)
          : []
      }))
    });
  });
}
