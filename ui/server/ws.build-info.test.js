/**
 * feads addition — the daemon volunteers its build identity.
 *
 * Server-initiated, and it has to be: the code that would ask "am I out of date?" is the
 * code that is out of date. Two moments matter and they are different cases:
 *
 * - **on connect**, because the interesting failure is a browser that has *just* loaded a
 *   stale bundle against a stale process. No change event is coming — both have been
 *   wrong since before the socket existed.
 * - **on change**, so a rebuild while somebody is looking at the page reaches them.
 *
 * A build change is broadcast to everyone, unlike a board switch, because it is a fact
 * about the process rather than about one connection. That asymmetry is the point of the
 * comment on `broadcastEvent`, and it is asserted here so nobody "fixes" it by making
 * this per-connection too.
 */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { attachWsServer } from './ws.js';

vi.mock('./bd.js', () => ({
  runBd: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  runBdJson: vi.fn(async () => ({ code: 0, stdoutJson: [] })),
  getGitUserName: vi.fn(async () => '')
}));

/** Sockets that can be connected and closed. */
class StubSocket extends EventEmitter {
  constructor() {
    super();
    /** @type {string[]} */
    this.sent = [];
    this.readyState = 1;
    this.OPEN = 1;
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
   * @returns {any[]}
   */
  events() {
    return this.sent.map((m) => JSON.parse(m));
  }
}

/** @type {Array<ReturnType<typeof attachWsServer>>} */
const attached = [];

afterEach(() => {
  for (const a of attached.splice(0)) {
    a.buildWatch?.stop();
    a.watchers.closeAll();
  }
});

/**
 * @param {{ report: () => any }} identity
 * @returns {ReturnType<typeof attachWsServer>}
 */
function attach(identity) {
  const a = attachWsServer(createServer(), {
    path: '/ws',
    heartbeat_ms: 100000,
    build_identity: identity,
    // Never a real `fs.watch`: its handle keeps the event loop alive.
    create_watcher: () => ({ close() {} })
  });
  attached.push(a);
  return a;
}

/**
 * @param {ReturnType<typeof attachWsServer>} a
 * @returns {StubSocket}
 */
function connect(a) {
  const ws = new StubSocket();
  a.wss.clients.add(/** @type {any} */ (ws));
  a.wss.emit('connection', /** @type {any} */ (ws), { headers: {} });
  return ws;
}

/**
 * @param {StubSocket} ws
 * @returns {any[]}
 */
function buildEvents(ws) {
  return ws.events().filter((e) => e.type === 'build-info');
}

describe('build-info over the WebSocket', () => {
  test('every connection is told the build as soon as it connects', () => {
    const report = {
      build_id: 'boot1',
      bundle_id: 'bundle1',
      server_stale: false,
      restart_command: 'scripts/feads-run.sh restart'
    };
    const a = attach({ report: () => report });

    const ws = connect(a);

    const events = buildEvents(ws);
    expect(events).toHaveLength(1);
    expect(events[0].payload.build_id).toBe('boot1');
    expect(events[0].payload.bundle_id).toBe('bundle1');
  });

  test('a stale process is reported on connect, not only after a change', () => {
    // The original failure: the daemon had been stale for four hours before this browser
    // existed, so waiting for a change event would have said nothing, ever.
    const a = attach({
      report: () => ({
        build_id: 'boot1',
        bundle_id: 'bundle1',
        server_stale: true,
        restart_command: 'scripts/feads-run.sh restart'
      })
    });

    const ws = connect(a);

    expect(buildEvents(ws)[0].payload.server_stale).toBe(true);
  });

  test('a change reaches every open client, because it is a fact about the process', () => {
    let bundle = 'bundle1';
    const a = attach({
      report: () => ({
        build_id: 'boot1',
        bundle_id: bundle,
        server_stale: false,
        restart_command: 'scripts/feads-run.sh restart'
      })
    });
    const first = connect(a);
    const second = connect(a);
    first.sent = [];
    second.sent = [];

    bundle = 'bundle2';
    a.buildWatch?.check();

    // Deliberately *not* per-connection, unlike a board switch: every browser is holding
    // a bundle from the same server.
    expect(buildEvents(first)[0].payload.bundle_id).toBe('bundle2');
    expect(buildEvents(second)[0].payload.bundle_id).toBe('bundle2');
  });

  test('no change means no event, so the banner is not re-rendered on a timer', () => {
    const a = attach({
      report: () => ({
        build_id: 'boot1',
        bundle_id: 'bundle1',
        server_stale: false,
        restart_command: 'scripts/feads-run.sh restart'
      })
    });
    const ws = connect(a);
    ws.sent = [];

    a.buildWatch?.check();
    a.buildWatch?.check();

    expect(buildEvents(ws)).toEqual([]);
  });

  test('a daemon attached without a build identity simply says nothing', () => {
    // A `handleMessage`-only test, or a build with no identity to report, must not pay
    // for a walk of the source tree — and must not send a payload full of blanks that a
    // client would read as "current".
    const a = attachWsServer(createServer(), {
      path: '/ws',
      heartbeat_ms: 100000,
      create_watcher: () => ({ close() {} })
    });
    attached.push(a);

    const ws = connect(a);

    expect(buildEvents(ws)).toEqual([]);
    expect(a.buildWatch).toBeNull();
  });

  test('a report that throws does not take the connection down', () => {
    // This runs in the connection handler. An exception there would leave a browser with
    // a socket that never finished setting up, over a diagnostic.
    const a = attach({
      report: () => {
        throw new Error('unreadable');
      }
    });

    expect(() => connect(a)).not.toThrow();
  });
});
