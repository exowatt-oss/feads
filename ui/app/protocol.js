/**
 * Protocol definitions for beads-ui WebSocket communication.
 *
 * Conventions
 * - All messages are JSON objects.
 * - Client → Server uses RequestEnvelope.
 * - Server → Client uses ReplyEnvelope.
 * - Every request is correlated by `id` in replies.
 * - Server can also send unsolicited events (e.g., subscription `snapshot`).
 */

/** @typedef {'ping'|'list-issues'|'update-status'|'edit-text'|'update-priority'|'create-issue'|'list-ready'|'dep-add'|'dep-remove'|'epic-status'|'update-assignee'|'label-add'|'label-remove'|'subscribe-list'|'unsubscribe-list'|'watch-agentwatch'|'unwatch-agentwatch'|'snapshot'|'upsert'|'delete'|'flares'|'get-comments'|'add-comment'|'delete-issue'|'list-workspaces'|'set-workspace'|'set-board'|'get-workspace'|'workspace-changed'|'whoami'|'list-agents'|'build-info'|'epic-graph'|'epic-history'|'list-notifications'|'ack-notifications'|'list-users'|'remove-user'|'notification'|'agentwatch'} MessageType */

/**
 * @typedef {Object} RequestEnvelope
 * @property {string} id - Unique id to correlate request/response.
 * @property {MessageType} type - Message type.
 * @property {unknown} [payload] - Message payload.
 */

/**
 * @typedef {Object} ErrorObject
 * @property {string} code - Stable error code.
 * @property {string} message - Human-readable message.
 * @property {unknown} [details] - Optional extra info for debugging.
 */

/**
 * @typedef {Object} ReplyEnvelope
 * @property {string} id - Correlates to the originating request.
 * @property {boolean} ok - True when request succeeded; false on error.
 * @property {MessageType} type - Echoes request type (or event type).
 * @property {unknown} [payload] - Response payload.
 * @property {ErrorObject} [error] - Present when ok=false.
 */

/** @type {MessageType[]} */
export const MESSAGE_TYPES = /** @type {const} */ ([
  // Transport liveness. The server has always answered it; the client sends
  // one periodically to detect a half-open socket (see app/ws.js).
  'ping',
  'list-issues',
  'update-status',
  'edit-text',
  'update-priority',
  'create-issue',
  'list-ready',
  'dep-add',
  'dep-remove',
  'epic-status',
  'update-assignee',
  'label-add',
  'label-remove',
  'subscribe-list',
  'unsubscribe-list',
  // Agentwatch is an explicit, read-authorized live snapshot subscription. The
  // request types return a snapshot/ack reply; `agentwatch` is server-initiated.
  'watch-agentwatch',
  'unwatch-agentwatch',
  'agentwatch',
  // feads: subscribe-list type `flares` pushes advisory work presence.
  // Request payload: {id, type:'flares', params?: {issue_id}}. Push payloads use
  // {type:'snapshot', id, revision, flares:[flare]}, then {type:'upsert', id,
  // revision, flare} or {type:'delete', id, revision, issue_id}.
  // vNext per-subscription full-issue push events
  'snapshot',
  'upsert',
  'delete',
  // feads: event type used by clients that opt into the flares list.
  'flares',
  // Comments
  'get-comments',
  'add-comment',
  // Delete issue
  'delete-issue',
  // Workspace management
  'list-workspaces',
  'set-workspace',
  // feads: select a board by registry id or `.beads` directory, which
  // set-workspace's project-root path cannot express
  'set-board',
  'get-workspace',
  'workspace-changed',
  // feads: agent identity. `whoami` is what tells the UI whether it is acting as
  // a registered agent or as the operator, which is what gates the admin view.
  'whoami',
  'list-agents',
  // feads: which build the daemon is running, and which of the two kinds of
  // staleness the client has. Sent on connect and again whenever it changes — a
  // browser cannot ask "am I out of date?" while it is out of date, so this is
  // server-initiated. See `server/build-identity.js`.
  'build-info',
  // feads: the epic story view. `epic-graph` is the current dependency graph of
  // one epic (a fresh capture, so it doubles as a snapshot point);
  // `epic-history` is the recorded snapshot series it replays. See
  // `server/story-snapshots.js`.
  'epic-graph',
  'epic-history',
  // feads: the notification centre and the directory it names people from.
  // `list-notifications` and `ack-notifications` are the bell's two calls;
  // `list-users` is the registry of live actors, which is what tells a comment
  // renderer that `@someone` is a person rather than a word starting with an at
  // sign. `notification` is server-initiated — a notification exists because
  // something happened elsewhere, so no client is in a position to ask for it.
  'list-notifications',
  'ack-notifications',
  'list-users',
  // Admin-only account removal. Request payload is {actor, confirm_actor},
  // with confirm_actor exactly matching actor; the reply payload contains the
  // server's removal count summary.
  'remove-user',
  'notification'
]);

/**
 * Generate a lexically sortable request id.
 *
 * @returns {string}
 */
export function nextId() {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${now}-${rand}`;
}

/**
 * Create a request envelope.
 *
 * @param {MessageType} type - Message type.
 * @param {unknown} [payload] - Message payload.
 * @param {string} [id] - Optional id; generated if omitted.
 * @returns {RequestEnvelope}
 */
export function makeRequest(type, payload, id = nextId()) {
  return { id, type, payload };
}

/**
 * Create a successful reply envelope for a given request.
 *
 * @param {RequestEnvelope} req - Original request.
 * @param {unknown} [payload] - Reply payload.
 * @returns {ReplyEnvelope}
 */
export function makeOk(req, payload) {
  return { id: req.id, ok: true, type: req.type, payload };
}

/**
 * Create an error reply envelope for a given request.
 *
 * @param {RequestEnvelope} req - Original request.
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {ReplyEnvelope}
 */
export function makeError(req, code, message, details) {
  return {
    id: req.id,
    ok: false,
    type: req.type,
    error: { code, message, details }
  };
}

/**
 * Check if a value is a plain object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Type guard for MessageType values.
 *
 * @param {unknown} value
 * @returns {value is MessageType}
 */
export function isMessageType(value) {
  return (
    typeof value === 'string' &&
    MESSAGE_TYPES.includes(/** @type {MessageType} */ (value))
  );
}

/**
 * Type guard for RequestEnvelope.
 *
 * @param {unknown} value
 * @returns {value is RequestEnvelope}
 */
export function isRequest(value) {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    (value.payload === undefined || 'payload' in value)
  );
}

/**
 * Type guard for ReplyEnvelope.
 *
 * @param {unknown} value
 * @returns {value is ReplyEnvelope}
 */
export function isReply(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.ok !== 'boolean' ||
    !isMessageType(value.type)
  ) {
    return false;
  }
  if (value.ok === false) {
    const err = value.error;
    if (
      !isRecord(err) ||
      typeof err.code !== 'string' ||
      typeof err.message !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Normalize and validate an incoming JSON value as a RequestEnvelope.
 * Throws a user-friendly error if invalid.
 *
 * @param {unknown} json
 * @returns {RequestEnvelope}
 */
export function decodeRequest(json) {
  if (!isRequest(json)) {
    throw new Error('Invalid request envelope');
  }
  return json;
}

/**
 * Normalize and validate an incoming JSON value as a ReplyEnvelope.
 *
 * @param {unknown} json
 * @returns {ReplyEnvelope}
 */
export function decodeReply(json) {
  if (!isReply(json)) {
    throw new Error('Invalid reply envelope');
  }
  return json;
}
