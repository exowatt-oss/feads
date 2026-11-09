/**
 * The compact Postgres snapshot used by the Agentwatch view.
 *
 * Agentwatch is deliberately read-only. The queries below do the filtering,
 * bounding, grouping, and ordering in Postgres so a large workspace never
 * requires the server or browser to materialize the full issues/comments set.
 * The issue LIST is bounded; the per-actor in-progress COUNTS are not (they are
 * one small aggregate row per actor and board).
 */

const ACTIVE_ISSUE_LIMIT = 250;
const SHARED_DISCUSSION_LIMIT = 100;
const TERMINAL_RUNTIME_STATUSES = new Set(['done', 'failed', 'aborted']);
const RUNTIME_STATUSES = new Set([
  'working',
  'idle',
  'done',
  'failed',
  'aborted',
  'unknown'
]);
const RUNTIME_LIVENESS = new Set(['live', 'fading', 'terminal']);

const ACTIVE_SNAPSHOT_SQL = `
  WITH active_items AS (
    SELECT
      i.id,
      i.board_id,
      i.title,
      i.status,
      i.priority,
      i.issue_type,
      BTRIM(i.assignee) AS actor,
      i.updated_at,
      i.started_at
    FROM issues i
    WHERE i.deleted_at IS NULL
      AND i.status = 'in_progress'
      AND NULLIF(BTRIM(i.assignee), '') IS NOT NULL
    ORDER BY i.updated_at DESC NULLS LAST, i.id ASC
    LIMIT $1
  ), active_items_with_counts AS (
    SELECT
      a.id,
      a.board_id,
      a.title,
      a.status,
      a.priority,
      a.issue_type,
      a.actor,
      a.updated_at,
      a.started_at,
      COUNT(c.id)::int AS comment_count
    FROM active_items a
    LEFT JOIN comments c ON c.issue_id = a.id
    GROUP BY
      a.id,
      a.board_id,
      a.title,
      a.status,
      a.priority,
      a.issue_type,
      a.actor,
      a.updated_at,
      a.started_at
  )
  SELECT
    actor,
    COUNT(*)::int AS item_count,
    MAX(updated_at) AS latest_activity,
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'board_id', board_id,
        'title', title,
        'status', status,
        'priority', priority,
        'issue_type', issue_type,
        'updated_at', updated_at,
        'started_at', started_at,
        'comment_count', comment_count
      )
      ORDER BY updated_at DESC NULLS LAST, id ASC
    ) AS issues
  FROM active_items_with_counts
  GROUP BY actor
  ORDER BY MAX(updated_at) DESC NULLS LAST, actor ASC`;

// Uncapped: every in-progress, assigned, nondeleted issue, counted per trimmed
// assignee and board. Per board so a viewer's projection can count only the
// boards it may read.
const ACTIVE_COUNTS_SQL = `
  SELECT
    BTRIM(i.assignee) AS actor,
    i.board_id,
    COUNT(*)::int AS item_count,
    MAX(i.updated_at) AS latest_activity
  FROM issues i
  WHERE i.deleted_at IS NULL
    AND i.status = 'in_progress'
    AND NULLIF(BTRIM(i.assignee), '') IS NOT NULL
  GROUP BY BTRIM(i.assignee), i.board_id`;

const SHARED_DISCUSSIONS_SQL = `
  WITH candidate_discussions AS (
    SELECT
      i.id,
      i.board_id,
      i.title,
      i.status,
      i.priority,
      i.issue_type,
      i.updated_at,
      COUNT(c.id)::int AS comment_count,
      MAX(c.created_at) AS latest_comment_at
    FROM issues i
    JOIN comments c ON c.issue_id = i.id
    WHERE i.deleted_at IS NULL
      AND i.status <> 'closed'
    GROUP BY
      i.id,
      i.board_id,
      i.title,
      i.status,
      i.priority,
      i.issue_type,
      i.updated_at
    HAVING COUNT(DISTINCT NULLIF(LOWER(BTRIM(c.author)), '')) >= 2
    ORDER BY MAX(c.created_at) DESC NULLS LAST, i.id ASC
    LIMIT $1
  ), discussion_comments AS (
    SELECT
      d.id AS issue_id,
      c.id AS comment_id,
      c.author,
      LEFT(c.body, 360) AS body,
      c.created_at,
      NULLIF(LOWER(BTRIM(c.author)), '') AS participant_actor,
      ROW_NUMBER() OVER (
        PARTITION BY d.id
        ORDER BY c.created_at DESC NULLS LAST, c.id ASC
      ) AS comment_rank
    FROM candidate_discussions d
    JOIN comments c ON c.issue_id = d.id
  ), discussion_participant_counts AS (
    SELECT
      issue_id,
      participant_actor,
      COUNT(*)::int AS comment_count,
      MAX(created_at) AS last_commented_at
    FROM discussion_comments
    WHERE participant_actor IS NOT NULL
    GROUP BY issue_id, participant_actor
  ), discussion_participants AS (
    SELECT
      issue_id,
      jsonb_agg(
        jsonb_build_object(
          'actor', participant_actor,
          'comment_count', comment_count,
          'last_commented_at', last_commented_at
        )
        ORDER BY participant_actor ASC
      ) AS participants
    FROM discussion_participant_counts
    GROUP BY issue_id
  ), latest_comments AS (
    SELECT issue_id, author, body, created_at
    FROM discussion_comments
    WHERE comment_rank = 1
  )
  SELECT
    d.id,
    d.board_id,
    d.title,
    d.status,
    d.priority,
    d.issue_type,
    d.updated_at,
    d.comment_count,
    COALESCE(p.participants, '[]'::jsonb) AS participants,
    jsonb_build_object(
      'author', l.author,
      'body', l.body,
      'created_at', l.created_at
    ) AS latest_comment
  FROM candidate_discussions d
  LEFT JOIN discussion_participants p ON p.issue_id = d.id
  JOIN latest_comments l ON l.issue_id = d.id
  ORDER BY d.latest_comment_at DESC NULLS LAST, d.id ASC`;

