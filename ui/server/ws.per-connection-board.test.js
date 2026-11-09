/**
 * feads addition — ex-dh0: board selection is per connection.
 *
 * The defect this file exists for: the dashboard's board used to be a property of
 * the *daemon*, so an anonymous browser tab calling `set-board` moved the board out
 * from under a logged-in agent's tab. That tab's next read or write silently went to
 * a different database, and its `whoami` and roster silently described a different
 * board. Nothing on either screen said so.
 *
 * Gating the switcher would have been the wrong fix — the browser's `read_only`
 * stance grants reading *every* board, so refusing `set-board` would have cut that
 * down to whichever board the daemon started on. So these tests assert isolation,
 * not refusal: the anonymous connection is *allowed* to switch, and switching
 * changes nothing for anybody else.
 *
 * Everything here is asserted through the wire and through the `bd` invocations,
 * never through `ws.js`'s private per-board maps. That is deliberate: the routing is
 * the thing under test, so a test that read the map would be asserting the
 * bookkeeping rather than the behaviour it is supposed to produce.
 *
 * `decideFor` is deliberately left real (see `test/stub-identity.js`), so the gates
 * these tests drive through are the real policy over a stated identity. Only
 * resolution and the roster are pinned, because whether the machine running this has
 * a `~/.feads/registry.db` must not decide the outcome.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vitest';
import { toAgentRow } from '../test/fake-agent-registry.js';
import { agentResolution, anonymousResolution } from '../test/stub-identity.js';
import { getConnectionBoardDir } from './active-board.js';
import { AGENT_TOKEN_COOKIE } from './agent-cookie.js';
import { runBd, runBdJson } from './bd.js';
import { listRoster, resolveIdentity } from './identity.js';
import { fetchListForSubscription } from './list-adapters.js';
import { attachWsServer, handleMessage, scheduleListRefresh } from './ws.js';

vi.mock('./bd.js', () => ({
  runBd: vi.fn(),
  runBdJson: vi.fn(),
  getGitUserName: vi.fn(async () => '')
}));

vi.mock('./list-adapters.js', () => ({
  fetchListForSubscription: vi.fn()
}));

vi.mock('./identity.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    resolveIdentity: vi.fn(),
    listRoster: vi.fn()
  };
});

const AGENT_TOKEN = 'fdsa_the_identified_tab';
const AGENT_ROW = toAgentRow({
  id: 'ag_alpha',
  actor: 'alpha-claude',
  role: 'user',
  board_id: 'alpha'
});

/** @type {string} */
let scratch;
/** @type {string} */
let alpha_root;
/** @type {string} */
let bravo_root;
/** @type {string} */
let loose_root;
/** @type {string | undefined} */
let prev_registry_db;
/** @type {ReturnType<typeof attachWsServer>} */
let attached;
/** @type {Array<{ board: any, closed: boolean }>} */
let watchers_created;

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

/**
 * @param {string} root
 * @returns {string}
 */
function beadsOf(root) {
  return path.join(root, '.beads');
}

/**
 * A socket that can also be closed, because half of what is asserted here happens
 * in the `close` handler. An `EventEmitter` rather than a plain object so
 * `wss.emit('connection', …)` wires up the real handlers instead of approximating
 * them.
 *
 * `readyState` deliberately stays `OPEN` after `close` is emitted. A closed socket
 * that is still in a subscriber set would otherwise be skipped by the
 * `readyState !== OPEN` guard in `refreshAndPublish`, and a missing sweep would look
 * like a passing test.
 */
class StubSocket extends EventEmitter {
  /**
   * @param {{ token?: string }} [options]
   */
  constructor(options = {}) {
    super();
    /** @type {string[]} */
    this.sent = [];
    this.readyState = 1;
    this.OPEN = 1;
    this.token = options.token || '';
  }

  /**
   * @param {string} msg
   */
  send(msg) {
    this.sent.push(String(msg));
  }

  ping() {}

  terminate() {}

