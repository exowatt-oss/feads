import { describe, expect, test, vi } from 'vitest';
import { createWsClient } from './ws.js';

/**
 * @returns {any[]}
 */
function setupFakeWebSocket() {
  /** @type {any[]} */
  const sockets = [];
  class FakeWebSocket {
    /** @param {string} url */
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.OPEN = 1;
      this.CLOSING = 2;
      this.CLOSED = 3;
      /** @type {{ open: Array<(ev:any)=>void>, message: Array<(ev:any)=>void>, error: Array<(ev:any)=>void>, close: Array<(ev:any)=>void> }} */
      this._listeners = { open: [], message: [], error: [], close: [] };
      /** @type {string[]} */
      this.sent = [];
      sockets.push(this);
    }
    /**
     * @param {'open'|'message'|'error'|'close'} type
     * @param {(ev:any)=>void} fn
     */
    addEventListener(type, fn) {
      this._listeners[type].push(fn);
    }
    /**
     * @param {'open'|'message'|'error'|'close'} type
     * @param {(ev:any)=>void} fn
     */
    removeEventListener(type, fn) {
      const a = this._listeners[type];
      const i = a.indexOf(fn);
      if (i !== -1) {
        a.splice(i, 1);
      }
    }
    /**
     * @param {'open'|'message'|'error'|'close'} type
     * @param {any} ev
     */
    _dispatch(type, ev) {
      for (const fn of this._listeners[type]) {
        try {
          fn(ev);
        } catch {
          // ignore
        }
      }
    }
    openNow() {
      this.readyState = this.OPEN;
      this._dispatch('open', {});
    }
    /** @param {string} data */
    send(data) {
      this.sent.push(String(data));
    }
    /** @param {any} obj */
    emitMessage(obj) {
      this._dispatch('message', { data: JSON.stringify(obj) });
    }
    /**
     * @param {number} [code]
     * @param {string} [reason]
     */
    close(code = 1000, reason = '') {
      this.readyState = this.CLOSED;
      this._dispatch('close', { code, reason });
    }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);
  return sockets;
}

