import { html, render } from 'lit-html';
import { createListSelectors } from '../data/list-selectors.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { skeletonGroups } from '../utils/skeleton.js';
import { createIssueRowRenderer } from './issue-row.js';

/**
 * @typedef {{ id: string, title?: string, status?: string, priority?: number, issue_type?: string, assignee?: string, created_at?: number, updated_at?: number }} IssueLite
 */

/**
 * Epics view (push-only):
 * - Derives epic groups from the local issues store (no RPC reads).
 * - Subscribes to `tab:epics` for top-level membership.
 * - On expand, subscribes to `detail:{id}` (issue-detail) for the epic.
 * - Renders children from the epic detail's `dependents` list.
 * - Provides inline edits via mutations; UI re-renders on push.
 *
 * @param {HTMLElement} mount_element
 * @param {{ updateIssue: (input: any) => Promise<any> }} data
 * @param {(id: string) => void} goto_issue - Navigate to issue detail.
 * @param {{ subscribeList: (client_id: string, spec: { type: string, params?: Record<string, string|number|boolean> }) => Promise<() => Promise<void>>, selectors: { getIds: (client_id: string) => string[], count?: (client_id: string) => number } }} [subscriptions]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void }} [issue_stores]
 */
export function createEpicsView(
  mount_element,
  data,
  goto_issue,
  subscriptions = undefined,
  issue_stores = undefined
) {
  /** @type {any[]} */
  let groups = [];
  /** @type {Set<string>} */
  const expanded = new Set();
  /** @type {Set<string>} */
  const loading = new Set();
  /** @type {Map<string, () => Promise<void>>} */
  const epic_unsubs = new Map();
  // Scope toggle: 'active' hides completed epics (the default); 'all' appends
  // them, visibly marked. Persisted per browser so the choice survives visits.
  const SCOPE_KEY = 'feads.epics.scope';
  /** @type {'active' | 'all'} */
  let scope = 'active';
  try {
    const saved = window.localStorage?.getItem(SCOPE_KEY);
    if (saved === 'all' || saved === 'active') {
      scope = saved;
    }
  } catch {
    // storage unavailable (private mode) — session-local default is fine
  }
  // Centralized selection helpers
  const selectors = issue_stores ? createListSelectors(issue_stores) : null;
  // Live re-render on pushes: recompute groups when stores change.
  // Cards stay collapsed by default — the collapsed header carries the
  // at-a-glance numbers, and expanding is a deliberate drill-in.
  if (selectors) {
    selectors.subscribe(() => {
      groups = buildGroupsFromSnapshot();
      doRender();
    });
  }

  /** @param {any} epic */
  function isClosedEpic(epic) {
    return String((epic && epic.status) || '') === 'closed';
  }

  /** Groups visible under the current scope: active first, completed last. */
  function visibleGroups() {
    const open = groups.filter((g) => !isClosedEpic(g.epic));
    if (scope === 'active') {
      return open;
    }
    const closed = groups
      .filter((g) => isClosedEpic(g.epic))
      .sort((a, b) =>
        String(b.epic?.closed_at || '').localeCompare(
          String(a.epic?.closed_at || '')
        )
      );
    return [...open, ...closed];
  }

  /** @param {'active' | 'all'} next */
  function setScope(next) {
    if (scope === next) {
      return;
    }
    scope = next;
    try {
      window.localStorage?.setItem(SCOPE_KEY, next);
    } catch {
      // best-effort persistence
    }
    doRender();
  }

  /**
   * ISO string or epoch-ms → YYYY-MM-DD, or '' when unparseable. The server
   * normalizes bd timestamps to epoch ms; test fixtures use ISO strings.
   *
   * @param {unknown} v
   */
  function fmtDay(v) {
    const s = String(v || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      return s.slice(0, 10);
    }
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      try {
        return new Date(n).toISOString().slice(0, 10);
      } catch {
        return '';
      }
    }
    return '';
  }

  // Shared row renderer used for children rows
  const renderRow = createIssueRowRenderer({
    navigate: (id) => goto_issue(id),
    onUpdate: updateInline,
    requestRender: doRender,
    getSelectedId: () => null,
    row_class: 'epic-row',
    getFlares: (id) =>
      issue_stores
        ?.snapshotFor?.('flares:board')
        ?.filter((flare) => flare.issue_id === id) || []
  });

  function doRender() {
    render(template(), mount_element);
  }

  /**
   * True while the Epics tab's first snapshot is in flight (feads).
   *
   * @returns {boolean}
   */
  function epicsLoading() {
    const stores = /** @type {any} */ (issue_stores);
    return Boolean(
      stores &&
      typeof stores.isLoaded === 'function' &&
      !stores.isLoaded('tab:epics')
    );
  }

  function template() {
    const visible = visibleGroups();
    const closed_count = groups.filter((g) => isClosedEpic(g.epic)).length;
    const active_count = groups.length - closed_count;
    // Before the first snapshot there is nothing to count: "0" would read as
    // empty, so the scope tabs show no count until it lands.
    const counting = groups.length > 0 || !epicsLoading();
    const empty_hint = !visible.length
      ? scope === 'active' && closed_count > 0
        ? 'No active epics — switch to All to see completed ones.'
        : 'No epics found.'
      : '';
    return html`
      <div class="epics-toolbar">
        <div
          class="epic-scope-toggle segmented"
          role="tablist"
          aria-label="Epic scope"
        >
          <button
            role="tab"
            aria-selected=${scope === 'active'}
            class="segmented__item ${scope === 'active' ? 'is-active' : ''}"
            @click=${() => setScope('active')}
          >
            Active
            ${counting ? html`<span class="mono">${active_count}</span>` : ''}
          </button>
          <button
            role="tab"
            aria-selected=${scope === 'all'}
            class="segmented__item ${scope === 'all' ? 'is-active' : ''}"
            @click=${() => setScope('all')}
          >
            All
            ${counting ? html`<span class="mono">${groups.length}</span>` : ''}
          </button>
        </div>
      </div>
      ${empty_hint && epicsLoading()
        ? skeletonGroups(5, 'epics')
        : empty_hint
          ? html`<div class="empty-state epics-empty">
              <p class="empty-state__body">${empty_hint}</p>
            </div>`
          : visible.map((g) => groupTemplate(g))}
    `;
  }

  /**
   * @param {any} g
   */
  function groupTemplate(g) {
    const epic = g.epic || {};
    const id = String(epic.id || '');
    const is_open = expanded.has(id);
    const is_done = isClosedEpic(epic);
    // Compose children via selectors
    const list = selectors ? selectors.selectEpicChildren(id) : [];
    const is_loading = loading.has(id);
    const total = Number(g.total_children || 0);
    const closed = Number(g.closed_children || 0);
    const remaining = Math.max(0, total - closed);
    const counts_known = Boolean(g.counts_known);
    const done_day = fmtDay(epic.closed_at);
    return html`
      <div
        class="epic-group ${is_done ? 'epic-group--closed' : ''}"
        data-epic-id=${id}
      >
        <div
          class="epic-header"
          @click=${() => toggle(id)}
          role="button"
          tabindex="0"
          aria-expanded=${is_open}
        >
          ${createIssueIdRenderer(id, { class_name: 'mono epic-header__id' })}
          <span class="text-truncate epic-header__title"
            >${epic.title || '(no title)'}</span
          >
          <span class="epic-progress">
            <button
              class="epic-story-btn"
              title="Story: dependency graph and history replay"
              @click=${(/** @type {MouseEvent} */ ev) => {
                // A drill-in, not an expand — don't toggle the group.
                ev.stopPropagation();
                window.location.hash = `#/story/${encodeURIComponent(id)}`;
              }}
            >
              Story
            </button>
            ${is_done
              ? html`<span class="epic-done-chip" title="This epic is closed"
                  >✓ Completed${done_day ? html` ${done_day}` : null}</span
                >`
              : html`<progress
                    value=${closed}
                    max=${Math.max(1, total)}
                  ></progress>
                  <span class="muted mono">${closed}/${total}</span>`}
          </span>
          ${is_open
            ? null
            : html`<span class="epic-sub">
                ${is_done
                  ? html`${counts_known
                      ? html`<span>${total} task${total === 1 ? '' : 's'}</span
                          ><span class="epic-sub__dot">·</span
                          ><span>all wrapped</span>`
                      : html`<span>closed epic — expand for tasks</span>`}`
                  : html`<span
                        >${remaining} task${remaining === 1 ? '' : 's'}
                        remaining</span
                      ><span class="epic-sub__dot">·</span
                      ><span>${closed} done of ${total}</span>`}
                ${epic.assignee
                  ? html`<span class="epic-sub__dot">·</span
                      ><span class="epic-sub__owner">${epic.assignee}</span>`
                  : null}
              </span>`}
        </div>
        ${is_open
          ? html`<div class="epic-children">
              ${is_loading
                ? html`<div class="muted">Loading…</div>`
                : list.length === 0
                  ? html`<div class="muted">No issues found</div>`
                  : html`<table class="table issues-table">
                      <colgroup>
                        <col style="width: 100px" />
                        <col style="width: 120px" />
                        <col />
                        <col style="width: 120px" />
                        <col style="width: 160px" />
                        <col style="width: 130px" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Type</th>
                          <th>Title</th>
                          <th>Status</th>
                          <th>Assignee</th>
                          <th>Priority</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${list.map((it) => renderRow(it))}
                      </tbody>
                    </table>`}
            </div>`
          : null}
      </div>
    `;
  }

  /**
   * @param {string} id
   * @param {{ [k: string]: any }} patch
   */
  async function updateInline(id, patch) {
    try {
      await data.updateIssue({ id, ...patch });
      // Re-render; view will update on subsequent push
      doRender();
    } catch {
      // swallow; UI remains
    }
  }

  /**
   * @param {string} epic_id
   */
  async function toggle(epic_id) {
    if (!expanded.has(epic_id)) {
      expanded.add(epic_id);
      loading.add(epic_id);
      doRender();
      // Subscribe to epic detail; children are rendered from `dependents`
      if (subscriptions && typeof subscriptions.subscribeList === 'function') {
        try {
          // Register store first to avoid dropping the initial snapshot
          try {
            if (issue_stores && /** @type {any} */ (issue_stores).register) {
              /** @type {any} */ (issue_stores).register(`detail:${epic_id}`, {
                type: 'issue-detail',
                params: { id: epic_id }
              });
            }
          } catch {
            // ignore
          }
          const u = await subscriptions.subscribeList(`detail:${epic_id}`, {
            type: 'issue-detail',
            params: { id: epic_id }
          });
          epic_unsubs.set(epic_id, u);
        } catch {
          // ignore subscription failures
        }
      }
      // Mark as not loading after subscribe attempt; membership will stream in
      loading.delete(epic_id);
    } else {
      expanded.delete(epic_id);
      // Unsubscribe when collapsing
      if (epic_unsubs.has(epic_id)) {
        try {
          const u = epic_unsubs.get(epic_id);
          if (u) {
            await u();
          }
        } catch {
          // ignore
        }
        epic_unsubs.delete(epic_id);
        try {
          if (issue_stores && /** @type {any} */ (issue_stores).unregister) {
            /** @type {any} */ (issue_stores).unregister(`detail:${epic_id}`);
          }
        } catch {
          // ignore
        }
      }
    }
    doRender();
  }

  /** Build groups from the current `tab:epics` snapshot. */
  function buildGroupsFromSnapshot() {
    /** @type {IssueLite[]} */
    const epic_entities =
      issue_stores && issue_stores.snapshotFor
        ? /** @type {IssueLite[]} */ (
            issue_stores.snapshotFor('tab:epics') || []
          )
        : [];
    const next_groups = [];
    for (const epic of epic_entities) {
      const dependents = Array.isArray(/** @type {any} */ (epic).dependents)
        ? /** @type {any[]} */ (/** @type {any} */ (epic).dependents)
        : [];
      // Prefer explicit counters when provided by server; otherwise derive
      const has_total = Number.isFinite(
        /** @type {any} */ (epic).total_children
      );
      const has_closed = Number.isFinite(
        /** @type {any} */ (epic).closed_children
      );
      const total = has_total
        ? Number(/** @type {any} */ (epic).total_children) || 0
        : dependents.length;
      let closed = has_closed
        ? Number(/** @type {any} */ (epic).closed_children) || 0
        : 0;
      if (!has_closed) {
        for (const d of dependents) {
          if (String(d.status || '') === 'closed') {
            closed++;
          }
        }
      }
      next_groups.push({
        epic,
        total_children: total,
        closed_children: closed,
        // Closed epics merged from `bd list` carry no child counters and no
        // dependents until expanded — the collapsed card must not render a
        // confident "0 tasks" it cannot back.
        counts_known: has_total || dependents.length > 0
      });
    }
    return next_groups;
  }

  return {
    async load() {
      // Collapsed by default — no auto-expand. The collapsed header carries
      // the summary; expanding is the reader's call.
      groups = buildGroupsFromSnapshot();
      doRender();
    }
  };
}
