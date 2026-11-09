/**
 * feads addition — the epic story recorder: periodic, deduplicated snapshots of
 * every epic's task graph, and the read side that replays them.
 *
 * The dashboard's story view answers two questions about an epic: "what does it
 * look like right now?" (a tiered dependency flowchart) and "how did it get
 * here?" (a session-replay over time). The first is answered by capturing on
 * demand; the second needs somebody to have been *watching*, which is this
 * module: a timer that walks every known board, runs one `bd export` per board,
 * and appends a compact line per epic — but only when something about that epic
 * actually changed, so an idle board costs one export and zero writes.
 *
 * ## Storage
 *
 * `~/.feads/story/<hash-of-board-dir>/<epic-id>.jsonl` (override the root with
 * `FEADS_STORY_DIR`). Outside the board's `.beads` on purpose: that directory
 * belongs to `bd`/Dolt, and replay history is dashboard-local observation, not
 * issue data — it must not ride along on `bd dolt push`.
 *
 * Each line: `{ t, es, s, meta? }`
 * - `t`  — capture time, epoch ms.
 * - `es` — the epic's own status, coded (see STATUS_CODES).
 * - `s`  — member statuses, `{ issue_id: code }`, keys sorted.
 * - `meta` — `{ epic: {title}, nodes: {id: {title,type,assignee}}, edges }`,
 *   present only on lines where the *structure* changed (task added, retitled,
 *   reassigned, edge added). A reader reconstructs cumulatively: each meta fully
 *   replaces the previous one. Statuses stay per-line because they are the
 *   thing being replayed; meta is factored out because titles and edges change
 *   rarely and repeating them would dominate the file.
 *
 * Deduplication is per epic against the last line written (cached in memory,
 * re-read from disk on cold start), so restarting the daemon does not spray
 * duplicate frames.
 *
 * ## Graph semantics
 *
 * Membership is the `parent-child` closure below the epic (children, their
 * children, sub-epics included as nodes). Edges are scheduling dependencies
 * (`blocks`, `conditional-blocks`, `waits-for`) between two members, stored as
 * `[blocker, blocked]` — the blocker is the earlier tier, which is what puts it
 * on top in the flowchart. Cross-epic dependencies are deliberately dropped:
 * the story is one epic's, and a node that isn't drawn can't anchor an edge.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBd } from './bd.js';
import { debug } from './logging.js';
import { getPgStore } from './pg-store.js';

const log = debug('story-snapshots');

/** Dependency types that mean "must finish first" — the flowchart's edges. */
const SCHEDULING_DEP_TYPES = new Set([
  'blocks',
  'conditional-blocks',
  'waits-for'
]);

/** Compact status codes for the JSONL lines. */
const STATUS_CODES = /** @type {Record<string, string>} */ ({
  open: 'o',
  in_progress: 'p',
  blocked: 'b',
  deferred: 'd',
  closed: 'c'
});

const CODE_TO_STATUS = /** @type {Record<string, string>} */ ({});
for (const [status, code] of Object.entries(STATUS_CODES)) {
  CODE_TO_STATUS[code] = status;
}

/**
 * @param {string | null | undefined} status
 * @returns {string}
 */
export function encodeStatus(status) {
  return STATUS_CODES[String(status || 'open')] || 'o';
}

/**
 * @param {string | null | undefined} code
 * @returns {string}
 */
export function decodeStatus(code) {
  return CODE_TO_STATUS[String(code || 'o')] || 'open';
}

/**
 * Root directory for story files.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function storyDataDir(env = process.env) {
  const override = String(env.FEADS_STORY_DIR || '').trim();
  if (override.length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.feads', 'story');
}

/**
 * Per-board story directory. Hashed rather than encoded because a board dir is
 * an absolute path and path-in-path encodings age badly; a `board.json` marker
 * keeps the directory identifiable by a human poking around.
 *
 * @param {string} board_key - Absolute board dir, or any stable key.
 * @param {{ data_dir?: string, create?: boolean }} [options]
 * @returns {string}
 */
