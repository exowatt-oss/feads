import { html, render } from 'lit-html';
import { debug } from '../utils/logging.js';
import { currentSpaceOf } from './accounts-pages.js';

/**
 * @typedef {import('../state.js').WorkspaceInfo} WorkspaceInfo
 */

/**
 * feads — the board picker.
 *
 * Used to be a native `<select>`, which can render exactly one string per
 * option — so a reader choosing between eight boards saw eight bare names and
 * had to hover each one for its purpose. This is a listbox popover instead:
 * every option shows the board's name, what it is for (the registry
 * description) and the repos it covers, which is the information the choice is
 * actually made on.
 */

/**
 * Extract the project name from a workspace path. Returns just the directory
 * name (e.g., 'myproject' from '/home/user/code/myproject').
 *
 * @param {string} workspace_path
 * @returns {string}
 */
function getProjectName(workspace_path) {
  if (!workspace_path) return 'Unknown';
  const parts = workspace_path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'Unknown';
}

/**
 * Stable identity of a board (feads): its registry id when it has one, else the
 * path. Must match the key the server puts on each entry.
 *
 * @param {WorkspaceInfo} ws
 * @returns {string}
 */
function boardKey(ws) {
  return ws.key || ws.path;
}

/**
 * Whether an entry is the server's All-boards pseudo-board (feads).
 *
 * @param {WorkspaceInfo | null | undefined} ws
 * @returns {boolean}
 */
function isAllBoards(ws) {
  return Boolean(ws && ws.id === '*');
}

/**
 * What to call a board (feads). The registry name says what the board is *for*;
 * the directory basename is the fallback for boards nobody registered.
 *
 * @param {WorkspaceInfo} ws
 * @returns {string}
 */
function boardLabel(ws) {
  const name = (ws.name || '').trim();
  return name.length > 0 ? name : getProjectName(ws.path);
}

/**
 * One-line summary shown next to the picker (feads).
 *
 * @param {WorkspaceInfo | null | undefined} ws
 * @returns {string}
 */
function boardSummary(ws) {
  if (!ws) return '';
  const description = (ws.description || '').trim();
  if (description.length > 0) return description;
  const repos = ws.repos || [];
  return repos.length > 0 ? repos.join(', ') : '';
}

/**
 * The repos line for an option row (feads) — short names, capped, so a board
 * covering nineteen repos does not become a wall.
 *
 * @param {WorkspaceInfo} ws
 * @returns {string}
 */
function boardReposLine(ws) {
  const repos = (ws.repos || []).map((r) => {
    const cut = r.lastIndexOf('/');
    return cut >= 0 ? r.slice(cut + 1) : r;
  });
  if (repos.length === 0) {
    return '';
  }
  const shown = repos.slice(0, 4);
  const extra = repos.length - shown.length;
  return shown.join(' · ') + (extra > 0 ? ` +${extra}` : '');
}

/**
 * Create the board picker component.
 *
 * @param {HTMLElement} mount_element
 * @param {{ getState: () => any, subscribe: (fn: (s: any) => void) => () => void }} store
 * @param {(board_key: string) => Promise<void>} onWorkspaceChange
 */
