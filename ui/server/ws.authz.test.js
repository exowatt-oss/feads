import { beforeEach, describe, expect, test, vi } from 'vitest';
import cases from '../../boards/authz-cases.json' with { type: 'json' };
import { createFakeRegistry, toAgentRow } from '../test/fake-agent-registry.js';
import { runBd, runBdJson } from './bd.js';
import { listRoster, resolveIdentity } from './identity.js';
import { bindConnectionCredential, handleMessage } from './ws.js';

/**
 * The UI's *enforcement path* against the shared conformance fixture.
 *
 * `boards/authz-cases.json` is the contract for the two-tier model — not
 * `boards/authz.mjs`, and certainly not this file. `boards/registry.test.mjs`
 * already asserts that the policy module answers the fixture correctly; what is
 * unproven until here is that the dashboard's `delete-issue` handler *asks* the
 * policy the right question and acts on the answer. A handler that resolved an
 * identity and then deleted anyway would pass every policy-level test.
 *
 * So `resolveIdentity` is mocked (there is no registry on a test machine, and
 * the fixture hands us agent rows directly) while `decideFor` stays real and
 * loads the real `boards/authz.mjs`. Mocking `decideFor` too would leave the
 * suite asserting against its own stub.
 */
vi.mock('./bd.js', () => ({
  runBd: vi.fn(),
  runBdJson: vi.fn(),
  getGitUserName: vi.fn()
}));

vi.mock('./identity.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, resolveIdentity: vi.fn() };
});

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
 * Present a fixture agent as the caller, under a stated stance.
 *
 * The stance defaults to `operator` rather than to the dashboard's real
 * `read_only`, and that is not laziness: a fixture row that says nothing about
 * `unidentified` is stating `decide()`'s *own* default, which is operator. Rows
 * that mean read-only say so, and the tests below that are about the browser's
 * stance pass it explicitly.
 *
 * @param {Record<string, any> | null} agent
 * @param {Object} [options]
 * @param {boolean} [options.require_identity]
 * @param {'operator'|'read_only'|'deny'} [options.stance]
 * @param {boolean} [options.credential_rejected] - A credential was presented and
 * did not verify. Forwarded verbatim, including alongside a resolved agent: one
 * fixture case pins that `decide()` ignores the flag when an agent resolved, and
 * dropping it here would quietly assert something weaker. That the real resolver
 * never emits both is a separate claim, asserted in identity.test.js.
 */
function actAs(agent, options = {}) {
  const row = agent ? toAgentRow(agent) : null;
  const credential_rejected = options.credential_rejected === true;
  const stance =
    options.require_identity === true ? 'deny' : options.stance || 'operator';
  /** @type {import('vitest').Mock} */ (resolveIdentity).mockResolvedValue({
    identity: row
      ? {
          agent_id: row.id,
          actor: row.actor,
          display_name: row.display_name,
          role: row.role,
          board_id: row.board_id,
          last_seen_at: row.last_seen_at
        }
      : null,
    agent: row,
    mode: row
      ? 'agent'
      : credential_rejected
        ? 'rejected'
        : stance === 'operator'
          ? 'operator'
          : 'anonymous',
    stance,
    require_identity: stance === 'deny',
    credential_rejected
  });
}

/**
 * The stance a fixture row is stating, if any.
 *
 * @param {Record<string, any>} c
 * @returns {'operator'|'read_only'|'deny'}
 */
function stanceOfCase(c) {
  if (c.require_identity === true) {
    return 'deny';
  }
  const stance = String(c.unidentified || '');
  return stance === 'read_only' || stance === 'deny' || stance === 'operator'
    ? /** @type {'operator'|'read_only'|'deny'} */ (stance)
    : 'operator';
}

/**
 * @param {string} id
 * @param {string} created_by
 */
function stubIssue(id, created_by) {
  /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
    code: 0,
    stdout: '',
    stderr: '',
    stdoutJson: { id, created_by }
  });
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {Promise<any>}
 */
