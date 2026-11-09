"""Build agent-registry databases for tests.

Not a test module (the filename deliberately does not match ``test_*``, so pytest
does not collect it). It exists because two suites need the same schema —
``test_agents_identity.py`` and the ``resolution_cases`` half of
``test_authz_parity.py`` — and a second copy of schema v2 is a second thing to
forget to update when ``boards/registry.mjs`` migrates.

Registries are built with stdlib sqlite3 rather than by shelling out to
``feads-agent``, so these tests stay fast and do not need node on PATH — the same
choice ``test_boards_registry.py`` makes for boards.
"""

import sqlite3
from pathlib import Path
from typing import Any

# Schema v2 from boards/registry.mjs. Every column is declared even where these
# tests never read it, so an INSERT here fails the same way it would against a
# real registry rather than passing on a laxer table.
SCHEMA = """
CREATE TABLE boards (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  board_dir     TEXT NOT NULL UNIQUE,
  workspace_dir TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE board_repos (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  repo     TEXT NOT NULL,
  PRIMARY KEY (board_id, repo)
);
CREATE TABLE agent_invites (
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
CREATE TABLE agents (
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
  kind          TEXT NOT NULL DEFAULT 'agent',
  registered_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  revoked_at    INTEGER NOT NULL DEFAULT 0,
  revoke_reason TEXT NOT NULL DEFAULT '',
  metadata      TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX agents_live_actor_idx ON agents(board_id, actor) WHERE revoked_at = 0;
CREATE INDEX agents_session_idx ON agents(session_id);
CREATE TABLE schema_meta (version INTEGER NOT NULL);
INSERT INTO schema_meta (version) VALUES (2);
"""

# Schema v3, verbatim from the notification contract. Applied only when a caller asks
# for notifications, because **the absence of these tables is a case under test**: a
# registry written by a build that predates the dashboard's notification engine has no
# ``notifications`` table, and answering "you have nothing" rather than raising is the
# behaviour :func:`beads_mcp.notifications.read_notifications` promises. A fixture that
# always created the table could not tell that apart from a fixture that never worked.
NOTIFICATIONS_SCHEMA_V3 = """
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
  read_at         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx
  ON notifications(recipient_actor, read_at, created_at DESC);
CREATE TABLE IF NOT EXISTS notify_state (
  board_key  TEXT PRIMARY KEY,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
UPDATE schema_meta SET version = 3;
"""

# Schema v4: the seen/handled split. Applied as an ALTER on top of v3 rather than folded
# into the CREATE above, exactly as ``boards/registry.mjs`` applies it — so a fixture
# built without it is the table a pre-split dashboard actually left behind, column for
# column, and one built with it acquires ``handled_at`` by the same route production does.
# Both shapes are under test: the MCP server probes for the column and falls back to
# ``read_at`` when it is missing, and a fixture that only ever produced v4 could not tell
# a working fallback from an untested one.
NOTIFICATIONS_SCHEMA_V4 = """
ALTER TABLE notifications ADD COLUMN handled_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS notifications_recipient_handled_idx
  ON notifications(recipient_actor, handled_at, created_at DESC);
UPDATE schema_meta SET version = 4;
"""

# The collapse columns (feads perf/notify pass): ``count`` and ``guidance``, applied as
# ALTERs on top of v4 exactly as ``ensureNotificationSchema`` in boards/notifications.mjs
# applies them. A fixture built without them is a registry whose dashboard predates
# burst-collapse — still a case under test, since the MCP server probes for them.
NOTIFICATIONS_COLLAPSE_COLUMNS = """
ALTER TABLE notifications ADD COLUMN count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN guidance TEXT NOT NULL DEFAULT '';
"""

# The v3 columns an inserted row fills, with ``handled_at`` appended below when the
# fixture is built at v4. Written out rather than derived from the schema so a column added
# above has exactly one other place to be added by hand — and so an INSERT against a table
# it has drifted from fails loudly rather than filling the wrong column.
_NOTIFICATION_INSERT_COLUMNS = (
    "id, board_id, recipient_actor, type, issue_id, issue_title, actor, snippet, "
    "related_issue, created_at, read_at"
)


