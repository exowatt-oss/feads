import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

/**
 * feads: the app shell's notification wiring.
 *
 * The bell's own behaviour is covered in `views/notification-bell.test.js`.
 * What is unproven until here is that the shell mounts it at all, hands it a
 * socket whose `notification` pushes reach it, and — the part that is easy to
 * get wrong — that a page with no agent neither shows a bell nor asks the
 * server for a list nobody is the recipient of.
 */

/** What the stub `whoami` answers. Mutated per test. */
/** @type {Record<string, any>} */
let whoami_reply = {
  identity: null,
  mode: 'operator',
  stance: 'operator',
  require_identity: false
};

/** Every request the shell made. */
/** @type {Array<{ type: string, payload: any }>} */
let sent = [];

/** @type {Record<string, Array<(p: any) => void>>} */
let handlers = {};

vi.mock('./ws.js', () => ({
  createWsClient: () => ({
    /**
     * @param {string} type
     * @param {any} payload
     * @returns {Promise<any>}
     */
    async send(type, payload) {
      sent.push({ type, payload });
      if (type === 'whoami') {
        return whoami_reply;
      }
      if (type === 'list-notifications') {
        return {
          notifications: [
            {
              id: 'n1',
              recipient_actor: 'alice',
              type: 'mention',
              issue_id: 'ex-abc',
              actor: 'bob',
              snippet: 'hey @alice',
              created_at: Date.now(),
              read_at: 0
            }
          ],
          unread_count: 1,
          actor: 'alice'
        };
      }
      return null;
    },
    /**
     * @param {string} type
     * @param {(p: any) => void} handler
     */
    on(type, handler) {
      handlers[type] = handlers[type] || [];
      handlers[type].push(handler);
      return () => {};
    },
    close() {},
    getState() {
      return 'open';
    }
  })
}));

/**
 * `whoami` is a round trip, the store notification another and the bell's own
 * fetch a third, so a handful of microtasks are needed before the header
 * settles.
 */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function boot() {
  window.location.hash = '#/issues';
  document.body.innerHTML =
    '<nav id="top-nav"></nav>' +
    '<div id="notification-bell"></div>' +
    '<div id="identity-chip"></div>' +
    '<main id="app"></main>';
  const root = /** @type {HTMLElement} */ (document.getElementById('app'));
  bootstrap(root);
  return root;
}

describe('app shell notification wiring', () => {
  beforeEach(() => {
    sent = [];
    handlers = {};
    document.documentElement.removeAttribute('data-identity-actor');
    whoami_reply = {
      identity: null,
      mode: 'operator',
      stance: 'operator',
      require_identity: false
    };
  });

  test('no bell and no request without an agent', async () => {
    boot();
    await settle();

    const mount = document.getElementById('notification-bell');
    expect(mount?.querySelector('.notif__bell')).toBeFalsy();
    expect(sent.some((c) => c.type === 'list-notifications')).toBe(false);
    expect(document.documentElement.dataset.identityActor).toBe('');
  });

  test('a signed-in agent gets a bell, a badge and a live push', async () => {
    whoami_reply = {
      identity: {
        agent_id: 'a1',
        actor: 'alice',
        display_name: 'Alice',
        role: 'user',
        board_id: 'example',
        last_seen_at: Date.now()
      },
      mode: 'agent',
      stance: 'operator',
      require_identity: false
    };

    boot();
    await settle();

    const mount = /** @type {HTMLElement} */ (
      document.getElementById('notification-bell')
    );
    expect(mount.querySelector('.notif__bell')).toBeTruthy();
    expect(mount.querySelector('.notif__badge')?.textContent).toBe('1');
    expect(sent.some((c) => c.type === 'list-notifications')).toBe(true);
    // The document names the actor, which is how a comment knows a mention is
    // the reader's own.
    expect(document.documentElement.dataset.identityActor).toBe('alice');

    // A push over the same socket reaches the bell.
    for (const fn of handlers['notification'] || []) {
      fn({
        type: 'notification',
        notification: {
          id: 'n2',
          recipient_actor: 'alice',
          type: 'assigned',
          issue_id: 'ex-def',
          actor: 'bob',
          snippet: 'yours now',
          created_at: Date.now(),
          read_at: 0
        },
        unread_count: 4
      });
    }
    await settle();

    expect(mount.querySelector('.notif__badge')?.textContent).toBe('4');
  });
});
