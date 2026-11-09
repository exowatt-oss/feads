#!/usr/bin/env node
/**
 * feads perf harness — measures a running dashboard the way a browser and a
 * swarm of agents use it. Pair with `seed-bench.js` (realistic volume) and run
 * the same seed before and after a change.
 *
 * Usage:
 *   node scripts/bench/feads-bench.js --url http://127.0.0.1:4199 \
 *     --token-file /tmp/feads-bench/token --dsn postgres://.../feads_bench_x \
 *     --pid <server pid> --out /tmp/feads-bench/before.json [--iterations 20]
 *
 * Every scenario reports p50/p95 wall time and payload sizes. "payload" bytes
 * are the decoded JSON frames the client handles; "wire" bytes are what the
 * socket actually read (smaller when permessage-deflate is negotiated).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import pg from 'pg';
import WebSocket from 'ws';

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : String(process.argv[i + 1] || fallback);
}

const base = arg('url', 'http://127.0.0.1:4199').replace(/\/$/, '');
const ws_url = base.replace(/^http/, 'ws') + '/ws';
const token = fs.readFileSync(arg('token-file'), 'utf8').trim();
const dsn = arg('dsn');
const pid = arg('pid');
const out_file = arg('out');
const N = Number(arg('iterations', '20')) || 20;
const only = arg('only')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** @type {Record<string, any>} */
const results = {};

/**
 * @param {number[]} xs
 * @param {number} p
 * @returns {number}
 */
function pct(xs, p) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return Math.round(s[Math.max(0, i)] * 10) / 10;
}

/**
 * @param {number[]} times
 * @param {Record<string, unknown>} [extra]
 */
function summary(times, extra = {}) {
  return {
    n: times.length,
    p50: pct(times, 50),
    p95: pct(times, 95),
    ...extra
  };
}

function cpuSeconds() {
  if (!pid) return 0;
  try {
    const raw = execFileSync('ps', ['-o', 'cputime=', '-p', pid])
      .toString()
      .trim();
    const parts = raw.split(':').map(Number);
    let s = 0;
    for (const p of parts) s = s * 60 + p;
    return s;
  } catch {
    return 0;
  }
}

let seq = 0;

/**
 * A dashboard connection with request/reply correlation and frame accounting.
 */
class Conn {
  /** @param {{ deflate?: boolean }} [options] */
  constructor(options = {}) {
    this.ws = new WebSocket(ws_url, {
      headers: { cookie: `feads_agent_token=${token}` },
      perMessageDeflate: options.deflate !== false
    });
    /** @type {Map<string, (msg: any) => void>} */
    this.waiters = new Map();
    /** @type {Array<(msg: any, size: number) => void>} */
    this.listeners = [];
    this.frames = 0;
    this.payload_bytes = 0;
    this.ws.on('message', (data) => {
      const text = String(data);
      this.frames += 1;
      this.payload_bytes += Buffer.byteLength(text);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      for (const fn of this.listeners) fn(msg, text.length);
      const w = this.waiters.get(msg.id);
      if (w) {
        this.waiters.delete(msg.id);
        w(msg);
      }
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  wireBytes() {
    // @ts-ignore — the underlying net.Socket
    return Number(this.ws._socket?.bytesRead || 0);
  }

  /**
   * @param {string} type
   * @param {unknown} [payload]
   * @returns {Promise<any>}
   */
  request(type, payload) {
    seq += 1;
    const id = `b-${seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout ${type}`)),
        60000
      );
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ id, type, payload }));
    });
  }

  /**
   * Subscribe and resolve when the snapshot for it arrives.
   *
   * @param {string} client_id
   * @param {{ type: string, params?: Record<string, unknown> }} spec
   * @returns {Promise<{ ms: number, bytes: number, count: number, ok: boolean }>}
   */
  async subscribe(client_id, spec) {
    const t0 = performance.now();
    let bytes = 0;
    let count = 0;
    const got = new Promise((resolve) => {
      /** @type {(msg: any, size: number) => void} */
      const fn = (msg, size) => {
        if (msg.type === 'snapshot' && msg.payload?.id === client_id) {
          bytes = size;
          count = Array.isArray(msg.payload.issues)
            ? msg.payload.issues.length
            : 0;
          this.listeners = this.listeners.filter((x) => x !== fn);
          resolve(undefined);
        }
      };
      this.listeners.push(fn);
    });
    const reply = await this.request('subscribe-list', {
      id: client_id,
      ...spec
    });
    if (!reply.ok) {
      return { ms: performance.now() - t0, bytes: 0, count: 0, ok: false };
    }
    await got;
    return { ms: performance.now() - t0, bytes, count, ok: true };
  }

  /** @param {string} client_id */
  unsubscribe(client_id) {
    return this.request('unsubscribe-list', { id: client_id });
  }

  close() {
    this.ws.close();
  }
}

