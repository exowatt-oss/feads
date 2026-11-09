/**
 * Agent identity — who is working a board, and how they proved it.
 *
 * beads identifies an actor by whatever `BEADS_ACTOR` happens to hold, falling
 * back to git's user.name and then `$USER`. That fallback is the problem: `bd
 * update <id> --claim` is idempotent *for the same actor*, so two agents sharing
 * a fallback identity both get a ✓ on the same bead and the collision detection
 * the board exists for silently reports success. Identity has to be minted, not
 * guessed.
 *
 * The flow is the standard two-token enrollment shape:
 *
 *   1. You mint one **invite** per agent (`createInvite`). It is single-use, has
 *      an expiry, and names the actor the agent will become.
 *   2. The agent redeems it once (`registerAgent`), which consumes the invite and
 *      mints a durable **agent token** it keeps for later calls.
 *
 * Only SHA-256 hashes of both tokens are stored. Plain SHA-256 rather than a
 * password KDF is correct here and deliberate: these are 128-bit random strings,
 * not human-chosen passwords, so there is no dictionary to stretch against — and
 * a KDF would put a deliberate delay on the hot path of every future
 * authenticated request.
 *
 * Local single-user today: nothing yet *requires* an agent to be registered, and
 * `verifyAgentToken` has no network caller. Both exist now because the recorded
 * destination is a hosted registry serving many agents (see
 * `the excluded hosted-provider design`, whose "who writes the
 * catalog implies an auth model" open question this is the first half of). Storing
 * plaintext tokens today would make that migration a security rewrite instead of a
 * transport change.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  accountsEnabled,
  principalForAgentRow,
  resolveTokenPrincipal,
} from "./accounts.mjs";
import { normalizeRole } from "./authz.mjs";
import {
  getRegistryPath,
  slugify,
} from "./registry.mjs";

/** Invite tokens: minted by you, redeemed once by an agent. */
export const INVITE_TOKEN_PREFIX = "fdsi_";
/** Agent tokens: minted at registration, held by the agent. */
export const AGENT_TOKEN_PREFIX = "fdsa_";

/** 16 bytes = 128 bits of entropy, hex-encoded so it survives any copy-paste. */
const TOKEN_BYTES = 16;
const ID_BYTES = 6;

/** Invites are a bootstrap credential, so they should not linger. */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_DELEGATE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_DELEGATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What an agent's `board_id` means — said out loud, on every surface that reports
 * an identity.
 *
 * `agents.board_id` is a foreign key to `boards.id` because a roster has to hang
 * off something: it scopes the live-actor uniqueness index (two agents may not
 * share an actor *on a board*), and it decides whose roster a new agent appears in.
 * That is the whole of its job. It is **not** a statement about where the agent's
 * work belongs — `routeTask` decides that, per item, from the item's own text and
 * repos.
 *
 * Nothing in the code confused the two; agents did, and reasonably. A sign-up that
 * cannot derive a board falls back to the board the daemon started on, which on the
 * hosted deployment is `example` — the zero-repo catch-all kept only as a
 * registration anchor. An agent reading `board_id: example` in its own identity and
 * concluding "so that is where I file" is drawing the obvious inference from a
 * field that never said otherwise. This is the field saying otherwise.
 *
 * Spread into a response rather than nested, so it is visible in a flat transcript
 * dump without anyone having to open a sub-object.
 */
export const HOME_BOARD_NOTE = Object.freeze({
  home_board_is_registration_anchor: true,
  home_board_hint:
    "The board_id in this identity is where you are REGISTERED, not where your work " +
    "goes: it scopes the roster and the claim-collision check, nothing else. Pick a " +
    "board per item with board_route(), and switch a session with context(board=...). " +
    "Filing everything on the board named here is exactly how a catch-all board " +
    "becomes everyone's default.",
});

/**
 * A token was rejected. `reason` is a stable machine-readable code so callers can
 * branch (and exit distinctly) without matching on message text.
 */
export class TokenError extends Error {
  /**
   * @param {string} message
   * @param {'malformed'|'unknown'|'expired'|'redeemed'|'revoked'} reason
   */
  constructor(message, reason) {
    super(message);
    this.name = "TokenError";
    this.reason = reason;
  }
}

/**
 * @param {string} prefix
 * @returns {string}
 */
function mintToken(prefix) {
  return prefix + crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix) {
  return prefix + crypto.randomBytes(ID_BYTES).toString("hex");
}

