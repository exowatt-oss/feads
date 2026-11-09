"""The Postgres data layer for issue tools — the ``bd`` subprocess's replacement.

This is the *store* half of the feads Option C strangler. Everything above it is
untouched: the FastMCP tools, their parameter schemas, the permission gates, the
compaction/brief/fields shaping, the mention enrichment. What changes is only where
an issue is read from and written to.

## Why it is shaped like a bd client

:class:`PgStoreClient` implements :class:`beads_mcp.bd_client.BdClientBase`, and every
read hands back **the same Python dicts ``bd --json`` would have printed**, which are
then passed through the same ``_sanitize_issue_deps`` + ``Model.model_validate`` the
CLI path uses. That is deliberate and it is the whole safety argument: the tool layer
cannot tell which store answered, so the reply an agent sees cannot drift from what it
saw yesterday — including bd's own quirks (``dependency_count`` on a list row is
rewritten to the *total* number of dependency records by the sanitizer, ``reopen`` of an
already-open issue raises rather than returning an empty list, and so on). Re-deriving
"what the tool should return" instead of "what bd returned" is how a frozen contract
quietly thaws.

The shapes were not guessed. They were captured from `bd 1.1.0` against a scratch board
covering the awkward cases (an epic, a closed blocker, a parent-child edge, a `related`
edge, labels, comments, an assignee) and diffed field by field; see
``tests/test_pgstore_contract.py``, which re-runs that diff against the golden captures
in ``.pg-fixtures/``.

## Semantics live in SQL views, once

``ready_issues`` / ``blocked_issues`` / ``epic_status`` (``pgstore/views.sql``) are
shared with the Node dashboard and locked against golden `bd` output by
``pgstore/parity.mjs``. This module reads them rather than restating their WHERE
clauses, so the two surfaces cannot disagree about what "ready" means. The filter and
ORDER BY clauses that are *not* in a view are transliterated from
``internal/storage/sqlbuild`` — the origin of each is named at its call site.

## Every write announces itself

A write runs in one transaction that also appends an ``events`` row and fires
``NOTIFY feads_events '<board>:<issue>:<kind>'``. The dashboard's live push and its
delta subscriptions are built on that stream (``ui/server/pg-store.js``), so a write
that skipped it would land in the database and be invisible until someone reloaded.
The kinds and payload keys mirror that module exactly.

## Nothing writes the Dolt board in pg mode

Not "almost nothing". The artifact tools used to reach `bd` directly for their
metadata and comment writes (:mod:`beads_mcp.artifacts`), which would have left issue
data split across two databases with no way to reconcile them; they now go through
:meth:`PgStoreClient.patch_metadata` and :meth:`PgStoreClient.add_comment` like every
other write. The ``admin`` diagnostics — schema, migration, repair, pollution,
validate — **refuse** rather than delegate, because in pg mode the on-disk board is a
frozen archive and answering from it would describe a snapshot as if it were live.
``quickstart`` still delegates: it prints a guide out of the bd binary and reads no
board data. ``init`` delegates too, for the opposite reason — creating a board on disk
is the one thing a database cannot do for itself — and the caller then registers the
result here with :func:`ensure_board`.

## What this module deliberately does NOT own

Board discovery, the agent registry and notifications keep their current
implementations — they read the SQLite registry, which did not move.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import socket
import subprocess
import sys
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from . import accounts as _accounts
from .agents import acting_actor
from .bd_client import (
    BdClientBase,
    BdCommandError,
    BdError,
    _sanitize_issue_deps,
    mutation_actor,
    silo_configured,
)
from .config import PG_DSN_ENV, load_config, normalize_pg_dsn
from .models import (
    AddCommentParams,
    AddDependencyParams,
    AddNoteParams,
    BlockedIssue,
    BlockedParams,
    ClaimIssueParams,
    CloseIssueParams,
    Comment,
    CreateIssueParams,
    InitParams,
    Issue,
    ListCommentsParams,
    ListIssuesParams,
    ReadyWorkParams,
    RemoveDependencyParams,
    ReopenIssueParams,
    ShowIssueParams,
    Stats,
    UpdateIssueParams,
)
from .workspace import normalize_workspace_dir
from .workspace_state import WORKSPACE_DIR_KEY, binding_metadata, create_binding

logger = logging.getLogger(__name__)

# The NOTIFY channel every writer of this database shares. Mirrors PG_CHANNEL in
# ui/server/pg-store.js — a second spelling here would silence the dashboard.
PG_CHANNEL = "feads_events"

# A claim's lease, matching what `bd update --claim` stamps (5 minutes).
CLAIM_LEASE = timedelta(minutes=5)

# Issue types `bd ready` excludes when the caller named no type. Transliterated from
# sqlbuild.ReadyWorkExcludeTypes + domain.DefaultInfraTypes(); epics are deliberately
# NOT here (bd lists them as ready, and the ready_issues view agrees).
READY_EXCLUDED_TYPES: tuple[str, ...] = (
    "merge-request",
    "gate",
    "molecule",
    "rig",
    "agent",
    "role",
    "message",
)

# Id minting: three base36 characters, i.e. one of 36**3 suffixes. Same alphabet and
# width as bd's own ids (ex-dw0, lab-7eu) and as mintId() in ui/server/pg-store.js.
_ID_SPACE = 36**3
_ID_ATTEMPTS = 12

# "not looked up yet", distinct from a looked-up None ("BEADS_ACTOR is unset").
_UNRESOLVED = "\x00unresolved"


# The issue columns every read projects. Listed rather than SELECT *, so a column added
# by a later migration cannot silently change the dicts this module promises. The
# qualified spelling is not decoration: `show` joins deps to issues, and deps carries
# its own created_at/created_by/metadata, so an unqualified list is ambiguous there.
_ISSUE_COLUMN_NAMES: tuple[str, ...] = (
    "id",
    "board_id",
    "title",
    "description",
    "design",
    "acceptance_criteria",
    "notes",
    "close_reason",
    "status",
    "issue_type",
    "priority",
    "assignee",
    "owner",
    "created_by",
    "external_ref",
    "metadata",
    "created_at",
    "updated_at",
    "closed_at",
    "started_at",
    "lease_expires_at",
    "heartbeat_at",
)
ISSUE_COLUMNS = ", ".join(_ISSUE_COLUMN_NAMES)
ISSUE_COLUMNS_I = ", ".join(f"i.{c}" for c in _ISSUE_COLUMN_NAMES)


# =============================================================================
# Configuration and the pool
# =============================================================================


def pg_dsn() -> str | None:
    """The Postgres DSN this server should use, or None for the bd subprocess path.

    The declaration lives on :class:`beads_mcp.config.Config` beside ``BEADS_PATH``, so
    the flag is configured and documented the same way every other setting is. What is
    read *here* is the environment, through the config module's own normalizer — two
    reasons, both about not making the wrong thing depend on the right one:

    * this is asked on every tool call, and building a ``Config`` runs the
      ``beads_path`` validator's PATH scan for a question that has nothing to do with
      bd;
    * a deployment that has cut over may not ship a `bd` binary at all, and a config
      error about a missing bd must not be able to answer "pg mode is off" — which is
      the one answer that would send every write back to the subprocess that is not
      there.

    Resolved per call rather than cached: the tests flip it with monkeypatch, and a
    cached answer would make the two modes untestable in one process.
    """
    return normalize_pg_dsn(os.environ.get(PG_DSN_ENV))


def pg_enabled() -> bool:
    """Whether issue data comes from Postgres on this call."""
    return bool(pg_dsn())


_pool: Any = None
_pool_dsn: str | None = None
_pool_lock = asyncio.Lock()

# Per-statement ceiling, enforced client-side by asyncpg (it sends a cancel request
# and recycles the connection) — never a session SET, which a transaction pooler would
# leak across clients. Without it one half-open TCP connection (a pooler restart, a
# network blip) leaves a query waiting forever, and ten of them wedge every call on the
# pool (seen in prod: `changes` silent for 50 minutes, FOLLOWUPS #9). Generous on
# purpose: nothing this server runs should take a minute.
PG_COMMAND_TIMEOUT_ENV = "FEADS_PG_COMMAND_TIMEOUT_S"
DEFAULT_PG_COMMAND_TIMEOUT_S = 60.0


def pg_command_timeout() -> float | None:
    """Seconds per statement; ``0`` (or negative) disables the ceiling."""
    raw = os.environ.get(PG_COMMAND_TIMEOUT_ENV, "").strip()
    try:
        value = float(raw) if raw else DEFAULT_PG_COMMAND_TIMEOUT_S
    except ValueError:
        value = DEFAULT_PG_COMMAND_TIMEOUT_S
    return value if value > 0 else None


async def get_pool() -> Any:
    """The process-wide asyncpg pool, opened on first use.

    One pool, not one per board: a board is a column here, not a database. The pool is
    what buys real concurrency — the bd path serialized on process spawn, and nothing in
    this module needs a lock beyond the one guarding pool creation itself.

    Re-opened if the DSN changed under us, which only happens in tests.
    """
    global _pool, _pool_dsn

    dsn = pg_dsn()
    if not dsn:
        raise BdError("FEADS_PG_DSN is not set; the Postgres store is unavailable")

    if _pool is not None and _pool_dsn == dsn:
        return _pool

    async with _pool_lock:
        if _pool is not None and _pool_dsn == dsn:
            return _pool
        if _pool is not None:
            old, _pool = _pool, None
            await old.close()
        try:
            import asyncpg
        except ImportError as exc:  # pragma: no cover - packaging guard
            raise BdError(
                "FEADS_PG_DSN is set but asyncpg is not installed. "
                "Install the pg extra: pip install 'beads-mcp[pg]'"
            ) from exc
        _pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=10, command_timeout=pg_command_timeout())
        _pool_dsn = dsn
        return _pool


async def close_pool() -> None:
    """Close the pool, if one is open. For tests and orderly shutdown."""
    global _pool, _pool_dsn
    async with _pool_lock:
        if _pool is not None:
            pool, _pool = _pool, None
            _pool_dsn = None
            await pool.close()


def board_id_for_workspace(workspace_root: str) -> str:
    """The board a workspace maps to: the directory holding the ``.beads`` directory.

    ``…/boards/<board_id>/.beads`` on the hosted deployment, ``…/example/.beads`` and
    ``…/feads/.beads`` locally — in both layouts the board id is the basename of the
    parent of ``.beads``, which is the path this server already resolved before asking.
    Deriving it here (rather than consulting the registry again) keeps context
    semantics exactly as they are: a path that exists nowhere is still refused
    upstream, by the same code that refused it before.
    """
    return os.path.basename(os.path.normpath(workspace_root))


async def list_board_prefixes() -> dict[str, str]:
    """Every board's issue-id prefix, mapped to its board id.

    The routing table for issue-id → board resolution: ids are minted as
    ``<prefix>-<suffix>`` and ``prefix`` is unique in ``boards``, so a call that
    names an issue id has already named its board. Read fresh from the store and
    cached briefly by the caller — boards are created rarely and the table is
    tiny, so a short TTL keeps a just-created board routable without a per-call
    query.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT id, prefix FROM boards WHERE prefix IS NOT NULL AND prefix <> ''")
    return {str(row["prefix"]): str(row["id"]) for row in rows}