async function sendDelete(payload) {
  const ws = makeStubSocket();
  await handleMessage(
    /** @type {any} */ (ws),
    Buffer.from(
      JSON.stringify({
        id: 'req-authz',
        type: /** @type {any} */ ('delete-issue'),
        payload
      })
    )
  );
  expect(ws.sent).toHaveLength(1);
  return JSON.parse(ws.sent[0]);
}

const delete_cases = cases.cases.filter((c) => c.action === 'delete');
const decide_delete_cases = cases.decide_cases.filter(
  (c) => c.action === 'delete'
);

describe('delete-issue conformance with boards/authz-cases.json', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    /** @type {import('vitest').Mock} */ (runBd).mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: ''
    });
  });

  // The `cases` group is `can()`, which has no notion of an unidentified
  // caller — its `agent: null` rows are covered by `decide_cases` below, where
  // the operator-mode rule lives. Everything with an identity must agree here,
  // because `decide()` delegates straight to `can()` for one.
  for (const c of delete_cases.filter((entry) => entry.agent !== null)) {
    test(`${c.name} → ${c.allowed ? 'allowed' : 'refused'}`, async () => {
      actAs(c.agent);
      const id = String(c.resource?.id || 'ex-0');
      stubIssue(id, String(c.resource?.created_by || ''));

      const reply = await sendDelete({ id });

      expect(reply.ok).toBe(c.allowed);
      if (c.allowed) {
        expect(reply.payload.deleted).toBe(true);
        expect(runBd).toHaveBeenCalledWith(
          ['delete', id, '--force'],
          expect.objectContaining({})
        );
      } else {
        expect(reply.error.code).toBe('forbidden');
        // The refusal has to stop the delete, not merely report one.
        expect(runBd).not.toHaveBeenCalled();
      }
    });
  }

  for (const c of decide_delete_cases) {
    test(`decide: ${c.name} → ${c.allowed ? 'allowed' : 'refused'}`, async () => {
      actAs(c.agent, {
        require_identity: c.require_identity === true,
        stance: stanceOfCase(c),
        credential_rejected: /** @type {any} */ (c).credential_rejected === true
      });
      const id = String(c.resource?.id || 'ex-0');
      stubIssue(id, String(c.resource?.created_by || ''));

      const reply = await sendDelete({ id });

      expect(reply.ok).toBe(c.allowed);
      if (!c.allowed) {
        expect(reply.error.code).toBe('forbidden');
        // `mode` distinguishes a refused authentication from a tier refusal and
        // from the require_identity refusal, so the client can say which.
        expect(reply.error.details.mode).toBe(c.mode);
        expect(runBd).not.toHaveBeenCalled();
      }
    });
  }

  test('every delete case in the fixture is exercised', () => {
    // Guards the loops above against a filter that silently matches nothing —
    // a conformance suite that runs zero cases passes. Bump these when the
    // fixture grows; that is the point of asserting them.
    expect(delete_cases.length).toBe(8);
    expect(decide_delete_cases.length).toBe(7);
    // The whole fixture, so a group growing without a suite noticing is a failure
    // here rather than silence. `decide_cases` grew from 19 to 23 with sign-up,
    // and to 24 when the deny stance opened user-tier sign-up (hosted instance:
    // enrollment satisfies the requirement; admin stays closed).
    expect(cases.cases.length).toBe(35);
    expect(cases.decide_cases.length).toBe(25);
    expect(delete_cases.filter((c) => c.agent === null)).toHaveLength(1);
    expect(
      decide_delete_cases.filter(
        (c) => /** @type {any} */ (c).credential_rejected === true
      )
    ).toHaveLength(2);
  });

  test('an unidentified caller is refused under FEADS_REQUIRE_AGENT', async () => {
    // The `cases` fixture's `agent: null` delete row says `can()` refuses an
    // unidentified caller; the dashboard calls `decide()`, which makes that row
    // true only once identity is required. Both halves asserted so the
    // difference stays deliberate.
    const unidentified = delete_cases.find((c) => c.agent === null);
    const id = String(unidentified?.resource?.id || 'ex-1');

    actAs(null);
    stubIssue(id, '');
    expect((await sendDelete({ id })).ok).toBe(true);

    vi.clearAllMocks();
    /** @type {import('vitest').Mock} */ (runBd).mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: ''
    });
    actAs(null, { require_identity: true });
    stubIssue(id, '');
    const refused = await sendDelete({ id });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe('forbidden');
  });
});

