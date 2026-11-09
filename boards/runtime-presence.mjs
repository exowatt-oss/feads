/**
 * Ephemeral, owner-scoped runtime presence for phi sessions and subagent runs.
 *
 * This store is deliberately separate from durable agents, claims, and work flares.
 * The authenticated owner is supplied by the HTTP layer; this module only enforces
 * the row shape, lineage, tuple lifecycle, retention, and SQLite ownership scope.
 */

export const LIVE_MS = 45_000;
export const FADING_MS = 90_000;
export const TERMINAL_RETENTION_MS = 5 * 60_000;
export const MAX_ROWS = 64;
export const MAX_RUN_IDS = 64;
export const MAX_ID_BYTES = 128;
export const MAX_LABEL_BYTES = 80;
export const MAX_CLIENT_BYTES = 32;
export const MAX_STARTED_AT_FUTURE_MS = 5 * 60_000;

const TERMINAL_STATUSES = new Set(["done", "failed", "aborted"]);
const STATUSES = new Set([
  "working",
  "idle",
  "done",
  "failed",
  "aborted",
  "unknown",
]);
const KINDS = new Set(["main", "subagent"]);
const ROW_KEYS = new Set([
  "session_id",
  "runtime_id",
  "run_id",
  "parent_run_id",
  "kind",
  "handle",
  "display_name",
  "status",
  "model",
  "activity",
  "context_percent",
  "started_at",
  "client",
]);
const CLIENT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * A malformed runtime-presence input. The HTTP layer maps this to 400.
 */
export class RuntimePresenceValidationError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "RuntimePresenceValidationError";
    this.code = "bad_request";
  }
}

/**
 * A tuple, lineage, or terminal-state conflict. The HTTP layer maps this to 409.
 */
export class RuntimePresenceConflictError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "RuntimePresenceConflictError";
    this.code = "conflict";
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function validNow(value) {
  const now = value === undefined ? Date.now() : Number(value);
  if (!Number.isFinite(now) || now < 0) {
    throw new RuntimePresenceValidationError(
      "now must be a non-negative number",
    );
  }
  return Math.floor(now);
}

/**
 * Resolve the durable owner id without accepting any caller-controlled actor field.
 *
 * @param {unknown} owner
 * @returns {string}
 */
