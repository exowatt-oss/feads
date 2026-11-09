"""Tests for which board a tool call actually writes to.

The bug these exist for is silent and expensive: the hosted daemon exports
``BEADS_DIR`` for the board it was started against, ``bd`` reads that ahead of its
cwd, and the MCP handed every child a copy of its own environment. A call that
resolved workspace *A* therefore minted its issues on board *B*, with nothing in the
response to say so — the id came back, the tool reported success, and the work was
simply on the wrong board.

So these tests assert the child process environment rather than the tool's answer.
A round-trip against a fixture board cannot see the difference (there is only one
board), and the tool's return value never could. ``bd`` is stubbed at
``asyncio.create_subprocess_exec``: what is under test is the argv, the cwd and the
env we hand it, not what bd does with them.

The rest of the suite pops ``BEADS_DIR`` in its fixtures to get isolation. These
tests deliberately *set* it — to a decoy board that must never be written — because
an override you cannot see being overridden proves nothing.
"""

import json
import os
from pathlib import Path
from typing import Any

import pytest
from fastmcp.client import Client
from fastmcp.exceptions import ToolError

from beads_mcp import server, tools
from beads_mcp.bd_client import BdError
from beads_mcp.boards import REGISTRY_DB_ENV
from beads_mcp.server import mcp
from beads_mcp.tools import current_workspace, workspace_was_explicit
from tests.test_boards_registry import make_registry


class Spawn:
    """One recorded ``bd`` invocation."""

    def __init__(self, argv: list[str], kwargs: dict[str, Any]) -> None:
        self.argv = argv
        self.env: dict[str, str] | None = kwargs.get("env")
        self.cwd: str | None = kwargs.get("cwd")

    @property
    def command(self) -> str:
        """The bd subcommand, e.g. ``list`` — argv[0] is the bd binary."""
        return self.argv[1] if len(self.argv) > 1 else ""

    def __repr__(self) -> str:
        return f"Spawn({self.command!r}, cwd={self.cwd!r})"


class FakeProcess:
    """Just enough of ``asyncio.subprocess.Process`` for the client to parse."""

    def __init__(self, stdout: bytes) -> None:
        self._stdout = stdout
        self.returncode = 0

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, b""


def _canned_stdout(command: str) -> bytes:
    """What bd would have printed, in the shape the client parses."""
    if command == "version":
        return b"bd version 0.30.0\n"
    if command in {"list", "ready", "blocked", "comments"}:
        return json.dumps([]).encode()
    if command == "create":
        # An issue object, because the client validates create's reply against the
        # model before this test ever gets to look at the env it was spawned with.
        return json.dumps(
            {
                "id": "t-1",
                "title": "bound to the named board",
                "status": "open",
                "priority": 2,
                "issue_type": "task",
                "created_at": "2026-08-02T00:00:00Z",
                "updated_at": "2026-08-02T00:00:00Z",
            }
        ).encode()
    if command == "init":
        return b"bd initialized successfully!\n"
    return b"ok\n"


@pytest.fixture
def spawns(monkeypatch: pytest.MonkeyPatch) -> list[Spawn]:
    """Record every bd subprocess this server would have started."""
    recorded: list[Spawn] = []

    async def fake_exec(*argv: str, **kwargs: Any) -> FakeProcess:
        spawn = Spawn(list(argv), kwargs)
        recorded.append(spawn)
        return FakeProcess(_canned_stdout(spawn.command))

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_exec)
    return recorded


@pytest.fixture(autouse=True)
def _clean_routing_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """No pooled clients, no cached canonical paths, no inherited context.

    All three are process-global and all three cache a *board*, so a leftover from
    another test is a false pass here.
    """
    tools._connection_pool.clear()
    tools._version_checked.clear()
    tools._canonicalize_path.cache_clear()
    server._workspace_contexts.clear()
    for var in ("BEADS_DIR", "BEADS_DB", "BD_DB", "BEADS_WORKING_DIR", "BEADS_CONTEXT_SET"):
        monkeypatch.delenv(var, raising=False)
    yield
    tools._connection_pool.clear()
    tools._version_checked.clear()
    tools._canonicalize_path.cache_clear()
    server._workspace_contexts.clear()


def make_board(root: Path) -> Path:
    """A directory that reads as an initialized board without running bd init."""
    beads = root / ".beads"
    beads.mkdir(parents=True)
    (beads / "config.yaml").write_text("prefix: t\n")
    return root


