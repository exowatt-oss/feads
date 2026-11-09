import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setOwnerDirectory } from '../utils/owners.js';
import { createUsersView } from './users.js';

// jsdom exposes the element but not always the native modal methods.
if (typeof HTMLDialogElement !== 'undefined') {
  const proto = /** @type {any} */ (HTMLDialogElement.prototype);
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    proto.close = function close() {
      this.removeAttribute('open');
    };
  }
}

const HOUR = 60 * 60 * 1000;
const now = Date.UTC(2026, 6, 30, 12, 0, 0);

const users = [
  {
    actor: 'carol',
    display_name: 'Carol Winter',
    role: 'user',
    kind: 'agent',
    board_id: 'example',
    registered_at: now - 90 * 24 * HOUR,
    last_seen_at: now - 48 * HOUR
  },
  {
    actor: 'alice',
    display_name: 'Alice Kim',
    role: 'admin',
    kind: 'agent',
    board_id: 'example',
    registered_at: now - 30 * 24 * HOUR,
    last_seen_at: now - 1 * HOUR
  },
  {
    actor: 'bob',
    display_name: 'Bob Stone',
    role: 'user',
    kind: 'human',
    board_id: 'example',
    registered_at: now - 10 * 24 * HOUR,
    last_seen_at: now - 5 * HOUR
  }
];

/**
 * @param {any} [identity]
 */
function makeStore(identity = { loaded: true, mode: 'operator', agent: null }) {
  /** @type {any} */
  const state = { identity };
  return {
    getState() {
      return state;
    },
    subscribe() {
      return () => {};
    }
  };
}

function mount() {
  document.body.innerHTML = '<div id="mount"></div>';
  return /** @type {HTMLElement} */ (document.getElementById('mount'));
}

/**
 * @param {HTMLElement} el
 * @returns {string[]}
 */
function actorCells(el) {
  return Array.from(el.querySelectorAll('.users-row td:first-child')).map((n) =>
    String(n.textContent).trim()
  );
}

/** @returns {{ promise: Promise<any>, resolve: (value: any) => void, reject: (error: any) => void }} */
function deferred() {
  /** @type {(value: any) => void} */
  let resolve_promise = () => {};
  /** @type {(error: any) => void} */
  let reject_promise = () => {};
  const promise = new Promise((resolve, reject) => {
    resolve_promise = resolve;
    reject_promise = reject;
  });
  return {
    promise,
    resolve: resolve_promise,
    reject: reject_promise
  };
}

/**
 * @param {HTMLElement} el
 * @param {string} actor
 */
