import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  accountsEnabled, aliasMap, getUserById, listUsers,
  principalForAgentRow, resolveTokenPrincipal, serviceMemberships
} from './accounts.mjs';

test('hosted accounts cannot be enabled in the standalone build', () => {
  assert.equal(accountsEnabled(null, { FEADS_ACCOUNTS: '1' }), false);
  assert.equal(principalForAgentRow(), null);
  assert.equal(resolveTokenPrincipal(), null);
  assert.equal(getUserById(), null);
  assert.deepEqual(listUsers(), []);
  assert.deepEqual(serviceMemberships(), {});
  assert.deepEqual(aliasMap(), new Map());
});