describe('app/ws client', () => {
  test('correlates replies for concurrent sends', async () => {
    const sockets = setupFakeWebSocket();
    const client = createWsClient({
      backoff: { initialMs: 5, maxMs: 5, jitterRatio: 0 }
    });
    // open connection
    sockets[0].openNow();

    const p1 = client.send('list-issues', { filters: {} });
    const p2 = client.send('edit-text', {
      id: 'UI-1',
      field: 'title',
      value: 'T'
    });

    // Parse the last two frames to extract ids
    const frames = sockets[0].sent
      .slice(-2)
      .map((/** @type {string} */ s) => JSON.parse(s));
    const id1 = frames[0].id;
    const id2 = frames[1].id;

    // Reply out of order
    sockets[0].emitMessage({
      id: id2,
      ok: true,
      type: 'edit-text',
      payload: { id: 'UI-1' }
    });
    sockets[0].emitMessage({
      id: id1,
      ok: true,
      type: 'list-issues',
      payload: [{ id: 'UI-1' }]
    });

    await expect(p2).resolves.toEqual({ id: 'UI-1' });
    await expect(p1).resolves.toEqual([{ id: 'UI-1' }]);
  });

  test('delays the first socket until explicitly started', () => {
    const sockets = setupFakeWebSocket();
    const client = createWsClient({ autoConnect: false });

    expect(sockets).toHaveLength(0);

    client.start();

    expect(sockets).toHaveLength(1);
    client.close();
  });

  test('stops reconnecting after an initial SSO authentication failure', async () => {
    vi.useFakeTimers();
    const sockets = setupFakeWebSocket();
    const client = createWsClient({
      autoConnect: false,
      backoff: { initialMs: 10, maxMs: 10, jitterRatio: 0 }
    });
    /** @type {Array<{ code: number, reason: string, initial: boolean }>} */
    const failures = [];
    client.onAuthFailure((failure) => failures.push(failure));
    client.setSsoBootstrapIdentified(true);
    client.start();

    sockets[0].close(1006, 'upgrade refused');
    await vi.advanceTimersByTimeAsync(100);

    expect(client.getState()).toBe('auth_denied');
    expect(failures).toEqual([
      { code: 1006, reason: 'upgrade refused', initial: true }
    ]);
    expect(sockets).toHaveLength(1);

    vi.useRealTimers();
    client.close();
  });

  test('treats an SSO policy close after open as terminal', () => {
    const sockets = setupFakeWebSocket();
    const client = createWsClient({ autoConnect: false });
    /** @type {Array<{ code: number, reason: string, initial: boolean }>} */
    const failures = [];
    client.onAuthFailure((failure) => failures.push(failure));
    client.setSsoBootstrapIdentified(true);
    client.start();
    sockets[0].openNow();

    sockets[0].close(1008, 'authentication failed');

    expect(client.getState()).toBe('auth_denied');
    expect(failures[0]).toMatchObject({
      code: 1008,
      reason: 'authentication failed',
      initial: false
    });
    expect(sockets).toHaveLength(1);
    client.close();
  });

  test('reconnects after close', async () => {
    vi.useFakeTimers();
    const sockets = setupFakeWebSocket();
    const client = createWsClient({
      backoff: { initialMs: 10, maxMs: 10, jitterRatio: 0 }
    });

    // First connection opens
    sockets[0].openNow();

    // Close the socket to trigger reconnect
    sockets[0].close();
    // Advance timers for reconnect
    await vi.advanceTimersByTimeAsync(10);

    // Second socket should exist and open
    expect(sockets.length).toBeGreaterThan(1);
    sockets[1].openNow();
    // No automatic subscribe frames in v2; just ensure reconnect occurred
    expect(Array.isArray(sockets[1].sent)).toBe(true);

    vi.useRealTimers();
    client.close();
  });

  test('dispatches server events', async () => {
    const sockets = setupFakeWebSocket();
    const client = createWsClient();
    sockets[0].openNow();

    /** @type {any[]} */
    const events = [];
    client.on('snapshot', (p) => events.push(p));
    sockets[0].emitMessage({
      id: 'evt-1',
      ok: true,
      type: 'snapshot',
      payload: {
        type: 'snapshot',
        id: 'any',
        revision: 1,
        issues: []
      }
    });
    expect(events.length).toBe(1);

    // No handler registered for create-issue -> warn
    sockets[0].emitMessage({
      id: 'evt-2',
      ok: true,
      type: 'create-issue',
      payload: {}
    });
    client.close();
  });

  // Removed: subscription ack frames; no warnings to test

  test('rejects a request whose reply never arrives (timeout)', async () => {
    vi.useFakeTimers();
    const sockets = setupFakeWebSocket();
    const client = createWsClient({
      requestTimeoutMs: 1000,
      pingIntervalMs: 0
    });
    sockets[0].openNow();

    const p = client.send('ping');
    /** @type {any} */
    let rejection = null;
    p.catch((e) => {
      rejection = e;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(rejection).toBe(null);
    await vi.advanceTimersByTimeAsync(2);
    expect(rejection && rejection.code).toBe('timeout');

    // A late reply for the timed-out id is ignored, not crashed on.
    const sent = JSON.parse(sockets[0].sent[0]);
    sockets[0].emitMessage({
      id: sent.id,
      ok: true,
      type: 'ping',
      payload: {}
    });

    vi.useRealTimers();
    client.close();
  });

  test('a reply that arrives in time clears the timeout', async () => {
    vi.useFakeTimers();
    const sockets = setupFakeWebSocket();
    const client = createWsClient({
      requestTimeoutMs: 1000,
      pingIntervalMs: 0
    });
    sockets[0].openNow();

    const p = client.send('ping');
    const sent = JSON.parse(sockets[0].sent[0]);
    sockets[0].emitMessage({
      id: sent.id,
      ok: true,
      type: 'ping',
      payload: { ts: 1 }
    });
    await expect(p).resolves.toEqual({ ts: 1 });
    // Advancing past the deadline must not reject anything after the fact.
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    client.close();
  });

  test('liveness ping closes a socket that stops answering', async () => {
    vi.useFakeTimers();
    const sockets = setupFakeWebSocket();
    const client = createWsClient({
      requestTimeoutMs: 60000,
      pingIntervalMs: 100,
      pingTimeoutMs: 50,
      backoff: { initialMs: 5, maxMs: 5, jitterRatio: 0 }
    });
    sockets[0].openNow();

    // First ping fires at t+100 and goes unanswered; at t+150 the client
    // closes the socket itself, and the backoff opens a replacement.
    await vi.advanceTimersByTimeAsync(100);
    const pings = sockets[0].sent
      .map((/** @type {string} */ m) => JSON.parse(m))
      .filter((/** @type {any} */ m) => m.type === 'ping');
    expect(pings.length).toBe(1);

    await vi.advanceTimersByTimeAsync(60);
    expect(sockets[0].readyState).toBe(sockets[0].CLOSED);

    await vi.advanceTimersByTimeAsync(10);
    expect(sockets.length).toBe(2);

    vi.useRealTimers();
    client.close();
  });

  test('an answered liveness ping keeps the socket open', async () => {
    vi.useFakeTimers();
    const sockets = setupFakeWebSocket();
    const client = createWsClient({
      requestTimeoutMs: 60000,
      pingIntervalMs: 100,
      pingTimeoutMs: 50
    });
    sockets[0].openNow();

    await vi.advanceTimersByTimeAsync(100);
    const ping = sockets[0].sent
      .map((/** @type {string} */ m) => JSON.parse(m))
      .find((/** @type {any} */ m) => m.type === 'ping');
    expect(!!ping).toBe(true);
    sockets[0].emitMessage({
      id: ping.id,
      ok: true,
      type: 'ping',
      payload: {}
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(sockets[0].readyState).toBe(sockets[0].OPEN);
    expect(sockets.length).toBe(1);

    vi.useRealTimers();
    client.close();
  });
});
