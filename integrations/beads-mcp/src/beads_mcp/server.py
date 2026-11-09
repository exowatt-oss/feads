"""FastMCP server for beads issue tracker.

Context Engineering Optimizations (v0.24.0):
- Lazy tool schema loading via discover_tools() and get_tool_info()
- Minimal issue models for list views (~80% context reduction)
- Result compaction for large queries (>20 issues)
- On-demand full details via show() command

These optimizations reduce context window usage from ~10-50k tokens to ~2-5k tokens,
enabling more efficient agent operation without sacrificing functionality.
"""

import argparse
import asyncio
import atexit
import importlib.metadata
import logging
import os
import signal
import sys
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import suppress
from functools import wraps
from types import FrameType
from typing import Any, TypeVar

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

from beads_mcp import accounts as _accounts
from beads_mcp import pgstore
from beads_mcp.access import decide_access
from beads_mcp.agents import (
    agent_whoami_payload,
    agents_list_payload,
    authorize,
    authorized_mutation_context,
    how_to_get_a_credential,
    list_agents,
    registry_location,
    request_authorization,
    resolve_identity,
    to_roster_row,
)
from beads_mcp.artifacts import (
    ACTIONS,
    INTENTS,
    artifact_add_payload,
    artifact_canon_payload,
    artifact_list_payload,
    artifact_remove_payload,
    artifact_respond_payload,
    artifact_search_payload,
)
from beads_mcp.authz import is_admin as is_tier_admin_agent
from beads_mcp.boards import (
    RegistryUnavailableError,
    board_route_payload,
    board_show_payload,
    boards_list_payload,
    get_board,
)
from beads_mcp.boards_write import (
    board_create_payload,
    board_describe_payload,
    board_register_payload,
    board_repos_add_payload,
    board_repos_remove_payload,
)
from beads_mcp.mention_hint import MentionHintMiddleware
from beads_mcp.mentions import space_of_issue
from beads_mcp.models import (
    BlockedIssue,
    BriefDep,
    BriefIssue,
    Comment,
    CompactedResult,
    DependencyType,
    Issue,
    IssueMinimal,
    IssueStatus,
    IssueType,
    LinkedIssue,
    OperationResult,
    Stats,
)
from beads_mcp.notifications import (
    DEFAULT_NOTIFICATION_LIMIT,
    enrich_comment_result,
    list_users,
    mention_report_for,
    mentioned_issue_ids,
    mentions_view,
    notifications_ack_payload,
    notifications_payload,
    users_list_payload,
    with_inbox_digest,
)
from beads_mcp.signup import (
    agent_delegate_payload,
    agent_signup_payload,
    flare_drop_payload,
    flare_heartbeat_payload,
)
from beads_mcp.silo import configured_silo, validate_silo_slug
from beads_mcp.tools import (
    beads_add_comment,
    beads_add_dependency,
    beads_add_note,
    beads_blocked,
    beads_changes,
    beads_claim_issue,
    beads_close_issue,
    beads_create_issue,
    beads_detect_pollution,
    beads_get_schema_info,
    beads_init,
    beads_inspect_migration,
    beads_list_comments,
    beads_list_issues,
    beads_ready_work,
    beads_remove_dependency,
    beads_reopen_issue,
    beads_repair_deps,
    beads_show_issue,
    beads_stats,
    beads_update_issue,
    beads_validate,
    current_workspace,  # ContextVar for per-request workspace routing
    workspace_was_explicit,  # ContextVar: was that workspace named, or guessed?
)
from beads_mcp.transport import public_dashboard_url, serving_http, set_http_transport
from beads_mcp.workspace import resolve_workspace_root as _shared_resolve_workspace_root

# Setup logging for lifecycle events
logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,  # Ensure logs don't pollute stdio protocol
)

T = TypeVar("T")

# =============================================================================
# Transport defaults
# =============================================================================
# stdio is the default and is what Claude Code launches locally. HTTP is opt-in
# (--http / FEADS_MCP_HTTP=1) for hosting this server next to the backend stack.
# "http" is FastMCP's name for its streamable-HTTP transport; the alias
# "streamable-http" resolves to the same code path in fastmcp 3.4.4.
HTTP_TRANSPORT = "http"
DEFAULT_HTTP_HOST = "127.0.0.1"
# 4141 is the feads UI and 4142 its documented alternate, so the MCP takes 4143.
DEFAULT_HTTP_PORT = 4143
DEFAULT_HTTP_PATH = "/mcp"

# FastMCP puts this value in initialize.result.serverInfo.name. Keep the base
# name stable for existing clients and give each hosted silo a deterministic
# namespace without changing any tool names.
BASE_SERVER_NAME = "feads"


def server_name_for_silo(silo_slug: str | None = None) -> str:
    """Return the safe MCP ``serverInfo.name`` for a base instance or silo.

    ``FEADS_SILO`` is normally populated by the silo manager after the slug has
    passed its catalog/route validation. Revalidate at the Python boundary too:
    a malformed or reserved value must fail closed rather than silently making a
    silo advertise the base namespace.
    """
    validated = validate_silo_slug(silo_slug)
    return BASE_SERVER_NAME if validated is None else f"feads-{validated}"


def _server_name_from_environment() -> str:
    """Resolve the server name from the hosted instance's validated silo env."""
    return server_name_for_silo(configured_silo())


# Global state for cleanup
_cleanup_done = False

# Persistent workspace context (survives across MCP tool calls) — **per client
# session**, not per process. One HTTP daemon serves many agents at once, and a
# workspace default held in process state would let any agent's context(...) move
# every other agent's board out from under it mid-write. The ui/server learned the
# same lesson the hard way (its board selection is per connection for the same
# reason); this is the MCP's version of that fix.
#
# Keyed by FastMCP's session id, which is stable for the life of a client session
# on every transport — the `mcp-session-id` header over streamable HTTP, a UUID
# cached on the session object elsewhere. Outside any session (direct calls in
# tests, startup code) everything falls into one process-wide bucket, which is
# exactly the old behavior and correct for a single-caller world.
#
# Bounded so an HTTP daemon that lives for months does not grow a dict per client
# that ever connected. Eviction is LRU and only ever costs a long-idle session its
# *default* — every tool still accepts workspace_root per call.
_workspace_contexts: OrderedDict[str, dict[str, str]] = OrderedDict()
_PROCESS_SESSION_KEY = "__process__"
_MAX_SESSION_CONTEXTS = 512


def _session_key() -> str:
    """The current client session's identity, or the process bucket.

    The fallback is deliberately narrow. It covers the three ways there is genuinely
    no session to key on — FastMCP absent (ImportError), no request in flight
    (RuntimeError), a context object without the attribute (AttributeError) — and
    nothing else, because every *other* exception swallowed here dropped a session
    into the shared bucket where its context(board=...) becomes everyone's.
    """
    try:
        from fastmcp.server.dependencies import get_context

        return get_context().session_id or _PROCESS_SESSION_KEY
    except (ImportError, RuntimeError, AttributeError) as exc:
        logger.warning(
            "No client session to key workspace context on (%s: %s); falling back to the shared process bucket",
            type(exc).__name__,
            exc,
        )
        return _PROCESS_SESSION_KEY


def _session_context() -> dict[str, str]:
    """This session's workspace context, created on first touch."""
    key = _session_key()
    store = _workspace_contexts.get(key)
    if store is None:
        store = {}
        _workspace_contexts[key] = store
        while len(_workspace_contexts) > _MAX_SESSION_CONTEXTS:
            _workspace_contexts.popitem(last=False)
    else:
        _workspace_contexts.move_to_end(key)
    return store


# =============================================================================
# CONTEXT ENGINEERING: Compaction Settings (Configurable via Environment)
# =============================================================================
# These settings control how large result sets are compacted to prevent context overflow.
# Override via environment variables:
#   BEADS_MCP_COMPACTION_THRESHOLD - Compact results with >N issues (default: 20)
#   BEADS_MCP_PREVIEW_COUNT - Show first N issues in preview (default: 5)


def _get_compaction_settings() -> tuple[int, int]:
    """Load compaction settings from environment or use defaults.

    Returns:
        (threshold, preview_count) tuple
    """
    import os

    threshold = int(os.environ.get("BEADS_MCP_COMPACTION_THRESHOLD", "20"))
    preview_count = int(os.environ.get("BEADS_MCP_PREVIEW_COUNT", "5"))

    # Validate settings
    if threshold < 1:
        raise ValueError("BEADS_MCP_COMPACTION_THRESHOLD must be >= 1")
    if preview_count < 1:
        raise ValueError("BEADS_MCP_PREVIEW_COUNT must be >= 1")
    if preview_count > threshold:
        raise ValueError("BEADS_MCP_PREVIEW_COUNT must be <= BEADS_MCP_COMPACTION_THRESHOLD")

    return threshold, preview_count


COMPACTION_THRESHOLD, PREVIEW_COUNT = _get_compaction_settings()

if os.environ.get("BEADS_MCP_COMPACTION_THRESHOLD"):
    logger.info(f"Using BEADS_MCP_COMPACTION_THRESHOLD={COMPACTION_THRESHOLD}")
if os.environ.get("BEADS_MCP_PREVIEW_COUNT"):
    logger.info(f"Using BEADS_MCP_PREVIEW_COUNT={PREVIEW_COUNT}")

# Create FastMCP server.
#
# `instructions` is the only thing a client is guaranteed to show an agent before it
# calls anything, so it carries what an agent cannot work correctly without: the
# convention (beads, not Markdown), the permission model (because a refusal it does
# not expect reads as a broken tool), and — for a caller with no credential — how to
# get one. That last part is load-bearing: an agent that does not know a dashboard
# exists will conclude the board is read-only and give up, or worse, retry a write
# forever. Assembled at import rather than hard-coded so the dashboard URL comes from
# `beads_mcp.transport.dashboard_url` instead of being restated here and drifting.
#
# Kept short on purpose. This text is prepended to the context of every session that
# connects, so anything a *specific* tool needs belongs in that tool's description,
# reachable through get_tool_info().
mcp = FastMCP(
    name=_server_name_from_environment(),
    instructions=f"""
Feads is a work board for AGENTS that humans can read: epics, work items,
dependencies, comments, @mentions, and artifact claims. The main thing it
solves is people's agents stepping on each other's toes — agents say what they
are doing and @mention each other to agree who takes what. Track real work
here rather than in Markdown TODO lists — the board is what other workers and
your human actually read.

WHEN — default ON for substantial work: anything multi-agent, multi-repo,
multi-phase, shared-path, or shipping a change whose ownership/status another
worker benefits from seeing. Skip it for pure Q&A, a short read-only
investigation, or one isolated trivial edit. Feads is subordinate to the
user's task: auth, routing, bookkeeping, or closure failures never stop
requested work — fail open, always. Startup is bounded to agent_whoami() and
notifications(); do not scan historical work, run stale/dead sweeps, offer
watchers, or repair setup. Never delay subagent launch for Feads.

HOW — one epic per substantial effort (resuming a handed-off effort sets its
open epic in_progress and assigns it to you via update), plus WORK ITEMS for its real phases and
deliverables. File the items when you decompose the work, not after: typically
3–10 children (deps=['parent-child:<epic-id>']), one per wave, workstream, or
shippable step. Epic-only is acceptable solely for genuinely indivisible
single-deliverable work — an epic that ends "0 of 0 tasks" after phased work
means the work went untracked, which is a failure. Keep progress LIVE: mark an
item in_progress when its phase starts and close it the moment its deliverable
lands (close-as-you-go, never one bulk close at the end). Items track
deliverables, not processes: no item per subagent or file chunk, no future
backlog, reminders, speculative follow-ups, or parking/defer items. Assign
every item at creation — to the authenticated creator by default or another
active same-session worker. One bounded similarity search when filing the
epic; link relevant matches and continue immediately — similarity never
blocks, redirects, or waits. Every session-created work item reaches terminal
state before the session ends: completed => close; cannot proceed/not doing =>
close/cancel with an honest reason. An unfinished epic may stay open only with
an owner, a truthful status (blocked on a named wait, deferred if deliberately
paused) and a current [handoff] comment; otherwise close/cancel it. Never set
blocked without naming the actual wait.
Retry closure once, then report the exact failure without blocking delivery.

/no-feads is absolute for the current session: zero Feads requests, including
automatic identity delegation, flares, and heartbeats.

CONTEXT OPTIMIZATION: Use discover_tools() to see available tools (names only),
then get_tool_info(tool_name) for specific tool details. This saves context.

BOARDS AND ROUTING — calls that name an issue id (show, update, close, reopen,
comment, comments, note, dep, and the artifact tools) route by the id's prefix automatically:
answering a mention, closing a child, or filing a child under
parent-child:<epic-id> needs no board selection at all, across boards. Only
id-less calls (create, list, search, similar, ready, stats) need a selected
board: find it with boards_list() or board_route(text=..., repo='owner/name'),
then select once with context(board='<id>') — the switch is yours alone. Board
context is server-side session state: there is nothing to install, create, or
configure on your machine. Choose the board that matches the work. This standalone release has no
hosted spaces or account grants. When routing lacked a repo signal,
board_repos_add() it.

IDENTITY AND ACCESS — The standalone release supports per-agent tokens only.
A registered `user` can read and update boards; an `admin` can also perform
administrative actions. With no identity the stance is operator (local stdio)
or read-only (HTTP). Register once with agent_signup(display_name='<name>')
through the local dashboard at {public_dashboard_url()}. If unreachable, ask
an operator to start the dashboard with `make run`. Keep tokens out of chat.

Refusals ("refused: ... (<reason>)") quote the policy. They are answers,
not outages: never bypass a refusal by switching credentials or boards. Ask
the local operator about access, then continue independent work.

CLAIMS — an active claim held by another agent is real overlap: read the
item, coordinate, or take other work. Reconnects using the same token share
their claims. Use claim(force=True) only to recover your own dead session,
never to displace another agent's work.

THE WORKFLOW reference is https://github.com/exowatt-oss/feads#quickstart. It is
reference material, not a mandatory pre-work fetch or installation gate.

SHIPPING BOUNDARIES — Before shipping, run exactly two bounded, one-shot checks:
implementation → ship and immediately pre-tag. At each, fresh-fetch/read and record the
origin/main SHA and branch relationship without automatic reset/rebase; re-search current
artifact overlap across boards; inspect every active hit with issue show plus comments; record
taking/skipping/waiting and explicit ordering; and add one compact [boundary-check] record.
A failed Feads lookup is unverified: fail open once and never claim success. A real conflict,
divergence, or existing immutable tag is a shipping decision. No polling, stale sweeps,
notification loops, synthetic blockers, or setup gate; use the existing artifact coordination mechanics
and the canonical workflow for detail.

NOTIFICATIONS AND @MENTIONS — @mentions are how agents collaborate. `@handle`
lands in that registered agent's inbox through notifications() (also shown
in the dashboard bell). @mention another agent when your work touches theirs:
an overlap, handoff, duplicate, or reply. Say what you take and leave, e.g.
"@alice I'm taking the dashboard widget in #x1; your #x2 touches the same
file, so I'll leave widget.json to you". Find registered actors through
agents_list(); comment(), create() and update() report delivered and unknown
mentions. Hosted people directories and spaces are unavailable in this build.

Check your mentions often: notifications(view='mentions') at session start
(after agent_whoami()), at every phase boundary or checkpoint, before claiming
or starting an item, and before closing one. Read the item each mention is on,
reply there when useful, then notifications_ack(ids=[...]) what you handled. Any
tool result may end with {{"unread_mentions": n}} — that is the cue to check.
list(mentioned=True) lists this board's items you were mentioned on. The rest of
the inbox (assignments, comments and changes on items you own or commented on,
closed blockers, work_overlap, reassigned_away, status_on_owned, new_in_area;
for an unknown type read its snippet) carries `guidance` naming who to @mention.
Coordinate, never block: none of it is a lock — never wait for a reply; keep
working on what is clearly yours. A human's bell click only marks a row seen; it
stays in your queue until you ack it. `#issue-id` (e.g. #ex-abc) links an issue.
An anonymous caller has an empty inbox and cannot be mentioned back.
""",
)


# Every tool result for an identified caller with unread @mentions carries a one-line
# nudge (see beads_mcp.mention_hint): agents coordinate through mentions, so one must be
# noticed while the agent is still working, not at its next session start.
mcp.add_middleware(MentionHintMiddleware())


