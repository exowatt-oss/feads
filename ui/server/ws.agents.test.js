import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { signupAgent } from '../../boards/agents.mjs';
import { openRegistry, upsertBoard } from '../../boards/registry.mjs';
import { toAgentRow } from '../test/fake-agent-registry.js';
import { listRoster, resolveIdentity } from './identity.js';
import { validateListAgentsPayload } from './validators.js';
import { handleMessage } from './ws.js';

/**
 * The `whoami` and `list-agents` handlers.
 *
 * Both are thin over `identity.js`, whose behaviour is covered in
 * identity.test.js against a fake registry. What is asserted here is the wire
 * contract: envelope shape, that a refusal is `forbidden` rather than a thrown
 * socket error, and that nothing a client receives can carry a token hash.
 */
vi.mock('./bd.js', () => ({
  runBd: vi.fn(),
  runBdJson: vi.fn(),
  getGitUserName: vi.fn()
}));

vi.mock('./identity.js', () => ({
  resolveIdentity: vi.fn(),
  decideFor: vi.fn(),
  listRoster: vi.fn(),
  // Not a function, so it is stated rather than stubbed. `whoami` reports it, and a
  // mock that omitted it would have the handler send `surface: undefined` while
  // every assertion here still passed.
  SURFACE: 'browser'
}));

function makeStubSocket() {
  return {
    sent: /** @type {string[]} */ ([]),
    readyState: 1,
    OPEN: 1,
    /** @param {string} msg */
    send(msg) {
      this.sent.push(String(msg));
    }
  };
}

/**
 * @param {string} type
 * @param {unknown} payload
 * @returns {Promise<any>}
 */
async function send(type, payload) {
  const ws = makeStubSocket();
  await handleMessage(
    /** @type {any} */ (ws),
    Buffer.from(
      JSON.stringify({ id: 'req-1', type: /** @type {any} */ (type), payload })
    )
  );
  expect(ws.sent).toHaveLength(1);
  return JSON.parse(ws.sent[0]);
}

