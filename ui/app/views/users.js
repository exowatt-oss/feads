import { html, render } from 'lit-html';
import { createActorChip } from '../utils/actor-name.js';
import { debug } from '../utils/logging.js';
import { ownerOf, personKeyOf, setOwnerDirectory } from '../utils/owners.js';
import { relativeTime } from './agents-admin.js';
import { formatDateValue } from './detail.js';

/**
 * feads addition — the actor directory and account administration page.
 *
 * The same `list-users` answer the comment renderer uses to tell `@someone` from
 * a word beginning with an at sign, shown to the person doing the writing. It
 * exists because a mention is only useful if you can spell it: the handle is the
 * address, the display name is how you recognise whose address it is, and the
 * admin action stays next to that context rather than in a separate control
 * plane.
 */

/**
 * @typedef {import('../state.js').AppState} AppState
 */

/**
 * @typedef {Object} DirectoryRow
 * @property {string} actor
 * @property {string} display_name
 * @property {string} role
 * @property {string} kind
 * @property {string} steward - a service account's steward actor ('' otherwise)
 * @property {string} steward_display_name
 * @property {string} parent_actor
 * @property {number} registered_at
 * @property {number} last_seen_at
 * @property {boolean | null} online
 * @property {boolean | null} is_online
 * @property {unknown} current_presence
 * @property {unknown} presence
 * @property {string} activity_status
 * @property {string} activity_source
 */

const REMOVAL_COUNT_LABELS = /** @type {Record<string, string>} */ ({
  account_access: 'account access records',
  credentials: 'credentials',
  sessions: 'active sessions',
  presence: 'presence records',
  notifications: 'notifications',
  invites: 'invites',
  issues: 'authored issues',
  comments: 'authored comments',
  dependencies: 'dependencies',
  assignments: 'assignments',
  tombstone: 'security tombstones'
});

/**
 * Coerce one `list-users` row into the shape the table renders.
 *
 * The server is the authority on this list and its fields have grown over time,
 * so every one is defaulted rather than trusted. Optional presence fields are
 * retained only to render server-provided state; this view never derives
 * presence from the age of `last_seen_at`.
 *
 * @param {any} row
 * @returns {DirectoryRow}
 */
function normalizeRow(row) {
  return {
    actor: String(row?.actor || ''),
    display_name: String(row?.display_name || ''),
    role: String(row?.role || ''),
    kind: String(row?.kind || ''),
    steward: String(row?.steward || ''),
    steward_display_name: String(row?.steward_display_name || ''),
    parent_actor: String(row?.parent_actor || ''),
    registered_at: Number(row?.registered_at || 0),
    last_seen_at: Number(row?.last_seen_at || 0),
    online: typeof row?.online === 'boolean' ? row.online : null,
    is_online: typeof row?.is_online === 'boolean' ? row.is_online : null,
    current_presence: row?.current_presence,
    presence: row?.presence,
    activity_status: String(row?.activity_status || ''),
    activity_source: String(row?.activity_source || '')
  };
}

/**
 * Most recently active first.
 *
 * @param {DirectoryRow} a
 * @param {DirectoryRow} b
 * @returns {number}
 */
function byLastSeenDesc(a, b) {
  if (b.last_seen_at !== a.last_seen_at) {
    return b.last_seen_at - a.last_seen_at;
  }
  return a.actor.toLowerCase().localeCompare(b.actor.toLowerCase());
}

/**
 * Group a person's rows together (accounts mode: an alias sits under its owner).
 * People are ordered by their most recent activity across every alias; within a
 * person the person's own row comes first, then aliases by recency. Accounts off
 * (no owners): every row is its own person and the order is `byLastSeenDesc`.
 *
 * @param {DirectoryRow[]} rows
 * @returns {DirectoryRow[]}
 */