async def boards_of_issues(issue_ids: Sequence[str]) -> dict[str, str]:
    """The board that actually holds each live issue (``{id: board_id}``).

    The authority for authorization: an issue id's prefix only *suggests* a board,
    and an id missing from the answer is held by no board at all (never minted, or
    tombstoned). Raises on a store failure — callers deciding access must refuse
    then, not guess.
    """
    wanted = sorted({str(i) for i in issue_ids if str(i or "").strip()})
    if not wanted:
        return {}
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, board_id FROM issues WHERE id = ANY($1::text[]) AND deleted_at IS NULL",
            wanted,
        )
    return {str(row["id"]): str(row["board_id"]) for row in rows}


async def mention_context(issue_ids: Sequence[str], per_issue: int = 20) -> dict[str, Any]:
    """Current status/title/assignee of each issue and its newest comments that contain
    an ``@`` — what the ``notifications(view="mentions")`` digest shows next to a mention
    (the full comment rather than the notification's 200-character snippet).

    Cross-board on purpose (a person's mentions span boards); the caller has already
    scoped the ids to boards it may read. Bounded: at most ``per_issue`` comments per
    issue. Raises on a store failure — the caller falls back to the stored snippet.
    """
    wanted = sorted({str(i) for i in issue_ids if str(i or "").strip()})
    if not wanted:
        return {"issues": {}, "comments": {}}
    pool = await get_pool()
    async with pool.acquire() as conn:
        issue_rows = await conn.fetch(
            "SELECT id, status, title, assignee FROM issues WHERE id = ANY($1::text[]) AND deleted_at IS NULL",
            wanted,
        )
        comment_rows = await conn.fetch(
            "SELECT issue_id, author, body, created_at FROM ("
            "  SELECT issue_id, author, body, created_at,"
            "         row_number() OVER (PARTITION BY issue_id ORDER BY created_at DESC, id DESC) AS rn"
            "    FROM comments WHERE issue_id = ANY($1::text[]) AND position('@' in body) > 0"
            ") c WHERE rn <= $2 ORDER BY issue_id, created_at DESC",
            wanted,
            int(per_issue),
        )
    issues = {
        str(r["id"]): {"status": str(r["status"]), "title": str(r["title"]), "assignee": str(r["assignee"] or "")}
        for r in issue_rows
    }
    comments: dict[str, list[dict[str, Any]]] = {}
    for r in comment_rows:
        created = r["created_at"]
        comments.setdefault(str(r["issue_id"]), []).append(
            {
                "author": str(r["author"] or ""),
                "text": str(r["body"] or ""),
                "created_at_ms": int(created.timestamp() * 1000) if created is not None else 0,
            }
        )
    return {"issues": issues, "comments": comments}


# =============================================================================
# bd's wire shapes
# =============================================================================


def _ts(value: datetime | None) -> str | None:
    """A timestamp the way bd prints one: RFC3339 in UTC, second precision, ``Z``.

    bd marshals ``time.Time`` and Go drops trailing zero fractions, so every stored
    timestamp in the live boards reads ``2026-07-30T16:20:09Z``. Truncating rather than
    rounding matches, and keeps a value stable across a re-read.
    """
    if value is None:
        return None
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _put(target: dict[str, Any], key: str, value: Any) -> None:
    """Set ``key`` only when Go's ``omitempty`` would have emitted it.

    Omission is not cosmetic here. ``Issue.description`` is typed ``str`` with a default
    of ``""``; a literal ``None`` fails validation where an absent key does not, so
    "what bd leaves out" is part of the contract rather than a rendering choice.
    """
    if value is None or value == "" or value == []:
        return
    target[key] = value


def _metadata(raw: Any) -> Any:
    """Decode a jsonb column, dropping the empty object bd would not have emitted."""
    if raw in (None, "", "{}"):
        return None
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None
    else:
        parsed = raw
    return parsed or None


def _bare_issue(row: Any) -> dict[str, Any]:
    """One issues row in bd's issue shape, without any of the derived counters.

    This is exactly what bd emits for a *nested* issue (an entry in ``show``'s
    ``dependencies``). The list/ready/blocked/show shapes are all this plus their own
    extra keys, which is why they share it.
    """
    out: dict[str, Any] = {"id": row["id"], "title": row["title"]}
    _put(out, "description", row["description"])
    _put(out, "design", row["design"])
    _put(out, "acceptance_criteria", row["acceptance_criteria"])
    _put(out, "notes", row["notes"])
    _put(out, "status", row["status"])
    out["priority"] = row["priority"]  # no omitempty: 0 is P0, a real value
    _put(out, "issue_type", row["issue_type"])
    _put(out, "assignee", row["assignee"])
    _put(out, "owner", row["owner"])
    out["created_at"] = _ts(row["created_at"])
    _put(out, "created_by", row["created_by"])
    out["updated_at"] = _ts(row["updated_at"])
    _put(out, "started_at", _ts(row["started_at"]))
    _put(out, "closed_at", _ts(row["closed_at"]))
    _put(out, "close_reason", row["close_reason"])
    _put(out, "lease_expires_at", _ts(row["lease_expires_at"]))
    _put(out, "heartbeat_at", _ts(row["heartbeat_at"]))
    _put(out, "external_ref", row["external_ref"])
    _put(out, "metadata", _metadata(row["metadata"]))
    return out


def _workspace_prefix_sql(prefix: str, arg: Any) -> str:
    """The WHERE fragment for "``metadata.workspace_dir`` is at or below ``prefix``".

    The pg spelling of :func:`beads_mcp.bd_client._under_workspace_prefix`, applied
    server-side so a busy board is not paged through to answer it. Path-boundary aware
    by comparing against ``prefix + '/'`` with ``left()`` rather than ``LIKE`` — a
    directory name containing ``_`` or ``%`` must not turn into a wildcard, and
    ``left(x, n)`` needs no escaping at all. Equality still counts: the workspace itself
    is under itself.
    """
    boundary = prefix if prefix.endswith(os.sep) else prefix + os.sep
    column = f"(i.metadata->>'{WORKSPACE_DIR_KEY}')"
    exact, below = arg(prefix), arg(boundary)
    return f"({column} = {exact} OR left({column}, length({below})) = {below})"


def _raw_dep(row: Any) -> dict[str, Any]:
    """A dependency row the way ``bd list`` prints one (the un-hydrated form).

    ``_sanitize_issue_deps`` throws these away and keeps only their count, so the shape
    matters less than the *number* — but it is reproduced faithfully anyway, because the
    sanitizer recognises the form by its ``depends_on_id`` key and would leave a
    differently-shaped record in place, where it would fail LinkedIssue validation.
    """
    return {
        "issue_id": row["issue_id"],
        "depends_on_id": row["depends_on_id"],
        "type": row["dep_type"],
        "created_at": _ts(row["created_at"]),
        "created_by": row["created_by"],
        "metadata": json.dumps(_metadata(row["metadata"]) or {}, separators=(",", ":")),
    }


# =============================================================================
# Actor resolution
# =============================================================================

_fallback_actor: str | None = None


def _default_actor() -> str:
    """bd's own answer to "who is acting" when nothing named an actor.

    ``git config user.name``, then the hostname (config.GetIdentity in the Go source).
    Cached: it is a subprocess, and the answer cannot change within a process's life.
    """
    global _fallback_actor
    if _fallback_actor is not None:
        return _fallback_actor

    name = ""
    try:
        result = subprocess.run(
            ["git", "config", "user.name"],
            capture_output=True,
            text=True,
            check=False,
            stdin=subprocess.DEVNULL,
            shell=sys.platform == "win32",
        )
        if result.returncode == 0:
            name = result.stdout.strip()
    except Exception:  # pragma: no cover - git absent
        name = ""

    if not name:
        try:
            name = socket.gethostname()
        except Exception:  # pragma: no cover
            name = ""

    _fallback_actor = name or "unknown"
    return _fallback_actor


# =============================================================================
# The client
# =============================================================================


