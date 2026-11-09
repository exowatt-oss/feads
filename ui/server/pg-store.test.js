import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  fetchListForSubscription,
  normalizeIssueList,
  trimListItems
} from './list-adapters.js';
import {
  boardIdForDir,
  createPgStore,
  parsePgEvent,
  pgDsn,
  pgErrorEnvelope,
  setPgStore
} from './pg-store.js';

/**
 * The database these tests run against.
 *
 * Deliberately a *different* variable from the one the server reads
 * (`FEADS_PG_DSN`): a developer with the server's DSN exported must not have
 * their test run silently start writing to whatever board they happen to be
 * looking at. Opting in is one explicit variable.
 */
const TEST_DSN = String(process.env.FEADS_PG_TEST_DSN || '').trim();

describe('boardIdForDir', () => {
  test('derives the board id from the parent of the .beads directory', () => {
    expect(boardIdForDir('/var/lib/feads/boards/example/.beads')).toBe(
      'example'
    );
    expect(boardIdForDir('/Users/x/example/feads/.beads')).toBe('feads');
  });

  test('tolerates trailing separators and relative paths', () => {
    expect(boardIdForDir('/var/lib/feads/boards/lab/.beads/')).toBe('lab');
  });

  test('answers empty for nothing to derive from', () => {
    expect(boardIdForDir('')).toBe('');
    expect(boardIdForDir(null)).toBe('');
    expect(boardIdForDir(undefined)).toBe('');
    expect(boardIdForDir('/')).toBe('');
  });
});

describe('parsePgEvent', () => {
  test('splits the notify payload', () => {
    expect(parsePgEvent('example:ex-6zr:status')).toEqual({
      board_id: 'example',
      issue_id: 'ex-6zr',
      kind: 'status'
    });
  });

  test('rejects payloads without both separators', () => {
    expect(parsePgEvent('')).toBe(null);
    expect(parsePgEvent('example')).toBe(null);
    expect(parsePgEvent(':x:y')).toBe(null);
  });
});

describe('pgErrorEnvelope', () => {
  test('keeps a store error code and details', () => {
    const err = Object.assign(new Error('nope'), {});
    expect(pgErrorEnvelope(err)).toEqual({
      code: 'pg_error',
      message: 'nope'
    });
  });

  test('falls back to a generic message', () => {
    expect(pgErrorEnvelope(null)).toEqual({
      code: 'pg_error',
      message: 'postgres query failed'
    });
  });
});

describe('pgDsn', () => {
  test('reads FEADS_PG_DSN and trims it', () => {
    expect(pgDsn({ FEADS_PG_DSN: '  postgres://x  ' })).toBe('postgres://x');
    expect(pgDsn({})).toBe('');
  });
});

