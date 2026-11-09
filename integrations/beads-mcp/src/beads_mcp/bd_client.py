"""Client for interacting with bd (beads) CLI and daemon."""

import asyncio
import json
import os
import re
import sys
from abc import ABC, abstractmethod
from collections.abc import Mapping
from typing import Any

from .agents import acting_actor, authorized_mutation_context
from .bd_stderr import failure_detail
from .config import load_config
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
from .silo import configured_silo
from .workspace_state import (
    WORKSPACE_DIR_KEY,
    binding_from_metadata,
    binding_metadata,
    create_binding,
    normalize_workspace_dir,
)


def _under_workspace_prefix(rows: list[Any], prefix: str) -> list[Any]:
    """The rows whose ``workspace_dir`` binding is at or below ``prefix``.

    Path-boundary aware: ``/w/dev-tools-old`` is not under ``/w/dev-tools``, which a bare
    ``startswith`` would claim it is. Equality still counts — the workspace itself is
    under itself.
    """
    boundary = prefix if prefix.endswith(os.sep) else prefix + os.sep
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        directory = binding_from_metadata(row.get("metadata")).get(WORKSPACE_DIR_KEY, "")
        if directory == prefix or directory.startswith(boundary):
            out.append(row)
    return out


def _sanitize_issue_deps(issue: dict[str, Any]) -> dict[str, Any]:
    """Strip raw dependency records that don't match the LinkedIssue schema.

    bd list/ready/blocked --json returns raw dep records (issue_id, depends_on_id,
    type, created_at) but the Pydantic Issue model expects enriched LinkedIssue
    objects (id, title, status, etc.). Replace raw records with empty lists and
    preserve counts so validation succeeds.
    """
    for field, count_field in [
        ("dependencies", "dependency_count"),
        ("dependents", "dependent_count"),
    ]:
        raw = issue.get(field)
        if isinstance(raw, list) and raw and isinstance(raw[0], dict) and "depends_on_id" in raw[0]:
            issue[count_field] = len(raw)
            issue[field] = []
    return issue


class BdError(Exception):
    """Base exception for bd CLI errors."""

    pass


class ActorResolutionError(BdError):
    """A silo mutation could not establish a verified acting actor."""

    pass


def silo_configured(env: Mapping[str, str] | None = None) -> bool:
    """Validate and report whether this call is running in a silo.

    The exact-value contract lives in :mod:`beads_mcp.silo`; this compatibility
    wrapper keeps the mutation-facing exception type used by the bd and Postgres
    clients. A malformed non-empty value is never reduced to base mode.
    """
    try:
        return configured_silo(env) is not None
    except ValueError as exc:
        raise ActorResolutionError(str(exc)) from exc


def mutation_actor(
    fallback: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
) -> str:
    """Resolve the actor for a subprocess or mutation.

    Base-mode callers retain their historical fallback chain. A valid silo is a
    different trust boundary: the mutation must consume the identity authorized
    for this tool invocation, and an absent/stale context is a refusal rather than
    permission to resolve or guess from config, environment, git, or the host.
    """
    in_silo = silo_configured(env)
    if in_silo:
        context = authorized_mutation_context()
        if context is None or not context.actor:
            raise ActorResolutionError("a valid FEADS_SILO requires an authorized acting actor")
        return context.actor
    actor = acting_actor() if env is None and db_path is None else acting_actor(env, db_path)
    return actor or fallback or ""


class BdNotFoundError(BdError):
    """Raised when bd command is not found."""

    @staticmethod
    def installation_message(attempted_path: str) -> str:
        """Get helpful installation message.

        Args:
            attempted_path: Path where we tried to find bd

        Returns:
            Formatted error message with installation instructions
        """
        return (
            f"bd CLI not found at: {attempted_path}\n\n"
            "The beads Claude Code plugin requires the bd CLI to be installed separately.\n\n"
            "Install bd CLI:\n"
            "  curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash\n\n"
            "Or visit: https://github.com/gastownhall/beads#installation\n\n"
            "After installation, restart Claude Code to reload the MCP server."
        )


class BdCommandError(BdError):
    """Raised when bd command fails.

    ``stderr`` keeps bd's output verbatim for logs and tests. The *message* does not:
    it is built with :func:`~beads_mcp.bd_stderr.failure_detail`, which drops bd's
    advisory lines. bd prefixes every run in a clone with no ``beads.role`` with a
    three-line nudge, and an error that opens with "warning: beads.role not configured"
    buries the actual failure under remediation aimed at whoever owns the server
    (#feads-r8d).
    """

    stderr: str
    returncode: int

    def __init__(self, message: str, stderr: str = "", returncode: int = 1):
        super().__init__(message)
        self.stderr = stderr
        self.returncode = returncode


class BdVersionError(BdError):
    """Raised when bd version is incompatible with MCP server."""

    pass


