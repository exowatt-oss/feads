"""The workspace binding an issue carries: ``workspace_dir``, ``session_id``, ``host``.

Three suites, split by what they need.

The first needs nothing: the pure functions in :mod:`beads_mcp.workspace_state` that
decide what gets stamped, what gets lifted, and what a prefix matches; the model layer
that surfaces the binding on every read shape; and the pg WHERE fragment.

The second mocks the ``bd`` subprocess to prove the CLI client spells the binding the way
bd expects — ``--metadata`` on create, ``--set-metadata`` on update, ``--has-metadata-key``
plus a client-side prefix pass on list — without needing a bd binary.

The third is gated on ``FEADS_PG_TEST_DSN`` like :mod:`tests.test_pgstore`, because the
prefix filter is a WHERE clause and only Postgres can say whether it matches.
"""

from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from beads_mcp import pgstore, server
from beads_mcp.agents import AuthorizationContext, request_authorization
from beads_mcp.bd_client import BdClient, _under_workspace_prefix
from beads_mcp.models import (
    BlockedIssue,
    BlockedParams,
    CreateIssueParams,
    Issue,
    IssueMinimal,
    ListIssuesParams,
    ReadyWorkParams,
    UpdateIssueParams,
)
from beads_mcp.transport import serving_http, set_http_transport
from beads_mcp.workspace import normalize_workspace_dir
from beads_mcp.workspace_state import (
    BINDING_KEYS,
    binding_from_metadata,
    binding_metadata,
    create_binding,
    hosted,
    lift_binding,
)

TEST_DSN_ENV = "FEADS_PG_TEST_DSN"
TEST_BOARD = "beads-mcp-pytest-wsb"
TEST_PREFIX = "wsbt"

requires_pg = pytest.mark.skipif(
    not os.environ.get(TEST_DSN_ENV),
    reason=f"set {TEST_DSN_ENV} to run the Postgres store tests",
)

WORKSPACE = "/Users/x/orca/workspaces/dev-tools/wsc-a"
BASE_ISSUE = {
    "id": "bd-1",
    "title": "Session epic",
    "status": "open",
    "priority": 2,
    "issue_type": "epic",
    "created_at": "2026-09-03T00:00:00Z",
    "updated_at": "2026-09-03T00:00:00Z",
}


def _agent_context(**row: str) -> AuthorizationContext:
    agent = {
        "id": "ag_x",
        "board_id": "example",
        "actor": "bob",
        "display_name": "bob",
        "role": "user",
        "invite_id": "",
        "host": "",
        "workspace_dir": "",
        "session_id": "",
        "kind": "agent",
        "registered_at": 0,
        "last_seen_at": 0,
        "revoked_at": None,
        "revoke_reason": "",
        "metadata": {},
    }
    agent.update(row)
    return AuthorizationContext(agent=agent, actor="bob", action="write", allowed=True)  # type: ignore[arg-type]


# =============================================================================
# Pure functions
# =============================================================================


class TestBindingKeys:
    def test_the_contract_spelling(self) -> None:
        """The metadata keys are the contract's names, and also the registry's columns."""
        assert BINDING_KEYS == ("workspace_dir", "session_id", "host")


class TestNormalizeWorkspaceDir:
    def test_expands_and_strips_trailing_separator(self) -> None:
        home = os.path.expanduser("~")
        assert normalize_workspace_dir("~/orca/x/") == f"{home}/orca/x"

    def test_empty_and_whitespace_are_nothing(self) -> None:
        assert normalize_workspace_dir(None) == ""
        assert normalize_workspace_dir("   ") == ""

    def test_root_keeps_its_separator(self) -> None:
        assert normalize_workspace_dir("/") == "/"


class TestBindingMetadata:
    def test_only_supplied_values_are_written(self) -> None:
        assert binding_metadata(session_id="s1") == {"session_id": "s1"}

    def test_blank_values_are_dropped_not_written(self) -> None:
        """A key holding "" would read as "bound to nowhere", which is not "unbound"."""
        assert binding_metadata(workspace_dir="  ", session_id="", host=None) == {}

    def test_workspace_dir_is_normalised(self) -> None:
        assert binding_metadata(workspace_dir=WORKSPACE + "/") == {"workspace_dir": WORKSPACE}


