/**
 * Notifications — the store and the diff engine behind the agent inbox.
 *
 * The problem this solves: agents (and humans) act on boards through three
 * different doors — the dashboard, the MCP server, and bare `bd` — and none of
 * those doors can see the others. So "someone commented on my issue" cannot be
 * an event hook on any one write path; it has to be derived from the board
 * itself. The dashboard's notification engine periodically diffs a `bd export`
 * of each board against the last exported state (`notify_state`) and mints
 * rows here for whoever should hear about the difference.
 *
 * Everything in this module is either SQL against the registry database or a
 * pure function over parsed export lines, so the whole event model is testable
 * without a board, a watcher, or a running `bd`.
 *
 * Who gets told what (the contract, mirrored by the MCP tools and the docs):
 *   - `mention`               — a new comment names @you.
 *   - `assigned`              — an issue's assignee became you.
 *   - `comment_on_owned`      — new comment on an issue you own (assignee or
 *                               creator), written by someone else.
 *   - `update_on_commented`   — an issue you commented on changed under you:
 *                               a new comment by someone else, a status change,
 *                               or any other edit.
 *   - `dependency_completed`  — an issue yours was waiting on was closed.
 *
 *
 * Agent-only coordination types (2026-10 — "coordinate, don't block"):
 *   - `reassigned_away`       — an issue assigned to you is now someone else's.
 *   - `work_overlap`          — live work whose artifacts overlap artifacts on
 *                               your live work was declared, claimed or started
 *                               by someone else (both sides are told).
 *   - `status_on_owned`       — an issue you own (assignee or creator) changed
 *                               status at someone else's hand.
 *   - `new_in_area`           — someone filed a new child under an epic you own.
 *
 * Audience: humans see ONLY `mention` rows (the dashboard bell, the unread
 * badge); every type reaches agents (MCP `notifications`, HTTP
 * `/api/notifications`). See `HUMAN_NOTIFICATION_TYPES` / `audienceOf`.
 *
 * One scan mints at most one row per (recipient, issue): the types above are
 * listed from most to least specific, and the most specific wins. Nobody is
 * ever notified of their own action when the actor is knowable (comment
 * authorship always is; status flips through bare `bd` are not). Across scans,
 * a burst of the same agent-only type on the same issue collapses into the one
 * still-unhandled row (`count` + latest snippet) instead of stacking up.
 */

import crypto from "node:crypto";

import { INTENT_DONE, INTENT_EDITING, artifactsFromMetadata, overlap } from "./artifacts.mjs";
import { extractMentions, mentionLookupKeys } from "./mentions.mjs";
// Cyclic (accounts → registry → notifications) but used only at call time.
import { getUserById, serviceMemberships } from "./accounts.mjs";

/**
 * Mention syntax: `@` + actor handle. The handle charset matches what
 * `normalizeActor` in agents.mjs can mint, and the left guard keeps email
 * addresses (`a@b`) and doubled ats from reading as mentions.
 *
 * A handle never ends in `.`, `_` or `-` (`normalizeActor` cannot mint one
 * that does), so the pattern does not either: `cc @mira.` and `ask
 * @dana-laptop-` mention `mira` and `dana-laptop` instead of a name nobody has.
 * Still at most 64 characters.
 *
 * Kept as the cheap shape test; the parser of record is `extractMentions`
 * (boards/mentions.mjs), which also handles the `@user@domain` form and skips
 * code spans/blocks, URLs and package scopes. The browser and the Python MCP
 * server implement the same rules against the shared fixture
 * boards/mention-cases.json, so the three cannot drift.
 */
