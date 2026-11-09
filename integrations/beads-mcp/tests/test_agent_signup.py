"""``agent_signup``: the one tool that causes a registry write, by proxy.

The HTTP layer is stubbed, never live. A suite that needed ``make run`` would be a
suite nobody runs, and the interesting behaviour is not "express answers a POST" — it
is the translation from *this* endpoint's documented error taxonomy into something an
agent can act on. So the stub returns the exact bodies ``ui/server/agent-session.js``
returns (``{ok: false, error: {code, message}}``, and its one success shape), and the
statuses it pairs them with.

Two properties get more attention than the rest, because both are silent when broken:

- **the policy is asked before the socket is touched.** A deployment that refuses
  sign-up must not have signup attempts in its dashboard's log, and the refusal must
  be correct with the dashboard stopped.
- **no token reaches a log.** It is returned exactly once, so a leak into a log file
  outlives the only copy the agent has.
"""

import email.message
import inspect
import io
import json
import logging
import tempfile
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request

import pytest
from fastmcp.client import Client

from beads_mcp import signup
from beads_mcp import transport as wire
from beads_mcp.agents import AGENT_TOKEN_ENV, AGENT_TOKEN_PREFIX, SESSION_ID_ENV, hash_token
from beads_mcp.authz import REQUIRE_AGENT_ENV
from beads_mcp.boards import REGISTRY_DB_ENV
from beads_mcp.server import mcp
from beads_mcp.signup import (
    SIGNUP_PATH,
    agent_delegate_payload,
    agent_signup_payload,
    flare_drop_payload,
    flare_heartbeat_payload,
)
from tests.agent_registry_fixture import build_registry

USER_TOKEN = f"{AGENT_TOKEN_PREFIX}6666666666666666666666666666666f"
REVOKED_TOKEN = f"{AGENT_TOKEN_PREFIX}77777777777777777777777777777770"
# What the dashboard hands back. Distinct from USER_TOKEN so a test cannot pass by
# echoing a token that was already in the environment.
MINTED_TOKEN = f"{AGENT_TOKEN_PREFIX}88888888888888888888888888888881"

DASHBOARD = "http://127.0.0.1:4141"
SIGNUP_URL = f"{DASHBOARD}{SIGNUP_PATH}"

# A directory with no `.beads` anywhere above it, so board resolution answers "I cannot
# tell" deterministically. Created once at import rather than per test because it holds
# nothing and is only ever an anchor for an upward walk. A system temp directory is the
# reliable choice: `tmp_path` would do, but the property that matters is having no
# ancestor `.beads`, which is true of the temp root and false of anywhere in a checkout.
NO_BOARD = tempfile.mkdtemp(prefix="feads-no-board-")

SUCCESS_BODY: dict[str, Any] = {
    "ok": True,
    "created": True,
    "token": MINTED_TOKEN,
    "identity": {
        "agent_id": "ag_new",
        "actor": "laptop-claude-2",
        "display_name": "laptop claude 2",
        "role": "user",
        "board_id": "lab",
        "last_seen_at": 0,
    },
    "mode": "agent",
    "mcp_url": "http://127.0.0.1:4143/mcp",
    "mcp_reason": "configured",
}


class FakeResponse:
    """A 2xx response, shaped like what ``urlopen`` yields."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self._body = io.BytesIO(body.encode("utf-8"))

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def http_error(status: int, body: str) -> HTTPError:
    """A 4xx/5xx, as ``urlopen`` raises it.

    Built as a real :class:`urllib.error.HTTPError` with a readable body rather than a
    stand-in, because the code under test relies on the fact that an ``HTTPError`` *is*
    a response — reading the body off the exception is what recovers the dashboard's own
    error code, and a mock that merely carried a status would let that break silently.
    """
    return HTTPError(SIGNUP_URL, status, "", email.message.Message(), io.BytesIO(body.encode("utf-8")))


def failure_body(code: str, message: str) -> str:
    """The dashboard's error envelope, verbatim from ``fail()`` in agent-session.js."""
    return json.dumps({"ok": False, "error": {"code": code, "message": message}})


