/**
 * feads addition — the Postgres data layer, and the only place SQL lives.
 *
 * ## Why
 *
 * Every read the dashboard performed used to spawn a `bd` child that opened an
 * embedded Dolt database (~200ms), and every one of those spawns was globally
 * serialized through a single promise queue (`bd.js` withBdRunQueue). A board
 * page is four subscriptions, so the last column arrived ~800ms after the first
 * request; a board switch re-fetched every live subscription behind the same
 * queue and took seconds. None of that is a query cost — it is process and
 * storage-engine startup, paid once per read.
 *
 * This module replaces the *data layer* with Postgres behind one flag,
 * `FEADS_PG_DSN`. When it is set the server never spawns `bd`; when it is unset
 * every legacy path is byte-for-byte what it was, because that is the rollback
 * and the upstream-compatibility story. There is deliberately no third mode.
 *
 * ## What it owns
 *
 * - A small `pg.Pool` (a handful of connections is plenty — the work is
 *   millisecond queries, not long transactions).
 * - A *separate* dedicated connection holding `LISTEN feads_events`. It cannot
 *   come from the pool: a pooled client is handed back after each query and the
 *   subscription would go with it.
 * - Id generation for new issues (`<prefix>-<3 chars base36>`, collision-checked
 *   in a retry loop, which is the shape bd mints — `ex-6zr`, `feads-3bb`).
 * - Every statement, reads and writes both. Nothing else in the server writes
 *   SQL, so the semantics locked by `pgstore/views.sql` (and its parity harness
 *   against golden `bd` output) cannot be forked by a second call site.
 *
 * ## Change propagation
 *
 * Every mutation runs in one transaction that also appends an `events` row and
 * calls `pg_notify('feads_events', '<board>:<issue>:<kind>')`. The NOTIFY is
 * emitted inside the transaction, so subscribers see it only if the write
 * committed. The listener fans it out to the callbacks registered with
 * `onPgEvent`, which is how the ws layer schedules a list refresh and how the
 * notification engine schedules a scan.
 *
 * The consequence worth stating: a write from *another process* — the Python MCP
 * server, a future CLI — notifies too, so open dashboards finally refresh on
 * somebody else's write. Under `bd` they could not: the file watcher cannot see
 * a write landing inside `embeddeddolt/<db>/.dolt/noms`, so the only refreshes that ever
 * fired were the ones this process caused itself.
 *
 * ## Board identity
 *
 * The rest of the server keys boards by their physical `.beads` directory. Here
 * the key is the registry board id, and the two are related by exactly one rule:
 * `.../<board_id>/.beads` → `<board_id>` (`boardIdForDir`). One helper, used
 * everywhere, validated against the `boards` table, so an unmapped directory
 * fails loudly on the first read instead of silently answering with another
 * board's rows.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { accountsOnSync, boardSpaces } from './accounts.js';
import { debug } from './logging.js';

const log = debug('pg-store');

/** The `NOTIFY` channel every writer uses. Mirrored in `pgstore/schema.sql`. */
export const PG_CHANNEL = 'feads_events';

/**
 * The DSN this process should use, or `''` for legacy (`bd`) mode.
 *
 * @param {Record<string, string | undefined>} [env] - Environment to read.
 * @returns {string}
 */
export function pgDsn(env = process.env) {
  return String(env.FEADS_PG_DSN || '').trim();
}

/**
 * Whether the Postgres data layer is active.
 *
 * @param {Record<string, string | undefined>} [env] - Environment to read.
 * @returns {boolean}
 */
export function isPgMode(env = process.env) {
  return pgDsn(env).length > 0;
}

/**
 * The board id a `.beads` directory belongs to.
 *
 * The physical layout is `<root>/<board_id>/.beads`, both on the hosted server
 * (`/var/lib/feads/boards/example/.beads`) and in a developer checkout
 * (`/Users/x/example/feads/.beads` → `feads`), so the id is the basename of the
 * board directory's *parent*. Kept as one function rather than inlined at each
 * call site because a second, subtly different derivation would route reads and
 * writes to different boards — the worst possible failure here, and a silent one.
 *
 * @param {string | null | undefined} board_dir - A `.beads` directory.
 * @returns {string} The board id, or `''` when there is nothing to derive from.
 */
export function boardIdForDir(board_dir) {
  const raw = String(board_dir || '').trim();
  if (raw.length === 0) {
    return '';
  }
  const resolved = path.resolve(raw);
  const parent = path.dirname(resolved);
  if (parent === resolved) {
    return '';
  }
  return path.basename(parent);
}

/**
 * An error carrying a protocol error code, so a ws handler can answer with the
 * same `{ code, message }` envelope it uses for a `bd` failure.
 */
export class PgStoreError extends Error {
  /**
   * @param {string} code - Protocol error code.
   * @param {string} message - Human-readable message.
   * @param {Record<string, unknown>} [details] - Extra context for the client.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'PgStoreError';
    this.code = code;
    /** @type {Record<string, unknown> | undefined} */
    this.details = details;
  }
}

/**
 * Structure a store failure the way a `bd` failure is structured, so the client
 * sees one error envelope whichever data layer is running.
 *
 * Lives here rather than beside the read path because the error *class* lives
 * here, and because `ws.js` needs it too: several suites replace
 * `list-adapters.js` wholesale with a one-export mock, and an import of this
 * from there would break them for a reason that has nothing to do with what
 * they test.
 *
 * @param {unknown} err - What the store threw.
 * @returns {{ code: string, message: string, details?: Record<string, unknown> }}
 */
export function pgErrorEnvelope(err) {
  if (err instanceof PgStoreError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {})
    };
  }
  const raw =
    err && typeof err === 'object'
      ? /** @type {{ message?: unknown }} */ (err).message
      : '';
  const message = typeof raw === 'string' && raw.length > 0 ? raw : '';
  return { code: 'pg_error', message: message || 'postgres query failed' };
}

/**
 * Turn a timestamptz column into the string shape bd emitted, so
 * `normalizeIssueList` (which runs `Date.parse` on strings) sees no difference.
 *
 * @param {unknown} value - A `Date` from node-postgres, or nullish.
 * @returns {string | null}
 */
function isoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

/**
 * Epoch ms for a timestamp that arrived inside a jsonb aggregate (Postgres
 * renders those as ISO-ish strings rather than as `Date`s).
 *
 * @param {unknown} value - Timestamp string, number, or nullish.
 * @returns {number | null}
 */
