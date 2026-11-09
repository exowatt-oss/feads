/**
 * Space RBAC — the one decision every surface asks once accounts mode is on.
 *
 * `boards/authz.mjs` answers "may this *tier* do this"; this module answers "may
 * this *principal* touch this *space*". Callers compose the two (both must allow)
 * and never re-derive either. It is pure — no SQL, no clock, no environment — so
 * the Node dashboard, the operator CLI and the Python MCP (`beads_mcp/access.py`)
 * can be pinned to the same answers by `boards/access-cases.json`. A disagreement
 * between surfaces here would be a cross-space leak, not a quirk.
 *
 * A principal is plain data (see `principalShape`). Loading one — which user,
 * which aliases, which spaces — is `boards/accounts.mjs`'s job.
 *
 * Deny by default: an unknown action, an unknown principal kind, a missing space
 * or a malformed principal all answer `allowed: false`.
 *
 * Design: the excluded hosted-provider design
 */

/** Principal kinds. Anything else is treated as anonymous. */
export const PRINCIPAL_KINDS = /** @type {const} */ ([
  'user',
  'service',
  'legacy_agent',
  'system',
  'operator',
  'anonymous'
]);

/** How a user principal arrived. `sso` is the only browser door. */
export const BROWSER_VIA = 'sso';

/** Every action this policy knows. */
export const ACCESS_ACTIONS = /** @type {const} */ ([
  'space_read',
  'item_write',
  'item_delete',
  'dep_link',
  'board_create',
  'board_manage',
  'space_create',
  'space_delete',
  'space_manage',
  'accounts_admin',
  'self_settings',
  'connection_mint',
  'connection_manage',
  'system_key_mint',
  'system_key_manage',
  'service_manage',
  'directory_read'
]);

/**
 * @typedef {Object} Principal
 * @property {'user'|'service'|'legacy_agent'|'system'|'operator'|'anonymous'} kind
 * @property {string} [via] - sso | personal_token | legacy_token | worker_email | service_key | token | session | none
 * @property {string} [user_id]
 * @property {string} [actor]
 * @property {string[]} [aliases]
 * @property {boolean} [is_superadmin]
 * @property {boolean} [agents_all_spaces]
 * @property {Record<string, 'member'|'admin'>} [memberships] - space_id → role
 * @property {string[]} [key_spaces] - system keys: the key's own scope
 * @property {Record<string, 'member'|'admin'>} [minter_memberships] - system keys
 * @property {boolean} [minter_superadmin]
 * @property {boolean} [minter_agents_all_spaces]
 * @property {boolean} [minter_live] - system keys: the minter can still act
 * @property {string} [legacy_role] - tier of an unclaimed legacy agent
 * @property {string} [default_space] - the space unclaimed agents are confined to
 * @property {string[]} [all_spaces] - every space id (needed to expand "all")
 * @property {boolean} [read_only] - service accounts: writes need the literal `false`
 */

/**
 * @param {unknown} value
 * @returns {Record<string, 'member'|'admin'>}
 */
function memberships(value) {
  /** @type {Record<string, 'member'|'admin'>} */
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [space, role] of Object.entries(value)) {
    if (typeof space === 'string' && space.length > 0) {
      out[space] = role === 'admin' ? 'admin' : 'member';
    }
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  return Array.isArray(value)
    ? value.filter((v) => typeof v === 'string' && v.length > 0)
    : [];
}

/**
 * @param {Principal | null | undefined} p
 * @returns {Principal['kind']}
 */
function kindOf(p) {
  const kind = p && typeof p === 'object' ? String(p.kind || '') : '';
  return /** @type {any} */ (
    PRINCIPAL_KINDS.includes(/** @type {any} */ (kind)) ? kind : 'anonymous'
  );
}

/**
 * Whether a user principal arrived through the browser door.
 *
 * @param {Principal} p
 * @returns {boolean}
 */
export function isBrowser(p) {
  return kindOf(p) === 'user' && String(p.via || '') === BROWSER_VIA;
}

/**
 * The spaces a principal may read (and, unless read-only, write). `null` means
 * every space.
 *
 * - browser user: superadmin → all; else member spaces
 * - agent-surface user (tokens, MCP edge): superadmin with access-all → all; else member spaces
 * - unclaimed legacy agent: the default space only (where every pre-migration board lives)
 * - service account: its own member spaces, nothing else — never "all", whatever
 *   flags a malformed principal carries (a service is never a superadmin)
 * - system key: key scope ∩ the minter's *current* agent-surface spaces
 * - operator: all; anonymous: none
 *
 * @param {Principal | null | undefined} p
 * @returns {Set<string> | null}
 */
