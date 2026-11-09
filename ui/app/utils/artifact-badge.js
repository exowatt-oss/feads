/**
 * Presentation helpers for the artifacts a bead is working on.
 *
 * The *meaning* of an artifact — how a ref is spelled, what overlaps what — is not
 * decided here. That lives in `boards/artifacts.mjs`, which this view imports directly
 * rather than reimplementing: a ref is a join key, and a third canonicalizer that
 * disagreed with the CLI and the MCP would make the dashboard show a file nobody else
 * can see. The module is dependency-free and browser-safe for exactly this reason.
 *
 * @import { INTENTS } from '../../../boards/artifacts.mjs'
 */

/**
 * Create a badge for what a bead is doing to an artifact.
 *
 * No colour coding. The four intents are `editing`, `reading`, `planned` and `done`,
 * and a palette would have to invent a severity ordering that the word already carries
 * — while colliding with the type and status badges, which do mean something specific.
 * `done` is dimmed, because a finished claim is history rather than a live one.
 *
 * @param {string | undefined | null} intent
 * @returns {HTMLSpanElement}
 */
export function createIntentBadge(intent) {
  const el = document.createElement('span');
  el.className = 'intent-badge';
  const value = String(intent || '')
    .trim()
    .toLowerCase();
  const known = ['editing', 'reading', 'planned', 'done'];
  // An unrecorded intent reads as `editing` everywhere else in feads — the cautious
  // assumption, since that is the one that conflicts — so it must read that way here.
  const resolved = known.includes(value) ? value : 'editing';
  el.classList.add(`intent-badge--${resolved}`);
  el.setAttribute('role', 'img');
  el.setAttribute('title', `Intent: ${resolved}`);
  el.setAttribute('aria-label', `Intent: ${resolved}`);
  el.textContent = resolved;
  return el;
}

/**
 * The part of a ref worth reading in a narrow sidebar.
 *
 * The repo is shown separately and is the same for most of a bead's artifacts, so
 * repeating `example-org/feads:` on every row would push the filename — the thing you
 * are actually scanning for — out of view.
 *
 * @param {{ kind?: string, path?: string, pr?: number, repo?: string, ref?: string }} artifact
 * @returns {string}
 */
export function artifactLabel(artifact) {
  const kind = String(artifact.kind || '');
  if (kind === 'pr') return `#${artifact.pr}`;
  if (kind === 'repo') return String(artifact.repo || artifact.ref || '');
  return String(artifact.path || artifact.ref || '');
}

/**
 * The repo an artifact belongs to, or '' when the label already names it.
 *
 * @param {{ kind?: string, repo?: string }} artifact
 * @returns {string}
 */
export function artifactRepo(artifact) {
  return String(artifact.kind || '') === 'repo'
    ? ''
    : String(artifact.repo || '');
}
