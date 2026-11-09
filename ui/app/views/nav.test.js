import { describe, expect, test, vi } from 'vitest';
import { createTopNav } from './nav.js';

function setup() {
  document.body.innerHTML = '<div id="m"></div>';
  const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
  const store = {
    state: { view: 'issues' },
    getState() {
      return this.state;
    },
    /** @param {any} v */
    set(v) {
      this.state = { ...this.state, ...v };
    },
    /** @param {(s: any) => void} fn */
    subscribe(fn) {
      // simplistic subscription for test
      this._fn = fn;
      return () => void 0;
    },
    _fn: /** @type {(s: any) => void} */ (() => {})
  };
  const router = { gotoView: vi.fn() };
  return { mount, store, router };
}

describe('views/nav', () => {
  test('renders and routes between tabs', async () => {
    const { mount, store, router } = setup();
    createTopNav(
      mount,
      /** @type {any} */ (store),
      /** @type {any} */ (router)
    );
    const links = mount.querySelectorAll('a.tab');
    expect(links.length).toBe(5);
    links[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(router.gotoView).toHaveBeenCalledWith('epics');
    links[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(router.gotoView).toHaveBeenCalledWith('board');
  });

  // feads: the actor directory is offered to everybody, including a store with
  // no identity slice at all — an unidentified reader is exactly who needs to
  // look a handle up before mentioning it.
  test('offers the Users tab with no identity at all', () => {
    const { mount, store, router } = setup();
    createTopNav(
      mount,
      /** @type {any} */ (store),
      /** @type {any} */ (router)
    );

    const links = Array.from(mount.querySelectorAll('a.tab'));
    expect(links.map((a) => String(a.textContent).trim())).toEqual([
      'Issues',
      'Epics',
      'Board',
      'Agentwatch New',
      'Users'
    ]);
    links[4].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(router.gotoView).toHaveBeenCalledWith('users');
  });

  // feads: the Agents tab is conditional on identity. The four-tab assertion
  // above doubles as the "before whoami has answered" case — that store has no
  // identity slice at all, which must not render the tab.
  test('offers the Agents tab in operator mode', () => {
    const { mount, store, router } = setup();
    store.set({ identity: { loaded: true, mode: 'operator', agent: null } });
    createTopNav(
      mount,
      /** @type {any} */ (store),
      /** @type {any} */ (router)
    );

    const links = mount.querySelectorAll('a.tab');
    expect(links.length).toBe(7);
    links[5].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(router.gotoView).toHaveBeenCalledWith('agents');
    links[6].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(router.gotoView).toHaveBeenCalledWith('admin');
  });

  test('offers the Agents tab to an admin', () => {
    const { mount, store, router } = setup();
    store.set({
      identity: { loaded: true, mode: 'agent', agent: { role: 'admin' } }
    });
    createTopNav(
      mount,
      /** @type {any} */ (store),
      /** @type {any} */ (router)
    );

    expect(mount.querySelectorAll('a.tab').length).toBe(7);
  });

  test('withholds the Agents tab from a user', () => {
    const { mount, store, router } = setup();
    store.set({
      identity: { loaded: true, mode: 'agent', agent: { role: 'user' } }
    });
    createTopNav(
      mount,
      /** @type {any} */ (store),
      /** @type {any} */ (router)
    );

    expect(mount.querySelectorAll('a.tab').length).toBe(5);
  });

  test('keeps Agentwatch visible for an identified agent on a deny-stance deployment', () => {
    const { mount, store, router } = setup();
    store.set({
      identity: {
        loaded: true,
        mode: 'agent',
        stance: 'deny',
        agent: { role: 'user' }
      }
    });
    createTopNav(
      mount,
      /** @type {any} */ (store),
      /** @type {any} */ (router)
    );

    expect(mount.querySelector('a[href="#/agentwatch"]')).not.toBeNull();
  });
});
