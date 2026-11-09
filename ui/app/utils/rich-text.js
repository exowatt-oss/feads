import DOMPurify from 'dompurify';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { extractMentions } from '../../../boards/mentions.mjs';
import { issueHashFor } from './issue-url.js';
import { samePerson } from './owners.js';
import { personFor } from './people.js';

/**
 * feads addition — comment text with the two syntaxes agents write in.
 *
 * A comment is plain text, not Markdown: it is written by agents whose other
 * output is shell and JSON, and rendering it as Markdown would silently eat
 * underscores out of issue ids and asterisks out of glob patterns. So this is
 * deliberately *not* `utils/markdown.js` — it escapes everything and then puts
 * back exactly two things, `@actor` and `#issue-id`, which are the two the
 * board coordinates on.
 *
 * The security posture is markdown.js's, for the same reason: the string is
 * built here, but "built here" is not a safety property once any part of it
 * came from a comment, so it goes through DOMPurify before `unsafeHTML` like
 * every other HTML this app injects.
 */

/**
 * A mention: `@` and an actor handle.
 *
 * The cheap shape of a mention. The leading `(^|[^\w@])` is what keeps
 * `foo@bar` and `@@x` out; capture group 2 is the handle, which never ends in
 * `.`, `_` or `-` (so `cc @alice.` names alice). Case-insensitive because the
 * registry compares handles that way. What is actually rendered as a mention
 * comes from `extractMentions` (boards/mentions.mjs) — the same parser the
 * notification engine uses, so the page highlights exactly what notifies:
 * trailing punctuation trimmed, `@user@domain` kept whole, nothing inside code
 * spans/blocks, URLs or package scopes.
 *
 * @type {RegExp}
 */
