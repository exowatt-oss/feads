/**
 * The notification export carries an issue's description only when it can hold
 * an @mention (feads-m1w): enough for the inbox to diff description mentions,
 * without moving every body on the board through every scan.
 *
 * Needs a disposable Postgres (`FEADS_PG_TEST_DSN`, schema applied); skipped
 * otherwise. Uses its own board id and removes it afterwards.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPgStore } from './pg-store.js';

const TEST_DSN = String(process.env.FEADS_PG_TEST_DSN || '').trim();
const BOARD = 'mention-export-test';

describe.skipIf(!TEST_DSN)(
  'exportIssues: description for the mention diff',
  () => {
    /** @type {pg.Client} */
    let sql;
    /** @type {ReturnType<typeof createPgStore>} */
    let store;

    async function cleanup() {
      await sql.query(
        'DELETE FROM comments WHERE issue_id IN (SELECT id FROM issues WHERE board_id = $1)',
        [BOARD]
      );
      await sql.query('DELETE FROM issues WHERE board_id = $1', [BOARD]);
      await sql.query('DELETE FROM boards WHERE id = $1', [BOARD]);
    }

    beforeAll(async () => {
      sql = new pg.Client({ connectionString: TEST_DSN });
      await sql.connect();
      await cleanup();
      await sql.query('INSERT INTO boards (id, prefix) VALUES ($1, $2)', [
        BOARD,
        'mex'
      ]);
      const insert = `INSERT INTO issues (id, board_id, title, description, status, priority, issue_type, created_by, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, 'open', 2, 'task', 'mira', now(), now())`;
      await sql.query(insert, [
        'mex-1',
        BOARD,
        'names someone',
        'cc @dana-laptop please'
      ]);
      await sql.query(insert, [
        'mex-2',
        BOARD,
        'plain body',
        'no names here at all'
      ]);
      await sql.query(insert, ['mex-3', BOARD, 'no body', null]);
      store = createPgStore({ dsn: TEST_DSN });
    });

    afterAll(async () => {
      await cleanup();
      await sql.end();
      await store?.close?.();
    });

    test('a full and a partial export carry the body only when it has an @', async () => {
      for (const rows of [
        await store.exportIssues(BOARD, { with_artifacts: true }),
        await store.exportIssues(BOARD, { ids: ['mex-1', 'mex-2', 'mex-3'] })
      ]) {
        const by_id = Object.fromEntries(
          rows.map((r) => [r.id, r.description])
        );
        expect(by_id).toEqual({
          'mex-1': 'cc @dana-laptop please',
          'mex-2': '',
          'mex-3': ''
        });
      }
    });
  }
);
