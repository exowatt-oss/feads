import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { signupAgent } from '../../boards/agents.mjs';
import { openRegistry, upsertBoard } from '../../boards/registry.mjs';

const mocks = vi.hoisted(() => ({
  fetchAgentwatchSnapshot: vi.fn(),
  getPgStore: vi.fn()
}));

vi.mock('./agentwatch.js', () => ({
  fetchAgentwatchSnapshot: mocks.fetchAgentwatchSnapshot
}));

vi.mock('./pg-store.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, getPgStore: mocks.getPgStore };
});

const { createApp } = await import('./app.js');
const { getConfig } = await import('./config.js');
const { scopeAgentwatchSnapshot } = await import('./agentwatch-routes.js');

/** @type {string[]} */
const temp_dirs = [];

const SNAPSHOT = {
  generated_at: 1_000,
  stats: {
    active_agents: 2,
    registered_agents: 2,
    active_issues: 3,
    shared_discussions: 2
  },
  agents: [
    {
      actor: 'alice',
      item_count: 2,
      flare: { board_id: 'main', issue_id: 'main-1' },
      issues: [
        { id: 'main-1', board_id: 'main' },
        { id: 'secret-1', board_id: 'secret' }
      ]
    },
    {
      actor: 'mallory',
      item_count: 1,
      flare: null,
      issues: [{ id: 'main-2', board_id: 'main' }]
    }
  ],
  discussions: [
    { issue_id: 'main-1', board_id: 'main' },
    { issue_id: 'secret-1', board_id: 'secret' }
  ]
};

function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feads-agentwatch-api-'));
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
    actor: 'watcher'
  });
  db.close();
  const app = createApp({ ...getConfig(), root_dir: root }, { env });
  return { app, token };
}

/**
 * @param {import('express').Express} app
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, json: any, headers: Headers }>}
 */
async function getAgentwatch(app, headers = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = /** @type {any} */ (server.address());
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/agentwatch`,
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
  mocks.getPgStore.mockReturnValue({});
  mocks.fetchAgentwatchSnapshot.mockResolvedValue(SNAPSHOT);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of temp_dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('GET /api/agentwatch', () => {
  test('refuses an unidentified caller', async () => {
    const { app } = makeApp();

    const response = await getAgentwatch(app);

    expect(response.status).toBe(401);
    expect(response.json).toEqual({ ok: false, error: 'not_identified' });
    expect(mocks.fetchAgentwatchSnapshot).not.toHaveBeenCalled();
  });

  test('refuses a token that does not verify', async () => {
    const { app } = makeApp();

    const response = await getAgentwatch(app, {
      authorization: 'Bearer fdsa_not-a-real-token'
    });

    expect(response.status).toBe(401);
  });

  test('serves the snapshot to an agent token', async () => {
    const { app, token } = makeApp();

    const response = await getAgentwatch(app, {
      authorization: `Bearer ${token}`
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.json).toEqual({
      ok: true,
      actor: 'watcher',
      snapshot: SNAPSHOT
    });
    const [, inputs] = mocks.fetchAgentwatchSnapshot.mock.calls[0];
    expect(Array.isArray(inputs.flares)).toBe(true);
    expect(Array.isArray(inputs.runtime_presence)).toBe(true);
    expect(inputs.roster.map((/** @type {any} */ a) => a.actor)).toContain(
      'watcher'
    );
    expect(inputs.presence_errors).toEqual([]);
    expect(inputs.aliases).toBeNull();
  });

  test('answers 503 when the Postgres data layer is not configured', async () => {
    mocks.getPgStore.mockReturnValue(null);
    const { app, token } = makeApp();

    const response = await getAgentwatch(app, {
      authorization: `Bearer ${token}`
    });

    expect(response.status).toBe(503);
    expect(response.json).toEqual({ ok: false, error: 'pg_unavailable' });
  });

  test('answers 500 with the error code when the snapshot query fails', async () => {
    mocks.fetchAgentwatchSnapshot.mockRejectedValue(
      Object.assign(new Error('boom'), { code: '57014' })
    );
    const { app, token } = makeApp();

    const response = await getAgentwatch(app, {
      authorization: `Bearer ${token}`
    });

    expect(response.status).toBe(500);
    expect(response.json.ok).toBe(false);
    expect(typeof response.json.error).toBe('string');
  });
});

describe('scopeAgentwatchSnapshot', () => {
  test('passes the snapshot through when no scope applies', () => {
    expect(scopeAgentwatchSnapshot(SNAPSHOT, null)).toBe(SNAPSHOT);
  });

  test('keeps only visible actors and readable boards, and recounts', () => {
    const scoped = scopeAgentwatchSnapshot(SNAPSHOT, {
      boards: new Set(['main']),
      actors: new Set(['alice'])
    });

    expect(scoped.agents).toEqual([
      {
        actor: 'alice',
        item_count: 1,
        flare: { board_id: 'main', issue_id: 'main-1' },
        issues: [{ id: 'main-1', board_id: 'main' }]
      }
    ]);
    expect(scoped.discussions).toEqual([
      { issue_id: 'main-1', board_id: 'main' }
    ]);
    expect(scoped.stats).toEqual({
      active_agents: 2,
      registered_agents: 1,
      active_issues: 1,
      shared_discussions: 1
    });
  });

  test('recounts uncapped board counts and visible aliases for the viewer', () => {
    const snapshot = {
      ...SNAPSHOT,
      agents: [
        {
          actor: 'alice',
          item_count: 312,
          board_item_counts: { main: 300, secret: 12 },
          aliases: ['alice-laptop', 'alice-hidden'],
          flare: null,
          issues: [
            { id: 'main-1', board_id: 'main' },
            { id: 'secret-1', board_id: 'secret' }
          ]
        }
      ]
    };

    const scoped = scopeAgentwatchSnapshot(snapshot, {
      boards: new Set(['main']),
      actors: new Set(['alice', 'alice-laptop'])
    });

    expect(scoped.agents[0]).toMatchObject({
      item_count: 300,
      board_item_counts: { main: 300 },
      aliases: ['alice-laptop'],
      issues: [{ id: 'main-1', board_id: 'main' }]
    });
    expect(scoped.stats.active_issues).toBe(300);
  });

  test('drops a flare on a board the viewer cannot read', () => {
    const scoped = scopeAgentwatchSnapshot(SNAPSHOT, {
      boards: new Set(['other']),
      actors: null
    });

    expect(scoped.agents.map((/** @type {any} */ a) => a.flare)).toEqual([
      null,
      null
    ]);
    expect(scoped.stats.active_issues).toBe(0);
  });
});
