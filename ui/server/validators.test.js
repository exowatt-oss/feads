import { describe, expect, test } from 'vitest';
import { validateRemoveUserPayload } from './validators.js';

describe('validateRemoveUserPayload', () => {
  test('accepts only an exact typed confirmation', () => {
    expect(
      validateRemoveUserPayload({
        actor: 'Target.User',
        confirm_actor: 'Target.User'
      })
    ).toEqual({
      ok: true,
      actor: 'Target.User',
      confirm_actor: 'Target.User'
    });
  });

  test('refuses case, whitespace, and extra-field confirmation changes', () => {
    expect(
      validateRemoveUserPayload({
        actor: 'Target.User',
        confirm_actor: 'target.user'
      }).ok
    ).toBe(false);
    expect(
      validateRemoveUserPayload({
        actor: 'Target.User',
        confirm_actor: 'Target.User '
      }).ok
    ).toBe(false);
    expect(
      validateRemoveUserPayload({
        actor: 'Target.User',
        confirm_actor: 'Target.User',
        reason: 'no'
      }).ok
    ).toBe(false);
  });
});
