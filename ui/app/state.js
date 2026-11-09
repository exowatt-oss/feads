/**
 * Minimal app state store with subscription.
 */
import { debug } from './utils/logging.js';

/**
 * @typedef {'all'|'open'|'in_progress'|'closed'|'ready'} StatusFilter
 */

/**
 * @typedef {{ status: StatusFilter, search: string, type: string }} Filters
 */

/**
 * @typedef {'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'story'|'access'|'departments'} ViewName
 */

/**
 * @typedef {'today'|'3'|'7'} ClosedFilter
 */

/**
 * @typedef {{ closed_filter: ClosedFilter, person: string, epic: string }} BoardState
 */

/**
 * @typedef {Object} WorkspaceInfo
 * @property {string} path - Full path to workspace
 * @property {string} database - Path to the database file
 * @property {number} [pid] - Process ID of the daemon
 * @property {string} [version] - Version of beads
 * @property {string} [key] - feads: stable board identity (registry id, else board dir)
 * @property {string} [id] - feads: board registry id, '' when unregistered
 * @property {string} [name] - feads: board name from the registry
 * @property {string} [description] - feads: what the board is for
 * @property {string[]} [repos] - feads: repos the board covers
 * @property {string} [board_dir] - feads: the board's `.beads` directory
 * @property {boolean} [exists] - feads: false when board_dir is gone from disk
 * @property {string} [space_id] - feads accounts mode: the space the board belongs to
 */

/**
 * @typedef {Object} WorkspaceState
 * @property {WorkspaceInfo | null} current - Currently active workspace
 * @property {WorkspaceInfo[]} available - All available workspaces
 * @property {string} [space] - feads accounts mode: the Space selected in the header
 */

/**
 * feads: the registered agent this dashboard is acting as, from `whoami`.
 *
 * @typedef {Object} AgentIdentity
 * @property {string} agent_id
 * @property {string} actor
 * @property {string} display_name
 * @property {string} role
 * @property {string} board_id
 * @property {number} last_seen_at
 */

/**
 * Optional silo-only provenance returned by `whoami`. It is deliberately kept in
 * memory only; the dashboard never persists identity details in web storage.
 *
 * @typedef {Object} SsoIdentity
 * @property {string} [email]
 * @property {string} [provenance]
 * @property {string} [provider]
 * @property {string} [status]
 * @property {string} [error_code]
 * @property {'clear_token'|'retry_sso'} [action]
 * @property {string} [actor]
 * @property {boolean} [linked]
 * @property {boolean} [pending]
 * @property {boolean} [terminal]
 * @property {string} [sign_out_url]
 * @property {string} [signout_url]
 * @property {string} [logout_url]
 * @property {string} [logout_target]
 * @property {string} [signout_target]
 * @property {string} [logout]
 * @property {string} [sign_out]
 * @property {string} [target]
 * @property {boolean} [available]
 * @property {boolean} [rejected]
 */

/**
 * Permissions are an optional server projection. Older/base whoami replies omit
 * them, so mode remains the compatibility fallback when they are absent.
 *
 * @typedef {Record<string, boolean> | string[]} IdentityPermissions
 */

/**
 * feads: identity is in the shared store rather than in the agents view because
 * the header nav needs it too — it decides whether the Agents tab exists at all.
 *
 * `loaded` is not redundant with `agent !== null`: unidentified-and-answered
 * (operator mode) and not-yet-answered are different states, and the tab must
 * not flicker into view before the server has answered.
 *
 * Nor is `mode` derivable from `agent`. Four distinct states share `agent: null`:
 * the operator (no registry on this machine, so nothing is restricted), an
 * `anonymous` visitor who may read and change nothing, a caller refused because
 * `FEADS_REQUIRE_AGENT` is set, and one whose credential was presented and rejected
 * (`mode: 'rejected'`, which includes a revoked agent). Collapsing them is what let
 * revocation read as a promotion.
 *
 * `stance` separates the last two, which share `mode: 'anonymous'`: `read_only`
 * means the board is visible and a sign-in is offered over it, `deny` means the
 * server refuses reads too and the panel may block. The UI could derive that from
 * `require_identity`, and carrying the server's own word for it instead means the
 * two cannot drift.
 *
 * @typedef {Object} IdentityState
 * @property {boolean} loaded
 * @property {AgentIdentity | null} agent
 * @property {'agent'|'operator'|'anonymous'|'rejected'} mode
 * @property {'operator'|'read_only'|'deny'} stance
 * @property {boolean} require_identity
 * @property {SsoIdentity | null} [sso] - Silo-only SSO provenance and logout target
 * @property {IdentityPermissions | null} [permissions] - Server-provided write permissions
 * @property {Record<string, any> | null} [accounts] - Accounts mode: whoami's `accounts` block
 */