describe('delete-issue creator lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    /** @type {import('vitest').Mock} */ (runBd).mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: ''
    });
  });

  test('an admin is not charged a bd show', async () => {
    // The creator cannot change an allow, so the handler must not pay for one.
    actAs({ id: 'ag_2', actor: 'alex-admin', role: 'admin' });

    const reply = await sendDelete({ id: 'ex-2' });

    expect(reply.ok).toBe(true);
    expect(runBdJson).not.toHaveBeenCalled();
  });

  test('operator mode is not charged a bd show', async () => {
    actAs(null);

    const reply = await sendDelete({ id: 'ex-2' });

    expect(reply.ok).toBe(true);
    expect(runBdJson).not.toHaveBeenCalled();
  });

  test('a rejected credential is not charged a bd show either', async () => {
    // Refused authentication is not about the item, so re-asking with its
    // creator would ask the same question and pay for a subprocess doing it.
    actAs(null, { credential_rejected: true });

    const reply = await sendDelete({ id: 'ex-2' });

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('forbidden');
    expect(reply.error.details.mode).toBe('rejected');
    expect(runBdJson).not.toHaveBeenCalled();
    expect(runBd).not.toHaveBeenCalled();
  });

  test('a rejected credential cannot delete even its own item', async () => {
    // The inversion this whole distinction exists for: before rejection was
    // distinguished from absence, a revoked `user` fell through to operator mode
    // and could delete *anything*. Now it can delete nothing.
    actAs(null, { credential_rejected: true });
    stubIssue('ex-1', 'laptop-claude');

    const reply = await sendDelete({ id: 'ex-1' });

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('forbidden');
    expect(reply.error.message).toContain('did not verify');
  });

  test('a user triggers exactly one bd show', async () => {
    actAs({ id: 'ag_1', actor: 'laptop-claude', role: 'user' });
    stubIssue('ex-1', 'laptop-claude');

    const reply = await sendDelete({ id: 'ex-1' });

    expect(reply.ok).toBe(true);
    expect(runBdJson).toHaveBeenCalledTimes(1);
    expect(runBdJson).toHaveBeenCalledWith(
      ['show', 'ex-1', '--json'],
      expect.objectContaining({})
    );
  });

  test('accepts a bd show payload wrapped in { issue }', async () => {
    actAs({ id: 'ag_1', actor: 'laptop-claude', role: 'user' });
    /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
      stdoutJson: { issue: { id: 'ex-1', created_by: 'laptop-claude' } }
    });

    expect((await sendDelete({ id: 'ex-1' })).ok).toBe(true);
  });

  test('a failed creator lookup refuses rather than assuming ownership', async () => {
    actAs({ id: 'ag_1', actor: 'laptop-claude', role: 'user' });
    /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'no such issue',
      stdoutJson: undefined
    });

    const reply = await sendDelete({ id: 'ex-1' });

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('forbidden');
    expect(runBd).not.toHaveBeenCalled();
  });

  test('a bad payload is still bad_request, not forbidden', async () => {
    actAs(null);

    const reply = await sendDelete({});

    expect(reply.error.code).toBe('bad_request');
    // Validation precedes the policy: refusing to delete an issue whose id was
    // never given would be a confusing way to report a malformed payload.
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
});