export function accessibleSpaces(p) {
  const kind = kindOf(p);
  const P = /** @type {Principal} */ (p || { kind: 'anonymous' });
  if (kind === 'operator') return null;
  if (kind === 'anonymous') return new Set();
  if (kind === 'legacy_agent') {
    const d = String(P.default_space || '');
    return new Set(d ? [d] : []);
  }
  if (kind === 'service') {
    return new Set(Object.keys(memberships(P.memberships)));
  }
  if (kind === 'system') {
    if (P.minter_live !== true) return new Set();
    const key = new Set(stringList(P.key_spaces));
    const minter_all =
      P.minter_superadmin === true && P.minter_agents_all_spaces === true;
    if (minter_all) return key;
    const minter = memberships(P.minter_memberships);
    return new Set([...key].filter((s) => s in minter));
  }
  // user
  if (P.is_superadmin === true) {
    if (isBrowser(P)) return null;
    if (P.agents_all_spaces === true) return null;
  }
  return new Set(Object.keys(memberships(P.memberships)));
}

/**
 * @param {Principal | null | undefined} p
 * @param {string} space
 * @returns {boolean}
 */
export function canReadSpace(p, space) {
  if (typeof space !== 'string' || space.length === 0) return false;
  const spaces = accessibleSpaces(p);
  return spaces === null ? true : spaces.has(space);
}

/**
 * @param {Principal | null | undefined} p
 * @returns {boolean}
 */
export function isReadOnly(p) {
  const kind = kindOf(p);
  if (kind === 'service') {
    // Deny by default: a service writes only when its principal says, literally,
    // that it is not read-only.
    return /** @type {Principal} */ (p).read_only !== false;
  }
  return kind === 'system' || kind === 'anonymous';
}

/**
 * @param {Principal} p
 * @param {string} space
 * @returns {boolean}
 */
function isSpaceAdmin(p, space) {
  return memberships(p.memberships)[space] === 'admin';
}

/**
 * @param {boolean} allowed
 * @param {string} reason
 * @returns {{ allowed: boolean, reason: string }}
 */
function answer(allowed, reason) {
  return { allowed, reason };
}

/**
 * Decide one action.
 *
 * `resource` carries what the action is about:
 * - `space` — the space id the board/item lives in (most actions)
 * - `other_space` — the second endpoint's space (`dep_link`)
 * - `created_by` — the item's creator (`item_delete`)
 * - `owner_user_id` — whose row it is (`connection_manage`, `system_key_manage`, `self_settings`)
 * - `spaces` — requested key scope (`system_key_mint`); every space a service account
 *   has or is asked for (`service_manage`)
 *
 * @param {Principal | null | undefined} principal
 * @param {string} action
 * @param {{ space?: string, other_space?: string, created_by?: string,
 *           owner_user_id?: string, spaces?: string[] }} [resource]
 * @returns {{ allowed: boolean, reason: string }}
 */