describe('whoami handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('reports an identified agent', async () => {
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: {
        agent_id: 'ag_1',
        actor: 'laptop-claude',
        display_name: 'Laptop Claude',
        role: 'user',
        board_id: 'example',
        last_seen_at: 1753718400000
      },
      agent: toAgentRow({ id: 'ag_1', actor: 'laptop-claude', role: 'user' }),
      mode: 'agent',
      stance: 'read_only',
      require_identity: false
    });

    const reply = await send('whoami', {});

    expect(reply.ok).toBe(true);
    expect(reply.payload.mode).toBe('agent');
    expect(reply.payload.require_identity).toBe(false);
    expect(reply.payload.identity.actor).toBe('laptop-claude');
    expect(reply.payload.identity.role).toBe('user');
    // The full registry row is server-side only; whoami sends the projection.
    expect(Object.keys(reply.payload.identity).sort()).toEqual([
      'actor',
      'agent_id',
      'board_id',
      'display_name',
      'last_seen_at',
      'role'
    ]);
  });

  test('advances authenticated browser activity once per minute per connection', async () => {
    vi.useFakeTimers();
    const registry_path = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'feads-ws-activity-')),
      'registry.db'
    );
    const old_registry = process.env.FEADS_REGISTRY_DB;
    process.env.FEADS_REGISTRY_DB = registry_path;
    const db = openRegistry({ path: registry_path });
    upsertBoard(db, {
      id: 'demo',
      name: 'Demo',
      board_dir: path.join(path.dirname(registry_path), 'board')
    });
    vi.setSystemTime(1_000_000);
    const agent = signupAgent(db, {
      board_id: 'demo',
      actor: 'browser-agent',
      display_name: 'Browser Agent'
    }).agent;
    db.close();
    vi.setSystemTime(2_000_000);

    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: {
        agent_id: agent.id,
        actor: agent.actor,
        display_name: agent.display_name,
        role: agent.role,
        board_id: agent.board_id,
        last_seen_at: agent.last_seen_at
      },
      agent: toAgentRow({ id: agent.id, actor: agent.actor, role: agent.role }),
      mode: 'agent',
      stance: 'read_only',
      require_identity: false
    });

    const ws = makeStubSocket();
    const request = () =>
      handleMessage(
        /** @type {any} */ (ws),
        Buffer.from(
          JSON.stringify({ id: 'activity', type: 'whoami', payload: {} })
        )
      );
    try {
      await request();
      let activity = openRegistry({ path: registry_path });
      const first = /** @type {any} */ (
        activity
          .prepare('SELECT last_seen_at FROM agents WHERE id = ?')
          .get(agent.id)
      ).last_seen_at;
      activity.close();

      vi.setSystemTime(2_030_000);
      await request();
      activity = openRegistry({ path: registry_path });
      const throttled = /** @type {any} */ (
        activity
          .prepare('SELECT last_seen_at FROM agents WHERE id = ?')
          .get(agent.id)
      ).last_seen_at;
      activity.close();
      expect(throttled).toBe(first);

      vi.setSystemTime(2_061_000);
      await request();
      activity = openRegistry({ path: registry_path });
      const advanced = /** @type {any} */ (
        activity
          .prepare('SELECT last_seen_at FROM agents WHERE id = ?')
          .get(agent.id)
      ).last_seen_at;
      activity.close();
      expect(advanced).toBe(2_061_000);
    } finally {
      if (old_registry === undefined) delete process.env.FEADS_REGISTRY_DB;
      else process.env.FEADS_REGISTRY_DB = old_registry;
      fs.rmSync(path.dirname(registry_path), { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  test('reports operator mode as success, not as an error', async () => {
    // A dashboard with no registered agent is the common case. Reporting it as
    // an error would make the UI treat "not registered" as "broken".
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: null,
      agent: null,
      mode: 'operator',
      stance: 'operator',
      require_identity: false
    });

    const reply = await send('whoami', {});

    expect(reply.ok).toBe(true);
    expect(reply.payload.identity).toBeNull();
    expect(reply.payload.mode).toBe('operator');
  });

  test('reports a rejected credential as ok with mode rejected', async () => {
    // Not an error envelope: the UI cannot distinguish an error from a transport
    // failure, so it would fall back to looking like operator mode — the exact
    // silence that let a revoked agent read as promoted.
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: null,
      agent: null,
      mode: 'rejected',
      stance: 'read_only',
      require_identity: false,
      credential_rejected: true
    });

    const reply = await send('whoami', {});

    expect(reply.ok).toBe(true);
    expect(reply.payload.mode).toBe('rejected');
    expect(reply.payload.credential_rejected).toBe(true);
    expect(reply.payload.identity).toBeNull();
  });

  test('operator mode is not reported as rejected', async () => {
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: null,
      agent: null,
      mode: 'operator',
      stance: 'operator',
      require_identity: false,
      credential_rejected: false
    });

    const reply = await send('whoami', {});

    expect(reply.payload.mode).toBe('operator');
    expect(reply.payload.credential_rejected).toBe(false);
  });

  test('surfaces require_identity so the UI can explain a refusal', async () => {
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: null,
      agent: null,
      mode: 'anonymous',
      stance: 'deny',
      require_identity: true
    });

    const reply = await send('whoami', {});

    expect(reply.payload.require_identity).toBe(true);
  });

  test('needs no payload', async () => {
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: null,
      agent: null,
      mode: 'operator',
      stance: 'operator',
      require_identity: false
    });

    const reply = await send('whoami', undefined);

    expect(reply.ok).toBe(true);
  });

  test('an anonymous browser is told it is read-only, not that it is broken', async () => {
    // The login state. `mode: 'anonymous'` with `stance: 'read_only'` is what makes
    // the panel offer a sign-in *over* a readable board; the `deny` stance is the
    // only one that may block, and the two are indistinguishable from `mode` alone.
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: null,
      agent: null,
      mode: 'anonymous',
      stance: 'read_only',
      require_identity: false,
      credential_rejected: false
    });

    const reply = await send('whoami', {});

    expect(reply.ok).toBe(true);
    expect(reply.payload.mode).toBe('anonymous');
    expect(reply.payload.stance).toBe('read_only');
    expect(reply.payload.identity).toBeNull();
  });

  test('reports the surface, so the UI can say this is a human session', async () => {
    // "If they're seeing a browser and not MCP, the agent knows they're a human."
    // Reported per connection rather than stored: the same token over MCP is the
    // same agent, and only the surface differs.
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: null,
      agent: null,
      mode: 'anonymous',
      stance: 'read_only',
      require_identity: false
    });

    const reply = await send('whoami', {});

    expect(reply.payload.surface).toBe('browser');
  });

  test('no whoami reply can carry a token', async () => {
    // The cookie is HttpOnly precisely so page JavaScript never holds the token.
    // A `whoami` that echoed it would undo that in one line.
    /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
      identity: {
        agent_id: 'ag_1',
        actor: 'laptop-claude',
        display_name: 'Laptop Claude',
        role: 'user',
        board_id: 'example',
        last_seen_at: 1753718400000
      },
      agent: toAgentRow(
        { id: 'ag_1', actor: 'laptop-claude', role: 'user' },
        { token_hash: 'e3b0c44298fc1c149afbf4c8996fb924' }
      ),
      mode: 'agent',
      stance: 'read_only',
      require_identity: false
    });

    const wire = JSON.stringify(await send('whoami', {}));

    expect(wire).not.toContain('token_hash');
    expect(wire).not.toContain('e3b0c44298fc');
    expect(wire).not.toContain('fdsa_');
  });
});