export const MENTION_RE =
  /(^|[^\w@])@([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)/gi;

/**
 * At most this many distinct handles are remembered per description (the
 * cursor's `dm`), which bounds the cursor however a description is written.
 */
const DESCRIPTION_MENTIONS_MAX = 50;

/**
 * Ticket reference syntax: `#` + issue id (`prefix-suffix`, the shape
 * cmd/bd/rename.go enforces). The trailing character class stops one short of
 * sentence punctuation so `see #ex-abc.` links `ex-abc`, not `ex-abc.`.
 */
export const ISSUE_REF_RE =
  /(^|[^\w#])#([a-z][a-z0-9]*-[a-zA-Z0-9._-]*[a-zA-Z0-9_])/g;

/** Dependency kinds that mean "must finish first" — same set the story view
 * treats as scheduling edges (story-snapshots.js SCHEDULING_DEP_TYPES). */
export const BLOCKING_DEP_TYPES = new Set([
  "blocks",
  "conditional-blocks",
  "waits-for",
]);

/** Most-specific-first; used to pick the one row a (recipient, issue) keeps. */
const TYPE_PRIORITY = [
  "mention",
  "assigned",
  "reassigned_away",
  "work_overlap",
  "dependency_completed",
  "comment_on_owned",
  "status_on_owned",
  "new_in_area",
  "update_on_commented",
];

/** Every type the engine mints, most specific first. */
export const NOTIFICATION_TYPES = Object.freeze([...TYPE_PRIORITY]);

/**
 * What a *human* is shown — the dashboard bell, its unread badge, and any
 * other human channel: only the rows where they were explicitly @mentioned.
 * Everything else is coordination traffic for their agents, which see every
 * type. One constant, mirrored by `HUMAN_NOTIFICATION_TYPES` in the Python MCP
 * server, so the two surfaces cannot disagree on what a human sees.
 */
export const HUMAN_NOTIFICATION_TYPES = Object.freeze(["mention"]);

/**
 * Agent-only coordination types that describe a moment rather than an
 * obligation. Unhandled rows of these types expire (see `pruneNotifications`);
 * a two-week-old "someone started on a file you declared" is noise, not news.
 */
export const EPHEMERAL_NOTIFICATION_TYPES = Object.freeze([
  "reassigned_away",
  "work_overlap",
  "status_on_owned",
  "new_in_area",
]);

/** Types that never collapse: every mention is its own question. */
const NON_COLLAPSING_TYPES = new Set(["mention"]);

/**
 * Who a row is for: `'all'` (the bell AND agents) or `'agent'` (agent
 * surfaces only).
 *
 * @param {string} type
 * @returns {'all' | 'agent'}
 */
export function audienceOf(type) {
  return HUMAN_NOTIFICATION_TYPES.includes(String(type)) ? "all" : "agent";
}

/** Cap on rows one issue's artifacts can mint per scan (a repo-wide artifact
 * overlaps everything in the repo; telling the whole company is not useful). */
const OVERLAP_FANOUT_MAX = 8;

const SNIPPET_MAX = 200;

/**
 * @typedef {Object} NotificationRow
 * @property {string} id
 * @property {string} board_id
 * @property {string} recipient_actor
 * @property {string} type
 * @property {string} issue_id
 * @property {string} issue_title
 * @property {string} actor - Who caused it; `''` when unknowable.
 * @property {string} snippet
 * @property {string} related_issue
 * @property {number} created_at - Epoch ms.
 * @property {number} read_at - Epoch ms; 0 = not yet *seen* (the bell).
 * @property {number} handled_at - Epoch ms; 0 = not yet *handled* (an agent
 * ack). Seen and handled are different promises: a human glancing at the bell
 * marks a row seen, but only an agent's ack — "I acted on this" — marks it
 * handled. The split is what stops a bell click from silently discharging a
 * question no agent has answered yet.
 * @property {string} url - Dashboard hash route for the issue.
 * @property {number} [count] - Events collapsed into this row (1 = just this
 * one). A burst of the same agent-only type on the same issue bumps the
 * still-unhandled row instead of minting another.
 * @property {string} [guidance] - "Coordinate, don't block": who to talk to
 * and a suggested next action, for agents.
 * @property {'all' | 'agent'} [audience] - See `audienceOf`.
 */

/**
 * @typedef {Object} ExportComment
 * @property {string} author
 * @property {string} text
 * @property {string} created_at - RFC3339 string as exported.
 */

/**
 * @typedef {Object} ExportIssue
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string} assignee
 * @property {string} created_by
 * @property {string} updated_at
 * @property {boolean} deleted
 * @property {ExportComment[]} comments
 * @property {Array<{ depends_on_id: string, type: string }>} dependencies
 * @property {Array<{ ref: string, intent: string }>} [artifacts] - Declared
 * artifacts (files, dirs, repos, PRs); absent when the source cannot say.
 * @property {string} [last_actor] - Who made the latest change, when the
 * source records it (Postgres `events`); bare `bd` exports cannot.
 * @property {string} [description] - The issue body, when the source exports
 * it; absent means "cannot say", and then description @mentions are neither
 * diffed nor remembered. (The Postgres export sends it only when it contains
 * an `@`, which is all the diff needs.)
 */

/**
 * Another piece of live work that holds artifacts — what a new claim or
 * declaration is checked against for overlap.
 *
 * @typedef {Object} ArtifactHolder
 * @property {string} issue_id
 * @property {string} board_id
 * @property {string} title
 * @property {string} status
 * @property {string} holder - assignee, else creator.
 * @property {Array<{ ref: string, intent: string }>} artifacts
 */

/**
 * The single point where a handle becomes an inbox. `resolve` maps any handle
 * (an actor, and — once accounts land — an alias) to the canonical recipient,
 * `''` when nobody can receive; `same` asks whether two handles are one
 * person. Every recipient decision in this module goes through it, so alias
 * resolution plugs in here and nowhere else.
 *
 * `canReceive` (accounts mode) is the space gate: may this recipient read the
 * board a row is about? A row the recipient could never open is not minted at
 * all — a mention of someone outside the issue's space notifies nobody rather
 * than storing the issue's title and text in their inbox. Absent = no gate.
 *
 * @typedef {Object} RecipientResolver
 * @property {(handle: string) => string} resolve
 * @property {(a: string, b: string) => boolean} same
 * @property {(recipient: string, board_id: string) => boolean} [canReceive]
 */

/**
 * @typedef {Object} IssueCursor
 * @property {string} s - status
 * @property {string} a - assignee
 * @property {string} u - updated_at
 * @property {number} cc - comment count
 * @property {string} lc - created_at of the newest comment seen
 * @property {string[]} [ar] - active artifacts as `ref|intent`, sorted;
 * absent on a cursor written before artifacts were tracked (which therefore
 * never reads as "every artifact is new").
 * @property {string[]} [dm] - lower-cased `@handles` in the description, as
 * written (not resolved); absent when the source did not export the
 * description or the cursor predates description mentions — then the next
 * scan only records them, it never announces them as new.
 */

/**
 * @typedef {{ issues: Record<string, IssueCursor> }} BoardState
 */

/**
 * Parse `bd export` JSONL keeping the fields the notification diff needs.
 * Tolerant per line, like the story collector: a malformed line loses that
 * line, not the scan.
 *
 * @param {string} text
 * @returns {ExportIssue[]}
 */
export function parseExportForNotifications(text) {
  /** @type {ExportIssue[]} */
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    /** @type {any} */
    let issue;
    try {
      issue = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id = String(issue?.id || "");
    if (id.length === 0) continue;
    const status = String(issue.status || "open");
    /** @type {ExportComment[]} */
    const comments = [];
    if (Array.isArray(issue.comments)) {
      for (const c of issue.comments) {
        comments.push({
          author: String(c?.author || ""),
          text: String(c?.text || ""),
          created_at: String(c?.created_at || ""),
        });
      }
    }
    comments.sort((x, y) => tsOf(x.created_at) - tsOf(y.created_at));
    /** @type {Array<{ depends_on_id: string, type: string }>} */
    const dependencies = [];
    if (Array.isArray(issue.dependencies)) {
      for (const dep of issue.dependencies) {
        const depends_on_id = String(dep?.depends_on_id || "");
        const type = String(dep?.type || "");
        if (depends_on_id.length > 0 && type.length > 0) {
          dependencies.push({ depends_on_id, type });
        }
      }
    }
    out.push({
      id,
      title: String(issue.title || ""),
      status,
      assignee: String(issue.assignee || ""),
      created_by: String(issue.created_by || ""),
      updated_at: String(issue.updated_at || ""),
      deleted:
        status === "tombstone" ||
        (issue.deleted_at !== undefined && issue.deleted_at !== null),
      comments,
      dependencies,
      artifacts: exportArtifacts(issue.metadata),
      // `bd export` always writes the body (empty bodies are omitted, i.e. "").
      description: String(issue.description || ""),
    });
  }
  return out;
}

/**
 * The artifacts in an issue's metadata, reduced to what the overlap check
 * needs. Tolerant: a malformed metadata blob yields none rather than failing
 * the scan.
 *
 * @param {unknown} metadata
 * @returns {Array<{ ref: string, intent: string }>}
 */
export function exportArtifacts(metadata) {
  if (!metadata || typeof metadata !== "object") return [];
  try {
    return artifactsFromMetadata(/** @type {any} */ (metadata)).map((a) => ({
      ref: a.ref,
      intent: a.intent,
    }));
  } catch {
    return [];
  }
}

/**
 * A resolver over the live-actor map, optionally alias-aware and space-gated.
 * See `RecipientResolver`.
 *
 * With accounts mode on, `aliases` maps every alias of a user (their agents'
 * actors, delegated children, loose aliases — lower-cased) to that user's actor
 * (`accounts.mjs aliasMap`). Then a handle resolves to its person, and two
 * aliases of one person are `same`: mira commenting on an issue owned by
 * `alex-laptop` is mira acting on their own issue, not news for anyone.
 * `reach` (see `spaceReach`) becomes `canReceive`.
 *
 * @param {Map<string, string>} live_actors - lowercase → canonical.
 * @param {Map<string, string> | null} [aliases] - lowercase alias → user actor.
 * @param {((recipient: string, board_id: string) => boolean) | null} [reach]
 * @returns {RecipientResolver}
 */
export function resolverFromLiveActors(live_actors, aliases = null, reach = null) {
  const person = (/** @type {string} */ lower) =>
    aliases ? aliases.get(lower) || "" : "";
  const resolve = (/** @type {string} */ handle) => {
    const lower = String(handle || "").toLowerCase();
    const user = person(lower);
    if (user) {
      const live = live_actors.get(user.toLowerCase());
      if (live) return live;
    }
    return live_actors.get(lower) || "";
  };
  /** @type {RecipientResolver} */
  const resolver = {
    resolve,
    same(a, b) {
      const x = String(a || "").toLowerCase();
      const y = String(b || "").toLowerCase();
      if (x.length === 0 || y.length === 0) return false;
      if (x === y) return true;
      if ((person(x) || x).toLowerCase() === (person(y) || y).toLowerCase()) {
        return true;
      }
      const rx = resolve(x);
      return rx.length > 0 && rx === resolve(y);
    },
  };
  if (typeof reach === "function") resolver.canReceive = reach;
  return resolver;
}

/**
 * The recipient resolver for a registry: who can receive, and who is whom.
 * Pass the accounts alias map (`accounts.mjs aliasMap`) when accounts mode is
 * on, so a person's aliases are one recipient and never notify each other, and
 * the space gate (`spaceReach`), so nobody is notified about a board they
 * cannot read.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ aliases?: Map<string, string> | null, reach?: ((recipient: string, board_id: string) => boolean) | null }} [options]
 * @returns {RecipientResolver}
 */
export function createRecipientResolver(db, options = {}) {
  return resolverFromLiveActors(
    liveActorsByLower(db),
    options.aliases || null,
    options.reach || null,
  );
}

/**
 * Accounts mode's space gate for minting: may `recipient` (a canonical
 * recipient — a user's actor, or an unclaimed legacy agent) read `board_id`?
 *
 * The union of the doors a person reads their inbox through: a superadmin's
 * browser reads every space, everyone else reads the spaces they are a member
 * of; an unclaimed legacy agent reads only the default space. Each door still
 * filters its own reads (`recipientScope`), so this only decides whether a row
 * is worth storing at all — and a row about a board the recipient can never
 * open is not: it would hold that issue's title and text.
 *
 * A row with no board counts as the default space (as the inbox reads do); a
 * board missing from `board_spaces` belongs to no space, so only superadmins
 * pass. `null` when the registry has no accounts tables (nothing to gate).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Map<string, string>} board_spaces - board id → space id
 * (`accounts.mjs boardSpaceMap`, with `data_ids` in Postgres mode — the same
 * map the inbox reads are scoped by).
 * @param {string} default_space
 * @param {Record<string, string | undefined>} [env] - for the steward roster gate
 * @returns {((recipient: string, board_id: string) => boolean) | null}
 */
export function spaceReach(db, board_spaces, default_space, env = process.env) {
  /** @type {any[]} */
  let users;
  /** @type {any[]} */
  let members;
  try {
    // A service account is never a superadmin (the excluded hosted-provider design
    // service-accounts.md), whatever its row says: it reaches its own spaces.
    users = db.prepare("SELECT * FROM users").all();
    members = db.prepare("SELECT user_id, space_id FROM space_members").all();
  } catch {
    return null;
  }
  /** @type {Map<string, { all: boolean, spaces: Set<string> }>} */
  const by_actor = new Map();
  /** @type {Map<string, { all: boolean, spaces: Set<string> }>} */
  const by_id = new Map();
  for (const u of users) {
    const service = String(u.kind || "") === "service";
    const entry = {
      all: !service && Number(u.is_superadmin) === 1,
      spaces: new Set(),
    };
    by_id.set(String(u.id), entry);
    const actor = String(u.actor || "").toLowerCase();
    if (actor) by_actor.set(actor, entry);
  }
  for (const m of members) {
    by_id.get(String(m.user_id))?.spaces.add(String(m.space_id));
  }
  // A bot identity reaches exactly what the principal path gives it
  // (accounts.mjs serviceMemberships): only the spaces its steward's agents can
  // reach right now, and nothing once the steward is not live (disabled, off the
  // roster, gone, not a person) — the same `userIsLive` rule, so this keeps rows
  // about boards it can never open from being stored at all.
  for (const u of users) {
    if (String(u.kind || "") !== "service" || String(u.source || "") !== "service:bot") continue;
    const entry = by_id.get(String(u.id));
    if (!entry) continue;
    const bot = getUserById(db, String(u.id));
    entry.spaces = bot ? new Set(Object.keys(serviceMemberships(db, bot, env))) : new Set();
  }
  return (recipient, board_id) => {
    const board = String(board_id || "");
    const space = board ? board_spaces.get(board) || "" : default_space;
    const who = by_actor.get(String(recipient || "").toLowerCase());
    if (!who) return space !== "" && space === default_space;
    if (who.all) return true;
    return space !== "" && who.spaces.has(space);
  };
}

/**
 * The `@handles` a description names, lower-cased as written, deduped, capped
 * at `DESCRIPTION_MENTIONS_MAX`. Syntax only — what the cursor remembers, so a
 * description edit announces only the names it added.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function descriptionMentions(text) {
  /** @type {string[]} */
  const out = [];
  for (const t of extractMentions(text)) {
    const handle = t.handle.toLowerCase();
    if (!out.includes(handle)) out.push(handle);
    if (out.length >= DESCRIPTION_MENTIONS_MAX) break;
  }
  return out;
}

/**
 * The part of a description around its first `@handle`, for a mention row's
 * snippet: a body's opening paragraph is rarely the sentence that names you.
 *
 * @param {string} text
 * @param {string} handle - lower-cased
 * @returns {string}
 */
function descriptionSnippet(text, handle) {
  const body = String(text || "");
  let at = -1;
  for (const t of extractMentions(body)) {
    if (t.handle.toLowerCase() === handle) {
      at = t.start;
      break;
    }
  }
  if (at < 0) return body.slice(0, SNIPPET_MAX);
  const start = Math.max(0, at - 60);
  const flat = body.slice(start).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + flat;
}

/**
 * Every `recipient_actor` value whose rows belong to `actor`'s inbox. Today
 * that is just the actor; with accounts it is the actor's alias set. Every
 * inbox read, count and ack goes through it.
 *
 * @param {import('node:sqlite').DatabaseSync} _db
 * @param {string} actor
 * @returns {string[]}
 */
export function inboxActors(_db, actor) {
  const a = String(actor || "");
  return a.length > 0 ? [a] : [];
}

/**
 * @param {string} value
 * @returns {number} Epoch ms, 0 when unparseable.
 */
function tsOf(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : 0;
}

/**
 * The `@mentions` in a text, resolved against the live actor set.
 *
 * Matching is case-insensitive but the returned names are the registry's
 * canonical casing, so a mention row is always addressed to an actor exactly
 * as the roster spells it.
 *
 * @param {string} text
 * @param {Map<string, string>} actors_by_lower - lowercase → canonical actor.
 * @returns {string[]} Unique canonical actors, in first-mention order.
 */
export function parseMentions(text, actors_by_lower) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const t of extractMentions(text)) {
    let canonical = "";
    for (const key of mentionLookupKeys(t.handle)) {
      canonical = actors_by_lower.get(key) || "";
      if (canonical) break;
    }
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

/**
 * The `#issue-id` references in a text. Purely syntactic — the caller decides
 * whether the ids exist.
 *
 * @param {string} text
 * @returns {string[]} Unique ids, in first-reference order.
 */
export function parseIssueRefs(text) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const m of String(text || "").matchAll(ISSUE_REF_RE)) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      out.push(m[2]);
    }
  }
  return out;
}

