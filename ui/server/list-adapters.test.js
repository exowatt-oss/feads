import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runBdJson } from './bd.js';
import {
  fetchListForSubscription,
  mapSubscriptionToBdArgs,
  scrubAdvisoryStderr
} from './list-adapters.js';

vi.mock('./bd.js', () => ({ runBdJson: vi.fn() }));

describe('list adapters for subscription types', () => {
  beforeEach(() => {
    /** @type {import('vitest').Mock} */ (runBdJson).mockReset();
  });

  test('mapSubscriptionToBdArgs returns args for all-issues', () => {
    const args = mapSubscriptionToBdArgs({ type: 'all-issues' });
    // `--limit 0` = unlimited; without it bd list truncates at its default 50
    expect(args).toEqual(['list', '--json', '--tree=false', '--limit', '0']);
  });

  test('mapSubscriptionToBdArgs returns args for epics', () => {
    const args = mapSubscriptionToBdArgs({ type: 'epics' });
    expect(args).toEqual(['epic', 'status', '--json']);
  });

  test('mapSubscriptionToBdArgs returns args for blocked-issues', () => {
    const args = mapSubscriptionToBdArgs({ type: 'blocked-issues' });
    // We choose dedicated subcommand mapping for blocked
    expect(args).toEqual(['blocked', '--json']);
  });

  test('mapSubscriptionToBdArgs returns args for ready-issues', () => {
    const args = mapSubscriptionToBdArgs({ type: 'ready-issues' });
    // `bd list --ready` (same semantics as `bd ready`) because it emits the
    // full list shape — assignee, parent, metadata — which board cards render
    expect(args).toEqual([
      'list',
      '--json',
      '--tree=false',
      '--ready',
      '--limit',
      '1000'
    ]);
  });

  test('mapSubscriptionToBdArgs returns args for in-progress-issues', () => {
    const args = mapSubscriptionToBdArgs({ type: 'in-progress-issues' });
    // `--limit 0` = unlimited; without it bd list truncates at its default 50
    expect(args).toEqual([
      'list',
      '--json',
      '--tree=false',
      '--status',
      'in_progress',
      '--limit',
      '0'
    ]);
  });

  test('mapSubscriptionToBdArgs returns args for closed-issues', () => {
    const args = mapSubscriptionToBdArgs({ type: 'closed-issues' });
    expect(args).toEqual([
      'list',
      '--json',
      '--tree=false',
      '--status',
      'closed',
      '--limit',
      '1000'
    ]);
  });

  test('mapSubscriptionToBdArgs returns args for issue-detail', () => {
    const args = mapSubscriptionToBdArgs({
      type: 'issue-detail',
      params: { id: 'UI-123' }
    });
    expect(args).toEqual(['show', 'UI-123', '--json', '--include-dependents']);
  });

  test('fetchListForSubscription returns normalized items (Date.parse)', async () => {
    /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
      code: 0,
      stdoutJson: [
        {
          id: 'A-1',
          updated_at: '2024-01-01T00:00:00.000Z',
          closed_at: null,
          extra: 'x'
        },
        {
          id: 'A-2',
          updated_at: '2024-01-01T00:00:01.000Z',
          closed_at: '2024-01-01T00:00:05.000Z'
        },
        { id: 3, updated_at: 'not-a-date' }
      ]
    });
    const res = await fetchListForSubscription({ type: 'all-issues' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.length).toBe(3);
      expect(res.items[0]).toMatchObject({
        id: 'A-1',
        updated_at: Date.parse('2024-01-01T00:00:00.000Z'),
        closed_at: null
      });
      expect(res.items[1]).toMatchObject({
        id: 'A-2',
        updated_at: Date.parse('2024-01-01T00:00:01.000Z'),
        closed_at: Date.parse('2024-01-01T00:00:05.000Z')
      });
      // id coerced to string, closed_at defaults to null
      expect(res.items[2]).toMatchObject({
        id: '3',
        updated_at: 0,
        closed_at: null
      });
    }
  });

  test('filters tombstoned epics', async () => {
    /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
      code: 0,
      stdoutJson: [
        {
          epic: {
            id: 'E-1',
            status: 'open',
            issue_type: 'epic',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
            closed_at: null
          },
          total_children: 1,
          closed_children: 0,
          eligible_for_close: false
        },
        {
          epic: {
            id: 'E-2',
            status: 'tombstone',
            issue_type: 'epic',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
            closed_at: null,
            deleted_at: '2024-02-01T00:00:00.000Z'
          },
          total_children: 0,
          closed_children: 0,
          eligible_for_close: false
        }
      ]
    });

    const res = await fetchListForSubscription({ type: 'epics' });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({
        id: 'E-1',
        status: 'open'
      });
    }
  });

  test('merges closed epics from bd list into the epics tab (never close-eligible)', async () => {
    const mock = /** @type {import('vitest').Mock} */ (runBdJson);
    mock
      .mockResolvedValueOnce({
        code: 0,
        stdoutJson: [
          {
            epic: {
              id: 'E-1',
              title: 'Open epic',
              status: 'open',
              issue_type: 'epic'
            },
            total_children: 2,
            closed_children: 1,
            eligible_for_close: false
          }
        ]
      })
      .mockResolvedValueOnce({
        code: 0,
        stdoutJson: [
          {
            id: 'E-9',
            title: 'Done epic',
            status: 'closed',
            issue_type: 'epic',
            closed_at: '2026-07-29T00:00:00.000Z',
            assignee: 'sam'
          },
          // Guard: an id already present from epic status must not duplicate.
          { id: 'E-1', status: 'closed' }
        ]
      });

    const res = await fetchListForSubscription({ type: 'epics' });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(['E-1', 'E-9']);
      expect(res.items[1]).toMatchObject({
        id: 'E-9',
        status: 'closed',
        issue_type: 'epic',
        eligible_for_close: false,
        // The adapter pipeline normalizes timestamps to epoch ms.
        closed_at: Date.parse('2026-07-29T00:00:00.000Z'),
        assignee: 'sam'
      });
    }
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0]).toEqual([
      'list',
      '--json',
      '--tree=false',
      '--type',
      'epic',
      '--status',
      'closed',
      '--limit',
      '0'
    ]);
  });

  test('strips heavy prose fields from list items but keeps card data', async () => {
    /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
      code: 0,
      stdoutJson: [
        {
          id: 'A-1',
          title: 't',
          description: 'a very long description',
          design: 'design prose',
          notes: 'notes prose',
          acceptance_criteria: 'ac prose',
          assignee: 'sam',
          parent: 'E-1',
          metadata: { 'artifact:o/r:f.js': { repo: 'o/r', path: 'f.js' } },
          dependencies: [
            {
              id: 'E-1',
              title: 'Epic one',
              description: 'epic prose',
              dependency_type: 'parent-child'
            }
          ],
          blocked_by: ['B-9'],
          updated_at: '2024-01-01T00:00:00.000Z'
        }
      ]
    });
    const res = await fetchListForSubscription({ type: 'all-issues' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const it = res.items[0];
      expect(it.description).toBeUndefined();
      expect(it.design).toBeUndefined();
      expect(it.notes).toBeUndefined();
      expect(it.acceptance_criteria).toBeUndefined();
      // Card data survives
      expect(it.assignee).toBe('sam');
      expect(it.parent).toBe('E-1');
      expect(it.metadata).toBeTruthy();
      // Embedded refs keep identity + title, lose their prose
      expect(it.dependencies).toEqual([
        { id: 'E-1', title: 'Epic one', dependency_type: 'parent-child' }
      ]);
      // Bare-string blockers (bd blocked's shape) pass through untouched
      expect(it.blocked_by).toEqual(['B-9']);
    }
  });

  test('issue-detail is not trimmed', async () => {
    /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
      code: 0,
      stdoutJson: [
        {
          id: 'A-1',
          description: 'kept',
          updated_at: '2024-01-01T00:00:00.000Z'
        }
      ]
    });
    const res = await fetchListForSubscription({
      type: 'issue-detail',
      params: { id: 'A-1' }
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items[0].description).toBe('kept');
    }
  });

  test('blocked-issues are enriched with full list fields, keeping blockers', async () => {
    const mock = /** @type {import('vitest').Mock} */ (runBdJson);
    mock.mockResolvedValueOnce({
      code: 0,
      stdoutJson: [
        {
          id: 'B-1',
          title: 'blocked',
          updated_at: '2024-01-01T00:00:00.000Z',
          blocked_by_count: 1,
          blocked_by: [{ id: 'X-1', title: 'the blocker' }]
        }
      ]
    });
    mock.mockResolvedValueOnce({
      code: 0,
      stdoutJson: [
        {
          id: 'B-1',
          title: 'blocked',
          assignee: 'sam',
          parent: 'E-1',
          metadata: { 'artifact:o/r:f.js': { repo: 'o/r', path: 'f.js' } },
          updated_at: '2024-01-01T00:00:00.000Z'
        }
      ]
    });
    const res = await fetchListForSubscription({ type: 'blocked-issues' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({
        id: 'B-1',
        assignee: 'sam',
        parent: 'E-1',
        blocked_by_count: 1
      });
      expect(res.items[0].blocked_by).toEqual([
        { id: 'X-1', title: 'the blocker' }
      ]);
    }
    // Second call re-reads the blocked ids through bd list
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0]).toEqual([
      'list',
      '--json',
      '--tree=false',
      '--id',
      'B-1',
      '--limit',
      '0'
    ]);
  });

  test('blocked-issues fall back to slim rows when enrichment fails', async () => {
    const mock = /** @type {import('vitest').Mock} */ (runBdJson);
    mock.mockResolvedValueOnce({
      code: 0,
      stdoutJson: [
        {
          id: 'B-1',
          title: 'blocked',
          updated_at: '2024-01-01T00:00:00.000Z',
          blocked_by: [{ id: 'X-1' }]
        }
      ]
    });
    mock.mockResolvedValueOnce({ code: 2, stderr: 'boom' });
    const res = await fetchListForSubscription({ type: 'blocked-issues' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({ id: 'B-1', title: 'blocked' });
    }
  });

  test(
    'fetchListForSubscription surfaces bd error',
    { timeout: 10000 },
    async () => {
      /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
        code: 2,
        stderr: 'boom'
      });
      const res = await fetchListForSubscription({ type: 'all-issues' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('bd_error');
        expect(res.error.message).toContain('boom');
        expect(res.error.details && res.error.details.exit_code).toBe(2);
      }
    }
  );

  test(
    'a transient bd failure heals through the retry, invisibly',
    { timeout: 10000 },
    async () => {
      // The board is written by other processes concurrent with our reads —
      // an embedded-Dolt read racing a writer can miss an issue that is
      // plainly there one second later (feads-dm1). Two failures, then truth.
      const mock = /** @type {import('vitest').Mock} */ (runBdJson);
      mock.mockResolvedValueOnce({
        code: 1,
        stderr: 'Error fetching ex-1: no issue found matching "ex-1"'
      });
      mock.mockResolvedValueOnce({
        code: 1,
        stderr: 'Error fetching ex-1: no issue found matching "ex-1"'
      });
      mock.mockResolvedValueOnce({
        code: 0,
        stdoutJson: [{ id: 'ex-1', updated_at: '2024-01-01T00:00:00.000Z' }]
      });
      const res = await fetchListForSubscription({
        type: 'issue-detail',
        params: { id: 'ex-1' }
      });
      expect(res.ok).toBe(true);
      expect(mock).toHaveBeenCalledTimes(3);
    }
  );

  test(
    'advisory stderr is scrubbed from the surfaced message',
    { timeout: 10000 },
    async () => {
      /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
        code: 1,
        stderr:
          'warning: beads.role not configured (GH#2950).\n' +
          '  Fix: git config beads.role maintainer\n' +
          '  Or: git config beads.role contributor\n' +
          'Error fetching ex-9tu: no issue found matching "ex-9tu"\n'
      });
      const res = await fetchListForSubscription({
        type: 'issue-detail',
        params: { id: 'ex-9tu' }
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toBe(
          'Error fetching ex-9tu: no issue found matching "ex-9tu"'
        );
      }
    }
  );

  test('scrubAdvisoryStderr falls back cleanly when all lines are advisory', () => {
    expect(
      scrubAdvisoryStderr(
        'warning: beads.role not configured (GH#2950).\n  Fix: git config beads.role maintainer\n'
      )
    ).toBe('');
    expect(
      scrubAdvisoryStderr(
        'note: contributor routing is active.\n  Fix: bd config unset routing.maintainer\nreal error'
      )
    ).toBe('real error');
    expect(scrubAdvisoryStderr(undefined)).toBe('');
  });

  test('fetchListForSubscription returns error for unknown type', async () => {
    const res = await fetchListForSubscription(
      /** @type {any} */ ({ type: 'unknown' })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('bad_request');
      expect(res.error.message).toMatch(/Unknown subscription type/);
    }
  });
});
