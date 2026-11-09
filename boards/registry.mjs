/**
 * SQLite board registry — the single source of truth for which boards exist and
 * what each one is for.
 *
 * A "board" is one beads database (a `.beads/` directory holding an embedded Dolt
 * DB). beads itself has no concept of a *set* of boards, and no place to record
 * what a board is about: its own `.beads/config.yaml` has a `repos:` key, but
 * that is a different, experimental feature (hydrating several repos into one
 * database) and not "which repos does this board cover". So the description and
 * repo list that let an agent route a task to the right board live here.
 *
 * Why SQLite rather than a JSON/YAML file: two different runtimes read this — the
 * Node UI server and the Python MCP server — and both speak SQLite natively with
 * zero dependencies (node:sqlite is built in, sqlite3 is stdlib). A file would
 * mean two hand-rolled parsers and no concurrency story.
 *
 * The schema is deliberately narrow so the same shape can later be served by an
 * HTTP endpoint when this moves to the cloud alongside the backend stack. Agent
 * identities live in the same database for the same reason — see `agents.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureNotificationSchema } from './notifications.mjs';

export const SCHEMA_VERSION = 10;

/** Hosted silo identity is unavailable. A nonempty FEADS_SILO fails closed. */
export function getValidatedSiloSlug(env = process.env) {
  if (env?.FEADS_SILO !== undefined && env.FEADS_SILO !== '') {
    throw new Error('hosted silo mode is unavailable in this build');
  }
  return null;
}

/**
 * A description write lost a race: what is in the registry now is not what the
 * caller believed it was replacing.
 *
 * Thrown only when a caller opts in by passing `expected_description` — see
 * `upsertBoard`. It carries the current value rather than only saying "conflict",
 * because the caller's next move is to re-read, merge and retry, and the value it
 * needs for that is exactly the one that made the check fail. A class with fields
 * (rather than a message a caller must parse) follows `TokenError` in `agents.mjs`.
 */
export class DescriptionConflictError extends Error {
  /**
   * @param {string} message
   * @param {{ board_id: string, current_name: string, current_description: string,
   *           expected_description: string, updated_at: number }} details
   */
  constructor(message, details) {
    super(message);
    this.name = 'DescriptionConflictError';
    this.board_id = details.board_id;
    this.current_name = details.current_name;
    this.current_description = details.current_description;
    this.expected_description = details.expected_description;
    this.updated_at = details.updated_at;
  }
}

/**
 * Whether a directory is actually a beads board, rather than merely existing.
 *
 * This distinction is load-bearing: beads ships a `.beads/` directory containing
 * nothing but `formulas/` in its own repo, so "the path is there" is not evidence
 * of a database. Treating it as one registers a board that can never be read.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isBoardDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, 'config.yaml'))) return true;
  if (fs.existsSync(path.join(dir, 'embeddeddolt'))) return true;
  if (fs.existsSync(path.join(dir, 'metadata.json'))) return true;
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.db'));
  } catch {
    return false;
  }
}

/**
 * Location of the registry database.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function getRegistryPath(env = process.env) {
  const override = env?.FEADS_REGISTRY_DB;
  if (override && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.feads', 'registry.db');
}

/**
 * Open the registry, creating and migrating it if needed.
 *
 * @param {{ path?: string, readonly?: boolean, env?: Record<string, string | undefined> }} [options]
 * @returns {DatabaseSync}
 */
export function openRegistry(options = {}) {
  const db_path = options.path
    ? path.resolve(options.path)
    : getRegistryPath(options.env || process.env);
  fs.mkdirSync(path.dirname(db_path), { recursive: true });
  const db = new DatabaseSync(db_path);
  // Writers are short transactions but no longer rare: the MCP server spawns one
  // CLI process per registry write, so two agents editing boards at once is a
  // normal Tuesday, not a corner case. The timeout makes the loser wait its turn
  // instead of failing with SQLITE_BUSY — and it must be set FIRST, because the
  // very next statement (journal_mode) takes a lock of its own and dies "database
  // is locked" under concurrent opens when the timeout is still the default 0.
  // Proven by TestConcurrentWriters in integrations/beads-mcp, not assumed.
  db.exec('PRAGMA busy_timeout = 5000');
  // WAL lets the UI server read while the CLI writes instead of erroring with
  // SQLITE_BUSY; foreign keys are off by default in SQLite and we rely on the
  // board_repos cascade.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, { env: options.env || process.env });
  return db;
}

/**
 * Apply schema migrations. Idempotent.
 *
 * All tables live here, including the agent tables read and written by
 * `agents.mjs`, so there is exactly one place that creates schema and one
 * version number to reason about. `agents.mjs` holds the logic, not the DDL.
 *
 * v1 → v2 adds `agent_invites` and `agents`. Both are pure additions, so an
 * existing v1 registry migrates by opening it — there is no data to rewrite.
 *
 * v2 → v3 adds `notifications` and `notify_state` — again pure additions. The
 * notification rows live here rather than in any board's beads database because
 * an agent's inbox spans boards, and because the two runtimes that read it (the
 * Node dashboard and the Python MCP server) already share this file. The
 * dashboard is the sole writer, exactly as it is for agent sign-ups; the MCP
 * server reads read-only and asks the dashboard over HTTP when it needs a write
 * (see `notifications.mjs`).
 *
 * v4 → v5 adds `board_description_history`, one row per replaced description. A
 * pure addition again, so an existing registry migrates by being opened. See the
 * table's own comment for why a *registry* keeps history at all.
 *
 * v3 → v4 splits a notification's read-state in two: `read_at` (a human *saw*
 * it — the bell) and `handled_at` (an agent *answered* it — the MCP/HTTP ack).
 * One timestamp for both surfaces meant a human glancing at their own bell
 * silently discharged the agent's obligation to answer. The one ALTER is
 * guarded by a column probe rather than the version number so a re-run is a
 * no-op, and existing read rows are backfilled as handled — they predate the
 * distinction, and flooding every old row back into agent inboxes on upgrade
 * would be worse than under-reporting history.
 */
