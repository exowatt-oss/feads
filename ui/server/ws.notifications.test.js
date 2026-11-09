/**
 * feads — the notification and directory WebSocket handlers.
 *
 * The store behind them has its own suites (boards/notifications.test.mjs and
 * notifications-engine.test.js); these tests pin the identity and mock the
 * store to assert the protocol layer: payload validation, identity scoping,
 * and reply shapes.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getGitUserName, runBd, runBdJson } from './bd.js';
import {
  ackNotificationsForActor,
  listNotificationsForActor,
  listUsersDirectory
} from './notifications-engine.js';
import { handleMessage } from './ws.js';

vi.mock('./bd.js', () => ({
  runBd: vi.fn(),
  runBdJson: vi.fn(),
  getGitUserName: vi.fn()
}));

vi.mock('./notifications-engine.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    listNotificationsForActor: vi.fn(),
    ackNotificationsForActor: vi.fn(),
    listUsersDirectory: vi.fn()
  };
});

// feads: pin the acting identity so this suite is about its own subject. See
// test/stub-identity.js. Reassigned per test via `resolution`.
/** @type {import('../test/stub-identity.js').StubResolution | null} */
let resolution = null;
vi.mock('./identity.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  const { operatorResolution } = await import('../test/stub-identity.js');
  return {
    ...actual,
    resolveIdentity: vi.fn(async () => resolution || operatorResolution())
  };
});

const ALICE_ROW = {
  id: 'ag_alice',
  actor: 'alice',
  display_name: 'Alice',
  role: 'user',
  board_id: 'demo',
  last_seen_at: 1
};

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
 * @param {ReturnType<typeof makeStubSocket>} ws
 * @param {string} type
 * @param {unknown} [payload]
 */
async function request(ws, type, payload) {
  await handleMessage(
    /** @type {any} */ (ws),
    Buffer.from(JSON.stringify({ id: 'req-1', type, payload }))
  );
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { agentResolution } = await import('../test/stub-identity.js');
  resolution = agentResolution(ALICE_ROW);
});

describe('list-notifications handler', () => {
  test('returns the identified caller inbox', async () => {
    const rows = [{ id: 'n_1', recipient_actor: 'alice', type: 'mention' }];
    /** @type {import('vitest').Mock} */ (
      listNotificationsForActor
    ).mockResolvedValueOnce({ notifications: rows, unread_count: 1 });

    const reply = await request(makeStubSocket(), 'list-notifications', {
      unread_only: false,
      limit: 10
    });
    expect(reply.ok).toBe(true);
    expect(reply.payload).toEqual({
      notifications: rows,
      unread_count: 1,
      actor: 'alice'
    });
    // The browser surface always lists the *seen* queue: the badge answers
    // "has the human looked", never "has an agent acted". And it is the human
    // audience: only @mentions reach the bell (coordination rows are agents').
    expect(listNotificationsForActor).toHaveBeenCalledWith('alice', {
      unread_only: false,
      limit: 10,
      queue: 'seen',
      audience: 'human'
    });
  });

  test('an unidentified caller gets an empty inbox, not an error', async () => {
    const { anonymousResolution } = await import('../test/stub-identity.js');
    resolution = anonymousResolution();
    const reply = await request(makeStubSocket(), 'list-notifications', {});
    expect(reply.ok).toBe(true);
    expect(reply.payload).toEqual({
      notifications: [],
      unread_count: 0,
      actor: null
    });
    expect(listNotificationsForActor).not.toHaveBeenCalled();
  });

  test('rejects a bad limit', async () => {
    const reply = await request(makeStubSocket(), 'list-notifications', {
      limit: 0
    });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad_request');
  });
});

describe('ack-notifications handler', () => {
  test('acks by ids for the identified caller', async () => {
    /** @type {import('vitest').Mock} */ (
      ackNotificationsForActor
    ).mockResolvedValueOnce({ acked: 2, unread_count: 3 });
    const reply = await request(makeStubSocket(), 'ack-notifications', {
      ids: ['n_1', 'n_2']
    });
    expect(reply.ok).toBe(true);
    expect(reply.payload).toEqual({ acked: 2, unread_count: 3 });
    // A browser ack means *seen* — it must never stamp handled_at, or a bell
    // click discharges a [q] no agent has answered (the ex-9tu incident).
    // Scoped to the human audience, so Mark-all-read clears the mentions the
    // human was shown and nothing else.
    expect(ackNotificationsForActor).toHaveBeenCalledWith('alice', {
      ids: ['n_1', 'n_2'],
      all: false,
      mode: 'seen',
      audience: 'human'
    });
  });

  test('requires ids or all', async () => {
    const reply = await request(makeStubSocket(), 'ack-notifications', {});
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad_request');
  });

  test('refuses an unidentified caller with not_identified', async () => {
    const { anonymousResolution } = await import('../test/stub-identity.js');
    resolution = anonymousResolution();
    const reply = await request(makeStubSocket(), 'ack-notifications', {
      all: true
    });
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('not_identified');
    expect(ackNotificationsForActor).not.toHaveBeenCalled();
  });
});

describe('list-users handler', () => {
  test('serves the directory to any reader', async () => {
    const users = [
      { actor: 'alice', display_name: 'Alice', role: 'user', kind: 'agent' }
    ];
    /** @type {import('vitest').Mock} */ (
      listUsersDirectory
    ).mockResolvedValueOnce(users);
    const reply = await request(makeStubSocket(), 'list-users', {});
    expect(reply.ok).toBe(true);
    expect(reply.payload).toEqual({ users });
  });

  test('anonymous read-only browsers may read it too', async () => {
    const { anonymousResolution } = await import('../test/stub-identity.js');
    resolution = anonymousResolution();
    /** @type {import('vitest').Mock} */ (
      listUsersDirectory
    ).mockResolvedValueOnce([]);
    const reply = await request(makeStubSocket(), 'list-users', {});
    expect(reply.ok).toBe(true);
  });
});

describe('add-comment author attribution', () => {
  test('a registered agent signs with its actor, not the git name', async () => {
    const rb = /** @type {import('vitest').Mock} */ (runBd);
    const rj = /** @type {import('vitest').Mock} */ (runBdJson);
    const git = /** @type {import('vitest').Mock} */ (getGitUserName);
    git.mockResolvedValue('Git Name');
    rb.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    rj.mockResolvedValueOnce({ code: 0, stdoutJson: [] });

    const reply = await request(makeStubSocket(), 'add-comment', {
      id: 'UI-1',
      text: 'hi @bob'
    });
    expect(reply.ok).toBe(true);
    expect(rb).toHaveBeenCalledWith(
      ['comments', 'add', 'UI-1', 'hi @bob', '--author', 'alice'],
      expect.anything()
    );
  });

  test('the operator still falls back to the git name', async () => {
    const { operatorResolution } = await import('../test/stub-identity.js');
    resolution = operatorResolution();
    const rb = /** @type {import('vitest').Mock} */ (runBd);
    const rj = /** @type {import('vitest').Mock} */ (runBdJson);
    const git = /** @type {import('vitest').Mock} */ (getGitUserName);
    git.mockResolvedValue('Git Name');
    rb.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    rj.mockResolvedValueOnce({ code: 0, stdoutJson: [] });

    const reply = await request(makeStubSocket(), 'add-comment', {
      id: 'UI-1',
      text: 'hello'
    });
    expect(reply.ok).toBe(true);
    expect(rb).toHaveBeenCalledWith(
      ['comments', 'add', 'UI-1', 'hello', '--author', 'Git Name'],
      expect.anything()
    );
  });
});
