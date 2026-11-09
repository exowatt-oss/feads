/**
 * Authorization conformance.
 *
 * The cases live in `authz-cases.json`, not here, because the same table is asserted
 * by the Python implementation in `integrations/beads-mcp/tests/test_authz_parity.py`.
 * Two implementations of a permission check is how surfaces come to disagree, and a
 * disagreement is a security bug rather than a routing quirk — so the fixture is the
 * contract and both suites are merely readers of it.
 *
 * Run with: node --test boards/
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  ACTIONS,
  DEFAULT_ROLE,
  DEFAULT_UNIDENTIFIED_STANCE,
  ROLES,
  UNIDENTIFIED_STANCES,
  can,
  decide,
  isAdmin,
  isRole,
  normalizeRole,
  normalizeStance,
  requireIdentityFromEnv,
  rosterScope,
  rosterScopeFor,
  stanceFor
} from './authz.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'authz-cases.json'), 'utf8'));

describe('authz-cases.json conformance', () => {
  // Asserting the counts stops a silently-empty fixture (a bad merge, a JSON edit that
  // drops the array) from reading as a passing suite.
  test('the fixture actually has cases', () => {
    assert.ok(fixture.cases.length >= 29, `only ${fixture.cases.length} can() cases`);
    assert.ok(fixture.decide_cases.length >= 23);
    assert.ok(fixture.roster_scope_cases.length >= 4);
    assert.ok(fixture.roster_scope_for_cases.length >= 8);
  });

  test('revocation cannot promote: a rejected credential never becomes the operator', () => {
    // Stated as its own test because it is the one inversion in this model that would
    // be invisible in review — both states produce a null agent at the call site.
    const rejected = decide(null, 'delete', { id: 'ex-1', created_by: 'someone' }, {
      credential_rejected: true
    });
    const absent = decide(null, 'delete', { id: 'ex-1', created_by: 'someone' }, {});
    assert.ok(!rejected.allowed, 'a rejected credential must be denied');
    assert.ok(absent.allowed, 'no credential at all is the operator, locally');
    assert.equal(rejected.mode, 'rejected');
    assert.equal(absent.mode, 'operator');
  });

  for (const c of fixture.cases) {
    test(`can: ${c.name}`, () => {
      const decision = can(c.agent, c.action, c.resource || {});
      assert.equal(
        decision.allowed,
        c.allowed,
        `${c.name}: expected allowed=${c.allowed}, got ${decision.allowed} (${decision.reason})`
      );
      // Every decision explains itself, including allows — a surface logs the reason.
      assert.ok(decision.reason.length > 0, 'decision must carry a reason');
    });
  }

  for (const c of fixture.decide_cases) {
    test(`decide: ${c.name}`, () => {
      const decision = decide(c.agent, c.action, c.resource || {}, {
        unidentified: c.unidentified,
        require_identity: c.require_identity,
        credential_rejected: c.credential_rejected
      });
      assert.equal(decision.allowed, c.allowed, `${c.name}: ${decision.reason}`);
      assert.equal(decision.mode, c.mode, `${c.name}: mode`);
    });
  }

  for (const c of fixture.roster_scope_cases) {
    test(`rosterScope: ${c.name}`, () => {
      const scope = rosterScope(c.agent);
      assert.equal(scope.scope, c.scope, c.name);
      if (c.agent_id) assert.equal(scope.agent_id, c.agent_id);
    });
  }

  for (const c of fixture.roster_scope_for_cases) {
    test(`rosterScopeFor: ${c.name}`, () => {
      const scope = rosterScopeFor(c.agent, {
        unidentified: c.unidentified,
        require_identity: c.require_identity,
        credential_rejected: c.credential_rejected
      });
      assert.equal(scope.scope, c.scope, c.name);
      if (c.agent_id) assert.equal(scope.agent_id, c.agent_id);
    });
  }
});

describe('roles', () => {
  test('there are exactly two tiers', () => {
    assert.deepEqual([...ROLES], ['user', 'admin']);
  });

  test('the default tier is the least privileged', () => {
    assert.equal(DEFAULT_ROLE, 'user');
  });

  test('normalizeRole fails closed on anything unrecognized', () => {
    for (const input of ['superuser', 'root', 'ADMINISTRATOR', '', null, undefined, 'usr']) {
      assert.equal(normalizeRole(/** @type {any} */ (input)), 'user', `${input} must not be admin`);
    }
  });

  test('normalizeRole accepts admin in any casing or padding', () => {
    for (const input of ['admin', 'ADMIN', ' Admin ', 'aDmIn']) {
      assert.equal(normalizeRole(input), 'admin');
    }
  });

  test('isRole rejects typos rather than silently downgrading them', () => {
    assert.ok(isRole('admin'));
    assert.ok(isRole('user'));
    assert.ok(!isRole('admni'));
    assert.ok(!isRole('superuser'));
    assert.ok(!isRole(''));
  });

  test('isAdmin is false for absent and malformed input', () => {
    assert.ok(!isAdmin(null));
    assert.ok(!isAdmin(undefined));
    assert.ok(!isAdmin({}));
    assert.ok(isAdmin({ role: 'admin' }));
  });
});