/**
 * feads: which build the server is running, and which kind of stale this page is.
 *
 * Two separate flags, never one. Their remedies differ — a reload fixes a stale bundle
 * and cannot fix a stale process — so a single "out of date" would send somebody round a
 * loop with no exit. See `build-info.js` and `views/staleness-banner.js`.
 *
 * `loaded` is not redundant with the flags: not-yet-reported and reported-as-current are
 * different states, and a banner must not flash on every page load before the server has
 * answered.
 *
 * `restart_offered` and `restart_allowed` are also distinct. The first says this
 * deployment has the feature at all (a launcher script is present and
 * `FEADS_REQUIRE_AGENT` is unset); the second says *this request* would be permitted,
 * which additionally means it came from the machine the daemon runs on. Notably neither
 * depends on who is signed in — see `server/server-routes.js`. Collapsing them would
 * either hide the copyable command on a deployment that has no button, or offer a button
 * that is going to be refused.
 *
 * @typedef {Object} BuildState
 * @property {boolean} loaded
 * @property {string} build_id - The running process's identity, for diagnosis.
 * @property {string} bundle_id - The bundle the server would serve now.
 * @property {boolean} client_stale
 * @property {boolean} server_stale
 * @property {string} restart_command
 * @property {boolean} restart_offered
 * @property {boolean} restart_allowed
 * @property {string} restart_reason
 */

/**
 * @typedef {{ selected_id: string | null, story_id: string | null, view: ViewName, filters: Filters, board: BoardState, workspace: WorkspaceState, identity: IdentityState, directory: { parents: string[], owners_rev?: number, people_rev?: number }, build: BuildState }} AppState
 */

/**
 * Create a simple store for application state.
 *
 * @param {Partial<AppState>} [initial]
 * @returns {{ getState: () => AppState, setState: (patch: { selected_id?: string | null, story_id?: string | null, view?: ViewName, filters?: Partial<Filters>, board?: Partial<BoardState>, workspace?: Partial<WorkspaceState>, identity?: Partial<IdentityState>, directory?: { parents?: string[], owners_rev?: number, people_rev?: number }, build?: Partial<BuildState> }) => void, subscribe: (fn: (s: AppState) => void) => () => void }}
 */