// Everything below needs a real database with the production import in it.
// Run with:
//   FEADS_PG_TEST_DSN=postgres://postgres:feads@localhost:5434/feads npm test
describe.skipIf(!TEST_DSN)('pg-store against a real database', () => {
  /** @type {import('./pg-store.js').PgStore} */
  let store;
  /** @type {string[]} */
  const scratch_ids = [];

  beforeAll(() => {
    store = createPgStore({ dsn: TEST_DSN });
  });

  afterAll(async () => {
    // Tombstone whatever the write tests minted, so a re-run starts from the
    // same board state it found.
    for (const id of scratch_ids) {
      try {
        await store.deleteIssue('example', id, { actor: 'vitest' });
      } catch {
        // already gone
      }
    }
    await store.close();
  });

  test('resolves a board directory to a board id', async () => {
    await expect(
      store.resolveBoardId('/var/lib/feads/boards/example/.beads')
    ).resolves.toBe('example');
  });

  test('refuses a directory that maps to no board', async () => {
    await expect(
      store.resolveBoardId('/var/lib/feads/boards/nope-not-a-board/.beads')
    ).rejects.toMatchObject({ code: 'unknown_board' });
    await expect(store.resolveBoardId('')).rejects.toMatchObject({
      code: 'unknown_board'
    });
  });

  test('all-issues is everything open, closed and tombstones excluded', async () => {
    const rows = await store.fetchList('example', { type: 'all-issues' });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).not.toBe('closed');
      expect(row.deleted_at).toBeUndefined();
      expect(typeof row.id).toBe('string');
      expect(typeof row.title).toBe('string');
      expect(typeof row.created_at).toBe('string');
      expect(typeof row.updated_at).toBe('string');
      expect(Array.isArray(row.labels)).toBe(true);
      expect(Array.isArray(row.dependencies)).toBe(true);
      expect(typeof row.dependency_count).toBe('number');
      expect(typeof row.dependent_count).toBe('number');
      expect(typeof row.comment_count).toBe('number');
    }
  });

  test('dependency rows carry the slim shape the client renders', async () => {
    const rows = await store.fetchList('example', { type: 'all-issues' });
    const withDeps = rows.find(
      (r) => Array.isArray(r.dependencies) && r.dependencies.length > 0
    );
    expect(withDeps).toBeTruthy();
    const dep = /** @type {any} */ (withDeps).dependencies[0];
    expect(Object.keys(dep).sort()).toEqual([
      'dependency_type',
      'id',
      'issue_type',
      'status',
      'title'
    ]);
  });

  test('parent comes from the parent-child edge', async () => {
    const rows = await store.fetchList('example', { type: 'all-issues' });
    const child = rows.find((r) => typeof r.parent === 'string');
    expect(child).toBeTruthy();
    const deps = /** @type {any[]} */ (/** @type {any} */ (child).dependencies);
    expect(deps.some((d) => d.dependency_type === 'parent-child')).toBe(true);
  });

  test('ready-issues never carries a live blocker', async () => {
    const ready = await store.fetchList('example', { type: 'ready-issues' });
    const blocked = await store.fetchList('example', {
      type: 'blocked-issues'
    });
    const blocked_ids = new Set(blocked.map((r) => r.id));
    expect(ready.length).toBeGreaterThan(0);
    for (const row of ready) {
      expect(row.status).toBe('open');
      expect(blocked_ids.has(row.id)).toBe(false);
    }
  });

  test('blocked-issues carries blocked_by and blocked_by_count', async () => {
    const rows = await store.fetchList('example', { type: 'blocked-issues' });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['open', 'in_progress']).toContain(row.status);
      expect(typeof row.blocked_by_count).toBe('number');
      expect(Array.isArray(row.blocked_by)).toBe(true);
      expect(/** @type {any[]} */ (row.blocked_by).length).toBe(
        row.blocked_by_count
      );
      for (const blocker of /** @type {any[]} */ (row.blocked_by)) {
        expect(typeof blocker.id).toBe('string');
        expect(blocker.status).not.toBe('closed');
      }
    }
  });

  test('in-progress-issues is exactly the in_progress rows', async () => {
    const rows = await store.fetchList('example', {
      type: 'in-progress-issues'
    });
    for (const row of rows) {
      expect(row.status).toBe('in_progress');
    }
  });

  test('fetchListItems is fetchList with epoch timestamps, after normalization', async () => {
    // The hot path must be a pure representation change: once both pass the
    // pipeline the client sees, the rows are identical, field for field.
    const specs = [
      { type: 'all-issues' },
      { type: 'ready-issues' },
      { type: 'in-progress-issues' },
      { type: 'closed-issues' },
      { type: 'blocked-issues' },
      { type: 'epics' }
    ];
    for (const spec of specs) {
      const slow = normalizeIssueList(
        trimListItems(await store.fetchList('example', spec))
      );
      // No trim on the fast side: the hot path skips it, so the rows must
      // already be exactly what trimming the slow rows produces.
      const fast = normalizeIssueList(
        await store.fetchListItems('example', spec)
      );
      expect(fast).toEqual(slow);
      for (const row of await store.fetchListItems('example', spec)) {
        expect(typeof row.created_at).toBe('number');
      }
    }
  });

  test('closed-issues with params.since only returns closures in the window', async () => {
    const all = await store.fetchList('example', { type: 'closed-issues' });
    expect(all.length).toBeGreaterThan(1);
    const stamps = all
      .map((row) => Date.parse(String(row.closed_at || '')))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    const since = stamps[Math.floor(stamps.length / 2)];
    const windowed = await store.fetchList('example', {
      type: 'closed-issues',
      params: { since }
    });
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.length).toBeLessThan(all.length);
    for (const row of windowed) {
      expect(Date.parse(String(row.closed_at))).toBeGreaterThanOrEqual(since);
    }
    const expected = all.filter(
      (row) => Date.parse(String(row.closed_at || '')) >= since
    );
    // Same set; ties on (closed_at, updated_at) have no defined order.
    expect(windowed.map((r) => r.id).sort()).toEqual(
      expected.map((r) => r.id).sort()
    );
  });

  test('closed-issues is newest-first and capped at 1000', async () => {
    const rows = await store.fetchList('example', { type: 'closed-issues' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(1000);
    let previous = Infinity;
    for (const row of rows) {
      expect(row.status).toBe('closed');
      const closed = Date.parse(String(row.closed_at || 0));
      expect(closed).toBeLessThanOrEqual(previous);
      previous = closed;
    }
  });

  test('epics are open ones with counters, then closed ones without', async () => {
    const rows = await store.fetchList('example', { type: 'epics' });
    expect(rows.length).toBeGreaterThan(0);
    const open = rows.filter((r) => r.status !== 'closed');
    const closed = rows.filter((r) => r.status === 'closed');
    expect(open.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.issue_type).toBe('epic');
    }
    for (const row of open) {
      expect(typeof row.total_children).toBe('number');
      expect(typeof row.closed_children).toBe('number');
      expect(typeof row.eligible_for_close).toBe('boolean');
    }
    for (const row of closed) {
      // Closed epics are merged in without counters — the client derives what
      // it needs from the detail subscription when one is expanded — and are
      // never close-eligible. This is the shape the bd path produced.
      expect(row.total_children).toBeUndefined();
      expect(row.closed_children).toBeUndefined();
      expect(row.eligible_for_close).toBe(false);
    }
    // Open epics sort ahead of closed ones.
    const first_closed = rows.findIndex((r) => r.status === 'closed');
    if (first_closed !== -1) {
      expect(rows.slice(first_closed).every((r) => r.status === 'closed')).toBe(
        true
      );
    }
  });

  test('issue-detail carries prose, labels, dependencies and dependents', async () => {
    const epics = await store.fetchList('example', { type: 'epics' });
    const parent = /** @type {any} */ (
      epics.find((e) => Number(e.total_children) > 0)
    );
    expect(parent).toBeTruthy();
    const rows = await store.fetchList('example', {
      type: 'issue-detail',
      params: { id: parent.id }
    });
    expect(rows.length).toBe(1);
    const issue = /** @type {any} */ (rows[0]);
    expect(issue.id).toBe(parent.id);
    expect('description' in issue).toBe(true);
    expect(Array.isArray(issue.labels)).toBe(true);
    expect(Array.isArray(issue.dependencies)).toBe(true);
    expect(Array.isArray(issue.dependents)).toBe(true);
    expect(issue.dependents.length).toBeGreaterThan(0);
    for (const ref of issue.dependents) {
      expect(typeof ref.id).toBe('string');
      // Nested timestamps are epoch ms, the shape DependencyRef declares.
      if (ref.created_at !== undefined) {
        expect(typeof ref.created_at).toBe('number');
      }
    }
    expect(typeof issue.comment_count).toBe('number');
  });

  test('issue-detail answers empty for an id that is not there', async () => {
    const rows = await store.fetchList('example', {
      type: 'issue-detail',
      params: { id: 'ex-nope' }
    });
    expect(rows).toEqual([]);
  });

  test('issue-detail without an id is a bad request', async () => {
    await expect(
      store.fetchList('example', { type: 'issue-detail', params: {} })
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  test('an unknown subscription type is a bad request', async () => {
    await expect(
      store.fetchList('example', { type: 'nonsense' })
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  test('exportIssues has the fields both export consumers parse', async () => {
    const rows = await store.exportIssues('example');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.id).toBe('string');
      expect(typeof row.status).toBe('string');
      expect(typeof row.issue_type).toBe('string');
      expect(typeof row.updated_at).toBe('string');
      expect(typeof row.deleted).toBe('boolean');
      expect(Array.isArray(row.comments)).toBe(true);
      expect(Array.isArray(row.dependencies)).toBe(true);
    }
    const commented = /** @type {any} */ (
      rows.find((r) => r.comments.length > 0)
    );
    expect(commented).toBeTruthy();
    // The notification differ reads `text`, not the column's `body`.
    expect(typeof commented.comments[0].text).toBe('string');
    expect(typeof commented.comments[0].author).toBe('string');
    const linked = /** @type {any} */ (
      rows.find((r) => r.dependencies.length > 0)
    );
    expect(linked).toBeTruthy();
    expect(typeof linked.dependencies[0].depends_on_id).toBe('string');
    expect(typeof linked.dependencies[0].type).toBe('string');
  });

  test('created ids have the shape bd minted, and do not collide', async () => {
    /** @type {Set<string>} */
    const minted = new Set();
    for (let i = 0; i < 5; i++) {
      const { id } = await store.createIssue('example', {
        title: `pg-store test issue ${i}`,
        issue_type: 'task',
        priority: 3,
        actor: 'vitest'
      });
      scratch_ids.push(id);
      expect(id).toMatch(/^ex-[0-9a-z]{3}$/);
      expect(minted.has(id)).toBe(false);
      minted.add(id);
    }
  });

  test('a mutation writes an events row and fires a NOTIFY', async () => {
    // A second store, with its own LISTEN connection — the assertion is that a
    // *different* client sees the write, which is what makes an MCP write
    // refresh an open dashboard.
    const observer = createPgStore({ dsn: TEST_DSN, max: 2 });
    /** @type {import('./pg-store.js').PgEvent[]} */
    const seen = [];
    const heard = new Promise((resolve) => {
      observer.onEvent((event) => {
        seen.push(event);
        resolve(event);
      });
    });
    // Give the observer's LISTEN a moment to land before writing.
    await observer.query('SELECT 1');
    await new Promise((r) => setTimeout(r, 250));

    const { id } = await store.createIssue('example', {
      title: 'pg-store notify probe',
      actor: 'vitest'
    });
    scratch_ids.push(id);

    const before = await store.query(
      'SELECT count(*)::int AS n FROM events WHERE issue_id = $1',
      [id]
    );
    expect(before.rows[0].n).toBe(1);

    await store.updateStatus('example', id, 'in_progress', { actor: 'vitest' });

    const rows = await store.query(
      `SELECT kind, board_id, actor FROM events
        WHERE issue_id = $1 ORDER BY seq`,
      [id]
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(['created', 'status']);
    expect(rows.rows[0].board_id).toBe('example');
    expect(rows.rows[0].actor).toBe('vitest');

    await Promise.race([
      heard,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error('no NOTIFY within 3s')), 3000)
      )
    ]);
    expect(seen.some((e) => e.issue_id === id && e.kind === 'created')).toBe(
      true
    );
    await observer.close();
  }, 15000);

  test('status transitions maintain closed_at and started_at', async () => {
    const { id } = await store.createIssue('example', {
      title: 'pg-store lifecycle probe',
      actor: 'vitest'
    });
    scratch_ids.push(id);

    const started = /** @type {any} */ (
      await store.updateStatus('example', id, 'in_progress', {})
    );
    expect(typeof started.started_at).toBe('string');
    expect(started.closed_at).toBeUndefined();

    const closed = /** @type {any} */ (
      await store.updateStatus('example', id, 'closed', {})
    );
    expect(typeof closed.closed_at).toBe('string');
    // started_at records when work began, not when it last resumed.
    expect(closed.started_at).toBe(started.started_at);

    const reopened = /** @type {any} */ (
      await store.updateStatus('example', id, 'open', {})
    );
    expect(reopened.closed_at).toBeUndefined();
    expect(reopened.status).toBe('open');
  });

  test('text edits, priority, assignee, labels and deps round-trip', async () => {
    const { id } = await store.createIssue('example', {
      title: 'pg-store edit probe',
      actor: 'vitest'
    });
    scratch_ids.push(id);

    const edited = /** @type {any} */ (
      await store.editText('example', id, 'acceptance', 'must pass', {})
    );
    expect(edited.acceptance_criteria).toBe('must pass');

    const prioritized = /** @type {any} */ (
      await store.updatePriority('example', id, 0, {})
    );
    expect(prioritized.priority).toBe(0);

    const assigned = /** @type {any} */ (
      await store.updateAssignee('example', id, 'vitest', {})
    );
    expect(assigned.assignee).toBe('vitest');
    const cleared = /** @type {any} */ (
      await store.updateAssignee('example', id, '', {})
    );
    expect(cleared.assignee).toBeUndefined();

    const labelled = /** @type {any} */ (
      await store.labelAdd('example', id, 'probe', {})
    );
    expect(labelled.labels).toContain('probe');
    const unlabelled = /** @type {any} */ (
      await store.labelRemove('example', id, 'probe', {})
    );
    expect(unlabelled.labels).not.toContain('probe');

    const epics = await store.fetchList('example', { type: 'epics' });
    const target = String(epics[0].id);
    await store.depAdd('example', id, target, {});
    const linked = /** @type {any} */ (await store.showIssue('example', id));
    expect(linked.dependencies.map((/** @type {any} */ d) => d.id)).toContain(
      target
    );
    const from_other_side = /** @type {any} */ (
      await store.showIssue('example', target)
    );
    expect(
      from_other_side.dependents.map((/** @type {any} */ d) => d.id)
    ).toContain(id);

    await store.depRemove('example', id, target, {});
    const unlinked = /** @type {any} */ (await store.showIssue('example', id));
    expect(
      unlinked.dependencies.map((/** @type {any} */ d) => d.id)
    ).not.toContain(target);
  });

  test('cross-board changes keyset hydrates snapshots and comments', async () => {
    const before = await store.query(
      'SELECT COALESCE(max(seq), 0) AS seq FROM events'
    );
    const { id } = await store.createIssue('example', {
      title: 'vitest change feed scratch',
      description: 'feed test',
      actor: 'vitest'
    });
    scratch_ids.push(id);
    await store.addComment('example', id, 'feed comment', { actor: 'vitest' });

    const feed = await store.fetchChanges({
      after_cursor: String(before.rows[0].seq),
      boards: ['example'],
      limit: 500
    });
    const change = /** @type {any} */ (
      feed.changes.find((row) => row.id === id)
    );
    expect(change).toBeTruthy();
    expect(change.board_id).toBe('example');
    expect(change.description).toBe('feed test');
    expect(
      change.comments.some(
        (/** @type {any} */ comment) => comment.body === 'feed comment'
      )
    ).toBe(true);
    expect(change.events).toHaveLength(1);
    expect(feed.complete).toBe(true);
    expect(feed.next_cursor).toBeTruthy();
  });

  test('comments store as body and read back as text', async () => {
    const { id } = await store.createIssue('example', {
      title: 'pg-store comment probe',
      actor: 'vitest'
    });
    scratch_ids.push(id);

    const comments = await store.addComment('example', id, 'hello @nobody', {
      actor: 'vitest'
    });
    expect(comments.length).toBe(1);
    expect(comments[0].text).toBe('hello @nobody');
    expect(comments[0].author).toBe('vitest');
    expect(String(comments[0].id)).toMatch(/^[0-9a-f-]{36}$/);

    const detail = /** @type {any} */ (await store.showIssue('example', id));
    expect(detail.comment_count).toBe(1);
  });

  test('delete tombstones the row and hides it from every list', async () => {
    const { id } = await store.createIssue('example', {
      title: 'pg-store delete probe',
      actor: 'vitest'
    });
    await store.deleteIssue('example', id, { actor: 'vitest' });
    const rows = await store.fetchList('example', { type: 'all-issues' });
    expect(rows.some((r) => r.id === id)).toBe(false);
    const still_there = await store.query(
      'SELECT deleted_at FROM issues WHERE id = $1',
      [id]
    );
    expect(still_there.rowCount).toBe(1);
    expect(still_there.rows[0].deleted_at).not.toBe(null);
  });

  test('purges owned data and authored rows transactionally', async () => {
    const actor = `purge-vitest-${Date.now()}`;
    const owned = `ex-purge-owned-${Date.now()}`;
    const survivor = `ex-purge-survivor-${Date.now()}`;
    const created_at = new Date().toISOString();
    try {
      await store.query(
        `INSERT INTO issues
         (id, board_id, title, created_by, assignee, owner, created_at, updated_at)
         VALUES ($1, 'example', 'owned', $3, NULL, NULL, $2, $2),
                ($4, 'example', 'survivor', 'someone-else', $3, $3, $2, $2)`,
        [owned, created_at, actor, survivor]
      );
      await store.query(
        `INSERT INTO deps (issue_id, depends_on_id, created_by)
         VALUES ($1, $2, $3), ($2, $1, 'someone-else'),
                ($2, 'ex-purge-dangling', $3)`,
        [owned, survivor, actor]
      );
      await store.query(
        `INSERT INTO labels (issue_id, label) VALUES ($1, 'private')`,
        [owned]
      );
      await store.query(
        `INSERT INTO comments (id, issue_id, author, body, created_at)
         VALUES ($1, $2, 'someone-else', 'private', $3),
                ($4, $5, $6, 'authored elsewhere', $3)`,
        [
          `comment-owned-${Date.now()}`,
          owned,
          created_at,
          `comment-survivor-${Date.now()}`,
          survivor,
          actor
        ]
      );
      await store.query(
        `INSERT INTO events (board_id, issue_id, actor, kind)
         VALUES ('example', $1, 'someone-else', 'updated'),
                ('example', $2, $3, 'updated')`,
        [owned, survivor, actor]
      );

      const result = await store.purgeActor(actor.toUpperCase());
      expect(result.issues).toBe(1);
      expect(result.deps).toBe(3);
      expect(result.labels).toBe(1);
      expect(result.comments).toBe(2);
      expect(result.events).toBe(2);
      expect(result.assignee_cleared).toBe(1);
      expect(result.owner_cleared).toBe(1);
      expect(result.updated_issues).toBe(1);
      expect(result.boards).toBe(1);
      expect(result.notifications).toBe(1);

      const remaining = await store.query(
        `SELECT id, deleted_at, title, description, created_by,
                assignee, owner
           FROM issues WHERE id IN ($1, $2) ORDER BY id`,
        [owned, survivor]
      );
      expect(remaining.rows[0].deleted_at === null).toBe(false);
      expect(remaining.rows[0].title).toBe('[removed user]');
      expect(remaining.rows[0].description).toBe(null);
      expect(remaining.rows[0].created_by).toBe(null);
      expect(remaining.rows[1].assignee).toBe(null);
      expect(remaining.rows[1].owner).toBe(null);
      await expect(
        store.query(
          `SELECT count(*)::int AS count FROM deps
            WHERE issue_id IN ($1, $2) OR depends_on_id IN ($1, $2)`,
          [owned, survivor]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await store.query(`DELETE FROM issues WHERE id IN ($1, $2)`, [
        owned,
        survivor
      ]);
    }
  });

  test('purges descendant actors across owned and authored data', async () => {
    const root = `purge-root-${Date.now()}`;
    const descendant = `purge-descendant-${Date.now()}`;
    const root_owned = `ex-purge-root-${Date.now()}`;
    const descendant_owned = `ex-purge-descendant-${Date.now()}`;
    const survivor = `ex-purge-survivor-${Date.now()}`;
    const created_at = new Date().toISOString();
    const issue_ids = [root_owned, descendant_owned, survivor];
    try {
      await store.query(
        `INSERT INTO issues
         (id, board_id, title, created_by, assignee, owner, created_at, updated_at)
         VALUES ($1, 'example', 'root-owned', $4, NULL, NULL, $3, $3),
                ($2, 'example', 'descendant-owned', $5, NULL, NULL, $3, $3),
                ($6, 'example', 'survivor', 'someone-else', $4, $5, $3, $3)`,
        [root_owned, descendant_owned, created_at, root, descendant, survivor]
      );
      await store.query(
        `INSERT INTO deps (issue_id, depends_on_id, created_by)
         VALUES ($1, $3, $4), ($2, $3, $5), ($3, 'ex-purge-dangling', $5)`,
        [root_owned, descendant_owned, survivor, root.toUpperCase(), descendant]
      );
      await store.query(
        `INSERT INTO labels (issue_id, label)
         VALUES ($1, 'root-private'), ($2, 'descendant-private')`,
        [root_owned, descendant_owned]
      );
      await store.query(
        `INSERT INTO comments (id, issue_id, author, body, created_at)
         VALUES ($1, $2, 'someone-else', 'root-owned', $6),
                ($3, $4, 'someone-else', 'descendant-owned', $6),
                ($5, $4, $7, 'root-authored', $6),
                ($8, $4, $9, 'descendant-authored', $6)`,
        [
          `comment-root-owned-${Date.now()}`,
          root_owned,
          `comment-descendant-owned-${Date.now()}`,
          descendant_owned,
          `comment-root-authored-${Date.now()}`,
          created_at,
          root.toUpperCase(),
          `comment-descendant-authored-${Date.now()}`,
          descendant
        ]
      );
      await store.query(
        `INSERT INTO events (board_id, issue_id, actor, kind)
         VALUES ('example', $1, 'someone-else', 'updated'),
                ('example', $2, 'someone-else', 'updated'),
                ('example', $3, $4, 'updated'),
                ('example', $3, $5, 'updated'),
                ('example', NULL, $5, 'updated')`,
        [
          root_owned,
          descendant_owned,
          survivor,
          root.toUpperCase(),
          descendant.toUpperCase()
        ]
      );

      const result = await store.purgeActor(root.toUpperCase(), [
        root,
        descendant,
        descendant.toUpperCase()
      ]);
      expect(result.actor).toBe(root.toUpperCase());
      expect(result.removed_actors).toEqual([root.toUpperCase(), descendant]);
      expect(result.issues).toBe(2);
      expect(result.owned_issues).toBe(2);
      expect(result.deps).toBe(3);
      expect(result.labels).toBe(2);
      expect(result.comments).toBe(4);
      expect(result.events).toBe(5);
      expect(result.assignee_cleared).toBe(1);
      expect(result.owner_cleared).toBe(1);
      expect(result.updated_issues).toBe(1);
      expect(result.boards).toBe(1);
      expect(result.notifications).toBe(1);

      const remaining = await store.query(
        `SELECT id, deleted_at, title, description, created_by,
                assignee, owner
           FROM issues WHERE id = ANY($1::text[]) ORDER BY id`,
        [issue_ids]
      );
      expect(remaining.rows).toHaveLength(3);
      const tombstones = remaining.rows.filter((row) => row.id !== survivor);
      expect(tombstones).toHaveLength(2);
      expect(tombstones.every((row) => row.deleted_at !== null)).toBe(true);
      expect(tombstones.every((row) => row.title === '[removed user]')).toBe(
        true
      );
      expect(tombstones.every((row) => row.description === null)).toBe(true);
      expect(tombstones.every((row) => row.created_by === null)).toBe(true);
      const surviving_row = remaining.rows.find((row) => row.id === survivor);
      expect(surviving_row.assignee).toBe(null);
      expect(surviving_row.owner).toBe(null);

      await expect(
        store.query(
          `SELECT count(*)::int AS count FROM deps
            WHERE lower(COALESCE(created_by, '')) = ANY($1::text[])
               OR issue_id = ANY($2::text[])`,
          [
            [root.toLowerCase(), descendant],
            [root_owned, descendant_owned]
          ]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        store.query(
          `SELECT count(*)::int AS count FROM comments
            WHERE lower(COALESCE(author, '')) = ANY($1::text[])
               OR issue_id = ANY($2::text[])`,
          [
            [root.toLowerCase(), descendant],
            [root_owned, descendant_owned]
          ]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        store.query(
          `SELECT count(*)::int AS count FROM events
            WHERE lower(COALESCE(actor, '')) = ANY($1::text[])
               OR issue_id = ANY($2::text[])`,
          [
            [root.toLowerCase(), descendant],
            [root_owned, descendant_owned]
          ]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await store.query(
        `DELETE FROM events
          WHERE issue_id = ANY($1::text[])
             OR lower(COALESCE(actor, '')) = ANY($2::text[])`,
        [issue_ids, [root.toLowerCase(), descendant]]
      );
      await store.query('DELETE FROM issues WHERE id = ANY($1::text[])', [
        issue_ids
      ]);
    }
  });

  test('purges authored data when an actor owns no issues', async () => {
    const actor = `purge-empty-${Date.now()}`;
    const survivor = `ex-purge-empty-survivor-${Date.now()}`;
    const comment_id = `comment-purge-empty-${Date.now()}`;
    const created_at = new Date().toISOString();
    try {
      await store.query(
        `INSERT INTO issues
         (id, board_id, title, created_by, assignee, owner, created_at, updated_at)
         VALUES ($1, 'example', 'survivor', 'someone-else', $2, $2, $3, $3)`,
        [survivor, actor, created_at]
      );
      await store.query(
        `INSERT INTO comments (id, issue_id, author, body, created_at)
         VALUES ($1, $2, $3, 'authored elsewhere', $4)`,
        [comment_id, survivor, actor.toUpperCase(), created_at]
      );
      await store.query(
        `INSERT INTO events (board_id, issue_id, actor, kind)
         VALUES ('example', $1, $2, 'updated')`,
        [survivor, actor.toUpperCase()]
      );

      const result = await store.purgeActor(actor);
      expect(result.removed_actors).toEqual([actor]);
      expect(result.issues).toBe(0);
      expect(result.owned_issues).toBe(0);
      expect(result.deps).toBe(0);
      expect(result.labels).toBe(0);
      expect(result.comments).toBe(1);
      expect(result.events).toBe(1);
      expect(result.assignee_cleared).toBe(1);
      expect(result.owner_cleared).toBe(1);
      expect(result.updated_issues).toBe(1);
      expect(result.boards).toBe(1);
      expect(result.notifications).toBe(1);
      await expect(
        store.query('SELECT id FROM comments WHERE id = $1', [comment_id])
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await store.query(
        `DELETE FROM events
          WHERE issue_id = $1 OR lower(COALESCE(actor, '')) = lower($2)`,
        [survivor, actor]
      );
      await store.query('DELETE FROM issues WHERE id = $1', [survivor]);
    }
  });

  test('a write against an unknown issue is not_found', async () => {
    await expect(
      store.updatePriority('example', 'ex-nope', 1, {})
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('creator lookup answers the delete-ownership question', async () => {
    const { id } = await store.createIssue('example', {
      title: 'pg-store creator probe',
      actor: 'somebody'
    });
    scratch_ids.push(id);
    await expect(store.issueCreator('example', id)).resolves.toBe('somebody');
    await expect(store.issueCreator('example', 'ex-nope')).resolves.toBe('');
  });
});

describe.skipIf(!TEST_DSN)('fetchListForSubscription in pg mode', () => {
  /** @type {import('./pg-store.js').PgStore} */
  let store;

  beforeAll(() => {
    store = createPgStore({ dsn: TEST_DSN, listen: false });
    setPgStore(store);
  });

  afterAll(async () => {
    setPgStore(null);
    await store.close();
  });

  test('normalizes timestamps to epoch ms and trims prose from lists', async () => {
    const res = await fetchListForSubscription(
      { type: 'all-issues' },
      { board_dir: '/var/lib/feads/boards/example/.beads' }
    );
    expect(res.ok).toBe(true);
    const items = /** @type {any} */ (res).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(typeof item.created_at).toBe('number');
      expect(typeof item.updated_at).toBe('number');
      expect(item.closed_at).toBe(null);
      expect(item.description).toBeUndefined();
      expect(item.notes).toBeUndefined();
    }
  });

  test('keeps prose on the detail subscription', async () => {
    const list = await fetchListForSubscription(
      { type: 'all-issues' },
      { board_dir: '/var/lib/feads/boards/example/.beads' }
    );
    const id = /** @type {any} */ (list).items[0].id;
    const res = await fetchListForSubscription(
      { type: 'issue-detail', params: { id } },
      { board_dir: '/var/lib/feads/boards/example/.beads' }
    );
    expect(res.ok).toBe(true);
    const items = /** @type {any} */ (res).items;
    expect(items.length).toBe(1);
    expect('dependents' in items[0]).toBe(true);
  });

  test('surfaces an unmapped board as a structured error', async () => {
    const res = await fetchListForSubscription(
      { type: 'all-issues' },
      { board_dir: '/var/lib/feads/boards/no-such-board/.beads' }
    );
    expect(res.ok).toBe(false);
    expect(/** @type {any} */ (res).error.code).toBe('unknown_board');
  });
});