def build_registry(
    path: Path,
    agents: list[dict[str, Any]],
    boards: tuple[str, ...] = ("lab",),
    notifications: list[dict[str, Any]] | None = None,
    handled_column: bool = True,
    collapse_columns: bool = False,
) -> str:
    """Create a registry containing the given boards and agent rows.

    Args:
        path: Database file to create.
        agents: Rows to insert. Required keys ``id``, ``actor``, ``token_hash``;
            optional ``board_id`` (defaults to the first board), ``role``,
            ``session_id``, ``last_seen_at``, ``revoked_at``, ``revoke_reason``.
            ``token_hash`` is passed already hashed so a caller keeps the plain
            token to present, exactly as a real agent would.
        boards: Board ids to create.
        notifications: Notification rows, which also *migrates the fixture past schema
            v2*. ``None`` leaves the registry at v2 with no ``notifications`` table —
            the state of a machine whose dashboard predates the feature, and a case
            under test. An empty list creates the tables with no rows in them, which is
            a different thing and also under test. Required keys ``id``,
            ``recipient_actor``, ``issue_id``, ``created_at``; the rest default,
            including ``handled_at``.
        handled_column: Whether the ``notifications`` table gets v4's ``handled_at``.
            ``False`` stops at v3 — a registry written by a dashboard from before the
            seen/handled split, where ``read_at`` was the only answer to both questions
            and any ``handled_at`` given in a row has nowhere to go. Also a case under
            test: the MCP server probes for the column and degrades to ``read_at``.
        collapse_columns: Whether the table also gets ``count`` and ``guidance`` (only
            on top of ``handled_at``, as in production). Rows may then carry ``count``
            and ``guidance``.

    Returns:
        The database path as a string, ready for ``db_path=`` or
        ``$FEADS_REGISTRY_DB``.
    """
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SCHEMA)
        for board in boards:
            conn.execute(
                "INSERT INTO boards (id, name, board_dir, workspace_dir, description,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (board, board.upper(), f"{path.parent}/{board}/.beads", f"{path.parent}/{board}", "", 1, 1),
            )
        for row in agents:
            conn.execute(
                "INSERT INTO agents (id, board_id, actor, display_name, role, invite_id,"
                " token_hash, host, workspace_dir, session_id, kind, registered_at,"
                " last_seen_at, revoked_at, revoke_reason, metadata)"
                " VALUES (?, ?, ?, ?, ?, '', ?, 'testhost', '', ?, 'agent', ?, ?, ?, ?, '{}')",
                (
                    row["id"],
                    row.get("board_id", boards[0]),
                    row["actor"],
                    row.get("display_name", row["actor"]),
                    row.get("role", "user"),
                    row["token_hash"],
                    row.get("session_id", ""),
                    row.get("registered_at", 10),
                    row.get("last_seen_at", 20),
                    row.get("revoked_at", 0),
                    row.get("revoke_reason", ""),
                ),
            )
        if notifications is not None:
            conn.executescript(NOTIFICATIONS_SCHEMA_V3)
            if handled_column:
                conn.executescript(NOTIFICATIONS_SCHEMA_V4)
            collapse = handled_column and collapse_columns
            if collapse:
                conn.executescript(NOTIFICATIONS_COLLAPSE_COLUMNS)
            columns = (
                _NOTIFICATION_INSERT_COLUMNS
                + (", handled_at" if handled_column else "")
                + (", count, guidance" if collapse else "")
            )
            placeholders = ", ".join("?" for _ in columns.split(", "))
            for row in notifications:
                values: list[Any] = [
                    row["id"],
                    row.get("board_id", boards[0]),
                    row["recipient_actor"],
                    row.get("type", "mention"),
                    row["issue_id"],
                    row.get("issue_title", ""),
                    row.get("actor", ""),
                    row.get("snippet", ""),
                    row.get("related_issue", ""),
                    row["created_at"],
                    row.get("read_at", 0),
                ]
                if handled_column:
                    values.append(row.get("handled_at", 0))
                if collapse:
                    values.extend([row.get("count", 1), row.get("guidance", "")])
                conn.execute(
                    f"INSERT INTO notifications ({columns}) VALUES ({placeholders})",
                    tuple(values),
                )
        conn.commit()
    finally:
        conn.close()
    return str(path)