/**
 * @typedef {Object} AgentwatchStore
 * @property {(text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>} query
 */

/**
 * @typedef {Object} AgentwatchIssue
 * @property {string} id
 * @property {string} board_id
 * @property {string} title
 * @property {string} status
 * @property {number} priority
 * @property {string} issue_type
 * @property {number} updated_at
 * @property {number} started_at
 * @property {number} comment_count
 */

/**
 * @typedef {Object} AgentwatchFlare
 * @property {string} actor
 * @property {string} board_id
 * @property {string} issue_id
 * @property {number} heartbeat_at
 * @property {string} liveness
 */

/**
 * @typedef {Object} AgentwatchRuntimeRow
 * @property {string} run_id
 * @property {string} handle
 * @property {string} display_name
 * @property {string} status
 * @property {string} model
 * @property {string} activity
 * @property {number} context_percent
 * @property {number} started_at
 * @property {number} ended_at
 * @property {number} heartbeat_at
 * @property {string} liveness
 * @property {string} client - launcher/ADE that started the runtime, e.g. p3
 * or forca; '' when the runtime was started directly.
 */

/**
 * @typedef {Object} AgentwatchRuntimeSession
 * @property {string} session_id
 * @property {string} runtime_id
 * @property {number} last_seen
 * @property {AgentwatchRuntimeRow | null} main
 * @property {AgentwatchRuntimeRow[]} subagents
 */

/**
 * @typedef {Object} AgentwatchPresenceError
 * @property {number} at
 * @property {number} status
 * @property {string} error
 * @property {string} [client]
 */

/**
 * @typedef {Object} AgentwatchAgent
 * @property {string} actor
 * @property {number} item_count - in-progress issues, uncapped (the sum of
 * `board_item_counts` when present)
 * @property {number} latest_activity
 * @property {number} last_seen
 * @property {AgentwatchFlare | null} flare
 * @property {AgentwatchIssue[]} issues - the bounded detail list
 * @property {Record<string, number>} [board_item_counts] - uncapped
 * in-progress counts by board id
 * @property {AgentwatchRuntimeSession[]} [runtime_sessions]
 * @property {boolean} [registered]
 * @property {string} [kind]
 * @property {string} [display_name]
 * @property {string[]} [aliases] - accounts mode: the alias actors folded
 * into this person's lane
 * @property {AgentwatchPresenceError} [presence_error] - the newest recent
 * rejected runtime-presence heartbeat not yet followed by a success
 */

/**
 * @typedef {(actor: string) => string} ActorFold
 */

/**
 * @typedef {Object} AgentwatchParticipant
 * @property {string} actor
 * @property {number} comment_count
 * @property {number} last_commented_at
 */

/**
 * @typedef {Object} AgentwatchLatestComment
 * @property {string} author
 * @property {string} body
 * @property {number} created_at
 */

/**
 * @typedef {Object} AgentwatchDiscussion
 * @property {string} id
 * @property {string} board_id
 * @property {string} title
 * @property {string} status
 * @property {number} priority
 * @property {string} issue_type
 * @property {number} updated_at
 * @property {number} comment_count
 * @property {AgentwatchParticipant[]} participants
 * @property {AgentwatchLatestComment} latest_comment
 */

/**
 * @typedef {Object} AgentwatchSnapshot
 * @property {number} generated_at
 * @property {{ active_agents: number, registered_agents: number, active_issues: number, shared_discussions: number }} stats
 * @property {AgentwatchAgent[]} agents
 * @property {AgentwatchDiscussion[]} discussions
 */

/**
 * Test whether a value can be read as a row object.
 *
 * @param {unknown} value - Candidate row value.
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Convert a database timestamp to epoch milliseconds. Invalid and null values
 * use zero so every timestamp in the public snapshot remains numeric.
 *
 * @param {unknown} value - A Date, epoch-millisecond value, or date string.
 * @returns {number}
 */
