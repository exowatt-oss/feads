import { describe, expect, test, vi } from 'vitest';
import { createSubscriptionIssueStores } from '../data/subscription-issue-stores.js';
import { createBoardView } from './board.js';

/**
 * Real stores, registered the way main.js registers them before subscribing.
 */
function registeredStores() {
  const stores = createSubscriptionIssueStores();
  stores.register('tab:board:ready', { type: 'ready-issues' });
  stores.register('tab:board:blocked', { type: 'blocked-issues' });
  stores.register('tab:board:in-progress', { type: 'in-progress-issues' });
  stores.register('tab:board:closed', { type: 'closed-issues' });
  return stores;
}

/**
 * @param {ReturnType<typeof createSubscriptionIssueStores>} stores
 * @param {string} id
 * @param {any[]} issues
 */
function snapshot(stores, id, issues) {
  stores.getStore(id)?.applyPush({ type: 'snapshot', id, revision: 1, issues });
}

describe('views/board loading states (feads)', () => {
  test('a column waiting for its first snapshot shows placeholders, not empty copy', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const stores = registeredStores();
    const view = createBoardView(
      mount,
      null,
      () => {},
      undefined,
      undefined,
      stores
    );
    await view.load();

    const ready = /** @type {HTMLElement} */ (
      mount.querySelector('#ready-col')
    );
    expect(ready.getAttribute('aria-busy')).toBe('true');
    expect(
      ready.querySelectorAll('.board-skeleton-card').length
    ).toBeGreaterThan(0);
    expect(ready.querySelector('.board-column__empty')).toBeNull();
    // Placeholders are not cards: keyboard navigation must never land on one.
    expect(ready.querySelectorAll('.board-card').length).toBe(0);

    snapshot(stores, 'tab:board:ready', [
      {
        id: 'R-1',
        title: 'ready one',
        priority: 1,
        updated_at: 1,
        created_at: 1
      }
    ]);
    snapshot(stores, 'tab:board:blocked', []);

    expect(ready.getAttribute('aria-busy')).toBe('false');
    expect(ready.querySelectorAll('.board-skeleton-card').length).toBe(0);
    expect(ready.querySelectorAll('.board-card').length).toBe(1);
    // A loaded-but-empty column says it is empty.
    const blocked = /** @type {HTMLElement} */ (
      mount.querySelector('#blocked-col')
    );
    expect(blocked.getAttribute('aria-busy')).toBe('false');
    expect(blocked.querySelector('.board-column__empty')).not.toBeNull();
    // Columns still in flight keep their placeholders.
    const in_progress = /** @type {HTMLElement} */ (
      mount.querySelector('#in-progress-col')
    );
    expect(in_progress.getAttribute('aria-busy')).toBe('true');
  });

  test('stores without isLoaded (older doubles) keep the old empty copy', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const stores = {
      snapshotFor: () => [],
      subscribe: () => () => {}
    };
    const view = createBoardView(
      mount,
      null,
      () => {},
      undefined,
      undefined,
      stores
    );
    await view.load();
    expect(
      mount.querySelector('#ready-col .board-column__empty')
    ).not.toBeNull();
    expect(mount.querySelectorAll('.board-skeleton-card').length).toBe(0);
  });

  test('a dropped card shows the move as pending until the server answers', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const stores = registeredStores();
    for (const id of [
      'tab:board:blocked',
      'tab:board:in-progress',
      'tab:board:closed'
    ]) {
      snapshot(stores, id, []);
    }
    snapshot(stores, 'tab:board:ready', [
      {
        id: 'R-1',
        title: 'ready one',
        priority: 1,
        updated_at: 1,
        created_at: 1
      }
    ]);
    /** @type {(v?: unknown) => void} */
    let answer = () => {};
    const transport = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const view = createBoardView(
      mount,
      null,
      () => {},
      undefined,
      undefined,
      stores,
      transport
    );
    await view.load();

    const target = /** @type {HTMLElement} */ (
      mount.querySelector('#in-progress-col')
    );
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { getData: () => 'R-1', dropEffect: 'move' }
    });
    target.dispatchEvent(drop);

    const card = () =>
      /** @type {HTMLElement} */ (mount.querySelector('[data-issue-id="R-1"]'));
    expect(transport).toHaveBeenCalledWith('update-status', {
      id: 'R-1',
      status: 'in_progress'
    });
    expect(card().classList.contains('is-pending')).toBe(true);
    expect(card().getAttribute('aria-busy')).toBe('true');

    answer({});
    await new Promise((r) => setTimeout(r, 0));
    expect(card().classList.contains('is-pending')).toBe(false);
  });
});
