import { runBdJson } from './bd.js';
import { debug } from './logging.js';
import { getPgStore, pgErrorEnvelope } from './pg-store.js';

const log = debug('list-adapters');

/**
 * Build concrete `bd` CLI args for a subscription type + params.
 * Always includes `--json` for parseable output.
 *
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 * @returns {string[]}
 */
export function mapSubscriptionToBdArgs(spec) {
  const t = String(spec.type);
  switch (t) {
    case 'all-issues': {
      // `--limit 0` = unlimited. Without it, `bd list` caps at its default 50.
      return ['list', '--json', '--tree=false', '--limit', '0'];
    }
    case 'epics': {
      return ['epic', 'status', '--json'];
    }
    case 'blocked-issues': {
      return ['blocked', '--json'];
    }
    case 'ready-issues': {
      // `bd list --ready` has the same semantics as `bd ready` but emits the
      // full list shape (assignee, parent, metadata, dependencies), which the
      // board needs to say who a card belongs to and what it touches.
      return ['list', '--json', '--tree=false', '--ready', '--limit', '1000'];
    }
    case 'in-progress-issues': {
      // `--limit 0` = unlimited. Without it, `bd list` caps at its default 50.
      return [
        'list',
        '--json',
        '--tree=false',
        '--status',
        'in_progress',
        '--limit',
        '0'
      ];
    }
    case 'closed-issues': {
      return [
        'list',
        '--json',
        '--tree=false',
        '--status',
        'closed',
        '--limit',
        '1000'
      ];
    }
    case 'issue-detail': {
      const p = spec.params || {};
      const id = String(p.id || '').trim();
      if (id.length === 0) {
        throw badRequest('Missing param: params.id');
      }
      return ['show', id, '--json', '--include-dependents'];
    }
    default: {
      throw badRequest(`Unknown subscription type: ${t}`);
    }
  }
}

/**
 * Normalize bd list output to minimal Issue shape used by the registry.
 * - Ensures `id` is a string.
 * - Coerces timestamps to numbers.
 * - `closed_at` defaults to null when missing or invalid.
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, created_at: number, updated_at: number, closed_at: number | null } & Record<string, unknown>>}
 */
export function normalizeIssueList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  /** @type {Array<{ id: string, created_at: number, updated_at: number, closed_at: number | null } & Record<string, unknown>>} */
  const out = [];
  for (const it of value) {
    const id = String(it.id ?? '');
    if (id.length === 0) {
      continue;
    }
    const created_at = parseTimestamp(/** @type {any} */ (it).created_at);
    const updated_at = parseTimestamp(it.updated_at);
    const closed_raw = it.closed_at;
    /** @type {number | null} */
    let closed_at = null;
    if (closed_raw !== undefined && closed_raw !== null) {
      const n = parseTimestamp(closed_raw);
      closed_at = Number.isFinite(n) ? n : null;
    }
    out.push({
      ...it,
      id,
      created_at: Number.isFinite(created_at) ? created_at : 0,
      updated_at: Number.isFinite(updated_at) ? updated_at : 0,
      closed_at
    });
  }
  return out;
}

/**
 * Fields a *list* consumer never reads. Descriptions dominate the payload —
 * a 1000-row closed column ships every closed issue's prose — and the views
 * that need them (issue detail) subscribe to `issue-detail`, which is not
 * trimmed. Dropping them here shrinks every snapshot and upsert on the wire.
 */
const HEAVY_LIST_FIELDS = [
  'description',
  'design',
  'notes',
  'acceptance_criteria'
];

/**
 * Slim an embedded issue reference (dependency / blocker) to what a list
 * consumer renders: identity, title, and enough type/status to badge it.
 *
 * @param {unknown} ref
 * @returns {Record<string, unknown> | string}
 */
function slimIssueRef(ref) {
  // `bd blocked` emits blockers as bare id strings; those are already slim.
  if (typeof ref === 'string') {
    return ref;
  }
  if (!ref || typeof ref !== 'object') {
    return {};
  }
  const r = /** @type {any} */ (ref);
  /** @type {Record<string, unknown>} */
  const out = { id: r.id };
  if (r.title !== undefined) {
    out.title = r.title;
  }
  if (r.status !== undefined) {
    out.status = r.status;
  }
  if (r.issue_type !== undefined) {
    out.issue_type = r.issue_type;
  }
  if (r.dependency_type !== undefined) {
    out.dependency_type = r.dependency_type;
  }
  return out;
}

/**
 * Strip heavy fields from list items before they hit the wire.
 *
 * @param {Array<Record<string, unknown>>} items
 * @returns {Array<Record<string, unknown>>}
 */
