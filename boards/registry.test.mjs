/**
 * Tests for the SQLite board registry.
 *
 * Uses node:test + node:sqlite, both built in, so this suite adds no
 * dependencies to the repo. Run with: node --test boards/
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  addRepos,
  describeBoard,
  getBoard,
  getRegistryPath,
  getValidatedSiloSlug,
  listBoards,
  listDescriptionHistory,
  openRegistry,
  removeBoard,
  removeRepos,
  routeTask,
  setRepos,
  slugify,
  upsertBoard
} from './registry.mjs';

const tmp_root = fs.mkdtempSync(path.join(os.tmpdir(), 'feads-registry-test-'));
let db_seq = 0;

/** @returns {import('node:sqlite').DatabaseSync} */
function freshDb() {
  db_seq += 1;
  return openRegistry({ path: path.join(tmp_root, `r${db_seq}.db`) });
}

after(() => fs.rmSync(tmp_root, { recursive: true, force: true }));

describe('schema', () => {
  test('base and unset registries never create the silo auth_bindings table', () => {
    for (const value of [undefined, '']) {
      const p = path.join(tmp_root, `base-schema-${String(value || 'unset')}.db`);
      const db = openRegistry({ path: p, env: { FEADS_SILO: value } });
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_bindings'")
        .get();
      assert.equal(table, undefined, `auth_bindings must stay absent for FEADS_SILO=${value}`);
      db.close();
    }
  });

  test('hosted silo mode fails closed', () => {
    assert.throws(() => openRegistry({
      path: path.join(tmp_root, 'silo-refused.db'),
      env: { FEADS_SILO: 'alpha' }
    }), /unavailable/);
  });

  test('opening twice is idempotent and preserves rows', () => {
    const p = path.join(tmp_root, 'idem.db');
    const a = openRegistry({ path: p });
    upsertBoard(a, { id: 'x', name: 'X', board_dir: path.join(tmp_root, 'x') });
    a.close();
    const b = openRegistry({ path: p });
    assert.equal(listBoards(b).length, 1);
    b.close();
  });

  test('getRegistryPath honors FEADS_REGISTRY_DB', () => {
    const prev = process.env.FEADS_REGISTRY_DB;
    process.env.FEADS_REGISTRY_DB = '/tmp/some/place.db';
    assert.equal(getRegistryPath(), '/tmp/some/place.db');
    if (prev === undefined) delete process.env.FEADS_REGISTRY_DB;
    else process.env.FEADS_REGISTRY_DB = prev;
  });
});

describe('slugify', () => {
  test('normalizes free text into an id', () => {
    assert.equal(slugify('Sample Project'), 'sample-project');
    assert.equal(slugify('  sample controller!! '), 'sample-controller');
    assert.equal(slugify('---'), '');
  });
});

