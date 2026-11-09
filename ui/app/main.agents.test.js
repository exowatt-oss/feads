import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';
import { showToast } from './utils/toast.js';

/**
 * feads: the app shell's agent wiring — `whoami` on boot, the conditional
 * header tab, and the `#/agents` route.
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
      if (type === 'list-agents') {
        return {
          agents: [
            {
              agent_id: 'ag_1',
              actor: 'laptop-claude',
              display_name: 'Laptop Claude',
              role: 'user',
              board_id: 'example',
              host: 'macbook',
              workspace_dir: '/w',
              session_id: 'sess-1',
              kind: 'agent',
              registered_at: 1753718400000,
              last_seen_at: 1753718400000,
              revoked_at: 0,
              revoke_reason: ''
            }
          ],
          scope: 'all',
          board_id: 'example',
          reason: 'operator mode'
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

/**
 * Let the boot round trips settle. `whoami` and the roster fetch are each a
 * promise chain, not a single microtask.
 */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('agents view wiring', () => {
  beforeEach(() => {
    // `restoreMocks` restores spies, not the call history of a `vi.fn()` created
    // in a module factory — the toast assertions below would otherwise see the
    // previous test's calls.
    vi.clearAllMocks();
    whoami_reply = {
      identity: null,
      mode: 'operator',
      require_identity: false,
      credential_rejected: false
    };
  });

  test('asks whoami on boot and offers the tab in operator mode', async () => {
    sent.length = 0;
    window.location.hash = '#/issues';
    document.body.innerHTML = '<nav id="top-nav"></nav><main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await settle();

    expect(sent).toContain('whoami');
    const tabs = Array.from(document.querySelectorAll('#top-nav a.tab')).map(
      (a) => String(a.textContent).trim()
    );
    expect(tabs).toContain('Agents');
  });

  test('#/agents shows the roster and hides the issue routes', async () => {
    sent.length = 0;
    window.location.hash = '#/agents';
    document.body.innerHTML = '<nav id="top-nav"></nav><main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await settle();

    const agents_root = /** @type {HTMLElement} */ (
      document.getElementById('agents-root')
    );
    const issues_root = /** @type {HTMLElement} */ (
      document.getElementById('issues-root')
    );
    expect(agents_root.hidden).toBe(false);
    expect(issues_root.hidden).toBe(true);
    expect(sent).toContain('list-agents');
    expect(agents_root.querySelector('.agents-row')).not.toBeNull();
    expect(String(agents_root.textContent)).toContain('laptop-claude');
  });

  test('a rejected credential is announced and gets no tab', async () => {
    // Reads are not gated, so a rejected caller still sees the board. Without
    // the toast it would notice nothing until a delete failed — and the likeliest
    // cause is that this agent was revoked.
    whoami_reply = {
      identity: null,
      mode: 'rejected',
      require_identity: false,
      credential_rejected: true
    };
    sent.length = 0;
    window.location.hash = '#/issues';
    document.body.innerHTML = '<nav id="top-nav"></nav><main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await settle();

    const tabs = Array.from(document.querySelectorAll('#top-nav a.tab')).map(
      (a) => String(a.textContent).trim()
    );
    expect(tabs).not.toContain('Agents');
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
      'error',
      expect.any(Number)
    );
  });

  test('operator mode is announced with no error toast', async () => {
    sent.length = 0;
    window.location.hash = '#/issues';
    document.body.innerHTML = '<nav id="top-nav"></nav><main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await settle();

    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
      'error',
      expect.any(Number)
    );
  });

  test('leaving the agents view hides it again', async () => {
    sent.length = 0;
    window.location.hash = '#/agents';
    document.body.innerHTML = '<nav id="top-nav"></nav><main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await settle();

    window.location.hash = '#/issues';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await settle();

    const agents_root = /** @type {HTMLElement} */ (
      document.getElementById('agents-root')
    );
    expect(agents_root.hidden).toBe(true);
  });
});