  /**
   * The upgrade request this socket would have arrived with.
   *
   * @returns {{ headers: Record<string, string> }}
   */
  request() {
    return {
      headers: this.token
        ? { cookie: `${AGENT_TOKEN_COOKIE}=${this.token}` }
        : {}
    };
  }

  /**
   * @returns {any[]}
   */
  events() {
    return this.sent.map((m) => JSON.parse(m));
  }
}

/**
 * Bring a connection up the way the server does, so credential binding, the seed
 * watcher retain and the close handler are all the real ones.
 *
 * @param {{ token?: string }} [options]
 * @returns {StubSocket}
 */
function connect(options = {}) {
  const ws = new StubSocket(options);
  attached.wss.clients.add(/** @type {any} */ (ws));
  attached.wss.emit('connection', /** @type {any} */ (ws), ws.request());
  return ws;
}

/**
 * @param {StubSocket} ws
 */
function disconnect(ws) {
  attached.wss.clients.delete(/** @type {any} */ (ws));
  ws.emit('close');
}

/**
 * @param {StubSocket} ws
 * @param {string} type
 * @param {unknown} payload
 * @returns {Promise<any>}
 */
async function on(ws, type, payload) {
  await handleMessage(
    /** @type {any} */ (ws),
    Buffer.from(JSON.stringify({ id: `t-${type}`, type, payload }))
  );
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

/**
 * Let fire-and-forget work settle. A board switch re-snapshots the connection's
 * subscriptions without awaiting, on purpose (see `migrateConnectionSubscriptions`),
 * so a test that wants to see the result has to give the queue a turn.
 *
 * @returns {Promise<void>}
 */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Wait out the refresh debounce and let everything it started finish.
 *
 * Needed after setup as well as after a deliberate refresh: a board switch schedules
 * a refresh of its own, and the mocked `bd` resolves in a microtask, so those timers
 * are still pending when the setup awaits return. Without draining them first, an
 * assertion about "which board was read" would see the setup's refreshes too.
 *
 * @returns {Promise<void>}
 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await flush();
}

/**
 * Run the debounced refresh a board's watcher would have scheduled, and wait for it.
 *
 * @param {string} board_key
 * @returns {Promise<void>}
 */
async function refresh(board_key) {
  scheduleListRefresh(board_key);
  await settle();
}

/**
 * The options `bd` was last invoked with.
 *
 * @returns {{ cwd?: string, board_dir?: string | null }}
 */
function lastBdOptions() {
  const run = /** @type {import('vitest').Mock} */ (runBd);
  const run_json = /** @type {import('vitest').Mock} */ (runBdJson);
  const calls = [...run.mock.calls, ...run_json.mock.calls];
  return calls[calls.length - 1]?.[1] || {};
}

/**
 * Every board `fetchListForSubscription` was asked about since the last clear.
 *
 * @returns {string[]}
 */
function fetchedBoards() {
  return /** @type {import('vitest').Mock} */ (
    fetchListForSubscription
  ).mock.calls.map((call) => String(call[1]?.board_dir || ''));
}

beforeAll(async () => {
  scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'feads-per-conn-'))
  );
  alpha_root = makeBoard('alpha');
  bravo_root = makeBoard('bravo');
  loose_root = makeBoard('loose');

  prev_registry_db = process.env.FEADS_REGISTRY_DB;
  process.env.FEADS_REGISTRY_DB = path.join(scratch, 'registry.db');

  const board_registry = await import('../../boards/registry.mjs');
  const db = board_registry.openRegistry();
  try {
    board_registry.upsertBoard(db, {
      id: 'alpha',
      name: 'Alpha Board',
      board_dir: beadsOf(alpha_root),
      workspace_dir: alpha_root
    });
    board_registry.upsertBoard(db, {
      id: 'bravo',
      name: 'Bravo Board',
      board_dir: beadsOf(bravo_root),
      workspace_dir: bravo_root
    });
  } finally {
    db.close();
  }

  watchers_created = [];
  attached = attachWsServer(createServer(), {
    path: '/ws',
    heartbeat_ms: 100000,
    refresh_debounce_ms: 5,
    root_dir: scratch,
    // Never a real `fs.watch` in a test: its handle is `persistent: true`, so a
    // leaked one shows up as a suite that will not exit rather than as a failure.
    create_watcher: (board) => {
      /** @type {{ board: any, closed: boolean, close: () => void }} */
      const entry = {
        board,
        closed: false,
        close() {
          entry.closed = true;
        }
      };
      watchers_created.push(entry);
      return entry;
    }
  });
});

