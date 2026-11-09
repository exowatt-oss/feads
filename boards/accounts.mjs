// Hosted accounts and directory providers are excluded from this release.
// Retain the per-agent callers' import surface, but never enable accounts mode.
export const DEFAULT_SPACE_ID = 'sp_default';
export const SYSTEM_KEY_PREFIX = 'fdss_';
export class AccountsError extends Error {
  constructor(message = 'accounts provider is not installed', code = 'provider_unavailable', status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function accountsEnabled() { return false; }
export function principalForAgentRow() { return null; }
export function resolveTokenPrincipal() { return null; }
export function getUserById() { return null; }
export function serviceMemberships() { return {}; }
export function listUsers() { return []; }
export function aliasMap() { return new Map(); }
export function isServiceUser() { return false; }

// All remaining hosted API entry points reject calls rather than ship providers.
function unsupported() { throw new AccountsError(); }
export const DEFAULT_SPACE_SLUG = 'default';
export const PERSONAL_TOKEN_PREFIX = 'fdsa_';
export const DEFAULT_SUPERADMIN_EMAILS = Object.freeze([]);
export function audit() { unsupported(); }
export function listAudit() { unsupported(); }
export function setAccountsMode() { unsupported(); }
export function getSetting() { unsupported(); }
export function setSetting() { unsupported(); }
export function superadminEmails() { unsupported(); }
export function replaceRoster() { unsupported(); }
export function fetchBingoRoster() { unsupported(); }
export function rosterRow() { unsupported(); }
export function searchRoster() { unsupported(); }
export function rosterGate() { unsupported(); }
export function ensureDefaultSpace() { unsupported(); }
export function listSpaces() { unsupported(); }
export function getSpace() { unsupported(); }
export function createSpace() { unsupported(); }
export function updateSpace() { unsupported(); }
export function deleteSpace() { unsupported(); }
export function listMembers() { unsupported(); }
export function setMember() { unsupported(); }
export function removeMember() { unsupported(); }
export function memberships() { unsupported(); }
export function boardSpaceMap() { unsupported(); }
export function inconsistentBoards() { unsupported(); }
export function boardSpace() { unsupported(); }
export function setBoardSpace() { unsupported(); }
export const MEMBERSHIP_SOURCES = Object.freeze([]);
export function accountsTransaction() { unsupported(); }
export function membershipSource() { unsupported(); }
export function setMembershipSource() { unsupported(); }
export function spaceBinding() { unsupported(); }
export function bindSpace() { unsupported(); }
export function unbindSpace() { unsupported(); }
export function getUserByEmail() { unsupported(); }
export function getUserByActor() { unsupported(); }
export function provisionUser() { unsupported(); }
export function updateUser() { unsupported(); }
export function userIsLive() { unsupported(); }
export function isBotUser() { unsupported(); }
export function agentVisibleSpaces() { unsupported(); }
export function effectiveOwner() { unsupported(); }
export function userAliases() { unsupported(); }
export function looseAliases() { unsupported(); }
export function addLooseAlias() { unsupported(); }
export function assignOwner() { unsupported(); }
export function clearOwner() { unsupported(); }
export function listUnclaimedAgents() { unsupported(); }
export function ownerMapEntries() { unsupported(); }
export function ownerMapLooseAliases() { unsupported(); }
export function ownerMapSystemAgents() { unsupported(); }
export function ownerMapUnmapped() { unsupported(); }
export function migrateAccounts() { unsupported(); }
export function teamsEntries() { unsupported(); }
export function seedSpaces() { unsupported(); }
export const SERVICE_EMAIL_PREFIX = 'service:';
export const SERVICE_SOURCE_BOT = 'service:bot';
export function getServiceAccount() { unsupported(); }
export function createServiceAccount() { unsupported(); }
export function updateServiceAccount() { unsupported(); }
export function setServiceSpaces() { unsupported(); }
export function mintServiceKey() { unsupported(); }
export function revokeServiceKey() { unsupported(); }
export function retireServiceLegacyToken() { unsupported(); }
export function removeServiceAccount() { unsupported(); }
export function listServiceAccounts() { unsupported(); }
export const BOT_MINT_AUDIT_ACTOR = 'bot-mint';
export function botIdentityShape() { unsupported(); }
export function getBotIdentity() { unsupported(); }
export function mintBotIdentity() { unsupported(); }
export function revokeBotIdentity() { unsupported(); }
export function serviceActorMap() { unsupported(); }
export function labelServiceRows() { unsupported(); }
export function migrateServiceAccounts() { unsupported(); }
export function mintCredential() { unsupported(); }
export function listCredentials() { unsupported(); }
export function getCredential() { unsupported(); }
export function revokeCredential() { unsupported(); }
export function userPrincipal() { unsupported(); }
export function servicePrincipal() { unsupported(); }
export function legacyPrincipal() { unsupported(); }
export function systemPrincipal() { unsupported(); }
export function resolveHashedCredential() { unsupported(); }
export function resolveEmailPrincipal() { unsupported(); }
export function readableBoards() { unsupported(); }
export function ownerDirectory() { unsupported(); }
export function directoryActors() { unsupported(); }