/**
 * Hash a token for storage and lookup.
 *
 * Lookup is by hash equality in SQL rather than by comparing candidates in JS.
 * That sidesteps the usual timing-comparison question entirely: the index is
 * consulted with a value derived from the presented token, and nothing about a
 * 128-bit random secret is recoverable from how long that takes.
 *
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token), "utf8")
    .digest("hex");
}

/**
 * Normalize an actor name into something safe to use as `BEADS_ACTOR`.
 *
 * This value ends up in an environment variable and in bd's assignee field, so it
 * must survive a shell without quoting. Reusing the registry's slugify keeps board
 * ids and actor names normalizing the same way.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeActor(input) {
  return slugify(input);
}

/**
 * A requested actor removal was refused before any identity state changed.
 */
export class AgentRemovalError extends Error {
  /**
   * @param {string} message
   * @param {'bad_request'|'target_not_found'|'self_removal'|'last_admin'} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details) {
    super(message);
    this.name = "AgentRemovalError";
    this.code = code;
    /** @type {Record<string, unknown> | undefined} */
    this.details = details;
  }
}

/**
 * @typedef {object} Invite
 * @property {string} id
 * @property {string} board_id
 * @property {string} actor
 * @property {string} display_name
 * @property {string} role          'user' or 'admin', fixed at mint time
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} expires_at   epoch ms; 0 means never
 * @property {number} redeemed_at
 * @property {string} redeemed_by  agents.id
 * @property {number} revoked_at
 * @property {string} notes
 */

/**
 * @typedef {object} Agent
 * @property {string} id
 * @property {string} board_id
 * @property {string} actor
 * @property {string} display_name
 * @property {string} role          'user' or 'admin' — the tier every check reads
 * @property {string} invite_id
 * @property {string} host
 * @property {string} workspace_dir
 * @property {string} session_id
 * @property {string} kind
 * @property {string|null} parent_agent_id
 * @property {number} expires_at
 * @property {number} archived_at
 * @property {number} registered_at
 * @property {number} last_seen_at
 * @property {number} revoked_at
 * @property {string} revoke_reason
 * @property {string} metadata
 */

// token_hash is never selected: keeping it out of every read path means it cannot
// be leaked by a caller that JSON-dumps whatever it was handed.
const INVITE_COLUMNS = `id, board_id, actor, display_name, role, created_by, created_at,
  expires_at, redeemed_at, redeemed_by, revoked_at, notes`;
const AGENT_COLUMNS = `agents.id, agents.board_id, agents.actor, agents.display_name, agents.role, agents.invite_id, agents.host,
  agents.workspace_dir, agents.session_id, agents.kind, agents.parent_agent_id, agents.expires_at, agents.archived_at,
  agents.registered_at, agents.last_seen_at, agents.revoked_at, agents.revoke_reason, agents.metadata,
  (SELECT p.actor FROM agents p WHERE p.id = agents.parent_agent_id) AS parent_actor`;

/**
 * Lifecycle state of an invite, derived rather than stored so an expiry needs no
 * sweeper to become true.
 *
 * @param {Invite} invite
 * @param {number} [now]
 * @returns {'pending'|'redeemed'|'revoked'|'expired'}
 */
export function inviteStatus(invite, now = Date.now()) {
  if (invite.redeemed_at > 0) return "redeemed";
  if (invite.revoked_at > 0) return "revoked";
  if (invite.expires_at > 0 && invite.expires_at <= now) return "expired";
  return "pending";
}

/**
 * Mint a single-use invite for one agent.
 *
 * The token is returned exactly once, here. It is not recoverable afterwards, so a
 * lost invite is replaced rather than looked up.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ board_id: string, actor?: string, display_name?: string,
 *           role?: string, created_by?: string, ttl_ms?: number,
 *           expires_at?: number, notes?: string }} input
 *   `actor` defaults to a slug of `display_name`. Pass `ttl_ms: 0` for no expiry.
 *   `role` is `user` unless explicitly `admin` — the tier is decided here, by the
 *   inviter, and the redeeming agent has no say in it.
 * @returns {{ invite: Invite, token: string }}
 */
