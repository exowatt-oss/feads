/**
 * feads addition — the `@mention` autocomplete over the comment composer.
 *
 * The renderer for a *posted* mention is covered in `utils/rich-text.test.js`
 * and `detail.rich-text.test.js`. What is worth asserting here is the composer:
 * that the menu tracks the token being typed, that the keys a Slack user's
 * fingers already know do what they do there, and — the one that costs a real
 * comment if it regresses — that Enter over an open menu picks a handle instead
 * of posting the half-typed one.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { createDetailView, resetActorDirectoryForTests } from './detail.js';

/**
 * @param {any[]} [comments]
 * @param {string} [id]
 */
function makeStores(comments = [], id = 'ex-abc') {
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

const directory = [
  { actor: 'alice', display_name: 'Alice Kim' },
  { actor: 'alfred', display_name: 'Alfred Nine' },
  { actor: 'bob', display_name: 'Bob Stone' },
  { actor: 'carol', display_name: 'Carol Winter' }
];

/**
 * @param {any[]} [users]
 * @param {any} [comment_result]
 */
function makeSend(users = directory, comment_result = undefined) {
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
    if (type === 'add-comment') {
      return comment_result || [];
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

/**
 * Open an issue with a warm actor directory and a focused composer.
 *
 * The directory is fetched on focus rather than on the first `@`, so the
 * composer is usable the instant the first handle is typed; every case below
 * starts from that state because that is the state a typist is in.
 *
 * @param {any} [send]
 */
async function openComposer(send = makeSend()) {
  const el = mount();
  const view = createDetailView(el, send, undefined, makeStores());
  await view.load('ex-abc');
  const ta = /** @type {HTMLTextAreaElement} */ (
    el.querySelector('.comment-input textarea')
  );
  ta.dispatchEvent(new FocusEvent('focus'));
  await flush();
  return { el, view, send, ta };
}

/**
 * @param {HTMLTextAreaElement} ta
 * @param {string} text
 */
function type(ta, text) {
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * @param {HTMLElement} el
 * @returns {string[]}
 */
function menuActors(el) {
  return Array.from(
    el.querySelectorAll(
      '.mention-autocomplete__row .mention-autocomplete__actor'
    )
  ).map((n) => String(n.textContent).trim());
}

/**
 * @param {HTMLTextAreaElement} ta
 * @param {string} key
 * @param {KeyboardEventInit} [init]
 */
function press(ta, key, init = {}) {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init
  });
  ta.dispatchEvent(ev);
  return ev;
}

describe('views/detail — mention autocomplete', () => {
  beforeEach(() => {
    resetActorDirectoryForTests();
    document.documentElement.dataset.identityActor = '';
    window.location.hash = '';
  });

  test('fetches the directory when the composer is focused', async () => {
    const { send } = await openComposer();
    expect(send.of('list-users').length).toBe(1);
  });

  test('opens on @ and narrows as the handle is typed', async () => {
    const { el, ta } = await openComposer();

    type(ta, 'hey @');
    expect(el.querySelector('.mention-autocomplete')).not.toBeNull();
    // Everyone, alphabetically, because nothing has been typed to filter on.
    expect(menuActors(el)).toEqual(['@alfred', '@alice', '@bob', '@carol']);

    type(ta, 'hey @al');
    expect(menuActors(el)).toEqual(['@alfred', '@alice']);

    type(ta, 'hey @ali');
    expect(menuActors(el)).toEqual(['@alice']);
  });

  test('matches a display name too, after the handle prefixes', async () => {
    const { el, ta } = await openComposer();

    type(ta, '@win');

    // `carol` has no handle starting with "win"; "Carol Winter" does.
    expect(menuActors(el)).toEqual(['@carol']);
  });

  test('an unknown prefix shows no menu', async () => {
    const { el, ta } = await openComposer();

    type(ta, 'ping @zzz');

    expect(el.querySelector('.mention-autocomplete')).toBeNull();
  });

  test('an email address is not a mention', async () => {
    const { el, ta } = await openComposer();

    type(ta, 'mail bob@ali');

    expect(el.querySelector('.mention-autocomplete')).toBeNull();
  });

  test('ArrowDown then Enter inserts the handle and closes', async () => {
    const { el, ta } = await openComposer();

    type(ta, 'hey @al');
    expect(menuActors(el)).toEqual(['@alfred', '@alice']);

    press(ta, 'ArrowDown');
    expect(
      el.querySelector('.mention-autocomplete__row.is-active')?.textContent
    ).toContain('@alice');

    const enter = press(ta, 'Enter');

    expect(enter.defaultPrevented).toBe(true);
    expect(ta.value).toBe('hey @alice ');
    expect(el.querySelector('.mention-autocomplete')).toBeNull();
  });

  test('ArrowUp wraps to the last row', async () => {
    const { el, ta } = await openComposer();

    type(ta, 'hey @al');
    press(ta, 'ArrowUp');

    expect(
      el.querySelector('.mention-autocomplete__row.is-active')?.textContent
    ).toContain('@alice');
  });

  test('Tab accepts the active row', async () => {
    const { el, ta } = await openComposer();

    type(ta, 'hey @al');
    const tab = press(ta, 'Tab');

    expect(tab.defaultPrevented).toBe(true);
    expect(ta.value).toBe('hey @alfred ');
    expect(el.querySelector('.mention-autocomplete')).toBeNull();
  });

  test('accepting replaces only the token, keeping the rest of the line', async () => {
    const { ta } = await openComposer();

    type(ta, 'hey @ali');
    ta.setSelectionRange(8, 8);
    press(ta, 'Enter');

    expect(ta.value).toBe('hey @alice ');
  });

  test('Escape closes the menu and goes no further', async () => {
    const { el, ta } = await openComposer();
    /** @type {string[]} */
    const bubbled = [];
    const listener = () => bubbled.push('document');
    document.addEventListener('keydown', listener);

    type(ta, 'hey @al');
    const esc = press(ta, 'Escape');
    document.removeEventListener('keydown', listener);

    expect(esc.defaultPrevented).toBe(true);
    expect(bubbled).toEqual([]);
    expect(el.querySelector('.mention-autocomplete')).toBeNull();
    // The text is untouched — Escape closed a menu, it did not undo typing.
    expect(ta.value).toBe('hey @al');
  });

  test('mousedown on a row accepts it', async () => {
    const { el, ta } = await openComposer();

    type(ta, 'hey @al');
    const row = /** @type {HTMLElement} */ (
      el.querySelectorAll('.mention-autocomplete__row')[1]
    );
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);

    // Prevented so the composer keeps focus and the caret survives the click.
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe('hey @alice ');
  });

  test('a click outside closes the menu', async () => {
    const { el, ta } = await openComposer();

    type(ta, 'hey @al');
    expect(el.querySelector('.mention-autocomplete')).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(el.querySelector('.mention-autocomplete')).toBeNull();
  });

  test('Enter over an open menu does not post the comment', async () => {
    const { el, ta, send } = await openComposer();

    type(ta, 'hey @al');
    press(ta, 'Enter');
    // Ctrl+Enter too: the menu outranks the submit shortcut while it is open.
    type(ta, 'hey @alice @ca');
    press(ta, 'Enter', { ctrlKey: true });
    await flush();

    expect(send.of('add-comment').length).toBe(0);
    expect(ta.value).toBe('hey @alice @carol ');
    expect(el.querySelector('.mention-autocomplete')).toBeNull();
  });

  test('plain Enter with the menu closed still types a newline', async () => {
    const { ta } = await openComposer();

    type(ta, 'no handles here');
    const ev = press(ta, 'Enter');

    // Not prevented, so the browser inserts the newline it always would.
    expect(ev.defaultPrevented).toBe(false);
  });

  test('the backdrop pills a completed mention and leaves an unknown one plain', async () => {
    const { el, ta } = await openComposer();

    type(ta, 'hey @alice and @ghost');

    const backdrop = /** @type {HTMLElement} */ (
      el.querySelector('.comment-input__backdrop')
    );
    expect(backdrop).not.toBeNull();
    expect(
      Array.from(backdrop.querySelectorAll('.mention')).map(
        (m) => m.textContent
      )
    ).toEqual(['@alice']);
    // Every character is still there, pill or not — the layer has to line up
    // with the textarea over it.
    expect(backdrop.textContent).toContain('hey @alice and @ghost');
  });

  test('the backdrop escapes markup rather than rendering it', async () => {
    const { el, ta } = await openComposer();

    type(ta, '<img src=x onerror="alert(1)"> @alice');

    const backdrop = /** @type {HTMLElement} */ (
      el.querySelector('.comment-input__backdrop')
    );
    expect(backdrop.querySelector('img')).toBeNull();
    expect(backdrop.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  test('submitting after accepting sends the mention, and clears both layers', async () => {
    const send = makeSend(directory, [
      { id: 1, author: 'me', text: 'ping @alice please' }
    ]);
    const { el, ta } = await openComposer(send);

    type(ta, 'ping @ali');
    press(ta, 'Enter');
    type(ta, `${ta.value}please`);

    press(ta, 'Enter', { ctrlKey: true });
    await flush();

    expect(send.of('add-comment').length).toBe(1);
    expect(send.of('add-comment')[0].payload).toEqual({
      id: 'ex-abc',
      text: 'ping @alice please'
    });

    const backdrop = /** @type {HTMLElement} */ (
      el.querySelector('.comment-input__backdrop')
    );
    expect(ta.value).toBe('');
    expect(backdrop.textContent).toBe('');
    // And the posted comment renders the mention it was given.
    expect(
      Array.from(el.querySelectorAll('.comment-text .mention')).map(
        (m) => m.textContent
      )
    ).toEqual(['@alice']);
  });

  test('a directory that never arrives costs the composer nothing', async () => {
    const el = mount();
    /** @type {any} */
    const send = async (/** @type {string} */ type) => {
      if (type === 'list-users') {
        throw new Error('no such message type');
      }
      return {};
    };
    const view = createDetailView(el, send, undefined, makeStores());
    await view.load('ex-abc');
    const ta = /** @type {HTMLTextAreaElement} */ (
      el.querySelector('.comment-input textarea')
    );
    ta.dispatchEvent(new FocusEvent('focus'));
    await flush();

    type(ta, 'hey @al');

    expect(el.querySelector('.mention-autocomplete')).toBeNull();
    expect(ta.value).toBe('hey @al');
  });
});
