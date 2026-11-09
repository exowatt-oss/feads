/**
 * Artifact ref conformance.
 *
 * The cases live in `artifact-cases.json`, not here, because the same table is
 * asserted by the Python implementation in
 * `integrations/beads-mcp/tests/test_artifact_parity.py`. A ref is a join key: two
 * canonicalizers that disagree do not report a wrong answer, they report "nobody
 * else is touching this file" — so the fixture is the contract and both suites are
 * readers of it.
 *
 * This file mirrors that one group for group. The `every group is asserted` guard at
 * the bottom fails when a group is added to the fixture and not read here, which is
 * the point.
 *
 * Run with: node --test boards/
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  ACTIONS,
  ACTION_INTENT,
  INTENTS,
  KINDS,
  MARKER_KEY,
  METADATA_PREFIX,
  artifactValue,
  artifactsFromMetadata,
  expandRepo,
  formatRef,
  intentRank,
  looksLocal,
  metadataKey,
  nowIso,
  normalizeArtifactPath,
  normalizeRepo,
  overlap,
  parseRef,
  parseRemoteUrl,
  refFromLocalPath,
  refFromMetadataKey,
  resolveRef,
  respondComment,
  sortHits
} from './artifacts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'artifact-cases.json'), 'utf8'));

/** Groups this suite reads. Kept explicit so an unread group is a failure. */
const ASSERTED_GROUPS = [
  'parse',
  'format',
  'expand_repo',
  'resolve',
  'remote_url',
  'local_path',
  'overlap',
  'metadata',
  'sort_hits',
  'comment'
];

/**
 * Assert every key the fixture states, ignoring extra keys on the actual value.
 * Cases name the fields they are about; a case that had to restate every field
 * would obscure which one it exists to pin.
 *
 * @param {any} actual
 * @param {Record<string, any>} expected
 * @param {string} label
 */
function assertSubset(actual, expected, label) {
  for (const [key, want] of Object.entries(expected)) {
    assert.deepEqual(actual[key], want, `${label}: ${key}`);
  }
}

/**
 * Run a fixture case that may be an error case.
 *
 * @param {() => any} fn
 * @param {{ throws?: boolean, message_contains?: string, why: string }} c
 * @returns {any} the result, or undefined for an asserted throw
 */