export function groupRowsByPerson(rows) {
  /** @type {Map<string, number>} */
  const latest = new Map();
  for (const row of rows) {
    const key = personKeyOf(row.actor).toLowerCase();
    latest.set(key, Math.max(latest.get(key) ?? 0, row.last_seen_at || 0));
  }
  return [...rows].sort((a, b) => {
    const ka = personKeyOf(a.actor).toLowerCase();
    const kb = personKeyOf(b.actor).toLowerCase();
    if (ka !== kb) {
      const la = latest.get(ka) ?? 0;
      const lb = latest.get(kb) ?? 0;
      return lb !== la ? lb - la : ka.localeCompare(kb);
    }
    const own_a = ownerOf(a.actor) ? 1 : 0;
    const own_b = ownerOf(b.actor) ? 1 : 0;
    return own_a !== own_b ? own_a - own_b : byLastSeenDesc(a, b);
  });
}

/**
 * Only a loaded, registered admin may see the account-removal controls. An
 * operator can read the directory, but is not an admin viewer for this action.
 *
 * @param {any} identity
 * @returns {boolean}
 */
function isAdminViewer(identity) {
  return (
    identity?.loaded === true &&
    identity.mode === 'agent' &&
    String(identity.agent?.role || '').toLowerCase() === 'admin'
  );
}

/**
 * @param {unknown} value
 * @returns {boolean | null}
 */
function readPresenceValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['online', 'active', 'present', 'current'].includes(normalized)) {
      return true;
    }
    if (['offline', 'inactive', 'away', 'none', 'never'].includes(normalized)) {
      return false;
    }
    return null;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === 'object') {
    const record = /** @type {any} */ (value);
    for (const key of ['online', 'active', 'present']) {
      if (typeof record[key] === 'boolean') {
        return record[key];
      }
    }
    if (typeof record.status === 'string') {
      return readPresenceValue(record.status);
    }
    if (Array.isArray(record.sessions)) {
      return record.sessions.length > 0;
    }
  }
  return null;
}

/**
 * Read presence only from an explicit server field.
 *
 * @param {DirectoryRow} row
 * @returns {boolean | null}
 */
function serverPresence(row) {
  if (row.online !== null) {
    return row.online;
  }
  if (row.is_online !== null) {
    return row.is_online;
  }
  if (row.current_presence !== undefined) {
    return readPresenceValue(row.current_presence);
  }
  if (row.presence !== undefined) {
    return readPresenceValue(row.presence);
  }
  if (row.activity_status === 'active') {
    return true;
  }
  return null;
}

/**
 * @param {DirectoryRow} row
 * @returns {string}
 */
function lastSeenTitle(row) {
  // Keep the exact formatted timestamp in the title, including the server's
  // zero value. The visible label is the user-friendly Never state.
  return formatDateValue(row.last_seen_at);
}

/**
 * Make a short, server-backed activity label. A recent timestamp is not
 * treated as online: only an explicit `online`/`current_presence` value can
 * produce the Online or Offline label.
 *
 * @param {DirectoryRow} row
 * @returns {import('lit-html').TemplateResult}
 */
