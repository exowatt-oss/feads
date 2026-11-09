#!/usr/bin/env node
/**
 * Parity harness: compare pgstore query results against golden `bd` outputs
 * captured from the live boards. This locks the SQL semantics (ready/blocked/
 * epics/default-list) to bd's before anything is cut over.
 *
 * Usage:
 *   node parity.mjs --dsn postgres://... --fixtures <dir> <board_id> ...
 *
 * Expects per board in <dir>: <board>.golden-list.json, <board>.golden-ready.json,
 * <board>.golden-blocked.json, <board>.golden-epics.json
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const dsn = argOf('--dsn');
const fixtures = argOf('--fixtures');
const boards = args.filter((a) => !a.startsWith('--') && a !== dsn && a !== fixtures);
if (!dsn || !fixtures || boards.length === 0) {
  console.error('usage: parity.mjs --dsn <dsn> --fixtures <dir> <board_id> ...');
  process.exit(2);
}

const client = new pg.Client({ connectionString: dsn });
await client.connect();
let failures = 0;

for (const board of boards) {
  const golden = (name) =>
    JSON.parse(fs.readFileSync(path.join(fixtures, `${board}.golden-${name}.json`), 'utf8'));

  // --- default list: bd list --json --tree=false --limit 0 — everything not
  // closed and not tombstoned (deferred included; verified vs live goldens).
  {
    const g = golden('list');
    const r = await client.query(
      `SELECT id, status, priority, issue_type, title, assignee
       FROM issues WHERE board_id = $1 AND deleted_at IS NULL
         AND status <> 'closed'`,
      [board]
    );
    compareSets(board, 'list', g, r.rows);
    compareFields(board, 'list', g, r.rows, ['status', 'priority', 'issue_type', 'title']);
  }

  // --- ready
  {
    const g = golden('ready');
    const r = await client.query(
      `SELECT id, status, issue_type FROM ready_issues WHERE board_id = $1`,
      [board]
    );
    compareSets(board, 'ready', g, r.rows);
  }

  // --- blocked (+ blocker sets)
  {
    const g = golden('blocked');
    const r = await client.query(
      `SELECT id, blocked_by FROM blocked_issues WHERE board_id = $1`,
      [board]
    );
    compareSets(board, 'blocked', g, r.rows);
    const pg_by = new Map(r.rows.map((x) => [x.id, blockerIds(x.blocked_by)]));
    for (const row of g) {
      const want = blockerIds(row.blocked_by ?? row.blockers ?? row.blocked_by_ids);
      const got = pg_by.get(row.id) || [];
      if (want.length && JSON.stringify(want) !== JSON.stringify(got)) {
        fail(board, 'blocked', `${row.id} blockers: bd=[${want}] pg=[${got}]`);
      }
    }
  }

  // --- epics: bd epic status --json ({epic:{...}, total_children, closed_children, eligible_for_close})
  {
    const g = golden('epics');
    const g_rows = g.map((x) => ({
      id: x.epic.id,
      total_children: x.total_children,
      closed_children: x.closed_children,
      eligible_for_close: x.eligible_for_close
    }));
    const r = await client.query(
      `SELECT id, total_children::int, closed_children::int, eligible_for_close
       FROM epic_status WHERE board_id = $1`,
      [board]
    );
    compareSets(board, 'epics', g_rows, r.rows);
    const by_id = new Map(r.rows.map((x) => [x.id, x]));
    for (const w of g_rows) {
      const got = by_id.get(w.id);
      if (!got) continue;
      for (const f of ['total_children', 'closed_children', 'eligible_for_close']) {
        if (String(got[f]) !== String(w[f])) {
          fail(board, 'epics', `${w.id}.${f}: bd=${w[f]} pg=${got[f]}`);
        }
      }
    }
  }
}

await client.end();
if (failures > 0) {
  console.error(`\nPARITY FAILED: ${failures} mismatch(es)`);
  process.exit(1);
}
console.log('\nPARITY OK');

function argOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

function blockerIds(v) {
  if (!Array.isArray(v)) return [];
  return v.map((b) => (typeof b === 'string' ? b : b.id)).sort();
}

function compareSets(board, name, golden_rows, pg_rows) {
  const g = new Set(golden_rows.map((x) => x.id));
  const p = new Set(pg_rows.map((x) => x.id));
  const missing = [...g].filter((id) => !p.has(id));
  const extra = [...p].filter((id) => !g.has(id));
  if (missing.length || extra.length) {
    fail(board, name, `id sets differ — missing from pg: [${missing}] extra in pg: [${extra}]`);
  } else {
    console.log(`ok   ${board}/${name}: ${g.size} rows match`);
  }
}

function compareFields(board, name, golden_rows, pg_rows, fields) {
  const by_id = new Map(pg_rows.map((x) => [x.id, x]));
  for (const w of golden_rows) {
    const got = by_id.get(w.id);
    if (!got) continue;
    for (const f of fields) {
      const a = w[f] ?? null;
      const b = got[f] ?? null;
      if (String(a) !== String(b)) {
        fail(board, name, `${w.id}.${f}: bd=${JSON.stringify(a)} pg=${JSON.stringify(b)}`);
      }
    }
  }
}

function fail(board, name, msg) {
  failures++;
  console.error(`FAIL ${board}/${name}: ${msg}`);
}
