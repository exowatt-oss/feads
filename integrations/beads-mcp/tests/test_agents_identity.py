"""Agent identity resolution, the roster tools, and the destructive-path gates.

Policy *conformance* is not tested here, and neither is the resolution order:
both are pinned by ``boards/authz-cases.json`` and asserted in
``test_authz_parity.py``. These tests cover what only this surface has — how
resolution reaches the SQL, what the tool payloads look like, and which tool calls
the gates refuse.
"""

from pathlib import Path
from typing import Any

import pytest
from fastmcp.client import Client
from fastmcp.exceptions import ToolError

from beads_mcp.agents import (
    AGENT_TOKEN_ENV,
    AGENT_TOKEN_PREFIX,
    SESSION_ID_ENV,
    agent_whoami_payload,
    agents_list_payload,
    authorize,
    find_agent_by_session,
    hash_token,
    list_agents,
    resolve_identity,
    verify_agent_token,
)
from beads_mcp.authz import REQUIRE_AGENT_ENV
from beads_mcp.boards import REGISTRY_DB_ENV, RegistryUnavailableError
from beads_mcp.server import mcp
from tests.agent_registry_fixture import build_registry

USER_TOKEN = f"{AGENT_TOKEN_PREFIX}1111111111111111111111111111111a"
ADMIN_TOKEN = f"{AGENT_TOKEN_PREFIX}2222222222222222222222222222222b"
REVOKED_TOKEN = f"{AGENT_TOKEN_PREFIX}3333333333333333333333333333333c"

USER_SESSION = "session-user-abc"
REVOKED_SESSION = "session-revoked-abc"