describe('boards CRUD', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
  });

  test('upsert creates then updates in place', () => {
    const dir = path.join(tmp_root, 'b1');
    const created = upsertBoard(db, {
      id: 'lab',
      name: 'Lab',
      board_dir: dir,
      description: 'first'
    });
    assert.equal(created.id, 'lab');
    assert.equal(created.description, 'first');

    upsertBoard(db, { id: 'lab', name: 'Lab 2', board_dir: dir, description: 'second' });
    const boards = listBoards(db);
    assert.equal(boards.length, 1, 'upsert must not create a duplicate row');
    assert.equal(boards[0].name, 'Lab 2');
    assert.equal(boards[0].description, 'second');
  });

  test('derives the id from the name when none is given', () => {
    const b = upsertBoard(db, { name: 'sample controller', board_dir: path.join(tmp_root, 'b2') });
    assert.equal(b.id, 'sample-controller');
  });

  test('rejects a name with no slug-able characters', () => {
    assert.throws(
      () => upsertBoard(db, { name: '!!!', board_dir: path.join(tmp_root, 'b3') }),
      /could not be derived/
    );
  });

  // Two ids pointing at one database would make routing ambiguous: a task could
  // be filed to either and land in the same place under a different name.
  test('refuses to let a second board claim an existing board_dir', () => {
    const dir = path.join(tmp_root, 'shared');
    upsertBoard(db, { id: 'first', name: 'First', board_dir: dir });
    assert.throws(
      () => upsertBoard(db, { id: 'second', name: 'Second', board_dir: dir }),
      /already registered as "first"/
    );
  });

  test('getBoard resolves by id or by board_dir', () => {
    const dir = path.join(tmp_root, 'b4');
    upsertBoard(db, { id: 'byid', name: 'ById', board_dir: dir });
    assert.equal(getBoard(db, 'byid')?.id, 'byid');
    assert.equal(getBoard(db, dir)?.id, 'byid');
    assert.equal(getBoard(db, 'nope'), null);
  });

  test('remove drops the board and cascades its repos', () => {
    upsertBoard(db, {
      id: 'gone',
      name: 'Gone',
      board_dir: path.join(tmp_root, 'b5'),
      repos: ['o/r']
    });
    assert.equal(removeBoard(db, 'gone'), true);
    assert.equal(removeBoard(db, 'gone'), false, 'removing twice reports no change');
    const orphans = db.prepare('SELECT COUNT(*) AS n FROM board_repos').get();
    assert.equal(Number(orphans.n), 0, 'board_repos must cascade');
  });
});

describe('repos', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    upsertBoard(db, { id: 'b', name: 'B', board_dir: path.join(tmp_root, 'repos') });
  });

  test('setRepos replaces the whole list', () => {
    setRepos(db, 'b', ['o/one', 'o/two']);
    setRepos(db, 'b', ['o/three']);
    assert.deepEqual(getBoard(db, 'b').repos, ['o/three']);
  });

  test('addRepos merges without dropping, and de-duplicates', () => {
    setRepos(db, 'b', ['o/one']);
    addRepos(db, 'b', ['o/two', 'o/one']);
    assert.deepEqual(getBoard(db, 'b').repos, ['o/one', 'o/two']);
  });

  test('blank entries are ignored', () => {
    setRepos(db, 'b', ['  ', '', 'o/real']);
    assert.deepEqual(getBoard(db, 'b').repos, ['o/real']);
  });

  test('removeRepos deletes only the named repos and reports how many', () => {
    setRepos(db, 'b', ['o/one', 'o/two', 'o/three']);
    const removed = removeRepos(db, 'b', ['o/two', 'o/absent']);
    assert.equal(removed, 1);
    assert.deepEqual(getBoard(db, 'b').repos, ['o/one', 'o/three']);
  });

  test('removeRepos of everything leaves a legal repo-less board', () => {
    setRepos(db, 'b', ['o/one']);
    assert.equal(removeRepos(db, 'b', ['o/one']), 1);
    assert.deepEqual(getBoard(db, 'b').repos, []);
    assert.ok(getBoard(db, 'b'));
  });

  test('concurrent-style add + remove compose instead of clobbering', () => {
    // The reason set-replace is not the MCP verb: interleaved adds from two
    // writers survive because each statement targets its own rows.
    setRepos(db, 'b', ['o/base']);
    addRepos(db, 'b', ['o/from-agent-a']);
    addRepos(db, 'b', ['o/from-agent-b']);
    removeRepos(db, 'b', ['o/base']);
    assert.deepEqual(getBoard(db, 'b').repos, ['o/from-agent-a', 'o/from-agent-b']);
  });
});

/**
 * A board description is what `routeTask` scores against, so replacing one is not
 * an edit to a label — it is an edit to how every future task finds its board. On
 * 2026-07-30 a describe made from a ~23h-stale read replaced two freshly authored
 * descriptions, and one was recovered only because a transcript happened to hold
 * it. These are the three protections that came out of that: history, echo, and an
 * opt-in compare-and-set.
 */