function epochMilliseconds(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const text = value.trim();
  if (text.length === 0) {
    return 0;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Convert a nullable database value to a compact string field.
 *
 * @param {unknown} value - Value to convert.
 * @returns {string}
 */
function textValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Convert a database count or integer to a safe non-negative integer.
 *
 * @param {unknown} value - Value to convert.
 * @param {number} fallback - Value for null, invalid, or missing input.
 * @returns {number} A safe non-negative integer.
 */
function nonNegativeInteger(value, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(numeric));
}

/**
 * Extract rows from a node-postgres query result.
 *
 * @param {{ rows: Array<Record<string, unknown>> }} result - Postgres response.
 */
function queryRows(result) {
  return Array.isArray(result.rows) ? result.rows : [];
}

/**
 * Compare two numeric timestamps descending, then use an id as a stable tie
 * breaker. SQL already applies this ordering; keeping the invariant at this
 * server boundary also makes malformed/fake query results deterministic.
 *
 * @param {number} left_timestamp - First timestamp.
 * @param {number} right_timestamp - Second timestamp.
 * @param {string} left_id - First id.
 * @param {string} right_id - Second id.
 * @returns {number}
 */
function compareTimestampDescending(
  left_timestamp,
  right_timestamp,
  left_id,
  right_id
) {
  if (left_timestamp !== right_timestamp) {
    return right_timestamp - left_timestamp;
  }
  return left_id < right_id ? -1 : left_id > right_id ? 1 : 0;
}

/**
 * Map one active-work issue from the compact JSON aggregate.
 *
 * @param {Record<string, unknown>} row - Aggregate issue object.
 * @returns {AgentwatchIssue}
 */
function mapActiveIssue(row) {
  return {
    id: textValue(row.id),
    board_id: textValue(row.board_id),
    title: textValue(row.title),
    status: textValue(row.status),
    priority: nonNegativeInteger(row.priority),
    issue_type: textValue(row.issue_type),
    updated_at: epochMilliseconds(row.updated_at),
    started_at: epochMilliseconds(row.started_at),
    comment_count: nonNegativeInteger(row.comment_count)
  };
}

/**
 * Map one grouped agent row and preserve its compact issue projection.
 *
 * @param {Record<string, unknown>} row - Grouped agent row.
 * @returns {AgentwatchAgent}
 */
function mapAgent(row) {
  const issue_values = Array.isArray(row.issues) ? row.issues : [];
  const issues = issue_values.filter(isRecord).map(mapActiveIssue);
  issues.sort((left_issue, right_issue) =>
    compareTimestampDescending(
      left_issue.updated_at,
      right_issue.updated_at,
      left_issue.id,
      right_issue.id
    )
  );
  const latest_activity = epochMilliseconds(row.latest_activity);
  return {
    actor: textValue(row.actor),
    item_count: nonNegativeInteger(row.item_count, issues.length),
    latest_activity,
    last_seen: latest_activity,
    flare: null,
    issues
  };
}

/**
 * Build the accounts-mode actor fold: an alias actor (a person's legacy agent,
 * a loose alias, a case variant) becomes that person's canonical actor, and the
 * absorbed aliases are remembered per lane. Without an alias map (accounts off,
 * silos) the fold is the identity and nothing is recorded.
 *
 * @param {unknown} aliases - Lower-cased alias → canonical actor.
 * @returns {{ fold: ActorFold, absorbed: Map<string, Set<string>> }}
 */
function createActorFold(aliases) {
  /** @type {Map<string, Set<string>>} */
  const absorbed = new Map();
  if (!(aliases instanceof Map) || aliases.size === 0) {
    return { fold: (actor) => actor, absorbed };
  }
  /** @type {ActorFold} */
  const fold = (actor) => {
    const canonical = aliases.get(actor.toLowerCase());
    if (
      typeof canonical !== 'string' ||
      canonical.length === 0 ||
      canonical === actor
    ) {
      return actor;
    }
    let seen = absorbed.get(canonical);
    if (!seen) {
      seen = new Set();
      absorbed.set(canonical, seen);
    }
    seen.add(actor);
    return canonical;
  };
  return { fold, absorbed };
}

/**
 * Merge grouped issue rows whose actors fold to the same person. Without a fold
 * every actor is already distinct and the rows pass through unchanged.
 *
 * @param {AgentwatchAgent[]} agents - Lanes mapped from the bounded list query.
 * @param {ActorFold} fold
 * @returns {AgentwatchAgent[]}
 */
function foldActiveLanes(agents, fold) {
  /** @type {Map<string, AgentwatchAgent>} */
  const lanes_by_actor = new Map();
  /** @type {AgentwatchAgent[]} */
  const lanes = [];
  for (const agent of agents) {
    const actor = fold(agent.actor);
    const lane = lanes_by_actor.get(actor);
    if (!lane) {
      agent.actor = actor;
      lanes_by_actor.set(actor, agent);
      lanes.push(agent);
      continue;
    }
    lane.item_count += agent.item_count;
    lane.latest_activity = Math.max(
      lane.latest_activity,
      agent.latest_activity
    );
    lane.last_seen = Math.max(lane.last_seen, agent.last_seen);
    lane.issues.push(...agent.issues);
    lane.issues.sort((left_issue, right_issue) =>
      compareTimestampDescending(
        left_issue.updated_at,
        right_issue.updated_at,
        left_issue.id,
        right_issue.id
      )
    );
  }
  return lanes;
}

/**
 * Apply the uncapped per-actor, per-board in-progress counts. An actor the
 * counts know about takes its `item_count` (and `board_item_counts`) from them;
 * an actor whose in-progress issues all fell outside the bounded list still
 * gets a lane, with an empty `issues` list. A lane the counts do not mention
 * (an issue that moved between the two reads) keeps its list-derived count.
 *
 * @param {AgentwatchAgent[]} agents - Lanes from the bounded list.
 * @param {Array<Record<string, unknown>>} count_rows - Raw count rows.
 * @param {ActorFold} fold
 * @returns {AgentwatchAgent[]}
 */
function mergeActiveCounts(agents, count_rows, fold) {
  /** @type {Map<string, { boards: Record<string, number>, latest_activity: number }>} */
  const counts = new Map();
  for (const row of count_rows) {
    const raw_actor = textValue(row.actor).trim();
    const item_count = nonNegativeInteger(row.item_count);
    if (raw_actor.length === 0 || item_count === 0) {
      continue;
    }
    const actor = fold(raw_actor);
    let entry = counts.get(actor);
    if (!entry) {
      entry = { boards: {}, latest_activity: 0 };
      counts.set(actor, entry);
    }
    const board_id = textValue(row.board_id);
    entry.boards[board_id] = (entry.boards[board_id] || 0) + item_count;
    entry.latest_activity = Math.max(
      entry.latest_activity,
      epochMilliseconds(row.latest_activity)
    );
  }
  if (counts.size === 0) {
    return agents;
  }
  const lanes_by_actor = new Map(agents.map((agent) => [agent.actor, agent]));
  for (const [actor, entry] of counts) {
    const item_count = Object.values(entry.boards).reduce(
      (total, count) => total + count,
      0
    );
    const lane = lanes_by_actor.get(actor);
    if (lane) {
      lane.item_count = item_count;
      lane.board_item_counts = entry.boards;
      lane.latest_activity = Math.max(
        lane.latest_activity,
        entry.latest_activity
      );
      lane.last_seen = Math.max(lane.last_seen, lane.latest_activity);
      continue;
    }
    /** @type {AgentwatchAgent} */
    const count_lane = {
      actor,
      item_count,
      latest_activity: entry.latest_activity,
      last_seen: entry.latest_activity,
      flare: null,
      issues: [],
      board_item_counts: entry.boards
    };
    lanes_by_actor.set(actor, count_lane);
    agents.push(count_lane);
  }
  return agents;
}

/**
 * Attach the newest recent rejected heartbeat to its (folded) actor's lane.
 * Only lanes that already exist are annotated: every authenticated agent is on
 * the roster, so a failure never needs a lane of its own.
 *
 * @param {AgentwatchAgent[]} agents
 * @param {unknown} values - `activePresenceErrors()` rows.
 * @param {ActorFold} fold
 * @returns {AgentwatchAgent[]}
 */
function mergePresenceErrors(agents, values, fold) {
  if (!Array.isArray(values) || values.length === 0) {
    return agents;
  }
  const lanes_by_actor = new Map(agents.map((agent) => [agent.actor, agent]));
  for (const value of values) {
    if (!isRecord(value)) {
      continue;
    }
    const raw_actor = textValue(value.actor).trim();
    const at = epochMilliseconds(value.at);
    const status = nonNegativeInteger(value.status);
    const error = textValue(value.error);
    if (raw_actor.length === 0 || at === 0 || status === 0) {
      continue;
    }
    const lane = lanes_by_actor.get(fold(raw_actor));
    if (!lane || (lane.presence_error && lane.presence_error.at >= at)) {
      continue;
    }
    /** @type {AgentwatchPresenceError} */
    const presence_error = { at, status, error };
    const client = textValue(value.client);
    if (client.length > 0) {
      presence_error.client = client;
    }
    lane.presence_error = presence_error;
  }
  return agents;
}

/**
 * Name, on each folded lane, the alias actors it absorbed.
 *
 * @param {AgentwatchAgent[]} agents
 * @param {Map<string, Set<string>>} absorbed
 * @returns {AgentwatchAgent[]}
 */
function attachAliases(agents, absorbed) {
  if (absorbed.size === 0) {
    return agents;
  }
  for (const agent of agents) {
    const aliases = absorbed.get(agent.actor);
    if (aliases && aliases.size > 0) {
      agent.aliases = Array.from(aliases).sort();
    }
  }
  return agents;
}

/**
 * Map one advisory presence row (a work flare) from the registry. Flares are
 * the live heartbeat: an agent touching an issue right now, independent of
 * whether the issue row itself was written.
 *
 * @param {unknown} value - Raw flare row.
 * @returns {AgentwatchFlare | null}
 */
function mapFlare(value) {
  if (!isRecord(value)) {
    return null;
  }
  const actor = textValue(value.actor).trim();
  const heartbeat_at = epochMilliseconds(value.heartbeat_at);
  if (actor.length === 0 || heartbeat_at === 0) {
    return null;
  }
  return {
    actor,
    board_id: textValue(value.board_id),
    issue_id: textValue(value.issue_id),
    heartbeat_at,
    liveness: textValue(value.liveness)
  };
}

/**
 * Fold advisory flares into the agent lanes. A flare for a known agent
 * advances that agent's `last_seen` and records what it is touching right
 * now; a flare from an actor with no in-progress issue still represents an
 * agent at work, so it becomes a lane of its own with an empty issue list.
 *
 * @param {AgentwatchAgent[]} agents - Lanes grouped from Postgres.
 * @param {unknown[]} flare_values - Raw registry flare rows.
 * @param {ActorFold} fold
 * @returns {AgentwatchAgent[]}
 */
function mergeFlares(agents, flare_values, fold) {
  const flares = flare_values
    .map(mapFlare)
    .filter((flare) => flare !== null)
    .map((flare) => ({ ...flare, actor: fold(flare.actor) }))
    .sort((left, right) => right.heartbeat_at - left.heartbeat_at);
  if (flares.length === 0) {
    return agents;
  }
  const lanes_by_actor = new Map(agents.map((agent) => [agent.actor, agent]));
  for (const flare of flares) {
    const lane = lanes_by_actor.get(flare.actor);
    if (lane) {
      if (lane.flare === null) {
        lane.flare = flare;
      }
      lane.last_seen = Math.max(lane.last_seen, flare.heartbeat_at);
      continue;
    }
    const flare_lane = {
      actor: flare.actor,
      item_count: 0,
      latest_activity: 0,
      last_seen: flare.heartbeat_at,
      flare,
      issues: []
    };
    lanes_by_actor.set(flare.actor, flare_lane);
    agents.push(flare_lane);
  }
  return agents;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasRuntimeControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) {
      return true;
    }
  }
  return false;
}