/** No silo auth-binding schema is installed in the standalone release. */
export function ensureSiloAuthBindingsTable(_db, env = process.env) {
  getValidatedSiloSlug(env);
  return null;
}

/**
 * @param {DatabaseSync} db
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
function migrate(db, options = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      board_dir     TEXT NOT NULL UNIQUE,
      workspace_dir TEXT NOT NULL DEFAULT '',
      description   TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_repos (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      repo     TEXT NOT NULL,
      PRIMARY KEY (board_id, repo)
    );
    CREATE INDEX IF NOT EXISTS board_repos_repo_idx ON board_repos(repo);

    -- One row per *replaced* description or name: the value that was there before
    -- the write, never the value written. So the current row plus this table is the
    -- whole history, and reading the latest row answers "what did I just destroy?".
    --
    -- Why a registry keeps history when nothing else here does: a board description
    -- is the text routeTask scores against, so it is not decoration — it is how
    -- every future task finds its way to the right board. It is also written by
    -- agents from stale reads (2026-07-30: a describe based on a ~23h-old read
    -- silently replaced two freshly authored descriptions, and one original was
    -- recovered only because a transcript happened to contain it). Overwriting is
    -- allowed; overwriting *irrecoverably* is what made that incident expensive.
    --
    -- Deliberately no FK to boards(id): unregistering a board does not delete its
    -- database, and it should not delete the record of what its description said
    -- either. Deliberately unpruned: this grows by one row per describe, on a
    -- registry with tens of boards.
    CREATE TABLE IF NOT EXISTS board_description_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id    TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      actor       TEXT NOT NULL DEFAULT '',
      replaced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS board_description_history_board_idx
      ON board_description_history(board_id, replaced_at DESC);

    -- One row per invite you mint for one agent. token_hash is a SHA-256 of the
    -- token; the token itself is shown once at mint time and never stored, so a
    -- stolen registry file yields no usable credential.
    -- The role is fixed at mint time, not at redeem time: the tier is the inviter's
    -- decision, so an agent cannot elect to be an admin by how it registers.
    CREATE TABLE IF NOT EXISTS agent_invites (
      id           TEXT PRIMARY KEY,
      board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      actor        TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role         TEXT NOT NULL DEFAULT 'user',
      token_hash   TEXT NOT NULL UNIQUE,
      created_by   TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL DEFAULT 0,
      redeemed_at  INTEGER NOT NULL DEFAULT 0,
      redeemed_by  TEXT NOT NULL DEFAULT '',
      revoked_at   INTEGER NOT NULL DEFAULT 0,
      notes        TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS agent_invites_board_idx ON agent_invites(board_id);

    -- One row per registered agent. The actor column is the value the agent uses as
    -- BEADS_ACTOR, which is what makes bd's claim collision detection real.
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      actor         TEXT NOT NULL,
      display_name  TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT 'user',
      invite_id     TEXT NOT NULL DEFAULT '',
      token_hash    TEXT NOT NULL UNIQUE,
      host          TEXT NOT NULL DEFAULT '',
      workspace_dir TEXT NOT NULL DEFAULT '',
      session_id    TEXT NOT NULL DEFAULT '',
      kind          TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('human', 'agent')),
      parent_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      expires_at    INTEGER NOT NULL DEFAULT 0,
      archived_at   INTEGER NOT NULL DEFAULT 0,
      registered_at INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      revoked_at    INTEGER NOT NULL DEFAULT 0,
      revoke_reason TEXT NOT NULL DEFAULT '',
      metadata      TEXT NOT NULL DEFAULT '{}'
    );
    -- Two live agents sharing an actor would silently defeat claim collision
    -- detection — the exact failure this feature exists to fix — so the uniqueness
    -- is enforced in the schema. It is partial so revoking an agent frees its name
    -- for reuse instead of burning it forever.
    CREATE UNIQUE INDEX IF NOT EXISTS agents_live_actor_idx
      ON agents(board_id, actor) WHERE revoked_at = 0;
    CREATE INDEX IF NOT EXISTS agents_session_idx ON agents(session_id);
    -- Ephemeral advisory presence for an agent working an issue. This is deliberately
    -- separate from board claims: flares never participate in authorization or CAS.
    CREATE TABLE IF NOT EXISTS work_flares (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      actor        TEXT NOT NULL,
      parent_actor TEXT NOT NULL DEFAULT '',
      board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      issue_id     TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      UNIQUE(agent_id, board_id, issue_id)
    );
    CREATE INDEX IF NOT EXISTS work_flares_board_issue_idx
      ON work_flares(board_id, issue_id, heartbeat_at);
    CREATE INDEX IF NOT EXISTS work_flares_agent_idx
      ON work_flares(agent_id, heartbeat_at);

    CREATE TABLE IF NOT EXISTS agent_runtime_presence (
      agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id      TEXT NOT NULL,
      runtime_id      TEXT NOT NULL,
      run_id          TEXT NOT NULL,
      parent_run_id   TEXT NOT NULL DEFAULT '',
      kind            TEXT NOT NULL CHECK (kind IN ('main', 'subagent')),
      handle          TEXT NOT NULL DEFAULT '',
      display_name    TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL CHECK (
        status IN ('working', 'idle', 'done', 'failed', 'aborted', 'unknown')
      ),
      model           TEXT NOT NULL DEFAULT '',
      activity        TEXT NOT NULL DEFAULT '',
      context_percent REAL NOT NULL DEFAULT 0,
      started_at      INTEGER NOT NULL DEFAULT 0,
      ended_at        INTEGER NOT NULL DEFAULT 0,
      heartbeat_at    INTEGER NOT NULL,
      client          TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (agent_id, runtime_id, run_id)
    );

    CREATE INDEX IF NOT EXISTS agent_runtime_presence_expiry_idx
      ON agent_runtime_presence(heartbeat_at, ended_at);
    CREATE INDEX IF NOT EXISTS agent_runtime_presence_agent_idx
      ON agent_runtime_presence(agent_id, runtime_id, heartbeat_at);

    -- One row per thing an agent should hear about: a mention, a comment on an
    -- issue it owns, an update to an issue it commented on, a closed blocker.
    -- recipient_actor is the registered actor handle; rows for actors nobody is
    -- registered as are never minted (the engine filters against live agents).
    CREATE TABLE IF NOT EXISTS notifications (
      id              TEXT PRIMARY KEY,
      board_id        TEXT NOT NULL DEFAULT '',
      recipient_actor TEXT NOT NULL,
      type            TEXT NOT NULL,
      issue_id        TEXT NOT NULL,
      issue_title     TEXT NOT NULL DEFAULT '',
      actor           TEXT NOT NULL DEFAULT '',
      snippet         TEXT NOT NULL DEFAULT '',
      related_issue   TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL,
      read_at         INTEGER NOT NULL DEFAULT 0,
      handled_at      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS notifications_recipient_idx
      ON notifications(recipient_actor, read_at, created_at DESC);

    -- The notification engine's per-board diff cursor: what each issue looked
    -- like the last time the board was scanned. One JSON blob per board, keyed
    -- by the board directory, because the scan replaces the whole snapshot
    -- atomically — per-issue rows would buy nothing but write amplification.
    CREATE TABLE IF NOT EXISTS notify_state (
      board_key  TEXT PRIMARY KEY,
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER NOT NULL
    );
  `);
  // Refuse unsupported hosted mode; standalone registries have no auth bindings.
  ensureSiloAuthBindingsTable(db, options.env || process.env);
  // v4: a registry created before the seen/handled split has a notifications
  // table without `handled_at`. Probe the columns rather than trusting the
  // version stamp — CREATE IF NOT EXISTS never alters an existing table, and
  // a probe makes the migration idempotent by construction.
  const notif_cols = db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('notifications')
    .map((/** @type {any} */ c) => String(c.name));
  if (!notif_cols.includes('handled_at')) {
    db.exec(
      'ALTER TABLE notifications ADD COLUMN handled_at INTEGER NOT NULL DEFAULT 0'
    );
    // Rows read before the split predate the distinction: treat them as
    // handled, or every inbox floods with rows somebody already dealt with.
    db.exec('UPDATE notifications SET handled_at = read_at WHERE read_at > 0');
  }
  const agent_cols = db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('agents')
    .map((/** @type {any} */ c) => String(c.name));
  if (!agent_cols.includes('parent_agent_id')) {
    db.exec(
      'ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE'
    );
  }
  if (!agent_cols.includes('expires_at')) {
    db.exec(
      'ALTER TABLE agents ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0'
    );
  }
  if (!agent_cols.includes('archived_at')) {
    db.exec(
      'ALTER TABLE agents ADD COLUMN archived_at INTEGER NOT NULL DEFAULT 0'
    );
  }
  const runtime_presence_cols = db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('agent_runtime_presence')
    .map((/** @type {any} */ c) => String(c.name));
  if (!runtime_presence_cols.includes('client')) {
    db.exec(
      "ALTER TABLE agent_runtime_presence ADD COLUMN client TEXT NOT NULL DEFAULT ''"
    );
  }
  migrateAccounts(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS agents_parent_idx ON agents(parent_agent_id);
    CREATE INDEX IF NOT EXISTS agents_expires_idx ON agents(expires_at);
    CREATE INDEX IF NOT EXISTS agents_archived_idx ON agents(archived_at);
    CREATE INDEX IF NOT EXISTS notifications_recipient_handled_idx
      ON notifications(recipient_actor, handled_at, created_at DESC);
  `);
  // Notification columns added after v4 (burst count, agent guidance).
  ensureNotificationSchema(db);
  const row = db.prepare('SELECT version FROM schema_meta LIMIT 1').get();
  if (!row) {
    db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(
      SCHEMA_VERSION
    );
  } else if (Number(row.version) < SCHEMA_VERSION) {
    db.prepare('UPDATE schema_meta SET version = ?').run(SCHEMA_VERSION);
  }
}

/**
 * v8: SSO users, spaces and RBAC (see
 * `the excluded hosted-provider design`). Every change is additive: new
 * tables, and two nullable columns (`agents.owner_user_id`, `boards.space_id`)
 * whose NULL means exactly what the registry meant before — an agent nobody
 * owns, a board in the default space. Nothing here turns the feature on; that is
 * `accounts_settings.mode`, flipped by `scripts/feads-accounts.mjs enable`, so a
 * deploy that only migrates the schema behaves byte for byte like the last one.
 *
 * @param {DatabaseSync} db
 */
function migrateAccounts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL UNIQUE,
      actor             TEXT NOT NULL UNIQUE,
      display_name      TEXT NOT NULL DEFAULT '',

      agent_id          TEXT NOT NULL DEFAULT '',
      is_superadmin     INTEGER NOT NULL DEFAULT 0,
      agents_all_spaces INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      last_seen_at      INTEGER NOT NULL DEFAULT 0,
      disabled_at       INTEGER NOT NULL DEFAULT 0,
      source            TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE IF NOT EXISTS user_credentials (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      kind         TEXT NOT NULL CHECK (kind IN ('personal', 'system')),
      label        TEXT NOT NULL DEFAULT '',
      token_hash   TEXT NOT NULL UNIQUE,
      spaces_json  TEXT NOT NULL DEFAULT '[]',
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      revoked_at   INTEGER NOT NULL DEFAULT 0,
      revoked_by   TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS user_credentials_user_idx
      ON user_credentials(user_id, kind, revoked_at);
    CREATE TABLE IF NOT EXISTS spaces (
      id          TEXT PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS space_members (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id  TEXT NOT NULL REFERENCES users(id),
      role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
      added_by TEXT NOT NULL DEFAULT '',
      added_at INTEGER NOT NULL,
      source   TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY (space_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS space_members_user_idx ON space_members(user_id);
    CREATE TABLE IF NOT EXISTS roster_cache (
      email      TEXT PRIMARY KEY,

      name       TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL DEFAULT '',
      synced_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_actor_aliases (
      alias      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      source     TEXT NOT NULL DEFAULT 'manual',
      confidence TEXT NOT NULL DEFAULT 'high',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_actor_aliases_user_idx ON user_actor_aliases(user_id);
    CREATE TABLE IF NOT EXISTS accounts_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      actor       TEXT NOT NULL DEFAULT '',
      action      TEXT NOT NULL,
      target      TEXT NOT NULL DEFAULT '',
      before_json TEXT NOT NULL DEFAULT 'null',
      after_json  TEXT NOT NULL DEFAULT 'null'
    );
  `);
  const agent_cols = db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('agents')
    .map((/** @type {any} */ c) => String(c.name));
  if (!agent_cols.includes('owner_user_id')) {
    db.exec('ALTER TABLE agents ADD COLUMN owner_user_id TEXT');
  }
  const board_cols = db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('boards')
    .map((/** @type {any} */ c) => String(c.name));
  if (!board_cols.includes('space_id')) {
    db.exec('ALTER TABLE boards ADD COLUMN space_id TEXT');
  }
  // v9: service accounts (the excluded hosted-provider design). A service
  // is a user row that is not a person: `kind = 'service'`, a human steward for
  // accountability, an optional read-only flag. Additive, and the defaults mean
  // exactly what every existing row already is — a human, no steward, read/write.
  const user_cols = db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('users')
    .map((/** @type {any} */ c) => String(c.name));
  if (!user_cols.includes('kind')) {
    db.exec("ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'");
  }
  if (!user_cols.includes('steward_user_id')) {
    db.exec("ALTER TABLE users ADD COLUMN steward_user_id TEXT NOT NULL DEFAULT ''");
  }
  if (!user_cols.includes('read_only')) {
    db.exec('ALTER TABLE users ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0');
  }
  // Hosted group bindings are excluded from the standalone release.
  db.exec(`
    CREATE TABLE IF NOT EXISTS membership_sync_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER NOT NULL,
      dry_run      INTEGER NOT NULL DEFAULT 0,
      forced       INTEGER NOT NULL DEFAULT 0,
      trigger      TEXT NOT NULL DEFAULT '',
      actor        TEXT NOT NULL DEFAULT '',
      ok           INTEGER NOT NULL DEFAULT 1,
      summary_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_user_id);
    CREATE INDEX IF NOT EXISTS boards_space_idx ON boards(space_id);
  `);
}