export const MENTION_RE =
  /(^|[^\w@])@([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)/gi;

/**
 * A ticket reference: `#` and an issue id.
 *
 * Case-sensitive, unlike mentions: issue ids are `^[a-z]+-[a-zA-Z0-9._-]+$`, so
 * a lowercase prefix is part of what makes a `#`-token an id rather than a
 * heading or a channel name.
 *
 * @type {RegExp}
 */
export const ISSUE_REF_RE =
  /(^|[^\w#])#([a-z][a-z0-9]*-[a-zA-Z0-9._-]*[a-zA-Z0-9_])/g;

/**
 * @typedef {Object} RichTextOptions
 * @property {Set<string>} [actors] - Live registry actors. When given, only
 * these are highlighted; when omitted every `@token` is, which is the graceful
 * fallback for a server that could not answer `list-users`.
 * @property {string} [current_actor] - Who is reading, so their own mentions
 * can be told apart from everyone else's.
 * @property {boolean} [interactive] - Whether a mention of a known person is a
 * keyboard stop for its hover card (`tabindex="0"`). Default true; pass false
 * inside a button, link or other control (the bell's rows), where a nested
 * focusable element is invalid — the card then opens on hover only.
 * @property {boolean} [refs] - Whether `#issue-id` becomes a link. Default
 * true; false inside a control, where a nested link is invalid too.
 */

/**
 * @typedef {Object} RichMatch
 * @property {'mention'|'ref'} kind
 * @property {number} start - Index of the sigil in the source text.
 * @property {number} end - Index just past the token.
 * @property {string} token - The handle or issue id, without the sigil.
 */

/**
 * Escape text for interpolation into HTML, attribute values included.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Find every match of one pattern.
 *
 * The pattern is copied rather than used directly: both are exported module
 * constants with the `g` flag, so scanning with the original would leave
 * `lastIndex` behind for the next caller and drop matches at random.
 *
 * @param {RegExp} pattern
 * @param {'mention'|'ref'} kind
 * @param {string} text
 * @returns {RichMatch[]}
 */
function collect(pattern, kind, text) {
  /** @type {RichMatch[]} */
  const found = [];
  const scanner = new RegExp(pattern.source, pattern.flags);
  /** @type {RegExpExecArray | null} */
  let match;
  while ((match = scanner.exec(text)) !== null) {
    const token = match[2];
    const start = match.index + match[1].length;
    found.push({ kind, start, end: start + 1 + token.length, token });
    if (scanner.lastIndex === match.index) {
      // A zero-length match cannot happen with these two patterns, and an
      // infinite loop is a bad way to find out one changed.
      scanner.lastIndex += 1;
    }
  }
  return found;
}

/**
 * Whether the text carries anything that looks like a mention.
 *
 * Exported so a caller can decide whether the actor directory is worth
 * fetching at all — most comments have no `@` in them, and a round trip per
 * rendered comment would be a round trip for nothing.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function containsMention(text) {
  return extractMentions(String(text)).length > 0;
}

/**
 * The mentions in a text as rich matches.
 *
 * @param {string} text
 * @returns {RichMatch[]}
 */
function collectMentions(text) {
  return extractMentions(text).map((t) => ({
    kind: /** @type {'mention'} */ ('mention'),
    start: t.start,
    end: t.end,
    token: t.handle
  }));
}

/**
 * Whether this handle is one the registry knows.
 *
 * @param {string} token
 * @param {Set<string> | null} lowered
 * @returns {boolean}
 */
function isKnownActor(token, lowered) {
  if (!lowered) {
    // No directory: highlight anything shaped like a mention. Being wrong here
    // costs a coloured word; being silent costs the reader the knowledge that
    // somebody was addressed.
    return true;
  }
  return lowered.has(token.toLowerCase());
}

/**
 * Render one `@actor` token.
 *
 * A handle that names a person (accounts mode: their actor or any alias, see
 * utils/people.js) also carries `data-person-hover` — the person hover card's
 * trigger (people/hover-controller.js) — and, unless `interactive` is false, a
 * tab stop. Anything else is the plain highlight it always was.
 *
 * @param {string} token
 * @param {Set<string> | null} lowered
 * @param {string} current_actor
 * @param {boolean} [interactive]
 * @returns {string}
 */
export function mentionHtml(token, lowered, current_actor, interactive = true) {
  if (!isKnownActor(token, lowered)) {
    return escapeHtml(`@${token}`);
  }
  const is_self =
    current_actor.length > 0 &&
    (token.toLowerCase() === current_actor.toLowerCase() ||
      samePerson(token, current_actor));
  const cls = is_self ? 'mention self-mention' : 'mention';
  const person = personFor(token);
  const hover = person
    ? ` data-person-hover="${escapeHtml(person.actor)}"${interactive ? ' tabindex="0"' : ''}`
    : '';
  return `<span class="${cls}"${hover}>${escapeHtml(`@${token}`)}</span>`;
}

/**
 * Render one `#issue-id` token.
 *
 * The `href` is real rather than `#`: middle-click and "open in new tab" are
 * how a reader keeps the comment they are reading, and a handler-only link
 * takes that away. In-app navigation is the detail view's delegated click,
 * which preventDefaults this and routes instead.
 *
 * @param {string} id
 * @returns {string}
 */
function issueRefHtml(id) {
  const href = issueHashFor('issues', id);
  return (
    `<a href="${escapeHtml(href)}" class="issue-ref"` +
    ` data-issue-id="${escapeHtml(id)}">${escapeHtml(`#${id}`)}</a>`
  );
}

/**
 * Render comment text as escaped HTML with mentions and ticket refs marked up.
 *
 * Returns a lit-html directive result, like `renderMarkdown`, so it can be
 * dropped straight into a template.
 *
 * @param {string} text - Raw comment text.
 * @param {RichTextOptions} [options]
 */
export function renderCommentRich(text, options = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const lowered = options.actors
    ? new Set(Array.from(options.actors, (a) => String(a).toLowerCase()))
    : null;
  const current_actor = String(options.current_actor || '');
  const interactive = options.interactive !== false;

  const matches = [
    ...collectMentions(source),
    ...(options.refs === false ? [] : collect(ISSUE_REF_RE, 'ref', source))
  ].sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) {
      // Overlapping matches: the earlier one already consumed these characters.
      continue;
    }
    out += escapeHtml(source.slice(cursor, match.start));
    out +=
      match.kind === 'ref'
        ? issueRefHtml(match.token)
        : mentionHtml(match.token, lowered, current_actor, interactive);
    cursor = match.end;
  }
  out += escapeHtml(source.slice(cursor));

  return unsafeHTML(DOMPurify.sanitize(out));
}

/**
 * Render composer text as the highlight layer that sits *behind* a textarea.
 *
 * The same characters as the textarea, in the same order, with every mention the
 * registry knows wrapped in a `.mention` span. It is a backdrop rather than a
 * rich editor because a textarea cannot hold markup and every contenteditable
 * substitute breaks something a typist relies on — undo, spellcheck, the caret
 * arithmetic the autocomplete does. So the pill is drawn underneath and the real
 * glyphs stay on top; see `.comment-input__backdrop` in `styles.css`, which is
 * what keeps the two layers in register.
 *
 * Only `@handle` is marked up, never `#issue-id`: an issue reference is a link,
 * and a link the reader cannot click (it is behind a textarea) would be a lie.
 *
 * Same security posture as `renderCommentRich` — the string is built here, but
 * every part of it came from the keyboard, so it is escaped and sanitized before
 * it is HTML.
 *
 * @param {string} text - Raw composer text.
 * @param {Set<string>} [actors] - Live registry actors; omitted means "no
 * directory", which highlights anything shaped like a mention, exactly as a
 * posted comment does.
 */
export function renderComposerHighlight(text, actors) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const lowered = actors
    ? new Set(Array.from(actors, (a) => String(a).toLowerCase()))
    : null;

  let out = '';
  let cursor = 0;
  for (const match of collectMentions(source)) {
    if (match.start < cursor) {
      continue;
    }
    out += escapeHtml(source.slice(cursor, match.start));
    const label = escapeHtml(`@${match.token}`);
    out += isKnownActor(match.token, lowered)
      ? `<span class="mention">${label}</span>`
      : label;
    cursor = match.end;
  }
  out += escapeHtml(source.slice(cursor));

  // A trailing newline has no line box, so the backdrop would be one row shorter
  // than the textarea and the two would scroll out of step. A zero-width space
  // gives that last line something to be.
  if (out.endsWith('\n')) {
    out += String.fromCharCode(0x200b);
  }

  return unsafeHTML(DOMPurify.sanitize(out));
}