describe('description history', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    upsertBoard(db, {
      id: 'lab',
      name: 'Lab',
      board_dir: path.join(tmp_root, `hist${db_seq}`),
      description: 'the original, carefully written'
    });
  });

  test('an overwrite appends the previous value, not the new one', () => {
    describeBoard(db, { id: 'lab', description: 'clobbered by a stale read' });
    const history = listDescriptionHistory(db, 'lab');
    assert.equal(history.length, 1);
    assert.equal(history[0].description, 'the original, carefully written');
    assert.equal(history[0].name, 'Lab');
    assert.ok(history[0].replaced_at > 0);
  });

  test('every writer inherits it, including register-style upserts', () => {
    // The guard lives at the single write site, so a caller that never heard of
    // describeBoard still cannot overwrite a description without leaving a copy.
    upsertBoard(db, {
      id: 'lab',
      name: 'Lab',
      board_dir: path.join(tmp_root, `hist${db_seq}`),
      description: 'rewritten by a re-register'
    });
    assert.equal(listDescriptionHistory(db, 'lab')[0].description, 'the original, carefully written');
  });

  test('a name change is history too', () => {
    describeBoard(db, { id: 'lab', name: 'example Lab' });
    const history = listDescriptionHistory(db, 'lab');
    assert.equal(history.length, 1);
    assert.equal(history[0].name, 'Lab');
    assert.equal(history[0].description, 'the original, carefully written');
  });

  test('rewriting the same text records nothing', () => {
    // An idempotent retry must not bury the value worth recovering under copies.
    describeBoard(db, { id: 'lab', description: 'the original, carefully written' });
    assert.equal(listDescriptionHistory(db, 'lab').length, 0);
  });

  test('successive overwrites stack newest-first', () => {
    describeBoard(db, { id: 'lab', description: 'second' });
    describeBoard(db, { id: 'lab', description: 'third' });
    assert.deepEqual(
      listDescriptionHistory(db, 'lab').map((r) => r.description),
      ['second', 'the original, carefully written']
    );
  });

  test('records the acting agent from BEADS_ACTOR', () => {
    const prev = process.env.BEADS_ACTOR;
    process.env.BEADS_ACTOR = 'alex-laptop';
    describeBoard(db, { id: 'lab', description: 'by an identified agent' });
    if (prev === undefined) delete process.env.BEADS_ACTOR;
    else process.env.BEADS_ACTOR = prev;
    assert.equal(listDescriptionHistory(db, 'lab')[0].actor, 'alex-laptop');
  });

  test('an explicit actor beats the environment', () => {
    describeBoard(db, { id: 'lab', description: 'by a named caller', actor: 'dashboard' });
    assert.equal(listDescriptionHistory(db, 'lab')[0].actor, 'dashboard');
  });

  test('history outlives unregistering the board', () => {
    // `remove` does not delete the board's database, and it must not delete the
    // record of what its description said either.
    describeBoard(db, { id: 'lab', description: 'replaced before removal' });
    removeBoard(db, 'lab');
    assert.equal(listDescriptionHistory(db, 'lab').length, 1);
  });

  test('limit is honoured', () => {
    describeBoard(db, { id: 'lab', description: 'two' });
    describeBoard(db, { id: 'lab', description: 'three' });
    assert.equal(listDescriptionHistory(db, 'lab', { limit: 1 }).length, 1);
  });
});

