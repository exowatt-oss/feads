/**
 * feads addition — the All-boards pseudo-board over the WebSocket protocol:
 * the picker entry, selecting `*`, aggregate subscriptions, refusal of
 * creation, and the routing of id-scoped writes to the issue's home board.
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
import { resetAggregateBoardsCache } from './all-board.js';
import { runBd, runBdJson } from './bd.js';
import { fetchListForSubscription } from './list-adapters.js';
import { handleMessage } from './ws.js';

// The write handlers ask the identity policy; without this stub the answer
// would depend on whether the machine running the tests has an agent registry
// (this file creates one for the *board* registry). See test/stub-identity.js.
vi.mock('./identity.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  const { operatorResolution } = await import('../test/stub-identity.js');
  return {
    ...actual,
    resolveIdentity: vi.fn(async () => operatorResolution())
  };
});

vi.mock('./bd.js', () => ({
  runBd: vi.fn(),
  runBdJson: vi.fn(),
  getGitUserName: vi.fn(async () => 'tester')
}));
vi.mock('./list-adapters.js', () => ({
  fetchListForSubscription: vi.fn()
}));

const fetch_mock = /** @type {import('vitest').Mock} */ (
  fetchListForSubscription
);
const run_bd_mock = /** @type {import('vitest').Mock} */ (runBd);
const run_bd_json_mock = /** @type {import('vitest').Mock} */ (runBdJson);

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

beforeAll(async () => {
  scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bdui-allboards-'))
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
      description: 'First board',
      repos: []
    });
    registry.upsertBoard(db, {
      id: 'bravo',
      name: 'Bravo Board',
      board_dir: path.join(bravo_root, '.beads'),
      workspace_dir: bravo_root,
      description: 'Second board',
      repos: []
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
  resetAggregateBoardsCache();
  fetch_mock.mockReset();
  run_bd_mock.mockReset();
  run_bd_json_mock.mockReset();
});

describe('the picker offers All boards', () => {
  test('list-workspaces leads with the pseudo-board when several boards exist', async () => {
    const reply = await on(makeStubSocket(), 'list-workspaces', {});
    expect(reply.ok).toBe(true);
    const first = reply.payload.workspaces[0];
    expect(first.id).toBe('*');
    expect(first.name).toBe('All boards');
    expect(first.exists).toBe(true);
  });
});

describe('selecting the pseudo-board', () => {
  test('set-board { id: "*" } binds the connection to the aggregate view', async () => {
    const sock = makeStubSocket();
    const reply = await on(sock, 'set-board', { id: '*' });
    expect(reply.ok).toBe(true);
    expect(reply.payload.workspace.board_id).toBe('*');
    expect(reply.payload.workspace.name).toBe('All boards');
    // bd children of this connection are pinned to *nothing*: an unrouted
    // handler must fail honestly rather than write to the seed board.
    expect(getConnectionBoardDir(/** @type {any} */ (sock))).toBe('');
  });

  test('a subscription on the pseudo-board answers with rows from every board', async () => {
    fetch_mock.mockImplementation(async (_spec, options) => {
      const dir = String(options.board_dir || '');
      if (dir.includes(`${path.sep}alpha${path.sep}`)) {
        return {
          ok: true,
          items: [
            { id: 'alpha-1', created_at: 1, updated_at: 1, closed_at: null }
          ]
        };
      }
      return {
        ok: true,
        items: [
          { id: 'bravo-1', created_at: 2, updated_at: 2, closed_at: null }
        ]
      };
    });
    const sock = makeStubSocket();
    await on(sock, 'set-board', { id: '*' });
    await on(sock, 'subscribe-list', { id: 'c1', type: 'all-issues' });
    const snapshot = sock.sent
      .map((m) => JSON.parse(m))
      .find((m) => m.type === 'snapshot');
    expect(snapshot).toBeTruthy();
    const ids = snapshot.payload.issues.map((/** @type {any} */ it) => it.id);
    expect(ids).toContain('alpha-1');
    expect(ids).toContain('bravo-1');
    const alpha_row = snapshot.payload.issues.find(
      (/** @type {any} */ it) => it.id === 'alpha-1'
    );
    expect(alpha_row.board_id).toBe('alpha');
    expect(alpha_row.board_name).toBe('Alpha Board');
  });
});

describe('writes on the pseudo-board', () => {
  test('create-issue is refused with directions, not a bd error', async () => {
    const sock = makeStubSocket();
    await on(sock, 'set-board', { id: '*' });
    const reply = await on(sock, 'create-issue', { title: 'nope' });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('all_boards_no_create');
    expect(reply.error.message).toContain('specific board');
  });

  test("an id-scoped write is routed to the issue's home board", async () => {
    // The routing probe (issue-detail) finds alpha-7 only on alpha.
    fetch_mock.mockImplementation(async (spec, options) => {
      const dir = String(options.board_dir || '');
      if (
        String(spec.type) === 'issue-detail' &&
        dir.includes(`${path.sep}alpha${path.sep}`)
      ) {
        return {
          ok: true,
          items: [
            { id: 'alpha-7', created_at: 1, updated_at: 1, closed_at: null }
          ]
        };
      }
      return { ok: true, items: [] };
    });
    run_bd_mock.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    run_bd_json_mock.mockResolvedValue({
      code: 0,
      stdoutJson: { id: 'alpha-7', priority: 1 }
    });

    const sock = makeStubSocket();
    await on(sock, 'set-board', { id: '*' });
    const reply = await on(sock, 'update-priority', {
      id: 'alpha-7',
      priority: 1
    });
    expect(reply.ok).toBe(true);
    expect(run_bd_mock).toHaveBeenCalled();
    const [, bd_options] = run_bd_mock.mock.calls[0];
    expect(bd_options.board_dir).toBe(path.join(alpha_root, '.beads'));
    expect(bd_options.cwd).toBe(alpha_root);
  });

  test('a write on an id no board owns is answered not_found', async () => {
    fetch_mock.mockResolvedValue({ ok: true, items: [] });
    const sock = makeStubSocket();
    await on(sock, 'set-board', { id: '*' });
    const reply = await on(sock, 'update-priority', {
      id: 'ghost-1',
      priority: 1
    });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('not_found');
    expect(run_bd_mock).not.toHaveBeenCalled();
  });
});