/**
 * The dashboard hash route for an issue — the one link shape every surface
 * emits (the MCP server prefixes the dashboard origin).
 *
 * @param {string} issue_id
 * @returns {string}
 */
export function issueUrl(issue_id) {
  return `#/issues?issue=${issue_id}`;
}

/**
 * Live actors, every board, as a lowercase-keyed lookup map.
 *
 * Cross-board on purpose: an agent registered on one board comments on
 * another's issues all the time, and a mention should reach it regardless of
 * where it happened to sign up.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Map<string, string>}
 */
export function liveActorsByLower(db) {
  const rows = db
    .prepare("SELECT actor FROM agents WHERE revoked_at = 0")
    .all();
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const row of rows) {
    const actor = String(/** @type {any} */ (row).actor || "");
    if (actor.length > 0 && !map.has(actor.toLowerCase())) {
      map.set(actor.toLowerCase(), actor);
    }
  }
  return map;
}

/**
 * The user directory — every live registered agent, in roster-safe projection.
 * This is what `list-users` (dashboard) and `users_list` (MCP) serve: the
 * handles you can @mention, and nothing an operator would call sensitive
 * (no host, workspace, session or token material).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ include_revoked?: boolean }} [options]
 * @returns {Array<{ actor: string, display_name: string, role: string, kind: string, board_id: string, registered_at: number, last_seen_at: number, activity_source: string, activity_status: string }>}
 */
