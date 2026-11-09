import { describe, expect, test } from 'vitest';
import { createHashRouter, parseHash, parseView } from './router.js';
import { createStore } from './state.js';
import { issueHashFor } from './utils/issue-url.js';

describe('router', () => {
  test('parseHash extracts id', () => {
    expect(parseHash('#/issues?issue=UI-5')).toBe('UI-5');
    expect(parseHash('#/issue/UI-5')).toBe('UI-5');
    expect(parseHash('#/anything')).toBeNull();
  });

  test('router updates store and gotoIssue updates hash', () => {
    document.body.innerHTML = '<div></div>';
    const store = createStore();
    const router = createHashRouter(store);
    router.start();

    window.location.hash = '#/issue/UI-10';
    // Trigger handler synchronously
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(store.getState().selected_id).toBe('UI-10');

    router.gotoIssue('UI-11');
    expect(window.location.hash).toBe('#/issues?issue=UI-11');
    router.stop();
  });

  test('parseView resolves from hash and defaults to issues', () => {
    expect(parseView('#/issues')).toBe('issues');
    expect(parseView('#/epics')).toBe('epics');
    expect(parseView('#/board')).toBe('board');
    expect(parseView('#/agentwatch')).toBe('agentwatch');
    expect(parseView('#/agentwatch?issue=UI-1')).toBe('agentwatch');
    expect(parseView('')).toBe('issues');
    expect(parseView('#/unknown')).toBe('issues');
  });

  // feads: routing is not authorization. `#/agents` resolves for every caller,
  // including one whose tier hides the tab, so a pasted link lands on a page
  // that explains the tier instead of silently redirecting.
  test('parseView resolves the agents view for anyone', () => {
    expect(parseView('#/agents')).toBe('agents');
    expect(parseView('#/agents?issue=UI-1')).toBe('agents');
  });

  test('parseView resolves the admin silo view for anyone', () => {
    expect(parseView('#/admin')).toBe('admin');
    expect(parseView('#/admin/anything')).toBe('admin');
  });

  test('an issue selected from the agents view returns to issues', () => {
    document.body.innerHTML = '<div></div>';
    window.location.hash = '#/agents';
    const store = createStore();
    const router = createHashRouter(store);
    router.start();
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(store.getState().view).toBe('agents');

    router.gotoIssue('UI-12');

    expect(window.location.hash).toBe('#/issues?issue=UI-12');
    router.stop();
  });

  test('retains Agentwatch when selecting and closing an issue', () => {
    document.body.innerHTML = '<div></div>';
    window.location.hash = '#/agentwatch';
    const store = createStore();
    const router = createHashRouter(store);
    router.start();

    router.gotoIssue('UI-13');
    expect(window.location.hash).toBe('#/agentwatch?issue=UI-13');
    expect(issueHashFor('agentwatch', 'UI-13')).toBe(
      '#/agentwatch?issue=UI-13'
    );

    store.setState({ selected_id: null });
    router.gotoView('agentwatch');
    expect(window.location.hash).toBe('#/agentwatch');
    router.stop();
  });

  test('restores the persisted view when the hash is empty', () => {
    window.location.hash = '';
    const store = createStore({ view: 'agentwatch' });
    const router = createHashRouter(store);
    router.start();
    expect(store.getState().view).toBe('agentwatch');
    router.stop();
  });
});