export function boardStoryDir(board_key, options = {}) {
  const root = options.data_dir || storyDataDir();
  const key = String(board_key || 'unbound');
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  const dir = path.join(root, hash);
  if (options.create) {
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, 'board.json');
    if (!fs.existsSync(marker)) {
      try {
        fs.writeFileSync(marker, JSON.stringify({ board_dir: key }) + '\n');
      } catch {
        // The marker is a courtesy; snapshots do not depend on it.
      }
    }
  }
  return dir;
}

/**
 * Keep epic ids honest as filenames. Beads ids are `prefix-alnum`, but the id
 * comes off the wire in the WS handlers, so it is not trusted here either.
 *
 * @param {string} epic_id
 * @returns {string}
 */
function epicFileName(epic_id) {
  const safe = String(epic_id).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}.jsonl`;
}

/**
 * Parse `bd export` output (JSONL) into the fields the collector needs.
 * Tolerant per line: one malformed line loses that line, not the capture.
 *
 * @param {string} text
 * @returns {Array<{ id: string, title: string, status: string, issue_type: string, assignee: string, deleted: boolean, dependencies: Array<{ depends_on_id: string, type: string }> }>}
 */
export function parseExportLines(text) {
  /** @type {ReturnType<typeof parseExportLines>} */
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    /** @type {any} */
    let issue;
    try {
      issue = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id = String(issue?.id || '');
    if (id.length === 0) {
      continue;
    }
    const status = String(issue.status || 'open');
    const deleted =
      status === 'tombstone' ||
      (issue.deleted_at !== undefined && issue.deleted_at !== null);
    /** @type {Array<{ depends_on_id: string, type: string }>} */
    const dependencies = [];
    if (Array.isArray(issue.dependencies)) {
      for (const dep of issue.dependencies) {
        const depends_on_id = String(dep?.depends_on_id || '');
        const type = String(dep?.type || '');
        if (depends_on_id.length > 0 && type.length > 0) {
          dependencies.push({ depends_on_id, type });
        }
      }
    }
    out.push({
      id,
      title: String(issue.title || ''),
      status,
      issue_type: String(issue.issue_type || 'task'),
      assignee: String(issue.assignee || ''),
      deleted,
      dependencies
    });
  }
  return out;
}

/**
 * @typedef {Object} EpicSnapshot
 * @property {number} t
 * @property {{ id: string, title: string, status: string }} epic
 * @property {Record<string, string>} statuses - member id → full status string.
 * @property {Record<string, { title: string, type: string, assignee: string }>} nodes
 * @property {Array<[string, string]>} edges - `[blocker, blocked]`, sorted.
 */

/**
 * Build one snapshot per epic from a parsed export.
 *
 * @param {ReturnType<typeof parseExportLines>} issues
 * @param {number} now_ms
 * @returns {Map<string, EpicSnapshot>}
 */
export function buildEpicSnapshots(issues, now_ms) {
  /** @type {Map<string, (typeof issues)[number]>} */
  const by_id = new Map();
  for (const issue of issues) {
    if (!issue.deleted) {
      by_id.set(issue.id, issue);
    }
  }

  // parent id → direct children, from each child's parent-child dependency.
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const issue of by_id.values()) {
    for (const dep of issue.dependencies) {
      if (dep.type === 'parent-child' && by_id.has(dep.depends_on_id)) {
        const list = children.get(dep.depends_on_id) || [];
        list.push(issue.id);
        children.set(dep.depends_on_id, list);
      }
    }
  }

  /** @type {Map<string, EpicSnapshot>} */
  const snapshots = new Map();
  for (const issue of by_id.values()) {
    if (issue.issue_type !== 'epic') {
      continue;
    }
    // Membership: the parent-child closure below this epic. The visited set
    // makes a parent cycle terminate instead of recursing forever.
    /** @type {Set<string>} */
    const members = new Set();
    /** @type {string[]} */
    const queue = [...(children.get(issue.id) || [])];
    while (queue.length > 0) {
      const next = /** @type {string} */ (queue.shift());
      if (next === issue.id || members.has(next)) {
        continue;
      }
      members.add(next);
      for (const child of children.get(next) || []) {
        queue.push(child);
      }
    }

    /** @type {Record<string, string>} */
    const statuses = {};
    /** @type {Record<string, { title: string, type: string, assignee: string }>} */
    const nodes = {};
    /** @type {Array<[string, string]>} */
    const edges = [];
    for (const member_id of Array.from(members).sort()) {
      const member = by_id.get(member_id);
      if (!member) {
        continue;
      }
      statuses[member_id] = member.status;
      nodes[member_id] = {
        title: member.title,
        type: member.issue_type,
        assignee: member.assignee
      };
      for (const dep of member.dependencies) {
        if (
          SCHEDULING_DEP_TYPES.has(dep.type) &&
          members.has(dep.depends_on_id)
        ) {
          edges.push([dep.depends_on_id, member_id]);
        }
      }
    }
    edges.sort((a, b) =>
      a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])
    );

    snapshots.set(issue.id, {
      t: now_ms,
      epic: { id: issue.id, title: issue.title, status: issue.status },
      statuses,
      nodes,
      edges
    });
  }
  return snapshots;
}

/**
 * The persisted shape of a snapshot's changing half and structural half,
 * serialized canonically so equality can be string equality.
 *
 * @param {EpicSnapshot} snap
 * @returns {{ state_key: string, meta_key: string, line_state: { es: string, s: Record<string, string> }, line_meta: { epic: { title: string }, nodes: EpicSnapshot['nodes'], edges: EpicSnapshot['edges'] } }}
 */
function persistedForm(snap) {
  /** @type {Record<string, string>} */
  const s = {};
  for (const id of Object.keys(snap.statuses).sort()) {
    s[id] = encodeStatus(snap.statuses[id]);
  }
  const line_state = { es: encodeStatus(snap.epic.status), s };
  /** @type {Record<string, { title: string, type: string, assignee: string }>} */
  const nodes = {};
  for (const id of Object.keys(snap.nodes).sort()) {
    nodes[id] = snap.nodes[id];
  }
  const line_meta = {
    epic: { title: snap.epic.title },
    nodes,
    edges: snap.edges
  };
  return {
    state_key: JSON.stringify(line_state),
    meta_key: JSON.stringify(line_meta),
    line_state,
    line_meta
  };
}

/**
 * Last-written line per epic file, so dedupe survives without re-reading the
 * file on every tick. Cold entries are hydrated from disk once.
 *
 * @type {Map<string, { state_key: string, meta_key: string }>}
 */
const LAST_WRITTEN = new Map();

/**
 * @param {string} file
 * @returns {{ state_key: string, meta_key: string } | null}
 */
function readLastWritten(file) {
  /** @type {string} */
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  /** @type {{ state_key: string, meta_key: string } | null} */
  let last = null;
  /** @type {string} */
  let meta_key = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object') {
      if (parsed.meta) {
        meta_key = JSON.stringify(parsed.meta);
      }
      last = {
        state_key: JSON.stringify({ es: parsed.es, s: parsed.s || {} }),
        meta_key
      };
    }
  }
  return last;
}

/**
 * Append a snapshot line for one epic, unless nothing changed since the last
 * line. Returns what happened, mostly for tests.
 *
 * @param {string} board_key
 * @param {EpicSnapshot} snap
 * @param {{ data_dir?: string }} [options]
 * @returns {'written'|'written-with-meta'|'unchanged'}
 */
export function appendEpicSnapshot(board_key, snap, options = {}) {
  const dir = boardStoryDir(board_key, { ...options, create: true });
  const file = path.join(dir, epicFileName(snap.epic.id));
  const next = persistedForm(snap);
  let last = LAST_WRITTEN.get(file);
  if (last === undefined) {
    last = readLastWritten(file) || { state_key: '', meta_key: '' };
  }
  const meta_changed = next.meta_key !== last.meta_key;
  if (!meta_changed && next.state_key === last.state_key) {
    LAST_WRITTEN.set(file, last);
    return 'unchanged';
  }
  /** @type {Record<string, unknown>} */
  const line = { t: snap.t, ...next.line_state };
  if (meta_changed) {
    line.meta = next.line_meta;
  }
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
  LAST_WRITTEN.set(file, {
    state_key: next.state_key,
    meta_key: next.meta_key
  });
  return meta_changed ? 'written-with-meta' : 'written';
}

/**
 * Read an epic's replay history.
 *
 * Frames carry decoded statuses; structural meta is deduplicated into `metas`
 * with each frame holding an index (`m`) into it — the wire mirror of the file
 * format, so a 200-frame history of a 30-task epic is not 200 copies of the
 * node table.
 *
 * @param {string} board_key
 * @param {string} epic_id
 * @param {{ data_dir?: string, max_frames?: number }} [options]
 * @returns {{ frames: Array<{ t: number, epic_status: string, statuses: Record<string, string>, m: number }>, metas: Array<{ epic: { title: string }, nodes: Record<string, { title: string, type: string, assignee: string }>, edges: Array<[string, string]> }> }}
 */
export function readEpicHistory(board_key, epic_id, options = {}) {
  const dir = boardStoryDir(board_key, { data_dir: options.data_dir });
  const file = path.join(dir, epicFileName(epic_id));
  /** @type {string} */
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { frames: [], metas: [] };
  }
  /** @type {ReturnType<typeof readEpicHistory>['metas']} */
  const metas = [];
  /** @type {ReturnType<typeof readEpicHistory>['frames']} */
  const frames = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.s) {
      continue;
    }
    if (parsed.meta) {
      metas.push(parsed.meta);
    }
    if (metas.length === 0) {
      // A file that starts mid-stream (first meta line pruned or lost) has
      // frames that cannot be drawn; skip until structure arrives.
      continue;
    }
    /** @type {Record<string, string>} */
    const statuses = {};
    for (const [id, code] of Object.entries(parsed.s)) {
      statuses[id] = decodeStatus(/** @type {string} */ (code));
    }
    frames.push({
      t: Number(parsed.t) || 0,
      epic_status: decodeStatus(parsed.es),
      statuses,
      m: metas.length - 1
    });
  }
  const max =
    options.max_frames && options.max_frames > 0 ? options.max_frames : 2000;
  if (frames.length > max) {
    // Keep the newest frames; re-base is unnecessary because metas are
    // cumulative replacements and every frame still points at its own.
    frames.splice(0, frames.length - max);
  }
  return { frames, metas };
}

/**
 * Every issue on a board, in the shape the snapshot builder reads (feads).
 *
 * Two sources, one shape. In Postgres mode a single query answers what a whole
 * `bd export` used to — the recorder ticks every board on a timer and each tick
 * was a ~250ms process spawn through the global `bd` queue, which is the cost
 * this removes. In legacy mode nothing changes, down to the error text.
 *
 * An explicitly injected `run` always wins: the tests that drive this feed
 * canned export text, and they must keep exercising the parser rather than
 * silently switching to SQL because the developer happens to have a DSN
 * exported.
 *
 * @param {{ board_dir: string | null, cwd?: string }} board - Board to read.
 * @param {{ run?: typeof runBd }} options - Capture options.
 * @returns {Promise<ReturnType<typeof parseExportLines>>}
 */
async function readBoardIssues(board, options) {
  if (!options.run) {
    const store = getPgStore();
    if (store) {
      const board_id = await store.resolveBoardId(board.board_dir);
      const rows = await store.exportIssues(board_id);
      return rows.map((row) => ({
        id: String(row.id),
        title: String(row.title || ''),
        status: String(row.status || 'open'),
        issue_type: String(row.issue_type || 'task'),
        assignee: String(row.assignee || ''),
        deleted: row.deleted === true,
        dependencies: Array.isArray(row.dependencies) ? row.dependencies : []
      }));
    }
  }
  const run = options.run || runBd;
  const res = await run(['export'], {
    cwd: board.cwd,
    board_dir: board.board_dir,
    timeout_ms: 60000
  });
  if (res.code !== 0) {
    throw new Error(
      `bd export failed (code ${res.code}): ${String(res.stderr || '').slice(0, 300)}`
    );
  }
  return parseExportLines(res.stdout);
}

/**
 * Run one capture of a board: export, build snapshots, persist changed epics.
 *
 * @param {{ board_dir: string | null, cwd?: string }} board
 * @param {{ data_dir?: string, run?: typeof runBd, now?: () => number }} [options]
 * @returns {Promise<Map<string, EpicSnapshot>>}
 */
export async function captureBoard(board, options = {}) {
  const now = options.now || Date.now;
  const issues = await readBoardIssues(board, options);
  const snapshots = buildEpicSnapshots(issues, now());
  const board_key = storyBoardKey(board);
  for (const snap of snapshots.values()) {
    // An epic with no members yet has no story to record; it still comes back
    // in the map so an on-demand "current graph" can say "no tasks yet".
    if (Object.keys(snap.statuses).length === 0) {
      continue;
    }
    try {
      appendEpicSnapshot(board_key, snap, { data_dir: options.data_dir });
    } catch (err) {
      log('append failed for %s/%s: %o', board_key, snap.epic.id, err);
    }
  }
  return snapshots;
}

/**
 * The stable key snapshots for a board are stored under. The board dir when
 * one is bound (the normal case); the workspace root as a fallback so an
 * unbound daemon still records *somewhere* stable.
 *
 * @param {{ board_dir: string | null, cwd?: string }} board
 * @returns {string}
 */
export function storyBoardKey(board) {
  const dir = String(board.board_dir || '').trim();
  if (dir.length > 0) {
    return path.resolve(dir);
  }
  const cwd = String(board.cwd || '').trim();
  return cwd.length > 0 ? path.resolve(cwd) : 'unbound';
}

/**
 * Shape an `epic-graph` reply from a capture.
 *
 * @param {Map<string, EpicSnapshot>} snapshots
 * @param {string} epic_id
 * @returns {{ epic: { id: string, title: string, status: string }, t: number, nodes: Array<{ id: string, title: string, issue_type: string, assignee: string, status: string }>, edges: Array<[string, string]> } | null}
 */
export function epicGraphPayload(snapshots, epic_id) {
  const snap = snapshots.get(epic_id);
  if (!snap) {
    return null;
  }
  const nodes = Object.keys(snap.nodes)
    .sort()
    .map((id) => ({
      id,
      title: snap.nodes[id].title,
      issue_type: snap.nodes[id].type,
      assignee: snap.nodes[id].assignee,
      status: snap.statuses[id] || 'open'
    }));
  return { epic: snap.epic, t: snap.t, nodes, edges: snap.edges };
}

/**
 * Start the periodic recorder.
 *
 * Ticks are strictly sequential — one board at a time, and a tick that is
 * still running when the next fires is skipped rather than stacked, because
 * `bd` invocations are globally serialized anyway and stacking would only
 * grow a queue.
 *
 * @param {{ listBoards: () => Promise<Array<{ board_dir: string | null, cwd?: string }>>, interval_ms?: number, data_dir?: string, run?: typeof runBd }} options
 * @returns {{ stop: () => void, tick: () => Promise<void> }}
 */
export function startStorySnapshotter(options) {
  const interval_ms =
    options.interval_ms && options.interval_ms > 0
      ? options.interval_ms
      : 120000;
  let in_flight = false;
  let stopped = false;

  async function tick() {
    if (in_flight || stopped) {
      return;
    }
    in_flight = true;
    try {
      /** @type {Array<{ board_dir: string | null, cwd?: string }>} */
      let boards = [];
      try {
        boards = await options.listBoards();
      } catch (err) {
        log('listBoards failed: %o', err);
        return;
      }
      /** @type {Set<string>} */
      const seen = new Set();
      for (const board of boards) {
        const key = storyBoardKey(board);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        try {
          await captureBoard(board, {
            data_dir: options.data_dir,
            run: options.run
          });
        } catch (err) {
          log('capture failed for %s: %o', key, err);
        }
      }
    } finally {
      in_flight = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, interval_ms);
  timer.unref?.();
  // A baseline right away, so the first replay frame exists after one boot
  // rather than one interval.
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick
  };
}