export function trimListItems(items) {
  return items.map((it) => {
    // Copied key by key rather than spread-then-`delete`: deleting a property
    // drops the object into V8's slow dictionary mode, and every row of every
    // list snapshot is serialized once per subscribed connection afterwards.
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(it)) {
      if (HEAVY_LIST_SET.has(key)) {
        continue;
      }
      const value = it[key];
      out[key] =
        Array.isArray(value) && SLIM_REF_FIELDS.has(key)
          ? value.map(slimIssueRef)
          : value;
    }
    return out;
  });
}

/** `HEAVY_LIST_FIELDS` as a set, for the per-key test in `trimListItems`. */
const HEAVY_LIST_SET = new Set(HEAVY_LIST_FIELDS);

/** Embedded issue-reference arrays `trimListItems` slims. */
const SLIM_REF_FIELDS = new Set(['dependencies', 'dependents', 'blocked_by']);

/**
 * @typedef {Object} FetchListResultSuccess
 * @property {true} ok
 * @property {Array<{ id: string, updated_at: number, closed_at: number | null } & Record<string, unknown>>} items
 */

/**
 * @typedef {Object} FetchListResultFailure
 * @property {false} ok
 * @property {{ code: string, message: string, details?: Record<string, unknown> }} error
 */

/**
 * Execute the mapped `bd` command for a subscription spec and return normalized items.
 * Errors do not throw; they are surfaced as a structured object.
 *
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 * @param {{ cwd?: string, board_dir?: string | null }} [options] - Working
 * directory for the bd command, and (feads) the board it must read. `board_dir`
 * is threaded through rather than resolved here because a refresh can be driven
 * either by a connection or by a file watcher, and only the caller knows which
 * board is meant — see the note at the spawn site in `bd.js`.
 * @returns {Promise<FetchListResultSuccess | FetchListResultFailure>}
 */
