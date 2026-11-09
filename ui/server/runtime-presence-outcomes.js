/**
 * In-process memory of runtime-presence ingestion outcomes.
 *
 * Heartbeats are advisory and fail open on the publisher, so a person whose
 * every heartbeat is rejected simply looks like "nobody reporting". This module
 * remembers, per authenticated agent id, the last success and the last
 * attributable failure so Agentwatch can say "heartbeats rejected" instead.
 *
 * It lives in the dashboard process: `PUT/DELETE /api/runtime-presence`
 * (app.js) and the Agentwatch snapshot (ws.js, agentwatch-routes.js) are served
 * by the same Node process (index.js), so no registry table is needed. The map
 * is bounded and holds no secrets: an agent id, its actor, timestamps, an HTTP
 * status, an error code, sanitized client names and a credential label.
 */

/** A failure is surfaced on Agentwatch for this long unless a success clears it. */
export const PRESENCE_ERROR_WINDOW_MS = 15 * 60_000;
const MAX_AGENTS = 2_000;
const MAX_RUNTIMES_PER_AGENT = 64;

/**
 * @typedef {{ at: number, status: number, error: string, client?: string, via?: string }} PresenceFailure
 */

/**
 * @typedef {{ actor: string, last_success_at: number,
 *             failure: PresenceFailure | null, runtimes: Set<string> }} PresenceRecord
 */

/** @type {Map<string, PresenceRecord>} insertion order = least recently touched first */
const RECORDS = new Map();

/**
 * Fetch (or create) an agent's record and mark it most recently touched,
 * evicting the least recently touched agents beyond the bound.
 *
 * @param {string} agent_id
 * @param {string} actor
 * @returns {PresenceRecord}
 */
function touch(agent_id, actor) {
  let record = RECORDS.get(agent_id);
  if (record) {
    RECORDS.delete(agent_id);
  } else {
    record = { actor, last_success_at: 0, failure: null, runtimes: new Set() };
  }
  if (actor.length > 0) {
    record.actor = actor;
  }
  RECORDS.set(agent_id, record);
  while (RECORDS.size > MAX_AGENTS) {
    const oldest = RECORDS.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    RECORDS.delete(oldest);
  }
  return record;
}

/**
 * Record a successful PUT/DELETE. A success clears any recorded failure. Answers
 * `first_seen` (runtime ids this process had not seen for this agent) and
 * `recovered` (the failure this success cleared, if any).
 *
 * @param {{ agent_id: string, actor: string, at: number, runtime_ids?: string[] }} input
 * @returns {{ first_seen: string[], recovered: PresenceFailure | null }}
 */
export function recordPresenceSuccess(input) {
  const agent_id = String(input.agent_id || '');
  if (agent_id.length === 0) {
    return { first_seen: [], recovered: null };
  }
  const record = touch(agent_id, String(input.actor || ''));
  record.last_success_at = Math.max(record.last_success_at, input.at);
  const recovered = record.failure;
  record.failure = null;
  /** @type {string[]} */
  const first_seen = [];
  for (const runtime_id of input.runtime_ids || []) {
    if (record.runtimes.has(runtime_id)) {
      continue;
    }
    record.runtimes.add(runtime_id);
    first_seen.push(runtime_id);
    if (record.runtimes.size > MAX_RUNTIMES_PER_AGENT) {
      const oldest = record.runtimes.values().next().value;
      if (oldest !== undefined) {
        record.runtimes.delete(oldest);
      }
    }
  }
  return { first_seen, recovered };
}

/**
 * Record an attributable failure (the caller resolved to an agent id). Callers
 * with no identity are only logged, never recorded.
 *
 * @param {{ agent_id: string, actor: string, at: number, status: number,
 *           error: string, client?: string, via?: string }} input
 */
export function recordPresenceFailure(input) {
  const agent_id = String(input.agent_id || '');
  if (agent_id.length === 0) {
    return;
  }
  const record = touch(agent_id, String(input.actor || ''));
  /** @type {PresenceFailure} */
  const failure = {
    at: input.at,
    status: input.status,
    error: String(input.error || '')
  };
  if (input.client) {
    failure.client = input.client;
  }
  if (input.via) {
    failure.via = input.via;
  }
  record.failure = failure;
}

/**
 * The failures Agentwatch should show right now: newer than that agent's last
 * success and no older than the window. Only display-safe fields leave here
 * (never the agent id or the credential label).
 *
 * @param {number} [now]
 * @returns {Array<{ actor: string, at: number, status: number, error: string, client?: string }>}
 */
export function activePresenceErrors(now = Date.now()) {
  /** @type {Array<{ actor: string, at: number, status: number, error: string, client?: string }>} */
  const out = [];
  for (const record of RECORDS.values()) {
    const failure = record.failure;
    if (
      !failure ||
      record.actor.length === 0 ||
      failure.at <= record.last_success_at ||
      now - failure.at > PRESENCE_ERROR_WINDOW_MS
    ) {
      continue;
    }
    out.push({
      actor: record.actor,
      at: failure.at,
      status: failure.status,
      error: failure.error,
      ...(failure.client ? { client: failure.client } : {})
    });
  }
  return out;
}

/** Forget every record (tests). */
export function resetPresenceOutcomesForTests() {
  RECORDS.clear();
}
