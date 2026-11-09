"""The Postgres store: shaping rules, routing, and behaviour against a real database.

Two suites in one file, split by what they need.

The first needs nothing — it covers the pure functions that decide what a reply *looks
like* (which keys appear, how a timestamp is spelled, which refusal a miss produces) and
the routing decision that picks a store. Those are the parts most likely to be broken by
a well-meaning edit and the parts a CI run without a database can still defend.

The second is gated on ``FEADS_PG_TEST_DSN`` and talks to a real Postgres, because the
things it proves cannot be faked: that a conditional UPDATE actually serialises two
concurrent claims, that a write and its event row commit together, and that
``NOTIFY`` reaches a listener. A mock would prove only that the code calls the functions
the test expects it to call.

Run the gated half with, e.g.::

    FEADS_PG_TEST_DSN=postgres://postgres:feads@localhost:5434/feads_mcp uv run pytest tests/test_pgstore.py

The gated tests own one board of their own (``TEST_BOARD``) and wipe it either side, so
they can run against a database holding real board data without touching it.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone

import pytest

from beads_mcp import pgstore, server
from beads_mcp.agents import AuthorizationContext, request_authorization
from beads_mcp.bd_client import BdCommandError, BdError
from beads_mcp.config import Config
from beads_mcp.models import (
    AddCommentParams,
    AddDependencyParams,
    AddNoteParams,
    ClaimIssueParams,
    CloseIssueParams,
    CreateIssueParams,
    ListCommentsParams,
    ListIssuesParams,
    ReadyWorkParams,
    RemoveDependencyParams,
    ReopenIssueParams,
    ShowIssueParams,
    UpdateIssueParams,
)

TEST_DSN_ENV = "FEADS_PG_TEST_DSN"
TEST_BOARD = "beads-mcp-pytest"
TEST_PREFIX = "mcpt"

requires_pg = pytest.mark.skipif(
    not os.environ.get(TEST_DSN_ENV),
    reason=f"set {TEST_DSN_ENV} to run the Postgres store tests",
)


# =============================================================================
# No database needed
# =============================================================================


class TestConfigFlag:
    """FEADS_PG_DSN is the whole switch, so what counts as 'set' matters."""

    def test_unset_means_bd(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("FEADS_PG_DSN", raising=False)
        assert Config().pg_dsn is None
        assert pgstore.pg_enabled() is False

    def test_set_means_pg(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FEADS_PG_DSN", "postgres://u@h/db")
        assert Config().pg_dsn == "postgres://u@h/db"
        assert pgstore.pg_enabled() is True

    def test_empty_string_means_bd(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A template that sets the variable to "" means 'off', not 'connect to nothing'."""
        monkeypatch.setenv("FEADS_PG_DSN", "   ")
        assert Config().pg_dsn is None
        assert pgstore.pg_enabled() is False


class TestBothBackendsAnswerTheWholeContract:
    """The seam only holds while the two clients implement the same set of verbs.

    Python's ABC catches a *missing* override at instantiation, which in a suite that
    gates its pg tests on a DSN means "catches it on the deployment, not in CI". This
    is the cheap check that runs everywhere: every abstract verb, implemented by both.
    Added with ``remove_dependency`` (#feads-qyo), the first verb added to the base
    class since the store landed.
    """

    def test_no_abstract_verb_is_left_to_the_other_backend(self) -> None:
        from beads_mcp.bd_client import BdClient, BdClientBase
        from beads_mcp.pgstore import PgStoreClient

        verbs = set(BdClientBase.__abstractmethods__)
        assert "remove_dependency" in verbs
        assert PgStoreClient.__abstractmethods__ == frozenset()
        assert BdClient.__abstractmethods__ == frozenset()
        for verb in verbs:
            assert getattr(PgStoreClient, verb) is not getattr(BdClientBase, verb), (
                f"PgStoreClient inherits the abstract {verb} instead of implementing it"
            )


class TestBoardResolution:
    def test_board_is_the_directory_holding_dot_beads(self) -> None:
        assert pgstore.board_id_for_workspace("/opt/feads/boards/example") == "example"
        assert pgstore.board_id_for_workspace("/opt/feads/boards/example/") == "example"
        assert pgstore.board_id_for_workspace("/Users/x/example/feads") == "feads"


class TestWireShapes:
    """What bd puts on the wire, reproduced. Values captured from bd 1.1.0."""

    def test_timestamps_are_utc_second_precision_with_z(self) -> None:
        value = datetime(2026, 7, 30, 16, 20, 9, 123456, tzinfo=timezone.utc)
        assert pgstore._ts(value) == "2026-07-30T16:20:09Z"
        assert pgstore._ts(None) is None

    def test_empty_fields_are_omitted_not_nulled(self) -> None:
        """``Issue.description`` is typed ``str``; a literal null would fail validation."""
        out: dict[str, object] = {}
        pgstore._put(out, "description", None)
        pgstore._put(out, "design", "")
        pgstore._put(out, "labels", [])
        pgstore._put(out, "notes", "kept")
        assert out == {"notes": "kept"}

    def test_bare_issue_omits_what_bd_omits(self) -> None:
        row = {
            "id": "mcpt-abc",
            "title": "T",
            "description": None,
            "design": None,
            "acceptance_criteria": None,
            "notes": None,
            "status": "open",
            "issue_type": "task",
            "priority": 0,
            "assignee": None,
            "owner": None,
            "created_by": "someone",
            "external_ref": None,
            "metadata": "{}",
            "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "updated_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "closed_at": None,
            "close_reason": None,
            "started_at": None,
            "lease_expires_at": None,
            "heartbeat_at": None,
        }
        item = pgstore._bare_issue(row)
        assert item == {
            "id": "mcpt-abc",
            "title": "T",
            "status": "open",
            # priority 0 is P0 and must survive omitempty
            "priority": 0,
            "issue_type": "task",
            "created_at": "2026-01-01T00:00:00Z",
            "created_by": "someone",
            "updated_at": "2026-01-01T00:00:00Z",
        }
        assert "closed_at" not in item
        assert "assignee" not in item
        assert "metadata" not in item

    def test_not_found_wording_matches_the_subcommand_that_asked(self) -> None:
        assert pgstore._not_found("mcpt-x", "fetch").stderr == (
            'Error fetching mcpt-x: no issue found matching "mcpt-x"\n'
        )
        assert str(pgstore._not_found("mcpt-x", "comment")) == (
            'bd comment failed: Error: resolving mcpt-x: no issue found matching "mcpt-x"\n'
        )
        assert "1 of 1 issues failed to update" in pgstore._not_found("mcpt-x", "resolve").stderr

    def test_reassign_refusal_quotes_like_go(self) -> None:
        """Go's %q means double quotes; Python's !r would have used single ones."""
        row = {"assignee": "holder", "status": "in_progress"}
        with pytest.raises(BdCommandError) as excinfo:
            pgstore._assert_not_stolen("mcpt-x", row, actor="me", new_assignee="other")
        assert 'held by "holder"' in str(excinfo.value)

    def test_reassign_is_allowed_when_the_holder_is_not_working(self) -> None:
        row = {"assignee": "holder", "status": "open"}
        pgstore._assert_not_stolen("mcpt-x", row, actor="me", new_assignee="other")

    def test_create_dep_specs_keep_bds_directions(self) -> None:
        """``blocks:X`` reverses the edge — the one rule you get wrong by reading the name."""
        assert pgstore._parse_dep_spec("mcpt-a") == ("blocks", "mcpt-a", False)
        assert pgstore._parse_dep_spec("depends-on:mcpt-a") == ("blocks", "mcpt-a", False)
        assert pgstore._parse_dep_spec("blocked-by:mcpt-a") == ("blocks", "mcpt-a", False)
        assert pgstore._parse_dep_spec("blocks:mcpt-a") == ("blocks", "mcpt-a", True)
        assert pgstore._parse_dep_spec("discovered-from:mcpt-a") == ("discovered-from", "mcpt-a", False)

    def test_base36_matches_bd_id_alphabet(self) -> None:
        assert pgstore._base36(0) == "0"
        assert pgstore._base36(35) == "z"
        assert pgstore._base36(36**3 - 1) == "zzz"


