"""Being told something happened, and being able to address somebody by name.

Three things that only make sense together, which is why they share a module:

- **the directory** (:func:`users_list_payload`) — who is registered, and therefore
  who can be named;
- **the conventions** (:data:`MENTION_PATTERN`, :data:`ISSUE_REF_PATTERN`) — how a
  comment names a person (``@actor``) or another issue (``#issue-id``);
- **the inbox** (:func:`notifications_payload`, :func:`notifications_ack_payload`) —
  what arrives because somebody named you, or touched work that is yours.

Before this existed, a board was a place agents wrote *past* each other. An agent
could leave a comment asking another agent a question and have no way to make that
agent aware of it: the only discovery mechanism was re-reading every issue you had
ever touched, which nobody does. ``@actor`` is the addressing, and ``notifications()``
is the delivery.

## The parsers are a contract, not an implementation detail

The same two regexes are implemented in the dashboard's Node engine (which decides who
gets notified) and in the browser (which highlights and links). If this one is looser,
this server tells an agent it mentioned somebody who will never be notified; if it is
tighter, an agent is notified for a mention this server said was not one. Both are
worse than either parser being wrong on its own, because the disagreement is invisible
from either side.

So they are ported character for character from the contract, including two details
that look like noise and are not:

- ``re.ASCII``. JavaScript's ``\\w`` is ``[A-Za-z0-9_]``; Python's is Unicode-aware, so
  without this flag ``café@bob`` is a mention in Node and is not one here.
- The leading ``(^|[^\\w@])`` / ``(^|[^\\w#])`` group, which is why the capture is group
  **2**. It is what stops ``user@example.com`` being a mention of ``example`` — the
  character before the sigil has to be a boundary, and consuming it is how a regex
  engine without lookbehind says so.

## Reads are read-only; the one write is a proxy

Everything here reads the registry ``mode=ro`` through :mod:`beads_mcp.boards`' own
connection helpers, for the reason that module states: the registry has few writers and
that is what makes concurrent access safe without a locking protocol.

``notifications_ack`` is the exception, and it resolves the exception the same way
:mod:`beads_mcp.signup` does — by asking the dashboard to write over HTTP rather than
opening a write handle here. See that module's header for the full argument; the short
version is that a second writer is a cost paid by everybody to save one round trip.

## The ``notifications`` table may not exist yet

It arrives with registry schema v3, created by the Node dashboard. A registry written
by an older build simply has no such table, and that is a **normal** state rather than
a fault: it means nobody has run a dashboard new enough to have notified anyone, so the
correct answer to "what am I owed?" is "nothing". Every read therefore checks
``sqlite_master`` first and answers empty, because the alternative — letting SQLite's
"no such table" surface as :class:`RegistryUnavailableError` — would report a
first-run condition as a broken registry and send an agent to fix something that is
not wrong.

## Seen and handled are two different questions

Every row carries two timestamps. ``read_at`` is stamped when a **human** saw it — the
dashboard's bell, or "mark all read". ``handled_at`` is stamped when an **agent**
acknowledged it, through ``notifications_ack`` here or the dashboard's HTTP ack. Handling
implies having been seen; being seen implies nothing about having been handled.

This is the agent surface, so its queue is the handled one. "Unread" has always meant
"not yet acknowledged" on this side — that reading is what makes ``notifications()`` at
session start a list of what is still *owed* rather than a list of what is novel. One
consequence is deliberate and worth stating plainly, because from the browser it looks
like a bug: **a row a human already read in the bell keeps appearing here until an agent
acks it.** A person glancing at a notification is not an agent having answered it, and
collapsing the two is how an obligation gets silently discharged by somebody scrolling
past it.

``handled_at`` arrives with registry schema v4 and, exactly like the table itself, a
registry without it is *older* rather than broken. So it is probed too (see
:func:`_column_exists`), and where it is absent every filter and count falls back to
``read_at`` while each row reports its ``handled_at`` as its ``read_at`` — a faithful
description of the pre-split world, in which seeing and handling were one act.

## Humans see mentions; agents see everything useful

The dashboard's bell shows a human only rows where they were ``@mentioned``
(:data:`HUMAN_NOTIFICATION_TYPES`). This surface is the agents' and lists every type,
including the coordination ones a human never sees — ``work_overlap``,
``reassigned_away``, ``status_on_owned``, ``new_in_area`` — each carrying a one-line
``guidance`` ("coordinate, don't block": who to talk to and what to do next) and an
``audience`` (``all`` for mentions, ``agent`` otherwise). Agent rows also collapse: a
second event of the same type about the same issue, while the first is still
unhandled, bumps that row's ``count`` instead of stacking a new one. ``count`` and
``guidance`` arrive with the same Node-side migration and are probed exactly like
``handled_at``: a registry without them reports ``count`` 1 and derives ``guidance``
here, from :func:`guidance_for`, which mirrors ``guidanceFor`` in
``boards/notifications.mjs`` word for word.
"""

import base64
import binascii
import json
import logging
import os
import re
import sqlite3
from collections.abc import Mapping, Sequence
from typing import Any, Literal, TypedDict
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from beads_mcp import accounts as _accounts
from beads_mcp.agents import (
    AgentRow,
    accounts_edge_email,
    acting_actor,
    how_to_get_a_credential,
    list_agents,
    registry_location,
    resolve_identity,
)
from beads_mcp.bd_client import ActorResolutionError, silo_configured
from beads_mcp.boards import RegistryUnavailableError, _connect, _query
from beads_mcp.models import Comment, IssueRef
from beads_mcp.transport import (
    DASHBOARD_URL_ENV,
    bearer_token,
    dashboard_url,
    public_dashboard_url,
    serving_http,
)

logger = logging.getLogger(__name__)

# =============================================================================
# The two conventions
# =============================================================================

# `@` + actor. Ported from the contract's
# `/(^|[^\w@])@([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)/gi`. Group 2 is the actor, which
# never ends in `.`, `_` or `-` (no actor can), so `cc @mira.` names `mira`. `re.ASCII` is load-bearing rather than tidy — see the module
# docstring — and `re.IGNORECASE` is what lets an agent write `@mira` and reach
# `mira`, since actor slugs are lowercase but prose is not.
MENTION_PATTERN = re.compile(r"(^|[^\w@])@([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)", re.IGNORECASE | re.ASCII)

# `#` + issue id. Ported from `/(^|[^\w#])#([a-z][a-z0-9]*-[a-zA-Z0-9._-]*[a-zA-Z0-9_])/g`,
# group 2. Deliberately **not** case-insensitive: issue ids begin with a lowercase
# prefix (`^[a-z]+-[a-zA-Z0-9._-]+$`, cmd/bd/rename.go), so matching `#Chapter-2` would
# turn ordinary prose into broken links. The trailing `[a-zA-Z0-9_]` is why
# `#ex-abc.` links `ex-abc` and leaves the sentence's full stop alone.
ISSUE_REF_PATTERN = re.compile(r"(^|[^\w#])#([a-z][a-z0-9]*-[a-zA-Z0-9._-]*[a-zA-Z0-9_])", re.ASCII)

# The dashboard's deep link for one issue, as a hash route. Shared with the UI, which
# navigates in-app on the same path — so a link pasted from here and a link clicked in
# the browser land in the same place.
ISSUE_HASH_PATH = "#/issues?issue="


# =============================================================================
# The notifications table
# =============================================================================

NOTIFICATIONS_TABLE = "notifications"

# The two timestamps a row can be filtered on. Named rather than inlined because they are
# interpolated into SQL below, and the interpolation is safe *because* they are these
# constants: the column a query is keyed on is chosen from this pair by a schema probe,
# never assembled from anything a caller passed in.
HANDLED_COLUMN = "handled_at"
SEEN_COLUMN = "read_at"

# The collapse columns, probed like handled_at (see the module docstring).
COUNT_COLUMN = "count"
GUIDANCE_COLUMN = "guidance"

# Listed explicitly rather than SELECT *, for the reason boards.py gives: a column
# added by a later Node-side migration must not silently change the shape this server
# promises. The order matches the wire row in the contract so the two read as one.
_NOTIFICATION_COLUMNS = (
    "id, board_id, recipient_actor, type, issue_id, issue_title, actor, snippet, "
    "related_issue, created_at, read_at"
)

# The same list on a v4 registry. Spelled as a second constant rather than by appending
# conditionally, so each string is literally the wire row of the schema version it reads
# — and a future column lands in exactly one of them by hand, which is the property the
# explicit list exists for.
_NOTIFICATION_COLUMNS_WITH_HANDLED = f"{_NOTIFICATION_COLUMNS}, {HANDLED_COLUMN}"

# And on a registry with the collapse columns (``count``, ``guidance``), which arrive
# together and only on top of ``handled_at``.
_NOTIFICATION_COLUMNS_WITH_COLLAPSE = f"{_NOTIFICATION_COLUMNS_WITH_HANDLED}, {COUNT_COLUMN}, {GUIDANCE_COLUMN}"

DEFAULT_NOTIFICATION_LIMIT = 20
# The same ceiling the WebSocket op enforces. Not in the tool's signature, where it
# would read as a thing to tune: it is a guard against `limit=1000000` turning one tool
# call into a context-window incident, not a knob.
MAX_NOTIFICATION_LIMIT = 200

