"""Tests for registry writes (boards_write) and per-session workspace context.

The write path spawns the real Node CLI (``scripts/feads-board.mjs``) against a
temp registry, because the CLI *is* the design — a mock here would prove only
that we can call our own stub. Node is a hard requirement of feads, so the skip
below should never fire in CI; it exists for a bare Python environment.

The session tests prove the property fix #3 exists for: two client sessions on
one server hold two independent workspace defaults.
"""

import shutil
import subprocess
from pathlib import Path

import pytest
from fastmcp.client import Client

import beads_mcp.transport as transport
from beads_mcp.boards import REGISTRY_DB_ENV, get_board, list_boards
from beads_mcp.boards_write import (
    BOARD_CLI_ENV,
    NODE_BIN_ENV,
    _find_board_cli,
    board_create_payload,
    board_describe_payload,
    board_register_payload,
    board_repos_add_payload,
    board_repos_remove_payload,
)
from beads_mcp.server import mcp

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="registry writes spawn the Node CLI"
)


@pytest.fixture()
def registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A temp registry the CLI will create on first write."""
    db = tmp_path / "registry.db"
    monkeypatch.setenv(REGISTRY_DB_ENV, str(db))
    return db


def make_board(root: Path) -> Path:
    """Make ``root`` read as an initialized board, without needing bd.

    Every path that binds a board — the CLI's isBoardDir, the MCP's
    _has_beads_project_files, bd itself — is satisfied by config.yaml, so a
    one-line file stands in for a Dolt database that takes seconds to create.
    """
    beads = root / ".beads"
    beads.mkdir(parents=True)
    (beads / "config.yaml").write_text("prefix: t\n")
    return root


@pytest.fixture()
def board_dir(tmp_path: Path) -> Path:
    """A directory that passes the CLI's isBoardDir test without needing bd."""
    return make_board(tmp_path / "proj") / ".beads"


@pytest.fixture()
def registered(registry: Path, board_dir: Path) -> str:
    """A board registered up front, returning its id."""
    payload = board_register_payload(str(board_dir), "Test Board", id="tb")
    assert payload.get("registered") is True, payload
    return "tb"


class TestCliDiscovery:
    def test_finds_the_cli_by_walking_up_from_the_package(self) -> None:
        """Installed in its home inside the feads checkout, no env var is needed."""
        found = _find_board_cli(env={})
        assert found.endswith("scripts/feads-board.mjs")
        assert Path(found).is_file()

    def test_env_override_pointing_nowhere_reads_as_unavailable(self, registry: Path) -> None:
        """A wrong FEADS_BOARD_CLI is a deployment problem with its own code, not a crash."""
        payload = board_repos_add_payload(
            "any", ["o/r"], env={BOARD_CLI_ENV: "/nowhere/feads-board.mjs"}
        )
        assert payload["updated"] is False
        assert payload["code"] == "cli_unavailable"
        assert "hint" in payload

    def test_missing_node_reads_as_unavailable(self, registry: Path) -> None:
        payload = board_repos_add_payload("any", ["o/r"], env={NODE_BIN_ENV: "/nowhere/node"})
        assert payload["updated"] is False
        assert payload["code"] == "cli_unavailable"


