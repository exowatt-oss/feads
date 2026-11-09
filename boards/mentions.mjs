/**
 * @mention extraction — the one parser every surface agrees on.
 *
 * Agents @mention each other to coordinate ("@carol I'm taking the tile
 * refactor in #x1"), so a mention has to be found exactly where a writer meant
 * one and nowhere else. Three implementations read the same text — the Node
 * notification engine (who gets notified), the browser (what is highlighted)
 * and the Python MCP server (what `comment()` reports back) — and they must
 * agree, or an agent is told "delivered" for a mention nobody receives. The
 * contract is the shared fixture `boards/mention-cases.json`, run by this
 * module's tests, `ui/app/utils/rich-text.test.js` and the MCP's pytest suite.
 *
 * Rules (each one a case in the fixture):
 *   - `@handle`: `@` after a boundary (start, or any character that is not a
 *     word character or `@`), then `[a-z0-9][a-z0-9._-]*`, case-insensitive.
 *     The boundary is what keeps `user@example.com` from mentioning `example`.
 *   - Trailing `.`, `_` and `-` are sentence punctuation, not handle: actors
 *     are slugs that end in a letter or digit, so `cc @mira.` names `mira`.
 *     Parentheses, commas, colons, quotes are never part of a handle.
 *   - `@mira@example.test` (the email form) is one mention whose handle is
 *     the email; resolvers try the email first, then its local part.
 *   - A handle followed by `/` is a path or package scope (`@example/ux`,
 *     `@types/node`), not a person.
 *   - Nothing inside fenced code blocks, inline code spans or URLs is a
 *     mention: agents paste shell, JSON and links, and `npm i @scope/pkg` or
 *     `https://medium.com/@someone` must not page anyone.
 *   - A handle is at most 64 characters (what `normalizeActor` can mint); a
 *     longer run is cut at 64, as it always was.
 *
 * Pure: no registry, no I/O. Whether a handle reaches anyone is the
 * resolver's call (notifications.mjs), never the parser's.
 */

/** Max handle length — `slugify` in registry.mjs caps actors at 64. */
export const MENTION_HANDLE_MAX = 64;

/**
 * A mention candidate token. No length cap here: the cap and the trailing
 * punctuation trim are applied after the match, so a 70-character run is one
 * token cut to 64 rather than a 64-character mention plus an orphaned tail.
 */
const MENTION_TOKEN_RE = /(^|[^\w@])@([a-z0-9][a-z0-9._-]*)/gi;

/** The domain of the email form, anchored at the character after the second `@`. */
const EMAIL_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/i;

/** Fenced code blocks: a run of 3+ backticks or tildes to the same run, or to the end. */
const CODE_FENCE_RE = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g;

/** Inline code spans on one line. */
const CODE_SPAN_RE = /`[^`\n]+`/g;

/** URLs: `scheme://…` or a bare `www.…`, up to whitespace or a quote. */
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/gi;

const TRAILING_PUNCT_RE = /[._-]+$/;

/**
 * The text with every span that cannot hold a mention blanked to spaces —
 * same length, so indices into it are indices into the original.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskNonProse(text) {
  const blank = (/** @type {string} */ s) => s.replace(/[^\n]/g, ' ');
  return String(text || '')
    .replace(CODE_FENCE_RE, blank)
    .replace(CODE_SPAN_RE, blank)
    .replace(URL_RE, blank);
}

/**
 * @typedef {Object} MentionToken
 * @property {string} handle - As written (case kept); `local@domain` for the
 * email form.
 * @property {number} start - Index of the `@` in the original text.
 * @property {number} end - Index just past the token.
 */

/**
 * Every @mention in a text, in order, duplicates included (callers dedupe by
 * whatever identity they resolve to).
 *
 * @param {string} text
 * @returns {MentionToken[]}
 */
export function extractMentions(text) {
  const source = String(text || '');
  const masked = maskNonProse(source);
  /** @type {MentionToken[]} */
  const out = [];
  const scanner = new RegExp(MENTION_TOKEN_RE.source, MENTION_TOKEN_RE.flags);
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = scanner.exec(masked)) !== null) {
    const raw = m[2];
    const start = m.index + m[1].length;
    const raw_end = start + 1 + raw.length;
    const after = masked.charAt(raw_end);
    let handle = raw.replace(TRAILING_PUNCT_RE, '');
    let end = start + 1 + handle.length;
    const trimmed = handle.length !== raw.length;
    if (after === '/' && !trimmed) {
      // `@example/ux`, `@types/node`: a package scope or a path.
      continue;
    }
    if (after === '@' && !trimmed) {
      const domain = EMAIL_DOMAIN_RE.exec(masked.slice(raw_end + 1));
      if (domain) {
        handle = `${source.slice(start + 1, raw_end)}@${source.slice(raw_end + 1, raw_end + 1 + domain[0].length)}`;
        end = raw_end + 1 + domain[0].length;
        scanner.lastIndex = end;
        if (raw.length <= MENTION_HANDLE_MAX) out.push({ handle, start, end });
        continue;
      }
    }
    if (handle.length > MENTION_HANDLE_MAX) {
      handle = handle.slice(0, MENTION_HANDLE_MAX).replace(TRAILING_PUNCT_RE, '');
      end = start + 1 + handle.length;
    }
    if (handle.length === 0) continue;
    out.push({ handle: source.slice(start + 1, start + 1 + handle.length), start, end });
  }
  return out;
}

/**
 * The distinct handles in a text, first spelling kept, deduped
 * case-insensitively.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function mentionHandles(text) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const t of extractMentions(text)) {
    const key = t.handle.toLowerCase();
    if (!seen.has(key)) seen.set(key, t.handle);
  }
  return [...seen.values()];
}

/**
 * The lookup keys for one handle, most specific first: the handle itself, and
 * for the email form its local part (slugified the way actors are minted).
 *
 * @param {string} handle
 * @returns {string[]}
 */
export function mentionLookupKeys(handle) {
  const h = String(handle || '').toLowerCase();
  const at = h.indexOf('@');
  if (at <= 0) return h ? [h] : [];
  const local = h
    .slice(0, at)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MENTION_HANDLE_MAX);
  return local && local !== h ? [h, local] : [h];
}