function removeButtonFor(el, actor) {
  return /** @type {HTMLButtonElement} */ (
    el.querySelector(`.users-remove-action[data-actor="${actor}"]`)
  );
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('views/users', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('renders a row per registered user, most recently seen first', async () => {
    const el = mount();
    /** @type {Array<{ type: string, payload: any }>} */
    const calls = [];
    /** @type {any} */
    const transport = async (
      /** @type {string} */ type,
      /** @type {any} */ payload
    ) => {
      calls.push({ type, payload });
      return { users };
    };

    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();

    expect(calls.map((c) => c.type)).toEqual(['list-users']);
    expect(actorCells(el)).toEqual(['alice', 'bob', 'carol']);
    expect(String(el.textContent)).toContain('Alice Kim');
    expect(String(el.textContent)).toContain('3 registered users');
    expect(String(el.querySelector('.users-hint')?.textContent)).toContain(
      '@handle'
    );
  });

  test('shows the role and kind of each user', async () => {
    const el = mount();
    /** @type {any} */
    const transport = async () => ({ users });

    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();

    const first = /** @type {HTMLElement} */ (el.querySelector('.users-row'));
    expect(String(first.querySelector('.users-role')?.textContent).trim()).toBe(
      'admin'
    );
    expect(first.querySelector('.users-role--admin')).not.toBeNull();
    expect(String(first.textContent)).toContain('agent');
  });

  test('labels a service account (kind service) with a badge and its steward', async () => {
    const el = mount();
    /** @type {any} */
    const transport = async () => ({
      users: [
        ...users,
        {
          actor: 'botty1',
          display_name: 'botty1',
          role: 'user',
          kind: 'service',
          steward: 'mira',
          steward_display_name: 'alex',
          board_id: 'example',
          registered_at: now - 50 * 24 * HOUR,
          last_seen_at: now - 0.5 * HOUR
        }
      ]
    });
    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();
    const row = /** @type {HTMLElement} */ (
      Array.from(el.querySelectorAll('.users-row')).find((r) =>
        String(r.textContent).includes('botty1')
      )
    );
    const kind = /** @type {HTMLElement} */ (
      row.querySelector('td[data-label="Kind"]')
    );
    expect(kind.querySelector('.kind-badge--service')?.textContent).toBe(
      'service'
    );
    expect(String(kind.textContent)).toContain('steward mira');
    expect(
      kind.querySelector('.kind-badge--service')?.getAttribute('title')
    ).toBe('Service account — steward alex');
    // People keep their plain kind.
    const alice = /** @type {HTMLElement} */ (
      Array.from(el.querySelectorAll('.users-row')).find((r) =>
        String(r.textContent).includes('alice')
      )
    );
    expect(alice.querySelector('.kind-badge')).toBeNull();
  });

  test('marks the row belonging to the signed-in agent', async () => {
    const el = mount();
    /** @type {any} */ const transport = async () => ({ users });
    const store = makeStore({
      loaded: true,
      mode: 'agent',
      agent: { actor: 'bob', role: 'user' }
    });

    const view = createUsersView(el, /** @type {any} */ (store), transport);
    await view.load();

    const self = Array.from(el.querySelectorAll('.users-row--self')).map((r) =>
      String(r.textContent).trim()
    );
    expect(self.length).toBe(1);
    expect(self[0]).toContain('bob');
  });

  test('shows Actions only to an admin and safely disables the admin own row', async () => {
    const el = mount();
    /** @type {any} */ const transport = async () => ({ users });
    const view = createUsersView(
      el,
      /** @type {any} */
      (
        makeStore({
          loaded: true,
          mode: 'agent',
          agent: { actor: 'alice', role: 'admin' }
        })
      ),
      transport
    );
    await view.load();

    expect(
      Array.from(el.querySelectorAll('th')).map((cell) =>
        cell.textContent?.trim()
      )
    ).toContain('Actions');
    expect(el.querySelectorAll('.users-remove-action[data-actor]').length).toBe(
      2
    );
    const ownAction = el.querySelector('.users-remove-action--self');
    expect(ownAction).not.toBeNull();
    expect(/** @type {HTMLButtonElement} */ (ownAction).disabled).toBe(true);
    expect(ownAction?.textContent).toContain('Your account');
  });

  test.each([
    ['an operator', { loaded: true, mode: 'operator', agent: null }],
    [
      'a registered user',
      { loaded: true, mode: 'agent', agent: { actor: 'bob', role: 'user' } }
    ]
  ])('%s never sees removal actions', async (_label, identity) => {
    const el = mount();
    /** @type {any} */ const transport = async () => ({ users });
    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore(identity)),
      transport
    );
    await view.load();

    expect(el.querySelector('th:last-child')?.textContent).not.toContain(
      'Actions'
    );
    expect(el.querySelector('.users-remove-action')).toBeNull();
  });

  test('requires exact actor confirmation and serializes submissions', async () => {
    const el = mount();
    const pending = deferred();
    /** @type {Array<{ type: string, payload: any }>} */ const calls = [];
    /** @type {any} */
    const transport = vi.fn((type, payload) => {
      calls.push({ type, payload });
      if (type === 'list-users') return Promise.resolve({ users });
      return pending.promise;
    });
    const view = createUsersView(
      el,
      /** @type {any} */
      (
        makeStore({
          loaded: true,
          mode: 'agent',
          agent: { actor: 'alice', role: 'admin' }
        })
      ),
      transport
    );
    await view.load();

    removeButtonFor(el, 'bob').click();
    const dialog = /** @type {HTMLDialogElement} */ (
      el.querySelector('.users-remove-dialog')
    );
    expect(dialog.open).toBe(true);
    expect(String(dialog.textContent)).toContain(
      'Account access and credentials'
    );
    expect(String(dialog.textContent)).toContain(
      'Active sessions and presence'
    );
    expect(String(dialog.textContent)).toContain('Notifications and invites');
    expect(String(dialog.textContent)).toContain(
      'Authored issues, comments, and dependencies'
    );
    expect(String(dialog.textContent)).toContain('Assignments');
    expect(String(dialog.textContent)).toContain(
      'minimal security tombstone remains'
    );

    const input = /** @type {HTMLInputElement} */ (
      dialog.querySelector('#users-remove-confirm')
    );
    const confirm = /** @type {HTMLButtonElement} */ (
      dialog.querySelector('button[type="submit"]')
    );
    input.value = '@bob';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(confirm.disabled).toBe(true);
    input.value = 'bob';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(confirm.disabled).toBe(false);

    confirm.click();
    confirm.click();
    await settle();
    expect(calls.filter((call) => call.type === 'remove-user')).toHaveLength(1);
    expect(calls.find((call) => call.type === 'remove-user')?.payload).toEqual({
      actor: 'bob',
      confirm_actor: 'bob'
    });

    pending.resolve({ removed_counts: { issues: 2, comments: 1 }, total: 3 });
    await settle();
    expect(el.querySelector('.users-remove-dialog')).toBeNull();
  });

  test('on successful removal removes every matching row, announces server counts, and restores focus', async () => {
    const el = mount();
    /** @type {any} */
    const transport = vi.fn(async (type) => {
      if (type === 'list-users')
        return {
          users: [
            ...users,
            { ...users[2], actor: 'BOB' },
            { ...users[2], actor: 'bob-child', display_name: 'Bob child' }
          ]
        };
      return {
        removed_actors: ['bob', 'bob-child'],
        removed_counts: { issues: 2, comments: 1, dependencies: 4 },
        total: 7
      };
    });
    const view = createUsersView(
      el,
      /** @type {any} */
      (
        makeStore({
          loaded: true,
          mode: 'agent',
          agent: { actor: 'alice', role: 'admin' }
        })
      ),
      transport
    );
    await view.load();
    removeButtonFor(el, 'bob').click();
    const input = /** @type {HTMLInputElement} */ (
      el.querySelector('#users-remove-confirm')
    );
    input.value = 'bob';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.users-remove-dialog button[type="submit"]')
    ).click();
    await settle();

    expect(actorCells(el)).toEqual(['alice', 'carol']);
    expect(el.querySelector('.users-remove-dialog')).toBeNull();
    expect(el.querySelector('.users-announcement')?.textContent).toContain(
      '2 authored issues'
    );
    expect(el.querySelector('.users-announcement')?.textContent).toContain(
      '1 authored comment'
    );
    expect(document.activeElement).toBe(el.querySelector('.users-title'));
  });

  test('on failure keeps the dialog, typed confirmation, and error state', async () => {
    const el = mount();
    const pending = deferred();
    /** @type {any} */
    const transport = vi.fn((type) => {
      if (type === 'list-users') return Promise.resolve({ users });
      return pending.promise;
    });
    const view = createUsersView(
      el,
      /** @type {any} */
      (
        makeStore({
          loaded: true,
          mode: 'agent',
          agent: { actor: 'alice', role: 'admin' }
        })
      ),
      transport
    );
    await view.load();
    removeButtonFor(el, 'bob').click();
    const input = /** @type {HTMLInputElement} */ (
      el.querySelector('#users-remove-confirm')
    );
    input.value = 'bob';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.users-remove-dialog button[type="submit"]')
    ).click();
    pending.reject(new Error('server refused removal'));
    await settle();

    const dialog = el.querySelector('.users-remove-dialog');
    expect(dialog).not.toBeNull();
    const dialogInput = /** @type {HTMLInputElement | null} */ (
      dialog?.querySelector('input')
    );
    expect(dialogInput).not.toBeNull();
    expect(dialogInput?.value).toBe('bob');
    expect(el.querySelector('.users-remove-error')?.textContent).toContain(
      'server refused removal'
    );
    expect(actorCells(el)).toContain('bob');
  });

  test('uses explicit server activity and says Never for a zero timestamp', async () => {
    const el = mount();
    const activityUsers = [
      {
        actor: 'online-user',
        display_name: 'Online',
        role: 'user',
        kind: 'agent',
        online: true,
        last_seen_at: Date.now() - 5 * 60 * 1000,
        registered_at: now
      },
      {
        actor: 'current-user',
        display_name: 'Current presence',
        role: 'user',
        kind: 'agent',
        activity_status: 'active',
        activity_source: 'runtime_presence',
        last_seen_at: Date.now() - 60 * 60 * 1000,
        registered_at: now
      },
      {
        actor: 'never-user',
        display_name: 'Never seen',
        role: 'user',
        kind: 'human',
        last_seen_at: 0,
        registered_at: now
      }
    ];
    /** @type {any} */ const transport = async () => ({ users: activityUsers });
    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();

    const activity = Array.from(el.querySelectorAll('.users-row')).map(
      (row) => ({
        actor: row.querySelector('td')?.textContent?.trim(),
        text: row.querySelector('.users-activity')?.textContent,
        title: row.querySelector('.users-activity')?.getAttribute('title')
      })
    );
    expect(
      activity.find((row) => row.actor?.includes('online-user'))?.text
    ).toContain('Active now');
    expect(
      activity.find((row) => row.actor?.includes('current-user'))?.text
    ).toContain('Active now');
    expect(
      activity.find((row) => row.actor?.includes('never-user'))?.text
    ).toContain('Never');
    expect(
      activity.find((row) => row.actor?.includes('never-user'))?.title
    ).toMatch(/1969|1970/);
    expect(
      activity.find((row) => row.actor?.includes('online-user'))?.title
    ).not.toBe('');
  });

  test('a singular count reads as one user', async () => {
    const el = mount();
    /** @type {any} */ const transport = async () => ({ users: [users[0]] });
    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();

    expect(String(el.querySelector('.users-title')?.textContent).trim()).toBe(
      '1 registered user'
    );
  });

  test('an empty directory explains itself instead of showing an empty table', async () => {
    const el = mount();
    /** @type {any} */ const transport = async () => ({ users: [] });
    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();

    expect(el.querySelector('table')).toBeNull();
    expect(String(el.querySelector('.users-empty')?.textContent)).toContain(
      'Nobody is registered'
    );
  });

  test('a transport failure reads as an error, not as an empty board', async () => {
    const el = mount();
    /** @type {any} */
    const transport = async () => {
      throw new Error('forbidden');
    };
    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();

    expect(el.querySelector('table')).toBeNull();
    const error = /** @type {HTMLElement} */ (
      el.querySelector('.users-empty--error')
    );
    expect(error).not.toBeNull();
    expect(String(error.textContent).trim()).toBe('forbidden');
  });

  test('a malformed row does not take the page down', async () => {
    const el = mount();
    /** @type {any} */
    const transport = async () => ({
      users: [{ actor: 'alice' }, {}, null, { display_name: 'no handle' }]
    });
    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();

    expect(actorCells(el)).toEqual(['alice']);
  });

  test('destroy unmounts the view', async () => {
    const el = mount();
    /** @type {any} */ const transport = async () => ({ users });
    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();
    expect(el.querySelector('.users-view')).not.toBeNull();

    view.destroy();
    expect(el.querySelector('.users-view')).toBeNull();
  });
});