export function createInvite(db, input) {
  const board = db
    .prepare("SELECT id FROM boards WHERE id = ?")
    .get(input.board_id);
  if (!board) throw new Error(`no such board: ${input.board_id}`);

  const actor = normalizeActor(input.actor || input.display_name || "");
  if (!actor) {
    throw new Error(
      "an actor name is required — pass --name or --actor with letters in it",
    );
  }

  // Refusing here rather than at redeem time is the whole value: the collision is
  // reported to the person who can still pick another name, not to an agent that
  // has already been handed a token it cannot use.
  const live = db
    .prepare(
      "SELECT id FROM agents WHERE board_id = ? AND actor = ? AND revoked_at = 0",
    )
    .get(input.board_id, actor);
  if (live) {
    throw new Error(
      `actor "${actor}" is already registered on board ${input.board_id}\n` +
        `  reuse the name:  feads-agent revoke ${actor} --board ${input.board_id}\n` +
        `  or pick another: feads-agent invite --name <other-name>`,
    );
  }
  const now = Date.now();
  const pending = db
    .prepare(
      `SELECT id FROM agent_invites
       WHERE board_id = ? AND actor = ? AND redeemed_at = 0 AND revoked_at = 0
         AND (expires_at = 0 OR expires_at > ?)`,
    )
    .get(input.board_id, actor, now);
  if (pending) {
    throw new Error(
      `an unredeemed invite for "${actor}" already exists (${pending.id})\n` +
        `  the token was only shown once; replace it with:\n` +
        `    feads-agent revoke-invite ${pending.id} && feads-agent invite --name ${actor}`,
    );
  }

  const token = mintToken(INVITE_TOKEN_PREFIX);
  const id = newId("inv_");
  const ttl = input.ttl_ms === undefined ? DEFAULT_INVITE_TTL_MS : input.ttl_ms;
  const expires_at =
    input.expires_at !== undefined ? input.expires_at : ttl > 0 ? now + ttl : 0;

  db.prepare(
    `INSERT INTO agent_invites
       (id, board_id, actor, display_name, role, token_hash, created_by, created_at,
        expires_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.board_id,
    actor,
    input.display_name || actor,
    normalizeRole(input.role),
    hashToken(token),
    input.created_by || "",
    now,
    expires_at,
    input.notes || "",
  );

  const invite = getInvite(db, id);
  if (!invite)
    throw new Error(`invite ${id} vanished immediately after insert`);
  return { invite, token };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {Invite | null}
 */
export function getInvite(db, id) {
  const row = db
    .prepare(`SELECT ${INVITE_COLUMNS} FROM agent_invites WHERE id = ?`)
    .get(id);
  return row ? /** @type {Invite} */ (row) : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ board_id?: string, include_inactive?: boolean }} [options]
 * @returns {Invite[]}
 */
export function listInvites(db, options = {}) {
  const rows = options.board_id
    ? db
        .prepare(
          `SELECT ${INVITE_COLUMNS} FROM agent_invites WHERE board_id = ?
           ORDER BY created_at DESC`,
        )
        .all(options.board_id)
    : db
        .prepare(
          `SELECT ${INVITE_COLUMNS} FROM agent_invites ORDER BY created_at DESC`,
        )
        .all();
  const invites = /** @type {Invite[]} */ (rows);
  if (options.include_inactive) return invites;
  return invites.filter((i) => inviteStatus(i) === "pending");
}

/**
 * Revoke an unredeemed invite. Redeeming one already consumed it, so revoking
 * after the fact is a no-op by design — revoke the *agent* instead.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {boolean} whether a row changed
 */
export function revokeInvite(db, id) {
  const res = db
    .prepare(
      "UPDATE agent_invites SET revoked_at = ? WHERE id = ? AND revoked_at = 0",
    )
    .run(Date.now(), id);
  return Number(res.changes) > 0;
}

/**
 * Redeem an invite token and register the agent it names.
 *
 * The invite is consumed in the same transaction that creates the agent, so a
 * token cannot be redeemed twice even if two agents present it at once — the
 * conditional UPDATE is the guard, not a prior read.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ token: string, host?: string, workspace_dir?: string,
 *           session_id?: string, display_name?: string, kind?: string,
 *           metadata?: object }} input
 * @returns {{ agent: Agent, token: string, invite_id: string }}
 *   `token` is the agent's durable credential, returned only here.
 * @throws {TokenError}
 */
export function registerAgent(db, input) {
  const presented = String(input.token || "").trim();
  if (!presented.startsWith(INVITE_TOKEN_PREFIX)) {
    throw new TokenError(
      `not an invite token (expected one starting with ${INVITE_TOKEN_PREFIX})`,
      "malformed",
    );
  }

  const row = db
    .prepare(`SELECT ${INVITE_COLUMNS} FROM agent_invites WHERE token_hash = ?`)
    .get(hashToken(presented));
  if (!row) throw new TokenError("invite token not recognized", "unknown");
  const invite = /** @type {Invite} */ (row);

  const now = Date.now();
  const status = inviteStatus(invite, now);
  if (status === "redeemed") {
    throw new TokenError(
      `invite ${invite.id} was already redeemed — invites are single-use, ask for a fresh one`,
      "redeemed",
    );
  }
  if (status === "revoked")
    throw new TokenError(`invite ${invite.id} was revoked`, "revoked");
  if (status === "expired") {
    throw new TokenError(
      `invite ${invite.id} expired on ${new Date(invite.expires_at).toISOString()}`,
      "expired",
    );
  }

  const token = mintToken(AGENT_TOKEN_PREFIX);
  const id = newId("ag_");

  db.exec("BEGIN IMMEDIATE");
  try {
    // Consume first, and only if still unconsumed. A second concurrent redeem
    // changes zero rows here and is rejected before any agent row exists.
    const consumed = db
      .prepare(
        `UPDATE agent_invites SET redeemed_at = ?, redeemed_by = ?
         WHERE id = ? AND redeemed_at = 0 AND revoked_at = 0`,
      )
      .run(now, id, invite.id);
    if (Number(consumed.changes) === 0) {
      throw new TokenError(
        `invite ${invite.id} was already redeemed — invites are single-use, ask for a fresh one`,
        "redeemed",
      );
    }
    db.prepare(
      `INSERT INTO agents
         (id, board_id, actor, display_name, role, invite_id, token_hash, host,
          workspace_dir, session_id, kind, registered_at, last_seen_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      invite.board_id,
      invite.actor,
      input.display_name || invite.display_name || invite.actor,
      // From the invite, never from `input`: an agent must not be able to name its
      // own tier at redeem time.
      normalizeRole(invite.role),
      invite.id,
      hashToken(token),
      input.host || os.hostname(),
      input.workspace_dir ? path.resolve(input.workspace_dir) : "",
      input.session_id || "",
      input.kind || "agent",
      now,
      now,
      JSON.stringify(input.metadata || {}),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    if (err instanceof TokenError) throw err;
    // The live-actor unique index is the other way this fails: the name was taken
    // between minting the invite and redeeming it.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("agents_live_actor_idx")) {
      throw new Error(
        `actor "${invite.actor}" was registered by someone else since this invite was minted`,
      );
    }
    throw err;
  }

  const agent = getAgent(db, id);
  if (!agent) throw new Error(`agent ${id} vanished immediately after insert`);
  return { agent, token, invite_id: invite.id };
}

