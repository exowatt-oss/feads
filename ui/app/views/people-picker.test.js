import { render } from 'lit-html';
import { describe, expect, test, vi } from 'vitest';
import { createPeoplePicker } from './people-picker.js';

const PEOPLE = [
  {
    email: 'gale@example.test',
    name: 'eve Lin',
    department: 'Team B',
    status: 'ACTIVE'
  },
  {
    email: 'harper@example.test',
    name: 'finn Ordouie',
    department: 'Team B',
    status: 'ACTIVE'
  }
];

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ note?: (p: any) => string }} [opts]
 */
function setup(opts = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const search = vi.fn(async () => ({ ok: true, people: PEOPLE }));
  /** @type {ReturnType<typeof createPeoplePicker>} */
  let picker;
  const draw = () => render(picker.template(), host);
  picker = createPeoplePicker({
    id: 'p',
    search,
    onUpdate: draw,
    delay_ms: 0,
    ...opts
  });
  draw();
  const input = /** @type {HTMLInputElement} */ (host.querySelector('input'));
  /** @param {string} text */
  const type = async (text) => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(5);
  };
  /** @param {string} key */
  const key = (key) =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
  return { host, input, search, picker: () => picker, type, key };
}

describe('people picker', () => {
  test('searches the roster after two characters and lists name, email, department', async () => {
    const { host, search, type } = setup();
    await type('z');
    expect(search).not.toHaveBeenCalled();
    await type('ze');
    expect(search).toHaveBeenCalledWith('/api/people?q=ze');
    const options = host.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain('eve Lin');
    expect(options[0].textContent).toContain('gale@example.test · Team B');
    expect(host.querySelector('input')?.getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  test('Enter picks the active person; the input then carries their email', async () => {
    const { host, input, type, key, picker } = setup();
    await type('Team B');
    key('ArrowDown');
    key('Enter');
    expect(picker().value()).toBe('harper@example.test');
    expect(input.value).toBe('harper@example.test');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  test('someone who cannot be picked is shown, marked, and skipped', async () => {
    const { host, type, key, picker } = setup({
      note: (p) => (p.email === 'gale@example.test' ? 'already a member' : '')
    });
    await type('Team B');
    const first = /** @type {HTMLElement} */ (
      host.querySelector('[role="option"]')
    );
    expect(first.getAttribute('aria-disabled')).toBe('true');
    expect(first.textContent).toContain('already a member');
    first.click();
    expect(picker().value()).toBe('Team B');
    key('Enter');
    expect(picker().value()).toBe('harper@example.test');
  });

  test('a typed address stands as typed, and reset clears it', async () => {
    const { type, picker } = setup();
    await type('new.person@example.test');
    expect(picker().value()).toBe('new.person@example.test');
    picker().reset();
    expect(picker().value()).toBe('');
  });
});
