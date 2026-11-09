import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { raiseFlare, listFlares, dropFlare, LIVE_MS, FADING_MS } from './flares.mjs';

function dbStub(rows = []) {
  return {
    rows,
    prepare(sql) {
      return {
        get(...args) {
          if (sql.startsWith('SELECT id')) return rows.find(r => r.agent_id === args[0] && r.board_id === args[1] && r.issue_id === args[2]) || undefined;
          if (sql.startsWith('SELECT *')) return rows.find(r => r.id === args[0]) || undefined;
          return undefined;
        },
        all(...args) {
          const cutoff = args[0];
          let out = rows.filter(r => r.heartbeat_at > cutoff);
          if (sql.includes('board_id = ?')) out = out.filter(r => r.board_id === args[1]);
          if (sql.includes('issue_id = ?')) out = out.filter(r => r.issue_id === args[sql.includes('board_id = ?') ? 2 : 1]);
          return out;
        },
        run(...args) {
          if (sql.startsWith('DELETE FROM work_flares WHERE heartbeat_at')) {
            const before = rows.length; rows.splice(0, rows.length, ...rows.filter(r => r.heartbeat_at > args[0])); return { changes: before - rows.length };
          }
          if (sql.startsWith('DELETE')) {
            const before = rows.length;
            rows.splice(0, rows.length, ...rows.filter(r => !(r.agent_id === args[0] && r.board_id === args[1] && r.issue_id === args[2])));
            return { changes: before - rows.length };
          }
          const [id, agent_id, actor, parent_actor, board_id, issue_id, started_at, heartbeat_at] = args;
          const old = rows.find(r => r.agent_id === agent_id && r.board_id === board_id && r.issue_id === issue_id);
          if (old) Object.assign(old, { actor, parent_actor, heartbeat_at });
          else rows.push({ id, agent_id, actor, parent_actor, board_id, issue_id, started_at, heartbeat_at });
          return { changes: 1 };
        }
      };
    }
  };
}

describe('advisory work flares', () => {
  test('raise is idempotent and refreshes heartbeat without changing start', () => {
    const db = dbStub();
    const first = raiseFlare(db, { agent_id: 'a', actor: 'child', parent_actor: 'parent', board_id: 'b', issue_id: 'i', now: 1000 });
    const second = raiseFlare(db, { agent_id: 'a', actor: 'child', parent_actor: 'parent', board_id: 'b', issue_id: 'i', now: 2000 });
    assert.equal(db.rows.length, 1); assert.equal(second.started_at, first.started_at); assert.equal(second.heartbeat_at, 2000);
  });
  test('liveness is live under 45s and fading under 90s', () => {
    const db = dbStub();
    raiseFlare(db, { agent_id: 'a', actor: 'x', board_id: 'b', issue_id: 'i', now: 0 });
    assert.equal(listFlares(db, { now: LIVE_MS - 1 })[0].liveness, 'live');
    assert.equal(listFlares(db, { now: FADING_MS - 1 })[0].liveness, 'fading');
  });
  test('expired rows are lazily purged and filters apply', () => {
    const db = dbStub();
    raiseFlare(db, { agent_id: 'a', actor: 'x', board_id: 'b', issue_id: 'i', now: 0 });
    raiseFlare(db, { agent_id: 'c', actor: 'y', board_id: 'other', issue_id: 'j', now: 100000 });
    assert.equal(listFlares(db, { board_id: 'b', issue_id: 'i', now: 100000 }).length, 0);
    assert.equal(db.rows.length, 1);
  });
  test('drop removes the caller flare', () => {
    const db = dbStub();
    raiseFlare(db, { agent_id: 'a', actor: 'x', board_id: 'b', issue_id: 'i', now: 1 });
    assert.equal(dropFlare(db, { agent_id: 'a', board_id: 'b', issue_id: 'i' }), true);
    assert.equal(db.rows.length, 0);
  });
});
