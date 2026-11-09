/**
 * Person hover cards on @mentions and owner names (feads-m1w): which names
 * become triggers, and the controller that lazily loads the card.
 *
 * The React half (people/hover-card.js) is loaded through a seam here: the
 * controller is tested against a fake card module, so these tests assert the
 * contract — nothing loads until a name is hovered or focused, unknown handles
 * never trigger, keyboard focus opens, Escape and leaving close — without React.
 */
import { render } from 'lit-html';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createActorChip } from '../utils/actor-name.js';
import { renderMarkdown } from '../utils/markdown.js';
import { setOwnerDirectory } from '../utils/owners.js';
import {
  knownPersonHandles,
  personFor,
  setPeopleDirectory
} from '../utils/people.js';
import { renderCommentRich } from '../utils/rich-text.js';
import {
  CLOSE_DELAY_MS,
  OPEN_DELAY_MS,
  installPersonHover,
  peopleBundleUrls
} from './hover-controller.js';

const PEOPLE = [
  {
    actor: 'mira',
    email: 'mira@example.test',
    display_name: 'alex',
    kind: 'human'
  },
  {
    actor: 'carol',
    email: 'carol@example.test',
    display_name: 'dana',
    kind: 'human'
  },
  {
    actor: 'botty1',
    email: '',
    display_name: 'botty1',
    kind: 'service',
    steward: 'alex'
  }
];
const OWNERS = [
  { actor: 'mira', display_name: 'alex', aliases: ['alex-laptop'] },
  { actor: 'carol', display_name: 'dana', aliases: ['dana-laptop'] }
];

/** @param {unknown} result */
function mount(result) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(result, host);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = '';
  setOwnerDirectory(OWNERS);
  setPeopleDirectory(PEOPLE);
});

afterEach(() => {
  setOwnerDirectory([]);
  setPeopleDirectory([]);
});

describe('who is a person', () => {
  test('a handle, any alias and any case name the person; unknown is nobody', () => {
    expect(personFor('mira')?.email).toBe('mira@example.test');
    expect(personFor('@alex-Laptop')?.actor).toBe('mira');
    expect(personFor('dana-laptop')?.email).toBe('carol@example.test');
    expect(personFor('nobody')).toBeNull();
    expect(personFor('')).toBeNull();
    // A service account is a person-shaped label: no email, never the optional directory.
    expect(personFor('botty1')).toMatchObject({
      kind: 'service',
      email: '',
      steward: 'alex'
    });
    // An entry without an email is treated as a service account too.
    setPeopleDirectory([{ actor: 'bot', email: '', display_name: 'bot' }]);
    expect(personFor('bot')?.kind).toBe('service');
  });

  test('knownPersonHandles covers actors and aliases; null until loaded', () => {
    expect([...(knownPersonHandles() || [])].sort()).toEqual(
      ['mira', 'alex-laptop', 'botty1', 'dana-laptop', 'carol'].sort()
    );
    setPeopleDirectory([]);
    expect(knownPersonHandles()).toBeNull();
  });
});

