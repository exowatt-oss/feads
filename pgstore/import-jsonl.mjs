#!/usr/bin/env node
/**
 * Import `bd export` JSONL files into the pgstore schema.
 *
 * Usage:
 *   node import-jsonl.mjs --dsn postgres://... [--wipe] <board_id>=<file.jsonl> ...
 *
 * Ids and timestamps are imported verbatim — same rule as `bd import
 * --allow-stale` (plain import skips same-updated_at rows; we must not).
 * Idempotent: rows upsert on conflict. Deps whose issue_id is missing are
 * skipped with a warning (dangling depends_on_id is kept — it is data).
 */
import fs from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const dsn_idx = args.indexOf('--dsn');
if (dsn_idx === -1 || !args[dsn_idx + 1]) {
  console.error('missing --dsn');
  process.exit(2);
}
const dsn = args[dsn_idx + 1];
const wipe = args.includes('--wipe');
// Skip the --dsn VALUE by position, not just by shape: a unix-socket DSN
// ("...?host=/var/run/postgresql") contains '=' and would otherwise parse as
// a board spec whose file is a directory (found the hard way at cutover).
const board_args = args.filter(
  (a, i) => i !== dsn_idx + 1 && a.includes('=') && !a.startsWith('--')
);
if (board_args.length === 0) {
  console.error('no <board_id>=<file.jsonl> args');
  process.exit(2);
}

/** @param {string} id */
function prefixOf(id) {
  const i = id.lastIndexOf('-');
  return i > 0 ? id.slice(0, i) : id;
}

const client = new pg.Client({ connectionString: dsn });
await client.connect();

try {
  for (const spec of board_args) {
    const eq = spec.indexOf('=');
    const board_id = spec.slice(0, eq);
    const file = spec.slice(eq + 1);
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const issues = lines
      .map((l) => JSON.parse(l))
      .filter((r) => r._type === 'issue');
    if (issues.length === 0) {
      // An empty board is still a board: without its row the pg store refuses
      // every read for it (unknown_board). Prefix falls back to the board id —
      // there are no issue ids to derive it from (the 'it' board, 2026-07-31).
      await client.query(
        `INSERT INTO boards (id, prefix) VALUES ($1, $1)
         ON CONFLICT (id) DO NOTHING`,
        [board_id]
      );
      console.warn(`${board_id}: no issues in ${file} — board registered, nothing to import`);
      continue;
    }

    // Majority id prefix — guards against a fixture filed under the wrong board.
    const counts = new Map();
    for (const it of issues) {
      const p = prefixOf(String(it.id));
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    const prefix = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    await client.query('BEGIN');
    if (wipe) {
      await client.query('DELETE FROM issues WHERE board_id = $1', [board_id]);
    }
    await client.query(
      `INSERT INTO boards (id, prefix) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET prefix = EXCLUDED.prefix`,
      [board_id, prefix]
    );

    let n_comments = 0;
    let n_deps = 0;
    let n_labels = 0;
    for (const it of issues) {
      await client.query(
        `INSERT INTO issues (id, board_id, title, description, design,
           acceptance_criteria, notes, close_reason, status, issue_type,
           priority, assignee, owner, created_by, external_ref, metadata,
           created_at, updated_at, closed_at, started_at, deleted_at,
           lease_expires_at, heartbeat_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (id) DO UPDATE SET
           board_id = EXCLUDED.board_id, title = EXCLUDED.title,
           description = EXCLUDED.description, design = EXCLUDED.design,
           acceptance_criteria = EXCLUDED.acceptance_criteria,
           notes = EXCLUDED.notes, close_reason = EXCLUDED.close_reason,
           status = EXCLUDED.status, issue_type = EXCLUDED.issue_type,
           priority = EXCLUDED.priority, assignee = EXCLUDED.assignee,
           owner = EXCLUDED.owner, created_by = EXCLUDED.created_by,
           external_ref = EXCLUDED.external_ref, metadata = EXCLUDED.metadata,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           closed_at = EXCLUDED.closed_at, started_at = EXCLUDED.started_at,
           deleted_at = EXCLUDED.deleted_at,
           lease_expires_at = EXCLUDED.lease_expires_at,
           heartbeat_at = EXCLUDED.heartbeat_at`,
        [
          it.id,
          board_id,
          it.title || '',
          it.description ?? null,
          it.design ?? null,
          it.acceptance_criteria ?? null,
          it.notes ?? null,
          it.close_reason ?? null,
          it.status || 'open',
          it.issue_type || 'task',
          Number.isFinite(it.priority) ? it.priority : 2,
          it.assignee ?? null,
          it.owner ?? null,
          it.created_by ?? null,
          it.external_ref ?? null,
          JSON.stringify(parseMaybeJson(it.metadata) ?? {}),
          it.created_at,
          it.updated_at,
          it.closed_at ?? null,
          it.started_at ?? null,
          it.deleted_at ?? null,
          it.lease_expires_at ?? null,
          it.heartbeat_at ?? null
        ]
      );
      for (const label of it.labels || []) {
        await client.query(
          `INSERT INTO labels (issue_id, label) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [it.id, label]
        );
        n_labels++;
      }
      for (const c of it.comments || []) {
        await client.query(
          `INSERT INTO comments (id, issue_id, author, body, created_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body`,
          [c.id, it.id, c.author ?? null, c.text ?? '', c.created_at]
        );
        n_comments++;
      }
    }
    // Deps second pass: every issue row exists by now.
    for (const it of issues) {
      for (const d of it.dependencies || []) {
        await client.query(
          `INSERT INTO deps (issue_id, depends_on_id, dep_type, created_at,
             created_by, metadata)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [
            d.issue_id || it.id,
            d.depends_on_id,
            d.type || d.dep_type || 'blocks',
            d.created_at ?? null,
            d.created_by ?? null,
            JSON.stringify(parseMaybeJson(d.metadata) ?? {})
          ]
        );
        n_deps++;
      }
    }
    await client.query('COMMIT');
    console.log(
      `${board_id}: ${issues.length} issues, ${n_deps} deps, ` +
        `${n_comments} comments, ${n_labels} labels (prefix=${prefix})`
    );
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await client.end();
}

/** @param {unknown} v */
function parseMaybeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}