/**
 * Read a runtime string without coercing arbitrary values into the public
 * projection. Runtime presence is advisory, so one malformed row is ignored
 * rather than allowed to poison an otherwise valid actor lane.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function runtimeString(value) {
  if (typeof value !== 'string' || hasRuntimeControlCharacters(value)) {
    return null;
  }
  return value;
}

/**
 * Map one registry runtime row to an internal grouping row plus an explicit
 * allowlisted public row. The internal owner id and lineage fields never cross
 * this boundary.
 *
 * @param {unknown} value
 * @returns {{ actor: string, session_id: string, runtime_id: string,
 *   parent_run_id: string, kind: string, public_row: AgentwatchRuntimeRow } | null}
 */
function mapRuntimePresenceRow(value) {
  if (!isRecord(value)) {
    return null;
  }

  const actor = runtimeString(value.actor)?.trim() || '';
  const session_id = runtimeString(value.session_id)?.trim() || '';
  const runtime_id = runtimeString(value.runtime_id)?.trim() || '';
  const run_id = runtimeString(value.run_id)?.trim() || '';
  const parent_run_id = runtimeString(value.parent_run_id);
  const kind = runtimeString(value.kind);
  const status = runtimeString(value.status);
  const liveness = runtimeString(value.liveness);
  const handle = runtimeString(value.handle);
  const display_name = runtimeString(value.display_name);
  const model = runtimeString(value.model);
  const activity = runtimeString(value.activity);
  if (
    !actor ||
    !session_id ||
    !runtime_id ||
    !run_id ||
    parent_run_id === null ||
    !kind ||
    !RUNTIME_STATUSES.has(status || '') ||
    !RUNTIME_LIVENESS.has(liveness || '') ||
    handle === null ||
    display_name === null ||
    model === null ||
    activity === null
  ) {
    return null;
  }
  if (
    (kind !== 'main' && kind !== 'subagent') ||
    (kind === 'main' && (run_id !== runtime_id || parent_run_id !== '')) ||
    (kind === 'subagent' && parent_run_id !== runtime_id)
  ) {
    return null;
  }

  const context_value = value.context_percent;
  if (typeof context_value !== 'number' || !Number.isFinite(context_value)) {
    return null;
  }
  const started_at = epochMilliseconds(value.started_at);
  const ended_at = epochMilliseconds(value.ended_at);
  const heartbeat_at = epochMilliseconds(value.heartbeat_at);
  if (
    started_at < 0 ||
    ended_at < 0 ||
    heartbeat_at <= 0 ||
    !Number.isFinite(started_at) ||
    !Number.isFinite(ended_at) ||
    !Number.isFinite(heartbeat_at)
  ) {
    return null;
  }

  const safe_parent_run_id = /** @type {string} */ (parent_run_id);
  const safe_kind = /** @type {string} */ (kind);
  const safe_status = /** @type {string} */ (status);
  const safe_liveness = /** @type {string} */ (liveness);
  const safe_handle = /** @type {string} */ (handle);
  const safe_display_name = /** @type {string} */ (display_name);
  const safe_model = /** @type {string} */ (model);
  const safe_activity = /** @type {string} */ (activity);
  const terminal = TERMINAL_RUNTIME_STATUSES.has(safe_status);
  if (
    (terminal && safe_liveness !== 'terminal') ||
    (!terminal && safe_liveness === 'terminal')
  ) {
    return null;
  }

  return {
    actor,
    session_id,
    runtime_id,
    parent_run_id: safe_parent_run_id,
    kind: safe_kind,
    public_row: {
      run_id,
      handle: safe_handle,
      display_name: safe_display_name,
      status: safe_status,
      model: safe_model,
      activity: safe_activity,
      context_percent: Math.min(100, Math.max(0, context_value)),
      started_at,
      ended_at,
      heartbeat_at,
      liveness: safe_liveness,
      client: runtimeString(value.client) || ''
    }
  };
}