describe('delete ownership', () => {
  const user = { actor: 'laptop-claude', role: 'user' };

  test('ownership is compared against the actor name bd records', () => {
    assert.ok(can(user, 'delete', { id: 'ex-1', created_by: 'laptop-claude' }).allowed);
    assert.ok(!can(user, 'delete', { id: 'ex-1', created_by: 'laptop-Claude' }).allowed);
  });

  test('a missing resource is refused for a user', () => {
    // No resource at all is the same evidentiary position as no creator: ownership
    // cannot be established, so it must not be assumed.
    assert.ok(!can(user, 'delete').allowed);
  });

  test('the refusal names both actors so the agent can explain itself', () => {
    const d = can(user, 'delete', { id: 'ex-9', created_by: 'someone-else' });
    assert.match(d.reason, /someone-else/);
    assert.match(d.reason, /laptop-claude/);
    assert.match(d.reason, /ex-9/);
  });
});

describe('reads are unscoped by tier', () => {
  test('a user reads everything, because hiding beads would defeat collision detection', () => {
    assert.ok(can({ actor: 'a', role: 'user' }, 'read').allowed);
    assert.ok(can({ actor: 'a', role: 'user' }, 'write').allowed);
  });
});

describe('unknown actions', () => {
  test('fail closed even for an admin', () => {
    const d = can({ actor: 'x', role: 'admin' }, /** @type {any} */ ('drop_database'));
    assert.ok(!d.allowed);
    assert.match(d.reason, /unknown action/);
  });

  test('every advertised action has a policy', () => {
    for (const action of ACTIONS) {
      const d = can({ actor: 'x', role: 'admin' }, action, { created_by: 'x' });
      assert.ok(!/unknown action/.test(d.reason), `${action} has no policy`);
    }
  });
});

describe('unidentified stances', () => {
  test('there are exactly three, and the default preserves prior behaviour', () => {
    assert.deepEqual([...UNIDENTIFIED_STANCES], ['operator', 'read_only', 'deny']);
    assert.equal(DEFAULT_UNIDENTIFIED_STANCE, 'operator');
  });

  test('normalizeStance falls back to operator, not deny', () => {
    // Failing closed here would break the CLI on a typo. A surface that wants strict
    // behaviour says so explicitly; it never gets it by accident.
    for (const input of ['', undefined, 'readonly', 'read only', 'strict', 'DENY!']) {
      assert.equal(normalizeStance(/** @type {any} */ (input)), 'operator', String(input));
    }
    assert.equal(normalizeStance('read_only'), 'read_only');
    assert.equal(normalizeStance('READ_ONLY'), 'read_only');
    assert.equal(normalizeStance('deny'), 'deny');
  });

  test('stanceFor lets the environment tighten a surface but never loosen it', () => {
    assert.equal(stanceFor('read_only', {}), 'read_only');
    assert.equal(stanceFor('operator', {}), 'operator');
    // FEADS_REQUIRE_AGENT can only ratchet toward deny.
    assert.equal(stanceFor('operator', { FEADS_REQUIRE_AGENT: '1' }), 'deny');
    assert.equal(stanceFor('read_only', { FEADS_REQUIRE_AGENT: '1' }), 'deny');
    assert.equal(stanceFor('deny', { FEADS_REQUIRE_AGENT: '0' }), 'deny');
  });

  test('the browser stance reads the board but changes nothing', () => {
    const opts = { unidentified: /** @type {const} */ ('read_only') };
    assert.ok(decide(null, 'read', {}, opts).allowed);
    assert.ok(!decide(null, 'write', {}, opts).allowed);
    assert.ok(!decide(null, 'delete', { id: 'x', created_by: '' }, opts).allowed);
    assert.ok(!decide(null, 'manage_agents', {}, opts).allowed);
    assert.equal(rosterScopeFor(null, opts).scope, 'none');
  });

  test('the CLI stance can still bootstrap the first admin', () => {
    // If this ever fails, the model is unbootstrappable: minting needs manage_agents,
    // which needs an admin, which needs an invite that only an operator could mint.
    assert.ok(decide(null, 'manage_agents', {}, {}).allowed);
    assert.ok(decide(null, 'manage_agents', {}, { unidentified: 'operator' }).allowed);
  });

  test('a stance never overrides a real tier', () => {
    const user = { actor: 'laptop-claude', role: 'user' };
    for (const stance of UNIDENTIFIED_STANCES) {
      const d = decide(user, 'delete', { id: 'ex-1', created_by: 'laptop-claude' }, {
        unidentified: stance
      });
      assert.ok(d.allowed, `stance ${stance} must not affect an identified user`);
      assert.equal(d.mode, 'agent');
    }
  });
});

describe('requireIdentityFromEnv', () => {
  test('reads the truthy spellings a person would actually type', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes']) {
      assert.ok(requireIdentityFromEnv({ FEADS_REQUIRE_AGENT: raw }), raw);
    }
  });

  test('anything else is off, including the confusing ones', () => {
    for (const raw of ['0', 'false', 'no', '', undefined]) {
      assert.ok(!requireIdentityFromEnv({ FEADS_REQUIRE_AGENT: raw }), String(raw));
    }
  });
});
