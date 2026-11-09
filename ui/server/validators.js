/**
 * Validation helpers for protocol payloads.
 *
 * Provides schema checks for subscription specs and selected mutations.
 */

/**
 * Known subscription types supported by the server.
 *
 * @type {Set<string>}
 */
const SUBSCRIPTION_TYPES = new Set([
  'all-issues',
  'epics',
  'blocked-issues',
  'ready-issues',
  'in-progress-issues',
  'closed-issues',
  'issue-detail',
  'flares'
]);

/**
 * Validate a `set-board` payload (feads).
 *
 * Three ways to name a board, in precedence order: its registry `id`, its
 * `.beads` directory, or a project root to discover one from. At least one has
 * to be present — an empty payload would otherwise silently re-select whatever
 * board is already active.
 *
 * @param {unknown} payload
 * @returns {{ ok: true, id: string, board_dir: string, path: string } | { ok: false, code: 'bad_request', message: string }}
 */
export function validateSetBoardPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload must be an object'
    };
  }
  const any =
    /** @type {{ id?: unknown, board_dir?: unknown, path?: unknown }} */ (
      payload
    );

  /**
   * @param {unknown} value
   * @returns {string}
   */
  const str = (value) => (typeof value === 'string' ? value.trim() : '');

  const id = str(any.id);
  const board_dir = str(any.board_dir);
  const board_path = str(any.path);

  if (id.length === 0 && board_dir.length === 0 && board_path.length === 0) {
    return {
      ok: false,
      code: 'bad_request',
      message:
        'payload requires one of { id: string } (registry board id), { board_dir: string } or { path: string }'
    };
  }

  return { ok: true, id, board_dir, path: board_path };
}

/**
 * Validate the destructive remove-user payload. Confirmation is deliberately
 * compared before trimming or canonicalizing: the caller must type the exact
 * actor string it is asking to remove, while the registry later matches the
 * target case-insensitively.
 *
 * @param {unknown} payload
 * @returns {{ ok: true, actor: string, confirm_actor: string } | { ok: false, code: 'bad_request', message: string }}
 */
export function validateRemoveUserPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload must be an object'
    };
  }
  const p = /** @type {{ actor?: unknown, confirm_actor?: unknown }} */ (
    payload
  );
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (payload));
  if (keys.some((key) => key !== 'actor' && key !== 'confirm_actor')) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload accepts only actor and confirm_actor'
    };
  }
  if (typeof p.actor !== 'string' || p.actor.length === 0) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload.actor must be a non-empty string'
    };
  }
  if (p.actor.trim() !== p.actor) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload.actor must not have surrounding whitespace'
    };
  }
  if (typeof p.confirm_actor !== 'string' || p.confirm_actor !== p.actor) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload.confirm_actor must exactly match payload.actor'
    };
  }
  return { ok: true, actor: p.actor, confirm_actor: p.confirm_actor };
}

/**
 * Validate a `list-agents` payload (feads).
 *
 * The payload is optional in full: a client that just wants the roster sends
 * nothing. `include_revoked` is opt-in because a revoked agent's row is kept
 * deliberately — it is the provenance of the claims it made — but it is history,
 * not a live collaborator, so it does not belong in the default list.
 *
 * @param {unknown} payload
 * @returns {{ ok: true, include_revoked: boolean } | { ok: false, code: 'bad_request', message: string }}
 */
export function validateListAgentsPayload(payload) {
  if (payload === undefined || payload === null) {
    return { ok: true, include_revoked: false };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload must be an object when provided'
    };
  }
  const any = /** @type {{ include_revoked?: unknown }} */ (payload);
  if (
    any.include_revoked !== undefined &&
    typeof any.include_revoked !== 'boolean'
  ) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload.include_revoked must be a boolean when provided'
    };
  }
  return { ok: true, include_revoked: any.include_revoked === true };
}

/**
 * Validate a subscribe-list payload and normalize to a SubscriptionSpec.
 *
 * @param {unknown} payload
 * @returns {{ ok: true, id: string, spec: { type: string, params?: Record<string, string|number|boolean> } } | { ok: false, code: 'bad_request', message: string }}
 */