/**
 * Keep a deterministic newest row when a defensive input contains duplicate
 * tuples. The store's primary key normally prevents this; the tie-breaker keeps
 * tests and future callers stable even if a registry implementation changes.
 *
 * @param {any | null} current
 * @param {any} candidate
 * @returns {any}
 */
function newestRuntimeRow(current, candidate) {
  if (!current) {
    return candidate;
  }
  if (candidate.public_row.heartbeat_at !== current.public_row.heartbeat_at) {
    return candidate.public_row.heartbeat_at > current.public_row.heartbeat_at
      ? candidate
      : current;
  }
  const current_key = JSON.stringify(current.public_row);
  const candidate_key = JSON.stringify(candidate.public_row);
  return candidate_key < current_key ? candidate : current;
}

/**
 * @param {AgentwatchRuntimeRow} left
 * @param {AgentwatchRuntimeRow} right
 * @returns {number}
 */
function compareRuntimeChildren(left, right) {
  const left_terminal = TERMINAL_RUNTIME_STATUSES.has(left.status) ? 1 : 0;
  const right_terminal = TERMINAL_RUNTIME_STATUSES.has(right.status) ? 1 : 0;
  if (left_terminal !== right_terminal) {
    return left_terminal - right_terminal;
  }
  if (left.run_id !== right.run_id) {
    return left.run_id < right.run_id ? -1 : 1;
  }
  return right.heartbeat_at - left.heartbeat_at;
}

