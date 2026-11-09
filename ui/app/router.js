import { issueHashFor } from './utils/issue-url.js';
import { debug } from './utils/logging.js';

/**
 * Hash-based router for tabs (issues/epics/board/agentwatch) and deep-linked issue ids.
 */

/**
 * Parse an application hash and extract the selected issue id.
 * Supports canonical form "#/(issues|epics|board|agentwatch)?issue=<id>" and legacy
 * "#/issue/<id>" which we will rewrite to the canonical form.
 *
 * @param {string} hash
 * @returns {string | null}
 */
export function parseHash(hash) {
  const h = String(hash || '');
  // Extract the fragment sans leading '#'
  const frag = h.startsWith('#') ? h.slice(1) : h;
  const qIndex = frag.indexOf('?');
  const query = qIndex >= 0 ? frag.slice(qIndex + 1) : '';
  if (query) {
    const params = new URLSearchParams(query);
    const id = params.get('issue');
    if (id) {
      return decodeURIComponent(id);
    }
  }
  // Legacy pattern: #/issue/<id>
  const m = /^\/issue\/([^\s?#]+)/.exec(frag);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * Parse the current view from hash.
 *
 * feads: `#/agents` and `#/admin` are parsed for everyone, including a caller
 * whose tier hides the tab. Routing is not authorization — the view itself
 * narrows what it shows (and the server narrows what it sends), so a deep link
 * resolves to a page that says what the caller may see rather than to a silent
 * redirect that looks like the link was wrong.
 *
 * @param {string} hash
 * @returns {'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'story'|'access'|'departments'}
 */
export function parseView(hash) {
  const h = String(hash || '');
  if (/^#\/epics(\b|\/|$)/.test(h)) {
    return 'epics';
  }
  if (/^#\/board(\b|\/|$)/.test(h)) {
    return 'board';
  }
  if (/^#\/agentwatch(\b|\/|$)/.test(h)) {
    return 'agentwatch';
  }
  // feads: the actor directory. Ungated in both directions — no tier hides the
  // tab and no tier is redirected away from the hash, because the server already
  // answers `list-users` for anyone it lets read at all.
  if (/^#\/users(\b|\/|$)/.test(h)) {
    return 'users';
  }
  if (/^#\/agents(\b|\/|$)/.test(h)) {
    return 'agents';
  }
  if (/^#\/access(\b|\/|$)/.test(h)) {
    return 'access';
  }
  if (/^#\/departments(\b|\/|$)/.test(h)) {
    return 'departments';
  }
  if (/^#\/admin(\b|\/|$)/.test(h)) {
    return 'admin';
  }
  if (/^#\/story(\b|\/|$)/.test(h)) {
    return 'story';
  }
  // Default to issues (also covers #/issues and unknown/empty)
  return 'issues';
}

/**
 * Extract the epic id from a story hash: `#/story/<epic-id>[?...]`.
 *
 * feads: the story view is per-epic, so the epic rides in the path — the
 * `?issue=` query stays what it is everywhere else (the open issue dialog),
 * which is how a node click can open an issue *over* the story.
 *
 * @param {string} hash
 * @returns {string | null}
 */
export function parseStoryId(hash) {
  const m = /^#\/story\/([^\s?#/]+)/.exec(String(hash || ''));
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * @param {{ getState: () => any, setState: (patch: any) => void }} store
 */
export function createHashRouter(store) {
  const log = debug('router');
  /** @type {(ev?: HashChangeEvent) => any} */
  const onHashChange = () => {
    const hash = window.location.hash || '';
    // Rewrite legacy #/issue/<id> to canonical #/issues?issue=<id>
    const legacyMatch = /^#\/issue\/([^\s?#]+)/.exec(hash);
    if (legacyMatch && legacyMatch[1]) {
      const id = decodeURIComponent(legacyMatch[1]);
      // Update state immediately for consumers expecting sync selection
      store.setState({ selected_id: id, view: 'issues' });
      const next = `#/issues?issue=${encodeURIComponent(id)}`;
      if (window.location.hash !== next) {
        window.location.hash = next;
        return; // will trigger handler again
      }
    }
    const id = parseHash(hash);
    // An empty hash means the browser did not provide a route. Keep the
    // persisted view from the store in that case; an explicit hash always wins.
    const view =
      hash && hash !== '#'
        ? parseView(hash)
        : store.getState().view || 'issues';
    const story_id = view === 'story' ? parseStoryId(hash) : null;
    log('hash change → view=%s id=%s story=%s', view, id, story_id);
    store.setState({ selected_id: id, view, story_id });
  };

  return {
    start() {
      window.addEventListener('hashchange', onHashChange);
      onHashChange();
    },
    stop() {
      window.removeEventListener('hashchange', onHashChange);
    },
    /**
     * @param {string} id
     */
    gotoIssue(id) {
      // Keep current view in hash and append issue param via helper
      const s = store.getState ? store.getState() : { view: 'issues' };
      const view = s.view || 'issues';
      // feads: a story hash carries its epic in the path, which issueHashFor
      // cannot express — build it here so a node click opens the issue dialog
      // *over* the story instead of bouncing back to the issues list.
      const next =
        view === 'story' && s.story_id
          ? `#/story/${encodeURIComponent(s.story_id)}?issue=${encodeURIComponent(id)}`
          : issueHashFor(view, id);
      log('goto issue %s (view=%s)', id, view);
      if (window.location.hash !== next) {
        window.location.hash = next;
      } else {
        // Force state update even if hash is the same
        store.setState({ selected_id: id, view });
      }
    },
    /**
     * Navigate to a top-level view.
     *
     * @param {'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'story'|'access'|'departments'} view
     */
    gotoView(view) {
      const s = store.getState ? store.getState() : { selected_id: null };
      const id = s.selected_id;
      // feads: "back to the story" must keep its epic; a story view with no
      // epic to show falls back to the epics list, which is where stories are
      // launched from.
      if (view === 'story') {
        if (!s.story_id) {
          this.gotoView('epics');
          return;
        }
        const next = `#/story/${encodeURIComponent(s.story_id)}`;
        if (window.location.hash !== next) {
          window.location.hash = next;
        } else {
          store.setState({ view, selected_id: null });
        }
        return;
      }
      // The admin view has no issue rows; if a stale selection is present,
      // return the dialog to the issues list just like the helper's fallback.
      const issue_view =
        view === 'admin' || view === 'access' || view === 'departments'
          ? 'issues'
          : view;
      const next = id ? issueHashFor(issue_view, id) : `#/${view}`;
      log('goto view %s (id=%s)', view, id || '');
      if (window.location.hash !== next) {
        window.location.hash = next;
      } else {
        store.setState({ view, selected_id: null });
      }
    }
  };
}
