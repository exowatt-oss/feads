/**
 * feads addition — the notification bell.
 *
 * Two failure modes drive most of these cases: a bell that talks to the server
 * on behalf of a browser with no identity (every visitor pays for a list that
 * is empty by construction), and a badge that counts locally and drifts from
 * the server the first time anything else acks a row.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { setOwnerDirectory } from '../utils/owners.js';
import { setPeopleDirectory } from '../utils/people.js';
import { createNotificationBell } from './notification-bell.js';

/**
 * @param {string} actor
 */
function makeStore(actor = 'alice') {
  const state = {
    view: 'issues',
    selected_id: null,
    identity: {
      loaded: actor.length > 0,
      agent: actor ? { agent_id: 'a1', actor, role: 'user' } : null,
      mode: actor ? 'agent' : 'operator',
      stance: 'operator',
      require_identity: false
    }
  };
  /** @type {Array<(s: any) => void>} */
  const listeners = [];
  return {
    getState: () => /** @type {any} */ (state),
    /** @param {(s: any) => void} fn */
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) {
          listeners.splice(i, 1);
        }
      };
    },
    /** @param {Record<string, any>} patch */
    setIdentity(patch) {
      state.identity = /** @type {any} */ ({ ...state.identity, ...patch });
      for (const fn of [...listeners]) {
        fn(state);
      }
    }
  };
}

/**
 * A socket double that hands back the handler it was given.
 */
function makeClient() {
  /** @type {Record<string, Array<(p: any) => void>>} */
  const handlers = {};
  return {
    /**
     * @param {string} type
     * @param {(p: any) => void} handler
     */
    on(type, handler) {
      handlers[type] = handlers[type] || [];
      handlers[type].push(handler);
      return () => {
        handlers[type] = handlers[type].filter((h) => h !== handler);
      };
    },
    /**
     * @param {string} type
     * @param {any} payload
     */
    push(type, payload) {
      for (const fn of handlers[type] || []) {
        fn(payload);
      }
    },
    /** @param {string} type */
    count(type) {
      return (handlers[type] || []).length;
    }
  };
}

/**
 * @param {number} count
 * @param {any[]} [notifications]
 */
function makeSend(count = 0, notifications = []) {
  /** @type {Array<{ type: string, payload: any }>} */
  const calls = [];
  let unread = count;
  /**
   * @param {string} type
   * @param {any} payload
   */
  const send = async (type, payload) => {
    calls.push({ type, payload });
    if (type === 'list-notifications') {
      return { notifications, unread_count: unread, actor: 'alice' };
    }
    if (type === 'ack-notifications') {
      const acked = payload?.all ? unread : (payload?.ids || []).length;
      unread = Math.max(0, unread - acked);
      return { acked, unread_count: unread };
    }
    return {};
  };
  return Object.assign(send, {
    calls,
    /** @param {string} type */
    of(type) {
      return calls.filter((c) => c.type === type);
    }
  });
}

/**
 * @param {Record<string, any>} [over]
 */
function makeRow(over = {}) {
  return {
    id: 'n1',
    board_id: 'example',
    recipient_actor: 'alice',
    type: 'mention',
    issue_id: 'ex-abc',
    issue_title: 'Fix the flux capacitor',
    actor: 'bob',
    snippet: 'hey @alice can you look',
    related_issue: '',
    created_at: Date.now() - 60_000,
    read_at: 0,
    url: '#/issues?issue=ex-abc',
    ...over
  };
}

