/**
 * @import { MessageType } from './protocol.js'
 */
/**
 * Persistent WebSocket client with reconnect, request/response correlation,
 * and simple event dispatching.
 *
 * Usage:
 *   const ws = createWsClient();
 *   const data = await ws.send('list-issues', { filters: {} });
 *   const off = ws.on('snapshot', (payload) => { <push event> });
 */
import { MESSAGE_TYPES, makeRequest, nextId } from './protocol.js';
import { debug } from './utils/logging.js';

/**
 * @typedef {'connecting'|'open'|'closed'|'reconnecting'|'auth_denied'} ConnectionState
 */

/**
 * @typedef {{ initialMs?: number, maxMs?: number, factor?: number, jitterRatio?: number }} BackoffOptions
 */

/**
 * @typedef {{ url?: string, backoff?: BackoffOptions, requestTimeoutMs?: number, pingIntervalMs?: number, pingTimeoutMs?: number, autoConnect?: boolean }} ClientOptions
 */

/**
 * Create a WebSocket client with auto-reconnect, message correlation, and an
 * optional delayed first connection. The delayed mode is used by the browser
 * shell for the silo SSO preflight; ordinary callers keep the historical
 * eager-connect behavior.
 *
 * @param {ClientOptions} [options]
 */
export function createWsClient(options = {}) {
  const log = debug('ws');

  // A request that the server never answers must not hang its caller forever
  // (feads incident: a half-open socket after laptop sleep left the detail
  // modal on "Loading…" until a manual reload). The server answers in
  // milliseconds when it is reachable, so a reply that has not arrived after
  // this long means the transport is gone, not that the work is slow.
  const request_timeout_ms = options.requestTimeoutMs ?? 15000;
  // Liveness: the browser cannot tell a half-open TCP connection from a quiet
  // one — `readyState` stays OPEN while every frame goes into the void. A
  // periodic application-level ping is the only reliable detector. When one
  // goes unanswered the socket is closed on purpose, which is what arms the
  // reconnect (and the session restore that main.js runs on reopen).
  const ping_interval_ms = options.pingIntervalMs ?? 25000;
  const ping_timeout_ms = options.pingTimeoutMs ?? 8000;

  /** @type {BackoffOptions} */
  const backoff = {
    initialMs: options.backoff?.initialMs ?? 1000,
    maxMs: options.backoff?.maxMs ?? 30000,
    factor: options.backoff?.factor ?? 2,
    jitterRatio: options.backoff?.jitterRatio ?? 0.2
  };

  /** @type {() => string} */
  const resolveUrl = () => {
    if (options.url && options.url.length > 0) {
      return options.url;
    }
    if (typeof location !== 'undefined') {
      return (
        (location.protocol === 'https:' ? 'wss://' : 'ws://') +
        location.host +
        '/ws'
      );
    }
    return 'ws://localhost/ws';
  };

  /** @type {WebSocket | null} */
  let ws = null;
  /** @type {ConnectionState} */
  let state = 'closed';
  /** @type {number} */
  let attempts = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnect_timer = null;
  /** @type {boolean} */
  let should_reconnect = true;
  /** @type {boolean} */
  let started = options.autoConnect !== false;
  /** @type {boolean} */
  let sso_bootstrap_identified = false;

  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: any) => void, type: string, timer: ReturnType<typeof setTimeout> | null }>} */
  const pending = new Map();
  /** @type {ReturnType<typeof setInterval> | null} */
  let ping_timer = null;
  /** @type {Array<ReturnType<typeof makeRequest>>} */
  const queue = [];
  /** @type {Map<string, Set<(payload: any) => void>>} */
  const handlers = new Map();
  /** @type {Set<(s: ConnectionState) => void>} */
  const connection_handlers = new Set();
  /** @type {Set<(failure: { code: number, reason: string, initial: boolean }) => void>} */
  const auth_failure_handlers = new Set();

  /**
   * @param {ConnectionState} s
   */
  function notifyConnection(s) {
    for (const fn of Array.from(connection_handlers)) {
      try {
        fn(s);
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * Reject requests that cannot survive the socket which carried them. Queued
   * requests must be dropped as well: replaying them after an auth failure would
   * turn a terminal SSO decision into an accidental retry loop.
   *
   * @param {Error|Record<string, unknown>} error
   */
  function rejectPending(error) {
    for (const [, entry] of pending.entries()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(error);
    }
    pending.clear();
    queue.length = 0;
  }

  function scheduleReconnect() {
    if (!started || !should_reconnect || reconnect_timer) {
      return;
    }
    state = 'reconnecting';
    log('ws reconnecting…');
    notifyConnection(state);
    const base = Math.min(
      backoff.maxMs || 0,
      (backoff.initialMs || 0) * Math.pow(backoff.factor || 1, attempts)
    );
    const jitter = (backoff.jitterRatio || 0) * base;
    const delay = Math.max(
      0,
      Math.round(base + (Math.random() * 2 - 1) * jitter)
    );
    log('ws retry in %d ms (attempt %d)', delay, attempts + 1);
    reconnect_timer = setTimeout(() => {
      reconnect_timer = null;
      connect();
    }, delay);
  }

  /** @param {ReturnType<typeof makeRequest>} req */
  function sendRaw(req) {
    try {
      ws?.send(JSON.stringify(req));
    } catch (err) {
      log('ws send failed', err);
    }
  }

  /** @param {WebSocket} socket */
  function onOpen(socket) {
    if (ws !== socket) {
      return;
    }
    state = 'open';
    log('ws open');
    notifyConnection(state);
    attempts = 0;
    // flush queue
    while (queue.length) {
      const req = queue.shift();
      if (req) {
        sendRaw(req);
      }
    }
    startPinging();
  }

  function stopPinging() {
    if (ping_timer) {
      clearInterval(ping_timer);
      ping_timer = null;
    }
  }

  function startPinging() {
    stopPinging();
    if (!(ping_interval_ms > 0)) {
      return;
    }
    ping_timer = setInterval(() => {
      if (!ws || ws.readyState !== ws.OPEN) {
        return;
      }
      sendRequest('ping', undefined, ping_timeout_ms).catch(() => {
        // No answer within the ping budget: the socket is dead even if the
        // browser thinks otherwise. Close it so reconnect takes over.
        log('ws ping unanswered — closing socket to force reconnect');
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      });
    }, ping_interval_ms);
    // In Node (tests), do not let the ping keep the process alive.
    /** @type {any} */ (ping_timer).unref?.();
  }

  /** @param {MessageEvent} ev */
  function onMessage(ev) {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      log('ws received non-JSON message');
      return;
    }
    if (!msg || typeof msg.id !== 'string' || typeof msg.type !== 'string') {
      log('ws received invalid envelope');
      return;
    }

    if (pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (entry?.timer) {
        clearTimeout(entry.timer);
      }
      if (msg.ok) {
        entry?.resolve(msg.payload);
      } else {
        entry?.reject(msg.error || new Error('ws error'));
      }
      return;
    }

    // Treat as server-initiated event
    const set = handlers.get(msg.type);
    if (set && set.size > 0) {
      for (const fn of Array.from(set)) {
        try {
          fn(msg.payload);
        } catch (err) {
          log('ws event handler error', err);
        }
      }
    } else {
      log('ws received unhandled message type: %s', msg.type);
    }
  }

  /**
   * @param {CloseEvent|{ code?: number, reason?: string }|undefined} event
   * @param {boolean} socket_opened
   */
  function onClose(event, socket_opened) {
    state = 'closed';
    log('ws closed');
    stopPinging();
    rejectPending(new Error('ws disconnected'));

    // A silo SSO bootstrap is a credential decision. A 1008 close is an
    // explicit policy refusal; a socket that never opened is the browser's
    // representation of an HTTP upgrade refusal. Neither should enter the
    // ordinary reconnect loop once the preflight identified SSO.
    const code = Number(event?.code || 0);
    const initial_failure = !socket_opened;
    if (
      sso_bootstrap_identified &&
      should_reconnect &&
      (code === 1008 || initial_failure)
    ) {
      should_reconnect = false;
      state = 'auth_denied';
      notifyConnection(state);
      const failure = {
        code: code || 1006,
        reason: String(event?.reason || ''),
        initial: initial_failure
      };
      for (const fn of Array.from(auth_failure_handlers)) {
        try {
          fn(failure);
        } catch {
          // ignore listener errors
        }
      }
      return;
    }

    if (!should_reconnect) {
      return;
    }
    notifyConnection(state);
    attempts += 1;
    scheduleReconnect();
  }

  /**
   * @param {WebSocket} socket
   * @param {boolean} socket_opened
   * @param {CloseEvent|{ code?: number, reason?: string }} event
   */
  function handleClose(socket, socket_opened, event) {
    if (ws !== socket) {
      return;
    }
    onClose(event, socket_opened);
  }

  function connect() {
    if (!started || !should_reconnect) {
      return;
    }
    const url = resolveUrl();
    /** @type {boolean} */
    let socket_opened = false;
    try {
      const socket = new WebSocket(url);
      ws = socket;
      log('ws connecting %s', url);
      state = 'connecting';
      notifyConnection(state);
      socket.addEventListener('open', () => {
        socket_opened = true;
        onOpen(socket);
      });
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', () => {
        // let close handler handle reconnect
      });
      socket.addEventListener('close', (event) =>
        handleClose(socket, socket_opened, event)
      );
    } catch (err) {
      log('ws connect failed', err);
      if (sso_bootstrap_identified && should_reconnect) {
        onClose({ code: 1006, reason: 'connection failed' }, false);
      } else {
        scheduleReconnect();
      }
    }
  }

  /**
   * Send a request with a reply deadline.
   *
   * @param {MessageType} type
   * @param {unknown} payload
   * @param {number} timeout_ms - 0 disables the deadline.
   * @returns {Promise<any>}
   */
  function sendRequest(type, payload, timeout_ms) {
    if (!MESSAGE_TYPES.includes(type)) {
      return Promise.reject(new Error(`unknown message type: ${type}`));
    }
    if (!should_reconnect) {
      return Promise.reject(new Error('ws client is closed'));
    }
    const id = nextId();
    const req = makeRequest(type, payload, id);
    log('send %s id=%s', type, id);
    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null;
      if (timeout_ms > 0) {
        timer = setTimeout(() => {
          if (!pending.has(id)) {
            return;
          }
          pending.delete(id);
          // Drop it from the offline queue too, so a reconnect does not
          // replay a request whose caller already gave up on it.
          const qi = queue.indexOf(req);
          if (qi >= 0) {
            queue.splice(qi, 1);
          }
          log('request %s id=%s timed out after %dms', type, id, timeout_ms);
          reject({
            code: 'timeout',
            message: `no reply to ${type} within ${timeout_ms}ms`
          });
        }, timeout_ms);
        /** @type {any} */ (timer).unref?.();
      }
      pending.set(id, { resolve, reject, type, timer });
      if (ws && ws.readyState === ws.OPEN) {
        sendRaw(req);
      } else {
        log('queue %s id=%s (state=%s)', type, id, state);
        queue.push(req);
      }
    });
  }

  if (started) {
    connect();
  }

  return {
    /**
     * Send a request and await its correlated reply payload.
     *
     * @param {MessageType} type
     * @param {unknown} [payload]
     * @returns {Promise<any>}
     */
    send(type, payload) {
      return sendRequest(type, payload, request_timeout_ms);
    },
    /**
     * Register a handler for a server-initiated event type.
     * Returns an unsubscribe function.
     *
     * @param {MessageType} type
     * @param {(payload: any) => void} handler
     * @returns {() => void}
     */
    on(type, handler) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      const set = handlers.get(type);
      set?.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    /**
     * Subscribe to connection state changes.
     *
     * @param {(state: ConnectionState) => void} handler
     * @returns {() => void}
     */
    onConnection(handler) {
      connection_handlers.add(handler);
      return () => {
        connection_handlers.delete(handler);
      };
    },
    /**
     * Subscribe to an SSO authentication failure. It is separate from ordinary
     * connection state so callers can show an actionable identity state rather
     * than a generic network toast.
     *
     * @param {(failure: { code: number, reason: string, initial: boolean }) => void} handler
     * @returns {() => void}
     */
    onAuthFailure(handler) {
      auth_failure_handlers.add(handler);
      return () => {
        auth_failure_handlers.delete(handler);
      };
    },
    /** Start a client created with `autoConnect: false`. */
    start() {
      if (started && should_reconnect && ws) {
        return;
      }
      started = true;
      should_reconnect = true;
      attempts = 0;
      connect();
    },
    /**
     * Tell the client that its HTTP preflight identified a silo SSO session.
     * This flag is intentionally explicit; the WebSocket client never guesses
     * from the URL or hostname.
     *
     * @param {boolean} identified
     */
    setSsoBootstrapIdentified(identified) {
      sso_bootstrap_identified = identified === true;
    },
    /** Close and stop reconnecting. */
    close() {
      started = false;
      should_reconnect = false;
      stopPinging();
      if (reconnect_timer) {
        clearTimeout(reconnect_timer);
        reconnect_timer = null;
      }
      rejectPending(new Error('ws client closed'));
      const active = ws;
      try {
        active?.close();
      } catch {
        /* ignore */
      }
      if (!active) {
        state = 'closed';
      }
    },
    /** For diagnostics in tests or UI. */
    getState() {
      return state;
    }
  };
}
