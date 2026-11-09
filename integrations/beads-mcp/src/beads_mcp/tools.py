"""MCP tools for beads issue tracker."""

import asyncio
import logging
import os
from contextlib import suppress
from contextvars import ContextVar
from functools import lru_cache
from typing import Annotated, Any

from . import pgstore
from .bd_client import BdClientBase, BdError, create_bd_client
from .change_feed import fetch_changes
from .mentions import space_of_issue
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
    DependencyType,
    InitParams,
    Issue,
    IssueStatus,
    IssueType,
    ListCommentsParams,
    ListIssuesParams,
    ReadyWorkParams,
    RemoveDependencyParams,
    ReopenIssueParams,
    ShowIssueParams,
    Stats,
    UpdateIssueParams,
)
from .notifications import annotate_comments
from .workspace import (
    get_git_workspace_roots as _get_git_workspace_roots,
)
from .workspace import (
    resolve_workspace_root as _shared_resolve_workspace_root,
)

logger = logging.getLogger(__name__)

# ContextVar for request-scoped workspace routing
current_workspace: ContextVar[str | None] = ContextVar("workspace", default=None)

# Whether that workspace was *asked for* (workspace_root=..., context(board=...))
# rather than guessed from the environment or the process cwd. An asked-for board
# that turns out not to exist is an error the caller has to see; a guessed one is
# allowed to keep searching, which is why the two cases cannot share a code path.
# Set by ``server.with_workspace``; lives here beside ``current_workspace`` because
# ``server`` imports ``tools`` and not the other way round.
workspace_was_explicit: ContextVar[bool] = ContextVar("workspace_explicit", default=False)

# Connection pool for per-project clients, keyed by (canonical root, stamped .beads).
# The board is part of the key because it is part of what the client *is*: one root
# can be reached with a board stamped or with none, and handing back a client bound
# to the wrong one is the bug this key exists to prevent.
_connection_pool: dict[tuple[str, str], BdClientBase] = {}
_pool_lock = asyncio.Lock()

# Version checking state (per-pool client)
_version_checked: set[str] = set()

# Default constants
DEFAULT_ISSUE_TYPE: IssueType = "task"
DEFAULT_DEPENDENCY_TYPE: DependencyType = "blocks"


