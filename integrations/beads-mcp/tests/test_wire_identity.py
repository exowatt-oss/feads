"""The wire layer: which stance a transport earns, and how a token rides a request.

Split from ``test_agents_identity.py`` because everything here needs an HTTP request
to exist, and two of the assertions are only meaningful against a *real* server:

- that ``Authorization: Bearer`` survives the trip into
  :func:`beads_mcp.agents.authorize`, which runs in a worker thread. FastMCP keeps the
  request in ContextVars and ``asyncio.to_thread`` copies the context, so it does —
  but that is a two-library invariant holding up an authentication path, and asserting
  it against a live socket is the only way to know it still holds after an upgrade.
- that an anonymous HTTP caller cannot write. A stanceless check would pass while the
  gate was missing from every mutating tool.
"""

import asyncio
import contextlib
import json
import socket
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
import uvicorn
from fastmcp.client import Client
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.exceptions import ToolError

from beads_mcp import artifacts as artifacts_module
from beads_mcp import bd_client as bd_client_module
from beads_mcp import transport as wire
from beads_mcp.agents import (
    AGENT_TOKEN_ENV,
    AGENT_TOKEN_PREFIX,
    acting_actor,
    agent_whoami_payload,
    authorize,
    hash_token,
    how_to_get_a_credential,
    resolve_identity,
)
from beads_mcp.authz import REQUIRE_AGENT_ENV
from beads_mcp.bd_client import BdCliClient
from beads_mcp.boards import REGISTRY_DB_ENV
from beads_mcp.server import mcp
from tests.agent_registry_fixture import build_registry

USER_TOKEN = f"{AGENT_TOKEN_PREFIX}4444444444444444444444444444444d"
REVOKED_TOKEN = f"{AGENT_TOKEN_PREFIX}5555555555555555555555555555555e"


