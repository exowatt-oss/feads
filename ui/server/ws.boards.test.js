/**
 * feads addition — board registry surfaced through `list-workspaces`, and
 * switching boards by registry id via `set-board`.
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
import { getConnectionBoardDir } from './active-board.js';
import { runBd, runBdJson } from './bd.js';
import { handleMessage } from './ws.js';

vi.mock('./bd.js', () => ({ runBdJson: vi.fn(), runBd: vi.fn() }));

/** @type {string} */
let scratch;
/** @type {string} */
let alpha_root;
/** @type {string} */
let bravo_root;
/** @type {string | undefined} */
let prev_registry_db;

/**
 * @param {string} name
 * @returns {string}
 */
function makeBoard(name) {
  const root = path.join(scratch, name);
  const beads_dir = path.join(root, '.beads');
  fs.mkdirSync(beads_dir, { recursive: true });
  fs.writeFileSync(path.join(beads_dir, 'metadata.json'), '{}');
  return root;
}

function makeStubSocket() {
  return {
    sent: /** @type {string[]} */ ([]),
    readyState: 1,
    OPEN: 1,
    /** @param {string} msg */
    send(msg) {
      this.sent.push(String(msg));
    }
  };
}

/**
 * @param {{ sent: string[] }} ws
 * @returns {any}
 */
function lastReply(ws) {
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

/**
 * Send a message on a specific connection.
 *
 * feads: the socket is a parameter now, and that is the whole shape of ex-dh0's fix
 * — a board selection belongs to the connection that made it, so a test that used a
 * throwaway socket per message could not observe a selection at all.
 *
 * @param {{ sent: string[] }} ws
 * @param {string} type
 * @param {unknown} payload
 * @returns {Promise<any>}
 */
async function on(ws, type, payload) {
  await handleMessage(
    /** @type {any} */ (ws),
    Buffer.from(JSON.stringify({ id: `t-${type}`, type, payload }))
  );
  return lastReply(ws);
}

/**
 * Send a message on a fresh connection, for the cases that do not care which.
 *
 * @param {string} type
 * @param {unknown} payload
 * @returns {Promise<any>}
 */
async function request(type, payload) {
  return on(makeStubSocket(), type, payload);
}

beforeAll(async () => {
  scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bdui-registry-'))
  );
  alpha_root = makeBoard('alpha');
  bravo_root = makeBoard('bravo');

  prev_registry_db = process.env.FEADS_REGISTRY_DB;
  process.env.FEADS_REGISTRY_DB = path.join(scratch, 'registry.db');

  const registry = await import('../../boards/registry.mjs');
  const db = registry.openRegistry();
  try {
    registry.upsertBoard(db, {
      id: 'alpha',
      name: 'Alpha Board',
      board_dir: path.join(alpha_root, '.beads'),
      workspace_dir: alpha_root,
      description: 'Lab cross-repo coordination',
      repos: ['example-lab/sample-controller', 'example-lab/cloud-lab-api']
    });
    registry.upsertBoard(db, {
      id: 'bravo',
      name: 'Bravo Board',
      board_dir: path.join(bravo_root, '.beads'),
      workspace_dir: bravo_root,
      description: 'Tooling experiments',
      repos: ['example-org/feads']
    });
    registry.upsertBoard(db, {
      id: 'ghost',
      name: 'Ghost Board',
      board_dir: path.join(scratch, 'deleted', '.beads'),
      description: 'board directory was removed'
    });
  } finally {
    db.close();
  }
});