class TestBindingFromMetadata:
    def test_reads_only_the_three_keys(self) -> None:
        meta = {"workspace_dir": WORKSPACE, "host": "mbp", "artifact:x": "claimed", "session_id": " s "}
        assert binding_from_metadata(meta) == {"workspace_dir": WORKSPACE, "host": "mbp", "session_id": "s"}

    def test_tolerates_a_json_string_and_garbage(self) -> None:
        assert binding_from_metadata(json.dumps({"host": "mbp"})) == {"host": "mbp"}
        assert binding_from_metadata("not json") == {}
        assert binding_from_metadata(None) == {}
        assert binding_from_metadata({"host": 3}) == {}


class TestLiftBinding:
    def test_promotes_metadata_keys_to_named_keys(self) -> None:
        data = {**BASE_ISSUE, "metadata": {"workspace_dir": WORKSPACE, "session_id": "s1"}}
        lifted = lift_binding(data)
        assert lifted["workspace_dir"] == WORKSPACE
        assert lifted["session_id"] == "s1"
        assert "host" not in lifted

    def test_an_explicit_named_key_wins(self) -> None:
        data = {**BASE_ISSUE, "host": "explicit", "metadata": {"host": "from-meta"}}
        assert lift_binding(data)["host"] == "explicit"

    def test_no_binding_returns_the_same_object(self) -> None:
        data = {**BASE_ISSUE, "metadata": {"artifact:x": "y"}}
        assert lift_binding(data) is data


