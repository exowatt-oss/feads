import { html, render } from 'lit-html';
import { debug } from '../utils/logging.js';
import { actorDisplay, samePerson } from '../utils/owners.js';
import { knownPersonHandles, personFor } from '../utils/people.js';
import { renderCommentRich } from '../utils/rich-text.js';
import { showToast } from '../utils/toast.js';
import { relativeTime } from './agents-admin.js';

/**
 * feads addition — the notification centre in the header.
 *
 * A board several agents write to produces events that are *about* you and
 * arrive nowhere: your name in a comment, an issue reassigned to you, a blocker
 * of yours closed. The bell is where those land.
 *
 * Three properties are load-bearing:
 *
 * - It renders nothing at all without an identity. Notifications are addressed
 *   to an `actor`; the operator and an anonymous reader have none, so there is
 *   no list to show and — just as important — no request to make. A bell that
 *   asked anyway would put an empty dropdown in front of every visitor.
 * - The unread count comes from the server on every reply and every push,
 *   never from arithmetic on this page. Two tabs, an `notifications_ack` from
 *   the MCP side, or an ack that raced a new row all make a locally-counted
 *   badge drift, and a badge that lies is worse than no badge.
 * - The panel refetches when it opens. The push keeps the count honest between
 *   opens; the refetch is what makes the *list* honest, including rows this
 *   socket missed while it was reconnecting.
 */

/**
 * @typedef {import('../state.js').AppState} AppState
 */

/**
 * One notification, exactly as it travels over the socket, the HTTP API and the
 * MCP tools. See `app/protocol.md`.
 *
 * @typedef {Object} NotificationRow
 * @property {string} id
 * @property {string} [board_id]
 * @property {string} [recipient_actor]
 * @property {string} type
 * @property {string} issue_id
 * @property {string} [issue_title]
 * @property {string} [actor]
 * @property {string} [snippet]
 * @property {string} [related_issue]
 * @property {number} [created_at]
 * @property {number} [read_at]
 * @property {string} [url]
 */

/**
 * @typedef {Object} BellOptions
 * @property {(type: string, payload?: unknown) => Promise<any>} send - RPC transport.
 * @property {{ on: (type: any, handler: (payload: any) => void) => (() => void) }} client -
 * The socket, for the server-initiated `notification` event.
 * @property {{ getState: () => AppState, subscribe: (fn: (s: AppState) => void) => () => void }} store -
 * Where identity lives; the same source the header chip reads, so the two
 * cannot disagree about whether this browser is somebody.
 * @property {(id: string) => void} [gotoIssue] - In-app navigation.
 */

/** How many rows the dropdown holds. Also the server-side page it asks for. */
const LIST_LIMIT = 50;

/** Above this the badge stops counting and starts gesturing. */
const BADGE_CAP = 99;

/**
 * The glyph for a notification type.
 *
 * Typographic rather than iconographic on purpose: five types is too few to
 * justify an icon set, and `@` and `→` already mean what they need to mean.
 *
 * @param {string} type
 * @returns {string}
 */
export function glyphForType(type) {
  switch (type) {
    case 'mention':
      return '@';
    case 'assigned':
      return '→';
    case 'comment_on_owned':
      return '💬';
    case 'update_on_commented':
      return '↻';
    case 'dependency_completed':
      return '✓';
    default:
      return '•';
  }
}

/**
 * A human label for a notification type, for the tooltip and screen readers.
 *
 * @param {string} type
 * @returns {string}
 */
export function labelForType(type) {
  switch (type) {
    case 'mention':
      return 'Mentioned you';
    case 'assigned':
      return 'Assigned to you';
    case 'comment_on_owned':
      return 'Comment on your issue';
    case 'update_on_commented':
      return 'Update on an issue you commented on';
    case 'dependency_completed':
      return 'A blocker was closed';
    default:
      return 'Notification';
  }
}

/**
 * Normalize a `notification` push into a row and a count.
 *
 * The envelope is `{ type, notification, unread_count }`, and a bare row is
 * accepted too — the push arrives as somebody else's payload shape the moment
 * the server changes its mind, and dropping a notification on the floor is a
 * silent failure that nobody reports.
 *
 * @param {any} payload
 * @returns {{ row: NotificationRow | null, unread_count: number | null }}
 */
export function readNotificationPush(payload) {
  if (!payload || typeof payload !== 'object') {
    return { row: null, unread_count: null };
  }
  const count =
    typeof payload.unread_count === 'number' ? payload.unread_count : null;
  const candidate =
    payload.notification && typeof payload.notification === 'object'
      ? payload.notification
      : payload;
  if (typeof candidate.id !== 'string' || typeof candidate.type !== 'string') {
    return { row: null, unread_count: count };
  }
  return {
    row: /** @type {NotificationRow} */ (candidate),
    unread_count: count
  };
}