class TestRouting:
    """Which store a tool call reaches, without either store being real."""

    @pytest.mark.asyncio
    async def test_pg_mode_returns_a_pg_client_and_spawns_no_bd(
        self, tmp_path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from beads_mcp import tools

        board = tmp_path / "boards" / "example"
        (board / ".beads").mkdir(parents=True)
        (board / ".beads" / "metadata.json").write_text("{}")

        monkeypatch.setenv("FEADS_PG_DSN", "postgres://u@h/db")
        monkeypatch.setattr(
            tools, "create_bd_client", lambda **kw: pytest.fail("pg mode must not build a bd client")
        )
        monkeypatch.setattr(tools, "_connection_pool", {})

        token = tools.current_workspace.set(str(board))
        explicit = tools.workspace_was_explicit.set(True)
        try:
            client = await tools._get_client()
        finally:
            tools.current_workspace.reset(token)
            tools.workspace_was_explicit.reset(explicit)

        assert isinstance(client, pgstore.PgStoreClient)
        assert client.board_id == "example"

    @pytest.mark.asyncio
    async def test_bd_mode_is_untouched(self, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
        from beads_mcp import tools

        board = tmp_path / "boards" / "example"
        (board / ".beads").mkdir(parents=True)
        (board / ".beads" / "metadata.json").write_text("{}")

        monkeypatch.delenv("FEADS_PG_DSN", raising=False)
        built: list[dict[str, object]] = []

        class Fake:
            pass

        def fake_create(**kw: object) -> object:
            built.append(kw)
            return Fake()

        monkeypatch.setattr(tools, "create_bd_client", fake_create)
        monkeypatch.setattr(tools, "_connection_pool", {})
        monkeypatch.setattr(tools, "_version_checked", set())

        token = tools.current_workspace.set(str(board))
        explicit = tools.workspace_was_explicit.set(True)
        try:
            client = await tools._get_client()
        finally:
            tools.current_workspace.reset(token)
            tools.workspace_was_explicit.reset(explicit)

        assert isinstance(client, Fake)
        assert built and built[0]["working_dir"] == os.path.realpath(str(board))

    @pytest.mark.asyncio
    async def test_init_stays_on_the_cli_even_in_pg_mode(self, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
        """`init` creates a board on disk — a question Postgres cannot answer."""
        from beads_mcp import tools

        board = tmp_path / "boards" / "brand-new"
        board.mkdir(parents=True)

        monkeypatch.setenv("FEADS_PG_DSN", "postgres://u@h/db")

        class Fake:
            pass

        monkeypatch.setattr(tools, "create_bd_client", lambda **kw: Fake())
        monkeypatch.setattr(tools, "_connection_pool", {})
        monkeypatch.setattr(tools, "_version_checked", set())

        token = tools.current_workspace.set(str(board))
        explicit = tools.workspace_was_explicit.set(True)
        try:
            client = await tools._get_client(allow_boardless=True)
        finally:
            tools.current_workspace.reset(token)
            tools.workspace_was_explicit.reset(explicit)

        assert isinstance(client, Fake)


class TestBdDatabaseDiagnosticsAreRefused:
    """In pg mode the Dolt board is an archive, so a diagnostic of it is a wrong answer.

    Not a crash and not a permission error — the tools *worked* before this change, and
    that was the problem: ``admin(action='validate')`` would report the archive's
    orphaned dependencies as if they were the live board's, and ``--fix`` would repair
    the archive while the real rows kept the defect. Both failures look like success.

    ``quickstart`` is the deliberate survivor: bd prints it out of the binary, so it
    reads no board and cannot answer from the wrong one.
    """

    @pytest.mark.parametrize(
        ("method", "kwargs", "action"),
        [
            ("validate", {}, "validate"),
            ("validate", {"fix_all": True}, "validate"),
            ("repair_deps", {}, "repair"),
            ("repair_deps", {"fix": True}, "repair"),
            ("detect_pollution", {}, "pollution"),
            ("detect_pollution", {"clean": True}, "pollution"),
            ("get_schema_info", {}, "schema"),
            ("inspect_migration", {}, "migration"),
        ],
    )
    @pytest.mark.asyncio
    async def test_each_diagnostic_refuses_and_says_why(
        self, method: str, kwargs: dict[str, object], action: str
    ) -> None:
        client = pgstore.PgStoreClient(board_id="anything")
        with pytest.raises(BdError) as caught:
            await getattr(client, method)(**kwargs)
        message = str(caught.value)
        assert f"admin(action='{action}')" in message
        assert "not available in pg mode" in message
        assert "the Dolt board is an archive" in message
        # The refusal has to leave a way through, or it is just a wall.
        assert "FEADS_PG_DSN unset" in message

    @pytest.mark.asyncio
    async def test_a_refusal_never_spawns_bd(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Refusing has to be cheaper than delegating, or a bd-less deployment hangs on it."""
        client = pgstore.PgStoreClient(board_id="anything")

        def explode() -> object:
            raise AssertionError("a refused diagnostic built a CLI client")

        monkeypatch.setattr(client, "_bd", explode)
        with pytest.raises(BdError):
            await client.validate()


class TestPrefixDerivation:
    """The prefix a new board is registered with is the prefix its ids will carry."""

    def test_normalization_matches_bd(self) -> None:
        # cmd/bd/init.go normalizeIssuePrefix: leading dots and trailing hyphens go,
        # remaining dots become underscores, a non-letter start gets a bd_ prefix.
        assert pgstore.normalize_issue_prefix(".claude") == "claude"
        assert pgstore.normalize_issue_prefix("my.board") == "my_board"
        assert pgstore.normalize_issue_prefix("trailing-") == "trailing"
        assert pgstore.normalize_issue_prefix("001") == "bd_001"
        assert pgstore.normalize_issue_prefix("_private") == "_private"
        assert pgstore.normalize_issue_prefix("") == ""

    def test_the_default_is_the_directory_name_bd_would_have_used(self) -> None:
        assert pgstore.default_prefix_for_workspace("/srv/boards/exoapp") == "exoapp"
        assert pgstore.default_prefix_for_workspace("/srv/boards/exoapp/") == "exoapp"
        assert pgstore.default_prefix_for_workspace("/srv/boards/.hidden") == "hidden"


class TestInitRegistersTheBoardItMade:
    """``context(action='init')`` has to leave behind a board the next tool can use."""

    @staticmethod
    def _fake_init(monkeypatch: pytest.MonkeyPatch, schema: object) -> dict[str, object]:
        from beads_mcp import tools

        class FakeClient:
            async def init(self, params: object) -> str:
                return "Initialized beads in /srv/boards/exoapp"

            async def get_schema_info(self) -> object:
                if isinstance(schema, Exception):
                    raise schema
                return schema

        async def fake_get_client(allow_boardless: bool = False) -> object:
            assert allow_boardless is True, "init must keep its boardless client"
            return FakeClient()

        recorded: dict[str, object] = {}

        async def fake_ensure(board_id: str, prefix: str) -> dict[str, object]:
            recorded.update(board_id=board_id, prefix=prefix)
            return {"board_id": board_id, "prefix": prefix, "created": True}

        monkeypatch.setattr(tools, "_get_client", fake_get_client)
        monkeypatch.setattr(pgstore, "ensure_board", fake_ensure)
        return recorded

    @pytest.mark.asyncio
    async def test_bd_reported_prefix_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """bd's answer is a fact; ours is a reproduction of bd's algorithm."""
        from beads_mcp import tools

        monkeypatch.setenv("FEADS_PG_DSN", "postgres://u@h/db")
        recorded = self._fake_init(monkeypatch, {"schema": {"detected_prefix": "fromconfig"}})

        token = tools.current_workspace.set("/srv/boards/exoapp")
        try:
            out = await tools.beads_init()
        finally:
            tools.current_workspace.reset(token)

        assert recorded == {"board_id": "exoapp", "prefix": "fromconfig"}
        assert "registered board 'exoapp' with prefix 'fromconfig'" in out
        assert out.startswith("Initialized beads in")  # bd's own answer is not swallowed

    @pytest.mark.asyncio
    async def test_the_derived_prefix_is_the_fallback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A bd that cannot answer must not leave the board unregistered."""
        from beads_mcp import tools

        monkeypatch.setenv("FEADS_PG_DSN", "postgres://u@h/db")
        recorded = self._fake_init(monkeypatch, RuntimeError("bd is not installed"))

        token = tools.current_workspace.set("/srv/boards/001-scratch")
        try:
            await tools.beads_init()
        finally:
            tools.current_workspace.reset(token)

        # Normalized the way bd normalizes: a leading digit gets bd_.
        assert recorded == {"board_id": "001-scratch", "prefix": "bd_001-scratch"}

    @pytest.mark.asyncio
    async def test_an_explicit_prefix_is_used_verbatim(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from beads_mcp import tools

        monkeypatch.setenv("FEADS_PG_DSN", "postgres://u@h/db")
        recorded = self._fake_init(monkeypatch, RuntimeError("no bd"))

        token = tools.current_workspace.set("/srv/boards/exoapp")
        try:
            await tools.beads_init()
        finally:
            tools.current_workspace.reset(token)
        assert recorded["prefix"] == "exoapp"

        recorded.clear()
        token = tools.current_workspace.set("/srv/boards/exoapp")
        try:
            await tools.beads_init(prefix="mob")
        finally:
            tools.current_workspace.reset(token)
        assert recorded["prefix"] == "mob"

    @pytest.mark.asyncio
    async def test_bd_mode_init_is_untouched(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from beads_mcp import tools

        monkeypatch.delenv("FEADS_PG_DSN", raising=False)
        recorded = self._fake_init(monkeypatch, {"schema": {"detected_prefix": "x"}})

        token = tools.current_workspace.set("/srv/boards/exoapp")
        try:
            out = await tools.beads_init()
        finally:
            tools.current_workspace.reset(token)

        assert out == "Initialized beads in /srv/boards/exoapp"
        assert recorded == {}


class TestBoardCreateRegistrationRouting:
    """Which creations get a store row, decided without touching a database."""

    @pytest.mark.asyncio
    async def test_bd_mode_is_left_exactly_as_it_was(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("FEADS_PG_DSN", raising=False)
        payload = {"created": True, "initialized": True, "board": {"id": "x", "workspace_dir": "/tmp/x"}}
        assert await server._register_created_board_in_pg(dict(payload), "") == payload

    @pytest.mark.asyncio
    async def test_an_adopted_board_is_not_declared_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """`initialized: false` means the board already held issues this store never saw.

        Registering it would turn a loud "that board is not in this database" into a
        quiet "that board has no issues" — the one failure mode the unknown-board error
        exists to prevent.
        """
        monkeypatch.setenv("FEADS_PG_DSN", "postgres://u@h/db")
        payload = {"created": True, "initialized": False, "board": {"id": "x", "workspace_dir": "/tmp/x"}}
        assert "pg_store" not in await server._register_created_board_in_pg(dict(payload), "")

    @pytest.mark.asyncio
    async def test_a_failed_creation_registers_nothing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FEADS_PG_DSN", "postgres://u@h/db")
        payload = {"created": False, "code": "cli_unavailable"}
        assert "pg_store" not in await server._register_created_board_in_pg(dict(payload), "")


# =============================================================================
# Against a real Postgres
# =============================================================================


@pytest.fixture
async def pg_board(monkeypatch: pytest.MonkeyPatch):
    """A private board in the test database, wiped either side.

    The pool is closed on teardown rather than shared: pytest-asyncio gives every test
    its own event loop, and an asyncpg pool outliving the loop it was created on fails
    in ways that look like store bugs.
    """
    dsn = os.environ[TEST_DSN_ENV]
    monkeypatch.setenv("FEADS_PG_DSN", dsn)
    await pgstore.close_pool()

    pool = await pgstore.get_pool()
    async with pool.acquire() as conn:
        await _wipe(conn)
        await conn.execute(
            "INSERT INTO boards (id, prefix) VALUES ($1, $2) "
            "ON CONFLICT (id) DO UPDATE SET prefix = EXCLUDED.prefix",
            TEST_BOARD,
            TEST_PREFIX,
        )
    try:
        yield pgstore.PgStoreClient(board_id=TEST_BOARD, actor="agent-a")
    finally:
        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            await _wipe(conn)
            await conn.execute("DELETE FROM boards WHERE id = $1", TEST_BOARD)
        await pgstore.close_pool()


def _payload(event: dict[str, object]) -> object:
    """An event payload, whichever way asyncpg handed back the jsonb column."""
    raw = event["payload"]
    return json.loads(raw) if isinstance(raw, str) else raw


async def _wipe(conn) -> None:
    await conn.execute("DELETE FROM events WHERE board_id = $1", TEST_BOARD)
    await conn.execute("DELETE FROM issues WHERE board_id = $1", TEST_BOARD)


async def _events(kind: str | None = None) -> list[dict[str, object]]:
    pool = await pgstore.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT issue_id, actor, kind, payload FROM events WHERE board_id = $1 "
            "AND ($2::text IS NULL OR kind = $2) ORDER BY seq",
            TEST_BOARD,
            kind,
        )
    return [dict(r) for r in rows]


@requires_pg
class TestRoundTrip:
    @pytest.mark.asyncio
    async def test_create_then_read_back(self, pg_board) -> None:
        issue = await pg_board.create(
            CreateIssueParams(
                title="Round trip",
                description="why it exists",
                design="how",
                acceptance="done when",
                priority=1,
                issue_type="feature",
                labels=["alpha", "beta"],
            )
        )
        assert issue.id.startswith(f"{TEST_PREFIX}-")
        assert len(issue.id) == len(TEST_PREFIX) + 4
        assert issue.status == "open"
        assert issue.priority == 1
        assert issue.issue_type == "feature"
        assert issue.labels == ["alpha", "beta"]
        assert issue.closed_at is None

        shown = await pg_board.show(ShowIssueParams(issue_id=issue.id))
        assert shown.title == "Round trip"
        assert shown.description == "why it exists"
        assert shown.design == "how"
        assert shown.acceptance_criteria == "done when"
        assert shown.labels == ["alpha", "beta"]

        listed = await pg_board.list_issues(ListIssuesParams(limit=50))
        assert [i.id for i in listed] == [issue.id]

    @pytest.mark.asyncio
    async def test_defaults_match_bd(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Bare"))
        assert (issue.priority, issue.issue_type, issue.status) == (2, "task", "open")
        assert issue.description == ""
        assert issue.assignee == "agent-a"

    @pytest.mark.asyncio
    async def test_owner_and_created_by_are_both_the_acting_agent(self, pg_board) -> None:
        """A deliberate divergence from bd, and the one place this store is not a copy.

        bd fills ``owner`` from ``git config user.email`` — the identity of whichever
        checkout the *server process* runs in, which on a shared daemon is nobody's.
        That leak is not theoretical: it is how rows attributed to a human who had
        filed nothing ended up on a live board. One verified actor on both columns.
        """
        issue = await pg_board.create(CreateIssueParams(title="Attributed"))
        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT owner, created_by FROM issues WHERE id = $1", issue.id)
        assert row["owner"] == "agent-a"
        assert row["created_by"] == "agent-a"
        # The column, not the reply: the MCP's Issue model has never carried `owner`
        # (bd mode does not surface it either), and it is the dashboard reading the
        # column that was showing a blank owner for everything filed after the cutover.

    @pytest.mark.asyncio
    async def test_valid_silo_actor_covers_issue_comment_dependency_and_events(
        self, pg_board, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Every PG audit column uses the verified silo actor, never host config."""
        monkeypatch.setenv("FEADS_SILO", "controls")
        monkeypatch.setenv("BEADS_ACTOR", "malicious-host-actor")
        context_token = request_authorization.set(
            AuthorizationContext(agent=None, actor="verified-silo-actor", action="write", allowed=True)
        )
        try:
            first = await pg_board.create(CreateIssueParams(title="Attributed in silo"))
            second = await pg_board.create(CreateIssueParams(title="Depends in silo"))
            await pg_board.add_comment(AddCommentParams(issue_id=first.id, text="verified comment"))
            await pg_board.add_dependency(
                AddDependencyParams(issue_id=second.id, depends_on_id=first.id, dep_type="blocks")
            )

            pool = await pgstore.get_pool()
            async with pool.acquire() as conn:
                issues = await conn.fetch(
                    "SELECT id, owner, created_by FROM issues WHERE id = ANY($1::text[]) ORDER BY id",
                    [first.id, second.id],
                )
                comment = await conn.fetchrow("SELECT author FROM comments WHERE issue_id = $1", first.id)
                dependency = await conn.fetchrow(
                    "SELECT created_by FROM deps WHERE issue_id = $1 AND depends_on_id = $2",
                    second.id,
                    first.id,
                )

            assert {(row["owner"], row["created_by"]) for row in issues} == {
                ("verified-silo-actor", "verified-silo-actor")
            }
            assert comment["author"] == "verified-silo-actor"
            assert dependency["created_by"] == "verified-silo-actor"
            assert {event["actor"] for event in await _events()} == {"verified-silo-actor"}
        finally:
            request_authorization.reset(context_token)

    @pytest.mark.asyncio
    async def test_update_moves_updated_at_and_stamps_started_at_once(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Bookkeeping"))
        first = await pg_board.update(UpdateIssueParams(issue_id=issue.id, status="in_progress"))
        assert first.updated_at >= issue.updated_at

        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            started = await conn.fetchval("SELECT started_at FROM issues WHERE id = $1", issue.id)
        assert started is not None

        await pg_board.update(UpdateIssueParams(issue_id=issue.id, status="open"))
        await pg_board.update(UpdateIssueParams(issue_id=issue.id, status="in_progress"))
        async with pool.acquire() as conn:
            again = await conn.fetchval("SELECT started_at FROM issues WHERE id = $1", issue.id)
        assert again == started, "started_at records the FIRST start, not the latest"

    @pytest.mark.asyncio
    async def test_update_replaces_the_whole_label_set(self, pg_board) -> None:
        """``labels=`` is a replacement, not a union — the caller's set is what remains."""
        issue = await pg_board.create(CreateIssueParams(title="Labelled", labels=["drop", "keep"]))

        replaced = await pg_board.update(UpdateIssueParams(issue_id=issue.id, labels=["keep", "fresh"]))
        assert replaced.labels == ["fresh", "keep"]
        assert (await pg_board.show(ShowIssueParams(issue_id=issue.id))).labels == ["fresh", "keep"]

    @pytest.mark.asyncio
    async def test_an_empty_label_list_clears_them(self, pg_board) -> None:
        """``[]`` is a real instruction here, which is why the parameter is not just a list."""
        issue = await pg_board.create(CreateIssueParams(title="Soon bare", labels=["stale"]))

        cleared = await pg_board.update(UpdateIssueParams(issue_id=issue.id, labels=[]))
        assert cleared.labels == []

        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch("SELECT label FROM labels WHERE issue_id = $1", issue.id)
        assert rows == []

    @pytest.mark.asyncio
    async def test_a_duplicated_label_is_collapsed_in_both_the_store_and_the_event(self, pg_board) -> None:
        """One normalisation, used twice — the announced set must be the stored set."""
        issue = await pg_board.create(CreateIssueParams(title="Deduped"))

        replaced = await pg_board.update(UpdateIssueParams(issue_id=issue.id, labels=["b", "a", "b"]))
        assert replaced.labels == ["a", "b"]
        assert _payload((await _events("updated"))[0]) == {"labels": ["a", "b"]}

    @pytest.mark.asyncio
    async def test_labels_left_unnamed_are_left_alone(self, pg_board) -> None:
        """The bug this guards: an unrelated field update wiping a bead's labels."""
        issue = await pg_board.create(CreateIssueParams(title="Untouched", labels=["a", "b"]))

        updated = await pg_board.update(UpdateIssueParams(issue_id=issue.id, priority=0, title="Renamed"))
        assert updated.labels == ["a", "b"]

    @pytest.mark.asyncio
    async def test_a_labels_only_update_is_still_a_mutation(self, pg_board) -> None:
        """A relabel that moved no column must move ``updated_at`` and announce itself.

        Both halves matter to the dashboard: its delta subscriptions ask "what changed
        since", so a stale ``updated_at`` hides the write, and its live push comes off the
        event stream, so a missing ``updated`` row leaves the old labels on screen.
        """
        issue = await pg_board.create(CreateIssueParams(title="Relabelled", labels=["old"]))
        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            before = await conn.fetchval("SELECT updated_at FROM issues WHERE id = $1", issue.id)

        await pg_board.update(UpdateIssueParams(issue_id=issue.id, labels=["new"]))

        async with pool.acquire() as conn:
            after = await conn.fetchval("SELECT updated_at FROM issues WHERE id = $1", issue.id)
        assert after > before

        events = await _events("updated")
        assert [e["issue_id"] for e in events] == [issue.id]
        assert _payload(events[0]) == {"labels": ["new"]}

    @pytest.mark.asyncio
    async def test_update_and_close_merge_metadata_and_delete_null_keys(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Metadata merge"))
        await pg_board.update(UpdateIssueParams(issue_id=issue.id, metadata={"keep": "yes", "drop": "old"}))
        updated = await pg_board.update(
            UpdateIssueParams(
                issue_id=issue.id,
                metadata={
                    "effort": {
                        "pre_ai_hours": 4,
                        "effective_hours": 1,
                        "ai_accel": 4,
                        "source": "test",
                    },
                    "drop": None,
                },
            )
        )
        assert updated.metadata == {
            "keep": "yes",
            "effort": {
                "pre_ai_hours": 4,
                "effective_hours": 1,
                "ai_accel": 4,
                "source": "test",
            },
        }

        closed = await pg_board.close(
            CloseIssueParams(issue_id=issue.id, reason="done", metadata={"closed": True})
        )
        assert closed[0].metadata["keep"] == "yes"
        assert closed[0].metadata["closed"] is True
        assert closed[0].metadata["effort"]["ai_accel"] == 4

    @pytest.mark.asyncio
    async def test_close_then_reopen(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Closes"))
        closed = await pg_board.close(CloseIssueParams(issue_id=issue.id, reason="shipped"))
        assert closed[0].status == "closed"
        assert closed[0].closed_at is not None

        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            reason = await conn.fetchval("SELECT close_reason FROM issues WHERE id = $1", issue.id)
        assert reason == "shipped"

        # bd's default list hides closed work; --status closed is how you see it
        assert await pg_board.list_issues(ListIssuesParams(limit=50)) == []
        assert [i.id for i in await pg_board.list_issues(ListIssuesParams(status="closed", limit=50))] == [
            issue.id
        ]

        reopened = await pg_board.reopen(ReopenIssueParams(issue_ids=[issue.id]))
        assert reopened[0].status == "open"
        assert reopened[0].closed_at is None

    @pytest.mark.asyncio
    async def test_reopening_an_open_issue_raises_the_way_bd_does(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Already open"))
        with pytest.raises(BdCommandError, match="Invalid response for reopen"):
            await pg_board.reopen(ReopenIssueParams(issue_ids=[issue.id]))

    @pytest.mark.asyncio
    async def test_close_refuses_somebody_elses_work(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Theirs", assignee="somebody-else"))
        with pytest.raises(BdCommandError, match="reclaim or use --force"):
            await pg_board.close(CloseIssueParams(issue_id=issue.id))

    @pytest.mark.asyncio
    async def test_force_close_succeeds_and_audits_the_actor(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Stale", assignee="somebody-else"))
        closed = await pg_board.close(CloseIssueParams(issue_id=issue.id, reason="stale", force=True))

        assert closed[0].status == "closed"
        events = await _events("status")
        assert events[-1]["issue_id"] == issue.id
        assert events[-1]["actor"] == "agent-a"
        assert _payload(events[-1]) == {"status": "closed", "close_reason": "stale"}

    @pytest.mark.asyncio
    async def test_notes_append_and_comments_accumulate(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Trail"))
        await pg_board.add_note(AddNoteParams(issue_id=issue.id, text="one"))
        await pg_board.add_note(AddNoteParams(issue_id=issue.id, text="two"))
        assert (await pg_board.show(ShowIssueParams(issue_id=issue.id))).notes == "one\ntwo"

        await pg_board.add_comment(AddCommentParams(issue_id=issue.id, text="first"))
        await pg_board.add_comment(AddCommentParams(issue_id=issue.id, text="second"))
        comments = await pg_board.list_comments(ListCommentsParams(issue_id=issue.id))
        assert [c.text for c in comments] == ["first", "second"]
        assert {c.author for c in comments} == {"agent-a"}

    @pytest.mark.asyncio
    async def test_create_wires_declared_dependencies(self, pg_board) -> None:
        first = await pg_board.create(CreateIssueParams(title="First"))
        second = await pg_board.create(CreateIssueParams(title="Second", deps=[first.id, f"blocks:{first.id}"]))
        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            edges = await conn.fetch(
                "SELECT issue_id, depends_on_id, dep_type FROM deps "
                "WHERE issue_id = ANY($1::text[]) ORDER BY issue_id",
                [first.id, second.id],
            )
        assert {(e["issue_id"], e["depends_on_id"]) for e in edges} == {
            (second.id, first.id),  # bare id: the new issue depends on it
            (first.id, second.id),  # blocks:id: reversed, as bd does
        }

    @pytest.mark.asyncio
    async def test_create_with_a_dangling_dep_leaves_nothing_behind(self, pg_board) -> None:
        """bd commits the issue and then reports the failure; one transaction does not."""
        before = {i.id for i in await pg_board.list_issues(ListIssuesParams(limit=50))}
        with pytest.raises(BdCommandError, match="not found"):
            await pg_board.create(CreateIssueParams(title="Dangling", deps=[f"{TEST_PREFIX}-000"]))
        after = {i.id for i in await pg_board.list_issues(ListIssuesParams(limit=50))}
        assert after == before

    @pytest.mark.asyncio
    async def test_missing_issue_raises_bds_message(self, pg_board) -> None:
        with pytest.raises(BdCommandError, match="no issue found matching"):
            await pg_board.show(ShowIssueParams(issue_id=f"{TEST_PREFIX}-000"))

    @pytest.mark.asyncio
    async def test_unknown_board_is_an_error_not_an_empty_board(self, pg_board) -> None:
        """Answering 'no issues' for a board nobody imported reads as data loss."""
        stranger = pgstore.PgStoreClient(board_id="no-such-board-here")
        with pytest.raises(BdError, match="not in the feads Postgres store"):
            await stranger.list_issues(ListIssuesParams(limit=5))


@requires_pg
class TestGraphReads:
    @pytest.mark.asyncio
    async def test_ready_blocked_and_epic_rollup(self, pg_board) -> None:
        epic = await pg_board.create(CreateIssueParams(title="Epic", issue_type="epic", priority=1))
        blocker = await pg_board.create(CreateIssueParams(title="Blocker", priority=0))
        work = await pg_board.create(CreateIssueParams(title="Work", priority=2))
        await pg_board.add_dependency(
            AddDependencyParams(issue_id=work.id, depends_on_id=blocker.id, dep_type="blocks")
        )
        await pg_board.add_dependency(
            AddDependencyParams(issue_id=work.id, depends_on_id=epic.id, dep_type="parent-child")
        )

        ready = {i.id for i in await pg_board.ready(ReadyWorkParams(limit=50))}
        assert ready == {epic.id, blocker.id}, "the blocked bead is not ready; the epic is"

        # #feads-qyo: retyping an edge is remove-then-add, so pg mode has to support
        # the remove half or the ergonomics fix is bd-mode-only.
        await pg_board.remove_dependency(RemoveDependencyParams(issue_id=work.id, depends_on_id=blocker.id))
        assert await pg_board.blocked() == [], "the blocks edge is gone"
        shown = await pg_board.show(ShowIssueParams(issue_id=work.id))
        assert [d.id for d in shown.dependencies] == [epic.id], "the parent-child edge is not"
        await pg_board.add_dependency(
            AddDependencyParams(issue_id=work.id, depends_on_id=blocker.id, dep_type="blocks")
        )

        blocked = await pg_board.blocked()
        assert [i.id for i in blocked] == [work.id]
        assert blocked[0].blocked_by == [blocker.id]
        assert blocked[0].blocked_by_count == 1

        # A closed blocker stops blocking, and the ready set grows by exactly that bead.
        await pg_board.close(CloseIssueParams(issue_id=blocker.id))
        assert await pg_board.blocked() == []
        assert {i.id for i in await pg_board.ready(ReadyWorkParams(limit=50))} == {epic.id, work.id}

        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT total_children::int AS t, closed_children::int AS c, eligible_for_close AS e "
                "FROM epic_status WHERE board_id = $1 AND id = $2",
                TEST_BOARD,
                epic.id,
            )
        assert (row["t"], row["c"], row["e"]) == (1, 0, False)

    @pytest.mark.asyncio
    async def test_show_counts_every_edge_type_and_list_counts_only_blocks(self, pg_board) -> None:
        """The asymmetry is bd's. Reproducing it is the point; smoothing it would be a change."""
        parent = await pg_board.create(CreateIssueParams(title="Parent", issue_type="epic"))
        blocker = await pg_board.create(CreateIssueParams(title="Blocker"))
        work = await pg_board.create(CreateIssueParams(title="Work"))
        await pg_board.add_dependency(
            AddDependencyParams(issue_id=work.id, depends_on_id=blocker.id, dep_type="blocks")
        )
        await pg_board.add_dependency(
            AddDependencyParams(issue_id=work.id, depends_on_id=parent.id, dep_type="parent-child")
        )

        shown = await pg_board.show(ShowIssueParams(issue_id=work.id))
        assert shown.dependency_count == 2
        assert {d.id for d in shown.dependencies} == {blocker.id, parent.id}
        assert {d.dependency_type for d in shown.dependencies} == {"blocks", "parent-child"}

        listed = {i.id: i for i in await pg_board.list_issues(ListIssuesParams(limit=50))}
        # bd reports 1 here (blocks only) and _sanitize_issue_deps then rewrites it to
        # the number of raw records — which is 2. That rewrite is the contract.
        assert listed[work.id].dependency_count == 2
        assert listed[blocker.id].dependent_count == 1
        assert listed[parent.id].dependent_count == 0, "a parent-child edge is not a blocker"

    @pytest.mark.asyncio
    async def test_stats_ready_is_open_minus_blocked(self, pg_board) -> None:
        blocker = await pg_board.create(CreateIssueParams(title="Blocker"))
        work = await pg_board.create(CreateIssueParams(title="Work"))
        await pg_board.add_dependency(AddDependencyParams(issue_id=work.id, depends_on_id=blocker.id))
        done = await pg_board.create(CreateIssueParams(title="Done"))
        await pg_board.close(CloseIssueParams(issue_id=done.id))

        stats = await pg_board.stats()
        assert stats.summary.total_issues == 3
        assert stats.summary.open_issues == 2
        assert stats.summary.closed_issues == 1
        assert stats.summary.blocked_issues == 1
        assert stats.summary.ready_issues == 1
        # bd never assigns these two; mirroring that is deliberate (see stats()).
        assert stats.summary.average_lead_time_hours == 0
        assert stats.summary.epics_eligible_for_closure == 0

    @pytest.mark.asyncio
    async def test_filters(self, pg_board) -> None:
        a = await pg_board.create(CreateIssueParams(title="Alpha thing", labels=["red", "blue"], priority=0))
        b = await pg_board.create(
            CreateIssueParams(title="Beta thing", issue_type="bug", assignee="someone", priority=3)
        )

        async def ids(**kw: object) -> set[str]:
            return {i.id for i in await pg_board.list_issues(ListIssuesParams(limit=50, **kw))}

        assert await ids(labels=["red"]) == {a.id}
        assert await ids(labels=["red", "missing"]) == set()
        assert await ids(labels_any=["red", "missing"]) == {a.id}
        assert await ids(issue_type="bug") == {b.id}
        assert await ids(assignee="someone") == {b.id}
        assert await ids(unassigned=True) == {a.id}
        assert await ids(priority=0) == {a.id}
        assert await ids(query="BETA") == {b.id}, "title search is case-insensitive"


@requires_pg
class TestClaimIsAtomic:
    @pytest.mark.asyncio
    async def test_two_concurrent_claims_and_exactly_one_wins(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Contended"))

        a = pgstore.PgStoreClient(board_id=TEST_BOARD, actor="agent-a")
        b = pgstore.PgStoreClient(board_id=TEST_BOARD, actor="agent-b")
        results = await asyncio.gather(
            a.claim(ClaimIssueParams(issue_id=issue.id)),
            b.claim(ClaimIssueParams(issue_id=issue.id)),
            return_exceptions=True,
        )

        winners = [r for r in results if not isinstance(r, BaseException)]
        losers = [r for r in results if isinstance(r, BaseException)]
        assert len(winners) == 1, f"exactly one claim must win, got {results}"
        assert len(losers) == 1
        assert isinstance(losers[0], BdCommandError)
        assert "already claimed by" in str(losers[0])

        held = winners[0].assignee
        assert held in ("agent-a", "agent-b")
        assert winners[0].status == "in_progress"

        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT assignee, status, lease_expires_at, heartbeat_at FROM issues WHERE id = $1", issue.id
            )
        assert row["assignee"] == held
        assert row["status"] == "in_progress"
        assert row["lease_expires_at"] is not None, "a claim takes a lease, as bd's does"
        assert row["heartbeat_at"] is not None

    @pytest.mark.asyncio
    async def test_reclaiming_your_own_bead_is_idempotent(self, pg_board) -> None:
        """Retry safety: a client that did not see its own success must not be refused."""
        issue = await pg_board.create(CreateIssueParams(title="Mine"))
        first = await pg_board.claim(ClaimIssueParams(issue_id=issue.id))
        second = await pg_board.claim(ClaimIssueParams(issue_id=issue.id))
        assert first.assignee == second.assignee == "agent-a"

    @pytest.mark.asyncio
    async def test_a_closed_bead_is_not_claimable(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Done"))
        await pg_board.close(CloseIssueParams(issue_id=issue.id))
        with pytest.raises(BdCommandError, match="not claimable: status closed"):
            await pg_board.claim(ClaimIssueParams(issue_id=issue.id))


@requires_pg
class TestEventStream:
    """The dashboard learns about MCP writes from here and nowhere else."""

    @pytest.mark.asyncio
    async def test_every_write_path_appends_an_event(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Watched"))
        other = await pg_board.create(CreateIssueParams(title="Other"))
        await pg_board.update(UpdateIssueParams(issue_id=issue.id, priority=0))
        await pg_board.update(UpdateIssueParams(issue_id=issue.id, status="in_progress"))
        await pg_board.add_comment(AddCommentParams(issue_id=issue.id, text="hi"))
        await pg_board.add_note(AddNoteParams(issue_id=issue.id, text="n"))
        await pg_board.add_dependency(AddDependencyParams(issue_id=issue.id, depends_on_id=other.id))
        await pg_board.remove_dependency(RemoveDependencyParams(issue_id=issue.id, depends_on_id=other.id))
        await pg_board.claim(ClaimIssueParams(issue_id=issue.id))
        await pg_board.close(CloseIssueParams(issue_id=issue.id))
        await pg_board.reopen(ReopenIssueParams(issue_ids=[issue.id]))

        kinds = [e["kind"] for e in await _events()]
        assert kinds == [
            "created",
            "created",
            "updated",
            "status",
            "comment",
            "updated",
            "dep_added",
            "dep_removed",
            "claimed",
            "status",
            "status",
        ]
        assert {e["actor"] for e in await _events()} == {"agent-a"}

    @pytest.mark.asyncio
    async def test_a_write_notifies_listeners(self, pg_board) -> None:
        import asyncpg

        received: asyncio.Queue[str] = asyncio.Queue()
        listener = await asyncpg.connect(os.environ[TEST_DSN_ENV])
        try:
            await listener.add_listener(
                pgstore.PG_CHANNEL, lambda _c, _p, _ch, payload: received.put_nowait(payload)
            )
            issue = await pg_board.create(CreateIssueParams(title="Announced"))
            payload = await asyncio.wait_for(received.get(), timeout=5)
            assert payload == f"{TEST_BOARD}:{issue.id}:created"

            await pg_board.add_comment(AddCommentParams(issue_id=issue.id, text="hello"))
            payload = await asyncio.wait_for(received.get(), timeout=5)
            assert payload == f"{TEST_BOARD}:{issue.id}:comment"
        finally:
            await listener.close()

    @pytest.mark.asyncio
    async def test_a_refused_write_announces_nothing(self, pg_board) -> None:
        """The event is in the write's transaction, so a rollback takes it with it."""
        issue = await pg_board.create(CreateIssueParams(title="Theirs", assignee="somebody-else"))
        before = len(await _events())
        with pytest.raises(BdCommandError):
            await pg_board.close(CloseIssueParams(issue_id=issue.id))
        assert len(await _events()) == before

    @pytest.mark.asyncio
    async def test_a_lost_claim_announces_nothing(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Contended"))
        await pg_board.claim(ClaimIssueParams(issue_id=issue.id))
        before = len(await _events("claimed"))
        loser = pgstore.PgStoreClient(board_id=TEST_BOARD, actor="agent-b")
        with pytest.raises(BdCommandError):
            await loser.claim(ClaimIssueParams(issue_id=issue.id))
        assert len(await _events("claimed")) == before


@requires_pg
class TestBoardRegistration:
    """A board created after the cutover has to be usable by the next tool call.

    Before this, ``board_create`` and ``context(action='init')`` built the board on disk
    and wrote the SQLite registry, and stopped there — so the agent that had just made
    a board got "not in the feads Postgres store" from its own first ``create``. The
    error was correct and the situation was a dead end.
    """

    NEW_BOARD = "mcpt-fresh-board"
    NEW_PREFIX = "mcptfresh"

    @pytest.fixture(autouse=True)
    async def _clean(self, pg_board):
        yield
        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            # Issues first: boards.id is a foreign key, and a failed teardown would
            # leave the board behind and silently change what the next test observes.
            await conn.execute("DELETE FROM events WHERE board_id = $1", self.NEW_BOARD)
            await conn.execute("DELETE FROM issues WHERE board_id = $1", self.NEW_BOARD)
            await conn.execute("DELETE FROM boards WHERE id = $1", self.NEW_BOARD)

    @pytest.mark.asyncio
    async def test_registering_makes_the_board_writable(self) -> None:
        outcome = await pgstore.ensure_board(self.NEW_BOARD, self.NEW_PREFIX)
        assert outcome == {"board_id": self.NEW_BOARD, "prefix": self.NEW_PREFIX, "created": True}

        issue = await pgstore.PgStoreClient(board_id=self.NEW_BOARD, actor="agent-a").create(
            CreateIssueParams(title="First bead on a brand new board")
        )
        assert issue.id.startswith(f"{self.NEW_PREFIX}-")

    @pytest.mark.asyncio
    async def test_an_existing_board_keeps_its_prefix(self) -> None:
        """Re-pointing a live board's prefix would strand every id already minted."""
        outcome = await pgstore.ensure_board(TEST_BOARD, "somethingelse")
        assert outcome["existing"] is True
        assert outcome["created"] is False
        assert outcome["prefix"] == TEST_PREFIX

    @pytest.mark.asyncio
    async def test_a_taken_prefix_is_reported_not_raised(self) -> None:
        """The board itself was created; failing the call afterwards would misdescribe that."""
        outcome = await pgstore.ensure_board(self.NEW_BOARD, TEST_PREFIX)
        assert outcome["created"] is False
        assert "could not register board" in outcome["error"]
        assert "issue tools will refuse it until a row is added by hand" in outcome["error"]

    @pytest.mark.asyncio
    async def test_a_half_known_board_is_not_registered_on_a_guess(self) -> None:
        assert "error" in await pgstore.ensure_board("", "prefix")
        assert "error" in await pgstore.ensure_board("board", "")


@requires_pg
class TestMetadata:
    """The generic half of what the artifact layer needs; end-to-end in test_pgstore_artifacts."""

    @pytest.mark.asyncio
    async def test_a_patch_merges_and_a_null_is_stored_rather_than_removing_the_key(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Has metadata"))
        await pg_board.patch_metadata(issue.id, {"one": 1, "two": {"nested": True}})
        merged = await pg_board.patch_metadata(issue.id, {"two": None, "three": "kept"})

        # Shallow merge, bd's semantics: `one` survives a patch that did not mention it.
        assert merged == {"one": 1, "two": None, "three": "kept"}
        assert (await pg_board.read_issue(issue.id))["metadata"] == merged

    @pytest.mark.asyncio
    async def test_a_metadata_write_announces_itself_like_any_other(self, pg_board) -> None:
        issue = await pg_board.create(CreateIssueParams(title="Announced"))
        await pg_board.patch_metadata(issue.id, {"marker": True})

        events = await _events("updated")
        assert [e["issue_id"] for e in events] == [issue.id]
        assert _payload(events[0]) == {"field": "metadata", "keys": ["marker"]}

    @pytest.mark.asyncio
    async def test_the_key_scan_finds_only_marked_live_issues(self, pg_board) -> None:
        marked = await pg_board.create(CreateIssueParams(title="Marked"))
        plain = await pg_board.create(CreateIssueParams(title="Plain"))
        closed = await pg_board.create(CreateIssueParams(title="Marked and closed"))
        await pg_board.patch_metadata(marked.id, {"marker": True})
        await pg_board.patch_metadata(closed.id, {"marker": True})
        await pg_board.close(CloseIssueParams(issue_id=closed.id))

        found = await pg_board.issues_with_metadata_key("marker")
        assert [row["id"] for row in found] == [marked.id]
        assert plain.id not in [row["id"] for row in found]

        with_closed = await pg_board.issues_with_metadata_key("marker", include_closed=True)
        assert sorted(row["id"] for row in with_closed) == sorted([marked.id, closed.id])

    @pytest.mark.asyncio
    async def test_patching_a_missing_issue_refuses_the_way_bd_does(self, pg_board) -> None:
        with pytest.raises(BdCommandError):
            await pg_board.patch_metadata(f"{TEST_PREFIX}-zzz", {"marker": True})
