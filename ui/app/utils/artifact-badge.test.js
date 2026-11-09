import { describe, expect, test } from 'vitest';
import { INTENTS } from '../../../boards/artifacts.mjs';
import {
  artifactLabel,
  artifactRepo,
  createIntentBadge
} from './artifact-badge.js';

describe('utils/artifact-badge intent badge', () => {
  test('renders every intent the shared vocabulary defines', () => {
    for (const intent of INTENTS) {
      const el = createIntentBadge(intent);
      expect(el.classList.contains('intent-badge')).toBe(true);
      expect(el.classList.contains(`intent-badge--${intent}`)).toBe(true);
      expect(el.textContent).toBe(intent);
      expect(el.getAttribute('aria-label')).toBe(`Intent: ${intent}`);
    }
  });

  test('an unrecorded or unknown intent reads as editing, as it does everywhere else', () => {
    for (const value of ['', null, undefined, 'vibing']) {
      const el = createIntentBadge(value);
      expect(el.textContent).toBe('editing');
      expect(el.classList.contains('intent-badge--editing')).toBe(true);
    }
  });

  test('case and whitespace do not create a new intent', () => {
    expect(createIntentBadge('  EDITING ').textContent).toBe('editing');
  });
});

describe('utils/artifact-badge label', () => {
  test('a file or dir shows its path, since the repo is the same on most rows', () => {
    expect(
      artifactLabel({
        kind: 'file',
        repo: 'example-org/feads',
        path: 'ui/server/bd.js'
      })
    ).toBe('ui/server/bd.js');
    expect(
      artifactLabel({
        kind: 'dir',
        repo: 'example-org/feads',
        path: 'ui/server/'
      })
    ).toBe('ui/server/');
  });

  test('a PR shows its number and a repo shows itself', () => {
    expect(
      artifactLabel({ kind: 'pr', repo: 'example-org/feads', pr: 4141 })
    ).toBe('#4141');
    expect(artifactLabel({ kind: 'repo', repo: 'example-org/feads' })).toBe(
      'example-org/feads'
    );
  });

  test('falls back to the ref rather than rendering nothing', () => {
    expect(
      artifactLabel({ kind: 'file', ref: 'example-org/feads:go.mod' })
    ).toBe('example-org/feads:go.mod');
  });

  test('the repo line is omitted for a repo artifact, which would repeat itself', () => {
    expect(artifactRepo({ kind: 'repo', repo: 'example-org/feads' })).toBe('');
    expect(artifactRepo({ kind: 'file', repo: 'example-org/feads' })).toBe(
      'example-org/feads'
    );
  });
});