class BdClientBase(ABC):
    """Abstract base class for bd clients (CLI or daemon)."""

    @abstractmethod
    async def ready(self, params: ReadyWorkParams | None = None) -> list[Issue]:
        """Get ready work (issues with no blockers)."""
        pass

    @abstractmethod
    async def list_issues(self, params: ListIssuesParams | None = None) -> list[Issue]:
        """List issues with optional filters."""
        pass

    @abstractmethod
    async def show(self, params: ShowIssueParams) -> Issue:
        """Show detailed issue information."""
        pass

    @abstractmethod
    async def create(self, params: CreateIssueParams) -> Issue:
        """Create a new issue."""
        pass

    @abstractmethod
    async def update(self, params: UpdateIssueParams) -> Issue:
        """Update an existing issue."""
        pass

    @abstractmethod
    async def claim(self, params: ClaimIssueParams) -> Issue:
        """Atomically claim an issue for work."""
        pass

    @abstractmethod
    async def close(self, params: CloseIssueParams) -> list[Issue]:
        """Close one or more issues."""
        pass

    @abstractmethod
    async def reopen(self, params: ReopenIssueParams) -> list[Issue]:
        """Reopen one or more closed issues."""
        pass

    @abstractmethod
    async def add_dependency(self, params: AddDependencyParams) -> None:
        """Add a dependency between issues."""
        pass

    @abstractmethod
    async def remove_dependency(self, params: RemoveDependencyParams) -> None:
        """Remove a dependency between issues."""
        pass

    @abstractmethod
    async def add_comment(self, params: AddCommentParams) -> str:
        """Add a comment to an issue."""
        pass

    @abstractmethod
    async def list_comments(self, params: ListCommentsParams) -> list[Comment]:
        """List comments on an issue."""
        pass

    @abstractmethod
    async def add_note(self, params: AddNoteParams) -> str:
        """Append a note to an issue's notes field."""
        pass

    @abstractmethod
    async def quickstart(self) -> str:
        """Get quickstart guide."""
        pass

    @abstractmethod
    async def stats(self) -> Stats:
        """Get repository statistics."""
        pass

    @abstractmethod
    async def blocked(self, params: BlockedParams | None = None) -> list[BlockedIssue]:
        """Get blocked issues."""
        pass

    @abstractmethod
    async def init(self, params: InitParams | None = None) -> str:
        """Initialize a new beads database."""
        pass

    @abstractmethod
    async def inspect_migration(self) -> dict[str, Any]:
        """Get migration plan and database state for agent analysis."""
        pass

    @abstractmethod
    async def get_schema_info(self) -> dict[str, Any]:
        """Get current database schema for inspection."""
        pass

    @abstractmethod
    async def repair_deps(self, fix: bool = False) -> dict[str, Any]:
        """Find and optionally fix orphaned dependency references.

        Args:
            fix: If True, automatically remove orphaned dependencies

        Returns:
            Dict with orphans_found, orphans list, and fixed count if fix=True
        """
        pass

    @abstractmethod
    async def detect_pollution(self, clean: bool = False) -> dict[str, Any]:
        """Detect test issues that leaked into production database.

        Args:
            clean: If True, delete detected test issues

        Returns:
            Dict with detected test issues and deleted count if clean=True
        """
        pass

    @abstractmethod
    async def validate(self, checks: str | None = None, fix_all: bool = False) -> dict[str, Any]:
        """Run database validation checks.

        Args:
            checks: Comma-separated list of checks (orphans,duplicates,pollution,conflicts)
            fix_all: If True, auto-fix all fixable issues

        Returns:
            Dict with validation results for each check
        """
        pass