function epochOrNull(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Normalize the timestamps inside an embedded issue reference to epoch ms —
 * the shape `types/subscriptions.ts` declares for `DependencyRef`, and the one
 * the client's sorters can actually compare. (`bd` shipped `0001-01-01…`
 * strings here, and `Number()` turns those into `NaN`.
 *
 * @param {unknown} refs - The jsonb array node-postgres decoded.
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeRefs(refs) {
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.map((ref) => {
    /** @type {Record<string, unknown>} */
    const out = {};
    if (!ref || typeof ref !== 'object') {
      return out;
    }
    for (const key of Object.keys(ref)) {
      const value = ref[key];
      if (value === null || value === undefined) {
        continue;
      }
      if (key === 'created_at' || key === 'updated_at' || key === 'closed_at') {
        const ms = epochOrNull(value);
        if (ms !== null) {
          out[key] = ms;
        }
        continue;
      }
      out[key] = value;
    }
    return out;
  });
}

/**
 * The columns every list row carries. Deliberately without the prose fields:
 * `trimListItems` strips those on the way out anyway, and a 1000-row closed
 * column that selects every description is the single biggest avoidable cost in
 * a snapshot.
 */
const LIST_COLUMNS = `
  i.id, i.title, i.status, i.priority, i.issue_type,
  i.assignee, i.owner, i.created_by, i.external_ref,
  i.metadata, i.close_reason,
  i.created_at, i.updated_at, i.closed_at, i.started_at,
  i.lease_expires_at, i.heartbeat_at`;

/** Prose fields, added on top of `LIST_COLUMNS` for the detail subscription. */
const DETAIL_COLUMNS = `
  i.description, i.design, i.acceptance_criteria, i.notes`;

/**
 * The aggregates every issue row carries: labels, the slim dependency list, the
 * three counters the cards render, and the parent epic.
 *
 * `dependency_count` counts dep *rows* while `dependencies` only lists the ones
 * whose target still exists — bd counts the edge and drops the dangling target
 * from the rendered list, and `views.sql` documents why dangling targets are
 * expected in real data.
 */
const ISSUE_AGGREGATES = `
  COALESCE(lab.labels, ARRAY[]::text[])              AS labels,
  COALESCE(dep.deps, '[]'::jsonb)                    AS dependencies,
  COALESCE(dep_n.n, 0)::int                          AS dependency_count,
  COALESCE(dpt_n.n, 0)::int                          AS dependent_count,
  COALESCE(cmt.n, 0)::int                            AS comment_count,
  par.parent,
  par.parent_board_id`;

const ISSUE_AGGREGATE_JOINS = `
LEFT JOIN LATERAL (
  SELECT array_agg(l.label ORDER BY l.label) AS labels
  FROM labels l WHERE l.issue_id = i.id
) lab ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
    'id', t.id, 'title', t.title, 'status', t.status,
    'issue_type', t.issue_type, 'dependency_type', d.dep_type,
    'board_id', t.board_id
  ) ORDER BY t.id) AS deps
  FROM deps d JOIN issues t ON t.id = d.depends_on_id
  WHERE d.issue_id = i.id AND t.deleted_at IS NULL
) dep ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n FROM deps d WHERE d.issue_id = i.id
) dep_n ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n FROM deps d WHERE d.depends_on_id = i.id
) dpt_n ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n FROM comments c WHERE c.issue_id = i.id
) cmt ON true
LEFT JOIN LATERAL (
  SELECT d.depends_on_id AS parent, p.board_id AS parent_board_id FROM deps d
  LEFT JOIN issues p ON p.id = d.depends_on_id
  WHERE d.issue_id = i.id AND d.dep_type = 'parent-child'
  ORDER BY d.created_at NULLS LAST, d.depends_on_id LIMIT 1
) par ON true`;

/**
 * Statuses `update-status` accepts, and what each does to the lifecycle stamps.
 * `closed_at` is cleared on reopen so a reopened issue stops sorting into the
 * Done column, and `started_at` is set only the first time — it records when
 * work began, not when it last resumed.
 */
const STATUS_VALUES = new Set(['open', 'in_progress', 'closed']);

/** Text fields `edit-text` can write, keyed by the client's field name. */
const TEXT_FIELDS = /** @type {Record<string, string>} */ ({
  title: 'title',
  description: 'description',
  acceptance: 'acceptance_criteria',
  notes: 'notes',
  design: 'design'
});

/**
 * `blocked_issues.blocked_by` (views.sql) recomputed with each blocker's board,
 * so `scopeIssueRefs` can drop blockers in a space the reader cannot see. Same
 * rows and order as the view: live blockers through `blocking_deps`.
 */
const BLOCKED_BY_WITH_BOARDS = `(
  SELECT jsonb_agg(jsonb_build_object(
    'id', b.id, 'title', b.title, 'status', b.status,
    'issue_type', b.issue_type, 'board_id', b.board_id
  ) ORDER BY b.id)
  FROM blocking_deps bd JOIN issues b ON b.id = bd.depends_on_id
  WHERE bd.issue_id = i.id AND b.status <> 'closed' AND b.deleted_at IS NULL
) AS blocked_by`;

/**
 * Accounts mode: the board → space map an issue's references are checked
 * against, or `null` when accounts mode is off (nothing is filtered).
 *
 * @returns {Promise<Map<string, string> | null>}
 */
async function refScope() {
  if (!accountsOnSync()) {
    return null;
  }
  try {
    return await boardSpaces();
  } catch {
    return new Map();
  }
}

/**
 * Drop an issue's references (dependencies, dependents, blockers, parent) into
 * another space, and strip the board ids the queries carried for the check. A
 * reader of `board_id` can read its space, so a reference in the same space is
 * one it may see; anything else — another space, an unregistered board, a ref
 * whose board is unknown — is left out, title and id alike. Dependency edges
 * cannot be drawn across spaces, but a board moved with `force` can leave some
 * behind. With accounts mode off (`scope === null`) only the board ids go.
 *
 * @param {Record<string, any>} row - A built issue row (mutated and returned).
 * @param {string} board_id - The board the row was read from.
 * @param {Map<string, string> | null} scope
 * @returns {Record<string, any>}
 */
function scopeIssueRefs(row, board_id, scope) {
  const home = scope ? scope.get(board_id) || '' : '';
  const visible = (/** @type {unknown} */ ref_board) => {
    if (scope === null) return true;
    const other = String(ref_board || '');
    if (other.length === 0) return false;
    if (other === board_id) return true;
    return home.length > 0 && scope.get(other) === home;
  };
  for (const key of REF_FIELDS) {
    const refs = row[key];
    if (!Array.isArray(refs)) continue;
    const kept = [];
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object') continue;
      const { board_id: ref_board, ...rest } = ref;
      if (visible(ref_board)) kept.push(rest);
    }
    row[key] = kept;
  }
  if ('parent_board_id' in row || 'parent' in row) {
    if (row.parent !== undefined && !visible(row.parent_board_id)) {
      delete row.parent;
    }
    delete row.parent_board_id;
  }
  return row;
}

/**
 * Build one issue row object from a query row.
 *
 * @param {Record<string, any>} row - A row from a list or detail query.
 * @param {string} [skip] - A query-only column to leave out.
 * @returns {Record<string, unknown>}
 */
function toIssueRow(row, skip = '') {
  return buildIssueRow(row, null, skip);
}

/**
 * Timestamp columns rendered as ISO strings (bd's wire shape) on every row.
 */
const TIMESTAMP_FIELDS = new Set([
  'created_at',
  'updated_at',
  'closed_at',
  'started_at',
  'lease_expires_at',
  'heartbeat_at',
  'deleted_at'
]);

/**
 * The three timestamps `normalizeIssueList` turns into epoch ms anyway. A list
 * row carries them as numbers straight from the `Date` node-postgres decoded,
 * instead of rendering an ISO string only for the next pass to `Date.parse` it
 * back — on a 1000-row closed column that round trip was most of the cost of a
 * refresh.
 */
const EPOCH_LIST_FIELDS = new Set(['created_at', 'updated_at', 'closed_at']);

/** Embedded issue-reference arrays normalized by `normalizeRefs`. */
const REF_FIELDS = new Set(['dependencies', 'dependents', 'blocked_by']);

/**
 * Build one issue row in a single pass: nulls dropped (bd's `omitempty`),
 * timestamps converted, embedded refs normalized.
 *
 * Built by copying rather than by spreading and then `delete`-ing: a `delete`
 * drops V8 into dictionary mode for the object, and every later pass over the
 * row (trim, normalize, `JSON.stringify` per connection) pays for it.
 *
 * @param {Record<string, any>} row - A row from a list or detail query.
 * @param {Set<string> | null} epoch_fields - Timestamp columns to emit as
 * epoch ms instead of ISO strings (`null` = none).
 * @param {string} [skip] - A query-only column to leave out (e.g. a sort key).
 * @returns {Record<string, unknown>}
 */
function buildIssueRow(row, epoch_fields, skip = '') {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value === null || value === undefined || key === skip) {
      continue;
    }
    if (TIMESTAMP_FIELDS.has(key)) {
      if (epoch_fields !== null && epoch_fields.has(key)) {
        const ms = value instanceof Date ? value.getTime() : epochOrNull(value);
        if (ms !== null && Number.isFinite(ms)) {
          out[key] = ms;
        }
        continue;
      }
      const iso = isoOrNull(value);
      if (iso !== null) {
        out[key] = iso;
      }
      continue;
    }
    out[key] = REF_FIELDS.has(key) ? normalizeRefs(value) : value;
  }
  return out;
}

/**
 * A list row: `toIssueRow` with created/updated/closed already in epoch ms
 * (see `EPOCH_LIST_FIELDS`). `normalizeIssueList` accepts either spelling, so
 * the wire shape the client sees is unchanged.
 *
 * @param {Record<string, any>} row
 * @param {string} [skip] - A query-only column to leave out.
 * @returns {Record<string, unknown>}
 */
function toListRow(row, skip = '') {
  return buildIssueRow(row, EPOCH_LIST_FIELDS, skip);
}

/**
 * Create a store bound to one DSN.
 *
 * Exported (rather than only reachable through the module singleton) so a test
 * can point at a throwaway database without touching `process.env`.
 *
 * @param {Object} options - How to connect, and how much to hold open.
 * @param {string} options.dsn - Postgres connection string.
 * @param {number} [options.max] - Pool size.
 * @param {boolean} [options.listen] - Whether to hold a `LISTEN` connection.
 * Defaults to `true`; a test that only reads can skip the extra socket.
 * @returns {PgStore}
 */
