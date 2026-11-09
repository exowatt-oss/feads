/**
 * feads addition — the `epic-graph` / `epic-history` message handlers behind
 * the epic story view.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vitest';
import { runBd } from './bd.js';
import { handleMessage } from './ws.js';

vi.mock('./bd.js', () => ({
  runBdJson: vi.fn(),
  runBd: vi.fn(),
  getGitUserName: vi.fn(async () => '')
}));

/** @type {string} */
let scratch;
/** @type {string | undefined} */
let prev_registry_db;
/** @type {string | undefined} */
let prev_story_dir;

/**
 * @returns {{ sent: string[], readyState: number, OPEN: number, send: (msg: string) => void }}
 */
function makeStubSocket() {
  return {
    sent: [],
    readyState: 1,
    OPEN: 1,
    send(msg) {
      this.sent.push(String(msg));
    }
  };
}

/**
 * @param {{ sent: string[] }} ws
 * @param {string} type
 * @param {unknown} payload
 * @returns {Promise<any>}
 */
async function request(ws, type, payload) {
  await handleMessage(
    /** @type {any} */ (ws),
    Buffer.from(JSON.stringify({ id: `t-${type}`, type, payload }))
  );
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

/**
 * @param {Record<string, unknown>[]} issues
 * @returns {string}
 */
function exportText(issues) {
  return issues.map((issue) => JSON.stringify(issue)).join('\n') + '\n';
}

const EXPORT_FIXTURE = exportText([
  {
    id: 'st-epic',
    title: 'Story epic',
    status: 'in_progress',
    issue_type: 'epic'
  },
  {
    id: 'st-a',
    title: 'First',
    status: 'closed',
    issue_type: 'task',
    dependencies: [
      { issue_id: 'st-a', depends_on_id: 'st-epic', type: 'parent-child' }
    ]
  },
  {
    id: 'st-b',
    title: 'Second',
    status: 'open',
    issue_type: 'task',
    dependencies: [
      { issue_id: 'st-b', depends_on_id: 'st-epic', type: 'parent-child' },
      { issue_id: 'st-b', depends_on_id: 'st-a', type: 'blocks' }
    ]
  }
]);

beforeAll(() => {
  scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bdui-story-'))
  );
  // No registry file → operator mode → reads are allowed without a credential.
  prev_registry_db = process.env.FEADS_REGISTRY_DB;
  process.env.FEADS_REGISTRY_DB = path.join(scratch, 'no-registry.db');
  prev_story_dir = process.env.FEADS_STORY_DIR;
  process.env.FEADS_STORY_DIR = path.join(scratch, 'story');
});

afterAll(() => {
  if (prev_registry_db === undefined) {
    delete process.env.FEADS_REGISTRY_DB;
  } else {
    process.env.FEADS_REGISTRY_DB = prev_registry_db;
  }
  if (prev_story_dir === undefined) {
    delete process.env.FEADS_STORY_DIR;
  } else {
    process.env.FEADS_STORY_DIR = prev_story_dir;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(runBd).mockReset();
});

describe('epic-graph', () => {
  test('refuses a missing id without touching bd', async () => {
    const reply = await request(makeStubSocket(), 'epic-graph', {});
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad_request');
    expect(vi.mocked(runBd)).not.toHaveBeenCalled();
  });

  test('returns the current graph for an epic', async () => {
    vi.mocked(runBd).mockResolvedValue({
      code: 0,
      stdout: EXPORT_FIXTURE,
      stderr: ''
    });
    const reply = await request(makeStubSocket(), 'epic-graph', {
      id: 'st-epic'
    });
    expect(reply.ok).toBe(true);
    expect(reply.payload.epic).toMatchObject({
      id: 'st-epic',
      title: 'Story epic',
      status: 'in_progress'
    });
    expect(reply.payload.nodes.map((/** @type {any} */ n) => n.id)).toEqual([
      'st-a',
      'st-b'
    ]);
    expect(reply.payload.edges).toEqual([['st-a', 'st-b']]);
    expect(vi.mocked(runBd)).toHaveBeenCalledWith(
      ['export'],
      expect.objectContaining({ timeout_ms: 60000 })
    );
  });

  test('an unknown epic is not_found', async () => {
    vi.mocked(runBd).mockResolvedValue({
      code: 0,
      stdout: EXPORT_FIXTURE,
      stderr: ''
    });
    const reply = await request(makeStubSocket(), 'epic-graph', {
      id: 'st-missing'
    });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('not_found');
  });

  test('a failing export is a bd_error, not a crash', async () => {
    vi.mocked(runBd).mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' });
    const reply = await request(makeStubSocket(), 'epic-graph', {
      id: 'st-epic'
    });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bd_error');
  });
});

describe('epic-history', () => {
  test('refuses a missing id', async () => {
    const reply = await request(makeStubSocket(), 'epic-history', {});
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad_request');
  });

  test('an unrecorded epic reads as empty history', async () => {
    const reply = await request(makeStubSocket(), 'epic-history', {
      id: 'st-never-seen'
    });
    expect(reply.ok).toBe(true);
    expect(reply.payload).toEqual({
      epic_id: 'st-never-seen',
      frames: [],
      metas: []
    });
  });

  test('a capture leaves history behind that epic-history then serves', async () => {
    vi.mocked(runBd).mockResolvedValue({
      code: 0,
      stdout: EXPORT_FIXTURE,
      stderr: ''
    });
    const graph_reply = await request(makeStubSocket(), 'epic-graph', {
      id: 'st-epic'
    });
    expect(graph_reply.ok).toBe(true);

    const reply = await request(makeStubSocket(), 'epic-history', {
      id: 'st-epic'
    });
    expect(reply.ok).toBe(true);
    expect(reply.payload.frames.length).toBeGreaterThanOrEqual(1);
    const last = reply.payload.frames[reply.payload.frames.length - 1];
    expect(last.statuses).toEqual({ 'st-a': 'closed', 'st-b': 'open' });
    expect(reply.payload.metas[last.m].edges).toEqual([['st-a', 'st-b']]);
  });
});