class BdCliClient(BdClientBase):
    """Client for calling bd CLI commands and parsing JSON output."""

    bd_path: str
    beads_dir: str | None
    beads_db: str | None
    actor: str | None
    no_auto_flush: bool
    no_auto_import: bool
    working_dir: str | None

    def __init__(
        self,
        bd_path: str | None = None,
        beads_dir: str | None = None,
        beads_db: str | None = None,
        actor: str | None = None,
        no_auto_flush: bool | None = None,
        no_auto_import: bool | None = None,
        working_dir: str | None = None,
    ):
        """Initialize bd client.

        Args:
            bd_path: Path to bd executable (optional, loads from config if not provided)
            beads_dir: Path to .beads directory (optional, loads from config if not provided)
            beads_db: Path to beads database file (deprecated, optional, loads from config if not provided)
            actor: Actor name for audit trail (optional, loads from config if not provided)
            no_auto_flush: Disable automatic JSONL sync (optional, loads from config if not provided)
            no_auto_import: Disable automatic JSONL import (optional, loads from config if not provided)
            working_dir: Working directory for bd commands (optional, loads from config/env if not provided)
        """
        config = load_config()
        self.bd_path = bd_path if bd_path is not None else config.beads_path
        self.beads_dir = beads_dir if beads_dir is not None else config.beads_dir
        self.beads_db = beads_db if beads_db is not None else config.beads_db
        self.actor = actor if actor is not None else config.beads_actor
        self.no_auto_flush = no_auto_flush if no_auto_flush is not None else config.beads_no_auto_flush
        self.no_auto_import = no_auto_import if no_auto_import is not None else config.beads_no_auto_import
        self.working_dir = working_dir if working_dir is not None else config.beads_working_dir

    def _get_working_dir(self) -> str:
        """Get working directory for bd commands.

        Returns:
            Working directory path, falls back to current directory if not configured
        """
        if self.working_dir:
            return self.working_dir
        # Use process working directory (set by MCP client at spawn time)
        return os.getcwd()

    def _acting_actor(self, *, mutation: bool = False) -> str:
        """The actor this specific call's bd invocation is attributed to.

        The caller's verified wire identity wins, and it has to be read **per
        call**: clients are pooled per workspace and shared across requests, so
        anything captured on the instance describes whoever's request built the
        client, not whoever is calling now. ``self.actor`` (the process
        environment, via config) is only the fallback for a caller that verified
        as nobody — which on stdio is the operator, whose environment genuinely
        is their own, and on HTTP is a caller the write gate refuses anyway.
        """
        if mutation:
            return mutation_actor(fallback=self.actor)
        return acting_actor() or self.actor or ""

    def _child_env(self) -> dict[str, str]:
        """The environment every bd child of this client runs with.

        bd resolves its board from BEADS_DIR first and only falls back to walking up
        from cwd (internal/storage/domain/fs/beads.go: ``resolveBeadsDir``), so an
        ambient BEADS_DIR — the hosted daemon exports one for the board it was started
        against — outranks the workspace a tool call just resolved. Stamping the bound
        board positively is therefore not enough: the *other* variables have to be
        removed in the same breath, or a client bound by cwd alone still opens the
        daemon's board and mints issues there.

        Tri-state, the same shape as ``artifacts._run_bd``:

        * bound to a ``.beads`` directory — stamp BEADS_DIR, drop BEADS_DB/BD_DB;
        * bound to a database file — stamp BEADS_DB, drop BEADS_DIR;
        * bound to a working directory only — drop both so cwd discovery decides;
        * bound to nothing — leave the environment alone, which is what a
          never-bound stdio session (seeded purely from its own environment) wants.
        """
        env = os.environ.copy()
        # The explicit --actor flag is authoritative, but do not leave a
        # configured host actor available as a second source in silo mode.
        if silo_configured():
            env.pop("BEADS_ACTOR", None)
        if self.beads_dir:
            env["BEADS_DIR"] = self.beads_dir
            env.pop("BEADS_DB", None)
            env.pop("BD_DB", None)
        elif self.beads_db:
            env["BEADS_DB"] = self.beads_db
            env.pop("BEADS_DIR", None)
        elif self.working_dir:
            env.pop("BEADS_DIR", None)
            env.pop("BEADS_DB", None)
            env.pop("BD_DB", None)
        return env

    def _spawn_failure(self, e: FileNotFoundError, working_dir: str | None) -> BdError:
        """Translate a spawn-time FileNotFoundError into the error that is actually true.

        create_subprocess_exec raises the same FileNotFoundError for a missing
        program and a missing working directory, and reporting the wrong one
        sends the caller chasing a phantom bd install: the hosted server saw
        exactly that when a client-local workspace_root that does not exist
        server-side surfaced as "bd CLI not found at: /opt/feads/bd". The cwd
        is checked directly rather than trusting e.filename, which not every
        platform fills in.
        """
        if working_dir is not None and not os.path.isdir(working_dir):
            return BdError(
                f"Working directory does not exist on this server: {working_dir}\n"
                "The workspace points at a path this server cannot see — if you are "
                "talking to a remote/hosted server, paths on your local machine do not "
                "exist here. Switch with context(board='<id>') (see boards_list()), or "
                "pass a workspace_root that exists where the server runs."
            )
        return BdNotFoundError(BdNotFoundError.installation_message(self.bd_path))

    @staticmethod
    def _command_mutates(args: tuple[str, ...]) -> bool:
        """Whether a bd command writes attribution-bearing state."""
        if not args:
            return False
        if args[0] == "repair-deps":
            return "--fix" in args
        if args[0] == "doctor":
            return "--fix" in args or "--clean" in args
        return args[0] in {
            "claim",
            "close",
            "comment",
            "create",
            "dep",
            "init",
            "note",
            "reopen",
            "update",
        }

    def _global_flags(self, *, mutation: bool = False) -> list[str]:
        """Build list of global flags for bd commands.

        Returns:
            List of global flag arguments
        """
        silo_configured()
        flags = []
        # NOTE: --db flag removed in v0.20.1, bd now auto-discovers database via cwd
        # We pass cwd via _run_command instead
        actor = self._acting_actor(mutation=mutation)
        if actor:
            flags.extend(["--actor", actor])
        if self.no_auto_flush:
            flags.append("--no-auto-flush")
        if self.no_auto_import:
            flags.append("--no-auto-import")
        return flags

    async def _run_command(self, *args: str, cwd: str | None = None) -> Any:
        """Run bd command and parse JSON output.

        Args:
            *args: Command arguments to pass to bd
            cwd: Optional working directory override for this command

        Returns:
            Parsed JSON output (dict or list)

        Raises:
            BdNotFoundError: If bd command not found
            BdCommandError: If bd command fails
        """
        cmd = [
            self.bd_path,
            *args,
            *self._global_flags(mutation=self._command_mutates(args)),
            "--json",
        ]
        working_dir = cwd if cwd is not None else self._get_working_dir()

        # Set up environment with database configuration
        env = self._child_env()

        # Log database routing for debugging
        if self.beads_dir:
            db_info = f"BEADS_DIR={self.beads_dir}"
        elif self.beads_db:
            db_info = f"BEADS_DB={self.beads_db} (deprecated)"
        else:
            db_info = "auto-discover"
        print(f"[beads-mcp] Running bd command: {' '.join(args)}", file=sys.stderr)
        print(f"[beads-mcp]   Database: {db_info}", file=sys.stderr)
        print(f"[beads-mcp]   Working dir: {working_dir}", file=sys.stderr)

        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,  # Prevent inheriting MCP's stdin
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=working_dir,
                env=env,
            )
            stdout, stderr = await process.communicate()
        except FileNotFoundError as e:
            raise self._spawn_failure(e, working_dir) from e

        if process.returncode != 0:
            raw = stderr.decode()
            raise BdCommandError(
                f"bd command failed: {failure_detail(raw, process.returncode)}",
                stderr=raw,
                returncode=process.returncode or 1,
            )

        stdout_str = stdout.decode().strip()
        if not stdout_str:
            return {}

        try:
            result: object = json.loads(stdout_str)
            return result
        except json.JSONDecodeError as e:
            raise BdCommandError(
                f"Failed to parse bd JSON output: {e}",
                stderr=stdout_str,
            ) from e

    async def _check_version(self) -> None:
        """Check that bd CLI version meets minimum requirements.

        Raises:
            BdVersionError: If bd version is incompatible
            BdNotFoundError: If bd command not found
        """
        # Minimum required version
        min_version = (0, 9, 0)

        # A silo read must not inherit the host actor, but it does not need an
        # authorized mutation context merely to inspect the installed version.
        version_env = None
        if silo_configured():
            version_env = os.environ.copy()
            version_env.pop("BEADS_ACTOR", None)

        working_dir = self._get_working_dir()
        try:
            process = await asyncio.create_subprocess_exec(
                self.bd_path,
                "version",
                stdin=asyncio.subprocess.DEVNULL,  # Prevent inheriting MCP's stdin
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=working_dir,
                env=version_env,
            )
            stdout, stderr = await process.communicate()
        except FileNotFoundError as e:
            raise self._spawn_failure(e, working_dir) from e

        if process.returncode != 0:
            raw = stderr.decode()
            raise BdCommandError(
                f"bd version failed: {failure_detail(raw, process.returncode)}",
                stderr=raw,
                returncode=process.returncode or 1,
            )

        # Parse version from output like "bd version 0.9.2"
        version_output = stdout.decode().strip()
        match = re.search(r"(\d+)\.(\d+)\.(\d+)", version_output)
        if not match:
            raise BdVersionError(f"Could not parse bd version from: {version_output}")

        version = tuple(int(x) for x in match.groups())

        if version < min_version:
            min_ver_str = ".".join(str(x) for x in min_version)
            cur_ver_str = ".".join(str(x) for x in version)
            install_cmd = (
                "curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash"
            )
            raise BdVersionError(
                f"bd version {cur_ver_str} is too old. "
                f"This MCP server requires bd >= {min_ver_str}. "
                f"Update with: {install_cmd}"
            )

    async def ready(self, params: ReadyWorkParams | None = None) -> list[Issue]:
        """Get ready work (issues with no blocking dependencies).

        Args:
            params: Query parameters

        Returns:
            List of ready issues
        """
        params = params or ReadyWorkParams()
        args = ["ready", "--limit", str(params.limit)]

        if params.issue_type:
            args.extend(["--type", params.issue_type])
        if params.priority is not None:
            args.extend(["--priority", str(params.priority)])
        if params.assignee:
            args.extend(["--assignee", params.assignee])
        if params.labels:
            for label in params.labels:
                args.extend(["--label", label])
        if params.labels_any:
            for label in params.labels_any:
                args.extend(["--label-any", label])
        if params.unassigned:
            args.append("--unassigned")
        if params.sort_policy:
            args.extend(["--sort", params.sort_policy])
        if params.parent_id:
            args.extend(["--parent", params.parent_id])

        data = await self._run_command(*args)
        if not isinstance(data, list):
            return []

        return [Issue.model_validate(_sanitize_issue_deps(issue)) for issue in data]

    async def list_issues(self, params: ListIssuesParams | None = None) -> list[Issue]:
        """List issues with optional filters.

        Args:
            params: Query parameters

        Returns:
            List of issues
        """
        params = params or ListIssuesParams()
        args = ["list"]

        if params.status:
            args.extend(["--status", params.status])
        if params.priority is not None:
            args.extend(["--priority", str(params.priority)])
        if params.issue_type:
            args.extend(["--type", params.issue_type])
        if params.assignee:
            args.extend(["--assignee", params.assignee])
        if params.labels:
            for label in params.labels:
                args.extend(["--label", label])
        if params.labels_any:
            for label in params.labels_any:
                args.extend(["--label-any", label])
        if params.query:
            args.extend(["--title", params.query])
        if params.unassigned:
            args.append("--no-assignee")

        prefix = normalize_workspace_dir(params.workspace_dir_prefix)
        if prefix:
            # bd can select "has this metadata key" and "equals this exact value", but not
            # "starts with". So the key narrows the scan to bound issues server-side and
            # the prefix is applied here — the same split `artifacts.py` uses for its
            # marker key, including the load-bearing `--limit 0`: bd's default 50 would
            # let a busy board answer "nothing in that workspace" for the 51st row.
            args.extend(["--limit", "0", "--has-metadata-key", WORKSPACE_DIR_KEY])
        elif params.ids is not None:
            # Filtered below: scan the board, not the first page of it.
            args.extend(["--limit", "0"])
            if not params.status:
                args.append("--all")
        elif params.limit:
            args.extend(["--limit", str(params.limit)])

        data = await self._run_command(*args)
        if not isinstance(data, list):
            return []

        if prefix:
            data = _under_workspace_prefix(data, prefix)[: params.limit]

        if params.ids is not None:
            # bd has no id filter: narrow here, in the order given (open first).
            order = {issue_id: index for index, issue_id in enumerate(params.ids)}
            data = [d for d in data if isinstance(d, dict) and str(d.get("id")) in order]
            data.sort(key=lambda d: (str(d.get("status")) == "closed", order[str(d.get("id"))]))
            data = data[: params.limit]

        return [Issue.model_validate(_sanitize_issue_deps(issue)) for issue in data]

    async def show(self, params: ShowIssueParams) -> Issue:
        """Show issue details.

        Args:
            params: Issue ID to show

        Returns:
            Issue details

        Raises:
            BdCommandError: If issue not found
        """
        data = await self._run_command("show", params.issue_id)
        # bd show returns an array, extract first element
        if isinstance(data, list):
            if not data:
                raise BdCommandError(f"Issue not found: {params.issue_id}")
            data = data[0]

        if not isinstance(data, dict):
            raise BdCommandError(f"Invalid response for show {params.issue_id}")

        return Issue.model_validate(data)

    async def create(self, params: CreateIssueParams) -> Issue:
        """Create a new issue.

        Args:
            params: Issue creation parameters

        Returns:
            Created issue
        """
        args = ["create", params.title, "-p", str(params.priority), "-t", params.issue_type]

        if params.description:
            args.extend(["-d", params.description])
        if params.design:
            args.extend(["--design", params.design])
        if params.acceptance:
            args.extend(["--acceptance", params.acceptance])
        if params.external_ref:
            args.extend(["--external-ref", params.external_ref])
        if params.assignee:
            args.extend(["--assignee", params.assignee])
        if params.id:
            args.extend(["--id", params.id])
        for label in params.labels:
            args.extend(["-l", label])
        if params.deps:
            args.extend(["--deps", ",".join(params.deps)])

        binding = create_binding(
            params.issue_type,
            workspace_dir=params.workspace_dir,
            session_id=params.session_id,
            host=params.host,
            workspace_root=self.working_dir,
        )
        if binding:
            args.extend(["--metadata", json.dumps(binding, separators=(",", ":"))])

        data = await self._run_command(*args)
        if not isinstance(data, dict):
            raise BdCommandError("Invalid response for create")

        return Issue.model_validate(data)

    async def update(self, params: UpdateIssueParams) -> Issue:
        """Update an issue.

        ``params.labels`` replaces the whole label set. bd has no "set these labels"
        flag that can express the empty set (``--set-labels`` is ignored when the slice
        it parses is empty, which is exactly the clear-all case), so the replacement is
        expressed as the diff against what the bead carries now and handed to
        ``--add-label`` / ``--remove-label`` on the same ``bd update`` call. bd re-reads
        the issue after applying labels, so the reply already carries the new set.

        Args:
            params: Issue update parameters

        Returns:
            Updated issue
        """
        args = ["update", params.issue_id]

        if params.labels is not None:
            args.extend(await self._label_diff_args(params.issue_id, params.labels))

        if params.status:
            args.extend(["--status", params.status])
        if params.priority is not None:
            args.extend(["--priority", str(params.priority)])
        if params.assignee:
            args.extend(["--assignee", params.assignee])
        if params.title:
            args.extend(["--title", params.title])
        if params.description:
            args.extend(["--description", params.description])
        if params.design:
            args.extend(["--design", params.design])
        if params.acceptance_criteria:
            args.extend(["--acceptance", params.acceptance_criteria])
        if params.notes:
            args.extend(["--notes", params.notes])
        if params.external_ref:
            args.extend(["--external-ref", params.external_ref])

        binding = binding_metadata(
            workspace_dir=params.workspace_dir,
            session_id=params.session_id,
            host=params.host,
        )
        for key, value in binding.items():
            # `--set-metadata` rather than `--metadata`: the latter shallow-merges a whole
            # object, and bd refuses to combine it with the incremental flags, so a rebind
            # expressed that way would race any artifact key written between the read and
            # the write. Per-key edits are applied inside bd's own transaction.
            args.extend(["--set-metadata", f"{key}={value}"])

        # `bd update --metadata` cannot be combined with its incremental metadata
        # flags. Run the ordinary fields first, then apply the JSON patch and deletes
        # as separate transactional updates; each command still merges against the
        # current row rather than a stale snapshot.
        regular_data = None
        if len(args) > 2:
            regular_data = await self._run_command(*args)
        metadata_data = await self._merge_metadata(params.issue_id, params.metadata)
        data = metadata_data if metadata_data is not None else regular_data
        if data is None:
            data = await self._run_command("show", params.issue_id)
        # bd update returns an array, extract first element
        if isinstance(data, list):
            if not data:
                raise BdCommandError(f"Issue not found: {params.issue_id}")
            data = data[0]

        if not isinstance(data, dict):
            raise BdCommandError(f"Invalid response for update {params.issue_id}")

        return Issue.model_validate(data)

    async def _merge_metadata(self, issue_id: str, metadata: dict[str, Any] | None) -> object | None:
        """Apply a top-level metadata patch, deleting keys whose value is null."""
        if metadata is None:
            return None
        values = {key: value for key, value in metadata.items() if value is not None}
        deletes = [key for key, value in metadata.items() if value is None]
        result = None
        if values:
            result = await self._run_command(
                "update", issue_id, "--metadata", json.dumps(values, separators=(",", ":"))
            )
        for key in deletes:
            result = await self._run_command("update", issue_id, "--unset-metadata", key)
        return result

    async def _label_diff_args(self, issue_id: str, labels: list[str]) -> list[str]:
        """The ``--add-label`` / ``--remove-label`` flags that turn today's set into ``labels``.

        One flag occurrence per label rather than a comma-joined value: cobra's
        StringSlice splits on commas, so joining would silently shred any label that
        contains one.

        Args:
            issue_id: Issue whose labels are being replaced
            labels: The complete label set the caller wants afterwards

        Returns:
            Flags to append to a ``bd update`` invocation (empty when already correct)
        """
        current = set((await self.show(ShowIssueParams(issue_id=issue_id))).labels)
        wanted = set(labels)

        args: list[str] = []
        for label in sorted(wanted - current):
            args.extend(["--add-label", label])
        for label in sorted(current - wanted):
            args.extend(["--remove-label", label])
        return args

    async def claim(self, params: ClaimIssueParams) -> Issue:
        """Atomically claim an issue via bd update --claim.

        Args:
            params: Claim parameters

        Returns:
            Claimed issue
        """
        data = await self._run_command("update", params.issue_id, "--claim")
        # bd update returns an array, extract first element
        if isinstance(data, list):
            if not data:
                raise BdCommandError(f"Issue not found: {params.issue_id}")
            data = data[0]

        if not isinstance(data, dict):
            raise BdCommandError(f"Invalid response for claim {params.issue_id}")

        return Issue.model_validate(data)

    async def close(self, params: CloseIssueParams) -> list[Issue]:
        """Close an issue.

        Args:
            params: Close parameters

        Returns:
            List containing closed issue
        """
        args = ["close", params.issue_id, "--reason", params.reason]
        if params.force:
            args.append("--force")

        data = await self._run_command(*args)
        if not isinstance(data, list):
            raise BdCommandError(f"Invalid response for close {params.issue_id}")

        metadata_data = await self._merge_metadata(params.issue_id, params.metadata)
        if metadata_data is not None:
            data = metadata_data if isinstance(metadata_data, list) else [metadata_data]
        return [Issue.model_validate(issue) for issue in data]

    async def reopen(self, params: ReopenIssueParams) -> list[Issue]:
        """Reopen one or more closed issues.

        Args:
            params: Reopen parameters

        Returns:
            List of reopened issues
        """
        args = ["reopen", *params.issue_ids]

        if params.reason:
            args.extend(["--reason", params.reason])

        data = await self._run_command(*args)
        if not isinstance(data, list):
            raise BdCommandError(f"Invalid response for reopen {params.issue_ids}")

        return [Issue.model_validate(issue) for issue in data]

    async def add_dependency(self, params: AddDependencyParams) -> None:
        """Add a dependency between issues.

        Args:
            params: Dependency parameters
        """
        # bd dep add doesn't return JSON, just prints confirmation
        cmd = [
            self.bd_path,
            "dep",
            "add",
            params.issue_id,
            params.depends_on_id,
            "--type",
            params.dep_type,
            *self._global_flags(mutation=True),
        ]

        # Set up environment with database configuration
        env = self._child_env()

        working_dir = self._get_working_dir()
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,  # Prevent inheriting MCP's stdin
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=working_dir,
                env=env,
            )
            _stdout, stderr = await process.communicate()
        except FileNotFoundError as e:
            raise self._spawn_failure(e, working_dir) from e

        if process.returncode != 0:
            raw = stderr.decode()
            raise BdCommandError(
                f"bd dep add failed: {failure_detail(raw, process.returncode)}",
                stderr=raw,
                returncode=process.returncode or 1,
            )

    async def remove_dependency(self, params: RemoveDependencyParams) -> None:
        """Remove a dependency between issues.

        ``bd dep remove`` prints a confirmation rather than JSON, so this goes through
        the same text path as ``comment`` and ``note``.

        Args:
            params: Dependency parameters (issue_id, depends_on_id)
        """
        await self._run_text_command("dep", "remove", params.issue_id, params.depends_on_id)

    async def _run_text_command(self, *args: str) -> str:
        """Run a bd command that returns plain text (not JSON) and return stdout.

        Used for subcommands like `comment`/`note` that print a confirmation
        line rather than JSON. Mirrors _run_command's env and error handling.
        """
        cmd = [
            self.bd_path,
            *args,
            *self._global_flags(mutation=True),
        ]

        env = self._child_env()

        working_dir = self._get_working_dir()
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,  # Prevent inheriting MCP's stdin
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=working_dir,
                env=env,
            )
            stdout, stderr = await process.communicate()
        except FileNotFoundError as e:
            raise self._spawn_failure(e, working_dir) from e

        if process.returncode != 0:
            raw = stderr.decode()
            raise BdCommandError(
                f"bd {args[0]} failed: {failure_detail(raw, process.returncode)}",
                stderr=raw,
                returncode=process.returncode or 1,
            )

        return stdout.decode().strip()

    async def add_comment(self, params: AddCommentParams) -> str:
        """Add a comment to an issue via `bd comment <id> <text>`.

        Args:
            params: Comment parameters (issue_id, text)

        Returns:
            Confirmation message
        """
        await self._run_text_command("comment", params.issue_id, params.text)
        return f"Added comment to {params.issue_id}"

    async def list_comments(self, params: ListCommentsParams) -> list[Comment]:
        """List comments on an issue via `bd comments <id>`.

        Args:
            params: Parameters containing the issue_id

        Returns:
            List of comments in chronological order
        """
        data = await self._run_command("comments", params.issue_id)
        if not isinstance(data, list):
            return []
        return [Comment.model_validate(comment) for comment in data]

    async def add_note(self, params: AddNoteParams) -> str:
        """Append a note to an issue's notes field via `bd note <id> <text>`.

        Args:
            params: Note parameters (issue_id, text)

        Returns:
            Confirmation message
        """
        await self._run_text_command("note", params.issue_id, params.text)
        return f"Appended note to {params.issue_id}"

    async def quickstart(self) -> str:
        """Get bd quickstart guide.

        Returns:
            Quickstart guide text
        """
        cmd = [self.bd_path, "quickstart"]
        # Quickstart is a read; keep the host actor out of a silo child without
        # requiring an authorized mutation context.
        quickstart_env = None
        if silo_configured():
            quickstart_env = os.environ.copy()
            quickstart_env.pop("BEADS_ACTOR", None)

        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,  # Prevent inheriting MCP's stdin
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._get_working_dir(),
                env=quickstart_env,
            )
            stdout, stderr = await process.communicate()
        except FileNotFoundError as e:
            raise BdNotFoundError(BdNotFoundError.installation_message(self.bd_path)) from e

        if process.returncode != 0:
            raise BdCommandError(
                f"bd quickstart failed: {failure_detail(stderr.decode(), process.returncode)}",
                stderr=stderr.decode(),
                returncode=process.returncode or 1,
            )

        return stdout.decode()

    async def stats(self) -> Stats:
        """Get statistics about issues.

        Returns:
            Statistics object
        """
        data = await self._run_command("stats")
        if not isinstance(data, dict):
            raise BdCommandError("Invalid response for stats")

        return Stats.model_validate(data)

    async def blocked(self, params: BlockedParams | None = None) -> list[BlockedIssue]:
        """Get blocked issues.

        Args:
            params: Query parameters

        Returns:
            List of blocked issues with blocking information
        """
        params = params or BlockedParams()
        args = ["blocked"]
        if params.parent_id:
            args.extend(["--parent", params.parent_id])

        data = await self._run_command(*args)
        if not isinstance(data, list):
            return []

        return [BlockedIssue.model_validate(_sanitize_issue_deps(issue)) for issue in data]

    async def inspect_migration(self) -> dict[str, Any]:
        """Get migration plan and database state for agent analysis.

        Returns:
            Migration plan dict with registered_migrations, warnings, etc.
        """
        data = await self._run_command("migrate", "--inspect")
        if not isinstance(data, dict):
            raise BdCommandError("Invalid response for inspect_migration")
        return data

    async def get_schema_info(self) -> dict[str, Any]:
        """Get current database schema for inspection.

        Returns:
            Schema info dict with tables, version, config, sample IDs, etc.
        """
        data = await self._run_command("info", "--schema")
        if not isinstance(data, dict):
            raise BdCommandError("Invalid response for get_schema_info")
        return data

    async def repair_deps(self, fix: bool = False) -> dict[str, Any]:
        """Find and optionally fix orphaned dependency references.

        Args:
            fix: If True, automatically remove orphaned dependencies

        Returns:
            Dict with orphans_found, orphans list, and fixed count if fix=True
        """
        args = ["repair-deps"]
        if fix:
            args.append("--fix")

        data = await self._run_command(*args)
        if not isinstance(data, dict):
            raise BdCommandError("Invalid response for repair-deps")
        return data

    async def detect_pollution(self, clean: bool = False) -> dict[str, Any]:
        """Detect test issues that leaked into production database.

        Args:
            clean: If True, delete detected test issues

        Returns:
            Dict with detected test issues and deleted count if clean=True
        """
        args = ["doctor", "--check=pollution"]
        if clean:
            args.extend(["--clean", "--yes"])

        data = await self._run_command(*args)
        if not isinstance(data, dict):
            raise BdCommandError("Invalid response for doctor --check=pollution")
        return data

    async def validate(self, checks: str | None = None, fix_all: bool = False) -> dict[str, Any]:
        """Run database validation checks via bd doctor --check=validate.

        Args:
            checks: Accepted for backward compatibility but no longer applied.
                bd doctor --check=validate runs the full data-integrity suite
                (duplicates, orphaned issues, conflicts) and has no flag for
                selecting a subset. Use detect_pollution() for the pollution check.
            fix_all: If True, auto-fix all fixable issues

        Returns:
            Dict with validation results for each check
        """
        del checks  # subset selection is unsupported by bd doctor (see docstring)
        args = ["doctor", "--check=validate"]
        if fix_all:
            args.append("--fix")
            args.append("--yes")

        data = await self._run_command(*args)
        if not isinstance(data, dict):
            raise BdCommandError("Invalid response for doctor --check=validate")
        return data

    async def init(self, params: InitParams | None = None) -> str:
        """Initialize bd in current directory.

        Args:
            params: Initialization parameters

        Returns:
            Initialization output message
        """
        params = params or InitParams()
        cmd = [self.bd_path, "init"]

        if params.prefix:
            cmd.extend(["--prefix", params.prefix])

        # NOTE: Do NOT add --db flag for init!
        # init creates a NEW database in the current directory.
        # Only add actor-related flags.
        actor = self._acting_actor(mutation=True)
        if actor:
            cmd.extend(["--actor", actor])

        # init is the one subcommand that used to inherit the ambient environment
        # wholesale (no env= at all). That is the most dangerous place to inherit it:
        # a stray BEADS_DIR sends `bd init` at somebody else's board instead of the
        # workspace this call resolved, so it runs through the same tri-state stamp
        # as every other bd child — which for a cwd-bound client means BEADS_DIR is
        # *removed*, and init creates the board where the caller asked for it.
        working_dir = self._get_working_dir()
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,  # Prevent inheriting MCP's stdin
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=working_dir,
                env=self._child_env(),
            )
            stdout, stderr = await process.communicate()
        except FileNotFoundError as e:
            raise self._spawn_failure(e, working_dir) from e

        if process.returncode != 0:
            raise BdCommandError(
                f"bd init failed: {failure_detail(stderr.decode(), process.returncode)}",
                stderr=stderr.decode(),
                returncode=process.returncode or 1,
            )

        return stdout.decode()


# Backwards compatibility alias
BdClient = BdCliClient


def create_bd_client(
    prefer_daemon: bool = False,
    bd_path: str | None = None,
    beads_dir: str | None = None,
    beads_db: str | None = None,
    actor: str | None = None,
    no_auto_flush: bool | None = None,
    no_auto_import: bool | None = None,
    working_dir: str | None = None,
) -> BdClientBase:
    """Create a bd CLI client.

    Args:
        prefer_daemon: Deprecated, ignored. Kept for API compatibility.
        bd_path: Path to bd executable
        beads_dir: Path to .beads directory
        beads_db: Path to beads database (deprecated)
        actor: Actor name for audit trail
        no_auto_flush: Disable auto-flush
        no_auto_import: Disable auto-import
        working_dir: Working directory for database discovery

    Returns:
        BdClientBase implementation (CLI)
    """
    return BdCliClient(
        bd_path=bd_path,
        beads_dir=beads_dir,
        beads_db=beads_db,
        actor=actor,
        no_auto_flush=no_auto_flush,
        no_auto_import=no_auto_import,
        working_dir=working_dir,
    )