export function createPgStore(options) {
  const dsn = String(options.dsn || '');
  if (dsn.length === 0) {
    throw new PgStoreError('bad_request', 'createPgStore requires a dsn');
  }
  const pool = new pg.Pool({ connectionString: dsn, max: options.max ?? 8 });
  pool.on('error', (err) => {
    // An idle client dying is normal (a server restart, a network blip); the
    // pool replaces it. Swallowing it here is what keeps it from reaching
    // `unhandledRejection` and taking the daemon down.
    log('idle pool client error: %o', err);
  });

  /** @type {Set<(event: PgEvent) => void>} */
  const listeners = new Set();
  /** @type {import('pg').Client | null} */
  let listen_client = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnect_timer = null;
  let closed = false;
  /** @type {Set<string> | null} */
  let board_ids = null;

  /**
   * Hold `LISTEN feads_events` on a dedicated connection, reconnecting for as
   * long as the store is open. A pooled client cannot be used: it is returned
   * to the pool after each query and the subscription goes with it.
   *
   * @returns {Promise<void>}
   */
  async function connectListener() {
    if (closed) {
      return;
    }
    const client = new pg.Client({ connectionString: dsn });
    client.on('error', (err) => {
      log('listen connection error: %o', err);
      scheduleReconnect(client);
    });
    client.on('end', () => {
      scheduleReconnect(client);
    });
    client.on('notification', (msg) => {
      if (msg.channel !== PG_CHANNEL) {
        return;
      }
      const event = parsePgEvent(msg.payload);
      if (!event) {
        return;
      }
      for (const fn of listeners) {
        try {
          fn(event);
        } catch (err) {
          log('pg event listener failed: %o', err);
        }
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${PG_CHANNEL}`);
      listen_client = client;
      log('listening on %s', PG_CHANNEL);
    } catch (err) {
      log('listen connect failed: %o', err);
      scheduleReconnect(client);
    }
  }

  /**
   * @param {import('pg').Client} client - The connection that failed.
   * @returns {void}
   */
  function scheduleReconnect(client) {
    if (closed || reconnect_timer) {
      return;
    }
    if (listen_client === client) {
      listen_client = null;
    }
    try {
      void client.end().catch(() => {});
    } catch {
      // already gone
    }
    reconnect_timer = setTimeout(() => {
      reconnect_timer = null;
      void connectListener();
    }, 1000);
    reconnect_timer.unref?.();
  }

  if (options.listen !== false) {
    void connectListener();
  }

  /**
   * Run one query on a pooled connection.
   *
   * @param {string} text - SQL.
   * @param {unknown[]} [values] - Bind parameters.
   * @returns {Promise<import('pg').QueryResult<any>>}
   */
  async function query(text, values = []) {
    return pool.query(text, values);
  }

  /**
   * Run `fn` inside a transaction on one connection.
   *
   * @template T
   * @param {(client: import('pg').PoolClient) => Promise<T>} fn - Work to run.
   * @returns {Promise<T>}
   */
  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // the connection is already unusable; the pool will discard it
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Append the audit row and fire the notification, inside the caller's
   * transaction so a rolled-back write announces nothing.
   *
   * @param {import('pg').PoolClient} client - The transaction's connection.
   * @param {Object} event - What happened.
   * @param {string} event.board_id - Board the write landed on.
   * @param {string} event.issue_id - Issue the write touched.
   * @param {string} event.kind - One of created|updated|status|comment|
   * dep_added|dep_removed|label|deleted.
   * @param {string} [event.actor] - Who acted, when known.
   * @param {Record<string, unknown>} [event.payload] - Extra context.
   * @returns {Promise<void>}
   */
  async function emitEvent(client, event) {
    await client.query(
      `INSERT INTO events (board_id, issue_id, actor, kind, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event.board_id,
        event.issue_id,
        event.actor || null,
        event.kind,
        JSON.stringify(event.payload || {})
      ]
    );
    await client.query('SELECT pg_notify($1, $2)', [
      PG_CHANNEL,
      `${event.board_id}:${event.issue_id}:${event.kind}`
    ]);
  }

  /**
   * Every board id the database knows, cached after the first read.
   *
   * Cached because it is asked on every read and boards are created about once
   * a month; `refreshBoards()` exists for the case that matters (a board created
   * while the daemon is up), and an unknown id refreshes once before failing.
   *
   * @returns {Promise<Set<string>>}
   */
  async function loadBoards() {
    if (board_ids) {
      return board_ids;
    }
    const res = await query('SELECT id FROM boards');
    board_ids = new Set(res.rows.map((r) => String(r.id)));
    return board_ids;
  }

  /**
   * Resolve a `.beads` directory to a board id this database knows.
   *
   * @param {string | null | undefined} board_dir - The connection's board.
   * @returns {Promise<string>}
   */
  async function resolveBoardId(board_dir) {
    const id = boardIdForDir(board_dir);
    if (id.length === 0) {
      throw new PgStoreError(
        'unknown_board',
        'no board directory on this connection — select a board first'
      );
    }
    let known = await loadBoards();
    if (!known.has(id)) {
      board_ids = null;
      known = await loadBoards();
    }
    if (!known.has(id)) {
      throw new PgStoreError(
        'unknown_board',
        `board "${id}" (from ${board_dir}) is not in the Postgres store`,
        { board_id: id, board_dir: String(board_dir || '') }
      );
    }
    return id;
  }

  /**
   * The issue-id prefix a board mints with (`example` → `ex`).
   *
   * @param {string} board_id - Board id.
   * @returns {Promise<string>}
   */
  async function prefixFor(board_id) {
    const res = await query('SELECT prefix FROM boards WHERE id = $1', [
      board_id
    ]);
    const prefix = res.rows[0] && String(res.rows[0].prefix || '');
    if (!prefix) {
      throw new PgStoreError(
        'unknown_board',
        `board "${board_id}" has no prefix`
      );
    }
    return prefix;
  }

  /**
   * Read the append-only cross-board change feed and hydrate each touched issue.
   *
   * The event sequence is the cursor rather than `updated_at`: several writes can
   * share a timestamp, and a timestamp cursor would either skip or repeat rows.
   * A page may contain more than one event for an issue; those events are grouped
   * under one current issue snapshot so consumers do not need to reconcile partial
   * rows themselves.
   *
   * @param {{ after_cursor?: string | null, since?: string | null,
   *   until?: string | null, boards?: string[], limit?: number }} options
   * @returns {Promise<{changes: Array<Record<string, unknown>>, next_cursor: string | null,
   *   complete: boolean, unavailable_boards: string[]} >}
   */
  async function fetchChanges(options = {}) {
    const requested_boards = [
      ...new Set(
        (options.boards || []).map((id) => String(id).trim()).filter(Boolean)
      )
    ];
    const unavailable_boards = [];
    let board_ids_for_query = requested_boards;
    if (requested_boards.length > 0) {
      const known = await query(
        'SELECT id FROM boards WHERE id = ANY($1::text[])',
        [requested_boards]
      );
      const known_ids = new Set(known.rows.map((row) => String(row.id)));
      board_ids_for_query = requested_boards.filter((id) => known_ids.has(id));
      unavailable_boards.push(
        ...requested_boards.filter((id) => !known_ids.has(id))
      );
      if (board_ids_for_query.length === 0) {
        return {
          changes: [],
          next_cursor: null,
          complete: false,
          unavailable_boards
        };
      }
    }

    const args = /** @type {unknown[]} */ ([]);
    const where = [];
    /** @param {unknown} value */
    const arg = (value) => {
      args.push(value);
      return `$${args.length}`;
    };
    if (board_ids_for_query.length > 0) {
      where.push(`e.board_id = ANY(${arg(board_ids_for_query)}::text[])`);
    }
    const after = Number.parseInt(String(options.after_cursor || '0'), 10);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new PgStoreError(
        'bad_request',
        'after_cursor must be an event sequence cursor'
      );
    }
    where.push(`e.seq > ${arg(after)}`);
    if (options.since) where.push(`e.at >= ${arg(options.since)}::timestamptz`);
    if (options.until) where.push(`e.at <= ${arg(options.until)}::timestamptz`);

    const limit = Math.min(500, Math.max(1, Number(options.limit) || 100));
    const event_result = await query(
      `WITH latest_events AS (
         SELECT DISTINCT ON (e.board_id, e.issue_id)
                e.seq, e.board_id, e.issue_id, e.actor, e.kind, e.payload, e.at
           FROM events e
          WHERE ${where.join(' AND ')} AND e.issue_id IS NOT NULL
          ORDER BY e.board_id, e.issue_id, e.seq DESC
       )
       SELECT seq, board_id, issue_id, actor, kind, payload, at
         FROM latest_events
        ORDER BY seq ASC
        LIMIT ${limit + 1}`,
      args
    );
    const truncated = event_result.rows.length > limit;
    const event_rows = truncated
      ? event_result.rows.slice(0, limit)
      : event_result.rows;
    const issue_keys = [
      ...new Set(
        event_rows
          .filter((row) => row.issue_id)
          .map((row) => `${row.board_id}:${row.issue_id}`)
      )
    ];
    const issue_ids = issue_keys.map((key) => key.slice(key.indexOf(':') + 1));
    const board_ids = issue_keys.map((key) => key.slice(0, key.indexOf(':')));
    const snapshots = new Map();
    if (issue_ids.length > 0) {
      const snapshot_result = await query(
        `SELECT i.id, i.board_id, i.title, i.description, i.design,
                i.acceptance_criteria, i.notes, i.close_reason, i.status,
                i.issue_type, i.priority, i.assignee, i.owner, i.created_by,
                i.external_ref, i.metadata, i.created_at, i.updated_at,
                i.closed_at, i.started_at, i.deleted_at, i.lease_expires_at,
                i.heartbeat_at,
                COALESCE(lab.labels, ARRAY[]::text[]) AS labels,
                COALESCE(dep.dependencies, '[]'::jsonb) AS dependencies,
                COALESCE(dpt.dependents, '[]'::jsonb) AS dependents,
                COALESCE(cmt.comments, '[]'::jsonb) AS comments
           FROM issues i
           LEFT JOIN LATERAL (
             SELECT array_agg(l.label ORDER BY l.label) AS labels
               FROM labels l WHERE l.issue_id = i.id
           ) lab ON true
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
               'issue_id', d.issue_id, 'depends_on_id', d.depends_on_id,
               'type', d.dep_type, 'created_at', d.created_at,
               'created_by', d.created_by, 'metadata', d.metadata
             ) ORDER BY d.depends_on_id, d.dep_type) AS dependencies
               FROM deps d WHERE d.issue_id = i.id
           ) dep ON true
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
               'issue_id', d.issue_id, 'depends_on_id', d.depends_on_id,
               'type', d.dep_type, 'created_at', d.created_at,
               'created_by', d.created_by, 'metadata', d.metadata
             ) ORDER BY d.issue_id, d.dep_type) AS dependents
               FROM deps d WHERE d.depends_on_id = i.id
           ) dpt ON true
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
               'id', c.id, 'issue_id', c.issue_id, 'author', c.author,
               'body', c.body, 'created_at', c.created_at
             ) ORDER BY c.created_at, c.id) AS comments
               FROM comments c WHERE c.issue_id = i.id
           ) cmt ON true
          WHERE i.id = ANY($1::text[]) AND i.board_id = ANY($2::text[])`,
        [issue_ids, board_ids]
      );
      for (const row of snapshot_result.rows) {
        const out = { ...row };
        for (const field of [
          'created_at',
          'updated_at',
          'closed_at',
          'started_at',
          'deleted_at',
          'lease_expires_at',
          'heartbeat_at'
        ]) {
          out[field] = isoOrNull(out[field]);
        }
        snapshots.set(`${row.board_id}:${row.id}`, out);
      }
    }

    const grouped = new Map();
    for (const row of event_rows) {
      const key = `${row.board_id}:${row.issue_id}`;
      if (!row.issue_id || !snapshots.has(key)) continue;
      let change = grouped.get(key);
      if (!change) {
        change = { ...snapshots.get(key), events: [] };
        grouped.set(key, change);
      }
      change.events.push({
        seq: String(row.seq),
        board_id: row.board_id,
        issue_id: row.issue_id,
        actor: row.actor,
        kind: row.kind,
        payload: row.payload || {},
        at: isoOrNull(row.at)
      });
    }
    const changes = [...grouped.values()];
    const last = event_rows[event_rows.length - 1];
    return {
      changes,
      next_cursor: last ? String(last.seq) : null,
      complete: !truncated && unavailable_boards.length === 0,
      unavailable_boards
    };
  }

  /**
   * Rows for one list subscription.
   *
   * @param {string} board_id - Board to read.
   * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
   *   - The subscription.
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function fetchList(board_id, spec) {
    return fetchListRows(board_id, spec, toIssueRow);
  }

  /**
   * `fetchList` for the dashboard's own list pipeline: identical rows, except
   * `created_at` / `updated_at` / `closed_at` arrive as epoch ms (what
   * `normalizeIssueList` makes of them anyway) instead of ISO strings. The
   * public `fetchList` keeps bd's wire shape; this is the hot path.
   *
   * @param {string} board_id - Board to read.
   * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function fetchListItems(board_id, spec) {
    return fetchListRows(board_id, spec, toListRow);
  }

  /**
   * @param {string} board_id
   * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
   * @param {(row: Record<string, any>, skip?: string) => Record<string, unknown>} toRow
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function fetchListRows(board_id, spec, toRow) {
    const type = String(spec.type);
    switch (type) {
      case 'all-issues':
        return listQuery(
          board_id,
          `SELECT * FROM issues
             WHERE board_id = $1 AND deleted_at IS NULL AND status <> 'closed'`,
          '',
          [],
          toRow
        );
      case 'ready-issues':
        return listQuery(
          board_id,
          `SELECT * FROM ready_issues WHERE board_id = $1
             ORDER BY priority, created_at LIMIT 1000`,
          '',
          [],
          toRow
        );
      case 'in-progress-issues':
        return listQuery(
          board_id,
          `SELECT * FROM issues
             WHERE board_id = $1 AND deleted_at IS NULL
               AND status = 'in_progress'`,
          '',
          [],
          toRow
        );
      case 'closed-issues': {
        // Capped at the newest 1000, matching `bd list --status closed
        // --limit 1000`: the column is a recency view, not an archive.
        //
        // `params.since` (epoch ms) is the Board tab's window. The ws layer
        // applies it after the fetch too (`applyClosedIssuesFilter`), so this
        // only moves the cut into SQL: a week of closures instead of the
        // newest thousand read, decoded and diffed on every refresh.
        const since = Number((spec.params || {}).since);
        if (Number.isFinite(since) && since > 0) {
          return listQuery(
            board_id,
            `SELECT * FROM issues
               WHERE board_id = $1 AND deleted_at IS NULL AND status = 'closed'
                 AND closed_at >= $2
               ORDER BY closed_at DESC NULLS LAST, updated_at DESC LIMIT 1000`,
            '',
            [new Date(since)],
            toRow
          );
        }
        return listQuery(
          board_id,
          `SELECT * FROM issues
             WHERE board_id = $1 AND deleted_at IS NULL AND status = 'closed'
             ORDER BY closed_at DESC NULLS LAST, updated_at DESC LIMIT 1000`,
          '',
          [],
          toRow
        );
      }
      case 'blocked-issues':
        return listQuery(
          board_id,
          `SELECT * FROM blocked_issues WHERE board_id = $1`,
          `,\n  i.blocked_by_count::int AS blocked_by_count,\n  ${BLOCKED_BY_WITH_BOARDS}`,
          [],
          toRow
        );
      case 'epics':
        return fetchEpics(board_id, toRow);
      case 'issue-detail': {
        const id = String((spec.params || {}).id || '').trim();
        if (id.length === 0) {
          throw new PgStoreError('bad_request', 'Missing param: params.id');
        }
        const issue = await fetchDetail(board_id, id);
        return issue ? [issue] : [];
      }
      default:
        throw new PgStoreError(
          'bad_request',
          `Unknown subscription type: ${type}`
        );
    }
  }

  /**
   * Run one of the list shapes over a base relation.
   *
   * @param {string} board_id - Board to read.
   * @param {string} base - A `SELECT` yielding issue columns, bound to `$1`.
   * @param {string} [extra_columns] - Extra select-list entries for the base.
   * @param {unknown[]} [extra_params] - Values for `$2…` in `base`.
   * @param {(row: Record<string, any>) => Record<string, unknown>} [toRow]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function listQuery(
    board_id,
    base,
    extra_columns = '',
    extra_params = [],
    toRow = toIssueRow
  ) {
    const sql = `SELECT ${LIST_COLUMNS},${ISSUE_AGGREGATES}${extra_columns}
FROM (${base}) i
${ISSUE_AGGREGATE_JOINS}`;
    const res = await query(sql, [board_id, ...extra_params]);
    const scope = await refScope();
    return res.rows.map((row) => scopeIssueRefs(toRow(row), board_id, scope));
  }

  /**
   * The Epics tab: open epics with their child counters, then closed epics.
   *
   * The two halves are different questions and bd answered them with two
   * commands — `epic status` only walks open epics, because close-eligibility is
   * the thing it computes. Finished work still has to be findable, so closed
   * epics are merged in without counters (the client derives what it needs from
   * the detail subscription's dependents when you expand one) and never
   * close-eligible.
   *
   * @param {string} board_id - Board to read.
   * @param {(row: Record<string, any>, skip?: string) => Record<string, unknown>} [toRow]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function fetchEpics(board_id, toRow = toIssueRow) {
    const res = await query(
      `SELECT 0 AS ord, e.id, e.title, e.status, e.issue_type,
              e.assignee, e.created_at, e.updated_at, e.closed_at,
              e.total_children::int   AS total_children,
              e.closed_children::int  AS closed_children,
              e.eligible_for_close
         FROM epic_status e WHERE e.board_id = $1
       UNION ALL
       SELECT 1 AS ord, i.id, i.title, i.status, i.issue_type,
              i.assignee, i.created_at, i.updated_at, i.closed_at,
              NULL::int, NULL::int, false
         FROM issues i
        WHERE i.board_id = $1 AND i.issue_type = 'epic'
          AND i.status = 'closed' AND i.deleted_at IS NULL
       ORDER BY ord, created_at`,
      [board_id]
    );
    return res.rows.map((row) => {
      const out = toRow(row, 'ord');
      // `false` must survive the null-drop — it is the answer, not a missing one.
      out.eligible_for_close = row.eligible_for_close === true;
      return out;
    });
  }

  /**
   * One issue with everything the detail modal renders.
   *
   * @param {string} board_id - Board to read.
   * @param {string} id - The issue to act on.
   * @param {{ include_dependents?: boolean }} [detail_options] - `false` matches
   * `bd show --json` without `--include-dependents`, which is what the mutation
   * handlers replied with.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function fetchDetail(board_id, id, detail_options = {}) {
    const include_dependents = detail_options.include_dependents !== false;
    const dependents_column = include_dependents
      ? `,\n  COALESCE(dpt.refs, '[]'::jsonb) AS dependents`
      : '';
    const dependents_join = include_dependents
      ? `
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
    'id', s.id, 'title', s.title, 'status', s.status,
    'priority', s.priority, 'issue_type', s.issue_type,
    'assignee', s.assignee, 'created_at', s.created_at,
    'updated_at', s.updated_at, 'closed_at', s.closed_at,
    'dependency_type', d.dep_type, 'board_id', s.board_id
  ) ORDER BY s.id) AS refs
  FROM deps d JOIN issues s ON s.id = d.issue_id
  WHERE d.depends_on_id = i.id AND s.deleted_at IS NULL
) dpt ON true`
      : '';
    const sql = `SELECT ${LIST_COLUMNS},${DETAIL_COLUMNS},${ISSUE_AGGREGATES}${dependents_column}
FROM (
  SELECT * FROM issues
   WHERE board_id = $1 AND id = $2 AND deleted_at IS NULL
) i
${ISSUE_AGGREGATE_JOINS}${dependents_join}`;
    const res = await query(sql, [board_id, id]);
    if (res.rows.length === 0) {
      return null;
    }
    return scopeIssueRefs(toIssueRow(res.rows[0]), board_id, await refScope());
  }

  /**
   * Every issue on a board in the shape `bd export` produced, as objects rather
   * than JSONL — a superset of what `parseExportLines` (the story recorder) and
   * `parseExportForNotifications` (the inbox differ) each pull out, so both can
   * be fed without either of them changing.
   *
   * Tombstoned rows are included and flagged, because both consumers use
   * "disappeared" as a signal and would otherwise read a tombstone as an issue
   * that was never there.
   *
   * @param {string} board_id - Board to read.
   * @param {{ ids?: string[], with_artifacts?: boolean, with_last_actor?: boolean }} [export_options]
   * `ids` makes it a partial export (see below), which always carries
   * `metadata` (artifact entries only) and `last_actor` for the notification
   * engine. A full export includes each only on request: the story recorder
   * needs neither, and the last actor is an index probe per row.
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async function exportIssues(board_id, export_options = {}) {
    const ids = Array.isArray(export_options.ids)
      ? export_options.ids.map(String).filter((id) => id.length > 0)
      : null;
    // A partial export (the notification engine's incremental scan) reads the
    // named issues plus everything the diff needs around them: issues that
    // were waiting on one of them (a closed blocker notifies its dependents'
    // owners) and their parent epics (new work under an epic notifies its
    // owners). Reading a few extra issues is always safe — each is diffed
    // against its own cursor exactly as a full scan would.
    // Artifacts are cheap (only rows with the marker pay); the last actor is
    // an index probe per row, so a full export opts in to each explicitly.
    const with_artifacts =
      ids !== null || export_options.with_artifacts === true;
    const with_last_actor =
      ids !== null || export_options.with_last_actor === true;
    const where =
      ids === null
        ? 'WHERE i.board_id = $1'
        : `WHERE i.board_id = $1 AND (
             i.id = ANY($2::text[])
             OR i.id IN (SELECT d.issue_id FROM deps d
                          WHERE d.depends_on_id = ANY($2::text[])
                            AND d.dep_type IN ('blocks', 'conditional-blocks', 'waits-for'))
             OR i.id IN (SELECT d.depends_on_id FROM deps d
                          WHERE d.issue_id = ANY($2::text[])
                            AND d.dep_type = 'parent-child'))`;
    const res = await query(
      `SELECT i.id, i.title, i.status, i.issue_type, i.assignee, i.created_by,
              i.updated_at, i.deleted_at,
              -- Only bodies that can mention anyone: all the inbox diff needs.
              CASE WHEN strpos(i.description, '@') > 0
                   THEN i.description ELSE '' END AS description,
              COALESCE(dep.deps, '[]'::jsonb)  AS dependencies,
              COALESCE(cmt.rows, '[]'::jsonb)  AS comments${
                with_artifacts ? ',\n              art.artifacts' : ''
              }${with_last_actor ? ',\n              ev.actor AS last_actor' : ''}
         FROM issues i
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'depends_on_id', d.depends_on_id, 'type', d.dep_type
           ) ORDER BY d.depends_on_id, d.dep_type) AS deps
           FROM deps d WHERE d.issue_id = i.id
         ) dep ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'author', c.author, 'text', c.body, 'created_at', c.created_at
           ) ORDER BY c.created_at, c.id) AS rows
           FROM comments c WHERE c.issue_id = i.id
         ) cmt ON true
         ${
           with_artifacts
             ? `LEFT JOIN LATERAL (
           SELECT jsonb_object_agg(m.key, m.value) AS artifacts
             FROM jsonb_each(i.metadata) m
            WHERE i.metadata ? 'has_artifacts' AND m.key LIKE 'artifact:%'
         ) art ON true`
             : ''
         }
         ${
           with_last_actor
             ? `LEFT JOIN LATERAL (
           SELECT e.actor FROM events e
            WHERE e.board_id = i.board_id AND e.issue_id = i.id
              AND e.kind <> 'comment'
            ORDER BY e.seq DESC LIMIT 1
         ) ev ON true`
             : ''
         }
        ${where}`,
      ids === null ? [board_id] : [board_id, ids]
    );
    return res.rows.map((row) => ({
      id: String(row.id),
      title: String(row.title || ''),
      status: String(row.status || 'open'),
      issue_type: String(row.issue_type || 'task'),
      assignee: String(row.assignee || ''),
      created_by: String(row.created_by || ''),
      updated_at: isoOrNull(row.updated_at) || '',
      deleted: row.deleted_at !== null && row.deleted_at !== undefined,
      comments: Array.isArray(row.comments)
        ? row.comments.map((/** @type {any} */ c) => ({
            author: String(c?.author || ''),
            text: String(c?.text || ''),
            created_at: String(c?.created_at || '')
          }))
        : [],
      dependencies: Array.isArray(row.dependencies)
        ? row.dependencies.map((/** @type {any} */ d) => ({
            depends_on_id: String(d?.depends_on_id || ''),
            type: String(d?.type || '')
          }))
        : [],
      // Only set when it can hold an @mention (see the SELECT); '' otherwise.
      description: String(row.description || ''),
      // Raw `artifact:*` metadata entries; the notification module parses
      // them with the same code the artifact tools use.
      ...(with_artifacts
        ? {
            metadata:
              row.artifacts && typeof row.artifacts === 'object'
                ? row.artifacts
                : {}
          }
        : {}),
      ...(with_last_actor ? { last_actor: String(row.last_actor || '') } : {})
    }));
  }

  /**
   * Every live (not closed, not deleted) issue on any board that holds
   * artifacts — the universe a new claim or declaration is checked against
   * for overlap. Proportional to beads that ever had artifacts (the
   * `has_artifacts` marker, partial-indexed), not to the store.
   *
   * @returns {Promise<Array<{ issue_id: string, board_id: string, title: string, status: string, holder: string, metadata: Record<string, unknown> }>>}
   */
  async function liveArtifactHolders() {
    const res = await query(
      `SELECT i.id, i.board_id, i.title, i.status, i.assignee, i.created_by,
              (SELECT jsonb_object_agg(m.key, m.value)
                 FROM jsonb_each(i.metadata) m
                WHERE m.key LIKE 'artifact:%') AS artifacts
         FROM issues i
        WHERE i.metadata ? 'has_artifacts'
          AND i.deleted_at IS NULL AND i.status <> 'closed'`
    );
    return res.rows.map((row) => ({
      issue_id: String(row.id),
      board_id: String(row.board_id),
      title: String(row.title || ''),
      status: String(row.status || 'open'),
      holder: String(row.assignee || row.created_by || ''),
      metadata:
        row.artifacts && typeof row.artifacts === 'object' ? row.artifacts : {}
    }));
  }

  /**
   * A comment list in the shape the dashboard reads (`text`, not the column's
   * `body` — the client has only ever read `.text`).
   *
   * @param {string} board_id - Board to read.
   * @param {string} issue_id - Issue whose comments to list.
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function listComments(board_id, issue_id) {
    const res = await query(
      `SELECT c.id, c.issue_id, c.author, c.body, c.created_at
         FROM comments c JOIN issues i ON i.id = c.issue_id
        WHERE i.board_id = $1 AND c.issue_id = $2
        ORDER BY c.created_at, c.id`,
      [board_id, issue_id]
    );
    return res.rows.map((row) => ({
      id: String(row.id),
      issue_id: String(row.issue_id),
      author: String(row.author || ''),
      text: String(row.body || ''),
      created_at: isoOrNull(row.created_at)
    }));
  }

  /**
   * Assert an issue exists on this board (and is not tombstoned), so a write to
   * a stale id fails with `not_found` rather than silently touching no rows.
   *
   * @param {import('pg').PoolClient} client - The transaction's connection.
   * @param {string} board_id - Board the write is scoped to.
   * @param {string} id - The issue to act on.
   * @returns {Promise<void>}
   */
  async function assertIssue(client, board_id, id) {
    const res = await client.query(
      `SELECT 1 FROM issues
        WHERE id = $1 AND board_id = $2 AND deleted_at IS NULL`,
      [id, board_id]
    );
    if (res.rowCount === 0) {
      throw new PgStoreError(
        'not_found',
        `no issue ${id} on board ${board_id}`
      );
    }
  }

  /**
   * The reply every mutation handler sends: the issue as it now stands.
   *
   * @param {string} board_id - Board to read.
   * @param {string} id - The issue to act on.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  function showIssue(board_id, id) {
    return fetchDetail(board_id, id);
  }

  /**
   * @param {string} board_id - Board to write.
   * @param {string} id - The issue to act on.
   * @param {string} status - `open` | `in_progress` | `closed`.
   * @param {{ actor?: string }} [write_options] - Who is acting.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function updateStatus(board_id, id, status, write_options = {}) {
    if (!STATUS_VALUES.has(status)) {
      throw new PgStoreError('bad_request', `unsupported status: ${status}`);
    }
    await withTx(async (client) => {
      await assertIssue(client, board_id, id);
      await client.query(
        `UPDATE issues SET
           status = $3,
           updated_at = now(),
           closed_at = CASE WHEN $3 = 'closed' THEN COALESCE(closed_at, now())
                            ELSE NULL END,
           started_at = CASE WHEN $3 = 'in_progress'
                             THEN COALESCE(started_at, now())
                             ELSE started_at END
         WHERE id = $1 AND board_id = $2`,
        [id, board_id, status]
      );
      await emitEvent(client, {
        board_id,
        issue_id: id,
        kind: 'status',
        actor: write_options.actor,
        payload: { status }
      });
    });
    return showIssue(board_id, id);
  }

  /**
   * @param {string} board_id - Board to write.
   * @param {string} id - The issue to act on.
   * @param {string} field - Client field name (`title`, `acceptance`, …).
   * @param {string} value - New text.
   * @param {{ actor?: string }} [write_options] - Who is acting.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function editText(board_id, id, field, value, write_options = {}) {
    const column = TEXT_FIELDS[field];
    if (!column) {
      throw new PgStoreError('bad_request', `unsupported field: ${field}`);
    }
    await withTx(async (client) => {
      await assertIssue(client, board_id, id);
      // The column name comes from TEXT_FIELDS, never from the payload, so the
      // interpolation cannot carry anything the client chose.
      await client.query(
        `UPDATE issues SET ${column} = $3, updated_at = now()
          WHERE id = $1 AND board_id = $2`,
        [id, board_id, value]
      );
      await emitEvent(client, {
        board_id,
        issue_id: id,
        kind: 'updated',
        actor: write_options.actor,
        payload: { field }
      });
    });
    return showIssue(board_id, id);
  }

  /**
   * @param {string} board_id - Board to write.
   * @param {string} id - The issue to act on.
   * @param {number} priority - 0..4.
   * @param {{ actor?: string }} [write_options] - Who is acting.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function updatePriority(board_id, id, priority, write_options = {}) {
    await withTx(async (client) => {
      await assertIssue(client, board_id, id);
      await client.query(
        `UPDATE issues SET priority = $3, updated_at = now()
          WHERE id = $1 AND board_id = $2`,
        [id, board_id, priority]
      );
      await emitEvent(client, {
        board_id,
        issue_id: id,
        kind: 'updated',
        actor: write_options.actor,
        payload: { priority }
      });
    });
    return showIssue(board_id, id);
  }

  /**
   * @param {string} board_id - Board to write.
   * @param {string} id - The issue to act on.
   * @param {string} assignee - New assignee, `''` to clear.
   * @param {{ actor?: string }} [write_options] - Who is acting.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function updateAssignee(board_id, id, assignee, write_options = {}) {
    await withTx(async (client) => {
      await assertIssue(client, board_id, id);
      await client.query(
        `UPDATE issues SET assignee = $3, updated_at = now()
          WHERE id = $1 AND board_id = $2`,
        [id, board_id, assignee.length > 0 ? assignee : null]
      );
      await emitEvent(client, {
        board_id,
        issue_id: id,
        kind: 'updated',
        actor: write_options.actor,
        payload: { assignee }
      });
    });
    return showIssue(board_id, id);
  }

  /**
   * Mint a new issue id: `<prefix>-<3 chars base36>`, the shape bd used
   * (`ex-6zr`, `feads-3bb`). Three characters is 46 656 ids per board, which is
   * why this is a collision-checked retry rather than a bare insert.
   *
   * @param {string} prefix - Board prefix.
   * @returns {string}
   */
  function mintId(prefix) {
    const bytes = crypto.randomBytes(4).readUInt32BE(0);
    const suffix = (bytes % 46656).toString(36).padStart(3, '0');
    return `${prefix}-${suffix}`;
  }

  /**
   * @param {string} board_id - Board to write.
   * @param {Object} fields - New issue.
   * @param {string} fields.title - One-line summary of the work.
   * @param {string} [fields.issue_type] - bug|feature|task|epic|chore.
   * @param {number} [fields.priority] - 0..4.
   * @param {string} [fields.description] - Body prose, when there is any.
   * @param {string} [fields.actor] - Who is filing, recorded as `created_by`.
   * @returns {Promise<{ id: string }>}
   */
  async function createIssue(board_id, fields) {
    const prefix = await prefixFor(board_id);
    return withTx(async (client) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const id = mintId(prefix);
        const res = await client.query(
          `INSERT INTO issues
             (id, board_id, title, description, status, issue_type, priority,
              created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, now(), now())
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            id,
            board_id,
            fields.title,
            fields.description || null,
            fields.issue_type || 'task',
            typeof fields.priority === 'number' ? fields.priority : 2,
            fields.actor || null
          ]
        );
        if (res.rowCount === 1) {
          await emitEvent(client, {
            board_id,
            issue_id: id,
            kind: 'created',
            actor: fields.actor,
            payload: { title: fields.title }
          });
          return { id };
        }
      }
      throw new PgStoreError(
        'pg_error',
        `could not mint a free id for board ${board_id} after 12 attempts`
      );
    });
  }

  /**
   * Draw a dependency edge: `a` depends on `b`.
   *
   * @param {string} board_id - Board to write.
   * @param {string} a - The dependent issue.
   * @param {string} b - The issue it depends on.
   * @param {{ actor?: string, dep_type?: string }} [write_options] - Who is
   * acting, and which edge kind (`blocks` by default, as `bd dep add`).
   * @returns {Promise<void>}
   */
  async function depAdd(board_id, a, b, write_options = {}) {
    const dep_type = write_options.dep_type || 'blocks';
    await withTx(async (client) => {
      await assertIssue(client, board_id, a);
      await client.query(
        `INSERT INTO deps (issue_id, depends_on_id, dep_type, created_at, created_by)
         VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (issue_id, depends_on_id, dep_type) DO NOTHING`,
        [a, b, dep_type, write_options.actor || null]
      );
      await client.query(
        `UPDATE issues SET updated_at = now() WHERE id = ANY($1::text[])`,
        [[a, b]]
      );
      await emitEvent(client, {
        board_id,
        issue_id: a,
        kind: 'dep_added',
        actor: write_options.actor,
        payload: { depends_on_id: b, dep_type }
      });
    });
  }

  /**
   * Drop every edge from `a` to `b`, whatever its kind — `bd dep remove a b`
   * takes no type either, and a UI that removed only the `blocks` edge would
   * leave a `parent-child` one behind that the same button had just displayed.
   *
   * @param {string} board_id - Board to write.
   * @param {string} a - The dependent issue.
   * @param {string} b - The issue it depended on.
   * @param {{ actor?: string }} [write_options] - Who is acting.
   * @returns {Promise<void>}
   */
  async function depRemove(board_id, a, b, write_options = {}) {
    await withTx(async (client) => {
      await assertIssue(client, board_id, a);
      await client.query(
        'DELETE FROM deps WHERE issue_id = $1 AND depends_on_id = $2',
        [a, b]
      );
      await client.query(
        `UPDATE issues SET updated_at = now() WHERE id = ANY($1::text[])`,
        [[a, b]]
      );
      await emitEvent(client, {
        board_id,
        issue_id: a,
        kind: 'dep_removed',
        actor: write_options.actor,
        payload: { depends_on_id: b }
      });
    });
  }

  /**
   * @param {string} board_id - Board to write.
   * @param {string} id - The issue to act on.
   * @param {string} label - Label to add.
   * @param {{ actor?: string }} [write_options] - Who is acting.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function labelAdd(board_id, id, label, write_options = {}) {
    await withTx(async (client) => {
      await assertIssue(client, board_id, id);
      await client.query(
        `INSERT INTO labels (issue_id, label) VALUES ($1, $2)
         ON CONFLICT (issue_id, label) DO NOTHING`,
        [id, label]
      );
      await client.query('UPDATE issues SET updated_at = now() WHERE id = $1', [
        id
      ]);
      await emitEvent(client, {
        board_id,
        issue_id: id,
        kind: 'label',
        actor: write_options.actor,
        payload: { added: label }
      });
    });
    return showIssue(board_id, id);
  }

  /**
   * @param {string} board_id - Board to write.
   * @param {string} id - The issue to act on.
   * @param {string} label - Label to remove.
   * @param {{ actor?: string }} [write_options] - Who is acting.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function labelRemove(board_id, id, label, write_options = {}) {
    await withTx(async (client) => {
      await assertIssue(client, board_id, id);
      await client.query(
        'DELETE FROM labels WHERE issue_id = $1 AND label = $2',
        [id, label]
      );
      await client.query('UPDATE issues SET updated_at = now() WHERE id = $1', [
        id
      ]);
      await emitEvent(client, {
        board_id,
        issue_id: id,
        kind: 'label',
        actor: write_options.actor,
        payload: { removed: label }
      });
    });
    return showIssue(board_id, id);
  }

  /**
   * Tombstone an issue: stamp `deleted_at` and keep the row.
   *
   * Keeping it is not squeamishness. Every list filters on `deleted_at IS NULL`,
   * so a tombstone is invisible; but `deps.issue_id` references it, comments
   * hang off it, and the notification differ needs "this used to exist" to be
   * distinguishable from "this was never here".
   *
   * @param {string} board_id - Board to write.
   * @param {string} id - The issue to act on.
   * @param {{ actor?: string }} [write_options] - Who is acting.
   * @returns {Promise<void>}
   */
  async function deleteIssue(board_id, id, write_options = {}) {
    await withTx(async (client) => {
      await assertIssue(client, board_id, id);
      await client.query(
        `UPDATE issues SET deleted_at = now(), updated_at = now()
          WHERE id = $1 AND board_id = $2`,
        [id, board_id]
      );
      await emitEvent(client, {
        board_id,
        issue_id: id,
        kind: 'deleted',
        actor: write_options.actor
      });
    });
  }

  /**
   * @param {string} board_id - Board to write.
   * @param {string} id - Issue the comment belongs to.
   * @param {string} body - Comment text.
   * @param {{ actor?: string }} [write_options] - Comment author.
   * @returns {Promise<Array<Record<string, unknown>>>} The issue's comments.
   */
  async function addComment(board_id, id, body, write_options = {}) {
    await withTx(async (client) => {
      await assertIssue(client, board_id, id);
      await client.query(
        `INSERT INTO comments (id, issue_id, author, body, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [crypto.randomUUID(), id, write_options.actor || null, body]
      );
      // A comment moves the issue's `updated_at`. Without it the subscription
      // delta — which is computed from `updated_at`/`closed_at` — would not
      // consider the row changed, and every other open dashboard would keep
      // rendering the old `comment_count`.
      await client.query('UPDATE issues SET updated_at = now() WHERE id = $1', [
        id
      ]);
      await emitEvent(client, {
        board_id,
        issue_id: id,
        kind: 'comment',
        actor: write_options.actor
      });
    });
    return listComments(board_id, id);
  }

  /**
   * Purge all issue data attributable to one actor and its removal descendants
   * in one transaction.
   *
   * Owned issues remain as tombstones so issue identity and the deletion signal
   * survive, but their prose and all attached rows are removed. Rows authored by
   * any removed actor on surviving issues are removed too, and surviving
   * assignments are cleared rather than leaving a dead handle in the roster.
   * The per-board notification is deliberately not an events row: this
   * operation has just scrubbed the audit rows that could identify the removed
   * actors.
   *
   * @param {string} actor_input - Root actor handle, matched case-insensitively.
   * @param {string[]} [actor_inputs] - Root and descendant actor handles.
   * Empty entries and case-insensitive duplicates are ignored; the root is
   * always included first.
   * @returns {Promise<{ actor: string, removed_actors: string[], issues: number,
   *   owned_issues: number, deps: number, labels: number, comments: number,
   *   events: number, assignee_cleared: number, owner_cleared: number,
   *   updated_issues: number, boards: number, notifications: number }>}
   */
  async function purgeActor(actor_input, actor_inputs = []) {
    const actor = String(actor_input || '').trim();
    if (actor.length === 0) {
      throw new PgStoreError(
        'bad_request',
        'purgeActor requires a non-empty actor'
      );
    }

    /** @type {string[]} */
    const actors = [];
    /** @type {Set<string>} */
    const seen_actors = new Set();
    for (const input of [
      actor,
      ...(Array.isArray(actor_inputs) ? actor_inputs : [])
    ]) {
      const candidate = String(input || '').trim();
      const key = candidate.toLowerCase();
      if (candidate.length === 0 || seen_actors.has(key)) {
        continue;
      }
      seen_actors.add(key);
      actors.push(candidate);
    }
    // `actor` is non-empty and is the first candidate, so this array always has
    // at least one entry. Keep a separate lowercase array for every SQL match;
    // the original spellings remain safe response metadata.
    const actor_keys = actors.map((value) => value.toLowerCase());

    return withTx(async (client) => {
      const owned_result = await client.query(
        `SELECT id, board_id FROM issues
          WHERE deleted_at IS NULL
            AND lower(COALESCE(created_by, '')) = ANY($1::text[])
          FOR UPDATE`,
        [actor_keys]
      );
      const owned_ids = owned_result.rows.map((row) => String(row.id));
      const affected_ids = new Set(owned_ids);
      const board_ids = new Set(
        owned_result.rows
          .map((row) => String(row.board_id || ''))
          .filter(Boolean)
      );

      // Capture board ids for authored events before deleting them. Events can
      // have a null issue_id, so looking only through issues would miss a board
      // that still needs a refresh. Issue ids also refresh surviving rows whose
      // audit history was scrubbed.
      const authored_event_boards = await client.query(
        `SELECT DISTINCT board_id, issue_id FROM events
          WHERE lower(COALESCE(actor, '')) = ANY($1::text[])`,
        [actor_keys]
      );
      for (const row of authored_event_boards.rows) {
        const board_id = String(row.board_id || '');
        if (board_id) {
          board_ids.add(board_id);
        }
        if (row.issue_id) {
          affected_ids.add(String(row.issue_id));
        }
      }

      const related_deps = await client.query(
        `SELECT issue_id, depends_on_id FROM deps
          WHERE issue_id = ANY($2::text[])
             OR depends_on_id = ANY($2::text[])
             OR lower(COALESCE(created_by, '')) = ANY($1::text[])`,
        [actor_keys, owned_ids]
      );
      for (const row of related_deps.rows) {
        affected_ids.add(String(row.issue_id || ''));
        affected_ids.add(String(row.depends_on_id || ''));
      }

      const related_comments = await client.query(
        `SELECT issue_id FROM comments
          WHERE issue_id = ANY($2::text[])
             OR lower(COALESCE(author, '')) = ANY($1::text[])`,
        [actor_keys, owned_ids]
      );
      for (const row of related_comments.rows) {
        affected_ids.add(String(row.issue_id || ''));
      }

      const affected_issue_ids = [...affected_ids].filter(Boolean);
      if (affected_issue_ids.length > 0) {
        const affected_boards = await client.query(
          `SELECT DISTINCT board_id FROM issues WHERE id = ANY($1::text[])`,
          [affected_issue_ids]
        );
        for (const row of affected_boards.rows) {
          const board_id = String(row.board_id || '');
          if (board_id) board_ids.add(board_id);
        }
      }

      const counts = {
        actor,
        removed_actors: actors,
        issues: 0,
        owned_issues: 0,
        deps: 0,
        labels: 0,
        comments: 0,
        events: 0,
        assignee_cleared: 0,
        owner_cleared: 0,
        updated_issues: 0,
        boards: 0,
        notifications: 0
      };

      if (owned_ids.length > 0) {
        const tombstones = await client.query(
          `UPDATE issues SET
             deleted_at = now(), updated_at = now(), status = 'closed',
             title = '[removed user]', description = NULL, design = NULL,
             acceptance_criteria = NULL, notes = NULL, close_reason = NULL,
             assignee = NULL, owner = NULL, created_by = NULL,
             external_ref = NULL, metadata = '{}'::jsonb,
             closed_at = COALESCE(closed_at, now()),
             lease_expires_at = NULL, heartbeat_at = NULL
            WHERE id = ANY($1::text[]) AND deleted_at IS NULL
            RETURNING id`,
          [owned_ids]
        );
        counts.owned_issues = Number(tombstones.rowCount || 0);
        counts.issues = counts.owned_issues;
      }

      const deleted_deps = await client.query(
        `DELETE FROM deps
          WHERE issue_id = ANY($2::text[])
             OR depends_on_id = ANY($2::text[])
             OR lower(COALESCE(created_by, '')) = ANY($1::text[])`,
        [actor_keys, owned_ids]
      );
      counts.deps = Number(deleted_deps.rowCount || 0);

      const deleted_labels = await client.query(
        `DELETE FROM labels WHERE issue_id = ANY($1::text[])`,
        [owned_ids]
      );
      counts.labels = Number(deleted_labels.rowCount || 0);

      const deleted_comments = await client.query(
        `DELETE FROM comments
          WHERE issue_id = ANY($2::text[])
             OR lower(COALESCE(author, '')) = ANY($1::text[])`,
        [actor_keys, owned_ids]
      );
      counts.comments = Number(deleted_comments.rowCount || 0);

      const deleted_events = await client.query(
        `DELETE FROM events
          WHERE issue_id = ANY($2::text[])
             OR lower(COALESCE(actor, '')) = ANY($1::text[])`,
        [actor_keys, owned_ids]
      );
      counts.events = Number(deleted_events.rowCount || 0);

      const cleared_assignees = await client.query(
        `UPDATE issues SET assignee = NULL
          WHERE deleted_at IS NULL
            AND lower(COALESCE(assignee, '')) = ANY($1::text[])
          RETURNING id, board_id`,
        [actor_keys]
      );
      counts.assignee_cleared = Number(cleared_assignees.rowCount || 0);
      for (const row of cleared_assignees.rows) {
        affected_ids.add(String(row.id));
        board_ids.add(String(row.board_id || ''));
      }

      const cleared_owners = await client.query(
        `UPDATE issues SET owner = NULL
          WHERE deleted_at IS NULL
            AND lower(COALESCE(owner, '')) = ANY($1::text[])
          RETURNING id, board_id`,
        [actor_keys]
      );
      counts.owner_cleared = Number(cleared_owners.rowCount || 0);
      for (const row of cleared_owners.rows) {
        affected_ids.add(String(row.id));
        board_ids.add(String(row.board_id || ''));
      }

      const surviving_ids = [...affected_ids].filter(Boolean);
      if (surviving_ids.length > 0) {
        const touched = await client.query(
          `UPDATE issues SET updated_at = now()
            WHERE id = ANY($1::text[]) AND deleted_at IS NULL
            RETURNING id`,
          [surviving_ids]
        );
        counts.updated_issues = Number(touched.rowCount || 0);
      }

      const refresh_boards = [...board_ids].filter(Boolean).sort();
      counts.boards = refresh_boards.length;
      for (const board_id of refresh_boards) {
        await client.query('SELECT pg_notify($1, $2)', [
          PG_CHANNEL,
          `${board_id}:__users__:user_removed`
        ]);
        counts.notifications += 1;
      }
      return counts;
    });
  }

  /**
   * Who filed an issue, for the delete-ownership check. `''` when it cannot be
   * read — which the policy treats as unattributed and refuses, the safe
   * direction.
   *
   * @param {string} board_id - Board to read.
   * @param {string} id - The issue to act on.
   * @returns {Promise<string>}
   */
  async function issueCreator(board_id, id) {
    const res = await query(
      'SELECT created_by FROM issues WHERE id = $1 AND board_id = $2',
      [id, board_id]
    );
    return String(res.rows[0]?.created_by || '');
  }

  /**
   * Which board an issue id lives on (feads) — the routing lookup the
   * All-boards pseudo-board uses to send an id-scoped read or write home.
   * `''` when no board has the id.
   *
   * @param {string} id - The issue to locate.
   * @returns {Promise<string>}
   */
  async function boardOfIssue(id) {
    const res = await query(
      'SELECT board_id FROM issues WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [id]
    );
    return String(res.rows[0]?.board_id || '');
  }

  /**
   * @type {PgStore}
   */
  const store = {
    dsn,
    boardIdForDir,
    resolveBoardId,
    refreshBoards() {
      board_ids = null;
    },
    fetchList,
    fetchListItems,
    fetchDetail,
    exportIssues,
    liveArtifactHolders,
    listComments,
    showIssue,
    issueCreator,
    boardOfIssue,
    updateStatus,
    editText,
    updatePriority,
    updateAssignee,
    createIssue,
    depAdd,
    depRemove,
    labelAdd,
    labelRemove,
    deleteIssue,
    purgeActor,
    addComment,
    fetchChanges,
    query,
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async close() {
      closed = true;
      if (reconnect_timer) {
        clearTimeout(reconnect_timer);
        reconnect_timer = null;
      }
      listeners.clear();
      const client = listen_client;
      listen_client = null;
      if (client) {
        try {
          await client.end();
        } catch {
          // already gone
        }
      }
      await pool.end();
    }
  };
  return store;
}

