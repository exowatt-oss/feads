/**
 * @import { MessageType } from './protocol.js'
 */
import { html, render } from 'lit-html';
import { stalenessOf } from './build-info.js';
import { createListSelectors } from './data/list-selectors.js';
import { createDataLayer } from './data/providers.js';
import { createSubscriptionIssueStores } from './data/subscription-issue-stores.js';
import { createSubscriptionStore } from './data/subscriptions-store.js';
import { installPersonHover } from './people/hover-controller.js';
import { createHashRouter, parseHash, parseView } from './router.js';
import { createStore } from './state.js';
import { createActivityIndicator } from './utils/activity-indicator.js';
import { debug } from './utils/logging.js';
import { setOwnerDirectory } from './utils/owners.js';
import { setPeopleDirectory } from './utils/people.js';
import { showToast } from './utils/toast.js';
import {
  accountsActive,
  createAccessView,
  createDepartmentsView,
  createSpaceSelect,
  currentSpaceOf
} from './views/accounts-pages.js';
import {
  createAgentLoginPanel,
  createIdentityChip,
  isWriteAffordanceOffered
} from './views/agent-login.js';
import { createAgentsView } from './views/agents-admin.js';
import { createAgentwatchView } from './views/agentwatch.js';
import { createBoardView } from './views/board.js';
import { createDetailView } from './views/detail.js';
import { createEpicStoryView } from './views/epic-story.js';
import { createEpicsView } from './views/epics.js';
import { createFatalErrorDialog } from './views/fatal-error-dialog.js';
import { createIssueDialog } from './views/issue-dialog.js';
import { createListView } from './views/list.js';
import { createTopNav } from './views/nav.js';
import { createNewIssueDialog } from './views/new-issue-dialog.js';
import { createNotificationBell } from './views/notification-bell.js';
import { createStalenessBanner } from './views/staleness-banner.js';
import { createUsersView } from './views/users.js';
import { createWorkspacePicker } from './views/workspace-picker.js';
import { createWsClient } from './ws.js';

/**
 * Keep the optional silo SSO projection narrow at the browser boundary. The
 * base whoami response has no block, and no credential-shaped value belongs in
 * the page state even if a future server accidentally includes one.
 *
 * @param {unknown} value
 * @returns {import('./state.js').SsoIdentity | undefined}
 */
function projectSsoBlock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const key of [
    'email',
    'provenance',
    'provider',
    'status',
    'actor',
    'error_code',
    'action',
    'sign_out_url',
    'signout_url',
    'logout_url',
    'logout_target',
    'signout_target',
    'logout',
    'sign_out',
    'target'
  ]) {
    if (typeof source[key] === 'string') {
      result[key] = source[key];
    }
  }
  for (const key of [
    'available',
    'rejected',
    'linked',
    'pending',
    'terminal'
  ]) {
    if (typeof source[key] === 'boolean') {
      result[key] = source[key];
    }
  }
  return /** @type {import('./state.js').SsoIdentity} */ (result);
}

/**
 * Project the server's client-safe agent identity. A response may carry other
 * fields, but the browser only needs this established identity shape and must
 * never retain registry or credential metadata by accident.
 *
 * @param {unknown} value
 * @returns {import('./state.js').AgentIdentity | null}
 */
function projectAgentIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  const agent_id = typeof source.agent_id === 'string' ? source.agent_id : '';
  const actor = typeof source.actor === 'string' ? source.actor : '';
  const role = typeof source.role === 'string' ? source.role : '';
  if (!agent_id || !actor || !role) {
    return null;
  }
  return {
    agent_id,
    actor,
    display_name:
      typeof source.display_name === 'string' ? source.display_name : '',
    role,
    board_id: typeof source.board_id === 'string' ? source.board_id : '',
    last_seen_at:
      typeof source.last_seen_at === 'number' ? source.last_seen_at : 0
  };
}

/**
 * @param {unknown} value
 * @returns {import('./state.js').IdentityPermissions | undefined}
 */
function projectPermissions(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string');
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  /** @type {Record<string, boolean>} */
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'boolean') {
      result[key] = item;
    }
  }
  return result;
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function ssoErrorCode(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return '';
  }
  const source = /** @type {Record<string, unknown>} */ (body);
  const nested =
    source.error &&
    typeof source.error === 'object' &&
    !Array.isArray(source.error)
      ? /** @type {Record<string, unknown>} */ (source.error)
      : null;
  const candidate = nested?.code || source.code || source.error;
  if (typeof candidate !== 'string') {
    return '';
  }
  const code = candidate.trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,80}$/.test(code) ? code : '';
}

/**
 * @param {string} code
 * @returns {'clear_token'|'retry_sso'}
 */
function ssoFailureAction(code) {
  return [
    'token_rejected',
    'invalid_token',
    'stale_token',
    'credential_rejected'
  ].includes(code)
    ? 'clear_token'
    : 'retry_sso';
}

/**
 * @param {unknown} body
 * @returns {import('./state.js').SsoIdentity}
 */
function pendingSsoIdentity(body) {
  const source =
    body && typeof body === 'object' && !Array.isArray(body)
      ? /** @type {Record<string, unknown>} */ (body)
      : {};
  const identity =
    source.identity &&
    typeof source.identity === 'object' &&
    !Array.isArray(source.identity)
      ? /** @type {Record<string, unknown>} */ (source.identity)
      : {};
  const sso =
    source.sso && typeof source.sso === 'object' && !Array.isArray(source.sso)
      ? { .../** @type {Record<string, unknown>} */ (source.sso) }
      : {};
  for (const key of ['email', 'provenance', 'provider']) {
    if (sso[key] === undefined && typeof identity[key] === 'string') {
      sso[key] = identity[key];
    }
    if (sso[key] === undefined && typeof source[key] === 'string') {
      sso[key] = source[key];
    }
  }
  if (typeof sso.provenance !== 'string' || !sso.provenance) {
    sso.provenance = 'sso';
  }
  sso.status = 'pending';
  sso.pending = true;
  const projected = projectSsoBlock(sso);
  return projected || { provenance: 'sso', status: 'pending', pending: true };
}

/**
 * The persistent WebSocket status pill (feads).
 *
 * Hidden while the socket is open. While it is connecting for the first time
 * it appears only after a short grace period (a fast connect should not
 * flash), and while it is reconnecting it says so and since when, and marks
 * `<body data-ws="stale">` so the lists can visibly dim: what is on screen is
 * a snapshot from before the drop, not live data.
 *
 * @param {Element | null} host - Where to mount (the page body; the pill is
 * fixed-positioned, so its host only decides DOM order).
 * @returns {{ set: (state: string) => void }}
 */
export function createConnectionStatus(host) {
  const el = document.createElement('div');
  el.id = 'conn-status';
  el.className = 'conn-status';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = true;
  const dot = document.createElement('span');
  dot.className = 'conn-status__dot';
  dot.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'conn-status__text';
  el.append(dot, text);
  if (host) {
    host.insertBefore(el, host.firstChild);
  }
  /** @type {ReturnType<typeof setTimeout> | null} */
  let grace = null;
  let stale_since = 0;
  /**
   * @param {string} state
   */
  function set(state) {
    if (grace) {
      clearTimeout(grace);
      grace = null;
    }
    if (state === 'open' || state === 'auth_denied') {
      stale_since = 0;
      el.hidden = true;
      el.dataset.state = state;
      document.body.removeAttribute('data-ws');
      return;
    }
    if (state === 'connecting' && stale_since === 0) {
      el.dataset.state = 'connecting';
      text.textContent = 'Connecting…';
      grace = setTimeout(() => {
        el.hidden = false;
      }, 600);
      return;
    }
    if (stale_since === 0) {
      stale_since = Date.now();
    }
    const at = new Date(stale_since).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    el.dataset.state = 'reconnecting';
    // Short on screen (the header has no room to spare); the full sentence is
    // the tooltip and what a screen reader announces.
    text.textContent = 'Reconnecting…';
    const detail = `Live connection lost — showing data from ${at}. Changes will appear once it is back.`;
    el.title = detail;
    el.setAttribute('aria-label', detail);
    el.hidden = false;
    document.body.setAttribute('data-ws', 'stale');
  }
  return { set };
}

/**
 * The Board tab's Done-column subscription (feads).
 *
 * The column filters to today / 3 days / 7 days client-side, so the server is
 * asked for closures since local midnight eight days ago — the widest window
 * plus slack — instead of the newest thousand. Snapped to midnight so every
 * tab opened the same day shares one subscription key (and one server-side
 * refresh), and so a long-lived tab's window only ever widens.
 *
 * @param {number} [now]
 * @returns {{ type: 'closed-issues', params: { since: number } }}
 */
export function boardClosedSpec(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 8);
  return { type: 'closed-issues', params: { since: d.getTime() } };
}

/**
 * Run the browser SSO preflight. A 404 is the explicit base-instance answer;
 * every other HTTP answer belongs to the SSO decision and is terminal. This is
 * intentionally an endpoint result, never a hostname classification.
 *
 * @param {typeof fetch} [fetch_impl]
 * @returns {Promise<{ kind: 'base' } | { kind: 'sso', agent: import('./state.js').AgentIdentity | null, sso: import('./state.js').SsoIdentity } | { kind: 'denied', code: string, sso: import('./state.js').SsoIdentity }>}
 */