/**
 * Normalize a free-text label into a slug usable as a board id.
 *
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * @typedef {object} Board
 * @property {string} id
 * @property {string} name
 * @property {string} board_dir
 * @property {string} workspace_dir
 * @property {string} description
 * @property {string[]} repos
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @param {DatabaseSync} db
 * @param {any} row
 * @returns {Board}
 */
function hydrate(db, row) {
  const repos = db
    .prepare('SELECT repo FROM board_repos WHERE board_id = ? ORDER BY repo')
    .all(row.id)
    .map((r) => String(r.repo));
  return { ...row, repos };
}

/**
 * The canonical id of the board stored at `board_dir`: the basename of the
 * directory holding `.beads` (`…/boards/example/.beads` → `example`). The
 * Postgres store keys a board's issues by exactly this (`boardIdForDir` in
 * ui/server/pg-store.js, `board_id_for_workspace` in beads_mcp/pgstore.py), so it
 * is the one id every authorization decision must be made against.
 *
 * @param {string} board_dir
 * @returns {string} '' when the path has no parent.
 */
export function canonicalBoardId(board_dir) {
  const raw = String(board_dir || '').trim();
  if (raw.length === 0) return '';
  const resolved = path.resolve(raw);
  const parent = path.dirname(resolved);
  if (parent === resolved) return '';
  return path.basename(parent);
}