describe('describeBoard', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    upsertBoard(db, {
      id: 'lab',
      name: 'Lab',
      board_dir: path.join(tmp_root, `desc${db_seq}`),
      description: 'original',
      repos: ['o/one']
    });
  });

  test('echoes what it replaced alongside what it wrote', () => {
    const result = describeBoard(db, { id: 'lab', description: 'replacement' });
    assert.deepEqual(result.previous, { name: 'Lab', description: 'original' });
    assert.equal(result.board.description, 'replacement');
    assert.equal(result.changed, true);
  });

  test('reports changed: false when nothing moved', () => {
    const result = describeBoard(db, { id: 'lab', description: 'original' });
    assert.equal(result.changed, false);
    assert.deepEqual(result.previous, { name: 'Lab', description: 'original' });
  });

  test('leaves the field the caller did not name alone', () => {
    const result = describeBoard(db, { id: 'lab', name: 'example Lab' });
    assert.equal(result.board.name, 'example Lab');
    assert.equal(result.board.description, 'original');
  });

  test('keeps board_dir, workspace and repos', () => {
    const before = getBoard(db, 'lab');
    const result = describeBoard(db, { id: 'lab', description: 'replacement' });
    assert.equal(result.board.board_dir, before.board_dir);
    assert.equal(result.board.workspace_dir, before.workspace_dir);
    assert.deepEqual(result.board.repos, ['o/one']);
  });

  test('resolves a board by its directory, as the CLI does', () => {
    const dir = getBoard(db, 'lab').board_dir;
    assert.equal(describeBoard(db, { id: dir, description: 'by dir' }).board.id, 'lab');
  });

  test('refuses an unknown board', () => {
    assert.throws(() => describeBoard(db, { id: 'nope', description: 'x' }), /no such board/);
  });
});

describe('compare-and-set on a description', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    upsertBoard(db, {
      id: 'lab',
      name: 'Lab',
      board_dir: path.join(tmp_root, `cas${db_seq}`),
      description: 'what agent A wrote'
    });
  });

  test('a matching expectation goes through', () => {
    const result = describeBoard(db, {
      id: 'lab',
      description: 'what agent B wrote',
      expected_description: 'what agent A wrote'
    });
    assert.equal(result.board.description, 'what agent B wrote');
    assert.equal(getBoard(db, 'lab').description, 'what agent B wrote');
  });

  test('a stale expectation is refused, and the write does not happen', () => {
    // The 2026-07-30 shape exactly: B read the board, A rewrote it, B writes.
    upsertBoard(db, {
      id: 'lab',
      name: 'Lab',
      board_dir: path.join(tmp_root, `cas${db_seq}`),
      description: 'what agent A wrote later'
    });
    assert.throws(
      () =>
        describeBoard(db, {
          id: 'lab',
          description: 'what agent B wrote',
          expected_description: 'what agent A wrote'
        }),
      (err) => {
        assert.equal(err.name, 'DescriptionConflictError');
        // The current value is in the error because the caller's next move is to
        // merge into it — this error is already the re-read.
        assert.equal(err.current_description, 'what agent A wrote later');
        assert.match(err.message, /what agent A wrote later/);
        assert.match(err.message, /changed since you read it/);
        assert.ok(err.updated_at > 0, 'names when it changed');
        assert.match(err.message, new RegExp(new Date(err.updated_at).toISOString()));
        return true;
      }
    );
    assert.equal(getBoard(db, 'lab').description, 'what agent A wrote later');
  });

  test('a refused write leaves no history row', () => {
    assert.throws(() =>
      describeBoard(db, {
        id: 'lab',
        description: 'never applied',
        expected_description: 'something else entirely'
      })
    );
    assert.equal(listDescriptionHistory(db, 'lab').length, 0);
  });

  test("surrounding whitespace is not somebody else's edit", () => {
    // The expected value arrives through a shell and a JSON body; a trailing
    // newline is not a conflict, and anything that survives trimming is.
    const result = describeBoard(db, {
      id: 'lab',
      description: 'merged',
      expected_description: '  what agent A wrote\n'
    });
    assert.equal(result.board.description, 'merged');
  });

  test('omitting the expectation is the old behaviour, plus history', () => {
    const result = describeBoard(db, { id: 'lab', description: 'blind overwrite' });
    assert.equal(result.board.description, 'blind overwrite');
    assert.equal(listDescriptionHistory(db, 'lab')[0].description, 'what agent A wrote');
  });

  test('expecting a description on a board that does not exist is a conflict', () => {
    assert.throws(
      () =>
        upsertBoard(db, {
          id: 'ghost',
          name: 'Ghost',
          board_dir: path.join(tmp_root, `ghost${db_seq}`),
          description: 'new',
          expected_description: 'something'
        }),
      /does not exist/
    );
  });

  test('a name-only describe still honours the expectation', () => {
    assert.throws(
      () => describeBoard(db, { id: 'lab', name: 'Renamed', expected_description: 'stale' }),
      /changed since you read it/
    );
  });
});

