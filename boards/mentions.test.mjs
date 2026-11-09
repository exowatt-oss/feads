/**
 * The @mention parser of record — boards/mention-cases.json is shared with
 * ui/app/utils/rich-text.js and the Python MCP server, so all three agree on
 * what is a mention. Run with: node --test boards/
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import {
  extractMentions,
  maskNonProse,
  mentionHandles,
  mentionLookupKeys
} from './mentions.mjs';

const fixture = JSON.parse(
  fs.readFileSync(new URL('./mention-cases.json', import.meta.url), 'utf8')
);

describe('mention-cases.json (shared with rich-text.js and beads_mcp)', () => {
  for (const c of fixture.cases) {
    test(c.name, () => {
      assert.deepEqual(mentionHandles(c.text), c.handles);
      if (c.tokens) assert.deepEqual(extractMentions(c.text), c.tokens);
    });
  }
});

describe('extractMentions', () => {
  test('token offsets point at the @ and the end of the handle', () => {
    const text = 'cc @mira. and (@dana-laptop)';
    for (const t of extractMentions(text)) {
      assert.equal(text[t.start], '@');
      assert.equal(text.slice(t.start + 1, t.end), t.handle);
    }
  });

  test('duplicates stay in the token list; mentionHandles dedupes', () => {
    assert.equal(extractMentions('@a @A @a').length, 3);
    assert.deepEqual(mentionHandles('@a @A @a'), ['a']);
  });

  test('masking keeps indices', () => {
    const text = 'x `@a` https://e.com/@b @c';
    assert.equal(maskNonProse(text).length, text.length);
  });

  test('lookup keys: the email form tries the address, then the slugged local part', () => {
    assert.deepEqual(mentionLookupKeys('mira'), ['mira']);
    assert.deepEqual(mentionLookupKeys('mira@example.test'), ['mira@example.test', 'mira']);
    assert.deepEqual(mentionLookupKeys('dana.lee@example.test'), [
      'dana.lee@example.test',
      'dana-lee'
    ]);
    assert.deepEqual(mentionLookupKeys(''), []);
  });
});
