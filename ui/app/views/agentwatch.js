import { html, render } from 'lit-html';
import {
  actorLabel,
  ownerOf,
  serviceOf,
  serviceTitle
} from '../utils/owners.js';

/**
 * @typedef {Record<string, any>} AgentwatchObject
 */

/**
 * @typedef {Object} AgentwatchPayload
 * @property {unknown} generated_at
 * @property {AgentwatchObject} stats
 * @property {any[]} agents
 * @property {any[]} discussions
 */

/**
 * @typedef {AgentwatchObject} RuntimePresenceRow
 */

/**
 * @typedef {AgentwatchObject} RuntimeSession
 */

/**
 * @typedef {Object} AgentwatchClient
 * @property {(event_name: 'agentwatch', handler: (payload: any) => void) => (() => void) | void} on
 */

/**
 * @typedef {Object} AgentwatchOptions
 * @property {(type: 'watch-agentwatch' | 'unwatch-agentwatch', payload?: unknown) => Promise<any>} send
 * @property {AgentwatchClient} client
 * @property {(issue_id: string) => void} [gotoIssue]
 * @property {() => boolean} [isActive]
 */

const TAB_IDS = ['active', 'discussions'];
const VIEW_MODES = ['compact', 'detail'];
const MODE_STORAGE_KEY = 'feads.agentwatch.mode';
const STALE_AFTER_MS = 45_000;
const UPDATE_FLASH_MS = 360;
const BUMP_FLASH_MS = 1_400;
const AGE_TICK_MS = 15_000;

// Recency tiers: how long ago an agent last touched anything.
const HOT_MS = 5 * 60_000;
const WARM_MS = 30 * 60_000;
const COOL_MS = 2 * 3_600_000;
const RUNTIME_LIVENESS = ['live', 'fading', 'terminal'];

/**
 * Whether a value is a non-null object that can be read as a record.
 *
 * @param {unknown} value
 * @returns {value is AgentwatchObject}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return the first present field from a record.
 *
 * @param {unknown} value
 * @param {string[]} names
 * @returns {unknown}
 */
function readField(value, names) {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) {
      return value[name];
    }
  }
  return undefined;
}

/**
 * Read a human-facing string without trusting server content as markup.
 *
 * @param {unknown} value
 * @param {string[]} names
 * @param {string} [fallback]
 * @returns {string}
 */
function readText(value, names, fallback = '') {
  const candidate = readField(value, names);
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate;
  }
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return String(candidate);
  }
  return fallback;
}

/**
 * Convert a timestamp in ISO, epoch seconds, or epoch milliseconds into epoch
 * milliseconds.
 *
 * @param {unknown} value
 * @returns {number}
 */
function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Format a timestamp as a coarse relative age appropriate for a live dashboard.
 *
 * @param {unknown} value
 * @param {number} [now]
 * @returns {string}
 */
