/**
 * feads addition — routing for the epic story view (`#/story/<epic-id>`).
 */
import { describe, expect, test } from 'vitest';
import { parseHash, parseStoryId, parseView } from './router.js';

describe('story routing', () => {
  test('parseView recognizes story hashes', () => {
    expect(parseView('#/story/ex-abc')).toBe('story');
    expect(parseView('#/story')).toBe('story');
    expect(parseView('#/storyboard')).toBe('issues');
  });

  test('parseStoryId extracts the epic from the path', () => {
    expect(parseStoryId('#/story/ex-abc')).toBe('ex-abc');
    expect(parseStoryId('#/story/ex-abc?issue=ex-def')).toBe('ex-abc');
    expect(parseStoryId('#/story')).toBe(null);
    expect(parseStoryId('#/epics')).toBe(null);
  });

  test('the issue dialog still rides the query on a story hash', () => {
    expect(parseHash('#/story/ex-abc?issue=ex-def')).toBe('ex-def');
    expect(parseHash('#/story/ex-abc')).toBe(null);
  });
});
