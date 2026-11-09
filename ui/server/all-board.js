/**
 * feads addition — the "All boards" pseudo-board.
 *
 * A connection can select `*` instead of a real board and see every registered
 * board's issues in one place. Nothing about the subscription machinery changes
 * shape: the pseudo-board has a scope key (`*`), a subscription registry and a
 * refresh debounce like any physical board. What changes is where the rows come
 * from — an aggregate fan-out over every registered board instead of one `bd`
 * (or one Postgres board id).
 *
 * ## Why aggregation lives on the server
 *
 * The alternative — the browser subscribing to N boards — multiplies sockets,
 * caches and refresh storms by the number of boards, and every client pays it
 * again. Here the fan-out happens once per refresh, behind the same per-key
 * lock and 75 ms debounce every board already gets, and the merged rows are
 * cached in the pseudo-board's own registry so clients get deltas, not
 * re-sends.
 *
 * ## Performance shape
 *
 * - Postgres mode: N small indexed queries in parallel on one pool — noise.
 * - `bd` mode: one `bd` fork per board per list, bounded by
 *   `FANOUT_CONCURRENCY` so a burst cannot fork-bomb the host. The registry
 *   list itself is cached for a few seconds since it changes about never.
 *
 * ## Writes
 *
 * The pseudo-board is not a database, so anything that needs *one* board is
 * routed: an issue id names its home board (learned from the rows themselves —
 * every aggregate fetch records which board answered for which id prefix — and
 * probed across boards on a cold miss). Creating an issue has no id to route
 * by, so creation is refused on the All view; everything else works.
 */
import path from 'node:path';
import { listRegistryBoards } from './board-registry.js';
import { fetchListForSubscription } from './list-adapters.js';
import { debug } from './logging.js';
import { boardIdForDir, getPgStore } from './pg-store.js';

const log = debug('all-board');

/** The board id the picker and `set-board` use for the pseudo-board. */
export const ALL_BOARD_ID = '*';

/**
 * The scope key the pseudo-board's registry, refresh timer and mutation gate
 * live under. Safe from collision: every physical board's scope key is an
 * absolute path.
 */
export const ALL_SCOPE_KEY = '*';

/** How the picker should label and describe the pseudo-board. */
export const ALL_BOARD_NAME = 'All boards';
export const ALL_BOARD_DESCRIPTION =
  'Everything across every board, in one view. Cards say which board they ' +
  'live on; edits are routed to it. Creating issues needs a specific board.';

/** Max simultaneous per-board fetches during a fan-out (`bd` forks, mostly). */
const FANOUT_CONCURRENCY = 4;

/** How long one registry read stands in for the next (ms). */
const BOARDS_CACHE_TTL_MS = 5000;

/** The closed column is a recency view, not an archive — same cap as one board. */
const CLOSED_MERGE_CAP = 1000;

/**
 * @typedef {Object} AggregateBoard
 * @property {string} id - Registry board id.
 * @property {string} name - Display name.
 * @property {string} board_dir - Absolute `.beads` directory.
 * @property {string} root_dir - Project root for `bd` children.
 */

/** @type {{ at: number, boards: AggregateBoard[] } | null} */
let BOARDS_CACHE = null;

/**
 * Which board answers for an issue-id prefix (`feads-s32` → `feads`), learned
 * from aggregate fetches so detail opens and mutations rarely need a probe.
 *
 * @type {Map<string, AggregateBoard>}
 */
const PREFIX_TO_BOARD = new Map();

/**
 * The prefix an issue id mints under — everything before the last dash.
 *
 * @param {string} issue_id
 * @returns {string}
 */
function prefixOf(issue_id) {
  const id = String(issue_id || '');
  const cut = id.lastIndexOf('-');
  return cut > 0 ? id.slice(0, cut) : '';
}

/**
 * Whether a workspace selection is the All-boards pseudo-board.
 *
 * @param {{ board_id?: string } | null | undefined} workspace
 * @returns {boolean}
 */
export function isAllBoardsWorkspace(workspace) {
  return Boolean(workspace && workspace.board_id === ALL_BOARD_ID);
}