afterAll(() => {
  if (prev_registry_db === undefined) {
    delete process.env.FEADS_REGISTRY_DB;
  } else {
    process.env.FEADS_REGISTRY_DB = prev_registry_db;
  }
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

beforeEach(() => {
  /** @type {import('vitest').Mock} */ (runBd).mockReset();
  /** @type {import('vitest').Mock} */ (runBdJson).mockReset();
});

describe('list-workspaces with a board registry', () => {
  test('carries id, name, description and repos for each registry board', async () => {
    const reply = await request('list-workspaces', {});
    expect(reply.ok).toBe(true);

    const alpha = reply.payload.workspaces.find(
      (/** @type {any} */ w) => w.id === 'alpha'
    );
    expect(alpha).toBeTruthy();
    expect(alpha.name).toBe('Alpha Board');
    expect(alpha.description).toBe('Lab cross-repo coordination');
    expect(alpha.repos).toEqual([
      'example-lab/cloud-lab-api',
      'example-lab/sample-controller'
    ]);
    expect(alpha.board_dir).toBe(path.join(alpha_root, '.beads'));
    expect(alpha.key).toBe('alpha');
    expect(alpha.exists).toBe(true);
  });

  test('lists boards that are not the current one, so a switcher appears', async () => {
    const reply = await request('list-workspaces', {});
    const ids = reply.payload.workspaces.map((/** @type {any} */ w) => w.id);
    expect(ids).toContain('alpha');
    expect(ids).toContain('bravo');
    expect(reply.payload.workspaces.length).toBeGreaterThan(1);
  });

  test('marks a board whose directory is gone instead of offering it', async () => {
    const reply = await request('list-workspaces', {});
    const ghost = reply.payload.workspaces.find(
      (/** @type {any} */ w) => w.id === 'ghost'
    );
    expect(ghost).toBeTruthy();
    expect(ghost.exists).toBe(false);
  });
});

describe('set-board', () => {
  test('rejects a payload that names no board', async () => {
    const reply = await request('set-board', {});
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad_request');
  });

  test('rejects an unknown registry id', async () => {
    const reply = await request('set-board', { id: 'nope' });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('not_found');
  });

  test('refuses a registered board whose directory is gone', async () => {
    const reply = await request('set-board', { id: 'ghost' });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('board_missing');
  });

  test('selecting by id pins bd to that board and returns its metadata', async () => {
    const ws = makeStubSocket();
    const reply = await on(ws, 'set-board', { id: 'bravo' });
    expect(reply.ok).toBe(true);
    expect(reply.payload.changed).toBe(true);
    expect(reply.payload.workspace.board_dir).toBe(
      path.join(bravo_root, '.beads')
    );
    expect(reply.payload.workspace.board_id).toBe('bravo');
    expect(reply.payload.workspace.name).toBe('Bravo Board');
    expect(reply.payload.workspace.repos).toEqual(['example-org/feads']);
    // The binding this connection's bd children actually read.
    expect(getConnectionBoardDir(ws)).toBe(path.join(bravo_root, '.beads'));
  });

  test('switching to another board rebinds bd to it', async () => {
    const ws = makeStubSocket();
    await on(ws, 'set-board', { id: 'bravo' });
    const reply = await on(ws, 'set-board', { id: 'alpha' });
    expect(reply.ok).toBe(true);
    expect(reply.payload.changed).toBe(true);
    expect(getConnectionBoardDir(ws)).toBe(path.join(alpha_root, '.beads'));
  });

  test('re-selecting the board this connection is on reports no change', async () => {
    const ws = makeStubSocket();
    await on(ws, 'set-board', { id: 'alpha' });
    const reply = await on(ws, 'set-board', { id: 'alpha' });
    expect(reply.ok).toBe(true);
    expect(reply.payload.changed).toBe(false);
  });

  test('accepts an unregistered board directory', async () => {
    const loose_root = makeBoard('loose');
    const ws = makeStubSocket();
    const reply = await on(ws, 'set-board', {
      board_dir: path.join(loose_root, '.beads')
    });
    expect(reply.ok).toBe(true);
    expect(getConnectionBoardDir(ws)).toBe(path.join(loose_root, '.beads'));
    expect(reply.payload.workspace.root_dir).toBe(loose_root);
  });

  test('accepts a project root, like set-workspace does', async () => {
    const ws = makeStubSocket();
    const reply = await on(ws, 'set-board', { path: alpha_root });
    expect(reply.ok).toBe(true);
    expect(getConnectionBoardDir(ws)).toBe(path.join(alpha_root, '.beads'));
  });

  test('announces the change to the connection that made it, and nobody else', async () => {
    const switcher = makeStubSocket();
    const bystander = makeStubSocket();
    await on(bystander, 'get-workspace', {});
    bystander.sent = [];

    await on(switcher, 'set-board', { id: 'bravo' });

    const events = switcher.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === 'workspace-changed');
    expect(events).toHaveLength(1);
    expect(events[0].payload.board_id).toBe('bravo');
    // A second tab quietly following the first one's switch is the same class of
    // bug as the one this work fixes.
    expect(bystander.sent).toEqual([]);
  });
});

describe('set-workspace still works', () => {
  test('discovers the board under a project root and pins bd to it', async () => {
    const ws = makeStubSocket();
    await on(ws, 'set-board', { id: 'alpha' });
    const reply = await on(ws, 'set-workspace', { path: bravo_root });
    expect(reply.ok).toBe(true);
    expect(reply.payload.changed).toBe(true);
    expect(reply.payload.workspace.root_dir).toBe(bravo_root);
    expect(getConnectionBoardDir(ws)).toBe(path.join(bravo_root, '.beads'));
  });

  test('still rejects a missing path payload', async () => {
    const reply = await request('set-workspace', {});
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad_request');
  });
});