afterAll(() => {
  attached?.watchers.closeAll();
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
  vi.clearAllMocks();
  /** @type {import('vitest').Mock} */ (resolveIdentity).mockImplementation(
    async (options = {}) =>
      String(options.token || '') === AGENT_TOKEN
        ? agentResolution(AGENT_ROW)
        : anonymousResolution()
  );
  /** @type {import('vitest').Mock} */ (listRoster).mockImplementation(
    async (options = {}) => ({
      allowed: true,
      reason: 'stub',
      scope: 'all',
      board_id: String(options.board_id || ''),
      agents: [],
      mode: 'operator',
      stance: 'operator',
      require_identity: false,
      credential_rejected: false
    })
  );
  /** @type {import('vitest').Mock} */ (runBd).mockResolvedValue({
    code: 0,
    stdout: '',
    stderr: ''
  });
  /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
    code: 0,
    stdoutJson: []
  });
  // One issue per board, named after it, so a snapshot that came from the wrong
  // board is visible in the assertion rather than merely absent.
  /** @type {import('vitest').Mock} */ (
    fetchListForSubscription
  ).mockImplementation(async (_spec, options = {}) => ({
    ok: true,
    items: [
      {
        id: `issue-on-${path.basename(
          path.dirname(String(options.board_dir || 'nowhere'))
        )}`,
        updated_at: Date.now(),
        closed_at: null
      }
    ]
  }));
});

afterEach(() => {
  for (const client of Array.from(attached.wss.clients)) {
    disconnect(/** @type {any} */ (client));
  }
});

