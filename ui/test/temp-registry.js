/**
 * A **real** feads registry in a temp directory, for the tests that must
 * exercise real resolution.
 *
 * The counterpart to `fake-agent-registry.js`, and the division matters. The
 * fake *stubs* resolution: a test says "resolution yielded this agent" and gets
 * on with asserting what the UI does about it. Nothing may assert the resolution
 * contract against a stub, because a stub that mirrors the contract passes
 * whether or not `boards/agents.mjs` still agrees with it — which is precisely
 * the drift the `resolution_cases` fixture exists to catch.
 *
 * So this builds an actual SQLite registry, mints actual invites, registers
 * actual agents and revokes one, then points `FEADS_REGISTRY_DB` at it so
 * `identity.js` loads the real `boards/` modules and runs the real
 * `resolveAgentIdentity`.
 *
 * `FEADS_REGISTRY_DB` is process-wide, so `cleanup()` restores it. Vitest runs
 * each test file in its own environment, so the override cannot leak sideways
 * into another suite.
 */
/* global process */
// `test/` gets no Node globals from eslint.config.js — see the same declaration
// in setup-vitest.js for `console`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {Object} TempRegistry
 * @property {string} path - The registry database.
 * @property {string} board_id
 * @property {string} other_board_id - A second board, for asserting that
 * resolution is not scoped to whichever board is on screen.
 * @property {string} valid_token - Verifies, belongs to a live `user`.
 * @property {string} revoked_token - Was valid; its agent is now revoked.
 * @property {string} invalid_token - Well-formed and never minted.
 * @property {string} malformed_token - Wrong prefix entirely.
 * @property {string} live_session
 * @property {string} revoked_session
 * @property {string} unknown_session
 * @property {string} other_board_session - Session of an agent registered
 * against `other_board_id`.
 * @property {Record<string, any>} live_agent
 * @property {() => void} cleanup
 */

/**
 * @returns {Promise<TempRegistry>}
 */
export async function createTempRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feads-ui-real-registry-'));
  const db_path = path.join(dir, 'registry.db');
  const previous = process.env.FEADS_REGISTRY_DB;
  process.env.FEADS_REGISTRY_DB = db_path;

  const registry = await import('../../boards/registry.mjs');
  const agents = await import('../../boards/agents.mjs');

  const db = registry.openRegistry();
  registry.upsertBoard(db, {
    id: 'example',
    name: 'example',
    board_dir: path.join(dir, 'example', '.beads')
  });
  registry.upsertBoard(db, {
    id: 'other-board',
    name: 'Other Board',
    board_dir: path.join(dir, 'other', '.beads')
  });

  /**
   * @param {string} board_id
   * @param {string} actor
   * @param {string} role
   * @param {string} session_id
   */
  function enroll(board_id, actor, role, session_id) {
    const invite = agents.createInvite(db, { board_id, actor, role });
    return agents.registerAgent(db, {
      token: invite.token,
      session_id,
      host: 'test-host',
      workspace_dir: dir
    });
  }

  const live = enroll('example', 'live-agent', 'user', 'sess-live');
  const doomed = enroll('example', 'doomed-agent', 'admin', 'sess-revoked');
  const elsewhere = enroll(
    'other-board',
    'other-board-agent',
    'user',
    'sess-other-board'
  );
  agents.revokeAgent(db, doomed.agent.id, 'session ended');
  db.close();

  return {
    path: db_path,
    board_id: 'example',
    other_board_id: 'other-board',
    valid_token: live.token,
    revoked_token: doomed.token,
    // Right prefix, right length, never minted — so it fails at the hash lookup
    // rather than at the prefix check, which is the more realistic failure.
    invalid_token: `fdsa_${'0'.repeat(32)}`,
    malformed_token: 'not-a-feads-token',
    live_session: 'sess-live',
    revoked_session: 'sess-revoked',
    unknown_session: 'sess-never-registered',
    other_board_session: elsewhere.agent.session_id,
    live_agent: live.agent,
    cleanup() {
      if (previous === undefined) {
        delete process.env.FEADS_REGISTRY_DB;
      } else {
        process.env.FEADS_REGISTRY_DB = previous;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
