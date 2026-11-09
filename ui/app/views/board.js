import { html, nothing, render } from 'lit-html';
import { createListSelectors } from '../data/list-selectors.js';
import { cmpClosedDesc, cmpPriorityThenCreated } from '../data/sort.js';
import { createActorChip } from '../utils/actor-name.js';
import { createFlarePips, groupFlaresByIssue } from '../utils/flare-pip.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { debug } from '../utils/logging.js';
import {
  actorDisplay,
  ownerOf,
  personKeyOf,
  samePerson
} from '../utils/owners.js';
import { personFor } from '../utils/people.js';
import { skeletonCards } from '../utils/skeleton.js';
import { showToast } from '../utils/toast.js';

/**
 * @typedef {{
 *   id: string,
 *   title?: string,
 *   status?: 'open'|'in_progress'|'closed',
 *   priority?: number,
 *   issue_type?: string,
 *   assignee?: string,
 *   created_by?: string,
 *   created_at?: number,
 *   updated_at?: number,
 *   closed_at?: number,
 *   started_at?: string|number,
 *   parent?: string,
 *   comment_count?: number,
 *   dependencies?: Array<{ id: string, title?: string }>,
 *   blocked_by?: Array<string | { id: string, title?: string }>,
 *   metadata?: Record<string, unknown>,
 *   board_id?: string,
 *   board_name?: string
 * }} IssueLite
 */

/**
 * Map column IDs to their corresponding status values.
 *
 * @type {Record<string, 'open'|'in_progress'|'closed'>}
 */
const COLUMN_STATUS_MAP = {
  'blocked-col': 'open',
  'ready-col': 'open',
  'in-progress-col': 'in_progress',
  'closed-col': 'closed'
};

/**
 * How many cards a lane shows before folding the rest behind "Show all".
 * A board with hundreds of tickets must render a glance, not a mile of
 * scroll — the column header still counts everything.
 */
const COLUMN_CAP = 20;

/**
 * What an empty lane says. Light grain-silo touch, nothing shouty.
 *
 * @type {Record<string, string>}
 */
const EMPTY_COPY = {
  'blocked-col': 'Nothing stuck.',
  'ready-col': 'The hopper is empty.',
  'in-progress-col': 'Nothing on the feed right now.',
  'closed-col': 'Nothing harvested in this window.'
};

/**
 * Coerce a bd timestamp (ISO string or epoch ms) to epoch ms, 0 when absent.
 *
 * @param {unknown} v
 * @returns {number}
 */
function tsOf(v) {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : 0;
  }
  if (typeof v === 'string' && v.length > 0) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/**
 * The "by <person>" line on a card: the person's name, and their hover card when the
 * creator is a known person (accounts mode). Hover-only — the card is the
 * click target.
 *
 * @param {string} created_by
 */
function creatorName(created_by) {
  const name = actorDisplay(created_by).name;
  const person = personFor(created_by);
  return person
    ? html`<span data-person-hover=${person.actor}>${name}</span>`
    : name;
}

/**
 * Short relative age — the board is scanned, not read.
 *
 * @param {number} ts - Epoch ms.
 * @returns {string}
 */
export function formatAgo(ts) {
  if (!Number.isFinite(ts) || ts <= 0) {
    return '';
  }
  const diff = Date.now() - ts;
  if (diff < 90_000) {
    return 'just now';
  }
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.round(diff / 86_400_000);
  return `${days}d`;
}

/**
 * The human behind a card: whoever it is assigned to, else whoever filed it.
 *
 * @param {IssueLite} it
 * @returns {string}
 */
export function personOf(it) {
  const assignee = String(it.assignee || '').trim();
  if (assignee.length > 0) {
    return assignee;
  }
  return String(it.created_by || '').trim();
}

/**
 * The epic a card belongs to — its parent, or itself when it is an epic.
 *
 * @param {IssueLite} it
 * @returns {string}
 */
export function epicIdOf(it) {
  if (String(it.issue_type || '') === 'epic') {
    return String(it.id || '');
  }
  return String(it.parent || '');
}

/**
 * Stable hue for a name, so the same person/epic keeps their colour across
 * renders and columns without anyone assigning it.
 *
 * @param {string} name
 * @returns {number} 0–359
 */
export function hueFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/**
 * Initials for the avatar chip. Emails use their local part; hyphen/underscore
 * separated agent names contribute one letter per token.
 *
 * @param {string} name
 * @returns {string}
 */
export function initialsOf(name) {
  const at = name.indexOf('@');
  const base = at > 0 ? name.slice(0, at) : name;
  const tokens = base.split(/[\s\-_./]+/).filter(Boolean);
  if (tokens.length === 0) {
    return '?';
  }
  if (tokens.length === 1) {
    return tokens[0].slice(0, 2).toUpperCase();
  }
  return (tokens[0][0] + tokens[1][0]).toUpperCase();
}

/**
 * The artifacts a bead declared (repos, files, PRs) from its metadata.
 * Shape mirrors what `bd` stores under `artifact:*` keys.
 *
 * @param {IssueLite} it
 * @returns {Array<{ repo: string, path: string, kind: string, pr?: number, intent: string }>}
 */
