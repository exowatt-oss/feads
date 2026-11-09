#!/usr/bin/env node
/**
 * Seed a disposable feads instance at realistic hosted volume, for the perf
 * harness in `feads-bench.js`.
 *
 * Writes three things, all of them throwaway:
 *   - a Postgres database (schema.sql + views.sql + every migration in
 *     pgstore/migrations, then issues/comments/deps/labels/events);
 *   - a SQLite registry (boards, agents, notifications) at --registry;
 *   - empty `<boards-root>/<id>/.beads` directories, because the dashboard
 *     resolves a board by its directory even in Postgres mode.
 *
 * Deterministic for a given --seed, so a before/after comparison measures the
 * code and not the data.
 *
 * Usage:
 *   node scripts/bench/seed-bench.js --dsn postgres://127.0.0.1:5433/feads_bench_x \
 *     --registry /tmp/feads-bench/registry.db --boards-root /tmp/feads-bench/boards \
 *     [--scale 1] [--seed 42] [--token-file /tmp/feads-bench/token]
 *
 * Never point --dsn at a database you care about: the schema is applied with
 * IF NOT EXISTS, but rows are inserted unconditionally.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : String(process.argv[i + 1] || fallback);
}

const dsn = arg('dsn');
const registry_path = arg('registry');
const boards_root = arg('boards-root');
const scale = Number(arg('scale', '1')) || 1;
const token_file = arg('token-file');
let rng_state = Number(arg('seed', '42')) >>> 0 || 42;

if (!dsn || !registry_path || !boards_root) {
  console.error(
    'usage: seed-bench.js --dsn <dsn> --registry <file> --boards-root <dir>'
  );
  process.exit(2);
}

/** Mulberry32 — tiny, deterministic, good enough for fixtures. */
function rand() {
  rng_state = (rng_state + 0x6d2b79f5) >>> 0;
  let t = rng_state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * @template T
 * @param {T[]} xs
 * @returns {T}
 */
function pick(xs) {
  return xs[Math.floor(rand() * xs.length)];
}

/**
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function int(lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

const WORDS = (
  'board agent claim artifact dashboard socket snapshot latency index ' +
  'migration export dependency epic story review deploy rollback silo ' +
  'telemetry inverter battery dispatch controller schema postgres cache ' +
  'refresh render subscribe notify mention blocker handoff coordinate ' +
  'pipeline runner feed registry token session runtime presence flare'
).split(' ');

/**
 * @param {number} n
 * @returns {string}
 */
function prose(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(pick(WORDS));
  return out.join(' ');
}

/** Boards: one big catch-all, a few busy ones, a long tail. */
const BOARDS = [
  ['demo', 'dm', 2600],
  ['issues', 'is', 1200],
  ['catalog', 'cat', 800],
  ['garden', 'gar', 420],
  ['research', 'rs', 380],
  ['design', 'ds', 340],
  ['operations', 'op', 300],
  ['testing', 'test', 260],
  ['support', 'sup', 220],
  ['documentation', 'docs', 180],
  ['integrations', 'int', 150],
  ['metrics', 'met', 120],
  ['releases', 'rel', 100],
  ['backend', 'be', 80],
  ['frontend', 'fe', 60]
].map(([id, prefix, n]) => ({
  id: String(id),
  prefix: String(prefix),
  n: Math.max(5, Math.round(Number(n) * scale))
}));

const PEOPLE = [
  'mira',
  'bob',
  'carol',
  'dana',
  'jules',
  'eve',
  'finn',
  'maria',
  'jon',
  'priya',
  'li',
  'sam'
];
const DEVICES = ['laptop', 'mbp', 'devbox', 'ci', 'desktop'];
/** @type {string[]} */
const ACTORS = [];
for (const p of PEOPLE) {
  for (const d of DEVICES) ACTORS.push(`${p}-${d}`);
}
ACTORS.push('bench-admin');

const REPOS = [
  'example-org/demo',
  'example-org/client',
  'example-org/api',
  'example-org/worker',
  'example-org/docs'
];
const DIRS = ['ui/server/', 'ui/app/views/', 'cmd/bd/', 'internal/', 'docs/'];

const STATUSES = () => {
  const r = rand();
  if (r < 0.74) return 'closed';
  if (r < 0.9) return 'open';
  return 'in_progress';
};
const TYPES = () => {
  const r = rand();
  if (r < 0.08) return 'epic';
  if (r < 0.63) return 'task';
  if (r < 0.78) return 'bug';
  if (r < 0.9) return 'feature';
  return 'chore';
};

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 86400000;

/**
 * @param {pg.Client} client
 * @param {string} table
 * @param {string[]} cols
 * @param {string[]} types
 * @param {unknown[][]} rows
 */
async function bulk(client, table, cols, types, rows) {
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const arrays = cols.map((_, c) => chunk.map((r) => r[c]));
    const sel = cols
      .map((col, c) => `unnest($${c + 1}::${types[c]}[]) AS ${col}`)
      .join(', ');
    await client.query(
      `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${sel}`,
      arrays
    );
  }
}

