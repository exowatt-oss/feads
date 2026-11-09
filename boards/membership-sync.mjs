/*
 * Public export: group membership synchronization is a deployment-specific
 * provider and is not bundled. Accounts mode remains opt-in; local agent
 * tokens and local board access need no directory or SSO service.
 */
import { AccountsError } from './accounts.mjs';
const unsupported = () => { throw new AccountsError('group membership provider is not installed', 'provider_unavailable', 503); };
export const MEMBERSHIP_SYNC_ACTOR = 'directory-sync';
export async function resolveBingoGroup() { unsupported(); }
export async function searchBingoGroups() { unsupported(); }
export async function fetchBingoGroup() { unsupported(); }
export async function fetchGroupsForSpaces() { unsupported(); }
export function syncMembership() { unsupported(); }
export async function runMembershipSync() { unsupported(); }
export function bingoModeProblems() { return ['group membership provider is not installed']; }
export function lastMembershipSync() { return { last: null, last_applied: null }; }
export function lastSyncBySpace() { return {}; }
export function listMembershipSyncRuns() { return []; }