export function createWorkspacePicker(mount_element, store, onWorkspaceChange) {
  const log = debug('views:workspace-picker');
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {boolean} */
  let is_switching = false;
  /** @type {boolean} */
  let is_open = false;
  /** @type {string} */
  let active_key = '';

  /**
   * The selectable entries, in menu order (the server puts All boards first).
   *
   * @returns {WorkspaceInfo[]}
   */
  function availableBoards() {
    const s = store.getState();
    const all = s.workspace?.available || [];
    // feads accounts mode: the Space selector narrows the picker to one space.
    // The server already lists only boards the caller can read; this is a view
    // filter, not access control.
    const space = s.workspace?.space || currentSpaceOf(s);
    if (!space || !all.some((/** @type {WorkspaceInfo} */ ws) => ws.space_id)) {
      return all;
    }
    return all.filter(
      (/** @type {WorkspaceInfo} */ ws) =>
        ws.id === '*' || ws.space_id === space
    );
  }

  /**
   * @returns {string}
   */
  function currentKey() {
    const s = store.getState();
    const current = s.workspace?.current;
    return current ? boardKey(current) : '';
  }

  /**
   * @param {boolean} next
   */
  function setOpen(next) {
    if (is_open === next) {
      return;
    }
    is_open = next;
    if (next) {
      active_key = currentKey();
      document.addEventListener('pointerdown', onDocumentPointerDown, true);
    } else {
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    }
    doRender();
    if (next) {
      const active = mount_element.querySelector(
        '.board-menu__option[data-active="true"]'
      );
      if (active && typeof (/** @type {any} */ (active).focus) === 'function') {
        /** @type {HTMLElement} */ (active).focus();
      }
    }
  }

  /**
   * Close when a pointer goes down anywhere outside the picker.
   *
   * @param {Event} ev
   */
  function onDocumentPointerDown(ev) {
    const target = /** @type {Node | null} */ (ev.target);
    if (target && mount_element.contains(target)) {
      return;
    }
    setOpen(false);
  }

  /**
   * @param {WorkspaceInfo} ws
   */
  async function choose(ws) {
    const new_key = boardKey(ws);
    setOpen(false);
    if (ws.exists === false || !new_key || new_key === currentKey()) {
      return;
    }
    log('switching board to %s', new_key);
    is_switching = true;
    doRender();
    try {
      await onWorkspaceChange(new_key);
    } catch (err) {
      log('board switch failed: %o', err);
    } finally {
      is_switching = false;
      doRender();
    }
  }

  /**
   * Move the keyboard-active option by `delta`, skipping missing boards.
   *
   * @param {number} delta
   */
  function moveActive(delta) {
    const entries = availableBoards().filter((ws) => ws.exists !== false);
    if (entries.length === 0) {
      return;
    }
    const keys = entries.map((ws) => boardKey(ws));
    const at = Math.max(0, keys.indexOf(active_key));
    const next = Math.min(keys.length - 1, Math.max(0, at + delta));
    active_key = keys[next];
    doRender();
    const active = mount_element.querySelector(
      '.board-menu__option[data-active="true"]'
    );
    if (active) {
      /** @type {HTMLElement} */ (active).focus();
    }
  }

  /**
   * Keyboard behavior for the whole widget: trigger and options share it so
   * arrows work from either.
   *
   * @param {KeyboardEvent} ev
   */
  function onKeydown(ev) {
    if (!is_open) {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      setOpen(false);
      const trigger = mount_element.querySelector('.board-menu__trigger');
      if (trigger) {
        /** @type {HTMLElement} */ (trigger).focus();
      }
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveActive(1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveActive(-1);
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      const chosen = availableBoards().find(
        (ws) => boardKey(ws) === active_key
      );
      if (chosen) {
        void choose(chosen);
      }
      return;
    }
    if (ev.key === 'Tab') {
      setOpen(false);
    }
  }

  /**
   * One option row.
   *
   * @param {WorkspaceInfo} ws
   */
  function optionTemplate(ws) {
    const key = boardKey(ws);
    const selected = key === currentKey();
    const missing = ws.exists === false;
    const all = isAllBoards(ws);
    const description = (ws.description || '').trim();
    const repos_line = boardReposLine(ws);
    return html`
      <div
        class="board-menu__option ${all
          ? 'board-menu__option--all'
          : ''} ${missing ? 'board-menu__option--missing' : ''}"
        role="option"
        tabindex="-1"
        aria-selected=${selected ? 'true' : 'false'}
        aria-disabled=${missing ? 'true' : 'false'}
        data-board-key=${key}
        data-active=${key === active_key ? 'true' : 'false'}
        @click=${() => void choose(ws)}
        @pointerenter=${() => {
          active_key = key;
          doRender();
        }}
      >
        <div class="board-menu__option-head">
          <span class="board-menu__name">
            ${all ? html`<span class="board-menu__all-mark">∗</span>` : ''}
            ${boardLabel(ws)}${missing ? ' (missing)' : ''}
          </span>
          ${selected
            ? html`<span class="board-menu__check" aria-hidden="true">✓</span>`
            : ''}
        </div>
        ${description
          ? html`<div class="board-menu__description">${description}</div>`
          : ''}
        ${repos_line
          ? html`<div class="board-menu__repos">${repos_line}</div>`
          : ''}
      </div>
    `;
  }

  function template() {
    const s = store.getState();
    const current = s.workspace?.current;
    /** @type {WorkspaceInfo[]} */
    const available = availableBoards();

    // Don't render if no workspaces available
    if (available.length === 0) {
      return html``;
    }

    // If only one workspace, show it as a simple label
    if (available.length === 1) {
      const only = available[0];
      const summary = boardSummary(only);
      return html`
        <div class="workspace-picker workspace-picker--single">
          <span class="workspace-picker__label" title="${summary}"
            >${boardLabel(only)}</span
          >
          ${summary
            ? html`<span class="workspace-picker__meta" title="${summary}"
                >${summary}</span
              >`
            : ''}
        </div>
      `;
    }

    const current_key = current ? boardKey(current) : '';
    const current_entry =
      available.find((ws) => boardKey(ws) === current_key) || current || null;
    const summary = boardSummary(current_entry);
    const label = current_entry
      ? boardLabel(/** @type {WorkspaceInfo} */ (current_entry))
      : 'Select board';
    const all_entries = available.filter((ws) => isAllBoards(ws));
    const board_entries = available.filter((ws) => !isAllBoards(ws));
    return html`
      <div class="workspace-picker" @keydown=${onKeydown}>
        <button
          type="button"
          class="board-menu__trigger context-select ${isAllBoards(current_entry)
            ? 'board-menu__trigger--all'
            : ''}"
          aria-haspopup="listbox"
          aria-expanded=${is_open ? 'true' : 'false'}
          aria-label="Select board"
          title=${`Board: ${label}`}
          ?disabled=${is_switching}
          @click=${() => setOpen(!is_open)}
        >
          <span class="board-menu__trigger-label">${label}</span>
          <span class="board-menu__caret" aria-hidden="true">▾</span>
        </button>
        ${is_open
          ? html`
              <div class="board-menu" role="listbox" aria-label="Boards">
                ${all_entries.map((ws) => optionTemplate(ws))}
                ${all_entries.length > 0 && board_entries.length > 0
                  ? html`<div class="board-menu__divider" role="none"></div>`
                  : ''}
                ${board_entries.map((ws) => optionTemplate(ws))}
              </div>
            `
          : ''}
        ${summary
          ? html`<span class="workspace-picker__meta" title="${summary}"
              >${summary}</span
            >`
          : ''}
        ${is_switching
          ? html`<span
              class="workspace-picker__loading"
              aria-hidden="true"
            ></span>`
          : ''}
      </div>
    `;
  }

  function doRender() {
    render(template(), mount_element);
  }

  doRender();
  unsubscribe = store.subscribe(() => doRender());

  return {
    destroy() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      render(html``, mount_element);
    }
  };
}