class TestCreateBinding:
    def test_epic_defaults_workspace_dir_from_the_resolved_workspace(self) -> None:
        token = request_authorization.set(None)
        try:
            assert create_binding("epic", workspace_root=WORKSPACE) == {"workspace_dir": WORKSPACE}
        finally:
            request_authorization.reset(token)

    def test_epic_defaults_session_and_host_from_the_agent_registry_row(self) -> None:
        token = request_authorization.set(_agent_context(session_id="sess-9", host="mbp"))
        try:
            binding = create_binding("epic", workspace_root=WORKSPACE)
        finally:
            request_authorization.reset(token)
        assert binding == {"workspace_dir": WORKSPACE, "session_id": "sess-9", "host": "mbp"}

    def test_explicit_values_beat_defaults(self) -> None:
        token = request_authorization.set(_agent_context(session_id="sess-9", host="mbp"))
        try:
            binding = create_binding("epic", workspace_dir="/elsewhere", host="other", workspace_root=WORKSPACE)
        finally:
            request_authorization.reset(token)
        assert binding == {"workspace_dir": "/elsewhere", "session_id": "sess-9", "host": "other"}

    def test_hosted_stamps_no_defaults_only_explicit_values(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """On the shared server both default sources describe the *server*, not the session.

        The resolved workspace is the board's server-side directory and the registry row's
        ``host`` is the feads process's hostname — plausible, durable, wrong. So hosted
        creates record only what the caller passed.
        """
        monkeypatch.setenv("FEADS_HOSTED", "1")
        token = request_authorization.set(_agent_context(session_id="", host="feads-ct"))
        try:
            assert hosted() is True
            assert create_binding("epic", workspace_root="/var/lib/feads/boards/forca") == {}
            explicit = create_binding(
                "epic", workspace_dir=WORKSPACE, session_id="sess-9", workspace_root="/var/lib/feads/boards/forca"
            )
        finally:
            request_authorization.reset(token)
        assert explicit == {"workspace_dir": WORKSPACE, "session_id": "sess-9"}

    def test_http_transport_alone_counts_as_hosted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("FEADS_HOSTED", raising=False)
        was = serving_http()
        set_http_transport(True)
        try:
            assert hosted() is True
            assert create_binding("epic", workspace_root=WORKSPACE) == {}
            assert create_binding("epic", workspace_root=WORKSPACE, defaults=True) == {"workspace_dir": WORKSPACE}
        finally:
            set_http_transport(was)

    def test_stdio_is_not_hosted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("FEADS_HOSTED", raising=False)
        was = serving_http()
        set_http_transport(False)
        try:
            assert hosted() is False
        finally:
            set_http_transport(was)

    def test_non_epics_record_only_what_was_given(self) -> None:
        token = request_authorization.set(_agent_context(session_id="sess-9", host="mbp"))
        try:
            assert create_binding("task", workspace_root=WORKSPACE) == {}
            assert create_binding("task", session_id="explicit", workspace_root=WORKSPACE) == {
                "session_id": "explicit"
            }
        finally:
            request_authorization.reset(token)


class TestModels:
    def test_issue_lifts_the_binding_from_metadata(self) -> None:
        issue = Issue.model_validate({**BASE_ISSUE, "metadata": {"workspace_dir": WORKSPACE, "host": "mbp"}})
        assert (issue.workspace_dir, issue.session_id, issue.host) == (WORKSPACE, None, "mbp")

    def test_unbound_issue_has_none_fields(self) -> None:
        issue = Issue.model_validate(BASE_ISSUE)
        assert (issue.workspace_dir, issue.session_id, issue.host) == (None, None, None)

    def test_minimal_omits_the_keys_when_unbound(self) -> None:
        """Three nulls on every list row is the growth IssueMinimal exists to prevent."""
        data = IssueMinimal(id="bd-1", title="t", status="open", priority=2, issue_type="task").model_dump()
        assert not set(BINDING_KEYS) & set(data)

    def test_minimal_carries_the_binding_when_bound(self) -> None:
        data = IssueMinimal(
            id="bd-1", title="t", status="open", priority=2, issue_type="epic", workspace_dir=WORKSPACE
        ).model_dump()
        assert data["workspace_dir"] == WORKSPACE
        assert "session_id" not in data

    def test_blocked_issue_lifts_the_binding_too(self) -> None:
        row = {**BASE_ISSUE, "status": "blocked", "blocked_by_count": 1, "blocked_by": ["bd-2"]}
        blocked = BlockedIssue.model_validate({**row, "metadata": {"session_id": "sess-9"}})
        assert (blocked.session_id, blocked.blocked_by) == ("sess-9", ["bd-2"])

    def test_to_minimal_and_fields_projection_know_the_binding(self) -> None:
        issue = Issue.model_validate({**BASE_ISSUE, "metadata": {"workspace_dir": WORKSPACE}})
        assert server._to_minimal(issue).workspace_dir == WORKSPACE
        assert server._filter_fields(issue, ["id", "workspace_dir"]) == {"id": "bd-1", "workspace_dir": WORKSPACE}

    def test_params_accept_the_binding(self) -> None:
        assert CreateIssueParams(title="t", workspace_dir=WORKSPACE).workspace_dir == WORKSPACE
        assert UpdateIssueParams(issue_id="bd-1", session_id="s").session_id == "s"
        assert ListIssuesParams(workspace_dir_prefix="~/x").workspace_dir_prefix == "~/x"


class TestPrefixMatching:
    def _rows(self) -> list[dict[str, object]]:
        return [
            {"id": "same", "metadata": {"workspace_dir": "/w/dev-tools"}},
            {"id": "below", "metadata": {"workspace_dir": "/w/dev-tools/wsc-a"}},
            {"id": "sibling", "metadata": {"workspace_dir": "/w/dev-tools-old"}},
            {"id": "unbound", "metadata": {"artifact:x": "y"}},
            {"id": "nometa"},
        ]

    def test_client_side_filter_is_path_boundary_aware(self) -> None:
        kept = _under_workspace_prefix(self._rows(), "/w/dev-tools")
        assert [row["id"] for row in kept] == ["same", "below"]

    def test_pg_fragment_is_boundary_aware_and_needs_no_like_escaping(self) -> None:
        args: list[object] = []

        def arg(value: object) -> str:
            args.append(value)
            return f"${len(args)}"

        sql = pgstore._workspace_prefix_sql("/w/dev_tools", arg)
        assert args == ["/w/dev_tools", "/w/dev_tools/"]
        assert "LIKE" not in sql
        assert sql == (
            "((i.metadata->>'workspace_dir') = $1 OR left((i.metadata->>'workspace_dir'), length($2)) = $2)"
        )


# =============================================================================
# The bd CLI client, with the subprocess mocked
# =============================================================================


@pytest.fixture
def bd_client() -> BdClient:
    return BdClient(bd_path="/usr/bin/bd", beads_db="/tmp/test.db", working_dir=WORKSPACE)


def _process(payload: object) -> MagicMock:
    process = MagicMock()
    process.returncode = 0
    process.communicate = AsyncMock(return_value=(json.dumps(payload).encode(), b""))
    return process


def _argv(spawn: MagicMock) -> list[str]:
    return [str(a) for a in spawn.call_args.args]


class TestBdClientSpelling:
    @pytest.mark.asyncio
    async def test_create_epic_stamps_metadata_from_the_workspace(self, bd_client: BdClient) -> None:
        token = request_authorization.set(_agent_context(session_id="sess-9", host="mbp"))
        try:
            with patch("asyncio.create_subprocess_exec", return_value=_process(BASE_ISSUE)) as spawn:
                await bd_client.create(CreateIssueParams(title="Session epic", issue_type="epic"))
        finally:
            request_authorization.reset(token)
        argv = _argv(spawn)
        stamped = json.loads(argv[argv.index("--metadata") + 1])
        assert stamped == {"workspace_dir": WORKSPACE, "session_id": "sess-9", "host": "mbp"}

    @pytest.mark.asyncio
    async def test_create_task_without_binding_passes_no_metadata(self, bd_client: BdClient) -> None:
        token = request_authorization.set(None)
        try:
            with patch("asyncio.create_subprocess_exec", return_value=_process(BASE_ISSUE)) as spawn:
                await bd_client.create(CreateIssueParams(title="child", issue_type="task"))
        finally:
            request_authorization.reset(token)
        assert "--metadata" not in _argv(spawn)

    @pytest.mark.asyncio
    async def test_update_rebinds_per_key_with_set_metadata(self, bd_client: BdClient) -> None:
        with patch("asyncio.create_subprocess_exec", return_value=_process([BASE_ISSUE])) as spawn:
            await bd_client.update(UpdateIssueParams(issue_id="bd-1", workspace_dir="/moved/", host="mbp"))
        argv = _argv(spawn)
        assert "--metadata" not in argv
        pairs = [argv[i + 1] for i, a in enumerate(argv) if a == "--set-metadata"]
        assert pairs == ["workspace_dir=/moved", "host=mbp"]

    @pytest.mark.asyncio
    async def test_ready_and_blocked_surface_the_binding(self, bd_client: BdClient) -> None:
        bound = {**BASE_ISSUE, "metadata": {"workspace_dir": WORKSPACE, "host": "mbp"}}
        with patch("asyncio.create_subprocess_exec", return_value=_process([bound])):
            ready = await bd_client.ready(ReadyWorkParams())
        assert (ready[0].workspace_dir, ready[0].host) == (WORKSPACE, "mbp")

        blocked_row = {**bound, "status": "blocked", "blocked_by_count": 1, "blocked_by": ["bd-2"]}
        with patch("asyncio.create_subprocess_exec", return_value=_process([blocked_row])):
            blocked = await bd_client.blocked(BlockedParams())
        assert (blocked[0].workspace_dir, blocked[0].blocked_by) == (WORKSPACE, ["bd-2"])

    @pytest.mark.asyncio
    async def test_list_prefix_narrows_server_side_then_filters_by_boundary(self, bd_client: BdClient) -> None:
        rows = [
            {**BASE_ISSUE, "id": "bd-a", "metadata": {"workspace_dir": "/w/dev-tools/wsc-a"}},
            {**BASE_ISSUE, "id": "bd-b", "metadata": {"workspace_dir": "/w/dev-tools-old"}},
        ]
        with patch("asyncio.create_subprocess_exec", return_value=_process(rows)) as spawn:
            issues = await bd_client.list_issues(ListIssuesParams(workspace_dir_prefix="/w/dev-tools", limit=5))
        argv = _argv(spawn)
        assert argv[argv.index("--has-metadata-key") + 1] == "workspace_dir"
        assert argv[argv.index("--limit") + 1] == "0"
        assert [i.id for i in issues] == ["bd-a"]
        assert issues[0].workspace_dir == "/w/dev-tools/wsc-a"


# =============================================================================
# Against a real Postgres
# =============================================================================


@pytest.fixture
async def pg_board(monkeypatch: pytest.MonkeyPatch):
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
        yield pgstore.PgStoreClient(board_id=TEST_BOARD, workspace_root=WORKSPACE, actor="agent-a")
    finally:
        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            await _wipe(conn)
            await conn.execute("DELETE FROM boards WHERE id = $1", TEST_BOARD)
        await pgstore.close_pool()


async def _wipe(conn) -> None:
    await conn.execute("DELETE FROM events WHERE board_id = $1", TEST_BOARD)
    await conn.execute("DELETE FROM issues WHERE board_id = $1", TEST_BOARD)


@requires_pg
class TestPgStoreBinding:
    @pytest.mark.asyncio
    async def test_epic_is_stamped_and_reads_back_from_show_and_list(self, pg_board) -> None:
        token = request_authorization.set(_agent_context(session_id="sess-9", host="mbp"))
        try:
            epic = await pg_board.create(CreateIssueParams(title="Session epic", issue_type="epic"))
        finally:
            request_authorization.reset(token)
        assert (epic.workspace_dir, epic.session_id, epic.host) == (WORKSPACE, "sess-9", "mbp")

        shown = await pg_board.show(pgstore.ShowIssueParams(issue_id=epic.id))
        assert shown.workspace_dir == WORKSPACE
        listed = await pg_board.list_issues(ListIssuesParams(limit=50))
        assert [(i.id, i.host) for i in listed] == [(epic.id, "mbp")]

    @pytest.mark.asyncio
    async def test_hosted_create_stamps_only_explicit_values(
        self, pg_board, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The production path: pg store, HTTP, a registry row carrying the server's hostname."""
        monkeypatch.setenv("FEADS_HOSTED", "1")
        token = request_authorization.set(_agent_context(session_id="", host="feads-ct"))
        try:
            defaulted = await pg_board.create(CreateIssueParams(title="no defaults", issue_type="epic"))
            explicit = await pg_board.create(
                CreateIssueParams(title="explicit", issue_type="epic", workspace_dir=WORKSPACE, host="mbp")
            )
        finally:
            request_authorization.reset(token)
        assert (defaulted.workspace_dir, defaulted.session_id, defaulted.host) == (None, None, None)
        assert (await pg_board.read_issue(defaulted.id)).get("metadata") is None
        assert (explicit.workspace_dir, explicit.host) == (WORKSPACE, "mbp")

    @pytest.mark.asyncio
    async def test_blocked_read_carries_the_binding(self, pg_board) -> None:
        token = request_authorization.set(None)
        try:
            blocker = await pg_board.create(CreateIssueParams(title="blocker"))
            epic = await pg_board.create(CreateIssueParams(title="epic", issue_type="epic", deps=[blocker.id]))
        finally:
            request_authorization.reset(token)
        blocked = await pg_board.blocked(BlockedParams())
        assert [(b.id, b.workspace_dir, b.blocked_by) for b in blocked] == [(epic.id, WORKSPACE, [blocker.id])]

    @pytest.mark.asyncio
    async def test_prefix_filter_is_server_side_and_boundary_aware(self, pg_board) -> None:
        token = request_authorization.set(None)
        try:
            a = await pg_board.create(
                CreateIssueParams(title="a", issue_type="epic", workspace_dir="/w/dev-tools/wsc-a")
            )
            await pg_board.create(
                CreateIssueParams(title="b", issue_type="epic", workspace_dir="/w/dev-tools-old")
            )
            await pg_board.create(CreateIssueParams(title="c", issue_type="task"))
        finally:
            request_authorization.reset(token)
        listed = await pg_board.list_issues(ListIssuesParams(workspace_dir_prefix="/w/dev-tools/", limit=50))
        assert [i.id for i in listed] == [a.id]
        assert len(await pg_board.list_issues(ListIssuesParams(limit=50))) == 3

    @pytest.mark.asyncio
    async def test_rebind_merges_and_keeps_other_metadata(self, pg_board) -> None:
        token = request_authorization.set(None)
        try:
            epic = await pg_board.create(CreateIssueParams(title="a", issue_type="epic"))
        finally:
            request_authorization.reset(token)
        await pg_board.patch_metadata(epic.id, {"artifact:x": "claimed"})
        updated = await pg_board.update(UpdateIssueParams(issue_id=epic.id, workspace_dir="/moved", host="mbp"))
        assert (updated.workspace_dir, updated.host) == ("/moved", "mbp")
        raw = await pg_board.read_issue(epic.id)
        assert raw["metadata"]["artifact:x"] == "claimed"