@pytest.fixture(autouse=True)
def clean_identity_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip identity variables the developer's own shell may export.

    Without this, a maintainer who has run ``eval "$(feads-agent env)"`` resolves
    to their real agent and half of these assertions invert — a failure that
    reproduces on one machine and nowhere else. ``CLAUDE_CODE_SESSION_ID`` matters
    most: it is set in every Claude Code session, including the one running these
    tests.
    """
    for name in (AGENT_TOKEN_ENV, SESSION_ID_ENV, REQUIRE_AGENT_ENV, REGISTRY_DB_ENV):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def registry(tmp_path: Path) -> str:
    """Two boards; a user, an admin and a revoked admin on the first.

    ``last_seen_at`` values are distinct and deliberately ordered against
    revocation — the revoked agent has the *newest* one — so the ordering
    assertions below prove live-first outranks recency rather than passing on a
    tie.
    """
    return build_registry(
        tmp_path / "registry.db",
        [
            {
                "id": "ag_user",
                "actor": "laptop-claude",
                "role": "user",
                "token_hash": hash_token(USER_TOKEN),
                "session_id": USER_SESSION,
                "last_seen_at": 30,
            },
            {
                "id": "ag_admin",
                "actor": "alex-admin",
                "role": "admin",
                "token_hash": hash_token(ADMIN_TOKEN),
                "last_seen_at": 20,
            },
            {
                "id": "ag_dead",
                "actor": "old-agent",
                "role": "admin",
                "token_hash": hash_token(REVOKED_TOKEN),
                "session_id": REVOKED_SESSION,
                "last_seen_at": 40,
                "revoked_at": 500,
                "revoke_reason": "rotated",
            },
            {
                "id": "ag_far",
                "board_id": "other",
                "actor": "other-board-agent",
                "role": "user",
                "token_hash": hash_token(f"{AGENT_TOKEN_PREFIX}dddd"),
                "last_seen_at": 10,
            },
        ],
        boards=("lab", "other"),
    )


@pytest.fixture
def as_user(registry: str, monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv(REGISTRY_DB_ENV, registry)
    monkeypatch.setenv(AGENT_TOKEN_ENV, USER_TOKEN)
    return registry


@pytest.fixture
def as_admin(registry: str, monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv(REGISTRY_DB_ENV, registry)
    monkeypatch.setenv(AGENT_TOKEN_ENV, ADMIN_TOKEN)
    return registry


class TestTokenVerification:
    def test_a_live_token_resolves_to_its_agent(self, registry: str) -> None:
        agent = verify_agent_token(USER_TOKEN, registry)
        assert agent is not None
        assert agent["actor"] == "laptop-claude"
        assert agent["role"] == "user"

    def test_a_revoked_token_is_indistinguishable_from_a_wrong_one(self, registry: str) -> None:
        """Both return None, matching verifyAgentToken in boards/agents.mjs."""
        assert verify_agent_token(REVOKED_TOKEN, registry) is None
        assert verify_agent_token(f"{AGENT_TOKEN_PREFIX}deadbeef", registry) is None

    def test_a_token_without_the_agent_prefix_is_not_looked_up(self, registry: str) -> None:
        """An invite token presented as an agent token must not authenticate anything."""
        assert verify_agent_token("fdsi_1111", registry) is None
        assert verify_agent_token("", registry) is None

    def test_no_read_path_exposes_the_token_hash(self, registry: str) -> None:
        """token_hash is kept out of every SELECT so a caller cannot dump it."""
        agent = verify_agent_token(USER_TOKEN, registry)
        assert agent is not None
        assert "token_hash" not in agent


class TestSessionLookup:
    def test_a_session_resolves_to_the_agent_that_registered_it(self, registry: str) -> None:
        agent = find_agent_by_session(USER_SESSION, db_path=registry)
        assert agent is not None
        assert agent["id"] == "ag_user"

    def test_a_revoked_agents_session_resolves_to_nothing_by_default(self, registry: str) -> None:
        assert find_agent_by_session(REVOKED_SESSION, db_path=registry) is None

    def test_include_revoked_is_how_never_registered_is_told_from_revoked(self, registry: str) -> None:
        """The default lookup answers None for both states, and conflating them is
        what let revocation promote an agent to operator. This is the query that
        separates them."""
        found = find_agent_by_session(REVOKED_SESSION, include_revoked=True, db_path=registry)
        assert found is not None
        assert found["id"] == "ag_dead"
        assert find_agent_by_session("never-registered", include_revoked=True, db_path=registry) is None

    def test_an_empty_session_id_is_not_a_query(self, registry: str) -> None:
        assert find_agent_by_session("", db_path=registry) is None

    def test_a_board_scoped_lookup_ignores_agents_on_other_boards(self, registry: str) -> None:
        assert find_agent_by_session(USER_SESSION, board_id="lab", db_path=registry) is not None
        assert find_agent_by_session(USER_SESSION, board_id="other", db_path=registry) is None


class TestIdentityResolution:
    def test_a_token_wins_over_a_session(self, registry: str) -> None:
        """The deliberate credential beats the ambient fact about the process."""
        resolved = resolve_identity({AGENT_TOKEN_ENV: ADMIN_TOKEN, SESSION_ID_ENV: USER_SESSION}, registry)
        assert resolved["via"] == "token"
        assert resolved["identity"] is not None
        assert resolved["identity"]["actor"] == "alex-admin"

    def test_nothing_presented_is_operator_mode(self, registry: str) -> None:
        resolved = resolve_identity({}, registry)
        assert resolved["mode"] == "operator"
        assert resolved["via"] == "none"
        assert resolved["agent"] is None
        assert resolved["credential_rejected"] is False
        assert resolved["require_identity"] is False

    @pytest.mark.parametrize(
        ("env", "door"),
        [
            ({AGENT_TOKEN_ENV: REVOKED_TOKEN}, "token"),
            ({SESSION_ID_ENV: REVOKED_SESSION}, "session"),
        ],
    )
    def test_revocation_is_a_rejection_through_either_door(
        self, registry: str, env: dict[str, str], door: str
    ) -> None:
        """Revoking an agent must not *increase* what it can do.

        A revoked credential resolves to no agent, and no agent locally means
        operator, which may delete anything — so without the rejection flag,
        revocation would be a promotion. The session door is the likelier one for a
        long-lived daemon, which has no token but always has a session id.

        Resolution order itself is pinned by ``resolution_cases``; asserted again
        here because what matters at this level is that the flag survives the trip
        from resolution into the decision.
        """
        resolved = resolve_identity(env, registry)
        assert resolved["mode"] == "rejected", door
        assert resolved["via"] == "rejected", door
        assert resolved["credential_rejected"] is True, door

        for flag in ({}, {REQUIRE_AGENT_ENV: "1"}):
            decision = authorize("delete", {"created_by": "someone-else"}, {**env, **flag}, registry)
            assert not decision["allowed"], (door, flag)
            assert decision["mode"] == "rejected", (door, flag)

        # The tier it *used* to hold is irrelevant: even a read is refused.
        assert not authorize("read", None, env, registry)["allowed"], door

    def test_an_unmatched_session_is_not_a_rejected_credential(self, registry: str) -> None:
        """CLAUDE_CODE_SESSION_ID is exported by every Claude Code session whether
        or not anyone registered, so treating an unmatched one as a failed
        authentication would deny every unregistered session on the machine."""
        resolved = resolve_identity({SESSION_ID_ENV: "session-nobody-registered"}, registry)
        assert resolved["mode"] == "operator"
        assert resolved["via"] == "none"
        assert resolved["credential_rejected"] is False

    def test_a_missing_registry_reports_rather_than_raises(self, tmp_path: Path) -> None:
        """An absent registry means "nobody has registered", which is the normal
        state of a machine that has not minted an invite — not a tool failure.

        And not a rejected credential either, even with a token presented: nothing
        was checked, so nothing was found wanting.
        """
        resolved = resolve_identity({AGENT_TOKEN_ENV: USER_TOKEN}, str(tmp_path / "nope.db"))
        assert resolved["mode"] == "operator"
        assert resolved["credential_rejected"] is False
        assert "nope.db" in resolved["registry_error"]

    def test_require_identity_is_read_from_the_environment(self, registry: str) -> None:
        assert resolve_identity({REQUIRE_AGENT_ENV: "yes"}, registry)["require_identity"] is True
        assert resolve_identity({REQUIRE_AGENT_ENV: "0"}, registry)["require_identity"] is False

    def test_stdio_is_the_operator_and_the_env_flag_still_tightens_it(self, registry: str) -> None:
        """Stdio keeps `operator`, and that is a decision, not a leftover.

        The server is a subprocess of the agent that launched it, reading a registry
        that agent could open itself — and, unlike a browser, stdio cannot *offer* the
        read-only bargain, because the token is read from the environment once at
        startup. Refusing a stdio caller is a dead end rather than an invitation to
        authenticate. Strictness stays opt-in via FEADS_REQUIRE_AGENT.

        The HTTP half of this is in test_wire_identity.py, which has to fake a request
        context to get at it.
        """
        assert resolve_identity({}, registry)["stance"] == "operator"
        assert resolve_identity({REQUIRE_AGENT_ENV: "1"}, registry)["stance"] == "deny"

    @pytest.mark.parametrize(
        "env",
        [
            {},
            {REQUIRE_AGENT_ENV: "1"},
            {AGENT_TOKEN_ENV: USER_TOKEN},
            {AGENT_TOKEN_ENV: ADMIN_TOKEN},
            {AGENT_TOKEN_ENV: REVOKED_TOKEN},
            {SESSION_ID_ENV: REVOKED_SESSION},
            {SESSION_ID_ENV: "session-nobody-registered"},
            {AGENT_TOKEN_ENV: REVOKED_TOKEN, REQUIRE_AGENT_ENV: "1"},
            {AGENT_TOKEN_ENV: USER_TOKEN, REQUIRE_AGENT_ENV: "1"},
        ],
    )
    def test_the_reported_mode_matches_the_mode_of_the_decision(self, registry: str, env: dict[str, str]) -> None:
        """`resolve_identity` settles the mode before any action is known.

        It can, because mode is action-independent in every branch of `decide` — but
        that is an invariant of two functions in different modules, so it is checked
        rather than asserted in a comment. `agent_whoami` reports the resolved mode
        and an agent explains its own latitude from it; a mode that disagreed with
        the decisions actually being made would mislead it about why a call failed.
        """
        resolved = resolve_identity(env, registry)
        for action in ("read", "write", "delete", "manage_agents", "view_roster"):
            decision = authorize(action, {"created_by": "someone-else"}, env, registry)
            assert decision["mode"] == resolved["mode"], (env, action)


class TestListAgents:
    def test_revoked_agents_are_excluded_by_default(self, registry: str) -> None:
        actors = [a["actor"] for a in list_agents(board_id="lab", db_path=registry)]
        assert actors == ["laptop-claude", "alex-admin"]

    def test_include_revoked_returns_history_live_first(self, registry: str) -> None:
        """Live agents sort ahead of revoked ones even when a revoked row was seen
        more recently — `old-agent` has the newest last_seen_at in the fixture."""
        agents = list_agents(board_id="lab", include_revoked=True, db_path=registry)
        assert [a["actor"] for a in agents] == ["laptop-claude", "alex-admin", "old-agent"]

    def test_an_empty_board_id_spans_every_board(self, registry: str) -> None:
        actors = {a["actor"] for a in list_agents(db_path=registry)}
        assert "other-board-agent" in actors

    def test_a_missing_registry_raises_for_direct_callers(self, tmp_path: Path) -> None:
        with pytest.raises(RegistryUnavailableError):
            list_agents(db_path=str(tmp_path / "nope.db"))


class TestRosterScoping:
    def test_an_admin_sees_every_agent(self, registry: str) -> None:
        payload = agents_list_payload("lab", env={AGENT_TOKEN_ENV: ADMIN_TOKEN}, db_path=registry)
        assert payload["scope"] == "all"
        assert payload["count"] == 2

    def test_a_user_sees_only_itself(self, registry: str) -> None:
        payload = agents_list_payload("lab", env={AGENT_TOKEN_ENV: USER_TOKEN}, db_path=registry)
        assert payload["allowed"] is True
        assert payload["scope"] == "self"
        assert [a["actor"] for a in payload["agents"]] == ["laptop-claude"]

    def test_a_user_sees_itself_even_while_working_another_board(self, registry: str) -> None:
        """The self row is answered from the resolved identity, not by querying the
        board in the request — an agent registered on lab must not vanish from its
        own roster because it is working on `other`."""
        payload = agents_list_payload("other", env={AGENT_TOKEN_ENV: USER_TOKEN}, db_path=registry)
        assert [a["agent_id"] for a in payload["agents"]] == ["ag_user"]

    def test_the_operator_sees_the_whole_roster_not_an_empty_one(self, registry: str) -> None:
        """The trap roster_scope_for exists for: the bare tier lookup answers
        `none` for an unidentified caller, which would render as "no agents are
        registered" rather than "you were not recognized"."""
        payload = agents_list_payload("lab", env={}, db_path=registry)
        assert payload["mode"] == "operator"
        assert payload["scope"] == "all"
        assert payload["count"] == 2

    def test_require_agent_refuses_an_unidentified_caller(self, registry: str) -> None:
        payload = agents_list_payload("lab", env={REQUIRE_AGENT_ENV: "1"}, db_path=registry)
        assert payload["allowed"] is False
        assert payload["scope"] == "none"
        assert payload["agents"] == []
        # `anonymous`, not `operator`: the flag refuses this caller, and it was never
        # granted operator standing to lose.
        assert payload["mode"] == "anonymous"
        assert payload["require_identity"] is True
        # The refusal is the policy's own wording, which is deliberately stance-
        # agnostic — a surface can be strict because of this flag or because that is
        # its default, so the reason says what to do rather than what is set. The
        # flag itself is reported in `require_identity` above.
        assert "requires an agent identity" in payload["reason"]

    def test_a_rejected_credential_sees_nothing_not_everything(self, registry: str) -> None:
        payload = agents_list_payload("lab", env={AGENT_TOKEN_ENV: REVOKED_TOKEN}, db_path=registry)
        assert payload["allowed"] is False
        assert payload["mode"] == "rejected"
        assert payload["scope"] == "none"
        assert payload["agents"] == []

    def test_an_empty_roster_carries_a_setup_hint(self, registry: str) -> None:
        payload = agents_list_payload("no-such-board", env={AGENT_TOKEN_ENV: ADMIN_TOKEN}, db_path=registry)
        assert payload["count"] == 0
        assert "feads-agent invite" in payload["hint"]

    def test_a_missing_registry_is_an_empty_roster_with_a_hint(self, tmp_path: Path) -> None:
        payload = agents_list_payload("lab", env={}, db_path=str(tmp_path / "nope.db"))
        assert payload["agents"] == []
        assert "feads-agent invite" in payload["hint"]
        assert "nope.db" in payload["error"]