export async function fetchListForSubscription(spec, options = {}) {
  // feads: the Postgres path. One branch, at the top, rather than a per-type
  // fork further down — every subscription type is answered by SQL or by `bd`,
  // never by a mix, so a half-migrated read cannot diff one source against the
  // other and emit deletes for rows that never left.
  const store = getPgStore();
  if (store) {
    return fetchListFromPg(store, spec, options);
  }

  /** @type {string[]} */
  let args;
  try {
    args = mapSubscriptionToBdArgs(spec);
  } catch (err) {
    // Surface bad requests (e.g., missing params)
    log('mapSubscriptionToBdArgs failed for %o: %o', spec, err);
    const e = toErrorObject(err);
    return { ok: false, error: e };
  }

  try {
    // Retry a failed read a couple of times before reporting it. The board is
    // written by other processes (CLI sessions, the MCP server) concurrent
    // with our reads, and an embedded-Dolt read that races a writer can come
    // back as a clean miss — "no issue found" for an issue that is plainly
    // there one second later (incident 2026-07-30, feads-dm1: the issue-detail
    // modal went CRITICAL right after a burst of CLI closes). A real error
    // still surfaces, just ~1s later; a transient one heals invisibly.
    /** @type {Awaited<ReturnType<typeof runBdJson>> | null} */
    let res = null;
    for (const delay_ms of [0, 250, 750]) {
      if (delay_ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay_ms));
      }
      res = await runBdJson(args, {
        cwd: options.cwd,
        board_dir: options.board_dir
      });
      if (res && res.code === 0 && 'stdoutJson' in res) {
        break;
      }
      log(
        'bd failed for %o (args=%o) code=%s stderr=%s — %s',
        spec,
        args,
        res?.code,
        res?.stderr || '',
        delay_ms < 750 ? 'retrying' : 'giving up'
      );
    }
    if (!res || res.code !== 0 || !('stdoutJson' in res)) {
      return {
        ok: false,
        error: {
          code: 'bd_error',
          message: scrubAdvisoryStderr(res?.stderr) || 'bd failed',
          details: { exit_code: res?.code ?? -1 }
        }
      };
    }
    // bd show may return a single object; normalize to an array first
    let raw = Array.isArray(res.stdoutJson)
      ? res.stdoutJson
      : res.stdoutJson && typeof res.stdoutJson === 'object'
        ? [res.stdoutJson]
        : [];

    // Special-case mapping for `epics`: current bd output nests the epic under
    // an `epic` key and exposes counters at the top level. Flatten so that
    // each entry has a top-level `id` and core fields expected by the registry.
    if (String(spec.type) === 'epics') {
      raw = raw.map((it) => {
        if (it && typeof it === 'object' && 'epic' in it) {
          const e = /** @type {any} */ (it).epic || {};
          /** @type {Record<string, unknown>} */
          const flat = {
            // Required minimal fields for registry + client rendering
            id: String(e.id ?? ''),
            title: e.title,
            status: e.status,
            issue_type: e.issue_type || 'epic',
            created_at: e.created_at,
            updated_at: e.updated_at,
            closed_at: e.closed_at ?? null,
            deleted_at: e.deleted_at ?? null,
            assignee: e.assignee,
            // Preserve useful counters from bd output
            total_children: /** @type {any} */ (it).total_children,
            closed_children: /** @type {any} */ (it).closed_children,
            eligible_for_close: /** @type {any} */ (it).eligible_for_close
          };
          return flat;
        }
        return it;
      });
      raw = raw.filter((it) => {
        if (!it || typeof it !== 'object') {
          return false;
        }
        const status =
          typeof (/** @type {any} */ (it).status) === 'string'
            ? /** @type {any} */ (it).status
            : '';
        if (status === 'tombstone') {
          return false;
        }
        const deleted_at = /** @type {any} */ (it).deleted_at;
        if (deleted_at !== undefined && deleted_at !== null) {
          return false;
        }
        return true;
      });

      // Completed epics: `bd epic status` computes close-eligibility, so it
      // only walks OPEN epics — but the Epics tab is where finished work
      // should still be findable. Merge closed epics in from `bd list`.
      // They carry no child counters (the client derives counts from the
      // detail subscription's dependents on expand) and are never
      // close-eligible. Additive + best-effort: a failure here must not
      // blank the open-epics list.
      try {
        const closed_res = await runBdJson(
          [
            'list',
            '--json',
            '--tree=false',
            '--type',
            'epic',
            '--status',
            'closed',
            '--limit',
            '0'
          ],
          { cwd: options.cwd, board_dir: options.board_dir }
        );
        const closed_rows =
          closed_res && closed_res.code === 0 && 'stdoutJson' in closed_res
            ? Array.isArray(closed_res.stdoutJson)
              ? closed_res.stdoutJson
              : []
            : [];
        const seen = new Set(raw.map((it) => String((it && it.id) ?? '')));
        for (const row of closed_rows) {
          if (!row || typeof row !== 'object') {
            continue;
          }
          const rid = String(/** @type {any} */ (row).id ?? '');
          if (!rid || seen.has(rid)) {
            continue;
          }
          const deleted_at = /** @type {any} */ (row).deleted_at;
          if (deleted_at !== undefined && deleted_at !== null) {
            continue;
          }
          seen.add(rid);
          raw.push({
            id: rid,
            title: /** @type {any} */ (row).title,
            status: 'closed',
            issue_type: 'epic',
            assignee: /** @type {any} */ (row).assignee,
            created_at: /** @type {any} */ (row).created_at,
            updated_at: /** @type {any} */ (row).updated_at,
            closed_at: /** @type {any} */ (row).closed_at ?? null,
            deleted_at: null,
            eligible_for_close: false
          });
        }
      } catch (err) {
        log('closed-epics merge failed (continuing with open only): %o', err);
      }
    }

    // feads: `bd blocked` emits a slim shape — no assignee, parent, metadata
    // or dependencies. The board names those on blocked cards too, so re-read
    // the same ids through `bd list` (full shape) and keep the blockers from
    // the first call. A failed enrichment is not a reason to show an empty
    // column: fall back to the slim rows.
    if (String(spec.type) === 'blocked-issues' && raw.length > 0) {
      try {
        const ids = raw
          .map((it) => String((it && it.id) ?? ''))
          .filter((s) => s.length > 0);
        const full = await runBdJson(
          [
            'list',
            '--json',
            '--tree=false',
            '--id',
            ids.join(','),
            '--limit',
            '0'
          ],
          { cwd: options.cwd, board_dir: options.board_dir }
        );
        if (
          full &&
          full.code === 0 &&
          'stdoutJson' in full &&
          Array.isArray(full.stdoutJson)
        ) {
          const by_id = new Map(
            full.stdoutJson.map((it) => [String((it && it.id) ?? ''), it])
          );
          raw = raw.map((it) => {
            const enriched = by_id.get(String((it && it.id) ?? ''));
            if (!enriched) {
              return it;
            }
            /** @type {Record<string, unknown>} */
            const merged = { ...enriched };
            if (it.blocked_by !== undefined) {
              merged.blocked_by = it.blocked_by;
            }
            if (it.blocked_by_count !== undefined) {
              merged.blocked_by_count = it.blocked_by_count;
            }
            return merged;
          });
        }
      } catch (err) {
        log('blocked enrichment failed (using slim rows): %o', err);
      }
    }

    // Lists ship without prose; the detail subscription keeps everything.
    if (String(spec.type) !== 'issue-detail') {
      raw = trimListItems(raw);
    }

    let items = normalizeIssueList(raw);
    if (String(spec.type) === 'flares') {
      items = raw.filter(Boolean).map((flare) => ({
        ...flare,
        id: String(flare.id || ''),
        updated_at: Number(flare.heartbeat_at) || 0,
        closed_at: null
      }));
    }
    return { ok: true, items };
  } catch (err) {
    log('bd invocation failed for %o (args=%o): %o', spec, args, err);
    return {
      ok: false,
      error: {
        code: 'bd_error',
        message:
          (err && /** @type {any} */ (err).message) || 'bd invocation failed'
      }
    };
  }
}