async def beads_changes(
    *,
    after_cursor: str | None = None,
    since: str | None = None,
    until: str | None = None,
    boards: list[str] | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """Read the authenticated hosted cross-board keyset change feed."""
    from . import accounts as _acc
    from .agents import resolve_identity

    readable: set[str] | None = None
    if await asyncio.to_thread(_acc.accounts_enabled, os.environ):
        # Accounts mode: only boards the caller may read, ever. An explicit request
        # for an unreadable board narrows to nothing rather than erroring (no oracle).
        principal = (await asyncio.to_thread(resolve_identity)).get("principal")
        readable = await asyncio.to_thread(_acc.readable_boards, principal)
        if readable is not None:
            wanted = [b for b in (boards or sorted(readable)) if b in readable]
            if not wanted:
                return {"changes": [], "next_cursor": None, "complete": True}
            boards = wanted
    return await fetch_changes(
        after_cursor=after_cursor,
        since=since,
        until=until,
        boards=boards,
        limit=limit,
        readable_boards=readable,
    )


def _register_client_for_cleanup(client: BdClientBase) -> None:
    """Register client with server cleanup system.

    This ensures client connections are properly closed on server shutdown.
    Import is deferred to avoid circular dependency.
    """
    try:
        from . import server

        if hasattr(server, "_registered_clients"):
            server._registered_clients.append(client)
    except (ImportError, AttributeError):
        # Server module not available or cleanup not initialized - that's ok
        pass


def _has_beads_project_files(beads_dir: str) -> bool:
    """Check if a .beads directory contains actual project files.

    Mirrors hasBeadsProjectFiles in internal/beads/beads.go. Returns True when
    any of these are present: metadata.json, config.yaml, dolt/, embeddeddolt/,
    or a non-backup *.db file (excluding vc.db).
    """
    import glob

    if os.path.isfile(os.path.join(beads_dir, "metadata.json")):
        return True
    if os.path.isfile(os.path.join(beads_dir, "config.yaml")):
        return True
    if os.path.isdir(os.path.join(beads_dir, "dolt")):
        return True
    if os.path.isdir(os.path.join(beads_dir, "embeddeddolt")):
        return True

    for match in glob.glob(os.path.join(beads_dir, "*.db")):
        base = os.path.basename(match)
        if ".backup" not in base and base != "vc.db":
            return True

    return False


def _resolve_beads_redirect(beads_dir: str, workspace_root: str) -> str | None:
    """Follow a .beads/redirect file to the actual beads directory.

    Args:
        beads_dir: Path to the .beads directory that may contain a redirect
        workspace_root: The workspace root directory (parent of beads_dir)

    Returns:
        Resolved workspace root if redirect is valid, None otherwise
    """
    redirect_path = os.path.join(beads_dir, "redirect")
    if not os.path.isfile(redirect_path):
        return None

    try:
        with open(redirect_path) as f:
            redirect_target = f.read().strip()

        if not redirect_target:
            return None

        # Resolve relative to workspace_root (the redirect is written from the perspective
        # of being inside workspace_root, not inside workspace_root/.beads)
        # e.g., redirect contains "../../mayor/rig/.beads"
        # from agents/capable/, this resolves to the canonical .beads
        resolved = os.path.normpath(os.path.join(workspace_root, redirect_target))

        if not os.path.isdir(resolved):
            logger.debug(f"Redirect target {resolved} does not exist")
            return None

        # Verify the redirected location has a valid beads project
        # (SQLite *.db, embedded Dolt, server Dolt, or just metadata/config)
        if not _has_beads_project_files(resolved):
            logger.debug(f"Redirect target {resolved} has no valid beads project files")
            return None

        # Return the workspace root of the redirected location (parent of .beads)
        return os.path.dirname(resolved)

    except Exception as e:
        logger.debug(f"Failed to follow redirect: {e}")
        return None


def _find_beads_db_in_tree(start_dir: str | None = None) -> str | None:
    """Walk up directory tree looking for .beads/*.db (matches Go CLI behavior).

    Also follows .beads/redirect files to shared beads locations, which is
    essential for agent/worker directories that share a central database.

    Args:
        start_dir: Starting directory (default: current working directory)

    Returns:
        Absolute path to workspace root containing a valid .beads project,
        or None if not found. Detects SQLite (*.db), embedded Dolt
        (embeddeddolt/), server Dolt (dolt/), and metadata-only projects.
    """
    try:
        current = os.path.abspath(start_dir or os.getcwd())

        # Resolve symlinks like Go CLI does
        with suppress(Exception):
            current = os.path.realpath(current)

        git_roots = _get_git_workspace_roots(current)
        worktree_root = None
        fallback_root = None
        if git_roots is not None:
            worktree_root, main_repo_root = git_roots
            if main_repo_root != worktree_root:
                fallback_root = main_repo_root

        # Walk up directory tree, but do not cross the current repo/worktree boundary.
        while True:
            beads_dir = os.path.join(current, ".beads")
            if os.path.isdir(beads_dir):
                # First, check for redirect file (agent/worker directories use this)
                redirected = _resolve_beads_redirect(beads_dir, current)
                if redirected:
                    logger.debug(f"Followed redirect from {current} to {redirected}")
                    return redirected

                # No redirect — check for any valid beads project files
                # (matches Go's hasBeadsProjectFiles)
                if _has_beads_project_files(beads_dir):
                    return current

            parent = os.path.dirname(current)
            if parent == current:  # Reached filesystem root
                break
            if worktree_root is not None and current == worktree_root:
                break
            current = parent

        if fallback_root is not None:
            beads_dir = os.path.join(fallback_root, ".beads")
            if os.path.isdir(beads_dir):
                redirected = _resolve_beads_redirect(beads_dir, fallback_root)
                if redirected:
                    logger.debug(f"Followed shared worktree fallback from {fallback_root} to {redirected}")
                    return redirected

                if _has_beads_project_files(beads_dir):
                    return fallback_root

        return None

    except Exception as e:
        logger.debug(f"Failed to search for .beads in tree: {e}")
        return None


def _resolve_beads_project_at(workspace_root: str) -> str | None:
    """The beads project rooted at exactly ``workspace_root`` — no walking up.

    The walk-up in :func:`_find_beads_db_in_tree` is the right answer for a workspace
    nobody named: guessing is the whole point, and a parent's board beats no board.
    It is the wrong answer for a workspace somebody *did* name, where "not here" has
    to stay "not here" — otherwise a typo'd path, or a directory whose board was
    never initialized, quietly resolves to the enclosing repo's board and the issues
    land there.

    ``.beads/redirect`` is still followed, because a redirect is that directory
    saying where its board lives, not a search.

    Returns:
        The workspace root owning the board, or None when this exact directory has
        no beads project.
    """
    real = os.path.abspath(workspace_root)
    with suppress(Exception):
        real = os.path.realpath(real)

    beads_dir = os.path.join(real, ".beads")
    if not os.path.isdir(beads_dir):
        return None

    redirected = _resolve_beads_redirect(beads_dir, real)
    if redirected:
        return redirected

    return real if _has_beads_project_files(beads_dir) else None


def _resolve_workspace_root(path: str) -> str:
    """Resolve workspace root to the repo that owns the active beads workspace."""
    return _shared_resolve_workspace_root(path)


@lru_cache(maxsize=128)
def _canonicalize_path(path: str) -> str:
    """Canonicalize workspace path to handle symlinks and git repos.

    This ensures that different paths pointing to the same project
    (e.g., via symlinks) use the same client connection.

    Args:
        path: Workspace directory path

    Returns:
        Canonical path (handles symlinks and submodules correctly)
    """
    # 1. Resolve symlinks
    real = os.path.realpath(path)

    # 2. Check for local .beads directory (submodule edge case)
    # Submodules should use their own .beads, not the parent repo's
    if os.path.exists(os.path.join(real, ".beads")):
        return real

    # 3. Try to find git toplevel
    # This ensures we connect to the right client for the git repo
    return _resolve_workspace_root(real)


async def _health_check_client(client: BdClientBase) -> bool:
    """Check if a client is healthy and responsive.

    Args:
        client: Client to health check

    Returns:
        True if client is healthy, False otherwise
    """
    # Only health check clients that support ping
    if not hasattr(client, "ping"):
        return True

    try:
        await client.ping()
        return True
    except Exception:
        # Any exception means the client is stale/unhealthy
        return False


async def _reconnect_client(canonical: str, beads_dir: str | None = None, max_retries: int = 3) -> BdClientBase:
    """Attempt to reconnect with exponential backoff.

    Args:
        canonical: Canonical workspace path
        beads_dir: The board to stamp on this client's bd children, if the workspace
            has one. Must match what the pooled client carried, or a reconnect would
            silently move the caller to a different board.
        max_retries: Maximum number of retry attempts (default: 3)

    Returns:
        New client instance

    Raises:
        BdError: If all reconnection attempts fail
    """
    for attempt in range(max_retries):
        try:
            client = create_bd_client(working_dir=canonical, beads_dir=beads_dir)

            # Verify new client works
            if await _health_check_client(client):
                _register_client_for_cleanup(client)
                return client

        except Exception:
            if attempt < max_retries - 1:
                # Exponential backoff: 0.1s, 0.2s, 0.4s
                backoff = 0.1 * (2**attempt)
                await asyncio.sleep(backoff)
            continue

    raise BdError(
        f"Failed to connect after {max_retries} attempts. The bd client may be misconfigured or unresponsive."
    )


def _no_board_at(workspace: str) -> BdError:
    """The refusal for a named workspace with no board — and, under accounts mode, for
    one whose board the caller cannot read (the two must be indistinguishable)."""
    return BdError(
        f"No beads board at the requested workspace: {workspace}\n"
        f"  Expected marker: {os.path.join(workspace, '.beads')} "
        f"(a directory holding config.yaml, metadata.json, embeddeddolt/ or *.db)\n"
        "  This path was named explicitly, so no parent directory was searched — "
        "a board found by walking up would be somebody else's.\n"
        "  Create one with context(action='init', workspace_root=...) or board_create(), "
        "or name a workspace that already has a board (boards_list())."
    )


def _board_readable(board_id: str) -> bool:
    """Whether the current principal may read this board; always true with accounts off."""
    from . import accounts as _acc
    from .agents import resolve_identity

    if not _acc.accounts_enabled(os.environ):
        return True
    ok, _reason = _acc.check_board(resolve_identity().get("principal"), board_id, False)
    return ok


def _enforce_board_access(board_id: str) -> None:
    """Refuse the call unless the current principal may touch this board.

    Reads need ``space_read`` on the board's space; a call inside an authorized
    mutation (``require_write`` ran) needs ``item_write``. A no-op unless accounts
    mode is on, so local and silo deployments are untouched.

    Raises:
        ToolError: On refusal, without naming the space or confirming the board exists.
    """
    from fastmcp.exceptions import ToolError

    from . import accounts as _acc
    from .agents import authorized_mutation_context, resolve_identity

    if not _acc.accounts_enabled(os.environ):
        return
    principal = resolve_identity().get("principal")
    write = authorized_mutation_context() is not None
    ok, reason = _acc.check_board(principal, board_id, write)
    if not ok:
        raise ToolError(f"refused: {reason}")


def _enforce_board_init(workspace: str) -> None:
    """Refuse ``init`` (``bd init`` + the store's board row) unless accounts mode is off,
    or the caller may write and holds ``board_create`` on the target's space: the
    space of the board already stored there, else the default space every new board
    lands in. A refusal names nothing about the target.

    Raises:
        ToolError: On refusal.
    """
    from fastmcp.exceptions import ToolError

    from . import accounts as _acc
    from .access import decide_access
    from .agents import authorize, resolve_identity

    if not _acc.accounts_enabled(os.environ):
        return
    decision = authorize("write")
    if not decision["allowed"]:
        raise ToolError(f"refused: {decision['reason']}")
    principal = resolve_identity().get("principal")
    target = pgstore.board_id_for_workspace(workspace)
    space = _acc.board_space(target) if target else ""
    known = bool(target) and target in _acc.board_space_map(data_ids=False)
    if known and not space:
        # A registered row whose data is no board's (see board_data_id): never.
        raise ToolError("refused: that board is not available to this identity")
    verdict = decide_access(principal, "board_create", {"space": space or _acc.DEFAULT_SPACE_ID})
    if not verdict.allowed:
        raise ToolError("refused: that board is not available to this identity")


async def _get_client(allow_boardless: bool = False) -> BdClientBase:
    """Get a BdClient instance for the current workspace.

    Uses connection pool to manage per-project clients.
    Workspace is auto-detected using the same logic as CLI:
    1. current_workspace ContextVar (from workspace_root parameter)
    2. BEADS_WORKING_DIR environment variable
    3. Walk up from CWD looking for .beads/*.db

    Performs health check before returning cached client.
    On failure, drops from pool and attempts reconnection with exponential backoff.

    Performs version check on first connection to each workspace.

    Which *store* the client reads is a separate question from which *board* it is bound
    to, and only the store moves: with ``FEADS_PG_DSN`` set this hands back a
    :class:`beads_mcp.pgstore.PgStoreClient` for the resolved board and never spawns
    ``bd``; with it unset the CLI client below is reached by exactly the path it always
    was. ``init`` (``allow_boardless``) stays on the CLI either way — creating a board on
    disk is not something the database can do.

    Args:
        allow_boardless: Accept a named workspace that has no board yet. Only ``init``
            wants this — every other caller naming a boardless path has made a
            mistake, and answering it with a client bound to some other board is how
            that mistake becomes somebody else's issues.

    Returns:
        Configured BdClientBase instance for the current workspace

    Raises:
        BdError: If no workspace found, or bd is not installed, or version is incompatible
    """
    # Determine workspace using standard search order (matches Go CLI)
    requested = current_workspace.get()
    explicit = bool(requested) and workspace_was_explicit.get()
    workspace = requested or os.environ.get("BEADS_WORKING_DIR")

    # Auto-detect from CWD if not explicitly set (NEW!)
    if not workspace:
        workspace = _find_beads_db_in_tree()
        if workspace:
            logger.debug(f"Auto-detected workspace from CWD: {workspace}")

    if not workspace:
        if os.environ.get("FEADS_HOSTED", "").strip().lower() in {"1", "true", "yes", "on"}:
            raise BdError(
                "No board is selected for this session and this call names no issue id "
                "to route by. Pick the board once — board_route(text='...', repo='owner/name') "
                "or boards_list(), then context(board='<board-id>') — and retry. "
                "Calls that carry an issue id (show, update, close, comment, dep, artifact "
                "tools) route by the id's prefix automatically and need no board selection. "
                "Board context is server-side session state; there is nothing to install or "
                "configure on your machine."
            )
        raise BdError(
            "No local Beads workspace found. Either:\n"
            '  1. Call context(workspace_root="/path/to/project"), OR\n'
            "  2. Run from a directory containing .beads/, OR\n"
            "  3. Set BEADS_WORKING_DIR environment variable"
        )

    # None means "whatever the environment binds" — the pre-existing behavior for a
    # workspace nobody named. Anything else is a decision this call is making.
    beads_dir: str | None = None

    if explicit:
        # A named workspace resolves at its own path or not at all. Falling through to
        # the git walk-up here is how a call that asked for one board writes to
        # another one — the failure this whole binding path exists to make impossible.
        resolved = _resolve_beads_project_at(workspace)
        if resolved is not None:
            canonical = resolved
        elif allow_boardless:
            # init: there is no board here yet, and the empty binding says so — the
            # child runs with BEADS_DIR *removed*, so `bd init` creates the board in
            # this directory instead of finding the daemon's and refusing.
            canonical = os.path.realpath(os.path.abspath(workspace))
            beads_dir = ""
        else:
            raise _no_board_at(workspace)
    else:
        # Canonicalize path to handle symlinks and deduplicate connections
        canonical = _canonicalize_path(workspace)

    # Bind the board when the caller named this workspace. Without this the client
    # inherits BEADS_DIR from the server's own environment (a hosted daemon exports
    # one for the board it serves), and bd reads that ahead of cwd — so the child
    # opened the daemon's board no matter which board the call asked for.
    #
    # A *guessed* workspace deliberately does not bind, and keeps inheriting. The
    # ambient BEADS_DIR is the operator's default board, set on the daemon on
    # purpose; a call that named nothing has not overruled it, and stamping the
    # board that happens to sit above the server's cwd would move that default
    # without anybody asking. Naming a board is what overrules it — which is the
    # whole point of the branch above.
    if explicit and beads_dir is None:
        candidate_dir = os.path.join(canonical, ".beads")
        if _has_beads_project_files(candidate_dir):
            beads_dir = candidate_dir

    # The strangler seam. With FEADS_PG_DSN set, issue data comes from Postgres and no
    # bd process is ever spawned for it — but *which board* is still resolved by
    # everything above, unchanged, so a path that exists nowhere is refused by the same
    # code that refused it before and a session's board switch means what it always did.
    # `init` is the exception on purpose: it creates a board on disk, which is a
    # question only the CLI can answer, and it is also the one caller that legitimately
    # names a directory with no board in it yet.
    # Space RBAC (accounts mode): the one choke point every board read and write
    # passes through. Deny by default — an anonymous caller, a board in a space the
    # principal cannot reach, or a write from a read-only system key never gets a
    # client. See the excluded hosted-provider design
    if not allow_boardless:
        bound_board = pgstore.board_id_for_workspace(canonical)
        if explicit and not _board_readable(bound_board):
            # A named workspace whose board the caller cannot read answers exactly like
            # a path with no board at all, so a guessed path never confirms that a board
            # exists in another space (DESIGN "Enforcement map": unknown and inaccessible
            # boards answer identically on every surface).
            raise _no_board_at(workspace)
        _enforce_board_access(bound_board)

    if not allow_boardless and pgstore.pg_enabled():
        board_id = pgstore.board_id_for_workspace(canonical)
        pg_key = ("pg", board_id)
        async with _pool_lock:
            existing = _connection_pool.get(pg_key)
            if existing is None:
                existing = pgstore.PgStoreClient(board_id=board_id, workspace_root=canonical)
                _connection_pool[pg_key] = existing
        # No version check and no health check: there is no subprocess whose version
        # could mismatch, and the pool below us already validates its own connections.
        return existing

    # "*" is the inherit-from-environment client and "" the deliberately unbound one.
    # They behave differently, so they are different pool entries.
    pool_key = (canonical, "*" if beads_dir is None else beads_dir)

    # Thread-safe connection pool access
    async with _pool_lock:
        if pool_key in _connection_pool:
            # Health check cached client before returning
            client = _connection_pool[pool_key]
            if not await _health_check_client(client):
                # Stale connection - remove from pool and reconnect
                del _connection_pool[pool_key]
                if canonical in _version_checked:
                    _version_checked.remove(canonical)

                # Attempt reconnection with backoff
                client = await _reconnect_client(canonical, beads_dir)
                _connection_pool[pool_key] = client
        else:
            # Create new client for this workspace
            client = create_bd_client(working_dir=canonical, beads_dir=beads_dir)

            # Register for cleanup
            _register_client_for_cleanup(client)

            # Add to pool
            _connection_pool[pool_key] = client

    # Check version once per workspace (only for CLI client)
    if canonical not in _version_checked:
        if hasattr(client, "_check_version"):
            await client._check_version()
        _version_checked.add(canonical)

    return client


async def beads_ready_work(
    limit: Annotated[int, "Maximum number of issues to return (1-100)"] = 10,
    priority: Annotated[int | None, "Filter by priority (0-4, 0=highest)"] = None,
    issue_type: Annotated[
        IssueType | None, "Filter by type (task, bug, feature, epic, chore, decision, merge-request, or custom)"
    ] = None,
    assignee: Annotated[str | None, "Filter by assignee"] = None,
    labels: Annotated[list[str] | None, "Filter by labels (AND: must have ALL)"] = None,
    labels_any: Annotated[list[str] | None, "Filter by labels (OR: must have at least one)"] = None,
    unassigned: Annotated[bool, "Filter to only unassigned issues"] = False,
    sort_policy: Annotated[str | None, "Sort policy: hybrid (default), priority, oldest"] = None,
    parent: Annotated[str | None, "Filter to descendants of this bead/epic"] = None,
) -> list[Issue]:
    """Find issues with no blocking dependencies that are ready to work on.

    Ready work = status is 'open' AND no blocking dependencies.
    Perfect for agents to claim next work!

    Use 'parent' to filter to all descendants of an epic/bead.
    """
    client = await _get_client()
    params = ReadyWorkParams(
        limit=limit,
        priority=priority,
        issue_type=issue_type,
        assignee=assignee,
        labels=labels,
        labels_any=labels_any,
        unassigned=unassigned,
        sort_policy=sort_policy,
        parent_id=parent,
    )
    return await client.ready(params)


async def beads_list_issues(
    status: Annotated[
        IssueStatus | None, "Filter by status (open, in_progress, blocked, deferred, closed, or custom)"
    ] = None,
    priority: Annotated[int | None, "Filter by priority (0-4, 0=highest)"] = None,
    issue_type: Annotated[
        IssueType | None, "Filter by type (bug, feature, task, epic, chore, decision, or custom)"
    ] = None,
    assignee: Annotated[str | None, "Filter by assignee"] = None,
    labels: Annotated[list[str] | None, "Filter by labels (AND: must have ALL)"] = None,
    labels_any: Annotated[list[str] | None, "Filter by labels (OR: must have at least one)"] = None,
    query: Annotated[str | None, "Search in title (case-insensitive substring)"] = None,
    unassigned: Annotated[bool, "Filter to only unassigned issues"] = False,
    limit: Annotated[int, "Maximum number of issues to return (1-100)"] = 20,
    workspace_dir_prefix: Annotated[
        str | None, "Only issues whose workspace_dir binding is at or below this directory"
    ] = None,
    ids: Annotated[list[str] | None, "Only these issue ids (open first, then in this order)"] = None,
) -> list[Issue]:
    """List all issues with optional filters."""
    client = await _get_client()

    params = ListIssuesParams(
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
    return await client.list_issues(params)


async def beads_show_issue(
    issue_id: Annotated[str, "Issue ID (e.g., bd-1)"],
) -> Issue:
    """Show detailed information about a specific issue.

    Includes full description, dependencies, and dependents.
    """
    client = await _get_client()
    params = ShowIssueParams(issue_id=issue_id)
    return await client.show(params)


async def beads_create_issue(
    title: Annotated[str, "Issue title"],
    description: Annotated[str, "Issue description"] = "",
    design: Annotated[str | None, "Design notes"] = None,
    acceptance: Annotated[str | None, "Acceptance criteria"] = None,
    external_ref: Annotated[str | None, "External reference (e.g., gh-9, jira-ABC)"] = None,
    priority: Annotated[int, "Priority (0-4, 0=highest)"] = 2,
    issue_type: Annotated[
        IssueType, "Type: bug, feature, task, epic, chore, decision, or custom"
    ] = DEFAULT_ISSUE_TYPE,
    assignee: Annotated[str | None, "Assignee username"] = None,
    labels: Annotated[list[str] | None, "List of labels"] = None,
    id: Annotated[str | None, "Explicit issue ID (e.g., bd-42)"] = None,
    deps: Annotated[list[str] | None, "Dependencies (e.g., ['bd-20', 'blocks:bd-15'])"] = None,
    workspace_dir: Annotated[str | None, "Workspace binding: absolute worktree directory"] = None,
    session_id: Annotated[str | None, "Workspace binding: agent session id"] = None,
    host: Annotated[str | None, "Workspace binding: hostname the session runs on"] = None,
) -> Issue:
    """Create a new issue.

    IMPORTANT: Always provide a meaningful description with context about:
    - Why this issue exists (problem statement or need)
    - What needs to be done (scope and approach)
    - How you discovered it (if applicable)

    Issues without descriptions lack context for future work and make prioritization difficult.

    Use this when you discover new work during your session.
    Link it back with beads_add_dependency using 'discovered-from' type.
    """
    client = await _get_client()
    params = CreateIssueParams(
        title=title,
        description=description,
        design=design,
        acceptance=acceptance,
        external_ref=external_ref,
        priority=priority,
        issue_type=issue_type,
        assignee=assignee,
        labels=labels or [],
        id=id,
        deps=deps or [],
        workspace_dir=workspace_dir,
        session_id=session_id,
        host=host,
    )
    return await client.create(params)


async def beads_update_issue(
    issue_id: Annotated[str, "Issue ID (e.g., bd-1)"],
    status: Annotated[
        IssueStatus | None, "New status (open, in_progress, blocked, deferred, closed, or custom)"
    ] = None,
    priority: Annotated[int | None, "New priority (0-4)"] = None,
    assignee: Annotated[str | None, "New assignee"] = None,
    title: Annotated[str | None, "New title"] = None,
    description: Annotated[str | None, "Issue description"] = None,
    design: Annotated[str | None, "Design notes"] = None,
    acceptance_criteria: Annotated[str | None, "Acceptance criteria"] = None,
    notes: Annotated[str | None, "Additional notes"] = None,
    external_ref: Annotated[str | None, "External reference (e.g., gh-9, jira-ABC)"] = None,
    labels: Annotated[list[str] | None, "Replace the full label set; omit to leave unchanged"] = None,
    metadata: Annotated[
        dict[str, Any] | None,
        "Top-level metadata merge; null values delete keys. "
        "metadata.effort = {pre_ai_hours, effective_hours, ai_accel, source}",
    ] = None,
    workspace_dir: Annotated[str | None, "Workspace binding: absolute worktree directory"] = None,
    session_id: Annotated[str | None, "Workspace binding: agent session id"] = None,
    host: Annotated[str | None, "Workspace binding: hostname the session runs on"] = None,
) -> Issue | list[Issue]:
    """Update an existing issue.

    Note: Setting status to 'closed' or 'open' will automatically route to
    beads_close_issue() or beads_reopen_issue() respectively to ensure
    proper approval workflows are followed.

    `labels` replaces the whole set: `[]` clears it, `None` leaves it alone.
    `metadata` merges top-level keys into the existing object: non-null values set or
    replace a key and `null` deletes it. The standard effort shape is
    `metadata.effort = {pre_ai_hours, effective_hours, ai_accel, source}`.
    """
    # Smart routing: intercept lifecycle status changes and route to dedicated tools.
    # close/reopen carry no label payload, so a relabel asked for in the same call is
    # applied here first rather than being dropped on the floor without saying so.
    if status in ("closed", "open") and labels is not None:
        relabel = await _get_client()
        await relabel.update(UpdateIssueParams(issue_id=issue_id, labels=labels))

    if status == "closed":
        # Route to close tool to respect approval workflows
        reason = notes if notes else "Completed"
        return await beads_close_issue(issue_id=issue_id, reason=reason, metadata=metadata)

    if status == "open":
        # Route to reopen tool to respect approval workflows, but do not drop a
        # metadata patch carried by the same update call.
        if metadata is not None:
            reopen_client = await _get_client()
            await reopen_client.update(UpdateIssueParams(issue_id=issue_id, metadata=metadata))
        reason = notes if notes else "Reopened"
        return await beads_reopen_issue(issue_ids=[issue_id], reason=reason)

    # Normal attribute updates proceed as usual
    client = await _get_client()
    params = UpdateIssueParams(
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
    return await client.update(params)


async def beads_claim_issue(
    issue_id: Annotated[str, "Issue ID (e.g., bd-1)"],
    force: Annotated[bool, "Take over your own claim held by another of your sessions"] = False,
) -> Issue:
    """Atomically claim an issue for work.

    Uses `bd update <id> --claim` semantics: sets assignee + in_progress in one
    compare-and-swap operation and fails if already claimed.
    """
    client = await _get_client()
    params = ClaimIssueParams(issue_id=issue_id, force=force)
    return await client.claim(params)


async def beads_close_issue(
    issue_id: Annotated[str, "Issue ID (e.g., bd-1)"],
    reason: Annotated[str, "Reason for closing"] = "Completed",
    force: Annotated[bool, "Bypass the assignee mismatch guard"] = False,
    metadata: Annotated[
        dict[str, Any] | None,
        "Top-level metadata merge; null values delete keys. "
        "metadata.effort = {pre_ai_hours, effective_hours, ai_accel, source}",
    ] = None,
) -> list[Issue]:
    """Close (complete) an issue.

    Mark work as done when you've finished implementing/fixing it. By default, closing
    somebody else's assigned issue is refused; ``force`` bypasses only that guard.
    `metadata` merges into the existing metadata object; null values delete keys.
    """
    client = await _get_client()
    params = CloseIssueParams(issue_id=issue_id, reason=reason, force=force, metadata=metadata)
    return await client.close(params)


async def beads_reopen_issue(
    issue_ids: Annotated[list[str], "Issue IDs to reopen (e.g., ['bd-1', 'bd-2'])"],
    reason: Annotated[str | None, "Reason for reopening"] = None,
) -> list[Issue]:
    """Reopen one or more closed issues.

    Sets status to 'open' and clears the closed_at timestamp.
    More explicit than 'update --status open'.
    """
    client = await _get_client()
    params = ReopenIssueParams(issue_ids=issue_ids, reason=reason)
    return await client.reopen(params)


async def beads_add_dependency(
    issue_id: Annotated[str, "Issue that has the dependency (e.g., bd-2)"],
    depends_on_id: Annotated[str, "Issue that issue_id depends on (e.g., bd-1)"],
    dep_type: Annotated[
        DependencyType,
        "Dependency type. Common: blocks, related, parent-child, discovered-from. "
        "Full set validated by bd CLI (see internal/types/types.go).",
    ] = DEFAULT_DEPENDENCY_TYPE,
) -> str:
    """Add a dependency relationship between two issues.

    Common types:
    - blocks: depends_on_id must complete before issue_id can start
    - related: Soft connection, doesn't block progress
    - parent-child: Epic/subtask hierarchical relationship
    - discovered-from: Track that issue_id was discovered while working on depends_on_id

    Other supported types include relates-to, replies-to, duplicates, supersedes,
    caused-by, validates, and more. The bd CLI is the source of truth for the
    full list — see internal/types/types.go.

    Use 'discovered-from' when you find new work during your session.
    """
    client = await _get_client()
    params = AddDependencyParams(
        issue_id=issue_id,
        depends_on_id=depends_on_id,
        dep_type=dep_type,
    )
    try:
        await client.add_dependency(params)
        return f"Added dependency: {issue_id} depends on {depends_on_id} ({dep_type})"
    except BdError as e:
        return f"Error: {str(e)}"


async def beads_remove_dependency(
    issue_id: Annotated[str, "Issue that has the dependency (e.g., bd-2)"],
    depends_on_id: Annotated[str, "Issue it depends on, the edge's other end (e.g., bd-1)"],
) -> str:
    """Remove a dependency relationship between two issues.

    The counterpart `dep` was missing (#feads-qyo). Without it a wrongly-typed edge was
    unfixable over MCP: `dep` refuses to retype an existing edge and tells you to run
    `bd dep remove` first, which was a CLI-only verb — so an agent that filed a session
    epic with the wrong edge type had to ask a human with a shell.

    Drops the edge whatever its type, matching `bd dep remove`. Removing an edge that
    does not exist succeeds quietly rather than erroring, so the retype sequence
    (remove, then `dep` with the right type) is safe to repeat.
    """
    client = await _get_client()
    params = RemoveDependencyParams(issue_id=issue_id, depends_on_id=depends_on_id)
    try:
        await client.remove_dependency(params)
        return f"Removed dependency: {issue_id} no longer depends on {depends_on_id}"
    except BdError as e:
        return f"Error: {str(e)}"


async def beads_add_comment(
    issue_id: Annotated[str, "Issue ID (e.g., bd-1)"],
    text: Annotated[str, "Comment text — a human-readable summary of work done, decisions, or verification"],
) -> str:
    """Add a comment to an issue.

    Leave a durable, timestamped record of what you did, decided, or verified so
    humans don't have to read the agent transcript to know what happened. `show`
    reports comment_count but not the bodies — use beads_list_comments to read them.

    Prefer a comment over overwriting `notes`: comments accumulate as a per-turn
    trail, whereas the notes field is a single value that gets replaced.
    """
    client = await _get_client()
    params = AddCommentParams(issue_id=issue_id, text=text)
    return await client.add_comment(params)


async def beads_list_comments(
    issue_id: Annotated[str, "Issue ID (e.g., bd-1)"],
) -> list[Comment]:
    """List all comments on an issue in chronological order.

    `show` returns comment_count but not the comment bodies; use this to read them.

    Each comment is annotated with the `@actors` and `#issue-id`s written in its text
    (see :func:`beads_mcp.notifications.annotate_comments`). That happens here rather
    than in the tool layer so every reader of a comment gets the same reading of it:
    the conventions are a property of the text, not of one surface's presentation.
    Annotation is additive and cannot fail the call — an unreadable registry degrades
    the mention list rather than raising.
    """
    client = await _get_client()
    params = ListCommentsParams(issue_id=issue_id)
    comments = await client.list_comments(params)
    space = await space_of_issue(issue_id) if any("@" in c.text for c in comments) else None
    return await asyncio.to_thread(annotate_comments, comments, None, None, space)


async def beads_add_note(
    issue_id: Annotated[str, "Issue ID (e.g., bd-1)"],
    text: Annotated[str, "Note text to append to the issue's notes field"],
) -> str:
    """Append a note to an issue's notes field (`bd note`).

    Notes are a single running field on the issue. For a per-turn, timestamped
    trail that multiple actors can follow, prefer beads_add_comment.
    """
    client = await _get_client()
    params = AddNoteParams(issue_id=issue_id, text=text)
    return await client.add_note(params)


async def beads_quickstart() -> str:
    """Get bd quickstart guide.

    Read this first to understand how to use beads (bd) commands.
    """
    client = await _get_client()
    return await client.quickstart()


async def beads_stats() -> Stats:
    """Get statistics about issues.

    Returns total issues, open, in_progress, closed, blocked, ready issues,
    and average lead time in hours.
    """
    client = await _get_client()
    return await client.stats()


async def beads_blocked(
    parent: Annotated[str | None, "Filter to descendants of this bead/epic"] = None,
) -> list[BlockedIssue]:
    """Get blocked issues.

    Returns issues that have blocking dependencies, showing what blocks them.

    Use 'parent' to filter to all descendants of an epic/bead.
    """
    client = await _get_client()
    params = BlockedParams(parent_id=parent)
    return await client.blocked(params)


async def beads_inspect_migration() -> dict[str, Any]:
    """Get migration plan and database state for agent analysis.

    AI agents should:
    1. Review registered_migrations to understand what will run
    2. Check warnings array for issues (missing config, version mismatch)
    3. Verify missing_config is empty before migrating
    4. Check invariants_to_check to understand safety guarantees

    Returns migration plan, current db state, warnings, and invariants.
    """
    client = await _get_client()
    return await client.inspect_migration()


async def beads_get_schema_info() -> dict[str, Any]:
    """Get current database schema for inspection.

    Returns tables, schema version, config, sample issue IDs, and detected prefix.
    Useful for verifying database state before migrations.
    """
    client = await _get_client()
    return await client.get_schema_info()


async def beads_repair_deps(
    fix: Annotated[bool, "If True, automatically remove orphaned dependencies"] = False,
) -> dict[str, Any]:
    """Find and optionally fix orphaned dependency references.

    Scans all issues for dependencies pointing to non-existent issues.
    Returns orphaned dependencies and optionally removes them with fix=True.

    Returns dict with:
    - orphans_found: number of orphaned dependencies
    - orphans: list of orphaned dependency details
    - fixed: number of orphans fixed (if fix=True)
    """
    client = await _get_client()
    return await client.repair_deps(fix=fix)


async def beads_detect_pollution(
    clean: Annotated[bool, "If True, delete detected test issues"] = False,
) -> dict[str, Any]:
    """Detect test issues that leaked into production database.

    Detects test issues using pattern matching:
    - Titles starting with 'test', 'benchmark', 'sample', 'tmp', 'temp'
    - Sequential numbering (test-1, test-2, ...)
    - Generic descriptions or no description
    - Created in rapid succession

    Returns dict with detected test issues and deleted count if clean=True.
    """
    client = await _get_client()
    return await client.detect_pollution(clean=clean)


async def beads_validate(
    checks: Annotated[
        str | None, "Comma-separated list of checks (orphans,duplicates,pollution,conflicts)"
    ] = None,
    fix_all: Annotated[bool, "If True, auto-fix all fixable issues"] = False,
) -> dict[str, Any]:
    """Run comprehensive database health checks.

    Available checks:
    - orphans: Orphaned dependencies (references to deleted issues)
    - duplicates: Duplicate issues (identical content)
    - pollution: Test pollution (leaked test issues)
    - conflicts: Git merge conflicts in JSONL

    If checks is None, runs all checks.

    Returns dict with validation results for each check.
    """
    client = await _get_client()
    return await client.validate(checks=checks, fix_all=fix_all)


async def beads_init(
    prefix: Annotated[str | None, "Issue prefix (e.g., 'myproject' for myproject-1, myproject-2)"] = None,
) -> str:
    """Initialize bd in current directory.

    Creates .beads/ directory and database file with optional custom prefix.

    In pg mode the board is created on disk *and* registered in the Postgres store,
    because otherwise the two halves disagree the moment the agent uses the board it
    just made: the directory exists, the registry knows it, and the first ``create``
    fails with "not in the feads Postgres store". Registration is reported in the
    returned text rather than silently — a board that could not be registered still
    needs a human, and the failure has to be visible where the creation was.
    """
    # Accounts mode: creating a board writes the server's filesystem and the store, so
    # it needs a write-capable person with board_create on the space the board will
    # land in — never an anonymous caller or a read-only system key.
    _enforce_board_init(current_workspace.get() or os.environ.get("BEADS_WORKING_DIR") or os.getcwd())
    # The one caller allowed to name a directory with no board in it — that is what
    # it is for. See :func:`_get_client`.
    client = await _get_client(allow_boardless=True)
    params = InitParams(prefix=prefix)
    result = await client.init(params)

    if not pgstore.pg_enabled():
        return result

    workspace = current_workspace.get() or os.environ.get("BEADS_WORKING_DIR") or os.getcwd()
    return result + await _register_pg_board(workspace, prefix or "", client)


async def _register_pg_board(workspace: str, prefix: str, client: BdClientBase | None = None) -> str:
    """Add a just-created board to the Postgres store; return a line describing what happened.

    The prefix comes from bd itself when it can (``bd info --schema`` reports the
    ``detected_prefix`` the board actually minted with) and is derived the way ``bd
    init`` derives it only as a fallback. The order matters: bd's answer is a fact,
    ours is a reproduction of bd's algorithm, and the reproduction can be wrong for the
    one case it cannot see — an ``issue-prefix`` set in a config file.
    """
    board_id = pgstore.board_id_for_workspace(workspace)
    resolved = pgstore.normalize_issue_prefix(prefix) or pgstore.default_prefix_for_workspace(workspace)

    if client is not None:
        with suppress(Exception):
            schema = await client.get_schema_info()
            detected = str((schema.get("schema") or {}).get("detected_prefix") or "")
            if detected:
                resolved = detected

    outcome = await pgstore.ensure_board(board_id, resolved)
    if outcome.get("error"):
        return f"\n\nWARNING: {outcome['error']}"
    if outcome.get("existing"):
        return (
            f"\n\nPostgres store: board '{board_id}' was already registered "
            f"(prefix {outcome['prefix']}); left as it was."
        )
    return f"\n\nPostgres store: registered board '{board_id}' with prefix '{outcome['prefix']}'."