export function createStore(initial = {}) {
  const log = debug('state');
  /** @type {IdentityState} */
  const initial_identity = {
    loaded: initial.identity?.loaded ?? false,
    agent: initial.identity?.agent ?? null,
    // `loaded: false` gates everything that reads these, so the pre-answer values
    // are placeholders rather than a claim. They stay at the permissive end so a
    // build whose `whoami` never answers behaves as it did before there was one.
    mode: initial.identity?.mode ?? 'operator',
    stance: initial.identity?.stance ?? 'operator',
    require_identity: initial.identity?.require_identity ?? false
  };
  // Keep the base identity object byte-compatible: optional silo fields are absent
  // unless the server actually returned them.
  if (initial.identity?.sso != null) {
    initial_identity.sso = initial.identity.sso;
  }
  if (initial.identity?.permissions != null) {
    initial_identity.permissions = initial.identity.permissions;
  }

  /** @type {AppState} */
  let state = {
    selected_id: initial.selected_id ?? null,
    // feads: the epic whose story view is open; carried in the hash path
    // (#/story/<id>) rather than the issue query, which stays the dialog's.
    story_id: initial.story_id ?? null,
    view: initial.view ?? 'issues',
    filters: {
      status: initial.filters?.status ?? 'all',
      search: initial.filters?.search ?? '',
      type:
        typeof initial.filters?.type === 'string' ? initial.filters?.type : ''
    },
    board: {
      closed_filter:
        initial.board?.closed_filter === '3' ||
        initial.board?.closed_filter === '7' ||
        initial.board?.closed_filter === 'today'
          ? initial.board?.closed_filter
          : 'today',
      // feads: board people/epic filters — who is doing it, and toward what.
      person:
        typeof initial.board?.person === 'string' ? initial.board.person : '',
      epic: typeof initial.board?.epic === 'string' ? initial.board.epic : ''
    },
    workspace: {
      current: initial.workspace?.current ?? null,
      available: initial.workspace?.available ?? []
    },
    directory: {
      parents: Array.isArray(initial.directory?.parents)
        ? initial.directory.parents
        : [],
      owners_rev: Number(initial.directory?.owners_rev || 0),
      people_rev: Number(initial.directory?.people_rev || 0)
    },
    identity: initial_identity,
    build: {
      // Everything defaults to "nothing is wrong and nothing is offered", so a build
      // whose server never reports behaves exactly as it did before this existed. The
      // failure direction matters: a false stale warning trains people to ignore the
      // banner, which costs more than a missed one.
      loaded: initial.build?.loaded ?? false,
      build_id: initial.build?.build_id ?? '',
      bundle_id: initial.build?.bundle_id ?? '',
      client_stale: initial.build?.client_stale ?? false,
      server_stale: initial.build?.server_stale ?? false,
      restart_command: initial.build?.restart_command ?? '',
      restart_offered: initial.build?.restart_offered ?? false,
      restart_allowed: initial.build?.restart_allowed ?? false,
      restart_reason: initial.build?.restart_reason ?? ''
    }
  };

  /** @type {Set<(s: AppState) => void>} */
  const subs = new Set();

  function emit() {
    for (const fn of Array.from(subs)) {
      try {
        fn(state);
      } catch {
        // ignore
      }
    }
  }

  return {
    getState() {
      return state;
    },
    /**
     * Update state. Nested filters can be partial.
     *
     * @param {{ selected_id?: string | null, story_id?: string | null, view?: ViewName, filters?: Partial<Filters>, board?: Partial<BoardState>, workspace?: Partial<WorkspaceState>, identity?: Partial<IdentityState>, directory?: { parents?: string[], owners_rev?: number, people_rev?: number }, build?: Partial<BuildState> }} patch
     */
    setState(patch) {
      const identity_patch = patch.identity || {};
      /** @type {IdentityState} */
      const next_identity = { ...state.identity, ...identity_patch };
      // A missing SSO block is meaningful: it is how a base whoami response
      // returns to the old identity shape after a silo session changes. Delete
      // optional fields rather than leaving a stale provenance line in memory.
      if (Object.hasOwn(identity_patch, 'sso') && identity_patch.sso == null) {
        delete next_identity.sso;
      }
      if (
        Object.hasOwn(identity_patch, 'permissions') &&
        identity_patch.permissions == null
      ) {
        delete next_identity.permissions;
      }

      /** @type {AppState} */
      const next = {
        ...state,
        ...patch,
        filters: { ...state.filters, ...(patch.filters || {}) },
        board: { ...state.board, ...(patch.board || {}) },
        workspace: {
          current:
            patch.workspace?.current !== undefined
              ? patch.workspace.current
              : state.workspace.current,
          available:
            patch.workspace?.available !== undefined
              ? patch.workspace.available
              : state.workspace.available
        },
        identity: next_identity,
        directory: { ...state.directory, ...(patch.directory || {}) },
        build: { ...state.build, ...(patch.build || {}) }
      };
      // Avoid emitting if nothing changed (shallow compare). feads: compare the
      // board key, not the path — two boards can share one project root.
      const workspace_changed =
        (next.workspace.current?.key ?? next.workspace.current?.path) !==
          (state.workspace.current?.key ?? state.workspace.current?.path) ||
        next.workspace.available.length !== state.workspace.available.length;
      // feads: compared field by field, like the rest of this guard. `agent` is
      // a fresh object on every whoami reply, so an identity check has to be on
      // what changed about the agent, not on object identity.
      const identity_changed =
        next.identity.loaded !== state.identity.loaded ||
        next.identity.mode !== state.identity.mode ||
        next.identity.stance !== state.identity.stance ||
        next.identity.require_identity !== state.identity.require_identity ||
        (next.identity.agent?.agent_id ?? '') !==
          (state.identity.agent?.agent_id ?? '') ||
        (next.identity.agent?.role ?? '') !==
          (state.identity.agent?.role ?? '') ||
        (next.identity.sso?.email ?? '') !==
          (state.identity.sso?.email ?? '') ||
        (next.identity.sso?.provenance ?? '') !==
          (state.identity.sso?.provenance ?? '') ||
        (next.identity.sso?.provider ?? '') !==
          (state.identity.sso?.provider ?? '') ||
        (next.identity.sso?.status ?? '') !==
          (state.identity.sso?.status ?? '') ||
        (next.identity.sso?.error_code ?? '') !==
          (state.identity.sso?.error_code ?? '') ||
        (next.identity.sso?.action ?? '') !==
          (state.identity.sso?.action ?? '') ||
        (next.identity.sso?.actor ?? '') !==
          (state.identity.sso?.actor ?? '') ||
        (next.identity.sso?.linked ?? null) !==
          (state.identity.sso?.linked ?? null) ||
        (next.identity.sso?.pending ?? null) !==
          (state.identity.sso?.pending ?? null) ||
        (next.identity.sso?.terminal ?? null) !==
          (state.identity.sso?.terminal ?? null) ||
        (next.identity.sso?.sign_out_url ?? '') !==
          (state.identity.sso?.sign_out_url ?? '') ||
        (next.identity.sso?.signout_url ?? '') !==
          (state.identity.sso?.signout_url ?? '') ||
        (next.identity.sso?.logout_url ?? '') !==
          (state.identity.sso?.logout_url ?? '') ||
        (next.identity.sso?.logout_target ?? '') !==
          (state.identity.sso?.logout_target ?? '') ||
        (next.identity.sso?.signout_target ?? '') !==
          (state.identity.sso?.signout_target ?? '') ||
        (next.identity.sso?.logout ?? '') !==
          (state.identity.sso?.logout ?? '') ||
        (next.identity.sso?.sign_out ?? '') !==
          (state.identity.sso?.sign_out ?? '') ||
        (next.identity.sso?.target ?? '') !==
          (state.identity.sso?.target ?? '') ||
        (next.identity.sso?.available ?? null) !==
          (state.identity.sso?.available ?? null) ||
        (next.identity.sso?.rejected ?? null) !==
          (state.identity.sso?.rejected ?? null) ||
        JSON.stringify(next.identity.permissions ?? null) !==
          JSON.stringify(state.identity.permissions ?? null) ||
        JSON.stringify(next.identity.accounts ?? null) !==
          JSON.stringify(state.identity.accounts ?? null);
      // feads accounts mode: the owner directory (aliases shown as their person)
      // changes how every actor renders, so a new revision re-renders.
      const directory_changed =
        (next.directory.owners_rev ?? 0) !==
          (state.directory.owners_rev ?? 0) ||
        (next.directory.people_rev ?? 0) !== (state.directory.people_rev ?? 0);
      // feads: field by field for the same reason. Note what is *not* compared: the
      // mtimes in the server's report. Those move whenever anything is touched, and
      // waking every subscriber for a changed mtime that changed neither answer would
      // re-render the banner on a timer for no reason.
      const build_changed =
        next.build.loaded !== state.build.loaded ||
        next.build.client_stale !== state.build.client_stale ||
        next.build.server_stale !== state.build.server_stale ||
        next.build.bundle_id !== state.build.bundle_id ||
        next.build.build_id !== state.build.build_id ||
        next.build.restart_offered !== state.build.restart_offered ||
        next.build.restart_allowed !== state.build.restart_allowed ||
        next.build.restart_command !== state.build.restart_command;
      if (
        next.selected_id === state.selected_id &&
        next.story_id === state.story_id &&
        next.view === state.view &&
        next.filters.status === state.filters.status &&
        next.filters.search === state.filters.search &&
        next.filters.type === state.filters.type &&
        next.board.closed_filter === state.board.closed_filter &&
        next.board.person === state.board.person &&
        next.board.epic === state.board.epic &&
        !workspace_changed &&
        !identity_changed &&
        !directory_changed &&
        !build_changed
      ) {
        return;
      }
      state = next;
      log('state change %o', {
        selected_id: state.selected_id,
        view: state.view,
        filters: state.filters,
        board: state.board,
        workspace: state.workspace.current?.path
      });
      emit();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    }
  };
}