class PgStoreClient(BdClientBase):
    """A :class:`BdClientBase` whose issue data lives in Postgres.

    One instance per board. Cheap to construct (it holds no connection — the pool is
    process-wide), so the tools-layer pool that keyed bd clients by workspace keys these
    the same way without changing.
    """

    board_id: str
    workspace_root: str
    actor: str | None

    def __init__(self, board_id: str, workspace_root: str = "", actor: str | None = None) -> None:
        self.board_id = board_id
        self.workspace_root = workspace_root
        self._configured_actor = actor
        self._env_actor: str | None = _UNRESOLVED
        self._bd_fallback: BdClientBase | None = None

    # -- identity -----------------------------------------------------------

    def _acting_actor(self) -> str:
        """Who this call is attributed to.

        Same chain as :meth:`BdCliClient._acting_actor` — the caller's verified wire
        identity first, read **per call** because clients are pooled and shared across
        agents, so anything cached would describe whoever's request built this client
        rather than whoever is calling now — with bd's own git/hostname fallback
        appended, since there is no subprocess left to work it out for us.

        Only the *fallback* is cached, and only per client. ``BEADS_ACTOR`` is process
        configuration, not caller identity, and reading it costs a ``Config`` build
        whose ``beads_path`` validator scans PATH.
        """
        if silo_configured():
            return mutation_actor(fallback=self._configured_actor)
        actor = acting_actor()
        return actor or self._fallback_actor() or _default_actor()

    def _fallback_actor(self) -> str | None:
        """``BEADS_ACTOR``, resolved once per client, for a caller that verified as nobody.

        This is only the legacy base-mode configuration fallback; verified request
        identity never enters the pooled client and is read by ``_acting_actor``.
        """
        if self._configured_actor is not None:
            return self._configured_actor
        if self._env_actor is _UNRESOLVED:
            try:
                self._env_actor = load_config().beads_actor
            except Exception:
                # A pg-mode deployment need not ship bd, and its absence is what makes
                # load_config raise. That says nothing about who is acting.
                self._env_actor = os.environ.get("BEADS_ACTOR") or None
        return self._env_actor

    # -- delegation for the things Postgres does not know -------------------

    def _bd(self) -> BdClientBase:
        """A CLI client for the two things Postgres cannot do: print the guide, make a board.

        Built lazily so a pg-mode deployment that ships no `bd` binary works right up
        until someone calls ``quickstart`` or ``init``. The ``admin`` diagnostics used
        to come through here and no longer do — see the refusals below.
        """
        if self._bd_fallback is None:
            from .bd_client import create_bd_client

            beads_dir = os.path.join(self.workspace_root, ".beads") if self.workspace_root else None
            self._bd_fallback = create_bd_client(
                working_dir=self.workspace_root or None,
                beads_dir=beads_dir if beads_dir and os.path.isdir(beads_dir) else None,
            )
        return self._bd_fallback

    # -- plumbing -----------------------------------------------------------

    async def _board_prefix(self, conn: Any) -> str:
        """The issue-id prefix registered for this board.

        A board absent from the ``boards`` table is an error rather than an empty
        result: answering "no issues" for a board that exists on disk but was never
        imported is the failure that looks like data loss.
        """
        prefix = await conn.fetchval("SELECT prefix FROM boards WHERE id = $1", self.board_id)
        if prefix is None:
            known = await conn.fetch("SELECT id FROM boards ORDER BY id")
            raise BdError(
                f"board '{self.board_id}' is not in the feads Postgres store.\n"
                f"  Known boards: {', '.join(str(r['id']) for r in known) or '(none)'}\n"
                "  A board has to be imported into the store before this server can read "
                "or write it (pgstore/import-jsonl.mjs)."
            )
        return str(prefix)

    async def _assert_board(self, conn: Any) -> None:
        await self._board_prefix(conn)

    async def _fetch_issue_row(self, conn: Any, issue_id: str) -> Any:
        return await conn.fetchrow(
            f"SELECT {ISSUE_COLUMNS} FROM issues WHERE id = $1 AND board_id = $2 AND deleted_at IS NULL",
            issue_id,
            self.board_id,
        )

    async def _require_issue_row(self, conn: Any, issue_id: str, miss: str = "fetch") -> Any:
        """The row, or the refusal `bd` would have produced for this subcommand.

        ``miss`` picks which one. bd words "no such issue" four different ways
        depending on which command asked, and the CLI client wraps each with a
        different prefix — a caller that learned to read one of them should keep
        recognising it. See :func:`_not_found`.
        """
        row = await self._fetch_issue_row(conn, issue_id)
        if row is None:
            raise _not_found(issue_id, miss)
        return row

    async def _emit(
        self,
        conn: Any,
        issue_id: str,
        kind: str,
        actor: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        """Append the audit row and fire the notification, inside the caller's transaction.

        Same table, same kinds, same channel string as ``emitEvent`` in
        ui/server/pg-store.js. Inside the transaction on purpose: a rolled-back write
        must announce nothing.
        """
        await conn.execute(
            "INSERT INTO events (board_id, issue_id, actor, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
            self.board_id,
            issue_id,
            actor or None,
            kind,
            json.dumps(payload or {}),
        )
        await conn.execute("SELECT pg_notify($1, $2)", PG_CHANNEL, f"{self.board_id}:{issue_id}:{kind}")

    # -- hydration ----------------------------------------------------------

    async def _labels_for(self, conn: Any, ids: list[str]) -> dict[str, list[str]]:
        if not ids:
            return {}
        rows = await conn.fetch(
            "SELECT issue_id, label FROM labels WHERE issue_id = ANY($1::text[]) ORDER BY issue_id, label",
            ids,
        )
        out: dict[str, list[str]] = {}
        for row in rows:
            out.setdefault(row["issue_id"], []).append(row["label"])
        return out

    async def _deps_for(self, conn: Any, ids: list[str]) -> dict[str, list[Any]]:
        if not ids:
            return {}
        rows = await conn.fetch(
            "SELECT issue_id, depends_on_id, dep_type, created_at, created_by, metadata "
            "FROM deps WHERE issue_id = ANY($1::text[]) "
            "ORDER BY issue_id, depends_on_id, dep_type",
            ids,
        )
        rows = await _drop_unreadable_edges(conn, rows, "depends_on_id")
        out: dict[str, list[Any]] = {}
        for row in rows:
            out.setdefault(row["issue_id"], []).append(row)
        return out

    async def _blocks_counts(self, conn: Any, ids: list[str]) -> tuple[dict[str, int], dict[str, int]]:
        """``dependency_count`` / ``dependent_count`` the way a *list* row carries them.

        Blocking edges only, both directions — transliterated from
        ``dependencySQLRepositoryImpl.CountsByIssueIDs``, which filters ``type =
        'blocks'``. ``show`` counts differently (every edge type); that asymmetry is
        bd's, and :meth:`show` reproduces it rather than smoothing it out.
        """
        if not ids:
            return {}, {}
        out_rows = await conn.fetch(
            "SELECT issue_id, count(*) AS n FROM deps "
            "WHERE issue_id = ANY($1::text[]) AND dep_type = 'blocks' GROUP BY issue_id",
            ids,
        )
        in_rows = await conn.fetch(
            "SELECT depends_on_id AS issue_id, count(*) AS n FROM deps "
            "WHERE depends_on_id = ANY($1::text[]) AND dep_type = 'blocks' GROUP BY depends_on_id",
            ids,
        )
        return (
            {r["issue_id"]: int(r["n"]) for r in out_rows},
            {r["issue_id"]: int(r["n"]) for r in in_rows},
        )

    async def _comment_counts(self, conn: Any, ids: list[str]) -> dict[str, int]:
        if not ids:
            return {}
        rows = await conn.fetch(
            "SELECT issue_id, count(*) AS n FROM comments WHERE issue_id = ANY($1::text[]) GROUP BY issue_id",
            ids,
        )
        return {r["issue_id"]: int(r["n"]) for r in rows}

    async def _list_shape(self, conn: Any, rows: list[Any]) -> list[dict[str, Any]]:
        """Hydrate issue rows into bd's ``list``/``ready`` shape."""
        ids = [r["id"] for r in rows]
        labels = await self._labels_for(conn, ids)
        deps = await self._deps_for(conn, ids)
        dep_counts, rdep_counts = await self._blocks_counts(conn, ids)
        comments = await self._comment_counts(conn, ids)

        out: list[dict[str, Any]] = []
        for row in rows:
            issue_id = row["id"]
            item = _bare_issue(row)
            _put(item, "labels", labels.get(issue_id, []))
            raw = deps.get(issue_id, [])
            _put(item, "dependencies", [_raw_dep(d) for d in raw])
            item["dependency_count"] = dep_counts.get(issue_id, 0)
            item["dependent_count"] = rdep_counts.get(issue_id, 0)
            item["comment_count"] = comments.get(issue_id, 0)
            parent = next((d["depends_on_id"] for d in raw if d["dep_type"] == "parent-child"), None)
            _put(item, "parent", parent)
            out.append(item)
        return out

    # -- reads --------------------------------------------------------------

    async def ready(self, params: ReadyWorkParams | None = None) -> list[Issue]:
        """Issues with no live blocker, in bd's ready order.

        Membership comes from the ``ready_issues`` view (parity-locked against golden
        `bd` output). The extra predicates and the ORDER BY are bd's ready-work clause
        from ``sqlbuild.BuildReadyWorkWhere`` / ``BuildReadyWorkOrder``; ``hybrid`` — the
        default — floats anything created in the last 48h to the top and ranks the rest
        oldest-first, which is why it needs the cutoff parameter.
        """
        params = params or ReadyWorkParams()
        pool = await get_pool()
        async with pool.acquire() as conn:
            await self._assert_board(conn)

            where = ["i.board_id = $1"]
            args: list[Any] = [self.board_id]

            def arg(value: Any) -> str:
                args.append(value)
                return f"${len(args)}"

            if params.priority is not None:
                where.append(f"i.priority = {arg(params.priority)}")
            if params.issue_type:
                where.append(f"i.issue_type = {arg(params.issue_type)}")
            else:
                where.append(f"i.issue_type <> ALL({arg(list(READY_EXCLUDED_TYPES))}::text[])")
            if params.unassigned:
                where.append("(i.assignee IS NULL OR i.assignee = '')")
            elif params.assignee:
                where.append(f"i.assignee = ANY({arg(_alias_group(params.assignee))}::text[])")
            for label in params.labels or []:
                where.append(f"i.id IN (SELECT issue_id FROM labels WHERE label = {arg(label)})")
            if params.labels_any:
                where.append(
                    f"i.id IN (SELECT issue_id FROM labels WHERE label = ANY({arg(params.labels_any)}::text[]))"
                )
            if params.parent_id:
                where.append(f"i.id = ANY({arg(await self._descendants(conn, params.parent_id))}::text[])")

            order = self._ready_order(params.sort_policy, arg)
            sql = (
                f"SELECT {ISSUE_COLUMNS_I} FROM ready_issues i "
                f"WHERE {' AND '.join(where)} {order} LIMIT {arg(params.limit)}"
            )
            rows = await conn.fetch(sql, *args)
            data = await self._list_shape(conn, list(rows))

        return [Issue.model_validate(_sanitize_issue_deps(item)) for item in data]

    @staticmethod
    def _ready_order(policy: str | None, arg: Any) -> str:
        """bd's ready ORDER BY, from ``sqlbuild.BuildReadyWorkOrder``."""
        if policy == "oldest":
            return "ORDER BY i.created_at ASC, i.id ASC"
        if policy == "priority":
            return "ORDER BY i.priority ASC, i.created_at ASC, i.id ASC"
        # hybrid (the default, and anything unrecognised falls back to priority in bd's
        # switch — but only after IsValid() has already rejected the unknown value).
        cutoff = datetime.now(timezone.utc) - timedelta(hours=48)
        a = arg(cutoff)
        b = arg(cutoff)
        return (
            f"ORDER BY CASE WHEN i.created_at >= {a} THEN 0 ELSE 1 END ASC, "
            f"CASE WHEN i.created_at >= {b} THEN i.priority ELSE 999 END ASC, "
            "i.created_at ASC, i.id ASC"
        )

    async def _descendants(self, conn: Any, parent_id: str) -> list[str]:
        """Every transitive parent-child descendant of ``parent_id``.

        bd recurses here (GH#3396 fixed a one-hop version that silently dropped
        grandchildren), so this does too — as a recursive CTE rather than the Go loop.
        """
        rows = await conn.fetch(
            """
            WITH RECURSIVE descendants(id) AS (
                SELECT d.issue_id FROM deps d
                 WHERE d.depends_on_id = $1 AND d.dep_type = 'parent-child'
                UNION
                SELECT d.issue_id FROM deps d
                  JOIN descendants x ON d.depends_on_id = x.id
                 WHERE d.dep_type = 'parent-child'
            )
            SELECT id FROM descendants
            """,
            parent_id,
        )
        return [r["id"] for r in rows]

    async def list_issues(self, params: ListIssuesParams | None = None) -> list[Issue]:
        """``bd list``: everything not closed unless a status was named.

        The default WHERE (``deleted_at IS NULL AND status <> 'closed'``, deferred
        included) is the one ``pgstore/parity.mjs`` locks against golden `bd` output.
        The ORDER BY is ``sqlbuild.OrderBy("")`` — priority, then newest, then id.
        """
        params = params or ListIssuesParams()
        pool = await get_pool()
        async with pool.acquire() as conn:
            await self._assert_board(conn)

            where = ["i.board_id = $1", "i.deleted_at IS NULL"]
            args: list[Any] = [self.board_id]

            def arg(value: Any) -> str:
                args.append(value)
                return f"${len(args)}"

            if params.status:
                where.append(f"i.status = {arg(params.status)}")
            else:
                where.append("i.status <> 'closed'")
            if params.priority is not None:
                where.append(f"i.priority = {arg(params.priority)}")
            if params.issue_type:
                where.append(f"i.issue_type = {arg(params.issue_type)}")
            if params.unassigned:
                where.append("(i.assignee IS NULL OR i.assignee = '')")
            elif params.assignee:
                where.append(f"i.assignee = ANY({arg(_alias_group(params.assignee))}::text[])")
            for label in params.labels or []:
                where.append(f"i.id IN (SELECT issue_id FROM labels WHERE label = {arg(label)})")
            if params.labels_any:
                where.append(
                    f"i.id IN (SELECT issue_id FROM labels WHERE label = ANY({arg(params.labels_any)}::text[]))"
                )
            if params.query:
                # A literal case-insensitive substring, matching the flag's documented
                # meaning. position() rather than ILIKE so a title search for "50%"
                # searches for "50%" instead of becoming a wildcard.
                where.append(f"position(lower({arg(params.query)}) in lower(i.title)) > 0")
            prefix = normalize_workspace_dir(params.workspace_dir_prefix)
            if prefix:
                where.append(_workspace_prefix_sql(prefix, arg))
            order = "i.priority ASC, i.created_at DESC, i.id ASC"
            if params.ids is not None:
                # "Tickets I was mentioned in": these ids only, open ones first, then in
                # the order given (most recent mention first); closed ones too unless a
                # status was named.
                ids_arg = arg(list(params.ids))
                where.append(f"i.id = ANY({ids_arg}::text[])")
                if not params.status:
                    where.remove("i.status <> 'closed'")
                order = f"(i.status = 'closed') ASC, array_position({ids_arg}::text[], i.id) ASC"

            sql = (
                f"SELECT {ISSUE_COLUMNS_I} FROM issues i WHERE {' AND '.join(where)} "
                f"ORDER BY {order} LIMIT {arg(params.limit)}"
            )
            rows = await conn.fetch(sql, *args)
            data = await self._list_shape(conn, list(rows))

        return [Issue.model_validate(_sanitize_issue_deps(item)) for item in data]

    async def show(self, params: ShowIssueParams) -> Issue:
        """``bd show``: one issue with its dependencies hydrated.

        Two things differ from a list row and both are bd's, not ours: the dependency
        edges arrive as whole issues (with ``dependency_type``) rather than as raw
        records, and the two counters count *every* edge type instead of only
        ``blocks``.
        """
        pool = await get_pool()
        async with pool.acquire() as conn:
            await self._assert_board(conn)
            row = await self._require_issue_row(conn, params.issue_id)

            item = _bare_issue(row)
            labels = await self._labels_for(conn, [row["id"]])
            _put(item, "labels", labels.get(row["id"], []))

            dep_rows = await conn.fetch(
                f"SELECT d.dep_type, {ISSUE_COLUMNS_I} FROM deps d JOIN issues i ON i.id = d.depends_on_id "
                "WHERE d.issue_id = $1 AND i.deleted_at IS NULL "
                "ORDER BY d.depends_on_id, d.dep_type",
                row["id"],
            )
            # Accounts mode: an edge to a board the caller cannot read (a board moved to
            # another space after the edge was made) is dropped, not just its title.
            readable = _accounts.readable_board_set()
            if readable is not None:
                dep_rows = [r for r in dep_rows if str(r["board_id"]) in readable]
            dep_ids = [r["id"] for r in dep_rows]
            dep_labels = await self._labels_for(conn, dep_ids)
            dependencies = []
            for dep in dep_rows:
                linked = _bare_issue(dep)
                _put(linked, "labels", dep_labels.get(dep["id"], []))
                linked["dependency_type"] = dep["dep_type"]
                dependencies.append(linked)
            _put(item, "dependencies", dependencies)

            parent = next((d["id"] for d in dep_rows if d["dep_type"] == "parent-child"), None)
            _put(item, "parent", parent)

            # Every edge type, not just 'blocks' — see the docstring.
            item["dependent_count"] = int(
                await conn.fetchval("SELECT count(*) FROM deps WHERE depends_on_id = $1", row["id"])
            )
            item["dependency_count"] = int(
                await conn.fetchval("SELECT count(*) FROM deps WHERE issue_id = $1", row["id"])
            )
            n_comments = int(await conn.fetchval("SELECT count(*) FROM comments WHERE issue_id = $1", row["id"]))
            item["comment_count"] = n_comments
            if n_comments:
                item["comments_omitted"] = True

        return Issue.model_validate(item)

    async def blocked(self, params: BlockedParams | None = None) -> list[BlockedIssue]:
        """``bd blocked``: open or in-progress issues with at least one live blocker.

        Straight off the ``blocked_issues`` view, whose blocker set is the parity-locked
        one — a dangling ``depends_on_id`` does not block, and a closed blocker does not
        either.
        """
        params = params or BlockedParams()
        pool = await get_pool()
        async with pool.acquire() as conn:
            await self._assert_board(conn)

            where = ["i.board_id = $1"]
            args: list[Any] = [self.board_id]
            if params.parent_id:
                args.append(await self._descendants(conn, params.parent_id))
                where.append(f"i.id = ANY(${len(args)}::text[])")

            rows = await conn.fetch(
                f"SELECT {ISSUE_COLUMNS_I}, i.blocked_by_count, i.blocked_by FROM blocked_issues i "
                f"WHERE {' AND '.join(where)} "
                "ORDER BY i.priority ASC, i.created_at DESC, i.id ASC",
                *args,
            )
            labels = await self._labels_for(conn, [r["id"] for r in rows])
            blockers_of: dict[str, list[str]] = {}
            for row in rows:
                raw = row["blocked_by"]
                if isinstance(raw, str):
                    raw = json.loads(raw)
                blockers_of[str(row["id"])] = [str(b["id"]) for b in (raw or [])]
            # Accounts mode: a blocker on a board the caller cannot read is not named
            # (the same no-leak rule show() applies to dependency edges). The count
            # still counts it, as show()/list() counts do: the item is blocked either way.
            readable = _accounts.readable_board_set()
            if readable is not None:
                ids = sorted({b for bs in blockers_of.values() for b in bs})
                held = {
                    str(r["id"]): str(r["board_id"])
                    for r in await conn.fetch("SELECT id, board_id FROM issues WHERE id = ANY($1::text[])", ids)
                }
                blockers_of = {k: [b for b in bs if held.get(b) in readable] for k, bs in blockers_of.items()}

        out: list[BlockedIssue] = []
        for row in rows:
            item = _bare_issue(row)
            _put(item, "labels", labels.get(row["id"], []))
            item["blocked_by_count"] = int(row["blocked_by_count"])
            item["blocked_by"] = blockers_of.get(str(row["id"]), [])
            out.append(BlockedIssue.model_validate(_sanitize_issue_deps(item)))
        return out

    async def list_comments(self, params: ListCommentsParams) -> list[Comment]:
        """``bd comments``: chronological, with the same tie-break bd uses (id ASC)."""
        pool = await get_pool()
        async with pool.acquire() as conn:
            await self._assert_board(conn)
            await self._require_issue_row(conn, params.issue_id)
            rows = await conn.fetch(
                "SELECT id, issue_id, author, body, created_at FROM comments "
                "WHERE issue_id = $1 ORDER BY created_at ASC, id ASC",
                params.issue_id,
            )

        out: list[Comment] = []
        for row in rows:
            item: dict[str, Any] = {
                "id": row["id"],
                "issue_id": row["issue_id"],
                "text": row["body"],
                "created_at": _ts(row["created_at"]),
            }
            _put(item, "author", row["author"])
            out.append(Comment.model_validate(item))
        return out

    async def stats(self) -> Stats:
        """``bd stats``, including the two fields bd never fills in.

        ``ready_issues`` here is ``open − blocked`` and **not** a count of the ready
        view: that is what ``GetStatisticsInTx`` computes, and the two disagree whenever
        an issue is open with a dangling blocker. ``epics_eligible_for_closure`` and
        ``average_lead_time_hours`` are always ``0`` because bd's implementation never
        assigns them — mirrored rather than fixed, since a summary that suddenly grew a
        non-zero number would be a contract change dressed up as a bug fix. The
        ``epic_status`` view has the real answer when somebody wants it.
        """
        pool = await get_pool()
        async with pool.acquire() as conn:
            await self._assert_board(conn)
            counts = await conn.fetchrow(
                """
                SELECT count(*) AS total,
                       count(*) FILTER (WHERE status = 'open')        AS open,
                       count(*) FILTER (WHERE status = 'in_progress') AS in_progress,
                       count(*) FILTER (WHERE status = 'closed')      AS closed,
                       count(*) FILTER (WHERE status = 'deferred')    AS deferred
                  FROM issues WHERE board_id = $1 AND deleted_at IS NULL
                """,
                self.board_id,
            )
            blocked = int(
                await conn.fetchval(
                    """
                    SELECT count(*) FROM issues i
                      JOIN open_blocker_counts o ON o.issue_id = i.id
                     WHERE i.board_id = $1 AND i.deleted_at IS NULL AND i.status <> 'closed'
                    """,
                    self.board_id,
                )
            )

        open_issues = int(counts["open"])
        return Stats.model_validate(
            {
                "summary": {
                    "total_issues": int(counts["total"]),
                    "open_issues": open_issues,
                    "in_progress_issues": int(counts["in_progress"]),
                    "closed_issues": int(counts["closed"]),
                    "deferred_issues": int(counts["deferred"]),
                    "blocked_issues": blocked,
                    "ready_issues": max(0, open_issues - blocked),
                    "pinned_issues": 0,
                    "epics_eligible_for_closure": 0,
                    "average_lead_time_hours": 0,
                }
            }
        )

    # -- writes -------------------------------------------------------------

    async def create(self, params: CreateIssueParams) -> Issue:
        """Mint an issue, its labels and its declared dependencies, in one transaction.

        The id is ``<board prefix>-<3 base36 chars>``, minted and retried on collision
        against the real unique constraint rather than a pre-check — two servers minting
        at once is exactly the case a pre-check loses.

        ``owner`` is stamped with the same actor as ``created_by``, which is a
        deliberate *change* from bd rather than a reproduction of it. bd fills owner
        from ``git config user.email`` — the identity of whoever's checkout the server
        process happens to run in, not of the agent making the call — and that leakage
        is not hypothetical: it is how rows attributed to "alex" ended up on a
        board where no human had filed anything. One verified actor on both columns is
        the whole point of resolving identity per call; see :meth:`_acting_actor`.
        """
        actor = self._acting_actor()
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            prefix = await self._board_prefix(conn)
            issue_id = await self._mint_id(conn, prefix, params)

            # The workspace binding goes into `metadata` at insert time, the same object
            # the artifact layer patches later — the same keys, defaults and normalisation
            # as the bd client's `--metadata`, so an epic reads back identically from
            # either store.
            binding = create_binding(
                params.issue_type,
                workspace_dir=params.workspace_dir,
                session_id=params.session_id,
                host=params.host,
                workspace_root=self.workspace_root,
            )
            await conn.execute(
                """
                INSERT INTO issues (id, board_id, title, description, design,
                    acceptance_criteria, external_ref, status, issue_type, priority,
                    assignee, created_by, owner, metadata, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$11,$12::jsonb, now(), now())
                """,
                issue_id,
                self.board_id,
                params.title,
                params.description or None,
                params.design,
                params.acceptance,
                params.external_ref,
                params.issue_type,
                params.priority,
                params.assignee or actor or None,
                actor or None,
                json.dumps(binding, separators=(",", ":")),
            )
            for label in params.labels:
                await conn.execute(
                    "INSERT INTO labels (issue_id, label) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                    issue_id,
                    label,
                )
            for spec in params.deps:
                dep_type, target, swap = _parse_dep_spec(spec)
                if not await conn.fetchval("SELECT 1 FROM issues WHERE id = $1 AND deleted_at IS NULL", target):
                    # bd refuses too — but only after it has already committed the
                    # issue, leaving a bead behind that the caller was told failed to
                    # be created. Here the whole create is one transaction, so a bad
                    # dep spec leaves nothing behind.
                    stderr = f"adding dependency {issue_id} -> {target}: issue {target} not found"
                    raise BdCommandError(f"bd command failed: {stderr}\n", stderr=f"{stderr}\n", returncode=1)
                a, b = (target, issue_id) if swap else (issue_id, target)
                await conn.execute(
                    "INSERT INTO deps (issue_id, depends_on_id, dep_type, created_at, created_by) "
                    "VALUES ($1, $2, $3, now(), $4) ON CONFLICT DO NOTHING",
                    a,
                    b,
                    dep_type,
                    actor or None,
                )
            await self._emit(conn, issue_id, "created", actor, {"title": params.title})
            row = await self._require_issue_row(conn, issue_id, "resolve")
            item = _bare_issue(row)
            _put(item, "labels", sorted(params.labels))

        return Issue.model_validate(item)

    async def _mint_id(self, conn: Any, prefix: str, params: CreateIssueParams) -> str:
        if params.id:
            taken = await conn.fetchval("SELECT 1 FROM issues WHERE id = $1", params.id)
            if taken:
                raise BdCommandError(
                    f"bd command failed: issue {params.id} already exists",
                    stderr=f"issue {params.id} already exists",
                    returncode=1,
                )
            return params.id

        for _ in range(_ID_ATTEMPTS):
            suffix = _base36(random.randrange(_ID_SPACE)).rjust(3, "0")
            candidate = f"{prefix}-{suffix}"
            if not await conn.fetchval("SELECT 1 FROM issues WHERE id = $1", candidate):
                return candidate
        raise BdError(f"could not mint a free id for board {self.board_id} after {_ID_ATTEMPTS} attempts")

    async def update(self, params: UpdateIssueParams) -> Issue:
        """Apply the named fields, and only the named fields.

        ``updated_at`` moves on every mutation; ``started_at`` is stamped the first time
        a bead reaches ``in_progress`` and never re-stamped. A status change reports
        itself as a ``status`` event rather than an ``updated`` one, matching what the
        dashboard emits for the same transition.

        ``labels`` is a replace-the-set write rather than a column, so it is a
        delete-then-insert against the ``labels`` table — in *this* transaction, with the
        rest of the fields, so a half-relabelled bead is never visible and never
        announced. It still counts as a mutation on its own: ``updated_at`` moves and the
        ``updated`` event names ``labels`` among its changed fields, because a relabel
        nobody was told about is a relabel the dashboard keeps showing the old version of.
        """
        actor = self._acting_actor()
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await self._assert_board(conn)
            row = await self._require_issue_row(conn, params.issue_id, "resolve")

            if params.assignee is not None:
                _assert_not_stolen(params.issue_id, row, actor, params.assignee)

            sets = ["updated_at = now()"]
            args: list[Any] = [params.issue_id]

            def arg(value: Any) -> str:
                args.append(value)
                return f"${len(args)}"

            fields: list[tuple[str, Any]] = [
                ("status", params.status),
                ("priority", params.priority),
                ("assignee", params.assignee),
                ("title", params.title),
                ("description", params.description),
                ("design", params.design),
                ("acceptance_criteria", params.acceptance_criteria),
                ("notes", params.notes),
                ("external_ref", params.external_ref),
            ]
            changed: dict[str, Any] = {}
            for column, value in fields:
                if value is None:
                    continue
                sets.append(f"{column} = {arg(value)}")
                changed[column] = value

            if params.status == "in_progress":
                sets.append("started_at = COALESCE(started_at, now())")
            if params.status == "closed":
                sets.append("closed_at = COALESCE(closed_at, now())")
            elif params.status is not None:
                sets.append("closed_at = NULL")

            # Normalised once, then used for both the writes and the event, so the payload
            # the dashboard reads cannot describe a different set from the one stored.
            new_labels = None if params.labels is None else sorted(set(params.labels))
            if new_labels is not None:
                changed["labels"] = new_labels

            # Metadata is a top-level patch, never a replacement. Null-valued keys
            # are deletions; non-null values (including nested objects such as effort)
            # are merged as JSON. Workspace bindings use the same expression so the
            # whole update remains one transaction.
            binding = binding_metadata(
                workspace_dir=params.workspace_dir,
                session_id=params.session_id,
                host=params.host,
            )
            metadata_patch = params.metadata
            if metadata_patch is not None or binding:
                values = {key: value for key, value in (metadata_patch or {}).items() if value is not None}
                values.update(binding)
                deletes = [
                    key for key, value in (metadata_patch or {}).items() if value is None and key not in binding
                ]
                if deletes and values:
                    expression = (
                        f"(metadata - {arg(deletes)}::text[]) || "
                        f"{arg(json.dumps(values, separators=(',', ':')))}::jsonb"
                    )
                elif deletes:
                    expression = f"metadata - {arg(deletes)}::text[]"
                else:
                    expression = f"metadata || {arg(json.dumps(values, separators=(',', ':')))}::jsonb"
                sets.append(f"metadata = {expression}")
                changed.update(values)
                changed.update(dict.fromkeys(deletes))

            await conn.execute(
                f"UPDATE issues SET {', '.join(sets)} WHERE id = $1",
                *args,
            )
            if new_labels is not None:
                await conn.execute("DELETE FROM labels WHERE issue_id = $1", params.issue_id)
                for label in new_labels:
                    await conn.execute(
                        "INSERT INTO labels (issue_id, label) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                        params.issue_id,
                        label,
                    )
            kind = "status" if params.status is not None else "updated"
            await self._emit(conn, params.issue_id, kind, actor, changed)
            fresh = await self._require_issue_row(conn, params.issue_id, "resolve")
            labels = await self._labels_for(conn, [params.issue_id])

        item = _bare_issue(fresh)
        _put(item, "labels", labels.get(params.issue_id, []))
        return Issue.model_validate(item)

    async def claim(self, params: ClaimIssueParams) -> Issue:
        """Take the bead, or lose the race — never both.

        One conditional UPDATE does the whole transition (assignee, status, started_at,
        lease, heartbeat), and its WHERE clause *is* the compare-and-swap: two agents
        claiming at once both run it, exactly one matches a row, and the loser learns it
        lost from the row rather than from a re-read that could already be stale.

        The guard mirrors bd's: claimable means open, or already held by this same actor
        (a re-claim is idempotent — retry safety), or held by nobody. The two refusals
        are reported with bd's own message text, since ``bd update --claim`` is what the
        callers have been reading.
        """
        actor = self._acting_actor()
        aliases = _caller_aliases(actor)
        label = _accounts.session_label(_accounts.request_principal.get())
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await self._assert_board(conn)
            if label and await _has_claim_label(conn):
                # Accounts mode: one human, several sessions, one actor. A claim held
                # by *another* live session of the same user is a conflict, reported
                # with that session's label — never a silent ✓. `force` takes over
                # one's own other-session claim; it never touches another user's.
                updated = await conn.fetchrow(
                    f"""
                    UPDATE issues SET
                        assignee = $2,
                        claim_label = $6,
                        status = 'in_progress',
                        started_at = COALESCE(started_at, now()),
                        lease_expires_at = now() + $3::interval,
                        heartbeat_at = now(),
                        updated_at = now()
                     WHERE id = $1
                       AND board_id = $4
                       AND deleted_at IS NULL
                       AND status IN ('open', 'in_progress')
                       AND (assignee IS NULL OR assignee = ''
                            OR (assignee = ANY($5::text[])
                                AND ($7 OR claim_label IS NULL OR claim_label = '' OR claim_label = $6
                                     OR lease_expires_at IS NULL OR lease_expires_at < now())))
                    RETURNING {ISSUE_COLUMNS}
                    """,
                    params.issue_id,
                    actor,
                    CLAIM_LEASE,
                    self.board_id,
                    aliases,
                    label,
                    bool(params.force),
                )
            else:
                updated = await conn.fetchrow(
                    f"""
                    UPDATE issues SET
                        assignee = $2,
                        status = 'in_progress',
                        started_at = COALESCE(started_at, now()),
                        lease_expires_at = now() + $3::interval,
                        heartbeat_at = now(),
                        updated_at = now()
                     WHERE id = $1
                       AND board_id = $4
                       AND deleted_at IS NULL
                       AND status IN ('open', 'in_progress')
                       AND (assignee IS NULL OR assignee = '' OR assignee = ANY($5::text[]))
                    RETURNING {ISSUE_COLUMNS}
                    """,
                    params.issue_id,
                    actor,
                    CLAIM_LEASE,
                    self.board_id,
                    aliases,
                )
            if updated is None:
                raise await self._claim_conflict(conn, params.issue_id, aliases)
            await self._emit(conn, params.issue_id, "claimed", actor, {"assignee": actor})
            labels = await self._labels_for(conn, [params.issue_id])

        item = _bare_issue(updated)
        _put(item, "labels", labels.get(params.issue_id, []))
        return Issue.model_validate(item)

    async def _claim_conflict(self, conn: Any, issue_id: str, aliases: list[str] | None = None) -> BdError:
        """Why the CAS matched nothing, in bd's wording.

        Read *after* the failed UPDATE rather than before it: a pre-check would be a
        TOCTOU window, and this read only has to explain a decision that has already
        been made.
        """
        row = await self._fetch_issue_row(conn, issue_id)
        if row is None:
            return _not_found(issue_id, "resolve")
        if row["status"] not in ("open", "in_progress"):
            detail = f"issue not claimable: status {row['status']}"
        elif aliases and (row["assignee"] or "") in aliases:
            held_by = (
                await conn.fetchval("SELECT claim_label FROM issues WHERE id = $1", issue_id)
                if await _has_claim_label(conn)
                else ""
            )
            detail = (
                f"issue already claimed by {row['assignee']} "
                f"(another of your own credentials: {held_by or 'unknown'}) "
                "— coordinate; force=true only if that session is gone"
            )
        else:
            detail = f"issue already claimed by {row['assignee']}"
        stderr = (
            f"Error claiming {issue_id}: {detail}\n"
            + json.dumps(
                {
                    "error": "1 of 1 issues failed to update",
                    "failed": [{"id": issue_id, "error": f"claiming issue: {detail}"}],
                    "schema_version": 1,
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        return BdCommandError(f"bd command failed: {stderr}", stderr=stderr, returncode=1)

    async def close(self, params: CloseIssueParams) -> list[Issue]:
        """Close one issue, stamping ``closed_at`` and ``close_reason``.

        bd refuses to close a bead assigned to somebody else (validation.AssigneeMatches
        — the guard that stopped actor A silently closing work actor B had re-claimed),
        and so does this. ``force`` mirrors bd's ``--force`` for this guard only; the
        caller is still the actor recorded in the audit event.
        """
        actor = self._acting_actor()
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await self._assert_board(conn)
            row = await self._require_issue_row(conn, params.issue_id, "close")
            assignee = row["assignee"] or ""
            if assignee and assignee not in _caller_aliases(actor) and not params.force:
                stderr = (
                    f"cannot close {params.issue_id}: assignee is {_q(assignee)}, "
                    f"actor is {_q(actor)}; reclaim or use --force to override\n"
                )
                raise BdCommandError(f"bd command failed: {stderr}", stderr=stderr, returncode=1)

            close_sets = [
                "status = 'closed'",
                "closed_at = now()",
                "close_reason = $2",
                "updated_at = now()",
                "lease_expires_at = NULL",
                "heartbeat_at = NULL",
            ]
            close_args: list[Any] = [params.issue_id, params.reason]
            if params.metadata is not None:
                values = {key: value for key, value in params.metadata.items() if value is not None}
                deletes = [key for key, value in params.metadata.items() if value is None]
                if deletes and values:
                    close_args.extend([deletes, json.dumps(values)])
                    close_sets.append(
                        f"metadata = (metadata - ${len(close_args) - 1}::text[]) || ${len(close_args)}::jsonb"
                    )
                elif deletes:
                    close_args.append(deletes)
                    close_sets.append(f"metadata = metadata - ${len(close_args)}::text[]")
                else:
                    close_args.append(json.dumps(values))
                    close_sets.append(f"metadata = metadata || ${len(close_args)}::jsonb")
            closed = await conn.fetchrow(
                f"""
                UPDATE issues SET {", ".join(close_sets)}
                 WHERE id = $1 RETURNING {ISSUE_COLUMNS}
                """,
                *close_args,
            )
            await self._emit(
                conn,
                params.issue_id,
                "status",
                actor,
                {
                    "status": "closed",
                    "close_reason": params.reason,
                    **({"metadata": params.metadata} if params.metadata is not None else {}),
                },
            )
            labels = await self._labels_for(conn, [params.issue_id])

        item = _bare_issue(closed)
        _put(item, "labels", labels.get(params.issue_id, []))
        return [Issue.model_validate(item)]

    async def reopen(self, params: ReopenIssueParams) -> list[Issue]:
        """Reopen closed issues, clearing ``closed_at`` and the close reason.

        An id that is already open is skipped, exactly as bd skips it — and when *every*
        id was skipped bd prints nothing at all, which the CLI client then reports as an
        invalid response. That is a strange contract, but it is the one callers have, so
        it is reproduced rather than improved.
        """
        actor = self._acting_actor()
        pool = await get_pool()
        reopened: list[dict[str, Any]] = []
        async with pool.acquire() as conn, conn.transaction():
            await self._assert_board(conn)
            for issue_id in params.issue_ids:
                row = await conn.fetchrow(
                    f"""
                    UPDATE issues SET status = 'open', closed_at = NULL, close_reason = NULL,
                                      updated_at = now()
                     WHERE id = $1 AND board_id = $2 AND deleted_at IS NULL AND status = 'closed'
                    RETURNING {ISSUE_COLUMNS}
                    """,
                    issue_id,
                    self.board_id,
                )
                if row is None:
                    continue
                await self._emit(
                    conn,
                    issue_id,
                    "status",
                    actor,
                    {"status": "open", "reason": params.reason} if params.reason else {"status": "open"},
                )
                item = _bare_issue(row)
                labels = await self._labels_for(conn, [issue_id])
                _put(item, "labels", labels.get(issue_id, []))
                reopened.append(item)

        if not reopened:
            raise BdCommandError(f"Invalid response for reopen {params.issue_ids}")
        return [Issue.model_validate(item) for item in reopened]

    async def add_dependency(self, params: AddDependencyParams) -> None:
        """Draw an edge, and touch both ends so the dashboard's delta notices."""
        actor = self._acting_actor()
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await self._assert_board(conn)
            await self._require_issue_row(conn, params.issue_id, "dep")
            target = await conn.fetchval(
                "SELECT 1 FROM issues WHERE id = $1 AND deleted_at IS NULL", params.depends_on_id
            )
            if not target:
                raise _not_found(params.depends_on_id, "dep_target")

            await conn.execute(
                "INSERT INTO deps (issue_id, depends_on_id, dep_type, created_at, created_by) "
                "VALUES ($1, $2, $3, now(), $4) ON CONFLICT (issue_id, depends_on_id, dep_type) DO NOTHING",
                params.issue_id,
                params.depends_on_id,
                params.dep_type,
                actor or None,
            )
            await conn.execute(
                "UPDATE issues SET updated_at = now() WHERE id = ANY($1::text[])",
                [params.issue_id, params.depends_on_id],
            )
            await self._emit(
                conn,
                params.issue_id,
                "dep_added",
                actor,
                {"depends_on_id": params.depends_on_id, "dep_type": params.dep_type},
            )

    async def remove_dependency(self, params: RemoveDependencyParams) -> None:
        """Erase an edge, whatever its type, and touch both ends.

        The mirror of :meth:`add_dependency` down to the pair of ``updated_at`` bumps,
        because the dashboard's delta subscription is what tells an open browser the
        graph changed. Deleting an edge that is not there is not an error: bd's
        ``dep remove`` is idempotent, the ``ON CONFLICT DO NOTHING`` on the insert side
        makes adding one idempotent too, and a retry after a dropped connection should
        not fail differently from the call it is retrying. The event still fires with
        the row count so an auditor can tell a real removal from a no-op.
        """
        actor = self._acting_actor()
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await self._assert_board(conn)
            await self._require_issue_row(conn, params.issue_id, "dep_remove")
            status = await conn.execute(
                "DELETE FROM deps WHERE issue_id = $1 AND depends_on_id = $2",
                params.issue_id,
                params.depends_on_id,
            )
            removed = int(str(status).rsplit(" ", 1)[-1] or 0)
            # The other end is touched only when an edge to it was actually removed:
            # under accounts mode the caller is authorized on ``issue_id`` alone (it may
            # drop a legacy edge into a space it cannot see), and a no-op must not let
            # it bump an arbitrary issue anywhere just by naming it.
            await conn.execute(
                "UPDATE issues SET updated_at = now() WHERE id = ANY($1::text[])",
                [params.issue_id, params.depends_on_id] if removed else [params.issue_id],
            )
            await self._emit(
                conn,
                params.issue_id,
                "dep_removed",
                actor,
                {"depends_on_id": params.depends_on_id, "removed": removed},
            )

    async def add_comment(self, params: AddCommentParams) -> str:
        """Append a comment, attributed to the acting agent.

        The issue's ``updated_at`` moves with it. bd leaves it alone; the dashboard's
        delta subscription is computed from ``updated_at``, so a comment that did not
        move it would leave every other open browser rendering a stale
        ``comment_count`` — ui/server/pg-store.js bumps it for that reason and this
        matches, because the two writers share one table.
        """
        import uuid

        actor = self._acting_actor()
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await self._assert_board(conn)
            await self._require_issue_row(conn, params.issue_id, "comment")
            await conn.execute(
                "INSERT INTO comments (id, issue_id, author, body, created_at) VALUES ($1, $2, $3, $4, now())",
                str(uuid.uuid4()),
                params.issue_id,
                actor or None,
                params.text,
            )
            await conn.execute("UPDATE issues SET updated_at = now() WHERE id = $1", params.issue_id)
            await self._emit(conn, params.issue_id, "comment", actor)
        return f"Added comment to {params.issue_id}"

    async def add_note(self, params: AddNoteParams) -> str:
        """Append to the notes field, newline-separated — what ``bd note`` does."""
        actor = self._acting_actor()
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await self._assert_board(conn)
            await self._require_issue_row(conn, params.issue_id, "note")
            await conn.execute(
                """
                UPDATE issues
                   SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $2
                                    ELSE notes || E'\\n' || $2 END,
                       updated_at = now()
                 WHERE id = $1
                """,
                params.issue_id,
                params.text,
            )
            await self._emit(conn, params.issue_id, "updated", actor, {"field": "notes"})
        return f"Appended note to {params.issue_id}"

    # -- issue metadata ------------------------------------------------------
    # bd exposes metadata through `bd show` and `bd update --metadata`, and the
    # artifact layer is its only caller here. These stay *generic* — a key/value
    # patch, a key scan — rather than growing artifact vocabulary, because what
    # they are really for is keeping the one invariant this module owns: a write
    # lands with its events row and its NOTIFY, in one transaction, always.

    async def read_issue(self, issue_id: str) -> dict[str, Any]:
        """One issue in bd's bare wire shape, ``metadata`` included.

        Not :meth:`show`: that hydrates dependencies and validates into an ``Issue``,
        which drops metadata entirely. A caller that wants metadata wants the dict.
        """
        pool = await get_pool()
        async with pool.acquire() as conn:
            await self._assert_board(conn)
            row = await self._require_issue_row(conn, issue_id, "resolve")
        return _bare_issue(row)

    async def issues_with_metadata_key(self, key: str, include_closed: bool = False) -> list[dict[str, Any]]:
        """Every live issue on this board whose metadata carries ``key``.

        The pg spelling of ``bd list --limit 0 --has-metadata-key <key>``: no row cap
        (bd's default 50 would silently answer "nothing here" on a busy board) and
        closed issues excluded unless asked for, which is ``bd list``'s own default.
        """
        pool = await get_pool()
        async with pool.acquire() as conn:
            await self._assert_board(conn)
            where = ["board_id = $1", "deleted_at IS NULL", "metadata ? $2"]
            if not include_closed:
                where.append("status <> 'closed'")
            rows = await conn.fetch(
                f"SELECT {ISSUE_COLUMNS} FROM issues WHERE {' AND '.join(where)} ORDER BY id",
                self.board_id,
                key,
            )
        return [_bare_issue(row) for row in rows]

    async def patch_metadata(self, issue_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        """Merge a top-level patch into one issue's metadata, and announce it.

        ``||`` is a shallow merge, which is what ``bd update --metadata`` does — and a
        ``null`` in the patch is *stored* as a JSON null rather than removing the key,
        which is also bd's behaviour and which the artifact layer depends on (its keys
        contain characters bd's ``--unset-metadata`` validator rejects, so a released
        artifact is a null value, not an absent key).

        Reported as an ``updated`` event, the same kind :meth:`update` emits for a
        non-status field change: to every consumer of the stream this *is* a field
        change, and a private kind would make it invisible to readers that already
        know what "updated" means.
        """
        actor = self._acting_actor()
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await self._assert_board(conn)
            await self._require_issue_row(conn, issue_id, "resolve")
            merged = await conn.fetchval(
                "UPDATE issues SET metadata = metadata || $2::jsonb, updated_at = now() "
                "WHERE id = $1 RETURNING metadata",
                issue_id,
                json.dumps(patch),
            )
            await self._emit(
                conn,
                issue_id,
                "updated",
                actor,
                {"field": "metadata", "keys": sorted(patch)},
            )
        return dict(_metadata(merged) or {})

    # -- delegated to the CLI (the Dolt board still owns these questions) ----

    async def quickstart(self) -> str:
        """The guide, which bd prints from its own binary and not from any board.

        Delegated rather than refused for that reason: it reads no issue data, so it
        cannot answer from the wrong database. It is the only survivor of this section.
        """
        return await self._bd().quickstart()

    async def init(self, params: InitParams | None = None) -> str:
        """Create a board on disk — something no database can do for itself.

        Reached only by a caller holding a client built for a boardless path; the tools
        layer sends ``init`` to the CLI directly (``_get_client(allow_boardless=True)``).
        Registering the *result* in this store is the caller's next step, not this one's:
        see :func:`ensure_board`.
        """
        return await self._bd().init(params)

    # -- refused in pg mode --------------------------------------------------
    # These five inspect and repair a bd database: schema versions, migration plans,
    # orphaned dependency rows, "test pollution". In pg mode the Dolt board is a
    # frozen archive — nothing writes to it — so running them would answer questions
    # about live data by examining a snapshot, and `--fix` / `--clean` would *repair*
    # the snapshot while the real rows kept their problem. Both failures are silent
    # and both look like the tool worked. A refusal that names the archive is the
    # only honest answer; an operator who genuinely means the archive can still point
    # a bd-mode server at it.

    async def inspect_migration(self) -> dict[str, Any]:
        raise _archive_only("admin(action='migration')")

    async def get_schema_info(self) -> dict[str, Any]:
        raise _archive_only("admin(action='schema')")

    async def repair_deps(self, fix: bool = False) -> dict[str, Any]:
        raise _archive_only("admin(action='repair')")

    async def detect_pollution(self, clean: bool = False) -> dict[str, Any]:
        raise _archive_only("admin(action='pollution')")

    async def validate(self, checks: str | None = None, fix_all: bool = False) -> dict[str, Any]:
        raise _archive_only("admin(action='validate')")


def _archive_only(what: str) -> BdError:
    """The refusal a bd-database diagnostic gets while Postgres is the live store."""
    return BdError(
        f"{what} is not available in pg mode; the Dolt board is an archive — "
        "run against a bd workspace explicitly if you mean the archive.\n"
        "  These checks read and repair a bd database. With FEADS_PG_DSN set, issue "
        "data lives in Postgres and nothing writes the Dolt board, so an answer from "
        "it would describe a snapshot, and a --fix would repair the snapshot while "
        "the live rows kept the problem.\n"
        "  To inspect the archive: run a server (or `bd`) with FEADS_PG_DSN unset "
        "against that .beads directory."
    )


# =============================================================================
# Board registration
# =============================================================================


def normalize_issue_prefix(raw: str) -> str:
    """bd's own ``normalizeIssuePrefix`` (cmd/bd/init.go), transliterated.

    Strips leading dots and trailing hyphens, turns remaining dots into underscores,
    and prefixes ``bd_`` when the result would not start with a letter or underscore
    (directory names like ``001`` are common). Reproduced rather than approximated
    because the prefix recorded here is the one this store mints ids with, and an id
    minted with a different prefix than the board's own is a bead nobody can find.
    """
    prefix = str(raw or "").lstrip(".").rstrip("-").replace(".", "_")
    if prefix and not (prefix[0].isascii() and (prefix[0].isalpha() or prefix[0] == "_")):
        prefix = "bd_" + prefix
    return prefix


def default_prefix_for_workspace(workspace_root: str) -> str:
    """What ``bd init`` would have chosen for a directory, given no ``--prefix``.

    bd's precedence is flag, then ``issue-prefix`` from config, then the basename of
    the working directory (all normalized). Only the last step is guessed here — the
    flag is passed in by the caller when it has one, and a fresh board has no config
    file yet, which is the case this exists for.
    """
    return normalize_issue_prefix(os.path.basename(os.path.normpath(workspace_root)))


async def ensure_board(board_id: str, prefix: str) -> dict[str, Any]:
    """Give a newly created board a row in this store, if it has none.

    Called after ``bd init`` (via ``context(action='init')`` or ``board_create``) so
    the very next issue tool has somewhere to write. Without it a board exists on disk
    and in the registry but not here, and the first ``create`` fails with
    ``_board_prefix``'s "not in the feads Postgres store" — correct, but a dead end for
    an agent that just made the board.

    Deliberately **not** called for ``board_register``: that adopts a board whose issues
    are already in Dolt and not here, and giving it an empty row would turn a loud "this
    board is not in the store" into a quiet "this board has no issues". Only a board
    this server just created empty is safe to declare empty.

    Existing rows are left alone (``DO NOTHING``, not ``DO UPDATE``): re-pointing a live
    board's prefix would strand every id already minted under the old one. A prefix
    already taken by another board is reported, not raised — the board itself was
    created successfully, and failing the call afterwards would misdescribe what
    happened.
    """
    # Board registration is itself a database write. Base mode keeps its
    # existing behaviour; a silo may not write without verified attribution.
    if silo_configured():
        # Board registration is a mutation too: it must consume the same
        # authorized context as the tool that initiated it.
        mutation_actor()

    result: dict[str, Any] = {"board_id": board_id, "prefix": prefix, "created": False}
    if not board_id or not prefix:
        result["error"] = "cannot register a board in the Postgres store without both an id and a prefix"
        return result

    pool = await get_pool()
    async with pool.acquire() as conn:
        existing = await conn.fetchval("SELECT prefix FROM boards WHERE id = $1", board_id)
        if existing is not None:
            result["prefix"] = str(existing)
            result["existing"] = True
            return result
        try:
            await conn.execute("INSERT INTO boards (id, prefix) VALUES ($1, $2)", board_id, prefix)
        except Exception as exc:  # asyncpg raises UniqueViolationError for a taken prefix
            result["error"] = (
                f"could not register board {board_id!r} with prefix {prefix!r} in the Postgres "
                f"store: {exc}. The board exists on disk; issue tools will refuse it until a "
                "row is added by hand (INSERT INTO boards)."
            )
            return result
    result["created"] = True
    return result


def _q(value: str) -> str:
    """Go's ``%q``, which is what bd's refusal messages quote identifiers with.

    ``json.dumps`` and Go's ``%q`` agree on the cases that occur here (double quotes,
    backslash escapes); Python's own ``!r`` does not, and would put single quotes
    around an actor name the previous message spelled with double ones.
    """
    return json.dumps(value)


def _not_found(issue_id: str, miss: str) -> BdCommandError:
    """The "no such issue" failure, worded the way the named bd subcommand words it.

    Captured from bd 1.1.0 rather than invented. The trailing newline is part of it:
    ``BdCliClient`` interpolates the child's stderr verbatim, so bd's messages reach an
    agent with it attached, and a message that differs only by whitespace is still a
    message that differs.

    ``close`` is the one entry that is *not* a transcription. bd writes its close-miss
    to stdout as JSON and leaves stderr empty, so the CLI path surfaces the literal
    string ``"bd command failed: "`` with nothing after it. Reproducing an empty error
    message would be parity with a bug that no caller can be relying on, so the wording
    from bd's own JSON body is used instead.
    """
    detail = f'no issue found matching "{issue_id}"'
    variants = {
        # bd show <id> --json
        "fetch": ("bd command failed", f"Error fetching {issue_id}: {detail}\n"),
        # bd update <id> ... --json (also the --claim path)
        "resolve": (
            "bd command failed",
            f"Error resolving {issue_id}: {detail}\n"
            + json.dumps(
                {
                    "error": "1 of 1 issues failed to update",
                    "failed": [{"id": issue_id, "error": f"resolving issue: {detail}"}],
                    "schema_version": 1,
                },
                separators=(",", ":"),
            )
            + "\n",
        ),
        "close": ("bd command failed", f"resolving ID {issue_id}: {detail}\n"),
        "comment": ("bd comment failed", f"Error: resolving {issue_id}: {detail}\n"),
        "note": ("bd note failed", f"Error: resolving {issue_id}: {detail}\n"),
        "dep": ("bd dep add failed", f"Error: resolving issue ID {issue_id}: {detail}\n"),
        "dep_target": (
            "bd dep add failed",
            f"Error: resolving dependency ID {issue_id}: resolving issue ID {issue_id}: {detail}\n",
        ),
    }
    prefix, stderr = variants[miss]
    return BdCommandError(f"{prefix}: {stderr}", stderr=stderr, returncode=1)


def _assert_not_stolen(issue_id: str, row: Any, actor: str, new_assignee: str) -> None:
    """bd's ``validation.AssigneeNotStolen``, minus the claim-pool carve-out.

    Refuses a plain reassignment that would take a live (``in_progress``) claim off
    somebody else. Pool aliases are a bd config value with no column in this schema, so
    a board using them would see this refuse where bd allowed — noted rather than
    guessed at.
    """
    held = row["assignee"] or ""
    if not held or held in (actor, new_assignee) or held in _caller_aliases(actor):
        return
    if row["status"] != "in_progress":
        return
    stderr = (
        f"cannot reassign {issue_id}: held by {_q(held)} (in_progress); coordinate with the holder "
        f"(bd mail {held}) — pass --force only if their claim is abandoned (crashed agent, "
        "expired lease), or use bd reclaim\n"
    )
    raise BdCommandError(f"bd command failed: {stderr}", stderr=stderr, returncode=1)


def _parse_dep_spec(raw: str) -> tuple[str, str, bool]:
    """One entry of ``create(deps=[...])``, as ``(dep_type, target_id, swap_direction)``.

    Transliterated from ``parseDepSpec`` in cmd/bd/create_deps.go, including the one
    rule that is counter-intuitive enough to get wrong by reading the parameter name:
    ``blocks:X`` **reverses** the edge. Bare ``X``, ``depends-on:X`` and ``blocked-by:X``
    all mean "the new issue depends on X"; ``blocks:X`` means "X depends on the new
    issue". Anything else is a literal dependency type pointing at X.

    The split is on the *first* colon (Go's ``SplitN(raw, ":", 2)``), not the last.
    """
    raw = raw.strip()
    head, sep, tail = raw.partition(":")
    if not sep:
        return "blocks", raw, False
    dep_type = head.strip()
    target = tail.strip()
    if dep_type in ("depends-on", "blocked-by"):
        return "blocks", target, False
    if dep_type == "blocks":
        return "blocks", target, True
    return dep_type, target, False


def _base36(value: int) -> str:
    """Lowercase base36, the alphabet bd's ids use."""
    if value == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while value:
        value, rem = divmod(value, 36)
        out = digits[rem] + out
    return out


# =============================================================================
# Accounts mode: aliases and claim labels (the excluded hosted-provider design)
# =============================================================================


async def _drop_unreadable_edges(conn: Any, rows: list[Any], other_key: str) -> list[Any]:
    """Accounts mode: drop dependency edges whose other end is on a board the caller
    cannot read. Dangling edges (no such issue) are kept — bd's parity, and they name
    nothing. Off → unchanged."""
    readable = _accounts.readable_board_set()
    if readable is None or not rows:
        return rows
    others = sorted({str(r[other_key]) for r in rows})
    boards = {
        str(r["id"]): str(r["board_id"])
        for r in await conn.fetch("SELECT id, board_id FROM issues WHERE id = ANY($1::text[])", others)
    }
    return [r for r in rows if boards.get(str(r[other_key])) is None or boards[str(r[other_key])] in readable]


_claim_label_column: bool | None = None


async def _has_claim_label(conn: Any) -> bool:
    """Whether ``issues.claim_label`` exists (pgstore/migrations/0001-claim-label.sql).

    Probed once per process. Absent → the claim CAS degrades to the pre-accounts
    actor check rather than failing every claim before the migration is applied.
    """
    global _claim_label_column
    if _claim_label_column is None:
        found = await conn.fetchval(
            "SELECT 1 FROM information_schema.columns WHERE table_name = 'issues' AND column_name = 'claim_label'"
        )
        _claim_label_column = bool(found)
        if not _claim_label_column:
            logger.warning("issues.claim_label is missing; same-user session claim detection is off")
    return _claim_label_column


def _caller_aliases(actor: str) -> list[str]:
    """Every actor that means the caller (the actor itself when accounts is off)."""
    aliases = _accounts.current_aliases()
    if actor and actor not in aliases:
        aliases = [actor, *aliases]
    return aliases or [actor]


def _alias_group(actor: str) -> list[str]:
    """An assignee filter value expanded to every alias of the user it names."""
    if not actor:
        return [actor]
    try:
        return _accounts.alias_group(actor)
    except Exception:  # noqa: BLE001 - a filter must never fail a read; fall back to exact
        return [actor]
