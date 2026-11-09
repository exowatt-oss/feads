/**
 * The browser's bd children act as the signed-in agent (#feads-tb5).
 *
 * The dashboard resolves a per-connection identity and authorizes every write against
 * it — but in bd mode the child process inherited the *daemon's* `BEADS_ACTOR`, which
 * comes from whatever shell launched it. So a bead filed from a signed-in browser was
 * authorized as the agent and recorded as the host: two records of one fact,
 * disagreeing, with the audit trail holding the wrong one.
 *
 * These are about the stamp, not about bd: `runBd` is the real module here so the
 * thunk `ws.js` hands it is really resolved, while `spawn` is stubbed so nothing runs.
 * (`ws.mutations.test.js` mocks bd.js wholesale and therefore cannot see this.)
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { handleMessage } from './ws.js';

/** @type {{ env: Record<string, string> }[]} */
const spawned = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_bin, _args, opts) => {
    spawned.push({ env: opts.env });
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
      stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
      kill() {}
    });
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  })
}));

// The identity this connection resolves to. Set per test, read by the stub below.
/** @type {any} */
let resolution;

vi.mock('./identity.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    resolveIdentity: vi.fn(async () => resolution)
  };
});

// pg mode has its own attribution path (`runPgOp`), already correct. This suite is
// about the bd path, so make sure that is the one under test.
vi.mock('./pg-store.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, getPgStore: () => null };
});

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
 * @param {any} ws - The stub socket.
 * @param {any} req - The request envelope.
 * @returns {Promise<void>}
 */
const send = (ws, req) => handleMessage(ws, Buffer.from(JSON.stringify(req)));

/**
 * @param {string} actor - The connection's registered handle.
 * @returns {any}
 */
const agentResolution = (actor) => ({
  identity: { agent_id: 'ag_1', actor, display_name: actor, role: 'user' },
  agent: { id: 'ag_1', actor, role: 'user' },
  mode: 'agent',
  stance: 'read_only',
  require_identity: false,
  credential_rejected: false,
  via: 'token'
});

beforeEach(() => {
  spawned.length = 0;
  resolution = agentResolution('mira-example');
});

describe('bd children act as the connection identity', () => {
  test('a create from a signed-in browser stamps that agent, not the daemon', async () => {
    process.env.BEADS_ACTOR = 'feads-daemon-launcher';
    const ws = makeStubSocket();

    await send(ws, {
      id: 'r1',
      type: 'create-issue',
      payload: { title: 'Filed from the browser' }
    });

    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned[0].env.BEADS_ACTOR).toBe('mira-example');
    delete process.env.BEADS_ACTOR;
  });

  test('a comment is authored by the same agent that was authorized', async () => {
    const ws = makeStubSocket();

    await send(ws, {
      id: 'r2',
      type: 'add-comment',
      payload: { id: 'UI-7', text: 'a note' }
    });

    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned[0].env.BEADS_ACTOR).toBe('mira-example');
  });

  test('an anonymous connection leaves bd its own resolution rather than blanking it', async () => {
    /* An empty actor is not the same claim as "attributed to nobody": an anonymous
       browser cannot write anyway, and forcing BEADS_ACTOR='' on the reads it *can*
       do would be a regression against a bug nobody has. */
    process.env.BEADS_ACTOR = 'feads-daemon-launcher';
    resolution = {
      identity: null,
      agent: null,
      mode: 'operator',
      stance: 'operator',
      require_identity: false,
      credential_rejected: false,
      via: 'none'
    };
    const ws = makeStubSocket();

    await send(ws, {
      id: 'r3',
      type: 'create-issue',
      payload: { title: 'Local operator' }
    });

    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned[0].env.BEADS_ACTOR).toBe('feads-daemon-launcher');
    delete process.env.BEADS_ACTOR;
  });

  test('one message resolves the identity once however many bd children it spawns', async () => {
    const identity = await import('./identity.js');
    /** @type {any} */ (identity.resolveIdentity).mockClear();
    const ws = makeStubSocket();

    // update-status runs bd twice: the mutation, then the `show` that reports it.
    await send(ws, {
      id: 'r4',
      type: 'update-status',
      payload: { id: 'UI-7', status: 'in_progress' }
    });

    expect(spawned.length).toBeGreaterThan(1);
    expect(spawned.every((s) => s.env.BEADS_ACTOR === 'mira-example')).toBe(
      true
    );
    // Once for the authorization gate, once for the memoized stamp, and once for
    // the advisory implicit-flare check added after this test was written. The
    // actor stamp is still resolved once for the message, not once per spawn —
    // which is what makes the per-message thunk worth the indirection.
    expect(
      /** @type {any} */ (identity.resolveIdentity).mock.calls.length
    ).toBeLessThanOrEqual(3);
  });
});

describe('runBd resolves the actor thunk at spawn time', () => {
  test('a thunk that throws leaves BEADS_ACTOR to bd rather than failing the run', async () => {
    /* The stamp is an annotation, not the write. An unreadable registry degrades it
       to the behaviour that was there before the thunk existed. */
    process.env.BEADS_ACTOR = 'feads-daemon-launcher';
    const { runBd } = await import('./bd.js');

    const res = await runBd(['list', '--json'], {
      board_dir: null,
      actor: () => {
        throw new Error('registry unreachable');
      }
    });

    expect(res.code).toBe(0);
    expect(spawned[spawned.length - 1].env.BEADS_ACTOR).toBe(
      'feads-daemon-launcher'
    );
    delete process.env.BEADS_ACTOR;
  });

  test('a plain string actor is stamped without a thunk', async () => {
    const { runBd } = await import('./bd.js');

    await runBd(['list', '--json'], { board_dir: null, actor: 'bob' });

    expect(spawned[spawned.length - 1].env.BEADS_ACTOR).toBe('bob');
  });
});
