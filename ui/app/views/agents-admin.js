import { html, render } from 'lit-html';
import { debug } from '../utils/logging.js';
import { formatDateValue } from './detail.js';
import { createActorChip } from '../utils/actor-name.js';

/**
 * feads addition — the registered-agent roster.
 *
 * This is a read-only window onto `agents` in the SQLite registry. Minting
 * invites and revoking agents are `feads-agent` CLI operations and stay there:
 * an invite token is displayed exactly once and never recoverable, which is a
 * terrible fit for a page that re-renders on every push, and revocation wants
 * the deliberation of a typed command.
 *
 * The server decides how much of the roster arrives (`scope`), so nothing here
 * filters for authorization — it renders what it was given and explains why the
 * list is the size it is.
 */

/**
 * @typedef {import('../state.js').AppState} AppState
 */

/**
 * @typedef {Object} RosterRow
 * @property {string} agent_id
 * @property {string} actor
 * @property {string} display_name
 * @property {string} role
 * @property {string} board_id
 * @property {string} host
 * @property {string} workspace_dir
 * @property {string} session_id
 * @property {string} kind
 * @property {number} registered_at
 * @property {number} last_seen_at
 * @property {number} revoked_at
 * @property {string} revoke_reason
 */

/**
 * Whether the Agents tab should be offered in the header.
 *
 * Exported so the nav and this view cannot disagree about who the page is for.
 *
 * Offered to an admin and to the operator; withheld from a `user`, whose whole
 * roster is one row it already knows. Withheld is not blocked: `#/agents` still
 * routes for a `user` and renders that one row with a note, because a link
 * pasted between agents should explain the tier rather than 404.
 *
 * Answers `false` until `whoami` has replied, so the tab appears once rather
 * than appearing and then being taken away.
 *
 * `mode: 'rejected'` is checked explicitly rather than falling into the
 * operator branch. A rejected credential — a revoked agent's token, most
 * often — has `agent: null`, so a test of "is there an agent, and is it an
 * admin?" would hand it the operator's tab. That inversion, where revoking an
 * agent grants it the admin page, is the one this mode exists to prevent.
 *
 * @param {{ identity?: { loaded?: boolean, mode?: string, agent?: { role?: string } | null } }} state
 * @returns {boolean}
 */
export function isAgentsTabVisible(state) {
  const identity = state?.identity;
  if (!identity?.loaded) {
    return false;
  }
  if (identity.mode === 'rejected') {
    return false;
  }
  if (identity.mode === 'operator') {
    return true;
  }
  return String(identity.agent?.role || '').toLowerCase() === 'admin';
}

/**
 * Human-readable age of a timestamp.
 *
 * Coarse on purpose. The number this feeds is `last_seen_at`, which exists to
 * separate live work from an abandoned claim, and that judgement is made in
 * hours — a to-the-second countdown would imply a precision the check-in
 * interval does not have.
 *
 * @param {number} value - Epoch ms; 0 or absent means never.
 * @param {number} [now]
 * @returns {string}
 */
