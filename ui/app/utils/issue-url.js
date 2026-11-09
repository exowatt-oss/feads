/**
 * Build a canonical issue hash that retains the view.
 *
 * feads: `agents`, `admin`, and `users` are accepted but not retained. Those
 * views have no issue rows, so an issue selected while one is open did not come
 * from it, and falling back to `issues` sends the dialog somewhere it can be
 * closed onto a list. Agentwatch owns issue rows, so it retains the watch route. `story`
 * falls back too — a story hash carries its epic in the path, which this helper
 * cannot know; the router builds that one itself.
 *
 * @param {'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'story'|'access'|'departments'} view
 * @param {string} id
 */
export function issueHashFor(view, id) {
  const v =
    view === 'epics' || view === 'board' || view === 'agentwatch'
      ? view
      : 'issues';
  return `#/${v}?issue=${encodeURIComponent(id)}`;
}
