/*
 * Public export: no deployment SSO provider is bundled. Browser sessions fail
 * closed; local agent-token mode remains available. A future deployment may
 * supply a verifier through the documented createApp/accountsVerifier seam.
 */
export const AUTH_COOKIE_NAME = 'feads_auth';
export const USERINFO_PATH = '/oauth2/userinfo';
export const DEFAULT_AUTH_PROXY_INTERNAL_URL = null;
export const MAX_COOKIE_HEADER_BYTES = 32 * 1024;
export const MAX_AUTH_COOKIE_PART_BYTES = 4096;
export const MAX_AUTH_COOKIE_BYTES = 16 * 1024;
export const MAX_USERINFO_BODY_BYTES = 16 * 1024;
export const USERINFO_TIMEOUT_MS = 2500;
export const MAX_AUTH_COOKIE_CHUNKS = 8;

// No silo/hosted deployment in the standalone export. Refuse a configured
// silo rather than silently accepting traffic without its authentication.
export function siloMode(env = process.env) {
  return env.FEADS_SILO ? 'invalid' : 'base';
}
export function assertValidSiloEnvironment(env = process.env) {
  if (siloMode(env) !== 'base') throw new Error('FEADS_SILO requires a private SSO provider');
  return null;
}
export function isValidSilo(_value) { return false; }
export function parseAuthCookie(_header) { return { ok: false, code: 'provider_unavailable' }; }
export function canonicalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email) ? email : null;
}
export function isExactOrigin(origin, trustedPublicUrl) {
  if (typeof origin !== 'string' || typeof trustedPublicUrl !== 'string' ||
      origin.trim() !== origin || trustedPublicUrl.trim() !== trustedPublicUrl) return false;
  try {
    const actual = new URL(origin);
    const trusted = new URL(trustedPublicUrl);
    return ['http:', 'https:'].includes(actual.protocol) &&
      ['http:', 'https:'].includes(trusted.protocol) &&
      !actual.username && !actual.password && !trusted.username && !trusted.password &&
      actual.origin === trusted.origin;
  } catch { return false; }
}
export function validateBrowserOrigin(origin, env = process.env) {
  return isExactOrigin(origin, env.FEADS_PUBLIC_URL);
}
export function createPlatformSsoVerifier(options = {}) {
  const env = options.env || process.env;
  const result = Object.freeze({ ok: false, enabled: false, reason: 'provider_unavailable' });
  return Object.freeze({
    enabled: false, silo: '', reason: 'provider_unavailable', userinfo_url: null,
    verify: async () => result,
    verifyPrincipal: async () => null,
    isOriginAllowed: origin => validateBrowserOrigin(origin, env)
  });
}
export async function verifyPlatformSso(request, options = {}) {
  return createPlatformSsoVerifier(options).verify(request);
}
export const createPlatformSSOVerifier = createPlatformSsoVerifier;
export const verifyPlatformSSO = verifyPlatformSso;
export const isTrustedBrowserOrigin = validateBrowserOrigin;