function activityTemplate(row) {
  const state = serverPresence(row);
  const recent =
    row.last_seen_at > 0 ? relativeTime(row.last_seen_at) : 'Never';
  if (state === true) {
    return html`
      <span class="users-presence users-presence--online">Active now</span>
      <span class="users-last-seen"> · ${recent}</span>
    `;
  }
  if (state === false) {
    return html`
      <span class="users-presence users-presence--offline">Offline</span>
      <span class="users-last-seen"> · ${recent}</span>
    `;
  }
  return html`<span class="users-last-seen">${recent}</span>`;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function countValue(value) {
  if (typeof value === 'boolean' || value === null || value === '') {
    return null;
  }
  const count = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null;
}

/**
 * @param {string} key
 * @param {number} count
 * @returns {string}
 */
function countLabel(key, count) {
  const label = REMOVAL_COUNT_LABELS[key] || key.replaceAll('_', ' ');
  if (count === 1) {
    return label.endsWith('s') ? label.slice(0, -1) : label;
  }
  return label;
}

/**
 * Turn the server's removal counts into an announcement. The named buckets
 * are deliberately tolerant of additive backend fields so an older frontend
 * can still report a useful summary when the server adds one.
 *
 * @param {any} result
 * @param {string} actor
 * @returns {string}
 */
function removalAnnouncement(result, actor) {
  const payload = result && typeof result === 'object' ? result : {};
  if (typeof payload.summary === 'string' && payload.summary.trim()) {
    return `Removed @${actor}. ${payload.summary.trim()}`;
  }

  const sources = [
    payload.removed_counts,
    payload.counts,
    payload.removed,
    payload.summary
  ];
  const source = sources.find(
    (candidate) => candidate && typeof candidate === 'object'
  );
  const counts = source && typeof source === 'object' ? source : payload;
  const entries = Object.entries(counts)
    .filter(([key]) => key !== 'total' && key !== 'actor')
    .map(([key, value]) => [key, countValue(value)])
    .filter((entry) => entry[1] !== null);

  if (entries.length > 0) {
    const details = entries
      .map(
        ([key, count]) =>
          `${count} ${countLabel(String(key), /** @type {number} */ (count))}`
      )
      .join(', ');
    return `Removed @${actor}. ${details}.`;
  }

  const total =
    countValue(payload.total) ??
    countValue(payload.removed_total) ??
    countValue(/** @type {any} */ (counts).total);
  if (total !== null) {
    return `Removed @${actor}. ${total} associated record${total === 1 ? '' : 's'} removed.`;
  }
  return `Removed @${actor} successfully.`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorMessage(value) {
  const message = /** @type {any} */ (value)?.message;
  return typeof message === 'string' && message.length > 0
    ? message
    : 'Failed to remove user';
}

/**
 * Create the registered-users directory view (feads).
 *
 * @param {HTMLElement} mount_element
 * @param {{ getState: () => AppState, subscribe: (fn: (s: AppState) => void) => () => void }} store
 * @param {(type: any, payload?: unknown) => Promise<any>} transport
 * @returns {{ load: () => Promise<void>, destroy: () => void }}
 */
export function createUsersView(mount_element, store, transport) {
  const log = debug('views:users');

  /** @type {DirectoryRow[]} */
  let rows = [];
  let error = '';
  let loaded = false;
  let loading = false;
  let announcement = '';

  let remove_actor = '';
  let remove_confirm_actor = '';
  let remove_error = '';
  let remove_submitting = false;
  let remove_dialog_open = false;
  /** @type {HTMLButtonElement | null} */
  let remove_trigger = null;

  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /** @returns {HTMLDialogElement | null} */
  function removeDialog() {
    return /** @type {HTMLDialogElement | null} */ (
      mount_element.querySelector('.users-remove-dialog')
    );
  }

  function focusRemoveInput() {
    removeDialog()?.querySelector('input')?.focus();
  }

  /** @param {boolean} focus */
  function ensureDialogOpen(focus) {
    const dialog = removeDialog();
    if (!dialog) {
      return;
    }
    if (!dialog.open) {
      try {
        if (typeof dialog.showModal === 'function') {
          dialog.showModal();
        } else {
          dialog.setAttribute('open', '');
        }
      } catch {
        // jsdom and older embedded browsers may expose <dialog> without the
        // modal methods. The open attribute still gives those environments a
        // usable confirmation surface.
        dialog.setAttribute('open', '');
      }
    }
    if (focus) {
      focusRemoveInput();
    }
  }

  /**
   * @param {{ heading?: boolean }} [options]
   */
  function closeRemoveDialog(options = {}) {
    const trigger = remove_trigger;
    const actor = remove_actor;
    const dialog = removeDialog();
    if (dialog?.open) {
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute('open');
      }
    }
    remove_dialog_open = false;
    remove_actor = '';
    remove_confirm_actor = '';
    remove_error = '';
    remove_submitting = false;
    remove_trigger = null;
    doRender();

    if (options.heading) {
      const heading = /** @type {HTMLElement | null} */ (
        mount_element.querySelector('.users-title')
      );
      heading?.focus();
      return;
    }
    if (trigger?.isConnected) {
      trigger.focus();
      return;
    }
    const replacement = Array.from(
      mount_element.querySelectorAll('.users-remove-action')
    ).find((button) => {
      const element = /** @type {HTMLButtonElement} */ (button);
      return !element.disabled && element.dataset.actor === actor;
    });
    const focus_target = /** @type {HTMLElement | null} */ (
      replacement || mount_element.querySelector('.users-title')
    );
    focus_target?.focus();
  }

  /**
   * @param {DirectoryRow} row
   * @param {Event} event
   */
  function openRemoveDialog(row, event) {
    const trigger = /** @type {HTMLButtonElement} */ (event.currentTarget);
    remove_actor = row.actor;
    remove_confirm_actor = '';
    remove_error = '';
    remove_submitting = false;
    remove_dialog_open = true;
    remove_trigger = trigger;
    announcement = '';
    doRender();
    ensureDialogOpen(true);
  }

  /** @param {Event} event */
  function onRemoveDialogCancel(event) {
    event.preventDefault();
    if (!remove_submitting) {
      closeRemoveDialog();
    }
  }

  /** @param {Event} event */
  function onRemoveDialogClick(event) {
    if (event.target === event.currentTarget && !remove_submitting) {
      closeRemoveDialog();
    }
  }

  /** @param {Event} event */
  function onRemoveConfirmInput(event) {
    remove_confirm_actor = String(
      /** @type {HTMLInputElement} */ (event.currentTarget).value
    );
    remove_error = '';
    doRender();
    ensureDialogOpen(false);
  }

  /** @param {SubmitEvent} event */
  async function onRemoveSubmit(event) {
    event.preventDefault();
    // The display handle includes @, but the protocol confirms the exact actor
    // string because the server's validator compares confirm_actor to actor.
    const expected = remove_actor;
    if (
      remove_submitting ||
      !remove_actor ||
      remove_confirm_actor !== expected
    ) {
      return;
    }

    const actor = remove_actor;
    const confirm_actor = remove_confirm_actor;
    remove_submitting = true;
    remove_error = '';
    doRender();
    ensureDialogOpen(false);

    try {
      const result = await transport('remove-user', { actor, confirm_actor });
      if (result?.ok === false) {
        throw new Error(result.error?.message || 'Failed to remove user');
      }
      const removed_actors = new Set(
        (Array.isArray(result?.removed_actors)
          ? result.removed_actors
          : [actor]
        ).map((/** @type {unknown} */ value) => String(value).toLowerCase())
      );
      rows = rows.filter((row) => !removed_actors.has(row.actor.toLowerCase()));
      announcement = removalAnnouncement(result, actor);
      log('user removed: %s', actor);
      const dialog = removeDialog();
      if (dialog?.open) {
        try {
          dialog.close();
        } catch {
          dialog.removeAttribute('open');
        }
      }
      remove_dialog_open = false;
      remove_actor = '';
      remove_confirm_actor = '';
      remove_error = '';
      remove_submitting = false;
      remove_trigger = null;
      doRender();
      // The trigger's row no longer exists. Focus the page heading so keyboard
      // users land on the changed context, while the live region announces the
      // server's count summary.
      const heading = /** @type {HTMLElement | null} */ (
        mount_element.querySelector('.users-title')
      );
      heading?.focus();
    } catch (err) {
      remove_error = errorMessage(err);
      remove_submitting = false;
      remove_dialog_open = true;
      log('user removal failed: %o', err);
      doRender();
      ensureDialogOpen(true);
    }
  }

  /**
   * Fetch the directory.
   *
   * @returns {Promise<void>}
   */
  async function load() {
    loading = true;
    doRender();
    try {
      const result = await transport('list-users', {});
      const users = Array.isArray(result?.users) ? result.users : [];
      // Accounts mode: the same answer carries who each alias belongs to.
      if (result && 'owners' in result) setOwnerDirectory(result.owners);
      rows = groupRowsByPerson(
        users
          .map(normalizeRow)
          .filter((/** @type {DirectoryRow} */ row) => row.actor.length > 0)
          .sort(byLastSeenDesc)
      );
      error = '';
      log('directory loaded: %d row(s)', rows.length);
    } catch (err) {
      error = errorMessage(err).replace('remove user', 'load users');
      rows = [];
      log('directory load failed: %o', err);
    } finally {
      loaded = true;
      loading = false;
      doRender();
    }
  }

  /**
   * @param {string} self_actor
   * @param {boolean} admin_viewer
   */
  function bodyTemplate(self_actor, admin_viewer) {
    if (error) {
      return html`<p class="users-empty users-empty--error">${error}</p>`;
    }
    if (!loaded && loading) {
      return html`<p class="users-empty">Loading users…</p>`;
    }
    if (rows.length === 0) {
      return html`
        <p class="users-empty">
          Nobody is registered on this board yet. An agent can sign itself up
          from the dashboard, or you can mint an invite with
          <code>feads-agent invite</code>.
        </p>
      `;
    }
    const lowered_self = self_actor.toLowerCase();
    return html`
      <div class="issues-block">
        <table class="table users-table data-table--stack">
          <thead>
            <tr>
              <th>Actor</th>
              <th>Display name</th>
              <th>Role</th>
              <th>Kind</th>
              <th>Last seen</th>
              <th>Registered</th>
              ${admin_viewer ? html`<th>Actions</th>` : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => {
              const is_self =
                lowered_self.length > 0 &&
                row.actor.toLowerCase() === lowered_self;
              return html`
                <tr class="users-row ${is_self ? 'users-row--self' : ''}">
                  <td data-label="Actor">
                    <span class="mention ${is_self ? 'self-mention' : ''}"
                      >${createActorChip(row.actor, {
                        parent_actor: row.parent_actor,
                        compact: false
                      })}</span
                    >
                  </td>
                  <td data-label="Name">
                    ${ownerOf(row.actor)?.display_name ||
                    row.display_name ||
                    '—'}
                  </td>
                  <td data-label="Role">
                    <span class="badge users-role users-role--${row.role}"
                      >${row.role || 'unknown'}</span
                    >
                  </td>
                  <td data-label="Kind">
                    ${row.kind === 'service'
                      ? html`<span
                            class="kind-badge kind-badge--service"
                            title=${row.steward
                              ? `Service account — steward ${row.steward_display_name || row.steward}`
                              : 'Service account'}
                            >service</span
                          >${row.steward
                            ? html`<span class="users-steward"
                                >steward ${row.steward}</span
                              >`
                            : ''}`
                      : row.kind || '—'}
                  </td>
                  <td
                    data-label="Last seen"
                    title=${lastSeenTitle(row)}
                    class="users-activity"
                  >
                    ${activityTemplate(row)}
                  </td>
                  <td data-label="Registered">
                    ${formatDateValue(row.registered_at) || '—'}
                  </td>
                  ${admin_viewer
                    ? html`
                        <td class="users-actions-cell">
                          ${is_self
                            ? html`
                                <button
                                  type="button"
                                  class="users-remove-action users-remove-action--self"
                                  disabled
                                  aria-label="Your account cannot be removed"
                                >
                                  Your account
                                </button>
                              `
                            : row.kind === 'service'
                              ? html`<a
                                  class="users-service-manage"
                                  href="#/access"
                                  title="A service account is disabled or has its keys revoked on Access, never removed here"
                                  >Manage on Access</a
                                >`
                              : html`
                                  <button
                                    type="button"
                                    class="users-remove-action"
                                    data-actor=${row.actor}
                                    ?disabled=${remove_submitting}
                                    @click=${(/** @type {Event} */ event) =>
                                      openRemoveDialog(row, event)}
                                  >
                                    ${remove_submitting &&
                                    remove_actor === row.actor
                                      ? 'Removing…'
                                      : 'Remove'}
                                  </button>
                                `}
                        </td>
                      `
                    : ''}
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    `;
  }

  function headingText() {
    if (error || !loaded) {
      return 'Registered users';
    }
    return `${rows.length} registered user${rows.length === 1 ? '' : 's'}`;
  }

  function template() {
    // The identity is read from the store rather than the document so this page
    // marks your own row and unlocks admin controls the moment `whoami` answers.
    const identity = store.getState()?.identity;
    const self_actor = String(identity?.agent?.actor || '').trim();
    const admin_viewer = isAdminViewer(identity);
    return html`
      <div class="users-view page">
        <header class="users-header page-header">
          <div class="page-header__main">
            <h2 class="users-title page-header__title" tabindex="-1">
              ${headingText()}
            </h2>
            <p class="users-hint page-header__desc">
              Find a handle for @mentions, such as @handle. Administrators can
              remove other accounts and their associated access when needed.
            </p>
          </div>
          ${loading && loaded
            ? html`<span class="users-loading" aria-hidden="true"></span>`
            : ''}
        </header>
        ${bodyTemplate(self_actor, admin_viewer)}
        <div
          class="users-announcement"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          ${announcement}
        </div>
        ${remove_dialog_open
          ? html`
              <dialog
                class="users-remove-dialog"
                aria-labelledby="users-remove-title"
                aria-describedby="users-remove-description"
                @cancel=${onRemoveDialogCancel}
                @click=${onRemoveDialogClick}
              >
                <form class="users-remove-form" @submit=${onRemoveSubmit}>
                  <header class="users-remove-header">
                    <h3 id="users-remove-title">Remove @${remove_actor}?</h3>
                    <button
                      type="button"
                      class="users-remove-close"
                      ?disabled=${remove_submitting}
                      @click=${() => closeRemoveDialog()}
                    >
                      Close
                    </button>
                  </header>
                  <div class="users-remove-body" id="users-remove-description">
                    <p>
                      This permanently removes the account and delegated agents
                      from Feads across every board. Review the full scope
                      before continuing:
                    </p>
                    <ul class="users-remove-scope">
                      <li>Account access and credentials</li>
                      <li>Active sessions and presence</li>
                      <li>Notifications and invites</li>
                      <li>Authored issues, comments, and dependencies</li>
                      <li>Assignments</li>
                    </ul>
                    <p class="users-remove-tombstone">
                      A minimal security tombstone remains to prevent a silent
                      SSO rejoin.
                    </p>
                    <label for="users-remove-confirm">
                      Type <code>${remove_actor}</code> to confirm
                    </label>
                    <input
                      id="users-remove-confirm"
                      name="confirm_actor"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      required
                      value=${remove_confirm_actor}
                      aria-describedby="users-remove-confirm-hint users-remove-error"
                      aria-invalid=${remove_error.length > 0 ? 'true' : 'false'}
                      @input=${onRemoveConfirmInput}
                    />
                    <p id="users-remove-confirm-hint" class="users-remove-hint">
                      Confirmation is case-sensitive and must match the actor
                      exactly.
                    </p>
                    <p
                      id="users-remove-error"
                      class="users-remove-error"
                      role="alert"
                      ?hidden=${remove_error.length === 0}
                    >
                      ${remove_error}
                    </p>
                  </div>
                  <footer class="users-remove-actions">
                    <button
                      type="button"
                      @click=${() => closeRemoveDialog()}
                      ?disabled=${remove_submitting}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      class="btn danger"
                      ?disabled=${remove_submitting ||
                      remove_confirm_actor !== remove_actor}
                    >
                      ${remove_submitting ? 'Removing…' : 'Remove account'}
                    </button>
                  </footer>
                </form>
              </dialog>
            `
          : ''}
      </div>
    `;
  }

  function doRender() {
    render(template(), mount_element);
    if (remove_dialog_open) {
      ensureDialogOpen(false);
    }
  }

  doRender();
  unsubscribe = store.subscribe(() => doRender());

  return {
    load,
    destroy() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      render(html``, mount_element);
    }
  };
}
