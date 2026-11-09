// Issue Detail view implementation (lit-html based)
import { html, render } from 'lit-html';
// feads: the artifact decoder is shared with the CLI and the MCP server rather than
// reimplemented here — see ui/app/utils/artifact-badge.js for why a third copy would be
// a bug rather than duplication.
import { artifactsFromMetadata } from '../../../boards/artifacts.mjs';
import { parseView } from '../router.js';
import { createActorChip } from '../utils/actor-name.js';
import {
  artifactLabel,
  artifactRepo,
  createIntentBadge
} from '../utils/artifact-badge.js';
import { createFlarePips } from '../utils/flare-pip.js';
import { issueHashFor } from '../utils/issue-url.js';
import { debug } from '../utils/logging.js';
import { renderMarkdown } from '../utils/markdown.js';
import { actorLabel, setOwnerDirectory } from '../utils/owners.js';
import { setPeopleDirectory } from '../utils/people.js';
import { priority_levels } from '../utils/priority.js';
import {
  containsMention,
  renderCommentRich,
  renderComposerHighlight
} from '../utils/rich-text.js';
import { statusLabel } from '../utils/status.js';
import { showToast } from '../utils/toast.js';
import { createTypeBadge } from '../utils/type-badge.js';

/**
 * Format a date string for display.
 *
 * @param {string} [dateStr]
 * @returns {string}
 */
function formatCommentDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return dateStr;
  }
}

/**
 * Format a date value for display in the Dates card.
 *
 * The detail object reaches the client via `bd show --json` →
 * `normalizeIssueList`, which overwrites `created_at`/`updated_at`/`closed_at`
 * into numeric epoch-millisecond timestamps (via `parseTimestamp`, which uses
 * `Date.parse`) while leaving `started_at`/`defer_until` as raw ISO strings.
 * `new Date(value)` handles both a number(ms) and an ISO string identically.
 *
 * @param {number | string | null | undefined} value
 * @returns {string} Formatted local datetime, or '' when value is missing.
 */
