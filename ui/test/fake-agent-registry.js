/**
 * A stand-in for the `boards/` agent registry, injected through
 * `ui/server/identity.js`'s `loadRegistry` seam.
 *
 * This **stubs resolution rather than implementing it**: a test states what
 * `resolveAgentIdentity` returned and gets on with asserting what the UI does
 * about it. That line is deliberate. Resolution's contract lives in the
 * `resolution_cases` group of `boards/authz-cases.json`, and a stub that mirrored
 * the contract would keep passing after `boards/agents.mjs` stopped agreeing with
 * it — the exact drift that fixture exists to catch. Anything asserting the
 * contract itself uses `temp-registry.js`, which runs the real resolver against a
 * real database.
 *
 * The reason a stub is wanted at all: the real registry lives at
 * `~/.feads/registry.db`, so a suite that read it would pass or fail according to
 * which agents happen to be registered on the machine running it, and would
 * resolve a genuine identity from the `CLAUDE_CODE_SESSION_ID` Claude Code
 * exports into every session — behaving differently under an agent than under a
 * human.
 *
 * Only what `identity.js` calls is implemented. The database handle is an opaque
 * token: nothing here reads it, so the on-disk file only has to exist for
 * `withRegistry`'s presence check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {Object} FakeRegistry
 * @property {() => Promise<{ agents: any, registry: any }>} loadRegistry - Pass
 * as `options.loadRegistry`.
 * @property {string} path - The stub registry file on disk.
 * @property {{ listAgents: string[], resolveAgentIdentity: string[] }} calls
 * @property {() => void} cleanup
 */

/**
 * @param {Object} [options]
 * @param {Record<string, any> | null} [options.agent] - The row resolution
 * yielded, or null for none.
 * @param {boolean} [options.credential_rejected] - Whether resolution saw a
 * credential presented and refused.
 * @param {string} [options.via] - Defaults to something consistent with `agent`
 * and `credential_rejected`, so a test only states it when that is the point.
 * @param {Record<string, any>[]} [options.roster] - Rows `listAgents` returns.
 * @param {boolean} [options.omitResolver] - Drop `resolveAgentIdentity` entirely,
 * standing in for a `boards/` too old to have it.
 * @returns {FakeRegistry}
 */
export function createFakeRegistry(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feads-ui-identity-'));
  const db_path = path.join(dir, 'registry.db');
  fs.writeFileSync(db_path, '');

  const calls = {
    /** @type {string[]} */
    listAgents: [],
    /** @type {string[]} */
    resolveAgentIdentity: []
  };

  const agent = options.agent || null;
  const credential_rejected = options.credential_rejected === true;
  const via =
    options.via ||
    (agent ? 'token' : credential_rejected ? 'rejected' : 'none');

  /** @type {Record<string, any>} */
  const agents = {
    /**
     * @param {unknown} _db
     * @param {Record<string, string | undefined>} env
     * @returns {{ agent: Record<string, any> | null, credential_rejected: boolean, via: string }}
     */
    resolveAgentIdentity(_db, env) {
      calls.resolveAgentIdentity.push(JSON.stringify(env || {}));
      return { agent, credential_rejected, via };
    },
    /**
     * @param {unknown} _db
     * @param {{ board_id?: string, include_revoked?: boolean }} [list_options]
     * @returns {Record<string, any>[]}
     */
    listAgents(_db, list_options = {}) {
      calls.listAgents.push(JSON.stringify(list_options));
      const rows = options.roster || [];
      return list_options.include_revoked
        ? rows
        : rows.filter((row) => !row.revoked_at);
    }
  };
  if (options.omitResolver) {
    delete agents.resolveAgentIdentity;
  }

  const registry = {
    getRegistryPath() {
      return db_path;
    },
    openRegistry() {
      return {
        close() {}
      };
    }
  };

  return {
    async loadRegistry() {
      return { agents, registry };
    },
    path: db_path,
    calls,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * A registry that cannot be loaded — the published-package and
 * no-`node:sqlite` case.
 *
 * @returns {() => Promise<null>}
 */
export function createMissingRegistry() {
  return async () => null;
}

/**
 * Build a plausible `agents` row from the sparse shape the shared fixture uses.
 *
 * `boards/authz-cases.json` names only the fields the policy reads, so a
 * fixture agent has no `host` or `registered_at`. Filling the rest in here keeps
 * the fixture about policy and lets the roster projection be asserted on the
 * same rows.
 *
 * @param {Record<string, any>} agent
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
export function toAgentRow(agent, overrides = {}) {
  return {
    id: agent.id || 'ag_fixture',
    board_id: 'example',
    actor: agent.actor || 'fixture-agent',
    display_name: agent.display_name || agent.actor || 'Fixture Agent',
    role: agent.role === undefined ? 'user' : agent.role,
    invite_id: 'inv_fixture',
    host: 'fixture-host',
    workspace_dir: '/tmp/fixture',
    session_id: 'sess-fixture',
    kind: 'agent',
    registered_at: 1753718400000,
    last_seen_at: 1753718400000,
    revoked_at: agent.revoked_at || 0,
    revoke_reason: '',
    metadata: '{}',
    ...overrides
  };
}