/**
 * The id of the board whose data a registry row reaches in Postgres mode, where
 * issues are keyed by `canonicalBoardId(board_dir)` (Node) and by the basename of
 * the resolved workspace (MCP: `workspace_dir`, else the parent of `board_dir`).
 * A row with no directory (a Postgres-only board adopted into a space) is its own
 * data. `''` when the two runtimes would disagree — such a row reaches no data
 * safely and must be denied.
 *
 * @param {{ id?: unknown, board_dir?: unknown, workspace_dir?: unknown } | null | undefined} row
 * @returns {string}
 */
export function boardDataId(row) {
  const id = String(row?.id || '');
  const dir = String(row?.board_dir || '').trim();
  const node_id = dir.length > 0 ? canonicalBoardId(dir) : id;
  const ws = String(row?.workspace_dir || '').trim();
  const mcp_id = ws.length > 0 ? path.basename(path.resolve(ws)) : node_id;
  return node_id === mcp_id ? node_id : '';
}

/**
 * Does a registry row name the data it points at (`boardDataId(row) === row.id`)?
 *
 * @param {{ id?: unknown, board_dir?: unknown, workspace_dir?: unknown } | null | undefined} row
 * @returns {boolean}
 */
export function boardRowConsistent(row) {
  const id = String(row?.id || '');
  return id.length > 0 && boardDataId(row) === id;
}