/**
 * Create the header bell (feads).
 *
 * @param {HTMLElement} mount_element
 * @param {BellOptions} options
 * @returns {{ destroy: () => void }}
 */
export function createNotificationBell(mount_element, options) {
  const log = debug('views:notification-bell');
  const { send, client, store } = options;
  const gotoIssue = options.gotoIssue || (() => {});

  /** @type {boolean} */
  let open = false;
  /** @type {NotificationRow[]} */
  let rows = [];
  /** @type {number} */
  let unread = 0;
  /** @type {boolean} */
  let loading = false;
  /** The actor whose list `rows` belongs to; '' before the first fetch. */
  let loaded_for = '';

  /**
   * Who this browser is acting as, or '' when it is nobody in particular.
   *
   * The operator is deliberately nobody here: it is a mode, not an actor, so
   * nothing is addressed to it.
   *
   * @returns {string}
   */
  function currentActor() {
    const identity = store.getState().identity;
    if (!identity?.loaded) {
      return '';
    }
    return String(identity.agent?.actor || '');
  }

  /**
   * Replace the local view of the world with the server's.
   *
   * `unread_only: false` on purpose. The badge count arrives as its own field,
   * so the list does not have to carry it — and a list of unread rows only
   * would empty itself under the reader's cursor as they clicked through it.
   */
  async function refresh() {
    const actor = currentActor();
    if (!actor || loading) {
      return;
    }
    loading = true;
    doRender();
    try {
      const result = await send('list-notifications', {
        unread_only: false,
        limit: LIST_LIMIT
      });
      const list = Array.isArray(result?.notifications)
        ? result.notifications
        : [];
      rows = /** @type {NotificationRow[]} */ (list);
      unread =
        typeof result?.unread_count === 'number' ? result.unread_count : 0;
      loaded_for = actor;
      log('loaded %d notifications, %d unread', rows.length, unread);
    } catch (err) {
      // Not a toast. The bell is ambient; a dashboard that pops an error over
      // the board because a background poll failed is worse than a bell that
      // is briefly out of date.
      log('list-notifications failed: %o', err);
    } finally {
      loading = false;
      doRender();
    }
  }

  /**
   * Mark rows read, server first.
   *
   * @param {{ ids?: string[], all?: boolean }} payload
   */
  async function ack(payload) {
    const ids = new Set(payload.ids || []);
    const now = Date.now();
    // Optimistic, because the click that acks a row also navigates away from
    // the panel, and a row that stays bold until a round trip lands reads as a
    // click that did not register.
    rows = rows.map((row) =>
      (payload.all || ids.has(row.id)) && !row.read_at
        ? { ...row, read_at: now }
        : row
    );
    doRender();
    try {
      const result = await send('ack-notifications', payload);
      if (typeof result?.unread_count === 'number') {
        unread = result.unread_count;
      }
    } catch (err) {
      log('ack-notifications failed: %o', err);
      // The server is the counter of record, so ask it rather than guessing
      // what the failed ack did or did not do.
      void refresh();
      return;
    }
    doRender();
  }

  /**
   * @param {NotificationRow} row
   */
  function onRowClick(row) {
    open = false;
    if (!row.read_at) {
      void ack({ ids: [row.id] });
    } else {
      doRender();
    }
    if (row.issue_id) {
      gotoIssue(row.issue_id);
    }
  }

  function onMarkAll() {
    if (unread === 0) {
      return;
    }
    void ack({ all: true });
  }

  function onToggle() {
    open = !open;
    doRender();
    if (open) {
      void refresh();
    }
  }

  /**
   * @param {MouseEvent} ev
   */
  function onDocumentClick(ev) {
    if (!open) {
      return;
    }
    const target = /** @type {Node | null} */ (ev.target);
    if (target && mount_element.contains(target)) {
      return;
    }
    if (target && !document.contains(target)) {
      // The click landed on a node that has since been re-rendered away — the
      // badge disappearing under the cursor, most often. It was ours, so
      // treating it as an outside click would close the panel it just opened.
      return;
    }
    open = false;
    doRender();
  }

  /**
   * @param {KeyboardEvent} ev
   */
  function onDocumentKeydown(ev) {
    if (open && ev.key === 'Escape') {
      open = false;
      doRender();
    }
  }

  /**
   * The server-initiated half: a notification exists because something happened
   * on a board this page is not necessarily even looking at.
   *
   * @param {any} payload
   */
  function onPush(payload) {
    const actor = currentActor();
    if (!actor) {
      return;
    }
    const { row, unread_count } = readNotificationPush(payload);
    if (unread_count !== null) {
      unread = unread_count;
    }
    if (!row) {
      doRender();
      return;
    }
    if (
      row.recipient_actor &&
      row.recipient_actor !== actor &&
      // Accounts mode: a row addressed to one of your aliases is yours.
      !samePerson(row.recipient_actor, actor)
    ) {
      // Not ours. The server addresses these, so this is belt-and-braces for a
      // socket that changed identity without reconnecting.
      return;
    }
    if (unread_count === null && !row.read_at) {
      unread += 1;
    }
    rows = [row, ...rows.filter((r) => r.id !== row.id)].slice(0, LIST_LIMIT);
    if (row.type === 'mention') {
      // The one type that is worth interrupting for: somebody is waiting on an
      // answer from *you*, and the bell alone is easy to miss on a page whose
      // content changes on its own.
      showToast(
        `@${row.actor ? actorDisplay(row.actor).name : 'someone'} mentioned you on #${row.issue_id}`,
        'info',
        5000
      );
    }
    doRender();
  }

  /**
   * @param {NotificationRow} row
   */
  function rowTemplate(row) {
    const rest = [row.issue_id, relativeTime(Number(row.created_at))]
      .filter((part) => String(part || '').length > 0)
      .join(' · ');
    const who = row.actor ? actorDisplay(row.actor) : null;
    const person = row.actor ? personFor(row.actor) : null;
    // Who acted, as a person hover card when they are one (hover-only: the row
    // is a button). Same words as before: `mira (via alex-laptop) · …`.
    const meta = who
      ? html`${person
          ? html`<span class="notif__who" data-person-hover=${person.actor}
              >${who.name}</span
            >`
          : who.name}${who.via ? ` (via ${who.via})` : ''}${rest
          ? ` · ${rest}`
          : ''}`
      : rest;
    const label = labelForType(row.type);
    return html`<li class="notif__item">
      <button
        type="button"
        class=${row.read_at ? 'notif__row' : 'notif__row is-unread'}
        data-notification-id=${row.id}
        @click=${() => onRowClick(row)}
      >
        <span class="notif__glyph" title=${label} aria-hidden="true"
          >${glyphForType(row.type)}</span
        >
        <span class="notif__body">
          <span class="notif__snippet"
            >${row.snippet
              ? renderCommentRich(row.snippet, {
                  actors: knownPersonHandles() || undefined,
                  current_actor: currentActor(),
                  interactive: false,
                  refs: false
                })
              : row.issue_title || label}</span
          >
          <span class="notif__meta">${meta}</span>
        </span>
      </button>
    </li>`;
  }

  function panelTemplate() {
    return html`<div
      class="notif__panel"
      role="dialog"
      aria-label="Notifications"
    >
      <div class="notif__head">
        <span class="notif__title">Notifications</span>
        <button
          type="button"
          class="notif__markall"
          ?disabled=${unread === 0}
          @click=${onMarkAll}
        >
          Mark all read
        </button>
      </div>
      ${rows.length === 0
        ? html`<div class="notif__empty muted">
            ${loading ? 'Loading…' : 'Nothing yet'}
          </div>`
        : html`<ul class="notif__list">
            ${rows.map((row) => rowTemplate(row))}
          </ul>`}
    </div>`;
  }

  function template() {
    if (!currentActor()) {
      return html``;
    }
    const badge = unread > BADGE_CAP ? `${BADGE_CAP}+` : String(unread);
    const label =
      unread > 0 ? `Notifications (${unread} unread)` : 'Notifications';
    return html`<div class="notif">
      <button
        type="button"
        class="notif__bell"
        aria-haspopup="dialog"
        aria-expanded=${open ? 'true' : 'false'}
        aria-label=${label}
        title=${label}
        @click=${onToggle}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        ${unread > 0
          ? html`<span class="notif__badge">${badge}</span>`
          : html``}
      </button>
      ${open ? panelTemplate() : html``}
    </div>`;
  }

  function doRender() {
    render(template(), mount_element);
  }

  /**
   * Fetch once the page knows who it is, and again if that changes — signing in
   * and signing out both arrive as a store update rather than a reload.
   */
  function onIdentityChange() {
    const actor = currentActor();
    if (!actor) {
      if (loaded_for) {
        rows = [];
        unread = 0;
        loaded_for = '';
        open = false;
      }
      doRender();
      return;
    }
    if (actor !== loaded_for) {
      rows = [];
      unread = 0;
      void refresh();
      return;
    }
    doRender();
  }

  const off_push = client.on('notification', onPush);
  const unsubscribe = store.subscribe(() => onIdentityChange());
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);

  doRender();
  // Mounted before `whoami` answers, like the identity chip, so the common case
  // — a page that loads already signed in — still fetches without waiting for a
  // second store update.
  onIdentityChange();

  return {
    destroy() {
      try {
        off_push();
      } catch {
        // ignore
      }
      unsubscribe();
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onDocumentKeydown);
      render(html``, mount_element);
    }
  };
}