/**
 * The workspace state a connection gets when it selects All boards.
 *
 * Deliberately holds no paths: `board_dir` is empty so `applyBoardEnv` drops
 * any inherited `BEADS_DIR` — an unrouted `bd` child fails honestly instead of
 * writing to whichever board the daemon started on.
 *
 * @returns {{ root_dir: string, db_path: string, board_dir: string, key: string, board_id: string, name: string, description: string, repos: string[] }}
 */
export function allBoardsWorkspaceState() {
  return {
    root_dir: '',
    db_path: '',
    board_dir: '',
    key: ALL_BOARD_ID,
    board_id: ALL_BOARD_ID,
    name: ALL_BOARD_NAME,
    description: ALL_BOARD_DESCRIPTION,
    repos: []
  };
}

/**
 * The picker entry for the pseudo-board, shaped like `listAvailableBoards`'s
 * rows so the client needs no special case to render it.
 *
 * @returns {Record<string, unknown>}
 */
export function allBoardsPickerEntry() {
  return {
    path: '',
    database: '',
    pid: 0,
    version: 'virtual',
    board_dir: '',
    key: ALL_BOARD_ID,
    id: ALL_BOARD_ID,
    name: ALL_BOARD_NAME,
    description: ALL_BOARD_DESCRIPTION,
    repos: [],
    exists: true,
    source: 'virtual'
  };
}

/**
 * Every registered board that still exists on disk, cached briefly — the
 * registry is read on every aggregate refresh otherwise, and boards change
 * about once a month.
 *
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<AggregateBoard[]>}
 */
export async function listAggregateBoards(options = {}) {
  const now = Date.now();
  if (
    !options.fresh &&
    BOARDS_CACHE &&
    now - BOARDS_CACHE.at < BOARDS_CACHE_TTL_MS
  ) {
    return BOARDS_CACHE.boards;
  }
  const boards = (await listRegistryBoards())
    .filter((b) => b.exists && b.board_dir)
    .map((b) => ({
      id: b.id || path.basename(path.dirname(b.board_dir)),
      name: b.name || b.id,
      board_dir: b.board_dir,
      root_dir: b.workspace_dir || path.dirname(b.board_dir)
    }));
  BOARDS_CACHE = { at: now, boards };
  return boards;
}

/**
 * Drop the boards cache (tests, and callers that just registered a board).
 */
export function resetAggregateBoardsCache() {
  BOARDS_CACHE = null;
  PREFIX_TO_BOARD.clear();
  BOARD_LIST_CACHE.clear();
}

/**
 * Per-board list results the aggregate reuses between refreshes (Postgres mode
 * only).
 *
 * Without it, one write to one board refetched *every* board's list for every
 * All-boards subscription — fifteen queries and fifteen normalizations to move
 * one row. With it, a refresh refetches only the boards whose NOTIFY arrived
 * since the last pass and splices the rest from here.
 *
 * Postgres only, deliberately: there every write from every door announces
 * itself (`LISTEN feads_events`), so invalidation is exact. Under bare `bd` a
 * board nobody is looking at directly has no watcher at all, and the old
 * refetch-everything behaviour is what kept its rows fresh in the aggregate.
 *
 * Entries also expire after `BOARD_LIST_TTL_MS`, the backstop for a NOTIFY lost
 * while the listen connection was reconnecting. `generation` guards the race
 * where a write lands while its board is being fetched: the fetch started
 * before the invalidation, so its result must not be stored as current.
 *
 * @type {Map<string, { generation: number, lists: Map<string, { at: number, items: Array<Record<string, unknown>> }> }>}
 */
const BOARD_LIST_CACHE = new Map();
const BOARD_LIST_TTL_MS = 30_000;
let BOARD_LIST_GENERATION = 0;

/**
 * Forget cached aggregate rows for one board, or for every board when the
 * caller cannot say which one changed (`''`).
 *
 * @param {string} board_id - Postgres board id (the NOTIFY's), or `''`.
 */
export function invalidateAggregateBoard(board_id) {
  BOARD_LIST_GENERATION += 1;
  const id = String(board_id || '');
  if (id.length === 0 || id === ALL_BOARD_ID) {
    BOARD_LIST_CACHE.clear();
    return;
  }
  BOARD_LIST_CACHE.delete(id);
}