@pytest.fixture(autouse=True)
def clean_wire_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Strip ambient identity, and restore the process-wide transport flag.

    The flag is module state deliberately (one process serves one transport), so a
    test that sets it must put it back or every later test in the session inherits an
    HTTP stance — which would be a false *pass* for anything asserting a refusal.
    """
    for name in (AGENT_TOKEN_ENV, "CLAUDE_CODE_SESSION_ID", REQUIRE_AGENT_ENV, REGISTRY_DB_ENV):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv(wire.DASHBOARD_URL_ENV, raising=False)
    previous = wire.serving_http()
    yield
    wire.set_http_transport(previous)


@pytest.fixture
def registry(tmp_path: Path) -> str:
    return build_registry(
        tmp_path / "wire.db",
        [
            {
                "id": "ag_wire",
                "actor": "wire-claude",
                "role": "user",
                "token_hash": hash_token(USER_TOKEN),
            },
            {
                "id": "ag_wire_dead",
                "actor": "old-wire",
                "role": "admin",
                "token_hash": hash_token(REVOKED_TOKEN),
                "revoked_at": 900,
            },
        ],
    )


class TestStancePerTransport:
    """`operator` on stdio, `read_only` on HTTP — the escalation this closes."""

    def test_http_is_read_only_so_an_anonymous_network_caller_cannot_destroy_anything(self, registry: str) -> None:
        """The vulnerability, stated as a test.

        Held at `operator`, an unauthenticated HTTP request would be the operator: it
        could delete any item on any board via `admin(action="pollution", clean=True)`
        and mint itself an *admin* invite. The justification for `operator` is "a local
        caller already owns the database file", which is false for whoever reached a
        port. `read_only` is the only reading of that pipe that is true.
        """
        wire.set_http_transport(True)
        assert wire.surface_stance({}) == "read_only"

        assert authorize("read", None, {}, registry)["allowed"]
        for action in ("write", "delete", "manage_agents", "view_roster"):
            decision = authorize(action, {"created_by": "someone-else"}, {}, registry)
            assert not decision["allowed"], action
            assert decision["mode"] == "anonymous", action

    def test_http_still_lets_an_anonymous_caller_sign_up(self, registry: str) -> None:
        """Sign-up has to survive `read_only`, or presenting a credential is a closed
        loop: you would need an identity to obtain one. The admin tier stays shut, so
        sign-up cannot become a self-promotion button."""
        wire.set_http_transport(True)
        assert authorize("mint_invite", {"role": "user"}, {}, registry)["allowed"]
        assert not authorize("mint_invite", {"role": "admin"}, {}, registry)["allowed"]

    def test_stdio_is_unchanged(self, registry: str) -> None:
        wire.set_http_transport(False)
        assert wire.surface_stance({}) == "operator"
        assert authorize("delete", {"created_by": "someone-else"}, {}, registry)["allowed"]

    def test_the_env_flag_tightens_either_transport_and_loosens_neither(self) -> None:
        for http in (True, False):
            wire.set_http_transport(http)
            assert wire.surface_stance({REQUIRE_AGENT_ENV: "1"}) == "deny", http
        # And no setting of it can talk HTTP back into operator.
        wire.set_http_transport(True)
        assert wire.surface_stance({REQUIRE_AGENT_ENV: "0"}) == "read_only"

    def test_an_identified_agent_is_unaffected_by_the_transport(self, registry: str) -> None:
        """The stance describes callers with no credential. A token opts you into your
        tier, and the tier is the same whichever pipe it arrived on — otherwise the
        same agent would have different rights depending on how it connected."""
        for http in (True, False):
            wire.set_http_transport(http)
            decision = authorize("write", None, {AGENT_TOKEN_ENV: USER_TOKEN}, registry)
            assert decision["allowed"], http
            assert decision["mode"] == "agent", http


class TestBearerExtraction:
    """Parsing, in isolation. The end-to-end proof is further down."""

    def test_no_request_means_no_token_rather_than_an_error(self) -> None:
        wire.set_http_transport(False)
        assert wire.bearer_token() == ""

    @pytest.mark.parametrize(
        ("header", "expected"),
        [
            (f"Bearer {USER_TOKEN}", USER_TOKEN),
            (f"bearer {USER_TOKEN}", USER_TOKEN),
            (f"BEARER   {USER_TOKEN}  ", USER_TOKEN),
            # Not our credential: somebody else's scheme must read as "nothing
            # presented", not as a rejection. Refusing every gated call because a proxy
            # added its own header would be a denial of service wearing a security
            # explanation.
            (f"Basic {USER_TOKEN}", ""),
            ("Negotiate abc", ""),
            (USER_TOKEN, ""),
            ("", ""),
            ("Bearer", ""),
        ],
    )
    def test_only_the_bearer_scheme_is_read(
        self, monkeypatch: pytest.MonkeyPatch, header: str, expected: str
    ) -> None:
        monkeypatch.setattr(wire, "get_http_headers", None, raising=False)
        import fastmcp.server.dependencies as deps

        monkeypatch.setattr(deps, "get_http_headers", lambda **_: {"authorization": header})
        assert wire.bearer_token() == expected

    def test_the_authorization_header_must_be_opted_back_in(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """FastMCP strips `authorization` from get_http_headers() by default.

        Reading it needs `include={"authorization"}`, and forgetting that produces an
        authentication bug indistinguishable from a client sending the wrong header —
        so this asserts the opt-in is actually passed, not just that parsing works.
        """
        seen: dict[str, Any] = {}
        import fastmcp.server.dependencies as deps

        def spy(**kwargs: Any) -> dict[str, str]:
            seen.update(kwargs)
            return {}

        monkeypatch.setattr(deps, "get_http_headers", spy)
        wire.bearer_token()
        assert seen.get("include") == {"authorization"}


class TestDashboardUrl:
    def test_the_default_is_the_launchers_documented_port(self) -> None:
        assert wire.dashboard_url({}) == "http://127.0.0.1:4141"

    def test_a_deployment_can_correct_it(self) -> None:
        assert wire.dashboard_url({wire.DASHBOARD_URL_ENV: "https://feads.example/ "}) == "https://feads.example"

    def test_a_blank_override_falls_back_rather_than_emitting_a_broken_sentence(self) -> None:
        """An agent pastes this at a person, who cannot tell a blank URL from a bug."""
        assert wire.dashboard_url({wire.DASHBOARD_URL_ENV: "   "}) == wire.DEFAULT_DASHBOARD_URL

    def test_public_url_wins_for_human_facing_guidance(self) -> None:
        env = {
            wire.DASHBOARD_URL_ENV: "http://127.0.0.1:4500",
            wire.PUBLIC_URL_ENV: "https://feads-demo.apps.example.test/",
        }
        assert wire.public_dashboard_url(env) == "https://feads-demo.apps.example.test"


class TestCredentialInstructions:
    def test_stdio_says_restart_because_it_cannot_adopt_a_token_mid_session(self) -> None:
        wire.set_http_transport(False)
        text = how_to_get_a_credential({})
        assert "127.0.0.1:4141" in text
        assert AGENT_TOKEN_ENV in text
        assert "restart" in text.lower()

    def test_http_says_send_a_header_because_it_can(self) -> None:
        wire.set_http_transport(True)
        text = how_to_get_a_credential({})
        assert "Authorization: Bearer" in text
        # Says so explicitly rather than staying silent: an agent that has just been
        # told to fetch a token needs to know it can use it on the next call, or it
        # will ask for a restart it does not need.
        assert "nothing needs restarting" in text

    def test_http_guidance_uses_the_public_dashboard_url(self) -> None:
        wire.set_http_transport(True)
        text = how_to_get_a_credential(
            {
                wire.DASHBOARD_URL_ENV: "http://127.0.0.1:4500",
                wire.PUBLIC_URL_ENV: "https://feads-demo.apps.example.test",
            }
        )
        assert "https://feads-demo.apps.example.test" in text
        assert "127.0.0.1:4500" not in text

    def test_it_always_names_the_dashboard_and_never_sends_the_human_to_an_admin(self) -> None:
        """Sign-up is open, so asking for an admin would send the human hunting for a
        person they do not need."""
        for http in (True, False):
            wire.set_http_transport(http)
            text = how_to_get_a_credential({})
            assert "dashboard" in text
            assert "ask an admin" not in text
            assert "needs no admin" in text


class TestWhoamiAnswersAnAnonymousCaller:
    def test_it_explains_the_situation_instead_of_erroring(self, registry: str) -> None:
        wire.set_http_transport(True)
        payload = agent_whoami_payload({}, registry)
        assert payload["identity"] is None
        assert payload["mode"] == "anonymous"
        assert payload["stance"] == "read_only"
        assert payload["credential_source"] == "none"
        assert payload["permissions"] == {
            "read": True,
            "write": False,
            # True, and it is the only thing besides reading that an anonymous caller on
            # a shared endpoint may do: `read_only` allows sign-up because requiring an
            # identity in order to obtain one is a closed loop. Over HTTP that offer is
            # real — the token rides on the next request, so there is nothing to restart.
            "sign_up": True,
            "delete_own": False,
            "delete_any": False,
            "manage_agents": False,
            "view_roster": False,
        }
        # The whole point: it is told what to do, and now the first thing it is told is
        # something it can do itself.
        assert "dashboard" in payload["hint"]
        assert "agent_signup" in payload["hint"]
        assert "127.0.0.1:4141" in payload["hint"]

    def test_it_reports_which_door_a_credential_came_through(self, registry: str) -> None:
        """ "My token does not work" is the first question wire auth produces, and the
        answer is usually that it went into the wrong one of two places."""
        wire.set_http_transport(False)
        assert agent_whoami_payload({AGENT_TOKEN_ENV: USER_TOKEN}, registry)["credential_source"] == "environment"

    def test_a_rejected_header_token_says_so_rather_than_blaming_the_environment(self, registry: str) -> None:
        wire.set_http_transport(True)
        resolved = resolve_identity({AGENT_TOKEN_ENV: REVOKED_TOKEN}, registry)
        assert resolved["mode"] == "rejected"
        assert resolved["credential_source"] == "environment"


# =============================================================================
# End to end, over a real socket
# =============================================================================


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@contextlib.asynccontextmanager
async def _serving(registry: str) -> AsyncIterator[str]:
    """Run this server over real HTTP on an ephemeral port.

    The registry is passed through the *process* environment because that is how the
    server reads it; the per-caller identity is what rides the request, which is the
    distinction under test.
    """
    port = _free_port()
    app = mcp.http_app(path="/mcp")
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(200):
            if server.started:
                break
            await asyncio.sleep(0.05)
        assert server.started, "uvicorn did not start"
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        server.should_exit = True
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(task, timeout=10)


async def _whoami(url: str, token: str = "") -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with Client(StreamableHttpTransport(url, headers=headers)) as client:
        result = await client.call_tool("agent_whoami", {})
    return dict(result.data)


class TestOverRealHttp:
    """Nothing in-process can prove these two."""

    async def test_a_bearer_token_reaches_the_decision_through_the_worker_thread(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The load-bearing integration: header -> ContextVar -> to_thread -> SQLite.

        `authorize` runs in a worker thread for its registry read. If ContextVars did
        not survive `asyncio.to_thread`, this would silently resolve to anonymous and
        every wire credential would be ignored — an authentication failure that looks
        like a client bug.
        """
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        async with _serving(registry) as url:
            identified = await _whoami(url, USER_TOKEN)
            anonymous = await _whoami(url)

        assert identified["mode"] == "agent"
        assert identified["identity"]["actor"] == "wire-claude"
        assert identified["credential_source"] == "authorization_header"
        assert identified["permissions"]["write"] is True
        assert identified["permissions"]["delete_any"] is False

        # Same server, same second, no header: read-only and told how to fix it.
        assert anonymous["mode"] == "anonymous"
        assert anonymous["stance"] == "read_only"
        assert anonymous["permissions"]["write"] is False
        assert "dashboard" in anonymous["hint"]

    async def test_a_revoked_header_token_is_rejected_not_treated_as_anonymous(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Revocation must not invert over the wire either.

        If a header token that fails to verify fell through to "no credential", a
        revoked agent would land in the anonymous bucket — which over HTTP still reads
        the whole board. Rejection has to outrank the stance.
        """
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        async with _serving(registry) as url:
            payload = await _whoami(url, REVOKED_TOKEN)
        assert payload["mode"] == "rejected"
        assert payload["credential_source"] == "authorization_header"
        assert not any(payload["permissions"].values())
        assert "did not verify" in payload["hint"] or "matched no live agent" in payload["hint"]

    async def test_an_anonymous_http_caller_cannot_write_through_the_tools(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`read_only` has to be a control, not a label.

        Before the write gate, an anonymous HTTP caller was refused deletes but could
        still create, edit and close anything — while `agent_whoami` reported
        `"write": false`. That combination is worse than an open door, because it is an
        open door with a sign saying "closed".
        """
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        async with _serving(registry) as url, Client(StreamableHttpTransport(url)) as client:
            with pytest.raises(ToolError) as excinfo:
                await client.call_tool("create", {"title": "should never exist"})
        message = str(excinfo.value)
        assert "read-only" in message
        # The refusal carries the fix, so the agent asks its human instead of retrying.
        assert "dashboard" in message

    async def test_an_identified_user_passes_the_write_gate_over_http(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The gate must not be a blanket refusal.

        Asserted through `authorize` rather than by calling `create`, which would shell
        out to bd and mutate whatever board the working directory resolves to — the
        thing conftest.py's pollution guard exists to prevent. What matters here is
        that the *decision* differs from the anonymous one on the same transport.
        """
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        wire.set_http_transport(True)
        assert authorize("write", None, {AGENT_TOKEN_ENV: USER_TOKEN}, registry)["allowed"]
        assert not authorize("write", None, {}, registry)["allowed"]


class TestTheArtifactToolsRespectTheSameGate:
    """The artifact tools are the newest writers, so they are the easiest to add ungated.

    Three of the six mutate a board — attach, release, respond — and they went in after
    the write gate existed, which is exactly the case the decorator was chosen over an
    in-body check to survive. The other three are reads and must stay open: an anonymous
    caller that could not ask "who else claims this path" would be back to discovering
    collisions at merge time, and hiding claims is the one thing this feature must not do.
    """

    async def test_an_anonymous_http_caller_cannot_attach(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        async with _serving(registry) as url, Client(StreamableHttpTransport(url)) as client:
            with pytest.raises(ToolError) as excinfo:
                await client.call_tool("artifact_add", {"issue_id": "ex-1", "refs": ["example-org/feads:go.mod"]})
        assert "read-only" in str(excinfo.value)

    async def test_an_anonymous_http_caller_cannot_release(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        async with _serving(registry) as url, Client(StreamableHttpTransport(url)) as client:
            with pytest.raises(ToolError) as excinfo:
                await client.call_tool(
                    "artifact_remove", {"issue_id": "ex-1", "refs": ["example-org/feads:go.mod"]}
                )
        assert "read-only" in str(excinfo.value)

    async def test_an_anonymous_http_caller_cannot_respond(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        async with _serving(registry) as url, Client(StreamableHttpTransport(url)) as client:
            with pytest.raises(ToolError) as excinfo:
                await client.call_tool(
                    "artifact_respond",
                    {"ref": "example-org/feads:go.mod", "mine": "ex-1", "action": "taking"},
                )
        assert "read-only" in str(excinfo.value)

    async def test_an_anonymous_http_caller_can_still_canonicalize_a_ref(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A read the gate must not touch — and one that needs no board, so it is the
        cheapest proof that the refusals above are the gate rather than a broken tool."""
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        async with _serving(registry) as url, Client(StreamableHttpTransport(url)) as client:
            result = await client.call_tool("artifact_canon", {"refs": ["example-org/feads:go.mod"]})
        assert result.data["refs"][0]["ref"] == "example-org/feads:go.mod"


class TestWritesAreAttributedToTheWireIdentity:
    """`created_by` must record the caller, not the server's environment.

    The bug this pins: one HTTP daemon serves many agents, and `BdCliClient` read its
    actor from the process environment — whatever `BEADS_ACTOR` the shell that ran
    `feads-run.sh start` happened to export. Observed in production as every
    authenticated agent's beads carrying one leaked session's actor, an identity the
    writing agents never held — so `agent_whoami` said `mira-example` while the
    delete-own policy compared against a stranger, and an agent could not delete the
    bead it had just created.

    Attribution therefore rides the same per-call resolution as authorization:
    `acting_actor()` first, the instance/config actor only as the unidentified-caller
    fallback (stdio, where the process environment genuinely is the caller's own).
    """

    def test_acting_actor_is_the_verified_identity(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(AGENT_TOKEN_ENV, USER_TOKEN)
        assert acting_actor(db_path=registry) == "wire-claude"

    def test_a_rejected_credential_attributes_to_nobody(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A revoked agent's writes must not fall back to the host's identity.

        Rejection already refuses the action; this asserts the attribution half
        cannot resurrect the environment fallback for a credential that failed.
        """
        monkeypatch.setenv(AGENT_TOKEN_ENV, REVOKED_TOKEN)
        assert acting_actor(db_path=registry) == ""

    def test_nobody_presented_is_nobody(self, registry: str) -> None:
        assert acting_actor(db_path=registry) == ""

    def test_the_client_prefers_the_wire_actor_over_its_own(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Clients are pooled across requests, so the instance actor is stale by design."""
        client = BdCliClient(bd_path="/bin/echo", actor="daemon-env-actor")
        monkeypatch.setattr(bd_client_module, "acting_actor", lambda: "wire-claude")
        flags = client._global_flags()
        assert flags[flags.index("--actor") + 1] == "wire-claude"

    def test_the_client_falls_back_to_its_own_actor_for_nobody(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client = BdCliClient(bd_path="/bin/echo", actor="stdio-operator")
        monkeypatch.setattr(bd_client_module, "acting_actor", lambda: "")
        flags = client._global_flags()
        assert flags[flags.index("--actor") + 1] == "stdio-operator"

    async def test_artifact_writes_stamp_the_wire_actor_into_the_spawn_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """artifacts spawns bd itself, so it must stamp BEADS_ACTOR per call."""
        captured: dict[str, Any] = {}

        class FakeProcess:
            returncode = 0

            async def communicate(self) -> tuple[bytes, bytes]:
                return b"[]", b""

        async def fake_exec(*cmd: str, **kwargs: Any) -> FakeProcess:
            captured["env"] = kwargs["env"]
            return FakeProcess()

        monkeypatch.setattr(artifacts_module, "acting_actor", lambda: "wire-claude")
        monkeypatch.setenv("BEADS_ACTOR", "daemon-env-actor")
        monkeypatch.setattr(artifacts_module.asyncio, "create_subprocess_exec", fake_exec)

        await artifacts_module._run_bd(["list"], "/tmp/some-board/.beads")

        assert captured["env"]["BEADS_ACTOR"] == "wire-claude"
        assert captured["env"]["BEADS_DIR"] == "/tmp/some-board/.beads"

    async def test_over_real_http_the_bearer_token_becomes_the_artifact_actor(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """End to end: the token on the request reaches the metadata bd is handed.

        `_run_bd` is stubbed (no bd binary in this suite), so the assertion is on the
        attach patch artifact_add builds — whose `actor` comes from the same per-call
        resolution the spawn env uses. The request context surviving into that
        resolution is the two-library invariant this file exists to re-prove.
        """
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        monkeypatch.setenv("BEADS_ACTOR", "daemon-env-actor")
        calls: list[list[str]] = []

        async def stub_run_bd(args: list[str], board_dir: str = "") -> str:
            calls.append(list(args))
            if args and args[0] == "list":
                return "[]"
            return "ok\n"

        monkeypatch.setattr(artifacts_module, "_run_bd", stub_run_bd)

        async with _serving(registry) as url:
            headers = {"Authorization": f"Bearer {USER_TOKEN}"}
            async with Client(StreamableHttpTransport(url, headers=headers)) as client:
                await client.call_tool(
                    "artifact_add",
                    {"issue_id": "ex-1", "refs": ["example-org/feads:go.mod"]},
                )

        update = next(argv for argv in calls if argv and argv[0] == "update")
        patch = json.loads(update[update.index("--metadata") + 1])
        assert patch["artifact:example-org/feads:go.mod"]["actor"] == "wire-claude"