/**
 * Delegate a short-lived user agent from an existing live parent.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ parent_agent_id: string, handle: string, display_name?: string,
 *           ttl_ms?: number, host?: string, workspace_dir?: string,
 *           session_id?: string, metadata?: object }} input
 * @returns {{ agent: Agent, token: string }}
 */
export function delegateAgent(db, input) {
  const parent = getAgent(db, input.parent_agent_id);
  if (
    !parent ||
    parent.revoked_at > 0 ||
    (parent.expires_at > 0 && parent.expires_at <= Date.now())
  )
    throw new Error("parent agent is not live");
  const handle = String(input.handle || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(handle) || handle.includes("/"))
    throw new Error("handle must match [a-z0-9._-] and may not contain /");
  const actor = `${parent.actor}-${handle}`;
  const now = Date.now();
  const ttl = Math.min(
    Math.max(Number(input.ttl_ms ?? DEFAULT_DELEGATE_TTL_MS), 1),
    MAX_DELEGATE_TTL_MS,
  );
  const token = mintToken(AGENT_TOKEN_PREFIX),
    id = newId("ag_");
  db.prepare(
    `INSERT INTO agents (id, board_id, actor, display_name, role, invite_id, token_hash, host, workspace_dir, session_id, kind, parent_agent_id, expires_at, registered_at, last_seen_at, metadata) VALUES (?, ?, ?, ?, 'user', '', ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    parent.board_id,
    actor,
    input.display_name || handle,
    hashToken(token),
    input.host || os.hostname(),
    input.workspace_dir ? path.resolve(input.workspace_dir) : "",
    input.session_id || "",
    parent.id,
    now + ttl,
    now,
    now,
    JSON.stringify(input.metadata || {}),
  );
  const agent = getAgent(db, id);
  if (!agent) throw new Error(`agent ${id} vanished immediately after insert`);
  return { agent, token };
}

/**
 * Sign up: mint an identity and hand back its token, in one call.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ board_id: string, display_name: string, actor?: string, host?: string,
 *           workspace_dir?: string, session_id?: string, kind?: string,
 *           created_by?: string, metadata?: object }} input
 * @returns {{ agent: Agent, token: string, invite_id: string }}
 */
export function signupAgent(db, input) {
  const minted = createInvite(db, {
    board_id: input.board_id,
    actor: input.actor || input.display_name,
    display_name: input.display_name,
    role: "user",
    created_by: input.created_by || "signup",
    notes: "self sign-up",
  });
  try {
    return registerAgent(db, {
      token: minted.token,
      host: input.host,
      workspace_dir: input.workspace_dir,
      session_id: input.session_id,
      kind: input.kind,
      metadata: input.metadata,
    });
  } catch (err) {
    // The invite was never shown to anyone, so revoking it loses nothing and stops it
    // from lingering as an unusable pending invite that blocks the same actor name.
    revokeInvite(db, minted.invite.id);
    throw err;
  }
}

/**
 * Look an agent up by id, or by actor name.
 *
 * A revoked agent keeps its row, so an actor lookup prefers the live one and only
 * then falls back to history — otherwise revoking and re-registering a name would
 * resolve to the dead row.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id_or_actor
 * @param {{ board_id?: string }} [options]
 * @returns {Agent | null}
 */
export function getAgent(db, id_or_actor, options = {}) {
  let row = db
    .prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`)
    .get(id_or_actor);
  if (!row && options.board_id) {
    row = db
      .prepare(
        `SELECT ${AGENT_COLUMNS} FROM agents WHERE board_id = ? AND actor = ?
         ORDER BY revoked_at = 0 DESC, registered_at DESC LIMIT 1`,
      )
      .get(options.board_id, normalizeActor(id_or_actor));
  }
  if (!row) {
    row = db
      .prepare(
        `SELECT ${AGENT_COLUMNS} FROM agents WHERE actor = ?
         ORDER BY revoked_at = 0 DESC, registered_at DESC LIMIT 1`,
      )
      .get(normalizeActor(id_or_actor));
  }
  return row ? /** @type {Agent} */ (row) : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ board_id?: string, include_revoked?: boolean, host?: string }} [options]
 * @returns {Agent[]}
 */
