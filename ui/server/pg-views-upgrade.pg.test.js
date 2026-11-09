/**
 * `pgstore/views.sql` must re-apply cleanly to a database whose `issues` table
 * gained a column after the views were created.
 *
 * The silo manager re-applies `schema.sql` then `views.sql` on every silo boot.
 * When `schema.sql` started adding `issues.claim_label`, `CREATE OR REPLACE VIEW
 * blocked_issues AS SELECT i.*, …` failed on existing silo databases ("cannot
 * change name of view column blocked_by_count to claim_label"), and the silo
 * could not boot (2026-10-06 ship). This replays that upgrade in a private
 * schema of a disposable database:
 *
 *   FEADS_PG_ACCOUNTS_DSN=postgresql://127.0.0.1:5433/<disposable db> \
 *     npx vitest run server/pg-views-upgrade.pg.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const DSN = String(
  process.env.FEADS_PG_ACCOUNTS_DSN || process.env.FEADS_PG_CONF_DSN || ''
).trim();
const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(
  path.join(here, '../../pgstore/schema.sql'),
  'utf8'
);
const VIEWS_SQL = fs.readFileSync(
  path.join(here, '../../pgstore/views.sql'),
  'utf8'
);
const SCHEMA = `views_upgrade_${process.pid}`;

describe.skipIf(!DSN)('views.sql on an upgraded issues table', () => {
  /** @type {pg.Client} */
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  /**
   * @param {string} view
   * @returns {Promise<string[]>}
   */
  async function columns(view) {
    const res = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [SCHEMA, view]
    );
    return res.rows.map((r) => String(r.column_name));
  }

  test('views built before claim_label are rebuilt, then re-apply as a no-op', async () => {
    // The pre-claim_label shape: the table without the column, views over it.
    await client.query(SCHEMA_SQL);
    await client.query('ALTER TABLE issues DROP COLUMN claim_label');
    await client.query(VIEWS_SQL);
    expect(await columns('blocked_issues')).not.toContain('claim_label');
    await client.query(
      `INSERT INTO boards (id, prefix) VALUES ('vu', 'vu');
       INSERT INTO issues (id, board_id, title, status, issue_type, priority, created_at, updated_at)
       VALUES ('vu-1', 'vu', 'blocked', 'open', 'task', 2, now(), now()),
              ('vu-2', 'vu', 'epic', 'open', 'epic', 2, now(), now());
       INSERT INTO deps (issue_id, depends_on_id, dep_type) VALUES ('vu-1', 'vu-2', 'blocks');`
    );

    // What the silo manager does on boot after the upgrade.
    await client.query(SCHEMA_SQL);
    await client.query(VIEWS_SQL);
    await client.query(VIEWS_SQL);

    for (const view of ['ready_issues', 'blocked_issues', 'epic_status']) {
      expect(await columns(view)).toContain('claim_label');
    }
    const blocked = await columns('blocked_issues');
    expect(blocked.slice(-2)).toEqual(['blocked_by_count', 'blocked_by']);
    const rows = await client.query(
      'SELECT id, blocked_by_count FROM blocked_issues'
    );
    expect(rows.rows).toEqual([{ id: 'vu-1', blocked_by_count: '1' }]);
    const epics = await client.query('SELECT id FROM epic_status');
    expect(epics.rows.map((r) => r.id)).toEqual(['vu-2']);
  });
});