export function listUserDirectory(db, options = {}) {
  const clause = options.include_revoked ? "" : "WHERE agents.revoked_at = 0";
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT agents.actor, agents.display_name, agents.role, agents.kind,
              agents.board_id, agents.registered_at, agents.last_seen_at,
              agents.revoked_at,
              CASE WHEN EXISTS (
                SELECT 1 FROM agent_runtime_presence p
                 WHERE p.agent_id = agents.id
                   AND p.heartbeat_at > ? AND p.ended_at = 0
              ) THEN 'runtime_presence' ELSE 'agent_activity' END AS activity_source
       FROM agents ${clause}
       ORDER BY agents.last_seen_at DESC`,
    )
    .all(now - 90_000);
  return rows.map((/** @type {any} */ r) => {
    const last_seen_at = Number(r.last_seen_at || 0);
    const age = last_seen_at > 0 ? Math.max(0, now - last_seen_at) : Infinity;
    const activity_status =
      last_seen_at <= 0
        ? "unknown"
        : age <= 60_000
          ? "active"
          : age <= 5 * 60_000
            ? "recent"
            : "stale";
    return {
      actor: String(r.actor || ""),
      display_name: String(r.display_name || ""),
      role: String(r.role || "user"),
      kind: String(r.kind || "agent"),
      board_id: String(r.board_id || ""),
      registered_at: Number(r.registered_at || 0),
      last_seen_at,
      activity_source: String(r.activity_source || "agent_activity"),
      activity_status,
      ...(options.include_revoked
        ? { revoked_at: Number(r.revoked_at || 0) }
        : {}),
    };
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} board_key
 * @returns {BoardState | null} `null` when this board has never been scanned.
 */
export function loadNotifyState(db, board_key) {
  const row = db
    .prepare("SELECT state_json FROM notify_state WHERE board_key = ?")
    .get(board_key);
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(/** @type {any} */ (row).state_json));
    return parsed && typeof parsed === "object" && parsed.issues
      ? parsed
      : { issues: {} };
  } catch {
    return { issues: {} };
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} board_key
 * @param {BoardState} state
 * @param {number} [now]
 */
export function saveNotifyState(db, board_key, state, now = Date.now()) {
  db.prepare(
    `INSERT INTO notify_state (board_key, state_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(board_key) DO UPDATE SET
       state_json = excluded.state_json,
       updated_at = excluded.updated_at`,
  ).run(board_key, JSON.stringify(state), now);
}

/**
 * The cursor a fresh export reduces to — what the next scan will diff against.
 *
 * @param {ExportIssue[]} issues
 * @returns {BoardState}
 */
export function stateFromExport(issues) {
  /** @type {BoardState} */
  const state = { issues: {} };
  for (const issue of issues) {
    if (issue.deleted) continue;
    const last = issue.comments[issue.comments.length - 1];
    /** @type {IssueCursor} */
    const cursor = {
      s: issue.status,
      a: issue.assignee,
      u: issue.updated_at,
      cc: issue.comments.length,
      lc: last ? last.created_at : "",
    };
    if (Array.isArray(issue.artifacts)) {
      cursor.ar = activeArtifactKeys(issue.artifacts);
    }
    if (typeof issue.description === "string") {
      cursor.dm = descriptionMentions(issue.description);
    }
    state.issues[issue.id] = cursor;
  }
  return state;
}

/**
 * Fold a partial scan into the previous cursor: the scanned issues replace
 * their entries (or drop out, when deleted or gone), everything else carries
 * over untouched. What an incremental scan persists.
 *
 * @param {BoardState} prev
 * @param {ExportIssue[]} issues - The issues the partial scan read.
 * @param {string[]} scanned_ids - Every id the scan asked for, including ones
 * that no longer exist (those leave the cursor).
 * @returns {BoardState}
 */
export function mergeBoardState(prev, issues, scanned_ids) {
  const next = { issues: { ...(prev && prev.issues ? prev.issues : {}) } };
  for (const id of scanned_ids) {
    delete next.issues[id];
  }
  const fresh = stateFromExport(issues);
  for (const issue of issues) {
    if (issue.deleted) {
      delete next.issues[issue.id];
    }
  }
  Object.assign(next.issues, fresh.issues);
  return next;
}

/**
 * @param {Array<{ ref: string, intent: string }>} artifacts
 * @returns {string[]} `ref|intent` for every artifact not marked done, sorted.
 */
function activeArtifactKeys(artifacts) {
  return artifacts
    .filter((a) => a && a.intent !== INTENT_DONE)
    .map((a) => `${a.ref}|${a.intent}`)
    .sort();
}

/**
 * "Coordinate, don't block" guidance for a row: who is involved and what to do
 * next, in one sentence. Never an instruction to stop — overlapping work is
 * normal, silent overlapping work is the failure.
 *
 * Feads is a platform for agents that humans can read: an `@handle` reaches
 * every agent of that person (one shared inbox), so the suggested reply
 * **@mentions the other person** — that is how two people's agents agree who
 * takes what instead of stepping on each other's toes. Mirrored word for word
 * by `guidance_for` in the Python MCP server; the shared expectations live in
 * boards/guidance-cases.json.
 *
 * @param {string} type
 * @param {{ issue_id: string, actor?: string, related_issue?: string }} ctx
 * @returns {string}
 */
export function guidanceFor(type, ctx) {
  const actor = String(ctx.actor || "");
  const at = actor ? `@${actor}` : "";
  const on = `#${ctx.issue_id}`;
  const rel = ctx.related_issue ? `#${ctx.related_issue}` : "";
  const nowait = "keep working on what is clearly yours; never wait for a reply.";
  switch (type) {
    case "mention":
      return at
        ? `${at} mentioned you on ${on}: read the thread, then reply there with ${at} (your answer, or what you are doing that touches it); ${nowait}`
        : `You were mentioned on ${on}: read the thread and reply there, @mentioning whoever asked; ${nowait}`;
    case "assigned":
      return `You now hold ${on}. Claim it when you start; if it is not yours to do, comment on ${on} @mentioning who should take it.`;
    case "reassigned_away":
      return at
        ? `Coordinate, don't block: ${on} is now ${at}'s. Stop changing it; comment on ${on} with ${at} saying where your partial work is rather than re-claiming.`
        : `Coordinate, don't block: ${on} was reassigned. Stop changing it; comment on ${on}, @mentioning the new holder, saying where your partial work is rather than re-claiming.`;
    case "work_overlap": {
      const yours = rel ? `your ${rel}` : "your work";
      return at
        ? `Coordinate, don't block: ${at} is on ${on}, which overlaps ${yours} — comment on ${on} with ${at} saying which part you take and which you leave to them; ${nowait}`
        : `Coordinate, don't block: ${on} overlaps ${yours} — comment on ${on}, @mentioning its holder, saying which part you take; ${nowait}`;
    }
    case "dependency_completed":
      return `Blocker ${rel ? `${rel} ` : ""}is closed — ${on} may be ready; check ready() and pick it up if it is yours.`;
    case "comment_on_owned":
      return at
        ? `${at} commented on ${on}, which you own: read it; if it asks something or touches your plan, reply on ${on} with ${at}.`
        : `New comment on ${on}, which you own: read it; if it asks something, reply there @mentioning its author.`;
    case "status_on_owned":
      return at
        ? `${on} was moved by ${at} — check it matches your plan; if it does not, comment on ${on} with ${at} rather than moving it back.`
        : `${on} changed status — check it matches your plan; if it does not, comment on ${on} @mentioning who moved it.`;
    case "new_in_area": {
      const epic = rel ? ` ${rel}` : "";
      return at
        ? `${at} filed ${on} under your epic${epic}: triage it; if it duplicates or overlaps work in flight, comment on ${on} with ${at} naming that #item.`
        : `New work under your epic${epic}: triage ${on}; if it duplicates or overlaps work in flight, comment on ${on} @mentioning its filer and naming that #item.`;
    }
    case "update_on_commented":
      return at
        ? `${at} changed ${on} since you commented — re-read before acting on it; if it now collides with your work, comment there with ${at}.`
        : `${on} changed since you commented — re-read before acting on it.`;
    default:
      return "";
  }
}

/**
 * Diff a fresh export against the previous cursor and mint notification rows.
 *
 * Pure: no clock (the caller passes `now`), no SQL, no I/O. The first scan of
 * a board has `prev = null`; the caller must treat that as baseline-only and
 * not call this at all (asserted here to keep the rule in one place).
 *
 * @param {Object} input
 * @param {BoardState} input.prev
 * @param {ExportIssue[]} input.issues
 * @param {Map<string, string>} [input.live_actors] - lowercase → canonical.
 * Either this or `resolver`.
 * @param {RecipientResolver} [input.resolver] - Who can receive, and who is
 * whom (aliases). Defaults to one over `live_actors`.
 * @param {ArtifactHolder[]} [input.artifact_index] - Live work holding
 * artifacts that a new claim or declaration is checked against. Defaults to
 * the scanned issues themselves (one board); the Postgres engine passes every
 * board's.
 * @param {string} input.board_id - Registry id of the scanned board, '' if none.
 * @param {number} input.now - Epoch ms stamped on every minted row.
 * @returns {{ notifications: NotificationRow[], next_state: BoardState }}
 */
export function computeBoardEvents({
  prev,
  issues,
  live_actors,
  resolver,
  artifact_index,
  board_id,
  now,
}) {
  if (!prev || typeof prev !== "object") {
    throw new Error(
      "computeBoardEvents requires a prior state; baseline scans must not mint",
    );
  }
  const who = resolver || resolverFromLiveActors(live_actors || new Map());
  const prev_issues = prev.issues || {};
  /** @type {Map<string, { type: string, row: NotificationRow }>} */
  const picked = new Map();
  /** @type {Map<string, ExportIssue>} */
  const by_id = new Map(issues.map((i) => [i.id, i]));

  /**
   * Offer a row for (recipient, issue); the most specific type wins.
   *
   * @param {string} recipient
   * @param {string} type
   * @param {{ id: string, title: string }} issue
   * @param {{ actor?: string, snippet?: string, related_issue?: string, allow_self?: boolean, board_id?: string }} extra
   */
  const offer = (recipient, type, issue, extra = {}) => {
    const actor = extra.actor || "";
    if (!recipient || recipient.length === 0) return;
    // Implicit self-notifications are noise (commenting on your own issue),
    // but an explicit act aimed at yourself — typing your own @handle — is a
    // deliberate note-to-self and must land in the inbox (allow_self).
    if (!extra.allow_self && actor && who.same(recipient, actor)) return;
    // Only registered, live actors have an inbox; minting rows for free-text
    // author strings would pile up rows nobody can ever read.
    const canonical = who.resolve(recipient);
    if (canonical.length === 0) return;
    // Accounts mode: nobody is told about a board they cannot read — not even
    // by name. Checked per row (an overlap row is about another board).
    if (who.canReceive && !who.canReceive(canonical, extra.board_id ?? board_id)) {
      return;
    }
    const key = `${canonical} ${issue.id}`;
    const existing = picked.get(key);
    if (
      existing &&
      TYPE_PRIORITY.indexOf(existing.type) <= TYPE_PRIORITY.indexOf(type)
    ) {
      return;
    }
    const related_issue = extra.related_issue || "";
    picked.set(key, {
      type,
      row: {
        id: `n_${crypto.randomUUID()}`,
        board_id: extra.board_id ?? board_id,
        recipient_actor: canonical,
        type,
        issue_id: issue.id,
        issue_title: issue.title,
        actor,
        snippet: String(extra.snippet || "").slice(0, SNIPPET_MAX),
        related_issue,
        created_at: now,
        read_at: 0,
        handled_at: 0,
        url: issueUrl(issue.id),
        count: 1,
        guidance: guidanceFor(type, { issue_id: issue.id, actor, related_issue }),
        audience: audienceOf(type),
      },
    });
  };

  /** @type {Set<string>} Issues that flipped to closed in this scan. */
  const closed_now = new Set();

  for (const issue of issues) {
    if (issue.deleted) continue;
    const prior = prev_issues[issue.id];
    const prior_status = prior ? prior.s : "";
    if (prior && prior_status !== "closed" && issue.status === "closed") {
      closed_now.add(issue.id);
    }

    // New comments: everything past the cursor. For an issue the cursor has
    // never seen, every comment is new — a brand-new issue's opening
    // discussion should notify like any other.
    const last_seen_ts = prior ? tsOf(prior.lc) : 0;
    const prior_count = prior ? prior.cc : 0;
    let new_comments = issue.comments.filter(
      (c) => tsOf(c.created_at) > last_seen_ts,
    );
    if (
      prior &&
      new_comments.length === 0 &&
      issue.comments.length > prior_count
    ) {
      // Cursor timestamp unusable (clock skew, missing created_at): fall back
      // to counting. Better to notify from an imprecise tail than go silent.
      new_comments = issue.comments.slice(prior_count);
    }

    const owners = [issue.assignee, issue.created_by];
    const all_commenters = new Set(
      issue.comments.map((c) => c.author).filter((a) => a.length > 0),
    );

    for (const comment of new_comments) {
      const author = comment.author;
      for (const mentioned of parseMentionHandles(comment.text)) {
        offer(mentioned, "mention", issue, {
          actor: author,
          snippet: comment.text,
          allow_self: true,
        });
      }
      for (const owner of owners) {
        offer(owner, "comment_on_owned", issue, {
          actor: author,
          snippet: comment.text,
        });
      }
      for (const commenter of all_commenters) {
        offer(commenter, "update_on_commented", issue, {
          actor: author,
          snippet: comment.text,
        });
      }
    }

    // Who made the latest non-comment change, when the source can say.
    const last_actor = String(issue.last_actor || "");

    // @mentions in the description (create, and edits that add a name). Only
    // names the cursor has not seen: an issue the cursor knows but whose cursor
    // predates description tracking (`dm` absent) is recorded, not announced.
    if (typeof issue.description === "string") {
      const named = descriptionMentions(issue.description);
      const known = prior
        ? Array.isArray(prior.dm)
          ? new Set(prior.dm)
          : null
        : new Set();
      if (known) {
        const by = prior ? last_actor : issue.created_by || last_actor;
        for (const handle of named) {
          if (known.has(handle)) continue;
          // The email form tries the whole address, then its local part.
          const key = mentionLookupKeys(handle).find((k) => who.resolve(k));
          if (!key) continue;
          offer(key, "mention", issue, {
            actor: by,
            snippet: descriptionSnippet(issue.description, handle),
            allow_self: true,
          });
        }
      }
    }

    if (prior) {
      // Assignment: "tagged onto" an issue. The actor who reassigned is not
      // recorded anywhere the export can see, so self-assignment can produce a
      // row; that is the accepted cost of catching assignments made through
      // every door rather than only the dashboard's.
      if (issue.assignee !== prior.a && issue.assignee.length > 0) {
        offer(issue.assignee, "assigned", issue, {
          snippet: `You are now the assignee of ${issue.id}`,
        });
        // ...and whoever held it is told it moved, so two agents do not both
        // carry on. Releases (new assignee empty) are usually the holder's own
        // act and stay quiet.
        if (prior.a && !who.same(prior.a, issue.assignee)) {
          offer(prior.a, "reassigned_away", issue, {
            actor: issue.assignee,
            snippet: `${issue.id} is now assigned to ${issue.assignee} (was you)`,
          });
        }
      }

      // Status changes and other edits reach everyone who ever commented.
      // A new comment already covered that audience above, so the generic
      // "it changed" row only minted when something other than discussion moved.
      if (prior_status !== issue.status) {
        for (const commenter of all_commenters) {
          offer(commenter, "update_on_commented", issue, {
            actor: last_actor,
            snippet: `Status: ${prior_status || "?"} → ${issue.status}`,
          });
        }
        // Owners hear about status moves made by someone else. With no
        // recorded actor the assignee is the likeliest hand (claims, closes),
        // so only the creator is told — never a guess at the holder's own act.
        const status_snippet = `Status: ${prior_status || "?"} → ${issue.status}${
          last_actor ? ` (by ${last_actor})` : ""
        }`;
        if (last_actor) {
          for (const owner of owners) {
            offer(owner, "status_on_owned", issue, {
              actor: last_actor,
              snippet: status_snippet,
            });
          }
        } else if (
          issue.created_by &&
          !who.same(issue.created_by, issue.assignee)
        ) {
          offer(issue.created_by, "status_on_owned", issue, {
            snippet: status_snippet,
          });
        }
      } else if (
        new_comments.length === 0 &&
        prior.u !== issue.updated_at &&
        issue.assignee === prior.a
      ) {
        for (const commenter of all_commenters) {
          offer(commenter, "update_on_commented", issue, {
            actor: last_actor,
            snippet: "Issue updated",
          });
        }
      }
    } else if (issue.status !== "closed") {
      // A brand-new issue filed under an epic: the epic's owners hear about
      // new work in their area.
      const parent_dep = issue.dependencies.find(
        (d) => d.type === "parent-child",
      );
      const parent = parent_dep ? by_id.get(parent_dep.depends_on_id) : null;
      if (parent && !parent.deleted) {
        const filer = issue.created_by || last_actor;
        for (const owner of [parent.assignee, parent.created_by]) {
          offer(owner, "new_in_area", issue, {
            actor: filer,
            related_issue: parent.id,
            snippet: `${filer || "Someone"} filed ${issue.id} "${issue.title}" under ${parent.id}`,
          });
        }
      }
    }

    offerOverlaps(issue, prior, last_actor);
  }

  /**
   * Work overlap: when an issue's artifacts are newly declared — or the work
   * holding them is claimed / started — tell whoever holds overlapping live
   * work elsewhere, and tell this issue's holder who that is. Both sides,
   * because the point is a conversation, not a lock.
   *
   * @param {ExportIssue} issue
   * @param {IssueCursor | undefined} prior
   * @param {string} last_actor
   */
  function offerOverlaps(issue, prior, last_actor) {
    if (issue.status === "closed" || !Array.isArray(issue.artifacts)) return;
    const active = issue.artifacts.filter((a) => a.intent !== INTENT_DONE);
    if (active.length === 0) return;
    // A cursor from before artifacts were tracked carries no `ar`: treat its
    // artifacts as known, or the first scan after upgrade would announce every
    // artifact on the board as new.
    if (prior && !Array.isArray(prior.ar)) return;
    const known = new Set(prior ? prior.ar : []);
    const known_refs = new Set([...known].map((k) => k.split("|")[0]));
    const claimed_now =
      prior !== undefined &&
      ((prior.s !== issue.status && issue.status === "in_progress") ||
        (issue.assignee.length > 0 && issue.assignee !== prior.a));
    const triggers = claimed_now
      ? active
      : active.filter(
          (a) =>
            !known_refs.has(a.ref) ||
            (a.intent === INTENT_EDITING && !known.has(`${a.ref}|${a.intent}`)),
        );
    if (triggers.length === 0) return;

    const holder = issue.assignee || issue.created_by;
    const index = artifact_index || holdersFromIssues(issues, board_id);
    let fanout = 0;
    for (const other of index) {
      if (fanout >= OVERLAP_FANOUT_MAX) break;
      if (other.issue_id === issue.id || other.status === "closed") continue;
      if (!other.holder || (holder && who.same(other.holder, holder))) continue;
      /** @type {{ mine: { ref: string, intent: string }, theirs: { ref: string, intent: string } } | null} */
      let hit = null;
      for (const mine of triggers) {
        for (const theirs of other.artifacts) {
          if (theirs.intent === INTENT_DONE) continue;
          // Two readers never collide; anything involving an edit does.
          if (mine.intent !== INTENT_EDITING && theirs.intent !== INTENT_EDITING) {
            continue;
          }
          let rel = null;
          try {
            rel = overlap(mine.ref, theirs.ref);
          } catch {
            rel = null;
          }
          if (rel) {
            hit = { mine, theirs };
            break;
          }
        }
        if (hit) break;
      }
      if (!hit) continue;
      fanout += 1;
      const doer = holder || last_actor;
      const verb = claimed_now ? "started on" : "declared";
      offer(other.holder, "work_overlap", issue, {
        actor: doer,
        related_issue: other.issue_id,
        snippet: `${doer || "Someone"} ${verb} ${hit.mine.ref} (${hit.mine.intent}) on ${issue.id} — overlaps your ${hit.theirs.ref} on ${other.issue_id}`,
      });
      if (holder) {
        offer(
          holder,
          "work_overlap",
          { id: other.issue_id, title: other.title },
          {
            actor: other.holder,
            related_issue: issue.id,
            board_id: other.board_id,
            snippet: `${other.holder} is ${hit.theirs.intent} ${hit.theirs.ref} on ${other.issue_id} — overlaps your ${hit.mine.ref} on ${issue.id}`,
          },
        );
      }
    }
  }

  /**
   * Mentions are syntax; whether a handle can receive is the resolver's call
   * (in `offer`), so an alias mention reaches its owner.
   *
   * @param {string} text
   * @returns {string[]}
   */
  function parseMentionHandles(text) {
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const t of extractMentions(text)) {
      // The email form tries the whole address, then its local part.
      for (const key of mentionLookupKeys(t.handle)) {
        const canonical = who.resolve(key);
        if (!canonical) continue;
        if (!seen.has(canonical)) {
          seen.add(canonical);
          out.push(key);
        }
        break;
      }
    }
    return out;
  }

  // Closed blockers: whoever owns a still-open issue that was waiting on one.
  if (closed_now.size > 0) {
    for (const issue of issues) {
      if (issue.deleted || issue.status === "closed") continue;
      for (const dep of issue.dependencies) {
        if (!closed_now.has(dep.depends_on_id)) continue;
        if (!BLOCKING_DEP_TYPES.has(dep.type)) continue;
        const blocker = by_id.get(dep.depends_on_id);
        const blocker_title = blocker ? blocker.title : "";
        for (const owner of [issue.assignee, issue.created_by]) {
          offer(owner, "dependency_completed", issue, {
            actor: blocker ? String(blocker.last_actor || "") : "",
            related_issue: dep.depends_on_id,
            snippet: `Blocker ${dep.depends_on_id}${
              blocker_title ? ` (${blocker_title})` : ""
            } was closed — ${issue.id} may be unblocked`,
          });
        }
      }
    }
  }

  return {
    notifications: [...picked.values()].map((p) => p.row),
    next_state: stateFromExport(issues),
  };
}

