import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { signupAgent } from '../../boards/agents.mjs';
import { openRegistry, upsertBoard } from '../../boards/registry.mjs';

const mocks = vi.hoisted(() => ({
  getPgStore: vi.fn(),
  query: vi.fn(),
  listRegistryBoards: vi.fn()
}));

vi.mock('./pg-store.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, getPgStore: mocks.getPgStore };
});

vi.mock('./board-registry.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, listRegistryBoards: mocks.listRegistryBoards };
});

const { createApp } = await import('./app.js');
const { getConfig } = await import('./config.js');

/** @type {string[]} */
const temp_dirs = [];

const ROW = {
  id: 'main-1',
  board_id: 'main',
  title: 'Ship it',
  status: 'in_progress',
  issue_type: 'task',
  priority: 1,
  assignee: 'watcher',
  created_at: new Date('2026-10-20T10:00:00.000Z'),
  updated_at: new Date('2026-10-22T10:00:00.000Z'),
  closed_at: null,
  labels: ['backend'],
  blocked_by: ['main-0']
};

function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feads-issues-api-'));
  temp_dirs.push(root);
  const registry_path = path.join(root, 'registry.db');
  const env = { FEADS_REGISTRY_DB: registry_path, FEADS_ACCOUNTS: 'off' };
  const db = openRegistry({ path: registry_path, env });
  const board_dir = path.join(root, 'board');
  fs.mkdirSync(board_dir, { recursive: true });
  upsertBoard(db, { id: 'main', name: 'Main', board_dir });
  const { token } = signupAgent(db, {
    board_id: 'main',
    display_name: 'Watcher',
    actor: 'Watcher'
  });
  db.close();
  const app = createApp({ ...getConfig(), root_dir: root }, { env });
  return { app, token };
}

/**
 * @param {import('express').Express} app
 * @param {string} query
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, json: any, headers: Headers }>}
 */
async function getIssues(app, query, headers = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = /** @type {any} */ (server.address());
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/issues${query}`,
      { headers }
    );
    return {
      status: response.status,
      json: await response.json(),
      headers: response.headers
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  mocks.query.mockResolvedValue({ rows: [ROW] });
  mocks.getPgStore.mockReturnValue({ query: mocks.query });
  mocks.listRegistryBoards.mockResolvedValue([{ id: 'main', name: 'Main' }]);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of temp_dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('GET /api/issues', () => {
  test('refuses an unidentified caller', async () => {
    const { app } = makeApp();

    const response = await getIssues(app, '?assignee=me');

    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  test("serves the caller's in-progress work across boards", async () => {
    const { app, token } = makeApp();

    const response = await getIssues(
      app,
      '?status=in_progress&assignee=me&board=*',
      { authorization: `Bearer ${token}` }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.json).toEqual({
      ok: true,
      actor: 'watcher',
      issues: [
        {
          id: 'main-1',
          title: 'Ship it',
          status: 'in_progress',
          issue_type: 'task',
          priority: 1,
          assignee: 'watcher',
          labels: ['backend'],
          board_id: 'main',
          board_name: 'Main',
          created_at: '2026-10-20T10:00:00.000Z',
          updated_at: '2026-10-22T10:00:00.000Z',
          closed_at: null,
          blocked_by: ['main-0']
        }
      ]
    });
    const [, params] = mocks.query.mock.calls[0];
    expect(params).toEqual([['in_progress'], ['watcher'], null, 100]);
  });

  test('passes explicit statuses, an actor, boards and a clamped limit', async () => {
    const { app, token } = makeApp();

    await getIssues(
      app,
      '?status=open,%20in_progress&assignee=Someone&board=main,ops&limit=9999',
      { authorization: `Bearer ${token}` }
    );

    const [, params] = mocks.query.mock.calls[0];
    expect(params).toEqual([
      ['open', 'in_progress'],
      ['someone'],
      ['main', 'ops'],
      500
    ]);
  });

  test('leaves every filter open when none is given', async () => {
    const { app, token } = makeApp();

    await getIssues(app, '', { authorization: `Bearer ${token}` });

    const [, params] = mocks.query.mock.calls[0];
    expect(params).toEqual([null, null, null, 100]);
  });

  test('answers 503 when the Postgres data layer is not configured', async () => {
    mocks.getPgStore.mockReturnValue(null);
    const { app, token } = makeApp();

    const response = await getIssues(app, '?assignee=me', {
      authorization: `Bearer ${token}`
    });

    expect(response.status).toBe(503);
    expect(response.json).toEqual({ ok: false, error: 'pg_unavailable' });
  });

  test('answers 500 when the query fails', async () => {
    mocks.query.mockRejectedValue(new Error('boom'));
    const { app, token } = makeApp();

    const response = await getIssues(app, '?assignee=me', {
      authorization: `Bearer ${token}`
    });

    expect(response.status).toBe(500);
    expect(response.json.ok).toBe(false);
  });
});
