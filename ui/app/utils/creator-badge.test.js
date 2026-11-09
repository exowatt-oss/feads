import { describe, expect, test } from 'vitest';
import { createCreatorBadge, shortenActor } from './creator-badge.js';

describe('utils/creator-badge', () => {
  test('names the actor and keeps the full value in the tooltip', () => {
    const el = createCreatorBadge('mira@example.test');
    expect(el.classList.contains('creator-badge')).toBe(true);
    expect(el.textContent).toBe('mira');
    expect(el.getAttribute('title')).toBe('Created by: mira@example.test');
    expect(el.getAttribute('aria-label')).toBe('Created by: mira@example.test');
  });

  test('a minted agent name is shown as-is when it fits', () => {
    const el = createCreatorBadge('laptop-claude');
    expect(el.textContent).toBe('laptop-claude');
  });

  test('an item with no recorded creator says so instead of rendering an empty pill', () => {
    for (const value of ['', '   ', null, undefined]) {
      const el = createCreatorBadge(value);
      expect(el.textContent).toBe('—');
      expect(el.classList.contains('creator-badge--unknown')).toBe(true);
      expect(el.getAttribute('title')).toBe('Created by: unknown');
    }
  });
});

describe('utils/creator-badge shortenActor', () => {
  test('drops the email domain, which is the same for everyone on the board', () => {
    expect(shortenActor('mira@example.test')).toBe('mira');
  });

  test('keeps an @ that is not a domain separator out of it', () => {
    expect(shortenActor('@nobody')).toBe('@nobody');
  });

  test('preserves the prefix and tail when truncating', () => {
    const short = shortenActor('macbook-pro-claude-pid638');
    expect(short.startsWith('macboo')).toBe(true);
    expect(short.endsWith('pid638')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(14);
  });

  test('stays inside the CSS width, so nothing is clipped from the right as well', () => {
    // `.creator-badge` is 15ch wide; a name shortened from the front and then clipped
    // from the right loses both ends — `better-tickets-pid638` → `…er-ticket…`.
    for (const actor of [
      'better-tickets-pid638',
      'macbook-pro-claude-pid638',
      'a'.repeat(40)
    ]) {
      expect(shortenActor(actor).length).toBeLessThanOrEqual(14);
    }
    expect(shortenActor('better-tickets-pid638')).toBe('better…-pid638');
  });

  test('leaves an ordinary minted name alone', () => {
    expect(shortenActor('laptop-claude')).toBe('laptop-claude');
  });

  test('leaves a name at the limit alone', () => {
    const exact = 'a'.repeat(14);
    expect(shortenActor(exact)).toBe(exact);
  });
});