describe('writes are gated by the stance, never by ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    /** @type {import('vitest').Mock} */ (runBd).mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: ''
    });
    /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
      stdoutJson: { id: 'ex-2', created_by: 'other-agent' }
    });
  });

  /**
   * @param {string} type
   * @param {Record<string, unknown>} payload
   * @returns {Promise<any>}
   */
  async function send(type, payload) {
    const ws = makeStubSocket();
    await handleMessage(
      /** @type {any} */ (ws),
      Buffer.from(
        JSON.stringify({
          id: 'req-w',
          type: /** @type {any} */ (type),
          payload
        })
      )
    );
    return JSON.parse(ws.sent[0]);
  }

  // A `user` acting on an item created by someone else. Both of these say
  // "remove", and neither destroys an item, so both are `write` — which both
  // tiers hold. Asserted so a later reading of the word "remove" cannot quietly
  // turn them into deletes.
  test('dep-remove succeeds for a user on another agent’s item', async () => {
    actAs({ id: 'ag_1', actor: 'laptop-claude', role: 'user' });

    const reply = await send('dep-remove', { a: 'ex-2', b: 'ex-3' });

    expect(reply.ok).toBe(true);
    expect(runBd).toHaveBeenCalledWith(
      ['dep', 'remove', 'ex-2', 'ex-3'],
      expect.objectContaining({})
    );
  });

  test('label-remove succeeds for a user on another agent’s item', async () => {
    actAs({ id: 'ag_1', actor: 'laptop-claude', role: 'user' });

    const reply = await send('label-remove', { id: 'ex-2', label: 'blocked' });

    expect(reply.ok).toBe(true);
    expect(runBd).toHaveBeenCalledWith(
      ['label', 'remove', 'ex-2', 'blocked'],
      expect.objectContaining({})
    );
  });

  test('update-status succeeds for a user on another agent’s item', async () => {
    actAs({ id: 'ag_1', actor: 'laptop-claude', role: 'user' });

    const reply = await send('update-status', { id: 'ex-2', status: 'closed' });

    expect(reply.ok).toBe(true);
  });

  /**
   * Every mutating message this socket accepts, with a payload that passes its own
   * validation. Enumerated rather than sampled: the gap this closes was `delete` being
   * the *only* gated handler, and a list that quietly stops matching `ws.js` would
   * recreate it one handler at a time. `bd` is stubbed to succeed, so an `ok: true`
   * here means the gate let the request through, not that anything was checked.
   */
  /** @type {Array<[string, Record<string, unknown>]>} */
  const MUTATIONS = [
    ['create-issue', { title: 'a new bead' }],
    ['update-assignee', { id: 'ex-2', assignee: 'someone' }],
    ['update-status', { id: 'ex-2', status: 'closed' }],
    ['update-priority', { id: 'ex-2', priority: 1 }],
    ['edit-text', { id: 'ex-2', field: 'title', value: 'retitled' }],
    ['dep-add', { a: 'ex-2', b: 'ex-3' }],
    ['dep-remove', { a: 'ex-2', b: 'ex-3' }],
    ['label-add', { id: 'ex-2', label: 'blocked' }],
    ['label-remove', { id: 'ex-2', label: 'blocked' }],
    ['add-comment', { id: 'ex-2', text: 'a comment' }],
    ['delete-issue', { id: 'ex-2' }]
  ];

  for (const [type, payload] of MUTATIONS) {
    test(`${type} is refused for an anonymous browser`, async () => {
      actAs(null, { stance: 'read_only' });

      const reply = await send(type, /** @type {any} */ (payload));

      expect(reply.ok).toBe(false);
      expect(reply.error.code).toBe('forbidden');
      expect(reply.error.details.mode).toBe('anonymous');
      // The refusal has to stop the write, not merely report one. This is the half
      // that a client-side disabled button cannot provide.
      expect(runBd).not.toHaveBeenCalled();
    });

    test(`${type} is allowed for an identified user`, async () => {
      actAs({ id: 'ag_1', actor: 'laptop-claude', role: 'user' });
      // `delete-issue` is the one handler whose answer also depends on the item, so
      // it gets an item this user created. Everything else is `write`, which both
      // tiers hold outright — the point of the pair of loops is that the stance is
      // what refused above, not the tier.
      /** @type {import('vitest').Mock} */ (runBdJson).mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
        stdoutJson: { id: 'ex-2', created_by: 'laptop-claude' }
      });

      const reply = await send(type, /** @type {any} */ (payload));

      expect(reply.ok).toBe(true);
    });
  }

  test('every mutating handler in ws.js is in the list above', () => {
    // A count, because the list is the claim. `dep-remove` and `label-remove` are
    // `write` rather than `delete` deliberately — see the notes on those handlers —
    // so all eleven are here and only `delete-issue` consults ownership.
    expect(MUTATIONS).toHaveLength(11);
  });

  test('reads stay open for an anonymous browser', async () => {
    // The premise of the login panel: the board is readable before you sign in, so
    // the prompt sits over something rather than replacing it.
    actAs(null, { stance: 'read_only' });

    const reply = await send('get-comments', { id: 'ex-2' });

    expect(reply.ok).toBe(true);
  });

  test('FEADS_REQUIRE_AGENT closes the reads too', async () => {
    // What makes `deny` a server-side answer rather than a blank screen the client
    // drew for itself.
    actAs(null, { require_identity: true });

    const reply = await send('get-comments', { id: 'ex-2' });

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('forbidden');
    expect(runBdJson).not.toHaveBeenCalled();
  });

  test('a subscription is refused under FEADS_REQUIRE_AGENT', async () => {
    // Refusing the subscription is what stops the push stream before it starts;
    // gating only the request that opens it is enough, because nothing is pushed to
    // a socket that never subscribed.
    actAs(null, { require_identity: true });

    const reply = await send('subscribe-list', {
      id: 'sub-1',
      type: 'all-issues'
    });

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('forbidden');
  });

  test('an anonymous browser may still subscribe', async () => {
    actAs(null, { stance: 'read_only' });

    const reply = await send('subscribe-list', {
      id: 'sub-1',
      type: 'all-issues'
    });

    expect(reply.ok).toBe(true);
  });

  test('bad payloads are still bad_request, ahead of the gate', async () => {
    // Validation precedes the policy everywhere, not just for deletes: refusing to
    // label an issue whose id was never given would be a confusing way to report a
    // malformed payload.
    actAs(null, { stance: 'read_only' });

    const reply = await send('label-add', { id: '', label: '' });

    expect(reply.error.code).toBe('bad_request');
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  test('a refusal never carries a token', async () => {
    actAs(null, { stance: 'read_only' });

    const wire = JSON.stringify(await send('create-issue', { title: 'x' }));

    // The prefixes rather than the word "token": the policy's refusal *says* "paste
    // the token your agent uses", which is the message doing its job. What must
    // never appear is a token value.
    expect(wire).not.toContain('fdsa_');
    expect(wire).not.toContain('fdsi_');
  });
});