describe('which names become hover triggers', () => {
  test('a comment mention of a person is a focusable trigger; unknown stays plain', () => {
    const host = mount(
      renderCommentRich('cc @alex-laptop, @nobody and #ex-1.', {
        actors: new Set(['alex-laptop', 'mira', 'nobody'])
      })
    );
    const chip = host.querySelector('[data-person-hover]');
    expect(chip?.getAttribute('data-person-hover')).toBe('mira');
    expect(chip?.getAttribute('tabindex')).toBe('0');
    expect(chip?.textContent).toBe('@alex-laptop');
    // A registry handle with no person behind it is highlighted, not a trigger.
    const spans = host.querySelectorAll('.mention');
    expect(spans.length).toBe(2);
    expect(spans[1].hasAttribute('data-person-hover')).toBe(false);
    expect(host.querySelector('a.issue-ref')).not.toBeNull();
  });

  test('inside a control (the bell) mentions are hover-only and refs are text', () => {
    const host = mount(
      renderCommentRich('@mira see #ex-1', {
        actors: knownPersonHandles() || undefined,
        interactive: false,
        refs: false
      })
    );
    const chip = host.querySelector('[data-person-hover]');
    expect(chip?.hasAttribute('tabindex')).toBe(false);
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toBe('@mira see #ex-1');
  });

  test('description markdown marks mentions hover-only, never inside code or links', () => {
    const host = mount(
      renderMarkdown(
        'Owner: @dana-laptop\n\n`@mira in code` and [@mira](https://x.test)\n\n- cc @mira.',
        { mentions: { actors: knownPersonHandles() || undefined } }
      )
    );
    const chips = Array.from(host.querySelectorAll('[data-person-hover]'));
    expect(
      chips.map((c) => [c.textContent, c.getAttribute('data-person-hover')])
    ).toEqual([
      ['@dana-laptop', 'carol'],
      ['@mira', 'mira']
    ]);
    expect(chips.every((c) => !c.hasAttribute('tabindex'))).toBe(true);
    expect(host.querySelector('code')?.textContent).toBe('@mira in code');
    expect(host.querySelector('a')?.textContent).toBe('@mira');
    // Sentence punctuation stays outside the chip.
    expect(host.querySelector('li')?.textContent).toBe('cc @mira.');
  });

  test('markdown without the option is unchanged', () => {
    const host = mount(renderMarkdown('hi @mira'));
    expect(host.querySelector('[data-person-hover]')).toBeNull();
    expect(host.textContent?.trim()).toBe('hi @mira');
  });

  test('an owner chip is a hover trigger without a native tooltip; focusable on request', () => {
    const host = mount(createActorChip('alex-laptop', { compact: true }));
    const chip = /** @type {HTMLElement} */ (host.querySelector('.actor-chip'));
    expect(chip.getAttribute('data-person-hover')).toBe('mira');
    expect(chip.hasAttribute('title')).toBe(false);
    expect(chip.getAttribute('aria-label')).toContain('via alex-laptop');
    expect(chip.hasAttribute('tabindex')).toBe(false);
    const focusable = mount(createActorChip('mira', { focusable: true }));
    expect(
      focusable.querySelector('.actor-chip')?.getAttribute('tabindex')
    ).toBe('0');
    // Not a person: the chip is exactly what it was.
    const plain = mount(createActorChip('some-bot'));
    const p = plain.querySelector('.actor-chip');
    expect(p?.hasAttribute('data-person-hover')).toBe(false);
    expect(p?.getAttribute('title')).toBe('some-bot');
  });
});

describe('the lazy bundle', () => {
  test('lives next to the main bundle and carries its version', () => {
    expect(
      peopleBundleUrls('https://feads.apps.example.test/main.bundle.js?v=abc123')
    ).toEqual({
      js: '/people.bundle.js?v=abc123',
      css: '/people.bundle.css?v=abc123'
    });
  });
});