/**
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function scenario(name, fn) {
  if (only.length > 0 && !only.includes(name)) return;
  const cpu0 = cpuSeconds();
  const t0 = performance.now();
  try {
    await fn();
  } catch (err) {
    results[name] = { error: String(/** @type {any} */ (err)?.message || err) };
  }
  if (results[name] && typeof results[name] === 'object') {
    results[name].server_cpu_s =
      Math.round((cpuSeconds() - cpu0) * 100) / 100 || 0;
    results[name].wall_s = Math.round(performance.now() - t0) / 1000;
  }
  console.error(`${name}: ${JSON.stringify(results[name])}`);
}

const LIST_TYPES = [
  'all-issues',
  'ready-issues',
  'in-progress-issues',
  'closed-issues',
  'blocked-issues',
  'epics'
];

await scenario('subscribe', async () => {
  const c = new Conn();
  await c.open();
  /** @type {Record<string, any>} */
  const out = {};
  for (const board of ['example', 'feads', 'it']) {
    await c.request('set-board', { id: board });
    for (const type of LIST_TYPES) {
      /** @type {number[]} */
      const times = [];
      let bytes = 0;
      let count = 0;
      for (let i = 0; i < N; i += 1) {
        const id = `s-${board}-${type}-${i}`;
        const r = await c.subscribe(id, { type });
        times.push(r.ms);
        bytes = r.bytes;
        count = r.count;
        await c.unsubscribe(id);
      }
      out[`${board}/${type}`] = summary(times, { bytes, count });
    }
  }
  c.close();
  results.subscribe = out;
});

await scenario('detail', async () => {
  const db = new pg.Client({ connectionString: dsn });
  await db.connect();
  const ids = (
    await db.query(
      `SELECT id FROM issues WHERE board_id = 'example' AND deleted_at IS NULL
       ORDER BY md5(id) LIMIT $1`,
      [N]
    )
  ).rows.map((r) => r.id);
  await db.end();
  const c = new Conn();
  await c.open();
  await c.request('set-board', { id: 'example' });
  /** @type {number[]} */
  const times = [];
  let bytes = 0;
  for (const id of ids) {
    const cid = `d-${id}`;
    const r = await c.subscribe(cid, { type: 'issue-detail', params: { id } });
    times.push(r.ms);
    bytes = Math.max(bytes, r.bytes);
    await c.unsubscribe(cid);
    const t0 = performance.now();
    await c.request('get-comments', { id });
    times.push(performance.now() - t0);
  }
  c.close();
  results.detail = summary(times, { max_bytes: bytes });
});

/**
 * `--closed-since 1` subscribes the Done column the way the dashboard does
 * since the perf pass: closures from local midnight eight days ago.
 */
const CLOSED_SINCE = arg('closed-since') === '1';
const since_day = new Date();
since_day.setHours(0, 0, 0, 0);
since_day.setDate(since_day.getDate() - 8);

/** The four lists the Board tab holds open. */
const BOARD_TAB = [
  ['tab:board:ready', 'ready-issues'],
  ['tab:board:blocked', 'blocked-issues'],
  ['tab:board:in-progress', 'in-progress-issues'],
  ['tab:board:closed', 'closed-issues']
];