# Exactly the strings the engine writes. Reproduced here so the tool description can
# enumerate them without importing the engine's vocabulary by hand at each call site.
NotificationType = Literal[
    "mention",
    "assigned",
    "comment_on_owned",
    "update_on_commented",
    "dependency_completed",
    "reassigned_away",
    "work_overlap",
    "status_on_owned",
    "new_in_area",
]

# Every type, in the engine's priority order (most specific first). Mirrors
# NOTIFICATION_TYPES in boards/notifications.mjs.
NOTIFICATION_TYPES: tuple[str, ...] = (
    "mention",
    "assigned",
    "reassigned_away",
    "work_overlap",
    "dependency_completed",
    "comment_on_owned",
    "status_on_owned",
    "new_in_area",
    "update_on_commented",
)

# What a human's bell shows. Mirrors HUMAN_NOTIFICATION_TYPES in
# boards/notifications.mjs — the one place the human/agent split is defined.
HUMAN_NOTIFICATION_TYPES: tuple[str, ...] = ("mention",)


class NotificationRow(TypedDict):
    """One notification, in the shape the ws, HTTP and MCP surfaces all use.

    ``url`` is the one field that differs by surface, and only in prefix: the browser
    gets the bare hash route because it is already on the dashboard's origin, while
    this server makes it absolute — an agent pasting a link into a message to a human
    has no origin to be relative to.

    ``read_at`` and ``handled_at`` are two different facts, and reading either as the
    other is the mistake the split exists to prevent: ``read_at`` is a **human** having
    seen the row in the dashboard's bell, ``handled_at`` an **agent** having acked it.
    This surface queues on the second — a row with ``read_at`` set and ``handled_at`` at
    zero is still yours to answer. On a registry that predates the split, ``handled_at``
    mirrors ``read_at``; see the module docstring.
    """

    id: str
    board_id: str
    recipient_actor: str
    type: str
    issue_id: str
    issue_title: str
    actor: str
    snippet: str
    related_issue: str
    created_at: int
    read_at: int
    handled_at: int
    url: str
    count: int
    guidance: str
    audience: str


def audience_of(notification_type: str) -> str:
    """``all`` for what humans see too (mentions), ``agent`` for the rest."""
    return "all" if notification_type in HUMAN_NOTIFICATION_TYPES else "agent"


def guidance_for(notification_type: str, issue_id: str, actor: str = "", related_issue: str = "") -> str:
    """The one-line "coordinate, don't block" next step for a row.

    Mirrors ``guidanceFor`` in ``boards/notifications.mjs`` word for word (the shared
    expectations are ``boards/guidance-cases.json``); the engine stores it on the row,
    and this derives it for rows minted before it did. Feads is a platform for agents
    that humans can read: an ``@handle`` reaches every agent of that person, so the
    suggested reply @mentions the other person — that is how two people's agents agree
    who takes what instead of stepping on each other's toes. Never "stop and wait".
    """
    at = f"@{actor}" if actor else ""
    on = f"#{issue_id}"
    rel = f"#{related_issue}" if related_issue else ""
    nowait = "keep working on what is clearly yours; never wait for a reply."
    if notification_type == "mention":
        if at:
            return (
                f"{at} mentioned you on {on}: read the thread, then reply there with {at} (your answer, "
                f"or what you are doing that touches it); {nowait}"
            )
        return f"You were mentioned on {on}: read the thread and reply there, @mentioning whoever asked; {nowait}"
    if notification_type == "assigned":
        return (
            f"You now hold {on}. Claim it when you start; if it is not yours to do, comment on {on} "
            "@mentioning who should take it."
        )
    if notification_type == "reassigned_away":
        if at:
            return (
                f"Coordinate, don't block: {on} is now {at}'s. Stop changing it; comment on {on} with {at} "
                "saying where your partial work is rather than re-claiming."
            )
        return (
            f"Coordinate, don't block: {on} was reassigned. Stop changing it; comment on {on}, @mentioning "
            "the new holder, saying where your partial work is rather than re-claiming."
        )
    if notification_type == "work_overlap":
        yours = f"your {rel}" if rel else "your work"
        if at:
            return (
                f"Coordinate, don't block: {at} is on {on}, which overlaps {yours} — comment on {on} with "
                f"{at} saying which part you take and which you leave to them; {nowait}"
            )
        return (
            f"Coordinate, don't block: {on} overlaps {yours} — comment on {on}, @mentioning its holder, "
            f"saying which part you take; {nowait}"
        )
    if notification_type == "dependency_completed":
        blocker = f"{rel} " if rel else ""
        return f"Blocker {blocker}is closed — {on} may be ready; check ready() and pick it up if it is yours."
    if notification_type == "comment_on_owned":
        if at:
            return (
                f"{at} commented on {on}, which you own: read it; if it asks something or touches your "
                f"plan, reply on {on} with {at}."
            )
        return (
            f"New comment on {on}, which you own: read it; if it asks something, reply there "
            "@mentioning its author."
        )
    if notification_type == "status_on_owned":
        if at:
            return (
                f"{on} was moved by {at} — check it matches your plan; if it does not, comment on {on} "
                f"with {at} rather than moving it back."
            )
        return (
            f"{on} changed status — check it matches your plan; if it does not, comment on {on} "
            "@mentioning who moved it."
        )
    if notification_type == "new_in_area":
        epic = f" {rel}" if rel else ""
        if at:
            return (
                f"{at} filed {on} under your epic{epic}: triage it; if it duplicates or overlaps work in "
                f"flight, comment on {on} with {at} naming that #item."
            )
        return (
            f"New work under your epic{epic}: triage {on}; if it duplicates or overlaps work in flight, "
            f"comment on {on} @mentioning its filer and naming that #item."
        )
    if notification_type == "update_on_commented":
        if at:
            return (
                f"{at} changed {on} since you commented — re-read before acting on it; if it now collides "
                f"with your work, comment there with {at}."
            )
        return f"{on} changed since you commented — re-read before acting on it."
    return ""


class UserRow(TypedDict):
    """One entry in the directory of actors you can ``@mention``.

    Deliberately narrower than :class:`beads_mcp.agents.RosterRow`: no ``host``, no
    ``workspace_dir``, no ``session_id``. Those answer "where is this agent running",
    which is administrative data and gated accordingly by ``agents_list``. This answers
    "what do I call it", which everyone with an identity needs.
    """

    actor: str
    display_name: str
    role: str
    kind: str
    board_id: str
    registered_at: int
    last_seen_at: int


class RevokedUserRow(UserRow, total=False):
    """A directory entry carrying ``revoked_at``, for ``include_revoked=True``.

    Present only when asked for. A caller reading the live directory should not have to
    check a field that is zero on every row it can see, and a caller that *did* ask
    needs the field or the extra rows are indistinguishable from the rest.
    """

    revoked_at: int


class MentionMatch(TypedDict):
    """The outcome of resolving ``@names`` in a piece of text against the registry.

    ``verified`` is the part that matters. When the registry cannot be read there is no
    way to tell a real actor from a typo, so ``mentioned`` degrades to the raw
    candidates and ``unmatched`` is empty — reporting every name as unmatched would be
    a confident claim we have no basis for, and reporting none would hide the mentions
    entirely.
    """

    mentioned: list[str]
    unmatched: list[str]
    verified: bool


# =============================================================================
# Parsing
# =============================================================================


class MentionToken(TypedDict):
    """One ``@mention`` occurrence: the handle as written and where its ``@`` token sits."""

    handle: str
    start: int
    end: int


# The parser of record, mirroring ``extractMentions`` in boards/mentions.mjs rule for
# rule (the shared cases are boards/mention-cases.json). MENTION_PATTERN above stays the
# cheap shape test; these are what decide what is a mention.
MENTION_HANDLE_MAX = 64
_MENTION_TOKEN = re.compile(r"(^|[^\w@])@([a-z0-9][a-z0-9._-]*)", re.IGNORECASE | re.ASCII)
_EMAIL_DOMAIN = re.compile(
    r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+", re.IGNORECASE | re.ASCII
)
_CODE_FENCE = re.compile(r"(`{3,}|~{3,})[\s\S]*?(?:\1|\Z)")
_CODE_SPAN = re.compile(r"`[^`\n]+`")
_URL = re.compile(r"\b(?:[a-z][a-z0-9+.-]*://|www\.)[^\s<>\"'`]+", re.IGNORECASE | re.ASCII)
_TRAILING_PUNCT = re.compile(r"[._-]+\Z")


def mask_non_prose(text: str) -> str:
    """``text`` with code fences, inline code spans and URLs blanked to spaces (same length)."""

    def blank(match: re.Match[str]) -> str:
        return re.sub(r"[^\n]", " ", match.group(0))

    out = _CODE_FENCE.sub(blank, text or "")
    out = _CODE_SPAN.sub(blank, out)
    return _URL.sub(blank, out)


