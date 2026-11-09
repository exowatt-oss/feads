/**
 * feads addition — the epic story recorder: export parsing, snapshot building,
 * deduplicated append, and history reconstruction.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  appendEpicSnapshot,
  boardStoryDir,
  buildEpicSnapshots,
  captureBoard,
  epicGraphPayload,
  parseExportLines,
  readEpicHistory,
  storyBoardKey
} from './story-snapshots.js';

/** @type {string} */
let scratch;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'story-'));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * @param {Record<string, unknown>[]} issues
 * @returns {string}
 */
function exportText(issues) {
  return issues.map((issue) => JSON.stringify(issue)).join('\n') + '\n';
}

const EPIC = {
  id: 'ex-epic',
  title: 'The epic',
  status: 'in_progress',
  issue_type: 'epic'
};
const CHILD_A = {
  id: 'ex-a',
  title: 'Task A',
  status: 'closed',
  issue_type: 'task',
  assignee: 'alice',
  dependencies: [
    { issue_id: 'ex-a', depends_on_id: 'ex-epic', type: 'parent-child' }
  ]
};
const CHILD_B = {
  id: 'ex-b',
  title: 'Task B',
  status: 'open',
  issue_type: 'task',
  dependencies: [
    { issue_id: 'ex-b', depends_on_id: 'ex-epic', type: 'parent-child' },
    { issue_id: 'ex-b', depends_on_id: 'ex-a', type: 'blocks' }
  ]
};

describe('parseExportLines', () => {
  test('parses issues and skips malformed lines', () => {
    const text = `${JSON.stringify(EPIC)}\nnot json\n${JSON.stringify(CHILD_A)}\n`;
    const issues = parseExportLines(text);
    expect(issues.map((issue) => issue.id)).toEqual(['ex-epic', 'ex-a']);
    expect(issues[1].dependencies).toEqual([
      { depends_on_id: 'ex-epic', type: 'parent-child' }
    ]);
  });

  test('marks tombstones and deletions', () => {
    const text = exportText([
      { id: 'x-1', status: 'tombstone' },
      { id: 'x-2', status: 'open', deleted_at: '2026-01-01T00:00:00Z' }
    ]);
    const issues = parseExportLines(text);
    expect(issues.every((issue) => issue.deleted)).toBe(true);
  });
});

describe('buildEpicSnapshots', () => {
  test('collects members, statuses and scheduling edges', () => {
    const snapshots = buildEpicSnapshots(
      parseExportLines(exportText([EPIC, CHILD_A, CHILD_B])),
      1000
    );
    const snap = snapshots.get('ex-epic');
    expect(snap).toBeTruthy();
    expect(snap?.epic).toEqual({
      id: 'ex-epic',
      title: 'The epic',
      status: 'in_progress'
    });
    expect(snap?.statuses).toEqual({ 'ex-a': 'closed', 'ex-b': 'open' });
    expect(snap?.edges).toEqual([['ex-a', 'ex-b']]);
    expect(snap?.nodes['ex-a'].assignee).toBe('alice');
  });

  test('includes grandchildren through sub-parents and drops cross-epic edges', () => {
    const sub = {
      id: 'ex-sub',
      title: 'Sub',
      status: 'open',
      issue_type: 'task',
      dependencies: [
        { issue_id: 'ex-sub', depends_on_id: 'ex-a', type: 'parent-child' },
        { issue_id: 'ex-sub', depends_on_id: 'outside', type: 'blocks' }
      ]
    };
    const snapshots = buildEpicSnapshots(
      parseExportLines(
        exportText([
          EPIC,
          CHILD_A,
          { id: 'outside', title: 'other', status: 'open', issue_type: 'task' },
          sub
        ])
      ),
      1000
    );
    const snap = snapshots.get('ex-epic');
    expect(Object.keys(snap?.statuses || {})).toEqual(['ex-a', 'ex-sub']);
    expect(snap?.edges).toEqual([]);
  });
});

