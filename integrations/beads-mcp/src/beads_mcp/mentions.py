"""Who an ``@mention`` reaches — the MCP side of agent-to-agent coordination.

Feads is a platform for agents that humans can read. Agents @mention each other to
say "I am on this, you take that" so people's agents stop stepping on each other's
toes; an ``@handle`` lands in that person's inbox, which every one of their agents
reads through ``notifications()`` (and the dashboard bell shows, so humans can read
along). For that to work an agent has to know, at the moment it writes, whether its
mention actually reached anyone. This module answers that question with the same
rules the notification engine (``boards/notifications.mjs``) mints by:

- the parser is :func:`beads_mcp.notifications.extract_mentions` (shared fixture
  ``boards/mention-cases.json``);
- a handle resolves through the person's aliases (``@alex-laptop`` is ``mira``),
  their email (``@mira@example.test``), or an unclaimed live agent's actor;
- under accounts mode a mention only delivers to someone who can read the item's
  space — the engine's ``spaceReach``: a superadmin, a member of the board's space,
  or (unclaimed legacy agents) the default space;
- an explicit mention of yourself lands (a deliberate note-to-self), reported with
  ``self: true``.

The report never leaks the directory: a person outside the writer's directory scope
(nobody who shares a space with the writer) reads exactly like a handle that does not
exist, and suggestions only ever name people the writer could already list.

Read-only, one registry open per report, best-effort: an unreadable registry yields
``verified: false`` rather than a guess.
"""

from __future__ import annotations

import difflib
import os
import sqlite3
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from beads_mcp import accounts as _accounts
from beads_mcp.boards import RegistryUnavailableError, _connect, registry_path

DEFAULT_SPACE_ID = _accounts.DEFAULT_SPACE_ID

# Fields of create/update whose @mentions the engine delivers. Comments always do;
# of an issue's own text, only the description is diffed for new names.
NOTIFYING_ISSUE_FIELDS: tuple[str, ...] = ("description",)
# Text fields that are stored but never notify anyone; a mention there is reported.
SILENT_ISSUE_FIELDS: tuple[str, ...] = ("title", "design", "acceptance", "acceptance_criteria", "notes")

_DIRECTORY_TTL_SECONDS = 5.0


@dataclass
class Person:
    """One addressable inbox: a user (human or service), or an unclaimed live agent."""

    actor: str
    name: str
    kind: str
    email: str = ""
    aliases: list[str] = field(default_factory=list)
    superadmin: bool = False
    spaces: set[str] = field(default_factory=set)
    user_id: str = ""
    live: bool = True

    def can_read(self, space: str) -> bool:
        """The engine's ``spaceReach``: may this recipient read a board in ``space``?"""
        if not self.user_id:
            return space != "" and space == DEFAULT_SPACE_ID
        if self.superadmin:
            return True
        return space != "" and space in self.spaces


@dataclass
class Directory:
    """Every addressable person, keyed by every lower-cased handle that means them."""

    accounts: bool
    people: list[Person]
    by_key: dict[str, Person]
    space_names: dict[str, str] = field(default_factory=dict)

    def resolve(self, handle: str) -> Person | None:
        from beads_mcp.notifications import mention_lookup_keys

        for key in mention_lookup_keys(handle):
            person = self.by_key.get(key)
            if person is not None:
                return person
        return None


_cache: dict[str, tuple[float, Directory]] = {}


def _rows(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    try:
        return list(conn.execute(sql, params).fetchall())
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc) or "no such column" in str(exc):
            return []
        raise


def _get(row: sqlite3.Row, key: str) -> Any:
    """``row[key]``, or ``None`` on a registry without that column."""
    return row[key] if key in set(row.keys()) else None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(r["name"]) for r in _rows(conn, f"PRAGMA table_info({table})")}