def extract_mentions(text: str) -> list[MentionToken]:
    """Every ``@mention`` in ``text``, in order, duplicates included.

    Mirrors ``extractMentions`` (boards/mentions.mjs): trailing ``.``/``_``/``-`` trimmed,
    ``@user@domain`` kept whole, nothing inside code spans/blocks or URLs, nothing
    followed by ``/`` (package scopes, paths), 64-character cap.
    """
    source = text or ""
    masked = mask_non_prose(source)
    out: list[MentionToken] = []
    pos = 0
    while True:
        m = _MENTION_TOKEN.search(masked, pos)
        if m is None:
            break
        raw = m.group(2)
        start = m.start(2) - 1
        raw_end = start + 1 + len(raw)
        pos = m.end()
        after = masked[raw_end : raw_end + 1]
        handle = _TRAILING_PUNCT.sub("", raw)
        end = start + 1 + len(handle)
        trimmed = len(handle) != len(raw)
        if after == "/" and not trimmed:
            continue
        if after == "@" and not trimmed:
            domain = _EMAIL_DOMAIN.match(masked, raw_end + 1)
            if domain:
                end = domain.end()
                pos = end
                if len(raw) <= MENTION_HANDLE_MAX:
                    out.append(MentionToken(handle=source[start + 1 : end], start=start, end=end))
                continue
        if len(handle) > MENTION_HANDLE_MAX:
            handle = _TRAILING_PUNCT.sub("", handle[:MENTION_HANDLE_MAX])
            end = start + 1 + len(handle)
        if not handle:
            continue
        out.append(MentionToken(handle=source[start + 1 : end], start=start, end=end))
    return out


def parse_mentions(text: str) -> list[str]:
    """Every ``@name`` candidate in ``text``, first-seen order.

    Candidates, not actors: nothing here consults the registry, so a name that belongs
    to nobody comes back exactly like one that does. Use :func:`resolve_mentions` when
    the difference matters.

    Deduped case-insensitively and keeping the first spelling seen, because ``@mira``
    and ``@mira`` in one comment are one mention of one agent, and the notification
    engine dedupes the same way.
    """
    seen: dict[str, str] = {}
    for token in extract_mentions(text):
        seen.setdefault(token["handle"].lower(), token["handle"])
    return list(seen.values())


def mention_lookup_keys(handle: str) -> list[str]:
    """Lookup keys for one handle, most specific first (``mentionLookupKeys`` in mentions.mjs):
    the handle, and for the email form its local part slugged the way actors are minted."""
    h = (handle or "").lower()
    at = h.find("@")
    if at <= 0:
        return [h] if h else []
    local = re.sub(r"[^a-z0-9]+", "-", h[:at]).strip("-")[:MENTION_HANDLE_MAX]
    return [h, local] if local and local != h else [h]


def parse_issue_refs(text: str) -> list[str]:
    """Every ``#issue-id`` in ``text``, first-seen order, deduped.

    Case-sensitively deduped, unlike mentions: issue ids are matched case-sensitively
    in the first place (see :data:`ISSUE_REF_PATTERN`), so two spellings would be two
    different ids rather than one id written twice.
    """
    return list(dict.fromkeys(match.group(2) for match in ISSUE_REF_PATTERN.finditer(text or "")))


def issue_url(issue_id: str, env: Mapping[str, str] | None = None) -> str:
    """Absolute dashboard link for one issue, fit to hand to a human.

    Built on :func:`public_dashboard_url`, not :func:`dashboard_url`: this string's
    only consumer is a person clicking it, and on a hosted deployment the loopback
    address this process proxies to is not the hostname their browser can reach.

    No percent-encoding, and that is safe rather than sloppy: issue ids match
    ``^[a-z]+-[a-zA-Z0-9._-]+$``, every character of which is already URL-safe. Encoding
    anyway would risk emitting a link that differs byte for byte from the one the UI
    builds for the same issue, which is the sort of divergence nobody notices until two
    links to the same place compare unequal.
    """
    return f"{public_dashboard_url(env)}/{ISSUE_HASH_PATH}{issue_id}"


def issue_refs(text: str, env: Mapping[str, str] | None = None) -> list[IssueRef]:
    """Every ``#issue-id`` in ``text``, paired with a link that opens it."""
    return [IssueRef(issue_id=ref, url=issue_url(ref, env)) for ref in parse_issue_refs(text)]


# =============================================================================
# Matching mentions against the registry
# =============================================================================