/**
 * Answer a subscription from Postgres (feads).
 *
 * Runs the same two shaping passes the `bd` path ends with — `trimListItems`
 * (everything but `issue-detail`) then `normalizeIssueList` — so the wire shape
 * is decided in exactly one place regardless of where the rows came from. The
 * store returns ISO timestamp strings for that reason: `normalizeIssueList`
 * runs `Date.parse` on strings and passes numbers through, so ISO in means the
 * epoch-ms the client has always seen comes out.
 *
 * @param {import('./pg-store.js').PgStore} store - The data layer.
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 *   - The subscription.
 * @param {{ cwd?: string, board_dir?: string | null }} options - The caller's
 * board; only `board_dir` is meaningful here, since Postgres has no cwd.
 * @returns {Promise<FetchListResultSuccess | FetchListResultFailure>}
 */
async function fetchListFromPg(store, spec, options) {
  try {
    const board_id = await store.resolveBoardId(options.board_dir);
    // `fetchListItems` where the store has it (the hot path: timestamps already
    // epoch ms); `fetchList` for a store that predates it, e.g. a test double.
    const fast = typeof store.fetchListItems === 'function';
    let raw = fast
      ? await store.fetchListItems(board_id, spec)
      : await store.fetchList(board_id, spec);
    // The fast path's rows are already list-shaped — no prose columns are
    // selected and embedded refs are built slim in SQL — so trimming them is a
    // copy of every row for nothing (pinned by the pg-store equivalence test).
    if (!fast && String(spec.type) !== 'issue-detail') {
      raw = trimListItems(raw);
    }
    return { ok: true, items: normalizeIssueList(raw) };
  } catch (err) {
    log('pg read failed for %o: %o', spec, err);
    return { ok: false, error: pgErrorEnvelope(err) };
  }
}

/**
 * Strip bd's advisory stderr — `warning:`/`note:` lines and their indented
 * `Fix:`/`Or:` continuations — from a message headed for a human. On a server
 * board (a git clone with an origin, no beads.role configured) bd prefixes
 * *every* run with its role nudge, and an error dialog that opens with
 * "warning: beads.role not configured" buries the actual failure under
 * remediation advice aimed at whoever owns the server, not the reader. The
 * full stderr still goes to the debug log at the call site.
 *
 * @param {unknown} stderr
 * @returns {string}
 */
export function scrubAdvisoryStderr(stderr) {
  /** @type {string[]} */
  const kept = [];
  let in_advisory = false;
  for (const line of String(stderr || '').split('\n')) {
    if (/^\s*(warning|note):/i.test(line)) {
      in_advisory = true;
      continue;
    }
    if (in_advisory && /^\s+(Fix|Or):/i.test(line)) {
      continue;
    }
    in_advisory = false;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * Create a `bad_request` error object.
 *
 * @param {string} message
 */
function badRequest(message) {
  const e = new Error(message);
  // @ts-expect-error add code
  e.code = 'bad_request';
  return e;
}

/**
 * Normalize arbitrary thrown values to a structured error object.
 *
 * @param {unknown} err
 * @returns {FetchListResultFailure['error']}
 */
function toErrorObject(err) {
  if (err && typeof err === 'object') {
    const any = /** @type {{ code?: unknown, message?: unknown }} */ (err);
    const code = typeof any.code === 'string' ? any.code : 'bad_request';
    const message =
      typeof any.message === 'string' ? any.message : 'Request error';
    return { code, message };
  }
  return { code: 'bad_request', message: 'Request error' };
}

/**
 * Parse a bd timestamp string to epoch ms using Date.parse.
 * Falls back to numeric coercion when parsing fails.
 *
 * @param {unknown} v
 * @returns {number}
 */
function parseTimestamp(v) {
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) {
      return ms;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : 0;
  }
  return 0;
}