/**
 * The board whose data `board_dir` would alias, if any. Only the standard layout
 * (`…/<id>/.beads`) has a data id; for it, another row whose id or data id equals
 * this directory's data id — or whose data id equals `id` — is a collision: two
 * registry names for one board's issues, each with its own space.
 *
 * @param {DatabaseSync} db
 * @param {string} id
 * @param {string} board_dir
 * @returns {string} The other board's id, or ''.
 */
export function dataIdCollision(db, id, board_dir) {
  if (path.basename(path.resolve(String(board_dir || ''))) !== '.beads') {
    return '';
  }
  const canonical = canonicalBoardId(board_dir);
  for (const row of /** @type {any[]} */ (
    db.prepare('SELECT id, board_dir FROM boards WHERE id != ?').all(id)
  )) {
    const other_id = String(row.id);
    const other_dir = String(row.board_dir || '').trim();
    const other_canonical =
      other_dir && path.basename(path.resolve(other_dir)) === '.beads'
        ? canonicalBoardId(other_dir)
        : other_id;
    if (
      (canonical && (canonical === other_id || canonical === other_canonical)) ||
      id === other_canonical
    ) {
      return other_id;
    }
  }
  return '';
}

/**
 * List every registered board.
 *
 * @param {DatabaseSync} db
 * @returns {Board[]}
 */
export function listBoards(db) {
  const rows = db.prepare('SELECT * FROM boards ORDER BY name').all();
  return rows.map((r) => hydrate(db, r));
}

/**
 * Look a board up by id, or by board_dir if no id matches.
 *
 * @param {DatabaseSync} db
 * @param {string} id_or_dir
 * @returns {Board | null}
 */
export function getBoard(db, id_or_dir) {
  let row = db.prepare('SELECT * FROM boards WHERE id = ?').get(id_or_dir);
  if (!row) {
    row = db
      .prepare('SELECT * FROM boards WHERE board_dir = ?')
      .get(path.resolve(id_or_dir));
  }
  return row ? hydrate(db, row) : null;
}

/**
 * Who to record against a description change.
 *
 * Defaulted here rather than at each call site so no writer can forget: the CLI,
 * the dashboard and the MCP-spawned subprocess all run with `BEADS_ACTOR` set to
 * the acting agent, and a history row with no author is only half a record.
 *
 * @param {string} [explicit]
 * @returns {string}
 */
function describeActor(explicit) {
  const named = String(explicit ?? '').trim();
  if (named.length > 0) return named;
  return String(process.env.BEADS_ACTOR || '').trim();
}

/**
 * Append the value a write is about to replace.
 *
 * @param {DatabaseSync} db
 * @param {string} board_id
 * @param {{ name: string, description: string }} previous
 * @param {string} actor
 * @param {number} at
 */