/**
 * @typedef {Object} PgEvent
 * @property {string} board_id
 * @property {string} issue_id
 * @property {string} kind
 */

/**
 * @typedef {Object} PgStore
 * @property {string} dsn
 * @property {(board_dir: string | null | undefined) => string} boardIdForDir
 * @property {(board_dir: string | null | undefined) => Promise<string>} resolveBoardId
 * @property {() => void} refreshBoards
 * @property {(board_id: string, spec: { type: string, params?: Record<string, string|number|boolean> }) => Promise<Array<Record<string, unknown>>>} fetchList
 * @property {(board_id: string, spec: { type: string, params?: Record<string, string|number|boolean> }) => Promise<Array<Record<string, unknown>>>} fetchListItems
 * @property {(board_id: string, id: string, options?: { include_dependents?: boolean }) => Promise<Record<string, unknown> | null>} fetchDetail
 * @property {(board_id: string, options?: { ids?: string[], with_artifacts?: boolean, with_last_actor?: boolean }) => Promise<Array<Record<string, any>>>} exportIssues
 * @property {() => Promise<Array<{ issue_id: string, board_id: string, title: string, status: string, holder: string, metadata: Record<string, unknown> }>>} liveArtifactHolders
 * @property {(board_id: string, issue_id: string) => Promise<Array<Record<string, unknown>>>} listComments
 * @property {(board_id: string, id: string) => Promise<Record<string, unknown> | null>} showIssue
 * @property {(board_id: string, id: string) => Promise<string>} issueCreator
 * @property {(id: string) => Promise<string>} boardOfIssue
 * @property {(board_id: string, id: string, status: string, options?: { actor?: string }) => Promise<Record<string, unknown> | null>} updateStatus
 * @property {(board_id: string, id: string, field: string, value: string, options?: { actor?: string }) => Promise<Record<string, unknown> | null>} editText
 * @property {(board_id: string, id: string, priority: number, options?: { actor?: string }) => Promise<Record<string, unknown> | null>} updatePriority
 * @property {(board_id: string, id: string, assignee: string, options?: { actor?: string }) => Promise<Record<string, unknown> | null>} updateAssignee
 * @property {(board_id: string, fields: { title: string, issue_type?: string, priority?: number, description?: string, actor?: string }) => Promise<{ id: string }>} createIssue
 * @property {(board_id: string, a: string, b: string, options?: { actor?: string, dep_type?: string }) => Promise<void>} depAdd
 * @property {(board_id: string, a: string, b: string, options?: { actor?: string }) => Promise<void>} depRemove
 * @property {(board_id: string, id: string, label: string, options?: { actor?: string }) => Promise<Record<string, unknown> | null>} labelAdd
 * @property {(board_id: string, id: string, label: string, options?: { actor?: string }) => Promise<Record<string, unknown> | null>} labelRemove
 * @property {(board_id: string, id: string, options?: { actor?: string }) => Promise<void>} deleteIssue
 * @property {(actor: string, actors?: string[]) => Promise<{ actor: string, removed_actors: string[], issues: number, owned_issues: number, deps: number, labels: number, comments: number, events: number, assignee_cleared: number, owner_cleared: number, updated_issues: number, boards: number, notifications: number }>} purgeActor
 * @property {(board_id: string, id: string, body: string, options?: { actor?: string }) => Promise<Array<Record<string, unknown>>>} addComment
 * @property {(options?: { after_cursor?: string | null, since?: string | null, until?: string | null, boards?: string[], limit?: number }) => Promise<{ changes: Array<Record<string, unknown>>, next_cursor: string | null, complete: boolean, unavailable_boards: string[] }>} fetchChanges
 * @property {(text: string, values?: unknown[]) => Promise<import('pg').QueryResult<any>>} query
 * @property {(fn: (event: PgEvent) => void) => () => void} onEvent
 * @property {() => Promise<void>} close
 */