export function formatDateValue(value) {
  if (value === null || value === undefined || value === '') return '';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

/**
 * @typedef {Object} Dependency
 * @property {string} id
 * @property {string} [title]
 * @property {string} [status]
 * @property {number} [priority]
 * @property {string} [issue_type]
 */

/**
 * @typedef {Object} Comment
 * @property {number} id
 * @property {string} [author]
 * @property {string} text
 * @property {string} [created_at]
 */

/**
 * @typedef {Object} IssueDetail
 * @property {string} id
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [design]
 * @property {string} [acceptance]
 * @property {string} [notes]
 * @property {string} [status]
 * @property {(string|null)} [close_reason]
 * @property {(number|string)} [created_at]
 * @property {string} [created_by]
 * @property {(number|string)} [updated_at]
 * @property {(number|string|null)} [closed_at]
 * @property {string} [started_at]
 * @property {string} [defer_until]
 * @property {string} [assignee]
 * @property {number} [priority]
 * @property {string[]} [labels]
 * @property {Dependency[]} [dependencies]
 * @property {Dependency[]} [dependents]
 * @property {Comment[]} [comments]
 */

/**
 * @param {string} hash
 */
function defaultNavigateFn(hash) {
  window.location.hash = hash;
}

/**
 * feads: the live-actor directory, so `@someone` in a comment can be told from
 * a word that starts with an at sign.
 *
 * Module-level and fetched at most once per page load. The registry changes
 * when somebody runs `feads-agent`, which nothing here observes, and the cost
 * of being a few minutes stale is that a brand-new agent's handle renders
 * unhighlighted for the rest of the session — far cheaper than a round trip per
 * rendered comment.
 *
 * `null` after a failed or empty fetch is not a bug: `renderCommentRich` treats
 * a missing directory as "highlight anything shaped like a mention", which is
 * the honest fallback on a server that does not implement `list-users`.
 *
 * @type {Set<string> | null}
 */
let known_actors = null;

/**
 * @typedef {Object} DirectoryActor
 * @property {string} actor - The handle `@` addresses.
 * @property {string} display_name - What a human calls them; may be empty.
 */

/**
 * The same directory, kept whole rather than flattened to handles.
 *
 * The set above answers the only question a *posted* comment asks — "is this a
 * person?" — and that is all it needs to be. The composer's autocomplete asks a
 * second one: "who could this half-typed handle become, and what are they
 * called?", which a set of strings cannot answer. Both are filled from the one
 * `list-users` round trip in `ensureActorDirectory`; a second fetch path would
 * be two answers that can disagree.
 *
 * @type {DirectoryActor[]}
 */
let known_actor_rows = [];
/** Whether the fetch above has been attempted, successfully or not. */
let known_actors_attempted = false;

/**
 * Forget the cached directory. Test seam — the cache outlives a view instance
 * on purpose, which would otherwise leak between cases in one file.
 */
export function resetActorDirectoryForTests() {
  known_actors = null;
  known_actor_rows = [];
  known_actors_attempted = false;
}

/** How many suggestions the mention menu offers at once. */
const MENTION_LIMIT = 8;

/**
 * The half-typed `@handle` the caret is sitting in, if it is sitting in one.
 *
 * Scans backwards from the caret rather than running `MENTION_RE` forwards,
 * because the token being completed is by definition not yet a match — `@` on
 * its own is a legal starting point and matches nothing. The two agree on what
 * counts as a boundary (`[^\w@]` before the sigil, so `foo@bar` and `@@x` are
 * not mentions) and on the handle alphabet, which is what keeps a suggestion
 * accepted here from rendering unhighlighted once it is posted.
 *
 * @param {string} text
 * @param {number} caret - Index of the caret in `text`.
 * @returns {{ start: number, prefix: string } | null} `start` is the index of
 * the `@`; `prefix` is what has been typed after it, possibly empty.
 */
function findMentionToken(text, caret) {
  const at_end = Math.max(0, Math.min(caret, text.length));
  let i = at_end - 1;
  while (i >= 0 && text[i] !== '@') {
    if (!/[a-zA-Z0-9._-]/.test(text[i])) {
      return null;
    }
    i -= 1;
  }
  if (i < 0) {
    return null;
  }
  const before = i > 0 ? text[i - 1] : '';
  if (before && /[\w@]/.test(before)) {
    return null;
  }
  const prefix = text.slice(i + 1, at_end);
  if (prefix.length > 64) {
    return null;
  }
  if (prefix.length > 0 && !/^[a-z0-9][a-z0-9._-]*$/i.test(prefix)) {
    return null;
  }
  return { start: i, prefix };
}

/**
 * Who the half-typed handle could become.
 *
 * A prefix match on the handle is what the typist is doing; a substring match on
 * the display name is the escape hatch for the case where they know the person
 * and not their handle. Prefix matches sort first for that reason — the
 * name-only hits are a fallback, not a peer.
 *
 * @param {string} prefix
 * @param {DirectoryActor[]} directory
 * @returns {DirectoryActor[]}
 */
function matchActors(prefix, directory) {
  const needle = prefix.toLowerCase();
  /** @type {Array<{ user: DirectoryActor, by_handle: boolean }>} */
  const hits = [];
  for (const user of directory) {
    const actor = String(user.actor || '');
    if (actor.length === 0) {
      continue;
    }
    const by_handle =
      needle.length === 0 || actor.toLowerCase().startsWith(needle);
    const by_name =
      needle.length > 0 &&
      String(user.display_name || '')
        .toLowerCase()
        .includes(needle);
    if (by_handle || by_name) {
      hits.push({ user, by_handle });
    }
  }
  hits.sort((a, b) => {
    if (a.by_handle !== b.by_handle) {
      return a.by_handle ? -1 : 1;
    }
    return String(a.user.actor)
      .toLowerCase()
      .localeCompare(String(b.user.actor).toLowerCase());
  });
  return hits.slice(0, MENTION_LIMIT).map((h) => h.user);
}

/**
 * Who this browser is acting as, for self-mention highlighting.
 *
 * Read off the document rather than threaded through four constructors, for
 * the same reason `data-identity-mode` is written there — see `main.js`. A view
 * that only wants to know "is this me?" should not have to be handed the store.
 *
 * @returns {string}
 */
function currentActor() {
  try {
    return String(document.documentElement.dataset.identityActor || '');
  } catch {
    return '';
  }
}

/**
 * Create the Issue Detail view.
 *
 * @param {HTMLElement} mount_element - Element to render into.
 * @param {(type: string, payload?: unknown) => Promise<unknown>} sendFn - RPC transport.
 * @param {(hash: string) => void} [navigateFn] - Navigation function; defaults to setting location.hash.
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void }} [issue_stores] - Optional issue stores for live updates.
 * @returns {{ load: (id: string) => Promise<void>, clear: () => void, showError: (message: string) => void, destroy: () => void }} View API.
 */
export function createDetailView(
  mount_element,
  sendFn,
  navigateFn = defaultNavigateFn,
  issue_stores = undefined
) {
  const log = debug('views:detail');
  /** @type {IssueDetail | null} */
  let current = null;
  /** @type {string | null} */
  let current_id = null;
  /** @type {any[]} */
  let current_flares = [];
  /** @type {boolean} */
  let pending = false;
  /** @type {boolean} */
  let edit_title = false;
  /** @type {boolean} */
  let edit_desc = false;
  /** @type {boolean} */
  let edit_design = false;
  /** @type {boolean} */
  let edit_notes = false;
  /** @type {boolean} */
  let edit_accept = false;
  /** @type {boolean} */
  let edit_assignee = false;
  /** @type {string} */
  let new_label_text = '';
  let labels_editing = false;
  let links_editing = false;
  /** @type {string} */
  let comment_text = '';
  /** @type {boolean} */
  let comment_pending = false;
  /**
   * feads: the `@mention` autocomplete over the composer.
   *
   * `mention_open` is not derivable from `mention_token !== null`: the caret can
   * sit inside a handle that matches nobody, and that state must show no menu
   * while still being a token — the next keystroke may delete a character and
   * bring matches back.
   *
   * @type {boolean}
   */
  let mention_open = false;
  /** @type {{ start: number, prefix: string } | null} */
  let mention_token = null;
  /** @type {DirectoryActor[]} */
  let mention_matches = [];
  /** @type {number} */
  let mention_index = 0;
  /** @type {Set<string>} */
  const comments_loading = new Set();
  /** @type {Map<string, number>} */
  const comments_loaded_counts = new Map();

  /** @type {HTMLDialogElement | null} */
  let delete_dialog = null;

  function ensureDeleteDialog() {
    if (delete_dialog) return delete_dialog;
    delete_dialog = document.createElement('dialog');
    delete_dialog.id = 'delete-confirm-dialog';
    delete_dialog.setAttribute('role', 'alertdialog');
    delete_dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(delete_dialog);
    return delete_dialog;
  }

  function openDeleteDialog() {
    if (!current) return;
    const dialog = ensureDeleteDialog();
    const issueId = current.id;
    const issueTitle = current.title || '(no title)';
    dialog.innerHTML = `
      <div class="delete-confirm">
        <h2 class="delete-confirm__title">Delete Issue</h2>
        <p class="delete-confirm__message">
          Are you sure you want to delete issue <strong>${issueId}</strong> — <strong>${issueTitle}</strong>? This action cannot be undone.
        </p>
        <div class="delete-confirm__actions">
          <button type="button" class="btn" id="delete-cancel-btn">Cancel</button>
          <button type="button" class="btn danger" id="delete-confirm-btn">Delete</button>
        </div>
      </div>
    `;
    const cancelBtn = dialog.querySelector('#delete-cancel-btn');
    const confirmBtn = dialog.querySelector('#delete-confirm-btn');

    cancelBtn?.addEventListener('click', () => {
      if (typeof dialog.close === 'function') {
        dialog.close();
      }
      dialog.removeAttribute('open');
    });

    confirmBtn?.addEventListener('click', async () => {
      if (typeof dialog.close === 'function') {
        dialog.close();
      }
      dialog.removeAttribute('open');
      await performDelete();
    });

    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      if (typeof dialog.close === 'function') {
        dialog.close();
      }
      dialog.removeAttribute('open');
    });

    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
        dialog.setAttribute('open', '');
      } catch {
        dialog.setAttribute('open', '');
      }
    } else {
      dialog.setAttribute('open', '');
    }
  }

  async function performDelete() {
    if (!current) return;
    const id = current.id;
    try {
      await sendFn('delete-issue', { id });
      current = null;
      current_id = null;
      doRender();
      // Navigate back to close the dialog
      const view = parseView(window.location.hash || '');
      navigateFn(`#/${view}`);
    } catch (err) {
      log('delete failed: %o', err);
      showToast('Failed to delete issue', 'error');
    }
  }

  /**
   * @param {Event} ev
   */
  function onDeleteClick(ev) {
    ev.stopPropagation();
    ev.preventDefault();
    openDeleteDialog();
  }

  /** @param {string} id */
  function issueHref(id) {
    /** @type {'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'story'|'access'|'departments'} */
    const view = parseView(window.location.hash || '');
    return issueHashFor(view, id);
  }

  /**
   * How a markdown block (description, design, notes, acceptance) marks up its
   * `@mentions`: like a comment, but hover-only — each block is itself a
   * click-to-edit button, so a nested tab stop would be invalid.
   */
  function markdownMentions() {
    return {
      actors: known_actors || undefined,
      current_actor: currentActor(),
      interactive: false
    };
  }

  /**
   * Fetch the actor directory the first time a comment on this page mentions
   * somebody, and re-render when it lands.
   *
   * Lazy rather than eager: most comments contain no `@` at all, and a fetch on
   * every opened issue would be a request per issue for a list that changes
   * daily. An error is swallowed — the fallback styling is already correct, and
   * a failed directory lookup is not something the reader of an issue can act
   * on.
   */
  function ensureActorDirectory() {
    if (known_actors_attempted) {
      return;
    }
    known_actors_attempted = true;
    void (async () => {
      try {
        const result = /** @type {any} */ (await sendFn('list-users', {}));
        const users = Array.isArray(result?.users) ? result.users : [];
        // Accounts mode: the same answer names each handle's person, which is
        // what makes a mention a person hover card (utils/people.js).
        if (Array.isArray(result?.owners)) setOwnerDirectory(result.owners);
        setPeopleDirectory(result?.people);
        /** @type {DirectoryActor[]} */
        const rows = [];
        for (const user of users) {
          const actor = String(user?.actor || '');
          if (actor.length > 0) {
            rows.push({
              actor,
              display_name: String(user?.display_name || '')
            });
          }
        }
        if (rows.length > 0) {
          known_actor_rows = rows;
          known_actors = new Set(rows.map((r) => r.actor));
          doRender();
        }
      } catch (err) {
        log('list-users failed: %o', err);
      }
    })();
  }

  /**
   * In-app navigation for a `#issue-id` inside a comment.
   *
   * Delegated from the comments container rather than bound per link: the
   * comment body is injected HTML, so there is no lit-html binding to hang a
   * handler on, and one listener survives every re-render of the list.
   *
   * The anchor keeps its real `href` so middle-click still opens a tab; this
   * only intercepts the plain left click, and hands it the *current* view's
   * hash so following a reference from the board does not dump the reader on
   * the issues tab.
   *
   * @param {Event} ev
   */
  function onCommentsClick(ev) {
    const target = /** @type {Element | null} */ (ev.target);
    const link = target?.closest ? target.closest('a.issue-ref') : null;
    if (!link) {
      return;
    }
    const id = link.getAttribute('data-issue-id') || '';
    if (!id) {
      return;
    }
    ev.preventDefault();
    navigateFn(issueHref(id));
  }

  /** Why the selected issue cannot be shown, once the server has said so. */
  let unavailable = '';

  /**
   * @param {string} message
   */
  function renderPlaceholder(message) {
    render(
      html`
        <div class="panel__body" id="detail-root">
          <p class="muted">${message}</p>
        </div>
      `,
      mount_element
    );
  }

  /**
   * Refresh current from subscription store snapshot if available.
   */
  function refreshFromStore() {
    if (
      !current_id ||
      !issue_stores ||
      typeof issue_stores.snapshotFor !== 'function'
    ) {
      return;
    }
    const arr = /** @type {IssueDetail[]} */ (
      issue_stores.snapshotFor(`detail:${current_id}`)
    );
    current_flares = issue_stores.snapshotFor(`flares:${current_id}`) || [];
    if (Array.isArray(arr) && arr.length > 0) {
      // First item is the issue for this subscription
      const found =
        arr.find((it) => String(it.id) === String(current_id)) || arr[0];
      current = /** @type {IssueDetail} */ (found);
    }
  }

  /**
   * @param {IssueDetail} issue
   */
  function issueCommentCount(issue) {
    const count = Number(/** @type {any} */ (issue).comment_count);
    return Number.isFinite(count) && count >= 0 ? count : null;
  }

  /**
   * @param {IssueDetail} issue
   */
  function hasCurrentComments(issue) {
    const comments = /** @type {any} */ (issue).comments;
    if (!Array.isArray(comments)) {
      return false;
    }
    const count = issueCommentCount(issue);
    if (count === null) {
      return true;
    }
    const id = String(issue.id);
    return (
      comments.length === count || comments_loaded_counts.get(id) === count
    );
  }

  /**
   * @param {IssueDetail} issue
   * @param {Comment[]} comments
   * @param {boolean} for_current_count
   */
  function markCommentsLoaded(issue, comments, for_current_count) {
    const id = String(issue.id);
    const count = issueCommentCount(issue);
    comments_loaded_counts.set(
      id,
      count !== null && for_current_count ? count : comments.length
    );
  }

  /**
   * Fetch comments for the selected issue once the detail subscription has
   * arrived. This enriches the current store issue object; the subscription
   * store preserves that field until the server explicitly sends comments.
   *
   * @param {string | null} id
   */
  async function ensureCommentsLoaded(id) {
    const issue_id = id ? String(id) : '';
    if (
      !issue_id ||
      current_id !== issue_id ||
      !current ||
      String(current.id) !== issue_id ||
      hasCurrentComments(current) ||
      comments_loading.has(issue_id)
    ) {
      return;
    }
    comments_loading.add(issue_id);
    try {
      const comments = await sendFn('get-comments', { id: issue_id });
      if (
        Array.isArray(comments) &&
        current &&
        current_id === issue_id &&
        String(current.id) === issue_id
      ) {
        const count = issueCommentCount(current);
        if (count !== null && comments.length !== count) {
          comments_loaded_counts.set(issue_id, comments.length);
          log(
            'comment count mismatch for %s: expected %d, got %d',
            issue_id,
            count,
            comments.length
          );
          return;
        }
        /** @type {any} */ (current).comments = comments;
        markCommentsLoaded(current, comments, true);
        doRender();
      }
    } catch (err) {
      log('fetch comments failed %s %o', issue_id, err);
    } finally {
      comments_loading.delete(issue_id);
    }
  }

  // Live updates: re-render when issue stores change
  if (issue_stores && typeof issue_stores.subscribe === 'function') {
    issue_stores.subscribe(() => {
      try {
        refreshFromStore();
        doRender();
        void ensureCommentsLoaded(current_id);
      } catch (err) {
        log('issue stores listener error %o', err);
      }
    });
  }

  // Handlers
  const onTitleSpanClick = () => {
    edit_title = true;
    doRender();
  };
  /**
   * @param {KeyboardEvent} ev
   */
  const onTitleKeydown = (ev) => {
    if (ev.key === 'Enter') {
      edit_title = true;
      doRender();
    } else if (ev.key === 'Escape') {
      edit_title = false;
      doRender();
    }
  };
  const onTitleSave = async () => {
    if (!current || pending) {
      return;
    }
    const input = /** @type {HTMLInputElement|null} */ (
      mount_element.querySelector('h2 input')
    );
    const prev = current.title || '';
    const next = input ? input.value : '';
    if (next === prev) {
      edit_title = false;
      doRender();
      return;
    }
    pending = true;
    if (input) {
      input.disabled = true;
    }
    try {
      log('save title %s → %s', String(current.id), next);
      const updated = await sendFn('edit-text', {
        id: current.id,
        field: 'title',
        value: next
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        edit_title = false;
        doRender();
      }
    } catch (err) {
      log('save title failed %s %o', String(current.id), err);
      current.title = prev;
      edit_title = false;
      doRender();
      showToast('Failed to save title', 'error');
    } finally {
      pending = false;
    }
  };
  const onTitleCancel = () => {
    edit_title = false;
    doRender();
  };
  // Assignee inline edit handlers
  const onAssigneeSpanClick = () => {
    edit_assignee = true;
    doRender();
  };
  /**
   * @param {KeyboardEvent} ev
   */
  const onAssigneeKeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      edit_assignee = true;
      doRender();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      edit_assignee = false;
      doRender();
    }
  };
  const onAssigneeSave = async () => {
    if (!current || pending) {
      return;
    }
    const input = /** @type {HTMLInputElement|null} */ (
      mount_element.querySelector('#detail-root .prop.assignee input')
    );
    const prev = current?.assignee ?? '';
    const next = input?.value ?? '';
    if (next === prev) {
      edit_assignee = false;
      doRender();
      return;
    }
    pending = true;
    if (input) {
      input.disabled = true;
    }
    try {
      log('save assignee %s → %s', String(current.id), next);
      const updated = await sendFn('update-assignee', {
        id: current.id,
        assignee: next
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        edit_assignee = false;
        doRender();
      }
    } catch (err) {
      log('save assignee failed %s %o', String(current.id), err);
      // revert visually
      current.assignee = prev;
      edit_assignee = false;
      doRender();
      showToast('Failed to update assignee', 'error');
    } finally {
      pending = false;
    }
  };
  const onAssigneeCancel = () => {
    edit_assignee = false;
    doRender();
  };

  // Labels handlers
  /**
   * @param {Event} ev
   */
  const onLabelInput = (ev) => {
    const el = /** @type {HTMLInputElement} */ (ev.currentTarget);
    new_label_text = el.value || '';
  };
  /**
   * @param {KeyboardEvent} e
   */
  function onLabelKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void onAddLabel();
    }
  }
  function onLabelsToggle() {
    labels_editing = !labels_editing;
    doRender();
  }

  function onLinksToggle() {
    links_editing = !links_editing;
    doRender();
  }

  async function onAddLabel() {
    if (!current || pending) {
      return;
    }
    const text = new_label_text.trim();
    if (!text) {
      return;
    }
    pending = true;
    try {
      log('add label %s → %s', String(current.id), text);
      const updated = await sendFn('label-add', {
        id: current.id,
        label: text
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        new_label_text = '';
        doRender();
      }
    } catch (err) {
      log('add label failed %s %o', String(current.id), err);
      showToast('Failed to add label', 'error');
    } finally {
      pending = false;
    }
  }
  /**
   * @param {string} label
   */
  async function onRemoveLabel(label) {
    if (!current || pending) {
      return;
    }
    pending = true;
    try {
      log('remove label %s → %s', String(current?.id || ''), label);
      const updated = await sendFn('label-remove', {
        id: current.id,
        label
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        doRender();
      }
    } catch (err) {
      log('remove label failed %s %o', String(current?.id || ''), err);
      showToast('Failed to remove label', 'error');
    } finally {
      pending = false;
    }
  }
  /**
   * @param {Event} ev
   */
  const onStatusChange = async (ev) => {
    if (!current || pending) {
      doRender();
      return;
    }
    const sel = /** @type {HTMLSelectElement} */ (ev.currentTarget);
    const prev = current.status || 'open';
    const next = sel.value;
    if (next === prev) {
      return;
    }
    pending = true;
    current.status = next;
    doRender();
    try {
      log('update status %s → %s', String(current.id), next);
      const updated = await sendFn('update-status', {
        id: current.id,
        status: next
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        doRender();
      }
    } catch (err) {
      log('update status failed %s %o', String(current.id), err);
      current.status = prev;
      doRender();
      showToast('Failed to update status', 'error');
    } finally {
      pending = false;
    }
  };
  /**
   * @param {Event} ev
   */
  const onPriorityChange = async (ev) => {
    if (!current || pending) {
      doRender();
      return;
    }
    const sel = /** @type {HTMLSelectElement} */ (ev.currentTarget);
    const prev = typeof current.priority === 'number' ? current.priority : 2;
    const next = Number(sel.value);
    if (next === prev) {
      return;
    }
    pending = true;
    current.priority = next;
    doRender();
    try {
      log('update priority %s → %d', String(current.id), next);
      const updated = await sendFn('update-priority', {
        id: current.id,
        priority: next
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        doRender();
      }
    } catch (err) {
      log('update priority failed %s %o', String(current.id), err);
      current.priority = prev;
      doRender();
      showToast('Failed to update priority', 'error');
    } finally {
      pending = false;
    }
  };

  const onDescEdit = () => {
    edit_desc = true;
    doRender();
  };
  /**
   * @param {KeyboardEvent} ev
   */
  const onDescKeydown = (ev) => {
    if (ev.key === 'Escape') {
      edit_desc = false;
      doRender();
    } else if (ev.key === 'Enter' && ev.ctrlKey) {
      const btn = /** @type {HTMLButtonElement|null} */ (
        mount_element.querySelector('#detail-root .editable-actions button')
      );
      if (btn) {
        btn.click();
      }
    }
  };
  const onDescSave = async () => {
    if (!current || pending) {
      return;
    }
    const ta = /** @type {HTMLTextAreaElement|null} */ (
      mount_element.querySelector('#detail-root textarea')
    );
    const prev = current.description || '';
    const next = ta ? ta.value : '';
    if (next === prev) {
      edit_desc = false;
      doRender();
      return;
    }
    pending = true;
    if (ta) {
      ta.disabled = true;
    }
    try {
      log('save description %s', String(current?.id || ''));
      const updated = await sendFn('edit-text', {
        id: current.id,
        field: 'description',
        value: next
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        edit_desc = false;
        doRender();
      }
    } catch (err) {
      log('save description failed %s %o', String(current?.id || ''), err);
      current.description = prev;
      edit_desc = false;
      doRender();
      showToast('Failed to save description', 'error');
    } finally {
      pending = false;
    }
  };
  const onDescCancel = () => {
    edit_desc = false;
    doRender();
  };

  // Design inline edit handlers (same UX as Description)
  const onDesignEdit = () => {
    edit_design = true;
    doRender();
    try {
      const ta = /** @type {HTMLTextAreaElement|null} */ (
        mount_element.querySelector('#detail-root .design textarea')
      );
      if (ta) {
        ta.focus();
      }
    } catch (err) {
      log('focus design textarea failed %o', err);
    }
  };
  /**
   * @param {KeyboardEvent} ev
   */
  const onDesignKeydown = (ev) => {
    if (ev.key === 'Escape') {
      edit_design = false;
      doRender();
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      const btn = /** @type {HTMLButtonElement|null} */ (
        mount_element.querySelector(
          '#detail-root .design .editable-actions button'
        )
      );
      if (btn) {
        btn.click();
      }
    }
  };
  const onDesignSave = async () => {
    if (!current || pending) {
      return;
    }
    const ta = /** @type {HTMLTextAreaElement|null} */ (
      mount_element.querySelector('#detail-root .design textarea')
    );
    const prev = current.design || '';
    const next = ta ? ta.value : '';
    if (next === prev) {
      edit_design = false;
      doRender();
      return;
    }
    pending = true;
    if (ta) {
      ta.disabled = true;
    }
    try {
      log('save design %s', String(current?.id || ''));
      const updated = await sendFn('edit-text', {
        id: current.id,
        field: 'design',
        value: next
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        edit_design = false;
        doRender();
      }
    } catch (err) {
      log('save design failed %s %o', String(current?.id || ''), err);
      current.design = prev;
      edit_design = false;
      doRender();
      showToast('Failed to save design', 'error');
    } finally {
      pending = false;
    }
  };
  const onDesignCancel = () => {
    edit_design = false;
    doRender();
  };

  // Notes inline edit handlers
  const onNotesEdit = () => {
    edit_notes = true;
    doRender();
  };
  /**
   * @param {KeyboardEvent} ev
   */
  const onNotesKeydown = (ev) => {
    if (ev.key === 'Escape') {
      edit_notes = false;
      doRender();
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      const btn = /** @type {HTMLButtonElement|null} */ (
        mount_element.querySelector(
          '#detail-root .notes .editable-actions button'
        )
      );
      if (btn) {
        btn.click();
      }
    }
  };
  const onNotesSave = async () => {
    if (!current || pending) {
      return;
    }
    const ta = /** @type {HTMLTextAreaElement|null} */ (
      mount_element.querySelector('#detail-root .notes textarea')
    );
    const prev = current.notes || '';
    const next = ta ? ta.value : '';
    if (next === prev) {
      edit_notes = false;
      doRender();
      return;
    }
    pending = true;
    if (ta) {
      ta.disabled = true;
    }
    try {
      log('save notes %s', String(current?.id || ''));
      const updated = await sendFn('edit-text', {
        id: current.id,
        field: 'notes',
        value: next
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        edit_notes = false;
        doRender();
      }
    } catch (err) {
      log('save notes failed %s %o', String(current?.id || ''), err);
      current.notes = prev;
      edit_notes = false;
      doRender();
      showToast('Failed to save notes', 'error');
    } finally {
      pending = false;
    }
  };
  const onNotesCancel = () => {
    edit_notes = false;
    doRender();
  };

  const onAcceptEdit = () => {
    edit_accept = true;
    doRender();
  };
  /**
   * @param {KeyboardEvent} ev
   */
  const onAcceptKeydown = (ev) => {
    if (ev.key === 'Escape') {
      edit_accept = false;
      doRender();
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      const btn = /** @type {HTMLButtonElement|null} */ (
        mount_element.querySelector(
          '#detail-root .acceptance .editable-actions button'
        )
      );
      if (btn) {
        btn.click();
      }
    }
  };
  const onAcceptSave = async () => {
    if (!current || pending) {
      return;
    }
    const ta = /** @type {HTMLTextAreaElement|null} */ (
      mount_element.querySelector('#detail-root .acceptance textarea')
    );
    const prev = current.acceptance || '';
    const next = ta ? ta.value : '';
    if (next === prev) {
      edit_accept = false;
      doRender();
      return;
    }
    pending = true;
    if (ta) {
      ta.disabled = true;
    }
    try {
      log('save acceptance %s', String(current?.id || ''));
      const updated = await sendFn('edit-text', {
        id: current.id,
        field: 'acceptance',
        value: next
      });
      if (updated && typeof updated === 'object') {
        current = /** @type {IssueDetail} */ (updated);
        edit_accept = false;
        doRender();
      }
    } catch (err) {
      log('save acceptance failed %s %o', String(current?.id || ''), err);
      current.acceptance = prev;
      edit_accept = false;
      doRender();
      showToast('Failed to save acceptance', 'error');
    } finally {
      pending = false;
    }
  };
  const onAcceptCancel = () => {
    edit_accept = false;
    doRender();
  };

  // Comment input handlers

  /** @returns {HTMLTextAreaElement | null} */
  function commentTextarea() {
    return /** @type {HTMLTextAreaElement | null} */ (
      mount_element.querySelector('.comment-input textarea')
    );
  }

  /**
   * Repaint the highlight layer behind the composer.
   *
   * Its own render root rather than a binding in the detail template, because it
   * has to keep up with every keystroke and the detail template does not: see
   * `onCommentInput`, which repaints this on the cheap path where nothing else
   * about the page has changed. The backdrop element itself carries no bindings
   * from the parent template, so the two render roots never contend.
   */
  function paintComposer() {
    const backdrop = /** @type {HTMLElement | null} */ (
      mount_element.querySelector('.comment-input__backdrop')
    );
    if (!backdrop) {
      return;
    }
    render(
      html`${renderComposerHighlight(comment_text, known_actors || undefined)}`,
      backdrop
    );
    const ta = commentTextarea();
    if (ta) {
      backdrop.scrollTop = ta.scrollTop;
    }
  }

  /**
   * Re-render without moving the caret out from under the typist.
   *
   * The composer's `.value` is a lit binding, and committing it puts the caret
   * at the end of the text. That is invisible while somebody types at the end of
   * a line and destructive the moment they go back to fix a handle mid-sentence,
   * which is exactly when the autocomplete is re-rendering hardest.
   */
  function renderKeepingCaret() {
    const ta = commentTextarea();
    if (!ta || document.activeElement !== ta) {
      doRender();
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    doRender();
    const next = commentTextarea();
    if (!next) {
      return;
    }
    try {
      next.setSelectionRange(start, end);
    } catch (err) {
      log('caret restore failed: %o', err);
    }
  }

  function closeMention() {
    mention_open = false;
    mention_token = null;
    mention_matches = [];
    mention_index = 0;
  }

  /**
   * Recompute the mention menu from the composer's text and caret.
   *
   * The active row survives a keystroke when the person it names is still in the
   * filtered list — narrowing `@al` to `@ali` must not silently move the
   * selection off the agent the typist was already looking at.
   *
   * @param {HTMLTextAreaElement | null} el
   */
  function syncMentionState(el) {
    const caret =
      el && typeof el.selectionStart === 'number'
        ? el.selectionStart
        : comment_text.length;
    const token = findMentionToken(comment_text, caret);
    if (!token || known_actor_rows.length === 0) {
      closeMention();
      return;
    }
    const matches = matchActors(token.prefix, known_actor_rows);
    const previous =
      mention_open && mention_matches[mention_index]
        ? mention_matches[mention_index].actor
        : '';
    mention_token = token;
    mention_matches = matches;
    mention_open = matches.length > 0;
    const kept = matches.findIndex((m) => m.actor === previous);
    mention_index = kept >= 0 ? kept : 0;
  }

  /**
   * Put the chosen handle in the text, replacing the token being typed.
   *
   * The trailing space is deliberate: without it the very next character the
   * typist writes extends the handle, and `@alice,` is not `@alice`.
   *
   * @param {DirectoryActor} user
   */
  function acceptMention(user) {
    if (!user || !mention_token) {
      return;
    }
    const start = mention_token.start;
    const end = start + 1 + mention_token.prefix.length;
    const insert = `@${user.actor} `;
    comment_text = `${comment_text.slice(0, start)}${insert}${comment_text.slice(end)}`;
    const caret = start + insert.length;
    closeMention();
    doRender();
    const ta = commentTextarea();
    if (!ta) {
      return;
    }
    try {
      ta.focus();
      ta.setSelectionRange(caret, caret);
    } catch (err) {
      log('caret placement failed: %o', err);
    }
  }

  /**
   * @param {DirectoryActor} user
   * @returns {(ev: Event) => void}
   */
  function makeMentionMouseDown(user) {
    return (ev) => {
      // `mousedown` rather than `click`, and prevented, so the textarea never
      // loses focus — a click that blurs the composer would take the caret with
      // it and there would be nothing left to insert into.
      ev.preventDefault();
      acceptMention(user);
    };
  }

  /**
   * Warm the directory when the composer is first focused.
   *
   * Earlier than the comment renderer needs it (which waits for an `@` to
   * appear in a *posted* comment) because the autocomplete has to be ready
   * before the first `@` is typed, not one round trip after it. Still at most
   * one fetch per page — `ensureActorDirectory` is the guard.
   */
  const onCommentFocus = () => {
    ensureActorDirectory();
  };

  /**
   * @param {Event} ev
   */
  const onCommentScroll = (ev) => {
    const el = /** @type {HTMLTextAreaElement} */ (ev.currentTarget);
    const backdrop = /** @type {HTMLElement | null} */ (
      mount_element.querySelector('.comment-input__backdrop')
    );
    if (backdrop) {
      backdrop.scrollTop = el.scrollTop;
    }
  };

  /**
   * @param {Event} ev
   */
  const onCommentInput = (ev) => {
    const el = /** @type {HTMLTextAreaElement} */ (ev.currentTarget);
    const prev_has_text = comment_text.trim().length > 0;
    const was_open = mention_open;
    comment_text = el.value || '';
    const has_text = comment_text.trim().length > 0;
    syncMentionState(el);
    // Re-render when the "has content" state changes to update button disabled
    // state, and whenever the menu is or was on screen — it has to follow the
    // token character by character.
    if (prev_has_text !== has_text || was_open || mention_open) {
      renderKeepingCaret();
      return;
    }
    // Cheap path: nothing in the template changed, so only the highlight layer
    // behind the textarea needs repainting.
    paintComposer();
  };

  /**
   * Close the menu when the click that opened something else lands elsewhere.
   *
   * @param {Event} ev
   */
  const onDocumentClick = (ev) => {
    if (!mention_open) {
      return;
    }
    const target = /** @type {Element | null} */ (ev.target);
    if (target && typeof target.closest === 'function') {
      if (target.closest('.comment-input')) {
        return;
      }
    }
    closeMention();
    doRender();
  };
  document.addEventListener('click', onDocumentClick);

  const onCommentSubmit = async () => {
    if (!current || comment_pending || !comment_text.trim()) {
      return;
    }
    comment_pending = true;
    doRender();
    try {
      log('add comment to %s', String(current.id));
      const result = await sendFn('add-comment', {
        id: current.id,
        text: comment_text.trim()
      });
      if (Array.isArray(result)) {
        // Update comments in current issue
        /** @type {any} */ (current).comments = result;
        markCommentsLoaded(current, result, false);
        comment_text = '';
        // The highlight layer is repainted from `comment_text` by `doRender`;
        // the menu is closed explicitly because a posted comment leaves no token
        // for it to be about.
        closeMention();
        doRender();
      }
    } catch (err) {
      log('add comment failed %s %o', String(current.id), err);
      showToast('Failed to add comment', 'error');
    } finally {
      comment_pending = false;
      doRender();
    }
  };

  /**
   * @param {KeyboardEvent} ev
   */
  const onCommentKeydown = (ev) => {
    // The open menu owns Enter, Tab, the arrows and Escape — including the
    // Ctrl+Enter that otherwise submits. Somebody who has a suggestion
    // highlighted and presses Enter meant "that one", and posting the comment
    // with a half-typed handle in it is not a recoverable mistake: the mention
    // notifies nobody and the comment is already on the board.
    if (mention_open && mention_matches.length > 0) {
      const count = mention_matches.length;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        mention_index = (mention_index + 1) % count;
        renderKeepingCaret();
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        mention_index = (mention_index - 1 + count) % count;
        renderKeepingCaret();
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        acceptMention(mention_matches[mention_index]);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        // Nothing above this may act on it: Escape is "close the menu", not
        // "leave the comment I am in the middle of writing".
        ev.stopPropagation();
        closeMention();
        renderKeepingCaret();
        return;
      }
    }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      onCommentSubmit();
    }
  };

  /**
   * What this bead is working on: files, directories, repos and pull requests.
   *
   * Read-only on purpose. Attaching and releasing are `feads-artifact` and the MCP
   * tools, because a claim is a coordination act an agent takes while it works — a
   * human clicking one on in the dashboard would be recording an intent nobody is
   * acting on. Showing them here is what the dashboard is for: the bead's own page is
   * where you find out that another agent is in your file.
   *
   * The card is omitted entirely when a bead has no artifacts, like the other
   * conditional blocks in this sidebar — an empty "Working on" card on every bead that
   * predates the feature would be noise on every page.
   *
   * @param {IssueDetail} issue
   */
  function artifactsSection(issue) {
    /** @type {any} */
    const any_issue = issue;
    const artifacts = artifactsFromMetadata(any_issue.metadata);
    if (artifacts.length === 0) {
      return '';
    }
    return html`
      <div class="props-card artifacts" data-testid="artifacts">
        <div>
          <div class="props-card__title">
            Working on
            <span class="badge" aria-label=${`${artifacts.length} artifacts`}
              >${artifacts.length}</span
            >
          </div>
        </div>
        <ul class="artifact-list">
          ${artifacts.map((a) => {
            const repo = artifactRepo(a);
            const meta = [a.actor ? actorLabel(a.actor) : '', a.at]
              .filter(Boolean)
              .join(' · ');
            return html`<li class="artifact" title=${a.ref}>
              <div class="artifact__head">
                ${createIntentBadge(a.intent)}
                <span class="mono text-truncate">${artifactLabel(a)}</span>
              </div>
              ${repo
                ? html`<div class="artifact__repo muted">${repo}</div>`
                : ''}
              ${meta
                ? html`<div class="artifact__meta muted">${meta}</div>`
                : ''}
              ${a.note ? html`<div class="artifact__note">${a.note}</div>` : ''}
            </li>`;
          })}
        </ul>
      </div>
    `;
  }

  /**
   * @param {'Dependencies'|'Dependents'} title
   * @param {Dependency[]} items
   */
  function depsSection(title, items) {
    const test_id =
      title === 'Dependencies' ? 'add-dependency' : 'add-dependent';
    if (!items || items.length === 0) return '';
    return html`
      <div class="props-card">
        <div>
          <div class="props-card__title">${title}</div>
        </div>
        <ul>
          ${items.map((dep) => {
            const did = dep.id;
            const href = issueHref(did);
            return html`<li data-href=${href} @click=${() => navigateFn(href)}>
              ${createTypeBadge(dep.issue_type || '')}
              <span class="text-truncate">${dep.title || ''}</span>
              <button
                aria-label=${`Remove dependency ${did}`}
                @click=${makeDepRemoveClick(did, title)}
              >
                ×
              </button>
            </li>`;
          })}
        </ul>
        ${links_editing
          ? html`<div class="props-card__footer">
              <input
                type="text"
                placeholder="Issue ID"
                data-testid=${test_id}
              />
              <button @click=${makeDepAddClick(items, title)}>Add</button>
            </div>`
          : ''}
      </div>
    `;
  }

  /**
   * The `@mention` suggestions, or nothing at all.
   *
   * A listbox rather than a `<datalist>` or a `<select>`: the composer keeps
   * focus throughout, which is what lets Escape mean "close this" and Enter mean
   * "take that one" without the browser's own widget getting a vote.
   */
  function mentionMenuTemplate() {
    if (!mention_open || mention_matches.length === 0) {
      return '';
    }
    return html`<div
      class="mention-autocomplete"
      role="listbox"
      aria-label="Mention a registered user"
    >
      ${mention_matches.map(
        (user, i) =>
          html`<div
            class="mention-autocomplete__row ${i === mention_index
              ? 'is-active'
              : ''}"
            role="option"
            aria-selected=${i === mention_index ? 'true' : 'false'}
            data-actor=${user.actor}
            @mousedown=${makeMentionMouseDown(user)}
          >
            <span class="mention-autocomplete__actor">@${user.actor}</span>
            ${user.display_name
              ? html`<span class="mention-autocomplete__name"
                  >${user.display_name}</span
                >`
              : ''}
          </div>`
      )}
    </div>`;
  }

  /**
   * @param {IssueDetail} issue
   */
  function detailTemplate(issue) {
    const flare_pips = createFlarePips(current_flares);
    const title_zone = edit_title
      ? html`<div class="detail-title">
          <h2>
            <input
              type="text"
              aria-label="Edit title"
              .value=${issue.title || ''}
              @keydown=${onTitleInputKeydown}
            />
            <button @click=${onTitleSave}>Save</button>
            <button @click=${onTitleCancel}>Cancel</button>
          </h2>
        </div>`
      : html`<div class="detail-title">
          <h2>
            ${flare_pips}
            <span
              class="editable"
              tabindex="0"
              role="button"
              aria-label="Edit title"
              @click=${onTitleSpanClick}
              @keydown=${onTitleKeydown}
              >${issue.title || ''}</span
            >
          </h2>
        </div>`;

    const status_select = html`<select
      class=${`badge-select badge--status is-${issue.status || 'open'}`}
      @change=${onStatusChange}
      .value=${issue.status || 'open'}
      ?disabled=${pending}
    >
      ${(() => {
        const cur = String(issue.status || 'open');
        return ['open', 'in_progress', 'closed'].map(
          (s) =>
            html`<option value=${s} ?selected=${cur === s}>
              ${statusLabel(s)}
            </option>`
        );
      })()}
    </select>`;

    const priority_select = html`<select
      class=${`badge-select badge--priority is-p${String(
        typeof issue.priority === 'number' ? issue.priority : 2
      )}`}
      @change=${onPriorityChange}
      .value=${String(typeof issue.priority === 'number' ? issue.priority : 2)}
      ?disabled=${pending}
    >
      ${(() => {
        const cur = String(
          typeof issue.priority === 'number' ? issue.priority : 2
        );
        return priority_levels.map(
          (p, i) =>
            html`<option value=${String(i)} ?selected=${cur === String(i)}>
              ${p}
            </option>`
        );
      })()}
    </select>`;

    const desc_block = edit_desc
      ? html`<div class="description">
          <textarea
            @keydown=${onDescKeydown}
            .value=${issue.description || ''}
            rows="8"
            style="width:100%"
          ></textarea>
          <div class="editable-actions">
            <button @click=${onDescSave}>Save</button>
            <button @click=${onDescCancel}>Cancel</button>
          </div>
        </div>`
      : html`<div
          class="md editable"
          tabindex="0"
          role="button"
          aria-label="Edit description"
          @click=${onDescEdit}
          @keydown=${onDescEditableKeydown}
        >
          ${(() => {
            const text = issue.description || '';
            if (text.trim() === '') {
              return html`<div class="muted">Description</div>`;
            }
            return renderMarkdown(text, { mentions: markdownMentions() });
          })()}
        </div>`;

    // Normalize acceptance text: prefer issue.acceptance, fallback to acceptance_criteria from bd
    const acceptance_text = (() => {
      /** @type {any} */
      const any_issue = issue;
      const raw = String(
        issue.acceptance || any_issue.acceptance_criteria || ''
      );
      return raw;
    })();

    const accept_block = edit_accept
      ? html`<div class="acceptance">
          ${acceptance_text.trim().length > 0
            ? html`<div class="props-card__title">Acceptance Criteria</div>`
            : ''}
          <textarea
            @keydown=${onAcceptKeydown}
            .value=${acceptance_text}
            rows="6"
            style="width:100%"
          ></textarea>
          <div class="editable-actions">
            <button @click=${onAcceptSave}>Save</button>
            <button @click=${onAcceptCancel}>Cancel</button>
          </div>
        </div>`
      : html`<div class="acceptance">
          ${(() => {
            const text = acceptance_text;
            const has = text.trim().length > 0;
            return html`${has
                ? html`<div class="props-card__title">Acceptance Criteria</div>`
                : ''}
              <div
                class="md editable"
                tabindex="0"
                role="button"
                aria-label="Edit acceptance criteria"
                @click=${onAcceptEdit}
                @keydown=${onAcceptEditableKeydown}
              >
                ${has
                  ? renderMarkdown(text, { mentions: markdownMentions() })
                  : html`<div class="muted">Add acceptance criteria…</div>`}
              </div>`;
          })()}
        </div>`;

    // Notes: editable in-place similar to Description
    const notes_text = String(issue.notes || '');
    const notes_block = edit_notes
      ? html`<div class="notes">
          ${notes_text.trim().length > 0
            ? html`<div class="props-card__title">Notes</div>`
            : ''}
          <textarea
            @keydown=${onNotesKeydown}
            .value=${notes_text}
            rows="6"
            style="width:100%"
          ></textarea>
          <div class="editable-actions">
            <button @click=${onNotesSave}>Save</button>
            <button @click=${onNotesCancel}>Cancel</button>
          </div>
        </div>`
      : html`<div class="notes">
          ${(() => {
            const text = notes_text;
            const has = text.trim().length > 0;
            return html`${has
                ? html`<div class="props-card__title">Notes</div>`
                : ''}
              <div
                class="md editable"
                tabindex="0"
                role="button"
                aria-label="Edit notes"
                @click=${onNotesEdit}
                @keydown=${onNotesEditableKeydown}
              >
                ${has
                  ? renderMarkdown(text, { mentions: markdownMentions() })
                  : html`<div class="muted">Add notes…</div>`}
              </div>`;
          })()}
        </div>`;

    // Labels section: empty labels stay silent until the user asks to add one.
    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    const labels_block =
      labels.length || labels_editing
        ? html`<div class="props-card labels">
            <div>
              <div class="props-card__title">Labels</div>
            </div>
            <ul>
              ${labels.map(
                (l) =>
                  html`<li>
                    <span class="badge" title=${l}
                      >${l}
                      <button
                        class="icon-button"
                        title="Remove label"
                        aria-label=${'Remove label ' + l}
                        @click=${() => onRemoveLabel(l)}
                        style="margin-left:6px"
                      >
                        ×
                      </button></span
                    >
                  </li>`
              )}
            </ul>
            <div class="props-card__footer">
              <input
                type="text"
                placeholder="Label"
                size="12"
                .value=${new_label_text}
                @input=${onLabelInput}
                @keydown=${onLabelKeydown}
              />
              <button @click=${onAddLabel}>Add</button>
            </div>
          </div>`
        : '';

    // Dates section block — rendered below Properties. Rows render
    // conditionally; absent values are omitted (no blank rows).
    // Date only — the close reason is shown in the Properties card, not
    // duplicated here.
    const closed_display = formatDateValue(issue.closed_at);
    const dates_block = html`<div class="props-card props-card--flat dates">
      <div class="props-card__header">
        <div class="props-card__title">Dates</div>
      </div>
      <div class="prop">
        <div class="label">Created</div>
        <div class="value">${formatDateValue(issue.created_at)}</div>
      </div>
      ${issue.started_at
        ? html`<div class="prop">
            <div class="label">Started</div>
            <div class="value">${formatDateValue(issue.started_at)}</div>
          </div>`
        : ''}
      <div class="prop">
        <div class="label">Updated</div>
        <div class="value">${formatDateValue(issue.updated_at)}</div>
      </div>
      ${closed_display
        ? html`<div class="prop">
            <div class="label">Closed</div>
            <div class="value">${closed_display}</div>
          </div>`
        : ''}
      ${issue.defer_until
        ? html`<div class="prop">
            <div class="label">Deferred until</div>
            <div class="value">${formatDateValue(issue.defer_until)}</div>
          </div>`
        : ''}
    </div>`;

    // Design section block
    const design_text = String(issue.design || '');
    const design_block = edit_design
      ? html`<div class="design">
          ${design_text.trim().length > 0
            ? html`<div class="props-card__title">Design</div>`
            : ''}
          <textarea
            @keydown=${onDesignKeydown}
            .value=${design_text}
            rows="6"
            style="width:100%"
          ></textarea>
          <div class="editable-actions">
            <button @click=${onDesignSave}>Save</button>
            <button @click=${onDesignCancel}>Cancel</button>
          </div>
        </div>`
      : html`<div class="design">
          ${(() => {
            const text = design_text;
            const has = text.trim().length > 0;
            return html`${has
                ? html`<div class="props-card__title">Design</div>`
                : ''}
              <div
                class="md editable"
                tabindex="0"
                role="button"
                aria-label="Edit design"
                @click=${onDesignEdit}
                @keydown=${onDesignEditableKeydown}
              >
                ${has
                  ? renderMarkdown(text, { mentions: markdownMentions() })
                  : html`<div class="muted">Add design…</div>`}
              </div>`;
          })()}
        </div>`;

    // Comments section
    const comments = Array.isArray(/** @type {any} */ (issue).comments)
      ? /** @type {Comment[]} */ (/** @type {any} */ (issue).comments)
      : [];
    // feads: comments carry `@actor` and `#issue-id`, so they render through
    // `renderCommentRich` rather than as a text binding. The directory lookup is
    // kicked off from here because here is where we first know a comment on
    // this issue mentions anybody; it is guarded to fire at most once per page.
    const self_actor = currentActor();
    if (
      !known_actors &&
      (comments.some((c) => containsMention(c.text || '')) ||
        containsMention(String(issue.description || '')))
    ) {
      ensureActorDirectory();
    }
    const comments_block = html`<div class="comments" @click=${onCommentsClick}>
      <div class="props-card__title">Comments</div>
      ${comments.length === 0
        ? html`<div class="muted">No comments yet</div>`
        : comments.map((c) => {
            // Kept out of the template: `.comment-text` is `pre-wrap`, so the
            // binding has to sit flush against its tags or the reader sees the
            // indentation of this file.
            const body = renderCommentRich(c.text || '', {
              actors: known_actors || undefined,
              current_actor: self_actor
            });
            return html`
              <div class="comment-item">
                <div class="comment-header">
                  <span class="comment-author"
                    >${c.author
                      ? createActorChip(c.author, { focusable: true })
                      : 'Unknown'}</span
                  >
                  <span class="comment-date"
                    >${formatCommentDate(c.created_at)}</span
                  >
                </div>
                <div class="comment-text">${body}</div>
              </div>
            `;
          })}
      <div class="comment-input">
        <div class="comment-input__field">
          <!-- The pill layer. Deliberately childless in this template: it is
               painted from its own render root so a keystroke can update it
               without re-rendering the issue. -->
          <div class="comment-input__backdrop" aria-hidden="true"></div>
          <textarea
            placeholder="Add a comment... (@ to mention, Ctrl+Enter to submit)"
            rows="3"
            .value=${comment_text}
            @input=${onCommentInput}
            @keydown=${onCommentKeydown}
            @focus=${onCommentFocus}
            @scroll=${onCommentScroll}
            ?disabled=${comment_pending}
          ></textarea>
          ${mentionMenuTemplate()}
        </div>
        <button
          class="btn btn--primary"
          @click=${onCommentSubmit}
          ?disabled=${comment_pending || !comment_text.trim()}
        >
          ${comment_pending ? 'Adding...' : 'Add Comment'}
        </button>
      </div>
    </div>`;

    return html`
      <div class="panel__body" id="detail-root">
        <div class="detail-layout">
          <div class="detail-main">
            ${title_zone} ${desc_block} ${design_block} ${notes_block}
            ${accept_block} ${comments_block}
          </div>
          <div class="detail-side">
            <div class="props-card">
              <div class="props-card__header">
                <div class="props-card__title">Properties</div>
                <button class="delete-issue-btn" title="Delete issue" aria-label="Delete issue" @click=${onDeleteClick}>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                  <span class="tooltip">Delete issue</span>
                </button>
              </div>
                <div class="prop">
                  <div class="label">Type</div>
                  <div class="value">
                    ${createTypeBadge(/** @type {any} */ (issue).issue_type)}
                  </div>
                </div>
                <div class="prop">
                  <div class="label">Status</div>
                  <div class="value">${status_select}</div>
                </div>
                ${
                  issue.close_reason
                    ? html`<div class="prop">
                        <div class="label">Close Reason</div>
                        <div class="value">${issue.close_reason}</div>
                      </div>`
                    : ''
                }
                <div class="prop">
                  <div class="label">Priority</div>
                  <div class="value">${priority_select}</div>
                </div>
                ${
                  issue.created_by
                    ? html`<div class="prop">
                        <div class="label">Reported by</div>
                        <div class="value">
                          ${createActorChip(issue.created_by)}
                        </div>
                      </div>`
                    : ''
                }
                <div class="prop assignee">
                  <div class="label">Assignee</div>
                  <div class="value">
                    ${
                      edit_assignee
                        ? html`<input
                              type="text"
                              aria-label="Edit assignee"
                              .value=${
                                /** @type {any} */ (issue).assignee || ''
                              }
                              size=${Math.min(
                                40,
                                Math.max(12, (issue.assignee || '').length + 3)
                              )}
                              @keydown=${
                                /** @param {KeyboardEvent} e */ (e) => {
                                  if (e.key === 'Escape') {
                                    e.preventDefault();
                                    onAssigneeCancel();
                                  } else if (e.key === 'Enter') {
                                    e.preventDefault();
                                    onAssigneeSave();
                                  }
                                }
                              }
                            />
                            <button
                              class="btn"
                              style="margin-left:6px"
                              @click=${onAssigneeSave}
                            >
                              Save
                            </button>
                            <button
                              class="btn"
                              style="margin-left:6px"
                              @click=${onAssigneeCancel}
                            >
                              Cancel
                            </button>`
                        : html`${(() => {
                            const raw = issue.assignee || '';
                            const has = raw.trim().length > 0;
                            const text = has ? raw : 'Unassigned';
                            const cls = has ? 'editable' : 'editable muted';
                            return html`<span
                              class=${cls}
                              tabindex="0"
                              role="button"
                              aria-label="Edit assignee"
                              @click=${onAssigneeSpanClick}
                              @keydown=${onAssigneeKeydown}
                              >${has ? createActorChip(raw) : text}</span
                            >`;
                          })()}`
                    }
                  </div>
                </div>
              </div>
              <div class="props-card__footer">
                ${!labels.length && !labels_editing ? html`<button class="ghost-button" @click=${onLabelsToggle}>+ Label</button>` : ''}
                ${labels.length && !labels_editing ? html`<button class="ghost-button" @click=${onLabelsToggle}>+ Label</button>` : ''}
              </div>
              ${dates_block}
              ${labels_block}
              ${depsSection('Dependencies', issue.dependencies || [])}
              ${depsSection('Dependents', issue.dependents || [])}
              ${
                links_editing
                  ? html`<div class="props-card__footer">
                      <input
                        type="text"
                        placeholder="Issue ID"
                        data-testid="add-dependency"
                      />
                      <button
                        @click=${makeDepAddClick(
                          issue.dependencies || [],
                          'Dependencies'
                        )}
                      >
                        Add link
                      </button>
                    </div>`
                  : html`<div class="props-card__footer">
                      <button class="ghost-button" @click=${onLinksToggle}>
                        + Add link
                      </button>
                    </div>`
              }
              ${artifactsSection(issue)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function doRender() {
    if (!current) {
      // An issue the server refused stays explained: a later re-render (a
      // comments fetch settling, a store push) must not put "Loading…" back
      // over the reason for content that will never arrive.
      renderPlaceholder(
        unavailable || (current_id ? 'Loading…' : 'No issue selected')
      );
      return;
    }
    render(detailTemplate(current), mount_element);
    // After, not before: the backdrop element only exists once the template
    // above has committed, and it is recreated whenever the placeholder has been
    // on screen in between.
    paintComposer();
  }

  /**
   * Create a click handler for the remove button of a dependency row.
   *
   * @param {string} did
   * @param {'Dependencies'|'Dependents'} title
   * @returns {(ev: Event) => Promise<void>}
   */
  function makeDepRemoveClick(did, title) {
    return async (ev) => {
      ev.stopPropagation();
      if (!current || pending) {
        return;
      }
      pending = true;
      try {
        if (title === 'Dependencies') {
          const updated = await sendFn('dep-remove', {
            a: current.id,
            b: did,
            view_id: current.id
          });
          if (updated && typeof updated === 'object') {
            current = /** @type {IssueDetail} */ (updated);
            doRender();
          }
        } else {
          const updated = await sendFn('dep-remove', {
            a: did,
            b: current.id,
            view_id: current.id
          });
          if (updated && typeof updated === 'object') {
            current = /** @type {IssueDetail} */ (updated);
            doRender();
          }
        }
      } catch (err) {
        log('dep-remove failed %o', err);
      } finally {
        pending = false;
      }
    };
  }

  /**
   * Create a click handler for the Add button in a dependency section.
   *
   * @param {Dependency[]} items
   * @param {'Dependencies'|'Dependents'} title
   * @returns {(ev: Event) => Promise<void>}
   */
  function makeDepAddClick(items, title) {
    return async (ev) => {
      if (!current || pending) {
        return;
      }
      const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
      const input = /** @type {HTMLInputElement|null} */ (
        btn.previousElementSibling
      );
      const target = input ? input.value.trim() : '';
      if (!target || target === current.id) {
        showToast('Enter a different issue id');
        return;
      }
      const set = new Set((items || []).map((d) => d.id));
      if (set.has(target)) {
        showToast('Link already exists');
        return;
      }
      pending = true;
      if (btn) {
        btn.disabled = true;
      }
      if (input) {
        input.disabled = true;
      }
      try {
        if (title === 'Dependencies') {
          const updated = await sendFn('dep-add', {
            a: current.id,
            b: target,
            view_id: current.id
          });
          if (updated && typeof updated === 'object') {
            current = /** @type {IssueDetail} */ (updated);
            doRender();
          }
        } else {
          const updated = await sendFn('dep-add', {
            a: target,
            b: current.id,
            view_id: current.id
          });
          if (updated && typeof updated === 'object') {
            current = /** @type {IssueDetail} */ (updated);
            doRender();
          }
        }
      } catch (err) {
        log('dep-add failed %o', err);
        showToast('Failed to add dependency', 'error');
      } finally {
        pending = false;
      }
    };
  }
  /**
   * @param {KeyboardEvent} ev
   */
  function onTitleInputKeydown(ev) {
    if (ev.key === 'Escape') {
      edit_title = false;
      doRender();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      onTitleSave();
    }
  }

  /**
   * @param {KeyboardEvent} ev
   */
  function onDescEditableKeydown(ev) {
    if (ev.key === 'Enter') {
      onDescEdit();
    }
  }

  /**
   * @param {KeyboardEvent} ev
   */
  function onAcceptEditableKeydown(ev) {
    if (ev.key === 'Enter') {
      onAcceptEdit();
    }
  }

  /**
   * @param {KeyboardEvent} ev
   */
  function onNotesEditableKeydown(ev) {
    if (ev.key === 'Enter') {
      onNotesEdit();
    }
  }

  /**
   * @param {KeyboardEvent} ev
   */
  function onDesignEditableKeydown(ev) {
    if (ev.key === 'Enter') {
      onDesignEdit();
    }
  }

  return {
    async load(id) {
      if (!id) {
        renderPlaceholder('No issue selected');
        return;
      }
      current_id = String(id);
      unavailable = '';
      // Try from store first; show placeholder while waiting for snapshot
      current = null;
      refreshFromStore();
      if (!current) {
        renderPlaceholder('Loading…');
      }
      // Render from current (if available) or keep placeholder until push arrives
      pending = false;
      comment_text = '';
      comment_pending = false;
      closeMention();
      doRender();

      await ensureCommentsLoaded(current_id);
    },
    clear() {
      renderPlaceholder('Select an issue to view details');
    },
    /**
     * Replace the modal body with an explanation — used when the detail
     * subscription is refused (issue not on this board) so the user is not
     * left staring at "Loading…" for content that will never arrive.
     *
     * @param {string} message
     */
    showError(message) {
      unavailable = String(message || 'Issue unavailable');
      renderPlaceholder(unavailable);
    },
    destroy() {
      document.removeEventListener('click', onDocumentClick);
      mount_element.replaceChildren();
      if (delete_dialog && delete_dialog.parentNode) {
        delete_dialog.parentNode.removeChild(delete_dialog);
        delete_dialog = null;
      }
    }
  };
}