describe('one connection switching boards does not move another', () => {
  test("the identified tab's board, reads and whoami survive an anonymous switch", async () => {
    const identified = connect({ token: AGENT_TOKEN });
    const anonymous = connect();

    await on(identified, 'set-board', { id: 'alpha' });
    const switched = await on(anonymous, 'set-board', { id: 'bravo' });
    // The anonymous tab is *allowed* to switch — that is the point. Refusing it
    // would silently reduce "read-only may read every board" to one board.
    expect(switched.ok).toBe(true);
    expect(switched.payload.workspace.board_id).toBe('bravo');

    // 1. Its binding.
    expect(getConnectionBoardDir(identified)).toBe(beadsOf(alpha_root));
    expect(getConnectionBoardDir(anonymous)).toBe(beadsOf(bravo_root));

    // 2. Its reads. This is the assertion that would have caught the defect: the
    // `bd` child carries the board, and it has to be the caller's.
    /** @type {import('vitest').Mock} */ (runBdJson).mockClear();
    await on(identified, 'get-comments', { id: 'ex-1' });
    expect(lastBdOptions()).toMatchObject({
      cwd: alpha_root,
      board_dir: beadsOf(alpha_root)
    });

    // 3. Its writes.
    /** @type {import('vitest').Mock} */ (runBd).mockClear();
    await on(identified, 'update-status', { id: 'ex-1', status: 'closed' });
    expect(
      /** @type {import('vitest').Mock} */ (runBd).mock.calls[0][1]
    ).toMatchObject({
      cwd: alpha_root,
      board_dir: beadsOf(alpha_root)
    });

    // 4. Its whoami. The roster is board-scoped, so resolution has to be asked
    // about the board this connection is on.
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockClear();
    const who = await on(identified, 'whoami', {});
    expect(who.ok).toBe(true);
    expect(who.payload.identity.actor).toBe('alpha-claude');
    expect(
      /** @type {import('vitest').Mock} */ (resolveIdentity).mock.calls[0][0]
    ).toMatchObject({ board_id: 'alpha' });
  });

  test('the anonymous tab reads its own board, not the identified one', async () => {
    // The mirror image, so the test cannot pass by pinning everything to alpha.
    const identified = connect({ token: AGENT_TOKEN });
    const anonymous = connect();
    await on(identified, 'set-board', { id: 'alpha' });
    await on(anonymous, 'set-board', { id: 'bravo' });

    /** @type {import('vitest').Mock} */ (runBdJson).mockClear();
    await on(anonymous, 'get-comments', { id: 'ex-2' });
    expect(lastBdOptions()).toMatchObject({
      cwd: bravo_root,
      board_dir: beadsOf(bravo_root)
    });
  });

  test('get-workspace answers each connection with its own board', async () => {
    const identified = connect({ token: AGENT_TOKEN });
    const anonymous = connect();
    await on(identified, 'set-board', { id: 'alpha' });
    await on(anonymous, 'set-board', { id: 'bravo' });

    expect((await on(identified, 'get-workspace', {})).payload.board_id).toBe(
      'alpha'
    );
    expect((await on(anonymous, 'get-workspace', {})).payload.board_id).toBe(
      'bravo'
    );
  });

  test('list-workspaces marks each connection its own current board', async () => {
    const identified = connect({ token: AGENT_TOKEN });
    const anonymous = connect();
    await on(identified, 'set-board', { id: 'alpha' });
    await on(anonymous, 'set-board', { id: 'bravo' });

    const mine = await on(identified, 'list-workspaces', {});
    expect(mine.payload.current.board_id).toBe('alpha');
    const theirs = await on(anonymous, 'list-workspaces', {});
    expect(theirs.payload.current.board_id).toBe('bravo');
  });

  test('list-agents is scoped to the asking connection', async () => {
    const identified = connect({ token: AGENT_TOKEN });
    const anonymous = connect();
    await on(identified, 'set-board', { id: 'alpha' });
    await on(anonymous, 'set-board', { id: 'bravo' });

    const mine = await on(identified, 'list-agents', {});
    expect(mine.payload.board_id).toBe('alpha');
    const theirs = await on(anonymous, 'list-agents', {});
    expect(theirs.payload.board_id).toBe('bravo');
  });

  test('an unregistered board reports an empty board id, never a stale one', async () => {
    // The related bug this must not resurrect: `listAgents` treats a falsy board_id
    // as "no filter" and would return every agent on every board. Per-connection
    // selection makes that easy to reintroduce by "helpfully" substituting some other
    // board's id, so assert the empty string reaches `listRoster` unchanged.
    const ws = connect({ token: AGENT_TOKEN });
    await on(ws, 'set-board', { board_dir: beadsOf(loose_root) });

    const reply = await on(ws, 'list-agents', {});
    expect(reply.payload.board_id).toBe('');
    expect(
      /** @type {import('vitest').Mock} */ (listRoster).mock.calls[0][0]
    ).toMatchObject({ board_id: '' });
  });

  test('a board switch is announced only to the connection that asked', async () => {
    const identified = connect({ token: AGENT_TOKEN });
    await on(identified, 'set-board', { id: 'alpha' });
    const anonymous = connect();
    identified.sent = [];

    await on(anonymous, 'set-board', { id: 'bravo' });

    expect(
      identified.events().filter((e) => e.type === 'workspace-changed')
    ).toEqual([]);
    const announced = anonymous
      .events()
      .filter((e) => e.type === 'workspace-changed');
    expect(announced).toHaveLength(1);
    expect(announced[0].payload.board_id).toBe('bravo');
  });
});