describe('the controller', () => {
  /** @type {() => void} */
  let uninstall = () => {};
  /** @type {{ open: any, close: any, isOpen: () => boolean, last: any }} */
  let card;
  /** @type {import('vitest').Mock} */
  let load;

  beforeEach(() => {
    vi.useFakeTimers();
    let opened = false;
    card = {
      last: null,
      open: vi.fn((input) => {
        opened = true;
        card.last = input;
      }),
      close: vi.fn(() => {
        opened = false;
      }),
      isOpen: () => opened
    };
    load = vi.fn(async () => card);
    uninstall = installPersonHover({ document, load });
  });

  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  /**
   * @param {Element} el
   * @param {string} type
   * @param {Record<string, any>} [init]
   */
  function fire(el, type, init = {}) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { pointerType: 'mouse', relatedTarget: null, ...init });
    el.dispatchEvent(ev);
    return ev;
  }

  async function settle(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  function comment() {
    return mount(
      renderCommentRich('ping @alex-laptop and @nobody', {
        actors: new Set(['alex-laptop', 'nobody'])
      })
    );
  }

  test('nothing loads until a name is hovered; the card opens after the delay', async () => {
    const host = comment();
    await settle(1000);
    expect(load).not.toHaveBeenCalled();
    const chip = /** @type {HTMLElement} */ (
      host.querySelector('[data-person-hover]')
    );
    fire(chip, 'pointerover');
    expect(load).toHaveBeenCalledTimes(1);
    await settle(OPEN_DELAY_MS - 50);
    expect(card.open).not.toHaveBeenCalled();
    await settle(60);
    expect(card.open).toHaveBeenCalledTimes(1);
    expect(card.last.anchor).toBe(chip);
    expect(card.last.person.email).toBe('mira@example.test');
    expect(card.last.theme).toBe('light');
  });

  test('leaving the name closes; moving into the card keeps it open', async () => {
    const host = comment();
    const chip = /** @type {HTMLElement} */ (
      host.querySelector('[data-person-hover]')
    );
    fire(chip, 'pointerover');
    await settle(OPEN_DELAY_MS + 10);
    const fake_card = document.createElement('div');
    fake_card.className = 'exo-ux-hover-card';
    document.body.appendChild(fake_card);
    fire(chip, 'pointerout', { relatedTarget: fake_card });
    fire(fake_card, 'pointerover');
    await settle(CLOSE_DELAY_MS + 50);
    expect(card.close).not.toHaveBeenCalled();
    fire(fake_card, 'pointerout', { relatedTarget: document.body });
    await settle(CLOSE_DELAY_MS + 10);
    expect(card.close).toHaveBeenCalled();
  });

  test('a quick pass over a name never opens it', async () => {
    const host = comment();
    const chip = /** @type {HTMLElement} */ (
      host.querySelector('[data-person-hover]')
    );
    fire(chip, 'pointerover');
    await settle(50);
    fire(chip, 'pointerout', { relatedTarget: document.body });
    await settle(OPEN_DELAY_MS + 50);
    expect(card.open).not.toHaveBeenCalled();
  });

  test('keyboard: focus opens at once, Escape closes, blur closes', async () => {
    const host = comment();
    const chip = /** @type {HTMLElement} */ (
      host.querySelector('[data-person-hover]')
    );
    chip.focus();
    await settle(5);
    expect(card.open).toHaveBeenCalledTimes(1);
    const esc = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    });
    chip.dispatchEvent(esc);
    expect(card.close).toHaveBeenCalled();
    expect(esc.defaultPrevented).toBe(true);
    chip.blur();
    chip.focus();
    await settle(5);
    expect(card.open).toHaveBeenCalledTimes(2);
    chip.blur();
    await settle(5);
    expect(card.close).toHaveBeenCalledTimes(2);
  });

  test('hover-only names (no tab stop) do not open on touch; unknown handles never', async () => {
    const host = mount(createActorChip('alex-laptop', { compact: true }));
    const chip = /** @type {HTMLElement} */ (
      host.querySelector('[data-person-hover]')
    );
    fire(chip, 'pointerdown', { pointerType: 'touch' });
    fire(chip, 'pointerover', { pointerType: 'touch' });
    await settle(OPEN_DELAY_MS + 10);
    expect(card.open).not.toHaveBeenCalled();
    const stale = document.createElement('span');
    stale.setAttribute('data-person-hover', 'someone-else');
    document.body.appendChild(stale);
    fire(stale, 'pointerover');
    await settle(OPEN_DELAY_MS + 10);
    expect(card.open).not.toHaveBeenCalled();
  });

  test('scrolling closes an open card; dark theme follows the page', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const host = comment();
    const chip = /** @type {HTMLElement} */ (
      host.querySelector('[data-person-hover]')
    );
    fire(chip, 'pointerover');
    await settle(OPEN_DELAY_MS + 10);
    expect(card.last.theme).toBe('dark');
    document.dispatchEvent(new Event('scroll'));
    expect(card.close).toHaveBeenCalled();
    document.documentElement.removeAttribute('data-theme');
  });

  test('a failed bundle load leaves the name a name and retries next time', async () => {
    load.mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    const host = comment();
    const chip = /** @type {HTMLElement} */ (
      host.querySelector('[data-person-hover]')
    );
    fire(chip, 'pointerover');
    await settle(OPEN_DELAY_MS + 10);
    expect(card.open).not.toHaveBeenCalled();
    fire(chip, 'pointerout', { relatedTarget: document.body });
    fire(chip, 'pointerover');
    await settle(OPEN_DELAY_MS + 10);
    expect(load).toHaveBeenCalledTimes(2);
    expect(card.open).toHaveBeenCalledTimes(1);
  });
});
