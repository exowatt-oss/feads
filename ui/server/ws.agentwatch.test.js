import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchAgentwatchSnapshot: vi.fn(),
  getPgStore: vi.fn(),
  pgListeners: /** @type {Array<(event: any) => void>} */ ([]),
  pgStore: {},
  resolveIdentity: vi.fn(),
  decideFor: vi.fn(),
  listFlares: vi.fn(),
  listRuntimePresence: vi.fn(),
  listAgents: vi.fn(),
  openRegistry: vi.fn()
}));

vi.mock('./agentwatch.js', () => ({
  fetchAgentwatchSnapshot: mocks.fetchAgentwatchSnapshot
}));

vi.mock('../../boards/flares.mjs', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, listFlares: mocks.listFlares };
});

vi.mock('../../boards/registry.mjs', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, openRegistry: mocks.openRegistry };
});

vi.mock('../../boards/runtime-presence.mjs', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, listRuntimePresence: mocks.listRuntimePresence };
});

vi.mock('../../boards/agents.mjs', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, listAgents: mocks.listAgents };
});

vi.mock('./pg-store.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    getPgStore: mocks.getPgStore,
    onPgEvent: vi.fn((fn) => {
      mocks.pgListeners.push(fn);
      return () => {
        const index = mocks.pgListeners.indexOf(fn);
        if (index >= 0) {
          mocks.pgListeners.splice(index, 1);
        }
      };
    })
  };
});

vi.mock('./identity.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    resolveIdentity: mocks.resolveIdentity,
    decideFor: mocks.decideFor
  };
});

const {
  attachWsServer,
  handleMessage,
  nudgeAgentwatchRefresh,
  resetAgentwatchForTests
} = await import('./ws.js');

class StubSocket extends EventEmitter {
  constructor() {
    super();
    /** @type {string[]} */
    this.sent = [];
    this.readyState = 1;
    this.OPEN = 1;
  }

  /** @param {string} message */
  send(message) {
    this.sent.push(String(message));
  }

  ping() {}
}

/**
 * @param {any} ws
 * @param {string} type
 * @param {unknown} [payload]
 * @returns {Promise<any>}
 */
async function request(ws, type, payload = {}) {
  await handleMessage(
    ws,
    Buffer.from(JSON.stringify({ id: `request-${type}`, type, payload }))
  );
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

/** @returns {void} */
function notifyPg() {
  const listener = mocks.pgListeners[0];
  if (!listener) {
    throw new Error('Expected ws to register a Postgres event listener');
  }
  listener({ board_id: 'board-1', issue_id: 'issue-1', kind: 'update' });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAgentwatchForTests();
  mocks.pgListeners.length = 1;
  mocks.getPgStore.mockReset();
  mocks.getPgStore.mockReturnValue(mocks.pgStore);
  mocks.fetchAgentwatchSnapshot.mockReset();
  mocks.fetchAgentwatchSnapshot.mockResolvedValue({ agents: ['initial'] });
  mocks.openRegistry.mockReset();
  mocks.openRegistry.mockReturnValue({ close: vi.fn() });
  mocks.listFlares.mockReset();
  mocks.listFlares.mockReturnValue([]);
  mocks.listRuntimePresence.mockReset();
  mocks.listRuntimePresence.mockReturnValue([]);
  mocks.listAgents.mockReset();
  mocks.listAgents.mockReturnValue([]);
  mocks.resolveIdentity.mockReset();
  mocks.resolveIdentity.mockResolvedValue({
    identity: null,
    agent: null,
    mode: 'operator',
    stance: 'operator',
    require_identity: false,
    credential_rejected: false
  });
  mocks.decideFor.mockReset();
  mocks.decideFor.mockResolvedValue({
    allowed: true,
    reason: 'allowed',
    mode: 'operator'
  });
});