describe('list subscriptions are per board', () => {
  test('two connections on two boards each get their own board rows', async () => {
    const identified = connect({ token: AGENT_TOKEN });
    const anonymous = connect();
    await on(identified, 'set-board', { id: 'alpha' });
    await on(anonymous, 'set-board', { id: 'bravo' });

    await on(identified, 'subscribe-list', { id: 'c1', type: 'all-issues' });
    await on(anonymous, 'subscribe-list', { id: 'c2', type: 'all-issues' });

    const mine = identified.events().find((e) => e.type === 'snapshot');
    const theirs = anonymous.events().find((e) => e.type === 'snapshot');
    expect(mine.payload.issues.map((/** @type {any} */ i) => i.id)).toEqual([
      'issue-on-alpha'
    ]);
    expect(theirs.payload.issues.map((/** @type {any} */ i) => i.id)).toEqual([
      'issue-on-bravo'
    ]);
  });

  test('a refresh on one board reads and publishes to that board only', async () => {
    const identified = connect({ token: AGENT_TOKEN });
    const anonymous = connect();
    await on(identified, 'set-board', { id: 'alpha' });
    await on(anonymous, 'set-board', { id: 'bravo' });
    await on(identified, 'subscribe-list', { id: 'c1', type: 'all-issues' });
    await on(anonymous, 'subscribe-list', { id: 'c2', type: 'all-issues' });
    await settle();
    identified.sent = [];
    anonymous.sent = [];
    /** @type {import('vitest').Mock} */ (fetchListForSubscription).mockClear();

    // What alpha's watcher does when alpha's files change.
    await refresh(beadsOf(alpha_root));

    expect(fetchedBoards()).toEqual([beadsOf(alpha_root)]);
    // The bravo tab hears nothing at all — not an upsert, not a delete, not a
    // snapshot. Cross-talk here is what a shared subscription cache produced.
    expect(anonymous.sent).toEqual([]);
    expect(identified.sent.length).toBeGreaterThan(0);
  });

  test('the same list on two boards does not diff one against the other', async () => {
    // With a shared cache, refreshing board A would compute a delta against board
    // B's rows and emit deletes for issues that never left.
    const identified = connect({ token: AGENT_TOKEN });
    const anonymous = connect();
    await on(identified, 'set-board', { id: 'alpha' });
    await on(anonymous, 'set-board', { id: 'bravo' });
    await on(identified, 'subscribe-list', { id: 'c1', type: 'all-issues' });
    await on(anonymous, 'subscribe-list', { id: 'c2', type: 'all-issues' });
    identified.sent = [];
    anonymous.sent = [];

    await refresh(beadsOf(alpha_root));
    await refresh(beadsOf(bravo_root));

    const deletes = [...identified.events(), ...anonymous.events()].filter(
      (e) => e.type === 'delete'
    );
    expect(deletes).toEqual([]);
  });

  test('switching boards moves the connection subscriptions with it', async () => {
    // A second tab stays on alpha so alpha keeps having active subscriptions after
    // the first one leaves — otherwise "alpha sends nothing" would be true for the
    // uninteresting reason that nothing on alpha is being refreshed at all.
    const keeper = connect({ token: AGENT_TOKEN });
    const mover = connect({ token: AGENT_TOKEN });
    await on(keeper, 'set-board', { id: 'alpha' });
    await on(mover, 'set-board', { id: 'alpha' });
    await on(keeper, 'subscribe-list', { id: 'k1', type: 'all-issues' });
    await on(mover, 'subscribe-list', { id: 'm1', type: 'all-issues' });

    await on(mover, 'set-board', { id: 'bravo' });
    await settle();
    // The move re-snapshots the list on the new board, so the connection is not
    // left showing the old board's rows until the next change.
    const resnapshot = mover
      .events()
      .filter((e) => e.type === 'snapshot')
      .pop();
    expect(resnapshot.payload.issues[0].id).toBe('issue-on-bravo');

    keeper.sent = [];
    mover.sent = [];
    await refresh(beadsOf(alpha_root));
    // Left the board it is no longer looking at…
    expect(mover.sent).toEqual([]);
    expect(keeper.sent.length).toBeGreaterThan(0);

    keeper.sent = [];
    mover.sent = [];
    await refresh(beadsOf(bravo_root));
    // …and is refreshed on the one it is.
    expect(mover.sent.length).toBeGreaterThan(0);
    expect(keeper.sent).toEqual([]);
  });

  test('a mutation on one board does not swallow another board refresh', async () => {
    // The mutation window used to be global: a write on board A suppressed board B's
    // watcher refresh for up to half a second and then refreshed B as a side effect.
    const identified = connect({ token: AGENT_TOKEN });
    const anonymous = connect();
    await on(identified, 'set-board', { id: 'alpha' });
    await on(anonymous, 'set-board', { id: 'bravo' });
    await on(identified, 'subscribe-list', { id: 'c1', type: 'all-issues' });
    await on(anonymous, 'subscribe-list', { id: 'c2', type: 'all-issues' });

    // A write on alpha opens alpha's mutation gate.
    await on(identified, 'create-issue', { title: 'on alpha' });
    /** @type {import('vitest').Mock} */ (fetchListForSubscription).mockClear();

    // bravo's watcher fires. It must not be absorbed by alpha's gate.
    await refresh(beadsOf(bravo_root));
    expect(fetchedBoards()).toContain(beadsOf(bravo_root));
  });
});

