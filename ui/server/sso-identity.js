/* Public export: silo/SSO identity requires an out-of-tree deployment provider. */
export const INTERNAL_SSO_HEADER = 'x-feads-sso-internal';
export const INTERNAL_SSO_SECRET_ENV = 'FEADS_SSO_INTERNAL_SECRET';
export function isSiloEnabled() { return false; }
export function isExactLoopbackPeer(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request?.socket?.remoteAddress);
}
export function constantTimeSecretMatches() { return false; }
export function isInternalSsoRequest() { return false; }
export function internalSsoEmail() { return null; }
export function resolveSsoIdentity() { return null; }
export function resolveSsoIdentityFromRegistry() { return null; }
export function resolveWorkerSsoIdentity() { return null; }
export const resolveSsoWorkerIdentity = resolveWorkerSsoIdentity;
export function normalizeEmail() { return null; }
