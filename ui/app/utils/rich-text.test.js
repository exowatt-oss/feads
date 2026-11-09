/**
 * feads addition — comment rich text.
 *
 * The assertions that matter are the ones about what *does not* happen: a
 * comment is attacker-controlled text written by whatever agent had a token, so
 * the first duty of this renderer is that nothing in it becomes markup.
 */
import { html, render } from 'lit-html';
import { describe, expect, test } from 'vitest';
import mentionCases from '../../../boards/mention-cases.json' with { type: 'json' };
import {
  ISSUE_REF_RE,
  MENTION_RE,
  containsMention,
  renderCommentRich
} from './rich-text.js';

/**
 * @param {string} text
 * @param {Record<string, any>} [options]
 * @returns {HTMLElement}
 */
function renderTo(text, options = {}) {
  const host = document.createElement('div');
  render(
    html`<div class="comment-text">${renderCommentRich(text, options)}</div>`,
    host
  );
  return /** @type {HTMLElement} */ (host.querySelector('.comment-text'));
}

describe('mention-cases.json (the engine and the MCP parse the same cases)', () => {
  for (const c of mentionCases.cases) {
    test(c.name, () => {
      const root = renderTo(c.text);
      const seen = new Map();
      for (const el of Array.from(root.querySelectorAll('.mention'))) {
        const handle = String(el.textContent).slice(1);
        if (!seen.has(handle.toLowerCase()))
          seen.set(handle.toLowerCase(), handle);
      }
      expect([...seen.values()]).toEqual(c.handles);
      expect(containsMention(c.text)).toBe(c.handles.length > 0);
      // Nothing is lost or reordered around a mention.
      expect(root.textContent).toBe(c.text);
    });
  }
});

describe('utils/rich-text', () => {
  test('escapes HTML rather than rendering it', () => {
    const root = renderTo('<img src=x onerror="alert(1)"> <b>bold</b>');

    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(root.textContent).toContain('<b>bold</b>');
  });

  test('escapes a script tag smuggled around a mention', () => {
    const root = renderTo('<script>alert(1)</script> @alice');

    expect(root.querySelector('script')).toBeNull();
    expect(root.innerHTML).not.toContain('<script');
    expect(root.querySelector('.mention')?.textContent).toBe('@alice');
  });

  test('renders empty and non-string input without throwing', () => {
    expect(renderTo('').textContent).toBe('');
    expect(renderTo(/** @type {any} */ (undefined)).textContent).not.toBeNull();
  });

  test('links a ticket reference to its issue hash', () => {
    const root = renderTo('see #ex-abc for context');

    const link = /** @type {HTMLAnchorElement} */ (
      root.querySelector('a.issue-ref')
    );
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('#/issues?issue=ex-abc');
    expect(link.getAttribute('data-issue-id')).toBe('ex-abc');
    expect(link.textContent).toBe('#ex-abc');
    expect(root.textContent).toBe('see #ex-abc for context');
  });

  test('links several references and leaves non-ids alone', () => {
    const root = renderTo('#ex-abc and #bd-12.3 but not #123 or #nodash');

    const ids = Array.from(root.querySelectorAll('a.issue-ref')).map((a) =>
      a.getAttribute('data-issue-id')
    );
    expect(ids).toEqual(['ex-abc', 'bd-12.3']);
  });

  test('highlights any handle when no directory is given', () => {
    const root = renderTo('@alice and @bob-2 shipped it');

    const mentions = Array.from(root.querySelectorAll('.mention')).map(
      (m) => m.textContent
    );
    expect(mentions).toEqual(['@alice', '@bob-2']);
  });

  test('highlights only known actors when a directory is given', () => {
    const root = renderTo('@alice pinged @nobody about it', {
      actors: new Set(['alice', 'carol'])
    });

    const mentions = Array.from(root.querySelectorAll('.mention')).map(
      (m) => m.textContent
    );
    expect(mentions).toEqual(['@alice']);
    expect(root.textContent).toBe('@alice pinged @nobody about it');
  });

  test('matches the directory case-insensitively and keeps the typed case', () => {
    const root = renderTo('ping @Alice', {
      actors: new Set(['alice'])
    });

    const mention = /** @type {HTMLElement} */ (root.querySelector('.mention'));
    expect(mention.textContent).toBe('@Alice');
  });

  test('marks the reader own mention', () => {
    const root = renderTo('@alice and @bob', {
      actors: new Set(['alice', 'bob']),
      current_actor: 'bob'
    });

    const self = Array.from(root.querySelectorAll('.self-mention')).map(
      (m) => m.textContent
    );
    expect(self).toEqual(['@bob']);
    // The other handle is still a mention, just not the reader's.
    expect(root.querySelectorAll('.mention').length).toBe(2);
  });

  test('does not treat an email address or a doubled sigil as a mention', () => {
    const root = renderTo('mail me at foo@example.com or @@alice');

    expect(root.querySelectorAll('.mention').length).toBe(0);
  });

  test('renders a mention and a reference in one comment', () => {
    const root = renderTo('@alice please look at #ex-abc today', {
      actors: new Set(['alice'])
    });

    expect(root.querySelector('.mention')?.textContent).toBe('@alice');
    expect(root.querySelector('a.issue-ref')?.textContent).toBe('#ex-abc');
    expect(root.textContent).toBe('@alice please look at #ex-abc today');
  });

  test('preserves newlines and surrounding whitespace verbatim', () => {
    const root = renderTo('line one\n  @alice\nline three', {
      actors: new Set(['alice'])
    });

    expect(root.textContent).toBe('line one\n  @alice\nline three');
  });

  test('exported patterns are the ones the contract names', () => {
    expect(MENTION_RE.source).toBe(
      '(^|[^\\w@])@([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)'
    );
    expect(MENTION_RE.flags).toContain('g');
    expect(MENTION_RE.flags).toContain('i');
    expect(ISSUE_REF_RE.source).toBe(
      '(^|[^\\w#])#([a-z][a-z0-9]*-[a-zA-Z0-9._-]*[a-zA-Z0-9_])'
    );
    expect(ISSUE_REF_RE.flags).toBe('g');
  });

  test('exported patterns are not left with a sticky lastIndex', () => {
    renderTo('@alice #ex-abc');
    renderTo('@alice #ex-abc');

    expect(MENTION_RE.lastIndex).toBe(0);
    expect(ISSUE_REF_RE.lastIndex).toBe(0);
  });

  test('containsMention answers for the cheap pre-check', () => {
    expect(containsMention('hello @alice')).toBe(true);
    expect(containsMention('hello alice')).toBe(false);
    expect(containsMention('mail foo@example.com')).toBe(false);
    // Repeated calls must not disagree, which they would on a shared lastIndex.
    expect(containsMention('hello @alice')).toBe(true);
  });
});