/**
 * The artifact index of one scan's own issues — the overlap universe when the
 * caller has nothing wider (a bare-`bd` board scanned alone).
 *
 * @param {ExportIssue[]} issues
 * @param {string} board_id
 * @returns {ArtifactHolder[]}
 */
export function holdersFromIssues(issues, board_id) {
  /** @type {ArtifactHolder[]} */
  const out = [];
  for (const issue of issues) {
    if (issue.deleted || issue.status === "closed") continue;
    if (!Array.isArray(issue.artifacts) || issue.artifacts.length === 0) continue;
    out.push({
      issue_id: issue.id,
      board_id,
      title: issue.title,
      status: issue.status,
      holder: issue.assignee || issue.created_by,
      artifacts: issue.artifacts,
    });
  }
  return out;
}

/**
 * Columns this module added after the table first shipped, added in place on
 * an older registry. Called from `registry.mjs`'s migrate; probes rather than
 * trusts the version stamp, so it is idempotent by construction.
 *
 *   - `count`    — events collapsed into the row (burst dedup).
 *   - `guidance` — the "coordinate, don't block" next action for agents.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureNotificationSchema(db) {
  const cols = db
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all("notifications")
    .map((/** @type {any} */ c) => String(c.name));
  if (cols.length === 0) return;
  if (!cols.includes("count")) {
    db.exec(
      "ALTER TABLE notifications ADD COLUMN count INTEGER NOT NULL DEFAULT 1",
    );
  }
  if (!cols.includes("guidance")) {
    db.exec(
      "ALTER TABLE notifications ADD COLUMN guidance TEXT NOT NULL DEFAULT ''",
    );
  }
  // The collapse lookup: "is there still an unhandled row of this type about
  // this issue for this recipient?" — run once per minted agent row.
  db.exec(`
    CREATE INDEX IF NOT EXISTS notifications_collapse_idx
      ON notifications(recipient_actor, issue_id, type) WHERE handled_at = 0;
  `);
}

