import { describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

const harness = vi.hoisted(() => {
  const handlers = new Map();
  /** @type {Set<(state: string) => void>} */
  const connection_handlers = new Set();
  const view = {
    load: vi.fn(() => Promise.resolve()),
    unload: vi.fn(),
    destroy: vi.fn()
  };
  /** @type {{ current: { gotoIssue: (id: string) => void } | null }} */
  const options = { current: null };
  const client = {
    async send() {
      return null;
    },
    /**
     * @param {string} type
     * @param {(payload: unknown) => void} handler
     */
    on(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    /** @param {(state: string) => void} handler */
    onConnection(handler) {
      connection_handlers.add(handler);
      return () => connection_handlers.delete(handler);
    },
    /** @param {string} state */
    emitConnection(state) {
      for (const handler of connection_handlers) {
        handler(state);
      }
    },
    close: vi.fn(),
    getState() {
      return 'open';
    }
  };
  return { client, handlers, options, view };
});

vi.mock('./ws.js', () => ({
  createWsClient: () => harness.client
}));

vi.mock('./views/agentwatch.js', () => ({
  createAgentwatchView: vi.fn((_mount, options) => {
    harness.options.current = options;
    return harness.view;
  })
}));

describe('Agentwatch shell wiring', () => {
  test('routes, renders the tab, persists the view, and manages lifecycle', async () => {
    window.localStorage.clear();
    window.location.hash = '#/issues';
    document.body.innerHTML = '<nav id="top-nav"></nav><main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await Promise.resolve();

    const link = /** @type {HTMLAnchorElement} */ (
      document.querySelector('a[href="#/agentwatch"]')
    );
    expect(link).not.toBeNull();
    expect(link.querySelector('.agentwatch-new-badge')?.textContent).toBe(
      'New'
    );
    expect(link.previousElementSibling?.textContent).toContain('Board');

    const route = /** @type {HTMLElement} */ (
      document.getElementById('agentwatch-root')
    );
    expect(route.hidden).toBe(true);

    window.location.hash = '#/agentwatch';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await Promise.resolve();
    expect(route.hidden).toBe(false);
    expect(harness.view.load).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('beads-ui.view')).toBe('agentwatch');

    // A fresh socket has no server-side watcher. Session restore resets the
    // view before loading it again, which avoids duplicate watchers.
    harness.client.emitConnection('reconnecting');
    harness.client.emitConnection('open');
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.view.load).toHaveBeenCalledTimes(2);
    expect(harness.view.unload).toHaveBeenCalledTimes(1);

    window.location.hash = '#/board';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(route.hidden).toBe(true);
    expect(harness.view.unload).toHaveBeenCalledTimes(2);
  });

  test('passes Agentwatch issue navigation through the active route', () => {
    window.location.hash = '#/agentwatch';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    harness.options.current?.gotoIssue('AW-1');
    expect(window.location.hash).toBe('#/agentwatch?issue=AW-1');
  });
});
