import { html } from 'lit-html';

/**
 * Return the exact presence tooltip for a flare.
 *
 * @param {{actor?: string, liveness?: string}} flare
 * @returns {string}
 */
export function flareTooltip(flare) {
  const actor = flare?.actor || 'agent';
  return `${actor} — ${flare?.liveness === 'fading' ? 'was here moments ago' : 'working here now'}`;
}

/**
 * Group flares by issue id for view joins.
 *
 * @param {Array<{issue_id?: string}>} flares
 * @returns {Map<string, Array<object>>}
 */
export function groupFlaresByIssue(flares) {
  const grouped = new Map();
  for (const flare of flares || []) {
    if (!flare?.issue_id) continue;
    const rows = grouped.get(flare.issue_id) || [];
    rows.push(flare);
    grouped.set(flare.issue_id, rows);
  }
  return grouped;
}

/**
 * Render up to three presence pips and an overflow count.
 *
 * @param {Array<{actor?: string, liveness?: string}>} flares
 * @param {{compact?: boolean}} [options]
 * @returns {import('lit-html').TemplateResult<1>}
 */
export function createFlarePips(flares, options = {}) {
  void options;
  const rows = Array.isArray(flares) ? flares : [];
  if (!rows.length) return html``;
  const visible = rows.slice(0, 3);
  const overflow = rows.length - visible.length;
  return html`<span
    class="flare-pips"
    aria-label="${visible.map(flareTooltip).join(', ')}"
  >
    ${visible.map((flare) => {
      const tooltip = flareTooltip(flare);
      const fading = flare.liveness === 'fading';
      return html`<span
        class="flare-pip flare-pip--${fading ? 'fading' : 'live'}"
        title=${tooltip}
        aria-label=${tooltip}
      ></span>`;
    })}${overflow > 0
      ? html`<span class="flare-pips__more" title="${overflow} more flares"
          >+${overflow}</span
        >`
      : ''}
  </span>`;
}