describe('appendEpicSnapshot / readEpicHistory', () => {
  /**
   * @param {number} t
   * @param {Record<string, string>} statuses
   * @returns {import('./story-snapshots.js').EpicSnapshot}
   */
  function snapAt(t, statuses) {
    return {
      t,
      epic: { id: 'ex-epic', title: 'The epic', status: 'in_progress' },
      statuses,
      nodes: {
        'ex-a': { title: 'Task A', type: 'task', assignee: '' },
        'ex-b': { title: 'Task B', type: 'task', assignee: '' }
      },
      edges: [['ex-a', 'ex-b']]
    };
  }

  test('first write carries meta, unchanged writes dedupe, status changes append', () => {
    const board = path.join(scratch, '.beads');
    const opts = { data_dir: path.join(scratch, 'story') };
    expect(
      appendEpicSnapshot(
        board,
        snapAt(1, { 'ex-a': 'open', 'ex-b': 'open' }),
        opts
      )
    ).toBe('written-with-meta');
    expect(
      appendEpicSnapshot(
        board,
        snapAt(2, { 'ex-a': 'open', 'ex-b': 'open' }),
        opts
      )
    ).toBe('unchanged');
    expect(
      appendEpicSnapshot(
        board,
        snapAt(3, { 'ex-a': 'closed', 'ex-b': 'open' }),
        opts
      )
    ).toBe('written');

    const history = readEpicHistory(board, 'ex-epic', opts);
    expect(history.frames).toHaveLength(2);
    expect(history.metas).toHaveLength(1);
    expect(history.frames[0].statuses).toEqual({
      'ex-a': 'open',
      'ex-b': 'open'
    });
    expect(history.frames[1].statuses).toEqual({
      'ex-a': 'closed',
      'ex-b': 'open'
    });
    expect(history.frames[1].t).toBe(3);
    expect(history.frames[1].m).toBe(0);
    expect(history.metas[0].edges).toEqual([['ex-a', 'ex-b']]);
  });

  test('dedupe survives a restart: an existing file the cache has never seen still dedupes', () => {
    const board = path.join(scratch, '.beads-cold');
    const opts = { data_dir: path.join(scratch, 'story') };
    // Plant the file directly, so the module's in-memory last-written cache has
    // no entry for it — exactly the state after a daemon restart.
    const dir = boardStoryDir(board, { data_dir: opts.data_dir, create: true });
    const file = path.join(dir, 'ex-epic.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        t: 1,
        es: 'p',
        s: { 'ex-a': 'o', 'ex-b': 'o' },
        meta: {
          epic: { title: 'The epic' },
          nodes: {
            'ex-a': { title: 'Task A', type: 'task', assignee: '' },
            'ex-b': { title: 'Task B', type: 'task', assignee: '' }
          },
          edges: [['ex-a', 'ex-b']]
        }
      }) + '\n'
    );
    const before = fs.readFileSync(file, 'utf8');
    expect(
      appendEpicSnapshot(
        board,
        snapAt(99, { 'ex-a': 'open', 'ex-b': 'open' }),
        opts
      )
    ).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('meta change appends a new meta and later frames point at it', () => {
    const board = path.join(scratch, '.beads-meta');
    const opts = { data_dir: path.join(scratch, 'story') };
    appendEpicSnapshot(
      board,
      snapAt(1, { 'ex-a': 'open', 'ex-b': 'open' }),
      opts
    );
    const grown = snapAt(2, { 'ex-a': 'open', 'ex-b': 'open', 'ex-c': 'open' });
    grown.nodes['ex-c'] = { title: 'Task C', type: 'task', assignee: '' };
    expect(appendEpicSnapshot(board, grown, opts)).toBe('written-with-meta');

    const history = readEpicHistory(board, 'ex-epic', opts);
    expect(history.metas).toHaveLength(2);
    expect(history.frames[0].m).toBe(0);
    expect(history.frames[1].m).toBe(1);
    expect(Object.keys(history.metas[1].nodes)).toContain('ex-c');
  });

  test('missing history reads as empty', () => {
    const history = readEpicHistory(path.join(scratch, 'nope'), 'ex-none', {
      data_dir: path.join(scratch, 'story')
    });
    expect(history).toEqual({ frames: [], metas: [] });
  });
});

describe('captureBoard', () => {
  test('exports, persists changed epics, returns all snapshots', async () => {
    const board_dir = path.join(scratch, 'proj', '.beads');
    const data_dir = path.join(scratch, 'story');
    /** @type {string[][]} */
    const calls = [];
    const run = async (/** @type {string[]} */ args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: exportText([
          EPIC,
          CHILD_A,
          CHILD_B,
          {
            id: 'ex-empty',
            title: 'Empty epic',
            status: 'open',
            issue_type: 'epic'
          }
        ]),
        stderr: ''
      };
    };
    const snapshots = await captureBoard(
      { board_dir, cwd: path.join(scratch, 'proj') },
      { data_dir, run, now: () => 42 }
    );
    expect(calls).toEqual([['export']]);
    expect(Array.from(snapshots.keys()).sort()).toEqual([
      'ex-empty',
      'ex-epic'
    ]);

    // The member-bearing epic got a history line; the empty one did not.
    expect(
      readEpicHistory(board_dir, 'ex-epic', { data_dir }).frames
    ).toHaveLength(1);
    expect(
      readEpicHistory(board_dir, 'ex-empty', { data_dir }).frames
    ).toHaveLength(0);

    const graph = epicGraphPayload(snapshots, 'ex-epic');
    expect(graph?.epic.title).toBe('The epic');
    expect(graph?.nodes.map((n) => n.id)).toEqual(['ex-a', 'ex-b']);
    expect(graph?.nodes[0].status).toBe('closed');
    expect(graph?.edges).toEqual([['ex-a', 'ex-b']]);
    expect(epicGraphPayload(snapshots, 'missing')).toBeNull();
  });

  test('a failing export throws with the stderr tail', async () => {
    const run = async () => ({ code: 1, stdout: '', stderr: 'boom' });
    await expect(
      captureBoard({ board_dir: path.join(scratch, '.b') }, { run })
    ).rejects.toThrow(/boom/);
  });
});

describe('storyBoardKey', () => {
  test('prefers the board dir, falls back to cwd, then a constant', () => {
    expect(storyBoardKey({ board_dir: '/a/.beads' })).toBe(
      path.resolve('/a/.beads')
    );
    expect(storyBoardKey({ board_dir: null, cwd: '/w' })).toBe(
      path.resolve('/w')
    );
    expect(storyBoardKey({ board_dir: null })).toBe('unbound');
  });
});