describe('a closing connection lets go of everything', () => {
  test('the last connection on a board closes its watcher', async () => {
    const before = attached.watchers.size();
    const a = connect({ token: AGENT_TOKEN });
    const b = connect();
    await on(a, 'set-board', { id: 'alpha' });
    await on(b, 'set-board', { id: 'alpha' });
    expect(attached.watchers.holderCount(beadsOf(alpha_root))).toBe(2);

    disconnect(a);
    // Still one tab on alpha, so the watcher stays — a watcher per *connection*
    // would have opened two handles on the same directory and closed one too early.
    expect(attached.watchers.holderCount(beadsOf(alpha_root))).toBe(1);

    disconnect(b);
    expect(attached.watchers.holderCount(beadsOf(alpha_root))).toBe(0);
    expect(attached.watchers.size()).toBe(before);
  });

  test('no watcher outlives the connections that wanted it', async () => {
    const before = attached.watchers.size();
    const created_before = watchers_created.length;
    const a = connect({ token: AGENT_TOKEN });
    const b = connect();
    await on(a, 'set-board', { id: 'alpha' });
    await on(b, 'set-board', { id: 'bravo' });
    // Then both move on, so the pool has churned rather than only grown.
    await on(a, 'set-board', { id: 'bravo' });
    await on(b, 'set-board', { id: 'alpha' });

    disconnect(a);
    disconnect(b);

    expect(attached.watchers.size()).toBe(before);
    const opened = watchers_created.slice(created_before);
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((w) => w.closed)).toBe(true);
  });

  test('a closed connection is dropped from every board it was ever on', async () => {
    const keeper = connect({ token: AGENT_TOKEN });
    const leaver = connect({ token: AGENT_TOKEN });
    await on(keeper, 'set-board', { id: 'alpha' });
    await on(leaver, 'set-board', { id: 'alpha' });
    await on(keeper, 'subscribe-list', { id: 'k1', type: 'all-issues' });
    await on(leaver, 'subscribe-list', { id: 'l1', type: 'all-issues' });
    // Move it to bravo, so it has been a subscriber of two boards' registries. A
    // sweep of only its current board would leave it in alpha's.
    await on(leaver, 'set-board', { id: 'bravo' });
    await flush();

    disconnect(leaver);
    keeper.sent = [];
    leaver.sent = [];

    await refresh(beadsOf(alpha_root));
    await refresh(beadsOf(bravo_root));

    // `readyState` is still OPEN on the stub, so a socket left in a subscriber set
    // would genuinely be written to here.
    expect(leaver.sent).toEqual([]);
    expect(keeper.sent.length).toBeGreaterThan(0);
    // Its board binding goes too, so it reads through to the seed if anything holds
    // a reference to it again.
    expect(getConnectionBoardDir(leaver)).not.toBe(beadsOf(bravo_root));
  });
});
