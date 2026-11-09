import { describe, expect, test } from 'vitest';
import { createDetailView } from './detail.js';

/**
 * An issue the server refused (another department's board, a deleted id) is
 * explained once and stays explained: a later re-render must not put
 * "Loading…" back over the reason for content that will never arrive.
 */
describe('views/detail: an unavailable issue', () => {
  test('the explanation survives the store push that follows it', async () => {
    document.body.innerHTML =
      '<section class="panel"><div id="mount"></div></section>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    /** @type {Array<() => void>} */
    const listeners = [];
    const stores = {
      snapshotFor() {
        return [];
      },
      /** @param {() => void} fn */
      subscribe(fn) {
        listeners.push(fn);
        return () => {};
      }
    };
    const view = createDetailView(
      mount,
      async () => ({}),
      () => {},
      stores
    );
    await view.load('feads-302');
    expect(mount.textContent).toContain('Loading');

    view.showError('feads-302 is not on a board you can open.');
    for (const fn of listeners) fn();
    expect(mount.textContent).toContain('not on a board you can open');
    expect(mount.textContent).not.toContain('Loading');

    // Opening another issue starts fresh.
    await view.load('opt-302');
    expect(mount.textContent).toContain('Loading');
  });
});
