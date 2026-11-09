import { describe, expect, test, vi } from 'vitest';
import { createWorkspacePicker } from './workspace-picker.js';

/**
 * Minimal store: state in, subscribers notified on set.
 *
 * @param {any} initial
 */
function makeStore(initial) {
  let state = initial;
  /** @type {Set<(s: any) => void>} */
  const subs = new Set();
  return {
    getState: () => state,
    /** @param {any} patch */
    setState(patch) {
      state = { ...state, ...patch };
      for (const fn of subs) fn(state);
    },
    /** @param {(s: any) => void} fn */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    }
  };
}

/**
 * @param {Partial<import('../state.js').WorkspaceInfo>} overrides
 * @returns {any}
 */
function board(overrides) {
  return {
    path: '/data/boards/x',
    database: '/data/boards/x/.beads',
    key: 'x',
    id: 'x',
    name: 'X',
    description: '',
    repos: [],
    board_dir: '/data/boards/x/.beads',
    exists: true,
    ...overrides
  };
}

/**
 * @param {any[]} available
 * @param {any} [current]
 */
function mountPicker(available, current = available[1] || available[0]) {
  document.body.innerHTML = '<div id="m"></div>';
  const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
  const store = makeStore({ workspace: { current, available } });
  const on_change = vi.fn(async () => {});
  const picker = createWorkspacePicker(mount, store, on_change);
  return { mount, store, on_change, picker };
}

const boards = [
  board({
    key: '*',
    id: '*',
    name: 'All boards',
    path: '',
    board_dir: '',
    description: 'Everything across every board, in one view.'
  }),
  board({
    key: 'alpha',
    id: 'alpha',
    name: 'Alpha',
    description: 'Lab cross-repo coordination',
    repos: ['example-lab/sample-controller', 'example-lab/cloud-lab-api']
  }),
  board({
    key: 'bravo',
    id: 'bravo',
    name: 'Bravo',
    description: 'Tooling experiments',
    repos: ['example-org/feads']
  })
];

describe('views/workspace-picker', () => {
  test('renders a trigger naming the current board, menu closed', () => {
    const { mount } = mountPicker(boards);
    const trigger = mount.querySelector('.board-menu__trigger');
    expect(trigger).toBeTruthy();
    expect(trigger?.textContent).toContain('Alpha');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(mount.querySelector('.board-menu')).toBeNull();
  });

  test('opening the menu shows every board with its purpose and repos', () => {
    const { mount } = mountPicker(boards);
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.board-menu__trigger')
    ).click();
    const menu = mount.querySelector('.board-menu');
    expect(menu).toBeTruthy();
    const options = Array.from(mount.querySelectorAll('.board-menu__option'));
    expect(options.length).toBe(3);
    const bravo = options.find((o) => String(o.textContent).includes('Bravo'));
    expect(bravo?.textContent).toContain('Tooling experiments');
    expect(bravo?.textContent).toContain('feads');
  });

  test('the All-boards entry leads the menu, marked apart from real boards', () => {
    const { mount } = mountPicker(boards);
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.board-menu__trigger')
    ).click();
    const options = Array.from(mount.querySelectorAll('.board-menu__option'));
    expect(options[0].textContent).toContain('All boards');
    expect(options[0].classList.contains('board-menu__option--all')).toBe(true);
    expect(mount.querySelector('.board-menu__divider')).toBeTruthy();
  });

  test('choosing a board fires the change callback and closes the menu', () => {
    const { mount, on_change } = mountPicker(boards);
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.board-menu__trigger')
    ).click();
    const bravo = /** @type {HTMLElement} */ (
      Array.from(mount.querySelectorAll('.board-menu__option')).find((o) =>
        String(o.textContent).includes('Bravo')
      )
    );
    bravo.click();
    expect(on_change).toHaveBeenCalledWith('bravo');
    expect(mount.querySelector('.board-menu')).toBeNull();
  });

  test('choosing the current board is a no-op', () => {
    const { mount, on_change } = mountPicker(boards);
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.board-menu__trigger')
    ).click();
    const alpha = /** @type {HTMLElement} */ (
      Array.from(mount.querySelectorAll('.board-menu__option')).find((o) =>
        String(o.textContent).includes('Alpha')
      )
    );
    alpha.click();
    expect(on_change).not.toHaveBeenCalled();
  });

  test('a missing board is offered but not selectable', () => {
    const with_missing = [
      ...boards,
      board({ key: 'ghost', id: 'ghost', name: 'Ghost', exists: false })
    ];
    const { mount, on_change } = mountPicker(with_missing);
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.board-menu__trigger')
    ).click();
    const ghost = /** @type {HTMLElement} */ (
      Array.from(mount.querySelectorAll('.board-menu__option')).find((o) =>
        String(o.textContent).includes('Ghost')
      )
    );
    expect(ghost.getAttribute('aria-disabled')).toBe('true');
    ghost.click();
    expect(on_change).not.toHaveBeenCalled();
  });

  test('Escape closes the menu', () => {
    const { mount } = mountPicker(boards);
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.board-menu__trigger')
    ).click();
    expect(mount.querySelector('.board-menu')).toBeTruthy();
    const picker_el = /** @type {HTMLElement} */ (
      mount.querySelector('.workspace-picker')
    );
    picker_el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(mount.querySelector('.board-menu')).toBeNull();
  });

  test('a single board renders as a plain label, no menu', () => {
    const { mount } = mountPicker([boards[1]], boards[1]);
    expect(mount.querySelector('.board-menu__trigger')).toBeNull();
    expect(
      mount.querySelector('.workspace-picker__label')?.textContent
    ).toContain('Alpha');
  });
});
