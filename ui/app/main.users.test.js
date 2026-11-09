import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

/**
 * feads: the app shell's wiring for the actor directory — the `#/users` route
 * and the tab that leads to it.
 *
 * Separate from `main.agents.test.js` because the point of this view is the one
 * thing that file's subject is not: it is offered to every tier, including a
 * `user` whose credential hides the roster.
 */

/** @type {string[]} */
const sent = [];

/**
 * What the stub `whoami` answers. Mutated per test.
 *
 * @type {{ identity: any, mode: string, require_identity: boolean, credential_rejected: boolean }}
 */
let whoami_reply = {
  identity: null,
  mode: 'operator',
  require_identity: false,
  credential_rejected: false
};

vi.mock('./utils/toast.js', () => ({
  showToast: vi.fn()
}));

vi.mock('./ws.js', () => ({
  createWsClient: () => ({
    /**
     * @param {string} type
     * @returns {Promise<any>}
     */
    async send(type) {
      sent.push(type);
      if (type === 'whoami') {
        return whoami_reply;
      }
      if (type === 'list-users') {
        return {
          users: [
            {
              actor: 'laptop-claude',
              display_name: 'Laptop Claude',
              role: 'user',
              kind: 'agent',
              board_id: 'example',
              registered_at: 1753718400000,
              last_seen_at: 1753718400000
            }
          ]
        };
      }
      return null;
    },
    on() {
      return () => {};
    },
    close() {},
    getState() {
      return 'open';
    }
  })
}));

/** Let the boot round trips settle; each is a promise chain, not one microtask. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('users view wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    whoami_reply = {
      identity: null,
      mode: 'operator',
      require_identity: false,
      credential_rejected: false
    };
  });

  test('#/users shows the directory and hides the issue routes', async () => {
    window.location.hash = '#/users';
    document.body.innerHTML = '<nav id="top-nav"></nav><main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await settle();

    const users_root = /** @type {HTMLElement} */ (
      document.getElementById('users-root')
    );
    const issues_root = /** @type {HTMLElement} */ (
      document.getElementById('issues-root')
    );
    expect(users_root.hidden).toBe(false);
    expect(issues_root.hidden).toBe(true);
    expect(sent).toContain('list-users');
    expect(users_root.querySelector('.users-row')).not.toBeNull();
    expect(String(users_root.textContent)).toContain('laptop-claude');
  });

  test('the tab is offered to a `user`, who has no Agents tab', async () => {
    whoami_reply = {
      identity: {
        actor: 'laptop-claude',
        display_name: 'Laptop Claude',
        role: 'user'
      },
      mode: 'agent',
      require_identity: false,
      credential_rejected: false
    };
    window.location.hash = '#/issues';
    document.body.innerHTML = '<nav id="top-nav"></nav><main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await settle();

    const tabs = Array.from(document.querySelectorAll('#top-nav a.tab')).map(
      (a) => String(a.textContent).trim()
    );
    expect(tabs).toContain('Users');
    expect(tabs).not.toContain('Agents');
  });

  test('leaving the users view hides it again', async () => {
    window.location.hash = '#/users';
    document.body.innerHTML = '<nav id="top-nav"></nav><main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await settle();

    window.location.hash = '#/issues';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await settle();

    const users_root = /** @type {HTMLElement} */ (
      document.getElementById('users-root')
    );
    expect(users_root.hidden).toBe(true);
  });
});