describe('the credential is per connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actAs(null, { stance: 'read_only' });
  });

  /**
   * @param {Record<string, string> | undefined} headers
   * @param {string} type
   * @returns {Promise<void>}
   */
  async function sendFrom(headers, type) {
    const ws = makeStubSocket();
    if (headers) {
      bindConnectionCredential(/** @type {any} */ (ws), { headers });
    }
    await handleMessage(
      /** @type {any} */ (ws),
      Buffer.from(
        JSON.stringify({ id: 'req-c', type: /** @type {any} */ (type) })
      )
    );
  }

  test('the handshake cookie is what identity resolves from', async () => {
    // One daemon serves many browsers. Reading the credential from `process.env`
    // would resolve every one of them to whatever shell launched the server.
    await sendFrom({ cookie: 'feads_agent_token=fdsa_browser_one' }, 'whoami');

    expect(resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'fdsa_browser_one' })
    );
  });

  test('two connections present their own credentials', async () => {
    await sendFrom({ cookie: 'feads_agent_token=fdsa_one' }, 'whoami');
    await sendFrom({ cookie: 'feads_agent_token=fdsa_two' }, 'whoami');

    const tokens = /** @type {import('vitest').Mock} */ (
      resolveIdentity
    ).mock.calls.map((call) => call[0].token);
    expect(tokens).toEqual(['fdsa_one', 'fdsa_two']);
  });

  test('a connection with no cookie presents nothing', async () => {
    // Not "whatever the last connection had" — the credential lives in a WeakMap
    // keyed by socket, so there is no shared slot to leak across connections.
    await sendFrom({ cookie: 'feads_agent_token=fdsa_one' }, 'whoami');
    await sendFrom({}, 'whoami');

    const tokens = /** @type {import('vitest').Mock} */ (
      resolveIdentity
    ).mock.calls.map((call) => call[0].token);
    expect(tokens).toEqual(['fdsa_one', '']);
  });

  test('an unbound socket resolves with no cookie rather than throwing', async () => {
    // Every other suite in this repo drives `handleMessage` with a bare stub socket
    // that never went through a handshake.
    await sendFrom(undefined, 'whoami');

    expect(resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ token: '' })
    );
  });

  test('the delete gate uses the connection’s credential too', async () => {
    // The gate and `whoami` must agree about who is calling, or the UI would show
    // one identity and the server enforce another.
    const ws = makeStubSocket();
    bindConnectionCredential(/** @type {any} */ (ws), {
      headers: { cookie: 'feads_agent_token=fdsa_deleter' }
    });
    await handleMessage(
      /** @type {any} */ (ws),
      Buffer.from(
        JSON.stringify({
          id: 'req-d',
          type: /** @type {any} */ ('delete-issue'),
          payload: { id: 'ex-1' }
        })
      )
    );

    expect(resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'fdsa_deleter' })
    );
  });
});