describe('an absent description leaves the stored one alone', () => {
  // Same clobber class as a stale describe, reached through a different door:
  // re-registering a board with no --description used to blank the text routing
  // scores against.
  test('re-upserting without a description keeps it', () => {
    const db = freshDb();
    const dir = path.join(tmp_root, `keep${db_seq}`);
    upsertBoard(db, { id: 'lab', name: 'Lab', board_dir: dir, description: 'keep me' });
    upsertBoard(db, { id: 'lab', name: 'Lab', board_dir: dir });
    assert.equal(getBoard(db, 'lab').description, 'keep me');
    assert.equal(listDescriptionHistory(db, 'lab').length, 0, 'nothing was replaced');
  });

  test('an explicit empty string still clears it', () => {
    const db = freshDb();
    const dir = path.join(tmp_root, `clear${db_seq}`);
    upsertBoard(db, { id: 'lab', name: 'Lab', board_dir: dir, description: 'clear me' });
    upsertBoard(db, { id: 'lab', name: 'Lab', board_dir: dir, description: '' });
    assert.equal(getBoard(db, 'lab').description, '');
    assert.equal(listDescriptionHistory(db, 'lab')[0].description, 'clear me');
  });
});

describe('routeTask', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    upsertBoard(db, {
      id: 'lab',
      name: 'example Lab',
      board_dir: path.join(tmp_root, 'lab'),
      description: 'sample controller fleet deployments provisioning dispatch',
      repos: ['example-lab/sample-controller', 'example-lab/deployments']
    });
    upsertBoard(db, {
      id: 'exoapp',
      name: 'ExoApp Mobile',
      board_dir: path.join(tmp_root, 'exoapp'),
      description: 'react native operator app telemetry push alerts',
      repos: ['example-org/exoapp']
    });
  });

  test('exact repo match scores 100 and wins', () => {
    const r = routeTask(db, { text: 'anything', repo: 'example-lab/sample-controller' });
    assert.equal(r[0].board.id, 'lab');
    assert.equal(r[0].score, 100);
    assert.match(r[0].reasons[0], /exact repo match/);
  });

  test('matching is case-insensitive', () => {
    const r = routeTask(db, { text: '', repo: 'example-lab/sample-controller' });
    assert.equal(r[0].board.id, 'lab');
    assert.equal(r[0].score, 100);
  });

  test('a bare repo name scores 60', () => {
    const r = routeTask(db, { text: '', repo: 'exoapp' });
    assert.equal(r[0].board.id, 'exoapp');
    assert.equal(r[0].score, 60);
    assert.match(r[0].reasons[0], /repo name match/);
  });

  // The whole point of weighting repos above prose: "which repo does this touch"
  // is checkable, description similarity is only a hint.
  test('an explicit repo beats a board whose prose matches better', () => {
    const r = routeTask(db, {
      text: 'sample controller fleet deployments provisioning dispatch',
      repo: 'example-org/exoapp'
    });
    assert.equal(r[0].board.id, 'exoapp', 'explicit repo must win');
    assert.ok(r[0].score > r[1].score);
  });

  test('a repo named in free text scores without a --repo flag', () => {
    const r = routeTask(db, { text: 'the exoapp build is broken' });
    assert.equal(r[0].board.id, 'exoapp');
    assert.ok(r[0].reasons.some((x) => /text mentions repo/.test(x)));
  });

  // Repos are hyphenated; people writing a task are not. Matching raw
  // substrings silently missed every multi-word repo name.
  test('an unhyphenated repo name in free text still matches', () => {
    const r = routeTask(db, { text: 'sample controller dispatch is wedged' });
    assert.equal(r[0].board.id, 'lab');
    assert.ok(
      r[0].reasons.some((x) => /text mentions repo: example-lab\/sample-controller/.test(x)),
      `expected a repo-mention reason, got: ${JSON.stringify(r[0].reasons)}`
    );
  });

  test('description overlap scores 5 per distinct token', () => {
    const r = routeTask(db, { text: 'telemetry alerts' });
    assert.equal(r[0].board.id, 'exoapp');
    assert.equal(r[0].score, 10);
  });

  test('tokens shorter than 4 chars are ignored as noise', () => {
    // "app" appears in exoapp's description but is only 3 chars.
    assert.deepEqual(routeTask(db, { text: 'app the a to' }), []);
  });

  // A raw substring test scored a board owning `.../api` on "therapist" and
  // "rapid", which is exactly the misrouting this feature exists to prevent.
  test('a short repo name does not match inside a longer word', () => {
    upsertBoard(db, {
      id: 'api',
      name: 'API',
      board_dir: path.join(tmp_root, 'api'),
      repos: ['example-lab/api']
    });
    assert.deepEqual(routeTask(db, { text: 'therapist notes' }), []);
    assert.deepEqual(routeTask(db, { text: 'rapid capital gains' }), []);
    // ...but the real word still matches.
    const hit = routeTask(db, { text: 'the api is down' });
    assert.equal(hit[0].board.id, 'api');
    assert.equal(hit[0].score, 25);
  });

  test('no signal yields no candidates rather than a random pick', () => {
    assert.deepEqual(routeTask(db, { text: 'zzzz qqqq wwww' }), []);
  });

  test('accepts several query repos and takes the best match, never a sum', () => {
    // Three of the board's own repos in one query is not three times the
    // evidence; summing would reintroduce repo-count scaling via the query side.
    const one = routeTask(db, { repos: ['example-lab/sample-controller'] });
    const three = routeTask(db, {
      repos: ['example-lab/sample-controller', 'example-lab/deployments', 'o/unknown']
    });
    assert.equal(one[0].score, 100);
    assert.equal(three[0].score, 100, 'three matching repos must score like one');
  });

  test('results are sorted by descending score', () => {
    const r = routeTask(db, { text: 'sample controller telemetry' });
    for (let i = 1; i < r.length; i++) {
      assert.ok(r[i - 1].score >= r[i].score);
    }
  });
});