export function listAgents(db, options = {}) {
  const where = [];
  const params = [];
  if (options.board_id) {
    where.push("board_id = ?");
    params.push(options.board_id);
  }
  if (options.host) {
    where.push("host = ?");
    params.push(options.host);
  }
  if (!options.include_revoked) {
    where.push(
      "revoked_at = 0 AND archived_at = 0 AND (expires_at = 0 OR expires_at > ?)",
    );
    params.push(Date.now());
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${AGENT_COLUMNS} FROM agents ${clause}
       ORDER BY revoked_at = 0 DESC, last_seen_at DESC`,
    )
    .all(...params);
  return /** @type {Agent[]} */ (rows);
}

/**
 * Resolve the agent belonging to a session.
 *
 * This is how an agent finds itself in a later shell without a credential file
 * lookup: Claude Code exports a stable `CLAUDE_CODE_SESSION_ID` for the whole
 * session, and registration records it. Two concurrent sessions on one machine
 * therefore resolve to different agents, which a host-wide lookup could not do.
 *
 * `include_revoked` is what lets a caller tell "this session never registered" apart
 * from "this session belongs to an agent that was revoked". Those must not be the
 * same answer: the second is a rejected credential, and treating it as the first
 * inverts revocation — see `resolveAgentIdentity`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} session_id
 * @param {{ board_id?: string, include_revoked?: boolean }} [options]
 * @returns {Agent | null}
 */
export function findAgentBySession(db, session_id, options = {}) {
  if (!session_id) return null;
  const where = ["session_id = ?"];
  const params = [session_id];
  if (options.board_id) {
    where.push("board_id = ?");
    params.push(options.board_id);
  }
  if (!options.include_revoked) where.push("revoked_at = 0");
  const row = db
    .prepare(
      `SELECT ${AGENT_COLUMNS} FROM agents WHERE ${where.join(" AND ")}
       ORDER BY revoked_at = 0 DESC, registered_at DESC LIMIT 1`,
    )
    .get(...params);
  return row ? /** @type {Agent} */ (row) : null;
}

/**
 * Resolve who a caller is from its environment — the one implementation every
 * JavaScript surface must use.
 *
 * Resolution is as security-sensitive as the policy itself, and unlike the policy it
 * was drifting: the CLI refused an unverifiable token while the UI quietly treated it
 * as "unidentified", which locally means operator. Both doors lead to the same
 * inversion — **revoking an agent would promote it** — so the order lives here, and
 * `authz-cases.json` pins it (`resolution_cases`) for the Python port too.
 *
 * The three-way distinction that matters:
 *
 * - **A token that does not verify is a rejection.** Something was presented and
 *   failed. It is not rescued by a session id, because an explicit credential that
 *   fails must not fall back to a weaker one that happens to succeed.
 * - **A session matching a *revoked* agent is a rejection.** This is the common door
 *   for a long-lived daemon, which has no token but always has a session id.
 * - **A session matching *nothing* is not a rejection.** Claude Code exports
 *   `CLAUDE_CODE_SESSION_ID` into every session whether or not anyone registered, so
 *   treating an unmatched session as a refused credential would deny nearly every
 *   caller.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, string | undefined>} env
 * @param {{ board_id?: string }} [options]
 * @returns {{ agent: Agent | null, credential_rejected: boolean,
 *             via: 'token'|'session'|'rejected'|'none' }}
 */
export function resolveAgentIdentity(db, env, options = {}) {
  const token = String(env.FEADS_AGENT_TOKEN || "").trim();
  if (token) {
    const agent = verifyAgentToken(db, token);
    if (agent) return { agent, credential_rejected: false, via: "token" };
    return { agent: null, credential_rejected: true, via: "rejected" };
  }

  const session = String(env.CLAUDE_CODE_SESSION_ID || "").trim();
  if (session) {
    const live = findAgentBySession(db, session, {
      board_id: options.board_id,
    });
    if (live && accountsEnabled(db, env)) {
      const mapped = principalForAgentRow(db, live, { env });
      return mapped
        ? {
            agent: /** @type {Agent} */ (mapped.agent),
            credential_rejected: false,
            via: "session",
          }
        : { agent: null, credential_rejected: true, via: "rejected" };
    }
    if (live)
      return { agent: live, credential_rejected: false, via: "session" };
    const revoked = findAgentBySession(db, session, {
      board_id: options.board_id,
      include_revoked: true,
    });
    if (revoked)
      return { agent: null, credential_rejected: true, via: "rejected" };
  }

  return { agent: null, credential_rejected: false, via: "none" };
}

/**
 * Authenticate an agent by its durable token.
 *
 * Nothing local requires this yet — `whoami --token` is its only caller today. It
 * is the function a hosted HTTP surface would call per request, and it is here now
 * so that surface is a transport change rather than a schema change.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token
 * @returns {Agent | null} null for unknown *or* revoked, so a revoked token is
 *   indistinguishable from a wrong one to a caller.
 */
export function verifyAgentToken(db, token) {
  const presented = String(token || "").trim();
  if (!presented.startsWith(AGENT_TOKEN_PREFIX)) return null;
  // Accounts mode (the excluded hosted-provider design): a legacy token
  // owned by a user authenticates *as that user* (the user's principal row,
  // decorated with the old actor as provenance), a personal connection token
  // resolves the same way, and an unclaimed legacy token is unchanged. Done here
  // so every caller of this function gets the mapping without knowing about it.
  if (accountsEnabled(db)) {
    const resolved = resolveTokenPrincipal(db, presented);
    return resolved && resolved.agent
      ? /** @type {Agent} */ (resolved.agent)
      : null;
  }
  const row = db
    .prepare(
      `SELECT ${AGENT_COLUMNS} FROM agents WHERE token_hash = ? AND revoked_at = 0 AND archived_at = 0 AND (expires_at = 0 OR expires_at > ?)`,
    )
    .get(hashToken(presented), Date.now());
  return row ? /** @type {Agent} */ (row) : null;
}

/**
 * Record that an agent is alive.
 *
 * `last_seen_at` is what makes the stale-claim sweep honest: an in-progress bead
 * held by an agent that checked in a minute ago is live work, while the same bead
 * held by one last seen yesterday is abandoned. Wall-clock age of the *bead* cannot
 * tell those apart.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} agent_id
 * @param {{ session_id?: string, host?: string, workspace_dir?: string }} [fields]
 * @returns {Agent | null}
 */
export function touchAgent(db, agent_id, fields = {}) {
  const sets = ["last_seen_at = ?"];
  /** @type {Array<string|number>} */
  const params = [Date.now()];
  if (fields.session_id) {
    sets.push("session_id = ?");
    params.push(fields.session_id);
  }
  if (fields.host) {
    sets.push("host = ?");
    params.push(fields.host);
  }
  if (fields.workspace_dir) {
    sets.push("workspace_dir = ?");
    params.push(path.resolve(fields.workspace_dir));
  }
  params.push(agent_id);
  db.prepare(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = ? AND revoked_at = 0`,
  ).run(...params);
  return getAgent(db, agent_id);
}