export async function runSsoPreflight(fetch_impl) {
  const doFetch = fetch_impl || ((...args) => window.fetch(...args));
  let response;
  try {
    response = await doFetch('/api/agent/sso/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: '{}'
    });
  } catch {
    return {
      kind: 'denied',
      code: 'preflight_unavailable',
      sso: {
        provenance: 'sso',
        status: 'denied',
        error_code: 'preflight_unavailable',
        action: 'retry_sso',
        terminal: true
      }
    };
  }

  if (Number(response?.status) === 404) {
    return { kind: 'base' };
  }

  const body =
    typeof response?.json === 'function'
      ? await response.json().catch(() => null)
      : null;
  if (response?.ok && body?.ok === true) {
    return {
      kind: 'sso',
      agent: projectAgentIdentity(body.identity),
      sso: pendingSsoIdentity(body)
    };
  }

  const code = ssoErrorCode(body) || `http_${Number(response?.status) || 0}`;
  return {
    kind: 'denied',
    code,
    sso: {
      provenance: 'sso',
      status: 'denied',
      error_code: code,
      action: ssoFailureAction(code),
      terminal: true
    }
  };
}

/** One set of person-hover listeners per page, however often bootstrap runs. */
let PERSON_HOVER_INSTALLED = false;

/**
 * Bootstrap the SPA shell with two panels.
 *
 * @param {HTMLElement} root_element - The container element to render into.
 * @param {Object} [options]
 * @param {() => void} [options.reload] - feads: how to reload the page once the daemon
 * has been replaced. A seam because jsdom cannot navigate, and because the assertion
 * worth making about a restart is "it reloaded exactly once, and only after the daemon
 * actually changed" — which is unobservable if the reload is a bare `location.reload()`.
 * @param {typeof fetch} [options.fetch] - Test seam for the SSO preflight.
 */