/**
 * @param {string} type
 * @returns {{ type: string, params?: Record<string, number> }}
 */
function boardSpec(type) {
  return CLOSED_SINCE && type === 'closed-issues'
    ? { type, params: { since: since_day.getTime() } }
    : { type };
}

await scenario('board_switch', async () => {
  const c = new Conn();
  await c.open();
  await c.request('set-board', { id: 'it' });
  for (const [cid, type] of BOARD_TAB) await c.subscribe(cid, boardSpec(type));
  /** @type {number[]} */
  const times = [];
  let wire = 0;
  let payload = 0;
  const order = ['demo', 'issues', 'catalog', 'garden', 'support'];
  for (let i = 0; i < N; i += 1) {
    const target = order[i % order.length];
    const want = new Set(BOARD_TAB.map(([cid]) => cid));
    const w0 = c.wireBytes();
    const p0 = c.payload_bytes;
    const t0 = performance.now();
    const done = new Promise((resolve) => {
      /** @type {(msg: any) => void} */
      const fn = (msg) => {
        if (msg.type === 'snapshot' && want.has(msg.payload?.id)) {
          want.delete(msg.payload.id);
          if (want.size === 0) {
            c.listeners = c.listeners.filter((x) => x !== fn);
            resolve(undefined);
          }
        }
      };
      c.listeners.push(fn);
    });
    await c.request('set-board', { id: target });
    await done;
    times.push(performance.now() - t0);
    wire += c.wireBytes() - w0;
    payload += c.payload_bytes - p0;
  }
  c.close();
  results.board_switch = summary(times, {
    avg_payload_bytes: Math.round(payload / N),
    avg_wire_bytes: Math.round(wire / N)
  });
});

// What the dashboard actually does on a switch: set-board, then tear down and
// re-subscribe every list (app/main.js clearAndResubscribe). Counts every
// snapshot frame that arrives within a settle window, so a server that also
// re-snapshots the migrated subscriptions shows up as doubled payload.
await scenario('board_switch_browser', async () => {
  const c = new Conn();
  await c.open();
  await c.request('set-board', { id: 'it' });
  for (const [cid, type] of BOARD_TAB) await c.subscribe(cid, boardSpec(type));
  /** @type {number[]} */
  const times = [];
  let wire = 0;
  let payload = 0;
  let snapshots = 0;
  const order = ['demo', 'issues', 'catalog', 'garden', 'support'];
  for (let i = 0; i < N; i += 1) {
    const target = order[i % order.length];
    const w0 = c.wireBytes();
    const p0 = c.payload_bytes;
    let seen = 0;
    /** @type {(msg: any) => void} */
    const count = (msg) => {
      if (msg.type === 'snapshot') seen += 1;
    };
    c.listeners.push(count);
    const t0 = performance.now();
    await c.request('set-board', { id: target });
    await Promise.all(
      BOARD_TAB.map(async ([cid]) => {
        await c.unsubscribe(cid);
      })
    );
    await Promise.all(
      BOARD_TAB.map(([cid, type]) => c.subscribe(cid, boardSpec(type)))
    );
    times.push(performance.now() - t0);
    await new Promise((r) => setTimeout(r, 600));
    c.listeners = c.listeners.filter((x) => x !== count);
    snapshots += seen;
    wire += c.wireBytes() - w0;
    payload += c.payload_bytes - p0;
  }
  c.close();
  results.board_switch_browser = summary(times, {
    snapshots_per_switch: Math.round((snapshots / N) * 10) / 10,
    avg_payload_bytes: Math.round(payload / N),
    avg_wire_bytes: Math.round(wire / N)
  });
});