export function artifactsOf(it) {
  const meta =
    it && it.metadata && typeof it.metadata === 'object' ? it.metadata : null;
  if (!meta) {
    return [];
  }
  /** @type {Array<{ repo: string, path: string, kind: string, pr?: number, intent: string }>} */
  const out = [];
  for (const [key, value] of Object.entries(meta)) {
    if (!key.startsWith('artifact:') || !value || typeof value !== 'object') {
      continue;
    }
    const a = /** @type {any} */ (value);
    out.push({
      repo: String(a.repo || ''),
      path: String(a.path || ''),
      kind: String(a.kind || ''),
      pr: typeof a.pr === 'number' ? a.pr : undefined,
      intent: String(a.intent || 'editing')
    });
  }
  // Live claims first; finished ones are history and go last.
  const rank = (/** @type {string} */ intent) => (intent === 'done' ? 1 : 0);
  out.sort((a, b) => rank(a.intent) - rank(b.intent));
  return out;
}

/**
 * The scannable label for an artifact chip: `repo#12` for PRs, the repo's own
 * name for whole-repo claims, the file's tail for paths.
 *
 * @param {{ repo: string, path: string, kind: string, pr?: number }} a
 * @returns {string}
 */
export function artifactChipLabel(a) {
  const repo_tail = a.repo.includes('/')
    ? a.repo.slice(a.repo.indexOf('/') + 1)
    : a.repo;
  if (a.kind === 'pr') {
    return `${repo_tail}#${a.pr}`;
  }
  if (a.kind === 'repo' || a.path.length === 0) {
    return repo_tail;
  }
  const parts = a.path.split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : a.path;
}

/**
 * Create the Board view with Blocked, Ready, In progress, Done lanes.
 * Push-only: derives items from per-subscription stores.
 *
 * Sorting rules:
 * - Ready/Blocked: priority asc, then created_at asc.
 * - In progress: most recently started first, then priority.
 * - Done: closed_at desc.
 *
 * @param {HTMLElement} mount_element
 * @param {unknown} _data - Unused (legacy param retained for call-compat)
 * @param {(id: string) => void} gotoIssue - Navigate to issue detail.
 * @param {{ getState: () => any, setState: (patch: any) => void, subscribe?: (fn: (s:any)=>void)=>()=>void }} [store]
 * @param {{ selectors: { getIds: (client_id: string) => string[], count?: (client_id: string) => number } }} [subscriptions]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void }} [issueStores]
 * @param {(type: string, payload: unknown) => Promise<unknown>} [transport] - Transport function for sending updates
 * @returns {{ load: () => Promise<void>, clear: () => void }}
 */