function recordDescriptionHistory(db, board_id, previous, actor, at) {
  db.prepare(
    `INSERT INTO board_description_history (board_id, name, description, actor, replaced_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(board_id, previous.name, previous.description, actor, at);
}

/**
 * The history of a board's descriptions, newest replacement first.
 *
 * The read side of `board_description_history`. It exists because a table nothing
 * can read is not recoverability — the whole point is that the person who just
 * clobbered a description can get the old text back without a transcript.
 *
 * @param {DatabaseSync} db
 * @param {string} board_id
 * @param {{ limit?: number }} [options]
 * @returns {Array<{ id: number, board_id: string, name: string, description: string,
 *                   actor: string, replaced_at: number }>}
 */
export function listDescriptionHistory(db, board_id, options = {}) {
  const limit =
    Number.isFinite(options.limit) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : 50;
  const rows = db
    .prepare(
      `SELECT id, board_id, name, description, actor, replaced_at
       FROM board_description_history WHERE board_id = ?
       ORDER BY replaced_at DESC, id DESC LIMIT ?`
    )
    .all(board_id, limit);
  return rows.map((r) => ({
    id: Number(r.id),
    board_id: String(r.board_id),
    name: String(r.name),
    description: String(r.description),
    actor: String(r.actor),
    replaced_at: Number(r.replaced_at)
  }));
}

/**
 * Refuse a write whose `expected_description` no longer matches what is stored.
 *
 * A no-op unless the caller opted in. The comparison is on trimmed text rather
 * than bytes, because the expected value arrives through a shell and a JSON body
 * and a trailing newline is not somebody else's edit — while any difference that
 * survives trimming is.
 *
 * The refusal names the current value in full. Truncating it would defeat the
 * purpose: the caller's next move is to re-read, merge and retry, and this error
 * is already the read.
 *
 * @param {string} board_id
 * @param {{ name: string, description: string } | null} current - null when no
 *   board with this id exists yet.
 * @param {number} updated_at
 * @param {{ expected_description?: string | null }} input
 * @throws {DescriptionConflictError}
 */
function assertExpectedDescription(board_id, current, updated_at, input) {
  if (
    input.expected_description === undefined ||
    input.expected_description === null
  ) {
    return;
  }
  const expected = String(input.expected_description).trim();
  if (!current) {
    throw new DescriptionConflictError(
      `board "${board_id}" does not exist, so it cannot have the description you ` +
        `expected to replace — re-read the registry before retrying`,
      {
        board_id,
        current_name: '',
        current_description: '',
        expected_description: expected,
        updated_at: 0
      }
    );
  }
  if (current.description.trim() === expected) return;
  throw new DescriptionConflictError(
    `board "${board_id}" changed since you read it — its description was last ` +
      `updated ${new Date(updated_at).toISOString()} and is not the one you passed ` +
      `as expected.\n` +
      `  current:  ${JSON.stringify(current.description)}\n` +
      `  expected: ${JSON.stringify(expected)}\n` +
      `  re-read the board, merge your edit into the current text, and retry`,
    {
      board_id,
      current_name: current.name,
      current_description: current.description,
      expected_description: expected,
      updated_at
    }
  );
}

/**
 * Create or update a board. Keyed on id; board_dir must stay unique.
 *
 * This is the single write site for a board's description, and therefore the place
 * that owns the two protections around it. Every surface — the CLI's `describe`,
 * `register` and `create`, the MCP server's tools (which spawn that CLI), anything
 * later — inherits them by calling this rather than by remembering to:
 *
 *   1. **History.** When an existing board's name or description actually changes,
 *      the *previous* pair is appended to `board_description_history` first. Free
 *      at this scale, and the difference between "somebody clobbered the routing
 *      text" being an annoyance and being an outage.
 *   2. **Compare-and-set**, when the caller opts in with `expected_description`.
 *      Absent, this behaves exactly as it always did — that is deliberate, because
 *      making the check mandatory would break every existing caller and, worse,
 *      teach agents to pass whatever value silences it.
 *
 * `description: undefined` on an *update* means "leave it alone", not "clear it".
 * That distinction is load-bearing: `register` and `create` accept an optional
 * `--description`, and treating its absence as the empty string made re-registering
 * a board silently erase the text routing depends on. Pass `''` to clear.
 *
 * @param {DatabaseSync} db
 * @param {{ id?: string, name: string, board_dir: string, workspace_dir?: string,
 *           description?: string, repos?: string[], expected_description?: string | null,
 *           actor?: string }} input
 *   `expected_description` is the description the caller last read. When it does not
 *   match what is stored, the write is refused with a `DescriptionConflictError`
 *   rather than applied.
 * @returns {Board}
 * @throws {DescriptionConflictError} when `expected_description` does not match
 */
export function upsertBoard(db, input) {
  const id =
    input.id && input.id.length > 0 ? slugify(input.id) : slugify(input.name);
  if (!id)
    throw new Error(
      'board id could not be derived — pass --id or a name with letters'
    );
  const board_dir = path.resolve(input.board_dir);
  const now = Date.now();

  // A different board already owning this directory is a conflict, not an update:
  // two ids pointing at one database would make routing ambiguous.
  const dir_owner = db
    .prepare('SELECT id FROM boards WHERE board_dir = ? AND id != ?')
    .get(board_dir, id);
  if (dir_owner) {
    throw new Error(
      `board_dir ${board_dir} is already registered as "${dir_owner.id}"`
    );
  }
  // ...and so is a different directory whose *data* id is another board's. The
  // Postgres store keys a board's issues by `canonicalBoardId(board_dir)`, so a row
  // "mine" → <anywhere>/team-b-lab/.beads would read and write team-b-lab's issues
  // under a name (and a space) that is not team-b-lab's.
  const alias = dataIdCollision(db, id, board_dir);
  if (alias) {
    throw new Error(
      `board_dir ${board_dir} holds the data of board "${alias}" — register that board, not an alias of it`
    );
  }

  const existing = db
    .prepare(
      'SELECT id, name, description, created_at, updated_at FROM boards WHERE id = ?'
    )
    .get(id);
  if (existing) {
    const previous = {
      name: String(existing.name ?? ''),
      description: String(existing.description ?? '')
    };
    assertExpectedDescription(
      id,
      previous,
      Number(existing.updated_at ?? 0),
      input
    );
    // Absent means "leave it alone" — see the header. Only an explicit '' clears.
    const description =
      input.description !== undefined
        ? input.description
        : previous.description;
    // Only a real change is history: re-running the same describe (an idempotent
    // retry, a script run twice) must not bury the value worth recovering under
    // copies of itself.
    if (previous.name !== input.name || previous.description !== description) {
      recordDescriptionHistory(
        db,
        id,
        previous,
        describeActor(input.actor),
        now
      );
    }
    db.prepare(
      `UPDATE boards SET name = ?, board_dir = ?, workspace_dir = ?,
       description = ?, updated_at = ? WHERE id = ?`
    ).run(
      input.name,
      board_dir,
      input.workspace_dir ? path.resolve(input.workspace_dir) : '',
      description,
      now,
      id
    );
  } else {
    assertExpectedDescription(id, null, 0, input);
    db.prepare(
      `INSERT INTO boards (id, name, board_dir, workspace_dir, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.name,
      board_dir,
      input.workspace_dir ? path.resolve(input.workspace_dir) : '',
      input.description ?? '',
      now,
      now
    );
  }

  if (Array.isArray(input.repos)) {
    setRepos(db, id, input.repos);
  }
  const board = getBoard(db, id);
  if (!board) throw new Error(`upsert failed for board ${id}`);
  return board;
}