/**
 * Split a `NOTIFY` payload into its three parts.
 *
 * @param {string | undefined} payload - `<board>:<issue>:<kind>`.
 * @returns {PgEvent | null}
 */
export function parsePgEvent(payload) {
  const raw = String(payload || '');
  const first = raw.indexOf(':');
  const last = raw.lastIndexOf(':');
  if (first <= 0 || last <= first) {
    return null;
  }
  return {
    board_id: raw.slice(0, first),
    issue_id: raw.slice(first + 1, last),
    kind: raw.slice(last + 1)
  };
}

/** @type {PgStore | null} */
let SINGLETON = null;

/**
 * Subscribers to the process-wide event stream.
 *
 * Deliberately *not* held on the store: `ws.js` and the notification engine
 * subscribe at module load, which happens before anybody has decided which
 * store this process runs, and a subscription attached to a store that is later
 * replaced (a reconnect, a test swapping in a throwaway database) would go on
 * listening to nothing. The set outlives every store; each store is wired into
 * it when it becomes the singleton.
 *
 * @type {Set<(event: PgEvent) => void>}
 */
const GLOBAL_LISTENERS = new Set();

/** @type {(() => void) | null} */
let UNWIRE_SINGLETON = null;

/**
 * Fan a store's events out to the process-wide subscribers.
 *
 * @param {PgEvent} event - The committed write.
 * @returns {void}
 */