await scenario('all_boards', async () => {
  const c = new Conn();
  await c.open();
  await c.request('set-board', { id: '*' });
  /** @type {Record<string, any>} */
  const out = {};
  for (const type of ['all-issues', 'closed-issues', 'ready-issues']) {
    /** @type {number[]} */
    const times = [];
    let bytes = 0;
    let count = 0;
    for (let i = 0; i < Math.max(5, Math.round(N / 2)); i += 1) {
      const id = `a-${type}-${i}`;
      const r = await c.subscribe(id, { type });
      times.push(r.ms);
      bytes = r.bytes;
      count = r.count;
      await c.unsubscribe(id);
    }
    out[type] = summary(times, { bytes, count });
  }
  c.close();
  results.all_boards = out;
});

await scenario('notifications', async () => {
  const c = new Conn();
  await c.open();
  /** @type {number[]} */
  const ws_times = [];
  let bytes = 0;
  for (let i = 0; i < N; i += 1) {
    const t0 = performance.now();
    const r = await c.request('list-notifications', { limit: 50 });
    ws_times.push(performance.now() - t0);
    bytes = JSON.stringify(r).length;
  }
  c.close();
  /** @type {number[]} */
  const http_times = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = performance.now();
    const res = await fetch(`${base}/api/notifications?limit=20`, {
      headers: { authorization: `Bearer ${token}` }
    });
    await res.text();
    http_times.push(performance.now() - t0);
  }
  results.notifications = {
    ws_list: summary(ws_times, { bytes }),
    http_list: summary(http_times)
  };
});

await scenario('static', async () => {
  /** @type {Record<string, any>} */
  const out = {};
  const html = await (await fetch(`${base}/`)).text();
  const bundle_src =
    /src="(\.?\/?main\.bundle\.js[^"]*)"/.exec(html)?.[1] || 'main.bundle.js';
  for (const p of [
    '/',
    `/${bundle_src.replace(/^\.?\//, '')}`,
    '/styles.css'
  ]) {
    /** @type {number[]} */
    const times = [];
    let wire = 0;
    let raw = 0;
    let encoding = '';
    let cache = '';
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      // Node's fetch decodes transparently; ask for raw bytes via a header
      // and measure the encoded length ourselves.
      const res = await fetch(`${base}${p}`, {
        headers: { 'accept-encoding': 'br, gzip' }
      });
      const buf = Buffer.from(await res.arrayBuffer());
      times.push(performance.now() - t0);
      encoding = res.headers.get('content-encoding') || 'identity';
      cache = res.headers.get('cache-control') || '';
      raw = buf.length;
      const len = Number(res.headers.get('content-length') || 0);
      wire = encoding === 'identity' ? raw : len || raw;
    }
    out[p.split('?')[0]] = summary(times, {
      decoded_bytes: raw,
      wire_bytes: wire,
      encoding,
      cache_control: cache,
      gzip_would_be: zlib.gzipSync(
        Buffer.from(await (await fetch(`${base}${p}`)).arrayBuffer())
      ).length
    });
  }
  results.static = out;
});

/**
 * Write the way the MCP server does: row change + events row + NOTIFY in one
 * transaction.
 *
 * @param {pg.Client} db
 * @param {string} id
 * @param {number} n
 */
async function agentWrite(db, id, n) {
  await db.query('BEGIN');
  if (n % 3 === 0) {
    await db.query(
      `INSERT INTO comments (id, issue_id, author, body, created_at)
       VALUES ($1, $2, 'mira-laptop', $3, now())`,
      [`bench-${Date.now()}-${n}`, id, `@bench-admin bench comment ${n}`]
    );
    await db.query(`UPDATE issues SET updated_at = now() WHERE id = $1`, [id]);
  } else {
    await db.query(
      `UPDATE issues SET title = $2, updated_at = now() WHERE id = $1`,
      [id, `bench title ${n} ${Date.now()}`]
    );
  }
  await db.query(
    `INSERT INTO events (board_id, issue_id, actor, kind) VALUES ('example', $1, 'mira-laptop', $2)`,
    [id, n % 3 === 0 ? 'comment' : 'updated']
  );
  await db.query(`SELECT pg_notify('feads_events', $1)`, [
    `example:${id}:${n % 3 === 0 ? 'comment' : 'updated'}`
  ]);
  await db.query('COMMIT');
}