/**
 * Group sanitized runtime rows by durable actor, session transcript, and
 * runtime incarnation. Children are attached only through their explicit parent
 * lineage; names and handles never participate in grouping.
 *
 * @param {unknown} values
 * @param {ActorFold} fold
 * @returns {Map<string, AgentwatchRuntimeSession[]>}
 */
function groupRuntimePresence(values, fold) {
  /** @type {Map<string, Map<string, any>>} */
  const grouped = new Map();
  if (!Array.isArray(values)) {
    return /** @type {Map<string, AgentwatchRuntimeSession[]>} */ (new Map());
  }

  for (const value of values) {
    const row = mapRuntimePresenceRow(value);
    if (!row) {
      continue;
    }
    const actor = fold(row.actor);
    let actor_groups = grouped.get(actor);
    if (!actor_groups) {
      actor_groups = new Map();
      grouped.set(actor, actor_groups);
    }
    const session_key = `${row.session_id}\u0000${row.runtime_id}`;
    let session = actor_groups.get(session_key);
    if (!session) {
      session = {
        session_id: row.session_id,
        runtime_id: row.runtime_id,
        last_seen: 0,
        main: null,
        subagents: new Map()
      };
      actor_groups.set(session_key, session);
    }
    session.last_seen = Math.max(
      session.last_seen,
      row.public_row.heartbeat_at
    );
    if (row.kind === 'main') {
      session.main = newestRuntimeRow(session.main, row);
    } else {
      const previous = session.subagents.get(row.public_row.run_id);
      session.subagents.set(
        row.public_row.run_id,
        newestRuntimeRow(previous, row)
      );
    }
  }

  /** @type {Map<string, AgentwatchRuntimeSession[]>} */
  const result = new Map();
  for (const [actor, actor_groups] of grouped) {
    const sessions = Array.from(actor_groups.values()).map((session) => ({
      session_id: session.session_id,
      runtime_id: session.runtime_id,
      last_seen: session.last_seen,
      main: session.main?.public_row || null,
      subagents: Array.from(session.subagents.values())
        .map((row) => row.public_row)
        .sort(compareRuntimeChildren)
    }));
    sessions.sort((left_session, right_session) => {
      if (left_session.last_seen !== right_session.last_seen) {
        return right_session.last_seen - left_session.last_seen;
      }
      if (left_session.runtime_id !== right_session.runtime_id) {
        return left_session.runtime_id < right_session.runtime_id ? -1 : 1;
      }
      return left_session.session_id < right_session.session_id ? -1 : 1;
    });
    result.set(actor, sessions);
  }
  return result;
}

/**
 * Merge runtime sessions into actor lanes while preserving the legacy shape for
 * actors with no valid runtime rows.
 *
 * @param {AgentwatchAgent[]} agents
 * @param {unknown} values
 * @param {ActorFold} fold
 * @returns {AgentwatchAgent[]}
 */
