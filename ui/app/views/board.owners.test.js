/**
 * Post-ship (2026-10-06): under accounts mode a card names the person behind an
 * agent alias (`alex-laptop` → mira, "via alex-laptop" in the tooltip), and the
 * Person filter offers one entry per person that includes every alias of theirs.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { createSubscriptionIssueStore } from '../data/subscription-issue-store.js';
import { setOwnerDirectory } from '../utils/owners.js';
import { createBoardView } from './board.js';

/** @returns {any} */
function createTestIssueStores() {
  /** @type {Map<string, any>} */
  const stores = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @param {string} id */
  function getStore(id) {
    let s = stores.get(id);
    if (!s) {
      s = createSubscriptionIssueStore(id);
      stores.set(id, s);
      s.subscribe(() => {
        for (const fn of Array.from(listeners)) fn();
      });
    }
    return s;
  }
  return {
    getStore,
    /** @param {string} id */
    snapshotFor(id) {
      return getStore(id).snapshot().slice();
    },
    /** @param {() => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

function makeStore() {
  return {
    /** @type {any} */
    state: {
      selected_id: null,
      view: 'board',
      filters: { status: 'all', search: '', type: '' },
      board: { closed_filter: 'today', person: '', epic: '' }
    },
    /** @type {((s: any) => void)[]} */
    subs: [],
    getState() {
      return this.state;
    },
    /** @param {any} patch */
    setState(patch) {
      this.state = {
        ...this.state,
        ...(patch || {}),
        board: { ...this.state.board, ...(patch.board || {}) }
      };
      for (const fn of this.subs) fn(this.state);
    },
    /** @param {(s: any) => void} fn */
    subscribe(fn) {
      this.subs.push(fn);
      return () => {
        this.subs = this.subs.filter((f) => f !== fn);
      };
    }
  };
}

afterEach(() => {
  setOwnerDirectory([]);
});

describe('views/board under accounts mode: aliases render as their person', () => {
  test('cards name the owner; the Person filter groups aliases and filters by all of them', async () => {
    setOwnerDirectory([
      {
        actor: 'mira',
        display_name: 'alex',
        aliases: ['alex-laptop']
      },
      { actor: 'dana', display_name: 'dana', aliases: ['dana-laptop'] }
    ]);
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:board:ready').applyPush({
      type: 'snapshot',
      id: 'tab:board:ready',
      revision: 1,
      issues: [
        {
          id: 'ex-1',
          title: 'by the laptop agent',
          status: 'open',
          priority: 2,
          assignee: 'alex-laptop',
          created_by: 'alex-laptop'
        },
        {
          id: 'ex-2',
          title: 'by the person',
          status: 'open',
          priority: 2,
          assignee: 'mira',
          created_by: 'dana-laptop'
        },
        {
          id: 'ex-3',
          title: 'unclaimed agent',
          status: 'open',
          priority: 2,
          assignee: 'botty1'
        }
      ]
    });
    const store = makeStore();
    const view = createBoardView(
      mount,
      null,
      () => {},
      store,
      undefined,
      issueStores
    );
    await view.load();

    const card = (/** @type {string} */ id) =>
      /** @type {HTMLElement} */ (
        mount.querySelector(`.board-card[data-issue-id="${id}"]`)
      );
    expect(card('ex-1').querySelector('.actor-chip')?.textContent?.trim()).toBe(
      'mira'
    );
    expect(
      card('ex-1').querySelector('.board-card__assignee')?.getAttribute('title')
    ).toBe('mira — via alex-laptop');
    // Created and assigned by the same person: no "by" line.
    expect(card('ex-1').querySelector('.board-card__creator')).toBeNull();
    expect(
      card('ex-2').querySelector('.board-card__creator')?.textContent?.trim()
    ).toBe('by dana');
    expect(
      card('ex-2').querySelector('.board-card__creator')?.getAttribute('title')
    ).toBe('dana — via dana-laptop');
    expect(card('ex-3').querySelector('.actor-chip')?.textContent?.trim()).toBe(
      'botty1'
    );

    const select = /** @type {HTMLSelectElement} */ (
      mount.querySelector('#board-person-filter')
    );
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'botty1',
      'mira'
    ]);
    select.value = 'mira';
    select.dispatchEvent(new Event('change'));
    const shown = Array.from(mount.querySelectorAll('.board-card')).map((el) =>
      el.getAttribute('data-issue-id')
    );
    expect(shown.sort()).toEqual(['ex-1', 'ex-2']);
    expect(store.state.board.person).toBe('mira');
  });

  test('a filter persisted as an alias selects its person', async () => {
    setOwnerDirectory([
      { actor: 'mira', display_name: '', aliases: ['alex-laptop'] }
    ]);
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:board:ready').applyPush({
      type: 'snapshot',
      id: 'tab:board:ready',
      revision: 1,
      issues: [
        { id: 'ex-1', title: 'a', status: 'open', assignee: 'mira' },
        { id: 'ex-2', title: 'b', status: 'open', assignee: 'someone' }
      ]
    });
    const store = makeStore();
    store.state.board.person = 'alex-laptop';
    const view = createBoardView(
      mount,
      null,
      () => {},
      store,
      undefined,
      issueStores
    );
    await view.load();
    const select = /** @type {HTMLSelectElement} */ (
      mount.querySelector('#board-person-filter')
    );
    expect(select.value).toBe('mira');
    expect(
      Array.from(mount.querySelectorAll('.board-card')).map((el) =>
        el.getAttribute('data-issue-id')
      )
    ).toEqual(['ex-1']);
  });
});