class TestWhoami:
    def test_a_user_reports_owning_only_its_own_deletes(self, registry: str) -> None:
        payload = agent_whoami_payload({AGENT_TOKEN_ENV: USER_TOKEN}, registry)
        assert payload["mode"] == "agent"
        assert payload["via"] == "token"
        assert payload["identity"]["actor"] == "laptop-claude"
        assert payload["permissions"] == {
            "read": True,
            "write": True,
            # Reported even for an agent that already has an identity: sign-up is open
            # to every tier in the shared policy. `agent_signup` refuses an identified
            # caller for its own reason — a second identity would not own the first
            # one's items — which is a different thing from the policy refusing it.
            "sign_up": True,
            "delete_own": True,
            "delete_any": False,
            "manage_agents": False,
            "view_roster": True,
        }
        assert payload["roster_scope"] == "self"

    def test_an_admin_reports_full_latitude(self, registry: str) -> None:
        payload = agent_whoami_payload({AGENT_TOKEN_ENV: ADMIN_TOKEN}, registry)
        assert payload["permissions"]["delete_any"] is True
        assert payload["permissions"]["manage_agents"] is True
        assert payload["roster_scope"] == "all"

    def test_an_unidentified_caller_is_told_how_to_get_a_credential(self, registry: str) -> None:
        """The hint points at the dashboard, not at a CLI.

        An agent cannot register itself — signing up is a write, and this server never
        writes the registry. So the actionable instruction is one it relays to its
        human, and that is what the hint has to contain to be worth anything.
        """
        payload = agent_whoami_payload({}, registry)
        assert payload["identity"] is None
        assert payload["mode"] == "operator"
        assert payload["permissions"]["delete_any"] is True
        assert "dashboard" in payload["hint"]
        assert "127.0.0.1:4141" in payload["hint"]

    def test_under_require_agent_an_unidentified_caller_may_only_sign_up(self, registry: str) -> None:
        payload = agent_whoami_payload({REQUIRE_AGENT_ENV: "1"}, registry)
        assert payload["permissions"] == {
            "read": False,
            "write": False,
            # Sign-up stays open: enrollment is how a caller satisfies the identity
            # requirement (policy change 2026-07-29 — closing it made the deny stance
            # unescapable), and an agent that reads this learns the one call that
            # will work: agent_signup.
            "sign_up": True,
            "delete_own": False,
            "delete_any": False,
            "manage_agents": False,
            "view_roster": False,
        }
        assert payload["roster_scope"] == "none"

    def test_a_rejected_credential_is_told_why_every_call_now_fails(self, registry: str) -> None:
        payload = agent_whoami_payload({AGENT_TOKEN_ENV: REVOKED_TOKEN}, registry)
        assert payload["mode"] == "rejected"
        assert payload["credential_rejected"] is True
        assert payload["identity"] is None
        assert not any(payload["permissions"].values())
        assert AGENT_TOKEN_ENV in payload["hint"]