def live_actors(db_path: str | None = None) -> list[str]:
    """Every live agent's actor, across every board.

    Cross-board on purpose, matching the contract: an agent registered on one board is
    still the same agent when it is named in a comment on another, and scoping the
    lookup to the board a comment happens to live on would make a real mention read as
    a typo the moment two boards are in play.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    return [agent["actor"] for agent in list_agents(db_path=db_path)]


def live_actor_index(db_path: str | None = None) -> tuple[dict[str, str], bool]:
    """Live actors keyed by lowercase name, and whether the registry answered.

    Returned as a pair rather than raising, because "the registry is unreadable" is not
    a failure of the thing being asked for here — a comment's text is parseable either
    way, and refusing to annotate it would lose information over a condition the caller
    can neither fix nor act on. The flag is how a caller says so honestly instead of
    presenting guesses as facts.

    Built once per batch so annotating fifty comments is one registry open rather than
    fifty.
    """
    try:
        return {actor.lower(): actor for actor in live_actors(db_path)}, True
    except RegistryUnavailableError as exc:
        logger.debug("mention matching has no registry to check against: %s", exc)
        return {}, False


def match_mentions(candidates: Sequence[str], index: Mapping[str, str], verified: bool) -> MentionMatch:
    """Split parsed candidates into ones that name a live actor and ones that do not.

    Matched actors come back in the registry's own spelling, not the comment's. That is
    what makes ``@mira`` and ``@mira`` report identically, and it is the spelling the
    notification row will carry.
    """
    if not verified:
        return MentionMatch(mentioned=list(candidates), unmatched=[], verified=False)

    mentioned: list[str] = []
    unmatched: list[str] = []
    for candidate in candidates:
        found = index.get(candidate.lower())
        if found is None:
            unmatched.append(candidate)
        else:
            mentioned.append(found)
    return MentionMatch(mentioned=mentioned, unmatched=unmatched, verified=True)


def resolve_mentions(text: str, db_path: str | None = None) -> MentionMatch:
    """Parse ``@names`` out of ``text`` and check them against the live registry.

    Short-circuits before touching the registry when there is nothing to check, which
    also means text with no mentions reports ``verified=True`` on a machine with no
    registry at all. That reads oddly out of context and is right in it: there was
    nothing to be unsure about.
    """
    candidates = parse_mentions(text)
    if not candidates:
        return MentionMatch(mentioned=[], unmatched=[], verified=True)
    index, verified = live_actor_index(db_path)
    return match_mentions(candidates, index, verified)


# =============================================================================
# Reading the registry
# =============================================================================


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    """Whether this registry has the named table yet.

    Asked before every notifications read rather than caught afterwards. Catching would
    work, but ``RegistryUnavailableError`` means "the registry is broken" everywhere
    else in this package, and a v2 registry is not broken — it is just older than the
    feature.
    """
    return bool(_query(conn, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)))


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    """Whether this registry's table has the named column yet.

    The same reasoning as :func:`_table_exists`, one level finer. ``handled_at`` arrives
    with schema v4, and a registry written by a dashboard from before the seen/handled
    split has the ``notifications`` table without it — old, not broken. Asked rather than
    caught for the same reason: SQLite's "no such column" would arrive as
    :class:`RegistryUnavailableError`, which everywhere else in this package means the
    registry cannot be read at all, and would send an agent to repair a database that is
    working exactly as its version says it should.

    ``pragma_table_info`` rather than parsing the ``CREATE TABLE`` out of
    ``sqlite_master``: it is the same probe boards/registry.mjs runs to decide whether to
    apply the ALTER, so both runtimes ask the schema the same question.
    """
    return bool(_query(conn, "SELECT name FROM pragma_table_info(?) WHERE name = ?", (table, column)))


def _to_notification(row: sqlite3.Row, env: Mapping[str, str] | None = None) -> NotificationRow:
    """Build a wire row, with the issue link made absolute.

    ``handled_at`` is read off the row where the registry has the column and mirrors
    ``read_at`` where it does not. Derived from the row's own columns rather than from a
    flag threaded down from the caller, so this function cannot come to a different
    conclusion about which schema produced the row than the query that selected it did.
    """
    issue_id = str(row["issue_id"])
    read_at = int(row["read_at"])
    # Bound rather than tested inline: membership on a `sqlite3.Row` itself searches its
    # *values*, so `HANDLED_COLUMN in row` would ask whether some column happens to hold
    # the string "handled_at" — true by accident, never by intent.
    columns = row.keys()
    notification_type = str(row["type"])
    actor = str(row["actor"])
    related_issue = str(row["related_issue"])
    stored_guidance = str(row[GUIDANCE_COLUMN] or "") if GUIDANCE_COLUMN in columns else ""
    return NotificationRow(
        id=str(row["id"]),
        board_id=str(row["board_id"]),
        recipient_actor=str(row["recipient_actor"]),
        type=notification_type,
        issue_id=issue_id,
        issue_title=str(row["issue_title"]),
        actor=actor,
        snippet=str(row["snippet"]),
        related_issue=related_issue,
        created_at=int(row["created_at"]),
        read_at=read_at,
        handled_at=int(row[HANDLED_COLUMN]) if HANDLED_COLUMN in columns else read_at,
        url=issue_url(issue_id, env),
        # One row may stand for a burst of the same event; see the module docstring.
        count=max(1, int(row[COUNT_COLUMN] or 1)) if COUNT_COLUMN in columns else 1,
        # Derived from the row's own fields, so every row speaks the current policy (rows
        # minted under older wording included); the stored text is the fallback for a type
        # this build does not know.
        guidance=guidance_for(notification_type, issue_id, actor, related_issue) or stored_guidance,
        audience=audience_of(notification_type),
    )


def _recipient_scope(actor: str) -> tuple[str, tuple[Any, ...]]:
    """Whose rows an inbox read covers: the one ``WHERE`` clause every listing and count
    goes through, so there is exactly one place that decides it.

    Accounts off (no principal on this call): rows addressed to ``actor``. Accounts on:
    rows minted to any alias of the caller, and only rows whose board the caller may read
    (a row from a board in an unreadable space would leak its ``issue_title``). Because
    the listing, the unhandled count, :func:`unhandled_by_type` and the whoami digest all
    call this, none of them can count a row the caller may not read.
    """
    return _accounts.notification_scope_sql(actor)


def _type_filter(types: Sequence[str] | None) -> tuple[str, tuple[str, ...]]:
    """``AND type IN (...)`` and its parameters, or nothing when no filter was asked.

    Only placeholders are interpolated; the type strings travel as parameters. An empty
    (but given) list matches nothing, like the Node side's ``type IN (NULL)``.
    """
    if types is None:
        return "", ()
    wanted = tuple(dict.fromkeys(str(t) for t in types if str(t)))
    if not wanted:
        return " AND type IN (NULL)", ()
    return f" AND type IN ({', '.join('?' for _ in wanted)})", wanted


def read_notifications(
    actor: str,
    unread_only: bool = True,
    limit: int = DEFAULT_NOTIFICATION_LIMIT,
    db_path: str | None = None,
    env: Mapping[str, str] | None = None,
    types: Sequence[str] | None = None,
) -> tuple[list[NotificationRow], int]:
    """One actor's notifications and its total count of rows still unacknowledged.

    "Unread" on this surface means **not yet handled** — not "no human has looked at it".
    Both the filter and the count are keyed on ``handled_at``, so a row somebody already
    read in the dashboard's bell is still listed and still counted until an agent acks it.
    That is the split working as intended rather than a stale queue; see the module
    docstring for why the alternative is worse.

    The count is deliberately **not** ``len(rows)``. It is every unhandled row for the
    actor on every board, unaffected by ``unread_only`` and unaffected by ``limit`` —
    so "you are seeing 20 of 143" is expressible, and a caller cannot mistake a page
    for the whole inbox.

    Args:
        actor: Recipient. An empty actor has no notifications by definition.
        unread_only: Restrict the listing (never the count) to unhandled rows.
        limit: Page size, clamped to 1..:data:`MAX_NOTIFICATION_LIMIT`.
        db_path: Registry location. Defaults to the resolved registry.
        env: Environment the dashboard origin is read from. Test seam.
        types: Only these notification types in the listing (never the count — that
            stays the whole inbox, as on the Node surfaces). ``None`` lists every type.

    Returns:
        ``(rows, unhandled_count)``, newest first. Empty for an actor with nothing, and
        empty for a registry whose ``notifications`` table has not been created yet. On a
        pre-v4 registry the pair means exactly what it meant before the split, because
        there ``read_at`` *was* both answers.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable. A registry
            that exists but predates the table — or predates ``handled_at`` — is not this
            case; see the module docstring.
    """
    if not actor:
        return [], 0

    capped = max(1, min(int(limit), MAX_NOTIFICATION_LIMIT))
    conn = _connect(db_path)
    try:
        if not _table_exists(conn, NOTIFICATIONS_TABLE):
            return [], 0

        # Which timestamp this queue is keyed on, decided by what the registry actually
        # has rather than by what its version stamp claims. Where the split has not
        # arrived, `read_at` carried both meanings and is therefore the honest fallback
        # — filtering on a column that is not there would turn an old registry into a
        # broken one.
        split = _column_exists(conn, NOTIFICATIONS_TABLE, HANDLED_COLUMN)
        queue = HANDLED_COLUMN if split else SEEN_COLUMN
        collapse = split and _column_exists(conn, NOTIFICATIONS_TABLE, COUNT_COLUMN)
        columns = (
            _NOTIFICATION_COLUMNS_WITH_COLLAPSE
            if collapse
            else _NOTIFICATION_COLUMNS_WITH_HANDLED
            if split
            else _NOTIFICATION_COLUMNS
        )

        scope_sql, scope_args = _recipient_scope(actor)
        type_sql, type_params = _type_filter(types)
        where = scope_sql + (f" AND {queue} = 0" if unread_only else "") + type_sql
        rows = _query(
            conn,
            f"SELECT {columns} FROM {NOTIFICATIONS_TABLE} WHERE {where} ORDER BY created_at DESC, id DESC LIMIT ?",
            (*scope_args, *type_params, capped),
        )
        counted = _query(
            conn,
            f"SELECT COUNT(*) AS unread FROM {NOTIFICATIONS_TABLE} WHERE {scope_sql} AND {queue} = 0",
            scope_args,
        )
        unread = int(counted[0]["unread"]) if counted else 0
        return [_to_notification(row, env) for row in rows], unread
    finally:
        conn.close()


def unhandled_by_type(actor: str, db_path: str | None = None) -> dict[str, int]:
    """Unacknowledged rows per type — the one-line digest read at session start.

    ``{"work_overlap": 2, "mention": 1}`` tells an agent what kind of inbox it has before
    it pages through it. Keyed on the same queue :func:`read_notifications` counts, with
    the same fallbacks: empty for an unknown actor or a registry without the table, and
    keyed on ``read_at`` where ``handled_at`` has not arrived.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    if not actor:
        return {}
    conn = _connect(db_path)
    try:
        if not _table_exists(conn, NOTIFICATIONS_TABLE):
            return {}
        queue = HANDLED_COLUMN if _column_exists(conn, NOTIFICATIONS_TABLE, HANDLED_COLUMN) else SEEN_COLUMN
        scope_sql, scope_args = _recipient_scope(actor)
        rows = _query(
            conn,
            f"SELECT type, COUNT(*) AS n FROM {NOTIFICATIONS_TABLE} "
            f"WHERE {scope_sql} AND {queue} = 0 GROUP BY type",
            scope_args,
        )
        counts = {str(row["type"]): int(row["n"]) for row in rows}
        # Engine priority order, so the digest reads most-specific first.
        order = {name: index for index, name in enumerate(NOTIFICATION_TYPES)}
        return dict(sorted(counts.items(), key=lambda item: (order.get(item[0], len(order)), item[0])))
    finally:
        conn.close()


def with_inbox_digest(whoami: dict[str, Any], db_path: str | None = None) -> dict[str, Any]:
    """``agent_whoami``'s payload plus an ``inbox`` digest when something is waiting.

    Added beside whoami rather than inside it (agents.py), so the identity code stays
    untouched: the actor is read off whoami's own ``identity``, and a rejected credential
    or an anonymous caller gets nothing added.
    """
    identity = whoami.get("identity")
    if whoami.get("credential_rejected") or not isinstance(identity, Mapping):
        return whoami
    actor = str(identity.get("actor") or "")
    digest = inbox_digest(actor, db_path) if actor else None
    if digest is not None:
        whoami["inbox"] = digest
    return whoami


def inbox_digest(actor: str, db_path: str | None = None) -> dict[str, Any] | None:
    """What ``agent_whoami`` says about the caller's inbox, or ``None`` when empty.

    Additive and best-effort: an unreadable registry or an empty inbox yields ``None`` so
    whoami's own answer is never displaced by an inbox problem.
    """
    try:
        by_type = unhandled_by_type(actor, db_path)
    except RegistryUnavailableError:
        return None
    total = sum(by_type.values())
    if total == 0:
        return None
    summary = ", ".join(f"{count} {name}" for name, count in by_type.items())
    mentions = int(by_type.get("mention", 0))
    lead = (
        f"{mentions} unread @mention(s) first: call notifications(view='mentions'), read each item and "
        "reply there with @<who mentioned you> when useful, then ack. "
        if mentions
        else ""
    )
    # `unread_mentions` leads: mentions are other people's agents talking to you.
    return {
        "unread_mentions": mentions,
        "unhandled_count": total,
        "unhandled_by_type": by_type,
        "hint": (
            f"{lead}{total} notification(s) waiting on you ({summary}). Call notifications() next; "
            "each row says who to @mention and what to do. Coordinate, don't block."
        ),
    }


def _to_user(agent: AgentRow, include_revoked: bool) -> RevokedUserRow:
    """Project a registry row onto the directory's narrower shape."""
    user = RevokedUserRow(
        actor=agent["actor"],
        display_name=agent["display_name"],
        role=agent["role"],
        kind=agent["kind"],
        board_id=agent["board_id"],
        registered_at=agent["registered_at"],
        last_seen_at=agent["last_seen_at"],
    )
    if include_revoked:
        user["revoked_at"] = agent["revoked_at"]
    return user