describe('roster scope conformance with roster_scope_for_cases', () => {
  // `rosterScopeFor` exists because the pure tier lookup answers `none` for a
  // null agent, which renders an *empty* roster — indistinguishable on screen
  // from "no agents are registered". These cases pin the UI's roster path to the
  // fixture, including the two the real resolvers cannot produce (a revoked
  // identity never resolves through them; the fake registry can present one).
  for (const c of cases.roster_scope_for_cases) {
    test(`${c.name} → scope ${c.scope}`, async () => {
      const row = c.agent ? toAgentRow(c.agent) : null;
      const rejected = /** @type {any} */ (c).credential_rejected === true;
      // Resolution is stubbed here, and only because these rows are about
      // *scoping*: the fixture states what resolution produced, and this asserts
      // how much roster the UI hands back for it. That resolution really
      // produces those combinations is asserted against the real registry in
      // identity.test.js — see fake-agent-registry.js on why the two are split.
      const fake = createFakeRegistry({
        agent: row,
        credential_rejected: rejected,
        roster: row ? [row] : []
      });
      try {
        const result = await listRoster({
          board_id: 'example',
          loadRegistry: fake.loadRegistry,
          // A row with no `unidentified` states `rosterScopeFor`'s own default,
          // which is operator — not the dashboard's `read_only`. The rows that
          // mean read-only say so, and one of them is the browser's case.
          unidentified: stanceOfCase(/** @type {any} */ (c)),
          env: c.require_identity ? { FEADS_REQUIRE_AGENT: '1' } : {}
        });

        expect(result.scope).toBe(c.scope);
        expect(result.credential_rejected).toBe(rejected);
        if (rejected) {
          expect(result.mode).toBe('rejected');
        }
        if (c.agent_id) {
          expect(result.agents.map((a) => a.agent_id)).toEqual([c.agent_id]);
        }
        if (c.scope === 'none') {
          expect(result.agents).toEqual([]);
        }
      } finally {
        fake.cleanup();
      }
    });
  }

  test('every roster scope case in the fixture is exercised', () => {
    expect(cases.roster_scope_for_cases.length).toBe(8);
    expect(
      cases.roster_scope_for_cases.filter(
        (c) => /** @type {any} */ (c).credential_rejected === true
      )
    ).toHaveLength(1);
  });
});
