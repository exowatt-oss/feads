/**
 * feads addition — `@actor` and `#issue-id` inside comments on the detail view.
 *
 * The renderer itself is covered in `utils/rich-text.test.js`; what is worth
 * asserting here is the wiring: that a reference navigates in-app instead of
 * reloading the page on its own hash, and that the actor directory is fetched
 * lazily — once, and only for a comment that mentions somebody.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { createDetailView, resetActorDirectoryForTests } from './detail.js';

/**
 * @param {any[]} comments
 * @param {string} [id]
 */
function makeStores(comments, id = 'ex-abc') {
  const issue = {
    id,
    title: 'Test issue',
    dependencies: [],
    dependents: [],
    comments
  };
  return {
    /** @param {string} client_id */
    snapshotFor(client_id) {
      return client_id === `detail:${id}` ? [issue] : [];
    },
    subscribe() {
      return () => {};
    }
  };
}

/**
 * @param {any[]} [users]
 */
function makeSend(users = []) {
  /** @type {Array<{ type: string, payload: any }>} */
  const calls = [];
  /**
   * @param {string} type
   * @param {any} payload
   */
  const send = async (type, payload) => {
    calls.push({ type, payload });
    if (type === 'list-users') {
      return { users };
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

/** @returns {Promise<void>} */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mount() {
  document.body.innerHTML =
    '<section class="panel"><div id="mount"></div></section>';
  return /** @type {HTMLElement} */ (document.getElementById('mount'));
}

describe('views/detail — mentions and ticket refs', () => {
  beforeEach(() => {
    resetActorDirectoryForTests();
    document.documentElement.dataset.identityActor = '';
    window.location.hash = '';
  });

  test('renders a ticket reference as an in-app link', async () => {
    const el = mount();
    /** @type {string[]} */
    const went = [];
    const view = createDetailView(
      el,
      makeSend(),
      (hash) => went.push(hash),
      makeStores([{ id: 1, author: 'bob', text: 'blocked on #ex-def' }])
    );
    await view.load('ex-abc');

    const link = /** @type {HTMLAnchorElement} */ (
      el.querySelector('.comment-text a.issue-ref')
    );
    expect(link).toBeTruthy();
    // A real href, so middle-click still opens a tab.
    expect(link.getAttribute('href')).toBe('#/issues?issue=ex-def');

    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);

    expect(went).toEqual(['#/issues?issue=ex-def']);
    expect(ev.defaultPrevented).toBe(true);
  });

  test('a reference followed from another tab keeps that tab', async () => {
    const el = mount();
    window.location.hash = '#/board';
    /** @type {string[]} */
    const went = [];
    const view = createDetailView(
      el,
      makeSend(),
      (hash) => went.push(hash),
      makeStores([{ id: 1, author: 'bob', text: 'see #ex-def' }])
    );
    await view.load('ex-abc');

    /** @type {HTMLAnchorElement} */ (
      el.querySelector('.comment-text a.issue-ref')
    ).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );

    expect(went).toEqual(['#/board?issue=ex-def']);
  });

  test('fetches the actor directory once, and only when a comment mentions somebody', async () => {
    const el = mount();
    const send = makeSend([{ actor: 'alice' }, { actor: 'carol' }]);
    const view = createDetailView(
      el,
      send,
      undefined,
      makeStores([
        { id: 1, author: 'bob', text: 'no handles here, see #ex-def' }
      ])
    );
    await view.load('ex-abc');
    await flush();

    expect(send.of('list-users').length).toBe(0);

    const el2 = mount();
    const view2 = createDetailView(
      el2,
      send,
      undefined,
      makeStores([
        { id: 1, author: 'bob', text: 'hey @alice' },
        { id: 2, author: 'bob', text: 'and @carol too' }
      ])
    );
    await view2.load('ex-abc');
    await flush();

    // One fetch for the page, not one per comment and not one per view.
    expect(send.of('list-users').length).toBe(1);
    expect(send.of('list-users')[0].payload).toEqual({});
    const mentions = Array.from(el2.querySelectorAll('.comment-text .mention'));
    expect(mentions.map((m) => m.textContent)).toEqual(['@alice', '@carol']);
  });

  test('highlights only registered handles once the directory has landed', async () => {
    const el = mount();
    const view = createDetailView(
      el,
      makeSend([{ actor: 'alice' }]),
      undefined,
      makeStores([{ id: 1, author: 'bob', text: '@alice and @ghost' }])
    );
    await view.load('ex-abc');
    await flush();

    const mentions = Array.from(el.querySelectorAll('.comment-text .mention'));
    expect(mentions.map((m) => m.textContent)).toEqual(['@alice']);
    expect(
      /** @type {HTMLElement} */ (el.querySelector('.comment-text')).textContent
    ).toBe('@alice and @ghost');
  });

  test('falls back to highlighting every handle when list-users fails', async () => {
    const el = mount();
    /** @type {any} */
    const send = async (/** @type {string} */ type) => {
      if (type === 'list-users') {
        throw new Error('no such message type');
      }
      return {};
    };
    const view = createDetailView(
      el,
      send,
      undefined,
      makeStores([{ id: 1, author: 'bob', text: '@alice and @ghost' }])
    );
    await view.load('ex-abc');
    await flush();

    expect(el.querySelectorAll('.comment-text .mention').length).toBe(2);
  });

  test('marks the reader own handle from the document identity', async () => {
    const el = mount();
    document.documentElement.dataset.identityActor = 'carol';
    const view = createDetailView(
      el,
      makeSend([{ actor: 'alice' }, { actor: 'carol' }]),
      undefined,
      makeStores([{ id: 1, author: 'bob', text: '@alice @carol' }])
    );
    await view.load('ex-abc');
    await flush();

    const self = Array.from(el.querySelectorAll('.comment-text .self-mention'));
    expect(self.map((m) => m.textContent)).toEqual(['@carol']);
  });

  test('comment markup is escaped, not rendered', async () => {
    const el = mount();
    const view = createDetailView(
      el,
      makeSend(),
      undefined,
      makeStores([
        { id: 1, author: 'bob', text: '<img src=x onerror="alert(1)"> @alice' }
      ])
    );
    await view.load('ex-abc');
    await flush();

    const body = /** @type {HTMLElement} */ (el.querySelector('.comment-text'));
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});