export function bootstrap(root_element, options = {}) {
  const log = debug('main');
  log('bootstrap start');
  // feads: the person hover card on @mentions and owner names. Listeners only;
  // React and @example/ux load on the first hover (people/hover-controller.js).
  if (!PERSON_HOVER_INSTALLED && typeof document !== 'undefined') {
    PERSON_HOVER_INSTALLED = true;
    installPersonHover();
  }
  const doReload = options.reload || (() => window.location.reload());

  // Render route shells (nav is mounted in header)
  const shell = html`
    <!-- feads: "this page or this server is out of date". Above everything, because
         when it is showing, nothing below it can be trusted to be current. -->
    <div id="staleness-root"></div>
    <!-- feads: the sign-in panel. Above the routes rather than a modal over them,
         because an unidentified visitor is read-only rather than refused and the
         board behind it must stay readable. -->
    <div id="agent-login-root"></div>
    <section id="issues-root" class="route issues">
      <aside id="list-panel" class="panel"></aside>
    </section>
    <section id="epics-root" class="route epics" hidden></section>
    <section id="board-root" class="route board" hidden></section>
    <section id="agentwatch-root" class="route agentwatch" hidden></section>
    <section id="story-root" class="route story" hidden></section>
    <section id="users-root" class="route users" hidden></section>
    <section id="agents-root" class="route agents" hidden></section>
    <section id="access-root" class="route access" hidden></section>
    <section id="departments-root" class="route departments" hidden></section>
    <section id="detail-panel" class="route detail" hidden></section>
  `;
  render(shell, root_element);

  /** @type {HTMLElement|null} */
  const nav_mount = document.getElementById('top-nav');
  /** @type {HTMLElement|null} */
  const issues_root = document.getElementById('issues-root');
  /** @type {HTMLElement|null} */
  const epics_root = document.getElementById('epics-root');
  /** @type {HTMLElement|null} */
  const board_root = document.getElementById('board-root');
  /** @type {HTMLElement|null} */
  const agentwatch_root = document.getElementById('agentwatch-root');
  // feads: agent roster. Not in the `if` below with the others — a build without
  // it must not cost the dashboard its issues list.
  /** @type {HTMLElement|null} */
  const agents_root = document.getElementById('agents-root');
  // feads accounts mode: Access and Departments. Same-origin HTTP, like silos.
  /** @type {HTMLElement|null} */
  const access_root = document.getElementById('access-root');
  /** @type {HTMLElement|null} */
  const departments_root = document.getElementById('departments-root');
  // feads: the actor directory. Outside the `if` below with the roster, and for
  // the same reason: a build without it must not cost the dashboard its issues
  // list.
  /** @type {HTMLElement|null} */
  const users_root = document.getElementById('users-root');
  // feads: the epic story view. Outside the `if` below for the same reason as
  // the roster: a build without it must not cost the dashboard its issues list.
  /** @type {HTMLElement|null} */
  const story_root = document.getElementById('story-root');
  // feads: the sign-in panel and the header chip that says who we are acting as.
  // Outside the `if` below with the roster, for the same reason: a build without
  // them must not cost the dashboard its issues list.
  /** @type {HTMLElement|null} */
  const agent_login_root = document.getElementById('agent-login-root');
  // feads: the staleness banner. Outside the `if` below for the same reason as the
  // other two — and with more force, since the state it reports is precisely the one
  // where other parts of the page may be failing to mount.
  /** @type {HTMLElement|null} */
  const staleness_root = document.getElementById('staleness-root');

  /** @type {HTMLElement|null} */
  const list_mount = document.getElementById('list-panel');
  /** @type {HTMLElement|null} */
  const detail_mount = document.getElementById('detail-panel');
  if (list_mount && issues_root && epics_root && board_root && detail_mount) {
    /** @type {HTMLElement|null} */
    const header_loading = document.getElementById('header-loading');
    const activity = createActivityIndicator(header_loading);
    const fatal_dialog = createFatalErrorDialog(root_element);

    /**
     * Show a blocking dialog when a backend command fails.
     *
     * @param {unknown} err
     * @param {string} context
     */
    function showFatalFromError(err, context) {
      /** @type {string} */
      let message = 'Request failed';
      /** @type {string} */
      let detail = '';

      if (err && typeof err === 'object') {
        const any = /** @type {{ message?: unknown, details?: unknown }} */ (
          err
        );
        if (typeof any.message === 'string' && any.message.length > 0) {
          message = any.message;
        }
        if (typeof any.details === 'string') {
          detail = any.details;
        } else if (any.details && typeof any.details === 'object') {
          try {
            detail = JSON.stringify(any.details, null, 2);
          } catch {
            detail = '';
          }
        }
      } else if (typeof err === 'string' && err.length > 0) {
        message = err;
      }

      // A deny-stance refusal for an unidentified visitor is not a fault: the
      // sign-in panel (rendered blocking under FEADS_REQUIRE_AGENT) already
      // explains the state, and a CRITICAL dialog on top of the login card
      // turns an expected first visit into an error screen (observed on the
      // hosted instance). Matched on the policy's stable refusal phrase rather
      // than only on store state, because the subscribe refusal can land
      // before `whoami` resolves the identity.
      if (message.includes('requires an agent identity')) {
        log(
          'suppressed deny-stance load error (%s): sign-in panel owns this state',
          context
        );
        return;
      }
      try {
        const identity = store.getState().identity;
        if (
          identity?.loaded &&
          identity.require_identity === true &&
          identity.mode !== 'agent' &&
          identity.mode !== 'operator'
        ) {
          log('suppressed load error while sign-in is required: %s', context);
          return;
        }
      } catch {
        // store not created yet — fall through to the dialog
      }

      const title =
        context && context.length > 0
          ? `Failed to load ${context}`
          : 'Request failed';

      fatal_dialog.open(title, message, detail);
    }

    // The shell must complete the same-origin SSO bootstrap before the first
    // WebSocket handshake. `autoConnect: false` is a no-op for base callers of
    // createWsClient itself; only this shell uses the delayed start contract.
    const client = createWsClient({ autoConnect: false });
    const tracked_send = activity.wrapSend((type, payload) =>
      client.send(type, payload)
    );
    // Subscriptions: wire client events and expose subscribe/unsubscribe helpers
    const subscriptions = createSubscriptionStore(tracked_send);
    // Per-subscription stores (source of truth)
    const sub_issue_stores = createSubscriptionIssueStores();
    // Route per-subscription push envelopes to the owning store
    client.on('snapshot', (payload) => {
      const p = /** @type {any} */ (payload);
      const id = p && typeof p.id === 'string' ? p.id : '';
      const store = id ? sub_issue_stores.getStore(id) : null;
      if (store && p && p.type === 'snapshot') {
        try {
          store.applyPush(p);
        } catch {
          // ignore
        }
      }
    });
    client.on('upsert', (payload) => {
      const p = /** @type {any} */ (payload);
      const id = p && typeof p.id === 'string' ? p.id : '';
      const store = id ? sub_issue_stores.getStore(id) : null;
      if (store && p && p.type === 'upsert') {
        try {
          store.applyPush(p);
        } catch {
          // ignore
        }
      }
    });
    client.on('delete', (payload) => {
      const p = /** @type {any} */ (payload);
      const id = p && typeof p.id === 'string' ? p.id : '';
      const store = id ? sub_issue_stores.getStore(id) : null;
      if (store && p && p.type === 'delete') {
        try {
          store.applyPush(p);
        } catch {
          // ignore
        }
      }
    });
    // Derived list selectors: render from per-subscription snapshots
    const listSelectors = createListSelectors(sub_issue_stores);

    // --- Workspace management ---
    /**
     * Resolves once no list subscription is in flight (bounded). Assigned where
     * the pending set is created, below.
     *
     * @type {() => Promise<void>}
     */
    let settlePendingSubscriptions = async () => {};
    /** @type {() => boolean} */
    let hasPendingSubscriptions = () => false;
    /**
     * Clear all subscriptions and stores, then re-establish them.
     * Called when switching workspaces.
     */
    async function clearAndResubscribe() {
      log('clearing all subscriptions for workspace switch');
      // Unsubscribe from server-side subscriptions first
      if (unsub_issues_tab) {
        void unsub_issues_tab().catch(() => {});
        unsub_issues_tab = null;
      }
      if (unsub_epics_tab) {
        void unsub_epics_tab().catch(() => {});
        unsub_epics_tab = null;
      }
      if (unsub_board_ready) {
        void unsub_board_ready().catch(() => {});
        unsub_board_ready = null;
      }
      if (unsub_board_in_progress) {
        void unsub_board_in_progress().catch(() => {});
        unsub_board_in_progress = null;
      }
      if (unsub_board_closed) {
        void unsub_board_closed().catch(() => {});
        unsub_board_closed = null;
      }
      if (unsub_board_blocked) {
        void unsub_board_blocked().catch(() => {});
        unsub_board_blocked = null;
      }
      // feads: the board's flare presence too — its store is cleared below,
      // and without dropping the subscription ensureTabSubscriptions would
      // never re-register it, leaving the new board without flares.
      if (unsub_board_flares) {
        void unsub_board_flares().catch(() => {});
        unsub_board_flares = null;
      }
      // Clear all subscription stores
      const storeIds = [
        'tab:issues',
        'tab:epics',
        'tab:board:ready',
        'tab:board:in-progress',
        'tab:board:closed',
        'tab:board:blocked',
        'flares:board'
      ];
      for (const id of storeIds) {
        try {
          sub_issue_stores.unregister(id);
        } catch {
          // ignore
        }
      }
      // Also clear any detail stores
      const s = store.getState();
      if (s.selected_id) {
        try {
          sub_issue_stores.unregister(`detail:${s.selected_id}`);
        } catch {
          // ignore
        }
      }
      // Force re-subscribe by resetting last spec key
      last_issues_spec_key = null;
      // Re-establish subscriptions for current view
      ensureTabSubscriptions(store.getState());
      // And the open detail modal, which lives on its own subscription and
      // used to be silently dropped here (its store was unregistered above
      // and nothing re-subscribed it — a board switch or reconnect with the
      // modal open left it permanently dead).
      resubscribeDetail();
      // Agentwatch owns a server-side push watcher rather than one of the issue
      // list subscriptions above. A reconnect or board switch gives it a new
      // session, so reset and reload it while the route is active. Unloading
      // first keeps a view implementation that deduplicates `load()` calls from
      // accidentally retaining the dead session's watcher.
      if (agentwatch_view && store.getState().view === 'agentwatch') {
        await agentwatch_view.unload();
        if (store.getState().view === 'agentwatch') {
          await agentwatch_view.load();
        }
      }
    }

    /**
     * Re-subscribe the open detail modal, if any. Assigned its real
     * implementation once the detail view exists; a hook so that
     * `clearAndResubscribe` (defined first) can call it.
     *
     * @type {() => void}
     */
    let resubscribeDetail = () => {};

    /** @type {ReturnType<typeof createAgentwatchView> | null} */
    let agentwatch_view = null;

    /**
     * Resolves when the startup board restore has settled — that is, when
     * `loadWorkspaces()` has finished, including any `set-board` it issued to
     * restore the saved preference. The deep-link detail subscription waits on
     * this: firing it earlier asks the SEED board for an issue that may live
     * on the board about to be selected, which the server now answers with
     * `not_found` (and used to answer with an empty snapshot — the eternal
     * "Loading…" modal).
     *
     * @type {() => void}
     */
    let resolve_board_restored = () => {};
    /** @type {Promise<void>} */
    const board_restored = new Promise((resolve) => {
      resolve_board_restored = () => resolve();
    });

    // feads: set while our own board switch is in flight. The server broadcasts
    // workspace-changed to every client including this one, and the reply path
    // below already clears and re-subscribes — without this the initiator would
    // do the whole teardown twice.
    let board_switch_in_flight = false;

    /**
     * Normalize the server's current-board payload for the store (feads).
     *
     * @param {any} workspace
     * @returns {import('./state.js').WorkspaceInfo}
     */
    function toWorkspaceInfo(workspace) {
      return {
        path: workspace.root_dir,
        database: workspace.db_path,
        key: workspace.key,
        id: workspace.board_id,
        name: workspace.name,
        description: workspace.description,
        repos: workspace.repos,
        board_dir: workspace.board_dir,
        space_id: workspace.space_id || ''
      };
    }

    /**
     * Move the dashboard to a space (feads accounts mode): its only board, or its
     * All-boards view.
     *
     * @param {string} space_id
     */
    async function handleSpaceChange(space_id) {
      const s = store.getState();
      const current = s.workspace?.current || null;
      if (current && currentSpaceOf(s) === space_id) {
        return;
      }
      const boards = (s.workspace?.available || []).filter(
        (/** @type {import('./state.js').WorkspaceInfo} */ ws) =>
          ws.space_id === space_id && ws.id && ws.id !== '*'
      );
      if (boards.length === 1) {
        await handleWorkspaceChange(boards[0].key || boards[0].path);
        return;
      }
      board_switch_in_flight = true;
      try {
        const result = await client.send('set-board', { id: '*', space_id });
        if (result && result.workspace) {
          store.setState({
            workspace: { current: toWorkspaceInfo(result.workspace) }
          });
          if (result.changed) {
            await clearAndResubscribe();
          }
        }
      } catch (err) {
        log('space switch failed: %o', err);
        showToast('Failed to switch space', 'error', 3000);
      } finally {
        board_switch_in_flight = false;
      }
    }

    /**
     * Handle board change request from the picker.
     *
     * feads: the picker hands back a board key, not a path — a registry board is
     * identified by its id or its `.beads` directory, which a project root
     * cannot express. Entries with neither (a plain bd-daemon workspace) still
     * go through set-workspace.
     *
     * @param {string} board_key
     */
    async function handleWorkspaceChange(board_key) {
      const s = store.getState();
      const entry =
        (s.workspace?.available || []).find(
          (/** @type {import('./state.js').WorkspaceInfo} */ ws) =>
            (ws.key || ws.path) === board_key
        ) || null;
      const label = entry?.name || getProjectName(entry?.path || board_key);
      log('requesting board switch to %s', board_key);
      board_switch_in_flight = true;
      try {
        /** @type {'set-board'|'set-workspace'} */
        let type = 'set-board';
        /** @type {Record<string, string>} */
        let payload;
        if (entry?.id === '*' && s.workspace?.space) {
          payload = { id: '*', space_id: s.workspace.space };
        } else if (entry?.id) {
          payload = { id: entry.id };
        } else if (entry?.board_dir) {
          payload = { board_dir: entry.board_dir };
        } else {
          type = 'set-workspace';
          payload = { path: entry?.path || board_key };
        }
        const result = await client.send(type, payload);
        log('board switch result: %o', result);
        if (result && result.workspace) {
          store.setState({
            workspace: { current: toWorkspaceInfo(result.workspace) }
          });
          // Persist preference
          window.localStorage.setItem('beads-ui.board', board_key);
          // Clear and resubscribe if the board actually changed
          if (result.changed) {
            await clearAndResubscribe();
            // feads: the new board's lists are loading — say so now rather
            // than keep showing the old board's rows until snapshots land.
            sub_issue_stores.touch();
            showToast('Switched to ' + label, 'success', 2000);
          }
        }
      } catch (err) {
        log('board switch failed: %o', err);
        showToast('Failed to switch board', 'error', 3000);
        throw err;
      } finally {
        board_switch_in_flight = false;
      }
    }

    /**
     * Re-establish this connection's server-side session after a reconnect
     * (feads). A reconnected socket is a NEW session to the server: it starts
     * on the seed board and holds no subscriptions — the old ones were swept
     * with the dead socket. Without this, the page silently went stale after
     * any network blip (laptop sleep, edge timeout): lists stopped updating
     * and opening an issue asked the wrong board, which hung the modal.
     */
    async function restoreSession() {
      const current = store.getState().workspace?.current || null;
      try {
        if (current && (current.id || current.board_dir || current.path)) {
          board_switch_in_flight = true;
          try {
            if (current.id) {
              await client.send('set-board', { id: current.id });
            } else if (current.board_dir) {
              await client.send('set-board', { board_dir: current.board_dir });
            } else {
              await client.send('set-workspace', { path: current.path });
            }
            log(
              'session restore: board re-asserted (%s)',
              current.id || current.board_dir || current.path
            );
          } finally {
            board_switch_in_flight = false;
          }
        }
      } catch (err) {
        log('session restore: board re-assert failed: %o', err);
      }
      await clearAndResubscribe();
    }

    /**
     * Extract project name from path.
     *
     * @param {string} path
     * @returns {string}
     */
    function getProjectName(path) {
      if (!path) return 'Unknown';
      const parts = path.split('/').filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : 'Unknown';
    }

    /**
     * Load available workspaces from server and update state.
     */
    async function loadWorkspaces() {
      try {
        const result = await client.send('list-workspaces', {});
        log('workspaces loaded: %o', result);
        if (result && Array.isArray(result.workspaces)) {
          const available = result.workspaces.map((/** @type {any} */ ws) => ({
            path: ws.path,
            database: ws.database,
            pid: ws.pid,
            version: ws.version,
            // feads: board registry metadata
            key: ws.key || ws.path,
            id: ws.id || '',
            name: ws.name || '',
            description: ws.description || '',
            repos: Array.isArray(ws.repos) ? ws.repos : [],
            board_dir: ws.board_dir || '',
            exists: ws.exists !== false,
            space_id: ws.space_id || ''
          }));
          const current = result.current
            ? toWorkspaceInfo(result.current)
            : null;
          store.setState({ workspace: { current, available } });

          // Check if we have a saved preference that differs from current
          const saved_board = window.localStorage.getItem('beads-ui.board');
          const current_key = current?.key || current?.path;
          if (saved_board && current && saved_board !== current_key) {
            // Only restore a board the server is still offering
            const saved_exists = available.some(
              (/** @type {import('./state.js').WorkspaceInfo} */ ws) =>
                (ws.key || ws.path) === saved_board && ws.exists !== false
            );
            if (saved_exists) {
              log('restoring saved board preference: %s', saved_board);
              await handleWorkspaceChange(saved_board);
            }
          }
        }
      } catch (err) {
        log('failed to load workspaces: %o', err);
      }
    }

    /**
     * Ask the server who this dashboard is acting as (feads).
     *
     * Failure is not fatal and deliberately does not mark identity `loaded`: an
     * unanswered `whoami` leaves the Agents tab hidden, which is the same place
     * the UI starts. Claiming operator mode on a transport error would offer a
     * page that the next request refuses.
     */
    async function loadIdentity() {
      try {
        const result = await client.send('whoami', {});
        if (!result) {
          return;
        }
        /** @type {'agent'|'operator'|'anonymous'|'rejected'} */
        const mode =
          result.mode === 'agent' ||
          result.mode === 'rejected' ||
          result.mode === 'anonymous'
            ? result.mode
            : 'operator';
        // The server's own word for the stance rather than a re-derivation, so the
        // panel and the enforcement cannot disagree about whether reading is allowed.
        /** @type {'operator'|'read_only'|'deny'} */
        const stance =
          result.stance === 'read_only' || result.stance === 'deny'
            ? result.stance
            : 'operator';
        const raw_sso = Object.hasOwn(result, 'sso')
          ? result.sso
          : result.identity?.sso;
        const has_sso_block =
          raw_sso !== null &&
          raw_sso !== undefined &&
          typeof raw_sso === 'object' &&
          !Array.isArray(raw_sso);
        const has_permissions =
          Object.hasOwn(result, 'permissions') ||
          (result.identity && Object.hasOwn(result.identity, 'permissions'));
        const identity_patch = {
          loaded: true,
          // Keep the established whoami projection untouched for the base
          // instance; only the preflight's pending SSO data is narrowed here.
          agent: result.identity || null,
          mode,
          stance,
          require_identity: result.require_identity === true,
          sso: has_sso_block ? projectSsoBlock(raw_sso) : null,
          // Accounts mode: who this session acts as, their spaces and role. The
          // Access/Departments tabs and the Space selector key off its presence.
          accounts:
            result.accounts && typeof result.accounts === 'object'
              ? result.accounts
              : null,
          permissions: has_permissions
            ? projectPermissions(
                Object.hasOwn(result, 'permissions')
                  ? result.permissions
                  : result.identity?.permissions
              )
            : null
        };
        store.setState({ identity: identity_patch });
        log('identity: %s (%s)', result.identity?.actor || `(${mode})`, mode);
        if (mode === 'rejected') {
          // Unmissable on purpose. Reads stay open under the browser's read-only
          // stance, so a rejected caller still sees the board and would otherwise
          // notice nothing until a write failed — and the most likely cause is that
          // this agent was revoked, which it should learn immediately rather than on
          // its next destructive click.
          showToast(
            has_sso_block
              ? 'Hosted SSO could not authenticate this browser — access is denied'
              : 'Your agent credential was rejected — it may have been revoked',
            'error',
            8000
          );
        }
      } catch (err) {
        log('whoami failed: %o', err);
      }
    }

    // Handle workspace-changed events from server (e.g., if another client changes workspace)
    client.on('workspace-changed', (payload) => {
      log('workspace-changed event: %o', payload);
      if (board_switch_in_flight) {
        // Our own switch; handleWorkspaceChange owns the teardown.
        return;
      }
      if (payload && payload.root_dir) {
        store.setState({
          workspace: { current: toWorkspaceInfo(payload) }
        });
        // Reload workspaces to get fresh list
        void loadWorkspaces();
        // Clear and resubscribe. A server-initiated switch can land while the
        // page's list subscriptions are still in flight — accounts mode re-homes
        // a socket off a board its user cannot read while answering the page's
        // very first subscribe — so let those settle first (bounded):
        // ensureTabSubscriptions skips keys still pending, and they would
        // otherwise resolve onto stores the teardown had just unregistered,
        // leaving the view on its loading state forever.
        void (async () => {
          if (hasPendingSubscriptions()) {
            await settlePendingSubscriptions();
          }
          await clearAndResubscribe();
        })();
      }
    });

    // --- End workspace management (mounting happens after store is created) ---

    // feads: which build the daemon is running, and which kind of stale this page is.
    //
    // Server-initiated, and it has to be: the code that would ask "am I out of date?"
    // is the code that is out of date. The server sends this on connect and again
    // whenever the build changes, so a browser that loaded a stale bundle against a
    // stale process hears about both without having asked.
    //
    // The client-stale half is computed *here* rather than on the server, because only
    // this page knows which bundle it actually loaded — it reads that from the `?v=` on
    // its own script URL. See `build-info.js`.
    //
    // Surviving a restart falls out of the same event, and deliberately not from
    // "did I click the restart button": `build_id` is the *boot* identity of the
    // process, so it cannot change while a process lives, and a different one
    // arriving over a reconnected socket means a different daemon is answering. That
    // covers the button, a `feads-run.sh restart` typed in a terminal, and a crash
    // that systemd restarted, with one rule instead of three. Sitting on the new
    // socket showing the old page would be the same failure in a new costume — every
    // store, subscription and byte of the bundle belongs to the process that died —
    // so the page reloads, which re-fetches a `no-store` `index.html` and therefore a
    // script URL stamped with the new build.
    /** The `build_id` this page has been talking to. */
    let seen_build_id = '';
    client.on('build-info', (payload) => {
      const report = /** @type {any} */ (payload) || {};
      const build_id = String(report.build_id || '');
      if (
        seen_build_id.length > 0 &&
        build_id.length > 0 &&
        build_id !== seen_build_id
      ) {
        log('daemon replaced (%s → %s) → reloading', seen_build_id, build_id);
        showToast('Server restarted — reloading', 'success', 1500);
        doReload();
        return;
      }
      if (build_id.length > 0) {
        seen_build_id = build_id;
      }
      const stale = stalenessOf(report);
      log(
        'build-info: bundle %s, client_stale=%s, server_stale=%s',
        report.bundle_id,
        stale.client_stale,
        stale.server_stale
      );
      store.setState({
        build: {
          loaded: true,
          build_id,
          bundle_id: String(report.bundle_id || ''),
          client_stale: stale.client_stale,
          server_stale: stale.server_stale,
          restart_command: String(report.restart_command || ''),
          restart_offered: report.restart_offered === true,
          restart_allowed: report.restart_allowed === true,
          restart_reason: String(report.restart_reason || '')
        }
      });
    });

    // Show toasts for WebSocket connectivity changes
    /** @type {boolean} */
    let had_disconnect = false;
    // feads: a persistent connection indicator. The toast says the
    // connection dropped once; this keeps saying the page is showing data as
    // of the drop until it is live again. Fixed to the viewport corner rather
    // than placed in the header, which has no width to spare.
    const connection_status = createConnectionStatus(document.body);
    if (typeof client.onConnection === 'function') {
      /** @type {(s: 'connecting'|'open'|'closed'|'reconnecting'|'auth_denied') => void} */
      const onConn = (s) => {
        log('ws state %s', s);
        connection_status.set(s);
        if (s === 'auth_denied') {
          // SSO policy failures are rendered by the identity panel, not as a
          // transient network toast. The client has already stopped reconnecting.
          return;
        }
        if (s === 'reconnecting' || s === 'closed') {
          had_disconnect = true;
          showToast('Connection lost. Reconnecting…', 'error', 4000);
        } else if (s === 'open' && had_disconnect) {
          had_disconnect = false;
          showToast('Reconnected', 'success', 2200);
          // The new socket is a blank session server-side: re-assert the
          // board and re-subscribe everything, or the page is a still image.
          void restoreSession();
        }
      };
      client.onConnection(onConn);
    }
    // Load persisted filters (status/search/type) from localStorage
    /** @type {{ status: 'all'|'open'|'in_progress'|'closed'|'ready', search: string, type: string }} */
    let persisted_filters = { status: 'all', search: '', type: '' };
    try {
      const raw = window.localStorage.getItem('beads-ui.filters');
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          const ALLOWED = ['bug', 'feature', 'task', 'epic', 'chore'];
          let parsed_type = '';
          if (typeof obj.type === 'string' && ALLOWED.includes(obj.type)) {
            parsed_type = obj.type;
          } else if (Array.isArray(obj.types)) {
            // Backwards compatibility: pick first valid from previous array format
            let first_valid = '';
            for (const it of obj.types) {
              if (ALLOWED.includes(String(it))) {
                first_valid = /** @type {string} */ (it);
                break;
              }
            }
            parsed_type = first_valid;
          }
          persisted_filters = {
            status: ['all', 'open', 'in_progress', 'closed', 'ready'].includes(
              obj.status
            )
              ? obj.status
              : 'all',
            search: typeof obj.search === 'string' ? obj.search : '',
            type: parsed_type
          };
        }
      }
    } catch (err) {
      log('filters parse error: %o', err);
    }
    // Load last-view from storage
    /** @type {'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'access'|'departments'} */
    let last_view = 'issues';
    try {
      const raw_view = window.localStorage.getItem('beads-ui.view');
      if (
        raw_view === 'issues' ||
        raw_view === 'epics' ||
        raw_view === 'board' ||
        raw_view === 'agentwatch' ||
        raw_view === 'users' ||
        raw_view === 'agents' ||
        raw_view === 'admin' ||
        raw_view === 'access' ||
        raw_view === 'departments'
      ) {
        last_view = raw_view;
      }
    } catch (err) {
      log('view parse error: %o', err);
    }
    // Load board preferences.
    //
    // feads: these live under their own key. `beads-ui.board` belongs to the
    // workspace picker (a plain board key string) and an earlier build wrote a
    // JSON prefs blob into the same slot, so each overwrote the other. A JSON
    // value found there is migrated once and the slot is left to the picker.
    /** @type {{ closed_filter: 'today'|'3'|'7', person: string, epic: string }} */
    let persistedBoard = { closed_filter: 'today', person: '', epic: '' };
    try {
      let raw_board = window.localStorage.getItem('beads-ui.board-prefs');
      if (!raw_board) {
        const legacy = window.localStorage.getItem('beads-ui.board');
        if (legacy && legacy.trim().startsWith('{')) {
          raw_board = legacy;
          window.localStorage.setItem('beads-ui.board-prefs', legacy);
          window.localStorage.removeItem('beads-ui.board');
        }
      }
      if (raw_board) {
        const obj = JSON.parse(raw_board);
        if (obj && typeof obj === 'object') {
          const cf = String(obj.closed_filter || 'today');
          if (cf === 'today' || cf === '3' || cf === '7') {
            persistedBoard.closed_filter = cf;
          }
          if (typeof obj.person === 'string') {
            persistedBoard.person = obj.person;
          }
          if (typeof obj.epic === 'string') {
            persistedBoard.epic = obj.epic;
          }
        }
      }
    } catch (err) {
      log('board prefs parse error: %o', err);
    }

    const store = createStore({
      filters: persisted_filters,
      view: last_view,
      board: persistedBoard
    });
    const router = createHashRouter(store);
    router.start();

    /**
     * Enter a terminal SSO identity state. The pending identity is retained only
     * as the safe actor/email provenance needed to explain the failure; no token
     * or provider response is copied into page state.
     *
     * @param {string} code
     */
    function enterSsoDenied(code) {
      const previous = store.getState().identity.sso;
      store.setState({
        identity: {
          loaded: true,
          agent: null,
          mode: 'rejected',
          stance: 'deny',
          require_identity: true,
          sso: {
            ...(previous || {}),
            provenance: previous?.provenance || 'sso',
            status: 'denied',
            pending: false,
            terminal: true,
            error_code: code,
            action: ssoFailureAction(code)
          }
        }
      });
    }

    if (typeof client.onAuthFailure === 'function') {
      client.onAuthFailure((failure) => {
        // A preflight-identified SSO socket that fails before opening most often
        // means a stale Feads token cookie won the silo upgrade path. Make the
        // remediation explicit rather than silently retrying it forever.
        enterSsoDenied(failure.initial ? 'token_rejected' : 'sso_rejected');
      });
    }

    /**
     * @param {string} type
     * @param {unknown} payload
     */
    const transport = async (type, payload) => {
      try {
        return await tracked_send(/** @type {MessageType} */ (type), payload);
      } catch {
        return [];
      }
    };
    // Top navigation (optional mount)
    if (nav_mount) {
      createTopNav(nav_mount, store, router);
    }

    // Workspace picker (mount now that store exists)
    const workspace_mount = document.getElementById('workspace-picker');
    if (workspace_mount) {
      createWorkspacePicker(workspace_mount, store, handleWorkspaceChange);
      // feads accounts mode: the Space selector sits before the board picker. Its
      // mount is created here rather than in index.html so a build without accounts
      // mode renders nothing extra.
      const space_mount = document.createElement('div');
      space_mount.id = 'space-select';
      // `.space-select-mount` is `display: contents`: the selector and its
      // separator lay out as siblings of the board picker in `.header-context`.
      space_mount.className = 'space-select-mount';
      workspace_mount.parentElement?.insertBefore(space_mount, workspace_mount);
      createSpaceSelect(space_mount, store, handleSpaceChange);
    }
    // feads: the sign-in panel, and the header chip naming who we act as. Mounted
    // before `whoami` is asked; both render nothing until it answers, so neither
    // flickers into view and then changes its mind.
    if (agent_login_root) {
      createAgentLoginPanel(agent_login_root, store, {
        onRetrySso: () => doReload()
      });
    }
    const identity_mount = document.getElementById('identity-chip');
    if (identity_mount) {
      createIdentityChip(identity_mount, store, {
        onSsoSignedOut: (target) => {
          // The oauth2-proxy route owns the platform session. Close the Feads
          // socket before navigating so no in-flight frame can outlive sign-out.
          client.close();
          window.location.assign(target);
        }
      });
    }
    // feads: the notification bell. Mounted unconditionally and renders nothing
    // until `whoami` names an actor — notifications are addressed to one, so
    // the operator and an anonymous reader get no bell and, more to the point,
    // make no requests for a list that would be empty by construction.
    const notification_mount = document.getElementById('notification-bell');
    if (notification_mount) {
      createNotificationBell(notification_mount, {
        send: (type, payload) =>
          tracked_send(/** @type {MessageType} */ (type), payload),
        client,
        store,
        gotoIssue: (id) => router.gotoIssue(id)
      });
    }
    // feads: the staleness banner. Renders nothing until the server has reported a
    // build, so it does not flash on load.
    if (staleness_root) {
      createStalenessBanner(staleness_root, store, { onReload: doReload });
    }

    /**
     * Start the ordinary WebSocket-backed shell after its identity gate has
     * completed. Base instances take the 404 branch and arrive here with the
     * historical client behavior; a terminal SSO result deliberately does not.
     */
    function startSessionLoads() {
      // Load workspaces after WebSocket is connected. Whatever happens —
      // success, failure, or a server without a registry — the board restore is
      // then SETTLED, which is what gates the deep-link detail subscription.
      void loadWorkspaces().finally(() => resolve_board_restored());
      // feads: and who we are, which decides whether the Agents tab exists and
      // whether the write affordances are offered at all
      void loadIdentity();
      // Lift the parent directory once so every surface can format child actors
      // consistently, without each view issuing its own list-users request.
      void client
        .send('list-users', {})
        .then((result) => {
          const users = Array.isArray(result?.users) ? result.users : [];
          const parents = users
            .filter(
              (/** @type {any} */ user) => !user?.parent_actor && user?.actor
            )
            .map((/** @type {any} */ user) => String(user.actor));
          // Accounts mode: who each alias belongs to, so every surface names
          // `alex-laptop` as its person (utils/owners.js).
          const owners_rev = setOwnerDirectory(result?.owners);
          // ...and who each person is (email for the optional directory hover card;
          // utils/people.js), under the same directory rule.
          const people_rev = setPeopleDirectory(result?.people);
          store.setState({ directory: { parents, owners_rev, people_rev } });
        })
        .catch(() => {});
    }

    // This fallback is for the small test and embedding clients that predate the
    // delayed-start API. The real client always exposes `start`, so production
    // browsers cannot bypass the preflight.
    if (typeof client.start !== 'function') {
      startSessionLoads();
    } else {
      void runSsoPreflight(options.fetch).then((result) => {
        if (result.kind === 'denied') {
          store.setState({
            identity: {
              loaded: true,
              agent: null,
              mode: 'rejected',
              stance: 'deny',
              require_identity: true,
              sso: result.sso
            }
          });
          client.close();
          resolve_board_restored();
          return;
        }
        if (result.kind === 'sso') {
          store.setState({
            identity: {
              loaded: true,
              agent: result.agent,
              mode: result.agent ? 'agent' : 'anonymous',
              stance: 'deny',
              require_identity: true,
              sso: result.sso
            }
          });
          client.setSsoBootstrapIdentified?.(true);
        } else {
          client.setSsoBootstrapIdentified?.(false);
        }
        client.start();
        startSessionLoads();
      });
    }

    // Global New Issue dialog (UI-106) mounted at root so it is always visible
    const new_issue_dialog = createNewIssueDialog(
      root_element,
      (type, payload) => tracked_send(type, payload),
      router,
      store
    );
    // Header button
    try {
      const btn_new = /** @type {HTMLButtonElement|null} */ (
        document.getElementById('new-issue-btn')
      );
      if (btn_new) {
        btn_new.addEventListener('click', () => new_issue_dialog.open());
        // feads: a read-only session cannot create anything, so the button says so
        // rather than failing on click. This is a courtesy and not a control — the
        // server refuses `create-issue` regardless, which is the half that counts.
        // Reflected on every identity change because `whoami` is a round trip and
        // signing out is another.
        const syncNewIssueButton = () => {
          const s = store.getState();
          // feads: the All-boards view spans every board, so a new issue has
          // no board to land on — the server refuses `create-issue` there and
          // the button says why instead of failing on click.
          const on_all_boards = s.workspace?.current?.id === '*';
          const allowed = isWriteAffordanceOffered(s) && !on_all_boards;
          btn_new.disabled = !allowed;
          btn_new.title = on_all_boards
            ? 'Pick one board to create an issue — All boards spans several'
            : allowed
              ? 'Create a new issue (Ctrl/Cmd+N)'
              : 'Sign in as an agent to create issues';
          // A disabled button takes no pointer events, so its wrapper says why.
          const wrap = btn_new.parentElement;
          if (wrap?.classList.contains('new-issue-wrap')) {
            wrap.title = btn_new.title;
          }
        };
        syncNewIssueButton();
        store.subscribe(syncNewIssueButton);
      }
    } catch {
      // ignore missing header
    }

    // feads: mark the document with the identity mode so read-only sessions *look*
    // read-only without every view having to know about identity. One attribute and a
    // couple of CSS rules reach the inline editors in the detail view, which would
    // otherwise take a click and answer with "Failed to save title" — technically
    // true, and a poor explanation of "you are not signed in".
    //
    // Deliberately limited to the controls whose only purpose is editing. Anything
    // broader risks disabling reading, and the enforcement is server-side regardless;
    // this is about not offering an action that cannot succeed.
    try {
      const syncIdentityMode = () => {
        const s = store.getState();
        document.documentElement.dataset.identityMode = s.identity.loaded
          ? s.identity.mode
          : 'unknown';
        // feads: and *which* agent, for the one question a view can answer
        // without the store — "is this mention me?". Same rationale as the mode
        // above: threading identity through every constructor to highlight one
        // word is a lot of wiring for one word. Empty in every mode but `agent`.
        document.documentElement.dataset.identityActor =
          s.identity.loaded && s.identity.agent
            ? s.identity.agent.actor || ''
            : '';
      };
      syncIdentityMode();
      store.subscribe(syncIdentityMode);
    } catch {
      // ignore a document that cannot be marked
    }

    // Local transport shim: for list-issues, serve from local listSelectors;
    // otherwise forward to ws transport for mutations/show.
    /**
     * @param {MessageType} type
     * @param {unknown} payload
     */
    const listTransport = async (type, payload) => {
      if (type === 'list-issues') {
        try {
          return listSelectors.selectIssuesFor('tab:issues');
        } catch (err) {
          log('list selectors failed: %o', err);
          return [];
        }
      }
      return transport(type, payload);
    };

    const issues_view = createListView(
      list_mount,
      /** @type {any} */ (listTransport),
      (hash) => {
        const id = parseHash(hash);
        if (id) {
          router.gotoIssue(id);
        }
      },
      store,
      subscriptions,
      sub_issue_stores
    );
    // Persist filter changes to localStorage
    store.subscribe((s) => {
      const data = {
        status: s.filters.status,
        search: s.filters.search,
        type: typeof s.filters.type === 'string' ? s.filters.type : ''
      };
      window.localStorage.setItem('beads-ui.filters', JSON.stringify(data));
    });
    // Persist board preferences (own key — see the migration note above)
    store.subscribe((s) => {
      window.localStorage.setItem(
        'beads-ui.board-prefs',
        JSON.stringify({
          closed_filter: s.board.closed_filter,
          person: s.board.person || '',
          epic: s.board.epic || ''
        })
      );
    });
    void issues_view.load();

    // Dialog for issue details (UI-104)
    const dialog = createIssueDialog(detail_mount, store, () => {
      // Close: clear selection and return to current view
      const s = store.getState();
      store.setState({ selected_id: null });
      try {
        /** @type {'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'story'|'access'|'departments'} */
        const v = s.view || 'issues';
        router.gotoView(v);
      } catch {
        // ignore
      }
    });

    /** @type {ReturnType<typeof createDetailView> | null} */
    let detail = null;
    // Mount details into the dialog body only
    detail = createDetailView(
      dialog.getMount(),
      transport,
      (hash) => {
        const id = parseHash(hash);
        if (id) {
          router.gotoIssue(id);
        } else {
          // No issue ID - navigate to view (closes dialog)
          const view = parseView(hash);
          router.gotoView(view);
        }
      },
      sub_issue_stores
    );

    /**
     * Subscribe the per-issue detail stream with patience. The subscription
     * is the modal's live-update channel, not its content — `detail.load()`
     * renders the issue from its own fetch — so a subscribe failure
     * (typically a transient bd error while another process is writing the
     * board) must not raise a fatal dialog over data the user is already
     * reading (incident 2026-07-30, feads-dm1). Retry quietly; if the retries
     * run dry, say so in a toast and leave the snapshot on screen. Each
     * attempt re-checks that the issue is still the selected one, so a retry
     * scheduled before the dialog closed cannot mint a zombie subscription.
     *
     * @param {string} client_id
     * @param {{ type: string, params: { id: string } }} spec
     * @returns {Promise<null | (() => Promise<void>)>}
     */
    const subscribeDetailPatiently = (client_id, spec) => {
      const retry_delays_ms = [1200, 3500];
      /**
       * @param {number} attempt
       * @returns {Promise<null | (() => Promise<void>)>}
       */
      const tryOnce = (attempt) => {
        if (String(store.getState().selected_id || '') !== spec.params.id) {
          return Promise.resolve(null);
        }
        return subscriptions.subscribeList(client_id, spec).catch((err) => {
          const code =
            err && typeof err === 'object' ? String(err.code || '') : '';
          if (code === 'not_found') {
            // Not a transport problem: the board this connection is on does
            // not have the issue. Retrying the same board would not help.
            return handleDetailNotFound(client_id, spec);
          }
          if (attempt < retry_delays_ms.length) {
            log(
              'detail subscribe failed (attempt %d, retrying): %o',
              attempt + 1,
              err
            );
            return new Promise((resolve) =>
              setTimeout(resolve, retry_delays_ms[attempt])
            ).then(() => tryOnce(attempt + 1));
          }
          log('detail subscribe failed, out of retries: %o', err);
          showToast(
            'Live updates unavailable for this issue — showing a snapshot. Reopen to retry.',
            'error',
            5000
          );
          return null;
        });
      };
      return tryOnce(0);
    };

    /** Once-per-issue guards for the not_found recovery ladder. */
    const detail_notfound_retried = new Set();
    const detail_allboards_tried = new Set();

    /**
     * Recover from a detail subscription the board refused as `not_found`.
     *
     * The ladder, each rung once per issue:
     * 1. Wait out the startup board restore — a deep link's first subscribe
     *    can race `set-board` and ask the seed board for an issue that lives
     *    on the board about to be selected — then try the (possibly new)
     *    board again.
     * 2. Switch to the All-boards view, which routes a detail subscription to
     *    the issue's home board. This is what makes cross-board deep links
     *    (notification URLs, pasted links) work instead of hanging.
     * 3. Say so, in the modal, instead of leaving "Loading…" on screen.
     *
     * @param {string} client_id
     * @param {{ type: string, params: { id: string } }} spec
     * @returns {Promise<null | (() => Promise<void>)>}
     */
    async function handleDetailNotFound(client_id, spec) {
      await board_restored;
      if (String(store.getState().selected_id || '') !== spec.params.id) {
        return null;
      }
      if (!detail_notfound_retried.has(client_id)) {
        detail_notfound_retried.add(client_id);
        try {
          return await subscriptions.subscribeList(client_id, spec);
        } catch (err) {
          const code =
            err && typeof err === 'object'
              ? String(/** @type {any} */ (err).code || '')
              : '';
          if (code !== 'not_found') {
            return null;
          }
        }
      }
      const cur = store.getState().workspace?.current?.id || '';
      const has_all = (store.getState().workspace?.available || []).some(
        (/** @type {any} */ w) => w.id === '*'
      );
      if (
        cur !== '*' &&
        has_all &&
        !detail_allboards_tried.has(spec.params.id)
      ) {
        detail_allboards_tried.add(spec.params.id);
        showToast(
          `Issue ${spec.params.id} lives on another board — switching to All boards`,
          'success',
          3500
        );
        try {
          // clearAndResubscribe (via the switch) re-subscribes this detail.
          await handleWorkspaceChange('*');
          return null;
        } catch (err) {
          log('all-boards fallback failed: %o', err);
        }
      }
      // One explanation, where the reader is looking: the dialog says why.
      // The toast is only for the case with no dialog to say it in.
      if (detail) {
        detail.showError(
          accountsActive(store.getState())
            ? `${spec.params.id} is not on a board you can open. It may belong to a department you are not in.`
            : `Issue ${spec.params.id} isn't on this board — switch boards to view it.`
        );
      } else {
        showToast(
          `Issue ${spec.params.id} was not found on this board`,
          'error',
          5000
        );
      }
      return null;
    }

    /**
     * The issue id the detail subscription is currently wired for. Prevents
     * the store listener below — which fires on EVERY state change — from
     * re-subscribing the same issue over and over. That churn was not just
     * waste: each round's cleanup unsubscribed the same client id its
     * predecessor had just registered, so a background state change (identity
     * loading, build info arriving) could tear down a live modal's stream.
     *
     * @type {string | null}
     */
    let active_detail_id = null;

    /**
     * Wire (or re-wire) the per-issue detail subscription.
     *
     * @param {string} id
     * @param {{ force?: boolean }} [opts] - `force` re-subscribes even when
     * already wired for this id: after a reconnect or board switch the
     * server-side subscription no longer exists whatever the client believes.
     */
    function subscribeDetailFor(id, opts = {}) {
      if (!opts.force && active_detail_id === id) {
        return;
      }
      active_detail_id = id;
      const client_id = `detail:${id}`;
      /** @type {{ type: string, params: { id: string } }} */
      const spec = { type: 'issue-detail', params: { id } };
      const flare_client_id = `flares:${id}`;
      const flare_spec = { type: 'flares', params: { issue_id: id } };
      try {
        sub_issue_stores.register(flare_client_id, flare_spec);
      } catch {
        /* ignore */
      }
      void subscriptions
        .subscribeList(flare_client_id, flare_spec)
        .catch(() => {});
      // Register store first to avoid dropping the initial snapshot.
      try {
        sub_issue_stores.register(client_id, spec);
      } catch {
        // ignore
      }
      // Unsubscribe whatever came before, BEFORE subscribing: for the same
      // client id the two messages are ordered on the socket, so the old
      // teardown can no longer kill the new stream (which is what happened
      // when cleanup ran after the fact).
      const prev_unsub = unsub_detail;
      unsub_detail = null;
      if (prev_unsub) {
        void prev_unsub().catch(() => {});
      }
      void subscribeDetailPatiently(client_id, spec).then((unsub) => {
        if (!unsub) {
          return;
        }
        if (String(store.getState().selected_id || '') !== id) {
          // Modal moved on while we were subscribing.
          void unsub().catch(() => {});
          return;
        }
        unsub_detail = unsub;
      });
    }
    resubscribeDetail = () => {
      const sel = store.getState().selected_id;
      if (sel) {
        subscribeDetailFor(String(sel), { force: true });
      }
    };

    // Open/close dialog based on selected_id (always dialog; no page variant)
    /** @type {null | (() => Promise<void>)} */
    let unsub_detail = null;

    // If router already set a selected id (deep-link), open dialog now — but
    // subscribe only once the board restore has settled, so the subscription
    // asks the board the user actually saved rather than the seed board.
    const initial_id = store.getState().selected_id;
    if (initial_id) {
      detail_mount.hidden = false;
      dialog.open(initial_id);
      if (detail) {
        void detail.load(initial_id);
      }
      void board_restored.then(() => {
        if (String(store.getState().selected_id || '') === initial_id) {
          subscribeDetailFor(initial_id, { force: true });
        }
      });
    }

    store.subscribe((s) => {
      const id = s.selected_id;
      if (id) {
        detail_mount.hidden = false;
        dialog.open(id);
        if (detail) {
          void detail.load(id);
        }
        subscribeDetailFor(String(id));
      } else {
        try {
          dialog.close();
        } catch {
          // ignore
        }
        if (detail) {
          detail.clear();
        }
        detail_mount.hidden = true;
        active_detail_id = null;
        if (unsub_detail) {
          void unsub_detail().catch(() => {});
          unsub_detail = null;
        }
      }
    });

    // Removed: issues-changed handling. All views re-render from
    // per-subscription stores which are updated by snapshot/upsert/delete.

    // Toggle route shells on view/detail change and persist
    const data = createDataLayer(transport);
    const epics_view = createEpicsView(
      epics_root,
      data,
      (id) => router.gotoIssue(id),
      subscriptions,
      sub_issue_stores
    );
    const board_view = createBoardView(
      board_root,
      data,
      (id) => router.gotoIssue(id),
      store,
      subscriptions,
      sub_issue_stores,
      transport
    );
    agentwatch_view = agentwatch_root
      ? createAgentwatchView(agentwatch_root, {
          send: tracked_send,
          client,
          gotoIssue: (id) => router.gotoIssue(id),
          isActive: () => store.getState().view === 'agentwatch'
        })
      : null;
    // feads: the roster is not push-driven. It changes when someone runs
    // `feads-agent`, which no watcher here observes, so it is fetched on entering
    // the view rather than subscribed to.
    const agents_view = agents_root
      ? createAgentsView(agents_root, store, transport)
      : null;
    const access_view = access_root
      ? createAccessView(access_root, store)
      : null;
    const departments_view = departments_root
      ? createDepartmentsView(departments_root, store)
      : null;
    // feads: the actor directory, fetched on entering the view for the same
    // reason as the roster — it changes when somebody signs up or an agent
    // checks in, and nothing here watches for either.
    const users_view = users_root
      ? createUsersView(users_root, store, transport)
      : null;
    // feads: the epic story view — request/response like the roster rather than
    // push-driven. Its live half re-polls on its own timer while it is the
    // active route; `unload()` below is what stops that when the route moves.
    const story_view = story_root
      ? createEpicStoryView(
          story_root,
          transport,
          (id) => router.gotoIssue(id),
          () => router.gotoView('epics')
        )
      : null;
    // Preload epics when switching to view
    /**
     * @param {{ selected_id: string | null, view: 'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'story'|'access'|'departments', filters: any }} s
     */
    // --- Subscriptions: tab-level management and filter-driven updates ---
    /** @type {null | (() => Promise<void>)} */
    let unsub_issues_tab = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_epics_tab = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_board_ready = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_board_in_progress = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_board_closed = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_board_blocked = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_board_flares = null;

    // Track in-flight subscriptions to prevent duplicates during rapid view switching
    /** @type {Set<string>} */
    const pending_subscriptions = new Set();
    hasPendingSubscriptions = () => pending_subscriptions.size > 0;
    settlePendingSubscriptions = async () => {
      const deadline = Date.now() + 10_000;
      while (pending_subscriptions.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    // Expose activity debug info globally for diagnostics
    // @ts-ignore
    window.__bdui_debug = {
      getPendingSubscriptions: () => Array.from(pending_subscriptions),
      getActivityCount: () => activity.getCount(),
      getActiveRequests: () => activity.getActiveRequests()
    };

    /**
     * Compute subscription spec for Issues tab based on filters.
     *
     * @param {{ status?: string }} filters
     * @returns {{ type: string, params?: Record<string, string|number|boolean> }}
     */
    function computeIssuesSpec(filters) {
      const st = String(filters?.status || 'all');
      if (st === 'ready') {
        return { type: 'ready-issues' };
      }
      if (st === 'in_progress') {
        return { type: 'in-progress-issues' };
      }
      if (st === 'closed') {
        return { type: 'closed-issues' };
      }
      // "all" and "open" map to all-issues; client filters apply locally
      return { type: 'all-issues' };
    }

    /** @type {string|null} */
    let last_issues_spec_key = null;
    /**
     * Ensure only the active tab has subscriptions; clean up previous.
     *
     * feads: `agents` reaches here and matches none of the branches, which is
     * the intent — every issue-list subscription is torn down while the roster
     * is on screen, since the roster is not built from issues. `users` and
     * `story` get the same treatment: both are request/response over their own
     * messages.
     *
     * @param {{ view: 'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'story'|'access'|'departments', filters: any }} s
     */
    function ensureTabSubscriptions(s) {
      // Issues tab
      if (s.view === 'issues') {
        const spec = computeIssuesSpec(s.filters || {});
        const key = JSON.stringify(spec);
        // Register store first to capture the initial snapshot
        try {
          sub_issue_stores.register('tab:issues', spec);
        } catch (err) {
          log('register issues store failed: %o', err);
        }
        // Only (re)subscribe if not yet subscribed, spec changed, and not already in-flight
        const issues_sub_key = `tab:issues:${key}`;
        if (
          (!unsub_issues_tab || key !== last_issues_spec_key) &&
          !pending_subscriptions.has(issues_sub_key)
        ) {
          pending_subscriptions.add(issues_sub_key);
          void subscriptions
            .subscribeList('tab:issues', spec)
            .then((unsub) => {
              unsub_issues_tab = unsub;
              last_issues_spec_key = key;
            })
            .catch((err) => {
              log('subscribe issues failed: %o', err);
              showFatalFromError(err, 'issues list');
            })
            .finally(() => {
              pending_subscriptions.delete(issues_sub_key);
            });
        }
      } else if (unsub_issues_tab) {
        void unsub_issues_tab().catch(() => {});
        unsub_issues_tab = null;
        last_issues_spec_key = null;
        try {
          sub_issue_stores.unregister('tab:issues');
        } catch (err) {
          log('unregister issues store failed: %o', err);
        }
      }

      // Epics tab
      if (s.view === 'epics') {
        // Register store first to avoid race with initial snapshot
        try {
          sub_issue_stores.register('tab:epics', { type: 'epics' });
        } catch (err) {
          log('register epics store failed: %o', err);
        }
        // Only subscribe if not already subscribed and not in-flight
        if (!unsub_epics_tab && !pending_subscriptions.has('tab:epics')) {
          pending_subscriptions.add('tab:epics');
          void subscriptions
            .subscribeList('tab:epics', { type: 'epics' })
            .then((unsub) => {
              unsub_epics_tab = unsub;
            })
            .catch((err) => {
              log('subscribe epics failed: %o', err);
              showFatalFromError(err, 'epics');
            })
            .finally(() => {
              pending_subscriptions.delete('tab:epics');
            });
        }
      } else if (unsub_epics_tab) {
        void unsub_epics_tab().catch(() => {});
        unsub_epics_tab = null;
        try {
          sub_issue_stores.unregister('tab:epics');
        } catch (err) {
          log('unregister epics store failed: %o', err);
        }
      }

      // Board tab subscribes to lists used by columns
      if (s.view === 'board') {
        // Ready column
        if (
          !unsub_board_ready &&
          !pending_subscriptions.has('tab:board:ready')
        ) {
          try {
            sub_issue_stores.register('tab:board:ready', {
              type: 'ready-issues'
            });
          } catch (err) {
            log('register board:ready store failed: %o', err);
          }
          pending_subscriptions.add('tab:board:ready');
          void subscriptions
            .subscribeList('tab:board:ready', { type: 'ready-issues' })
            .then((u) => (unsub_board_ready = u))
            .catch((err) => {
              log('subscribe board ready failed: %o', err);
              showFatalFromError(err, 'board (Ready)');
            })
            .finally(() => {
              pending_subscriptions.delete('tab:board:ready');
            });
        }
        // In Progress column
        if (
          !unsub_board_in_progress &&
          !pending_subscriptions.has('tab:board:in-progress')
        ) {
          try {
            sub_issue_stores.register('tab:board:in-progress', {
              type: 'in-progress-issues'
            });
          } catch (err) {
            log('register board:in-progress store failed: %o', err);
          }
          pending_subscriptions.add('tab:board:in-progress');
          void subscriptions
            .subscribeList('tab:board:in-progress', {
              type: 'in-progress-issues'
            })
            .then((u) => (unsub_board_in_progress = u))
            .catch((err) => {
              log('subscribe board in-progress failed: %o', err);
              showFatalFromError(err, 'board (In Progress)');
            })
            .finally(() => {
              pending_subscriptions.delete('tab:board:in-progress');
            });
        }
        // Closed column
        if (
          !unsub_board_closed &&
          !pending_subscriptions.has('tab:board:closed')
        ) {
          // feads: the Done column shows at most the last 7 days, so ask for
          // those (plus a day of slack) instead of the newest thousand.
          const closed_spec = boardClosedSpec();
          try {
            sub_issue_stores.register('tab:board:closed', closed_spec);
          } catch (err) {
            log('register board:closed store failed: %o', err);
          }
          pending_subscriptions.add('tab:board:closed');
          void subscriptions
            .subscribeList('tab:board:closed', closed_spec)
            .then((u) => (unsub_board_closed = u))
            .catch((err) => {
              log('subscribe board closed failed: %o', err);
              showFatalFromError(err, 'board (Closed)');
            })
            .finally(() => {
              pending_subscriptions.delete('tab:board:closed');
            });
        }
        // Persistent board-wide flare presence
        if (!unsub_board_flares && !pending_subscriptions.has('flares:board')) {
          try {
            sub_issue_stores.register('flares:board', { type: 'flares' });
          } catch (err) {
            log('register board flares store failed: %o', err);
          }
          pending_subscriptions.add('flares:board');
          void subscriptions
            .subscribeList('flares:board', { type: 'flares' })
            .then((u) => (unsub_board_flares = u))
            .catch((err) => log('subscribe board flares failed: %o', err))
            .finally(() => pending_subscriptions.delete('flares:board'));
        }
        // Blocked column
        if (
          !unsub_board_blocked &&
          !pending_subscriptions.has('tab:board:blocked')
        ) {
          try {
            sub_issue_stores.register('tab:board:blocked', {
              type: 'blocked-issues'
            });
          } catch (err) {
            log('register board:blocked store failed: %o', err);
          }
          pending_subscriptions.add('tab:board:blocked');
          void subscriptions
            .subscribeList('tab:board:blocked', { type: 'blocked-issues' })
            .then((u) => (unsub_board_blocked = u))
            .catch((err) => {
              log('subscribe board blocked failed: %o', err);
              showFatalFromError(err, 'board (Blocked)');
            })
            .finally(() => {
              pending_subscriptions.delete('tab:board:blocked');
            });
        }
      } else {
        if (unsub_board_flares) {
          void unsub_board_flares().catch(() => {});
          unsub_board_flares = null;
          try {
            sub_issue_stores.unregister('flares:board');
          } catch {
            /* ignore */
          }
        }
        // Unsubscribe all board lists when leaving the board view
        if (unsub_board_ready) {
          void unsub_board_ready().catch(() => {});
          unsub_board_ready = null;
          try {
            sub_issue_stores.unregister('tab:board:ready');
          } catch (err) {
            log('unregister board:ready failed: %o', err);
          }
        }
        if (unsub_board_in_progress) {
          void unsub_board_in_progress().catch(() => {});
          unsub_board_in_progress = null;
          try {
            sub_issue_stores.unregister('tab:board:in-progress');
          } catch (err) {
            log('unregister board:in-progress failed: %o', err);
          }
        }
        if (unsub_board_closed) {
          void unsub_board_closed().catch(() => {});
          unsub_board_closed = null;
          try {
            sub_issue_stores.unregister('tab:board:closed');
          } catch (err) {
            log('unregister board:closed failed: %o', err);
          }
        }
        if (unsub_board_blocked) {
          void unsub_board_blocked().catch(() => {});
          unsub_board_blocked = null;
          try {
            sub_issue_stores.unregister('tab:board:blocked');
          } catch (err) {
            log('unregister board:blocked failed: %o', err);
          }
        }
      }
    }

    /** @type {import('./state.js').ViewName | null} */
    let active_route_view = null;

    /**
     * Manage route visibility and list subscriptions per view.
     *
     * @param {{ selected_id: string | null, story_id?: string | null, view: 'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'story'|'access'|'departments', filters: any }} s
     */
    const onRouteChange = (s) => {
      const entering_agentwatch =
        s.view === 'agentwatch' && active_route_view !== 'agentwatch';
      const leaving_agentwatch =
        active_route_view === 'agentwatch' && s.view !== 'agentwatch';
      if (leaving_agentwatch && agentwatch_view) {
        void agentwatch_view.unload();
      }
      if (issues_root && epics_root && board_root && detail_mount) {
        // Underlying route visibility is controlled only by selected view
        issues_root.hidden = s.view !== 'issues';
        epics_root.hidden = s.view !== 'epics';
        board_root.hidden = s.view !== 'board';
        if (agentwatch_root) {
          agentwatch_root.hidden = s.view !== 'agentwatch';
        }
        // detail_mount visibility handled in subscription above
      }
      if (users_root) {
        users_root.hidden = s.view !== 'users';
      }
      if (agents_root) {
        agents_root.hidden = s.view !== 'agents';
      }
      if (access_root) {
        access_root.hidden = s.view !== 'access';
      }
      if (departments_root) {
        departments_root.hidden = s.view !== 'departments';
      }
      if (story_root) {
        story_root.hidden = s.view !== 'story';
      }
      // Ensure subscriptions for the active tab before loading the view to
      // avoid empty initial renders due to racing list-delta.
      ensureTabSubscriptions(s);
      if (!s.selected_id && s.view === 'epics') {
        void epics_view.load();
      }
      if (!s.selected_id && s.view === 'board') {
        void board_view.load();
      }
      if (!s.selected_id && s.view === 'users' && users_view) {
        void users_view.load();
      }
      if (!s.selected_id && s.view === 'agents' && agents_view) {
        void agents_view.load();
      }
      if (!s.selected_id && s.view === 'access' && access_view) {
        void access_view.load();
      }
      if (!s.selected_id && s.view === 'departments' && departments_view) {
        void departments_view.load();
      }
      if (story_view) {
        if (s.view === 'story' && s.story_id) {
          void story_view.load(s.story_id);
        } else if (s.view !== 'story') {
          story_view.unload();
        }
      }
      if (entering_agentwatch && agentwatch_view) {
        void agentwatch_view.load();
      }
      active_route_view = s.view;
      // feads: `story` is a per-epic drill-in, not a tab; restoring it on a
      // fresh load would need an epic id that is not persisted, so the saved
      // view falls back to the tab stories launch from.
      window.localStorage.setItem(
        'beads-ui.view',
        s.view === 'story' ? 'epics' : s.view
      );
    };
    store.subscribe(onRouteChange);
    // Ensure initial state is reflected (fixes reload on #/epics)
    onRouteChange(store.getState());

    // Removed redundant filter-change subscription: handled by ensureTabSubscriptions

    // Keyboard shortcuts: Ctrl/Cmd+N opens new issue; Ctrl/Cmd+Enter submits inside dialog
    window.addEventListener('keydown', (ev) => {
      const is_modifier = ev.ctrlKey || ev.metaKey;
      const key = String(ev.key || '').toLowerCase();
      const target = /** @type {HTMLElement} */ (ev.target);
      const tag =
        target && target.tagName ? String(target.tagName).toLowerCase() : '';
      const is_editable =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (target &&
          typeof target.isContentEditable === 'boolean' &&
          target.isContentEditable);
      if (is_modifier && key === 'n') {
        // Do not hijack when typing in inputs; common UX
        if (!is_editable) {
          ev.preventDefault();
          // feads: no creation on the All-boards view — nothing to route it to.
          if (store.getState().workspace?.current?.id !== '*') {
            new_issue_dialog.open();
          }
        }
      }
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    // Initialize theme from saved preference or OS preference
    try {
      const saved = window.localStorage.getItem('beads-ui.theme');
      const prefersDark =
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      const initial =
        saved === 'dark' || saved === 'light'
          ? saved
          : prefersDark
            ? 'dark'
            : 'light';
      document.documentElement.setAttribute('data-theme', initial);
      const sw = /** @type {HTMLInputElement|null} */ (
        document.getElementById('theme-switch')
      );
      if (sw) {
        sw.checked = initial === 'dark';
      }
    } catch {
      // ignore theme init errors
    }

    // Wire up theme switch in header
    const themeSwitch = /** @type {HTMLInputElement|null} */ (
      document.getElementById('theme-switch')
    );
    if (themeSwitch) {
      themeSwitch.addEventListener('change', () => {
        const mode = themeSwitch.checked ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', mode);
        window.localStorage.setItem('beads-ui.theme', mode);
      });
    }

    /** @type {HTMLElement|null} */
    const app_root = document.getElementById('app');
    if (app_root) {
      bootstrap(app_root);
    }
  });
}
