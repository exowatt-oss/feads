/**
 * feads accounts mode — who a handle is, for the person hover card.
 *
 * `list-users` sends, under the directory rule, the people the caller may see
 * (`people`: actor, email, display name, kind) next to the alias → owner map
 * (`owners`, see owners.js). Together they answer "which person is
 * `@alex-laptop`?" → mira, mira@example.test. Only an email resolves in
 * the optional directory, so a handle that maps to no person stays plain text: no trigger, no
 * tab stop, no request. A service account (`kind: 'service'`, or no email) is
 * a person-shaped label — the card says so and never asks the optional directory.
 *
 * Accounts off: the map is empty and nothing is a person.
 */
import { handlesOf, ownerOf } from './owners.js';

/**
 * @typedef {{ actor: string, email: string, display_name: string,
 *             kind: 'human' | 'service', steward: string }} PersonInfo
 */

/** @type {Map<string, PersonInfo>} lower-cased actor → person */
let PEOPLE = new Map();
let REVISION = 0;

/**
 * Replace the people directory (main.js and detail.js, on every `list-users`
 * answer that carries one).
 *
 * @param {unknown} people - `[{ actor, email, display_name, kind, steward? }]`
 * @returns {number} the new revision (changes whenever the map does)
 */
export function setPeopleDirectory(people) {
  if (!Array.isArray(people)) return REVISION;
  /** @type {Map<string, PersonInfo>} */
  const next = new Map();
  for (const entry of people) {
    const actor = String(entry?.actor || '').trim();
    if (!actor) continue;
    const email = String(entry?.email || '')
      .trim()
      .toLowerCase();
    const service =
      String(entry?.kind || '').toLowerCase() === 'service' || !email;
    next.set(actor.toLowerCase(), {
      actor,
      email: service ? '' : email,
      display_name: String(entry?.display_name || '').trim(),
      kind: service ? 'service' : 'human',
      steward: String(entry?.steward || '').trim()
    });
  }
  const changed =
    next.size !== PEOPLE.size ||
    [...next].some(([k, v]) => {
      const was = PEOPLE.get(k);
      return (
        !was ||
        was.email !== v.email ||
        was.display_name !== v.display_name ||
        was.kind !== v.kind ||
        was.steward !== v.steward
      );
    });
  PEOPLE = next;
  if (changed) REVISION += 1;
  return REVISION;
}

/** @returns {number} */
export function peopleDirectoryRevision() {
  return REVISION;
}

/**
 * The person a handle (their actor, or any alias of theirs) names, or `null`.
 *
 * @param {string | null | undefined} handle
 * @returns {PersonInfo | null}
 */
export function personFor(handle) {
  const key = String(handle || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
  if (!key) return null;
  const direct = PEOPLE.get(key);
  if (direct) return direct;
  const owner = ownerOf(key);
  return owner ? PEOPLE.get(owner.actor.toLowerCase()) || null : null;
}

/**
 * Every handle that names a person (each person's actor and aliases),
 * lower-cased — what a mention renderer treats as "known" when it has no actor
 * list of its own (the bell). `null` while the directory is empty (accounts
 * off, not loaded yet), which renderers read as "highlight anything shaped
 * like a mention".
 *
 * @returns {Set<string> | null}
 */
export function knownPersonHandles() {
  if (PEOPLE.size === 0) return null;
  /** @type {Set<string>} */
  const out = new Set();
  for (const person of PEOPLE.values()) {
    for (const handle of handlesOf(person.actor)) out.add(handle.toLowerCase());
  }
  return out;
}
