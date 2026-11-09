import { html, render } from 'lit-html';
import { afterEach, describe, expect, test } from 'vitest';
import { createActorChip } from './actor-name.js';
import { createCreatorBadge } from './creator-badge.js';
import {
  actorDisplay,
  actorKind,
  actorLabel,
  handlesOf,
  ownerDirectoryRevision,
  ownerOf,
  personKeyOf,
  samePerson,
  serviceOf,
  setOwnerDirectory
} from './owners.js';

const OWNERS = [
  {
    actor: 'mira',
    display_name: 'alex',
    aliases: ['alex-laptop', 'alex-laptop-triage-probe']
  },
  { actor: 'dana', display_name: 'dana', aliases: ['dana-laptop'] }
];

/** @param {import('lit-html').TemplateResult} tpl */
function mount(tpl) {
  const el = document.createElement('div');
  render(html`${tpl}`, el);
  return el;
}

afterEach(() => {
  setOwnerDirectory([]);
});

describe('owner directory (accounts mode: an alias renders as its person)', () => {
  test('aliases map to their owner; a person, an unclaimed agent and strangers do not', () => {
    setOwnerDirectory(OWNERS);
    expect(ownerOf('alex-laptop')).toEqual({
      actor: 'mira',
      display_name: 'alex'
    });
    expect(ownerOf('alex-LAPTOP')?.actor).toBe('mira');
    expect(ownerOf('mira')).toBeNull();
    expect(ownerOf('botty1')).toBeNull();
    expect(personKeyOf('alex-laptop-triage-probe')).toBe('mira');
    expect(personKeyOf('botty1')).toBe('botty1');
    expect(samePerson('mira', 'alex-laptop')).toBe(true);
    expect(samePerson('dana-laptop', 'alex-laptop')).toBe(false);
    expect(handlesOf('mira')).toEqual([
      'mira',
      'alex-laptop',
      'alex-laptop-triage-probe'
    ]);
    expect(handlesOf('botty1')).toEqual(['botty1']);
    expect(actorDisplay('dana-laptop')).toEqual({
      name: 'dana',
      via: 'dana-laptop',
      display_name: 'dana'
    });
    expect(actorLabel('dana-laptop')).toBe('dana (via dana-laptop)');
    expect(actorLabel('botty1')).toBe('botty1');
  });

  test('accounts off (no owners): every function is the identity', () => {
    setOwnerDirectory(undefined);
    expect(ownerOf('alex-laptop')).toBeNull();
    expect(personKeyOf('alex-laptop')).toBe('alex-laptop');
    expect(actorLabel('alex-laptop')).toBe('alex-laptop');
    expect(samePerson('mira', 'alex-laptop')).toBe(false);
  });

  test('the revision moves only when the map changes', () => {
    const r0 = setOwnerDirectory(OWNERS);
    expect(setOwnerDirectory(OWNERS)).toBe(r0);
    expect(ownerDirectoryRevision()).toBe(r0);
    expect(setOwnerDirectory(OWNERS.slice(0, 1))).toBe(r0 + 1);
  });

  test('the actor chip names the person, the agent as secondary text and tooltip', () => {
    setOwnerDirectory(OWNERS);
    const full = mount(createActorChip('alex-laptop'));
    const chip = full.querySelector('.actor-chip');
    expect(chip?.classList.contains('actor-chip--owner')).toBe(true);
    expect(chip?.querySelector('.actor-chip__handle')?.textContent).toBe(
      'mira'
    );
    expect(chip?.querySelector('.actor-chip__via')?.textContent?.trim()).toBe(
      'via alex-laptop'
    );
    expect(chip?.getAttribute('title')).toBe(
      'alex (mira) — via alex-laptop'
    );
    const compact = mount(createActorChip('alex-laptop', { compact: true }));
    expect(compact.querySelector('.actor-chip__handle')?.textContent).toBe(
      'mira'
    );
    expect(compact.querySelector('.actor-chip__via')).toBeNull();
    expect(
      compact.querySelector('.actor-chip')?.getAttribute('title')
    ).toContain('via alex-laptop');
    // The person's own actor and non-aliases render exactly as before.
    const own = mount(createActorChip('mira'));
    expect(own.querySelector('.actor-chip--owner')).toBeNull();
    expect(own.textContent?.trim()).toBe('mira');
    const raw = mount(createActorChip('alex-laptop', { raw: true }));
    expect(raw.textContent?.trim()).toBe('alex-laptop');
  });

  test('the creator badge names the person and keeps the agent in its tooltip', () => {
    setOwnerDirectory(OWNERS);
    const badge = createCreatorBadge('dana-laptop');
    expect(badge.textContent).toBe('dana');
    expect(badge.getAttribute('title')).toBe(
      'Created by: dana (via dana-laptop)'
    );
  });
});