// A board is NOT tied to a repo: zero, one or many are all legitimate, and repos
// are an optional hint rather than part of a board's identity. That makes these
// properties load-bearing rather than nice-to-have — without them an optional
// hint quietly becomes a requirement for being findable.
describe('boards are not coupled to repos', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    // No repos at all — description is its only signal.
    upsertBoard(db, {
      id: 'platform',
      name: 'Platform',
      board_dir: path.join(tmp_root, 'platform'),
      description: 'shared platform infrastructure deploy tooling terraform observability runbooks',
      repos: []
    });
    // Five repos, deliberately unrelated prose.
    upsertBoard(db, {
      id: 'many',
      name: 'Many',
      board_dir: path.join(tmp_root, 'many'),
      description: 'unrelated things',
      repos: ['o/alpha', 'o/bravo', 'o/charlie', 'o/delta', 'o/echo']
    });
  });

  test('a board with zero repos can be created and listed', () => {
    assert.deepEqual(getBoard(db, 'platform').repos, []);
    assert.equal(listBoards(db).length, 2);
  });

  test('a board with zero repos is routable on description alone', () => {
    const r = routeTask(db, { text: 'shared platform deploy tooling' });
    assert.equal(r[0].board.id, 'platform');
    assert.ok(r[0].score > 0);
  });

  // The regression that motivated this: crediting each matching repo separately
  // scored a 3-repo board 75 while a well-described repo-less board got 10.
  test('repo mentions in text are credited once per board, not per repo', () => {
    const r = routeTask(db, { text: 'alpha bravo charlie delta echo' });
    assert.equal(r[0].board.id, 'many');
    assert.equal(r[0].score, 25, 'five mentioned repos must score like one');
    assert.match(r[0].reasons[0], /text mentions repo: o\/alpha, o\/bravo/);
  });

  test('a well-described repo-less board outranks an incidental repo mention', () => {
    const r = routeTask(db, {
      text: 'shared platform infrastructure deploy tooling terraform observability alpha'
    });
    assert.equal(r[0].board.id, 'platform');
    assert.ok(
      r[0].score > r[1].score,
      `expected platform > many, got ${r[0].score} vs ${r[1].score}`
    );
  });

  test('description score is capped so a stuffed description cannot dominate', () => {
    const stuffed = 'shared platform infrastructure deploy tooling terraform observability runbooks';
    const r = routeTask(db, { text: stuffed });
    assert.equal(r[0].board.id, 'platform');
    assert.equal(r[0].score, 40, 'eight matching tokens must clamp to the 40 cap');
  });

  // An explicit repo is a checkable fact and still outranks inference.
  test('an explicit repo match still beats the description cap', () => {
    const r = routeTask(db, {
      text: 'shared platform infrastructure deploy tooling terraform observability runbooks',
      repo: 'o/alpha'
    });
    assert.equal(r[0].board.id, 'many');
    assert.equal(r[0].score, 100);
  });

  test('scores are bounded regardless of how many repos a board lists', () => {
    const r = routeTask(db, {
      text: 'alpha bravo charlie delta echo unrelated things',
      repo: 'o/alpha'
    });
    const MAX = 100 + 25 + 40;
    for (const c of r) assert.ok(c.score <= MAX, `${c.board.id} scored ${c.score} > ${MAX}`);
  });
});

