import { describe, expect, test } from 'vitest';
import { createSubscriptionIssueStore } from '../data/subscription-issue-store.js';
import { createBoardView } from './board.js';

/**
 * The All-boards card eyebrow: which board, then which epic. The board is the
 * fact a reader scans for there, so it gets its own label element (which the
 * stylesheet keeps at its natural width) and the full name on hover, while the
 * epic title is the part that truncates.
 */
function stores() {
  /** @type {Map<string, any>} */
  const map = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @param {string} id */
  function getStore(id) {
    let s = map.get(id);
    if (!s) {
      s = createSubscriptionIssueStore(id);
      map.set(id, s);
      s.subscribe(() => {
        for (const fn of Array.from(listeners)) fn();
      });
    }
    return s;
  }
  return {
    getStore,
    /** @param {string} id */
    snapshotFor: (id) => getStore(id).snapshot().slice(),
    /** @param {() => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

describe('board card chips', () => {
  test('board chip and epic chip each carry a label element and a full-name title', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const now = Date.now();
    const s = stores();
    s.getStore('tab:board:ready').applyPush({
      type: 'snapshot',
      id: 'tab:board:ready',
      revision: 1,
      issues: [
        {
          id: 'ultron-1',
          title: 'Rebuild the carrier',
          issue_type: 'epic',
          priority: 1,
          created_at: now,
          updated_at: now,
          board_id: 'project-ultron',
          board_name: 'Project Ultron'
        },
        {
          id: 'ultron-2',
          title: 'Route carrier board and correct Teensy footprint',
          issue_type: 'task',
          parent: 'ultron-1',
          priority: 1,
          created_at: now,
          updated_at: now,
          board_id: 'project-ultron',
          board_name: 'Project Ultron'
        }
      ]
    });
    const view = createBoardView(
      mount,
      null,
      () => {},
      undefined,
      undefined,
      s
    );
    await view.load();
    const card = /** @type {HTMLElement} */ (
      mount.querySelector('[data-issue-id="ultron-2"]')
    );
    const board = /** @type {HTMLElement} */ (
      card.querySelector('.board-chip')
    );
    expect(board.querySelector('.board-chip__label')?.textContent).toBe(
      'Project Ultron'
    );
    expect(board.title).toBe('Board: Project Ultron');
    const epic = /** @type {HTMLElement} */ (card.querySelector('.epic-chip'));
    expect(epic.querySelector('.epic-chip__label')?.textContent).toBe(
      'Rebuild the carrier'
    );
    expect(epic.title).toContain('Rebuild the carrier');
    // Board first: it is the one that keeps its width.
    expect(board.compareDocumentPosition(epic)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
