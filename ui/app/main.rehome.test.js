import { describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

/**
 * Accounts mode (feads): the server re-homes a socket off a board its user
 * cannot read while answering the page's first subscribe, and announces it
 * with `workspace-changed`. The board's list subscriptions are still in flight
 * at that moment; the page must end up subscribed on the new board instead of
 * waiting forever on stores it tore down.
 */

/** @type {Array<{ type: string, payload: any, resolve: (v: any) => void }>} */
const sent = [];
/** @type {Map<string, (payload: any) => void>} */
const handlers = new Map();

vi.mock('./ws.js', () => ({
  createWsClient: () => ({
    /**
     * @param {string} type
     * @param {any} payload
     */
    send(type, payload) {
      return new Promise((resolve) => {
        sent.push({ type, payload, resolve });
        if (type !== 'subscribe-list') resolve(null);
      });
    },
    /**
     * @param {string} type
     * @param {(payload: any) => void} fn
     */
    on(type, fn) {
      handlers.set(type, fn);
      return () => {};
    },
    close() {},
    getState() {
      return 'open';
    }
  })
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('re-home during the first subscribe (accounts mode)', () => {
  test('board subscriptions in flight at a workspace change are re-established on the new board', async () => {
    window.location.hash = '#/board';
    document.body.innerHTML = '<main id="app"></main>';
    bootstrap(/** @type {HTMLElement} */ (document.getElementById('app')));
    await tick();
    await tick();

    const boardSubs = () =>
      sent.filter(
        (m) =>
          m.type === 'subscribe-list' &&
          String(m.payload?.id || '').startsWith('tab:board:')
      );
    const first = boardSubs();
    expect(first.length).toBeGreaterThan(0);

    // The server re-homes the socket while those subscribes are in flight...
    handlers.get('workspace-changed')?.({
      root_dir: '/boards/team_b-lab',
      board_id: 'team_b-lab',
      key: 'team_b-lab',
      name: 'team_b-lab'
    });
    await tick();
    // ...then answers every subscribe it had in flight.
    for (const m of sent.filter((x) => x.type === 'subscribe-list')) {
      m.resolve({ id: m.payload.id, key: m.payload.type });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    const ids = first.map((m) => m.payload.id);
    for (const id of ids) {
      const count = boardSubs().filter((m) => m.payload.id === id).length;
      expect(count, id).toBe(2);
    }
  });
});
