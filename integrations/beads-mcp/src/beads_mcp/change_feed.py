"""Shared Postgres change-feed query used by the hosted MCP surface."""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Any

from . import pgstore

MAX_PAGE_SIZE = 500
# MCP clients (mcp>=2 / httpx2) reject a single SSE event over 1 MiB, and
# FastMCP ships the result twice (content.text + structuredContent), so a page
# stops once its JSON nears half that; callers page on via next_cursor.
MAX_PAGE_BYTES = 400_000

# Snapshots are read in chunks of this many issues, in seq order, and reading stops
# once the page's byte budget is spent: a 500-issue request whose first ~150
# snapshots fill the budget costs ~150 snapshots, not 500 (FOLLOWUPS #9).
SNAPSHOT_CHUNK = 50

# The whole call — pool acquire, both queries, serialization — is bounded. A wedged
# connection now answers with an error the caller can retry instead of silence.
CHANGES_TIMEOUT_ENV = "FEADS_CHANGES_TIMEOUT_S"
DEFAULT_CHANGES_TIMEOUT_S = 30.0

# One change larger than the page budget would make an undeliverable page (an SSE
# event over 1 MiB) and pin every caller at that cursor. Such a change is shrunk:
# oldest comments first, then long text fields clipped, and marked `truncated`;
# `show`/`comments` still return it whole.
CLIPPED_FIELD_CHARS = 20_000
_CLIPPABLE_FIELDS = ("description", "design", "notes", "acceptance_criteria")


def changes_timeout() -> float:
    """Seconds the feed may take before it answers with a timeout error."""
    raw = os.environ.get(CHANGES_TIMEOUT_ENV, "").strip()
    try:
        value = float(raw) if raw else DEFAULT_CHANGES_TIMEOUT_S
    except ValueError:
        value = DEFAULT_CHANGES_TIMEOUT_S
    return value if value > 0 else DEFAULT_CHANGES_TIMEOUT_S