export function validateSubscribeListPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload must be an object'
    };
  }
  const any =
    /** @type {{ id?: unknown, type?: unknown, params?: unknown }} */ (payload);

  const id = typeof any.id === 'string' ? any.id : '';
  if (id.length === 0) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload.id must be a non-empty string'
    };
  }

  const type = typeof any.type === 'string' ? any.type : '';
  if (type.length === 0 || !SUBSCRIPTION_TYPES.has(type)) {
    return {
      ok: false,
      code: 'bad_request',
      message: `payload.type must be one of: ${Array.from(SUBSCRIPTION_TYPES).join(', ')}`
    };
  }

  /** @type {Record<string, string|number|boolean> | undefined} */
  let params;
  if (any.params !== undefined) {
    if (
      !any.params ||
      typeof any.params !== 'object' ||
      Array.isArray(any.params)
    ) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'payload.params must be an object when provided'
      };
    }
    params = /** @type {Record<string, string|number|boolean>} */ (any.params);
  }

  // Per-type param schemas
  if (type === 'flares') {
    if (params && Object.keys(params).some((key) => key !== 'issue_id')) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'flares accepts only params.issue_id'
      };
    }
    if (params?.issue_id !== undefined) {
      const issue_id = String(params.issue_id).trim();
      if (!issue_id)
        return {
          ok: false,
          code: 'bad_request',
          message: 'params.issue_id must be non-empty'
        };
      params = { issue_id };
    } else {
      params = undefined;
    }
  } else if (type === 'issue-detail') {
    const id = String(params?.id ?? '').trim();
    if (id.length === 0) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'params.id must be a non-empty string'
      };
    }
    params = { id };
  } else if (type === 'closed-issues') {
    if (params && 'since' in params) {
      const since = params.since;
      const n = typeof since === 'number' ? since : Number.NaN;
      if (!Number.isFinite(n) || n < 0) {
        return {
          ok: false,
          code: 'bad_request',
          message: 'params.since must be a non-negative number (epoch ms)'
        };
      }
      params = { since: n };
    } else {
      params = undefined;
    }
  } else {
    // Other types do not accept params
    if (params && Object.keys(params).length > 0) {
      return {
        ok: false,
        code: 'bad_request',
        message: `type ${type} does not accept params`
      };
    }
    params = undefined;
  }

  return { ok: true, id, spec: { type, params } };
}

/**
 * Validate a `list-notifications` payload (feads).
 *
 * Everything is optional: the default is "my unread, newest 50", which is what
 * a bell wants on open. The limit ceiling matches the store's own.
 *
 * @param {unknown} payload
 * @returns {{ ok: true, unread_only: boolean, limit: number } | { ok: false, code: 'bad_request', message: string }}
 */
export function validateListNotificationsPayload(payload) {
  const p = /** @type {Record<string, unknown>} */ (payload || {});
  if (typeof p !== 'object' || Array.isArray(p)) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload must be an object'
    };
  }
  if ('unread_only' in p && typeof p.unread_only !== 'boolean') {
    return {
      ok: false,
      code: 'bad_request',
      message: 'unread_only must be a boolean'
    };
  }
  let limit = 50;
  if ('limit' in p && p.limit !== undefined) {
    const n = typeof p.limit === 'number' ? p.limit : Number.NaN;
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'limit must be a number between 1 and 200'
      };
    }
    limit = Math.floor(n);
  }
  return {
    ok: true,
    unread_only: p.unread_only !== false,
    limit
  };
}

/**
 * Validate an `ack-notifications` payload (feads).
 *
 * Either specific ids or `all: true` — an empty ack is a caller bug worth
 * surfacing, not a silent no-op.
 *
 * @param {unknown} payload
 * @returns {{ ok: true, ids: string[] | undefined, all: boolean } | { ok: false, code: 'bad_request', message: string }}
 */
export function validateAckNotificationsPayload(payload) {
  const p = /** @type {Record<string, unknown>} */ (payload || {});
  if (typeof p !== 'object' || Array.isArray(p)) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload must be an object'
    };
  }
  const all = p.all === true;
  /** @type {string[] | undefined} */
  let ids;
  if ('ids' in p && p.ids !== undefined) {
    if (
      !Array.isArray(p.ids) ||
      p.ids.some((v) => typeof v !== 'string' || v.length === 0)
    ) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'ids must be an array of non-empty strings'
      };
    }
    ids = /** @type {string[]} */ (p.ids);
  }
  if (!all && (!ids || ids.length === 0)) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload requires ids: string[] or all: true'
    };
  }
  return { ok: true, ids, all };
}