class TestRegisterAndCreate:
    def test_register_makes_the_board_visible_to_the_read_path(
        self, registry: Path, board_dir: Path
    ) -> None:
        """The write goes through the CLI; the mode=ro reader sees the result."""
        payload = board_register_payload(
            str(board_dir),
            "Site Lab",
            description="on-site controllers and UI",
            repos=["example-lab/sample-controller"],
        )
        assert payload["registered"] is True
        assert payload["board"]["id"] == "site-lab"
        assert [b["id"] for b in list_boards()] == ["site-lab"]
        assert get_board("site-lab")["repos"] == ["example-lab/sample-controller"]

    def test_create_on_an_existing_board_registers_without_bd(
        self, registry: Path, board_dir: Path
    ) -> None:
        """create sees a real board dir and skips bd init entirely."""
        payload = board_create_payload(str(board_dir.parent), "Existing", id="ex")
        assert payload["created"] is True
        assert payload["initialized"] is False
        assert get_board("ex")["board_dir"] == str(board_dir)

    def test_registering_the_same_dir_under_a_second_id_is_a_dir_conflict(
        self, registry: Path, board_dir: Path, registered: str
    ) -> None:
        payload = board_register_payload(str(board_dir), "Impostor", id="other")
        assert payload["registered"] is False
        assert payload["code"] == "dir_conflict"

    def test_blank_name_is_refused_before_any_subprocess(self, registry: Path) -> None:
        payload = board_register_payload("/some/dir", "  ")
        assert payload["code"] == "invalid"

    def test_register_refuses_a_directory_with_no_board_in_it(
        self, registry: Path, tmp_path: Path
    ) -> None:
        """A registration promises issues a home; a bare directory cannot keep it.

        Registered-but-empty is the shape that produces the worst failure: the id
        resolves, the tool reports success, and bd — finding no database there —
        falls back to whatever BEADS_DIR or the cwd says, so the issues appear on a
        different board with nothing to say they moved.
        """
        bare = tmp_path / "not-a-board" / ".beads"
        bare.mkdir(parents=True)

        payload = board_register_payload(str(bare), "Empty")

        assert payload["registered"] is False
        assert payload["code"] == "no_database"
        assert "holds no board database" in payload["reason"]
        assert list_boards() == []

    def test_register_force_registers_a_bare_directory_anyway(
        self, registry: Path, tmp_path: Path
    ) -> None:
        """The refusal is a guard rail, not a wall — an operator can still say yes."""
        bare = tmp_path / "coming-soon" / ".beads"
        bare.mkdir(parents=True)
        cli = _find_board_cli()

        result = subprocess.run(
            ["node", cli, "register", str(bare), "--name", "Coming Soon", "--force", "--json"],
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0, result.stderr
        assert [b["id"] for b in list_boards()] == ["coming-soon"]


class TestReposAndDescribe:
    def test_add_then_remove_roundtrip(self, registry: Path, registered: str) -> None:
        added = board_repos_add_payload(registered, ["example-lab/sample-web-ui", "o/two"])
        assert added["updated"] is True
        assert added["board"]["repos"] == ["example-lab/sample-web-ui", "o/two"]

        removed = board_repos_remove_payload(registered, ["o/two", "o/never-there"])
        assert removed["updated"] is True
        assert removed["removed"] == 1
        assert removed["board"]["repos"] == ["example-lab/sample-web-ui"]

    def test_adds_are_merges_never_replacements(self, registry: Path, registered: str) -> None:
        """Two agents adding different repos both survive — the concurrency contract."""
        board_repos_add_payload(registered, ["a/from-agent-one"])
        board_repos_add_payload(registered, ["b/from-agent-two", "a/from-agent-one"])
        assert get_board(registered)["repos"] == ["a/from-agent-one", "b/from-agent-two"]

    def test_unknown_board_names_the_known_ones(self, registry: Path, registered: str) -> None:
        payload = board_repos_add_payload("nope", ["o/r"])
        assert payload["updated"] is False
        assert payload["code"] == "board_not_found"
        assert payload["known_boards"] == [registered]

    def test_bare_repo_names_are_accepted_but_flagged(
        self, registry: Path, registered: str
    ) -> None:
        payload = board_repos_add_payload(registered, ["just-a-name"])
        assert payload["updated"] is True
        assert any("owner/name" in warning for warning in payload["warnings"])

    def test_empty_repo_list_is_invalid(self, registry: Path, registered: str) -> None:
        assert board_repos_add_payload(registered, ["  ", ""])["code"] == "invalid"

    def test_describe_updates_description_and_name_but_never_the_id(
        self, registry: Path, registered: str
    ) -> None:
        payload = board_describe_payload(registered, description="Lab work", name="Lab")
        assert payload["updated"] is True
        board = payload["board"]
        assert (board["id"], board["name"], board["description"]) == ("tb", "Lab", "Lab work")

    def test_describe_with_nothing_to_do_is_invalid(self, registry: Path, registered: str) -> None:
        assert board_describe_payload(registered)["code"] == "invalid"


class TestConcurrentWriters:
    def test_parallel_adds_from_many_processes_all_land(
        self, registry: Path, registered: str, board_dir: Path
    ) -> None:
        """N CLI processes hammering one registry: WAL + busy_timeout, proven not assumed."""
        cli = _find_board_cli()
        procs = [
            subprocess.Popen(
                ["node", cli, "repos", registered, "--repo", f"o/repo-{i}", "--add", "--json"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            for i in range(8)
        ]
        errors = [p.communicate()[1] for p in procs]
        assert all(p.returncode == 0 for p in procs), errors
        assert get_board(registered)["repos"] == [f"o/repo-{i}" for i in range(8)]


class TestBoardWriteToolsOverMcp:
    async def test_tools_are_registered_and_cataloged(self) -> None:
        new_tools = {
            "board_repos_add",
            "board_repos_remove",
            "board_describe",
            "board_create",
            "board_register",
        }
        async with Client(mcp) as client:
            names = {tool.name for tool in await client.list_tools()}
            catalog = await client.call_tool("discover_tools", {})
            info = await client.call_tool("get_tool_info", {"tool_name": "board_repos_add"})
        assert new_tools <= names
        assert new_tools <= set(catalog.data["tools"])
        assert "repos" in info.data["parameters"]

    async def test_add_repo_through_the_wire(self, registry: Path, registered: str) -> None:
        """The end of the routing loop, as an agent runs it: pick, file, teach the board."""
        async with Client(mcp) as client:
            result = await client.call_tool(
                "board_repos_add",
                {"board": registered, "repos": ["example-lab/sample-web-ui"]},
            )
        assert result.data["updated"] is True
        assert "example-lab/sample-web-ui" in result.data["board"]["repos"]


class TestPerSessionContext:
    """Fix #3: one session's context(...) is invisible to every other session."""

    @pytest.fixture(autouse=True)
    def _isolate(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # No inherited defaults: the env fallback exists for stdio, and these
        # tests assert the HTTP-shaped behavior where it must not apply.
        for var in ("BEADS_WORKING_DIR", "BEADS_CONTEXT_SET", "BEADS_DB"):
            monkeypatch.delenv(var, raising=False)
        previous = transport._http_transport
        transport.set_http_transport(True)
        yield
        transport.set_http_transport(previous)

    async def test_two_sessions_hold_independent_workspaces(self, tmp_path: Path) -> None:
        # Both workspaces are real boards: context(...) refuses a directory with no
        # board in it, because a stored workspace with nothing behind it sends the
        # session's writes to whatever the environment resolves instead.
        ws_a = make_board(tmp_path / "a")
        ws_b = make_board(tmp_path / "b")

        async with Client(mcp) as a, Client(mcp) as b:
            await a.call_tool("context", {"action": "set", "workspace_root": str(ws_a)})
            # B has chosen nothing, and A's choice must not have become B's.
            shown_b = await b.call_tool("context", {"action": "show"})
            assert "Context not set" in shown_b.data

            await b.call_tool("context", {"action": "set", "workspace_root": str(ws_b)})
            shown_a = await a.call_tool("context", {"action": "show"})
            shown_b = await b.call_tool("context", {"action": "show"})
        assert str(ws_a) in shown_a.data and str(ws_b) not in shown_a.data
        assert str(ws_b) in shown_b.data and str(ws_a) not in shown_b.data

    async def test_context_set_over_http_leaves_the_process_environment_alone(
        self, tmp_path: Path
    ) -> None:
        """os.environ is shared by every session, so no session may write it."""
        import os

        ws = make_board(tmp_path / "ws")
        async with Client(mcp) as client:
            await client.call_tool("context", {"action": "set", "workspace_root": str(ws)})
        assert "BEADS_WORKING_DIR" not in os.environ
        assert "BEADS_CONTEXT_SET" not in os.environ

    async def test_context_switches_to_a_registered_board_by_id(
        self, registry: Path, registered: str, board_dir: Path
    ) -> None:
        """'Switch board' as one call: the id resolves to the board's workspace."""
        async with Client(mcp) as client:
            result = await client.call_tool("context", {"board": registered})
            shown = await client.call_tool("context", {"action": "show"})
        assert "Context set successfully" in result.data
        assert str(board_dir.parent) in shown.data

    async def test_context_with_an_unknown_board_names_the_known_ones(
        self, registry: Path, registered: str
    ) -> None:
        async with Client(mcp) as client:
            result = await client.call_tool("context", {"board": "nope"})
        assert "no such board: nope" in result.data
        assert registered in result.data


class TestStdioKeepsTheEnvironmentBridge:
    """On stdio the process is the one session; legacy env readers keep working."""

    async def test_context_set_still_exports_for_the_single_local_session(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import os

        for var in ("BEADS_WORKING_DIR", "BEADS_CONTEXT_SET", "BEADS_DB"):
            monkeypatch.delenv(var, raising=False)
        previous = transport._http_transport
        transport.set_http_transport(False)
        try:
            ws = make_board(tmp_path / "ws")
            async with Client(mcp) as client:
                await client.call_tool("context", {"action": "set", "workspace_root": str(ws)})
            assert os.environ.get("BEADS_WORKING_DIR") == str(ws)
        finally:
            transport.set_http_transport(previous)
            for var in ("BEADS_WORKING_DIR", "BEADS_CONTEXT_SET", "BEADS_DB"):
                os.environ.pop(var, None)