async function seedPostgres() {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query(
      fs.readFileSync(path.join(repo, 'pgstore/schema.sql'), 'utf8')
    );
    await client.query(
      fs.readFileSync(path.join(repo, 'pgstore/views.sql'), 'utf8')
    );
    const mig_dir = path.join(repo, 'pgstore/migrations');
    if (fs.existsSync(mig_dir) && process.env.BENCH_SKIP_MIGRATIONS !== '1') {
      for (const f of fs.readdirSync(mig_dir).sort()) {
        if (f.endsWith('.sql')) {
          // One statement at a time: CREATE INDEX CONCURRENTLY refuses to run
          // inside the implicit transaction of a multi-statement query.
          const sql = fs
            .readFileSync(path.join(mig_dir, f), 'utf8')
            .replace(/^\s*--.*$/gm, '');
          for (const stmt of sql.split(';')) {
            if (stmt.trim().length > 0) await client.query(stmt);
          }
        }
      }
    }

    /** @type {unknown[][]} */ const issues = [];
    /** @type {unknown[][]} */ const comments = [];
    /** @type {unknown[][]} */ const deps = [];
    /** @type {unknown[][]} */ const labels = [];
    /** @type {unknown[][]} */ const events = [];

    for (const board of BOARDS) {
      await client.query('INSERT INTO boards (id, prefix) VALUES ($1, $2)', [
        board.id,
        board.prefix
      ]);
      /** @type {string[]} */ const epics = [];
      /** @type {string[]} */ const ids = [];
      for (let k = 0; k < board.n; k += 1) {
        const id = `${board.prefix}-${k.toString(36).padStart(3, '0')}`;
        ids.push(id);
        const type = TYPES();
        if (type === 'epic') epics.push(id);
        const status = STATUSES();
        const created = NOW - int(1, 120) * DAY - int(0, DAY);
        const updated = Math.min(NOW, created + int(0, 30) * DAY);
        const assignee = rand() < 0.8 ? pick(ACTORS) : null;
        const created_by = pick(ACTORS);
        /** @type {Record<string, unknown>} */
        const metadata = {};
        if (rand() < 0.22) {
          metadata.has_artifacts = true;
          const repo_name = pick(REPOS);
          for (let a = 0; a < int(1, 4); a += 1) {
            const p = `${pick(DIRS)}${pick(WORDS)}.js`;
            metadata[`artifact:${repo_name}:${p}`] = {
              kind: 'file',
              repo: repo_name,
              path: p,
              intent: pick(['editing', 'reading', 'reviewing']),
              actor: assignee || created_by,
              at: new Date(updated).toISOString()
            };
          }
        }
        issues.push([
          id,
          board.id,
          `${prose(int(3, 9))}`.slice(0, 120),
          prose(int(30, 400)),
          rand() < 0.2 ? prose(int(20, 200)) : null,
          rand() < 0.4 ? prose(int(10, 80)) : null,
          rand() < 0.3 ? prose(int(10, 120)) : null,
          status === 'closed' ? prose(int(2, 12)) : null,
          status,
          type,
          int(0, 4),
          assignee,
          null,
          created_by,
          null,
          JSON.stringify(metadata),
          new Date(created).toISOString(),
          new Date(updated).toISOString(),
          status === 'closed' ? new Date(updated).toISOString() : null,
          status !== 'open' ? new Date(created + DAY).toISOString() : null,
          rand() < 0.01 ? new Date(updated).toISOString() : null
        ]);
        const n_comments = rand() < 0.3 ? 0 : int(1, 9);
        for (let c = 0; c < n_comments; c += 1) {
          const author = pick(ACTORS);
          const mention = rand() < 0.15 ? `@${pick(ACTORS)} ` : '';
          comments.push([
            `c-${id}-${c}`,
            id,
            author,
            `${mention}${prose(int(8, 140))}`,
            new Date(created + (c + 1) * 3600000).toISOString()
          ]);
        }
        const issue_labels = new Set();
        for (let l = 0; l < int(0, 3); l += 1) {
          issue_labels.add(`area:${pick(WORDS)}`);
        }
        for (const label of issue_labels) labels.push([id, label]);
        for (let e = 0; e < int(3, 14); e += 1) {
          events.push([
            board.id,
            id,
            pick(ACTORS),
            pick(['created', 'updated', 'status', 'comment', 'claimed']),
            new Date(created + e * 60000).toISOString()
          ]);
        }
      }
      const dep_seen = new Set();
      /**
       * @param {string} a
       * @param {string} b
       * @param {string} t
       */
      const addDep = (a, b, t) => {
        const k = `${a}|${b}|${t}`;
        if (a === b || dep_seen.has(k)) return;
        dep_seen.add(k);
        deps.push([a, b, t, new Date(NOW - int(1, 60) * DAY).toISOString()]);
      };
      for (const id of ids) {
        if (epics.length > 0 && !epics.includes(id) && rand() < 0.55) {
          addDep(id, pick(epics), 'parent-child');
        }
        if (rand() < 0.12) addDep(id, pick(ids), 'blocks');
        if (rand() < 0.04) addDep(id, pick(ids), 'related');
      }
    }

    await bulk(
      client,
      'issues',
      [
        'id',
        'board_id',
        'title',
        'description',
        'design',
        'acceptance_criteria',
        'notes',
        'close_reason',
        'status',
        'issue_type',
        'priority',
        'assignee',
        'owner',
        'created_by',
        'external_ref',
        'metadata',
        'created_at',
        'updated_at',
        'closed_at',
        'started_at',
        'deleted_at'
      ],
      [
        'text',
        'text',
        'text',
        'text',
        'text',
        'text',
        'text',
        'text',
        'text',
        'text',
        'int',
        'text',
        'text',
        'text',
        'text',
        'jsonb',
        'timestamptz',
        'timestamptz',
        'timestamptz',
        'timestamptz',
        'timestamptz'
      ],
      issues
    );
    await bulk(
      client,
      'comments',
      ['id', 'issue_id', 'author', 'body', 'created_at'],
      ['text', 'text', 'text', 'text', 'timestamptz'],
      comments
    );
    await bulk(
      client,
      'deps',
      ['issue_id', 'depends_on_id', 'dep_type', 'created_at'],
      ['text', 'text', 'text', 'timestamptz'],
      deps
    );
    await bulk(
      client,
      'labels',
      ['issue_id', 'label'],
      ['text', 'text'],
      labels
    );
    await bulk(
      client,
      'events',
      ['board_id', 'issue_id', 'actor', 'kind', 'at'],
      ['text', 'text', 'text', 'text', 'timestamptz'],
      events
    );
    await client.query('ANALYZE');
    return {
      issues: issues.length,
      comments: comments.length,
      deps: deps.length,
      labels: labels.length,
      events: events.length
    };
  } finally {
    await client.end();
  }
}

