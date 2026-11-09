import { describe, expect, test } from 'vitest';
import { createSubscriptionIssueStore } from '../data/subscription-issue-store.js';
import { createBoardView } from './board.js';

/**
 * Minimal push-store harness, mirroring board.closed-filter.test.js.
 *
 * @returns {any}
 */
function createTestIssueStores() {
  /** @type {Map<string, any>} */
  const stores = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /**
   * @param {string} id
   * @returns {any}
   */
  function getStore(id) {
    let s = stores.get(id);
    if (!s) {
      s = createSubscriptionIssueStore(id);
      stores.set(id, s);
      s.subscribe(() => {
        for (const fn of Array.from(listeners)) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
      });
    }
    return s;
  }
  return {
    getStore,
    /** @param {string} id */
    snapshotFor(id) {
      return getStore(id).snapshot().slice();
    },
    /** @param {() => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

describe('views/board creator badge', () => {
  test('every card names the actor that filed it, with the full value in the tooltip', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));

    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:board:in-progress').applyPush({
      type: 'snapshot',
      id: 'tab:board:in-progress',
      revision: 1,
      issues: [
        {
          id: 'ex-dh0',
          title: 'feads UI: board selection is daemon-global',
          status: 'in_progress',
          issue_type: 'bug',
          priority: 2,
          created_by: 'mira@example.test'
        },
        {
          id: 'ex-qtn',
          title: 'feads: let an agent sign itself up over MCP',
          status: 'in_progress',
          issue_type: 'task',
          priority: 3,
          created_by: 'laptop-claude'
        }
      ]
    });

    const view = createBoardView(
      mount,
      null,
      () => {},
      undefined,
      undefined,
      issueStores
    );
    await view.load();

    const badges = Array.from(
      mount.querySelectorAll(
        '#in-progress-col .board-card .board-card__creator'
      )
    );
    expect(badges).toHaveLength(0);
    expect(
      Array.from(mount.querySelectorAll('#in-progress-col .actor-chip')).map(
        (el) => el.textContent?.trim()
      )
    ).toEqual(['mira@e…le.test', 'laptop-claude']);
  });

  test('an item filed before actor attribution still renders a card', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));

    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:board:in-progress').applyPush({
      type: 'snapshot',
      id: 'tab:board:in-progress',
      revision: 1,
      issues: [
        { id: 'ex-old', title: 'no creator recorded', status: 'in_progress' }
      ]
    });

    const view = createBoardView(
      mount,
      null,
      () => {},
      undefined,
      undefined,
      issueStores
    );
    await view.load();

    const card = mount.querySelector('#in-progress-col .board-card');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.board-card__creator')).toBeNull();
  });
});
