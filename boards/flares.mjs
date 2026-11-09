/** Ephemeral advisory work presence ("flares"). Never a lock or authorization input. */
import crypto from 'node:crypto';

export const LIVE_MS = 45_000;
export const FADING_MS = 90_000;

const id = () => `fl_${crypto.randomBytes(8).toString('hex')}`;

function rowShape(row, now = Date.now()) {
  const age = Math.max(0, now - Number(row.heartbeat_at));
  return { ...row, liveness: age < LIVE_MS ? 'live' : age < FADING_MS ? 'fading' : 'expired' };
}

/** Raise or refresh an agent's advisory presence on an issue. */
export function raiseFlare(db, { agent_id, actor, parent_actor = '', board_id, issue_id, now = Date.now() }) {
  const existing = db.prepare('SELECT id, started_at FROM work_flares WHERE agent_id = ? AND board_id = ? AND issue_id = ?').get(agent_id, board_id, issue_id);
  const flare_id = existing?.id || id();
  const started_at = Number(existing?.started_at || now);
  db.prepare(`INSERT INTO work_flares (id, agent_id, actor, parent_actor, board_id, issue_id, started_at, heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, board_id, issue_id) DO UPDATE SET actor=excluded.actor, parent_actor=excluded.parent_actor, heartbeat_at=excluded.heartbeat_at`).run(flare_id, agent_id, actor, parent_actor, board_id, issue_id, started_at, now);
  return rowShape(db.prepare('SELECT * FROM work_flares WHERE id = ?').get(flare_id), now);
}

export const heartbeat = raiseFlare;

export function dropFlare(db, { agent_id, board_id, issue_id, flare_id = '' }) {
  const result = flare_id
    ? db.prepare('DELETE FROM work_flares WHERE id = ? AND agent_id = ?').run(flare_id, agent_id)
    : db.prepare('DELETE FROM work_flares WHERE agent_id = ? AND board_id = ? AND issue_id = ?').run(agent_id, board_id, issue_id);
  return Number(result.changes || 0) > 0;
}

/** List advisory presence; expired rows are lazily purged at read time. */
export function listFlares(db, { board_id = '', issue_id = '', now = Date.now() } = {}) {
  db.prepare('DELETE FROM work_flares WHERE heartbeat_at <= ?').run(now - FADING_MS);
  let sql = 'SELECT * FROM work_flares WHERE heartbeat_at > ?';
  const args = [now - FADING_MS];
  if (board_id) { sql += ' AND board_id = ?'; args.push(board_id); }
  if (issue_id) { sql += ' AND issue_id = ?'; args.push(issue_id); }
  sql += ' ORDER BY heartbeat_at DESC';
  return db.prepare(sql).all(...args).map((row) => rowShape(row, now));
}

export function flareById(db, flare_id) {
  const row = db.prepare('SELECT * FROM work_flares WHERE id = ?').get(flare_id);
  return row ? rowShape(row) : null;
}