export function decideAccess(principal, action, resource = {}) {
  const p = /** @type {Principal} */ (principal || { kind: 'anonymous' });
  const kind = kindOf(p);
  const r = resource && typeof resource === 'object' ? resource : {};
  const space = typeof r.space === 'string' ? r.space : '';

  if (!ACCESS_ACTIONS.includes(/** @type {any} */ (action))) {
    return answer(false, `unknown action "${String(action)}"`);
  }
  if (kind === 'anonymous') {
    return answer(false, 'sign in with an external SSO provider or present a valid token');
  }
  if (kind === 'operator') {
    return answer(true, 'local operator');
  }

  const superadmin = kind === 'user' && p.is_superadmin === true;
  const browser = isBrowser(p);

  switch (action) {
    case 'space_read':
      return canReadSpace(p, space)
        ? answer(true, 'space member')
        : answer(false, 'no access to this space');

    case 'item_write':
    case 'board_manage': {
      if (isReadOnly(p)) return answer(false, 'this credential is read-only');
      return canReadSpace(p, space)
        ? answer(true, 'space member')
        : answer(false, 'no access to this space');
    }

    case 'dep_link': {
      if (isReadOnly(p)) return answer(false, 'this credential is read-only');
      const other = typeof r.other_space === 'string' ? r.other_space : '';
      if (!canReadSpace(p, space) || !canReadSpace(p, other)) {
        return answer(false, 'no access to this space');
      }
      return space === other
        ? answer(true, 'same space')
        : answer(false, 'dependencies cannot cross spaces');
    }

    case 'item_delete': {
      if (isReadOnly(p)) return answer(false, 'this credential is read-only');
      if (!canReadSpace(p, space)) {
        return answer(false, 'no access to this space');
      }
      const creator = String(r.created_by || '').toLowerCase();
      const aliases = stringList(p.aliases).map((a) => a.toLowerCase());
      if (creator && aliases.includes(creator)) {
        return answer(true, 'own item');
      }
      // Deleting someone else's item is a superadmin power of the dashboard
      // session only: an agent holding a superadmin's token (personal, legacy or
      // MCP edge) deletes like any member — its own items, or as a space admin.
      if (superadmin && browser) {
        return answer(true, 'superadmin');
      }
      // A service account deletes only its own items: it is never a space admin
      // and never a superadmin, whatever its membership row says.
      if (kind === 'user' && isSpaceAdmin(p, space)) {
        return answer(true, 'space admin');
      }
      if (kind === 'legacy_agent' && String(p.legacy_role || '') === 'admin') {
        return answer(true, 'legacy admin tier');
      }
      return answer(false, 'only the creator, a space admin or a superadmin may delete');
    }

    case 'board_create': {
      // Any write-capable member may register a board in a space it can write —
      // agents do this today and the migration must not take it away. Moving a
      // board between spaces is not this action: it is `space_manage` on both.
      if (isReadOnly(p)) return answer(false, 'this credential is read-only');
      return canReadSpace(p, space)
        ? answer(true, 'space member')
        : answer(false, 'no access to this space');
    }

    case 'space_create':
    case 'space_delete':
    case 'accounts_admin':
      return superadmin && browser
        ? answer(true, 'superadmin')
        : answer(false, 'superadmins only, from the dashboard');

    case 'space_manage':
      if (!browser) return answer(false, 'manage spaces from the dashboard');
      return superadmin || isSpaceAdmin(p, space)
        ? answer(true, superadmin ? 'superadmin' : 'space admin')
        : answer(false, 'only a space admin or superadmin may manage this space');

    case 'self_settings':
      return superadmin && browser && String(r.owner_user_id || '') === String(p.user_id || '')
        ? answer(true, 'own settings')
        : answer(false, 'superadmins change only their own settings, from the dashboard');

    case 'connection_mint':
      return kind === 'user' && browser
        ? answer(true, 'signed-in user')
        : answer(false, 'connection tokens are minted from a signed-in dashboard session');

    case 'connection_manage':
      return kind === 'user' && browser && String(r.owner_user_id || '') === String(p.user_id || '')
        ? answer(true, 'own connection')
        : answer(false, 'only the owner may manage a connection');

    case 'system_key_mint': {
      if (!(kind === 'user' && browser)) {
        return answer(false, 'system keys are minted from a signed-in dashboard session');
      }
      const wanted = stringList(r.spaces);
      if (wanted.length === 0) return answer(false, 'choose at least one space');
      // Capped at the minter's agent-surface spaces: a key never sees more than
      // the minter's own agents could.
      const agentView = accessibleSpaces({ ...p, via: 'personal_token' });
      const ok = wanted.every((s) => (agentView === null ? true : agentView.has(s)));
      return ok
        ? answer(true, 'within your spaces')
        : answer(false, 'a key may only cover spaces your agents can access');
    }

    case 'service_manage': {
      // Create a service account, change its steward, spaces or read-only flag,
      // mint or revoke its keys. A superadmin anywhere; a space admin only when
      // every space the service has (and every space asked for) is one they
      // administer — so a space admin can never reach into another space through
      // a service account. Always from the dashboard.
      if (!browser) return answer(false, 'manage service accounts from the dashboard');
      if (superadmin) return answer(true, 'superadmin');
      const spaces = stringList(r.spaces);
      if (spaces.length === 0) {
        return answer(false, 'only a superadmin may manage a service account with no spaces');
      }
      return spaces.every((s) => isSpaceAdmin(p, s))
        ? answer(true, 'space admin of every space involved')
        : answer(false, 'only a superadmin or an admin of every space involved may manage this service account');
    }

    case 'system_key_manage':
      if (!(kind === 'user' && browser)) return answer(false, 'manage keys from the dashboard');
      return superadmin || String(r.owner_user_id || '') === String(p.user_id || '')
        ? answer(true, superadmin ? 'superadmin' : 'own key')
        : answer(false, 'only the minter or a superadmin may manage this key');

    case 'directory_read':
      return answer(true, 'identified caller');

    default:
      return answer(false, 'denied');
  }
}

/**
 * Filter a list of board ids to those whose space the principal may read.
 *
 * @param {Principal | null | undefined} p
 * @param {Array<{ id: string, space_id: string }>} boards
 * @returns {string[]}
 */
export function readableBoardIds(p, boards) {
  const spaces = accessibleSpaces(p);
  return boards
    .filter((b) => (spaces === null ? true : spaces.has(String(b.space_id || ''))))
    .map((b) => String(b.id));
}