class TestAgentToolsOverMcp:
    async def test_tools_are_registered_and_catalogued(self) -> None:
        async with Client(mcp) as client:
            names = {tool.name for tool in await client.list_tools()}
            catalog = await client.call_tool("discover_tools", {})
        assert {"agents_list", "agent_whoami"} <= names
        assert {"agents_list", "agent_whoami"} <= set(catalog.data["tools"])

    async def test_get_tool_info_documents_both_tools(self) -> None:
        async with Client(mcp) as client:
            roster = await client.call_tool("get_tool_info", {"tool_name": "agents_list"})
            whoami = await client.call_tool("get_tool_info", {"tool_name": "agent_whoami"})
        assert "board" in roster.data["parameters"]
        assert whoami.data["name"] == "agent_whoami"

    async def test_the_tools_read_the_registry_the_env_var_points_at(self, as_user: str) -> None:
        async with Client(mcp) as client:
            roster = await client.call_tool("agents_list", {"board": "lab"})
            me = await client.call_tool("agent_whoami", {})
        assert roster.data["scope"] == "self"
        assert me.data["identity"]["actor"] == "laptop-claude"


class TestDestructiveGates:
    """The gated paths, refused before bd is ever invoked.

    Only the refusals are exercised through the client: the allowed path would
    shell out to `bd doctor` and delete rows from whatever board the working
    directory resolves to, which is exactly what conftest.py's pollution guard
    exists to prevent. The allow side is asserted against `authorize` instead.
    """

    @pytest.mark.parametrize(
        ("arguments", "expected"),
        [
            ({"action": "pollution", "clean": True}, "pollution --clean"),
            ({"action": "validate", "fix_all": True}, "validate --fix"),
        ],
    )
    async def test_a_user_cannot_bulk_delete(self, as_user: str, arguments: dict[str, Any], expected: str) -> None:
        async with Client(mcp) as client:
            with pytest.raises(ToolError) as excinfo:
                await client.call_tool("admin", arguments)
        message = str(excinfo.value)
        assert expected in message
        # The refusal reaches the agent as the policy's own wording, so it can
        # explain itself rather than retrying blind.
        assert "an admin must delete it" in message

    async def test_an_admin_may_bulk_delete(self, registry: str) -> None:
        for what in ("pollution --clean", "validate --fix"):
            decision = authorize("delete", {"id": what}, {AGENT_TOKEN_ENV: ADMIN_TOKEN}, registry)
            assert decision["allowed"], what
            assert decision["mode"] == "agent"

    async def test_the_operator_may_bulk_delete(self, registry: str) -> None:
        """Unidentified is the operator locally, and the operator owns the database."""
        decision = authorize("delete", {"id": "pollution --clean"}, {}, registry)
        assert decision["allowed"]
        assert decision["mode"] == "operator"

    async def test_require_agent_refuses_a_bulk_delete_outright(self, registry: str) -> None:
        decision = authorize("delete", {"id": "pollution --clean"}, {REQUIRE_AGENT_ENV: "1"}, registry)
        assert not decision["allowed"]
        # The gate prints this mode back to the agent, so it must not claim the
        # caller was the operator while refusing it.
        assert decision["mode"] == "anonymous"

    async def test_a_rejected_credential_cannot_bulk_delete(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The gate must not treat a failed authentication as the operator.

        Through the client rather than through `authorize` alone, because this is
        the path where a promotion would actually have been exploitable.
        """
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        monkeypatch.setenv(AGENT_TOKEN_ENV, REVOKED_TOKEN)
        async with Client(mcp) as client:
            with pytest.raises(ToolError) as excinfo:
                await client.call_tool("admin", {"action": "pollution", "clean": True})
        assert "did not verify" in str(excinfo.value)

    async def test_read_only_diagnostics_are_not_gated(self, as_user: str) -> None:
        """`debug` mutates nothing, so a user reaches it without a delete right.

        Deliberately the `debug` action rather than `validate`/`repair`: it is the
        one branch that runs entirely in-process, so this asserts the gate's
        absence without shelling out to bd.
        """
        async with Client(mcp) as client:
            result = await client.call_tool("admin", {"action": "debug"})
        assert "Working Directory Debug Info" in result.data
