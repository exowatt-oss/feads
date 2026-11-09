import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import cases from '../../boards/authz-cases.json' with { type: 'json' };
import {
  createFakeRegistry,
  createMissingRegistry,
  toAgentRow
} from '../test/fake-agent-registry.js';
import { createTempRegistry } from '../test/temp-registry.js';
import { decideFor, listRoster, resolveIdentity } from './identity.js';

/**
 * `process.env` is never read for credentials in these tests. The UI server
 * resolves identity from the environment it was launched in, and Claude Code
 * exports `CLAUDE_CODE_SESSION_ID` into every session — so a suite that let the
 * real environment through would resolve a different identity for an agent than
 * for a human, and only on machines with a registry.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string | undefined>}
 */
function env(overrides = {}) {
  return { ...overrides };
}

describe('server/identity resolveIdentity', () => {
  test('operator mode when no registry is reachable', async () => {
    const resolved = await resolveIdentity({
      env: env(),
      loadRegistry: createMissingRegistry()
    });

    expect(resolved.mode).toBe('operator');
    expect(resolved.identity).toBeNull();
    expect(resolved.agent).toBeNull();
    expect(resolved.require_identity).toBe(false);
    expect(resolved.via).toBe('none');
  });

  test('an unreachable registry is not a rejection', async () => {
    // Nothing could have been refused by a registry that was never opened, so
    // this stays the permissive operator case rather than locking the dashboard.
    // This one is the UI's own call, not the shared resolver's.
    const resolved = await resolveIdentity({
      env: env({ FEADS_AGENT_TOKEN: 'fdsa_whatever' }),
      loadRegistry: createMissingRegistry()
    });

    expect(resolved.mode).toBe('operator');
    expect(resolved.credential_rejected).toBe(false);
  });

  test('a boards without resolveAgentIdentity degrades to unidentified', async () => {
    // Rather than approximating the order locally. An approximation that drifts
    // from the shared resolver is how revocation came to read as a promotion.
    // Unidentified, not operator: the registry itself is reachable here, so the
    // browser's read-only stance stands and a login could still succeed.
    const fake = createFakeRegistry({ omitResolver: true });
    try {
      const resolved = await resolveIdentity({
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_whatever' }),
        loadRegistry: fake.loadRegistry
      });

      expect(resolved.mode).toBe('anonymous');
      expect(resolved.stance).toBe('read_only');
      expect(resolved.credential_rejected).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test('the environment is handed to the shared resolver verbatim', async () => {
    // identity.js must not pre-filter or reinterpret the credentials — deciding
    // which one wins is `resolveAgentIdentity`'s job.
    const fake = createFakeRegistry({ agent: null });
    try {
      await resolveIdentity({
        env: env({
          FEADS_AGENT_TOKEN: 'fdsa_x',
          CLAUDE_CODE_SESSION_ID: 'sess-1'
        }),
        loadRegistry: fake.loadRegistry
      });

      expect(fake.calls.resolveAgentIdentity).toEqual([
        JSON.stringify({
          FEADS_AGENT_TOKEN: 'fdsa_x',
          CLAUDE_CODE_SESSION_ID: 'sess-1'
        })
      ]);
    } finally {
      fake.cleanup();
    }
  });

  test('a cookie token is handed to the resolver in the token slot', async () => {
    // Not as a fourth kind of credential. If the cookie had its own resolution
    // path, the order that `resolution_cases` pins would exist twice — and a second
    // implementation of that order is what made revoking an agent read as a
    // promotion once already.
    const fake = createFakeRegistry({ agent: null });
    try {
      await resolveIdentity({
        token: 'fdsa_from_cookie',
        env: env({ CLAUDE_CODE_SESSION_ID: 'sess-1' }),
        loadRegistry: fake.loadRegistry
      });

      expect(fake.calls.resolveAgentIdentity).toEqual([
        JSON.stringify({
          CLAUDE_CODE_SESSION_ID: 'sess-1',
          FEADS_AGENT_TOKEN: 'fdsa_from_cookie'
        })
      ]);
    } finally {
      fake.cleanup();
    }
  });

  test('the cookie outranks the daemon’s own FEADS_AGENT_TOKEN', async () => {
    // The cookie is what the person in front of the browser just chose; the
    // environment variable is whatever shell happened to launch the daemon. A human
    // pasting a token must not be silently overruled by the server's environment —
    // that would look like the login had failed.
    const fake = createFakeRegistry({ agent: null });
    try {
      await resolveIdentity({
        token: 'fdsa_from_cookie',
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_from_daemon_env' }),
        loadRegistry: fake.loadRegistry
      });

      const handed = JSON.parse(fake.calls.resolveAgentIdentity[0]);
      expect(handed.FEADS_AGENT_TOKEN).toBe('fdsa_from_cookie');
    } finally {
      fake.cleanup();
    }
  });

  test('with no cookie the environment is handed through untouched', async () => {
    const fake = createFakeRegistry({ agent: null });
    try {
      await resolveIdentity({
        token: '',
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_from_daemon_env' }),
        loadRegistry: fake.loadRegistry
      });

      expect(fake.calls.resolveAgentIdentity).toEqual([
        JSON.stringify({ FEADS_AGENT_TOKEN: 'fdsa_from_daemon_env' })
      ]);
    } finally {
      fake.cleanup();
    }
  });

  test('a cookie token that does not verify is rejected, not anonymous', async () => {
    // The revocation inversion, arriving by the new door. A revoked agent's cookie
    // must not fall through to the read-only anonymous bucket, or revoking an agent
    // would leave its browser exactly as capable as a stranger's — and, before the
    // browser was read-only, more capable than that.
    const fake = createFakeRegistry({
      agent: null,
      credential_rejected: true,
      via: 'rejected'
    });
    try {
      const resolved = await resolveIdentity({
        token: 'fdsa_revoked',
        env: env(),
        loadRegistry: fake.loadRegistry
      });

      expect(resolved.mode).toBe('rejected');
      expect(resolved.credential_rejected).toBe(true);
      expect(resolved.identity).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  test('a resolved agent becomes an agent-mode identity', async () => {
    const fake = createFakeRegistry({
      agent: toAgentRow({ id: 'ag_1', actor: 'laptop-claude', role: 'user' }),
      via: 'token'
    });
    try {
      const resolved = await resolveIdentity({
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_deadbeef' }),
        loadRegistry: fake.loadRegistry
      });

      expect(resolved.mode).toBe('agent');
      expect(resolved.via).toBe('token');
      expect(resolved.credential_rejected).toBe(false);
      expect(resolved.identity?.agent_id).toBe('ag_1');
      expect(resolved.identity?.actor).toBe('laptop-claude');
      expect(resolved.identity?.role).toBe('user');
    } finally {
      fake.cleanup();
    }
  });

  test('a rejection becomes rejected mode, not operator mode', async () => {
    // The mapping that closes the inversion. Whether a given credential *is* a
    // rejection is the shared resolver's call, asserted against
    // `resolution_cases` below; this is only that the UI carries the answer.
    const fake = createFakeRegistry({
      agent: null,
      credential_rejected: true,
      via: 'rejected'
    });
    try {
      const resolved = await resolveIdentity({
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_revoked' }),
        loadRegistry: fake.loadRegistry
      });

      expect(resolved.mode).toBe('rejected');
      expect(resolved.credential_rejected).toBe(true);
      expect(resolved.via).toBe('rejected');
      expect(resolved.identity).toBeNull();
      expect(resolved.agent).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  test('FEADS_REQUIRE_AGENT is reported to the caller', async () => {
    const resolved = await resolveIdentity({
      env: env({ FEADS_REQUIRE_AGENT: '1' }),
      loadRegistry: createMissingRegistry()
    });

    expect(resolved.require_identity).toBe(true);
    expect(resolved.stance).toBe('deny');
    expect(resolved.mode).toBe('anonymous');
  });

  test('an unreachable registry does NOT relax FEADS_REQUIRE_AGENT', async () => {
    // The fail-open this ordering exists to prevent. A missing registry relaxes the
    // browser's *own* read-only default to operator, because read-only with nothing
    // to log in to is a dead end — but it must never relax an explicit instruction
    // from whoever deployed this, or a hosted service that mistyped its registry
    // path would promote every anonymous caller to operator at exactly the moment
    // nobody is looking at stances.
    const relaxed = await resolveIdentity({
      env: env(),
      loadRegistry: createMissingRegistry()
    });
    expect(relaxed.stance).toBe('operator');

    const required = await resolveIdentity({
      env: env({ FEADS_REQUIRE_AGENT: '1' }),
      loadRegistry: createMissingRegistry()
    });
    expect(required.stance).toBe('deny');
  });

  test('the browser is read-only until it presents something', async () => {
    // The stance this surface takes, and the whole premise of the login panel: the
    // board stays readable, nothing can be changed. Distinct from operator mode,
    // which is what the CLI gets and what this degrades to with no registry.
    const fake = createFakeRegistry({ agent: null });
    try {
      const resolved = await resolveIdentity({
        env: env(),
        loadRegistry: fake.loadRegistry
      });

      expect(resolved.mode).toBe('anonymous');
      expect(resolved.stance).toBe('read_only');
      expect(resolved.require_identity).toBe(false);
      expect(resolved.identity).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  test('the projection carries no token hash', async () => {
    const fake = createFakeRegistry({
      // A row that still has the column, which the real SELECT never returns —
      // the projection must drop it even if that ever changes.
      agent: toAgentRow(
        { id: 'ag_4', actor: 'laptop-claude', role: 'user' },
        { token_hash: 'e3b0c44298fc1c149afbf4c8996fb924' }
      )
    });
    try {
      const resolved = await resolveIdentity({
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_x' }),
        loadRegistry: fake.loadRegistry
      });

      expect(JSON.stringify(resolved.identity)).not.toContain('token_hash');
      expect(JSON.stringify(resolved.identity)).not.toContain('e3b0c44298fc');
      // Delegation lineage and expiry are deliberately client-safe identity
      // fields. Keep this allowlist exact so registry metadata, host details and
      // credential material cannot leak by accident.
      expect(Object.keys(resolved.identity || {}).sort()).toEqual([
        'actor',
        'agent_id',
        'board_id',
        'display_name',
        'expires_at',
        'last_seen_at',
        'parent_actor',
        'parent_agent_id',
        'role'
      ]);
    } finally {
      fake.cleanup();
    }
  });
});

/**
 * Resolution conformance — the UI's answer to every row of `resolution_cases`.
 *
 * The real `boards/` modules against a real SQLite registry, with real invites
 * redeemed and one agent really revoked. Nothing here is stubbed, on purpose:
 * these rows are the contract that keeps the UI, the CLI and the MCP server from
 * disagreeing about *who is calling*, and it was drift there — not in `decide()`
 * — that let revoking an agent promote it. A stub mirroring the contract would
 * pass after `boards/agents.mjs` stopped honouring it.
 */
describe('resolution conformance with boards/authz-cases.json', () => {
  /** @type {Awaited<ReturnType<typeof createTempRegistry>>} */
  let reg;

  beforeAll(async () => {
    reg = await createTempRegistry();
  });

  afterAll(() => {
    reg?.cleanup();
  });

  /**
   * Turn a fixture row's `token`/`session` keys into a launch environment.
   *
   * @param {string} token
   * @param {string} session
   * @returns {Record<string, string | undefined>}
   */
  function envFor(token, session) {
    /** @type {Record<string, string | undefined>} */
    const out = {};
    if (token === 'valid') out.FEADS_AGENT_TOKEN = reg.valid_token;
    if (token === 'invalid') out.FEADS_AGENT_TOKEN = reg.invalid_token;
    if (session === 'live') out.CLAUDE_CODE_SESSION_ID = reg.live_session;
    if (session === 'revoked') out.CLAUDE_CODE_SESSION_ID = reg.revoked_session;
    if (session === 'no_match') {
      out.CLAUDE_CODE_SESSION_ID = reg.unknown_session;
    }
    return out;
  }

  for (const c of cases.resolution_cases) {
    test(`${c.name} → via ${c.via}`, async () => {
      const resolved = await resolveIdentity({
        env: envFor(c.token, c.session)
      });

      expect(resolved.via).toBe(c.via);
      expect(resolved.agent !== null).toBe(c.resolves_agent);
      expect(resolved.credential_rejected).toBe(c.credential_rejected);
      // And the mode the UI derives from that, which is what `whoami` sends and
      // what the header tab is gated on. A real registry is reachable here, so an
      // unidentified caller is `anonymous` — the browser's read-only stance —
      // rather than the operator the CLI would report for the same resolution.
      expect(resolved.mode).toBe(
        c.resolves_agent
          ? 'agent'
          : c.credential_rejected
            ? 'rejected'
            : 'anonymous'
      );
      expect(resolved.identity !== null).toBe(c.resolves_agent);
    });
  }

  test('every resolution case in the fixture is exercised', () => {
    expect(cases.resolution_cases.length).toBe(8);
    // Both rejection doors: an invalid token, and a session naming a revoked
    // agent. The second is the one a long-lived daemon actually hits.
    expect(
      cases.resolution_cases.filter((c) => c.credential_rejected)
    ).toHaveLength(3);
  });

  test('a revoked token is refused by the real resolver', () => {
    // Not a fixture row — the fixture's `token: invalid` covers "does not
    // verify" generically. This pins the specific case the inversion came from:
    // a token that *was* valid until its agent was revoked.
    return expect(
      resolveIdentity({ env: { FEADS_AGENT_TOKEN: reg.revoked_token } })
    ).resolves.toMatchObject({
      mode: 'rejected',
      credential_rejected: true,
      via: 'rejected'
    });
  });

  test('a real revoked token presented by cookie is refused', async () => {
    // The same claim as the fake-registry case above, but through the real resolver
    // and a real revoked agent — because "the cookie is just the token slot" is only
    // true if `boards/agents.mjs` still agrees.
    const resolved = await resolveIdentity({
      token: reg.revoked_token,
      env: {}
    });

    expect(resolved.mode).toBe('rejected');
    expect(resolved.credential_rejected).toBe(true);
    expect(resolved.via).toBe('rejected');
  });

  test('a real valid token presented by cookie resolves that agent', async () => {
    const resolved = await resolveIdentity({ token: reg.valid_token, env: {} });

    expect(resolved.mode).toBe('agent');
    expect(resolved.via).toBe('token');
    expect(resolved.identity?.actor).toBe('live-agent');
  });

  test('a cookie beats a live session belonging to someone else', async () => {
    // Precedence, end to end. The session id here would resolve on its own; the
    // cookie is presented explicitly and must win, which is exactly what
    // `resolveAgentIdentity`'s "token before session" order already says.
    const resolved = await resolveIdentity({
      token: reg.invalid_token,
      env: { CLAUDE_CODE_SESSION_ID: reg.live_session }
    });

    expect(resolved.mode).toBe('rejected');
    expect(resolved.credential_rejected).toBe(true);
  });

  test('a malformed token is refused, not ignored', async () => {
    const resolved = await resolveIdentity({
      env: { FEADS_AGENT_TOKEN: reg.malformed_token }
    });

    expect(resolved.mode).toBe('rejected');
    expect(resolved.credential_rejected).toBe(true);
  });

  test('resolution is not scoped to the board on screen', async () => {
    // `resolveAgentIdentity` accepts a board_id and identity.js declines to pass
    // it. Scoping would resolve to nobody the moment the picker moved — and
    // nobody, with nothing presented, is the operator. So a `user` would gain
    // privilege by switching boards.
    const resolved = await resolveIdentity({
      board_id: reg.board_id,
      env: { CLAUDE_CODE_SESSION_ID: reg.other_board_session }
    });

    expect(resolved.mode).toBe('agent');
    expect(resolved.identity?.board_id).toBe(reg.other_board_id);
  });

  test('a revoked agent on another board is still a rejection', async () => {
    // The corollary: not scoping means a revoked agent cannot escape the
    // rejection by having the dashboard point somewhere else.
    const resolved = await resolveIdentity({
      board_id: reg.other_board_id,
      env: { CLAUDE_CODE_SESSION_ID: reg.revoked_session }
    });

    expect(resolved.mode).toBe('rejected');
    expect(resolved.credential_rejected).toBe(true);
  });

  test('a real roster read reaches the real registry', async () => {
    // End to end through the real modules: the operator sees the live agent and
    // not the revoked one, and no token hash survives the projection.
    // Stated as the operator rather than left to the surface default: the
    // browser's own stance is `read_only`, under which the roster is refused —
    // asserted against the fixture in ws.authz.test.js. What this row is for is
    // that a permitted roster read really reaches the real registry.
    const roster = await listRoster({
      board_id: reg.board_id,
      unidentified: 'operator',
      env: {}
    });

    expect(roster.allowed).toBe(true);
    expect(roster.scope).toBe('all');
    expect(roster.agents.map((a) => a.actor)).toEqual(['live-agent']);
    expect(JSON.stringify(roster.agents)).not.toContain('token_hash');

    const withRevoked = await listRoster({
      board_id: reg.board_id,
      include_revoked: true,
      unidentified: 'operator',
      env: {}
    });
    expect(withRevoked.agents.map((a) => a.actor).sort()).toEqual([
      'doomed-agent',
      'live-agent'
    ]);
  });
});

describe('server/identity decideFor', () => {
  test('an identified user may not delete another agent’s item', async () => {
    const fake = createFakeRegistry({
      agent: toAgentRow({
        id: 'ag_1',
        actor: 'laptop-claude',
        role: 'user'
      })
    });
    try {
      const resolved = await resolveIdentity({
        env: env({ CLAUDE_CODE_SESSION_ID: 'sess-1' }),
        loadRegistry: fake.loadRegistry
      });

      const own = await decideFor(resolved, 'delete', {
        id: 'ex-1',
        created_by: 'laptop-claude'
      });
      const other = await decideFor(resolved, 'delete', {
        id: 'ex-2',
        created_by: 'other-agent'
      });

      expect(own.allowed).toBe(true);
      expect(other.allowed).toBe(false);
      expect(other.mode).toBe('agent');
    } finally {
      fake.cleanup();
    }
  });

  test('an unidentified caller is allowed as the operator', async () => {
    const resolved = await resolveIdentity({
      env: env(),
      loadRegistry: createMissingRegistry()
    });

    const decision = await decideFor(resolved, 'delete', {
      id: 'ex-2',
      created_by: 'other-agent'
    });

    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe('operator');
  });

  test('FEADS_REQUIRE_AGENT refuses an unidentified caller', async () => {
    const resolved = await resolveIdentity({
      env: env({ FEADS_REQUIRE_AGENT: 'true' }),
      loadRegistry: createMissingRegistry()
    });

    const decision = await decideFor(resolved, 'read');

    // Even a read, which the ordinary browser stance allows — the `deny` stance is
    // the one case where the login panel may block rather than sit over a visible
    // board.
    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe('anonymous');
    expect(decision.reason).toContain('requires an agent identity');
  });

  test('an anonymous browser may read and may change nothing', async () => {
    const fake = createFakeRegistry({ agent: null });
    try {
      const resolved = await resolveIdentity({
        env: env(),
        loadRegistry: fake.loadRegistry
      });

      const read = await decideFor(resolved, 'read');
      expect(read.allowed).toBe(true);
      expect(read.mode).toBe('anonymous');

      for (const action of /** @type {const} */ ([
        'write',
        'delete',
        'manage_agents',
        'view_roster'
      ])) {
        const decision = await decideFor(resolved, action, { id: 'ex-1' });
        expect(decision.allowed).toBe(false);
        expect(decision.mode).toBe('anonymous');
      }
    } finally {
      fake.cleanup();
    }
  });

  test('an anonymous browser may sign itself up, but not as an admin', async () => {
    // Sign-up is the one write an anonymous visitor may cause: requiring an
    // identity in order to obtain one is a closed loop. The admin tier is not, or
    // the tier would be self-service and the delete rules decorative.
    const fake = createFakeRegistry({ agent: null });
    try {
      const resolved = await resolveIdentity({
        env: env(),
        loadRegistry: fake.loadRegistry
      });

      const user = await decideFor(resolved, 'mint_invite', { role: 'user' });
      const admin = await decideFor(resolved, 'mint_invite', { role: 'admin' });

      expect(user.allowed).toBe(true);
      expect(admin.allowed).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test('FEADS_REQUIRE_AGENT keeps user-tier sign-up open (admin stays closed)', async () => {
    // Enrollment is how a caller satisfies the identity requirement — closing it
    // made the deny stance unescapable from the dashboard. Admin remains gated:
    // open sign-up must never be a self-promotion button.
    const fake = createFakeRegistry({ agent: null });
    try {
      const resolved = await resolveIdentity({
        env: env({ FEADS_REQUIRE_AGENT: '1' }),
        loadRegistry: fake.loadRegistry
      });

      const user = await decideFor(resolved, 'mint_invite', { role: 'user' });
      expect(user.allowed).toBe(true);

      const admin = await decideFor(resolved, 'mint_invite', { role: 'admin' });
      expect(admin.allowed).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test('a rejected credential is denied with the flag off', async () => {
    // The permissive fallback is for callers who never claimed an identity, not
    // for one whose claim was refused, so `FEADS_REQUIRE_AGENT` is irrelevant.
    const fake = createFakeRegistry({
      agent: null,
      credential_rejected: true,
      via: 'rejected'
    });
    try {
      const resolved = await resolveIdentity({
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_revoked' }),
        loadRegistry: fake.loadRegistry
      });

      for (const action of /** @type {const} */ ([
        'read',
        'write',
        'delete',
        'view_roster'
      ])) {
        const decision = await decideFor(resolved, action, { id: 'ex-1' });
        expect(decision.allowed).toBe(false);
        expect(decision.mode).toBe('rejected');
      }
    } finally {
      fake.cleanup();
    }
  });

  test('a rejected credential cannot delete an item it created', async () => {
    const fake = createFakeRegistry({
      agent: null,
      credential_rejected: true,
      via: 'rejected'
    });
    try {
      const resolved = await resolveIdentity({
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_revoked' }),
        loadRegistry: fake.loadRegistry
      });

      const decision = await decideFor(resolved, 'delete', {
        id: 'ex-1',
        created_by: 'laptop-claude'
      });

      expect(decision.allowed).toBe(false);
      expect(decision.mode).toBe('rejected');
    } finally {
      fake.cleanup();
    }
  });

  test('allows everything when the policy module cannot be loaded', async () => {
    // A checkout without `boards/` has no registry, so no caller could hold an
    // identity — refusing would brick the dashboard rather than secure it.
    const resolved = await resolveIdentity({
      env: env(),
      loadAuthz: async () => null,
      loadRegistry: createMissingRegistry()
    });

    const decision = await decideFor(
      resolved,
      'delete',
      { id: 'ex-2', created_by: 'other-agent' },
      { loadAuthz: async () => null }
    );

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('no authorization policy module');
  });

  test('still refuses a rejected credential with no policy module', async () => {
    // The degraded allow covers "nobody could have an identity here". A caller
    // that presented one this build cannot honour is not that case.
    const fake = createFakeRegistry({
      agent: null,
      credential_rejected: true,
      via: 'rejected'
    });
    try {
      const resolved = await resolveIdentity({
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_revoked' }),
        loadRegistry: fake.loadRegistry,
        loadAuthz: async () => null
      });

      const decision = await decideFor(
        resolved,
        'delete',
        { id: 'ex-1' },
        { loadAuthz: async () => null }
      );

      expect(decision.allowed).toBe(false);
      expect(decision.mode).toBe('rejected');
    } finally {
      fake.cleanup();
    }
  });
});

describe('server/identity listRoster', () => {
  const roster = [
    toAgentRow({ id: 'ag_1', actor: 'laptop-claude', role: 'user' }),
    toAgentRow({ id: 'ag_2', actor: 'alex-admin', role: 'admin' }),
    toAgentRow(
      { id: 'ag_3', actor: 'retired', role: 'user', revoked_at: 1753718400000 },
      { revoke_reason: 'session ended' }
    )
  ];

  test('an admin sees every agent on the active board', async () => {
    const fake = createFakeRegistry({
      roster,
      agent: roster[1],
      via: 'session'
    });
    try {
      const result = await listRoster({
        board_id: 'example',
        env: env({ CLAUDE_CODE_SESSION_ID: 'sess-1' }),
        loadRegistry: fake.loadRegistry
      });

      expect(result.allowed).toBe(true);
      expect(result.scope).toBe('all');
      expect(result.agents.map((a) => a.actor)).toEqual([
        'laptop-claude',
        'alex-admin'
      ]);
      expect(fake.calls.listAgents).toEqual([
        '{"board_id":"example","include_revoked":false}'
      ]);
    } finally {
      fake.cleanup();
    }
  });

  test('include_revoked reaches the query', async () => {
    const fake = createFakeRegistry({
      roster,
      agent: roster[1],
      via: 'session'
    });
    try {
      const result = await listRoster({
        board_id: 'example',
        include_revoked: true,
        env: env({ CLAUDE_CODE_SESSION_ID: 'sess-1' }),
        loadRegistry: fake.loadRegistry
      });

      expect(result.agents.map((a) => a.actor)).toContain('retired');
      const revoked = result.agents.find((a) => a.actor === 'retired');
      expect(revoked?.revoked_at).toBe(1753718400000);
      expect(revoked?.revoke_reason).toBe('session ended');
    } finally {
      fake.cleanup();
    }
  });

  test('a user sees only its own row, without querying the board', async () => {
    const fake = createFakeRegistry({
      roster,
      agent: roster[0],
      via: 'session'
    });
    try {
      const result = await listRoster({
        board_id: 'example',
        env: env({ CLAUDE_CODE_SESSION_ID: 'sess-1' }),
        loadRegistry: fake.loadRegistry
      });

      expect(result.allowed).toBe(true);
      expect(result.scope).toBe('self');
      expect(result.agents.map((a) => a.actor)).toEqual(['laptop-claude']);
      // Answered from the resolved row, so a user registered on another board
      // still sees itself.
      expect(fake.calls.listAgents).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test('operator mode sees every agent', async () => {
    const fake = createFakeRegistry({ roster });
    try {
      const result = await listRoster({
        board_id: 'example',
        unidentified: 'operator',
        env: env(),
        loadRegistry: fake.loadRegistry
      });

      expect(result.mode).toBe('operator');
      expect(result.scope).toBe('all');
      expect(result.agents).toHaveLength(2);
    } finally {
      fake.cleanup();
    }
  });

  test('an unregistered active board yields an explained empty roster', async () => {
    // The trap this guards: `listAgents` treats a falsy board_id as "no filter"
    // and would return every agent on every board under the heading of the
    // board on screen.
    const fake = createFakeRegistry({ roster });
    try {
      const result = await listRoster({
        board_id: '',
        unidentified: 'operator',
        env: env(),
        loadRegistry: fake.loadRegistry
      });

      expect(result.allowed).toBe(true);
      expect(result.agents).toEqual([]);
      expect(result.reason).toContain('no registry entry');
      expect(fake.calls.listAgents).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test('refuses an unidentified caller when identity is required', async () => {
    const fake = createFakeRegistry({ roster });
    try {
      const result = await listRoster({
        board_id: 'example',
        env: env({ FEADS_REQUIRE_AGENT: '1' }),
        loadRegistry: fake.loadRegistry
      });

      expect(result.allowed).toBe(false);
      expect(result.scope).toBe('none');
      expect(result.agents).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test('a rejected credential sees nothing, not the whole roster', async () => {
    // Falling into the operator branch would have handed a revoked agent every
    // registered agent's host, workspace and session id.
    const fake = createFakeRegistry({
      agent: null,
      credential_rejected: true,
      via: 'rejected',
      roster
    });
    try {
      const result = await listRoster({
        board_id: 'example',
        env: env({ FEADS_AGENT_TOKEN: 'fdsa_revoked' }),
        loadRegistry: fake.loadRegistry
      });

      expect(result.allowed).toBe(false);
      expect(result.scope).toBe('none');
      expect(result.mode).toBe('rejected');
      expect(result.credential_rejected).toBe(true);
      expect(result.agents).toEqual([]);
      expect(fake.calls.listAgents).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test('an anonymous read-only caller gets no roster at all', async () => {
    // Read-only means "read the board", not "read the administrative record of who
    // else is registered, on which host, in which workspace". The registry is
    // reachable here, so the stance really is read_only rather than degraded.
    const fake = createFakeRegistry({ roster });
    try {
      const result = await listRoster({
        board_id: 'example',
        env: env(),
        loadRegistry: fake.loadRegistry
      });

      expect(result.mode).toBe('anonymous');
      expect(result.stance).toBe('read_only');
      expect(result.allowed).toBe(false);
      expect(result.scope).toBe('none');
      expect(result.agents).toEqual([]);
      expect(fake.calls.listAgents).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test('a cookie-presented admin sees the whole roster', async () => {
    const fake = createFakeRegistry({ roster, agent: roster[1], via: 'token' });
    try {
      const result = await listRoster({
        token: 'fdsa_admin',
        board_id: 'example',
        env: env(),
        loadRegistry: fake.loadRegistry
      });

      expect(result.mode).toBe('agent');
      expect(result.scope).toBe('all');
      const handed = JSON.parse(fake.calls.resolveAgentIdentity[0]);
      expect(handed.FEADS_AGENT_TOKEN).toBe('fdsa_admin');
    } finally {
      fake.cleanup();
    }
  });

  test('no registry is an empty roster, not a refusal', async () => {
    const result = await listRoster({
      board_id: 'example',
      env: env(),
      loadRegistry: createMissingRegistry()
    });

    expect(result.allowed).toBe(true);
    expect(result.agents).toEqual([]);
    expect(result.reason).toContain('no agent registry');
  });

  test('no roster row can carry a token hash', async () => {
    const fake = createFakeRegistry({
      roster: [
        toAgentRow(
          { id: 'ag_1', actor: 'laptop-claude', role: 'user' },
          { token_hash: 'e3b0c44298fc1c149afbf4c8996fb924' }
        )
      ]
    });
    try {
      const result = await listRoster({
        board_id: 'example',
        env: env(),
        loadRegistry: fake.loadRegistry
      });

      const wire = JSON.stringify(result.agents);
      expect(wire).not.toContain('token_hash');
      expect(wire).not.toContain('e3b0c44298fc');
      // `metadata` is dropped too: it is an agent-authored JSON blob with no
      // reader in the UI, and forwarding it would widen the surface for free.
      expect(wire).not.toContain('metadata');
    } finally {
      fake.cleanup();
    }
  });
});