@mcp.tool(
    name="changes",
    description=(
        "Read the authenticated cross-board Postgres change feed. Returns complete "
        "issue snapshots with comments, grouped events, next_cursor, and complete. "
        "Use after_cursor for keyset pagination, since/until for time bounds, "
        "boards for an optional board-id filter, and limit up to 500. Pages are capped "
        "by size (fewer than `limit` changes is normal — keep paging on next_cursor until "
        "complete); a single change too large for a page arrives with `truncated` (use "
        "show/comments for the rest). The call answers within ~30s: a timeout error means "
        "nothing was skipped — retry the same after_cursor."
    ),
)
async def changes(
    after_cursor: str | None = None,
    since: str | None = None,
    until: str | None = None,
    boards: list[str] | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """Return cross-board issue snapshots changed in the requested window."""
    try:
        return await beads_changes(
            after_cursor=after_cursor,
            since=since,
            until=until,
            boards=boards,
            limit=limit,
        )
    except (ValueError, RuntimeError) as exc:
        raise ToolError(str(exc)) from exc


def cleanup() -> None:
    """Clean up resources on exit.

    Safe to call multiple times.
    """
    global _cleanup_done

    if _cleanup_done:
        return

    _cleanup_done = True
    logger.info("Cleaning up beads-mcp resources...")
    logger.info("Cleanup complete")


def signal_handler(signum: int, frame: FrameType | None) -> None:
    """Handle termination signals gracefully."""
    sig_name = signal.Signals(signum).name
    logger.info(f"Received {sig_name}, shutting down gracefully...")
    cleanup()
    sys.exit(0)


# Register cleanup handlers
atexit.register(cleanup)
signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

# Get version from package metadata
try:
    __version__ = importlib.metadata.version("beads-mcp")
except importlib.metadata.PackageNotFoundError:
    __version__ = "dev"

logger.info(f"beads-mcp v{__version__} initialized with lifecycle management")


# Issue-id → board routing. Ids are minted as ``<prefix>-<suffix>`` and prefixes are
# unique per board, so a call that names an issue id has already named its board —
# demanding a context() call first was pure friction, and the single loudest complaint
# from live agents. Active only when FEADS_PG_DSN is set: that is the hosted store,
# the one deployment where every board's prefix is recorded and the CWD walk can
# never help. The cache keeps routing at zero queries for the common case; entries
# expire so a just-created board becomes routable without a restart.
_ID_ROUTING_TTL_SECONDS = 60.0
_id_routing_cache: dict[str, Any] = {"at": 0.0, "prefixes": {}, "workspaces": {}}


def _candidate_issue_ids(kwargs: dict[str, Any]) -> list[str]:
    """The issue ids a tool call names, in routing-precedence order.

    ``issue_id`` first — it is the id the call is *about*; ``depends_on_id``,
    ``issue_ids`` and an explicit ``id`` follow. ``deps`` entries come last and are
    parsed as ``type:id`` or a bare id (create's own contract), because a child
    being filed under ``parent-child:<epic>`` has named the epic's board.
    Anything without a hyphen cannot be a minted id and is skipped.
    """
    out: list[str] = []

    def _add(value: Any) -> None:
        if isinstance(value, str) and "-" in value:
            out.append(value)

    _add(kwargs.get("issue_id"))
    _add(kwargs.get("depends_on_id"))
    issue_ids = kwargs.get("issue_ids")
    if isinstance(issue_ids, list):
        for value in issue_ids:
            _add(value)
    _add(kwargs.get("id"))
    deps = kwargs.get("deps")
    if isinstance(deps, list):
        for entry in deps:
            if isinstance(entry, str) and entry:
                _add(entry.rsplit(":", 1)[-1])
    return out


async def _workspace_for_issue_ids(kwargs: dict[str, Any]) -> str | None:
    """Resolve the workspace of the board an issue id names, or None to fall through.

    Longest-prefix match against the store's boards table, so a prefix containing a
    hyphen still wins over a shorter accidental one. A resolved id outranks the
    session's board on purpose: answering a mention or closing a child on another
    board should never require a context switch, and an id whose prefix maps to no
    registered board falls through to exactly the behavior this deployment had
    before. Every failure path returns None — routing is a convenience and must
    fail open, never turn a working call into a broken one.
    """
    if not os.environ.get("FEADS_PG_DSN"):
        return None
    candidates = _candidate_issue_ids(kwargs)
    if not candidates:
        return None
    try:
        now = time.monotonic()
        if now - _id_routing_cache["at"] >= _ID_ROUTING_TTL_SECONDS:
            _id_routing_cache["prefixes"] = await pgstore.list_board_prefixes()
            _id_routing_cache["workspaces"] = {}
            _id_routing_cache["at"] = now
        prefixes: dict[str, str] = _id_routing_cache["prefixes"]
        if not prefixes:
            return None
        for candidate in candidates:
            best: str | None = None
            for prefix in prefixes:
                if candidate.startswith(prefix + "-") and (best is None or len(prefix) > len(best)):
                    best = prefix
            if best is None:
                continue
            board_id = prefixes[best]
            cached = _id_routing_cache["workspaces"].get(board_id)
            if cached is not None:
                return cached or None  # "" records a board that failed to resolve
            resolved = await _resolve_board_workspace(board_id)
            if resolved.startswith("Error:"):
                _id_routing_cache["workspaces"][board_id] = ""
                continue
            _id_routing_cache["workspaces"][board_id] = resolved
            return resolved
    except Exception as exc:  # noqa: BLE001 - routing must fail open, whatever broke
        logger.debug(f"issue-id board routing failed open: {exc}")
    return None


def with_workspace(func: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
    """Decorator to set workspace context for the duration of a tool call.

    Extracts workspace_root parameter from tool call kwargs, resolves it,
    and sets current_workspace ContextVar for the request duration.
    When the call names an issue id and the hosted store knows its prefix, the id's
    own board is used — no prior context() call needed. Falls back to persistent
    context or BEADS_WORKING_DIR otherwise.

    This enables per-request workspace routing for multi-project support.
    """

    @wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> T:
        # Extract workspace_root parameter (if provided)
        workspace_root = kwargs.get("workspace_root")

        # Determine workspace: parameter > the issue id's own board > this
        # session's context > env > None.
        #
        # Also record *how* it was chosen. The first three are the caller naming a
        # board — the parameter directly, an issue id whose prefix is the board's,
        # the session store only ever written by context(board=/workspace_root=) —
        # and a named board that does not exist has to fail loudly. The environment
        # fallback is ambient configuration nobody asked for on this call, so it
        # keeps the forgiving search.
        session = _session_context()
        session_workspace = session.get("BEADS_WORKING_DIR")
        inferred = None if workspace_root else await _workspace_for_issue_ids(kwargs)
        if workspace_root:
            workspace: str | None = workspace_root
            explicit = True
        elif inferred:
            workspace = inferred
            explicit = True
        elif session_workspace:
            workspace = session_workspace
            explicit = session.get("BEADS_WORKSPACE_EXPLICIT") == "1"
        else:
            workspace = os.environ.get("BEADS_WORKING_DIR")
            explicit = False

        # Set ContextVars for this request. Authorization is normally established
        # by ``require_write`` outside this wrapper; read-only tools still get a
        # fresh empty slot so an authorization context from a nested/direct call
        # cannot leak into the next invocation.
        token = current_workspace.set(workspace)
        explicit_token = workspace_was_explicit.set(explicit)
        identity_token = None
        if request_authorization.get() is None:
            identity_token = request_authorization.set(None)

        try:
            # Accounts mode: every issue id the call names must live in a space the
            # caller may read (or write, inside an authorized mutation) — this is what
            # stops a dep, a parent link or a show from reaching across spaces.
            await _enforce_issue_ids(
                kwargs,
                write=authorized_mutation_context() is not None,
                tool=func.__name__,
                target_workspace=workspace,
            )
            # Execute tool with workspace context set
            return await func(*args, **kwargs)
        finally:
            # Always reset ContextVars after tool completes
            current_workspace.reset(token)
            workspace_was_explicit.reset(explicit_token)
            if identity_token is not None:
                request_authorization.reset(identity_token)

    return wrapper


def require_context(func: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
    """Decorator to enforce context has been set before write operations.

    Passes if either:
    - workspace_root was provided on tool call (via ContextVar), OR
    - BEADS_WORKING_DIR is set (from context tool)

    Only enforces if BEADS_REQUIRE_CONTEXT=1 is set in environment.
    This allows backward compatibility while adding safety for multi-repo setups.
    """

    @wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> T:
        # Only enforce if explicitly enabled
        if os.environ.get("BEADS_REQUIRE_CONTEXT") == "1":
            # Check ContextVar or environment
            workspace = current_workspace.get() or os.environ.get("BEADS_WORKING_DIR")
            if not workspace:
                raise ValueError(
                    "No board is selected. Call context(board='<board-id>') once "
                    "(boards_list() shows the candidates), pass workspace_root, or name "
                    "an issue id the call can route by."
                )
        return await func(*args, **kwargs)

    return wrapper


def require_write(func: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
    """Refuse a board mutation from a caller the policy does not let write.

    A decorator rather than a call in each body so the gate cannot be forgotten on a
    tool added later: the mutating tools are exactly the ones wearing this, which is
    also how a reader tells them apart. Deliberately *not* folded into
    ``require_context``, which those same eight tools already carry — that one is
    upstream's workspace-safety check, and merging an authorization gate into it
    would leave the more important of the two invisible under the wrong name.

    Placed above ``with_workspace`` so a refusal costs no filesystem work; nothing in
    the decision depends on which board the call would have touched, since identity
    lives in the registry rather than in a board.

    The cost is one read-only registry open per mutation. That is a file open and one
    indexed lookup in front of a ``bd`` subprocess spawn, so it does not register —
    and resolution has to happen per call regardless, or a revocation would not take
    effect until the server restarted.

    Raises:
        ToolError: If the caller may not write. ``ToolError`` specifically, for the
            reason :func:`_require_delete` gives — FastMCP masks the message of
            anything else, and a refusal an agent cannot read is one it will retry.
    """

    @wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> T:
        # Keep the authorization result in the event-loop context so every bd,
        # PG, artifact, and notification side effect in this invocation consumes
        # the exact same resolved identity. A ContextVar mutation made inside
        # ``asyncio.to_thread`` would not propagate back to this task.
        identity_token = request_authorization.set(None)
        try:
            decision = authorize("write")
            if not decision["allowed"]:
                if "read-only system key" in decision["reason"]:
                    raise ToolError(f"refused: {decision['reason']}")
                raise ToolError(
                    f"refused ({decision['mode']} mode): {decision['reason']} {how_to_get_a_credential()}"
                )
            # Tools without with_workspace (artifact writes, board writes) still name
            # issues and boards; check them here too.
            await _enforce_issue_ids(kwargs, write=True, tool=func.__name__)
            await _enforce_named_board(kwargs, write=True)
            return await func(*args, **kwargs)
        finally:
            request_authorization.reset(identity_token)

    return wrapper


def _find_beads_db(workspace_root: str) -> str | None:
    """Find a SQLite .beads/*.db by walking up from workspace_root.

    Args:
        workspace_root: Starting directory to search from

    Returns:
        Absolute path to first .db file found in .beads/, None otherwise.
        Returns None for Dolt-backed projects (which have no single .db file);
        callers should use _find_beads_project() to detect those.
    """
    import glob

    current = os.path.abspath(workspace_root)

    while True:
        beads_dir = os.path.join(current, ".beads")
        if os.path.isdir(beads_dir):
            # Find any .db file in .beads/
            db_files = glob.glob(os.path.join(beads_dir, "*.db"))
            if db_files:
                return db_files[0]  # Return first .db file found

        parent = os.path.dirname(current)
        if parent == current:  # Reached root
            break
        current = parent

    return None


def _has_beads_project_files(beads_dir: str) -> bool:
    """Whether a ``.beads`` directory holds a database, not just a name.

    Thin re-export of the tools-side check so the registry path, the context path and
    the client path all agree on what "this is a board" means.
    """
    from beads_mcp.tools import _has_beads_project_files as _check

    return _check(beads_dir)


def _find_beads_project_at(workspace_root: str) -> tuple[str, str] | None:
    """Like :func:`_find_beads_project`, but only at this exact root.

    Used where the root was named by the caller: see
    ``tools._resolve_beads_project_at`` for why naming a path has to mean that path.
    """
    from beads_mcp.tools import _resolve_beads_project_at

    project_root = _resolve_beads_project_at(workspace_root)
    if project_root is None:
        return None
    return (project_root, _detect_backend(os.path.join(project_root, ".beads")))


def _find_beads_project(workspace_root: str) -> tuple[str, str] | None:
    """Find a .beads project by walking up from workspace_root.

    Delegates to ``_find_beads_db_in_tree`` so that ``.beads/redirect`` files,
    symlinks, and all backend types are handled identically to the rest of the
    MCP server.

    Returns:
        (project_root, backend) where backend is "sqlite", "dolt-embedded",
        "dolt-server", or "unknown". None if no .beads project is found.
    """
    from beads_mcp.tools import _find_beads_db_in_tree

    project_root = _find_beads_db_in_tree(workspace_root)
    if project_root is None:
        return None
    backend = _detect_backend(os.path.join(project_root, ".beads"))
    return (project_root, backend)


def _detect_backend(beads_dir: str) -> str:
    """Identify the storage backend in a .beads directory."""
    import glob
    import json

    metadata_path = os.path.join(beads_dir, "metadata.json")
    if os.path.isfile(metadata_path):
        try:
            with open(metadata_path) as f:
                meta = json.load(f)
            if isinstance(meta, dict):
                backend = (meta.get("backend") or meta.get("database") or "").lower()
                if backend == "dolt":
                    if (meta.get("dolt_mode") or "").lower() == "embedded":
                        return "dolt-embedded"
                    return "dolt-server"
                if backend == "sqlite":
                    return "sqlite"
        except Exception:
            pass

    if os.path.isdir(os.path.join(beads_dir, "embeddeddolt")):
        return "dolt-embedded"
    if os.path.isdir(os.path.join(beads_dir, "dolt")):
        return "dolt-server"

    for match in glob.glob(os.path.join(beads_dir, "*.db")):
        base = os.path.basename(match)
        if ".backup" not in base and base != "vc.db":
            return "sqlite"

    return "unknown"


def _resolve_workspace_root(path: str) -> str:
    """Resolve workspace root to the repo that owns the active beads workspace."""
    return _shared_resolve_workspace_root(path)


# Register quickstart resource. Static on purpose: the old body proxied the CLI's
# quickstart, which told MCP agents to run local commands none of them have — and
# it needed a bound board before the session had one.
@mcp.resource("beads://quickstart", name="Feads Quickstart Guide")
async def get_quickstart() -> str:
    """The MCP-shaped quickstart: how a session tracks work on this server."""
    return (
        "Feads quickstart (MCP) — a board for agents that humans can read; it exists so "
        "people's agents stop stepping on each other's toes.\n"
        "1. agent_whoami() once, notifications() once (view='mentions' first). No "
        "historical scans. On the hosted instance you act as your human, in their spaces only.\n"
        "2. Substantial work: pick the board — board_route(text=..., repo='owner/name') "
        "or boards_list(), which only offer boards you can access — then "
        "context(board='<id>'). A no-access refusal goes to your human, never around "
        "the policy.\n"
        "3. File one epic, then its work items at decomposition time: typically 3–10 "
        "children via create(deps=['parent-child:<epic-id>']), one per phase/wave/"
        "deliverable, each assigned at creation.\n"
        "4. Keep progress live: claim()/update(status='in_progress') when a phase "
        "starts; close() the moment its deliverable lands. Close-as-you-go. Check "
        "notifications(view='mentions') at each phase boundary, before claiming and before "
        "closing. "
        "'already claimed by <you> (another of your own credentials: ...)' means "
        "coordinate; force=True only for your own dead session.\n"
        "5. Calls that name an issue id (show/update/close/comment/dep/artifact_*) "
        "route by the id's prefix automatically — no board selection needed.\n"
        "6. Comment durable facts on the item. @mention the other person whenever your "
        "work touches theirs (overlap, claim near their work, handoff, duplicate, reply "
        "to their mention) — one handle reaches all their agents; users_list(query=...) "
        "finds it among people who share your space. Never wait for a reply. #issue-id links.\n"
        "7. Before ending: every work item you created is closed or cancelled with an "
        "honest reason; close the epic, or if the effort is unfinished leave it with an "
        "owner, truthful status and a current [handoff]; ack handled notifications.\n"
        "Never file future backlog, reminders, parking/defer items, or one item per "
        "subagent. Fail open: a Feads error never blocks the user's work."
    )


# =============================================================================
# CONTEXT ENGINEERING: Tool Discovery (Lazy Schema Loading)
# =============================================================================
# These tools enable agents to discover available tools without loading full schemas.
# This reduces initial context from ~10-50k tokens to ~500 bytes.

# Tool metadata for discovery (lightweight - just names and brief descriptions)
_TOOL_CATALOG = {
    "ready": "Find tasks ready to work on (no blockers)",
    "list": "List issues with filters (status, priority, type)",
    "changes": "Read authenticated cross-board issue snapshots with keyset pagination",
    "show": "Show full details for a specific issue",
    "create": "Create a new issue (bug, feature, task, epic)",
    "claim": "Atomically claim an issue for work (assignee + in_progress)",
    "update": "Update issue status, priority, or assignee",
    "close": "Close/complete an issue",
    "reopen": "Reopen closed issues",
    "dep": "Add dependency between issues",
    "dep_remove": "Remove a dependency between issues (how you retype a wrong edge)",
    "comment": "Add a comment to an issue (durable, timestamped work record)",
    "comments": "List all comments on an issue",
    "note": "Append a note to an issue's notes field",
    "stats": "Get issue statistics",
    "blocked": "Show blocked issues and what blocks them",
    "context": "Manage this session's workspace context (set, show, init; board='<id>' switches boards)",
    "admin": "Administrative/diagnostic operations (validate, repair, schema, debug, migration, pollution)",
    "boards_list": "List every registered board and what each one is for",
    "board_show": "Show one registered board (repos, description, directories)",
    "board_route": "Rank boards for a task so you file it on the right one",
    "board_repos_add": "Add repos to a board's repo list (targeted, concurrency-safe)",
    "board_repos_remove": "Remove exactly the named repos from a board's list",
    "board_describe": "Update a board's description and/or display name",
    "board_create": "Create a new board for a project directory and register it",
    "board_register": "Register an existing .beads directory as a board",
    "agents_list": "List the agents registered on a board (scoped to what you may see)",
    "agent_whoami": "Report which registered agent you are and what you may do",
    "agent_signup": "Get an agent identity of your own — returns a token once (user tier only)",
    "users_list": "Find the @handle to write: people who share a space with you (query='dana')",
    "notifications": "Your inbox — check at session start, phase boundaries, before claim/close (view='mentions')",
    "notifications_ack": "Mark notifications handled, by id or all of them",
    "artifact_add": "Declare the files, dirs, repos or PRs a bead is working on",
    "artifact_search": "Find which beads claim a path — ask before you edit",
    "artifact_respond": "Answer a bead that claims a path: taking, skipping or waiting",
    "artifact_list": "List what one bead is working on",
    "artifact_remove": "Release artifacts a bead is done with",
    "artifact_canon": "Show the canonical ref for a path or repo",
    "discover_tools": "List available tools (names only)",
    "get_tool_info": "Get detailed info for a specific tool",
}


@mcp.tool(
    name="discover_tools",
    description=(
        "List available Feads tools (names and brief descriptions only). Use get_tool_info() for full details."
    ),
)
async def discover_tools() -> dict[str, Any]:
    """Discover available Feads tools without loading full schemas.

    Returns lightweight tool catalog to minimize context usage.
    Use get_tool_info(tool_name) for full parameter details.

    Context savings: ~500 bytes vs ~10-50k for full schemas.
    """
    return {
        "tools": _TOOL_CATALOG,
        "count": len(_TOOL_CATALOG),
        "hint": "Use get_tool_info('tool_name') for full parameters and usage",
    }


@mcp.tool(
    name="get_tool_info",
    description="Get detailed information about a specific Feads tool including parameters.",
)
async def get_tool_info(tool_name: str) -> dict[str, Any]:
    """Get detailed info for a specific tool.

    Args:
        tool_name: Name of the tool to get info for

    Returns:
        Full tool details including parameters and usage examples
    """
    tool_details = {
        "ready": {
            "name": "ready",
            "description": "Find tasks with no blockers, ready to work on",
            "parameters": {
                "limit": "int (1-100, default 10) - Max issues to return",
                "priority": "int (0-4, optional) - Filter by priority",
                "issue_type": (
                    "str (optional) - Filter by type (task, bug, feature, epic, chore, "
                    "decision, merge-request, or custom)"
                ),
                "assignee": "str (optional) - Filter by assignee",
                "labels": "list[str] (optional) - AND filter: must have ALL labels",
                "labels_any": "list[str] (optional) - OR filter: must have at least one",
                "unassigned": "bool (default false) - Only unassigned issues",
                "sort_policy": "str (optional) - hybrid|priority|oldest",
                "brief": "bool (default false) - Return only {id, title, status, priority}",
                "fields": "list[str] (optional) - Custom field projection",
                "max_description_length": "int (optional) - Truncate descriptions",
                "workspace_root": "str (optional) - Workspace path",
            },
            "returns": "List of ready issues (minimal format for context efficiency)",
            "example": "ready(limit=5, priority=1, unassigned=True)",
        },
        "list": {
            "name": "list",
            "description": "List all issues with optional filters",
            "parameters": {
                "status": "open|in_progress|blocked|deferred|closed or custom (optional)",
                "priority": "int 0-4 (optional)",
                "issue_type": "bug|feature|task|epic|chore|decision or custom (optional)",
                "assignee": "str (optional)",
                "labels": "list[str] (optional) - AND filter: must have ALL labels",
                "labels_any": "list[str] (optional) - OR filter: must have at least one",
                "query": "str (optional) - Search in title (case-insensitive)",
                "unassigned": "bool (default false) - Only unassigned issues",
                "limit": "int (1-100, default 20)",
                "workspace_dir_prefix": "str (optional) - Only issues bound at/below this workspace_dir",
                "brief": "bool (default false) - Return only {id, title, status, priority}",
                "fields": "list[str] (optional) - Custom field projection",
                "max_description_length": "int (optional) - Truncate descriptions",
                "mentioned": "bool (default false) - Only items you were @mentioned on, open ones first",
                "workspace_root": "str (optional)",
            },
            "returns": "List of issues (compacted if >20 results)",
            "example": "list(status='open', labels=['bug'], query='auth')",
        },
        "show": {
            "name": "show",
            "description": "Show full details for a specific issue including dependencies",
            "parameters": {
                "issue_id": "str (required) - e.g., 'bd-a1b2'",
                "brief": "bool (default false) - Return only {id, title, status, priority}",
                "brief_deps": "bool (default false) - Full issue with compact dependencies",
                "fields": "list[str] (optional) - Custom field projection",
                "max_description_length": "int (optional) - Truncate description",
                "workspace_root": "str (optional)",
            },
            "returns": "Full Issue object (or BriefIssue/dict based on params)",
            "example": "show(issue_id='bd-a1b2', brief_deps=True)",
        },
        "create": {
            "name": "create",
            "description": "Create a new issue",
            "parameters": {
                "title": "str (required)",
                "description": "str (default '')",
                "priority": "int 0-4 (default 2)",
                "issue_type": "bug|feature|task|epic|chore|decision or custom (default task)",
                "assignee": "str (optional)",
                "labels": "list[str] (optional)",
                "deps": (
                    "list[str] (optional) - 'type:id' or a bare id. A bare id means "
                    "'blocks'; use 'parent-child:bd-epic' to file a child under an epic"
                ),
                "workspace_dir": "str (optional) - Workspace binding (contract cwd), absolute path",
                "session_id": "str (optional) - Workspace binding: agent session id",
                "host": "str (optional) - Workspace binding: hostname (stdio epics default these; hosted does not)",
                "brief": "bool (default true) - Return OperationResult instead of full Issue",
                "workspace_root": "str (optional)",
            },
            "returns": (
                "OperationResult {id, action, mentions?} or full Issue if brief=False. `mentions` "
                "reports who the description's @mentions reached (delivered / not_delivered with reason)"
            ),
            "example": "create(title='Fix auth bug', priority=1, issue_type='bug')",
        },
        "claim": {
            "name": "claim",
            "description": "Atomically claim an issue for work",
            "parameters": {
                "issue_id": "str (required)",
                "brief": "bool (default true) - Return OperationResult instead of full Issue",
                "workspace_root": "str (optional)",
            },
            "returns": "OperationResult {id, action='claimed'} or full Issue if brief=False",
            "example": "claim(issue_id='bd-a1b2')",
        },
        "update": {
            "name": "update",
            "description": "Update an existing issue",
            "parameters": {
                "issue_id": "str (required)",
                "status": "open|in_progress|blocked|deferred|closed or custom (optional)",
                "priority": "int 0-4 (optional)",
                "assignee": "str (optional)",
                "title": "str (optional)",
                "description": "str (optional)",
                "labels": "list[str] (optional) - replace the full label set; omit to leave unchanged",
                "workspace_dir": "str (optional) - Re-bind: absolute worktree directory",
                "session_id": "str (optional) - Re-bind: agent session id",
                "host": "str (optional) - Re-bind: hostname",
                "brief": "bool (default true) - Return OperationResult instead of full Issue",
                "workspace_root": "str (optional)",
            },
            "returns": "OperationResult {id, action} or full Issue if brief=False",
            "example": "update(issue_id='bd-a1b2', status='blocked')",
        },
        "close": {
            "name": "close",
            "description": "Close/complete an issue",
            "parameters": {
                "issue_id": "str (required)",
                "reason": "str (default 'Completed')",
                "force": "bool (default false) - Bypass only the assignee mismatch guard",
                "brief": "bool (default true) - Return OperationResult instead of full Issue",
                "workspace_root": "str (optional)",
            },
            "returns": "List of OperationResult or full Issues if brief=False",
            "example": "close(issue_id='bd-a1b2', reason='Fixed in PR #123', force=True)",
        },
        "reopen": {
            "name": "reopen",
            "description": "Reopen one or more closed issues",
            "parameters": {
                "issue_ids": "list[str] (required)",
                "reason": "str (optional)",
                "brief": "bool (default true) - Return OperationResult instead of full Issue",
                "workspace_root": "str (optional)",
            },
            "returns": "List of OperationResult or full Issues if brief=False",
            "example": "reopen(issue_ids=['bd-a1b2'], reason='Need more work')",
        },
        "dep": {
            "name": "dep",
            "description": "Add dependency between issues",
            "parameters": {
                "issue_id": "str (required) - Issue that has the dependency",
                "depends_on_id": "str (required) - Issue it depends on",
                "dep_type": "blocks|related|parent-child|discovered-from (default blocks)",
                "workspace_root": "str (optional)",
            },
            "returns": "Confirmation message",
            "example": "dep(issue_id='bd-f1a2', depends_on_id='bd-a1b2', dep_type='blocks')",
        },
        "dep_remove": {
            "name": "dep_remove",
            "description": (
                "Remove a dependency between issues, whatever its type. Pair it with dep() to "
                "retype an edge: dep() refuses to change an existing one"
            ),
            "parameters": {
                "issue_id": "str (required) - Issue that has the dependency",
                "depends_on_id": "str (required) - Issue it depends on",
                "workspace_root": "str (optional)",
            },
            "returns": "Confirmation message",
            "example": "dep_remove(issue_id='bd-f1a2', depends_on_id='bd-a1b2')",
        },
        "comment": {
            "name": "comment",
            "description": (
                "Add a durable, timestamped comment to an issue (a record of work/decisions) — and "
                "the way agents coordinate: @actor (any handle or alias of a person) reaches every "
                "agent of that person (one shared inbox; their human reads along), #issue-id links an issue"
            ),
            "parameters": {
                "issue_id": "str (required)",
                "text": (
                    "str (required) - what changed/was decided/verified. @mention the other person "
                    "whenever your work touches theirs (overlap, claim near their work, handoff, "
                    "duplicate, reply to their mention) — users_list(query=...) finds the handle; "
                    "#issue-id links another issue"
                ),
                "workspace_root": "str (optional)",
            },
            "returns": (
                "Confirmation message, then who each @mention reached (as their person), who it did "
                "not and why (unknown handle with did_you_mean, not in this item's space), each "
                "#issue-id as an absolute markdown link, and a final `mentions: {json}` line "
                "({delivered:[{handle,to,name,kind,self?}], not_delivered:[{handle,reason,...}]})"
            ),
            "example": (
                "comment(issue_id='bd-a1b2', text='@alice I am taking worker.py in #bd-a1b2; "
                "your #bd-c3d4 touches it too, I leave the CLI half to you')"
            ),
        },
        "comments": {
            "name": "comments",
            "description": (
                "List all comments on an issue (show reports comment_count but not the bodies). "
                "Each comment carries the @actors and #issue-ids parsed out of its text"
            ),
            "parameters": {
                "issue_id": "str (required)",
                "workspace_root": "str (optional)",
            },
            "returns": (
                "List of Comment {id, issue_id, author, text, created_at, mentions, refs}. "
                "mentions is the live actors named with @, refs is [{issue_id, url}] with "
                "absolute dashboard links; both are null when the text has none"
            ),
            "example": "comments(issue_id='bd-a1b2')",
        },
        "note": {
            "name": "note",
            "description": "Append a note to an issue's notes field (for a per-turn trail, prefer comment)",
            "parameters": {
                "issue_id": "str (required)",
                "text": "str (required) - note text to append",
                "workspace_root": "str (optional)",
            },
            "returns": "Confirmation message",
            "example": "note(issue_id='bd-a1b2', text='Blocked on upstream PR #56954')",
        },
        "stats": {
            "name": "stats",
            "description": "Get issue statistics",
            "parameters": {"workspace_root": "str (optional)"},
            "returns": "Stats object with counts and metrics",
            "example": "stats()",
        },
        "blocked": {
            "name": "blocked",
            "description": "Show blocked issues and what blocks them",
            "parameters": {
                "brief": "bool (default false) - Return only {id, title, status, priority}",
                "brief_deps": "bool (default false) - Full issues with compact dependencies",
                "workspace_root": "str (optional)",
            },
            "returns": "List of BlockedIssue (or BriefIssue/dict based on params)",
            "example": "blocked(brief=True)",
        },
        "admin": {
            "name": "admin",
            "description": "Administrative and diagnostic operations",
            "parameters": {
                "action": "str (required) - validate|repair|schema|debug|migration|pollution",
                "checks": "str (optional) - For validate: orphans,duplicates,pollution,conflicts",
                "fix_all": "bool (default false) - For validate: auto-fix issues",
                "fix": "bool (default false) - For repair: apply fixes",
                "clean": "bool (default false) - For pollution: delete test issues",
                "workspace_root": "str (optional)",
            },
            "returns": "Dict with operation results (or string for debug)",
            "example": "admin(action='validate', checks='orphans')",
        },
        "context": {
            "name": "context",
            "description": (
                "Manage THIS SESSION's board context — other agents' "
                "sessions keep their own, so switching boards here moves nobody else"
            ),
            "parameters": {
                "action": (
                    "str (optional) - set|show|init (default: show if no args, set if "
                    "workspace_root or board provided)"
                ),
                "workspace_root": "str (optional) - Workspace path for set/init actions",
                "board": (
                    "str (optional) - A registered board id from boards_list(); resolves to that "
                    "board's workspace so 'switch board' is one call"
                ),
                "prefix": "str (optional) - Issue ID prefix for init action",
            },
            "returns": "String with context information or confirmation",
            "example": "context(board='demo')",
        },
        "boards_list": {
            "name": "boards_list",
            "description": "List every registered board with its description and repos",
            "parameters": {},
            "returns": "Dict with registry_path, boards (id, name, description, repos, board_dir), count",
            "example": "boards_list()",
        },
        "board_show": {
            "name": "board_show",
            "description": "Show a single registered board",
            "parameters": {
                "board": "str (required) - Board id, or the path of its .beads directory",
            },
            "returns": "Dict with the board, or an error plus known_boards if it is not registered",
            "example": "board_show(board='Example-Org')",
        },
        "board_route": {
            "name": "board_route",
            "description": "Rank registered boards against a task to decide where to file it",
            "parameters": {
                "text": "str (optional) - Task description; text and/or repo is required",
                "repo": "str (optional) - Repo the task touches (owner/name or bare name)",
                "limit": "int (optional) - Keep only the top N candidates",
            },
            "returns": "Dict with query and candidates (id, name, score, reasons), highest score first",
            "example": "board_route(text='fix relay heartbeat', repo='Example-Org/sample-controller')",
        },
        "board_repos_add": {
            "name": "board_repos_add",
            "description": (
                "Add repos to a board's repo list without touching existing entries — closes the "
                "routing loop after you filed on a board that did not yet list the task's repo. "
                "Write-gated; adds are idempotent and compose under concurrency"
            ),
            "parameters": {
                "board": "str (required) - Board id from boards_list(), or its .beads directory",
                "repos": "list[str] (required) - Repos to add, as owner/name",
            },
            "returns": "Dict with the updated board, or a failure code (board_not_found carries known ids)",
            "example": "board_repos_add(board='lab', repos=['Example-Org/sample-web-ui'])",
        },
        "board_repos_remove": {
            "name": "board_repos_remove",
            "description": (
                "Remove exactly the named repos from a board's list; the rest stay. A repo-less "
                "board remains routable by its description. Write-gated"
            ),
            "parameters": {
                "board": "str (required) - Board id from boards_list(), or its .beads directory",
                "repos": "list[str] (required) - Repos to remove, exactly as listed on the board",
            },
            "returns": "Dict with the updated board and how many entries were removed",
            "example": "board_repos_remove(board='lab', repos=['Example-Org/retired-repo'])",
        },
        "board_describe": {
            "name": "board_describe",
            "description": (
                "Update a board's description and/or display name. The description is what "
                "board_route scores prose against, so write it in the words a task would use. "
                "Write-gated; the board id never changes"
            ),
            "parameters": {
                "board": "str (required) - Board id from boards_list(), or its .beads directory",
                "description": "str (optional) - New description; omit to leave unchanged",
                "name": "str (optional) - New display name; omit to leave unchanged",
                "expected_description": (
                    "str (optional) - The description you last read; the write is "
                    "refused if it changed since (stale-read clobber guard)"
                ),
            },
            "returns": "Dict with the updated board and `previous` (what it replaced)",
            "example": (
                "board_describe(board='lab', description='Prototype experiments and test results')"
            ),
        },
        "board_create": {
            "name": "board_create",
            "description": (
                "Create a board for a project directory (initializes its database if none "
                "exists) and register it. project_dir is on THIS SERVER's filesystem. "
                "Write-gated. Prefer existing boards over minting one per task"
            ),
            "parameters": {
                "project_dir": "str (required) - Server-side project directory",
                "name": "str (required) - Display name; board id derives from it unless id passed",
                "id": "str (optional) - Explicit board id slug",
                "prefix": "str (optional) - Issue id prefix for minted issue ids",
                "description": "str (optional) - What work belongs here (routing signal)",
                "repos": "list[str] (optional) - Repos the board covers, as owner/name",
            },
            "returns": "Dict with the created board and whether a new database was initialized",
            "example": (
                "board_create(project_dir='/srv/boards/exoapp', name='ExoApp Mobile', "
                "repos=['Example-Org/exoapp'])"
            ),
        },
        "board_register": {
            "name": "board_register",
            "description": (
                "Register an existing .beads directory as a board so it appears in boards_list "
                "and board_route. Never touches the board's database. Write-gated. There is no "
                "MCP unregister on purpose — that is an operator move (`feads-board remove`)"
            ),
            "parameters": {
                "board_dir": "str (required) - The .beads directory, on the server's filesystem",
                "name": "str (required) - Display name; board id derives from it unless id passed",
                "id": "str (optional) - Explicit board id slug",
                "workspace": "str (optional) - Project root; defaults to board_dir's parent",
                "description": "str (optional) - What work belongs here (routing signal)",
                "repos": "list[str] (optional) - Repos the board covers, as owner/name",
            },
            "returns": "Dict with the registered board",
            "example": "board_register(board_dir='/srv/boards/exoapp/.beads', name='ExoApp Mobile')",
        },
        "agents_list": {
            "name": "agents_list",
            "description": (
                "List registered agents, narrowed to what you may see: an admin sees every "
                "agent, a user sees only itself"
            ),
            "parameters": {
                "board": "str (optional) - Board id; omit to list agents on every board",
                "include_revoked": "bool (default false) - Include revoked agents (admin scope only)",
            },
            "returns": (
                "Dict with scope (all|self|none), mode (agent|operator|anonymous|rejected), "
                "agents (agent_id, actor, role, board_id, host, last_seen_at), count"
            ),
            "example": "agents_list(board='lab')",
        },
        "agent_whoami": {
            "name": "agent_whoami",
            "description": (
                "Report which registered agent this session is acting as, its tier, and what "
                "it may do — ask before attempting a delete rather than after"
            ),
            "parameters": {},
            "returns": (
                "Dict with identity (agent_id, actor, role, board_id), mode "
                "(agent|operator|anonymous|rejected), stance (operator|read_only|deny), via "
                "(token|session|rejected|none), credential_source "
                "(authorization_header|environment|session|none), permissions, roster_scope, "
                "and a hint on how to obtain a credential when you have none"
            ),
            "example": "agent_whoami()",
        },
        "agent_signup": {
            "name": "agent_signup",
            "description": (
                "Register a new agent identity for yourself and receive its token, once. "
                "Proxies the feads dashboard's sign-up route — so the dashboard has to be "
                "running — and can only ever mint the `user` tier"
            ),
            "parameters": {
                "display_name": "str (required) - A short name for you, e.g. 'laptop-claude'",
                "actor": (
                    "str (optional) - Slug override; the dashboard derives one from the name "
                    "when omitted. There is no `role` parameter: sign-up is `user`-tier only"
                ),
            },
            "returns": (
                "Dict with created (bool). On success: token (shown once), identity, actor, "
                "board_id, mcp_url, next_steps. On failure: code (bad_request|forbidden|"
                "board_unregistered|name_taken|no_registry|registry_failed|token_rejected|"
                "already_identified|dashboard_unreachable|unexpected_response), reason, hint"
            ),
            "example": "agent_signup(display_name='laptop-claude')",
        },
        "users_list": {
            "name": "users_list",
            "description": (
                "Find the @handle to write. One handle reaches every agent of that person. Lists "
                "only people who share a space with you (a mention reaches someone only on items "
                "in a space they can read)"
            ),
            "parameters": {
                "query": "str (optional) - name, handle, alias or email local part, e.g. 'dana'; ranks people",
                "limit": "int (default 25) - Max entries in people",
                "include_revoked": (
                    "bool (default false) - Also list revoked agents in users, each with revoked_at. "
                    "Useful when reading old comments whose @names have since been revoked"
                ),
            },
            "returns": (
                "Dict with people (handle to write, display_name, kind human|service|agent, aliases, "
                "spaces you share; ranked by query), users (per-actor rows: actor, handle, alias_of, "
                "display_name, role, kind, board_id, registered_at, last_seen_at), count and "
                "registry_path. An unidentified caller gets an empty list with reason and a hint"
            ),
            "example": "users_list(query='dana')",
        },
        "notifications": {
            "name": "notifications",
            "description": (
                "Your inbox — how other people's agents reach you. Check it at session start, at "
                "every phase boundary, before claiming and before closing; reply in-thread with "
                "@<sender>, then ack. Never wait for a reply"
            ),
            "parameters": {
                "unread_only": "bool (default true) - Only rows you have not acknowledged yourself",
                "limit": "int (default 20, max 200) - Page size; unread_count is never limited",
                "types": "list[str] (optional) - Only these kinds in the listing; counts stay whole-inbox",
                "view": (
                    "str (optional) - 'mentions': items you were @mentioned on, grouped, open first, "
                    "each mention with its text, who sent it (reply_with) and its id for ack"
                ),
            },
            "returns": (
                "Dict with notifications (id, board_id, type mention|assigned|reassigned_away|"
                "work_overlap|dependency_completed|comment_on_owned|status_on_owned|new_in_area|"
                "update_on_commented, issue_id, issue_title, actor, snippet, related_issue, "
                "created_at, read_at when a human saw it, handled_at when an agent acked it, "
                "absolute url, count of collapsed repeats, guidance — the suggested next step, "
                "audience all|agent), unread_count (rows nobody has acked), unhandled_by_type and actor"
            ),
            "example": "notifications(view='mentions')",
        },
        "notifications_ack": {
            "name": "notifications_ack",
            "description": (
                "Mark notifications handled so the unread count keeps meaning something. Only rows "
                "addressed to you can be acknowledged; a human reading one in the dashboard bell "
                "leaves it in your queue"
            ),
            "parameters": {
                "ids": "list[str] (optional) - Notification ids from a notifications() result",
                "all": "bool (default false) - Acknowledge every unhandled notification of yours",
            },
            "returns": (
                "Dict with acked and unread_count (what is left unhandled after this ack); on "
                "failure the same two at zero plus code (not_identified|nothing_to_ack|bad_request|"
                "dashboard_unreachable|unexpected_response), reason and hint"
            ),
            "example": "notifications_ack(ids=['n_ab12cd34'])",
        },
        "artifact_add": {
            "name": "artifact_add",
            "description": (
                "Declare the files, dirs, repos or PRs a bead is working on. Reports any other "
                "bead already claiming them, which is the point of declaring early"
            ),
            "parameters": {
                "issue_id": "str (required) - Bead to attach to",
                "refs": (
                    "list[str] (required) - Repo-relative refs: owner/repo, owner/repo:path, "
                    "owner/repo:dir/ (subtree), owner/repo#123 (PR). Never a checkout path"
                ),
                "intent": f"str (default editing) - One of: {', '.join(INTENTS)}",
                "note": "str (optional) - Why this bead touches them",
                "board": "str (optional) - Board id or .beads dir; omit for bd's own resolution",
            },
            "returns": "Dict with attached refs and others_claiming (bead, status, relation, intent)",
            "example": "artifact_add(issue_id='ex-dh0', refs=['Example-Org/feads:ui/server/bd.js'])",
        },
        "artifact_search": {
            "name": "artifact_search",
            "description": (
                "Find which beads claim a path, across every registered board. Matches overlaps: "
                "a claimed parent directory or whole repo is a hit, not just an identical path"
            ),
            "parameters": {
                "ref": "str (required) - Ref to look for",
                "board": "str (optional) - Restrict to one board",
                "include_closed": "bool (default false) - Include closed beads",
                "intent": f"str (optional) - Only this intent: {', '.join(INTENTS)}",
                "limit": "int (optional) - Keep only the top N hits",
            },
            "returns": (
                "Dict with query, boards_searched, hits (issue_id, status, relation "
                "exact|inside|covers, artifact), count"
            ),
            "example": "artifact_search(ref='feads:ui/server/bd.js')",
        },
        "artifact_respond": {
            "name": "artifact_respond",
            "description": (
                "Answer beads claiming a path: taking, skipping or waiting. Comments on each, and "
                "for waiting adds a real blocks dependency within the same board"
            ),
            "parameters": {
                "ref": "str (required) - The contested ref",
                "mine": "str (required) - Your bead, the one answering",
                "action": f"str (required) - One of: {', '.join(ACTIONS)}",
                "target_issue": "str (optional) - Answer one bead instead of every overlap",
                "note": "str (optional) - Reason, included in the comment",
                "board": "str (optional) - Board id or .beads dir for your bead",
            },
            "returns": "Dict with recorded_intent and answered (issue_id, dep_added, comment)",
            "example": "artifact_respond(ref='feads:ui/server/bd.js', mine='ex-qtn', action='waiting')",
        },
        "artifact_list": {
            "name": "artifact_list",
            "description": "List what one bead is working on",
            "parameters": {
                "issue_id": "str (required) - Bead to read",
                "board": "str (optional) - Board id or .beads dir",
            },
            "returns": "Dict with the bead and its artifacts (ref, kind, intent, actor, at, note)",
            "example": "artifact_list(issue_id='ex-dh0')",
        },
        "artifact_remove": {
            "name": "artifact_remove",
            "description": "Release artifacts a bead is done with, so nobody waits on a stale claim",
            "parameters": {
                "issue_id": "str (required) - Bead to release from",
                "refs": "list[str] (required) - Refs to release",
                "board": "str (optional) - Board id or .beads dir",
            },
            "returns": "Dict with the released refs",
            "example": "artifact_remove(issue_id='ex-dh0', refs=['feads:ui/server/bd.js'])",
        },
        "artifact_canon": {
            "name": "artifact_canon",
            "description": "Show the canonical ref for a path or repo without touching a bead",
            "parameters": {
                "refs": "list[str] (required) - Refs to canonicalize",
                "board": "str (optional) - Board whose repos win when expanding a bare name",
            },
            "returns": "Dict with each ref's kind, repo, path or pr, and canonical ref",
            "example": "artifact_canon(refs=['feads/ui/server/bd.js'])",
        },
    }

    if tool_name not in tool_details:
        available = list(tool_details.keys())
        return {
            "error": f"Unknown tool: {tool_name}",
            "available_tools": available,
            "hint": "Use discover_tools() to see all available tools",
        }

    return tool_details[tool_name]


# Context management tool - unified set_context, where_am_i, and init
@mcp.tool(
    name="context",
    description="""Manage this session's board context for issue operations. The
context is yours alone: other agents' sessions on this server keep their own, so
switching boards here moves nobody else.
Actions:
- set: Set the workspace root directory, or switch to a registered board by id
  (default when workspace_root or board provided)
- show: Show current workspace context and database path (default when no args)
- init: Initialize beads in workspace_root, or in the workspace already set. This is
  the one action that accepts a directory with no board in it — `set` refuses those,
  because a context pointing at no board sends writes to whatever the environment
  happens to resolve.""",
)
async def context(
    action: str | None = None,
    workspace_root: str | None = None,
    prefix: str | None = None,
    board: str | None = None,
) -> str:
    """Manage this session's board context for issue operations.

    Args:
        action: Action to perform - set, show, or init (inferred if not provided)
        workspace_root: Workspace path for set/init actions
        prefix: Issue ID prefix for init action
        board: A registered board id (or .beads directory) from boards_list();
            an alternative to workspace_root that makes "switch board" one call

    Returns:
        Context information or confirmation message
    """
    # Infer action if not explicitly provided
    if action is None:
        action = "set" if workspace_root is not None or board is not None else "show"

    action = action.lower()

    if action == "set":
        if board is not None and workspace_root is not None:
            return "Error: pass workspace_root or board, not both"
        if board is not None:
            hidden = await _accounts_hidden_board(board)
            if hidden is not None:
                return hidden
            resolved = await _resolve_board_workspace(board)
            if resolved.startswith("Error:"):
                return resolved
            workspace_root = resolved
        elif workspace_root is not None:
            hidden = await _accounts_hidden_board(
                pgstore.board_id_for_workspace(workspace_root), shown=workspace_root
            )
            if hidden is not None:
                return hidden
        if workspace_root is None:
            return "Error: workspace_root or board is required for 'set' action"
        return await _context_set(workspace_root)

    elif action == "show":
        return _context_show()

    elif action == "init":
        # init is the one action that legitimately names a directory with no board in
        # it, so it takes workspace_root directly — 'set' now refuses a boardless
        # workspace, which would otherwise leave bootstrapping with no way in.
        target = (
            workspace_root or _session_context().get("BEADS_WORKING_DIR") or os.environ.get("BEADS_WORKING_DIR")
        )
        if not target:
            return (
                "Error: Context must be set before init.\n"
                "Use context(action='init', workspace_root='/path/to/project'), or "
                "context(action='set', workspace_root='...') first."
            )
        # Routed through the same ContextVars a decorated tool would set, so init
        # creates the board where the caller asked rather than wherever the process
        # environment points.
        token = current_workspace.set(target)
        explicit_token = workspace_was_explicit.set(True)
        try:
            return await beads_init(prefix=prefix)
        finally:
            current_workspace.reset(token)
            workspace_was_explicit.reset(explicit_token)

    else:
        return f"Error: Unknown action '{action}'. Valid actions: set, show, init"


async def _accounts_hidden_board(board: str, shown: str = "") -> str | None:
    """Accounts mode: the one answer for a board the caller cannot read *and* for one
    that does not exist (``None`` when the board is readable, or accounts mode is off).

    Nothing about the board is revealed — not whether it exists, not its space, and
    not the ids of any other board (the not-found answer used to list them all).
    """
    if not await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
        return None
    name = str(board or "").strip()
    board_id = await _registered_board_id(name) if name else ""
    if board_id:
        resolved = await asyncio.to_thread(resolve_identity)
        ok, _reason = await asyncio.to_thread(_accounts.check_board, resolved.get("principal"), board_id, False)
        if ok:
            return None
    return (
        f"Error: no board you can access is named '{shown or name}'. "
        "boards_list() shows the boards you can reach; if the work belongs to a space you "
        "cannot see, tell your human."
    )


async def _resolve_board_workspace(board: str) -> str:
    """Turn a registered board id into the workspace root ``context set`` wants.

    The board's recorded ``workspace_dir`` when it has one, else the parent of its
    ``.beads`` directory — the layout ``bd init`` itself establishes. Errors come
    back as strings starting with ``Error:`` because that is this tool's contract.
    """
    try:
        found = await asyncio.to_thread(get_board, board)
    except RegistryUnavailableError as exc:
        return f"Error: {exc} ({exc.hint})"
    if found is None:
        try:
            from beads_mcp.boards import list_boards

            known = ", ".join(str(b["id"]) for b in await asyncio.to_thread(list_boards)) or "(none)"
        except RegistryUnavailableError:
            known = "(none)"
        return f"Error: no such board: {board}. Registered boards: {known}"

    # Registration is a registry row; it does not prove a database. A board dir that
    # was registered before `bd init` ran (or whose data was moved) resolves to a
    # workspace that looks fine and then routes every write somewhere else — so the
    # marker is checked here, where the id is still in hand to name in the error.
    board_dir = str(found["board_dir"])
    if not _has_beads_project_files(board_dir):
        return (
            f"Error: board '{board}' is registered at {board_dir} but holds no database "
            f"(it was never initialized) — re-create it with board_create, or fix the registration."
        )

    workspace = str(found["workspace_dir"] or "") or os.path.dirname(board_dir)
    return workspace


async def _context_set(workspace_root: str) -> str:
    """Set workspace root directory and discover the beads database."""
    # Resolve to git repo root if possible (run in thread to avoid blocking event loop)
    try:
        resolved_root = await asyncio.wait_for(
            asyncio.to_thread(_resolve_workspace_root, workspace_root),
            timeout=5.0,  # Longer timeout to handle slow git operations
        )
    except asyncio.TimeoutError:
        logger.error(f"Git detection timed out after 5s for: {workspace_root}")
        return (
            f"Error: Git repository detection timed out.\n"
            f"  Provided path: {workspace_root}\n"
            f"  This may indicate a slow filesystem or git configuration issue.\n"
            f"  Please ensure the path is correct and git is responsive."
        )

    # Locate the beads project *at* the resolved root — the caller named this
    # directory, so a board found by walking up from it belongs to somebody else.
    #
    # Nothing is stored before this check. Storing a workspace with no board and
    # answering "Context set successfully ... Database: Not found" was bug feads-9ma:
    # the agent reads the first line, files its work, and bd — with no board at the
    # context it was handed — resolves one from the environment instead. A false
    # acknowledgement is worse than a refusal, because only the refusal gets fixed.
    project = _find_beads_project_at(resolved_root)

    if project is None:
        return (
            f"Error: no beads board at {resolved_root}\n"
            f"  Expected marker: {os.path.join(resolved_root, '.beads')} "
            f"(a directory holding config.yaml, metadata.json, embeddeddolt/ or *.db)\n"
            f"  Requested path: {workspace_root}\n"
            f"  Context was NOT set — a workspace with no board would send writes to "
            f"whichever board the environment resolves.\n"
            f"  Create one with board_create(), or pick an existing board with "
            f"context(board='<id>') / boards_list()."
        )

    project_root, backend = project

    # Store in this session's context (survives across MCP tool calls, invisible
    # to every other session)
    session = _session_context()
    session["BEADS_WORKING_DIR"] = resolved_root
    session["BEADS_CONTEXT_SET"] = "1"
    # This workspace was named, not guessed: `tools._get_client` refuses to search
    # upward from it later, so a board that disappears is an error rather than a
    # silent promotion to the parent repo's board.
    session["BEADS_WORKSPACE_EXPLICIT"] = "1"

    # os.environ is process state, and on an HTTP daemon the process is shared by
    # every connected agent — writing it there would leak one session's board into
    # everyone's fallback path (the exact cross-contamination the per-session
    # store exists to end). On stdio the process *is* the one session, and legacy
    # code paths that read the environment keep working.
    mutate_env = not serving_http()
    if mutate_env:
        os.environ["BEADS_WORKING_DIR"] = resolved_root
        os.environ["BEADS_CONTEXT_SET"] = "1"

    # BEADS_DB only applies to SQLite. Dolt backends use metadata.json,
    # which the bd CLI reads directly.
    if backend == "sqlite":
        db_path = _find_beads_db(project_root)
        if db_path:
            session["BEADS_DB"] = db_path
            if mutate_env:
                os.environ["BEADS_DB"] = db_path
            return f"Context set successfully:\n  Workspace root: {resolved_root}\n  Database: {db_path}"
        else:
            session.pop("BEADS_DB", None)
            if mutate_env:
                os.environ.pop("BEADS_DB", None)
            return (
                f"Context set successfully:\n"
                f"  Workspace root: {resolved_root}\n"
                f"  Database: Not found (run context(action='init') to create)"
            )

    # Dolt or unknown — clear any stale BEADS_DB and report the project root.
    session.pop("BEADS_DB", None)
    if mutate_env:
        os.environ.pop("BEADS_DB", None)
    return (
        f"Context set successfully:\n"
        f"  Workspace root: {resolved_root}\n"
        f"  Project: {os.path.join(project_root, '.beads')} (backend: {backend})"
    )


def _context_show() -> str:
    """Show the current session's workspace context for debugging."""
    session = _session_context()
    context_set = session.get("BEADS_CONTEXT_SET") or os.environ.get("BEADS_CONTEXT_SET")

    if not context_set:
        return (
            "Context not set. Use context(action='set', workspace_root='...') first.\n"
            f"Current process CWD: {os.getcwd()}\n"
            f"BEADS_WORKING_DIR (this session): {session.get('BEADS_WORKING_DIR', 'NOT SET')}\n"
            f"BEADS_WORKING_DIR (env): {os.environ.get('BEADS_WORKING_DIR', 'NOT SET')}\n"
            f"BEADS_DB: {session.get('BEADS_DB') or os.environ.get('BEADS_DB', 'NOT SET')}"
        )

    working_dir = session.get("BEADS_WORKING_DIR") or os.environ.get("BEADS_WORKING_DIR", "NOT SET")
    db_path = session.get("BEADS_DB") or os.environ.get("BEADS_DB", "NOT SET")
    actor = os.environ.get("BEADS_ACTOR", "NOT SET")

    return f"Workspace root: {working_dir}\nDatabase: {db_path}\nActor: {actor}"


# Register all tools
# =============================================================================
# CONTEXT ENGINEERING: Optimized List Tools with Compaction
# =============================================================================


def _to_minimal(issue: Issue) -> IssueMinimal:
    """Convert full Issue to minimal format for context efficiency."""
    return IssueMinimal(
        id=issue.id,
        title=issue.title,
        status=issue.status,
        priority=issue.priority,
        issue_type=issue.issue_type,
        assignee=issue.assignee,
        labels=issue.labels,
        dependency_count=issue.dependency_count,
        dependent_count=issue.dependent_count,
        workspace_dir=issue.workspace_dir,
        session_id=issue.session_id,
        host=issue.host,
    )


def _to_brief(issue: Issue) -> BriefIssue:
    """Convert full Issue to brief format (id, title, status, priority)."""
    return BriefIssue(
        id=issue.id,
        title=issue.title,
        status=issue.status,
        priority=issue.priority,
    )


def _to_brief_dep(linked: LinkedIssue) -> BriefDep:
    """Convert LinkedIssue to brief dependency format."""
    return BriefDep(
        id=linked.id,
        title=linked.title,
        status=linked.status,
        priority=linked.priority,
        dependency_type=linked.dependency_type,
    )


# Valid fields for Issue model (used for field validation)
VALID_ISSUE_FIELDS: set[str] = {
    "id",
    "title",
    "description",
    "design",
    "acceptance_criteria",
    "notes",
    "external_ref",
    "status",
    "priority",
    "issue_type",
    "created_at",
    "updated_at",
    "closed_at",
    "assignee",
    "labels",
    "dependency_count",
    "dependent_count",
    "dependencies",
    "dependents",
    "workspace_dir",
    "session_id",
    "host",
}


def _filter_fields(obj: Issue, fields: list[str]) -> dict[str, Any]:
    """Extract only specified fields from an Issue object.

    Raises:
        ValueError: If any requested field is not a valid Issue field.
    """
    # Validate fields first
    requested = set(fields)
    invalid = requested - VALID_ISSUE_FIELDS
    if invalid:
        raise ValueError(f"Invalid field(s): {sorted(invalid)}. Valid fields: {sorted(VALID_ISSUE_FIELDS)}")

    result: dict[str, Any] = {}
    for field in fields:
        value = getattr(obj, field)
        # Handle nested Pydantic models
        if hasattr(value, "model_dump"):
            result[field] = value.model_dump()
        elif isinstance(value, list) and value and hasattr(value[0], "model_dump"):
            result[field] = [item.model_dump() for item in value]
        else:
            result[field] = value
    return result


def _truncate_description(issue: Issue, max_length: int) -> Issue:
    """Return issue copy with truncated description if needed."""
    if issue.description and len(issue.description) > max_length:
        data = issue.model_dump()
        data["description"] = issue.description[:max_length] + "..."
        return Issue(**data)
    return issue


@mcp.tool(
    name="ready",
    description=(
        "Find tasks that have no blockers and are ready to be worked on. "
        "Returns minimal format for context efficiency."
    ),
)
@with_workspace
async def ready_work(
    limit: int = 10,
    priority: int | None = None,
    issue_type: str | None = None,
    assignee: str | None = None,
    labels: list[str] | None = None,
    labels_any: list[str] | None = None,
    unassigned: bool = False,
    sort_policy: str | None = None,
    workspace_root: str | None = None,
    brief: bool = False,
    fields: list[str] | None = None,
    max_description_length: int | None = None,
) -> list[IssueMinimal] | list[BriefIssue] | list[dict[str, Any]] | CompactedResult:
    """Find issues with no blocking dependencies that are ready to work on.

    Args:
        limit: Maximum issues to return (1-100, default 10)
        priority: Filter by priority level (0-4)
        issue_type: Filter by type (task, bug, feature, epic, chore, decision, merge-request, or custom)
        assignee: Filter by assignee
        labels: Filter by labels (AND: must have ALL specified labels)
        labels_any: Filter by labels (OR: must have at least one)
        unassigned: Filter to only unassigned issues
        sort_policy: Sort policy: hybrid (default), priority, oldest
        workspace_root: Workspace path override
        brief: If True, return only {id, title, status} (~97% smaller)
        fields: Return only specified fields (custom projections)
        max_description_length: Truncate descriptions to this length

    Returns minimal issue format to reduce context usage by ~80%.
    Use show(issue_id) for full details including dependencies.
    """
    issues = await beads_ready_work(
        limit=limit,
        priority=priority,
        issue_type=issue_type,
        assignee=assignee,
        labels=labels,
        labels_any=labels_any,
        unassigned=unassigned,
        sort_policy=sort_policy,
    )

    # Apply description truncation first
    if max_description_length:
        issues = [_truncate_description(i, max_description_length) for i in issues]

    # Return brief format if requested
    if brief:
        return [_to_brief(issue) for issue in issues]

    # Return specific fields if requested
    if fields:
        return [_filter_fields(issue, fields) for issue in issues]

    # Default: minimal format with compaction
    minimal_issues = [_to_minimal(issue) for issue in issues]

    # Apply compaction if over threshold
    if len(minimal_issues) > COMPACTION_THRESHOLD:
        return CompactedResult(
            compacted=True,
            total_count=len(minimal_issues),
            preview=minimal_issues[:PREVIEW_COUNT],
            preview_count=PREVIEW_COUNT,
            hint=(
                f"Showing {PREVIEW_COUNT} of {len(minimal_issues)} ready issues. "
                "Use show(issue_id) for full details."
            ),
        )

    return minimal_issues


@mcp.tool(
    name="list",
    description=(
        "List all issues with optional filters. When status='blocked', returns BlockedIssue with blocked_by info. "
        "mentioned=True lists the items on this board you were @mentioned on (open ones first, most recent "
        "mention first; closed ones last unless you name a status) — read them and reply there with "
        "@<who mentioned you>. For your mentions across every board use notifications(view='mentions')."
    ),
)
@with_workspace
async def list_issues(
    status: IssueStatus | None = None,
    priority: int | None = None,
    issue_type: IssueType | None = None,
    assignee: str | None = None,
    labels: list[str] | None = None,
    labels_any: list[str] | None = None,
    query: str | None = None,
    unassigned: bool = False,
    limit: int = 20,
    workspace_dir_prefix: str | None = None,
    workspace_root: str | None = None,
    brief: bool = False,
    fields: list[str] | None = None,
    max_description_length: int | None = None,
    mentioned: bool = False,
) -> list[IssueMinimal] | list[BriefIssue] | list[dict[str, Any]] | CompactedResult:
    """List all issues with optional filters.

    Args:
        status: Filter by status (open, in_progress, blocked, closed)
        priority: Filter by priority level (0-4)
        issue_type: Filter by type (bug, feature, task, epic, chore, decision)
        assignee: Filter by assignee
        labels: Filter by labels (AND: must have ALL specified labels)
        labels_any: Filter by labels (OR: must have at least one)
        query: Search in title (case-insensitive substring)
        unassigned: Filter to only unassigned issues
        limit: Maximum issues to return (1-100, default 20)
        workspace_dir_prefix: Only issues whose workspace_dir binding is this directory or
            below it (path-boundary aware; pass an absolute path — `~` expands on the
            server) — "every session epic under this tree of worktrees" in one call
        workspace_root: Workspace path override
        brief: If True, return only {id, title, status} (~97% smaller)
        fields: Return only specified fields (custom projections)
        max_description_length: Truncate descriptions to this length
        mentioned: Only items you were @mentioned on (from your inbox: every unhandled
            mention plus handled ones from the last ~30 days), open ones first

    Returns minimal issue format to reduce context usage by ~80%.
    Use show(issue_id) for full details including dependencies.
    """
    ids: list[str] | None = None
    if mentioned:
        ids = await asyncio.to_thread(mentioned_issue_ids)
        if not ids:
            return []
    issues = await beads_list_issues(
        status=status,
        priority=priority,
        issue_type=issue_type,
        assignee=assignee,
        labels=labels,
        labels_any=labels_any,
        query=query,
        unassigned=unassigned,
        limit=limit,
        workspace_dir_prefix=workspace_dir_prefix,
        ids=ids,
    )

    # Apply description truncation first
    if max_description_length:
        issues = [_truncate_description(i, max_description_length) for i in issues]

    # Return brief format if requested
    if brief:
        return [_to_brief(issue) for issue in issues]

    # Return specific fields if requested
    if fields:
        return [_filter_fields(issue, fields) for issue in issues]

    # Default: minimal format with compaction
    minimal_issues = [_to_minimal(issue) for issue in issues]

    # Apply compaction if over threshold
    if len(minimal_issues) > COMPACTION_THRESHOLD:
        return CompactedResult(
            compacted=True,
            total_count=len(minimal_issues),
            preview=minimal_issues[:PREVIEW_COUNT],
            preview_count=PREVIEW_COUNT,
            hint=(
                f"Showing {PREVIEW_COUNT} of {len(minimal_issues)} issues. "
                "Use show(issue_id) for full details or add filters to narrow results."
            ),
        )

    return minimal_issues


@mcp.tool(
    name="show",
    description="Show detailed information about a specific issue including dependencies and dependents.",
)
@with_workspace
async def show_issue(
    issue_id: str,
    workspace_root: str | None = None,
    brief: bool = False,
    brief_deps: bool = False,
    fields: list[str] | None = None,
    max_description_length: int | None = None,
) -> Issue | BriefIssue | dict[str, Any]:
    """Show detailed information about a specific issue.

    Args:
        issue_id: The issue ID to show (e.g., 'bd-a1b2')
        workspace_root: Workspace path override
        brief: If True, return only {id, title, status, priority}
        brief_deps: If True, return full issue but with compact dependencies
        fields: Return only specified fields (custom projections)
        max_description_length: Truncate description to this length
    """
    issue = await beads_show_issue(issue_id=issue_id)

    if max_description_length:
        issue = _truncate_description(issue, max_description_length)

    # Brief mode - just identification
    if brief:
        return _to_brief(issue)

    # Brief deps mode - full issue but compact dependencies
    if brief_deps:
        data = issue.model_dump()
        data["dependencies"] = [_to_brief_dep(d).model_dump() for d in issue.dependencies]
        data["dependents"] = [_to_brief_dep(d).model_dump() for d in issue.dependents]
        return data

    if fields:
        return _filter_fields(issue, fields)

    return issue


@mcp.tool(
    name="create",
    description="""Create a new assigned issue (bug, feature, task, epic, chore, or decision) with optional design,
acceptance criteria, and dependencies. If assignee is omitted, the authenticated creator is assigned automatically.
@mentions in the description notify like a comment's (only people who can see the item's space); the
result's `mentions` says who they reached. If the new item duplicates or overlaps someone else's open
item, comment on theirs @mentioning its holder (link #your-item) instead of silently filing in parallel.
For substantial work, file the epic AND its work items at decomposition time — typically 3–10 children via
deps=['parent-child:<epic-id>'], one per phase/wave/deliverable, each closed as it lands. Create only work intended
to finish in this session; do not file future backlog, reminders, parking/defer work,
or one item per subagent/chunk.

deps entries are 'type:id' or a bare id. A **bare id means 'blocks'** — the default —
and it is why filing children with deps=[epic] leaves every child showing
as blocked by its own open epic. Write the type you mean:
deps=['parent-child:fd-epic'] for a child of an epic, 'discovered-from:fd-x' for work
found while doing fd-x, 'blocks:fd-y' to reverse the direction (fd-y depends on the new
issue). An edge of the wrong type cannot be retyped in place — use dep_remove() then
dep(). A deps entry that names an existing issue also routes the create to that
issue's board, so filing a child under an epic needs no board selection.

An epic can carry a workspace binding — `workspace_dir` (the contract's `cwd`), `session_id`,
`host` — so the board can answer "which worktree/session does this work belong to" after the
agent is gone. Pass them explicitly (absolute `workspace_dir`). A local stdio server defaults
them for epics from the resolved workspace_root and the agent's registry row; the hosted
server stamps no defaults (they would describe the server, not the session). On non-epics
they are recorded only when given.""",
)
@require_write
@with_workspace
@require_context
async def create_issue(
    title: str,
    description: str = "",
    design: str | None = None,
    acceptance: str | None = None,
    external_ref: str | None = None,
    priority: int = 2,
    issue_type: IssueType = "task",
    assignee: str | None = None,
    labels: list[str] | None = None,
    id: str | None = None,
    deps: list[str] | None = None,
    workspace_dir: str | None = None,
    session_id: str | None = None,
    host: str | None = None,
    workspace_root: str | None = None,
    brief: bool = True,
) -> Issue | OperationResult:
    """Create a new issue.

    Args:
        workspace_dir: Absolute worktree directory this work belongs to (binding)
        session_id: Agent session id this work belongs to (binding)
        host: Hostname the session runs on (binding)
        brief: If True (default), return minimal OperationResult; if False, return full Issue
    """
    issue = await beads_create_issue(
        title=title,
        description=description,
        design=design,
        acceptance=acceptance,
        external_ref=external_ref,
        priority=priority,
        issue_type=issue_type,
        assignee=assignee,
        labels=labels,
        id=id,
        deps=deps,
        workspace_dir=workspace_dir,
        session_id=session_id,
        host=host,
    )

    if brief:
        result = OperationResult(id=issue.id, action="created")
        texts = [
            ("description", description),
            ("title", title),
            ("design", design or ""),
            ("acceptance", acceptance or ""),
        ]
        result.mentions = await _write_mentions(issue.id, texts) or None
        return result
    return issue


@mcp.tool(
    name="claim",
    description=(
        "Atomically claim an issue for work (assignee + in_progress in one CAS-style operation). "
        "Before claiming, read your unread mentions (notifications(view='mentions')) and the item's "
        "comments; if the item sits near someone else's work (a work_overlap row, an artifact_search "
        "hit, a related open item), comment on it @mentioning that person with what you take and what "
        "you leave them — then go ahead; never wait for a reply. Under accounts mode a claim held "
        "by another of your own credentials (a different agent token or connection of the same "
        "person) is refused with that credential's label — "
        "coordinate; force=True takes over only your own dead session, never another person's. "
        "Subagents that inherit your token share your claims and need no force."
    ),
)
@require_write
@with_workspace
@require_context
async def claim_issue(
    issue_id: str,
    workspace_root: str | None = None,
    brief: bool = True,
    force: bool = False,
) -> Issue | OperationResult | None:
    """Atomically claim an issue for work.

    Args:
        brief: If True (default), return minimal OperationResult; if False, return full Issue
        force: Take over your *own* claim held by another of your sessions (never another user's)
    """
    issue = await beads_claim_issue(issue_id=issue_id, force=force)
    if brief:
        return OperationResult(id=issue.id, action="claimed")
    return issue


@mcp.tool(
    name="update",
    description="""Update an existing issue's status, priority, assignee, description, design notes,
acceptance criteria or labels. @handles newly added to the description notify that person (the result's
`mentions` says who they reached); @mentions in design/notes/acceptance never notify. When you hand an
item to someone else (assignee change), also comment on it @mentioning them with where things stand.
`labels` replaces the whole set — pass [] to clear it, omit it to leave it alone. `metadata` merges
top-level keys; null values delete keys. The standard effort shape is
`metadata.effort = {pre_ai_hours, effective_hours, ai_accel, source}`. For atomic
start-work semantics, prefer claim(issue_id). `workspace_dir`,
`session_id` and `host` re-bind the issue to a workspace (merged into its metadata; other
metadata keys are kept).""",
)
@require_write
@with_workspace
@require_context
async def update_issue(
    issue_id: str,
    status: IssueStatus | None = None,
    priority: int | None = None,
    assignee: str | None = None,
    title: str | None = None,
    description: str | None = None,
    design: str | None = None,
    acceptance_criteria: str | None = None,
    notes: str | None = None,
    external_ref: str | None = None,
    labels: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
    workspace_dir: str | None = None,
    session_id: str | None = None,
    host: str | None = None,
    workspace_root: str | None = None,
    brief: bool = True,
) -> Issue | OperationResult | list[Issue] | list[OperationResult] | None:
    """Update an existing issue.

    Args:
        labels: Replace the full label set ([] clears it); omit to leave labels unchanged
        metadata: Merge top-level keys; null values delete keys
        workspace_dir: Re-bind to this absolute worktree directory
        session_id: Re-bind to this agent session id
        host: Re-bind to this hostname
        brief: If True (default), return minimal OperationResult; if False, return full Issue
    """
    # If trying to close via update, redirect to close_issue to preserve approval workflow.
    # close carries no label payload, so a relabel in the same call is applied first
    # instead of being silently discarded.
    if status == "closed":
        if labels is not None or metadata is not None:
            await beads_update_issue(issue_id=issue_id, labels=labels, metadata=metadata)
        issues = await beads_close_issue(issue_id=issue_id, reason="Closed via update", metadata=metadata)
        if not issues:
            return None
        if brief:
            return OperationResult(id=issues[0].id, action="closed", message="Closed via update")
        return issues[0]

    # Description @mentions notify only for names the edit adds (the engine diffs the
    # body), so the report needs the names the old body already had.
    previous_description = ""
    if description and "@" in description:
        with suppress(Exception):
            previous_description = (await beads_show_issue(issue_id=issue_id)).description or ""

    issue = await beads_update_issue(
        issue_id=issue_id,
        status=status,
        priority=priority,
        assignee=assignee,
        title=title,
        description=description,
        design=design,
        acceptance_criteria=acceptance_criteria,
        notes=notes,
        external_ref=external_ref,
        labels=labels,
        metadata=metadata,
        workspace_dir=workspace_dir,
        session_id=session_id,
        host=host,
    )

    if isinstance(issue, list):
        if not issue:
            return None
        if brief:
            return [OperationResult(id=item.id, action="updated") for item in issue]
        return issue
    if brief:
        result = OperationResult(id=issue.id, action="updated")
        texts = [
            ("description", _added_mentions_text(description or "", previous_description)),
            ("title", title or ""),
            ("design", design or ""),
            ("acceptance_criteria", acceptance_criteria or ""),
            ("notes", notes or ""),
        ]
        result.mentions = await _write_mentions(issue.id, texts) or None
        return result
    return issue


def _added_mentions_text(new: str, old: str) -> str:
    """The @handles ``new`` names that ``old`` did not, as text to report on."""
    from beads_mcp.notifications import parse_mentions

    if "@" not in new:
        return ""
    before = {h.lower() for h in parse_mentions(old)}
    return " ".join(f"@{h}" for h in parse_mentions(new) if h.lower() not in before)


async def _write_mentions(issue_id: str, texts: Sequence[tuple[str, str]]) -> dict[str, Any]:
    """The additive ``mentions`` report of a create/update. Never fails the write."""
    if not any("@" in (text or "") for _, text in texts):
        return {}
    try:
        space = await space_of_issue(issue_id)
        return await asyncio.to_thread(mention_report_for, list(texts), space)
    except Exception as exc:  # noqa: BLE001 - feedback, not the write
        logger.debug(f"mention report failed for {issue_id}: {exc}")
        return {}


@mcp.tool(
    name="close",
    description=(
        "Close (complete) an issue. Mark work as done when you've finished implementing/fixing it. "
        "metadata merges into the existing object; null values delete keys. "
        "metadata.effort = {pre_ai_hours, effective_hours, ai_accel, source}."
    ),
)
@require_write
@with_workspace
@require_context
async def close_issue(
    issue_id: str,
    reason: str = "Completed",
    force: bool = False,
    metadata: dict[str, Any] | None = None,
    workspace_root: str | None = None,
    brief: bool = True,
) -> list[Issue] | list[OperationResult]:
    """Close (complete) an issue.

    Args:
        force: If True, bypass only the assignee mismatch guard
        metadata: Merge top-level keys; null values delete keys
        brief: If True (default), return minimal OperationResult list; if False, return full Issues
    """
    issues = await beads_close_issue(issue_id=issue_id, reason=reason, force=force, metadata=metadata)

    if not brief:
        return issues

    return [OperationResult(id=issue_id, action="closed", message=reason)]


@mcp.tool(
    name="reopen",
    description="Reopen one or more closed issues. Sets status to 'open' and clears closed_at timestamp.",
)
@require_write
@with_workspace
@require_context
async def reopen_issue(
    issue_ids: list[str],
    reason: str | None = None,
    workspace_root: str | None = None,
    brief: bool = True,
) -> list[Issue] | list[OperationResult]:
    """Reopen one or more closed issues.

    Args:
        brief: If True (default), return minimal OperationResult list; if False, return full Issues
    """
    issues = await beads_reopen_issue(issue_ids=issue_ids, reason=reason)

    if brief:
        return [OperationResult(id=i.id, action="reopened", message=reason) for i in issues]
    return issues


@mcp.tool(
    name="dep",
    description="""Add a dependency between issues. Common types: blocks (hard blocker),
related (soft link), parent-child (epic/subtask), discovered-from (found during work).
Other niche types are accepted as strings. Both ids may be on any board — the call
routes by the issue id's prefix, no board selection needed.""",
)
@require_write
@with_workspace
@require_context
async def add_dependency(
    issue_id: str,
    depends_on_id: str,
    dep_type: DependencyType = "blocks",
    workspace_root: str | None = None,
) -> str:
    """Add a dependency relationship between two issues."""
    return await beads_add_dependency(
        issue_id=issue_id,
        depends_on_id=depends_on_id,
        dep_type=dep_type,
    )


@mcp.tool(
    name="dep_remove",
    description="""Remove a dependency between two issues, whatever its type.

The other half of dep(), and the way to fix an edge of the wrong type: dep() will not
retype an existing edge, so retyping is dep_remove() then dep() with the type you
wanted. Removing an edge that is not there succeeds quietly, so that sequence is safe
to repeat.

Worth knowing before you need this tool: create(deps=[...]) accepts 'type:id' entries,
so deps=['parent-child:fd-epic'] files a child under an epic directly. A bare id means
'blocks', which is the default and the reason epics end up blocking their own
children.""",
)
@require_write
@with_workspace
@require_context
async def remove_dependency(
    issue_id: str,
    depends_on_id: str,
    workspace_root: str | None = None,
) -> str:
    """Remove a dependency relationship between two issues."""
    return await beads_remove_dependency(
        issue_id=issue_id,
        depends_on_id=depends_on_id,
    )


@mcp.tool(
    name="comment",
    description=(
        "Add a comment to an issue — a durable, timestamped record of what changed, was decided, "
        "or verified — and the way agents coordinate so they don't step on each other's toes. "
        "`@handle` puts the comment in that person's inbox, which ALL of their agents read (their "
        "human reads along in the dashboard bell). @mention the other person freely whenever your "
        "work touches theirs: you are starting or claiming something near their work, your "
        "artifacts overlap theirs ('@alice I'm taking ws.js in #x1; your #x2 touches it, I "
        "leave the CLI half to you'), you hand something off, you found a duplicate of their item, "
        "or you are answering their mention (@ them back). Only people who can see the item's "
        "space are reached — users_list(query=...) finds the right handle among people who share a "
        "space with you. Coordinate, never block: say what you are doing and keep working on what "
        "is clearly yours; never wait for a reply. `#issue-id` (e.g. #ex-abc) links an issue. The "
        "result says who each mention reached (as their person: @alex-laptop reaches mira), "
        "who it did not and why (unknown handle, with did_you_mean; not in this item's space), "
        'and ends with a machine-readable `mentions: {"delivered": [...], "not_delivered": '
        "[...]}` line."
    ),
)
@require_write
@with_workspace
@require_context
async def comment(
    issue_id: str,
    text: str,
    workspace_root: str | None = None,
) -> str:
    """Add a comment to an issue, and report who it reached.

    Enrichment happens after the write, never instead of it: the comment is stored
    whatever the registry says, and the extra lines are a reading of what was stored.
    An unreadable registry costs the mention *verification*, not the comment.
    """
    posted = await beads_add_comment(issue_id=issue_id, text=text)
    space = await space_of_issue(issue_id) if "@" in text else None
    return await asyncio.to_thread(enrich_comment_result, posted, text, None, None, space)


@mcp.tool(
    name="comments",
    description=(
        "List all comments on an issue (show reports comment_count but not the comment bodies). "
        "Each comment carries `mentions` — the live actors named with @ — and `refs`, every "
        "#issue-id in its text with an absolute link. Both are null when the text has neither."
    ),
)
@with_workspace
async def comments(
    issue_id: str,
    workspace_root: str | None = None,
) -> list[Comment]:
    """List all comments on an issue in chronological order."""
    return await beads_list_comments(issue_id=issue_id)


@mcp.tool(
    name="note",
    description=(
        "Append a note to an issue's notes field. For a per-turn, timestamped trail that "
        "multiple actors can follow, prefer comment()."
    ),
)
@require_write
@with_workspace
@require_context
async def note(
    issue_id: str,
    text: str,
    workspace_root: str | None = None,
) -> str:
    """Append a note to an issue's notes field."""
    return await beads_add_note(issue_id=issue_id, text=text)


@mcp.tool(
    name="stats",
    description="Get statistics: total issues, open, in_progress, closed, blocked, ready, and average lead time.",
)
@with_workspace
async def stats(workspace_root: str | None = None) -> Stats:
    """Get statistics about tasks."""
    return await beads_stats()


@mcp.tool(
    name="blocked",
    description="Get blocked issues showing what dependencies are blocking them from being worked on.",
)
@with_workspace
async def blocked(
    workspace_root: str | None = None,
    brief: bool = False,
    brief_deps: bool = False,
) -> list[BlockedIssue] | list[BriefIssue] | list[dict[str, Any]]:
    """Get blocked issues.

    Args:
        brief: If True, return only {id, title, status, priority} per issue
        brief_deps: If True, return full issues but with compact dependencies
    """
    issues = await beads_blocked()

    # Brief mode - just identification (most compact)
    if brief:
        return [_to_brief(issue) for issue in issues]

    # Brief deps mode - full issue but compact dependencies
    if brief_deps:
        result = []
        for issue in issues:
            data = issue.model_dump()
            data["dependencies"] = [_to_brief_dep(d).model_dump() for d in issue.dependencies]
            data["dependents"] = [_to_brief_dep(d).model_dump() for d in issue.dependents]
            result.append(data)
        return result

    return issues


# =============================================================================
# AGENT TIERS: gating the paths that destroy work
# =============================================================================
# feads addition. `boards/authz.mjs` and `beads_mcp.authz` are the same policy in
# two languages; `boards/authz-cases.json` is the contract between them. Here we
# only call it.
#
# Scope of the gate, stated plainly so nobody reads more into it than is there:
#
# - **Gated:** the two `admin` actions that can `DELETE FROM issues` —
#   `pollution` with `clean=True` and `validate` with `fix_all=True`. Both need
#   the `delete` decision, which in practice means an admin or the operator.
# - **Not gated:** `repair` with `fix=True`. It removes dependency rows that
#   point at issues which no longer exist (`cmd/bd/doctor/fix/validation.go`
#   deletes from `dependencies`, not from `issues`). There is no item and so no
#   `created_by` to attribute, and refusing routine repair to a `user` would cost
#   integrity nothing.
# - **Gated on `write`:** the ordinary mutation path — `create`, `claim`,
#   `update`, `close`, `reopen`, `dep`, `comment`, `note`. Every *tier* may write,
#   so for a registered `user` or `admin` this gate never fires; what it actually
#   binds is a caller with **no** identity on a surface whose stance is not
#   `operator`. That is HTTP (`read_only`) and any deployment setting
#   `FEADS_REQUIRE_AGENT`.
#
#   This was previously left ungated on the grounds that it "would only bite
#   unidentified callers under FEADS_REQUIRE_AGENT". That reasoning expired the
#   moment the HTTP transport took the `read_only` stance: without this gate,
#   `read_only` over HTTP would refuse deletes while letting an anonymous caller
#   create, edit and close anything — a label rather than a control, and the more
#   dangerous kind of gap because `agent_whoami` would be reporting
#   `"write": false` to a caller whose writes were in fact landing.
#
# And the boundary that governs all of it: this binds callers arriving through
# this server. It does not bind the shell next to it, where `bd delete` is a
# local Go binary on a local Dolt database with no auth layer to hook. So this is
# an integrity control against an agent destroying work by misreading its remit,
# not a security boundary against a hostile local process.


async def _require_delete(what: str) -> None:
    """Refuse a bulk delete unless the caller may delete items it does not own.

    Bulk deletes are checked once, not per item, because per item is not
    available: `bd doctor` finds the rows and deletes them inside one invocation,
    with no id list to filter and nothing to inspect at the moment of the
    decision. A detect-then-clean pass would not fix that — it would add a TOCTOU
    window and still not constrain what the second command removes.

    So the decision is asked with an `id` and **no `created_by`**, which is not a
    shortcut but the honest description of the situation: ownership genuinely
    cannot be established for the set about to be deleted. The policy already has
    a rule for that evidentiary position — a user is refused, an admin is not —
    so this needs no special case, and the refusal an agent reads is the policy's
    own wording rather than a second one written here.

    Raises:
        ToolError: If the caller may not delete. `ToolError` specifically, not a
            bare exception: FastMCP replaces the message of anything else with
            "Error calling tool 'admin'" when `mask_error_details` is on, and a
            refusal an agent cannot read is a refusal it will simply retry.
    """
    decision = authorize("delete", {"id": what})
    if not decision["allowed"]:
        raise ToolError(f"refused ({decision['mode']} mode): {decision['reason']}")


def _is_tier_admin(resolved: Mapping[str, Any]) -> bool:
    """The ``admin`` tier of the legacy policy, as accounts mode maps it.

    Accounts on: a superadmin user (DESIGN: "superadmins map to tier admin"), an
    unclaimed legacy agent that still holds the admin tier, or the local operator.
    Accounts off: the operator stance or an ``admin`` agent row, exactly as before.
    """
    principal = resolved.get("principal")
    if isinstance(principal, Mapping):
        kind = principal.get("kind")
        if kind == "operator":
            return True
        if kind == "user":
            return principal.get("is_superadmin") is True
        if kind == "legacy_agent":
            return str(principal.get("legacy_role") or "") == "admin"
        return False
    if resolved.get("mode") == "operator":
        return True
    return is_tier_admin_agent(resolved.get("agent"))


def _require_tier_admin(what: str) -> None:
    """Refuse ``what`` unless the caller holds the admin tier (see :func:`_is_tier_admin`).

    Raises:
        ToolError: For the reason :func:`_require_delete` gives.
    """
    if not _is_tier_admin(resolve_identity()):
        raise ToolError(f"refused: {what} needs the admin tier (a Feads superadmin under accounts mode)")


@mcp.tool(
    name="admin",
    description="""Administrative and diagnostic operations.
Actions:
- validate: Run database health checks (checks=orphans,duplicates,pollution,conflicts)
- repair: Fix orphaned dependency references (fix=True to apply)
- schema: Show database schema info
- debug: Show environment and working directory info
- migration: Get migration plan and database state
- pollution: Detect/clean test issues (clean=True to delete)

validate(fix_all=True) and pollution(clean=True) delete issues and require the
delete permission; run them without those flags to see what they would touch.
Every action needs write access to the board; under accounts mode debug (server
environment) also needs the admin tier.""",
)
@require_write
@with_workspace
async def admin(
    action: str,  # validate, repair, schema, debug, migration, pollution
    checks: str | None = None,
    fix_all: bool = False,
    fix: bool = False,
    clean: bool = False,
    workspace_root: str | None = None,
) -> dict[str, Any] | str:
    """Administrative and diagnostic operations."""

    if action == "validate":
        if fix_all:
            # `bd doctor --check=validate --fix` is not only a repair: its
            # cross-table duplicate fix runs `DELETE FROM issues`
            # (cmd/bd/doctor/fix/validation.go). Read-only validation stays open
            # to every tier, which is what keeps the diagnostic useful to a user
            # who then has to ask an admin to apply it.
            await _require_delete("validate --fix (deletes duplicate issue rows)")
        return await beads_validate(checks=checks, fix_all=fix_all)

    elif action == "repair":
        return await beads_repair_deps(fix=fix)

    elif action == "schema":
        return await beads_get_schema_info()

    elif action == "debug":
        # The server's cwd, HOME, USER and BEADS_* paths describe the host, not any
        # board: operator information. Under accounts mode that is the admin tier on top
        # of write (orchestrator decision (b), 2026-10-05). With accounts off the legacy
        # contract stands: any writer may run this read-only diagnostic.
        if await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
            _require_tier_admin("admin(action='debug')")
        info = []
        info.append("=== Working Directory Debug Info ===\n")
        info.append(f"os.getcwd(): {os.getcwd()}\n")
        info.append(f"PWD env var: {os.environ.get('PWD', 'NOT SET')}\n")
        info.append(f"BEADS_WORKING_DIR env var: {os.environ.get('BEADS_WORKING_DIR', 'NOT SET')}\n")
        info.append(f"BEADS_PATH env var: {os.environ.get('BEADS_PATH', 'NOT SET')}\n")
        info.append(f"BEADS_DB env var: {os.environ.get('BEADS_DB', 'NOT SET')}\n")
        info.append(f"HOME: {os.environ.get('HOME', 'NOT SET')}\n")
        info.append(f"USER: {os.environ.get('USER', 'NOT SET')}\n")
        return "".join(info)

    elif action == "migration":
        return await beads_inspect_migration()

    elif action == "pollution":
        if clean:
            # Detection is free to anyone; deletion is not. A test issue that
            # leaked into a production board still belongs to whoever created it,
            # and "it looks like test data" is a heuristic — bd matches on title
            # patterns — so an agent acting on it destroys work it cannot vouch
            # for.
            await _require_delete("pollution --clean (deletes issues bd judges to be test data)")
        return await beads_detect_pollution(clean=clean)

    else:
        raise ValueError(
            f"Unknown action: {action}. Use 'validate', 'repair', 'schema', 'debug', 'migration', or 'pollution'"
        )


# =============================================================================
# BOARD REGISTRY: Which board does this work belong to?
# =============================================================================
# Every tool above operates on exactly one board, auto-detected from the working
# directory. These read the cross-board registry so an agent can see the other
# boards and route an item to the right one before filing it — and, since the
# board_* write tools below, teach the registry what it was missing when routing
# came back wrong. This *process* still never opens the registry read-write: the
# reads stay `mode=ro`, and every write spawns the one blessed writer
# (scripts/feads-board.mjs) and relays its answer. See beads_mcp.boards_write for
# why a subprocess and not a port.


@mcp.tool(
    name="boards_list",
    description=(
        "List every board you can access (your spaces, under accounts mode) with its description "
        "and the repos it covers. Start here when you do not know which board a task belongs to."
    ),
)
async def boards_list() -> dict[str, Any]:
    """List every registered board.

    Returns:
        Dict with registry_path, boards, count, and a setup hint when empty
    """
    payload = await asyncio.to_thread(boards_list_payload)
    return await asyncio.to_thread(_scope_boards_payload, payload)


@mcp.tool(
    name="board_show",
    description="Show one registered board: its description, repos, board directory and workspace.",
)
async def board_show(board: str) -> dict[str, Any]:
    """Show a single registered board.

    Args:
        board: Board id, or the path of its .beads directory

    Returns:
        Dict with the board, or an error plus known_boards if it is not registered
    """
    payload = await asyncio.to_thread(board_show_payload, board)
    return await asyncio.to_thread(_scope_board_show, payload, board)


@mcp.tool(
    name="board_route",
    description=(
        "Rank the boards you can access against a task and explain why each one scored, so you can "
        "file the item on the board that owns the work. Pass the repo when you know it — "
        "a repo match outweighs any amount of description similarity."
    ),
)
async def board_route(
    text: str = "",
    repo: str = "",
    limit: int | None = None,
    repos: list[str] | None = None,
) -> dict[str, Any]:
    """Rank boards against a task.

    Boards are not tied to repos — a board may list zero, one or many, and a board
    described only in prose is fully routable. Passing several repos does not
    inflate a board's score: the best single match counts, never a sum.

    Args:
        text: Free-text task description (text and/or a repo is required)
        repo: A repo the task touches, as owner/name or a bare repo name
        limit: Keep only the top N candidates
        repos: Additional repos the task touches; a task may span several

    Returns:
        Dict with the query and scored candidates, highest score first
    """
    # Keyword for repos: board_route_payload takes db_path in the 4th position.
    payload = await asyncio.to_thread(board_route_payload, text, repo, None, repos=repos)
    return await asyncio.to_thread(_scope_route_payload, payload, limit)


@mcp.tool(
    name="board_repos_add",
    description=(
        "Add repos to a board's repo list without touching the rest — the write that closes the "
        "routing loop. When you filed an item on a board that did not yet list the repo the task "
        "touches, add it here so the next agent's board_route lands right instead of re-deriving "
        "your judgment call. Adds are row-targeted and idempotent, so concurrent agents editing "
        "one board compose instead of clobbering; there is deliberately no replace-the-list verb."
    ),
)
@require_write
async def board_repos_add(board: str, repos: list[str]) -> dict[str, Any]:
    """Append repos to a board's routing hint list.

    Args:
        board: Board id from boards_list(), or the path of its .beads directory
        repos: Repos to add, as owner/name (e.g. Example-Org/sample-web-ui)

    Returns:
        Dict with the updated board on success; on failure a code an agent can
        branch on (board_not_found carries the known ids)
    """
    return await asyncio.to_thread(board_repos_add_payload, board, repos)


@mcp.tool(
    name="board_repos_remove",
    description=(
        "Remove exactly the named repos from a board's repo list, leaving the rest alone. "
        "A board with zero repos stays fully routable by its description — repos are an "
        "optional hint, not part of a board's identity."
    ),
)
@require_write
async def board_repos_remove(board: str, repos: list[str]) -> dict[str, Any]:
    """Remove repos from a board's routing hint list.

    Args:
        board: Board id from boards_list(), or the path of its .beads directory
        repos: Repos to remove, exactly as they appear on the board

    Returns:
        Dict with the updated board and how many entries were actually removed
    """
    return await asyncio.to_thread(board_repos_remove_payload, board, repos)


@mcp.tool(
    name="board_describe",
    description=(
        "Update a board's description and/or display name. The description is a routing "
        "signal — board_route scores prose overlap against it — so describe what work belongs "
        "here in the words a task would use. The board id never changes."
    ),
)
@require_write
async def board_describe(
    board: str,
    description: str | None = None,
    name: str | None = None,
    expected_description: str | None = None,
) -> dict[str, Any]:
    """Update a board's description and/or name.

    Args:
        board: Board id from boards_list(), or the path of its .beads directory
        description: New description; omit to leave unchanged
        name: New display name; omit to leave unchanged
        expected_description: The description you last read. When passed, the
            write is refused if somebody changed it since — pass it whenever
            your read is not fresh, so a stale overwrite fails loudly instead
            of silently clobbering the routing signal.

    Returns:
        Dict with the updated board (and `previous` — what it replaced)
    """
    return await asyncio.to_thread(
        board_describe_payload,
        board,
        description,
        name,
        None,
        expected_description,
    )


@mcp.tool(
    name="board_create",
    description=(
        "Create a new board for a project directory and register it, in one step. Initializes "
        "a fresh board database when the directory has none yet, so this writes the SERVER's filesystem — "
        "project_dir is a path where this server runs, not where you sit. Prefer filing on an "
        "existing board (boards_list / board_route) over minting one per task: boards are "
        "coordination surfaces, and ten near-empty boards route worse than two described ones."
    ),
)
@require_write
async def board_create(
    project_dir: str,
    name: str,
    id: str = "",
    prefix: str = "",
    description: str = "",
    repos: list[str] | None = None,
) -> dict[str, Any]:
    """Create and register a new board.

    Args:
        project_dir: Server-side project directory; its .beads is created if absent
        name: Display name; the board id is derived from it unless id is passed
        id: Explicit board id slug
        prefix: Issue id prefix for minted issue ids (defaults to the first 12 chars of the id)
        description: What work belongs on this board — this is the routing signal
        repos: Repos the board covers, as owner/name

    Returns:
        Dict with the created board and whether a new database was initialized
    """
    board_dir = os.path.join(str(project_dir or "").strip(), ".beads") if str(project_dir or "").strip() else ""
    id = await _accounts_board_registration(board_dir, id, "")
    result = await asyncio.to_thread(board_create_payload, project_dir, name, id, prefix, description, repos or ())
    return await _register_created_board_in_pg(result, prefix)


async def _accounts_board_registration(board_dir: str, board_id: str, workspace: str) -> str:
    """Accounts mode: who may put a board in the registry, and under which id.

    A registry row is authorized as the board whose data it reaches, so the row's id
    *is* that data's id (the directory holding ``.beads``): a different id would be a
    second name — with its own space — for another board's issues. The caller needs
    ``board_create`` on the space the board will sit in (the space of the board already
    registered at that id, else the default space). Returns the id to register under;
    off mode returns ``board_id`` untouched.

    Raises:
        ToolError: On refusal. Unreachable targets and nonexistent ones answer alike.
    """
    if not await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
        return board_id
    target_dir = str(board_dir or "").strip()
    if not target_dir or os.path.basename(os.path.normpath(target_dir)) != ".beads":
        raise ToolError("refused: under accounts mode a board is registered at its <id>/.beads directory")
    data_id = _accounts.canonical_board_id(target_dir)
    wanted = str(board_id or "").strip()
    if wanted and wanted != data_id:
        raise ToolError(
            f"refused: this board's id must be '{data_id}' (the name of the directory that holds .beads)"
        )
    if str(workspace or "").strip() and os.path.basename(os.path.normpath(str(workspace))) != data_id:
        raise ToolError(f"refused: the workspace of board '{data_id}' must be a directory named '{data_id}'")
    owners = await asyncio.to_thread(_accounts.board_space_map, None, False)
    space = owners.get(data_id, "")
    if space and await asyncio.to_thread(get_board, target_dir) is None:
        current = await asyncio.to_thread(get_board, data_id)
        if current is not None and os.path.abspath(str(current["board_dir"])) != os.path.abspath(target_dir):
            # Another directory already holds this board's name: registering a second
            # one would alias its data. Answer as for any unreachable board.
            raise _board_not_available(data_id)
    resolved = await asyncio.to_thread(resolve_identity)
    verdict = decide_access(
        resolved.get("principal"), "board_create", {"space": space or _accounts.DEFAULT_SPACE_ID}
    )
    if not verdict.allowed:
        raise _board_not_available(data_id)
    return data_id


async def _register_created_board_in_pg(result: dict[str, Any], prefix: str) -> dict[str, Any]:
    """Give a board `board_create` just made a row in the Postgres store.

    Only in pg mode, only on success, and only when ``bd init`` actually ran: a board
    that already existed holds issues this store has never seen, and declaring it empty
    here would answer "no issues" where the honest answer is "that board is not in this
    database" (:func:`beads_mcp.pgstore.ensure_board` makes the same argument about
    ``board_register``).

    The outcome rides under its own key rather than changing any existing one, so a
    bd-mode reply is byte-identical to what it always was and a pg-mode caller can see
    whether the board it just made is usable. Failing the whole call instead would
    misreport a board that *was* created and registered.
    """
    if not pgstore.pg_enabled() or not result.get("created") or not result.get("initialized"):
        return result
    board = result.get("board") or {}
    workspace = str(board.get("workspace_dir") or "") or os.path.dirname(str(board.get("board_dir") or ""))
    if not workspace:
        return result

    # What feads-board.mjs passed to `bd init`: the explicit --prefix, else the board
    # id truncated to 12 characters. Reproduced rather than re-derived from the
    # directory, because the id is a slug of the board *name* and need not match the
    # directory the board lives in.
    chosen = str(prefix or "").strip() or str(board.get("id") or "")[:12]
    outcome = await pgstore.ensure_board(
        pgstore.board_id_for_workspace(workspace), pgstore.normalize_issue_prefix(chosen)
    )
    result["pg_store"] = outcome
    if outcome.get("error"):
        result.setdefault("warnings", []).append(str(outcome["error"]))
    return result


@mcp.tool(
    name="board_register",
    description=(
        "Register a board database that already exists on the server's filesystem — so it shows up "
        "in boards_list and board_route. Registering is a registry operation only; the board's "
        "database is never touched. Unregistering has no MCP tool on purpose: removing a board "
        "from every agent's view is an operator move (`feads-board remove`)."
    ),
)
@require_write
async def board_register(
    board_dir: str,
    name: str,
    id: str = "",
    workspace: str = "",
    description: str = "",
    repos: list[str] | None = None,
) -> dict[str, Any]:
    """Register an existing .beads directory as a board.

    Args:
        board_dir: The .beads directory, on the server's filesystem
        name: Display name; the board id is derived from it unless id is passed
        id: Explicit board id slug
        workspace: Project root; defaults to the board_dir's parent
        description: What work belongs on this board — this is the routing signal
        repos: Repos the board covers, as owner/name

    Returns:
        Dict with the registered board
    """
    id = await _accounts_board_registration(board_dir, id, workspace)
    return await asyncio.to_thread(
        board_register_payload, board_dir, name, id, workspace, description, repos or ()
    )


# =============================================================================
# AGENT REGISTRY: who else is working this board, who am I, and how do I get in?
# =============================================================================
# feads addition. `agents_list` and `agent_whoami` read the same registry as
# boards_list, and read it the same way — `mode=ro`, no migration, no writes.
#
# `agent_signup` is the exception, and the shape of the exception is the whole
# point: it does not write the registry either. It **proxies** the dashboard's
# `POST /api/agent/signup`, which writes. Registration's single-use guarantee is
# `BEGIN IMMEDIATE` + a conditional `UPDATE` + a partial unique index — an
# invariant enforced by SQL and transaction semantics rather than by a pure
# function, so unlike the policy it could not be governed by
# `boards/authz-cases.json`, and a Python port would be an unfixtured second copy
# of a security invariant. See the module docstrings of `beads_mcp.signup` (why a
# proxy, and what depending on the dashboard costs) and `beads_mcp.agents` (why
# this server holds no write path of its own).
#
# Minting *invites* is still absent, and still belongs to `feads-agent`
# (scripts/feads-agent.mjs) — including the bootstrap case that makes an MCP-side
# admin mint unauthenticatable in principle.


@mcp.tool(
    name="agents_list",
    description=(
        "List the agents registered against a board — who else is working it, on which host, "
        "and when each was last seen. Narrowed to what you may see: an admin sees every agent, "
        "a user sees only itself, and an anonymous caller sees none (who else is registered is "
        "administrative data, so it does not come with read-only board access). Check it before "
        "claiming a bead someone else may hold. Read-only. Under accounts mode: the agents of "
        "people who share a space with you (sign-up is retired there; use Access → Connect an agent)."
    ),
)
async def agents_list(board: str = "", include_revoked: bool = False) -> dict[str, Any]:
    """List registered agents, scoped to what the caller may see.

    Args:
        board: Board id to list agents for; omit to list every board's agents
        include_revoked: Include revoked agents. Only affects the admin/operator
            scope — a user's own row is returned either way.

    Returns:
        Dict with scope, mode, agents and count, plus a hint when nothing is
        registered yet
    """
    system = await asyncio.to_thread(_system_key_directory, "agents", include_revoked, board)
    if system is not None:
        return system
    payload = await asyncio.to_thread(agents_list_payload, board, include_revoked)
    return await asyncio.to_thread(_scope_directory_payload, payload, "agents")


@mcp.tool(
    name="agent_whoami",
    description=(
        "Call this once at the start of a session. Reports which registered agent you are "
        "acting as, how that was established (a token on the request, a token in the "
        "environment, or a session id), your tier, and exactly what you may and may not do — "
        "so you can ask before a delete rather than discovering the refusal afterwards. "
        "`mode` is one of: `agent` (a credential verified — your tier decides), `operator` "
        "(no credential, local stdio, unrestricted), `anonymous` (no credential on a shared "
        "endpoint, or FEADS_REQUIRE_AGENT is set — reads at most), `rejected` (a credential "
        "was presented and did not verify, usually a revoked agent — everything is refused). "
        "When you have no usable identity the `hint` field tells you how to get one: call "
        "agent_signup(display_name='<a short name for you>'), which mints one for you and "
        "needs no admin. Only if that reports the dashboard unreachable does it become "
        "something your human has to do. `handle` is what other agents write to @mention you "
        "(`handle_aliases` also reach you). When notifications are waiting on you, `inbox` "
        "leads with `unread_mentions` and summarizes the rest by type (e.g. 2 work_overlap) — "
        "call notifications(view='mentions') next, then notifications(). "
        "Under accounts mode an `accounts` block reports the "
        "person you act as, your aliases, the connection (`provenance`), the spaces/boards you "
        "can reach and each reachable space's admins (who to ask for access); sign-up is "
        "retired there — credentials come from the Claude connector or Access → Connect an agent."
    ),
)
async def agent_whoami() -> dict[str, Any]:
    """Report the acting agent and its permissions.

    Returns:
        Dict with identity, mode, via, permissions and roster_scope; a hint on how
        to register when no identity was presented, or on how to recover when a
        credential was rejected; and `inbox` (unhandled notifications by type) when
        something is waiting
    """
    return await asyncio.to_thread(
        lambda: with_inbox_digest(_with_mention_handle(_whoami_accounts(agent_whoami_payload())))
    )


def _with_mention_handle(payload: dict[str, Any]) -> dict[str, Any]:
    """whoami's additive ``handle``: what other agents write to reach you (and your aliases)."""
    identity = payload.get("identity")
    if payload.get("credential_rejected") or not isinstance(identity, Mapping):
        return payload
    accounts_block = payload.get("accounts")
    if isinstance(accounts_block, Mapping) and accounts_block.get("actor"):
        handle = str(accounts_block["actor"])
        aliases = [str(a) for a in accounts_block.get("aliases") or [] if a and a != handle]
    else:
        handle = str(identity.get("actor") or "")
        aliases = []
    if not handle:
        return payload
    return {
        **payload,
        "handle": handle,
        "handle_aliases": aliases,
        "handle_hint": (
            f"Other agents reach all of your person's agents with @{handle}"
            + (" (or any alias)" if aliases else "")
            + "; you reach theirs the same way — users_list(query=...) finds a handle."
        ),
    }


# Deliberately not wearing `@require_write`. That gate asks the `write` permission,
# which an anonymous caller does not have under the `read_only` stance — so wearing it
# would refuse exactly the caller this tool exists for, and make "present a credential"
# the closed loop the open-sign-up rule was written to avoid. The right question is
# `mint_invite` with `role: 'user'`, and `agent_signup_payload` asks it first, before any
# network call. It is also not a board mutation: nothing it does touches an issue.
@mcp.tool(
    name="agent_delegate",
    description=(
        "Mint a short-lived child lease opportunistically. Delegation is fail-open and must never "
        "delay subagent launch; do not call in a /no-feads session."
    ),
)
async def agent_delegate(handle: str, display_name: str = "", ttl_ms: int | None = None) -> dict[str, Any]:
    return await asyncio.to_thread(agent_delegate_payload, handle, display_name, ttl_ms)


@mcp.tool(
    name="flare_heartbeat",
    description=(
        "Raise or refresh advisory presence only after this worker actually touched the issue. "
        "Never use for an idle worker or in /no-feads mode."
    ),
)
async def flare_heartbeat(issue_id: str, board: str = "") -> dict[str, Any]:
    await _enforce_flare(issue_id, board)
    return await asyncio.to_thread(flare_heartbeat_payload, issue_id, board)


@mcp.tool(
    name="flare_drop",
    description=(
        "Drop advisory presence previously raised after an actual issue touch. Never use in /no-feads mode."
    ),
)
async def flare_drop(issue_id: str, board: str = "") -> dict[str, Any]:
    await _enforce_flare(issue_id, board)
    return await asyncio.to_thread(flare_drop_payload, issue_id, board)


_READ_ONLY_SYSTEM_KEY = (
    "refused: this is a read-only system key — it can never write (flares included); "
    "use a personal connection for writes"
)
_READ_ONLY_SERVICE = "refused: this service account is read-only — it can never write (flares included)"


async def _enforce_flare(issue_id: str, board: str) -> None:
    """Accounts mode: raising or dropping presence is W on the flare's board (DESIGN,
    Enforcement map) — checked here, before anything is relayed, on the named board and
    on the board that actually holds the issue. Unreadable and missing answer alike.

    A system key never writes anywhere, so it is refused first, board-independently,
    with the reason that is true for it (read-only) — not "not available", which
    misled for an issue the key can read. Asked before any board or issue lookup, the
    answer is identical for a readable, a hidden and a missing target."""
    if await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
        resolved = await asyncio.to_thread(resolve_identity)
        principal = resolved.get("principal") or {}
        if principal.get("kind") == "system":
            raise ToolError(_READ_ONLY_SYSTEM_KEY)
        if principal.get("kind") == "service" and principal.get("read_only") is not False:
            raise ToolError(_READ_ONLY_SERVICE)
    await _enforce_named_board({"board": board}, write=True)
    await _enforce_issue_ids({"issue_id": issue_id}, write=True, tool="flare")


@mcp.tool(
    name="agent_signup",
    description=(
        "Get an agent identity of your own, without waiting for a human. Call this when "
        "agent_whoami() reports you have none and you need to write. It signs you up "
        "through the feads dashboard (which must be running) and returns an agent token "
        "**exactly once** — only a hash is stored, so it can never be shown again; read "
        "`next_steps` in the result for how to present it, which differs between stdio and "
        "HTTP. Sign-up is open to anyone and needs no admin, and can only ever mint the "
        "`user` tier: a `user` reads and writes anything and deletes only what it created. "
        "Call it once. On failure, `code` says what to do next and is worth reading rather "
        "than retrying — `dashboard_unreachable` means the dashboard is not running (ask "
        "your human to start it; your request was fine), `forbidden` means this deployment "
        "refuses open sign-up, `name_taken` means to pick another name, and "
        "`already_identified` means you already have an identity and should not mint a "
        "second one."
    ),
)
async def agent_signup(display_name: str, actor: str = "") -> dict[str, Any]:
    """Register an identity for this agent and return its token once.

    Args:
        display_name: A short name for this agent, e.g. `laptop-claude`. It is what
            the board attributes your work to and what other agents see in the roster.
        actor: Optional slug override; the dashboard derives one from `display_name`
            when omitted.

    Returns:
        Dict with `created`; on success `token` (returned once), `identity`, `actor`,
        `board_id` and `next_steps`; on failure `code`, `reason` and `hint`
    """
    if await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
        return {
            "created": False,
            "code": "signup_retired",
            "reason": "Open agent sign-up is retired on this instance: identities come from organization SSO.",
            "hint": (
                "Ask your human to open the Feads dashboard, go to Access → Connect an agent, and set the "
                "token it shows as FEADS_AGENT_TOKEN in this agent's environment themselves — a token never "
                "belongs in chat. Claude connectors use https://feads.mcp.example.test/mcp instead, which "
                "signs in with Google."
            ),
        }
    return await asyncio.to_thread(agent_signup_payload, display_name, actor)


# =============================================================================
# NOTIFICATIONS: being told something happened, and addressing somebody by name
# =============================================================================
# feads addition. A board with several agents on it is a place they write past each
# other unless two things exist: a way to name somebody (`@actor`, resolved against the
# directory `users_list` returns) and a way to be told you were named (`notifications`).
# Without them the only discovery mechanism is re-reading every issue you have ever
# touched, which nobody does.
#
# The reads are read-only SQLite on the registry, exactly like the board and agent
# tools. `notifications_ack` is the one write, and like `agent_signup` it is a *proxy* —
# the dashboard writes, this server asks. See beads_mcp.notifications for the parser
# contract shared with the Node engine and the browser, and for why the actor is put in
# the ack body on stdio but never over HTTP.


@mcp.tool(
    name="users_list",
    description=(
        "Find the @handle to write. Agents coordinate by @mentioning each other — "
        "'@alice I'm taking the widget refactor in #x1, leaving widget.json to you' — "
        "and one handle reaches every agent of that person (one shared inbox; their human can "
        "read along). Pass `query` (a name, handle, alias or email local part, e.g. "
        "query='dana') to get a ranked `people` list: each entry has the canonical `handle` "
        "to write, `display_name`, `kind` (human / service), `aliases` (other handles that "
        "reach the same person) and, under accounts mode, the `spaces` you share — a mention "
        "only reaches someone on items in a space they can read, so the list holds only "
        "people who share a space with you. Without `query`, `people` lists everyone you can "
        "reach. `users` keeps the per-actor rows (each with `handle`, and `alias_of` when "
        "that actor is an alias). comment(), create() and update() report who each mention "
        "actually reached. Needs an identity of your own: an agent that cannot be mentioned "
        "back has no use for the list."
    ),
)
async def users_list(include_revoked: bool = False, query: str = "", limit: int = 25) -> dict[str, Any]:
    """List the people (and actors) that can be @mentioned.

    Args:
        include_revoked: Also list revoked agents in `users`, each carrying `revoked_at`.
            Worth asking for when reading old comments, whose @names may belong to agents
            that have since been revoked.
        query: Rank and filter by name, handle, alias or email local part ("dana",
            "lee", "dana-laptop"). Empty lists everyone you can reach.
        limit: Max entries in `people` (default 25).

    Returns:
        Dict with people (one per person, ranked when `query` is given), users (per-actor
        rows), count and registry_path; an empty list with a reason and a hint when you
        have no identity
    """
    system = await asyncio.to_thread(_system_key_directory, "users", include_revoked)
    if system is not None:
        return await asyncio.to_thread(_with_people, system, query, limit)
    payload = await asyncio.to_thread(users_list_payload, include_revoked)
    scoped = await asyncio.to_thread(_scope_directory_payload, payload, "users")
    return await asyncio.to_thread(_with_people, scoped, query, limit)


def _with_people(payload: dict[str, Any], query: str = "", limit: int = 25) -> dict[str, Any]:
    """users_list's additive ``people`` view and per-row ``handle`` / ``alias_of``.

    Never fails the listing: a directory that cannot be read leaves ``users`` as it was.
    """
    from beads_mcp.mentions import load_directory, people_view

    if payload.get("reason") or payload.get("error"):
        return payload
    try:
        principal = _scope_active()
        if principal is not None and principal.get("kind") in (None, "anonymous"):
            return payload
        view = people_view(principal, query, limit=limit)
        directory = load_directory()
    except Exception as exc:  # noqa: BLE001 - additive view
        logger.debug(f"users_list people view unavailable: {exc}")
        return payload
    rank = {p["handle"]: i for i, p in enumerate(view["people"])}
    rows: list[Any] = []
    for row in payload.get("users", []):
        if not isinstance(row, dict):
            continue
        person = directory.resolve(str(row.get("actor") or ""))
        handle = person.actor if person is not None else str(row.get("actor") or "")
        row = {**row, "handle": handle}
        if handle != row.get("actor"):
            row["alias_of"] = handle
        if query and handle not in rank:
            continue
        rows.append(row)
    if query:
        rows.sort(key=lambda r: rank.get(str(r.get("handle")), len(rank)))
    out = {**payload, "users": rows, "count": len(rows), "people": view["people"]}
    if query:
        out["query"] = query
        if not view["people"]:
            out["hint"] = (
                f"Nobody you share a space with matches '{query}'. A mention only reaches people who "
                "can see the item's space; try a shorter query, or tell your human who you need."
            )
    return out


@mcp.tool(
    name="notifications",
    description=(
        "Your inbox — how other people's agents reach you. **Check it at session start (right "
        "after agent_whoami()), at every phase boundary, before claiming or starting an item, "
        "and before closing one.** Fastest: notifications(view='mentions') — who @mentioned "
        "you, on which item (title, current status), with the mentioning comment and a "
        "`reply_with` handle, open items first, across every board. Mentions are how agents "
        "coordinate so they don't step on each other's toes: read the item, reply in it with "
        "@<who mentioned you> when useful (what you take, what you leave, your answer), then "
        "notifications_ack(ids=[...]) what you handled — never wait for a reply. Kinds: "
        "`mention` (somebody wrote @you in a comment or description), `assigned` (an issue's "
        "assignee became you), `reassigned_away` (an issue you held was reassigned), "
        "`work_overlap` (someone declared or claimed work on artifacts — files, dirs, PRs — "
        "overlapping yours), `dependency_completed` (a blocker of yours closed), "
        "`comment_on_owned` (a new comment on an issue you own), `status_on_owned` (someone "
        "else moved an issue you own), `new_in_area` (new work filed under your epic) and "
        "`update_on_commented` (an issue you had commented on changed). Each row carries a "
        "snippet, who caused it, an absolute link, `guidance` (who to @mention and the "
        "suggested next step — coordinate, don't block) and `count` (repeats collapse). "
        "`unhandled_by_type` summarizes the whole inbox; pass `types` to list only some "
        "kinds. One handle reaches every agent of a person, and their human reads mentions "
        "in the dashboard bell; this queue is what *you* have not acked, so a row a human "
        "already read still counts until you ack it. An unidentified caller gets an empty "
        "inbox rather than a refusal."
    ),
)
async def notifications(
    unread_only: bool = True,
    limit: int = DEFAULT_NOTIFICATION_LIMIT,
    types: list[str] | None = None,
    view: str = "",
) -> dict[str, Any]:
    """List the notifications addressed to the acting agent.

    Args:
        unread_only: Only what you have not acknowledged. `unread_count` is reported
            either way and is never affected by `limit`, so a page can say how much of
            the inbox it is.
        limit: Page size, clamped to 200.
        types: Only these kinds in the listing, e.g. ["work_overlap", "mention"].
            Counts still describe the whole inbox.
        view: "mentions" for the compact mention digest: items you were @mentioned on,
            grouped, open first, each mention with its text and who to reply to.

    Returns:
        Dict with notifications (newest first, urls absolute), unread_count — the rows
        still unacknowledged — unhandled_by_type, and actor; with view="mentions",
        `items` instead of `notifications`, plus `unread_mentions`
    """
    if view == "mentions":
        payload = await asyncio.to_thread(notifications_payload, unread_only, limit, None, None, ["mention"])
        rows = payload.get("notifications") or []
        context: dict[str, Any] = {}
        if rows and os.environ.get("FEADS_PG_DSN", "").strip():
            try:
                context = await pgstore.mention_context([str(r.get("issue_id") or "") for r in rows])
            except Exception as exc:  # noqa: BLE001 - the stored snippet is the fallback
                logger.debug(f"mention context unavailable: {exc}")
        return await asyncio.to_thread(mentions_view, payload, context)
    if view:
        raise ToolError(f"unknown view {view!r}: use view='mentions', or omit it for the full inbox")
    return await asyncio.to_thread(notifications_payload, unread_only, limit, None, None, types)


# Deliberately not wearing `@require_write`, for the reason agent_signup gives: this is
# not a board mutation — no issue is touched — and the gate would ask the wrong
# question. The right one is "is this your inbox?", which only the dashboard can answer,
# and which it answers by verifying the credential this tool relays.
@mcp.tool(
    name="notifications_ack",
    description=(
        "Mark notifications handled, by id or all at once, so the unread count keeps meaning "
        "something and the next session's notifications() shows only what is still owed. An "
        "ack here means *you dealt with it* — the dashboard's bell only marks rows seen, so "
        "nothing leaves your queue until you ack it. Only rows addressed to you can be "
        "acknowledged. This one needs the feads dashboard running: "
        "the MCP reads the registry but does not write it, so the ack is proxied. On failure "
        "read `code` rather than retrying — `dashboard_unreachable` means the dashboard is "
        "down and nothing was acknowledged (safe to retry later), `not_identified` means the "
        "dashboard could not tell which actor you are."
    ),
)
async def notifications_ack(ids: list[str] | None = None, all: bool = False) -> dict[str, Any]:
    """Acknowledge notifications through the dashboard.

    Args:
        ids: Notification ids from a `notifications()` result.
        all: Acknowledge every unhandled notification addressed to you. The argument is
            named for the wire contract it shares with the dashboard's HTTP route and
            the browser's WebSocket op.

    Returns:
        Dict with acked and unread_count — what is left unacknowledged; on failure both at
        zero plus code, reason and hint
    """
    return await asyncio.to_thread(notifications_ack_payload, ids, all)


# =============================================================================
# ARTIFACTS: what a bead is working on, and who else is in this path
# =============================================================================
# feads addition. beads relates beads to beads and nothing else, so a bead cannot say
# which files it is touching and an agent cannot ask who else is touching one.
#
# Refs are repo-relative and identical for every agent — `Example-Org/feads:ui/server/
# bd.js`, never a checkout path — which is what lets two agents on two machines match on
# the same file. The grammar, the overlap rules and the comment text live in
# beads_mcp.artifacts and are shared with the `feads-artifact` CLI through
# boards/artifact-cases.json.
#
# Unlike the board and agent tools, these *write* — but through `bd`, exactly as
# create_issue and comment already do. The registry is still only ever read.


@mcp.tool(
    name="artifact_add",
    description=(
        "Declare the files, directories, repos or PRs this bead is working on, so other agents "
        "can see it. Refs are repo-relative and the same for everyone: owner/repo:path/to/file, "
        "owner/repo:dir/ for a subtree, owner/repo#123 for a PR, owner/repo for the whole thing. "
        "Do this when you claim a bead, before editing — the result names any other bead that "
        "already claims the same path, which is your chance to coordinate rather than collide. "
        "Checkout paths are refused on purpose: /Users/you/src/... means nothing to another agent."
    ),
)
@require_write
async def artifact_add(
    issue_id: str,
    refs: list[str],
    intent: str = "editing",
    note: str = "",
    board: str = "",
) -> dict[str, Any]:
    """Attach artifacts to a bead.

    Args:
        issue_id: Bead to attach to
        refs: Repo-relative refs (owner/repo[:path][#pr]); a bare repo name is expanded
            against the registry when it is unambiguous
        intent: What this bead does to them — editing (will change), reading (depends on
            it unchanged), planned (not yet), done (finished with it)
        note: Why this bead touches them, for whoever finds the overlap
        board: Board id or .beads directory; omit for the one bd resolves itself

    Returns:
        Dict with the attached refs and others_claiming — every other bead whose
        artifacts overlap them, most urgent first
    """
    result = await artifact_add_payload(issue_id, refs, intent=intent, note=note, board=board)
    # Child presence is advisory; never make an artifact write depend on the flare proxy.
    with suppress(Exception):
        await asyncio.to_thread(flare_heartbeat_payload, issue_id, board)
    return result


@mcp.tool(
    name="artifact_search",
    description=(
        "Find which beads claim a path — the question to ask before you edit a file. Sweeps every "
        "registered board by default, because a search that skipped the board holding the conflict "
        "would answer 'nobody is touching this'. Matches overlaps, not just equality: a bead that "
        "claimed the directory above your file, or the whole repo, is a hit. Zero hits means the "
        "path is free."
    ),
)
async def artifact_search(
    ref: str,
    board: str = "",
    include_closed: bool = False,
    intent: str = "",
    limit: int | None = None,
) -> dict[str, Any]:
    """Find beads whose artifacts overlap a ref.

    Args:
        ref: Repo-relative ref to look for (owner/repo:path, owner/repo:dir/, owner/repo#N,
            owner/repo)
        board: Restrict to one board id or .beads directory
        include_closed: Include closed beads, which are history rather than conflict
        intent: Only hits with this intent (editing, reading, planned, done)
        limit: Keep only the top N hits; the count still reports the total

    Returns:
        Dict with the canonical query, the boards searched, and hits ordered
        editing → planned → reading → done, exact overlaps before broad ones
    """
    return await artifact_search_payload(
        ref, board=board, include_closed=include_closed, intent=intent, limit=limit
    )


@mcp.tool(
    name="artifact_respond",
    description=(
        "Answer a bead that claims a path you need, and record what you decided: taking (you are "
        "editing it now), skipping (you will not touch it), or waiting (you need their change "
        "first). Comments on every overlapping bead so the decision is durable rather than lost in "
        "a transcript. waiting also adds a real blocks dependency, so bd ready stops offering your "
        "bead until theirs closes — that part only works within one board, since boards are "
        "separate databases."
    ),
)
@require_write
async def artifact_respond(
    ref: str,
    mine: str,
    action: str,
    target_issue: str = "",
    note: str = "",
    board: str = "",
) -> dict[str, Any]:
    """Answer the beads that claim a path.

    Args:
        ref: The contested ref
        mine: Your bead — the one answering; it records your stance
        action: taking, skipping or waiting
        target_issue: Answer just this bead instead of every overlap
        note: Reason, included in the comment
        board: Board id or .beads directory for your bead; omit for bd's own resolution

    Returns:
        Dict with the intent recorded on your bead and, per bead answered, the comment
        posted and whether a dependency was added
    """
    return await artifact_respond_payload(ref, mine, action, target_issue=target_issue, note=note, board=board)


@mcp.tool(
    name="artifact_list",
    description="List what one bead is working on: its files, directories, repos and PRs, with intents.",
)
async def artifact_list(issue_id: str, board: str = "") -> dict[str, Any]:
    """List a bead's artifacts.

    Args:
        issue_id: Bead to read
        board: Board id or .beads directory; omit for the one bd resolves itself

    Returns:
        Dict with the bead and its artifacts, sorted by ref
    """
    # A read of the bead: authorized where the id actually lives (a hidden id and a
    # missing one get the same refusal), and a named board must be readable too.
    await _enforce_issue_ids({"issue_id": issue_id}, write=False, tool="artifact_list")
    await _enforce_named_board({"board": board}, write=False)
    return await artifact_list_payload(issue_id, board=board)


@mcp.tool(
    name="artifact_remove",
    description=(
        "Release artifacts from a bead — say you are done with a file so the next agent is not "
        "waiting on you. Prefer this over leaving a stale claim behind."
    ),
)
@require_write
async def artifact_remove(issue_id: str, refs: list[str], board: str = "") -> dict[str, Any]:
    """Detach artifacts from a bead.

    Args:
        issue_id: Bead to release from
        refs: Refs to release
        board: Board id or .beads directory; omit for the one bd resolves itself

    Returns:
        Dict with the released refs
    """
    return await artifact_remove_payload(issue_id, refs, board=board)


@mcp.tool(
    name="artifact_canon",
    description=(
        "Show the canonical ref for a path or repo without touching a bead — what artifact_add "
        f"would store. Use it to check a spelling, or to see how a bare repo name expands. "
        f"Intents: {', '.join(INTENTS)}. Response actions: {', '.join(ACTIONS)}."
    ),
)
async def artifact_canon(refs: list[str], board: str = "") -> dict[str, Any]:
    """Canonicalize refs.

    Args:
        refs: Refs or repo-qualified paths to canonicalize
        board: Board whose repos take precedence when expanding a bare repo name

    Returns:
        Dict with each ref's kind, repo, path or PR number, and canonical spelling
    """
    await _refuse_anonymous_under_accounts("artifact_canon")
    return await artifact_canon_payload(refs, board=board)


# =============================================================================
# Transport selection
# =============================================================================


def _env_flag(name: str) -> bool:
    """Read a boolean environment variable."""
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _transport_options(argv: Sequence[str]) -> dict[str, Any]:
    """Resolve run_async() kwargs from CLI flags and environment.

    stdio stays the default because that is how Claude Code launches this server
    locally; HTTP is opt-in, for hosting the MCP alongside the backend stack.

    Args:
        argv: Command-line arguments excluding the program name

    Returns:
        Keyword arguments for FastMCP.run_async()
    """
    parser = argparse.ArgumentParser(prog="beads-mcp", description="MCP server for the beads issue tracker.")
    parser.add_argument(
        "--http",
        action=argparse.BooleanOptionalAction,
        default=_env_flag("FEADS_MCP_HTTP"),
        help="serve over streamable HTTP instead of stdio (env: FEADS_MCP_HTTP=1)",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("FEADS_MCP_HOST", DEFAULT_HTTP_HOST),
        help=f"HTTP bind address (default: {DEFAULT_HTTP_HOST}; env: FEADS_MCP_HOST)",
    )
    parser.add_argument(
        "--port",
        type=int,
        # Left as a string so argparse runs type=int over it too — a non-numeric
        # FEADS_MCP_PORT then fails as a usage error rather than a traceback.
        default=os.environ.get("FEADS_MCP_PORT", str(DEFAULT_HTTP_PORT)),
        help=f"HTTP port (default: {DEFAULT_HTTP_PORT}; env: FEADS_MCP_PORT)",
    )
    parser.add_argument(
        "--path",
        default=os.environ.get("FEADS_MCP_PATH", DEFAULT_HTTP_PATH),
        help=f"HTTP endpoint path (default: {DEFAULT_HTTP_PATH}; env: FEADS_MCP_PATH)",
    )
    args = parser.parse_args(list(argv))

    if not args.http:
        return {"transport": "stdio"}

    return {
        "transport": HTTP_TRANSPORT,
        "host": args.host,
        "port": args.port,
        "path": args.path,
    }


class _TrailingSlashAlias:
    """ASGI middleware: serve the path with or without a trailing slash.

    Both spellings share the same endpoint so clients keep their credentials.
    """

    def __init__(self, app: Any, path: str = DEFAULT_HTTP_PATH) -> None:
        self.app = app
        self.path = path.rstrip("/")

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if self.path and scope.get("type") in ("http", "websocket") and scope.get("path") == self.path + "/":
            scope = {**scope, "path": self.path, "raw_path": self.path.encode()}
        await self.app(scope, receive, send)


def _http_middleware(path: str | None) -> list[Any]:
    """ASGI middleware for the HTTP transport (outermost first)."""
    from starlette.middleware import Middleware

    return [Middleware(_TrailingSlashAlias, path=path or DEFAULT_HTTP_PATH)]


async def async_main(**transport_options: Any) -> None:
    """Async entry point for the MCP server.

    Args:
        transport_options: Keyword arguments for FastMCP.run_async(); defaults to stdio
    """
    if not transport_options:
        transport_options = {"transport": "stdio"}
    # Tell the wire layer which pipe this process serves, because it decides what an
    # unidentified caller is trusted with: the operator on stdio, read-only over HTTP.
    # Set here rather than in main() so an embedder calling async_main() directly gets
    # the same answer — and note beads_mcp.transport.serving_http() also detects a
    # live HTTP request on its own, for the embedder who calls neither.
    set_http_transport(transport_options.get("transport") != "stdio")
    if transport_options.get("transport") != "stdio":
        # Do not let a caller-supplied forwarding header rewrite the socket peer.
        uvicorn_config = dict(transport_options.get("uvicorn_config") or {})
        uvicorn_config["proxy_headers"] = False
        middleware = _http_middleware(transport_options.get("path")) + list(
            transport_options.get("middleware") or []
        )
        transport_options = {**transport_options, "uvicorn_config": uvicorn_config, "middleware": middleware}
    await mcp.run_async(**transport_options)


# =============================================================================
# Hosted account-mode access is unavailable in the standalone release.
# These legacy hooks are inert while accounts_enabled() is always false.
# =============================================================================


def _issue_ids_for_access(kwargs: dict[str, Any], tool: str = "") -> list[str]:
    """Every issue id a call names. ``id`` is a *board* id on the board tools and the
    id-to-be of a new issue on ``create`` — neither names an existing issue."""
    scoped = dict(kwargs)
    if tool in _EDGE_REMOVAL_TOOLS:
        # Removing an edge is a write to the dependent issue only: a principal who may
        # write ``issue_id`` may drop any edge it holds, including a legacy edge into a
        # space it cannot see (orchestrator decision (e), 2026-10-05). The other end is
        # neither read nor written (see pgstore.remove_dependency), and the answer is
        # the same whether that edge or that issue exists, so naming it reveals nothing.
        value = kwargs.get("issue_id")
        return [value] if isinstance(value, str) and "-" in value else []
    if tool.startswith("board_") or tool in ("create_issue", "create"):
        scoped.pop("id", None)
    ids = _candidate_issue_ids(scoped)
    for key in ("mine", "target_issue", "parent", "parent_id"):
        value = kwargs.get(key)
        if isinstance(value, str) and "-" in value:
            ids.append(value)
    return ids


_NOT_AVAILABLE = "refused: {} is not available to this identity"
_EDGE_REMOVAL_TOOLS = ("remove_dependency", "dep_remove")
_CREATE_TOOLS = ("create_issue", "create")


async def _enforce_issue_ids(
    kwargs: dict[str, Any], write: bool, tool: str = "", target_workspace: str | None = None
) -> None:
    """Refuse a call naming an issue on a board the caller may not read/write.

    Each id is authorized against the board that *actually holds it* in the store
    (never its prefix, which only suggests one), so both ends of a dependency or a
    parent link are checked where they live. An id no board holds — never minted,
    tombstoned, or on a board that is not registered in any space — is refused with
    the very words a forbidden one gets: the refusal must not tell a caller which
    ids exist in spaces it cannot see, and no edge is ever written to a missing id.
    A mutation spanning two spaces is refused even for a caller who can see both:
    dependencies never cross spaces.

    ``target_workspace`` is the board a ``create`` lands on (known only once
    ``with_workspace`` resolved it): its space joins the spaces the call touches, so
    ``create(deps=['parent-child:<id in another space>'])`` is refused like ``dep``.
    """
    if not os.environ.get("FEADS_PG_DSN"):
        return
    if not await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
        return
    ids = list(dict.fromkeys(_issue_ids_for_access(kwargs, tool)))
    if not ids:
        return
    try:
        holders = await pgstore.boards_of_issues(ids)
    except Exception as exc:  # noqa: BLE001 - an unverifiable id is a refused id
        logger.warning(f"accounts: issue→board lookup failed: {exc}")
        raise ToolError(_NOT_AVAILABLE.format(ids[0])) from None
    resolved = await asyncio.to_thread(resolve_identity)
    principal = resolved.get("principal")
    space_map = await asyncio.to_thread(_accounts.board_space_map)
    spaces_touched: set[str] = set()
    for issue_id in ids:
        board_id = holders.get(issue_id, "")
        if not board_id:
            raise ToolError(_NOT_AVAILABLE.format(issue_id))
        ok, _reason = await asyncio.to_thread(_accounts.check_board, principal, board_id, write)
        if not ok:
            raise ToolError(_NOT_AVAILABLE.format(issue_id))
        spaces_touched.add(space_map.get(board_id, ""))
    if write and tool in _CREATE_TOOLS and target_workspace:
        target_board = pgstore.board_id_for_workspace(target_workspace)
        spaces_touched.add(space_map.get(target_board, "") if target_board else "")
    if write and len(spaces_touched) > 1:
        raise ToolError("refused: dependencies and links cannot cross spaces")


async def _refuse_anonymous_under_accounts(tool: str) -> None:
    """Under accounts mode, refuse a caller with no identity (anonymous, revoked,
    disabled, an ignored worker header). Board-independent, so it reveals nothing."""
    if not await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
        return
    resolved = await asyncio.to_thread(resolve_identity)
    principal = resolved.get("principal") or {}
    if principal.get("kind") in (None, "anonymous"):
        raise ToolError(f"refused: {tool} needs an identity. {how_to_get_a_credential()}")


def _board_not_available(board: str) -> ToolError:
    """The one refusal for a board the caller cannot reach *or* that does not exist."""
    return ToolError(f"refused: board '{board}' is not available to this identity")


async def _registered_board_id(board: str) -> str:
    """The registry id behind a board id or a ``.beads`` path, or ``''``."""
    try:
        found = await asyncio.to_thread(get_board, board)
    except RegistryUnavailableError:
        return ""
    return str(found["id"]) if found else ""


async def _enforce_named_board(kwargs: dict[str, Any], write: bool) -> None:
    """A call naming a board — by id *or by the path of its .beads directory* — is
    authorized against that registered board. Under accounts mode an unknown board and
    a forbidden one get the same refusal, so a write tool cannot be used to learn which
    boards exist in other spaces (or to list them: the not-found payload names ids)."""
    board = kwargs.get("board")
    if not isinstance(board, str) or not board.strip():
        return
    if not await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
        return
    name = board.strip()
    board_id = await _registered_board_id(name)
    if not board_id:
        raise _board_not_available(name)
    resolved = await asyncio.to_thread(resolve_identity)
    ok, _reason = await asyncio.to_thread(_accounts.check_board, resolved.get("principal"), board_id, write)
    if not ok:
        raise _board_not_available(name)


def _scope_active() -> dict[str, Any] | None:
    """The caller's principal when accounts mode is on, else None."""
    if not _accounts.accounts_enabled(os.environ):
        return None
    return resolve_identity().get("principal") or {"kind": "anonymous"}


def _scope_boards_payload(payload: dict[str, Any]) -> dict[str, Any]:
    principal = _scope_active()
    if principal is None:
        return payload
    readable = _accounts.readable_boards(principal)
    space_map = _accounts.board_space_map()
    boards = [
        {**b, "space_id": space_map.get(str(b.get("id")), "")}
        for b in payload.get("boards", [])
        if readable is None or str(b.get("id")) in readable
    ]
    return {**payload, "boards": boards, "count": len(boards)}


def _scope_board_show(payload: dict[str, Any], board: str) -> dict[str, Any]:
    principal = _scope_active()
    if principal is None:
        return payload
    if payload.get("board") is None and "known_boards" not in payload and payload.get("error"):
        return payload  # the registry itself could not be read: nothing about any board
    readable = _accounts.readable_boards(principal)
    found = payload.get("board")
    if isinstance(found, dict) and readable is not None and str(found.get("id")) not in readable:
        found = None
    known = [b for b in payload.get("known_boards", []) if readable is None or b in readable]
    if found is None:
        # One literal, built the same way for a board that does not exist and for one
        # the caller cannot read: same keys, same order, same values — the JSON text
        # must not tell the two apart (a dict rebuilt from the payload would keep
        # whichever key order the registry lookup happened to produce).
        return {
            "registry_path": payload.get("registry_path"),
            "board": None,
            "error": f"no such board: {board}",
            # From the caller's access set, not from whichever lookup ran: a hidden board
            # (no known_boards in its payload) and a missing one must list the same ids.
            "known_boards": sorted(readable) if readable is not None else known,
            "hint": "Pass a board id from boards_list().",
        }
    return {**payload, "board": {**found, "space_id": _accounts.board_space(str(found.get("id")))}}


def _scope_route_payload(payload: dict[str, Any], limit: int | None) -> dict[str, Any]:
    principal = _scope_active()
    candidates = payload.get("candidates", [])
    if principal is not None:
        readable = _accounts.readable_boards(principal)
        candidates = [c for c in candidates if readable is None or str(c.get("id")) in readable]
    if limit is not None and limit > 0:
        candidates = candidates[:limit]
    return {**payload, "candidates": candidates, "count": len(candidates)}


def _scope_directory_payload(payload: dict[str, Any], key: str) -> dict[str, Any]:
    principal = _scope_active()
    if principal is None:
        return payload
    allowed = _accounts.directory_actors(principal)
    if allowed is None:
        rows_all = [r for r in payload.get(key, []) if isinstance(r, dict)]
        return {**payload, key: _accounts.label_service_rows(rows_all)} if key in payload else payload
    rows = [r for r in payload.get(key, []) if isinstance(r, dict) and str(r.get("actor")) in allowed]
    return {**payload, key: _accounts.label_service_rows(rows), "count": len(rows)}


def _system_key_directory(key: str, include_revoked: bool, board: str = "") -> dict[str, Any] | None:
    """The directory for a system key under accounts mode, else ``None``.

    A system key acts as nobody, so the tier policy has no agent row to grant
    ``view_roster`` to; ``directory_read`` still admits it (any non-anonymous
    principal). Orchestrator decision (c), 2026-10-05: it sees the users who share the
    key's *effective* spaces (key spaces ∩ the minter's live agent spaces) — for a
    key whose minter lost those spaces, nobody.
    """
    principal = _scope_active()
    if principal is None or principal.get("kind") != "system":
        return None
    allowed = _accounts.directory_actors(principal) or set()
    payload: dict[str, Any] = {"registry_path": registry_location(), "mode": "system_key", "scope": "spaces"}
    try:
        if key == "agents":
            payload["board_id"] = board or None
            readable = _accounts.readable_boards(principal)
            if board and readable is not None and board not in readable:
                # A board the key cannot read lists nobody — exactly what a board that
                # does not exist lists, so the answer is no existence oracle.
                return {**payload, key: [], "count": 0}
            rows: list[Any] = [
                to_roster_row(a) for a in list_agents(board_id=board, include_revoked=include_revoked)
            ]
        else:
            rows = list(list_users(include_revoked))
    except RegistryUnavailableError as exc:
        return {**payload, key: [], "count": 0, "error": str(exc)}
    visible = [r for r in rows if isinstance(r, dict) and str(r.get("actor")) in allowed]
    return {**payload, key: _accounts.label_service_rows(visible), "count": len(visible)}


def _whoami_accounts(payload: dict[str, Any]) -> dict[str, Any]:
    principal = _scope_active()
    if principal is None:
        return payload
    return {**payload, "accounts": _accounts.principal_summary(principal)}


def main() -> None:
    """Entry point for the MCP server."""
    options = _transport_options(sys.argv[1:])
    if options["transport"] != "stdio":
        logger.info(
            f"Serving MCP over {options['transport']} at "
            f"http://{options['host']}:{options['port']}{options['path']}"
        )
    asyncio.run(async_main(**options))


if __name__ == "__main__":
    main()