describe('list-agents handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * @param {Partial<import('./identity.js').Roster>} [overrides]
   */
  function stubRoster(overrides = {}) {
    /** @type {import('vitest').Mock} */ (listRoster).mockResolvedValue({
      allowed: true,
      reason: 'admin sees every agent',
      scope: 'all',
      board_id: 'example',
      agents: [
        {
          agent_id: 'ag_1',
          actor: 'laptop-claude',
          display_name: 'Laptop Claude',
          role: 'user',
          board_id: 'example',
          host: 'macbook',
          workspace_dir: '/Users/alex/example',
          session_id: 'sess-1',
          kind: 'agent',
          registered_at: 1753718400000,
          last_seen_at: 1753718400000,
          revoked_at: 0,
          revoke_reason: ''
        }
      ],
      mode: 'operator',
      stance: 'operator',
      require_identity: false,
      credential_rejected: false,
      ...overrides
    });
  }

  test('returns the roster with its scope', async () => {
    stubRoster();

    const reply = await send('list-agents', {});

    expect(reply.ok).toBe(true);
    expect(reply.payload.scope).toBe('all');
    expect(reply.payload.board_id).toBe('example');
    expect(reply.payload.agents).toHaveLength(1);
    expect(reply.payload.agents[0].actor).toBe('laptop-claude');
  });

  test('a refusal is a forbidden reply, not a thrown socket error', async () => {
    stubRoster({
      allowed: false,
      reason:
        'FEADS_REQUIRE_AGENT is set and this caller presented no identity',
      scope: 'none',
      agents: []
    });

    const reply = await send('list-agents', {});

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('forbidden');
    expect(reply.error.message).toContain('FEADS_REQUIRE_AGENT');
  });

  test('a rejected credential is refused, and told why', async () => {
    stubRoster({
      allowed: false,
      reason: 'a credential was presented and did not verify',
      scope: 'none',
      agents: [],
      mode: 'rejected',
      credential_rejected: true
    });

    const reply = await send('list-agents', {});

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('forbidden');
    expect(reply.error.message).toContain('did not verify');
  });

  test('credential_rejected reaches the client on a successful roster', async () => {
    stubRoster();

    const reply = await send('list-agents', {});

    expect(reply.payload.credential_rejected).toBe(false);
  });

  test('include_revoked is forwarded', async () => {
    stubRoster();

    await send('list-agents', { include_revoked: true });

    expect(listRoster).toHaveBeenCalledWith(
      expect.objectContaining({ include_revoked: true })
    );
  });

  test('a non-boolean include_revoked is bad_request', async () => {
    stubRoster();

    const reply = await send('list-agents', { include_revoked: 'yes' });

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad_request');
    expect(listRoster).not.toHaveBeenCalled();
  });

  test('the payload is optional', async () => {
    stubRoster();

    const reply = await send('list-agents', undefined);

    expect(reply.ok).toBe(true);
    expect(listRoster).toHaveBeenCalledWith(
      expect.objectContaining({ include_revoked: false })
    );
  });

  test('the client cannot widen its own scope', async () => {
    // Scope is the server's decision. A `scope: 'all'` in the request is
    // ignored rather than honored, and `listRoster` never sees it.
    stubRoster({ scope: 'self' });

    const reply = await send('list-agents', {
      scope: 'all',
      board_id: 'other'
    });

    expect(reply.payload.scope).toBe('self');
    const call = /** @type {import('vitest').Mock} */ (listRoster).mock
      .calls[0][0];
    expect(call.scope).toBeUndefined();
    expect(call.board_id).not.toBe('other');
  });

  test('no reply can carry a token hash', async () => {
    stubRoster();

    const reply = await send('list-agents', {});

    expect(JSON.stringify(reply)).not.toContain('token_hash');
  });
});

describe('validateListAgentsPayload', () => {
  test('accepts an absent payload', () => {
    expect(validateListAgentsPayload(undefined)).toEqual({
      ok: true,
      include_revoked: false
    });
    expect(validateListAgentsPayload(null)).toEqual({
      ok: true,
      include_revoked: false
    });
  });

  test('accepts a boolean include_revoked', () => {
    expect(validateListAgentsPayload({ include_revoked: true })).toEqual({
      ok: true,
      include_revoked: true
    });
  });

  test('rejects a non-object payload', () => {
    const res = validateListAgentsPayload([]);
    expect(res.ok).toBe(false);
  });

  test('rejects a truthy non-boolean include_revoked', () => {
    // '1' and 'false' are both truthy strings; coercing either would make the
    // flag mean whatever the client's serializer happened to do.
    const res = validateListAgentsPayload({ include_revoked: '1' });
    expect(res.ok).toBe(false);
  });
});