/**
 * The CLI is what the MCP server actually spawns for a board write (see
 * `integrations/beads-mcp/src/beads_mcp/boards_write.py`), so the guard is only
 * real if it survives the argv round trip: the flag has to reach the registry, and
 * the refusal has to come back as an exit code and a line of stderr rather than as
 * a stack trace.
 */
describe('feads-board describe (CLI)', () => {
  const cli = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'feads-board.mjs'
  );

  /** @type {string} */
  let registry;
  /** @type {string} */
  let board_dir;

  /**
   * @param {string[]} args
   * @returns {{ status: number, stdout: string, stderr: string }}
   */
  function run(args) {
    const res = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, FEADS_REGISTRY_DB: registry, BEADS_ACTOR: 'cli-tester' }
    });
    return { status: Number(res.status), stdout: res.stdout || '', stderr: res.stderr || '' };
  }

  beforeEach(() => {
    db_seq += 1;
    registry = path.join(tmp_root, `cli${db_seq}.db`);
    board_dir = path.join(tmp_root, `cli-board${db_seq}`);
    fs.mkdirSync(board_dir, { recursive: true });
    const db = openRegistry({ path: registry });
    upsertBoard(db, { id: 'lab', name: 'Lab', board_dir, description: 'what agent A wrote' });
    db.close();
  });

  test('--json carries what it replaced', () => {
    const res = run(['describe', 'lab', '--description', 'what agent B wrote', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.updated, true);
    assert.equal(out.changed, true);
    assert.equal(out.previous.description, 'what agent A wrote');
    assert.equal(out.board.description, 'what agent B wrote');
  });

  test('--expect-description matching goes through', () => {
    const res = run([
      'describe',
      'lab',
      '--description',
      'merged',
      '--expect-description',
      'what agent A wrote',
      '--json'
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).board.description, 'merged');
  });

  test('--expect-description stale exits 3 and names the current value', () => {
    const res = run([
      'describe',
      'lab',
      '--description',
      'never applied',
      '--expect-description',
      'what agent B thought was there'
    ]);
    assert.equal(res.status, 3, 'a conflict must be branchable without parsing prose');
    assert.match(res.stderr, /changed since you read it/);
    assert.match(res.stderr, /what agent A wrote/);
    const db = openRegistry({ path: registry });
    assert.equal(getBoard(db, 'lab').description, 'what agent A wrote', 'refused, not applied');
    db.close();
  });

  test('history lists what was replaced, with the actor', () => {
    run(['describe', 'lab', '--description', 'second']);
    const res = run(['history', 'lab', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.history.length, 1);
    assert.equal(out.history[0].description, 'what agent A wrote');
    assert.equal(out.history[0].actor, 'cli-tester');
  });

  test('re-registering without --description keeps the description', () => {
    const res = run(['register', board_dir, '--name', 'Lab', '--id', 'lab', '--force', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).board.description, 'what agent A wrote');
  });

  test('help still ends at the env block', () => {
    // The help text is a slice of this file's own header, so adding usage lines
    // silently truncates it unless the slice moves too.
    const res = run(['help']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /--expect-description/);
    assert.match(res.stdout, /feads-board history/);
    assert.match(res.stdout, /BD_BIN/);
  });
});

