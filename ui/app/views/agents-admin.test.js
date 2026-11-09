import { describe, expect, test, vi } from 'vitest';
import {
  createAgentsView,
  isAgentsTabVisible,
  relativeTime
} from './agents-admin.js';

/**
 * @param {Record<string, any>} [identity]
 */
function makeStore(identity = {}) {
  const state = {
    view: 'agents',
    selected_id: null,
    identity: {
      loaded: true,
      agent: null,
      mode: 'operator',
      require_identity: false,
      ...identity
    }
  };
  /** @type {Array<(s: any) => void>} */
  const listeners = [];
  return {
    getState: () => state,
    /** @param {(s: any) => void} fn */
    subscribe(fn) {
      listeners.push(fn);
      return () => void 0;
    },
    /** @param {Record<string, any>} patch */
    patchIdentity(patch) {
      state.identity = { ...state.identity, ...patch };
      for (const fn of listeners) {
        fn(state);
      }
    }
  };
}

/**
 * @param {Record<string, any>} [overrides]
 */
function row(overrides = {}) {
  return {
    agent_id: 'ag_1',
    actor: 'laptop-claude',
    display_name: 'Laptop Claude',
    role: 'user',
    board_id: 'example',
    host: 'macbook',
    workspace_dir: '/Users/alex/example/sample-controller',
    session_id: '9ca8040e-26ab-4d51-8c0a-25f9a33d340c',
    kind: 'agent',
    registered_at: 1753718400000,
    last_seen_at: 1753718400000,
    revoked_at: 0,
    revoke_reason: '',
    ...overrides
  };
}

function mount() {
  document.body.innerHTML = '<div id="m"></div>';
  return /** @type {HTMLElement} */ (document.getElementById('m'));
}

describe('isAgentsTabVisible', () => {
  test('hidden until whoami has answered', () => {
    // Otherwise the tab appears and is then taken away from a `user`.
    expect(
      isAgentsTabVisible({ identity: { loaded: false, mode: 'operator' } })
    ).toBe(false);
  });

  test('shown in operator mode', () => {
    expect(
      isAgentsTabVisible({ identity: { loaded: true, mode: 'operator' } })
    ).toBe(true);
  });

  test('shown for an admin', () => {
    expect(
      isAgentsTabVisible({
        identity: { loaded: true, mode: 'agent', agent: { role: 'admin' } }
      })
    ).toBe(true);
  });

  test('hidden for a user', () => {
    expect(
      isAgentsTabVisible({
        identity: { loaded: true, mode: 'agent', agent: { role: 'user' } }
      })
    ).toBe(false);
  });

  test('withheld from a rejected credential', () => {
    // The inversion guard: a rejected credential has `agent: null`, so any test
    // shaped as "no agent means operator" would hand a revoked agent the admin
    // page — i.e. revoking it would grant it the roster.
    expect(
      isAgentsTabVisible({
        identity: { loaded: true, mode: 'rejected', agent: null }
      })
    ).toBe(false);
  });

  test('an unknown role is not treated as admin', () => {
    // Matches normalizeRole's fail-closed default: a role a newer build wrote
    // and this one does not know must not read as privileged.
    expect(
      isAgentsTabVisible({
        identity: { loaded: true, mode: 'agent', agent: { role: 'superuser' } }
      })
    ).toBe(false);
  });

  test('an ADMIN role in any case is admin', () => {
    expect(
      isAgentsTabVisible({
        identity: { loaded: true, mode: 'agent', agent: { role: 'ADMIN' } }
      })
    ).toBe(true);
  });

  test('tolerates a state with no identity slice', () => {
    expect(isAgentsTabVisible({})).toBe(false);
  });
});