/**
 * Persist freshly minted rows. Agent-only types collapse: when the recipient
 * still has an unhandled row of the same type about the same issue, that row
 * absorbs the new event (count + 1, latest snippet/actor/time, re-surfaced as
 * unseen) instead of a second row stacking up behind it. Mentions never
 * collapse — each one may be a separate question.
 *
 * The rows are updated in place to describe what was stored (a collapsed
 * row's id becomes the surviving row's id, its count the new total), so the
 * caller pushes exactly what an inbox read would return.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {NotificationRow[]} rows
 * @returns {NotificationRow[]} The same rows, as stored.
 */
export function insertNotifications(db, rows) {
  if (rows.length === 0) return rows;
  const has_extras = notificationColumns(db).has("count");
  const insert = db.prepare(
    has_extras
      ? `INSERT INTO notifications
           (id, board_id, recipient_actor, type, issue_id, issue_title, actor,
            snippet, related_issue, created_at, read_at, handled_at, count, guidance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO notifications
           (id, board_id, recipient_actor, type, issue_id, issue_title, actor,
            snippet, related_issue, created_at, read_at, handled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const find = has_extras
    ? db.prepare(
        `SELECT id, count FROM notifications
          WHERE recipient_actor = ? AND issue_id = ? AND type = ? AND handled_at = 0
          ORDER BY created_at DESC LIMIT 1`,
      )
    : null;
  const bump = has_extras
    ? db.prepare(
        `UPDATE notifications
            SET count = count + 1, snippet = ?, actor = ?, related_issue = ?,
                issue_title = ?, guidance = ?, created_at = ?, read_at = 0
          WHERE id = ?`,
      )
    : null;
  for (const row of rows) {
    if (find && bump && !NON_COLLAPSING_TYPES.has(row.type)) {
      const existing = /** @type {any} */ (
        find.get(row.recipient_actor, row.issue_id, row.type)
      );
      if (existing) {
        bump.run(
          row.snippet,
          row.actor,
          row.related_issue,
          row.issue_title,
          String(row.guidance || ""),
          row.created_at,
          String(existing.id),
        );
        row.id = String(existing.id);
        row.count = Number(existing.count || 1) + 1;
        row.read_at = 0;
        continue;
      }
    }
    const base = [
      row.id,
      row.board_id,
      row.recipient_actor,
      row.type,
      row.issue_id,
      row.issue_title,
      row.actor,
      row.snippet,
      row.related_issue,
      row.created_at,
      // Coerced so a caller minting rows the pre-split way (no handled_at)
      // still inserts; the engine itself always stamps both.
      Number(row.read_at || 0),
      Number(row.handled_at || 0),
    ];
    if (has_extras) {
      insert.run(
        ...base,
        Number(row.count || 1),
        String(row.guidance ?? guidanceFor(row.type, row)),
      );
    } else {
      insert.run(...base);
    }
  }
  return rows;
}

/**
 * The notifications table's columns, probed once per handle.
 *
 * @type {WeakMap<object, Set<string>>}
 */
const COLUMN_CACHE = new WeakMap();

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Set<string>}
 */
function notificationColumns(db) {
  let cols = COLUMN_CACHE.get(db);
  if (!cols) {
    cols = new Set(
      db
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all("notifications")
        .map((/** @type {any} */ c) => String(c.name)),
    );
    COLUMN_CACHE.set(db, cols);
  }
  return cols;
}

/**
 * @param {any} r - Raw notifications row.
 * @returns {NotificationRow}
 */
function toWireRow(r) {
  const type = String(r.type || "");
  const issue_id = String(r.issue_id || "");
  const actor = String(r.actor || "");
  const related_issue = String(r.related_issue || "");
  return {
    id: String(r.id),
    board_id: String(r.board_id || ""),
    recipient_actor: String(r.recipient_actor || ""),
    type,
    issue_id,
    issue_title: String(r.issue_title || ""),
    actor,
    snippet: String(r.snippet || ""),
    related_issue,
    created_at: Number(r.created_at || 0),
    read_at: Number(r.read_at || 0),
    handled_at: Number(r.handled_at || 0),
    url: issueUrl(issue_id),
    count: Number(r.count || 1),
    // Derived on the way out from the row's own fields, so every row speaks the
    // current policy (rows minted under older wording included); the stored
    // text is the fallback for a type this build does not know.
    guidance: guidanceFor(type, { issue_id, actor, related_issue }) || String(r.guidance || ""),
    audience: audienceOf(type),
  };
}

/**
 * Accounts mode (the excluded hosted-provider design): an inbox is every
 * row addressed to any alias of the user, limited to boards the caller may read
 * (`board_ids: null` = all; rows with no board count as the default space and are
 * included only when `include_boardless`). Without a scope: exactly `recipient_actor = ?`.
 *
 * @typedef {{ recipients?: string[], board_ids?: string[] | null, include_boardless?: boolean }} RecipientScope
 * @typedef {{ audience?: 'human' | 'agent', types?: string[], scope?: RecipientScope }} InboxOptions
 * @param {string} actor
 * @param {RecipientScope | undefined} scope
 * @returns {{ sql: string, args: string[] }}
 */
export function recipientScope(actor, scope) {
  if (!scope) return { sql: "recipient_actor = ?", args: [actor] };
  const recipients = [
    ...new Set([actor, ...(scope.recipients || [])].filter(Boolean)),
  ];
  let sql = `recipient_actor IN (${recipients.map(() => "?").join(",") || "NULL"})`;
  const args = [...recipients];
  if (Array.isArray(scope.board_ids)) {
    const boards = scope.board_ids.filter(Boolean);
    let board_sql = boards.length
      ? `board_id IN (${boards.map(() => "?").join(",")})`
      : "0";
    if (scope.include_boardless) board_sql = `(${board_sql} OR board_id = '')`;
    sql = `${sql} AND ${board_sql}`;
    args.push(...boards);
  }
  return { sql, args };
}

/**
 * The SQL filter shared by every inbox read: whose rows, and which types.
 *
 * `audience: 'human'` restricts to `HUMAN_NOTIFICATION_TYPES` — what the
 * bell shows. `types` narrows further (agents filtering their own inbox).
 * `scope` (accounts mode) widens the recipient to every alias of the user and
 * narrows the rows to boards the caller may read — see `recipientScope`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} actor
 * @param {InboxOptions} [options]
 * @returns {{ sql: string, params: string[] }}
 */
function inboxFilter(db, actor, options = {}) {
  const recipients = options.scope
    ? recipientScope(actor, options.scope)
    : (() => {
        const actors = inboxActors(db, actor);
        return {
          sql: `recipient_actor IN (${actors.map(() => "?").join(", ") || "NULL"})`,
          args: actors,
        };
      })();
  let types = Array.isArray(options.types)
    ? options.types.map(String).filter((t) => t.length > 0)
    : null;
  if (options.audience === "human") {
    types = (types || [...HUMAN_NOTIFICATION_TYPES]).filter((t) =>
      HUMAN_NOTIFICATION_TYPES.includes(t),
    );
  }
  const parts = [recipients.sql];
  /** @type {string[]} */
  const params = [...recipients.args];
  if (types) {
    parts.push(`type IN (${types.map(() => "?").join(", ") || "NULL"})`);
    params.push(...types);
  }
  return { sql: parts.join(" AND "), params };
}

/**
 * An actor's notifications, newest first, across every board — an agent works
 * more than one board but has one inbox.
 *
 * `queue` names which promise "unread" is measured against: `'seen'` is the
 * bell's queue (`read_at = 0` — has a human looked?), `'handled'` is the
 * agents' queue (`handled_at = 0` — has anyone *acted*?). The browser lists
 * seen; the MCP/HTTP agent surfaces list handled, so a row a human glanced at
 * still reaches the next agent session until an agent acks it.
 *
 * `audience: 'human'` is the bell: mentions only. Agents omit it and get
 * every type.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ actor: string, unread_only?: boolean, limit?: number, queue?: 'seen'|'handled' } & InboxOptions} options
 * @returns {NotificationRow[]}
 */
export function listNotifications(db, options) {
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
  const unread_only = options.unread_only !== false;
  const unread_col = options.queue === "handled" ? "handled_at" : "read_at";
  const filter = inboxFilter(db, options.actor, options);
  const rows = db
    .prepare(
      `SELECT * FROM notifications
       WHERE ${filter.sql} ${unread_only ? `AND ${unread_col} = 0` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...filter.params, limit);
  return rows.map(toWireRow);
}

/**
 * Rows no human has seen — the bell badge. Pass `{ audience: 'human' }` for
 * the badge proper (mentions only); omitted, it counts every type.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} actor
 * @param {InboxOptions} [options]
 * @returns {number}
 */
export function unreadCount(db, actor, options = {}) {
  const filter = inboxFilter(db, actor, options);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE ${filter.sql} AND read_at = 0`,
    )
    .get(...filter.params);
  return Number(/** @type {any} */ (row)?.n || 0);
}

/**
 * Rows no agent has handled — the agents' obligation count. A row can be seen
 * and still unhandled; it can never be handled and unseen (a handled-ack
 * stamps both).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} actor
 * @param {InboxOptions} [options]
 * @returns {number}
 */
export function unhandledCount(db, actor, options = {}) {
  const filter = inboxFilter(db, actor, options);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE ${filter.sql} AND handled_at = 0`,
    )
    .get(...filter.params);
  return Number(/** @type {any} */ (row)?.n || 0);
}