class Dashboard:
    """A stand-in for the signup endpoint that records what it was asked.

    Recording matters as much as answering: the tool must send the right body to the
    right URL, and must not send one at all when the policy has already refused.
    """

    def __init__(self, *outcomes: object) -> None:
        self.outcomes = list(outcomes)
        self.requests: list[Request] = []

    def __call__(self, request: Request, timeout: float | None = None) -> object:
        self.requests.append(request)
        outcome = self.outcomes.pop(0) if len(self.outcomes) > 1 else self.outcomes[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    @property
    def called(self) -> bool:
        return bool(self.requests)

    def body(self, index: int = 0) -> dict[str, Any]:
        data = self.requests[index].data
        assert isinstance(data, bytes)
        parsed = json.loads(data.decode("utf-8"))
        assert isinstance(parsed, dict)
        return parsed


@pytest.fixture(autouse=True)
def stdio_transport(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Pin the transport and strip ambient identity.

    The transport flag is process-wide module state, so a test that flips it and does
    not restore it turns every later refusal assertion into a false pass. Pinned to
    stdio here because it is the default; the HTTP cases set it explicitly.
    """
    for name in (AGENT_TOKEN_ENV, SESSION_ID_ENV, REQUIRE_AGENT_ENV, REGISTRY_DB_ENV, wire.DASHBOARD_URL_ENV):
        monkeypatch.delenv(name, raising=False)
    previous = wire.serving_http()
    wire.set_http_transport(False)
    yield
    wire.set_http_transport(previous)


@pytest.fixture
def registry(tmp_path: Path) -> str:
    """A registry holding one live user and one revoked agent."""
    return build_registry(
        tmp_path / "registry.db",
        [
            {
                "id": "ag_user",
                "actor": "laptop-claude",
                "role": "user",
                "token_hash": hash_token(USER_TOKEN),
            },
            {
                "id": "ag_dead",
                "actor": "old-agent",
                "role": "admin",
                "token_hash": hash_token(REVOKED_TOKEN),
                "revoked_at": 500,
                "revoke_reason": "rotated",
            },
        ],
    )


def sign_up(
    dashboard: Dashboard,
    monkeypatch: pytest.MonkeyPatch,
    registry: str,
    display_name: str = "laptop claude 2",
    actor: str = "",
    env: dict[str, str] | None = None,
    workspace: str = "",
) -> dict[str, Any]:
    """Call the payload builder with the HTTP layer stubbed.

    ``workspace`` defaults to :data:`NO_BOARD` rather than to nothing, and that is test
    isolation rather than tidiness: the board directory is resolved by walking *up* from
    the working directory, and pytest runs inside the feads checkout — so an unset
    workspace would make every one of these tests post the maintainer's own
    `.beads` path, and the assertions would then pass or fail depending on whose machine
    they ran on.
    """
    monkeypatch.setattr(signup, "urlopen", dashboard)
    resolved_env = dict(env or {})
    resolved_env.setdefault("BEADS_WORKING_DIR", workspace or NO_BOARD)
    return agent_signup_payload(display_name, actor, resolved_env, registry)


class TestFlareAndDelegateProxies:
    def test_flare_heartbeat_and_drop_use_dashboard_http(self, monkeypatch: pytest.MonkeyPatch) -> None:
        dashboard = Dashboard(
            FakeResponse(200, json.dumps({"ok": True, "flare": {"id": "fl_1"}})),
            FakeResponse(200, json.dumps({"ok": True, "dropped": True})),
        )
        monkeypatch.setattr(signup, "urlopen", dashboard)
        env = {AGENT_TOKEN_ENV: USER_TOKEN}
        assert flare_heartbeat_payload("bd-1", "board-a", env)["ok"] is True
        assert flare_drop_payload("bd-1", "board-a", env)["dropped"] is True
        assert [r.get_method() for r in dashboard.requests] == ["PUT", "DELETE"]
        assert dashboard.body(0) == {"board_id": "board-a", "issue_id": "bd-1"}

    def test_delegate_posts_bearer_to_dashboard(self, monkeypatch: pytest.MonkeyPatch, registry: str) -> None:
        dashboard = Dashboard(FakeResponse(200, json.dumps({"ok": True, "created": True})))
        monkeypatch.setattr(signup, "urlopen", dashboard)
        result = agent_delegate_payload(
            "child",
            "Child",
            60_000,
            {AGENT_TOKEN_ENV: USER_TOKEN, wire.DASHBOARD_URL_ENV: DASHBOARD},
            registry,
        )
        assert result["created"] is True
        assert dashboard.requests[0].get_method() == "POST"
        assert dashboard.requests[0].get_header("Authorization") == f"Bearer {USER_TOKEN}"
        assert dashboard.body() == {"handle": "child", "display_name": "Child", "ttl_ms": 60_000}


class TestAnonymousSignupSucceeds:
    def test_it_returns_the_token_and_the_recorded_identity(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(dashboard, monkeypatch, registry)

        assert payload["created"] is True
        assert payload["token"] == MINTED_TOKEN
        # The *recorded* actor, not the requested display name: the dashboard slugifies
        # it, and `created_by` on every item this agent files will hold the slug — which
        # is what a delete decision compares against.
        assert payload["actor"] == "laptop-claude-2"
        assert payload["identity"]["agent_id"] == "ag_new"
        assert payload["board_id"] == "lab"
        assert payload["role"] == "user"
        assert "code" not in payload

    def test_it_says_the_token_is_shown_once(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        """Both as a flag and in the prose, because only one of the two gets read."""
        payload = sign_up(Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY))), monkeypatch, registry)
        assert payload["token_shown_once"] is True
        assert "exactly once" in payload["next_steps"]

    def test_it_posts_the_name_to_the_dashboard_signup_route(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        sign_up(dashboard, monkeypatch, registry)
        assert dashboard.requests[0].full_url == SIGNUP_URL
        assert dashboard.requests[0].get_method() == "POST"
        assert dashboard.body() == {"display_name": "laptop claude 2", "surface": "mcp"}

    def test_an_explicit_actor_is_forwarded_and_a_blank_one_is_not(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A blank slug is omitted rather than sent, so the dashboard's own default
        (derive one from the display name) stays in one place."""
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        sign_up(dashboard, monkeypatch, registry, actor="  chosen-slug  ")
        assert dashboard.body()["actor"] == "chosen-slug"

        blank = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        sign_up(blank, monkeypatch, registry, actor="   ")
        assert "actor" not in blank.body()

    def test_it_talks_to_the_dashboard_the_environment_names(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(
            dashboard,
            monkeypatch,
            registry,
            env={wire.DASHBOARD_URL_ENV: "http://feads.internal:9000/"},
        )
        assert dashboard.requests[0].full_url == f"http://feads.internal:9000{SIGNUP_PATH}"
        assert payload["dashboard_url"] == "http://feads.internal:9000"

    def test_stdio_says_the_token_cannot_be_used_until_a_restart(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The anti-loop sentence. A stdio server read the token slot once at startup,
        so an agent told "you are authenticated now" would find it is not, and sign up
        again — colliding on the name it just took."""
        payload = sign_up(Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY))), monkeypatch, registry)
        steps = payload["next_steps"]
        assert AGENT_TOKEN_ENV in steps
        assert "restart" in steps
        assert "do **not** call agent_signup again" in steps

    def test_http_says_the_next_call_is_already_authenticated(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        wire.set_http_transport(True)
        payload = sign_up(Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY))), monkeypatch, registry)
        steps = payload["next_steps"]
        assert "Authorization: Bearer" in steps
        assert "nothing needs restarting" in steps
        assert "restart the server" not in steps


class TestProvenanceAndBoard:
    """What the roster ends up saying about where this identity came from.

    Both fields exist so the row is honest about it: without `surface` an MCP sign-up was
    recorded as a person in a browser, and without `board_dir` the agent was attached to
    whichever board the daemon happened to start on.
    """

    def test_it_declares_the_surface_it_came_from(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(dashboard, monkeypatch, registry)
        assert dashboard.body()["surface"] == "mcp"
        assert payload["surface"] == "mcp"

    def test_it_never_sends_kind_or_created_by(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        """The endpoint maps `surface` onto those columns rather than accepting them, and
        this side must not undo that. Free-text provenance is spoofable: a caller that
        could send `created_by` could attribute an identity to an actor that never
        created it, which is exactly the lie the registry exists to stop."""
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        sign_up(dashboard, monkeypatch, registry)
        body = dashboard.body()
        assert "kind" not in body
        assert "created_by" not in body

    def test_the_surface_is_a_literal_and_not_a_parameter(self) -> None:
        """So the endpoint's 400 for an unrecognised surface is unreachable from here —
        which is why there is no hint for it."""
        assert signup.SURFACE == "mcp"
        assert "surface" not in inspect.signature(agent_signup_payload).parameters

    def test_it_names_the_board_this_process_is_working_on(
        self, tmp_path: Path, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Without this the sign-up appears to succeed while the agent is nowhere its
        owner would look: the roster is board-scoped."""
        project = tmp_path / "sample-controller"
        (project / ".beads").mkdir(parents=True)
        (project / ".beads" / "beads.db").write_bytes(b"")

        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(dashboard, monkeypatch, registry, workspace=str(project))

        assert dashboard.body()["board_dir"] == str(project / ".beads")
        assert payload["board_dir"] == str(project / ".beads")

    def test_it_omits_the_board_rather_than_guessing_one(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An unregistered directory is now a hard 409, so a guess costs the sign-up
        outright while an omission just falls back to the dashboard's own board."""
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(dashboard, monkeypatch, registry, workspace=NO_BOARD)

        assert "board_dir" not in dashboard.body()
        assert payload["board_dir"] == ""

    def test_a_board_the_registry_does_not_know_names_the_directory_it_tried(
        self, tmp_path: Path, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The residual case resolution cannot rule out — a board registered under
        another spelling of the same path. A 409 that does not say which directory it
        looked for is unreadable."""
        project = tmp_path / "unregistered"
        (project / ".beads").mkdir(parents=True)
        (project / ".beads" / "beads.db").write_bytes(b"")

        dashboard = Dashboard(http_error(409, failure_body("board_unregistered", "not in the registry")))
        payload = sign_up(dashboard, monkeypatch, registry, workspace=str(project))

        assert payload["code"] == "board_unregistered"
        assert payload["board_dir"] == str(project / ".beads")
        assert "`board_dir`" in payload["hint"]


class TestAnOlderEndpointIsNotAFailure:
    """`surface` and `board_dir` may not be deployed when this code runs.

    An endpoint that predates them ignores the fields — express drops body keys it does
    not read — so the only observable difference is a row labelled `human` on the
    dashboard's own board. That is a **successful sign-up**: the token is valid and
    usable, and refusing an identity that works because its provenance label is stale
    would be the worse bug. Asserted rather than assumed, because "we do not read that
    field" is exactly the kind of claim a later refactor breaks quietly.
    """

    def test_a_human_kind_row_on_another_board_still_succeeds(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        old_endpoint = {
            **SUCCESS_BODY,
            # What an endpoint without `surface` records, and what one without
            # `board_dir` attaches the agent to.
            "kind": "human",
            "identity": {**SUCCESS_BODY["identity"], "board_id": "seed-board"},
        }
        payload = sign_up(Dashboard(FakeResponse(200, json.dumps(old_endpoint))), monkeypatch, registry)

        assert payload["created"] is True
        assert payload["token"] == MINTED_TOKEN
        assert "code" not in payload
        # Reported as it came back rather than as we asked, so the difference is visible
        # instead of being assumed away.
        assert payload["board_id"] == "seed-board"

    def test_no_version_probe_is_made(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        """One request, not a capability check first: a probe would double the round
        trips and still not tell us whether the fields were honoured."""
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        sign_up(dashboard, monkeypatch, registry)
        assert len(dashboard.requests) == 1


class TestFailuresAreTranslatedNotSwallowed:
    """Every documented failure of the endpoint, as its own code and its own next move.

    Parametrized against the statuses and codes in ``ui/server/agent-session.js`` rather
    than against invented ones. Two of these share a status (409) and need different
    actions, which is why the dashboard's `code` is carried through instead of being
    re-derived from the status.
    """

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            (400, "bad_request"),
            (403, "forbidden"),
            (409, "board_unregistered"),
            (409, "name_taken"),
            (503, "no_registry"),
            (500, "registry_failed"),
            (401, "token_rejected"),
        ],
    )
    def test_each_failure_keeps_its_own_code_reason_and_hint(
        self, registry: str, monkeypatch: pytest.MonkeyPatch, status: int, code: str
    ) -> None:
        dashboard = Dashboard(http_error(status, failure_body(code, f"the {code} message")))
        payload = sign_up(dashboard, monkeypatch, registry)

        assert payload["created"] is False
        assert payload["code"] == code
        assert payload["status"] == status
        # Relayed verbatim: the dashboard's wording is the accurate account of what
        # happened, and rewriting it here would be a second error taxonomy to keep in
        # step with the first.
        assert payload["reason"] == f"the {code} message"
        # And a next move, which the dashboard cannot supply because its message is
        # written for a person looking at a form.
        assert payload["hint"]

    def test_a_name_collision_says_to_pick_another_name(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The one failure the agent can fix on its own, so the hint has to say so."""
        dashboard = Dashboard(http_error(409, failure_body("name_taken", "that name is already taken")))
        payload = sign_up(dashboard, monkeypatch, registry)
        assert "different display_name" in payload["hint"]

    def test_a_board_that_is_not_registered_is_not_the_agents_fault(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(http_error(409, failure_body("board_unregistered", "not in the registry")))
        payload = sign_up(dashboard, monkeypatch, registry)
        assert "feads-board register" in payload["hint"]
        assert "Nothing about your request was wrong" in payload["hint"]

    def test_registry_failed_warns_against_a_blind_retry(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A row may exist holding the name, with a token nobody was shown. Retrying
        the same name would then fail as `name_taken` forever."""
        dashboard = Dashboard(http_error(500, failure_body("registry_failed", "no token came back")))
        payload = sign_up(dashboard, monkeypatch, registry)
        assert "revoke it" in payload["hint"]

    def test_an_unknown_future_code_is_reported_rather_than_folded_into_a_known_one(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(http_error(418, failure_body("brand_new_code", "something novel")))
        payload = sign_up(dashboard, monkeypatch, registry)
        assert payload["code"] == "brand_new_code"
        assert payload["reason"] == "something novel"

    def test_a_status_with_no_envelope_still_reports_the_status(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(http_error(502, json.dumps({"ok": False})))
        payload = sign_up(dashboard, monkeypatch, registry)
        assert payload["code"] == "http_502"
        assert "502" in payload["reason"]

    def test_a_success_with_no_token_is_a_registry_failure(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Only a hash is stored, so a token nobody was shown is unusable."""
        body = {**SUCCESS_BODY}
        del body["token"]
        payload = sign_up(Dashboard(FakeResponse(200, json.dumps(body))), monkeypatch, registry)
        assert payload["code"] == "registry_failed"
        assert "no token" in payload["reason"]

    def test_something_that_is_not_the_dashboard_says_so(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The likely cause is FEADS_DASHBOARD_URL pointing at the wrong port, which is
        a different fix from every refusal above."""
        payload = sign_up(Dashboard(FakeResponse(200, "<html>Vite dev server</html>")), monkeypatch, registry)
        assert payload["code"] == "unexpected_response"
        assert wire.DASHBOARD_URL_ENV in payload["hint"]
        assert "Vite" in payload["reason"]


class TestTheDashboardBeingDownIsNotARefusal:
    """A connection error must not read like a policy refusal.

    They call for opposite behaviour — retry once the dashboard is up, versus stop
    asking — and an agent that cannot tell them apart picks the wrong one every time.
    """

    @pytest.mark.parametrize(
        "error",
        [
            URLError(ConnectionRefusedError(61, "Connection refused")),
            TimeoutError("timed out"),
            ConnectionResetError(54, "Connection reset by peer"),
        ],
    )
    def test_every_flavour_of_unreachable_lands_on_one_code(
        self, registry: str, monkeypatch: pytest.MonkeyPatch, error: Exception
    ) -> None:
        payload = sign_up(Dashboard(error), monkeypatch, registry)
        assert payload["code"] == "dashboard_unreachable"

    def test_it_names_the_url_it_tried_and_how_to_start_the_dashboard(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        payload = sign_up(Dashboard(URLError("Connection refused")), monkeypatch, registry)
        assert SIGNUP_URL in payload["reason"]
        assert DASHBOARD in payload["hint"]
        assert "make run" in payload["hint"]
        # The wording an agent needs in order not to give up: this is about the
        # dashboard, not about permission.
        assert "not a refusal" in payload["hint"]
        assert "sign up in the browser" in payload["hint"]

    def test_it_does_not_use_the_vocabulary_of_a_refusal(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        payload = sign_up(Dashboard(URLError("Connection refused")), monkeypatch, registry)
        text = f"{payload['reason']} {payload['hint']}".lower()
        for word in ("forbidden", "not allowed", "not permitted", "policy"):
            assert word not in text


class TestAuthorizationHappensBeforeTheNetwork:
    def test_require_agent_no_longer_blocks_sign_up(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The deny stance keeps user-tier sign-up open (policy change, 2026-07-29).

        Closing it made FEADS_REQUIRE_AGENT unescapable for a first-time caller — an
        identity was needed to get an identity. Enrollment is how a caller *satisfies*
        the requirement, so the shared policy now permits it and the request proceeds
        to the dashboard. The class's policy-before-network principle is still held up
        by the rejected-credential and missing-name tests below, which do refuse
        without a round trip.
        """
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(dashboard, monkeypatch, registry, env={REQUIRE_AGENT_ENV: "1"})

        assert dashboard.called is True
        assert payload["created"] is True

    def test_a_rejected_credential_cannot_sign_up_a_fresh_identity(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A revoked token resolves to no agent, and "no agent" is who sign-up is for —
        so without the rejection rule, revocation could be undone by the very tool that
        hands out identities."""
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(dashboard, monkeypatch, registry, env={AGENT_TOKEN_ENV: REVOKED_TOKEN})

        assert dashboard.called is False
        assert payload["code"] == "forbidden"
        assert payload["mode"] == "rejected"
        assert "did not verify" in payload["reason"]

    def test_a_missing_name_is_refused_without_a_round_trip(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Checked locally *as well as* at the endpoint: waiting on a round trip to be
        told you gave no name is a wait for nothing, and if the dashboard happens to be
        down the same omission would be reported as `dashboard_unreachable` — sending
        the agent to fix the wrong thing."""
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(dashboard, monkeypatch, registry, display_name="   ")

        assert dashboard.called is False
        assert payload["code"] == "bad_request"
        assert "display_name" in payload["hint"]

    def test_the_endpoints_own_400_is_still_translated(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The local check does not make the remote one stop existing."""
        dashboard = Dashboard(http_error(400, failure_body("bad_request", "give the agent a name")))
        payload = sign_up(dashboard, monkeypatch, registry)
        assert dashboard.called is True
        assert payload["code"] == "bad_request"

    def test_no_admin_tier_can_be_asked_for(self) -> None:
        """Not a parameter, and not a default that could be overridden.

        The policy refuses an admin invite to a caller that is not already an admin, so
        a `role` parameter could only ever be refused — and a parameter an agent cannot
        use successfully is a lie in the tool schema.
        """
        assert signup.SIGNUP_ROLE == "user"
        assert "role" not in inspect.signature(agent_signup_payload).parameters


class TestAnAlreadyIdentifiedCallerIsToldSo:
    def test_it_does_not_mint_a_second_identity(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        """Silently minting one would cost the agent its own delete rights: `created_by`
        on everything it already filed names the *first* actor, and a user may delete
        only its own items."""
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(dashboard, monkeypatch, registry, env={AGENT_TOKEN_ENV: USER_TOKEN})

        assert dashboard.called is False
        assert payload["created"] is False
        assert payload["code"] == "already_identified"
        assert payload["mode"] == "agent"

    def test_it_reports_the_identity_the_caller_already_has(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An agent reaching this tool with a token is one that did not call
        agent_whoami, so the useful answer is its own identity plus a pointer."""
        payload = sign_up(
            Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY))),
            monkeypatch,
            registry,
            env={AGENT_TOKEN_ENV: USER_TOKEN},
        )
        assert payload["identity"]["actor"] == "laptop-claude"
        assert "laptop-claude" in payload["reason"]
        assert "agent_whoami" in payload["hint"]
        assert "feads-agent invite" in payload["hint"]

    def test_a_session_identified_caller_is_treated_the_same(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Identity by session id is still identity; a second row would be just as wrong."""
        registry = build_registry(
            tmp_path / "sessions.db",
            [
                {
                    "id": "ag_session",
                    "actor": "daemon-claude",
                    "role": "user",
                    "token_hash": hash_token(f"{AGENT_TOKEN_PREFIX}9999"),
                    "session_id": "session-abc",
                }
            ],
        )
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        payload = sign_up(dashboard, monkeypatch, registry, env={SESSION_ID_ENV: "session-abc"})
        assert dashboard.called is False
        assert payload["code"] == "already_identified"
        assert "via session" in payload["reason"]


class TestTheTokenNeverReachesALog:
    """Returned exactly once, so a copy in a log outlives the agent's own copy.

    Each of these asserts the log is *not* empty as well, because "the token is not in
    the log" passes trivially against a module that logs nothing, and this module logs
    on every path so that a signup is traceable at all.
    """

    def test_a_successful_signup_logs_the_actor_and_not_the_token(
        self, registry: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.DEBUG, logger="beads_mcp.signup"):
            payload = sign_up(Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY))), monkeypatch, registry)

        assert payload["token"] == MINTED_TOKEN
        assert "laptop-claude-2" in caplog.text
        assert MINTED_TOKEN not in caplog.text
        assert AGENT_TOKEN_PREFIX not in caplog.text

    def test_a_token_in_an_unparseable_body_is_scrubbed_from_the_response_and_the_log(
        self, registry: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The one path that relays bytes nobody predicted — so the one that could carry
        a credential into a message."""
        with caplog.at_level(logging.DEBUG, logger="beads_mcp.signup"):
            payload = sign_up(
                Dashboard(FakeResponse(200, f"not json, but here is a token: {MINTED_TOKEN}")),
                monkeypatch,
                registry,
            )

        assert payload["code"] == "unexpected_response"
        assert MINTED_TOKEN not in payload["reason"]
        assert "«token»" in payload["reason"]
        assert MINTED_TOKEN not in caplog.text

    def test_a_refusal_is_logged_by_code_and_carries_no_credential(
        self, registry: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        dashboard = Dashboard(http_error(409, failure_body("name_taken", "taken")))
        with caplog.at_level(logging.DEBUG, logger="beads_mcp.signup"):
            sign_up(dashboard, monkeypatch, registry)
        assert "name_taken" in caplog.text
        assert AGENT_TOKEN_PREFIX not in caplog.text


class TestOverMcp:
    async def test_the_tool_is_registered_and_catalogued(self) -> None:
        async with Client(mcp) as client:
            names = {tool.name for tool in await client.list_tools()}
            catalog = await client.call_tool("discover_tools", {})
            info = await client.call_tool("get_tool_info", {"tool_name": "agent_signup"})
        assert "agent_signup" in names
        assert "agent_signup" in catalog.data["tools"]
        assert "display_name" in info.data["parameters"]

    async def test_the_schema_offers_no_role_parameter(self) -> None:
        """An agent reads a parameter as a capability. There is no tier to choose."""
        async with Client(mcp) as client:
            tool = next(t for t in await client.list_tools() if t.name == "agent_signup")
        assert set(tool.inputSchema["properties"]) == {"display_name", "actor"}
        assert tool.inputSchema.get("required") == ["display_name"]

    async def test_it_answers_through_the_client(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        """Through a real MCP call, because the payload builder runs in a worker thread
        (`asyncio.to_thread`) and a refusal that lost the request context would be a
        different answer than the one asserted above."""
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        monkeypatch.setattr(signup, "urlopen", Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY))))
        async with Client(mcp) as client:
            result = await client.call_tool("agent_signup", {"display_name": "laptop claude 2"})
        assert result.data["created"] is True
        assert result.data["token"] == MINTED_TOKEN

    async def test_a_refusal_arrives_as_data_rather_than_an_exception(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Deliberately unlike the write and delete gates, which raise ToolError.

        "You may not", "that name is taken" and "the dashboard is not running" are all
        expected answers to the question this tool asks, and they need different next
        moves — which an agent can only branch on if they arrive as fields.
        """
        # Driven by a rejected credential — the case that still refuses locally now
        # that the deny stance keeps sign-up open (a revoked token must not be able
        # to mint itself a fresh identity).
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        monkeypatch.setenv(AGENT_TOKEN_ENV, REVOKED_TOKEN)
        dashboard = Dashboard(FakeResponse(200, json.dumps(SUCCESS_BODY)))
        monkeypatch.setattr(signup, "urlopen", dashboard)
        async with Client(mcp) as client:
            result = await client.call_tool("agent_signup", {"display_name": "laptop claude 2"})
        assert result.data["code"] == "forbidden"
        assert dashboard.called is False


class TestTheInstructionsNoLongerSayItCannotBeDone:
    """Rule: the guidance an agent reads must match what the tools can do.

    Before this tool existed, both the server instructions and `agent_whoami`'s hint
    told an unidentified agent it could not fix the situation itself. Leaving that in
    place would be worse than never having said anything, because an agent that reads
    "you cannot" does not try.
    """

    def test_the_server_instructions_point_at_the_tool(self) -> None:
        instructions = mcp.instructions or ""
        assert "agent_signup" in instructions
        assert "you cannot fix this" not in instructions
        # The human path survives as the fallback, because the dashboard may be down.
        assert "make run" in instructions

    def test_the_instructions_carry_the_work_item_workflow_without_a_setup_gate(self) -> None:
        """The MCP instructions are sufficient and never turn setup into pre-work.

        They must also carry the work-item calibration — epics with live children,
        not bare epics — and the id-prefix routing contract, with zero CLI residue:
        a hosted agent has no `bd`, no `.beads`, and nothing to configure locally.
        """
        instructions = mcp.instructions or ""
        assert "https://github.com/exowatt-oss/feads#quickstart" in instructions
        # Work items by default, filed at decomposition, closed as they land.
        assert "WORK ITEMS" in instructions
        assert "parent-child:<epic-id>" in instructions
        assert '"0 of 0 tasks"' in instructions
        assert "close-as-you-go" in instructions
        assert "Assign\nevery item at creation" in instructions
        # Work items finish this session; a genuinely unfinished epic has an owned handoff.
        assert "Every session-created work item reaches terminal" in instructions
        assert "An unfinished epic may stay open only with" in instructions
        assert "a current [handoff] comment" in instructions
        assert "Never set\nblocked without naming the actual wait" in instructions
        # Fail-open subordination to the user's task.
        assert "fail open, always" in instructions
        # Id-prefix routing kills the board-selection friction.
        assert "route by the id's prefix automatically" in instructions
        assert "context(board='<id>')" in instructions
        assert "server-side session state" in instructions
        # Zero CLI residue in what a hosted agent reads.
        assert ".beads" not in instructions
        assert "BEADS_WORKING_DIR" not in instructions
        assert "bd init" not in instructions
        assert "feads@example-software" not in instructions
        assert "/feads:setup-feads" not in instructions

    def test_the_instructions_carry_the_two_shipping_boundary_checks(self) -> None:
        instructions = mcp.instructions or ""
        for want in [
            "exactly two bounded, one-shot checks",
            "implementation → ship and immediately pre-tag",
            "fresh-fetch/read",
            "origin/main SHA",
            "automatic reset/rebase",
            "artifact overlap across boards",
            "issue show plus comments",
            "taking/skipping/waiting",
            "[boundary-check]",
            "failed Feads lookup is unverified",
            "fail open once and never claim success",
            "existing immutable tag is a shipping decision",
        ]:
            assert want in instructions
        for prohibition in [
            "No polling",
            "stale sweeps",
            "notification loops",
            "synthetic blockers",
            "setup gate",
        ]:
            assert prohibition in instructions

    def test_the_whoami_hint_leads_with_the_tool(self, registry: str) -> None:
        from beads_mcp.agents import agent_whoami_payload

        hint = agent_whoami_payload({}, registry)["hint"]
        assert "agent_signup" in hint
        assert "dashboard_unreachable" in hint

    def test_under_deny_the_hint_matches_the_open_signup_permission(self, registry: str) -> None:
        """`deny` refuses reads and other writes, but sign-up stays open so the caller
        can obtain the identity that the stance requires. The prose must not contradict
        the `permissions.sign_up` flag in the same whoami response."""
        from beads_mcp.agents import agent_whoami_payload

        payload = agent_whoami_payload(
            {
                REQUIRE_AGENT_ENV: "1",
                wire.DASHBOARD_URL_ENV: "http://127.0.0.1:4500",
                wire.PUBLIC_URL_ENV: "https://feads-demo.apps.example.test",
            },
            registry,
        )
        hint = payload["hint"]
        assert payload["permissions"]["sign_up"] is True
        assert "call agent_signup" in hint
        assert "sign_up` permission is true" in hint
        assert "forbidden" not in hint
        assert "https://feads-demo.apps.example.test" in hint
        assert "127.0.0.1:4500" not in hint