await scenario('write_fanout', async () => {
  const SUBSCRIBERS = 10;
  const db = new pg.Client({ connectionString: dsn });
  await db.connect();
  const ids = (
    await db.query(
      `SELECT id FROM issues WHERE board_id = 'example' AND deleted_at IS NULL
         AND status = 'open'
       ORDER BY md5(id) LIMIT 60`
    )
  ).rows.map((r) => r.id);
  /** @type {Conn[]} */
  const conns = [];
  for (let k = 0; k < SUBSCRIBERS; k += 1) {
    const c = new Conn();
    await c.open();
    await c.request('set-board', { id: 'example' });
    for (const [cid, type] of BOARD_TAB)
      await c.subscribe(cid, boardSpec(type));
    await c.subscribe('tab:issues', { type: 'all-issues' });
    conns.push(c);
  }
  // A couple of All-boards watchers too: every write fans into the aggregate.
  for (let k = 0; k < 2; k += 1) {
    const c = new Conn();
    await c.open();
    await c.request('set-board', { id: '*' });
    await c.subscribe('tab:issues', { type: 'all-issues' });
    conns.push(c);
  }
  await new Promise((r) => setTimeout(r, 500));

  /**
   * @param {number} count
   * @param {number} gap_ms
   */
  const run = async (count, gap_ms) => {
    const f0 = conns.map((c) => c.frames);
    const b0 = conns.map((c) => c.payload_bytes);
    const w0 = conns.map((c) => c.wireBytes());
    /** @type {number[]} */
    const lat = [];
    const cpu0 = cpuSeconds();
    const t_start = performance.now();
    /** @type {Promise<void>[]} */
    const pending = [];
    for (let n = 0; n < count; n += 1) {
      const id = ids[n % ids.length];
      const c = conns[0];
      const seen = new Promise((resolve) => {
        const t0 = performance.now();
        /** @type {(msg: any) => void} */
        const fn = (msg) => {
          const p = msg.payload;
          if (
            (msg.type === 'upsert' && p?.issue?.id === id) ||
            (msg.type === 'delete' && p?.issue_id === id)
          ) {
            lat.push(performance.now() - t0);
            c.listeners = c.listeners.filter((x) => x !== fn);
            resolve(undefined);
          }
        };
        c.listeners.push(fn);
        setTimeout(() => {
          c.listeners = c.listeners.filter((x) => x !== fn);
          resolve(undefined);
        }, 15000);
      });
      pending.push(/** @type {Promise<void>} */ (seen));
      await agentWrite(db, id, n);
      if (gap_ms > 0) await new Promise((r) => setTimeout(r, gap_ms));
    }
    await Promise.all(pending);
    // let trailing refreshes land
    await new Promise((r) => setTimeout(r, 1500));
    const frames = conns.reduce((s, c, i) => s + c.frames - f0[i], 0);
    const bytes = conns.reduce((s, c, i) => s + c.payload_bytes - b0[i], 0);
    const wire = conns.reduce((s, c, i) => s + c.wireBytes() - w0[i], 0);
    return summary(lat, {
      writes: count,
      delivered_pct: Math.round((lat.length / count) * 100),
      frames_per_write_per_conn:
        Math.round((frames / count / conns.length) * 10) / 10,
      payload_kb_per_write: Math.round(bytes / count / 1024),
      wire_kb_per_write: Math.round(wire / count / 1024),
      server_cpu_ms_per_write: Math.round(
        ((cpuSeconds() - cpu0) * 1000) / count
      ),
      duration_s: Math.round(performance.now() - t_start) / 1000
    });
  };
  const steady = await run(30, 150);
  const burst = await run(40, 0);
  for (const c of conns) c.close();
  await db.end();
  results.write_fanout = { subscribers: conns.length, steady, burst };
});

if (out_file) {
  fs.writeFileSync(out_file, JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
process.exit(0);
