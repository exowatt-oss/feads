import { describe, expect, test } from 'vitest';
import { formatActorTooltip, splitActor, truncateHandle } from './actor-name.js';

describe('actor-name', () => {
  test('explicit parent wins', () => {
    expect(splitActor('alex-luna-3', { parent_actor: 'alex' })).toEqual({ parent: 'alex', handle: 'luna-3' });
  });
  test('uses longest known parent', () => {
    expect(splitActor('alex-laptop-luna-3', { known_parents: ['alex', 'alex-laptop'] })).toEqual({ parent: 'alex-laptop', handle: 'luna-3' });
  });
  test('does not guess hyphenated humans', () => {
    expect(splitActor('mary-jane')).toEqual({ parent: '', handle: 'mary-jane' });
  });
  test('handles empty values', () => {
    expect(splitActor('')).toEqual({ parent: '', handle: '' });
  });
  test('preserves both ends when truncating', () => {
    expect(truncateHandle('luna-implementer-wave-2')).toBe('luna-i…er-wave-2');
  });
  test('formats tooltip copy', () => {
    expect(formatActorTooltip('alex-luna-3', 'alex')).toBe('alex-luna-3 — subagent of alex');
    expect(formatActorTooltip('alex', '')).toBe('alex');
  });
});
