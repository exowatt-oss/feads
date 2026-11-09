import { truncateHandle } from './actor-name.js';
import { actorDisplay, serviceOf, serviceTitle } from './owners.js';

/**
 * Create a compact badge naming the actor that filed an item.
 *
 * A board that several agents write to is unreadable without this: every card looks
 * like it came from nowhere, and "who is doing this" is the first question anyone
 * asks of a shared board. bd records it as `created_by`, populated from `BEADS_ACTOR`
 * — the same minted actor name feads issues to each agent — so it is the identity the
 * permission model already compares against, not a guess.
 *
 * Long actor names are shortened for the badge, never for the tooltip: `mira@
 * example.test` shows as `mira` but hovers as the full string, because the short form
 * is for scanning a column and the full one is for telling two agents apart.
 *
 * @param {string | undefined | null} created_by
 * @returns {HTMLSpanElement}
 */
export function createCreatorBadge(created_by) {
  const el = document.createElement('span');
  el.className = 'creator-badge';
  const actor = String(created_by || '').trim();
  if (actor.length === 0) {
    // An item with no recorded creator predates actor attribution (or was filed by a
    // bd that had none). Say so rather than rendering an empty pill: "unknown" is a
    // fact about the item, an empty badge is a rendering bug.
    el.classList.add('creator-badge--unknown');
    el.setAttribute('title', 'Created by: unknown');
    el.setAttribute('aria-label', 'Created by: unknown');
    el.textContent = '—';
    return el;
  }
  // Accounts mode: a service account is labelled as one.
  const service = serviceOf(actor);
  if (service) {
    el.classList.add('creator-badge--service');
    el.dataset.kind = 'service';
    el.setAttribute('title', `Created by: ${serviceTitle(service)}`);
    el.setAttribute('aria-label', `Created by: ${serviceTitle(service)}`);
    el.textContent = shortenActor(service.actor);
    const tag = document.createElement('span');
    tag.className = 'kind-badge kind-badge--service';
    tag.textContent = 'service';
    el.append(tag);
    return el;
  }
  // Accounts mode: an alias is named as its person, the agent kept in the tooltip.
  const shown = actorDisplay(actor);
  const full = shown.via ? `${shown.name} (via ${shown.via})` : actor;
  el.setAttribute('title', `Created by: ${full}`);
  el.setAttribute('aria-label', `Created by: ${full}`);
  el.textContent = shortenActor(shown.name);
  return el;
}

/**
 * Beyond this the badge crowds the type and priority badges beside it. Chosen so an
 * ordinary minted name (`laptop-claude`) is never shortened at all.
 *
 * It must stay in step with `.creator-badge { max-width }` in styles.css, which is one
 * `ch` wider. If CSS is the tighter of the two it clips with its own ellipsis on the
 * *right*, and a name shortened from the front then loses both ends — which is how
 * `better-tickets-pid638` rendered as `…er-ticket…`, unreadable and pointless.
 */
const MAX_BADGE_LENGTH = 14;

/**
 * The scannable form of an actor name.
 *
 * @param {string} actor
 * @returns {string}
 */
export function shortenActor(actor) {
  // An email identifies a person by its local part; the domain is the same for
  // everyone on the board and costs the whole badge width.
  const at = actor.indexOf('@');
  const base = at > 0 ? actor.slice(0, at) : actor;
  if (base.length <= MAX_BADGE_LENGTH) return base;
  return truncateHandle(base, MAX_BADGE_LENGTH);
}
