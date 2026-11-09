/**
 * feads addition — the All-boards pseudo-board's aggregate fetch: fan-out,
 * tagging, failure tolerance, ordering, and issue→board routing.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ALL_BOARD_ID,
  allBoardsPickerEntry,
  allBoardsWorkspaceState,
  fetchListForAllBoards,
  isAllBoardsWorkspace,
  listAggregateBoards,
  resetAggregateBoardsCache,
  resolveIssueBoard
} from './all-board.js';
import { listRegistryBoards } from './board-registry.js';
import { fetchListForSubscription } from './list-adapters.js';

vi.mock('./board-registry.js', () => ({
  listRegistryBoards: vi.fn()
}));
vi.mock('./list-adapters.js', () => ({
  fetchListForSubscription: vi.fn()
}));
vi.mock('./pg-store.js', () => ({
  getPgStore: () => null
}));

const boards_mock = /** @type {import('vitest').Mock} */ (listRegistryBoards);
const fetch_mock = /** @type {import('vitest').Mock} */ (
  fetchListForSubscription
);

/**
 * @param {string} id
 * @returns {any}
 */
function registryBoard(id) {
  return {
    id,
    name: `${id} board`,
    board_dir: `/data/boards/${id}/.beads`,
    workspace_dir: `/data/boards/${id}`,
    description: '',
    repos: [],
    exists: true
  };
}

beforeEach(() => {
  resetAggregateBoardsCache();
  boards_mock.mockReset();
  fetch_mock.mockReset();
  boards_mock.mockResolvedValue([
    registryBoard('alpha'),
    registryBoard('bravo')
  ]);
});

describe("the pseudo-board's identity", () => {
  test('workspace state is recognizable and holds no paths', () => {
    const state = allBoardsWorkspaceState();
    expect(state.board_id).toBe(ALL_BOARD_ID);
    expect(state.board_dir).toBe('');
    expect(state.root_dir).toBe('');
    expect(isAllBoardsWorkspace(state)).toBe(true);
    expect(isAllBoardsWorkspace(null)).toBe(false);
    expect(isAllBoardsWorkspace({ board_id: 'alpha' })).toBe(false);
  });

  test('the picker entry is shaped like a registry board row', () => {
    const entry = allBoardsPickerEntry();
    expect(entry.id).toBe(ALL_BOARD_ID);
    expect(entry.key).toBe(ALL_BOARD_ID);
    expect(entry.exists).toBe(true);
    expect(String(entry.name).length).toBeGreaterThan(0);
    expect(String(entry.description).length).toBeGreaterThan(0);
  });

  test('boards missing from disk are not aggregated', async () => {
    boards_mock.mockResolvedValue([
      registryBoard('alpha'),
      { ...registryBoard('ghost'), exists: false }
    ]);
    const boards = await listAggregateBoards();
    expect(boards.map((b) => b.id)).toEqual(['alpha']);
  });
});