def list_users(include_revoked: bool = False, db_path: str | None = None) -> list[RevokedUserRow]:
    """The directory of registered actors, across every board.

    Built on :func:`beads_mcp.agents.list_agents` rather than on its own query, so the
    directory and the roster cannot come to different answers about who is live or list
    the same people in a different order. What differs is the projection — see
    :class:`UserRow` — and the authorization, which is the caller's to apply.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    return [
        _to_user(agent, include_revoked)
        for agent in list_agents(board_id="", include_revoked=include_revoked, db_path=db_path)
    ]


# =============================================================================
# Acknowledging, by asking the dashboard
# =============================================================================

# The dashboard route this proxies. Contract: body `{ids?, all?, actor?}`, answer
# `{ok, acked, unread_count, unhandled_count}`, `401 {ok: false, error: 'not_identified'}`
# when the caller could not be established.
#
# This route acks in **handled** mode — it is the agents' door, and an ack arriving here
# is an agent saying it answered. `unhandled_count` is what is left to answer and is the
# number this surface reports; `unread_count` is the browser bell's own tally, which the
# route still returns because the same handler serves the dashboard. A dashboard older
# than the split sends only `unread_count`, which is why the read below falls back rather
# than requiring the newer field.
ACK_PATH = "/api/notifications/ack"

# Same reasoning as SIGNUP_TIMEOUT_SECONDS: a hung dashboard must not hang the tool
# call, and this route is two SQLite statements behind an express handler.
ACK_TIMEOUT_SECONDS = 10.0
_SSO_EMAIL_PATTERN = re.compile(r"^[^@\s]+@example\.com$", re.IGNORECASE)
_SSO_SECRET_HEX_PATTERN = re.compile(r"^(?:[0-9a-fA-F]{2})+$")
_SSO_SECRET_BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
_SSO_SECRET_MIN_BYTES = 32
_NATIVE_CREDENTIAL_PATTERN = re.compile(r"fdsa_[A-Za-z0-9_-]+")

# Not about the dashboard, which answers in a few dozen bytes. It is about
# FEADS_DASHBOARD_URL pointing at something else entirely, where an unbounded read is
# how a tool call never returns.
_MAX_BODY_BYTES = 64 * 1024

AckFailureCode = Literal[
    "not_identified",
    "nothing_to_ack",
    "bad_request",
    "dashboard_unreachable",
    "unexpected_response",
]


class DashboardUnreachableError(RuntimeError):
    """Nothing answered at the ack endpoint.

    Distinct from every HTTP status including 5xx, for the reason
    :class:`beads_mcp.signup.DashboardUnreachableError` gives: "the dashboard is down"
    and "the dashboard refused you" need different words in front of an agent.

    Declared here rather than imported from :mod:`beads_mcp.signup` only to keep the
    import graph acyclic — ``signup`` imports :mod:`beads_mcp.tools`, and ``tools``
    imports this module to annotate comments.
    """


def _read_body(status: int, response: Any) -> tuple[int, Any, str]:
    """Read a response into ``(status, parsed_json_or_None, raw_text)``.

    A non-JSON body is a diagnosis rather than an error — almost always that
    ``FEADS_DASHBOARD_URL`` points at something that is not the feads dashboard — so
    the raw text survives to be reported instead of being lost to a parse exception.
    """
    raw = response.read(_MAX_BODY_BYTES).decode("utf-8", errors="replace")
    if not raw.strip():
        return status, None, raw
    try:
        return status, json.loads(raw), raw
    except ValueError:
        return status, None, raw


def _post_ack(url: str, request_body: Mapping[str, Any], token: str = "") -> tuple[int, Any, str]:
    """POST the ack and return its status and body.

    ``urllib.request`` rather than ``httpx``, for the reason spelled out in
    :func:`beads_mcp.signup._post_signup`: httpx is present only as a transitive
    dependency of fastmcp, and building a runtime path on an undeclared dependency is
    how a future fastmcp release removes it from under us.

    Raises:
        DashboardUnreachableError: If nothing answered.
    """
    headers = {"content-type": "application/json", "accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = Request(
        url,
        data=json.dumps(dict(request_body)).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urlopen(request, timeout=ACK_TIMEOUT_SECONDS) as response:
            return _read_body(int(response.status), response)
    except HTTPError as error:
        # An HTTPError *is* the response — urllib raises on 4xx/5xx and the body it
        # carries holds the endpoint's own error code. Caught before OSError because
        # HTTPError is a URLError is an OSError.
        with error:
            return _read_body(int(error.code), error)
    except OSError as error:
        raise DashboardUnreachableError(f"{type(error).__name__}: {error}") from error


def _contains_native_credential(value: Any) -> bool:
    """Reject credential-shaped material from an internal route response."""
    if isinstance(value, str):
        return _NATIVE_CREDENTIAL_PATTERN.search(value) is not None
    if isinstance(value, Mapping):
        return any(
            (isinstance(key, str) and "token" in key.casefold()) or _contains_native_credential(nested)
            for key, nested in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(_contains_native_credential(item) for item in value)
    return False


def _valid_sso_internal_secret(secret: str) -> bool:
    """Match the Node silo secret contract without exposing the secret."""
    if _SSO_SECRET_HEX_PATTERN.fullmatch(secret) and len(secret) >= _SSO_SECRET_MIN_BYTES * 2:
        return True
    if not _SSO_SECRET_BASE64URL_PATTERN.fullmatch(secret) or len(secret) < 43:
        return False
    try:
        decoded = base64.urlsafe_b64decode(secret + "=" * (-len(secret) % 4))
    except (ValueError, binascii.Error):
        return False
    return (
        len(decoded) >= _SSO_SECRET_MIN_BYTES and base64.urlsafe_b64encode(decoded).decode().rstrip("=") == secret
    )


def _native_sso_credentials(env: Mapping[str, str] | None = None) -> None:
    """No trusted edge identity or hosted SSO provider ships with this release."""
    return None


# Accounts mode, base instance: the MCP-edge user's ack door (ui/server/accounts-internal-
# edge.js). Loopback + the per-boot accounts internal secret; the dashboard
# re-resolves the email through the roster gate and acks with that person's own scope.
ACCOUNTS_INTERNAL_ACK_PATH = "/api/accounts/internal/notifications/ack"


def _post_accounts_internal_ack(
    url: str, request_body: Mapping[str, Any], email: str, secret: str
) -> tuple[int, Any, str]:
    """POST an MCP-edge ack through the accounts internal door; never a bearer or actor."""
    body = {k: v for k, v in request_body.items() if k in ("ids", "all")}
    body["email"] = email
    request = Request(
        url,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            _accounts.ACCOUNTS_INTERNAL_HEADER: secret,
        },
    )
    try:
        with urlopen(request, timeout=ACK_TIMEOUT_SECONDS) as response:
            return _read_body(int(response.status), response)
    except HTTPError as error:
        with error:
            return _read_body(int(error.code), error)
    except OSError as error:
        raise DashboardUnreachableError(f"{type(error).__name__}") from error


def _post_sso_ack(
    url: str,
    request_body: Mapping[str, Any],
    email: str,
    secret: str,
) -> tuple[int, Any, str]:
    """POST an ack through the internal SSO door, never with bearer/actor data."""
    body = dict(request_body)
    body["sso_email"] = email
    request = Request(
        url,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "X-Feads-Sso-Internal": secret,
        },
    )
    try:
        with urlopen(request, timeout=ACK_TIMEOUT_SECONDS) as response:
            return _read_body(int(response.status), response)
    except HTTPError as error:
        with error:
            return _read_body(int(error.code), error)
    except OSError as error:
        raise DashboardUnreachableError(f"{type(error).__name__}") from error


def _endpoint_error(body: Mapping[str, Any]) -> tuple[str, str]:
    """Pull a code and a message out of whichever error envelope arrived.

    Two shapes are in play across the dashboard's routes: ``{error: 'not_identified'}``
    (this route) and ``{error: {code, message}}`` (the sign-up route). Reading both
    costs four lines and means a route that later adopts the richer envelope does not
    silently start reporting ``http_401``.
    """
    error = body.get("error")
    if isinstance(error, Mapping):
        return str(error.get("code") or ""), str(error.get("message") or "")
    if error:
        return str(error), str(error)
    return "", ""


# What to do about each failure, written as the next move rather than as a restatement
# of the error — the same split :mod:`beads_mcp.signup` makes, and for the same reason:
# the endpoint's own message says what happened, and it is answering a browser.
_ACK_HINTS: dict[str, str] = {
    "not_identified": (
        "Acknowledging is per-actor, so the dashboard has to know which actor you are. "
        "Over HTTP that means the `Authorization: Bearer <token>` header on this call; on "
        "stdio it means this server could resolve your identity from its environment."
    ),
    "nothing_to_ack": (
        "Pass the ids you have read — notifications_ack(ids=['n_ab12', ...]) — or "
        "notifications_ack(all=True) to clear the whole inbox. Calling it with neither "
        "would have acknowledged nothing."
    ),
    "bad_request": (
        "The dashboard rejected the request itself. Check that every id came from a "
        "notifications() result: only rows addressed to you can be acknowledged, and ids "
        "from another actor's inbox are not yours to clear."
    ),
    "unexpected_response": (
        f"Something answered, but it was not the feads dashboard, so ${DASHBOARD_URL_ENV} is "
        "probably pointing at the wrong port. Ask your human which port the feads dashboard "
        "is on."
    ),
}


# =============================================================================
# Tool payloads
# =============================================================================
# Shaped here rather than in server.py so the JSON an agent sees can be asserted on
# without standing up an MCP client — the same split boards.py and agents.py make.


def users_list_payload(
    include_revoked: bool = False,
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
) -> dict[str, Any]:
    """Build the ``users_list`` tool result — the directory of who you can ``@mention``.

    **An unidentified caller gets nothing**, and that is the same line ``agents_list``
    draws: who else is registered is administrative data, so it does not come with
    read-only board access. It also happens to be the honest answer here, because the
    directory exists to be used — and an agent with no identity cannot be mentioned
    back, cannot receive the notification a mention produces, and so has nothing to do
    with a list of people to address. The hint says how to stop being that caller.

    A rejected credential is refused on the same branch rather than being treated as
    anonymous, for the reason :func:`beads_mcp.agents.resolve_identity` gives at
    length: letting a revoked agent fall back to the anonymous path is how revocation
    comes to *increase* what an agent can see.

    Args:
        include_revoked: Include revoked agents, each carrying ``revoked_at``. Useful
            for reading old comments, where a ``@name`` may belong to someone who has
            since been revoked.
        env: Environment to resolve identity from. Test seam.
        db_path: Registry to read. Test seam.

    Returns:
        ``{registry_path, users, count}``; plus ``reason`` and ``hint`` when the caller
        has no identity, or ``error`` and ``hint`` when the registry cannot be read.
    """
    resolved = resolve_identity(env, db_path)
    payload: dict[str, Any] = {
        "registry_path": registry_location(db_path),
        "users": [],
        "count": 0,
    }

    if resolved["mode"] in ("anonymous", "rejected"):
        payload["reason"] = resolved["mode"]
        payload["hint"] = (
            "The directory of actors is for agents that have one. You have no identity, so "
            "there is nobody you could be mentioned back as. " + how_to_get_a_credential(env)
        )
        return payload

    try:
        users = list_users(include_revoked, db_path)
    except RegistryUnavailableError as exc:
        payload["error"] = str(exc)
        payload["hint"] = (
            "No registry means nobody is registered, so there is nobody to @mention yet. "
            + how_to_get_a_credential(env)
        )
        return payload

    payload["users"] = users
    payload["count"] = len(users)
    if not users:
        payload["hint"] = (
            "Nobody is registered, so an @mention in a comment would reach no one. Other "
            "agents can register themselves with agent_signup()."
        )
    return payload


def notifications_payload(
    unread_only: bool = True,
    limit: int = DEFAULT_NOTIFICATION_LIMIT,
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
    types: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Build the ``notifications`` tool result — what happened to your work.

    The recipient is the *acting* identity, resolved exactly as attribution is (see
    :func:`beads_mcp.agents.acting_actor`), and for the same reason: one HTTP server
    serves many agents, so anything read from this process's own environment would
    describe the host rather than the caller, and every agent would be handed the
    host's inbox.

    An unidentified caller therefore gets an empty inbox rather than a refusal.
    Notifications are addressed to an actor; a caller that is not one is not being
    denied anything, it simply has no address. Including the operator on stdio, who is
    unrestricted and still has nothing here.

    ``unread_count`` is the count of rows **nobody has acked**, not of rows nobody has
    looked at. The key keeps its name because the contract locks key names across the ws,
    HTTP and MCP surfaces, and because on this one the two have always meant the same
    thing: what is still owed. So a notification a human already cleared from the
    dashboard's bell is still listed and still counted here — see the module docstring for
    why that is the point rather than a leak.

    Args:
        unread_only: Only rows not yet acknowledged by an agent. The ``unread_count`` is
            unaffected.
        limit: Page size, clamped to 1..:data:`MAX_NOTIFICATION_LIMIT`.
        env: Environment to resolve identity and the dashboard origin from. Test seam.
        db_path: Registry to read. Test seam.
        types: Only these notification types in the listing. ``unread_count`` and
            ``unhandled_by_type`` always describe the whole inbox.

    Returns:
        ``{notifications, unread_count, unhandled_by_type, actor}`` with every ``url``
        absolute, plus a ``hint`` when there is nothing to show and a reason worth naming.
    """
    identity_error = ""
    try:
        # Validate a non-empty silo even for this read surface. Missing identity
        # remains an empty inbox, as the read-only contract allows.
        silo_configured(env)
        actor = acting_actor(env, db_path)
    except ActorResolutionError as exc:
        actor = ""
        identity_error = str(exc)

    payload: dict[str, Any] = {
        "notifications": [],
        "unread_count": 0,
        "unhandled_by_type": {},
        "actor": actor or None,
    }

    if identity_error:
        payload["reason"] = "rejected"
        payload["hint"] = identity_error
        return payload

    if not actor:
        payload["hint"] = (
            "Notifications are addressed to a registered actor, and you are not one — this is "
            "an empty inbox rather than a refusal. " + how_to_get_a_credential(env)
        )
        return payload

    try:
        rows, unread = read_notifications(actor, unread_only, limit, db_path, env, types=types)
        by_type = unhandled_by_type(actor, db_path)
    except RegistryUnavailableError as exc:
        payload["error"] = str(exc)
        payload["hint"] = (
            "The registry could not be read, so nothing can be delivered. This is a setup "
            "problem rather than an empty inbox — ask your human to check the feads registry."
        )
        return payload

    payload["notifications"] = rows
    payload["unread_count"] = unread
    payload["unhandled_by_type"] = by_type

    if rows:
        return payload
    if types is not None and unread:
        payload["hint"] = (
            f"Nothing of type {', '.join(types) or '(none)'} here, but {unread} other notification(s) "
            "are waiting — see unhandled_by_type, or call notifications() without `types`."
        )
        return payload
    # No count is quoted on the unread branch because there is nothing to quote: the
    # listing and the count run the same predicate, so an empty page here means an empty
    # queue. What is worth saying instead is *which* queue was empty, since "nothing
    # unread" reads as "nobody has looked at anything" and means something else here.
    payload["hint"] = (
        "Nothing waiting on you — everything addressed to you has been acknowledged. Pass "
        "unread_only=False to see what you already acked. Note this queue is what agents have "
        "answered rather than what humans have seen: a row your human read in the dashboard's "
        "bell would still be listed here until you ack it."
        if unread_only
        else (
            "Nothing here yet. You are notified when somebody @mentions you in a comment, "
            "assigns you an issue (or reassigns yours away), comments on or moves an issue you "
            "own, changes one you had commented on, closes a blocker one of your issues was "
            "waiting on, files new work under your epic, or declares or claims work overlapping "
            "artifacts you hold."
        )
    )
    return payload