function dispatchGlobal(event) {
  for (const fn of GLOBAL_LISTENERS) {
    try {
      fn(event);
    } catch (err) {
      log('pg event subscriber failed: %o', err);
    }
  }
}

/**
 * The store this process uses, created on first use from `FEADS_PG_DSN`.
 *
 * `null` in legacy mode, and every caller branches on that rather than on the
 * environment directly — one question, asked one way, so a half-migrated call
 * site cannot spawn `bd` while its neighbour reads Postgres.
 *
 * @param {Record<string, string | undefined>} [env] - Environment to read.
 * @returns {PgStore | null}
 */
export function getPgStore(env = process.env) {
  // An explicitly installed store wins over the environment. That is what makes
  // `setPgStore` mean anything: a test points the whole server at a throwaway
  // database through one call, without having to mutate `process.env` (which is
  // process-wide, and would leak into whatever else the run touches).
  if (SINGLETON) {
    return SINGLETON;
  }
  const dsn = pgDsn(env);
  if (dsn.length === 0) {
    return null;
  }
  setPgStore(createPgStore({ dsn }));
  log('postgres data layer enabled');
  return SINGLETON;
}

/**
 * Install a store as the process singleton. For `index.js`, which wants the
 * pool and the listener up before the first connection arrives, and for tests.
 *
 * @param {PgStore | null} store - The store, or `null` to clear.
 * @returns {void}
 */
export function setPgStore(store) {
  if (UNWIRE_SINGLETON) {
    UNWIRE_SINGLETON();
    UNWIRE_SINGLETON = null;
  }
  SINGLETON = store;
  if (store) {
    UNWIRE_SINGLETON = store.onEvent(dispatchGlobal);
  }
}

/**
 * Close and forget the process singleton.
 *
 * @returns {Promise<void>}
 */
export async function closePgStore() {
  const store = SINGLETON;
  setPgStore(null);
  if (store) {
    await store.close();
  }
}

/**
 * Subscribe to every committed write, whichever store is current.
 *
 * Returns an unsubscribe function. Safe to call in legacy mode and safe to call
 * at module load: nothing here creates a connection.
 *
 * @param {(event: PgEvent) => void} fn - Called for every committed write.
 * @returns {() => void}
 */
export function onPgEvent(fn) {
  GLOBAL_LISTENERS.add(fn);
  return () => GLOBAL_LISTENERS.delete(fn);
}