/**
 * Rewrite a board's description and/or display name, and say what it replaced.
 *
 * The verb `upsertBoard` cannot express on its own: "change these two fields on a
 * board that exists, leave the rest, and tell me what was there". It exists for the
 * echo as much as the convenience — **every** describe returns `previous`, so the
 * value that was overwritten is in the caller's transcript whether or not anyone
 * thought to look it up first. That is the cheap half of the 2026-07-30 incident's
 * fix; `board_description_history` is the durable half and `expected_description`
 * is the half that prevents it.
 *
 * @param {DatabaseSync} db
 * @param {{ id: string, description?: string, name?: string,
 *           expected_description?: string | null, actor?: string }} input
 * @returns {{ board: Board, previous: { name: string, description: string },
 *             changed: boolean }}
 * @throws {DescriptionConflictError} when `expected_description` does not match
 */
export function describeBoard(db, input) {
  const board = getBoard(db, input.id);
  if (!board) throw new Error(`no such board: ${input.id}`);
  const previous = { name: board.name, description: board.description };
  const updated = upsertBoard(db, {
    id: board.id,
    name: input.name !== undefined ? String(input.name) : board.name,
    board_dir: board.board_dir,
    workspace_dir: board.workspace_dir,
    description:
      input.description !== undefined ? String(input.description) : undefined,
    expected_description: input.expected_description,
    actor: input.actor
  });
  return {
    board: updated,
    previous,
    changed:
      previous.name !== updated.name ||
      previous.description !== updated.description
  };
}

/**
 * Replace a board's repo list.
 *
 * @param {DatabaseSync} db
 * @param {string} board_id
 * @param {string[]} repos
 */
export function setRepos(db, board_id, repos) {
  db.prepare('DELETE FROM board_repos WHERE board_id = ?').run(board_id);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO board_repos (board_id, repo) VALUES (?, ?)'
  );
  for (const repo of repos) {
    const trimmed = String(repo || '').trim();
    if (trimmed.length > 0) insert.run(board_id, trimmed);
  }
  db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?').run(
    Date.now(),
    board_id
  );
}

/**
 * Add repos to a board without dropping existing ones.
 *
 * @param {DatabaseSync} db
 * @param {string} board_id
 * @param {string[]} repos
 */
export function addRepos(db, board_id, repos) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO board_repos (board_id, repo) VALUES (?, ?)'
  );
  for (const repo of repos) {
    const trimmed = String(repo || '').trim();
    if (trimmed.length > 0) insert.run(board_id, trimmed);
  }
  db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?').run(
    Date.now(),
    board_id
  );
}

/**
 * Remove specific repos from a board, leaving the rest alone.
 *
 * The targeted inverse of `addRepos`, and the pair exists so concurrent callers
 * never need `setRepos`: replace-the-list is a read-modify-write, and two agents
 * doing it at once silently drop each other's edits. Add and remove compose.
 *
 * @param {DatabaseSync} db
 * @param {string} board_id
 * @param {string[]} repos
 * @returns {number} how many rows were actually removed
 */
export function removeRepos(db, board_id, repos) {
  const del = db.prepare(
    'DELETE FROM board_repos WHERE board_id = ? AND repo = ?'
  );
  let removed = 0;
  for (const repo of repos) {
    const trimmed = String(repo || '').trim();
    if (trimmed.length > 0)
      removed += Number(del.run(board_id, trimmed).changes);
  }
  db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?').run(
    Date.now(),
    board_id
  );
  return removed;
}

/**
 * Remove a board from the registry. Does not touch the board's database.
 *
 * @param {DatabaseSync} db
 * @param {string} board_id
 * @returns {boolean} whether a row was removed
 */
export function removeBoard(db, board_id) {
  const res = db.prepare('DELETE FROM boards WHERE id = ?').run(board_id);
  return Number(res.changes) > 0;
}