def load_directory(db_path: str | None = None, accounts_on: bool | None = None) -> Directory:
    """Read the addressable directory (cached a few seconds per registry).

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    if accounts_on is None:
        accounts_on = _accounts.accounts_enabled(os.environ, db_path)
    path = db_path or registry_path()
    key = f"{path}|{int(accounts_on)}|{_fingerprint(path)}"
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and now - hit[0] < _DIRECTORY_TTL_SECONDS:
        return hit[1]
    if len(_cache) > 32:
        _cache.clear()
    conn = _connect(db_path)
    try:
        directory = _read_directory(conn, accounts_on)
    finally:
        conn.close()
    _cache[key] = (now, directory)
    return directory


def _fingerprint(path: str) -> str:
    """Change marker for a registry file (and its WAL), so a write is seen at once."""
    parts = []
    for candidate in (path, f"{path}-wal"):
        try:
            st = os.stat(candidate)
            parts.append(f"{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append("-")
    return "/".join(parts)


def reset_directory_cache() -> None:
    """Drop cached directories (tests; after a change made in this process)."""
    _cache.clear()


def _read_directory(conn: sqlite3.Connection, accounts_on: bool) -> Directory:
    live_agents = {
        str(r["actor"]).lower(): r
        for r in _rows(conn, "SELECT * FROM agents WHERE revoked_at = 0 ORDER BY registered_at")
        if r["actor"]
    }
    people: list[Person] = []
    by_key: dict[str, Person] = {}

    def claim(handle: str, person: Person) -> None:
        lowered = (handle or "").strip().lower()
        if lowered and lowered not in by_key:
            by_key[lowered] = person

    if not accounts_on:
        for lower, row in live_agents.items():
            person = Person(
                actor=str(row["actor"]),
                name=str(row["display_name"] or row["actor"]),
                kind=str(_get(row, "kind") or "agent"),
                aliases=[str(row["actor"])],
            )
            people.append(person)
            claim(lower, person)
        return Directory(accounts=False, people=people, by_key=by_key)

    user_cols = _columns(conn, "users")
    kind_col = "kind" in user_cols
    members: dict[str, set[str]] = {}
    for r in _rows(conn, "SELECT user_id, space_id FROM space_members"):
        members.setdefault(str(r["user_id"]), set()).add(str(r["space_id"]))
    for r in _rows(conn, "SELECT * FROM users ORDER BY actor"):
        user = dict(r)
        actor = str(user.get("actor") or "")
        if not actor:
            continue
        aliases = _accounts._aliases(conn, user)
        kind = str(user.get("kind") or "human") if kind_col else "human"
        person = Person(
            actor=actor,
            name=str(user.get("display_name") or actor),
            kind=kind,
            email=str(user.get("email") or ""),
            aliases=aliases,
            # A service account is never a superadmin, whatever its row says (the
            # engine's spaceReach applies the same rule): it reaches its own spaces.
            superadmin=kind != "service" and int(user.get("is_superadmin") or 0) == 1,
            spaces=members.get(str(user["id"]), set()),
            user_id=str(user["id"]),
            # The engine can only mint for a recipient with a live agent row: the
            # user's principal row, or failing that a live alias row.
            live=actor.lower() in live_agents or any(a.lower() in live_agents for a in aliases),
        )
        people.append(person)
    # A bot identity reaches exactly what the principal path gives it
    # (``_service_memberships``, the engine's spaceReach): its steward's current
    # agent-visible spaces, and nothing once the steward is not live (disabled,
    # off the roster, gone, not a person) — the same ``_user_live`` rule.
    users_by_id: dict[str, dict[str, Any]] = {str(r["id"]): dict(r) for r in _rows(conn, "SELECT * FROM users")}
    for person in people:
        bot_row = users_by_id.get(person.user_id) or {}
        if (
            str(bot_row.get("kind") or "") != "service"
            or str(bot_row.get("source") or "") != _accounts.SERVICE_SOURCE_BOT
        ):
            continue
        person.spaces = set(_accounts._service_memberships(conn, _accounts._shape_user(bot_row), os.environ))
    # Same precedence as accounts.mjs aliasMap: every user's aliases first (in actor
    # order), then emails, then unclaimed live agents as themselves.
    for person in people:
        for alias in person.aliases:
            claim(alias, person)
    for person in people:
        if "@" in person.email:
            claim(person.email, person)
    for lower, row in live_agents.items():
        if lower in by_key:
            continue
        if _get(row, "owner_user_id"):
            continue
        person = Person(
            actor=str(row["actor"]),
            name=str(row["display_name"] or row["actor"]),
            kind="agent",
            aliases=[str(row["actor"])],
        )
        people.append(person)
        claim(lower, person)
    space_names = {
        str(r["id"]): str(r["slug"] or r["name"] or r["id"]) for r in _rows(conn, "SELECT * FROM spaces")
    }
    return Directory(accounts=True, people=people, by_key=by_key, space_names=space_names)


# =============================================================================
# The report
# =============================================================================


def _in_scope(person: Person, scope: set[str] | None) -> bool:
    if scope is None:
        return True
    return any(alias in scope for alias in person.aliases) or person.actor in scope


def _is_self(person: Person, caller_aliases: Sequence[str], caller_actor: str) -> bool:
    mine = {a.lower() for a in caller_aliases if a}
    if caller_actor:
        mine.add(caller_actor.lower())
    return person.actor.lower() in mine or any(a.lower() in mine for a in person.aliases)


def did_you_mean(handle: str, directory: Directory, scope: set[str] | None, limit: int = 3) -> list[str]:
    """Up to ``limit`` canonical handles close to ``handle``, only among people in scope."""
    needle = (handle or "").lower().split("@", 1)[0]
    if not needle:
        return []
    candidates: dict[str, Person] = {}
    for person in directory.people:
        if not person.live or not _in_scope(person, scope):
            continue
        for key in {person.actor, *person.aliases, person.name, person.email.split("@", 1)[0]}:
            k = (key or "").strip().lower()
            if k:
                candidates.setdefault(k, person)
    ranked: list[str] = []

    def add(person: Person) -> None:
        if person.actor not in ranked:
            ranked.append(person.actor)

    for key, person in candidates.items():
        if key.startswith(needle) or needle.startswith(key) and len(key) >= 3:
            add(person)
    for word in needle.replace("-", " ").replace(".", " ").split():
        for key, person in candidates.items():
            if len(word) >= 3 and word in key.replace("-", " ").split():
                add(person)
    for key in difflib.get_close_matches(needle, list(candidates), n=limit * 2, cutoff=0.72):
        add(candidates[key])
    return ranked[:limit]


def mention_report(
    texts: Iterable[tuple[str, str]],
    *,
    space: str | None,
    caller_actor: str,
    caller_aliases: Sequence[str] = (),
    scope: set[str] | None = None,
    db_path: str | None = None,
    accounts_on: bool | None = None,
) -> dict[str, Any]:
    """Who the ``@mentions`` in ``texts`` reach.

    Args:
        texts: ``(field, text)`` pairs — ``("comment", text)`` or the create/update
            fields. Fields in :data:`SILENT_ISSUE_FIELDS` are reported as not notifying.
        space: The item's space id; ``None`` when it cannot be determined (no space
            gating then — the engine's gate is the authority); ``""`` for an item on no
            registered board, which only superadmins can read.
        caller_actor / caller_aliases: who is writing (self-mentions).
        scope: The writer's directory scope (``accounts.directory_actors``); ``None`` =
            everyone. People outside it are reported as unknown, never named.

    Returns:
        ``{"delivered": [...], "not_delivered": [...]}`` (plus ``verified: False`` and
        the raw handles under ``unverified`` when the registry cannot be read), or ``{}``
        when nothing in ``texts`` is a mention.
    """
    from beads_mcp.notifications import parse_mentions

    pairs = [(f, t) for f, t in texts if t]
    handles: list[tuple[str, str]] = []
    seen: set[str] = set()
    for field_name, text in pairs:
        for handle in parse_mentions(text):
            k = f"{field_name}\0{handle.lower()}"
            if k not in seen:
                seen.add(k)
                handles.append((field_name, handle))
    if not handles:
        return {}
    try:
        directory = load_directory(db_path, accounts_on)
    except (RegistryUnavailableError, sqlite3.Error):
        return {
            "delivered": [],
            "not_delivered": [],
            "verified": False,
            "unverified": list(dict.fromkeys(h for _, h in handles)),
        }

    delivered: list[dict[str, Any]] = []
    not_delivered: list[dict[str, Any]] = []
    reached: set[str] = set()
    gate = directory.accounts
    for field_name, handle in handles:
        person = directory.resolve(handle)
        if person is not None and not person.live:
            person = None
        is_self = person is not None and _is_self(person, caller_aliases, caller_actor)
        in_scope = person is not None and (not gate or is_self or _in_scope(person, scope))
        # Whoever can read the item's space is in its audience: naming them leaks
        # nothing, so they are reported as reached even outside the directory scope.
        reads_item = person is not None and (not gate or space is None or is_self or person.can_read(space))
        known = person is not None and (in_scope or (gate and space is not None and reads_item))
        if field_name in SILENT_ISSUE_FIELDS:
            entry: dict[str, Any] = {"handle": handle, "reason": "field_not_notified", "field": field_name}
            if known and person is not None:
                entry["to"] = person.actor
            not_delivered.append(entry)
            continue
        if person is None or not known:
            entry = {"handle": handle, "reason": "unknown_handle"}
            suggestions = did_you_mean(handle, directory, scope if gate else None)
            if suggestions:
                entry["did_you_mean"] = suggestions
            not_delivered.append(entry)
            continue
        if not reads_item:
            not_delivered.append({"handle": handle, "reason": "not_in_space", "to": person.actor})
            continue
        if person.actor in reached:
            continue
        reached.add(person.actor)
        entry = {"handle": handle, "to": person.actor, "name": person.name, "kind": person.kind}
        if is_self:
            entry["self"] = True
        delivered.append(entry)
    return {"delivered": delivered, "not_delivered": not_delivered}


def report_lines(report: Mapping[str, Any]) -> list[str]:
    """The human-readable lines ``comment()`` appends for a report."""
    lines: list[str] = []
    if not report:
        return lines
    if report.get("verified") is False:
        named = ", ".join(f"@{h}" for h in report.get("unverified") or [])
        if named:
            lines.append(
                f"mentioned (unverified): {named} — the registry could not be read, so these are the "
                "names you wrote rather than people known to exist"
            )
        return lines
    delivered = report.get("delivered") or []
    if delivered:
        parts = []
        for d in delivered:
            label = f"@{d['to']}"
            if str(d["handle"]).lower() != str(d["to"]).lower():
                label += f" (as @{d['handle']})"
            if d.get("self"):
                label += " (you)"
            parts.append(label)
        lines.append("mentioned: " + ", ".join(parts))
    for miss in report.get("not_delivered") or []:
        handle = f"@{miss['handle']}"
        reason = miss.get("reason")
        if reason == "not_in_space":
            lines.append(
                f"not delivered: {handle} — they cannot see this item's space, so nothing was sent. "
                "Mention people who share this space (users_list(query=...))."
            )
        elif reason == "field_not_notified":
            lines.append(
                f"not delivered: {handle} — @mentions in {miss.get('field')} do not notify; put them in a "
                "comment (or the description)."
            )
        else:
            hint = ""
            if miss.get("did_you_mean"):
                hint = " Did you mean " + ", ".join(f"@{h}" for h in miss["did_you_mean"]) + "?"
            lines.append(
                f"not delivered: {handle} — nobody you can reach by that handle, so nobody was notified."
                f"{hint} users_list() (or users_list(query=...)) is the directory of who you can @mention."
            )
    return lines


async def space_of_issue(issue_id: str) -> str | None:
    """The space of the board that holds ``issue_id``, for mention gating.

    Only answers where the engine gates: accounts mode on the Postgres store (the
    hosted instance), using the same board → space map the inbox reads are scoped by.
    ``None`` = cannot say (no gating in the report; the engine stays the authority);
    ``""`` = an issue on a board in no space (only superadmins can read it). Never raises.
    """
    import asyncio

    if not issue_id or not os.environ.get("FEADS_PG_DSN", "").strip():
        return None
    try:
        if not await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
            return None
        from beads_mcp import pgstore

        holders = await pgstore.boards_of_issues([issue_id])
        board = holders.get(issue_id, "")
        if not board:
            return None
        space_map = await asyncio.to_thread(_accounts.board_space_map)
        return space_map.get(board, "")
    except Exception:  # noqa: BLE001 - a report must never fail the write it describes
        return None


# =============================================================================
# Handle lookup: users_list(query=...)
# =============================================================================


def _match_score(query: str, person: Person) -> int:
    """How well ``query`` names ``person`` (0 = not at all). Handles, aliases, the email
    local part and display-name words; exact beats prefix beats substring beats fuzzy."""
    q = query.strip().lower().lstrip("@")
    if not q:
        return 1
    q_local = q.split("@", 1)[0]
    handle = person.actor.lower()
    aliases = [a.lower() for a in person.aliases if a and a.lower() != handle]
    local = person.email.lower().split("@", 1)[0] if "@" in person.email else ""
    name = person.name.lower()
    words = [w for w in name.replace("-", " ").replace(".", " ").split() if w]
    if q == handle:
        return 100
    if q in aliases:
        return 95
    if local and (q == local or q == person.email.lower()):
        return 90
    if q == name:
        return 85
    if handle.startswith(q_local):
        return 70
    if any(a.startswith(q_local) for a in aliases):
        return 65
    if (local and local.startswith(q_local)) or any(w.startswith(q_local) for w in words):
        return 60
    if q_local in handle or any(q_local in a for a in aliases) or q_local in name or (local and q_local in local):
        return 40
    keys = [handle, *aliases, *words] + ([local] if local else [])
    if difflib.get_close_matches(q_local, keys, n=1, cutoff=0.75):
        return 30
    return 0


def people_view(
    principal: Mapping[str, Any] | None,
    query: str = "",
    db_path: str | None = None,
    limit: int = 25,
) -> dict[str, Any]:
    """One entry per person the caller may @mention, ranked by ``query``.

    Each entry: ``handle`` (the canonical @handle to write — it reaches all of that
    person's agents), ``display_name``, ``kind`` (``human`` / ``service``, or ``agent``
    for an unclaimed legacy agent), ``aliases`` (other handles that also reach them),
    and ``spaces`` (the spaces you share — a mention reaches them only on items in
    those). Limited to people who share a space with the caller (everyone when the
    caller's scope is unrestricted). Raises ``RegistryUnavailableError``.
    """
    from beads_mcp.access import accessible_spaces

    directory = load_directory(db_path)
    scope = _accounts.directory_actors(principal, db_path) if principal else None
    caller_spaces = accessible_spaces(principal) if principal else None
    ranked: list[tuple[int, Person]] = []
    for person in directory.people:
        if not person.live:
            continue
        if directory.accounts and not _in_scope(person, scope):
            continue
        score = _match_score(query, person)
        if score > 0:
            ranked.append((score, person))
    ranked.sort(key=lambda item: (-item[0], item[1].kind != "human", item[1].actor))
    people: list[dict[str, Any]] = []
    for score, person in ranked[: max(1, min(int(limit), 200))]:
        entry: dict[str, Any] = {
            "handle": person.actor,
            "display_name": person.name,
            "kind": person.kind,
            "aliases": [a for a in person.aliases if a and a != person.actor],
        }
        if directory.accounts:
            reach = {DEFAULT_SPACE_ID} if not person.user_id else set(person.spaces)
            if person.superadmin and person.user_id and not reach:
                reach = set(directory.space_names)
            shared = reach if caller_spaces is None else reach & set(caller_spaces)
            entry["spaces"] = sorted(directory.space_names.get(s, s) for s in shared)
        if query:
            entry["match"] = score
        people.append(entry)
    return {"people": people, "total": len(ranked)}


def handle_of(actor: str, db_path: str | None = None) -> str:
    """The canonical @handle for an actor or alias (itself when unknown)."""
    try:
        person = load_directory(db_path).resolve(actor)
    except (RegistryUnavailableError, sqlite3.Error):
        return actor
    return person.actor if person is not None else actor