function mergeRuntimePresence(agents, values, fold) {
  const grouped = groupRuntimePresence(values, fold);
  if (grouped.size === 0) {
    return agents;
  }
  const lanes_by_actor = new Map(agents.map((agent) => [agent.actor, agent]));
  for (const [actor, runtime_sessions] of grouped) {
    const lane = lanes_by_actor.get(actor);
    if (lane) {
      lane.runtime_sessions = runtime_sessions;
      lane.last_seen = Math.max(
        lane.last_seen,
        ...runtime_sessions.map((session) => session.last_seen)
      );
      continue;
    }
    const last_seen = Math.max(
      ...runtime_sessions.map((session) => session.last_seen)
    );
    const runtime_lane = {
      actor,
      item_count: 0,
      latest_activity: 0,
      last_seen,
      flare: null,
      issues: [],
      runtime_sessions
    };
    lanes_by_actor.set(actor, runtime_lane);
    agents.push(runtime_lane);
  }
  return agents;
}

/**
 * Map one registered-agent row from the registry roster. Only the fields that
 * belong in the public snapshot survive; everything else (tokens, hosts,
 * workspace paths) never crosses this boundary.
 *
 * @param {unknown} value - Raw registry agent row.
 * @returns {{ actor: string, display_name: string, kind: string, last_seen_at: number } | null}
 */
function mapRosterRow(value) {
  if (!isRecord(value)) {
    return null;
  }
  const actor = textValue(value.actor).trim();
  if (actor.length === 0) {
    return null;
  }
  const kind = textValue(value.kind);
  return {
    actor,
    display_name: textValue(value.display_name).trim(),
    kind: kind === 'human' ? 'human' : 'agent',
    last_seen_at: epochMilliseconds(value.last_seen_at)
  };
}

/**
 * Fold the registered roster into the agent lanes so every registered actor is
 * always on the wall, active or not. An actor already grouped from issues,
 * flares, or runtime presence is only annotated; an actor with no activity at
 * all becomes an empty lane whose recency is the registry's last-seen moment.
 * The roster is advisory like flares: it adds lanes, it never removes any.
 *
 * In accounts mode a person's alias agent rows fold into the person's lane; the
 * person's own row names it whenever it has a display name.
 *
 * @param {AgentwatchAgent[]} agents - Lanes grouped so far.
 * @param {unknown[]} roster_values - Raw registry agent rows.
 * @param {ActorFold} fold
 * @returns {{ agents: AgentwatchAgent[], registered_count: number }}
 */
function mergeRoster(agents, roster_values, fold) {
  /** @type {Map<string, { actor: string, display_name: string, kind: string, last_seen_at: number, aliased: boolean }>} */
  const roster = new Map();
  for (const value of roster_values) {
    const mapped = mapRosterRow(value);
    if (mapped === null) {
      continue;
    }
    const actor = fold(mapped.actor);
    const row = { ...mapped, actor, aliased: actor !== mapped.actor };
    const existing = roster.get(row.actor);
    if (!existing) {
      roster.set(row.actor, row);
      continue;
    }
    // The same actor registered on several boards is one person or agent.
    existing.last_seen_at = Math.max(existing.last_seen_at, row.last_seen_at);
    if (
      existing.display_name.length === 0 ||
      (existing.aliased && !row.aliased && row.display_name.length > 0)
    ) {
      existing.display_name = row.display_name;
      existing.aliased = row.aliased;
    }
    if (row.kind === 'human') {
      existing.kind = 'human';
    }
  }
  if (roster.size === 0) {
    return { agents, registered_count: 0 };
  }
  const lanes_by_actor = new Map(agents.map((agent) => [agent.actor, agent]));
  for (const row of roster.values()) {
    const lane = lanes_by_actor.get(row.actor);
    if (lane) {
      lane.registered = true;
      lane.kind = row.kind;
      if (!lane.display_name && row.display_name.length > 0) {
        lane.display_name = row.display_name;
      }
      lane.last_seen = Math.max(lane.last_seen, row.last_seen_at);
      continue;
    }
    /** @type {AgentwatchAgent} */
    const roster_lane = {
      actor: row.actor,
      item_count: 0,
      latest_activity: 0,
      last_seen: row.last_seen_at,
      flare: null,
      issues: [],
      registered: true,
      kind: row.kind
    };
    if (row.display_name.length > 0) {
      roster_lane.display_name = row.display_name;
    }
    lanes_by_actor.set(row.actor, roster_lane);
    agents.push(roster_lane);
  }
  return { agents, registered_count: roster.size };
}

/**
 * Map a participant from the JSON aggregate and discard malformed blank actors.
 *
 * @param {unknown} value - Aggregate participant value.
 * @returns {AgentwatchParticipant | null}
 */