/** @returns {Promise<void>} */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('views/notification-bell', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('renders nothing and asks nothing without an identity', async () => {
    const el = mount();
    const send = makeSend();
    const store = makeStore('');

    createNotificationBell(el, { send, client: makeClient(), store });
    await flush();

    expect(el.querySelector('.notif__bell')).toBeNull();
    expect(send.calls).toEqual([]);
  });

  test('renders nothing for the operator, who is a mode and not an actor', async () => {
    const el = mount();
    const send = makeSend();
    const store = makeStore('');
    store.setIdentity({ loaded: true, agent: null, mode: 'operator' });

    createNotificationBell(el, { send, client: makeClient(), store });
    await flush();

    expect(el.querySelector('.notif__bell')).toBeNull();
    expect(send.calls).toEqual([]);
  });

  test('loads the list once the identity names an actor', async () => {
    const el = mount();
    const send = makeSend(3, [makeRow()]);
    const store = makeStore('');

    createNotificationBell(el, { send, client: makeClient(), store });
    await flush();
    expect(send.calls).toEqual([]);

    store.setIdentity({
      loaded: true,
      agent: { agent_id: 'a1', actor: 'alice', role: 'user' },
      mode: 'agent'
    });
    await flush();

    expect(send.of('list-notifications').length).toBe(1);
    expect(send.of('list-notifications')[0].payload).toEqual({
      unread_only: false,
      limit: 50
    });
    const badge = /** @type {HTMLElement} */ (
      el.querySelector('.notif__badge')
    );
    expect(badge.textContent).toBe('3');
  });

  test('hides the badge at zero and caps it at 99+', async () => {
    const el = mount();
    createNotificationBell(el, {
      send: makeSend(0),
      client: makeClient(),
      store: makeStore()
    });
    await flush();
    expect(el.querySelector('.notif__bell')).toBeTruthy();
    expect(el.querySelector('.notif__badge')).toBeNull();

    const el2 = mount();
    createNotificationBell(el2, {
      send: makeSend(140),
      client: makeClient(),
      store: makeStore()
    });
    await flush();
    expect(el2.querySelector('.notif__badge')?.textContent).toBe('99+');
  });

  test('opens a panel of rows and refetches while opening', async () => {
    const el = mount();
    const send = makeSend(2, [
      makeRow(),
      makeRow({
        id: 'n2',
        type: 'dependency_completed',
        issue_id: 'ex-def',
        snippet: 'ex-zzz closed',
        actor: 'carol'
      })
    ]);
    createNotificationBell(el, {
      send,
      client: makeClient(),
      store: makeStore()
    });
    await flush();

    /** @type {HTMLButtonElement} */ (el.querySelector('.notif__bell')).click();
    await flush();

    expect(el.querySelector('.notif__panel')).toBeTruthy();
    const rows = el.querySelectorAll('.notif__row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('hey @alice can you look');
    expect(rows[0].textContent).toContain('bob');
    expect(rows[0].textContent).toContain('ex-abc');
    // Two fetches: one on identity, one on open.
    expect(send.of('list-notifications').length).toBe(2);
  });

  test('accounts mode: who acted and who was mentioned are hover-only person cards', async () => {
    setOwnerDirectory([
      { actor: 'bob', display_name: 'Bob B', aliases: ['bob-laptop'] }
    ]);
    setPeopleDirectory([
      {
        actor: 'alice',
        email: 'alice@example.test',
        display_name: 'Alice',
        kind: 'human'
      },
      {
        actor: 'bob',
        email: 'bob@example.test',
        display_name: 'Bob B',
        kind: 'human'
      }
    ]);
    try {
      const el = mount();
      const send = makeSend(1, [
        makeRow({ actor: 'bob-laptop', snippet: 'hey @alice see #ex-1' })
      ]);
      createNotificationBell(el, {
        send,
        client: makeClient(),
        store: makeStore()
      });
      await flush();
      /** @type {HTMLButtonElement} */ (
        el.querySelector('.notif__bell')
      ).click();
      await flush();
      const row = /** @type {HTMLElement} */ (el.querySelector('.notif__row'));
      const triggers = Array.from(row.querySelectorAll('[data-person-hover]'));
      expect(triggers.map((t) => t.getAttribute('data-person-hover'))).toEqual([
        'alice',
        'bob'
      ]);
      // Inside a button: no tab stops, no links.
      expect(row.querySelector('[tabindex], a')).toBeNull();
      expect(row.textContent).toContain('hey @alice see #ex-1');
      expect(row.textContent).toContain('bob (via bob-laptop)');
    } finally {
      setOwnerDirectory([]);
      setPeopleDirectory([]);
    }
  });

  test('clicking a row acks just that row and navigates to its issue', async () => {
    const el = mount();
    const send = makeSend(1, [makeRow()]);
    /** @type {string[]} */
    const went = [];
    createNotificationBell(el, {
      send,
      client: makeClient(),
      store: makeStore(),
      gotoIssue: (id) => went.push(id)
    });
    await flush();

    /** @type {HTMLButtonElement} */ (el.querySelector('.notif__bell')).click();
    await flush();
    /** @type {HTMLButtonElement} */ (el.querySelector('.notif__row')).click();
    await flush();

    expect(send.of('ack-notifications').length).toBe(1);
    expect(send.of('ack-notifications')[0].payload).toEqual({ ids: ['n1'] });
    expect(went).toEqual(['ex-abc']);
    // The panel closed behind the click, and the count came back from the ack.
    expect(el.querySelector('.notif__panel')).toBeNull();
    expect(el.querySelector('.notif__badge')).toBeNull();
  });

  test('mark all read acks everything and clears the badge', async () => {
    const el = mount();
    const send = makeSend(2, [makeRow(), makeRow({ id: 'n2' })]);
    createNotificationBell(el, {
      send,
      client: makeClient(),
      store: makeStore()
    });
    await flush();

    /** @type {HTMLButtonElement} */ (el.querySelector('.notif__bell')).click();
    await flush();
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.notif__markall')
    ).click();
    await flush();

    expect(send.of('ack-notifications')[0].payload).toEqual({ all: true });
    expect(el.querySelector('.notif__badge')).toBeNull();
    expect(el.querySelectorAll('.notif__row.is-unread').length).toBe(0);
  });

  test('a pushed notification takes the server count and prepends the row', async () => {
    const el = mount();
    const client = makeClient();
    const send = makeSend(0, []);
    createNotificationBell(el, { send, client, store: makeStore() });
    await flush();
    /** @type {HTMLButtonElement} */ (el.querySelector('.notif__bell')).click();
    await flush();

    client.push('notification', {
      type: 'notification',
      notification: makeRow({
        id: 'n9',
        type: 'assigned',
        snippet: 'yours now'
      }),
      unread_count: 7
    });
    await flush();

    expect(el.querySelector('.notif__badge')?.textContent).toBe('7');
    const rows = el.querySelectorAll('.notif__row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('yours now');
  });

  test('a pushed mention toasts, other types do not', async () => {
    const el = mount();
    const client = makeClient();
    createNotificationBell(el, {
      send: makeSend(0, []),
      client,
      store: makeStore()
    });
    await flush();

    client.push('notification', {
      type: 'notification',
      notification: makeRow({ id: 'n3', type: 'comment_on_owned' }),
      unread_count: 1
    });
    await flush();
    expect(document.querySelector('.toast')).toBeNull();

    client.push('notification', {
      type: 'notification',
      notification: makeRow({ id: 'n4', type: 'mention', actor: 'bob' }),
      unread_count: 2
    });
    await flush();

    const toast = /** @type {HTMLElement} */ (document.querySelector('.toast'));
    expect(toast).toBeTruthy();
    expect(toast.textContent).toBe('@bob mentioned you on #ex-abc');
  });

  test('a push without a count still bumps the badge', async () => {
    const el = mount();
    const client = makeClient();
    createNotificationBell(el, {
      send: makeSend(1, [makeRow()]),
      client,
      store: makeStore()
    });
    await flush();

    client.push('notification', { notification: makeRow({ id: 'n5' }) });
    await flush();

    expect(el.querySelector('.notif__badge')?.textContent).toBe('2');
  });

  test('a push addressed to somebody else is ignored', async () => {
    const el = mount();
    const client = makeClient();
    createNotificationBell(el, {
      send: makeSend(0, []),
      client,
      store: makeStore()
    });
    await flush();
    /** @type {HTMLButtonElement} */ (el.querySelector('.notif__bell')).click();
    await flush();

    client.push('notification', {
      notification: makeRow({ id: 'n6', recipient_actor: 'someone-else' })
    });
    await flush();

    expect(el.querySelectorAll('.notif__row').length).toBe(0);
    expect(el.querySelector('.notif__badge')).toBeNull();
  });

  test('closes on an outside click and on Escape', async () => {
    const el = mount();
    createNotificationBell(el, {
      send: makeSend(1, [makeRow()]),
      client: makeClient(),
      store: makeStore()
    });
    await flush();
    const bell = /** @type {HTMLButtonElement} */ (
      el.querySelector('.notif__bell')
    );

    bell.click();
    await flush();
    expect(el.querySelector('.notif__panel')).toBeTruthy();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(el.querySelector('.notif__panel')).toBeNull();

    bell.click();
    await flush();
    expect(el.querySelector('.notif__panel')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(el.querySelector('.notif__panel')).toBeNull();
  });

  test('a failed list leaves the bell quiet rather than shouting', async () => {
    const el = mount();
    /** @type {any} */
    const send = async () => {
      throw new Error('nope');
    };
    createNotificationBell(el, {
      send,
      client: makeClient(),
      store: makeStore()
    });
    await flush();

    expect(el.querySelector('.notif__bell')).toBeTruthy();
    expect(el.querySelector('.notif__badge')).toBeNull();
    expect(document.querySelector('.toast')).toBeNull();
  });

  test('signing out empties the bell', async () => {
    const el = mount();
    const store = makeStore();
    createNotificationBell(el, {
      send: makeSend(4, [makeRow()]),
      client: makeClient(),
      store
    });
    await flush();
    expect(el.querySelector('.notif__badge')?.textContent).toBe('4');

    store.setIdentity({ agent: null, mode: 'anonymous' });
    await flush();

    expect(el.querySelector('.notif__bell')).toBeNull();
  });

  test('destroy unhooks the socket, the document and the mount', async () => {
    const el = mount();
    const client = makeClient();
    const handle = createNotificationBell(el, {
      send: makeSend(1, [makeRow()]),
      client,
      store: makeStore()
    });
    await flush();
    expect(client.count('notification')).toBe(1);

    handle.destroy();

    expect(client.count('notification')).toBe(0);
    expect(el.querySelector('.notif')).toBeNull();
  });
});
