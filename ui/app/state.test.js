import { describe, expect, test } from 'vitest';
import { createStore } from './state.js';

describe('state store', () => {
  test('get/set/subscribe works and dedupes unchanged', () => {
    const store = createStore();
    const seen = [];
    const off = store.subscribe((s) => seen.push(s));

    store.setState({ selected_id: 'UI-1' });
    store.setState({ filters: { status: 'open' } });
    // no-op (unchanged)
    store.setState({ filters: { status: 'open' } });
    off();

    expect(seen.length).toBe(2);
    const state = store.getState();
    expect(state.selected_id).toBe('UI-1');
    expect(state.filters.status).toBe('open');
  });

  // feads: the change guard is a field-by-field compare, so a new slice that is
  // not listed in it is silently swallowed. The header nav renders from this
  // slice, so a swallowed update means the Agents tab never appears.
  test('starts unidentified and emits when the identity lands', () => {
    const store = createStore();
    expect(store.getState().identity).toEqual({
      loaded: false,
      agent: null,
      mode: 'operator',
      stance: 'operator',
      require_identity: false
    });

    /** @type {number} */
    let emits = 0;
    const off = store.subscribe(() => {
      emits += 1;
    });

    store.setState({ identity: { loaded: true, mode: 'operator' } });
    expect(emits).toBe(1);
    expect(store.getState().identity.loaded).toBe(true);

    // A whoami reply that says the same thing must not re-render.
    store.setState({ identity: { loaded: true, mode: 'operator' } });
    expect(emits).toBe(1);

    // A promotion is a change even though `loaded` and `mode` did not move.
    store.setState({
      identity: {
        mode: 'agent',
        agent: {
          agent_id: 'ag_1',
          actor: 'a',
          display_name: 'A',
          role: 'user',
          board_id: 'b',
          last_seen_at: 0
        }
      }
    });
    expect(emits).toBe(2);
    store.setState({
      identity: {
        agent: {
          agent_id: 'ag_1',
          actor: 'a',
          display_name: 'A',
          role: 'admin',
          board_id: 'b',
          last_seen_at: 0
        }
      }
    });
    expect(emits).toBe(3);
    expect(store.getState().identity.agent?.role).toBe('admin');
    off();
  });

  // Three states share `agent: null` — operator, refused-because-required, and
  // credential-rejected. The guard compares `mode`, so a move between them has
  // to emit even though every other identity field is unchanged.
  test('a move to rejected mode emits even with no agent either side', () => {
    const store = createStore({
      identity: {
        loaded: true,
        agent: null,
        mode: 'operator',
        stance: 'operator',
        require_identity: false
      }
    });
    /** @type {number} */
    let emits = 0;
    const off = store.subscribe(() => {
      emits += 1;
    });

    store.setState({ identity: { mode: 'rejected' } });

    expect(emits).toBe(1);
    expect(store.getState().identity.mode).toBe('rejected');
    expect(store.getState().identity.agent).toBeNull();
    off();
  });

  test('keeps base identity shape and diffs silo SSO details', () => {
    const base = createStore({
      identity: {
        loaded: true,
        agent: null,
        mode: 'operator',
        stance: 'operator',
        require_identity: false
      }
    });
    expect(Object.hasOwn(base.getState().identity, 'sso')).toBe(false);

    const silo = createStore({
      identity: {
        loaded: true,
        agent: null,
        mode: 'agent',
        stance: 'read_only',
        require_identity: false,
        sso: {
          email: 'person@example.test',
          sign_out_url: '/oauth2/sign_out'
        }
      }
    });
    /** @type {number} */
    let emits = 0;
    const off = silo.subscribe(() => {
      emits += 1;
    });

    // whoami creates fresh objects; identical SSO content is still a no-op.
    silo.setState({
      identity: {
        sso: {
          email: 'person@example.test',
          sign_out_url: '/oauth2/sign_out'
        }
      }
    });
    expect(emits).toBe(0);

    silo.setState({
      identity: { sso: { email: 'other@example.test' } }
    });
    expect(emits).toBe(1);

    // Returning to a base-shaped whoami removes the optional block rather than
    // leaving stale email/provenance in memory.
    silo.setState({ identity: { sso: null } });
    expect(emits).toBe(2);
    expect(Object.hasOwn(silo.getState().identity, 'sso')).toBe(false);
    off();
  });

  test('diffs server permissions without granting writes from client assumptions', () => {
    const store = createStore({
      identity: {
        loaded: true,
        agent: null,
        mode: 'agent',
        stance: 'read_only',
        require_identity: false,
        permissions: { write: false }
      }
    });
    /** @type {number} */
    let emits = 0;
    const off = store.subscribe(() => {
      emits += 1;
    });

    store.setState({ identity: { permissions: { write: false } } });
    expect(emits).toBe(0);
    store.setState({ identity: { permissions: { write: true } } });
    expect(emits).toBe(1);
    off();
  });
});