function ownerId(owner) {
  const owner_record =
    owner && typeof owner === "object"
      ? /** @type {Record<string, unknown>} */ (owner)
      : null;
  const value =
    typeof owner === "string"
      ? owner
      : owner_record
        ? (owner_record.agent_id ?? owner_record.id)
        : "";
  const id = typeof value === "string" ? value.trim() : "";
  if (id.length === 0) {
    throw new RuntimePresenceValidationError(
      "an authenticated agent owner is required",
    );
  }
  return id;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max_bytes
 * @param {boolean} [required]
 * @returns {string}
 */
function boundedText(value, field, max_bytes, required = true) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") {
    throw new RuntimePresenceValidationError(`${field} must be a string`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new RuntimePresenceValidationError(
      `${field} contains a control character`,
    );
  }
  if (Buffer.byteLength(value, "utf8") > max_bytes) {
    throw new RuntimePresenceValidationError(`${field} exceeds its byte limit`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {Set<string>} allowed
 * @returns {string}
 */
function enumValue(value, field, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new RuntimePresenceValidationError(`${field} has an invalid value`);
  }
  return value;
}

/**
 * @param {unknown} row
 * @param {number} now
 * @returns {{ session_id: string, runtime_id: string, run_id: string,
 *   parent_run_id: string, kind: string, handle: string, display_name: string,
 *   status: string, model: string, activity: string, context_percent: number,
 *   started_at: number, client: string }}
 */
function normalizeRow(row, now) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new RuntimePresenceValidationError(
      "each runtime-presence row must be an object",
    );
  }
  for (const key of Object.keys(row)) {
    if (!ROW_KEYS.has(key)) {
      throw new RuntimePresenceValidationError(
        `unknown runtime-presence field: ${key}`,
      );
    }
  }

  const input = /** @type {Record<string, unknown>} */ (row);
  const session_id = boundedText(input.session_id, "session_id", MAX_ID_BYTES);
  const runtime_id = boundedText(input.runtime_id, "runtime_id", MAX_ID_BYTES);
  const run_id = boundedText(input.run_id, "run_id", MAX_ID_BYTES);
  if (
    session_id.length === 0 ||
    runtime_id.length === 0 ||
    run_id.length === 0
  ) {
    throw new RuntimePresenceValidationError(
      "session_id, runtime_id, and run_id must not be empty",
    );
  }

  const parent_run_id = boundedText(
    input.parent_run_id,
    "parent_run_id",
    MAX_ID_BYTES,
  );
  const kind = enumValue(input.kind, "kind", KINDS);
  if (kind === "main" && (parent_run_id !== "" || run_id !== runtime_id)) {
    throw new RuntimePresenceValidationError(
      "main rows must use runtime_id as their run_id and have no parent_run_id",
    );
  }
  if (kind === "subagent" && parent_run_id !== runtime_id) {
    throw new RuntimePresenceValidationError(
      "subagent rows must use runtime_id as their parent_run_id",
    );
  }

  const status = enumValue(input.status, "status", STATUSES);
  const handle = boundedText(input.handle, "handle", MAX_LABEL_BYTES);
  const display_name = boundedText(
    input.display_name,
    "display_name",
    MAX_LABEL_BYTES,
  );
  const model = boundedText(input.model, "model", MAX_ID_BYTES);
  const activity = boundedText(input.activity, "activity", MAX_ID_BYTES);
  // The launcher/ADE that wrapped the runtime (e.g. p3, forca). Optional so
  // publishers that predate the field keep working; '' means started directly.
  const client = boundedText(input.client, "client", MAX_CLIENT_BYTES, false);
  if (client !== "" && !CLIENT_PATTERN.test(client)) {
    throw new RuntimePresenceValidationError("client has an invalid value");
  }

  if (
    typeof input.context_percent !== "number" ||
    !Number.isFinite(input.context_percent)
  ) {
    throw new RuntimePresenceValidationError(
      "context_percent must be a finite number",
    );
  }
  const context_percent = Math.min(100, Math.max(0, input.context_percent));

  const raw_started_at = input.started_at === undefined ? 0 : input.started_at;
  if (
    typeof raw_started_at !== "number" ||
    !Number.isFinite(raw_started_at) ||
    raw_started_at < 0
  ) {
    throw new RuntimePresenceValidationError(
      "started_at must be a non-negative number",
    );
  }
  const started_at = Math.min(
    Math.floor(raw_started_at),
    now + MAX_STARTED_AT_FUTURE_MS,
  );

  return {
    session_id,
    runtime_id,
    run_id,
    parent_run_id,
    kind,
    handle,
    display_name,
    status,
    model,
    activity,
    context_percent,
    started_at,
    client,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} now
 */
function pruneExpired(db, now) {
  db.prepare(
    `DELETE FROM agent_runtime_presence
     WHERE (status IN ('done', 'failed', 'aborted') AND
            ((ended_at > 0 AND ended_at < ?) OR
             (ended_at = 0 AND heartbeat_at < ?)))
        OR (status NOT IN ('done', 'failed', 'aborted') AND heartbeat_at < ?)`,
  ).run(
    now - TERMINAL_RETENTION_MS,
    now - TERMINAL_RETENTION_MS,
    now - FADING_MS,
  );
}

/**
 * @param {number} heartbeat_at
 * @param {string} status
 * @param {number} now
 * @returns {'live'|'fading'|'terminal'}
 */
function livenessFor(heartbeat_at, status, now) {
  if (TERMINAL_STATUSES.has(status)) return "terminal";
  const age = Math.max(0, now - heartbeat_at);
  return age < LIVE_MS ? "live" : age <= FADING_MS ? "fading" : "fading";
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function runtimeText(value, field) {
  if (typeof value !== "string") {
    throw new RuntimePresenceValidationError(`${field} must be a string`);
  }
  return value;
}

/**
 * Reject duplicate main rows in one request while still allowing an idempotent
 * heartbeat in a later request to refresh the existing main tuple.
 *
 * @param {Array<Record<string, unknown>>} rows
 */
function validateBatchMainTuples(rows) {
  const mainRuntimeIds = new Set();
  for (const row of rows) {
    if (row.kind !== "main") continue;
    const runtime_id = String(row.runtime_id);
    if (mainRuntimeIds.has(runtime_id)) {
      throw new RuntimePresenceConflictError(
        `runtime ${runtime_id} has duplicate main rows`,
      );
    }
    mainRuntimeIds.add(runtime_id);
  }
}

/**
 * Validate the lineage already persisted for one runtime incarnation. This is
 * defensive against rows written by an older implementation: a malformed or
 * duplicated main must not become a second parent when a valid main arrives.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} runtime_id
 */
function validateStoredRuntimeRows(rows, runtime_id) {
  let main_count = 0;
  for (const row of rows) {
    const kind = runtimeText(row.kind, "kind");
    const run_id = runtimeText(row.run_id, "run_id");
    const parent_run_id = runtimeText(row.parent_run_id, "parent_run_id");
    if (kind === "main") {
      main_count += 1;
      if (run_id !== runtime_id || parent_run_id !== "") {
        throw new RuntimePresenceConflictError(
          `runtime ${runtime_id} has malformed main lineage`,
        );
      }
    } else if (kind === "subagent" && parent_run_id !== runtime_id) {
      throw new RuntimePresenceConflictError(
        `runtime ${runtime_id} has malformed subagent lineage`,
      );
    }
  }
  if (main_count > 1) {
    throw new RuntimePresenceConflictError(
      `runtime ${runtime_id} has duplicate main rows`,
    );
  }
}

/**
 * Insert or refresh an authenticated owner's runtime rows in one transaction.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {unknown} owner - The authenticated agent or its durable id.
 * @param {Array<Record<string, unknown>>} rows
 * @param {number} [now]
 */
export function upsertRuntimePresence(db, owner, rows, now = Date.now()) {
  const agent_id = ownerId(owner);
  const at = validNow(now);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) {
    throw new RuntimePresenceValidationError(
      `rows must contain between 1 and ${MAX_ROWS} entries`,
    );
  }
  const normalized = rows.map((row) => normalizeRow(row, at));
  validateBatchMainTuples(normalized);

  /** @type {Map<string, string>} */
  const batchRuntimeSessions = new Map();
  for (const row of normalized) {
    const previous = batchRuntimeSessions.get(row.runtime_id);
    if (previous && previous !== row.session_id) {
      throw new RuntimePresenceConflictError(
        `runtime ${row.runtime_id} cannot change session_id`,
      );
    }
    batchRuntimeSessions.set(row.runtime_id, row.session_id);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // A runtime heartbeat is authenticated activity for the durable actor too.
    // Keep this in the same transaction as the presence write so a failed or
    // conflicting heartbeat cannot make last_seen_at claim activity that never
    // made it into the runtime table.
    db.prepare(
      "UPDATE agents SET last_seen_at = ? WHERE id = ? AND revoked_at = 0",
    ).run(at, agent_id);
    pruneExpired(db, at);
    const runtimeSession = db.prepare(
      `SELECT session_id FROM agent_runtime_presence
       WHERE agent_id = ? AND runtime_id = ? LIMIT 1`,
    );
    const existingLineage = db.prepare(
      `SELECT run_id, parent_run_id, kind
       FROM agent_runtime_presence
       WHERE agent_id = ? AND runtime_id = ?`,
    );
    const checkedRuntimes = new Set();
    for (const row of normalized) {
      if (checkedRuntimes.has(row.runtime_id)) continue;
      checkedRuntimes.add(row.runtime_id);
      validateStoredRuntimeRows(
        existingLineage.all(agent_id, row.runtime_id),
        row.runtime_id,
      );
    }
    const existing = db.prepare(
      `SELECT session_id, parent_run_id, kind, status, started_at
       FROM agent_runtime_presence
       WHERE agent_id = ? AND runtime_id = ? AND run_id = ?`,
    );
    const insert = db.prepare(
      `INSERT INTO agent_runtime_presence
       (agent_id, session_id, runtime_id, run_id, parent_run_id, kind, handle,
        display_name, status, model, activity, context_percent, started_at,
        ended_at, heartbeat_at, client)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = db.prepare(
      `UPDATE agent_runtime_presence SET
        handle = ?, display_name = ?, status = ?, model = ?, activity = ?,
        context_percent = ?, ended_at = ?, heartbeat_at = ?, client = ?
       WHERE agent_id = ? AND runtime_id = ? AND run_id = ?`,
    );

    for (const row of normalized) {
      const runtime = runtimeSession.get(agent_id, row.runtime_id);
      if (
        runtime &&
        runtimeText(runtime.session_id, "session_id") !== row.session_id
      ) {
        throw new RuntimePresenceConflictError(
          `runtime ${row.runtime_id} cannot change session_id`,
        );
      }
      const current = existing.get(agent_id, row.runtime_id, row.run_id);
      if (!current) {
        const terminal = TERMINAL_STATUSES.has(row.status);
        insert.run(
          agent_id,
          row.session_id,
          row.runtime_id,
          row.run_id,
          row.parent_run_id,
          row.kind,
          row.handle,
          row.display_name,
          row.status,
          row.model,
          row.activity,
          row.context_percent,
          row.started_at,
          terminal ? at : 0,
          at,
          row.client,
        );
        continue;
      }

      if (
        runtimeText(current.session_id, "session_id") !== row.session_id ||
        runtimeText(current.parent_run_id, "parent_run_id") !==
          row.parent_run_id ||
        runtimeText(current.kind, "kind") !== row.kind
      ) {
        throw new RuntimePresenceConflictError(
          `runtime row ${row.runtime_id}/${row.run_id} has an immutable tuple`,
        );
      }

      const current_status = runtimeText(current.status, "status");
      const current_terminal = TERMINAL_STATUSES.has(current_status);
      const incoming_terminal = TERMINAL_STATUSES.has(row.status);
      if (current_terminal) {
        if (current_status !== row.status) {
          throw new RuntimePresenceConflictError(
            `terminal runtime row ${row.runtime_id}/${row.run_id} cannot change status`,
          );
        }
        // A terminal row is final. In particular, repeated terminal updates must
        // not extend its five-minute retention window.
        continue;
      }

      update.run(
        row.handle,
        row.display_name,
        row.status,
        row.model,
        row.activity,
        row.context_percent,
        incoming_terminal ? at : 0,
        at,
        row.client,
        agent_id,
        row.runtime_id,
        row.run_id,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original validation or storage error.
    }
    throw error;
  }

  return { accepted: normalized.length, heartbeat_at: at };
}

/**
 * Remove active rows for one owner's runtime incarnation. Terminal history is
 * intentionally retained until its normal five-minute retention deadline.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {unknown} owner
 * @param {unknown} runtime_id
 * @param {string[] | undefined} [run_ids]
 */
export function dropRuntimePresence(db, owner, runtime_id, run_ids) {
  const agent_id = ownerId(owner);
  const runtime = boundedText(runtime_id, "runtime_id", MAX_ID_BYTES);
  if (runtime.length === 0) {
    throw new RuntimePresenceValidationError("runtime_id must not be empty");
  }
  if (run_ids !== undefined && !Array.isArray(run_ids)) {
    throw new RuntimePresenceValidationError("run_ids must be an array");
  }
  if (Array.isArray(run_ids) && run_ids.length > MAX_RUN_IDS) {
    throw new RuntimePresenceValidationError(
      `run_ids may contain at most ${MAX_RUN_IDS} entries`,
    );
  }
  const ids = run_ids?.map((run_id) => {
    const value = boundedText(run_id, "run_id", MAX_ID_BYTES);
    if (value.length === 0) {
      throw new RuntimePresenceValidationError("run_id must not be empty");
    }
    return value;
  });

  let sql = `DELETE FROM agent_runtime_presence
     WHERE agent_id = ? AND runtime_id = ?
       AND status NOT IN ('done', 'failed', 'aborted')`;
  /** @type {Array<string>} */
  const args = [agent_id, runtime];
  if (ids !== undefined) {
    if (ids.length === 0) return 0;
    sql += ` AND run_id IN (${ids.map(() => "?").join(", ")})`;
    args.push(...ids);
  }
  return Number(db.prepare(sql).run(...args).changes || 0);
}

/**
 * List non-expired runtime rows while joining only the safe durable actor handle.
 * Expired rows are lazily removed; revoked, archived, and expired owners are never
 * returned even if their rows remain in the registry.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: number }} [options]
 */
export function listRuntimePresence(db, options = {}) {
  const now = validNow(options.now);
  pruneExpired(db, now);
  const rows = db
    .prepare(
      `SELECT r.agent_id, a.actor, r.session_id, r.runtime_id, r.run_id,
              r.parent_run_id, r.kind, r.handle, r.display_name, r.status,
              r.model, r.activity, r.context_percent, r.started_at,
              r.ended_at, r.heartbeat_at, r.client
       FROM agent_runtime_presence r
       JOIN agents a ON a.id = r.agent_id
       WHERE a.revoked_at = 0 AND a.archived_at = 0
         AND (a.expires_at = 0 OR a.expires_at > ?)
       ORDER BY r.heartbeat_at DESC, r.runtime_id, r.run_id`,
    )
    .all(now);

  return rows.map((row) => ({
    ...row,
    agent_id: runtimeText(row.agent_id, "agent_id"),
    actor: runtimeText(row.actor, "actor"),
    session_id: runtimeText(row.session_id, "session_id"),
    runtime_id: runtimeText(row.runtime_id, "runtime_id"),
    run_id: runtimeText(row.run_id, "run_id"),
    parent_run_id: runtimeText(row.parent_run_id, "parent_run_id"),
    kind: runtimeText(row.kind, "kind"),
    handle: runtimeText(row.handle, "handle"),
    display_name: runtimeText(row.display_name, "display_name"),
    status: runtimeText(row.status, "status"),
    model: runtimeText(row.model, "model"),
    activity: runtimeText(row.activity, "activity"),
    context_percent: Number(row.context_percent),
    started_at: Number(row.started_at),
    ended_at: Number(row.ended_at),
    heartbeat_at: Number(row.heartbeat_at),
    client: runtimeText(row.client, "client"),
    liveness: livenessFor(
      Number(row.heartbeat_at),
      runtimeText(row.status, "status"),
      now,
    ),
  }));
}