/**
 * Unhandled rows per type — the one-line digest an agent reads at session
 * start ("2 work_overlap, 1 mention") before deciding to page the inbox.
 * Takes the same options as every other inbox read so a recipient scope
 * (aliases, readable boards) applies to the digest too — a count must never
 * include rows the caller may not read.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} actor
 * @param {InboxOptions} [options]
 * @returns {Record<string, number>}
 */
export function unhandledByType(db, actor, options = {}) {
  const filter = inboxFilter(db, actor, options);
  const rows = db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM notifications
        WHERE ${filter.sql} AND handled_at = 0 GROUP BY type`,
    )
    .all(...filter.params);
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of /** @type {any[]} */ (rows)) {
    out[String(r.type)] = Number(r.n || 0);
  }
  return out;
}

/**
 * Mark notifications read. Only the recipient's own rows are touched — the
 * WHERE clause is the authorization, so a caller cannot ack somebody else's
 * inbox no matter what ids it passes.
 *
 * Two modes, one per promise:
 *   - `'seen'` (default) stamps `read_at` — a human looked. The browser's
 *     bell click and Mark-all-read land here, and deliberately do NOT touch
 *     `handled_at`: reading your own bell must not discharge what an agent
 *     owes.
 *   - `'handled'` stamps `handled_at` — somebody acted — and stamps `read_at`
 *     too if no one had seen it (handled implies seen). The MCP/HTTP ack
 *     lands here.
 *
 * `audience: 'human'` scopes `all: true` to what the bell shows, so "mark all
 * read" in the dashboard means the mentions the human was looking at.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ actor: string, ids?: string[], all?: boolean, now?: number, mode?: 'seen'|'handled', audience?: 'human'|'agent', scope?: RecipientScope }} options
 * @returns {number} Rows acked.
 */
export function ackNotifications(db, options) {
  const now = options.now || Date.now();
  const handled = options.mode === "handled";
  // A seen-ack skips rows already seen; a handled-ack skips rows already
  // handled but must still count rows a human saw first.
  const set = handled
    ? "handled_at = ?, read_at = CASE WHEN read_at = 0 THEN ? ELSE read_at END"
    : "read_at = ?";
  const stamps = handled ? [now, now] : [now];
  const pending = handled ? "handled_at = 0" : "read_at = 0";
  const filter = inboxFilter(db, options.actor, {
    audience: options.audience,
    scope: options.scope,
  });
  if (options.all) {
    const res = db
      .prepare(`UPDATE notifications SET ${set} WHERE ${filter.sql} AND ${pending}`)
      .run(...stamps, ...filter.params);
    return Number(res.changes || 0);
  }
  const ids = Array.isArray(options.ids) ? options.ids.filter(Boolean) : [];
  if (ids.length === 0) return 0;
  let acked = 0;
  const stmt = db.prepare(
    `UPDATE notifications SET ${set} WHERE id = ? AND ${filter.sql} AND ${pending}`,
  );
  for (const id of ids) {
    acked += Number(
      stmt.run(...stamps, String(id), ...filter.params).changes || 0,
    );
  }
  return acked;
}

/**
 * Drop handled rows older than `max_age_ms` (default 30 days). Rows nobody
 * has handled survive longer: seen-but-unhandled rows get three times the
 * window (the human looked, no agent ever answered — stale, but the only
 * record that something was owed), and rows nobody has even seen are never
 * pruned — an inbox nobody has looked at is exactly the one that must
 * survive.
 *
 * The exception is the ephemeral coordination types
 * (`EPHEMERAL_NOTIFICATION_TYPES`): they describe a moment ("someone started
 * on a file you declared"), carry no question, and expire unhandled after
 * `ephemeral_max_age_ms` (default 14 days) so an agent that never acks them is
 * not greeted by a month of stale overlaps.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ max_age_ms?: number, ephemeral_max_age_ms?: number, now?: number }} [options]
 * @returns {number}
 */
export function pruneNotifications(db, options = {}) {
  const now = options.now || Date.now();
  const max_age = options.max_age_ms || 30 * 24 * 60 * 60 * 1000;
  const ephemeral_age =
    options.ephemeral_max_age_ms || 14 * 24 * 60 * 60 * 1000;
  const ephemeral = EPHEMERAL_NOTIFICATION_TYPES.map(() => "?").join(", ");
  const res = db
    .prepare(
      `DELETE FROM notifications
       WHERE (handled_at > 0 AND handled_at < ?)
          OR (handled_at = 0 AND read_at > 0 AND read_at < ?)
          OR (handled_at = 0 AND type IN (${ephemeral}) AND created_at < ?)`,
    )
    .run(
      now - max_age,
      now - 3 * max_age,
      ...EPHEMERAL_NOTIFICATION_TYPES,
      now - ephemeral_age,
    );
  return Number(res.changes || 0);
}