/**
 * `beads.role`, and why board provisioning owns it (#feads-r8d).
 *
 * In a git work tree with no `beads.role`, bd prefixes every run with a three-line
 * advisory on stderr. A wrapper that read stderr's first line as the diagnosis then
 * reported "warning: beads.role not configured" as the reason a write failed, with
 * bd's real error on the line below — the 2026-07-29 incident on the feads board.
 *
 * `bd init` already sets the role for a board it creates, so the fresh case was never
 * the gap. The gap is the *adopted* one — `create` on a directory that already holds
 * a database never runs init — and that is the shape the incident board had. These
 * tests run the CLI for real but adopt a pre-existing board dir, so no `bd init`
 * (seconds of Dolt) is needed to pin the behaviour that matters.
 */
describe('feads-board create provisions beads.role (CLI)', () => {
  const cli = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'feads-board.mjs'
  );

  /** @type {string} */
  let registry;
  /** @type {string} */
  let project_dir;

  /** @param {string[]} args */
  function run(args) {
    const res = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, FEADS_REGISTRY_DB: registry, BEADS_ACTOR: 'cli-tester' }
    });
    return { status: Number(res.status), stdout: res.stdout || '', stderr: res.stderr || '' };
  }

  /** @param {string[]} args */
  const git = (args) =>
    spawnSync('git', args, { cwd: project_dir, encoding: 'utf8' });

  beforeEach(() => {
    db_seq += 1;
    registry = path.join(tmp_root, `role${db_seq}.db`);
    project_dir = path.join(tmp_root, `role-project${db_seq}`);
    // A directory that already reads as an initialized board, so `create` adopts it.
    fs.mkdirSync(path.join(project_dir, '.beads'), { recursive: true });
    fs.writeFileSync(path.join(project_dir, '.beads', 'config.yaml'), 'prefix: role\n');
    git(['init', '-q', '.']);
  });

  test('an adopted board in a git repo gets beads.role=maintainer', () => {
    assert.equal(git(['config', '--get', 'beads.role']).status, 1, 'unset to begin with');

    const res = run(['create', project_dir, '--name', 'Role', '--id', 'role', '--json']);
    assert.equal(res.status, 0, res.stderr);

    assert.equal(git(['config', '--get', 'beads.role']).stdout.trim(), 'maintainer');
  });

  test('a role an operator already chose is left alone', () => {
    git(['config', 'beads.role', 'contributor']);

    const res = run(['create', project_dir, '--name', 'Role', '--id', 'role', '--json']);
    assert.equal(res.status, 0, res.stderr);

    assert.equal(git(['config', '--get', 'beads.role']).stdout.trim(), 'contributor');
  });

  test('a board dir that is not a git work tree is not a failure', () => {
    // bd emits no advisory outside a work tree, so there is nothing to provision —
    // and `create` must not fail over a `git config` that cannot work.
    fs.rmSync(path.join(project_dir, '.git'), { recursive: true, force: true });

    const res = run(['create', project_dir, '--name', 'Role', '--id', 'role', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).board.id, 'role');
  });
});