describe('fetchListForAllBoards', () => {
  test("merges every board's rows and tags each with its home board", async () => {
    fetch_mock.mockImplementation(async (_spec, options) => {
      if (String(options.board_dir).includes('/alpha/')) {
        return {
          ok: true,
          items: [
            { id: 'alpha-1', created_at: 2, updated_at: 2, closed_at: null }
          ]
        };
      }
      return {
        ok: true,
        items: [
          { id: 'bravo-1', created_at: 1, updated_at: 1, closed_at: null }
        ]
      };
    });
    const res = await fetchListForAllBoards({ type: 'all-issues' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.map((it) => it.id)).toEqual(['bravo-1', 'alpha-1']);
    const alpha_row = res.items.find((it) => it.id === 'alpha-1');
    expect(alpha_row?.board_id).toBe('alpha');
    expect(alpha_row?.board_name).toBe('alpha board');
  });

  test('a board that cannot be read is skipped, not fatal', async () => {
    fetch_mock.mockImplementation(async (_spec, options) => {
      if (String(options.board_dir).includes('/alpha/')) {
        return { ok: false, error: { code: 'bd_error', message: 'wedged' } };
      }
      return {
        ok: true,
        items: [
          { id: 'bravo-1', created_at: 1, updated_at: 1, closed_at: null }
        ]
      };
    });
    const res = await fetchListForAllBoards({ type: 'all-issues' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.map((it) => it.id)).toEqual(['bravo-1']);
  });

  test('every board failing is an error, named after the first failure', async () => {
    fetch_mock.mockResolvedValue({
      ok: false,
      error: { code: 'bd_error', message: 'down' }
    });
    const res = await fetchListForAllBoards({ type: 'all-issues' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain('down');
  });

  test('no registered boards is an error, not an empty success', async () => {
    boards_mock.mockResolvedValue([]);
    const res = await fetchListForAllBoards({ type: 'all-issues' });
    expect(res.ok).toBe(false);
  });

  test("closed issues merge newest-first and cap at one board's limit", async () => {
    fetch_mock.mockImplementation(async (_spec, options) => {
      const on_alpha = String(options.board_dir).includes('/alpha/');
      const base = on_alpha ? 10_000 : 5_000;
      const prefix = on_alpha ? 'alpha' : 'bravo';
      return {
        ok: true,
        items: Array.from({ length: 600 }, (_, i) => ({
          id: `${prefix}-${i}`,
          created_at: 1,
          updated_at: 1,
          closed_at: base + i
        }))
      };
    });
    const res = await fetchListForAllBoards({ type: 'closed-issues' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.length).toBe(1000);
    // Newest closed first: all of alpha's (10_000+) before bravo's (5_000+).
    expect(res.items[0].closed_at).toBe(10_599);
    expect(res.items[res.items.length - 1].closed_at).toBeGreaterThanOrEqual(
      5_200
    );
  });

  test('ready issues keep priority-then-age order across boards', async () => {
    fetch_mock.mockImplementation(async (_spec, options) => {
      if (String(options.board_dir).includes('/alpha/')) {
        return {
          ok: true,
          items: [
            {
              id: 'alpha-lo',
              priority: 3,
              created_at: 1,
              updated_at: 1,
              closed_at: null
            }
          ]
        };
      }
      return {
        ok: true,
        items: [
          {
            id: 'bravo-hi',
            priority: 0,
            created_at: 9,
            updated_at: 9,
            closed_at: null
          }
        ]
      };
    });
    const res = await fetchListForAllBoards({ type: 'ready-issues' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.map((it) => it.id)).toEqual(['bravo-hi', 'alpha-lo']);
  });
});

describe('issue → board routing', () => {
  test('detail routes to the owning board instead of fanning out its result', async () => {
    fetch_mock.mockImplementation(async (spec, options) => {
      const on_alpha = String(options.board_dir).includes('/alpha/');
      if (String(spec.type) === 'issue-detail') {
        return on_alpha
          ? {
              ok: true,
              items: [
                { id: 'alpha-7', created_at: 1, updated_at: 1, closed_at: null }
              ]
            }
          : { ok: true, items: [] };
      }
      return { ok: true, items: [] };
    });
    const res = await fetchListForAllBoards({
      type: 'issue-detail',
      params: { id: 'alpha-7' }
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.length).toBe(1);
    expect(res.items[0].board_id).toBe('alpha');
  });

  test('an id no board owns resolves to null and detail reports not_found', async () => {
    fetch_mock.mockResolvedValue({ ok: true, items: [] });
    expect(await resolveIssueBoard('nowhere-1')).toBe(null);
    const res = await fetchListForAllBoards({
      type: 'issue-detail',
      params: { id: 'nowhere-1' }
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('not_found');
  });

  test('aggregate fetches teach the prefix map, so routing needs no probe', async () => {
    fetch_mock.mockImplementation(async (_spec, options) => {
      if (String(options.board_dir).includes('/alpha/')) {
        return {
          ok: true,
          items: [
            { id: 'alpha-1', created_at: 1, updated_at: 1, closed_at: null }
          ]
        };
      }
      return { ok: true, items: [] };
    });
    await fetchListForAllBoards({ type: 'all-issues' });
    fetch_mock.mockClear();
    const board = await resolveIssueBoard('alpha-99');
    expect(board?.id).toBe('alpha');
    // No probe: the prefix was learned from the aggregate fetch above.
    expect(fetch_mock).not.toHaveBeenCalled();
  });
});
