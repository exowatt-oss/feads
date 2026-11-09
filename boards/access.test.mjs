import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  accessibleSpaces,
  decideAccess,
  readableBoardIds
} from './access.mjs';

const vectors = JSON.parse(
  fs.readFileSync(new URL('./access-cases.json', import.meta.url), 'utf8')
);

describe('access-cases.json (shared with beads_mcp/access.py)', () => {
  for (const [i, c] of vectors.cases.entries()) {
    const label = `#${i} ${c.principal} ${c.action} ${JSON.stringify(c.resource)} → ${c.allowed}${c.note ? ` (${c.note})` : ''}`;
    it(label, () => {
      const principal = vectors.principals[c.principal];
      assert.ok(principal, `unknown principal ${c.principal}`);
      const got = decideAccess(principal, c.action, c.resource);
      assert.equal(got.allowed, c.allowed, got.reason);
      assert.equal(typeof got.reason, 'string');
    });
  }

  for (const c of vectors.accessible_spaces) {
    it(`accessibleSpaces(${c.principal})`, () => {
      const got = accessibleSpaces(vectors.principals[c.principal]);
      if (c.all) {
        assert.equal(got, null);
      } else {
        assert.deepEqual([...got].sort(), [...c.spaces].sort());
      }
    });
  }
});

describe('decideAccess deny-by-default', () => {
  it('null / undefined / non-object principals are anonymous', () => {
    for (const p of [null, undefined, 'mira', 42, []]) {
      assert.equal(
        decideAccess(/** @type {any} */ (p), 'space_read', { space: 'sp_team_a' }).allowed,
        false
      );
    }
  });

  it('a malformed memberships map grants nothing', () => {
    const p = { kind: 'user', via: 'sso', memberships: ['sp_team_a'] };
    assert.equal(decideAccess(/** @type {any} */ (p), 'space_read', { space: 'sp_team_a' }).allowed, false);
  });

  it('superadmin must be the literal boolean true', () => {
    const p = { kind: 'user', via: 'sso', is_superadmin: 'yes', memberships: {} };
    assert.equal(decideAccess(/** @type {any} */ (p), 'space_read', { space: 'sp_team_a' }).allowed, false);
  });

  it('readableBoardIds filters by space', () => {
    const boards = [
      { id: 'example', space_id: 'sp_team_a' },
      { id: 'team_b-lab', space_id: 'sp_team_b' }
    ];
    assert.deepEqual(readableBoardIds(vectors.principals.member_sw, boards), ['example']);
    assert.deepEqual(readableBoardIds(vectors.principals.team_b, boards), ['team_b-lab']);
    assert.deepEqual(readableBoardIds(vectors.principals.super_browser, boards), ['example', 'team_b-lab']);
    assert.deepEqual(readableBoardIds(vectors.principals.anonymous, boards), []);
  });
});