export function createBoardView(
  mount_element,
  _data,
  gotoIssue,
  store,
  subscriptions = undefined,
  issueStores = undefined,
  transport = undefined
) {
  const log = debug('views:board');
  /**
   * feads: issue ids whose drag-and-drop status change awaits the server.
   *
   * @type {Set<string>}
   */
  const pending_moves = new Set();
  /** @type {IssueLite[]} */
  let list_ready = [];
  /** @type {IssueLite[]} */
  let list_blocked = [];
  /** @type {IssueLite[]} */
  let list_in_progress = [];
  /** @type {IssueLite[]} */
  let list_closed = [];
  /** @type {IssueLite[]} */
  let list_closed_raw = [];
  // Centralized selection helpers
  const selectors = issueStores ? createListSelectors(issueStores) : null;

  /**
   * Closed column filter mode.
   * 'today' → items with closed_at since local day start
   * '3' → last 3 days; '7' → last 7 days
   *
   * @type {'today'|'3'|'7'}
   */
  let closed_filter_mode = 'today';
  /** Columns whose full list the reader asked to see (uncapped). */
  const expanded_columns = new Set();
  /** Person filter: matches assignee, else creator. '' = everyone. */
  let person_filter = '';
  /** Epic filter: parent epic id, '__none' for cards without one. '' = all. */
  let epic_filter = '';
  if (store) {
    try {
      const s = store.getState();
      const cf =
        s && s.board ? String(s.board.closed_filter || 'today') : 'today';
      if (cf === 'today' || cf === '3' || cf === '7') {
        closed_filter_mode = /** @type {any} */ (cf);
      }
      person_filter = s && s.board ? String(s.board.person || '') : '';
      epic_filter = s && s.board ? String(s.board.epic || '') : '';
    } catch {
      // ignore store init errors
    }
  }

  /** All lists, one pass — the option builders and title map read this. */
  function allItems() {
    return [
      ...list_blocked,
      ...list_ready,
      ...list_in_progress,
      ...list_closed_raw
    ];
  }

  /**
   * Epic id → human title, harvested from the cards themselves: an epic's own
   * card carries its title, and children carry the parent's title inside
   * their `dependencies`. No extra subscription needed.
   *
   * @returns {Map<string, string>}
   */
  function epicTitles() {
    /** @type {Map<string, string>} */
    const titles = new Map();
    for (const it of allItems()) {
      if (String(it.issue_type || '') === 'epic' && it.title) {
        titles.set(String(it.id), String(it.title));
      }
      const parent = String(it.parent || '');
      if (parent && !titles.has(parent) && Array.isArray(it.dependencies)) {
        const dep = it.dependencies.find((d) => String(d?.id) === parent);
        if (dep && dep.title) {
          titles.set(parent, String(dep.title));
        }
      }
    }
    return titles;
  }

  /**
   * Apply the person/epic filters to a column's items.
   *
   * @param {IssueLite[]} items
   * @returns {IssueLite[]}
   */
  function applyBoardFilters(items) {
    let out = items;
    if (person_filter) {
      // Accounts mode: a person includes every alias of theirs, so filtering
      // by mira shows alex-laptop's cards too.
      const wanted = personKeyOf(person_filter);
      out = out.filter((it) => personKeyOf(personOf(it)) === wanted);
    }
    if (epic_filter === '__none') {
      out = out.filter((it) => epicIdOf(it) === '');
    } else if (epic_filter) {
      out = out.filter((it) => epicIdOf(it) === epic_filter);
    }
    return out;
  }

  function template() {
    const board_flares = issueStores?.snapshotFor?.('flares:board') || [];
    const live_actors = Array.from(
      new Map(
        board_flares
          .filter((f) => f?.liveness === 'live' && f.actor)
          .map((f) => [f.actor, f])
      ).values()
    );
    const known_parents = store?.getState?.()?.directory?.parents || [];
    // One option per person: an alias groups under its owner (accounts mode).
    const people = new Set();
    for (const it of allItems()) {
      const p = personKeyOf(personOf(it));
      if (p) {
        people.add(p);
      }
    }
    const selected_person = person_filter ? personKeyOf(person_filter) : '';
    if (selected_person) {
      people.add(selected_person);
    }
    const person_options = Array.from(people).sort((a, b) =>
      a.localeCompare(b)
    );
    const titles = epicTitles();
    const epic_ids = new Set(titles.keys());
    /** @type {Set<string>} */
    const closed_epics = new Set();
    for (const it of allItems()) {
      const e = epicIdOf(it);
      if (e) {
        epic_ids.add(e);
      }
      if (
        String(it.issue_type || '') === 'epic' &&
        (String(it.status || '') === 'closed' || it.closed_at)
      ) {
        closed_epics.add(String(it.id));
      }
    }
    if (epic_filter && epic_filter !== '__none') {
      epic_ids.add(epic_filter);
    }
    // Active epics first, closed ones labelled and sunk to the bottom, so a
    // finished session's epic can't be mistaken for the live one with the
    // same title (dup titles happen: session epics re-filed across days).
    const epic_options = Array.from(epic_ids)
      .map((id) => ({
        id,
        title: titles.get(id) || id,
        closed: closed_epics.has(id)
      }))
      .sort(
        (a, b) =>
          Number(a.closed) - Number(b.closed) || a.title.localeCompare(b.title)
      );
    const filters_active = Boolean(person_filter || epic_filter);

    return html`
      <div class="panel__body">
        <div class="board-toolbar">
          <label class="board-filter">
            <span>Person</span>
            <select
              id="board-person-filter"
              aria-label="Filter board by person"
              @change=${onPersonFilterChange}
            >
              <option value="" ?selected=${person_filter === ''}>
                Everyone
              </option>
              ${person_options.map(
                (p) => html`
                  <option value=${p} ?selected=${selected_person === p}>
                    ${p}
                  </option>
                `
              )}
            </select>
          </label>
          <label class="board-filter">
            <span>Epic</span>
            <select
              id="board-epic-filter"
              aria-label="Filter board by epic"
              @change=${onEpicFilterChange}
            >
              <option value="" ?selected=${epic_filter === ''}>
                All epics
              </option>
              <option value="__none" ?selected=${epic_filter === '__none'}>
                No epic
              </option>
              ${epic_options.map(
                (e) => html`
                  <option value=${e.id} ?selected=${epic_filter === e.id}>
                    ${e.closed ? `${e.title} (closed)` : e.title}
                  </option>
                `
              )}
            </select>
          </label>
          ${filters_active
            ? html`<button
                class="board-toolbar__clear"
                @click=${onClearFilters}
              >
                Clear filters
              </button>`
            : ''}
          ${live_actors.length
            ? html`<div class="live-now">
                <span class="live-now__label">● live now:</span
                >${createFlarePips([live_actors[0]], {
                  compact: true
                })}${live_actors.slice(0, 4).map((f) =>
                  createActorChip(f.actor, {
                    parent_actor: f.parent_actor,
                    known_parents,
                    compact: true
                  })
                )}${live_actors.length > 4
                  ? html`<span>+${live_actors.length - 4}</span>`
                  : ''}
              </div>`
            : ''}
        </div>
        <div class="board-root">
          ${columnTemplate(
            'Blocked',
            'blocked-col',
            applyBoardFilters(list_blocked),
            titles
          )}
          ${columnTemplate(
            'Ready',
            'ready-col',
            applyBoardFilters(list_ready),
            titles
          )}
          ${columnTemplate(
            'In progress',
            'in-progress-col',
            applyBoardFilters(list_in_progress),
            titles
          )}
          ${columnTemplate(
            'Done',
            'closed-col',
            applyBoardFilters(list_closed),
            titles
          )}
        </div>
      </div>
    `;
  }

  /**
   * The subscription each column renders from (feads).
   *
   * @type {Record<string, string>}
   */
  const COLUMN_STORES = {
    'blocked-col': 'tab:board:blocked',
    'ready-col': 'tab:board:ready',
    'in-progress-col': 'tab:board:in-progress',
    'closed-col': 'tab:board:closed'
  };

  /**
   * Whether a column is still waiting for its first snapshot (feads).
   *
   * @param {string} id - Board column element id, e.g. `ready-col`.
   * @returns {boolean} True while the column's first snapshot is in flight.
   */
  function isColumnLoading(id) {
    const stores = /** @type {any} */ (issueStores);
    if (!stores || typeof stores.isLoaded !== 'function') {
      return false;
    }
    const client_id = COLUMN_STORES[id];
    return Boolean(client_id) && !stores.isLoaded(client_id);
  }

  /**
   * @param {string} title
   * @param {string} id
   * @param {IssueLite[]} items
   * @param {Map<string, string>} titles
   */
  function columnTemplate(title, id, items, titles) {
    const item_count = Array.isArray(items) ? items.length : 0;
    // feads: a column whose first snapshot has not arrived is loading, not
    // empty — say so instead of "The hopper is empty." for a beat.
    const loading = item_count === 0 && isColumnLoading(id);
    const count_label = item_count === 1 ? '1 issue' : `${item_count} issues`;
    const is_expanded = expanded_columns.has(id);
    const visible = is_expanded ? items : items.slice(0, COLUMN_CAP);
    const hidden_count = item_count - visible.length;
    return html`
      <section
        class="board-column${loading ? ' is-loading' : ''}"
        id=${id}
        aria-busy=${loading ? 'true' : 'false'}
      >
        <header
          class="board-column__header"
          id=${id + '-header'}
          role="heading"
          aria-level="2"
        >
          <div class="board-column__title">
            <span class="board-column__title-text">${title}</span>
            <span class="badge board-column__count" aria-label=${count_label}>
              ${item_count}
            </span>
          </div>
          ${id === 'closed-col'
            ? html`<label class="board-closed-filter">
                <span class="visually-hidden">Filter closed issues</span>
                <select
                  id="closed-filter"
                  aria-label="Filter closed issues"
                  @change=${onClosedFilterChange}
                >
                  <option
                    value="today"
                    ?selected=${closed_filter_mode === 'today'}
                  >
                    Today
                  </option>
                  <option value="3" ?selected=${closed_filter_mode === '3'}>
                    Last 3 days
                  </option>
                  <option value="7" ?selected=${closed_filter_mode === '7'}>
                    Last 7 days
                  </option>
                </select>
              </label>`
            : ''}
        </header>
        <div
          class="board-column__body"
          role="list"
          aria-labelledby=${id + '-header'}
        >
          ${loading
            ? skeletonCards(3)
            : items.length === 0
              ? html`<div class="board-column__empty">
                  ${EMPTY_COPY[id] || 'Nothing here.'}
                </div>`
              : visible.map((it) =>
                  cardTemplate(
                    it,
                    id,
                    titles,
                    groupFlaresByIssue(
                      issueStores?.snapshotFor?.('flares:board') || []
                    ),
                    store?.getState?.()?.directory?.parents || []
                  )
                )}
          ${!loading && hidden_count > 0
            ? html`<button
                class="board-column__more"
                @click=${() => onToggleColumnCap(id)}
              >
                Show all ${item_count}
              </button>`
            : is_expanded && item_count > COLUMN_CAP
              ? html`<button
                  class="board-column__more"
                  @click=${() => onToggleColumnCap(id)}
                >
                  Show fewer
                </button>`
              : ''}
        </div>
      </section>
    `;
  }

  /**
   * @param {string} column_id
   */
  function onToggleColumnCap(column_id) {
    if (expanded_columns.has(column_id)) {
      expanded_columns.delete(column_id);
    } else {
      expanded_columns.add(column_id);
    }
    doRender();
  }

  /**
   * One card, built for a human scanning the room: the title carries the
   * card, the person doing the work is named and pictured, active work
   * pulses, and the repos/files/PRs it touches are right there. Priority
   * only speaks when it is urgent.
   *
   * @param {IssueLite} it
   * @param {string} column_id
   * @param {Map<string, string>} titles
   */
  function cardTemplate(
    it,
    column_id,
    titles,
    flares_by_issue = new Map(),
    /** @type {string[]} */
    known_parents = []
  ) {
    const is_active = column_id === 'in-progress-col';
    const is_closed = column_id === 'closed-col';
    const epic_id =
      String(it.issue_type || '') === 'epic' ? '' : String(it.parent || '');
    const epic_title = epic_id ? titles.get(epic_id) || epic_id : '';
    const prio = typeof it.priority === 'number' ? it.priority : 2;
    const person = personOf(it);
    // The person a card names: an alias renders as its owner (accounts mode).
    const person_key = personKeyOf(person);
    const artifacts = artifactsOf(it);
    const shown_artifacts = artifacts.slice(0, 2);
    const extra_artifacts = artifacts.length - shown_artifacts.length;
    // `bd blocked` emits blockers as bare id strings; enriched rows may carry
    // {id, title} objects. Normalize to one shape for the template.
    const blocked_by = (Array.isArray(it.blocked_by) ? it.blocked_by : [])
      .map((b) =>
        typeof b === 'string'
          ? { id: b, title: '' }
          : { id: String(b?.id || ''), title: String(b?.title || '') }
      )
      .filter((b) => b.id.length > 0);
    const comment_count = Number(it.comment_count || 0);

    /** @type {string} */
    let when = '';
    if (is_active) {
      const started = tsOf(it.started_at);
      when = started > 0 ? `started ${formatAgo(started)} ago` : '';
      if (when === 'started just now ago') {
        when = 'started just now';
      }
    } else if (is_closed) {
      const closed = Number(it.closed_at || 0);
      const ago = formatAgo(closed);
      when =
        ago === 'just now' ? 'done just now' : ago ? `done ${ago} ago` : '';
    } else {
      const created = Number(it.created_at || 0);
      const ago = formatAgo(created);
      when = ago === 'just now' ? 'just now' : ago ? `${ago} old` : '';
    }

    return html`
      <article
        class="board-card ${is_active ? 'board-card--active' : ''} ${is_closed
          ? 'board-card--closed'
          : ''} ${pending_moves.has(it.id) ? 'is-pending' : ''}"
        aria-busy=${pending_moves.has(it.id) ? 'true' : 'false'}
        data-issue-id=${it.id}
        role="listitem"
        tabindex="-1"
        draggable="true"
        @click=${(/** @type {MouseEvent} */ ev) => onCardClick(ev, it.id)}
        @dragstart=${(/** @type {DragEvent} */ ev) => onDragStart(ev, it.id)}
        @dragend=${onDragEnd}
      >
        ${epic_title || prio <= 1 || it.board_id
          ? html`<div class="board-card__eyebrow">
              ${it.board_id
                ? // The board is the fact a reader scans for on the All view, so it
                  // keeps its width; the epic beside it is what gets truncated.
                  html`<span
                    class="board-chip"
                    style="--chip-hue: ${hueFor(String(it.board_id))}"
                    title=${`Board: ${it.board_name || it.board_id}`}
                    ><span class="board-chip__label"
                      >${it.board_name || it.board_id}</span
                    ></span
                  >`
                : ''}
              ${epic_title
                ? html`<span
                    class="epic-chip"
                    style="--chip-hue: ${hueFor(epic_id)}"
                    title=${`Epic: ${epic_title} (${epic_id})`}
                    ><span class="epic-chip__label">${epic_title}</span></span
                  >`
                : ''}
              ${prio <= 1
                ? html`<span class="prio-flag is-p${prio}"
                    >${prio === 0 ? 'urgent' : 'high'}</span
                  >`
                : ''}
            </div>`
          : ''}
        <div class="board-card__title">${it.title || '(no title)'}</div>
        ${person || comment_count > 0 || is_active
          ? html`<div class="board-card__people">
              ${flares_by_issue.get(String(it.id))?.length
                ? createFlarePips(flares_by_issue.get(String(it.id)))
                : is_active
                  ? html`<span class="pulse-dot"></span>`
                  : ''}
              ${person
                ? html`<span
                      class="avatar"
                      style="--chip-hue: ${hueFor(person_key)}"
                      aria-hidden="true"
                      >${initialsOf(person_key)}</span
                    >
                    <span
                      class="board-card__assignee"
                      title=${personFor(person)
                        ? nothing
                        : ownerOf(person)
                          ? `${person_key} — via ${person}`
                          : person}
                      >${createActorChip(person, {
                        known_parents,
                        compact: true
                      })}</span
                    >`
                : ''}
              ${comment_count > 0
                ? html`<span
                    class="board-card__comments"
                    title=${`${comment_count} ${comment_count === 1 ? 'comment' : 'comments'}`}
                    >${comment_count}</span
                  >`
                : ''}
            </div>`
          : ''}
        <div class="board-card__foot">
          <span class="board-card__when"
            >${createIssueIdRenderer(it.id, { class_name: 'mono' })}${when
              ? html` · ${when}`
              : ''}</span
          >
          ${it.created_by && !samePerson(String(it.created_by), person)
            ? html`<span
                class="board-card__creator"
                title=${personFor(String(it.created_by))
                  ? nothing
                  : actorDisplay(String(it.created_by)).via
                    ? `${actorDisplay(String(it.created_by)).name} — via ${it.created_by}`
                    : String(it.created_by)}
                >by ${creatorName(String(it.created_by))}</span
              >`
            : ''}
        </div>
        ${shown_artifacts.length > 0
          ? html`<div class="board-card__artifacts">
              ${shown_artifacts.map(
                (a) =>
                  html`<span
                    class="artifact-chip"
                    title=${`${a.repo}${a.path ? ':' + a.path : ''} (${a.intent})`}
                    >${artifactChipLabel(a)}</span
                  >`
              )}
              ${extra_artifacts > 0
                ? html`<span class="artifact-chip artifact-chip--more"
                    >+${extra_artifacts}</span
                  >`
                : ''}
            </div>`
          : ''}
        ${blocked_by.length > 0
          ? html`<div
              class="board-card__blocked-by"
              title=${blocked_by
                .map((b) => `${b.id}${b.title ? ' — ' + b.title : ''}`)
                .join('\n')}
            >
              waiting on ${blocked_by.map((b) => b.id).join(', ')}
            </div>`
          : ''}
      </article>
    `;
  }

  /** @type {string|null} */
  let dragging_id = null;

  /**
   * Handle card click, ignoring clicks during drag operations.
   *
   * @param {MouseEvent} ev
   * @param {string} id
   */
  function onCardClick(ev, id) {
    // Only navigate if this wasn't a drag operation
    if (!dragging_id) {
      gotoIssue(id);
    }
  }

  /**
   * Handle drag start: store issue id in dataTransfer and add dragging class.
   *
   * @param {DragEvent} ev
   * @param {string} id
   */
  function onDragStart(ev, id) {
    dragging_id = id;
    if (ev.dataTransfer) {
      ev.dataTransfer.setData('text/plain', id);
      ev.dataTransfer.effectAllowed = 'move';
    }
    const target = /** @type {HTMLElement} */ (ev.target);
    target.classList.add('board-card--dragging');
    log('dragstart %s', id);
  }

  /**
   * Handle drag end: remove dragging class.
   *
   * @param {DragEvent} ev
   */
  function onDragEnd(ev) {
    const target = /** @type {HTMLElement} */ (ev.target);
    target.classList.remove('board-card--dragging');
    // Clear any highlighted drop target
    clearDropTarget();
    // Clear dragging_id after a short delay to allow click event to check it
    setTimeout(() => {
      dragging_id = null;
    }, 0);
    log('dragend');
  }

  /**
   * Clear the currently highlighted drop target column.
   */
  function clearDropTarget() {
    /** @type {HTMLElement[]} */
    const all_cols = Array.from(
      mount_element.querySelectorAll('.board-column--drag-over')
    );
    for (const c of all_cols) {
      c.classList.remove('board-column--drag-over');
    }
  }

  /**
   * Update issue status via WebSocket transport.
   *
   * @param {string} issue_id
   * @param {'open'|'in_progress'|'closed'} new_status
   */
  async function updateIssueStatus(issue_id, new_status) {
    if (!transport) {
      log('no transport available, status update skipped');
      showToast('Cannot update status: not connected', 'error');
      return;
    }
    // feads: the card shows the move is in flight until the server answers,
    // instead of sitting unchanged in its old column with no feedback.
    pending_moves.add(issue_id);
    doRender();
    try {
      log('update-status %s → %s', issue_id, new_status);
      await transport('update-status', { id: issue_id, status: new_status });
      showToast('Status updated', 'success', 1500);
    } catch (err) {
      log('update-status failed: %o', err);
      showToast('Failed to update status', 'error');
    } finally {
      pending_moves.delete(issue_id);
      doRender();
    }
  }

  function doRender() {
    render(template(), mount_element);
    postRenderEnhance();
  }

  /**
   * Enhance rendered board with a11y and keyboard navigation.
   * - Roving tabindex per column (first card tabbable).
   * - ArrowUp/ArrowDown within column.
   * - ArrowLeft/ArrowRight to adjacent non-empty column (focus top card).
   * - Enter/Space to open details for focused card.
   */
  function postRenderEnhance() {
    try {
      /** @type {HTMLElement[]} */
      const columns = Array.from(
        mount_element.querySelectorAll('.board-column')
      );
      for (const col of columns) {
        const body = /** @type {HTMLElement|null} */ (
          col.querySelector('.board-column__body')
        );
        if (!body) {
          continue;
        }
        /** @type {HTMLElement[]} */
        const cards = Array.from(body.querySelectorAll('.board-card'));
        // Assign aria-label using column header for screen readers
        const header = /** @type {HTMLElement|null} */ (
          col.querySelector('.board-column__header')
        );
        const col_name = header ? header.textContent?.trim() || '' : '';
        for (const card of cards) {
          const title_el = /** @type {HTMLElement|null} */ (
            card.querySelector('.board-card__title')
          );
          const t = title_el ? title_el.textContent?.trim() || '' : '';
          card.setAttribute(
            'aria-label',
            `Issue ${t || '(no title)'} — Column ${col_name}`
          );
          // Default roving setup
          card.tabIndex = -1;
        }
        if (cards.length > 0) {
          cards[0].tabIndex = 0;
        }
      }
    } catch {
      // non-fatal
    }
  }

  // Delegate keyboard handling from mount_element
  mount_element.addEventListener('keydown', (ev) => {
    const target = ev.target;
    if (!target || !(target instanceof HTMLElement)) {
      return;
    }
    // Do not intercept keys inside editable controls
    const tag = String(target.tagName || '').toLowerCase();
    if (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      target.isContentEditable === true
    ) {
      return;
    }
    const card = target.closest('.board-card');
    if (!card) {
      return;
    }
    const key = String(ev.key || '');
    if (key === 'Enter' || key === ' ') {
      ev.preventDefault();
      const id = card.getAttribute('data-issue-id');
      if (id) {
        gotoIssue(id);
      }
      return;
    }
    if (
      key !== 'ArrowUp' &&
      key !== 'ArrowDown' &&
      key !== 'ArrowLeft' &&
      key !== 'ArrowRight'
    ) {
      return;
    }
    ev.preventDefault();
    // Column context
    const col = /** @type {HTMLElement|null} */ (card.closest('.board-column'));
    if (!col) {
      return;
    }
    const body = col.querySelector('.board-column__body');
    if (!body) {
      return;
    }
    /** @type {HTMLElement[]} */
    const cards = Array.from(body.querySelectorAll('.board-card'));
    const idx = cards.indexOf(/** @type {HTMLElement} */ (card));
    if (idx === -1) {
      return;
    }
    if (key === 'ArrowDown' && idx < cards.length - 1) {
      moveFocus(cards[idx], cards[idx + 1]);
      return;
    }
    if (key === 'ArrowUp' && idx > 0) {
      moveFocus(cards[idx], cards[idx - 1]);
      return;
    }
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      // Find adjacent column with at least one card
      /** @type {HTMLElement[]} */
      const cols = Array.from(mount_element.querySelectorAll('.board-column'));
      const col_idx = cols.indexOf(col);
      if (col_idx === -1) {
        return;
      }
      const dir = key === 'ArrowRight' ? 1 : -1;
      let next_idx = col_idx + dir;
      /** @type {HTMLElement|null} */
      let target_col = null;
      while (next_idx >= 0 && next_idx < cols.length) {
        const candidate = cols[next_idx];
        const c_body = /** @type {HTMLElement|null} */ (
          candidate.querySelector('.board-column__body')
        );
        const c_cards = c_body
          ? Array.from(c_body.querySelectorAll('.board-card'))
          : [];
        if (c_cards.length > 0) {
          target_col = candidate;
          break;
        }
        next_idx += dir;
      }
      if (target_col) {
        const first = /** @type {HTMLElement|null} */ (
          target_col.querySelector('.board-column__body .board-card')
        );
        if (first) {
          moveFocus(/** @type {HTMLElement} */ (card), first);
        }
      }
      return;
    }
  });

  // Track the currently highlighted column to avoid flicker
  /** @type {HTMLElement|null} */
  let current_drop_target = null;

  // Delegate drag and drop handling for columns
  mount_element.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = 'move';
    }
    // Find the column being dragged over
    const target = /** @type {HTMLElement} */ (ev.target);
    const col = /** @type {HTMLElement|null} */ (
      target.closest('.board-column')
    );

    // Only update if we've entered a different column
    if (col && col !== current_drop_target) {
      // Remove highlight from previous column
      if (current_drop_target) {
        current_drop_target.classList.remove('board-column--drag-over');
      }
      // Highlight the new column
      col.classList.add('board-column--drag-over');
      current_drop_target = col;
    }
  });

  mount_element.addEventListener('dragleave', (ev) => {
    const related = /** @type {HTMLElement|null} */ (ev.relatedTarget);
    // Only clear if we're leaving the mount element entirely
    if (!related || !mount_element.contains(related)) {
      if (current_drop_target) {
        current_drop_target.classList.remove('board-column--drag-over');
        current_drop_target = null;
      }
    }
  });

  mount_element.addEventListener('drop', (ev) => {
    ev.preventDefault();
    // Clear the drop target highlight
    if (current_drop_target) {
      current_drop_target.classList.remove('board-column--drag-over');
      current_drop_target = null;
    }

    const target = /** @type {HTMLElement} */ (ev.target);
    const col = target.closest('.board-column');
    if (!col) {
      return;
    }

    const col_id = col.id;
    const new_status = COLUMN_STATUS_MAP[col_id];
    if (!new_status) {
      log('drop on unknown column: %s', col_id);
      return;
    }

    const issue_id = ev.dataTransfer?.getData('text/plain');
    if (!issue_id) {
      log('drop without issue id');
      return;
    }

    log('drop %s on %s → %s', issue_id, col_id, new_status);
    void updateIssueStatus(issue_id, new_status);
  });

  /**
   * @param {HTMLElement} from
   * @param {HTMLElement} to
   */
  function moveFocus(from, to) {
    try {
      from.tabIndex = -1;
      to.tabIndex = 0;
      to.focus();
    } catch {
      // ignore focus errors
    }
  }

  // Sort helpers centralized in app/data/sort.js

  /**
   * Recompute closed list from raw using the current filter and sort.
   */
  function applyClosedFilter() {
    log('applyClosedFilter %s', closed_filter_mode);
    /** @type {IssueLite[]} */
    let items = Array.isArray(list_closed_raw) ? [...list_closed_raw] : [];
    const now = new Date();
    let since_ts = 0;
    if (closed_filter_mode === 'today') {
      const start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
        0
      );
      since_ts = start.getTime();
    } else if (closed_filter_mode === '3') {
      since_ts = now.getTime() - 3 * 24 * 60 * 60 * 1000;
    } else if (closed_filter_mode === '7') {
      since_ts = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    }
    items = items.filter((it) => {
      const s = Number.isFinite(it.closed_at)
        ? /** @type {number} */ (it.closed_at)
        : NaN;
      if (!Number.isFinite(s)) {
        return false;
      }
      return s >= since_ts;
    });
    items.sort(cmpClosedDesc);
    list_closed = items;
  }

  /**
   * @param {Event} ev
   */
  function onClosedFilterChange(ev) {
    try {
      const el = /** @type {HTMLSelectElement} */ (ev.target);
      const v = String(el.value || 'today');
      closed_filter_mode = v === '3' || v === '7' ? v : 'today';
      log('closed filter %s', closed_filter_mode);
      if (store) {
        try {
          store.setState({ board: { closed_filter: closed_filter_mode } });
        } catch {
          // ignore store errors
        }
      }
      applyClosedFilter();
      doRender();
    } catch {
      // ignore
    }
  }

  /**
   * @param {Event} ev
   */
  function onPersonFilterChange(ev) {
    const el = /** @type {HTMLSelectElement} */ (ev.target);
    person_filter = String(el.value || '');
    log('person filter %s', person_filter || '(everyone)');
    if (store) {
      try {
        store.setState({ board: { person: person_filter } });
      } catch {
        // ignore store errors
      }
    }
    doRender();
  }

  /**
   * @param {Event} ev
   */
  function onEpicFilterChange(ev) {
    const el = /** @type {HTMLSelectElement} */ (ev.target);
    epic_filter = String(el.value || '');
    log('epic filter %s', epic_filter || '(all)');
    if (store) {
      try {
        store.setState({ board: { epic: epic_filter } });
      } catch {
        // ignore store errors
      }
    }
    doRender();
  }

  function onClearFilters() {
    person_filter = '';
    epic_filter = '';
    if (store) {
      try {
        store.setState({ board: { person: '', epic: '' } });
      } catch {
        // ignore store errors
      }
    }
    doRender();
  }

  /**
   * In progress reads as "who is doing what right now": most recently
   * started first, with the column's priority sort as the tie-break for
   * items that never recorded a start.
   *
   * @param {IssueLite[]} items
   * @returns {IssueLite[]}
   */
  function sortInProgress(items) {
    return items.slice().sort((a, b) => {
      const delta = tsOf(b.started_at) - tsOf(a.started_at);
      if (delta !== 0) {
        return delta;
      }
      return cmpPriorityThenCreated(a, b);
    });
  }

  /**
   * Compose lists from subscriptions + issues store and render.
   */
  function refreshFromStores() {
    try {
      if (selectors) {
        const in_progress = selectors.selectBoardColumn(
          'tab:board:in-progress',
          'in_progress'
        );
        const blocked = selectors.selectBoardColumn(
          'tab:board:blocked',
          'blocked'
        );
        const ready_raw = selectors.selectBoardColumn(
          'tab:board:ready',
          'ready'
        );
        const closed = selectors.selectBoardColumn(
          'tab:board:closed',
          'closed'
        );

        // Ready excludes items that are in progress
        /** @type {Set<string>} */
        const in_prog_ids = new Set(in_progress.map((i) => i.id));
        const ready = ready_raw.filter((i) => !in_prog_ids.has(i.id));

        list_ready = ready;
        list_blocked = blocked;
        list_in_progress = sortInProgress(in_progress);
        list_closed_raw = closed;
      }
      applyClosedFilter();
      doRender();
    } catch {
      list_ready = [];
      list_blocked = [];
      list_in_progress = [];
      list_closed = [];
      doRender();
    }
  }

  // Live updates: recompose on issue store envelopes
  if (selectors) {
    selectors.subscribe(() => {
      try {
        refreshFromStores();
      } catch {
        // ignore
      }
    });
  }

  return {
    async load() {
      // Compose lists from subscriptions + issues store
      log('load');
      refreshFromStores();
      // If nothing is present yet (e.g., immediately after switching back
      // to the Board and before list-delta arrives), fetch via data layer as
      // a fallback so the board is not empty on initial display.
      try {
        const has_subs = Boolean(subscriptions && subscriptions.selectors);
        /**
         * @param {string} id
         */
        const cnt = (id) => {
          if (!has_subs || !subscriptions) {
            return 0;
          }
          const sel = subscriptions.selectors;
          if (typeof sel.count === 'function') {
            return Number(sel.count(id) || 0);
          }
          try {
            const arr = sel.getIds(id);
            return Array.isArray(arr) ? arr.length : 0;
          } catch {
            return 0;
          }
        };
        const total_items =
          cnt('tab:board:ready') +
          cnt('tab:board:blocked') +
          cnt('tab:board:in-progress') +
          cnt('tab:board:closed');
        const data = /** @type {any} */ (_data);
        const can_fetch =
          data &&
          typeof data.getReady === 'function' &&
          typeof data.getBlocked === 'function' &&
          typeof data.getInProgress === 'function' &&
          typeof data.getClosed === 'function';
        if (total_items === 0 && can_fetch) {
          log('fallback fetch');
          /** @type {[IssueLite[], IssueLite[], IssueLite[], IssueLite[]]} */
          const [ready_raw, blocked_raw, in_prog_raw, closed_raw] =
            await Promise.all([
              data.getReady().catch(() => []),
              data.getBlocked().catch(() => []),
              data.getInProgress().catch(() => []),
              data.getClosed().catch(() => [])
            ]);
          // Normalize and map unknowns to IssueLite shape
          /** @type {IssueLite[]} */
          let ready = Array.isArray(ready_raw) ? ready_raw.map((it) => it) : [];
          /** @type {IssueLite[]} */
          const blocked = Array.isArray(blocked_raw)
            ? blocked_raw.map((it) => it)
            : [];
          /** @type {IssueLite[]} */
          const in_prog = Array.isArray(in_prog_raw)
            ? in_prog_raw.map((it) => it)
            : [];
          /** @type {IssueLite[]} */
          const closed = Array.isArray(closed_raw)
            ? closed_raw.map((it) => it)
            : [];

          // Remove items from Ready that are already In Progress
          /** @type {Set<string>} */
          const in_progress_ids = new Set(in_prog.map((i) => i.id));
          ready = ready.filter((i) => !in_progress_ids.has(i.id));

          // Sort as per column rules
          ready.sort(cmpPriorityThenCreated);
          blocked.sort(cmpPriorityThenCreated);
          list_ready = ready;
          list_blocked = blocked;
          list_in_progress = sortInProgress(in_prog);
          list_closed_raw = closed;
          applyClosedFilter();
          doRender();
        }
      } catch {
        // ignore fallback errors
      }
    },
    clear() {
      mount_element.replaceChildren();
      list_ready = [];
      list_blocked = [];
      list_in_progress = [];
      list_closed = [];
    }
  };
}
