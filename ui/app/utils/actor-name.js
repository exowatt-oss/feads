import { html, nothing } from 'lit-html';
import { ownerOf, serviceOf, serviceTitle } from './owners.js';
import { personFor } from './people.js';

/**
 * Split an actor into its source parent and child handle.
 *
 * @param {string} actor
 * @param {{parent_actor?: string, known_parents?: string[]}} [options]
 * @returns {{parent: string, handle: string}}
 */
export function splitActor(actor, options = {}) {
  const value = String(actor || '');
  const explicit = String(options.parent_actor || '');
  if (explicit && value.startsWith(`${explicit}-`)) {
    return { parent: explicit, handle: value.slice(explicit.length + 1) };
  }
  if (explicit) return { parent: explicit, handle: value };

  const parents = Array.isArray(options.known_parents)
    ? options.known_parents
    : [];
  const parent = parents
    .filter((candidate) => candidate && value.startsWith(`${candidate}-`))
    .sort((a, b) => b.length - a.length)[0];
  return parent
    ? { parent, handle: value.slice(parent.length + 1) }
    : { parent: '', handle: value };
}

/**
 * Format the accessible actor identity tooltip.
 *
 * @param {string} actor
 * @param {string} parent
 * @returns {string}
 */
export function formatActorTooltip(actor, parent) {
  return parent ? `${actor} — subagent of ${parent}` : actor;
}

/**
 * Truncate a handle while retaining both its identifying prefix and suffix.
 *
 * @param {string} handle
 * @param {number} [max=16]
 * @returns {string}
 */
export function truncateHandle(handle, max = 16) {
  const value = String(handle || '');
  if (value.length <= max) return value;
  if (max <= 1) return '…'.slice(0, max);
  const head = Math.min(6, Math.max(0, max - 1));
  const tail = Math.max(0, max - head - 1);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Render the shared two-layer actor identity chip.
 *
 * Accounts mode: an actor that is a person's alias renders as that person, with
 * the agent as secondary text (`via alex-laptop`; tooltip-only when `compact`).
 * `raw` opts out (a surface that must show the stored handle itself).
 *
 * When the actor names a person (utils/people.js) the chip is also the person
 * hover card's trigger (`data-person-hover`); the native tooltip then gives way
 * to the card. Hover-only unless `focusable` — chips mostly sit inside rows,
 * cards and editable cells, where a nested tab stop would be invalid.
 *
 * @param {string} actor
 * @param {{parent_actor?: string, known_parents?: string[], compact?: boolean, raw?: boolean, focusable?: boolean}} [options]
 * @returns {import('lit-html').TemplateResult<1>}
 */
export function createActorChip(actor, options = {}) {
  const value = String(actor || '');
  const service = options.raw ? null : serviceOf(value);
  if (service) {
    // A service account is labelled as one everywhere it is named, so nobody
    // reads botty1's comments as a person's. It is still a hover trigger: the
    // person card renders a "Service account" card for it and never asks the optional directory.
    const compact = Boolean(options.compact);
    const via =
      service.actor.toLowerCase() === value.toLowerCase() ? '' : value;
    const tooltip = via
      ? `${serviceTitle(service)} — via ${via}`
      : serviceTitle(service);
    const svc_person = personFor(value);
    return html`<span
      class="actor-chip actor-chip--service"
      title=${svc_person ? nothing : tooltip}
      aria-label=${tooltip}
      data-person-hover=${svc_person ? svc_person.actor : nothing}
      tabindex=${svc_person && options.focusable ? '0' : nothing}
      data-kind="service"
      ><span class="actor-chip__handle"
        >${truncateHandle(service.actor, compact ? 16 : 20)}</span
      ><span class="kind-badge kind-badge--service">service</span>${via &&
      !compact
        ? html`<span class="actor-chip__via"
            >via ${truncateHandle(via, 20)}</span
          >`
        : ''}</span
    >`;
  }
  const owner = options.raw ? null : ownerOf(value);
  const person = options.raw ? null : personFor(value);
  const hover = person ? person.actor : nothing;
  const tab = person && options.focusable ? '0' : nothing;
  if (owner) {
    const compact = Boolean(options.compact);
    const who = owner.display_name
      ? `${owner.display_name} (${owner.actor})`
      : owner.actor;
    const tooltip = `${who} — via ${value}`;
    return html`<span
      class="actor-chip actor-chip--owner"
      title=${person ? nothing : tooltip}
      aria-label=${tooltip}
      data-person-hover=${hover}
      tabindex=${tab}
      data-via=${value}
      ><span class="actor-chip__handle"
        >${truncateHandle(owner.actor, compact ? 14 : 16)}</span
      >${compact
        ? ''
        : html`<span class="actor-chip__via"
            >via ${truncateHandle(value, 20)}</span
          >`}</span
    >`;
  }
  const { parent, handle } = splitActor(value, options);
  const tooltip = formatActorTooltip(value, parent);
  const compact = Boolean(options.compact);
  const shownHandle = truncateHandle(handle, compact ? 14 : 16);
  return html`<span
    class="actor-chip ${parent ? 'actor-chip--sub' : ''}"
    title=${person ? nothing : tooltip}
    aria-label=${tooltip}
    data-person-hover=${hover}
    tabindex=${tab}
    >${parent && !compact
      ? html`<span class="actor-chip__parent"
          >${truncateHandle(parent, 12)} /</span
        >`
      : ''}<span class="actor-chip__handle">${shownHandle}</span></span
  >`;
}