/**
 * @typedef {object} AgentRemovalPlan
 * @property {string} actor
 * @property {string[]} ids
 * @property {string[]} root_ids
 * @property {Agent[]} agents
 * @property {number} now
 */

/**
 * Whether an agent row still counts as live for an administrative safety check.
 *
 * @param {Agent | Record<string, any>} agent
 * @param {number} now
 */
function isLiveAgent(agent, now) {
  return (
    Number(agent.revoked_at || 0) === 0 &&
    Number(agent.archived_at || 0) === 0 &&
    (Number(agent.expires_at || 0) === 0 || Number(agent.expires_at) > now)
  );
}

/**
 * Read and validate the complete removal closure without changing the registry.
 * The target actor is case-insensitive; the closure follows every descendant,
 * including an already-revoked child whose inert row still carries provenance.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ actor: string, requester_agent_id?: string, requester_actor?: string }} input
 * @returns {AgentRemovalPlan}
 */
export function inspectAgentRemoval(db, input) {
  const actor = typeof input?.actor === "string" ? input.actor.trim() : "";
  if (actor.length === 0) {
    throw new AgentRemovalError(
      "remove-user requires a non-empty actor",
      "bad_request",
    );
  }

  const now = Date.now();
  const roots = db
    .prepare(
      `SELECT ${AGENT_COLUMNS} FROM agents
       WHERE lower(actor) = lower(?) AND revoked_at = 0 AND archived_at = 0
         AND (expires_at = 0 OR expires_at > ?)
       ORDER BY board_id, registered_at, id`,
    )
    .all(actor, now);
  if (roots.length === 0) {
    throw new AgentRemovalError(
      `no live agent matches actor "${actor}"`,
      "target_not_found",
    );
  }

  const rows = db
    .prepare(
      `WITH RECURSIVE roots(id) AS (
         SELECT id FROM agents
          WHERE lower(actor) = lower(?) AND revoked_at = 0 AND archived_at = 0
            AND (expires_at = 0 OR expires_at > ?)
       ), closure(id) AS (
         SELECT id FROM roots
         UNION
         SELECT child.id FROM agents child
         JOIN closure parent ON child.parent_agent_id = parent.id
       )
       SELECT ${AGENT_COLUMNS} FROM agents
        WHERE agents.id IN (SELECT id FROM closure)
        ORDER BY board_id, registered_at, id`,
    )
    .all(actor, now);
  const agents = /** @type {Agent[]} */ (rows);
  const ids = agents.map((agent) => String(agent.id));
  const root_ids = roots.map((agent) => String(agent.id));
  const requester_id = String(input?.requester_agent_id || "");
  const requester_actor = String(input?.requester_actor || "").trim();
  if (
    (requester_id.length > 0 && ids.includes(requester_id)) ||
    (requester_actor.length > 0 &&
      roots.some(
        (agent) =>
          String(agent.actor || "").toLowerCase() ===
          requester_actor.toLowerCase(),
      ))
  ) {
    throw new AgentRemovalError(
      "an administrator cannot remove its own identity or a parent of it",
      "self_removal",
    );
  }

  const admin_count_row = db
    .prepare(
      `SELECT count(*) AS count FROM agents
       WHERE lower(role) = 'admin' AND revoked_at = 0 AND archived_at = 0
         AND (expires_at = 0 OR expires_at > ?)`,
    )
    .get(now);
  const admin_count = Number(admin_count_row?.count || 0);
  const removed_admin_count = agents.filter(
    (agent) => isLiveAgent(agent, now) && normalizeRole(agent.role) === "admin",
  ).length;
  if (removed_admin_count > 0 && admin_count <= removed_admin_count) {
    throw new AgentRemovalError(
      "cannot remove the last live administrator",
      "last_admin",
      { live_admins: admin_count, removed_admins: removed_admin_count },
    );
  }

  return { actor, ids, root_ids, agents, now };
}