@pytest.fixture
def decoy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An ambient BEADS_DIR standing in for the hosted daemon's own board.

    Nothing in these tests may ever touch it. It has to be a real directory because
    the config layer validates BEADS_DIR exists before the server will start.
    """
    board = make_board(tmp_path / "daemon-board")
    monkeypatch.setenv("BEADS_DIR", str(board / ".beads"))
    return board / ".beads"


@pytest.fixture
def board(tmp_path: Path) -> Path:
    """The board the caller actually asks for."""
    return make_board(tmp_path / "asked-for")


def stamped(spawns: list[Spawn], command: str) -> Spawn:
    """The recorded spawn of ``command``, failing loudly if bd never ran it."""
    matches = [s for s in spawns if s.command == command]
    assert matches, f"bd {command} never ran; recorded: {spawns}"
    return matches[-1]


class TestExplicitWorkspaceWins:
    """A named workspace outranks whatever the server's own environment says."""

    async def test_explicit_workspace_root_overrides_ambient_beads_dir(
        self, spawns: list[Spawn], decoy: Path, board: Path
    ) -> None:
        async with Client(mcp) as client:
            await client.call_tool("list", {"workspace_root": str(board)})

        call = stamped(spawns, "list")
        assert call.env is not None
        assert call.env["BEADS_DIR"] == str(board / ".beads")
        assert call.env["BEADS_DIR"] != str(decoy)
        assert call.cwd == os.path.realpath(str(board))

    async def test_ambient_beads_db_not_leaked_when_board_bound(
        self, spawns: list[Spawn], board: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """BEADS_DB is bd's other route to a database, so binding must clear it too."""
        stale_db = tmp_path / "stale.db"
        stale_db.write_bytes(b"")
        monkeypatch.setenv("BEADS_DB", str(stale_db))

        async with Client(mcp) as client:
            await client.call_tool("list", {"workspace_root": str(board)})

        call = stamped(spawns, "list")
        assert call.env is not None
        assert call.env["BEADS_DIR"] == str(board / ".beads")
        assert "BEADS_DB" not in call.env
        assert "BD_DB" not in call.env

    @pytest.mark.parametrize(
        ("command", "tool", "arguments"),
        [
            ("list", "list", {}),
            # `create` is the site the bug was actually *reported* from (#feads-eeo):
            # a create that named a workspace came back with an id minted on the
            # daemon's default board. A read landing on the wrong board is confusing;
            # a write landing there leaves a stray somebody has to find and close.
            ("create", "create", {"title": "bound to the named board"}),
            ("dep", "dep", {"issue_id": "t-1", "depends_on_id": "t-2"}),
            ("dep", "dep_remove", {"issue_id": "t-1", "depends_on_id": "t-2"}),
            ("comment", "comment", {"issue_id": "t-1", "text": "hello"}),
            ("init", "context", {"action": "init", "prefix": "t"}),
        ],
    )
    async def test_all_subprocess_sites_stamp(
        self,
        spawns: list[Spawn],
        decoy: Path,
        board: Path,
        command: str,
        tool: str,
        arguments: dict[str, Any],
    ) -> None:
        """Every place this client spawns bd, not just the JSON one.

        Four call sites build a bd child; three of them stamped the board and
        ``init`` passed no environment at all, so it inherited the daemon's. One
        unstamped site is enough to put issues on the wrong board, so the guarantee
        is only worth stating for all of them.
        """
        async with Client(mcp) as client:
            await client.call_tool(tool, {**arguments, "workspace_root": str(board)})

        call = stamped(spawns, command)
        assert call.env is not None, f"bd {command} inherited the ambient environment"
        assert call.env["BEADS_DIR"] == str(board / ".beads")
        assert call.env["BEADS_DIR"] != str(decoy)


class TestGuessedWorkspaceKeepsTheDefault:
    """Nothing named means nothing overruled."""

    async def test_a_guessed_workspace_keeps_the_operators_default_board(
        self, spawns: list[Spawn], decoy: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A board merely lying above the server's cwd does not become the default.

        The ambient BEADS_DIR is the operator's choice — the hosted daemon exports the
        board it serves — and a caller who named no workspace has not disagreed with
        it. Binding the cwd's board here would silently move the default board of
        every context-less session, which is the same class of surprise this file
        exists to prevent, pointed the other way.
        """
        monkeypatch.chdir(make_board(tmp_path / "board-above-cwd"))

        async with Client(mcp) as client:
            await client.call_tool("list", {})

        call = stamped(spawns, "list")
        assert call.env is not None
        assert call.env["BEADS_DIR"] == str(decoy)


class TestUnresolvableExplicitWorkspace:
    """A named workspace with no board is an error, never a neighbouring board."""

    @pytest.fixture
    def repo_with_boardless_subdir(self, tmp_path: Path) -> tuple[Path, Path]:
        """A git repo whose root owns a board, and a subdirectory that owns none.

        This is the shape that makes the walk-up dangerous: every marker the search
        looks for exists one level up, so "not found here" silently becomes "found
        there" and the issues land on the enclosing repo's board.
        """
        root = make_board(tmp_path / "repo")
        (root / ".git").mkdir()
        subdir = root / "packages" / "widget"
        subdir.mkdir(parents=True)
        return root, subdir

    async def test_unresolvable_explicit_workspace_root_raises(
        self, spawns: list[Spawn], decoy: Path, repo_with_boardless_subdir: tuple[Path, Path]
    ) -> None:
        root, subdir = repo_with_boardless_subdir

        async with Client(mcp) as client:
            with pytest.raises(ToolError):
                await client.call_tool("list", {"workspace_root": str(subdir)})

        # Not "it failed" but "it never went anywhere": no bd ran, so no board was
        # read and none could have been written.
        assert [s.command for s in spawns if s.command != "version"] == []

        # And the message has to name the path the caller gave, because the whole
        # failure mode is a caller who believes they are on a board they are not.
        token = current_workspace.set(str(subdir))
        explicit_token = workspace_was_explicit.set(True)
        try:
            with pytest.raises(BdError) as raised:
                await tools._get_client()
        finally:
            current_workspace.reset(token)
            workspace_was_explicit.reset(explicit_token)

        message = str(raised.value)
        assert str(subdir) in message
        assert ".beads" in message
        # The parent repo's board is exactly what a walk-up would have found.
        assert str(root / ".beads") not in message
        assert tools._connection_pool == {}

    async def test_guessed_workspace_still_walks_up(
        self, repo_with_boardless_subdir: tuple[Path, Path]
    ) -> None:
        """The forgiving search survives for workspaces nobody named.

        Auto-detection is a guess by construction, and a guess that refuses to look
        one directory up is useless. Only an explicit path gets the hard edge.
        """
        root, subdir = repo_with_boardless_subdir
        assert tools._find_beads_db_in_tree(str(subdir)) == os.path.realpath(str(root))
        assert tools._resolve_beads_project_at(str(subdir)) is None
        assert tools._resolve_beads_project_at(str(root)) == os.path.realpath(str(root))


class TestContextSetHonesty:
    """context(...) either bound a board or it did not, and says which."""

    async def test_context_set_on_boardless_dir_reports_error_not_success(
        self, tmp_path: Path
    ) -> None:
        """feads-9ma: "Context set successfully ... Database: Not found" was a lie.

        The agent reads the first line, files its work, and bd — handed a context
        with no board behind it — resolves one from the environment instead.
        """
        boardless = tmp_path / "no-board"
        boardless.mkdir()

        async with Client(mcp) as client:
            result = await client.call_tool("context", {"workspace_root": str(boardless)})
            shown = await client.call_tool("context", {"action": "show"})

        assert result.data.startswith("Error:")
        assert str(boardless) in result.data
        # Nothing was stored: the next call must not inherit a workspace that failed.
        assert "Context not set" in shown.data
        assert all("BEADS_WORKING_DIR" not in store for store in server._workspace_contexts.values())

    async def test_context_set_on_a_real_board_still_succeeds(self, board: Path) -> None:
        async with Client(mcp) as client:
            result = await client.call_tool("context", {"workspace_root": str(board)})
        assert result.data.startswith("Context set successfully")
        assert str(board) in result.data

    async def test_context_board_rejects_registered_board_with_no_database(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Registration is a registry row; it does not prove a database exists."""
        empty_dir = tmp_path / "ghost" / ".beads"
        empty_dir.mkdir(parents=True)
        registry = make_registry(
            tmp_path / "registry.db",
            [
                {
                    "id": "ghost",
                    "name": "Ghost",
                    "board_dir": str(empty_dir),
                    "workspace_dir": str(empty_dir.parent),
                }
            ],
        )
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)

        async with Client(mcp) as client:
            result = await client.call_tool("context", {"board": "ghost"})
            shown = await client.call_tool("context", {"action": "show"})

        assert result.data.startswith("Error:")
        assert "holds no database" in result.data
        assert str(empty_dir) in result.data
        assert "Context not set" in shown.data

    async def test_context_board_accepts_a_board_with_a_database(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The same check, passing — so the refusal above is about the database."""
        root = make_board(tmp_path / "real")
        registry = make_registry(
            tmp_path / "registry.db",
            [
                {
                    "id": "real",
                    "name": "Real",
                    "board_dir": str(root / ".beads"),
                    "workspace_dir": str(root),
                }
            ],
        )
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)

        async with Client(mcp) as client:
            result = await client.call_tool("context", {"board": "real"})

        assert result.data.startswith("Context set successfully")


class TestSessionContextBinding:
    """A board chosen with context(...) binds the same way an argument does."""

    async def test_context_board_then_write_stamps_that_board(
        self, spawns: list[Spawn], decoy: Path, board: Path
    ) -> None:
        """The session default is a named board too — it came from context(...)."""
        async with Client(mcp) as client:
            await client.call_tool("context", {"workspace_root": str(board)})
            await client.call_tool("list", {})

        call = stamped(spawns, "list")
        assert call.env is not None
        assert call.env["BEADS_DIR"] == str(board / ".beads")
        assert call.cwd == os.path.realpath(str(board))
