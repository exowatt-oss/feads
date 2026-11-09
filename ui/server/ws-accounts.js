// Hosted accounts WebSocket identity is unavailable in the standalone release.
export const SSO_REVERIFY_MS = 5 * 60_000;
export const ACCESS_REVALIDATE_MS = 30_000;
export function accountsConnection() { return null; }
export async function authenticateAccountsUpgrade() { return null; }
export function bindAccountsConnection() { return false; }
export function releaseAccountsConnection() {}
export async function resolveAccountsConnection() {
  return { mode: 'rejected', stance: 'deny', credential_rejected: true,
    error_code: 'provider_unavailable', principal: { kind: 'anonymous' } };
}
// Unbound per-agent sockets retain their ordinary delivery gate.
export function canDeliverBoard() { return true; }
export async function messageBoardAllowed() { return false; }