/**
 * Revoke and scrub an actor and its delegation descendants after its owned data
 * has been purged from the Postgres store.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ actor: string, requester_agent_id?: string, requester_actor?: string,
 *           reason?: string }} input
 * @returns {{ actor: string, agents: number, runtime_presence: number, flares: number,
 *   invites: number, notifications: number, notify_state: number }}
 */
export function removeAgentActor(db, input) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = inspectAgentRemoval(db, input);
    const placeholders = plan.ids.map(() => "?").join(", ");
    const actors = [
      ...new Set(
        plan.agents
          .map((agent) => String(agent.actor || "").toLowerCase())
          .filter((value) => value.length > 0),
      ),
    ];
    const actor_placeholders = actors.map(() => "?").join(", ");
    const reason = String(input.reason || `removed actor ${plan.actor}`);
    const counts = {
      actor: plan.actor,
      agents: plan.ids.length,
      runtime_presence: 0,
      flares: 0,
      invites: 0,
      notifications: 0,
      notify_state: 0,
    };

    counts.runtime_presence = Number(
      db
        .prepare(
          `DELETE FROM agent_runtime_presence WHERE agent_id IN (${placeholders})`,
        )
        .run(...plan.ids).changes || 0,
    );
    counts.flares = Number(
      db
        .prepare(`DELETE FROM work_flares WHERE agent_id IN (${placeholders})`)
        .run(...plan.ids).changes || 0,
    );
    counts.invites = Number(
      db
        .prepare(
          `DELETE FROM agent_invites
           WHERE lower(actor) IN (${actor_placeholders})
              OR lower(created_by) IN (${actor_placeholders})`,
        )
        .run(...actors, ...actors).changes || 0,
    );
    counts.notifications = Number(
      db
        .prepare(
          `DELETE FROM notifications
           WHERE lower(recipient_actor) IN (${actor_placeholders})
              OR lower(actor) IN (${actor_placeholders})`,
        )
        .run(...actors, ...actors).changes || 0,
    );
    counts.notify_state = Number(
      db.prepare("DELETE FROM notify_state").run().changes || 0,
    );

    const used_hashes = new Set();
    const scrub = db.prepare(
      `UPDATE agents SET
         revoked_at = CASE WHEN revoked_at = 0 THEN ? ELSE revoked_at END,
         revoke_reason = CASE
           WHEN revoke_reason = '' THEN ?
           ELSE revoke_reason || '; ' || ?
         END,
         display_name = '', host = '', workspace_dir = '', session_id = '',
         invite_id = '', metadata = ?, token_hash = ?
       WHERE id = ?`,
    );
    for (const agent of plan.agents) {
      let token_hash;
      do {
        token_hash = hashToken(mintToken(AGENT_TOKEN_PREFIX));
      } while (used_hashes.has(token_hash));
      used_hashes.add(token_hash);
      scrub.run(plan.now, reason, reason, "{}", token_hash, agent.id);
    }

    db.exec("COMMIT");
    return counts;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original safety or storage error.
    }
    throw error;
  }
}

