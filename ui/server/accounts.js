// Hosted accounts mode is not bundled. The per-agent UI keeps its ordinary
// board and token behavior; callers of hosted routes receive unavailable.
export async function loadAccountsModules() { return null; }
export async function withAccounts(_fn, options = {}) { return options.fallback ?? null; }
export async function accountsOn() { return false; }
export function accountsOnSync() { return false; }
export function resetAccountsCache() {}
export async function boardSpaces() { return new Map(); }
export function principalOf(resolved) { return resolved?.principal || { kind: 'anonymous' }; }
export async function boardAccess() { return false; }
// Null means no hosted board filtering; per-agent access is handled elsewhere.
export async function readableBoardIds() { return null; }
export async function scopeBoardFields(rows) { return rows; }
export async function scopeIdentityBoard(identity) { return identity; }
export async function readableSpaceIds() { return null; }
export async function decide() { return { allowed: false, reason: 'provider_unavailable' }; }
export async function principalSummary() { return {}; }
