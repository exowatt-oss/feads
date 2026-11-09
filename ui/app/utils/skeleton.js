/**
 * feads: loading placeholders.
 *
 * Shown in place of a list while its first snapshot is in flight, so a slow
 * board reads as "loading" rather than "empty", and the layout does not jump
 * when rows arrive (the placeholders occupy roughly the space real rows will).
 * Purely presentational and hidden from assistive tech; the container carries
 * `aria-busy` and a polite status line says what is loading.
 */
import { html } from 'lit-html';

/**
 * Placeholder board cards.
 *
 * @param {number} count
 */
export function skeletonCards(count) {
  return html`${Array.from(
    { length: count },
    () =>
      html`<div class="board-skeleton-card skeleton" aria-hidden="true">
        <span class="skeleton__line skeleton__line--short"></span>
        <span class="skeleton__line"></span>
        <span class="skeleton__line skeleton__line--mid"></span>
      </div>`
  )}`;
}

/**
 * Placeholder rows for a list/table body, with a status line for screen
 * readers.
 *
 * @param {number} count
 * @param {string} label - What is loading, e.g. "issues".
 */
export function skeletonRows(count, label) {
  return html`<div class="skeleton-rows" aria-busy="true">
    <span class="visually-hidden" role="status">Loading ${label}…</span>
    ${Array.from(
      { length: count },
      () =>
        html`<div class="skeleton-row skeleton" aria-hidden="true">
          <span class="skeleton__line skeleton__line--short"></span>
          <span class="skeleton__line"></span>
        </div>`
    )}
  </div>`;
}

/**
 * Placeholder group cards (the Epics view's `.epic-group` boxes), with a
 * status line for screen readers.
 *
 * @param {number} count
 * @param {string} label - What is loading, e.g. "epics".
 */
export function skeletonGroups(count, label) {
  return html`<div aria-busy="true">
    <span class="visually-hidden" role="status">Loading ${label}…</span>
    ${Array.from(
      { length: count },
      () =>
        html`<div class="epic-group skeleton-group skeleton" aria-hidden="true">
          <span class="skeleton__line skeleton__line--mid"></span>
          <span class="skeleton__line skeleton__line--short"></span>
        </div>`
    )}
  </div>`;
}