def _time_bound(value: str | None, name: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


# ``deleted_at`` is not part of ``_ISSUE_COLUMN_NAMES`` (every other read filters
# it out); the feed selects it explicitly so a deletion is visible as a change.
_SNAPSHOT_COLUMNS: tuple[str, ...] = (*pgstore._ISSUE_COLUMN_NAMES, "deleted_at")
_SNAPSHOT_COLUMNS_I = ", ".join(f"i.{c}" for c in _SNAPSHOT_COLUMNS)


def _fit_page(changes: list[dict[str, Any]], max_bytes: int = MAX_PAGE_BYTES) -> tuple[list[dict[str, Any]], bool]:
    """Keep the leading changes whose JSON fits in ``max_bytes`` (at least one).

    One event row per issue (DISTINCT ON) in seq order, so a prefix cut keeps
    the keyset cursor exact.
    """
    size = 0
    for index, change in enumerate(changes):
        size += len(json.dumps(change, default=str))
        if index and size > max_bytes:
            return changes[:index], True
    return changes, False


def _json_size(value: Any) -> int:
    return len(json.dumps(value, default=str))


def _shrink_change(change: dict[str, Any], max_bytes: int = MAX_PAGE_BYTES) -> dict[str, Any]:
    """Make one oversized change fit ``max_bytes``, saying what was left out.

    Keeps the newest comments that fit, then clips long text fields. A change that
    already fits is returned untouched (same object).
    """
    if _json_size(change) <= max_bytes:
        return change
    shrunk = dict(change)
    comments = list(change.get("comments") or [])
    shrunk["comments"] = []
    clipped: list[str] = []
    for name in _CLIPPABLE_FIELDS:
        text = shrunk.get(name)
        if isinstance(text, str) and len(text) > CLIPPED_FIELD_CHARS:
            shrunk[name] = text[:CLIPPED_FIELD_CHARS] + "\n…[clipped — call show() for the full text]"
            clipped.append(name)
    base = _json_size(shrunk) + 200  # room for the `truncated` marker
    kept: list[Any] = []
    for comment in reversed(comments):  # newest last in the snapshot order
        size = _json_size(comment) + 2
        if base + size > max_bytes:
            break
        kept.append(comment)
        base += size
    kept.reverse()
    shrunk["comments"] = kept
    shrunk["truncated"] = {
        "comments_omitted": len(comments) - len(kept),
        "fields_clipped": clipped,
        "hint": "This change was too large for one page; show()/comments() return it whole.",
    }
    return shrunk


def _snapshot(row: Any) -> dict[str, Any]:
    data = {name: row[name] for name in _SNAPSHOT_COLUMNS}
    for name in (
        "created_at",
        "updated_at",
        "closed_at",
        "started_at",
        "deleted_at",
        "lease_expires_at",
        "heartbeat_at",
    ):
        data[name] = pgstore._ts(data[name])
    data["metadata"] = pgstore._metadata(data["metadata"]) or {}
    data["labels"] = sorted(row["labels"] or [])
    data["dependencies"] = _json_list(row["dependencies"])
    data["dependents"] = _json_list(row["dependents"])
    data["comments"] = _json_list(row["comments"])
    return data


def _json_list(value: Any) -> list[Any]:
    """A jsonb aggregate as a list. asyncpg hands jsonb back as text unless a codec is
    registered (the pool registers none), so decode it here rather than shipping a
    JSON string inside the JSON answer."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    return list(value) if isinstance(value, list) else []


async def fetch_changes(
    *,
    after_cursor: str | None = None,
    since: str | None = None,
    until: str | None = None,
    boards: list[str] | None = None,
    limit: int = 100,
    timeout: float | None = None,
    readable_boards: set[str] | None = None,
) -> dict[str, Any]:
    """Return keyset-paged event rows grouped into complete issue snapshots.

    ``readable_boards`` (accounts mode) also prunes each snapshot's dependency edges
    to issues on those boards; ``None`` leaves them whole.

    Bounded: the call answers within ``timeout`` (default :func:`changes_timeout`) or
    raises a retryable ``RuntimeError`` — never hangs on a wedged connection.
    """
    budget = timeout if timeout and timeout > 0 else changes_timeout()
    try:
        return await asyncio.wait_for(
            _fetch_changes(
                after_cursor=after_cursor,
                since=since,
                until=until,
                boards=boards,
                limit=limit,
                readable_boards=readable_boards,
            ),
            budget,
        )
    except asyncio.TimeoutError as exc:
        raise RuntimeError(
            f"changes did not finish within {budget:g}s (the database is slow or unreachable); "
            "nothing was skipped — retry the same after_cursor, or ask for a smaller limit or a "
            "narrower since/until window"
        ) from exc


async def _fetch_changes(
    *,
    after_cursor: str | None = None,
    since: str | None = None,
    until: str | None = None,
    boards: list[str] | None = None,
    limit: int = 100,
    readable_boards: set[str] | None = None,
) -> dict[str, Any]:
    if not pgstore.pg_enabled():
        raise RuntimeError("the changes feed requires FEADS_PG_DSN")
    if not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError(f"limit must be between 1 and {MAX_PAGE_SIZE}")
    try:
        after = int(after_cursor or "0")
    except ValueError as exc:
        raise ValueError("after_cursor must be an event sequence cursor") from exc
    if after < 0:
        raise ValueError("after_cursor must be an event sequence cursor")
    since_at = _time_bound(since, "since")
    until_at = _time_bound(until, "until")

    requested = sorted({str(board).strip() for board in (boards or []) if str(board).strip()})
    pool = await pgstore.get_pool()
    unavailable: list[str] = []
    async with pool.acquire() as conn:
        if requested:
            known = await conn.fetch("SELECT id FROM boards WHERE id = ANY($1::text[])", requested)
            known_ids = {str(row["id"]) for row in known}
            unavailable = [board for board in requested if board not in known_ids]
            board_ids = [board for board in requested if board in known_ids]
            if not board_ids:
                return {
                    "changes": [],
                    "next_cursor": None,
                    "complete": False,
                    "unavailable_boards": unavailable,
                }
        else:
            board_ids = []

        args: list[Any] = [after]
        where = ["e.seq > $1"]
        if board_ids:
            args.append(board_ids)
            where.append(f"e.board_id = ANY(${len(args)}::text[])")
        if since_at is not None:
            args.append(since_at)
            where.append(f"e.at >= ${len(args)}")
        if until_at is not None:
            args.append(until_at)
            where.append(f"e.at <= ${len(args)}")
        event_rows = list(
            await conn.fetch(
                f"""
                WITH latest_events AS (
                    SELECT DISTINCT ON (e.board_id, e.issue_id)
                           e.seq, e.board_id, e.issue_id, e.actor, e.kind, e.payload, e.at
                      FROM events e
                     WHERE {" AND ".join(where)} AND e.issue_id IS NOT NULL
                     ORDER BY e.board_id, e.issue_id, e.seq DESC
                )
                SELECT seq, board_id, issue_id, actor, kind, payload, at
                  FROM latest_events
                 ORDER BY seq ASC
                 LIMIT {limit + 1}
                """,
                *args,
            )
        )
        truncated = len(event_rows) > limit
        event_rows = [row for row in event_rows[:limit] if row["issue_id"]]
        # Read snapshots chunk by chunk in seq order until the byte budget is spent.
        ordered: list[dict[str, Any]] = []
        size = 0
        stopped_early = False
        for start in range(0, len(event_rows), SNAPSHOT_CHUNK):
            if ordered and size > MAX_PAGE_BYTES:
                stopped_early = True
                break
            chunk = event_rows[start : start + SNAPSHOT_CHUNK]
            snapshots = await _read_snapshots(conn, chunk)
            if readable_boards is not None:
                await _drop_unreadable_edges(conn, snapshots, readable_boards)
            for row in chunk:
                key = (str(row["board_id"]), str(row["issue_id"]))
                if key not in snapshots:
                    continue
                change = _shrink_change(
                    {
                        **snapshots[key],
                        "events": [
                            {
                                "seq": str(row["seq"]),
                                "board_id": str(row["board_id"]),
                                "issue_id": str(row["issue_id"]),
                                "actor": row["actor"],
                                "kind": row["kind"],
                                "payload": row["payload"] or {},
                                "at": pgstore._ts(row["at"]),
                            }
                        ],
                    }
                )
                ordered.append(change)
                size += _json_size(change)

    changes, cut = _fit_page(ordered)
    truncated = truncated or cut or stopped_early
    return {
        "changes": changes,
        "next_cursor": changes[-1]["events"][-1]["seq"] if changes else None,
        "complete": not truncated and not unavailable,
        "unavailable_boards": unavailable,
    }


async def _read_snapshots(conn: Any, event_rows: list[Any]) -> dict[tuple[str, str], dict[str, Any]]:
    """Complete snapshots (labels, deps both ways, comments) for these events' issues."""
    keys = {(str(row["board_id"]), str(row["issue_id"])) for row in event_rows if row["issue_id"]}
    if not keys:
        return {}
    issue_ids = sorted({issue_id for _, issue_id in keys})
    event_boards = sorted({board_id for board_id, _ in keys})
    rows = await conn.fetch(
        f"""
        SELECT {_SNAPSHOT_COLUMNS_I},
               COALESCE(lab.labels, ARRAY[]::text[]) AS labels,
               COALESCE(dep.dependencies, '[]'::jsonb) AS dependencies,
               COALESCE(dpt.dependents, '[]'::jsonb) AS dependents,
               COALESCE(cmt.comments, '[]'::jsonb) AS comments
          FROM issues i
          LEFT JOIN LATERAL (
            SELECT array_agg(l.label ORDER BY l.label) AS labels
              FROM labels l WHERE l.issue_id = i.id
          ) lab ON true
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object(
              'issue_id', d.issue_id, 'depends_on_id', d.depends_on_id,
              'type', d.dep_type, 'created_at', d.created_at,
              'created_by', d.created_by, 'metadata', d.metadata
            ) ORDER BY d.depends_on_id, d.dep_type) AS dependencies
              FROM deps d WHERE d.issue_id = i.id
          ) dep ON true
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object(
              'issue_id', d.issue_id, 'depends_on_id', d.depends_on_id,
              'type', d.dep_type, 'created_at', d.created_at,
              'created_by', d.created_by, 'metadata', d.metadata
            ) ORDER BY d.issue_id, d.dep_type) AS dependents
              FROM deps d WHERE d.depends_on_id = i.id
          ) dpt ON true
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object(
              'id', c.id, 'issue_id', c.issue_id, 'author', c.author,
              'body', c.body, 'created_at', c.created_at
            ) ORDER BY c.created_at, c.id) AS comments
              FROM comments c WHERE c.issue_id = i.id
          ) cmt ON true
         WHERE i.id = ANY($1::text[]) AND i.board_id = ANY($2::text[])
        """,
        issue_ids,
        event_boards,
    )
    return {(str(row["board_id"]), str(row["id"])): _snapshot(row) for row in rows}


async def _drop_unreadable_edges(
    conn: Any, snapshots: dict[tuple[str, str], dict[str, Any]], readable: set[str]
) -> None:
    """Accounts mode: remove dependency edges whose other end is on a board the caller
    cannot read — events are already limited to readable boards, but a snapshot's edge
    list would still name the other space's ids. Dangling edges (no such issue) are kept,
    as ``pgstore._drop_unreadable_edges`` keeps them: they name nothing. Off → unchanged.
    """
    if not snapshots:
        return
    others: set[str] = set()
    for snap in snapshots.values():
        others.update(str(e.get("depends_on_id")) for e in snap["dependencies"] if isinstance(e, dict))
        others.update(str(e.get("issue_id")) for e in snap["dependents"] if isinstance(e, dict))
    if not others:
        return
    held = {
        str(r["id"]): str(r["board_id"])
        for r in await conn.fetch("SELECT id, board_id FROM issues WHERE id = ANY($1::text[])", sorted(others))
    }

    def visible(other: Any) -> bool:
        board = held.get(str(other))
        return board is None or board in readable

    for snap in snapshots.values():
        snap["dependencies"] = [
            e for e in snap["dependencies"] if isinstance(e, dict) and visible(e.get("depends_on_id"))
        ]
        snap["dependents"] = [e for e in snap["dependents"] if isinstance(e, dict) and visible(e.get("issue_id"))]