describe('relativeTime', () => {
  const now = 1753718400000;

  test('never for an unset timestamp', () => {
    expect(relativeTime(0, now)).toBe('never');
    expect(relativeTime(Number.NaN, now)).toBe('never');
  });

  test('coarse buckets', () => {
    expect(relativeTime(now - 5000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  test('clock skew is reported, not hidden', () => {
    expect(relativeTime(now + 60_000, now)).toBe('in the future');
  });
});

describe('views/agents-admin', () => {
  test('renders a row per agent', async () => {
    const store = makeStore();
    const transport = vi.fn().mockResolvedValue({
      agents: [
        row(),
        row({ agent_id: 'ag_2', actor: 'alex-admin', role: 'admin' })
      ],
      scope: 'all',
      reason: 'admin sees every agent'
    });

    const view = createAgentsView(
      mount(),
      /** @type {any} */ (store),
      transport
    );
    await view.load();

    const rows = document.querySelectorAll('.agents-row');
    expect(rows.length).toBe(2);
    expect(document.body.textContent).toContain('laptop-claude');
    expect(document.body.textContent).toContain('alex-admin');
    expect(transport).toHaveBeenCalledWith('list-agents', {
      include_revoked: false
    });
  });

  test('shows host, session and last seen', async () => {
    const store = makeStore();
    const transport = vi
      .fn()
      .mockResolvedValue({ agents: [row()], scope: 'all' });

    const view = createAgentsView(
      mount(),
      /** @type {any} */ (store),
      transport
    );
    await view.load();

    const cells = Array.from(document.querySelectorAll('.agents-row td')).map(
      (td) => String(td.textContent).trim()
    );
    expect(cells).toContain('macbook');
    // A full session uuid would not fit a cell; the prefix identifies it and the
    // whole value is in the title attribute.
    expect(cells).toContain('9ca8040e');
    const session_cell = document.querySelector('.agents-row td[title]');
    expect(session_cell).not.toBeNull();
  });

  test('a user sees its own row plus an explanatory note', async () => {
    const store = makeStore({
      mode: 'agent',
      agent: { agent_id: 'ag_1', actor: 'laptop-claude', role: 'user' }
    });
    const transport = vi.fn().mockResolvedValue({
      agents: [row()],
      scope: 'self',
      reason: 'user sees itself'
    });

    const view = createAgentsView(
      mount(),
      /** @type {any} */ (store),
      transport
    );
    await view.load();

    expect(document.querySelectorAll('.agents-row').length).toBe(1);
    const note = document.querySelector('.agents-note');
    expect(note).not.toBeNull();
    expect(String(note?.textContent)).toContain('laptop-claude');
    expect(String(note?.textContent)).toContain('admin');
    // Nothing to reveal by asking for revoked rows when the roster is one row.
    const toggle = /** @type {HTMLInputElement} */ (
      document.querySelector('.agents-toggle input')
    );
    expect(toggle.disabled).toBe(true);
  });

  test('operator mode says so rather than implying a tier', async () => {
    const store = makeStore();
    const transport = vi
      .fn()
      .mockResolvedValue({ agents: [row()], scope: 'all' });

    const view = createAgentsView(
      mount(),
      /** @type {any} */ (store),
      transport
    );
    await view.load();

    const note = document.querySelector('.agents-note');
    expect(String(note?.textContent)).toContain('operator');
  });

  test('a rejected credential is named as such, not shown an empty board', async () => {
    // `scope: 'none'` plus zero rows would otherwise render as "nobody is
    // registered", which is the wrong conclusion and hides the revocation.
    const store = makeStore({ mode: 'rejected', agent: null });
    const transport = vi.fn().mockRejectedValue({
      code: 'forbidden',
      message: 'a credential was presented and did not verify'
    });

    const view = createAgentsView(
      mount(),
      /** @type {any} */ (store),
      transport
    );
    await view.load();

    const note = document.querySelector('.agents-note--rejected');
    expect(note).not.toBeNull();
    expect(String(note?.textContent)).toContain('not accepted');
    expect(String(note?.textContent)).toContain('revoked');
    // And it must not also claim operator mode.
    expect(String(note?.textContent)).not.toContain('acting as the operator');
  });

  test('an empty roster shows the server’s reason', async () => {
    const store = makeStore();
    const transport = vi.fn().mockResolvedValue({
      agents: [],
      scope: 'all',
      reason:
        'the active board has no registry entry, so no agent can be registered against it'
    });

    const view = createAgentsView(
      mount(),
      /** @type {any} */ (store),
      transport
    );
    await view.load();

    expect(document.querySelectorAll('.agents-row').length).toBe(0);
    expect(
      String(document.querySelector('.agents-empty')?.textContent)
    ).toContain('no registry entry');
  });

  test('a refusal is rendered as an error, not as an empty board', async () => {
    const store = makeStore();
    const transport = vi.fn().mockRejectedValue({
      code: 'forbidden',
      message:
        'FEADS_REQUIRE_AGENT is set and this caller presented no identity'
    });

    const view = createAgentsView(
      mount(),
      /** @type {any} */ (store),
      transport
    );
    await view.load();

    const error = document.querySelector('.agents-empty--error');
    expect(error).not.toBeNull();
    expect(String(error?.textContent)).toContain('FEADS_REQUIRE_AGENT');
  });

  test('revoked rows are marked and requested explicitly', async () => {
    const store = makeStore();
    const transport = vi.fn().mockResolvedValue({
      agents: [
        row({ revoked_at: 1753718400000, revoke_reason: 'session over' })
      ],
      scope: 'all'
    });

    const mount_element = mount();
    const view = createAgentsView(
      mount_element,
      /** @type {any} */ (store),
      transport
    );
    await view.load();
    expect(document.querySelector('.agents-row--revoked')).not.toBeNull();
    expect(document.querySelector('.agents-state--archived')).not.toBeNull();

    const toggle = /** @type {HTMLInputElement} */ (
      mount_element.querySelector('.agents-toggle input')
    );
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(transport).toHaveBeenLastCalledWith('list-agents', {
      include_revoked: true
    });
  });

  test('re-renders when the identity arrives after the first paint', async () => {
    // whoami is a round trip, so the note's inputs land after mount.
    const store = makeStore({ mode: 'operator' });
    const transport = vi
      .fn()
      .mockResolvedValue({ agents: [row()], scope: 'self' });

    const view = createAgentsView(
      mount(),
      /** @type {any} */ (store),
      transport
    );
    await view.load();

    store.patchIdentity({
      mode: 'agent',
      agent: { agent_id: 'ag_1', actor: 'renamed-agent', role: 'user' }
    });

    expect(
      String(document.querySelector('.agents-note')?.textContent)
    ).toContain('renamed-agent');
  });

  test('destroy clears the mount', async () => {
    const store = makeStore();
    const transport = vi
      .fn()
      .mockResolvedValue({ agents: [row()], scope: 'all' });

    const mount_element = mount();
    const view = createAgentsView(
      mount_element,
      /** @type {any} */ (store),
      transport
    );
    await view.load();
    expect(mount_element.querySelector('.agents-view')).not.toBeNull();

    view.destroy();

    expect(mount_element.querySelector('.agents-view')).toBeNull();
  });
});