/**
 * Lowercase and collapse every non-alphanumeric run to a single space, so
 * "sample-controller", "sample_controller" and "sample controller" all compare equal.
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeSeparators(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Scoring weights. Every component is bounded, and none of them scales with how
// many repos a board happens to list — see routeTask for why that matters.
const SCORE_REPO_EXACT = 100;
const SCORE_REPO_SHORT_NAME = 60;
const SCORE_REPO_IN_TEXT = 25;
const SCORE_TOKEN_HIT = 5;
const MAX_DESCRIPTION_SCORE = 40;
const MIN_TOKEN_LENGTH = 4;
const MIN_REPO_MENTION_LENGTH = 3;
const MAX_REPORTED_TOKEN_HITS = 6;

/**
 * Score boards against a task so an agent can decide where an item belongs.
 *
 * **A board is not tied to a repo.** It may list zero, one or many, and repos are
 * an optional hint rather than part of a board's identity. That constrains the
 * scoring in two ways that are easy to get wrong:
 *
 *   1. No component may scale with the size of a board's repo list. Crediting
 *      every matching repo separately made a board listing three repos outscore a
 *      well-described board listing none (75 vs 10), which turns an optional hint
 *      into a requirement for being findable at all. So the repo signal takes the
 *      best single match, and a repo named in the task text is credited once for
 *      the board however many of its repos are mentioned.
 *   2. Description has to be able to win on its own, because for a repo-less board
 *      it is the *only* signal. It is capped so a keyword-stuffed description
 *      can't dominate, but the cap sits above SCORE_REPO_IN_TEXT so a genuinely
 *      well-matched description outranks an incidental repo mention.
 *
 * An explicit repo match still dominates: which repo a task touches is a hard,
 * checkable fact, while prose similarity is inference. Scores are bounded at
 * SCORE_REPO_EXACT + SCORE_REPO_IN_TEXT + MAX_DESCRIPTION_SCORE, so they are
 * comparable across boards.
 *
 * @param {DatabaseSync} db
 * @param {{ text?: string, repo?: string, repos?: string[] }} query
 *   `repo` and `repos` are both accepted; a task can touch several repos.
 * @returns {Array<{ board: Board, score: number, reasons: string[] }>}
 */
export function routeTask(db, query) {
  const text = String(query.text || '').toLowerCase();
  const query_repos = [
    ...(query.repo ? [query.repo] : []),
    ...(Array.isArray(query.repos) ? query.repos : [])
  ]
    .map((r) =>
      String(r || '')
        .trim()
        .toLowerCase()
    )
    .filter((r) => r.length > 0);

  // Short tokens ("a", "to", "the") match everything and rank nothing.
  const tokens = Array.from(
    new Set(
      text.split(/[^a-z0-9]+/).filter((t) => t.length >= MIN_TOKEN_LENGTH)
    )
  );
  const text_words = ` ${normalizeSeparators(text)} `;

  const scored = listBoards(db).map((board) => {
    let score = 0;
    const reasons = [];
    const board_repos = board.repos.map((r) => r.toLowerCase());
    const credited = new Set();

    // Best single match across the query's repos, never a sum: a task touching
    // three repos of one board is not three times the evidence, and summing would
    // reintroduce repo-count scaling through the query side.
    let repo_score = 0;
    let repo_reason = '';
    for (const q of query_repos) {
      if (board_repos.includes(q)) {
        if (SCORE_REPO_EXACT > repo_score) {
          repo_score = SCORE_REPO_EXACT;
          repo_reason = `exact repo match: ${q}`;
        }
        credited.add(q);
        continue;
      }
      // Accept a bare repo name against an owner/name entry, since agents and
      // humans both say "sample-controller" far more often than the full path.
      const short = q.includes('/') ? q.split('/').pop() : q;
      const partial = board_repos.find(
        (r) => r === short || r.split('/').pop() === short
      );
      if (partial) {
        credited.add(partial);
        if (SCORE_REPO_SHORT_NAME > repo_score) {
          repo_score = SCORE_REPO_SHORT_NAME;
          repo_reason = `repo name match: ${short} ~ ${partial}`;
        }
      }
    }
    if (repo_score > 0) {
      score += repo_score;
      reasons.push(repo_reason);
    }

    // A repo named in the free text counts too, but once for the board rather
    // than per repo. Separators are normalized on both sides because repos are
    // hyphenated ("sample-controller") while people describing a task are not, and
    // the match is on whole words — a board owning a short repo like `.../api`
    // would otherwise score on "therapist" or "rapid".
    const mentioned = board.repos.filter((r) => {
      if (credited.has(r.toLowerCase())) return false; // already scored above
      const short = normalizeSeparators(String(r.split('/').pop() || ''));
      return (
        short.length >= MIN_REPO_MENTION_LENGTH &&
        text_words.includes(` ${short} `)
      );
    });
    if (mentioned.length > 0) {
      score += SCORE_REPO_IN_TEXT;
      reasons.push(`text mentions repo: ${mentioned.join(', ')}`);
    }

    // The only signal a repo-less board has, so it must be able to win alone.
    const haystack = `${board.name} ${board.description}`.toLowerCase();
    const hits = tokens.filter((t) => haystack.includes(t));
    if (hits.length > 0) {
      const description_score = Math.min(
        hits.length * SCORE_TOKEN_HIT,
        MAX_DESCRIPTION_SCORE
      );
      score += description_score;
      reasons.push(
        `description/name overlap: ${hits.slice(0, MAX_REPORTED_TOKEN_HITS).join(', ')}`
      );
    }

    return { board, score, reasons };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.board.id.localeCompare(b.board.id));
}