afterEach(() => {
  resetAgentwatchForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Agentwatch WebSocket protocol', () => {
  test('watches with an initial snapshot and unwatches idempotently', async () => {
    const ws = new StubSocket();
    const snapshot = { agents: [{ id: 'agent-1', status: 'working' }] };
    const flares = [{ actor: 'scout', issue_id: 'fd-7', liveness: 'live' }];
    const runtime_presence = [{ actor: 'runtime-owner', runtime_id: 'r1' }];
    const roster = [{ actor: 'registered-quiet', kind: 'agent' }];
    mocks.fetchAgentwatchSnapshot.mockResolvedValue(snapshot);
    mocks.listFlares.mockReturnValue(flares);
    mocks.listRuntimePresence.mockReturnValue(runtime_presence);
    mocks.listAgents.mockReturnValue(roster);

    const watched = await request(ws, 'watch-agentwatch');

    expect(watched.ok).toBe(true);
    expect(watched.payload).toEqual(snapshot);
    expect(mocks.fetchAgentwatchSnapshot).toHaveBeenCalledWith(mocks.pgStore, {
      flares,
      runtime_presence,
      roster,
      presence_errors: [],
      aliases: null
    });

    const unwatched = await request(ws, 'unwatch-agentwatch');

    expect(unwatched.ok).toBe(true);
    expect(unwatched.payload).toEqual({ watching: false });
  });

  test('returns a Postgres configuration error without fetching', async () => {
    mocks.getPgStore.mockReturnValue(null);
    const ws = new StubSocket();

    const reply = await request(ws, 'watch-agentwatch');

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('pg_error');
    expect(mocks.fetchAgentwatchSnapshot).not.toHaveBeenCalled();
  });

  test('applies the existing read authorization gate before watching', async () => {
    mocks.decideFor.mockResolvedValue({
      allowed: false,
      reason: 'agent required',
      mode: 'rejected'
    });
    const ws = new StubSocket();

    const reply = await request(ws, 'watch-agentwatch');

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('forbidden');
    expect(mocks.fetchAgentwatchSnapshot).not.toHaveBeenCalled();
  });

  test('coalesces Postgres events into one query shared by all watchers', async () => {
    const a = new StubSocket();
    const b = new StubSocket();
    await request(a, 'watch-agentwatch');
    await request(b, 'watch-agentwatch');
    mocks.fetchAgentwatchSnapshot.mockClear();
    mocks.fetchAgentwatchSnapshot.mockResolvedValue({ agents: ['updated'] });

    notifyPg();
    notifyPg();
    notifyPg();
    await vi.advanceTimersByTimeAsync(199);

    expect(mocks.fetchAgentwatchSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.fetchAgentwatchSnapshot).toHaveBeenCalledTimes(1);
    for (const ws of [a, b]) {
      const events = ws.sent
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === 'agentwatch');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ agents: ['updated'] });
    }
  });

  test('refreshes on a heartbeat cadence while watched, then retires', async () => {
    const ws = new StubSocket();
    await request(ws, 'watch-agentwatch');
    mocks.fetchAgentwatchSnapshot.mockClear();
    mocks.fetchAgentwatchSnapshot.mockResolvedValue({ agents: ['beat'] });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.fetchAgentwatchSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.fetchAgentwatchSnapshot).toHaveBeenCalledTimes(2);

    const events = ws.sent
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === 'agentwatch');
    expect(events).toHaveLength(2);

    await request(ws, 'unwatch-agentwatch');
    mocks.fetchAgentwatchSnapshot.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.fetchAgentwatchSnapshot).not.toHaveBeenCalled();
  });

  test('fails open on runtime registry errors and coalesces one shared nudge', async () => {
    const a = new StubSocket();
    const b = new StubSocket();
    mocks.listRuntimePresence.mockImplementation(() => {
      throw new Error('registry unavailable');
    });
    await request(a, 'watch-agentwatch');
    await request(b, 'watch-agentwatch');
    mocks.fetchAgentwatchSnapshot.mockClear();
    mocks.fetchAgentwatchSnapshot.mockResolvedValue({
      agents: ['runtime-safe']
    });
    nudgeAgentwatchRefresh();
    nudgeAgentwatchRefresh();
    nudgeAgentwatchRefresh();
    await vi.advanceTimersByTimeAsync(199);
    expect(mocks.fetchAgentwatchSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.fetchAgentwatchSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAgentwatchSnapshot).toHaveBeenCalledWith(mocks.pgStore, {
      flares: [],
      runtime_presence: [],
      roster: [],
      presence_errors: [],
      aliases: null
    });
    for (const ws of [a, b]) {
      const events = ws.sent
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === 'agentwatch');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ agents: ['runtime-safe'] });
    }
  });

  test('removes a watcher when its socket disconnects', async () => {
    const attached = attachWsServer(createServer(), {
      heartbeat_ms: 10_000
    });
    const ws = new StubSocket();
    attached.wss.clients.add(/** @type {any} */ (ws));
    attached.wss.emit('connection', /** @type {any} */ (ws), {
      headers: {}
    });

    await request(ws, 'watch-agentwatch');
    mocks.fetchAgentwatchSnapshot.mockClear();
    attached.wss.clients.delete(/** @type {any} */ (ws));
    ws.emit('close');

    notifyPg();
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.fetchAgentwatchSnapshot).not.toHaveBeenCalled();
    attached.wss.close();
  });
});