/**
 * Revoke an agent. Its row is kept — the roster is a record of who worked the
 * board, and deleting it would erase the provenance of past claims — but its token
 * stops verifying and its actor name becomes available again.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} agent_id
 * @param {string} [reason]
 * @returns {boolean} whether a row changed
 */
export function revokeAgent(db, agent_id, reason = "") {
  const now = Date.now();
  const res = db
    .prepare(
      "UPDATE agents SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at = 0",
    )
    .run(now, reason, agent_id);
  db.prepare(
    "UPDATE agents SET revoked_at = ?, revoke_reason = ? WHERE parent_agent_id = ? AND revoked_at = 0",
  ).run(now, `parent revoked: ${reason}`, agent_id);
  return Number(res.changes) > 0;
}

/**
 * Change an agent's tier.
 *
 * Separate from registration so a promotion is an explicit operator act with its own
 * audit trail, rather than something that can ride along in a redeem.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} agent_id
 * @param {string} role
 * @returns {Agent | null}
 */
export function setAgentRole(db, agent_id, role) {
  db.prepare("UPDATE agents SET role = ? WHERE id = ? AND revoked_at = 0").run(
    normalizeRole(role),
    agent_id,
  );
  return getAgent(db, agent_id);
}

/**
 * How many live agents hold each tier.
 *
 * Used to tell an operator that a board has no admin yet — a board whose only agents
 * are users has nobody who can mint the next invite through an authenticated path.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ board_id?: string }} [options]
 * @returns {{ user: number, admin: number }}
 */
export function countAgentsByRole(db, options = {}) {
  const counts = { user: 0, admin: 0 };
  for (const agent of listAgents(db, { board_id: options.board_id })) {
    counts[normalizeRole(agent.role)] += 1;
  }
  return counts;
}

/**
 * Where an agent's own copy of its token lives.
 *
 * Per-agent rather than one shared file: several agents share a machine, and a
 * single `~/.feads/agent.json` would have them overwrite each other's credential.
 *
 * @param {string} agent_id
 * @returns {string}
 */
export function credentialPath(agent_id) {
  return path.join(
    path.dirname(getRegistryPath()),
    "agents",
    `${agent_id}.json`,
  );
}

/**
 * Persist an agent's credential, readable only by its owner.
 *
 * @param {Agent} agent
 * @param {string} token
 * @returns {string} the path written
 */
export function writeCredential(agent, token) {
  const file = credentialPath(agent.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        agent_id: agent.id,
        board_id: agent.board_id,
        actor: agent.actor,
        // Informational only. Every surface re-reads the tier from the database on
        // each check, so editing this file cannot promote anyone.
        role: agent.role,
        token,
        registered_at: agent.registered_at,
      },
      null,
      2,
    ) + "\n",
    // 0600 up front rather than write-then-chmod: the latter leaves a window where
    // the token is world-readable.
    { mode: 0o600 },
  );
  return file;
}

/**
 * @param {string} agent_id
 * @returns {{ agent_id: string, board_id: string, actor: string, token: string } | null}
 */
export function readCredential(agent_id) {
  const file = credentialPath(agent_id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Remove an agent's local credential. Called on revoke so a revoked agent does not
 * keep presenting a token that no longer verifies.
 *
 * @param {string} agent_id
 * @returns {boolean}
 */
export function removeCredential(agent_id) {
  const file = credentialPath(agent_id);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}