/**
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 * @returns {string}
 */
function listCacheKey(spec) {
  return JSON.stringify([String(spec.type), spec.params || null]);
}

/**
 * One board's slice of an aggregate list, from the cache when it is current.
 *
 * @param {AggregateBoard} board
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 * @returns {Promise<import('./list-adapters.js').FetchListResultSuccess | import('./list-adapters.js').FetchListResultFailure>}
 */
async function fetchBoardSlice(board, spec) {
  if (!getPgStore()) {
    return fetchListForSubscription(spec, {
      cwd: board.root_dir,
      board_dir: board.board_dir
    });
  }
  const id = boardIdForDir(board.board_dir);
  const key = listCacheKey(spec);
  const now = Date.now();
  const hit = BOARD_LIST_CACHE.get(id)?.lists.get(key);
  if (hit && now - hit.at < BOARD_LIST_TTL_MS) {
    return { ok: true, items: /** @type {any} */ (hit.items) };
  }
  const generation = BOARD_LIST_GENERATION;
  const res = await fetchListForSubscription(spec, {
    cwd: board.root_dir,
    board_dir: board.board_dir
  });
  // Only a fetch that no invalidation overtook may become the cached answer.
  // (A global generation is coarser than per-board, so a busy instance caches
  // a little less often — never a little wrongly.)
  if (res.ok && generation === BOARD_LIST_GENERATION) {
    let entry = BOARD_LIST_CACHE.get(id);
    if (!entry) {
      entry = { generation, lists: new Map() };
      BOARD_LIST_CACHE.set(id, entry);
    }
    entry.lists.set(key, { at: now, items: res.items });
  }
  return res;
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) {
          return;
        }
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/**
 * Remember which board a set of rows came from, so later id-scoped requests
 * route without a probe.
 *
 * @param {AggregateBoard} board
 * @param {Array<{ id?: unknown }>} items
 */
function learnPrefixes(board, items) {
  for (const it of items) {
    const prefix = prefixOf(String(it?.id || ''));
    if (prefix.length > 0 && !PREFIX_TO_BOARD.has(prefix)) {
      PREFIX_TO_BOARD.set(prefix, board);
    }
  }
}

/**
 * Tag rows with the board they came from. The client renders these as chips;
 * the ids double as the routing table for later writes.
 *
 * @param {AggregateBoard} board
 * @param {Array<Record<string, unknown>>} items
 * @returns {Array<Record<string, unknown>>}
 */
function tagItems(board, items) {
  return items.map((it) => ({
    ...it,
    board_id: board.id,
    board_name: board.name || board.id
  }));
}

/**
 * The board that owns an issue id, or `null` when no board answers for it.
 *
 * Resolution order: Postgres (one indexed lookup) when configured, then the
 * learned prefix map, then a bounded probe across every board. The probe's
 * answer is cached by prefix, so one cold miss per board prefix per process.
 *
 * @param {string} issue_id
 * @returns {Promise<AggregateBoard | null>}
 */
export async function resolveIssueBoard(issue_id) {
  const id = String(issue_id || '').trim();
  if (id.length === 0) {
    return null;
  }
  const boards = await listAggregateBoards();

  const store = getPgStore();
  if (store && typeof store.boardOfIssue === 'function') {
    // Postgres is the authority on which board holds an issue. Its answer is
    // final: an issue it does not know, or one whose board is not (or no longer)
    // in the aggregate — unregistered, directory missing — resolves to nothing.
    // Falling back to the prefix map or a probe here would let a guess stand in
    // for the real board, and every caller authorizes against what this returns.
    try {
      const board_id = await store.boardOfIssue(id);
      if (!board_id) return null;
      return (
        boards.find((b) => b.id === board_id) ||
        boards.find((b) => boardIdForDir(b.board_dir) === board_id) ||
        null
      );
    } catch (err) {
      log('pg issue→board lookup failed for %s: %o', id, err);
      return null;
    }
  }

  const prefix = prefixOf(id);
  if (prefix.length > 0) {
    const cached = PREFIX_TO_BOARD.get(prefix);
    if (cached && boards.some((b) => b.board_dir === cached.board_dir)) {
      return cached;
    }
  }

  // Cold miss: ask every board. First board whose read answers with the issue
  // wins; the rest of the forks finish and are discarded.
  const spec = { type: 'issue-detail', params: { id } };
  const results = await mapLimit(boards, FANOUT_CONCURRENCY, async (board) => {
    try {
      const res = await fetchListForSubscription(spec, {
        cwd: board.root_dir,
        board_dir: board.board_dir
      });
      return res.ok && res.items.length > 0 ? board : null;
    } catch {
      return null;
    }
  });
  const found = results.find((b) => b !== null) || null;
  if (found && prefix.length > 0) {
    PREFIX_TO_BOARD.set(prefix, found);
  }
  return found;
}