function runCase(fn, c) {
  if (!c.throws) return fn();
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${c.why}: expected a throw`);
  if (c.message_contains) {
    const haystack = `${err.message} ${err.hint || ''}`.toLowerCase();
    assert.ok(
      haystack.includes(c.message_contains.toLowerCase()),
      `${c.why}: message/hint should mention ${c.message_contains} — got ${haystack}`
    );
  }
  return undefined;
}

describe('artifact-cases.json conformance', () => {
  // A silently-empty fixture (bad merge, JSON edit that drops an array) would read as
  // a passing suite, so the counts are asserted too.
  test('the fixture actually has cases', () => {
    for (const group of ASSERTED_GROUPS) {
      assert.ok(Array.isArray(fixture[group]), `${group} is missing`);
      assert.ok(fixture[group].length >= 2, `${group} has only ${fixture[group].length} cases`);
    }
    assert.ok(fixture.parse.length >= 15, `only ${fixture.parse.length} parse cases`);
    assert.ok(fixture.overlap.length >= 18, `only ${fixture.overlap.length} overlap cases`);
  });

  test('every group in the fixture is asserted by this suite', () => {
    const unread = Object.keys(fixture).filter(
      (k) => !k.startsWith('_') && !ASSERTED_GROUPS.includes(k)
    );
    assert.deepEqual(unread, [], `unread fixture groups: ${unread.join(', ')}`);
  });

  for (const c of fixture.parse) {
    test(`parse: ${c.why}`, () => {
      const got = runCase(() => parseRef(c.input), c);
      if (got) assertSubset(got, c.expect, c.why);
    });
  }

  for (const c of fixture.format) {
    test(`format: ${c.why}`, () => {
      const got = runCase(() => formatRef(c.input), c);
      if (got !== undefined) assert.equal(got, c.expect, c.why);
    });
  }

  for (const c of fixture.expand_repo) {
    test(`expand_repo: ${c.why}`, () => {
      const got = runCase(() => expandRepo(c.input.repo, c.input.known_repos), c);
      if (got) assertSubset(got, c.expect, c.why);
    });
  }

  for (const c of fixture.resolve) {
    test(`resolve: ${c.why}`, () => {
      const got = runCase(
        () =>
          resolveRef(c.input.input, {
            known_repos: c.input.known_repos,
            preferred_repos: c.input.preferred_repos,
            current_repo: c.input.current_repo
          }),
        c
      );
      if (got) assertSubset(got, c.expect, c.why);
    });
  }

  for (const c of fixture.remote_url) {
    test(`remote_url: ${c.why}`, () => {
      assert.equal(parseRemoteUrl(c.input), c.expect, c.why);
    });
  }

  for (const c of fixture.local_path) {
    test(`local_path: ${c.why}`, () => {
      const got = runCase(() => refFromLocalPath(c.input), c);
      if (got) assert.equal(got.ref, c.expect, c.why);
    });
  }

  for (const c of fixture.overlap) {
    test(`overlap: ${c.why}`, () => {
      assert.equal(overlap(c.query, c.attached), c.expect, c.why);
    });
  }

  for (const c of fixture.metadata) {
    test(`metadata: ${c.why}`, () => {
      const got = artifactsFromMetadata(c.input);
      assert.equal(got.length, c.expect.length, `${c.why}: artifact count`);
      c.expect.forEach((want, i) => assertSubset(got[i], want, `${c.why}[${i}]`));
    });
  }

  for (const c of fixture.sort_hits) {
    test(`sort_hits: ${c.why}`, () => {
      assert.deepEqual(
        sortHits(c.input).map((h) => h.issue_id),
        c.expect,
        c.why
      );
    });
  }

  for (const c of fixture.comment) {
    test(`comment: ${c.why}`, () => {
      const got = runCase(() => respondComment(c.input), c);
      if (got !== undefined) assert.equal(got, c.expect, c.why);
    });
  }
});

describe('refs round-trip', () => {
  test('parse → format → parse is stable for every fixture case that parses', () => {
    for (const c of fixture.parse) {
      if (c.throws) continue;
      const once = parseRef(c.input);
      const twice = parseRef(formatRef(once));
      assert.equal(twice.ref, once.ref, c.input);
      assert.equal(twice.kind, once.kind, c.input);
    }
  });

  test('the metadata key carries the canonical ref back unchanged', () => {
    for (const ref of [
      'example-org/feads',
      'example-org/feads:ui/server/bd.js',
      'example-org/feads:ui/server/',
      'example-org/feads#4141'
    ]) {
      assert.equal(refFromMetadataKey(metadataKey(ref)), ref);
    }
  });

  test('a non-canonical ref is canonicalized on the way into the key', () => {
    assert.equal(
      metadataKey('example-org/feads:./ui/server/bd.js'),
      `${METADATA_PREFIX}example-org/feads:ui/server/bd.js`
    );
  });

  test('keys that are not artifacts are not artifacts', () => {
    for (const key of ['team', 'has_artifacts', 'artifacts', '', 'artifactory:thing']) {
      assert.equal(refFromMetadataKey(key), null, key);
    }
  });
});

describe('overlap is symmetric in the way the labels claim', () => {
  test('inside one way means covers the other', () => {
    for (const c of fixture.overlap) {
      const back = overlap(c.attached, c.query);
      if (c.expect === 'inside') assert.equal(back, 'covers', c.why);
      else if (c.expect === 'covers') assert.equal(back, 'inside', c.why);
      else assert.equal(back, c.expect, c.why);
    }
  });
});

describe('normalizeRepo', () => {
  test('folds case so one repo is one key', () => {
    assert.equal(normalizeRepo('example-org/FEADS'), 'example-org/feads');
  });

  test('rejects characters that cannot appear in a repo', () => {
    for (const bad of ['owner/na me', 'owner/na:me', 'own er']) {
      assert.throws(() => normalizeRepo(bad), /invalid character/, bad);
    }
  });

  test('rejects an empty repo', () => {
    assert.throws(() => normalizeRepo('   '), /missing repo/);
  });
});

describe('normalizeArtifactPath', () => {
  test('reports the subtree intent separately from the path', () => {
    assert.deepEqual(normalizeArtifactPath('ui/server/'), { path: 'ui/server/', is_dir: true });
    assert.deepEqual(normalizeArtifactPath('ui/server'), { path: 'ui/server', is_dir: false });
  });
});

describe('looksLocal', () => {
  test('recognizes the checkout paths an agent reaches for by reflex', () => {
    for (const p of ['/Users/ana/src/feads/go.mod', '~/src/feads/go.mod', './go.mod', '../feads/go.mod', 'C:\\src\\feads\\go.mod']) {
      assert.ok(looksLocal(p), p);
    }
  });

  test('does not mistake a ref for one', () => {
    for (const r of ['example-org/feads', 'example-org/feads:ui/server/bd.js', 'feads#41', '']) {
      assert.ok(!looksLocal(r), r);
    }
  });
});

describe('artifactValue', () => {
  test('records the parsed shape alongside the intent', () => {
    const v = artifactValue({
      ref: 'example-org/feads:ui/server/bd.js',
      intent: 'reading',
      actor: 'Laptop Claude',
      note: 'reads the spawn choke point',
      at: '2026-07-28T20:38:20Z'
    });
    assert.deepEqual(v, {
      kind: 'file',
      repo: 'example-org/feads',
      path: 'ui/server/bd.js',
      intent: 'reading',
      note: 'reads the spawn choke point',
      actor: 'Laptop Claude',
      at: '2026-07-28T20:38:20Z'
    });
  });

  test('defaults to editing — the intent that makes a collision worth reporting', () => {
    assert.equal(artifactValue({ ref: 'example-org/feads' }).intent, 'editing');
  });

  test('omits empty annotation rather than storing blanks', () => {
    const v = artifactValue({ ref: 'example-org/feads', actor: '', note: '' });
    assert.ok(!('actor' in v), 'actor');
    assert.ok(!('note' in v), 'note');
  });

  test('refuses an intent outside the vocabulary', () => {
    assert.throws(() => artifactValue({ ref: 'example-org/feads', intent: 'maybe' }), /unknown intent/);
  });
});

describe('nowIso', () => {
  test('is second-precision UTC with a Z, matching the Python side exactly', () => {
    assert.equal(nowIso(new Date('2026-07-28T20:38:20.123Z')), '2026-07-28T20:38:20Z');
    assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('vocabularies', () => {
  test('every action records an intent the vocabulary knows, or nothing', () => {
    for (const action of ACTIONS) {
      const intent = ACTION_INTENT[action];
      assert.ok(intent === null || INTENTS.includes(intent), action);
    }
  });

  test('every intent has a conflict rank, and editing ranks first', () => {
    for (const intent of INTENTS) {
      assert.ok(intentRank(intent) < INTENTS.length, intent);
    }
    assert.equal(Math.min(...INTENTS.map(intentRank)), intentRank('editing'));
  });

  test('an unknown intent sorts last rather than first', () => {
    assert.ok(intentRank('vibing') >= INTENTS.length);
  });

  test('kinds and the marker key are what the storage layer promises', () => {
    assert.deepEqual([...KINDS].sort(), ['dir', 'file', 'pr', 'repo']);
    assert.equal(MARKER_KEY, 'has_artifacts');
    assert.equal(METADATA_PREFIX, 'artifact:');
  });
});
