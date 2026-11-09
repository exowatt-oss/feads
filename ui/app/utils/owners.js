/**
 * feads accounts mode — display an alias as its owner.
 *
 * Under accounts mode every agent identity is an alias of a person
 * (`alex-laptop` → mira) — or of a service account (botty1, sample-service-agent:
 * a user that is not a person, labelled `service` everywhere and never given a
 * person's hover card). The server delivers, with `list-users`, who each
 * alias the caller may see belongs to (`owners`: the directory rule — people who
 * share a space with you). Every surface that names an actor asks this module, so
 * cards, rows, detail, Agentwatch, Users and the Person filter agree: the person
 * first, the agent as secondary text (`via alex-laptop`). Stored history is never
 * rewritten — only how an actor is named. Accounts off: the map is empty and every
 * function is the identity.
 */

/**
 * @typedef {{ actor: string, display_name: string, kind?: 'human'|'service',
 *             steward?: { actor: string, display_name: string } | null }} Owner
 */

/** @type {Map<string, Owner>} lower-cased alias → owner */
let OWNERS = new Map();
/** @type {Map<string, Owner>} lower-cased service actor or alias → the service */
let SERVICES = new Map();
/** @type {Map<string, string[]>} lower-cased owner actor → every handle of theirs */
let HANDLES = new Map();
let REVISION = 0;

/**
 * Replace the owner directory (main.js, on every `list-users` answer).
 *
 * @param {unknown} owners - `[{ actor, display_name, aliases: string[], kind?, steward? }]`
 * @returns {number} the new revision (changes whenever the map does)
 */
export function setOwnerDirectory(owners) {
  /** @type {Map<string, Owner>} */
  const next = new Map();
  /** @type {Map<string, Owner>} */
  const services = new Map();
  /** @type {Map<string, string[]>} */
  const handles = new Map();
  for (const entry of Array.isArray(owners) ? owners : []) {
    const actor = String(entry?.actor || '').trim();
    if (!actor) continue;
    const kind = entry?.kind === 'service' ? 'service' : 'human';
    const steward =
      kind === 'service' && entry?.steward && entry.steward.actor
        ? {
            actor: String(entry.steward.actor),
            display_name: String(entry.steward.display_name || '')
          }
        : null;
    /** @type {Owner} */
    const owner = {
      actor,
      display_name: String(entry?.display_name || '').trim(),
      // Only a service carries its kind and steward; a person stays the plain
      // { actor, display_name } every caller already reads.
      ...(kind === 'service' ? { kind, steward } : {})
    };
    if (kind === 'service') services.set(actor.toLowerCase(), owner);
    const all = [actor];
    for (const raw of Array.isArray(entry?.aliases) ? entry.aliases : []) {
      const alias = String(raw || '').trim();
      if (!alias || alias.toLowerCase() === actor.toLowerCase()) continue;
      if (!next.has(alias.toLowerCase())) next.set(alias.toLowerCase(), owner);
      if (kind === 'service' && !services.has(alias.toLowerCase())) {
        services.set(alias.toLowerCase(), owner);
      }
      all.push(alias);
    }
    handles.set(actor.toLowerCase(), all);
  }
  /**
   * @param {Map<string, Owner>} a - the new map
   * @param {Map<string, Owner>} b - the current one
   */
  const differs = (a, b) =>
    a.size !== b.size ||
    [...a].some(([k, v]) => {
      const was = b.get(k);
      return (
        !was ||
        was.actor !== v.actor ||
        was.display_name !== v.display_name ||
        was.kind !== v.kind ||
        (was.steward?.actor || '') !== (v.steward?.actor || '')
      );
    });
  const changed = differs(next, OWNERS) || differs(services, SERVICES);
  OWNERS = next;
  SERVICES = services;
  HANDLES = handles;
  if (changed) REVISION += 1;
  return REVISION;
}

/** @returns {number} */
export function ownerDirectoryRevision() {
  return REVISION;
}

/**
 * The person an actor is an alias of, or `null` when it is nobody's alias (a
 * person's own actor, an unclaimed agent, an actor outside your spaces).
 *
 * @param {string | null | undefined} actor
 * @returns {Owner | null}
 */
export function ownerOf(actor) {
  const key = String(actor || '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  return OWNERS.get(key) || null;
}

/**
 * The service account an actor is (or is an alias of), or `null` for people,
 * unclaimed agents and actors outside your spaces.
 *
 * @param {string | null | undefined} actor
 * @returns {Owner | null}
 */
export function serviceOf(actor) {
  const key = String(actor || '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  return SERVICES.get(key) || null;
}

/**
 * `'service'` for a service account (or its alias), `'human'` for a known person,
 * `''` when the directory does not say (accounts off, unclaimed, out of scope).
 * The @mention hover card asks this before it looks a person up.
 *
 * @param {string | null | undefined} actor
 * @returns {'service'|'human'|''}
 */
export function actorKind(actor) {
  if (serviceOf(actor)) return 'service';
  const key = String(actor || '')
    .trim()
    .toLowerCase();
  if (!key) return '';
  return OWNERS.has(key) || HANDLES.has(key) ? 'human' : '';
}

/**
 * Tooltip text naming a service account and its steward.
 *
 * @param {Owner} service
 * @returns {string}
 */
export function serviceTitle(service) {
  const who =
    service.display_name && service.display_name !== service.actor
      ? `${service.display_name} (${service.actor})`
      : service.actor;
  const steward = service.steward
    ? ` — steward ${service.steward.display_name || service.steward.actor}`
    : '';
  return `${who} · service account${steward}`;
}

/**
 * The key that groups an actor with the rest of its person's aliases: the owner's
 * actor for an alias, the actor itself otherwise.
 *
 * @param {string | null | undefined} actor
 * @returns {string}
 */
export function personKeyOf(actor) {
  const value = String(actor || '').trim();
  return ownerOf(value)?.actor || value;
}

/**
 * Whether two actors are the same person.
 *
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
export function samePerson(a, b) {
  const x = personKeyOf(a);
  const y = personKeyOf(b);
  return x.length > 0 && x.toLowerCase() === y.toLowerCase();
}

/**
 * Every handle a person key stands for (their actor and their aliases), for
 * filters; just the key when it is not a known person.
 *
 * @param {string} person
 * @returns {string[]}
 */
export function handlesOf(person) {
  const value = String(person || '').trim();
  return HANDLES.get(value.toLowerCase()) || (value ? [value] : []);
}

/**
 * How to name an actor in plain text: `{ name, via }`, where `via` is the agent
 * label when the actor is someone's alias (`'' ` otherwise). `name` is the owner's
 * actor — the handle convention every chip uses — or the actor itself.
 *
 * @param {string | null | undefined} actor
 * @returns {{ name: string, via: string, display_name: string }}
 */
export function actorDisplay(actor) {
  const value = String(actor || '').trim();
  const owner = ownerOf(value);
  if (!owner) return { name: value, via: '', display_name: '' };
  return { name: owner.actor, via: value, display_name: owner.display_name };
}

/**
 * Plain-text label: `mira (via alex-laptop)` for an alias, else the actor.
 *
 * @param {string | null | undefined} actor
 * @returns {string}
 */
export function actorLabel(actor) {
  const d = actorDisplay(actor);
  return d.via ? `${d.name} (via ${d.via})` : d.name;
}