def _ack_refusal(base: dict[str, Any], code: AckFailureCode, reason: str, **extra: Any) -> dict[str, Any]:
    """Assemble a failed ack: the locked keys, plus what happened and what to do next.

    Returned rather than raised, for the reason :func:`beads_mcp.signup._refusal` gives:
    "you are not identified", "you asked for nothing" and "the dashboard is not running"
    are different answers wanting different next moves, and an agent can only branch on
    them if they arrive as data. ``acked`` and ``unread_count`` are still present and
    zero, so a caller reading only those two never has to special-case a failure.
    """
    payload = dict(base)
    payload.update({"ok": False, "acked": 0, "unread_count": 0, "code": code, "reason": reason})
    hint = _ACK_HINTS.get(code)
    if hint:
        payload["hint"] = hint
    payload.update(extra)
    return payload


def notifications_ack_payload(
    ids: Sequence[str] | None = None,
    all: bool = False,  # noqa: A002 — the contract locks this argument name across surfaces
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
) -> dict[str, Any]:
    """Build the ``notifications_ack`` tool result by asking the dashboard to write.

    An ack through here means **handled**: an agent saying it dealt with the row, which is
    a stronger claim than anybody having seen it. The browser's bell is the other half of
    the split and only marks rows *seen* — a human clearing their bell does not clear this
    queue, and nothing an agent does here depends on whether they had. Which is why the
    count that comes back is ``unhandled_count`` under the wire's ``unread_count`` key.

    ## How the dashboard is told who is acking

    Two channels, and which one is used is a property of the transport rather than a
    preference:

    - **Over HTTP**, the caller's own bearer token is relayed. It is the only thing on
      the call that identifies *this* caller, and the dashboard verifies it against the
      registry itself.
    - **On stdio**, there is no bearer to relay, so the resolved actor goes in the body
      and the dashboard's loopback fallback attributes the ack — the same operator-grade
      local trust ``/api/server/restart`` runs on.
    - **In a valid silo with native OAuth**, the worker email goes in ``sso_email`` and
      the per-silo ``X-Feads-Sso-Internal`` secret authenticates the request. No bearer
      token or caller-supplied actor is read or sent; the dashboard derives the actor.
    - **Under accounts mode, for an MCP-edge user** (trusted worker header, no bearer),
      the email goes to the dashboard's loopback accounts-internal ack door with the
      per-boot ``X-Feads-Accounts-Internal`` secret; the dashboard re-resolves the person
      through the roster gate and acks within that person's own scope.

    The actor is **not** sent over HTTP without a bearer, and that asymmetry is a
    security property rather than an oversight. The actor this process could resolve
    from its own environment describes the host that launched it; sending it on behalf
    of an anonymous network caller would let anyone who can reach the MCP port clear the
    host agent's inbox through the loopback fallback.

    Args:
        ids: Notification ids to acknowledge, from a ``notifications()`` result.
        all: Acknowledge every unhandled notification addressed to you.
        env: Environment to resolve identity and the dashboard URL from. Test seam.
        db_path: Registry to resolve identity against. Test seam.

    Returns:
        ``{acked, unread_count}`` on success — ``unread_count`` being what is left
        unhandled — and on failure the same two keys at zero alongside ``code``,
        ``reason`` and ``hint``.
    """
    where = dashboard_url(env)
    url = f"{where}{ACK_PATH}"
    identity_error = ""
    in_silo = False
    native_credentials: tuple[str, str] | None = None
    edge_email = ""
    try:
        in_silo = silo_configured(env)
        edge_email = "" if in_silo else accounts_edge_email(env, db_path)
        if edge_email:
            # Accounts mode, MCP edge: no bearer exists on this path (the Worker strips
            # it), so the dashboard is asked through its loopback internal door with the
            # email this request was resolved from. Never an actor in the body.
            url = f"{where}{ACCOUNTS_INTERNAL_ACK_PATH}"
            source = os.environ if env is None else env
            secret = str(source.get(_accounts.ACCOUNTS_INTERNAL_SECRET_ENV, "") or "")
            native_credentials = (edge_email, secret.strip())
            actor = acting_actor(env, db_path)
            if len(native_credentials[1]) < 32:
                identity_error = "the dashboard's accounts internal door is not configured on this server"
            token = ""
        elif in_silo:
            # Native OAuth has its own private door. Never inspect or relay a bearer
            # token, and never turn a locally resolved actor into request authority.
            native_credentials = _native_sso_credentials(env)
            actor = ""
            if native_credentials is None:
                identity_error = "native silo SSO credentials were not available"
            token = ""
        else:
            token = bearer_token()
            actor = acting_actor(env, db_path)
    except ActorResolutionError as exc:
        actor = ""
        token = ""
        identity_error = str(exc)
    # See the docstring: over HTTP the body must never speak for an actor the caller did
    # not authenticate as. Silo requests use only ``sso_email`` below.
    body_actor = "" if (in_silo or edge_email or token or serving_http()) else actor

    wanted = [str(entry).strip() for entry in (ids or []) if str(entry).strip()]

    # Reported on every outcome, success included. "Which dashboard did this talk to"
    # is the first thing to check when the answer is surprising, and an agent cannot
    # read this server's environment to find out.
    base: dict[str, Any] = {"dashboard_url": where, "ack_url": url, "actor": actor or None}

    # Identity first, before the socket — the ordering signup.py argues for. A caller
    # with nothing to present would be refused by the dashboard anyway; refusing here
    # makes the refusal correct with the dashboard stopped, and keeps an unauthenticated
    # attempt out of its log.
    if identity_error:
        return _ack_refusal(base, "not_identified", identity_error)

    if not in_silo and not edge_email and not token and not body_actor:
        return _ack_refusal(
            base,
            "not_identified",
            "no credential to present: this call carries no bearer token and no actor could be resolved for it",
            hint="Notifications are addressed to a registered actor. " + how_to_get_a_credential(env),
        )

    if not wanted and not all:
        return _ack_refusal(base, "nothing_to_ack", "neither ids nor all=True was given")

    request_body: dict[str, Any] = {}
    if wanted:
        request_body["ids"] = wanted
    if all:
        request_body["all"] = True
    if body_actor:
        request_body["actor"] = body_actor

    try:
        if edge_email:
            assert native_credentials is not None
            status, body, raw = _post_accounts_internal_ack(url, request_body, *native_credentials)
        elif in_silo:
            assert native_credentials is not None
            status, body, raw = _post_sso_ack(url, request_body, *native_credentials)
        else:
            status, body, raw = _post_ack(url, request_body, token)
    except DashboardUnreachableError as error:
        logger.info("notifications ack could not reach %s: %s", url, error)
        return _ack_refusal(
            base,
            "dashboard_unreachable",
            f"nothing answered at {url} ({error})",
            # Named here rather than in `_ACK_HINTS` because it is the one hint that has
            # to carry the URL — "the dashboard" without saying *which* dashboard is what
            # makes this failure read as a refusal.
            hint=(
                f"The feads dashboard is not running at {where}, or is running somewhere else. "
                "Your request was fine and nothing was acknowledged, so it is safe to retry once "
                f"it is up (`make run`), or ask your human to set ${DASHBOARD_URL_ENV} on this "
                "server if the dashboard is on another port."
            ),
        )

    if not isinstance(body, Mapping):
        reason = (
            f"HTTP {status} from {url} with an unexpected response"
            if in_silo
            else f"HTTP {status} from {url} with a body that is not the JSON this endpoint returns: {raw[:200]!r}"
        )
        return _ack_refusal(base, "unexpected_response", reason, status=status)

    if status >= 400 or body.get("ok") is False:
        if in_silo:
            code = "not_identified" if status == 401 else "forbidden" if status == 403 else f"http_{status}"
            logger.info("native OAuth notification ack refused (HTTP %s)", status)
            return _ack_refusal(
                base,
                code,  # type: ignore[arg-type]
                f"HTTP {status} from {url}",
                status=status,
            )
        code, message = _endpoint_error(body)
        # `http_<status>` for a code this build has not been taught. Deliberately not a
        # friendly synonym: an unfamiliar code should look unfamiliar rather than be
        # folded into one of ours and acted on wrongly.
        resolved_code = code or f"http_{status}"
        logger.info("notifications ack refused: %s (HTTP %s)", resolved_code, status)
        return _ack_refusal(
            base,
            resolved_code,  # type: ignore[arg-type]
            message or f"HTTP {status} from {url}",
            status=status,
        )

    if in_silo and _contains_native_credential(body):
        return _ack_refusal(
            base,
            "unexpected_response",
            f"HTTP {status} from {url} returned credential-shaped data",
            status=status,
        )

    # What is left *unhandled* is this surface's remaining queue, so it is what goes under
    # the wire's `unread_count` key — the key name is locked across surfaces, the number
    # behind it is the one that answers "what do I still owe?". Tested for `is None` rather
    # than truthiness, because a genuine zero is the interesting answer here and `or` would
    # read it as a dashboard that never sent the field.
    unhandled = body.get("unhandled_count")
    remaining = body.get("unread_count") if unhandled is None else unhandled

    payload = dict(base)
    if in_silo and isinstance(body.get("actor"), str):
        # The dashboard's resolver is authoritative for native OAuth attribution.
        payload["actor"] = body["actor"]
    payload.update(
        {
            "ok": True,
            "acked": int(body.get("acked") or 0),
            "unread_count": int(remaining or 0),
        }
    )
    return payload