function mapParticipant(value) {
  if (!isRecord(value)) {
    return null;
  }
  const actor = textValue(value.actor).trim();
  if (actor.length === 0) {
    return null;
  }
  return {
    actor,
    comment_count: nonNegativeInteger(value.comment_count),
    last_commented_at: epochMilliseconds(value.last_commented_at)
  };
}

/**
 * Map one shared-discussion row and keep only its latest comment.
 *
 * @param {Record<string, unknown>} row - Grouped discussion row.
 * @returns {AgentwatchDiscussion} Normalized public row.
 */
function mapDiscussion(row) {
  const participant_values = Array.isArray(row.participants)
    ? row.participants
    : [];
  const participants = participant_values
    .map(mapParticipant)
    .filter((participant) => participant !== null);
  participants.sort((left_participant, right_participant) =>
    left_participant.actor < right_participant.actor
      ? -1
      : left_participant.actor > right_participant.actor
        ? 1
        : 0
  );

  const latest_value = isRecord(row.latest_comment) ? row.latest_comment : {};
  return {
    id: textValue(row.id),
    board_id: textValue(row.board_id),
    title: textValue(row.title),
    status: textValue(row.status),
    priority: nonNegativeInteger(row.priority),
    issue_type: textValue(row.issue_type),
    updated_at: epochMilliseconds(row.updated_at),
    comment_count: nonNegativeInteger(row.comment_count),
    participants,
    latest_comment: {
      author: textValue(latest_value.author),
      body: textValue(latest_value.body),
      created_at: epochMilliseconds(latest_value.created_at)
    }
  };
}

/**
 * @param {AgentwatchAgent} agent
 * @returns {boolean}
 */
function agentHasActivePresence(agent) {
  if (agent.item_count > 0) {
    return true;
  }
  if (
    agent.flare &&
    (agent.flare.liveness === 'live' || agent.flare.liveness === 'fading')
  ) {
    return true;
  }
  return (
    agent.runtime_sessions?.some((session) => {
      const rows = [
        ...(session.main ? [session.main] : []),
        ...session.subagents
      ];
      return rows.some((row) => !TERMINAL_RUNTIME_STATUSES.has(row.status));
    }) || false
  );
}

/**
 * Fetch the bounded Agentwatch snapshot from a Postgres-backed store.
 *
 * Accounts mode passes `aliases` (lower-cased alias → canonical person actor):
 * every alias actor in issues, counts, flares, runtime presence and the roster
 * then folds into its person's lane before lanes merge. Without it (accounts
 * off, silos) every actor is its own lane exactly as before.
 *
 * @param {AgentwatchStore} store - Store exposing a node-postgres-style query.
 * @param {{ generated_at?: number, flares?: unknown[], runtime_presence?: unknown[], roster?: unknown[], presence_errors?: unknown[], aliases?: Map<string, string> | null }} [options] - Clock override, advisory registry presence to merge as heartbeats, the registered-agent roster, recent rejected runtime heartbeats, and the accounts-mode alias fold.
 * @returns {Promise<AgentwatchSnapshot>}
 */
export async function fetchAgentwatchSnapshot(store, options = {}) {
  const generated_at =
    typeof options.generated_at === 'number' &&
    Number.isFinite(options.generated_at)
      ? options.generated_at
      : Date.now();
  const [active_result, count_result, discussion_result] = await Promise.all([
    store.query(ACTIVE_SNAPSHOT_SQL, [ACTIVE_ISSUE_LIMIT]),
    store.query(ACTIVE_COUNTS_SQL),
    store.query(SHARED_DISCUSSIONS_SQL, [SHARED_DISCUSSION_LIMIT])
  ]);

  const { fold, absorbed } = createActorFold(options.aliases);
  const { agents: roster_agents, registered_count } = mergeRoster(
    mergeRuntimePresence(
      mergeFlares(
        mergeActiveCounts(
          foldActiveLanes(queryRows(active_result).map(mapAgent), fold),
          queryRows(count_result),
          fold
        ),
        Array.isArray(options.flares) ? options.flares : [],
        fold
      ),
      Array.isArray(options.runtime_presence) ? options.runtime_presence : [],
      fold
    ),
    Array.isArray(options.roster) ? options.roster : [],
    fold
  );
  const agents = attachAliases(
    mergePresenceErrors(roster_agents, options.presence_errors, fold),
    absorbed
  );
  agents.sort((left_agent, right_agent) =>
    compareTimestampDescending(
      left_agent.last_seen,
      right_agent.last_seen,
      left_agent.actor,
      right_agent.actor
    )
  );

  const discussions = queryRows(discussion_result).map(mapDiscussion);
  discussions.sort((left_discussion, right_discussion) =>
    compareTimestampDescending(
      left_discussion.latest_comment.created_at,
      right_discussion.latest_comment.created_at,
      left_discussion.id,
      right_discussion.id
    )
  );

  const active_issues = agents.reduce(
    (total, agent) => total + agent.item_count,
    0
  );
  return {
    generated_at,
    stats: {
      active_agents: agents.filter(agentHasActivePresence).length,
      registered_agents: registered_count,
      active_issues,
      shared_discussions: discussions.length
    },
    agents,
    discussions
  };
}
