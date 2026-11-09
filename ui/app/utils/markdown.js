import DOMPurify from 'dompurify';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { marked } from 'marked';
import { extractMentions } from '../../../boards/mentions.mjs';
import { mentionHtml } from './rich-text.js';

/**
 * @typedef {Object} MarkdownMentionOptions
 * @property {Set<string>} [actors] - Known handles (see rich-text.js); omitted
 * highlights anything shaped like a mention.
 * @property {string} [current_actor]
 * @property {boolean} [interactive] - See `RichTextOptions.interactive`. The
 * description, design and notes blocks are themselves click-to-edit buttons,
 * so mentions inside them default to hover-only.
 */

/**
 * Render Markdown safely as HTML using marked and DOMPurify.
 * Returns a lit-html TemplateResult via the unsafeHTML directive so it can be
 * embedded directly in templates.
 *
 * feads: with `options.mentions`, `@handles` in the text (never inside code,
 * pre or links) are marked up exactly as a comment's are — the highlight and,
 * for a known person, the hover-card trigger.
 *
 * @param {string} markdown - Markdown source text
 * @param {{ mentions?: MarkdownMentionOptions }} [options]
 */
export function renderMarkdown(markdown, options = {}) {
  const parsed = /** @type {string} */ (marked.parse(markdown));
  let html_string = DOMPurify.sanitize(parsed);
  if (options.mentions && html_string.includes('@')) {
    html_string = DOMPurify.sanitize(
      markMentions(html_string, options.mentions)
    );
  }
  return unsafeHTML(html_string);
}

const SKIP = new Set([
  'CODE',
  'PRE',
  'A',
  'BUTTON',
  'TEXTAREA',
  'SCRIPT',
  'STYLE'
]);

/**
 * Wrap every `@handle` in already-sanitized HTML's text nodes.
 *
 * @param {string} html_string
 * @param {MarkdownMentionOptions} options
 * @returns {string}
 */
export function markMentions(html_string, options) {
  if (typeof document === 'undefined') return html_string;
  const lowered = options.actors
    ? new Set(Array.from(options.actors, (a) => String(a).toLowerCase()))
    : null;
  const current_actor = String(options.current_actor || '');
  const interactive = options.interactive === true;
  const tpl = document.createElement('template');
  tpl.innerHTML = html_string;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  /** @type {Text[]} */
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = /** @type {Text} */ (n);
    if (!text.data.includes('@')) continue;
    let skip = false;
    for (let p = text.parentElement; p; p = p.parentElement) {
      if (SKIP.has(p.tagName)) {
        skip = true;
        break;
      }
    }
    if (!skip) texts.push(text);
  }
  for (const text of texts) {
    const source = text.data;
    let out = '';
    let cursor = 0;
    let any = false;
    // The shared parser (boards/mentions.mjs): what is highlighted is what
    // the engine notifies — no package scopes, URLs or inline code.
    for (const m of extractMentions(source)) {
      const piece = mentionHtml(m.handle, lowered, current_actor, interactive);
      if (!piece.startsWith('<')) continue;
      out += escapeText(source.slice(cursor, m.start)) + piece;
      cursor = m.end;
      any = true;
    }
    if (!any) continue;
    out += escapeText(source.slice(cursor));
    const holder = document.createElement('template');
    holder.innerHTML = out;
    text.replaceWith(holder.content);
  }
  return tpl.innerHTML;
}

/** @param {string} s */
function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
