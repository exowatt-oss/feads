#!/usr/bin/env node
/**
 * Register a board in the Postgres store: insert its `boards` row so the
 * pg data layer will answer for it. This is what makes a freshly-created
 * (empty) board visible to the dashboard and MCP in pg mode — without it,
 * every read fails loudly with unknown_board (by design: answering with an
 * empty board for a directory whose issues live elsewhere would be a quiet
 * wrong answer; see the 2026-07-31 example-project/it incident).
 *
 * Usage: node register-board.mjs --dsn <dsn> <board_id> [--prefix <p>]
 *
 * ON CONFLICT DO NOTHING on purpose: an existing row's prefix is already
 * minting issue ids and must never be clobbered by a re-run.
 */
import pg from 'pg';

const args = process.argv.slice(2);
const dsn_idx = args.indexOf('--dsn');
const prefix_idx = args.indexOf('--prefix');
const positional = args.filter(
  (a, i) =>
    !a.startsWith('--') && i !== dsn_idx + 1 && i !== prefix_idx + 1
);
const dsn = dsn_idx === -1 ? '' : args[dsn_idx + 1] || '';
const board_id = String(positional[0] || '').trim();
if (!dsn || !board_id) {
  console.error('usage: register-board.mjs --dsn <dsn> <board_id> [--prefix <p>]');
  process.exit(2);
}
const prefix =
  (prefix_idx === -1 ? '' : String(args[prefix_idx + 1] || '').trim()) ||
  board_id;

const client = new pg.Client({ connectionString: dsn });
await client.connect();
try {
  const res = await client.query(
    `INSERT INTO boards (id, prefix) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, prefix`,
    [board_id, prefix]
  );
  if (res.rowCount === 1) {
    console.log(JSON.stringify({ registered: true, id: board_id, prefix }));
  } else {
    const existing = await client.query(
      'SELECT id, prefix FROM boards WHERE id = $1',
      [board_id]
    );
    console.log(
      JSON.stringify({ registered: false, existing: existing.rows[0] || null })
    );
  }
} finally {
  await client.end();
}