describe('service accounts (a user that is not a person) are labelled as such', () => {
  const WITH_SERVICES = [
    ...OWNERS,
    {
      actor: 'botty1',
      display_name: 'botty1',
      aliases: [],
      kind: 'service',
      steward: { actor: 'mira', display_name: 'alex' }
    },
    {
      actor: 'sample-service-agent',
      display_name: 'sample-service',
      aliases: ['sample-service-child'],
      kind: 'service',
      steward: { actor: 'mira', display_name: 'alex' }
    }
  ];

  test('serviceOf / actorKind: services, their aliases, people, strangers', () => {
    setOwnerDirectory(WITH_SERVICES);
    expect(serviceOf('botty1')).toEqual({
      actor: 'botty1',
      display_name: 'botty1',
      kind: 'service',
      steward: { actor: 'mira', display_name: 'alex' }
    });
    expect(serviceOf('botty1')?.actor).toBe('botty1');
    expect(serviceOf('sample-service-child')?.actor).toBe('sample-service-agent');
    expect(serviceOf('mira')).toBeNull();
    expect(serviceOf('alex-laptop')).toBeNull();
    expect(actorKind('botty1')).toBe('service');
    expect(actorKind('sample-service-child')).toBe('service');
    expect(actorKind('alex-laptop')).toBe('human');
    expect(actorKind('mira')).toBe('human');
    expect(actorKind('stranger')).toBe('');
    // A service is never anyone's alias: it is not a person's "via".
    expect(ownerOf('botty1')).toBeNull();
    expect(actorLabel('botty1')).toBe('botty1');
  });

  test('a steward change moves the revision', () => {
    const r0 = setOwnerDirectory(WITH_SERVICES);
    const moved = WITH_SERVICES.map((o) =>
      o.actor === 'botty1'
        ? { ...o, steward: { actor: 'dana', display_name: 'dana' } }
        : o
    );
    expect(setOwnerDirectory(moved)).toBe(r0 + 1);
  });

  test('the actor chip and the creator badge carry a "service" badge and the steward', () => {
    setOwnerDirectory(WITH_SERVICES);
    const el = mount(createActorChip('botty1'));
    const chip = el.querySelector('.actor-chip');
    expect(chip?.classList.contains('actor-chip--service')).toBe(true);
    expect(chip?.getAttribute('data-kind')).toBe('service');
    expect(chip?.querySelector('.actor-chip__handle')?.textContent).toBe(
      'botty1'
    );
    expect(chip?.querySelector('.kind-badge')?.textContent).toBe('service');
    expect(chip?.getAttribute('title')).toBe(
      'botty1 · service account — steward alex'
    );
    const child = mount(createActorChip('sample-service-child'));
    expect(child.querySelector('.actor-chip__handle')?.textContent).toBe(
      'sample-service-agent'
    );
    expect(child.querySelector('.actor-chip__via')?.textContent).toContain(
      'sample-service-child'
    );
    const badge = createCreatorBadge('botty1');
    expect(badge.classList.contains('creator-badge--service')).toBe(true);
    expect(badge.querySelector('.kind-badge')?.textContent).toBe('service');
    expect(badge.getAttribute('title')).toBe(
      'Created by: botty1 · service account — steward alex'
    );
    // People are unchanged.
    expect(
      mount(createActorChip('alex-laptop')).querySelector('.kind-badge')
    ).toBeNull();
    expect(
      createCreatorBadge('dana-laptop').querySelector('.kind-badge')
    ).toBeNull();
  });
});
