import { beforeEach, describe, expect, test, vi } from 'vitest';
import { handleMessage } from './ws.js';

const {
  resolveIdentity,
  decideFor,
  getPgStore,
  purgeActor,
  inspectAgentRemoval,
  removeAgentActor,
  openRegistry,
  registryDb
} = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  decideFor: vi.fn(),
  getPgStore: vi.fn(),
  purgeActor: vi.fn(),
  inspectAgentRemoval: vi.fn(),
  removeAgentActor: vi.fn(),
  registryDb: { close: vi.fn() },
  openRegistry: vi.fn()
}));

vi.mock('./bd.js', () => ({
  getGitUserName: vi.fn(),
  runBd: vi.fn(),
  runBdJson: vi.fn()
}));

vi.mock('./identity.js', () => ({
  SURFACE: 'browser',
  decideFor,
  listRoster: vi.fn(),
  resolveIdentity
}));

vi.mock('./pg-store.js', () => ({
  boardIdForDir: vi.fn(() => ''),
  getPgStore,
  onPgEvent: vi.fn(() => vi.fn()),
  pgErrorEnvelope: vi.fn((error) => ({
    code: error?.code || 'pg_error',
    message: error?.message || 'postgres query failed'
  }))
}));

vi.mock('../../boards/registry.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  getRegistryPath: vi.fn(() => '/tmp/feads-test-registry.db'),
  openRegistry
}));

vi.mock('../../boards/agents.mjs', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (
    await importOriginal()
  );
  return {
    ...actual,
    inspectAgentRemoval,
    listAgents: vi.fn(() => []),
    removeAgentActor,
    touchAgent: vi.fn()
  };
});

/** @returns {any} */
function socket() {
  return {
    sent: /** @type {string[]} */ ([]),
    readyState: 1,
    OPEN: 1,
    /** @param {string} message */
    send(message) {
      this.sent.push(String(message));
    }
  };
}

/** @param {unknown} payload */
async function send(payload) {
  const ws = socket();
  await handleMessage(
    ws,
    Buffer.from(
      JSON.stringify({ id: 'remove-1', type: 'remove-user', payload })
    )
  );
  return JSON.parse(String(ws.sent.at(-1)));
}

describe('remove-user WebSocket mutation', () => {
  const operator = {
    identity: null,
    agent: null,
    mode: 'operator',
    stance: 'operator',
    require_identity: false,
    credential_rejected: false
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openRegistry.mockReturnValue(registryDb);
    resolveIdentity.mockResolvedValue(operator);
  });

  test('requires manage_agents authorization', async () => {
    decideFor.mockResolvedValue({
      allowed: false,
      reason: 'admin access is required'
    });
    getPgStore.mockReturnValue({ purgeActor });

    const reply = await send({ actor: 'target', confirm_actor: 'target' });

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('forbidden');
    expect(purgeActor).not.toHaveBeenCalled();
  });

  test('refuses before any identity mutation when PostgreSQL is unavailable', async () => {
    decideFor.mockResolvedValue({ allowed: true, reason: 'operator' });
    getPgStore.mockReturnValue(null);

    const reply = await send({ actor: 'target', confirm_actor: 'target' });

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('pg_unavailable');
  });

  test('passes unique descendant actors to PostgreSQL and returns them safely', async () => {
    decideFor.mockResolvedValue({ allowed: true, reason: 'operator' });
    inspectAgentRemoval.mockReturnValue({
      actor: 'Root-Admin',
      agents: [
        { actor: 'root-admin', role: 'admin' },
        { actor: 'child-admin', role: 'admin' },
        { actor: 'CHILD-ADMIN', role: 'admin' },
        { actor: 'child-user', role: 'user' }
      ]
    });
    purgeActor.mockResolvedValue({
      actor: 'Root-Admin',
      removed_actors: ['Root-Admin', 'child-admin', 'child-user'],
      issues: 3,
      owned_issues: 3,
      deps: 0,
      labels: 0,
      comments: 0,
      events: 0,
      assignee_cleared: 0,
      owner_cleared: 0,
      updated_issues: 0,
      boards: 0,
      notifications: 0
    });
    removeAgentActor.mockReturnValue({
      actor: 'Root-Admin',
      agents: 4,
      runtime_presence: 0,
      flares: 0,
      invites: 0,
      notifications: 0,
      notify_state: 0
    });
    getPgStore.mockReturnValue({ purgeActor });

    const reply = await send({
      actor: 'Root-Admin',
      confirm_actor: 'Root-Admin'
    });

    expect(reply.ok).toBe(true);
    expect(inspectAgentRemoval).toHaveBeenCalledWith(
      registryDb,
      expect.objectContaining({ actor: 'Root-Admin' })
    );
    expect(purgeActor).toHaveBeenCalledWith('Root-Admin', [
      'root-admin',
      'child-admin',
      'child-user'
    ]);
    expect(reply.payload.actor).toBe('Root-Admin');
    expect(reply.payload.removed_actors).toEqual([
      'root-admin',
      'child-admin',
      'child-user'
    ]);
    expect(reply.payload.registry.actor).toBe('Root-Admin');
  });

  test('rejects confirmation that is not byte-for-byte identical', async () => {
    const reply = await send({ actor: 'target', confirm_actor: 'TARGET' });

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad_request');
    expect(decideFor).not.toHaveBeenCalled();
  });
});