async function seedRegistry() {
  fs.mkdirSync(path.dirname(registry_path), { recursive: true });
  for (const f of [
    registry_path,
    `${registry_path}-wal`,
    `${registry_path}-shm`
  ]) {
    fs.rmSync(f, { force: true });
  }
  process.env.FEADS_REGISTRY_DB = registry_path;
  const { openRegistry } = await import(path.join(repo, 'boards/registry.mjs'));
  const db = openRegistry();
  const now = Date.now();
  const insBoard = db.prepare(
    `INSERT INTO boards (id, name, board_dir, workspace_dir, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const board of BOARDS) {
    const workspace = path.join(boards_root, board.id);
    const board_dir = path.join(workspace, '.beads');
    fs.mkdirSync(board_dir, { recursive: true });
    insBoard.run(
      board.id,
      board.id,
      board_dir,
      workspace,
      `${board.id} — ${prose(12)}`,
      now,
      now
    );
  }
  const token = `fdsa_${crypto.randomBytes(16).toString('hex')}`;
  const insAgent = db.prepare(
    `INSERT INTO agents (id, board_id, actor, display_name, role, token_hash, kind,
       registered_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const actor of ACTORS) {
    const t =
      actor === 'bench-admin'
        ? token
        : `fdsa_${crypto.randomBytes(16).toString('hex')}`;
    insAgent.run(
      `ag_${crypto.randomBytes(6).toString('hex')}`,
      'example',
      actor,
      actor,
      actor === 'bench-admin' ? 'admin' : 'user',
      crypto.createHash('sha256').update(t, 'utf8').digest('hex'),
      'agent',
      now - 30 * DAY,
      now - int(0, 3) * DAY
    );
  }
  const insNotif = db.prepare(
    `INSERT INTO notifications (id, board_id, recipient_actor, type, issue_id,
       issue_title, actor, snippet, related_issue, created_at, read_at, handled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const n_notifs = Math.round(24000 * scale);
  db.exec('BEGIN');
  for (let i = 0; i < n_notifs; i += 1) {
    const board = pick(BOARDS);
    const created = now - int(0, 60) * DAY;
    const read = rand() < 0.7 ? created + 1000 : 0;
    insNotif.run(
      `n_${crypto.randomUUID()}`,
      board.id,
      i % 7 === 0 ? 'bench-admin' : pick(ACTORS),
      pick([
        'mention',
        'assigned',
        'comment_on_owned',
        'update_on_commented',
        'dependency_completed'
      ]),
      `${board.prefix}-${int(0, board.n - 1)
        .toString(36)
        .padStart(3, '0')}`,
      prose(5),
      pick(ACTORS),
      prose(20),
      '',
      created,
      read,
      read && rand() < 0.5 ? read : 0
    );
  }
  db.exec('COMMIT');
  db.close();
  if (token_file) {
    fs.writeFileSync(token_file, token, { mode: 0o600 });
  }
  return { agents: ACTORS.length, notifications: n_notifs };
}

const t0 = Date.now();
const pg_counts = await seedPostgres();
const reg_counts = await seedRegistry();
console.log(
  JSON.stringify({
    boards: BOARDS.length,
    ...pg_counts,
    ...reg_counts,
    seconds: (Date.now() - t0) / 1000
  })
);