function relativeAge(value, now = Date.now()) {
  const timestamp = timestampMs(value);
  if (timestamp === 0) {
    return 'time unavailable';
  }
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Format a timestamp as the tightest possible age for a data pill.
 *
 * @param {unknown} value
 * @param {number} [now]
 * @returns {string}
 */
function shortAge(value, now = Date.now()) {
  const timestamp = timestampMs(value);
  if (timestamp === 0) {
    return '';
  }
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) {
    return 'now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Format a server count while preserving a server-provided string when it is
 * already compacted for display.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function formatCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return null;
}

/**
 * Read a count from the server stats without deriving it from another list.
 *
 * @param {AgentwatchObject} stats
 * @param {string[]} names
 * @returns {string | null}
 */
function readCount(stats, names) {
  for (const name of names) {
    const count = formatCount(stats[name]);
    if (count !== null) {
      return count;
    }
  }
  return null;
}

/**
 * Read an actor identity without coercing malformed values into a display label.
 * The canonical actor field wins when it is present; legacy handle/id fields are
 * accepted only when actor is absent.
 *
 * @param {unknown} value
 * @returns {string}
 */
function actorHandle(value) {
  if (!isRecord(value)) {
    return '';
  }
  if (Object.prototype.hasOwnProperty.call(value, 'actor')) {
    return typeof value.actor === 'string' ? value.actor.trim() : '';
  }
  for (const name of ['handle', 'agent_id']) {
    const candidate = value[name];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return '';
}

/**
 * Normalize one runtime row at the browser boundary. Runtime rows must carry
 * enough identity and liveness data to be rendered as real presence; otherwise
 * they are ignored instead of becoming an unnamed placeholder row.
 *
 * @param {unknown} value
 * @returns {AgentwatchObject | null}
 */
function normalizeRuntimeRow(value) {
  if (!isRecord(value)) {
    return null;
  }
  const run_id = readField(value, ['run_id']);
  const status = readField(value, ['status']);
  const liveness = readField(value, ['liveness']);
  const run_id_text = typeof run_id === 'string' ? run_id.trim() : '';
  const status_text = typeof status === 'string' ? status.trim() : '';
  const liveness_text =
    typeof liveness === 'string' ? liveness.trim().toLowerCase() : '';
  const required_text_fields = [
    run_id,
    status,
    liveness,
    readField(value, ['handle']),
    readField(value, ['display_name']),
    readField(value, ['model']),
    readField(value, ['activity'])
  ];
  if (
    required_text_fields.some((field) => typeof field !== 'string') ||
    run_id_text.length === 0 ||
    status_text.length === 0 ||
    !RUNTIME_LIVENESS.includes(liveness_text)
  ) {
    return null;
  }
  const context_percent = readField(value, ['context_percent']);
  if (
    typeof context_percent !== 'number' ||
    !Number.isFinite(context_percent)
  ) {
    return null;
  }
  if (timestampMs(readField(value, ['heartbeat_at'])) <= 0) {
    return null;
  }
  return value;
}

/**
 * Normalize one grouped runtime session and discard empty or unidentified
 * sessions. A child-only session remains valid when it contains a real child
 * row and a runtime/session identifier.
 *
 * @param {unknown} value
 * @returns {RuntimeSession | null}
 */
function normalizeRuntimeSession(value) {
  if (!isRecord(value)) {
    return null;
  }
  const runtime_id = readText(value, ['runtime_id'], '').trim();
  const session_id = readText(value, ['session_id'], '').trim();
  if (runtime_id.length === 0 && session_id.length === 0) {
    return null;
  }
  const main = normalizeRuntimeRow(readField(value, ['main']));
  const raw_subagents = readField(value, ['subagents']);
  const subagents = Array.isArray(raw_subagents)
    ? raw_subagents.map(normalizeRuntimeRow).filter(isRecord)
    : [];
  if (main === null && subagents.length === 0) {
    return null;
  }
  return {
    ...value,
    session_id: session_id || runtime_id,
    runtime_id: runtime_id || session_id,
    main,
    subagents
  };
}

/**
 * Normalize one agent lane. A lane needs a real actor identity; malformed
 * lanes are dropped while roster-only lanes with valid actor names remain.
 *
 * @param {unknown} value
 * @returns {AgentwatchObject | null}
 */
function normalizeAgent(value) {
  const handle = actorHandle(value);
  if (handle.length === 0 || !isRecord(value)) {
    return null;
  }
  const raw_sessions = readField(value, ['runtime_sessions']);
  const runtime_sessions = Array.isArray(raw_sessions)
    ? raw_sessions.map(normalizeRuntimeSession).filter(isRecord)
    : [];
  return {
    ...value,
    actor: handle,
    ...(Array.isArray(raw_sessions) ? { runtime_sessions } : {})
  };
}

/**
 * Normalize one discussion row. A discussion without an issue identity and
 * title cannot be opened or understood, so it is omitted instead of rendering
 * an empty row with fallback labels.
 *
 * @param {unknown} value
 * @returns {AgentwatchObject | null}
 */
function normalizeDiscussion(value) {
  if (!isRecord(value)) {
    return null;
  }
  const id = issueId(value);
  const title = readText(value, ['title', 'issue_title', 'name'], '').trim();
  return id.length > 0 && title.length > 0 ? value : null;
}

/**
 * Normalize the response envelope while keeping the server's group and row
 * order intact. No agent or discussion grouping happens in the client.
 *
 * @param {unknown} value
 * @returns {AgentwatchPayload | null}
 */
function normalizePayload(value) {
  if (!isRecord(value)) {
    return null;
  }
  return {
    generated_at: value.generated_at,
    stats: isRecord(value.stats) ? value.stats : {},
    agents: Array.isArray(value.agents)
      ? value.agents.map(normalizeAgent).filter(isRecord)
      : [],
    discussions: Array.isArray(value.discussions)
      ? value.discussions.map(normalizeDiscussion).filter(isRecord)
      : []
  };
}

/**
 * Choose the runtime sessions that the server attached to one agent lane.
 * The server owns grouping and order; malformed session values are ignored
 * without changing the surrounding issue lane.
 *
 * @param {unknown} agent
 * @returns {RuntimeSession[]}
 */
function agentRuntimeSessions(agent) {
  const sessions = readField(agent, ['runtime_sessions']);
  return Array.isArray(sessions)
    ? sessions.map(normalizeRuntimeSession).filter(isRecord)
    : [];
}

/**
 * Read the main row and child rows from one server-grouped runtime session.
 * This is a projection helper only: it never moves a row between sessions.
 *
 * @param {RuntimeSession} session
 * @returns {RuntimePresenceRow[]}
 */
function runtimeSessionRows(session) {
  /** @type {RuntimePresenceRow[]} */
  const rows = [];
  const main = readField(session, ['main']);
  if (isRecord(main)) {
    rows.push(main);
  }
  const subagents = readField(session, ['subagents']);
  if (Array.isArray(subagents)) {
    for (const subagent of subagents) {
      if (isRecord(subagent)) {
        rows.push(subagent);
      }
    }
  }
  return rows;
}

/**
 * Return the short opaque identifier shown beside a runtime session name.
 *
 * @param {unknown} value
 * @returns {string}
 */
function shortIdentifier(value) {
  const identifier =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : '';
  if (identifier.length <= 10) {
    return identifier;
  }
  return `${identifier.slice(0, 4)}…${identifier.slice(-4)}`;
}

/**
 * Read one runtime status into the fixed public status vocabulary.
 *
 * @param {unknown} row
 * @returns {'working'|'idle'|'done'|'failed'|'aborted'|'unknown'}
 */
function runtimeStatus(row) {
  const status = readText(row, ['status'], 'unknown').trim().toLowerCase();
  const statuses = ['working', 'idle', 'done', 'failed', 'aborted', 'unknown'];
  return statuses.includes(status)
    ? /** @type {'working'|'idle'|'done'|'failed'|'aborted'|'unknown'} */ (
        status
      )
    : 'unknown';
}

/**
 * Return true when a runtime row is terminal and cannot become active again.
 *
 * @param {unknown} row
 * @returns {boolean}
 */
function isTerminalRuntimeRow(row) {
  return ['done', 'failed', 'aborted'].includes(runtimeStatus(row));
}

/**
 * Return true when the server marks a non-terminal runtime row live or fading.
 *
 * @param {unknown} row
 * @returns {boolean}
 */
function isLiveRuntimeRow(row) {
  if (isTerminalRuntimeRow(row)) {
    return false;
  }
  const liveness = readText(row, ['liveness'], '').trim().toLowerCase();
  return liveness === 'live' || liveness === 'fading';
}

/**
 * Return true when a lane has a non-terminal runtime row with server liveness.
 *
 * @param {unknown} agent
 * @returns {boolean}
 */
function hasLiveRuntime(agent) {
  return agentRuntimeSessions(agent).some((session) =>
    runtimeSessionRows(session).some(isLiveRuntimeRow)
  );
}

/**
 * Return true when runtime presence is the only activity in a lane and all
 * reported runtime rows are terminal. Such a lane is recent history, not live
 * work, even when its heartbeat is only a few seconds old.
 *
 * @param {unknown} agent
 * @returns {boolean}
 */
function hasTerminalOnlyRuntimeHistory(agent) {
  const sessions = agentRuntimeSessions(agent);
  const rows = sessions.flatMap(runtimeSessionRows);
  return (
    sessions.length > 0 &&
    rows.length > 0 &&
    rows.every(isTerminalRuntimeRow) &&
    agentIssues(agent).length === 0 &&
    !isRecord(readField(agent, ['flare']))
  );
}

/**
 * Read the runtime incarnation identifier, preferring the server's runtime id
 * and falling back to the resumable session id only when needed.
 *
 * @param {RuntimeSession} session
 * @returns {string}
 */
function runtimeSessionIdentifier(session) {
  return (
    readText(session, ['runtime_id'], '') ||
    readText(session, ['session_id'], '')
  );
}

/**
 * Return the display name for one server-grouped runtime session.
 *
 * @param {RuntimeSession} session
 * @returns {string}
 */
function runtimeSessionName(session) {
  const main = readField(session, ['main']);
  const display_name = readText(main, ['display_name'], '');
  if (display_name.length > 0) {
    return display_name;
  }
  const identifier = runtimeSessionIdentifier(session);
  return identifier.length > 0
    ? `agent · ${shortIdentifier(identifier)}`
    : 'agent session';
}

/**
 * Read a bounded context percentage for display without trusting malformed
 * values as markup or an unbounded number.
 *
 * @param {unknown} row
 * @returns {string}
 */
function runtimeContextLabel(row) {
  const value = readField(row, ['context_percent']);
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return 'Context unavailable';
  }
  return `${Math.round(Math.min(100, Math.max(0, numeric)))}% ctx`;
}

/**
 * Format elapsed runtime from the server-provided start and terminal times.
 *
 * @param {unknown} row
 * @param {number} now
 * @returns {string}
 */
function runtimeElapsed(row, now) {
  const started_at = timestampMs(readField(row, ['started_at']));
  if (started_at === 0) {
    return 'Elapsed unavailable';
  }
  const ended_at = timestampMs(readField(row, ['ended_at']));
  const elapsed_seconds = Math.max(
    0,
    Math.floor(((ended_at > 0 ? ended_at : now) - started_at) / 1000)
  );
  if (elapsed_seconds < 60) {
    return `${elapsed_seconds}s elapsed`;
  }
  const minutes = Math.floor(elapsed_seconds / 60);
  if (minutes < 60) {
    return `${minutes}m elapsed`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m elapsed`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h elapsed`;
}

/**
 * Format the server heartbeat freshness for a runtime row.
 *
 * @param {unknown} row
 * @param {number} now
 * @returns {string}
 */
function runtimeFreshness(row, now) {
  const liveness = readText(row, ['liveness'], '').trim().toLowerCase();
  if (liveness === 'live') {
    return 'Live';
  }
  if (liveness === 'fading') {
    return 'Fading';
  }
  const heartbeat_at = readField(row, ['heartbeat_at']);
  return timestampMs(heartbeat_at) > 0
    ? relativeAge(heartbeat_at, now)
    : 'Freshness unavailable';
}

/**
 * Choose the recency label for an agent's principal heartbeat. Runtime-only
 * terminal history deliberately takes the recent-but-not-active path.
 *
 * @param {unknown} agent
 * @param {number} now
 * @returns {{ tier: 'now'|'warm'|'cool'|'idle', label: string, seen: number }}
 */
function runtimeAwareBeatInfo(agent, now) {
  const runtime_sessions = agentRuntimeSessions(agent);
  const runtime_only_terminal = hasTerminalOnlyRuntimeHistory(agent);
  if (hasLiveRuntime(agent)) {
    return { tier: 'now', label: 'Active now', seen: agentLastSeen(agent) };
  }
  if (!runtime_only_terminal || runtime_sessions.length === 0) {
    return beatInfo(agent, now);
  }
  const seen = agentLastSeen(agent);
  if (seen === 0) {
    return { tier: 'idle', label: 'completed activity', seen };
  }
  const age = now - seen;
  if (age <= HOT_MS) {
    return { tier: 'warm', label: 'Completed recently', seen };
  }
  if (age <= WARM_MS) {
    return { tier: 'warm', label: relativeAge(seen, now), seen };
  }
  if (age <= COOL_MS) {
    return { tier: 'cool', label: relativeAge(seen, now), seen };
  }
  return { tier: 'idle', label: relativeAge(seen, now), seen };
}

/**
 * Summarize one agent's live runtime footprint for the compact card: how many
 * agent sessions and subagents are live right now, plus the newest live activity
 * text. Terminal rows deliberately do not count or speak.
 *
 * @param {unknown} agent
 * @returns {{ live_sessions: number, live_subagents: number, activity: string }}
 */
function compactSummary(agent) {
  let live_sessions = 0;
  let live_subagents = 0;
  let activity = '';
  let activity_at = 0;
  for (const session of agentRuntimeSessions(agent)) {
    const main = readField(session, ['main']);
    if (isRecord(main) && isLiveRuntimeRow(main)) {
      live_sessions += 1;
    }
    const subagents = readField(session, ['subagents']);
    if (Array.isArray(subagents)) {
      for (const subagent of subagents) {
        if (isRecord(subagent) && isLiveRuntimeRow(subagent)) {
          live_subagents += 1;
        }
      }
    }
    for (const row of runtimeSessionRows(session)) {
      if (!isLiveRuntimeRow(row)) {
        continue;
      }
      const beat_at = timestampMs(readField(row, ['heartbeat_at']));
      const text = readText(row, ['activity'], '');
      if (text.length > 0 && beat_at >= activity_at) {
        activity_at = beat_at;
        activity = text;
      }
    }
  }
  return { live_sessions, live_subagents, activity };
}

/**
 * Project each runtime session into one compact-card line: session name, the
 * main status, whether anything in it is live, its newest live activity, and
 * the main context label. Live sessions sort first, preserving server order
 * within each group.
 *
 * @param {unknown} agent
 * @returns {{ name: string, status: string, live: boolean, activity: string, context: string }[]}
 */
function compactSessionSummaries(agent) {
  /** @type {{ name: string, status: string, live: boolean, activity: string, context: string }[]} */
  const summaries = [];
  for (const session of agentRuntimeSessions(agent)) {
    const rows = runtimeSessionRows(session);
    if (rows.length === 0) {
      continue;
    }
    const main = readField(session, ['main']);
    let activity = '';
    let activity_at = 0;
    for (const row of rows) {
      if (!isLiveRuntimeRow(row)) {
        continue;
      }
      const text = readText(row, ['activity'], '');
      const beat_at = timestampMs(readField(row, ['heartbeat_at']));
      if (text.length > 0 && beat_at >= activity_at) {
        activity_at = beat_at;
        activity = text;
      }
    }
    if (activity.length === 0) {
      activity = readText(main, ['activity'], '');
    }
    const status_row = isRecord(main) ? main : rows[0];
    const context = runtimeContextLabel(status_row);
    summaries.push({
      name: runtimeSessionName(session),
      status: runtimeStatus(status_row),
      live: rows.some(isLiveRuntimeRow),
      activity,
      context: context === 'Context unavailable' ? '' : context
    });
  }
  summaries.sort(
    (left_session, right_session) =>
      Number(right_session.live) - Number(left_session.live)
  );
  return summaries;
}

/**
 * Choose the issue list that the server attached to one agent lane.
 *
 * @param {unknown} agent
 * @returns {any[]}
 */
function agentIssues(agent) {
  const candidates = ['issues', 'active_issues', 'work', 'active_work'];
  for (const name of candidates) {
    const value = readField(agent, [name]);
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

/**
 * The alias actors the server folded into this lane (accounts mode).
 *
 * @param {unknown} agent
 * @returns {string[]}
 */
function agentAliases(agent) {
  const value = readField(agent, ['aliases']);
  return Array.isArray(value)
    ? value.filter(
        (alias) => typeof alias === 'string' && alias.trim().length > 0
      )
    : [];
}

/**
 * Read the display identity for an agent lane.
 *
 * Accounts mode: the server folds a person's aliases into the person's lane, so
 * a lane's actor is already the person's (`aliases` lists what it absorbed and
 * the handle tooltip names them). A lane the server did not fold — a service
 * account's alias, a snapshot without the fold — is still named as its owner
 * (`alex`, handle line `via alex-laptop`); `handle` stays the lane's
 * actor — it keys the lane, the modal and the bump animation.
 *
 * A service account (botty1, sample-service-agent) is labelled `service`, with its
 * steward in the badge's tooltip.
 *
 * @param {unknown} agent
 * @returns {{ name: string, handle: string, initials: string, handle_label: string, handle_title: string, aliases: string[], service_title: string }}
 */
function agentIdentity(agent) {
  const handle = actorHandle(agent);
  const service = serviceOf(handle);
  const aliases = agentAliases(agent);
  // A folded lane is keyed by its person, never by an alias: no second fold.
  const owner = aliases.length > 0 ? null : ownerOf(handle);
  const name = owner
    ? owner.display_name || owner.actor
    : readText(agent, ['display_name', 'name', 'label'], handle);
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials =
    words.length > 1
      ? `${words[0][0]}${words[words.length - 1][0]}`
      : name.slice(0, 2);
  return {
    name,
    handle,
    initials: initials.toUpperCase(),
    handle_label: owner ? `via ${handle}` : handle,
    handle_title:
      aliases.length > 0 ? `${handle} · also as ${aliases.join(', ')}` : handle,
    aliases,
    service_title: service ? serviceTitle(service) : ''
  };
}

/**
 * The one restrained line for a lane whose recent runtime heartbeats were
 * rejected (`presence_error`), e.g. `Heartbeats rejected · 400 bad_request ·
 * 3m ago`; '' when there is none.
 *
 * @param {unknown} agent
 * @param {number} now
 * @returns {string}
 */
function presenceErrorLine(agent, now) {
  const presence_error = readField(agent, ['presence_error']);
  if (!isRecord(presence_error)) {
    return '';
  }
  const at = timestampMs(readField(presence_error, ['at']));
  const status = readText(presence_error, ['status'], '');
  if (at === 0 || status.length === 0) {
    return '';
  }
  const error = readText(presence_error, ['error'], '');
  return `Heartbeats rejected · ${error.length > 0 ? `${status} ${error}` : status} · ${relativeAge(at, now)}`;
}

/**
 * The `service` badge after an Agentwatch name, or nothing for a person.
 *
 * @param {{ service_title: string }} identity
 */
function serviceBadge(identity) {
  return identity.service_title
    ? html` <span
        class="kind-badge kind-badge--service"
        title=${identity.service_title}
        >service</span
      >`
    : '';
}

/**
 * The moment an agent last touched anything: the server's merged heartbeat,
 * runtime heartbeat, or newest issue write grouped into the lane.
 *
 * @param {unknown} agent
 * @returns {number}
 */
function agentLastSeen(agent) {
  const flare = readField(agent, ['flare']);
  let seen = Math.max(
    timestampMs(readField(agent, ['last_seen'])),
    timestampMs(readField(agent, ['latest_activity'])),
    timestampMs(readField(flare, ['heartbeat_at']))
  );
  for (const session of agentRuntimeSessions(agent)) {
    seen = Math.max(seen, timestampMs(readField(session, ['last_seen'])));
    for (const row of runtimeSessionRows(session)) {
      seen = Math.max(seen, timestampMs(readField(row, ['heartbeat_at'])));
    }
  }
  if (seen === 0) {
    for (const issue of agentIssues(agent)) {
      seen = Math.max(seen, timestampMs(readField(issue, ['updated_at'])));
    }
  }
  return seen;
}

/**
 * Map an agent's heartbeat onto a small set of recency tiers. A live or
 * fading flare is an explicit "working right now" signal and always wins.
 *
 * @param {unknown} agent
 * @param {number} now
 * @returns {{ tier: 'now'|'warm'|'cool'|'idle', label: string, seen: number }}
 */
function beatInfo(agent, now) {
  const seen = agentLastSeen(agent);
  const liveness = readText(readField(agent, ['flare']), ['liveness'], '');
  if (liveness === 'live' || liveness === 'fading') {
    return { tier: 'now', label: 'Active now', seen };
  }
  if (seen === 0) {
    return { tier: 'idle', label: 'quiet', seen };
  }
  const age = now - seen;
  if (age <= HOT_MS) {
    return { tier: 'now', label: 'Active now', seen };
  }
  const label = relativeAge(seen, now);
  if (age <= WARM_MS) {
    return { tier: 'warm', label, seen };
  }
  if (age <= COOL_MS) {
    return { tier: 'cool', label, seen };
  }
  return { tier: 'idle', label, seen };
}

/**
 * Read an issue identifier, including the nested issue form used by some
 * server responses.
 *
 * @param {unknown} issue
 * @returns {string}
 */
function issueId(issue) {
  const direct = readText(issue, ['issue_id', 'id', 'key'], '');
  if (direct.length > 0) {
    return direct;
  }
  const nested = readField(issue, ['issue']);
  return readText(nested, ['issue_id', 'id', 'key'], '');
}

/**
 * Read an issue title without altering the server's text.
 *
 * @param {unknown} issue
 * @returns {string}
 */
function issueTitle(issue) {
  const title = readText(issue, ['title', 'issue_title', 'name'], '');
  if (title.length > 0) {
    return title;
  }
  const nested = readField(issue, ['issue']);
  return readText(nested, ['title', 'issue_title', 'name'], 'Untitled issue');
}

/**
 * Read the board identifier attached to an issue or discussion.
 *
 * @param {unknown} value
 * @returns {string}
 */
function boardId(value) {
  const direct = readText(value, ['board_id', 'board_name'], '');
  if (direct.length > 0) {
    return direct;
  }
  const board = readField(value, ['board']);
  return readText(board, ['id', 'name', 'key'], 'board unavailable');
}

/**
 * Read a priority label, keeping priority quiet beside title and recency.
 *
 * @param {unknown} issue
 * @returns {string}
 */
function issuePriority(issue) {
  const priority = readField(issue, ['priority', 'priority_level']);
  if (typeof priority === 'number' && Number.isFinite(priority)) {
    return `P${priority}`;
  }
  if (typeof priority === 'string' && priority.trim().length > 0) {
    return priority.startsWith('P') ? priority : `P${priority}`;
  }
  return '';
}

/**
 * Normalize one discussion participant label and its server-provided comment
 * count.
 *
 * @param {unknown} participant
 * @returns {{ label: string, count: string | null }}
 */
function participantDetail(participant) {
  // Accounts mode: an alias participant is named as its person.
  const raw_actor =
    typeof participant === 'string'
      ? participant
      : readText(participant, ['actor'], '');
  const label = ownerOf(raw_actor)
    ? actorLabel(raw_actor)
    : typeof participant === 'string'
      ? participant
      : readText(participant, ['display_name', 'actor', 'name', 'label'], '');
  return {
    label,
    count: formatCount(readField(participant, ['comment_count', 'comments']))
  };
}

/**
 * Read the participant labels and counts supplied by the server.
 *
 * @param {unknown} discussion
 * @returns {{ details: { label: string, count: string | null }[], count: number | null }}
 */
function discussionParticipants(discussion) {
  const raw = readField(discussion, [
    'participants',
    'participant_labels',
    'participant_actors'
  ]);
  const details = Array.isArray(raw)
    ? raw.map(participantDetail).filter((detail) => detail.label.length > 0)
    : [];
  const count_value = readField(discussion, [
    'participant_count',
    'participants_count'
  ]);
  const count =
    typeof count_value === 'number' && Number.isFinite(count_value)
      ? count_value
      : details.length > 0
        ? details.length
        : null;
  return { details, count };
}

/**
 * Read the number of comments attached to a discussion.
 *
 * @param {unknown} discussion
 * @returns {string}
 */
function discussionCommentCount(discussion) {
  const direct = formatCount(
    readField(discussion, ['comment_count', 'comments_count'])
  );
  if (direct !== null) {
    return direct;
  }
  const comments = readField(discussion, ['comments']);
  if (Array.isArray(comments)) {
    return comments.length.toLocaleString();
  }
  return '0';
}

/**
 * Read the latest author and excerpt, including a nested latest comment.
 *
 * @param {unknown} discussion
 * @returns {{ author: string, excerpt: string }}
 */
function latestComment(discussion) {
  const latest = readField(discussion, ['latest_comment', 'latest']);
  const author = readText(
    discussion,
    ['latest_author', 'last_author'],
    readText(
      latest,
      ['author', 'actor', 'display_name', 'name'],
      'Unknown author'
    )
  );
  const excerpt = readText(
    discussion,
    ['latest_excerpt', 'excerpt', 'latest_comment_excerpt'],
    readText(latest, ['excerpt', 'body', 'text'], 'No comment excerpt')
  );
  return { author, excerpt };
}

/**
 * Read the timestamp that describes discussion recency.
 *
 * @param {unknown} discussion
 * @returns {unknown}
 */
function discussionTimestamp(discussion) {
  const direct = readField(discussion, [
    'latest_at',
    'latest_created_at',
    'last_commented_at',
    'updated_at'
  ]);
  if (direct !== undefined) {
    return direct;
  }
  const latest = readField(discussion, ['latest_comment', 'latest']);
  return readField(latest, ['created_at', 'updated_at']);
}

/**
 * Choose the status shown beside the live snapshot.
 *
 * @param {boolean} loading
 * @param {boolean} loaded
 * @param {string} error
 * @param {AgentwatchPayload | null} payload
 * @returns {{ label: string, state: string }}
 */
function connectionStatus(loading, loaded, error, payload) {
  if (error.length > 0) {
    return { label: 'Error', state: 'error' };
  }
  if (loading && !loaded) {
    return { label: 'Connecting', state: 'connecting' };
  }
  if (payload !== null) {
    const generated_at = timestampMs(payload.generated_at);
    if (generated_at > 0 && Date.now() - generated_at > STALE_AFTER_MS) {
      return { label: 'Stale', state: 'stale' };
    }
    return { label: 'Live', state: 'live' };
  }
  return { label: 'Waiting', state: 'waiting' };
}

/**
 * Create the executive Agentwatch view.
 *
 * The server owns the grouping and ordering. This view only chooses a tab and
 * renders the `agents` and `discussions` arrays it receives, deriving each
 * agent's recency tier from the merged heartbeat the server attaches.
 *
 * @param {HTMLElement} mount_element
 * @param {AgentwatchOptions} options
 * @returns {{ load: () => Promise<void>, unload: () => Promise<void>, destroy: () => void }}
 */
export function createAgentwatchView(mount_element, options) {
  const send = options.send;
  const client = options.client;
  const goto_issue = options.gotoIssue || (() => {});
  const is_active = options.isActive || (() => true);

  /** @type {AgentwatchPayload | null} */
  let payload = null;
  let selected_tab = 'active';
  /** @type {'compact'|'detail'} */
  let view_mode = 'compact';
  try {
    const stored_mode = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (stored_mode === 'compact' || stored_mode === 'detail') {
      view_mode = stored_mode;
    }
  } catch {
    // Storage may be unavailable; the default density still renders.
  }
  /** @type {string | null} */
  let modal_agent = null;
  let loading = false;
  let loaded = false;
  let error = '';
  let watching = false;
  let destroyed = false;
  let update_flash = false;
  /** @type {number | null} */
  let update_timer = null;
  let watch_generation = 0;
  /** @type {Promise<void> | null} */
  let pending_load = null;
  /** @type {(() => void) | null} */
  let unsubscribe_client = null;
  /** @type {number | null} */
  let age_timer = null;
  /** @type {Set<string>} */
  const expanded_agents = new Set();
  /** @type {Set<string>} */
  let bumped_actors = new Set();
  /** @type {number | null} */
  let bump_timer = null;
  /** @type {Map<string, number>} */
  let last_seen_by_actor = new Map();

  /**
   * Render the current state into the mount point.
   */
  function doRender() {
    if (destroyed) {
      return;
    }
    render(viewTemplate(), mount_element);
  }

  /**
   * Keep relative ages and recency tiers honest between snapshots.
   */
  function startAgeTicker() {
    if (age_timer !== null) {
      return;
    }
    age_timer = window.setInterval(() => {
      doRender();
    }, AGE_TICK_MS);
  }

  /**
   * Stop the age ticker when nothing live is on screen.
   */
  function stopAgeTicker() {
    if (age_timer !== null) {
      window.clearInterval(age_timer);
      age_timer = null;
    }
  }

  /**
   * Begin the short, non-layout update cue for an incoming snapshot.
   */
  function flashUpdate() {
    update_flash = true;
    doRender();
    if (update_timer !== null) {
      window.clearTimeout(update_timer);
    }
    update_timer = window.setTimeout(() => {
      update_timer = null;
      update_flash = false;
      doRender();
    }, UPDATE_FLASH_MS);
  }

  /**
   * Highlight the specific agents whose heartbeat advanced in a snapshot, so
   * motion on the wall points at who just did something.
   *
   * @param {AgentwatchPayload} next_payload
   */
  function trackHeartbeats(next_payload) {
    /** @type {Map<string, number>} */
    const next_seen = new Map();
    for (const agent of next_payload.agents) {
      const handle = agentIdentity(agent).handle;
      next_seen.set(handle, agentLastSeen(agent));
    }
    /** @type {Set<string>} */
    const bumps = new Set();
    for (const [handle, seen] of next_seen) {
      const previous = last_seen_by_actor.get(handle);
      if (typeof previous === 'number' && seen > previous) {
        bumps.add(handle);
      }
    }
    last_seen_by_actor = next_seen;
    if (bumps.size === 0) {
      return;
    }
    bumped_actors = bumps;
    if (bump_timer !== null) {
      window.clearTimeout(bump_timer);
    }
    bump_timer = window.setTimeout(() => {
      bump_timer = null;
      bumped_actors = new Set();
      doRender();
    }, BUMP_FLASH_MS);
  }

  /**
   * Apply a server snapshot received over the request or live event channel.
   *
   * @param {unknown} next_payload
   * @param {boolean} [flash]
   */
  function applySnapshot(next_payload, flash = true) {
    const normalized = normalizePayload(next_payload);
    if (normalized === null) {
      return;
    }
    trackHeartbeats(normalized);
    payload = normalized;
    loaded = true;
    error = '';
    if (flash) {
      flashUpdate();
    } else {
      doRender();
    }
  }

  /**
   * Handle a server-pushed Agentwatch snapshot.
   *
   * @param {unknown} next_payload
   */
  function onSnapshot(next_payload) {
    if (destroyed || !watching || !is_active()) {
      return;
    }
    applySnapshot(next_payload);
  }

  /**
   * Subscribe to the event stream once for the current watch generation.
   */
  function subscribeClient() {
    if (unsubscribe_client !== null) {
      return;
    }
    const unsubscribe = client.on('agentwatch', onSnapshot);
    if (typeof unsubscribe === 'function') {
      unsubscribe_client = unsubscribe;
    }
  }

  /**
   * Remove the event stream handler for the current watch.
   */
  function unsubscribeClient() {
    if (unsubscribe_client !== null) {
      unsubscribe_client();
      unsubscribe_client = null;
    }
  }

  /**
   * Request the live stream and accept its initial snapshot.
   *
   * Repeated calls while a watch is live or connecting share the same promise;
   * they never create a second server watch.
   *
   * @returns {Promise<void>}
   */
  function load() {
    if (destroyed) {
      return Promise.resolve();
    }
    if (pending_load !== null) {
      return pending_load;
    }
    if (watching) {
      return Promise.resolve();
    }

    watching = true;
    loading = true;
    loaded = false;
    error = '';
    const generation = ++watch_generation;
    subscribeClient();
    startAgeTicker();
    doRender();

    pending_load = send('watch-agentwatch')
      .then((initial_payload) => {
        if (watching && generation === watch_generation) {
          applySnapshot(initial_payload);
        }
      })
      .catch((err) => {
        if (!watching || generation !== watch_generation) {
          return;
        }
        const message = isRecord(err) ? err.message : err;
        error =
          typeof message === 'string' && message.length > 0
            ? message
            : 'Failed to load Agentwatch';
        loaded = true;
        watching = false;
        unsubscribeClient();
        stopAgeTicker();
        doRender();
      })
      .finally(() => {
        if (generation === watch_generation) {
          loading = false;
          pending_load = null;
          doRender();
        }
      });

    return pending_load;
  }

  /**
   * Stop the live stream once. A late initial response cannot repopulate an
   * unloaded view because the watch generation changes before unwatching.
   *
   * @returns {Promise<void>}
   */
  async function unload() {
    if (!watching) {
      return;
    }
    watching = false;
    ++watch_generation;
    loading = false;
    pending_load = null;
    unsubscribeClient();
    stopAgeTicker();
    const unwatch = send('unwatch-agentwatch');
    doRender();
    try {
      await unwatch;
    } catch {
      // Unwatch is best effort during route changes; the server has already
      // received the request, and the next load establishes a fresh watch.
    }
  }

  /**
   * Handle a tab activation click.
   *
   * @param {'active'|'discussions'} tab_name
   */
  function selectTab(tab_name) {
    if (!TAB_IDS.includes(tab_name)) {
      return;
    }
    selected_tab = tab_name;
    doRender();
  }

  /**
   * Keep the two subtabs operable with the standard tab-list key bindings.
   *
   * @param {KeyboardEvent} event
   */
  function onTabKeydown(event) {
    const current_tab = /** @type {HTMLElement} */ (event.currentTarget).dataset
      .tab;
    const current_index = TAB_IDS.indexOf(current_tab || '');
    if (current_index < 0) {
      return;
    }
    let next_index = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next_index = (current_index + 1) % TAB_IDS.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next_index = (current_index - 1 + TAB_IDS.length) % TAB_IDS.length;
    } else if (event.key === 'Home') {
      next_index = 0;
    } else if (event.key === 'End') {
      next_index = TAB_IDS.length - 1;
    }
    if (next_index < 0) {
      return;
    }
    event.preventDefault();
    const next_tab = TAB_IDS[next_index];
    selectTab(/** @type {'active'|'discussions'} */ (next_tab));
    const next_button = mount_element.querySelector(`[data-tab="${next_tab}"]`);
    if (next_button instanceof HTMLElement) {
      next_button.focus();
    }
  }

  /**
   * Navigate to an issue when a row has a usable identifier.
   *
   * @param {string} issue_id
   */
  function onIssueClick(issue_id) {
    if (issue_id.length > 0) {
      goto_issue(issue_id);
    }
  }

  /**
   * Toggle the collapsed remainder of one agent's in-flight work.
   *
   * @param {string} handle
   */
  function toggleExpanded(handle) {
    if (expanded_agents.has(handle)) {
      expanded_agents.delete(handle);
    } else {
      expanded_agents.add(handle);
    }
    doRender();
  }

  /**
   * Switch the active-agent panel density and remember the choice.
   *
   * @param {'compact'|'detail'} mode
   */
  function selectMode(mode) {
    if (!VIEW_MODES.includes(mode) || view_mode === mode) {
      return;
    }
    view_mode = mode;
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Storage may be unavailable; the choice still applies to this view.
    }
    doRender();
  }

  /**
   * Open the single-agent modal with the full card for one actor.
   *
   * @param {string} handle
   */
  function openModal(handle) {
    if (handle.length === 0) {
      return;
    }
    modal_agent = handle;
    doRender();
    const close_button = mount_element.querySelector(
      '.agentwatch-modal__close'
    );
    if (close_button instanceof HTMLElement) {
      close_button.focus();
    }
  }

  /**
   * Close the single-agent modal.
   */
  function closeModal() {
    if (modal_agent === null) {
      return;
    }
    modal_agent = null;
    doRender();
  }

  /**
   * Close the modal on Escape from anywhere inside it.
   *
   * @param {KeyboardEvent} event
   */
  function onModalKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeModal();
    }
  }

  /**
   * Close the modal when the click lands on the backdrop itself.
   *
   * @param {MouseEvent} event
   */
  function onModalBackdropClick(event) {
    if (event.target === event.currentTarget) {
      closeModal();
    }
  }

  /**
   * Render the live pulse strip: one glance answers "who is on right now and
   * how much is moving", nothing more.
   *
   * @param {AgentwatchPayload} current_payload
   * @param {number} now
   * @returns {import('lit-html').TemplateResult}
   */
  function pulseTemplate(current_payload, now) {
    const stats = current_payload.stats;
    const active_now = current_payload.agents.filter(
      (agent) => runtimeAwareBeatInfo(agent, now).tier === 'now'
    ).length;
    const live_work =
      readCount(stats, [
        'live_work',
        'active_work',
        'active_issues',
        'in_progress_issues',
        'issues_in_progress'
      ]) || '0';
    const active_agents = readCount(stats, [
      'active_agents',
      'working_agents',
      'agents_active'
    ]);
    const registered_agents = readCount(stats, ['registered_agents']);
    const discussions = readCount(stats, [
      'shared_discussions',
      'discussion_count',
      'discussions'
    ]);
    return html`
      <section class="agentwatch-pulse" aria-label="Live activity summary">
        <div
          class="agentwatch-pulse__stat agentwatch-pulse__stat--now ${active_now >
          0
            ? 'agentwatch-pulse__stat--beating'
            : ''}"
          data-stat="active-now"
        >
          <span class="agentwatch-pulse__value">
            <span class="agentwatch-pulse__dot" aria-hidden="true"></span>
            ${active_now.toLocaleString()}
          </span>
          <span class="agentwatch-label">Active now</span>
        </div>
        <div class="agentwatch-pulse__stat" data-stat="live-work">
          <span class="agentwatch-pulse__value">${live_work}</span>
          <span class="agentwatch-label">Live work</span>
        </div>
        ${active_agents === null
          ? ''
          : html`<div class="agentwatch-pulse__stat" data-stat="agents">
              <span class="agentwatch-pulse__value">${active_agents}</span>
              <span class="agentwatch-label">Agents</span>
            </div>`}
        ${registered_agents === null
          ? ''
          : html`<div class="agentwatch-pulse__stat" data-stat="registered">
              <span class="agentwatch-pulse__value">${registered_agents}</span>
              <span class="agentwatch-label">Registered</span>
            </div>`}
        ${discussions === null
          ? ''
          : html`<div class="agentwatch-pulse__stat" data-stat="discussions">
              <span class="agentwatch-pulse__value">${discussions}</span>
              <span class="agentwatch-label">Discussions</span>
            </div>`}
      </section>
    `;
  }

  /**
   * Render the tab strip with proper tab semantics.
   *
   * @returns {import('lit-html').TemplateResult}
   */
  function tabsTemplate() {
    return html`
      <div class="agentwatch-tabs" role="tablist" aria-label="Agentwatch views">
        <button
          class="agentwatch-tab"
          data-tab="active"
          id="agentwatch-tab-active"
          role="tab"
          type="button"
          aria-controls="agentwatch-panel-active"
          aria-selected=${selected_tab === 'active'}
          tabindex=${selected_tab === 'active' ? '0' : '-1'}
          @click=${() => selectTab('active')}
          @keydown=${onTabKeydown}
        >
          Active agents
        </button>
        <button
          class="agentwatch-tab"
          data-tab="discussions"
          id="agentwatch-tab-discussions"
          role="tab"
          type="button"
          aria-controls="agentwatch-panel-discussions"
          aria-selected=${selected_tab === 'discussions'}
          tabindex=${selected_tab === 'discussions' ? '0' : '-1'}
          @click=${() => selectTab('discussions')}
          @keydown=${onTabKeydown}
        >
          Shared discussions
        </button>
      </div>
    `;
  }

  /**
   * Render the density toggle between the compact wall and the detailed grid.
   *
   * @returns {import('lit-html').TemplateResult}
   */
  function modesTemplate() {
    return html`
      <div class="agentwatch-modes" role="group" aria-label="Layout density">
        <button
          class="agentwatch-mode"
          data-mode="compact"
          type="button"
          aria-pressed=${view_mode === 'compact'}
          @click=${() => selectMode('compact')}
        >
          Compact
        </button>
        <button
          class="agentwatch-mode"
          data-mode="detail"
          type="button"
          aria-pressed=${view_mode === 'detail'}
          @click=${() => selectMode('detail')}
        >
          Detailed
        </button>
      </div>
    `;
  }

  /**
   * Render one compact at-a-glance card. The whole card opens the single-agent
   * modal; the stats answer "how much is this person running right now" and
   * the activity line is the live movement.
   *
   * @param {unknown} agent
   * @param {number} now
   * @returns {import('lit-html').TemplateResult}
   */
  function compactCardTemplate(agent, now) {
    const identity = agentIdentity(agent);
    const beat = runtimeAwareBeatInfo(agent, now);
    const summary = compactSummary(agent);
    const sessions = compactSessionSummaries(agent);
    const shown_sessions = sessions.slice(0, 3);
    const hidden_sessions = sessions.length - shown_sessions.length;
    const issues = agentIssues(agent);
    const item_count_value = readField(agent, ['item_count']);
    const work_count =
      typeof item_count_value === 'number' &&
      Number.isFinite(item_count_value) &&
      item_count_value >= 0
        ? item_count_value
        : issues.length;
    const focus_title = issues.length > 0 ? issueTitle(issues[0]) : '';
    const presence_error = presenceErrorLine(agent, now);
    const foot_line =
      focus_title ||
      (beat.tier === 'idle' && beat.seen > 0
        ? `Last seen ${relativeAge(beat.seen, now)}`
        : work_count === 0
          ? 'No issues in flight'
          : `${work_count.toLocaleString()} issues in flight`);
    const bumped = bumped_actors.has(identity.handle);
    const inactive = beat.tier === 'idle';
    return html`
      <button
        class="agentwatch-mini agentwatch-mini--${beat.tier} ${bumped
          ? 'agentwatch-mini--bumped'
          : ''} ${inactive ? 'agentwatch-mini--inactive' : ''}"
        type="button"
        data-agent=${identity.handle}
        aria-haspopup="dialog"
        aria-label=${`${identity.name} — ${beat.label}. Open details`}
        @click=${() => openModal(identity.handle)}
      >
        <span class="agentwatch-mini__head">
          <span class="agentwatch-orb agentwatch-orb--mini" aria-hidden="true">
            <span class="agentwatch-orb__initials">${identity.initials}</span>
          </span>
          <span class="agentwatch-mini__identity">
            <strong class="agentwatch-mini__name" title=${identity.name}
              >${identity.name}${serviceBadge(identity)}</strong
            >
            <code class="agentwatch-mini__handle" title=${identity.handle_title}
              >${identity.handle_label}</code
            >
          </span>
          <span
            class="agentwatch-beat agentwatch-beat--${beat.tier} agentwatch-mini__beat"
            title=${beat.seen > 0
              ? `Last touched ${relativeAge(beat.seen, now)}`
              : 'No recent activity timestamp'}
          >
            <span class="agentwatch-beat__dot" aria-hidden="true"></span>
            <span class="agentwatch-mini__beat-label">${beat.label}</span>
          </span>
        </span>
        <span class="agentwatch-mini__stats">
          <span class="agentwatch-mini__stat" data-mini-stat="sessions">
            <strong>${summary.live_sessions.toLocaleString()}</strong>
            <span>sessions</span>
          </span>
          <span class="agentwatch-mini__stat" data-mini-stat="subagents">
            <strong>${summary.live_subagents.toLocaleString()}</strong>
            <span>subagents</span>
          </span>
          <span class="agentwatch-mini__stat" data-mini-stat="issues">
            <strong>${work_count.toLocaleString()}</strong>
            <span>issues</span>
          </span>
        </span>
        <span class="agentwatch-mini__sessions">
          ${shown_sessions.map(
            (session) => html`
              <span
                class="agentwatch-mini__session"
                data-session-status=${session.status}
              >
                <span
                  class="agentwatch-runtime-status agentwatch-runtime-status--${session.status}"
                  title=${`Session status: ${session.status}`}
                >
                  <span
                    class="agentwatch-runtime-status__dot"
                    aria-hidden="true"
                  ></span>
                </span>
                <span
                  class="agentwatch-mini__session-name"
                  title=${session.name}
                  >${session.name}</span
                >
                <span
                  class="agentwatch-mini__session-activity"
                  title=${session.activity}
                  >${session.activity}</span
                >
                ${session.context.length > 0
                  ? html`<span class="agentwatch-mini__session-ctx"
                      >${session.context}</span
                    >`
                  : ''}
              </span>
            `
          )}
          ${hidden_sessions > 0
            ? html`<span class="agentwatch-mini__session-more"
                >+${hidden_sessions} more sessions</span
              >`
            : ''}
          ${sessions.length === 0
            ? presence_error.length > 0
              ? html`<span
                  class="agentwatch-mini__session-empty agentwatch-mini__session-empty--warn"
                  data-presence-error
                  title=${presence_error}
                  >${presence_error}</span
                >`
              : html`<span class="agentwatch-mini__session-empty"
                  >${work_count > 0
                    ? 'No agent reporting'
                    : 'No live sessions'}</span
                >`
            : ''}
        </span>
        <span class="agentwatch-mini__foot" title=${foot_line}
          >${foot_line}</span
        >
      </button>
    `;
  }

  /**
   * Render one compact clickable issue row inside an agent card.
   *
   * @param {unknown} issue
   * @param {number} now
   * @param {boolean} [focus]
   * @returns {import('lit-html').TemplateResult}
   */
  function issueRowTemplate(issue, now, focus = false) {
    const id = issueId(issue);
    const title = issueTitle(issue);
    const priority = issuePriority(issue);
    const age = shortAge(readField(issue, ['updated_at']), now);
    return html`
      <button
        class="agentwatch-issue-row ${focus
          ? 'agentwatch-issue-row--focus'
          : ''}"
        type="button"
        data-issue-id=${id}
        ?disabled=${id.length === 0}
        aria-label=${id.length > 0 ? `Open ${id}: ${title}` : title}
        @click=${() => onIssueClick(id)}
      >
        <span class="agentwatch-issue-main">
          <span class="agentwatch-issue-title">${title}</span>
          <span class="agentwatch-issue-meta">
            <span class="agentwatch-issue-board"
              >${boardId(issue)} / ${id || 'no id'}</span
            >
            ${priority.length > 0
              ? html`<span class="agentwatch-issue-priority">${priority}</span>`
              : ''}
          </span>
        </span>
        ${age.length > 0
          ? html`<time class="agentwatch-issue-age">${age}</time>`
          : ''}
      </button>
    `;
  }

  /**
   * Render a runtime status with a text label and a redundant indicator.
   *
   * @param {unknown} row
   * @returns {import('lit-html').TemplateResult}
   */
  function runtimeStatusTemplate(row) {
    const status = runtimeStatus(row);
    return html`
      <span
        class="agentwatch-runtime-status agentwatch-runtime-status--${status}"
        title=${`Runtime status: ${status}`}
      >
        <span class="agentwatch-runtime-status__dot" aria-hidden="true"></span>
        <span>${status}</span>
      </span>
    `;
  }

  /**
   * Render one main or child runtime row. The server has already established
   * the parent/session relationship, so this function only renders the row it
   * receives in its current list position.
   *
   * @param {RuntimePresenceRow} row
   * @param {number} now
   * @param {'main'|'child'} kind
   * @returns {import('lit-html').TemplateResult}
   */
  function runtimeRowTemplate(row, now, kind) {
    const handle = readText(
      row,
      ['handle'],
      kind === 'child' ? 'Unnamed child' : 'main'
    );
    const model = readText(row, ['model'], 'Model unavailable');
    const activity = readText(row, ['activity'], 'Activity unavailable');
    const elapsed = runtimeElapsed(row, now);
    const context = runtimeContextLabel(row);
    const freshness = runtimeFreshness(row, now);
    return html`
      <li
        class="agentwatch-runtime-row agentwatch-runtime-row--${kind}"
        data-runtime-kind=${kind}
        data-runtime-status=${runtimeStatus(row)}
      >
        <div class="agentwatch-runtime-row__identity">
          <strong class="agentwatch-runtime-row__name" title=${handle}>
            ${kind === 'child' ? handle : 'Main session'}
          </strong>
          <code title=${handle}>${handle}</code>
        </div>
        <div class="agentwatch-runtime-row__facts">
          <span
            class="agentwatch-runtime-field agentwatch-runtime-field--status"
            >${runtimeStatusTemplate(row)}</span
          >
          <span
            class="agentwatch-runtime-field agentwatch-runtime-field--model"
            title=${model}
          >
            <span class="agentwatch-runtime-field__label">Model</span>
            <span class="agentwatch-runtime-field__value">${model}</span>
          </span>
          <span
            class="agentwatch-runtime-field agentwatch-runtime-field--elapsed"
            title=${elapsed}
          >
            <span class="agentwatch-runtime-field__label">Elapsed</span>
            <time class="agentwatch-runtime-field__value">${elapsed}</time>
          </span>
          <span
            class="agentwatch-runtime-field agentwatch-runtime-field--activity"
            title=${activity}
          >
            <span class="agentwatch-runtime-field__label">Activity</span>
            <span class="agentwatch-runtime-field__value">${activity}</span>
          </span>
          <span
            class="agentwatch-runtime-field agentwatch-runtime-field--context"
            title=${context}
          >
            <span class="agentwatch-runtime-field__label">Context</span>
            <span class="agentwatch-runtime-field__value">${context}</span>
          </span>
          <span
            class="agentwatch-runtime-field agentwatch-runtime-field--freshness"
            title=${`Heartbeat freshness: ${freshness}`}
          >
            <span class="agentwatch-runtime-field__label">Freshness</span>
            <span class="agentwatch-runtime-field__value">${freshness}</span>
          </span>
        </div>
      </li>
    `;
  }

  /**
   * Render one server-grouped runtime session and its child list.
   *
   * @param {RuntimeSession} session
   * @param {number} now
   * @param {number | string} agent_index
   * @param {number} session_index
   * @returns {import('lit-html').TemplateResult}
   */
  function runtimeSessionTemplate(session, now, agent_index, session_index) {
    const main_value = readField(session, ['main']);
    const main = isRecord(main_value) ? main_value : null;
    const subagents_value = readField(session, ['subagents']);
    const subagents = Array.isArray(subagents_value)
      ? subagents_value.filter(isRecord)
      : [];
    const session_name = runtimeSessionName(session);
    const opaque_id = runtimeSessionIdentifier(session);
    if (opaque_id.length === 0) {
      return html``;
    }
    const heading_id = `agentwatch-runtime-session-${agent_index}-${session_index}`;
    return html`
      <section
        class="agentwatch-runtime-session"
        aria-labelledby=${heading_id}
        data-runtime-id=${opaque_id}
      >
        <header class="agentwatch-runtime-session__head">
          <div class="agentwatch-runtime-session__identity">
            <h5 id=${heading_id} title=${session_name}>${session_name}</h5>
            <code title=${opaque_id}>${shortIdentifier(opaque_id)}</code>
          </div>
          ${main === null
            ? html`<span class="agentwatch-runtime-session__missing"
                >Main session unavailable</span
              >`
            : ''}
        </header>
        <ul
          class="agentwatch-runtime-list"
          aria-label=${`${session_name} runtime activity`}
        >
          ${main === null
            ? html`<li
                class="agentwatch-runtime-row agentwatch-runtime-row--main-missing"
                data-runtime-kind="main-missing"
              >
                <span class="agentwatch-runtime-row__missing"
                  >Main session is not reporting</span
                >
              </li>`
            : runtimeRowTemplate(main, now, 'main')}
          ${subagents.map((subagent) =>
            runtimeRowTemplate(subagent, now, 'child')
          )}
        </ul>
      </section>
    `;
  }

  /**
   * Render the additive runtime section inside one principal lane.
   *
   * @param {RuntimeSession[]} sessions
   * @param {number} now
   * @param {number | string} agent_index
   * @returns {import('lit-html').TemplateResult}
   */
  function runtimeSessionsTemplate(sessions, now, agent_index) {
    const heading_id = `agentwatch-runtime-heading-${agent_index}`;
    return html`
      <section
        class="agentwatch-runtime-sessions"
        aria-labelledby=${heading_id}
      >
        <h4 id=${heading_id}>Runtime sessions</h4>
        <div class="agentwatch-runtime-session-list">
          ${sessions.map((session, session_index) =>
            runtimeSessionTemplate(session, now, agent_index, session_index)
          )}
        </div>
      </section>
    `;
  }

  /**
   * Render the small control that pops one agent out into the modal. Rendered
   * in the grid only; the modal itself never nests another expand control.
   *
   * @param {{ name: string, handle: string }} identity
   * @returns {import('lit-html').TemplateResult}
   */
  function expandButtonTemplate(identity) {
    return html`<button
      class="agentwatch-card__expand"
      type="button"
      aria-haspopup="dialog"
      aria-label=${`Expand ${identity.name}`}
      title="Expand"
      @click=${() => openModal(identity.handle)}
    >
      ⤢
    </button>`;
  }

  /**
   * Render an agent with no runtime presence using the exact legacy template
   * from origin/main. Keep this branch separate: even an empty Lit expression
   * changes the marker structure of the no-runtime DOM.
   *
   * @param {unknown} agent
   * @param {number} now
   * @param {boolean} [in_modal]
   * @returns {import('lit-html').TemplateResult}
   */
  function legacyAgentCardTemplate(agent, now, in_modal = false) {
    const identity = agentIdentity(agent);
    const beat = beatInfo(agent, now);
    const issues = agentIssues(agent);
    const focus = issues.length > 0 ? issues[0] : null;
    const rest = issues.slice(1);
    const expanded = expanded_agents.has(identity.handle);
    const bumped = bumped_actors.has(identity.handle);
    const flare = readField(agent, ['flare']);
    const flare_issue = readText(flare, ['issue_id'], '');
    const presence_error = presenceErrorLine(agent, now);
    const item_count_value = readField(agent, ['item_count']);
    const work_count =
      typeof item_count_value === 'number' &&
      Number.isFinite(item_count_value) &&
      item_count_value > 0
        ? item_count_value
        : 0;
    // Kept inside the existing branches below: an extra child expression on the
    // article would change the no-runtime card's marker structure.
    const presence_error_line = html`<p
      class="agentwatch-card__empty agentwatch-card__runtime-empty agentwatch-card__runtime-empty--warn"
      data-presence-error
      title=${presence_error}
    >
      ${presence_error}
    </p>`;
    return html`
      <article
        class="agentwatch-card agentwatch-card--${beat.tier} ${bumped
          ? 'agentwatch-card--bumped'
          : ''}"
        data-agent=${identity.handle}
      >
        <div class="agentwatch-card__head">
          <span class="agentwatch-orb" aria-hidden="true">
            <span class="agentwatch-orb__initials">${identity.initials}</span>
          </span>
          <div class="agentwatch-card__identity">
            <h3>${identity.name}${serviceBadge(identity)}</h3>
            <code title=${identity.handle_title}>${identity.handle_label}</code>
          </div>
          <span
            class="agentwatch-beat agentwatch-beat--${beat.tier}"
            title=${beat.seen > 0
              ? `Last touched ${relativeAge(beat.seen, now)}`
              : 'No recent activity timestamp'}
          >
            <span class="agentwatch-beat__dot" aria-hidden="true"></span>
            <span>${beat.label}</span>
          </span>
          ${in_modal ? '' : expandButtonTemplate(identity)}
        </div>
        ${focus !== null
          ? html`${issueRowTemplate(focus, now, true)}
            ${presence_error.length > 0
              ? presence_error_line
              : html`<p
                  class="agentwatch-card__empty agentwatch-card__runtime-empty"
                >
                  No agent reporting.
                </p>`}`
          : flare_issue.length > 0
            ? html`<button
                  class="agentwatch-issue-row agentwatch-issue-row--focus"
                  type="button"
                  data-issue-id=${flare_issue}
                  aria-label=${`Open ${flare_issue}`}
                  @click=${() => onIssueClick(flare_issue)}
                >
                  <span class="agentwatch-issue-main">
                    <span class="agentwatch-issue-title">Heartbeat</span>
                    <span class="agentwatch-issue-meta">
                      <span class="agentwatch-issue-board"
                        >${readText(flare, ['board_id'], 'board')} /
                        ${flare_issue}</span
                      >
                    </span>
                  </span>
                </button>
                ${presence_error.length > 0 ? presence_error_line : ''}`
            : presence_error.length > 0
              ? presence_error_line
              : html`<p class="agentwatch-card__empty">
                  ${work_count > 0
                    ? `${work_count.toLocaleString()} issues in flight.`
                    : 'No open work attached.'}
                </p>`}
        ${expanded ? rest.map((issue) => issueRowTemplate(issue, now)) : ''}
        ${rest.length > 0
          ? html`<button
              class="agentwatch-card__more"
              type="button"
              aria-expanded=${expanded}
              @click=${() => toggleExpanded(identity.handle)}
            >
              ${expanded ? 'Collapse' : `+${rest.length} more in flight`}
            </button>`
          : ''}
      </article>
    `;
  }

  /**
   * Render an agent card that contains server-grouped runtime sessions.
   *
   * @param {unknown} agent
   * @param {number} now
   * @param {number | string} agent_index
   * @param {boolean} [in_modal]
   * @returns {import('lit-html').TemplateResult}
   */
  function runtimeAgentCardTemplate(agent, now, agent_index, in_modal = false) {
    const identity = agentIdentity(agent);
    const beat = runtimeAwareBeatInfo(agent, now);
    const issues = agentIssues(agent);
    const runtime_sessions = agentRuntimeSessions(agent);
    const focus = issues.length > 0 ? issues[0] : null;
    const rest = issues.slice(1);
    const expanded = expanded_agents.has(identity.handle);
    const bumped = bumped_actors.has(identity.handle);
    const flare = readField(agent, ['flare']);
    const flare_issue = readText(flare, ['issue_id'], '');
    return html`
      <article
        class="agentwatch-card agentwatch-card--runtime agentwatch-card--${beat.tier} ${bumped
          ? 'agentwatch-card--bumped'
          : ''}"
        data-agent=${identity.handle}
      >
        <div class="agentwatch-card__head">
          <span class="agentwatch-orb" aria-hidden="true">
            <span class="agentwatch-orb__initials">${identity.initials}</span>
          </span>
          <div class="agentwatch-card__identity">
            <h3>${identity.name}${serviceBadge(identity)}</h3>
            <code title=${identity.handle_title}>${identity.handle_label}</code>
          </div>
          <span
            class="agentwatch-beat agentwatch-beat--${beat.tier}"
            title=${beat.seen > 0
              ? `Last touched ${relativeAge(beat.seen, now)}`
              : 'No recent activity timestamp'}
          >
            <span class="agentwatch-beat__dot" aria-hidden="true"></span>
            <span>${beat.label}</span>
          </span>
          ${in_modal ? '' : expandButtonTemplate(identity)}
        </div>
        ${focus !== null
          ? issueRowTemplate(focus, now, true)
          : flare_issue.length > 0
            ? html`<button
                class="agentwatch-issue-row agentwatch-issue-row--focus"
                type="button"
                data-issue-id=${flare_issue}
                aria-label=${`Open ${flare_issue}`}
                @click=${() => onIssueClick(flare_issue)}
              >
                <span class="agentwatch-issue-main">
                  <span class="agentwatch-issue-title">Heartbeat</span>
                  <span class="agentwatch-issue-meta">
                    <span class="agentwatch-issue-board"
                      >${readText(flare, ['board_id'], 'board')} /
                      ${flare_issue}</span
                    >
                  </span>
                </span>
              </button>`
            : ''}
        ${expanded ? rest.map((issue) => issueRowTemplate(issue, now)) : ''}
        ${rest.length > 0
          ? html`<button
              class="agentwatch-card__more"
              type="button"
              aria-expanded=${expanded}
              @click=${() => toggleExpanded(identity.handle)}
            >
              ${expanded ? 'Collapse' : `+${rest.length} more in flight`}
            </button>`
          : ''}
        ${runtimeSessionsTemplate(runtime_sessions, now, agent_index)}
      </article>
    `;
  }

  /**
   * Select the exact legacy path until the server provides runtime sessions.
   *
   * @param {unknown} agent
   * @param {number} now
   * @param {number | string} [agent_index]
   * @param {boolean} [in_modal]
   * @returns {import('lit-html').TemplateResult}
   */
  function agentCardTemplate(agent, now, agent_index = 0, in_modal = false) {
    return agentRuntimeSessions(agent).length > 0
      ? runtimeAgentCardTemplate(agent, now, agent_index, in_modal)
      : legacyAgentCardTemplate(agent, now, in_modal);
  }

  /**
   * Render the single-agent modal: the full detail card for one actor, live
   * against the current snapshot.
   *
   * @param {AgentwatchPayload} current_payload
   * @param {number} now
   * @returns {import('lit-html').TemplateResult | ''}
   */
  function modalTemplate(current_payload, now) {
    if (modal_agent === null) {
      return '';
    }
    const agent = current_payload.agents.find(
      (candidate) => agentIdentity(candidate).handle === modal_agent
    );
    const identity = agent
      ? agentIdentity(agent)
      : {
          name: modal_agent,
          handle: modal_agent,
          handle_label: modal_agent,
          handle_title: modal_agent,
          aliases: /** @type {string[]} */ ([])
        };
    const also_as =
      identity.aliases.length > 0
        ? `also as ${identity.aliases.join(', ')}`
        : '';
    return html`
      <div
        class="agentwatch-modal"
        @click=${onModalBackdropClick}
        @keydown=${onModalKeydown}
      >
        <div
          class="agentwatch-modal__dialog"
          role="dialog"
          aria-modal="true"
          aria-label=${`${identity.name} details`}
        >
          <header class="agentwatch-modal__head">
            <div class="agentwatch-modal__identity">
              <h2>${identity.name}</h2>
              <code title=${identity.handle_title}
                >${identity.handle_label}</code
              >
              ${also_as.length > 0
                ? html`<span class="agentwatch-modal__aliases" title=${also_as}
                    >${also_as}</span
                  >`
                : ''}
            </div>
            <button
              class="agentwatch-modal__close"
              type="button"
              aria-label="Close"
              @click=${closeModal}
            >
              ✕
            </button>
          </header>
          <div class="agentwatch-modal__body">
            ${agent
              ? agentCardTemplate(agent, now, 'modal', true)
              : html`<p class="agentwatch-modal__missing">
                  This agent is not in the current snapshot.
                </p>`}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render the active-agent panel.
   *
   * @param {AgentwatchPayload} current_payload
   * @param {number} now
   * @returns {import('lit-html').TemplateResult}
   */
  function activePanelTemplate(current_payload, now) {
    const agents = current_payload.agents;
    return html`
      <section
        class="agentwatch-panel"
        id="agentwatch-panel-active"
        role="tabpanel"
        aria-labelledby="agentwatch-tab-active"
        ?hidden=${selected_tab !== 'active'}
        tabindex="0"
      >
        ${agents.length > 0
          ? view_mode === 'compact'
            ? html`<div class="agentwatch-compact-grid">
                ${agents.map((agent) => compactCardTemplate(agent, now))}
              </div>`
            : html`<div class="agentwatch-grid">
                ${agents.map((agent, agent_index) =>
                  agentCardTemplate(agent, now, agent_index)
                )}
              </div>`
          : html`<div class="agentwatch-empty agentwatch-empty--panel">
              <strong>No agents are reporting live work.</strong>
              <span
                >The next server snapshot will appear here when an agent claims
                an issue.</span
              >
            </div>`}
      </section>
    `;
  }

  /**
   * Render one shared discussion row.
   *
   * @param {unknown} discussion
   * @param {number} now
   * @returns {import('lit-html').TemplateResult}
   */
  function discussionRowTemplate(discussion, now) {
    const id = issueId(discussion);
    const title = issueTitle(discussion);
    const participants = discussionParticipants(discussion);
    const latest = latestComment(discussion);
    const timestamp = discussionTimestamp(discussion);
    const recency = relativeAge(timestamp, now);
    const fresh = now - timestampMs(timestamp) <= HOT_MS;
    const participant_details = participants.details.slice(0, 3);
    const remaining = Math.max(
      0,
      participants.details.length - participant_details.length
    );
    return html`
      <button
        class="agentwatch-discussion-row ${fresh
          ? 'agentwatch-discussion-row--fresh'
          : ''}"
        type="button"
        data-issue-id=${id}
        ?disabled=${id.length === 0}
        aria-label=${id.length > 0 ? `Open ${id}: ${title}` : title}
        @click=${() => onIssueClick(id)}
      >
        <span class="agentwatch-discussion__issue">
          <span class="agentwatch-issue-title">${title}</span>
          <span class="agentwatch-issue-meta">
            <span class="agentwatch-issue-board"
              >${boardId(discussion)} / ${id || 'no id'}</span
            >
            <span>${discussionCommentCount(discussion)} comments</span>
          </span>
        </span>
        <span class="agentwatch-discussion__people">
          <span class="agentwatch-label">Participants</span>
          <span class="agentwatch-participants">
            ${participant_details.length > 0
              ? participant_details.map(
                  (participant) =>
                    html`<span>
                      ${participant.label}
                      ${participant.count === null
                        ? ''
                        : html` · ${participant.count}`}
                    </span>`
                )
              : html`<span>Participants unavailable</span>`}
            ${remaining > 0 ? html`<span>+${remaining}</span>` : ''}
            ${participants.count === null
              ? ''
              : html`<strong
                  >${participants.count}
                  ${participants.count === 1
                    ? 'participant'
                    : 'participants'}</strong
                >`}
          </span>
        </span>
        <span class="agentwatch-discussion__latest">
          <span class="agentwatch-label"
            >Latest · ${actorLabel(latest.author)}</span
          >
          <span class="agentwatch-discussion__excerpt">${latest.excerpt}</span>
          <time datetime=${String(timestamp || '')}>
            <span class="agentwatch-discussion__pip" aria-hidden="true"></span>
            ${recency}
          </time>
        </span>
      </button>
    `;
  }

  /**
   * Render the shared-discussions panel.
   *
   * @param {AgentwatchPayload} current_payload
   * @param {number} now
   * @returns {import('lit-html').TemplateResult}
   */
  function discussionsPanelTemplate(current_payload, now) {
    const discussions = current_payload.discussions;
    return html`
      <section
        class="agentwatch-panel"
        id="agentwatch-panel-discussions"
        role="tabpanel"
        aria-labelledby="agentwatch-tab-discussions"
        ?hidden=${selected_tab !== 'discussions'}
        tabindex="0"
      >
        ${discussions.length > 0
          ? html`<div class="agentwatch-discussions">
              ${discussions.map((discussion) =>
                discussionRowTemplate(discussion, now)
              )}
            </div>`
          : html`<div class="agentwatch-empty agentwatch-empty--panel">
              <strong>No shared discussions yet.</strong>
              <span
                >Threads with two or more participants will surface here.</span
              >
            </div>`}
      </section>
    `;
  }

  /**
   * Render the complete state lattice: connecting, error, empty, stale, or live.
   *
   * @returns {import('lit-html').TemplateResult}
   */
  function viewTemplate() {
    const status = connectionStatus(loading, loaded, error, payload);
    const now = Date.now();
    return html`
      <div
        class="agentwatch-view agentwatch-view--${view_mode} ${update_flash
          ? 'agentwatch-view--updated'
          : ''}"
        data-status=${status.state}
      >
        <div class="agentwatch-content">
          <header class="agentwatch-header">
            <div>
              <span class="agentwatch-kicker">Executive view</span>
              <h1>Agentwatch</h1>
              <p>Live work, grouped by the agents moving it forward.</p>
            </div>
            <div class="agentwatch-header__side">
              <div
                class="agentwatch-status agentwatch-status--${status.state}"
                role="status"
                aria-live="polite"
              >
                <span class="agentwatch-status__dot" aria-hidden="true"></span>
                <span>${status.label}</span>
              </div>
              ${modesTemplate()}
            </div>
          </header>

          ${error.length > 0
            ? html`<div
                class="agentwatch-message agentwatch-message--error"
                role="alert"
              >
                <strong>Agentwatch could not load.</strong>
                <span>${error}</span>
              </div>`
            : ''}
          ${!loaded && loading
            ? html`<div
                class="agentwatch-message agentwatch-message--loading"
                aria-busy="true"
              >
                <span class="agentwatch-loading-bar" aria-hidden="true"></span>
                <span>Loading live activity…</span>
              </div>`
            : payload === null && error.length === 0
              ? html`<div class="agentwatch-message agentwatch-message--empty">
                  <strong>Waiting for live activity.</strong>
                  <span
                    >Agentwatch will show the first server snapshot here.</span
                  >
                </div>`
              : payload !== null
                ? html`${pulseTemplate(payload, now)} ${tabsTemplate()}
                  ${activePanelTemplate(payload, now)}
                  ${discussionsPanelTemplate(payload, now)}`
                : ''}
          ${payload !== null
            ? html`<footer class="agentwatch-footer">
                <span>Snapshot ${relativeAge(payload.generated_at, now)}</span>
                <span class="agentwatch-footer__separator" aria-hidden="true"
                  >·</span
                >
                <span
                  >${status.state === 'stale'
                    ? 'Waiting for a newer snapshot'
                    : 'Updates arrive automatically'}</span
                >
              </footer>`
            : ''}
        </div>
        ${payload !== null ? modalTemplate(payload, now) : ''}
      </div>
    `;
  }

  /**
   * Release all view resources and clear the mount point.
   */
  function destroy() {
    if (destroyed) {
      return;
    }
    const was_watching = watching;
    destroyed = true;
    ++watch_generation;
    watching = false;
    loading = false;
    unsubscribeClient();
    stopAgeTicker();
    if (update_timer !== null) {
      window.clearTimeout(update_timer);
      update_timer = null;
    }
    if (bump_timer !== null) {
      window.clearTimeout(bump_timer);
      bump_timer = null;
    }
    if (was_watching) {
      void send('unwatch-agentwatch').catch(() => {});
    }
    pending_load = null;
    render(html``, mount_element);
  }

  doRender();

  return { load, unload, destroy };
}