# =============================================================================
# Enriching comments
# =============================================================================


def caller_mention_context(
    env: Mapping[str, str] | None = None, db_path: str | None = None
) -> tuple[str, list[str], set[str] | None]:
    """``(actor, aliases, directory scope)`` of the caller, for a mention report.

    Read from the identity this call already resolved (``request_principal`` under
    accounts mode), so the report judges self-mentions and directory scope exactly as
    authorization did. Never raises: a caller nobody can identify writes as nobody,
    with an unrestricted scope (accounts off) or none at all.
    """
    try:
        actor = acting_actor(env, db_path)
    except Exception:  # noqa: BLE001 - attribution must not fail a report
        actor = ""
    principal = _accounts.request_principal.get()
    if not principal:
        return actor, [actor] if actor else [], None
    aliases = [str(a) for a in principal.get("aliases") or [] if a]
    try:
        scope = _accounts.directory_actors(principal, db_path)
    except Exception:  # noqa: BLE001 - an unreadable scope names nobody
        scope = set(aliases)
    return actor or str(principal.get("actor") or ""), aliases, scope


def mention_report_for(
    texts: Sequence[tuple[str, str]],
    space: str | None = None,
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
) -> dict[str, Any]:
    """The ``mentions`` report for a write by the current caller (see :mod:`beads_mcp.mentions`)."""
    from beads_mcp.mentions import mention_report

    if not any("@" in (text or "") for _, text in texts):
        return {}
    actor, aliases, scope = caller_mention_context(env, db_path)
    return mention_report(
        texts, space=space, caller_actor=actor, caller_aliases=aliases, scope=scope, db_path=db_path
    )