export function relativeTime(value, now = Date.now()) {
  const ts = Number(value || 0);
  if (!Number.isFinite(ts) || ts <= 0) {
    return 'never';
  }
  const seconds = Math.round((now - ts) / 1000);
  if (seconds < 0) {
    // A clock skew between the agent's host and this one, not a bug worth
    // hiding behind "0 seconds ago".
    return 'in the future';
  }
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
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Shorten a path for a table cell, keeping the tail.
 *
 * The distinguishing part of a workspace path is the end of it — several agents
 * on one machine differ by leaf directory, not by prefix.
 *
 * @param {string} value
 * @param {number} [max]
 * @returns {string}
 */
function shortenPath(value, max = 34) {
  const text = String(value || '');
  if (text.length <= max) {
    return text;
  }
  return `…${text.slice(text.length - (max - 1))}`;
}

/**
 * @param {RosterRow} row
 * @returns {string}
 */
function stateLabel(row) {
  if (row.revoked_at > 0 || (row.archived_at || 0) > 0) return 'archived';
  if (row.expires_at && row.expires_at <= Date.now()) return 'expired';
  return 'live';
}

/**
 * Create the agents roster view (feads).
 *
 * @param {HTMLElement} mount_element
 * @param {{ getState: () => AppState, subscribe: (fn: (s: AppState) => void) => () => void }} store
 * @param {(type: any, payload?: unknown) => Promise<any>} transport
 * @returns {{ load: () => Promise<void>, destroy: () => void }}
 */
export function createAgentsView(mount_element, store, transport) {
  const log = debug('views:agents');

  /** @type {RosterRow[]} */
  let rows = [];
  /** @type {'all'|'self'|'none'} */
  let scope = 'all';
  /** @type {string} */
  let reason = '';
  /** @type {string} */
  let error = '';
  let loaded = false;
  let loading = false;
  let include_revoked = false;

  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /**
   * @param {Event} ev
   */
  function onToggleRevoked(ev) {
    const input = /** @type {HTMLInputElement} */ (ev.target);
    include_revoked = input.checked;
    void load();
  }

  /**
   * Fetch the roster the server is willing to show this caller.
   *
   * @returns {Promise<void>}
   */
  async function load() {
    loading = true;
    doRender();
    try {
      const result = await transport('list-agents', { include_revoked });
      rows = Array.isArray(result?.agents) ? result.agents : [];
      scope =
        result?.scope === 'self' || result?.scope === 'none'
          ? result.scope
          : 'all';
      reason = typeof result?.reason === 'string' ? result.reason : '';
      error = '';
      log('roster loaded: %d row(s), scope=%s', rows.length, scope);
    } catch (err) {
      // A refusal is `forbidden` from the server; anything else is a transport
      // failure. Both read the same to a user, so both land in `error`.
      const message = /** @type {any} */ (err)?.message;
      error =
        typeof message === 'string' && message.length > 0
          ? message
          : 'Failed to load agents';
      rows = [];
      log('roster load failed: %o', err);
    } finally {
      loaded = true;
      loading = false;
      doRender();
    }
  }

  function noteTemplate() {
    const s = store.getState();
    const identity = s.identity;
    if (identity?.mode === 'rejected') {
      // Checked before `scope`, because a rejected caller's scope is `none` and
      // an empty roster on its own reads as "nobody is registered" — the wrong
      // conclusion, and the one that hides a revocation.
      return html`
        <p class="agents-note agents-note--rejected">
          A credential was presented and it was not accepted. The agent may have
          been revoked, or the token may be stale. Register again with a fresh
          invite (<code>feads-agent invite</code>), or clear
          <code>FEADS_AGENT_TOKEN</code> to act as the operator.
        </p>
      `;
    }
    if (scope === 'self') {
      return html`
        <p class="agents-note">
          You are registered as
          <strong>${identity?.agent?.actor || 'this agent'}</strong> at the
          <code>user</code> tier, so this is your own row. The full roster of
          registered agents is visible to an <code>admin</code>.
        </p>
      `;
    }
    if (identity?.mode === 'operator') {
      return html`
        <p class="agents-note">
          No agent identity was presented, so this dashboard is acting as the
          operator and sees every agent on the active board. Registered agents
          are limited by their tier; a local shell is not.
        </p>
      `;
    }
    return html``;
  }

  function bodyTemplate() {
    if (error) {
      return html`<p class="agents-empty agents-empty--error">${error}</p>`;
    }
    if (!loaded && loading) {
      return html`<p class="agents-empty">Loading agents…</p>`;
    }
    if (rows.length === 0) {
      return html`
        <p class="agents-empty">
          ${reason ||
          'No agents are registered on this board yet. Mint an invite with `feads-agent invite`.'}
        </p>
      `;
    }
    return html`
      <div class="issues-block">
        <table class="table agents-table data-table--stack">
          <thead>
            <tr>
              <th>Actor</th>
              <th>Name</th>
              <th>Tier</th>
              <th>Host</th>
              <th>Workspace</th>
              <th>Session</th>
              <th>Registered</th>
              <th>Last seen</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .slice()
              .sort((a, b) => (a.parent_agent_id ? 1 : 0) - (b.parent_agent_id ? 1 : 0))
              .map(
              (row) => html`
                <tr
                  class="agents-row ${row.revoked_at > 0
                    ? 'agents-row--revoked'
                    : ''}"
                >
                  <td data-label="Actor">${createActorChip(row.actor, { parent_actor: row.parent_actor, compact: false })}</td>
                  <td data-label="Name">${row.display_name}</td>
                  <td data-label="Tier">
                    <span class="badge agents-role agents-role--${row.role}"
                      >${row.role}</span
                    >
                  </td>
                  <td data-label="Host">${row.host}</td>
                  <td data-label="Workspace" title="${row.workspace_dir}">
                    ${shortenPath(row.workspace_dir)}
                  </td>
                  <td data-label="Session" title="${row.session_id}">
                    ${row.session_id ? row.session_id.slice(0, 8) : '—'}
                  </td>
                  <td data-label="Registered">
                    ${formatDateValue(row.registered_at)}
                  </td>
                  <td
                    data-label="Last seen"
                    title="${formatDateValue(row.last_seen_at)}"
                  >
                    ${relativeTime(row.last_seen_at)}
                  </td>
                  <td data-label="State">
                    <span
                      class="agents-state agents-state--${stateLabel(row)}"
                      title="${row.revoke_reason}"
                      >${stateLabel(row)}</span
                    >
                  </td>
                </tr>
              `
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  function template() {
    return html`
      <div class="agents-view page">
        <header class="agents-header page-header">
          <div class="page-header__main">
            <h2 class="agents-title page-header__title">Registered agents</h2>
          </div>
          <div class="page-header__actions">
            ${loading && loaded
              ? html`<span class="agents-loading" aria-hidden="true"></span>`
              : ''}
            <label class="agents-toggle">
              <input
                type="checkbox"
                ?checked=${include_revoked}
                ?disabled=${scope === 'self'}
                @change=${onToggleRevoked}
              />
              Show revoked
            </label>
          </div>
        </header>
        ${noteTemplate()} ${bodyTemplate()}
      </div>
    `;
  }

  function doRender() {
    render(template(), mount_element);
  }

  doRender();
  // The note depends on the identity in the store, which arrives after the first
  // render — `whoami` is a round trip.
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
