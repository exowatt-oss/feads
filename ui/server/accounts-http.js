// Hosted accounts/SSO authentication is excluded. This module cannot authenticate anyone.
export function createAccountsVerifier() {
  return { verify: async () => ({ ok: false, code: 'provider_unavailable' }) };
}
export async function resolveRequestIdentity() {
  return { identity: null, agent: null, mode: 'rejected', stance: 'deny',
    require_identity: true, credential_rejected: true, via: 'rejected',
    principal: { kind: 'anonymous' }, error_code: 'provider_unavailable', http_via: 'none' };
}
export function hasTokenCookie() { return false; }
export function mutationOriginAllowed() { return false; }