describe('views/users under accounts mode (post-ship 2026-10-06)', () => {
  afterEach(() => {
    setOwnerDirectory([]);
  });

  test('an alias row reads as its person, grouped under them, the agent as "via"', async () => {
    const el = mount();
    const rows = [
      ...users,
      {
        actor: 'alice-laptop',
        display_name: 'alice laptop agent',
        role: 'user',
        kind: 'agent',
        board_id: 'example',
        registered_at: now - 60 * 24 * HOUR,
        last_seen_at: now - 72 * HOUR
      }
    ];
    /** @type {any} */
    const transport = async () => ({
      users: rows,
      owners: [
        { actor: 'alice', display_name: 'Alice Kim', aliases: ['alice-laptop'] }
      ]
    });
    const view = createUsersView(
      el,
      /** @type {any} */ (makeStore()),
      transport
    );
    await view.load();

    // alice's alias sits right under alice, even though it was seen last.
    expect(actorCells(el)).toEqual([
      'alice',
      'alicevia alice-laptop',
      'bob',
      'carol'
    ]);
    const alias_row = /** @type {HTMLElement} */ (
      el.querySelectorAll('.users-row')[1]
    );
    expect(
      alias_row.querySelector('.actor-chip__via')?.textContent?.trim()
    ).toBe('via alice-laptop');
    expect(
      String(
        alias_row.querySelector('td[data-label="Name"]')?.textContent
      ).trim()
    ).toBe('Alice Kim');
  });
});