/**
 * Order a merged list the way a single board would have.
 *
 * @param {string} type
 * @param {Array<Record<string, unknown>>} items
 * @returns {Array<Record<string, unknown>>}
 */
function orderMerged(type, items) {
  const t = String(type);
  if (t === 'closed-issues') {
    items.sort((a, b) => Number(b.closed_at || 0) - Number(a.closed_at || 0));
    return items.slice(0, CLOSED_MERGE_CAP);
  }
  if (t === 'ready-issues') {
    items.sort((a, b) => {
      const p = Number(a.priority ?? 2) - Number(b.priority ?? 2);
      return p !== 0
        ? p
        : Number(a.created_at || 0) - Number(b.created_at || 0);
    });
    return items;
  }
  items.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
  return items;
}

/**
 * Answer one subscription across every registered board.
 *
 * Failures are per-board: a board that cannot be read is skipped (logged) so
 * one wedged board does not blank the whole view. Only when *no* board answers
 * does the aggregate report an error.
 *
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 * @param {{ only?: Set<string> | null }} [options]
 * @returns {Promise<import('./list-adapters.js').FetchListResultSuccess | import('./list-adapters.js').FetchListResultFailure>}
 */
export async function fetchListForAllBoards(spec, options = {}) {
  // Accounts mode: `only` is the set of boards in the aggregate's space. A board
  // outside it is never fetched, so its rows cannot reach the merged list.
  const only = options.only instanceof Set ? options.only : null;
  const boards = (await listAggregateBoards()).filter(
    (b) => !only || only.has(String(b.id))
  );
  if (boards.length === 0) {
    return {
      ok: false,
      error: {
        code: 'no_boards',
        message: 'no registered boards to aggregate'
      }
    };
  }

  // Detail is id-scoped: route to the owning board instead of asking N boards
  // on every refresh of an open detail panel.
  if (String(spec.type) === 'issue-detail') {
    const id = String((spec.params || {}).id || '').trim();
    const board = await resolveIssueBoard(id);
    if (!board || (only && !only.has(String(board.id)))) {
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: `no board owns issue "${id}"`
        }
      };
    }
    const res = await fetchListForSubscription(spec, {
      cwd: board.root_dir,
      board_dir: board.board_dir
    });
    if (!res.ok) {
      return res;
    }
    return { ok: true, items: /** @type {any} */ (tagItems(board, res.items)) };
  }

  /** @type {Array<Record<string, unknown>>} */
  const merged = [];
  /** @type {Array<{ board: AggregateBoard, error: { code: string, message: string } }>} */
  const failures = [];
  await mapLimit(boards, FANOUT_CONCURRENCY, async (board) => {
    try {
      const res = await fetchBoardSlice(board, spec);
      if (!res.ok) {
        failures.push({ board, error: res.error });
        return;
      }
      learnPrefixes(board, res.items);
      merged.push(...tagItems(board, res.items));
    } catch (err) {
      failures.push({
        board,
        error: {
          code: 'bd_error',
          message: (err && /** @type {any} */ (err).message) || 'fetch failed'
        }
      });
    }
  });

  for (const f of failures) {
    log(
      'aggregate %s skipped board %s: %s',
      spec.type,
      f.board.id,
      f.error.message
    );
  }
  if (merged.length === 0 && failures.length === boards.length) {
    return {
      ok: false,
      error: {
        code: failures[0].error.code,
        message: `every board failed — first: ${failures[0].error.message}`
      }
    };
  }
  return {
    ok: true,
    items: /** @type {any} */ (orderMerged(spec.type, merged))
  };
}