def comment_enrichment(
    text: str,
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
    space: str | None = None,
) -> str:
    """What ``comment()`` adds to its confirmation, or ``""`` when there is nothing to add.

    Agents @mention each other to coordinate, so the one thing a writer must learn at
    once is whether the mention reached anyone. ``bd`` stores whatever text it is given:
    ``@mira can you look`` succeeds identically whether ``mira`` can receive it or not.
    So this names who was reached (as their person: ``@alex-laptop`` reaches
    ``mira``), and who was not and why — no such handle (with suggestions among people
    you share a space with), or they cannot see this item's space — and ends with the
    same answer as one machine-readable line, ``mentions: {"delivered": [...],
    "not_delivered": [...]}``.

    Refs are rendered as markdown links with absolute URLs, so the line can be pasted
    into a message to a human and still resolve.
    """
    from beads_mcp.mentions import report_lines

    lines: list[str] = []
    report = mention_report_for([("comment", text)], space, env, db_path)
    lines.extend(report_lines(report))

    refs = issue_refs(text, env)
    if refs:
        lines.append("refs: " + ", ".join(f"[#{ref.issue_id}]({ref.url})" for ref in refs))

    if report:
        lines.append("mentions: " + json.dumps(report, separators=(",", ":")))
    return "\n".join(lines)


def enrich_comment_result(
    result: str,
    text: str,
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
    space: str | None = None,
) -> str:
    """``bd``'s confirmation, followed by who was notified and what was linked.

    The confirmation is passed through untouched and always comes first, so a caller
    that only reads the first line — or matches on the old text — sees exactly what it
    saw before.
    """
    extra = comment_enrichment(text, env, db_path, space)
    return f"{result}\n{extra}" if extra else result


def annotate_comments(
    comments: Sequence[Comment],
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
    space: str | None = None,
) -> list[Comment]:
    """Attach ``mentions`` and ``refs`` to each comment that has any.

    Purely additive: both fields default to ``None`` and are set only when something was
    found, so a consumer written before they existed reads the same five fields it
    always did, and one written after can tell "no mentions" from "this comment was
    never annotated".

    ``mentions`` lists the people a comment reached, as their person's handle (an alias
    such as ``@alex-laptop`` reads as ``mira``) and only when they can read the
    item's ``space`` (when known) — the same answer ``comment()`` gave its writer.

    The directory is read once for the whole batch rather than once per comment — an
    issue's history can run to dozens of comments, and the answer cannot change between
    two of them within one call. When it cannot be read, ``mentions`` degrades to the
    raw parsed names; see :class:`MentionMatch`.

    Args:
        comments: Comments to annotate. Mutated in place and returned, since they are
            this call's own objects on the way to a client.
        env: Environment the dashboard origin is read from. Test seam.
        db_path: Registry to match actors against. Test seam.
        space: The item's space, when known (accounts mode).

    Returns:
        The same comments, annotated.
    """
    from beads_mcp.mentions import load_directory, mention_report

    annotated = list(comments)
    if not annotated:
        return annotated

    directory_ok = True
    try:
        load_directory(db_path)
    except (RegistryUnavailableError, sqlite3.Error):
        directory_ok = False
    principal = _accounts.request_principal.get()
    scope: set[str] | None = None
    if principal:
        try:
            scope = _accounts.directory_actors(principal, db_path)
        except Exception:  # noqa: BLE001 - an unreadable scope names nobody
            scope = set()
    for comment in annotated:
        if "@" in comment.text:
            if directory_ok:
                report = mention_report(
                    [("comment", comment.text)],
                    space=space,
                    caller_actor="",
                    scope=scope,
                    db_path=db_path,
                )
                named = list(dict.fromkeys(d["to"] for d in report.get("delivered") or []))
            else:
                named = parse_mentions(comment.text)
            if named:
                comment.mentions = named
        refs = issue_refs(comment.text, env)
        if refs:
            comment.refs = refs
    return annotated


# =============================================================================
# Mentions: the inbox agents check most often
# =============================================================================
# Agents coordinate by @mentioning each other, so "who mentioned me, on what, and is it
# still open" is the question an agent asks at session start, at every phase boundary,
# before claiming and before closing. These make it one cheap call.

MENTION_TEXT_MAX = 2000


def mentioned_issue_ids(env: Mapping[str, str] | None = None, db_path: str | None = None) -> list[str]:
    """Issue ids the caller was @mentioned on, most recent mention first.

    From the inbox (every unhandled mention, plus handled ones until they are pruned
    ~30 days after handling), within the boards the caller may read.
    """
    try:
        actor = acting_actor(env, db_path)
        if not actor:
            return []
        rows, _ = read_notifications(
            actor, unread_only=False, limit=MAX_NOTIFICATION_LIMIT, db_path=db_path, env=env, types=["mention"]
        )
    except (RegistryUnavailableError, ActorResolutionError):
        return []
    return list(dict.fromkeys(row["issue_id"] for row in rows if row["issue_id"]))


def _mentioning_comment(
    row: Mapping[str, Any], comments: Sequence[Mapping[str, Any]], me: set[str], db_path: str | None
) -> str:
    """The full text of the comment that minted a mention row, or ``""`` if unsure.

    The newest comment on the issue, written no later than the row (plus a little
    slack for clock skew), that names one of the reader's handles — the engine mints the
    row on the scan right after the comment lands.
    """
    from beads_mcp.mentions import load_directory

    try:
        directory = load_directory(db_path)
    except (RegistryUnavailableError, sqlite3.Error):
        return ""
    created = int(row.get("created_at") or 0)
    author = directory.resolve(str(row.get("actor") or ""))
    for comment in comments:
        if created and int(comment.get("created_at_ms") or 0) > created + 5000:
            continue
        if author is not None:
            by = directory.resolve(str(comment.get("author") or ""))
            if by is None or by.actor != author.actor:
                continue
        for handle in parse_mentions(str(comment.get("text") or "")):
            person = directory.resolve(handle)
            if person is not None and person.actor.lower() in me:
                text = str(comment.get("text") or "")
                return text if len(text) <= MENTION_TEXT_MAX else text[:MENTION_TEXT_MAX] + "…"
    return ""


def mentions_view(
    payload: Mapping[str, Any], context: Mapping[str, Any] | None = None, db_path: str | None = None
) -> dict[str, Any]:
    """``notifications(view="mentions")``: mention rows grouped by item, open items first.

    Each item: ``issue_id``, ``title``, ``status`` (current, when the store can say),
    ``assignee``, ``url``, ``unhandled`` and ``mentions`` — each with the notification
    ``id`` (for notifications_ack), ``from`` (who to @mention back), ``at``, ``text`` (the
    mentioning comment when it can be found, else the stored snippet) and ``handled``.
    """
    base: dict[str, Any] = {
        "view": "mentions",
        "actor": payload.get("actor"),
        "items": [],
        "unread_mentions": int((payload.get("unhandled_by_type") or {}).get("mention", 0)),
        "unread_count": payload.get("unread_count", 0),
        "unhandled_by_type": payload.get("unhandled_by_type") or {},
    }
    for key in ("reason", "error"):
        if key in payload:
            base[key] = payload[key]
    rows = list(payload.get("notifications") or [])
    if not rows:
        base["hint"] = payload.get("hint") or "No mentions waiting on you."
        return base
    context = context or {}
    issues = context.get("issues") or {}
    comments = context.get("comments") or {}
    me = {str(a).lower() for a in (_accounts.current_aliases() or [payload.get("actor") or ""]) if a}
    groups: dict[str, dict[str, Any]] = {}
    latest: dict[str, int] = {}
    for row in rows:
        issue_id = str(row.get("issue_id") or "")
        current = issues.get(issue_id) or {}
        group = groups.get(issue_id)
        if group is None:
            group = {
                "issue_id": issue_id,
                "title": current.get("title") or row.get("issue_title") or "",
                "status": current.get("status"),
                "assignee": current.get("assignee"),
                "url": row.get("url"),
                "unhandled": 0,
                "mentions": [],
            }
            groups[issue_id] = group
        handled = bool(row.get("handled_at"))
        if not handled:
            group["unhandled"] += 1
        text = _mentioning_comment(row, comments.get(issue_id) or [], me, db_path) or str(row.get("snippet") or "")
        sender = str(row.get("actor") or "")
        group["mentions"].append(
            {
                "id": row.get("id"),
                "from": sender or None,
                "reply_with": f"@{sender}" if sender else None,
                "at": row.get("created_at"),
                "text": text,
                "handled": handled,
            }
        )
        latest[issue_id] = max(latest.get(issue_id, 0), int(row.get("created_at") or 0))
    items = sorted(
        groups.values(),
        key=lambda g: (g.get("status") == "closed", g["unhandled"] == 0, -latest.get(g["issue_id"], 0)),
    )
    base["items"] = items
    base["hint"] = (
        "Read each item, reply in it with @<from> when useful (your answer, or what you are doing "
        "that touches it), then notifications_ack(ids=[...]) what you handled. Coordinate, don't "
        "block: never wait for a reply."
    )
    return base


def unread_mention_count(actor: str, db_path: str | None = None) -> int:
    """Unhandled mention rows for ``actor`` (scoped like every inbox read); 0 on any failure."""
    if not actor:
        return 0
    try:
        return int(unhandled_by_type(actor, db_path).get("mention", 0))
    except (RegistryUnavailableError, sqlite3.Error):
        return 0
