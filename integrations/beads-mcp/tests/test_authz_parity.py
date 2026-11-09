"""Authorization conformance for the Python policy implementation.

The cases live in ``boards/authz-cases.json``, not here, because the same table
is asserted by the Node implementation in ``boards/authz.test.mjs``. Two
implementations of a permission check is how surfaces come to disagree, and a
disagreement is a security bug rather than a routing quirk — so the fixture is
the contract and both suites are merely readers of it.

This file mirrors ``boards/authz.test.mjs`` group for group. If you add a case
group there, add it here; the ``test_every_...`` guards at the bottom fail until
you do, which is the point.
"""

import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from beads_mcp.agents import (
    AGENT_TOKEN_ENV,
    AGENT_TOKEN_PREFIX,
    SESSION_ID_ENV,
    authorize,
    hash_token,
    resolve_agent_identity,
)
from beads_mcp.authz import (
    ACTIONS,
    DEFAULT_ROLE,
    DEFAULT_UNIDENTIFIED_STANCE,
    REQUIRE_AGENT_ENV,
    ROLES,
    UNIDENTIFIED_STANCES,
    Forbidden,
    can,
    decide,
    is_admin,
    is_role,
    normalize_role,
    normalize_stance,
    require,
    require_identity_from_env,
    roster_scope,
    roster_scope_for,
    stance_for,
)
from tests.agent_registry_fixture import build_registry

FIXTURE_ENV = "FEADS_AUTHZ_CASES"


def _find_fixture() -> Path:
    """Locate ``boards/authz-cases.json``.

    Resolved relative to this file rather than to the cwd: pytest can be invoked
    from the repo root (``make mcp-test``) or from ``integrations/beads-mcp``,
    and a cwd-relative path would find the fixture in one case and not the other.

    A missing fixture is a hard error rather than a skip. This suite's only claim
    is "the two implementations agree", and a skipped conformance suite reports
    that claim as verified when nothing checked it — worse than having no test.
    ``FEADS_AUTHZ_CASES`` is the escape hatch for a checkout where the Node half
    genuinely is not present.
    """
    override = os.environ.get(FIXTURE_ENV, "")
    if override:
        path = Path(override).expanduser().resolve()
        if not path.is_file():
            raise RuntimeError(f"{FIXTURE_ENV}={override} does not point at a readable file")
        return path

    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "boards" / "authz-cases.json"
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        "cannot find boards/authz-cases.json above "
        f"{here} — the authorization conformance contract is unreadable, so this "
        f"suite cannot verify anything. Set {FIXTURE_ENV} to its path if the Node "
        "half is not checked out here."
    )


FIXTURE_PATH = _find_fixture()
FIXTURE: dict[str, Any] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

CAN_CASES: list[dict[str, Any]] = FIXTURE["cases"]
DECIDE_CASES: list[dict[str, Any]] = FIXTURE["decide_cases"]
ROSTER_SCOPE_CASES: list[dict[str, Any]] = FIXTURE["roster_scope_cases"]
ROSTER_SCOPE_FOR_CASES: list[dict[str, Any]] = FIXTURE["roster_scope_for_cases"]
RESOLUTION_CASES: list[dict[str, Any]] = FIXTURE["resolution_cases"]

# Every case-bearing key this file asserts. The fixture's other top-level keys are
# "$comment"-prefixed prose; anything else is a group nobody is reading.
ASSERTED_GROUPS = {
    "cases": CAN_CASES,
    "decide_cases": DECIDE_CASES,
    "roster_scope_cases": ROSTER_SCOPE_CASES,
    "roster_scope_for_cases": ROSTER_SCOPE_FOR_CASES,
    "resolution_cases": RESOLUTION_CASES,
}

# Filled in as the parametrized tests run, then checked at the bottom of the file.
# A parametrized case that is silently never executed — a bad merge, an `if` that
# skips it, a group added to the fixture and forgotten here — is precisely the
# failure this suite must not have.
_ASSERTED: dict[str, list[str]] = {name: [] for name in ASSERTED_GROUPS}


def _ids(cases: list[dict[str, Any]]) -> list[str]:
    return [str(case["name"]) for case in cases]


def _agent(case: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """The case's agent. ``null`` in the fixture means an unidentified caller."""
    agent = case.get("agent")
    return None if agent is None else dict(agent)


@pytest.mark.parametrize("case", CAN_CASES, ids=_ids(CAN_CASES))
def test_can_case(case: dict[str, Any]) -> None:
    decision = can(_agent(case), case["action"], case.get("resource") or {})
    assert decision["allowed"] == case["allowed"], (
        f"{case['name']}: expected allowed={case['allowed']}, got {decision['allowed']} ({decision['reason']})"
    )
    # Every decision explains itself, including allows — a surface logs the reason.
    assert decision["reason"], f"{case['name']}: decision must carry a reason"
    _ASSERTED["cases"].append(str(case["name"]))


@pytest.mark.parametrize("case", DECIDE_CASES, ids=_ids(DECIDE_CASES))
def test_decide_case(case: dict[str, Any]) -> None:
    # `unidentified` and `require_identity` are both optional, and both are passed
    # through raw rather than defaulted here: a case that omits the stance is
    # asserting what a surface that passes nothing gets, and one that spells a stance
    # the implementation does not know is asserting the fallback. Substituting a
    # default in the reader would test this file instead of the policy.
    decision = decide(
        _agent(case),
        case["action"],
        case.get("resource") or {},
        unidentified=case.get("unidentified"),
        require_identity=bool(case.get("require_identity")),
        credential_rejected=bool(case.get("credential_rejected")),
    )
    assert decision["allowed"] == case["allowed"], f"{case['name']}: {decision['reason']}"
    assert decision["mode"] == case["mode"], f"{case['name']}: mode"
    assert decision["reason"], f"{case['name']}: decision must carry a reason"
    _ASSERTED["decide_cases"].append(str(case["name"]))


@pytest.mark.parametrize("case", ROSTER_SCOPE_CASES, ids=_ids(ROSTER_SCOPE_CASES))
def test_roster_scope_case(case: dict[str, Any]) -> None:
    scope = roster_scope(_agent(case))
    assert scope["scope"] == case["scope"], case["name"]
    if case.get("agent_id"):
        assert scope.get("agent_id") == case["agent_id"], case["name"]
    _ASSERTED["roster_scope_cases"].append(str(case["name"]))


@pytest.mark.parametrize("case", ROSTER_SCOPE_FOR_CASES, ids=_ids(ROSTER_SCOPE_FOR_CASES))
def test_roster_scope_for_case(case: dict[str, Any]) -> None:
    scope = roster_scope_for(
        _agent(case),
        unidentified=case.get("unidentified"),
        require_identity=bool(case.get("require_identity")),
        credential_rejected=bool(case.get("credential_rejected")),
    )
    assert scope["scope"] == case["scope"], case["name"]
    if case.get("agent_id"):
        assert scope.get("agent_id") == case["agent_id"], case["name"]
    _ASSERTED["roster_scope_for_cases"].append(str(case["name"]))


# =============================================================================
# resolution_cases: who is calling, before any policy question is asked
# =============================================================================
# Unlike the groups above, these need a real registry: resolution is a pair of
# SQL lookups, and the whole point of the group is which lookup runs when. One
# database serves all eight rows — the case's `token` and `session` keys select
# which credential goes into the environment, not which rows exist.

VALID_TOKEN = f"{AGENT_TOKEN_PREFIX}00000000000000000000000000000001"
# Right prefix, no matching row: `verify_agent_token` short-circuits on a wrong
# prefix, so an invalid token has to look real to exercise the lookup.
INVALID_TOKEN = f"{AGENT_TOKEN_PREFIX}ffffffffffffffffffffffffffffffff"
REVOKED_AGENT_TOKEN = f"{AGENT_TOKEN_PREFIX}00000000000000000000000000000002"

LIVE_SESSION = "sess-live"
REVOKED_SESSION = "sess-revoked"
UNMATCHED_SESSION = "sess-nobody-ever-registered"


@pytest.fixture
def resolution_registry(tmp_path: Path) -> str:
    """One live agent and one revoked agent, each with a token and a session."""
    return build_registry(
        tmp_path / "resolution.db",
        [
            {
                "id": "ag_live",
                "actor": "laptop-claude",
                "role": "user",
                "token_hash": hash_token(VALID_TOKEN),
                "session_id": LIVE_SESSION,
            },
            {
                "id": "ag_revoked",
                "actor": "old-agent",
                "role": "admin",
                "token_hash": hash_token(REVOKED_AGENT_TOKEN),
                "session_id": REVOKED_SESSION,
                "revoked_at": 1753718400000,
            },
        ],
    )


def _env_for(case: Mapping[str, Any]) -> dict[str, str]:
    """Translate a case's ``token``/``session`` keys into an environment."""
    env: dict[str, str] = {}
    token = case["token"]
    if token == "valid":
        env[AGENT_TOKEN_ENV] = VALID_TOKEN
    elif token == "invalid":
        env[AGENT_TOKEN_ENV] = INVALID_TOKEN
    elif token != "absent":
        raise AssertionError(f"unknown token state in fixture: {token!r}")

    session = case["session"]
    if session == "live":
        env[SESSION_ID_ENV] = LIVE_SESSION
    elif session == "revoked":
        env[SESSION_ID_ENV] = REVOKED_SESSION
    elif session == "no_match":
        env[SESSION_ID_ENV] = UNMATCHED_SESSION
    elif session != "absent":
        raise AssertionError(f"unknown session state in fixture: {session!r}")
    return env


@pytest.mark.parametrize("case", RESOLUTION_CASES, ids=_ids(RESOLUTION_CASES))
def test_resolution_case(case: dict[str, Any], resolution_registry: str) -> None:
    resolved = resolve_agent_identity(_env_for(case), db_path=resolution_registry)
    assert resolved["via"] == case["via"], f"{case['name']}: via"
    assert (resolved["agent"] is not None) == case["resolves_agent"], f"{case['name']}: resolves_agent"
    assert resolved["credential_rejected"] == case["credential_rejected"], f"{case['name']}: credential_rejected"
    _ASSERTED["resolution_cases"].append(str(case["name"]))


def test_resolution_feeds_the_policy_it_is_paired_with(resolution_registry: str) -> None:
    """The two halves have to meet, or the fixture pins nothing that matters.

    ``resolution_cases`` says a revoked session is a rejection; ``decide_cases``
    says a rejection is denied. Neither group asserts the join, so a surface could
    satisfy both and still drop the flag on the way between them — which is
    precisely the shape of the bug this all exists to prevent.
    """
    revoked_session_env = {SESSION_ID_ENV: REVOKED_SESSION}
    resolved = resolve_agent_identity(revoked_session_env, db_path=resolution_registry)
    assert resolved["credential_rejected"] is True

    decision = authorize(
        "delete", {"id": "ex-1", "created_by": "someone"}, revoked_session_env, resolution_registry
    )
    assert not decision["allowed"]
    assert decision["mode"] == "rejected"

    # And the inverse, so this cannot pass by denying everything: an unmatched
    # session is not a rejection, and locally it is the operator.
    anonymous = authorize(
        "delete",
        {"id": "ex-1", "created_by": "someone"},
        {SESSION_ID_ENV: UNMATCHED_SESSION},
        resolution_registry,
    )
    assert anonymous["allowed"]
    assert anonymous["mode"] == "operator"


def test_revocation_cannot_promote_a_rejected_credential_to_the_operator() -> None:
    """Mirrors the same standalone test in ``boards/authz.test.mjs``.

    Stated on its own because it is the one inversion in this model that would be
    invisible in review: a rejected credential and no credential at all both
    produce a null agent at the call site, so nothing about the shape of the call
    reveals that one of them must be denied while the other is the operator.
    Without it, revoking a ``user`` would *promote* it to deleting anything.
    """
    resource = {"id": "ex-1", "created_by": "someone"}
    rejected = decide(None, "delete", resource, credential_rejected=True)
    absent = decide(None, "delete", resource)

    assert not rejected["allowed"], "a rejected credential must be denied"
    assert absent["allowed"], "no credential at all is the operator, locally"
    assert rejected["mode"] == "rejected"
    assert absent["mode"] == "operator"

    # Rejection outranks the flag in both settings, so a permissive deployment
    # cannot be talked into accepting a credential that failed to verify.
    for flag in (True, False):
        assert not decide(None, "read", require_identity=flag, credential_rejected=True)["allowed"]
        assert roster_scope_for(None, require_identity=flag, credential_rejected=True)["scope"] == "none"


def test_fixture_actually_has_cases() -> None:
    """A silently-empty fixture must not read as a passing suite.

    Same floors as ``boards/authz.test.mjs`` so a JSON edit that drops an array —
    or a bad merge — fails on both sides rather than on neither.
    """
    assert len(CAN_CASES) >= 29, f"only {len(CAN_CASES)} can() cases"
    assert len(DECIDE_CASES) >= 23
    assert len(ROSTER_SCOPE_CASES) >= 4
    assert len(ROSTER_SCOPE_FOR_CASES) >= 8
    assert len(RESOLUTION_CASES) >= 8


def test_every_case_group_in_the_fixture_is_asserted_here() -> None:
    """No group may exist in the fixture without a reader in this file.

    The fixture is the contract, so a group added on the Node side and not
    mirrored here would leave the Python implementation unverified against part
    of the policy while this suite stayed green.
    """
    in_fixture = {key for key, value in FIXTURE.items() if isinstance(value, list) and key.endswith("cases")}
    assert in_fixture == set(ASSERTED_GROUPS), (
        f"{FIXTURE_PATH} has case groups this suite does not assert: "
        f"{sorted(in_fixture - set(ASSERTED_GROUPS))}; or asserts groups the fixture "
        f"no longer has: {sorted(set(ASSERTED_GROUPS) - in_fixture)}"
    )


def test_every_case_was_actually_run() -> None:
    """The count asserted must equal the count in the file, per group.

    Trap: this depends on running after the parametrized tests above, which
    pytest does by default (collection follows definition order, and no
    shuffling plugin is in the dev dependencies). If you ran a subset with
    ``-k`` that matched this test but not the cases, a failure here is expected
    and means nothing.
    """
    for name, cases in ASSERTED_GROUPS.items():
        expected = [str(case["name"]) for case in cases]
        assert _ASSERTED[name] == expected, (
            f"{name}: asserted {len(_ASSERTED[name])} of {len(expected)} cases in "
            f"{FIXTURE_PATH}; missing {sorted(set(expected) - set(_ASSERTED[name]))}"
        )


# =============================================================================
# The Node suite's non-fixture assertions, mirrored
# =============================================================================
# boards/authz.test.mjs asserts these beyond the shared table. Keeping them
# symmetric matters as much as the fixture does: they cover the coercion edges
# (casing, padding, junk input) that a fixture of realistic rows does not reach,
# and those edges are where two hand-written implementations actually diverge.


def test_there_are_exactly_two_tiers() -> None:
    assert list(ROLES) == ["user", "admin"]
    assert DEFAULT_ROLE == "user"


def test_normalize_role_fails_closed_on_anything_unrecognized() -> None:
    for value in ["superuser", "root", "ADMINISTRATOR", "", None, "usr", 0, []]:
        assert normalize_role(value) == "user", f"{value!r} must not be admin"


def test_normalize_role_accepts_admin_in_any_casing_or_padding() -> None:
    for value in ["admin", "ADMIN", " Admin ", "aDmIn"]:
        assert normalize_role(value) == "admin"


def test_is_role_rejects_typos_rather_than_downgrading_them() -> None:
    assert is_role("admin")
    assert is_role("user")
    assert not is_role("admni")
    assert not is_role("superuser")
    assert not is_role("")
    assert not is_role(None)


def test_is_admin_is_false_for_absent_and_malformed_input() -> None:
    assert not is_admin(None)
    assert not is_admin({})
    assert is_admin({"role": "admin"})


def test_ownership_is_compared_against_the_actor_name_bd_records() -> None:
    user = {"actor": "laptop-claude", "role": "user"}
    assert can(user, "delete", {"id": "ex-1", "created_by": "laptop-claude"})["allowed"]
    # Case-sensitive on purpose: bd records created_by verbatim from BEADS_ACTOR,
    # so a case-insensitive compare here would claim ownership bd cannot confirm.
    assert not can(user, "delete", {"id": "ex-1", "created_by": "laptop-Claude"})["allowed"]


def test_a_missing_resource_is_refused_for_a_user() -> None:
    # No resource at all is the same evidentiary position as no creator:
    # ownership cannot be established, so it must not be assumed.
    assert not can({"actor": "laptop-claude", "role": "user"}, "delete")["allowed"]


def test_the_refusal_names_both_actors_so_the_agent_can_explain_itself() -> None:
    decision = can(
        {"actor": "laptop-claude", "role": "user"},
        "delete",
        {"id": "ex-9", "created_by": "someone-else"},
    )
    assert "someone-else" in decision["reason"]
    assert "laptop-claude" in decision["reason"]
    assert "ex-9" in decision["reason"]


def test_an_admin_invite_request_is_recognized_through_any_casing_or_padding() -> None:
    """The escalation check reads the raw requested role, not a normalized one.

    ``normalize_role`` maps anything unrecognized to ``user``, so routing this check
    through it would turn ``" ADMIN "`` into an *open sign-up* — the escalation would
    be granted by the same fail-closed helper that exists to prevent one. The fixture
    pins ``" ADMIN "``; these are the coercion edges around it, where two
    hand-written implementations actually diverge.
    """
    user = {"actor": "laptop-claude", "role": "user"}
    for requested in ["admin", "ADMIN", " Admin ", "aDmIn"]:
        assert not can(user, "mint_invite", {"role": requested})["allowed"], requested
    # Anything that is not the admin tier is an open sign-up — including absent and
    # junk, which the registry would store as `user` anyway.
    for requested in ["user", "", None, "superuser", 0, []]:
        assert can(user, "mint_invite", {"role": requested})["allowed"], requested
    assert can(user, "mint_invite")["allowed"]


def test_every_advertised_action_has_a_policy() -> None:
    for action in ACTIONS:
        decision = can({"actor": "x", "role": "admin"}, action, {"created_by": "x"})
        assert "unknown action" not in decision["reason"], f"{action} has no policy"


def test_unknown_actions_fail_closed_even_for_an_admin() -> None:
    decision = can({"actor": "x", "role": "admin"}, "drop_database")
    assert not decision["allowed"]
    assert "unknown action" in decision["reason"]


def test_require_raises_forbidden_carrying_the_action() -> None:
    with pytest.raises(Forbidden) as excinfo:
        require({"actor": "laptop-claude", "role": "user"}, "manage_agents")
    assert excinfo.value.action == "manage_agents"
    assert excinfo.value.code == "forbidden"
    assert "only an admin" in excinfo.value.reason
    # An allowed action returns rather than raising.
    assert require({"actor": "x", "role": "admin"}, "manage_agents")["allowed"]


def test_there_are_exactly_three_stances_and_the_default_preserves_prior_behaviour() -> None:
    assert list(UNIDENTIFIED_STANCES) == ["operator", "read_only", "deny"]
    assert DEFAULT_UNIDENTIFIED_STANCE == "operator"


def test_normalize_stance_falls_back_to_operator_rather_than_deny() -> None:
    """The one place this policy deliberately fails *open*, and it is tested for it.

    Failing closed on an unrecognized stance would break the CLI on a typo — and a
    CLI that cannot act cannot mint the first invite, so the model would become
    unbootstrappable by misspelling a config value. Note the contrast with
    ``normalize_role``, which fails closed: an unknown *role* could grant something,
    while an unknown *stance* only ever leaves a local caller where it already was.
    """
    for value in ["", None, "readonly", "read only", "strict", "DENY!", 0, []]:
        assert normalize_stance(value) == "operator", f"{value!r} must not tighten silently"
    assert normalize_stance("read_only") == "read_only"
    assert normalize_stance("READ_ONLY") == "read_only"
    assert normalize_stance(" Deny ") == "deny"


def test_stance_for_lets_the_environment_tighten_a_surface_but_never_loosen_it() -> None:
    assert stance_for("read_only", {}) == "read_only"
    assert stance_for("operator", {}) == "operator"
    # FEADS_REQUIRE_AGENT can only ratchet toward deny.
    assert stance_for("operator", {REQUIRE_AGENT_ENV: "1"}) == "deny"
    assert stance_for("read_only", {REQUIRE_AGENT_ENV: "1"}) == "deny"
    # And no setting of it can talk a strict surface out of being strict.
    assert stance_for("deny", {REQUIRE_AGENT_ENV: "0"}) == "deny"


def test_the_browser_stance_reads_the_board_and_changes_nothing_but_signs_up() -> None:
    assert decide(None, "read", unidentified="read_only")["allowed"]
    assert not decide(None, "write", unidentified="read_only")["allowed"]
    assert not decide(None, "delete", {"id": "x", "created_by": ""}, unidentified="read_only")["allowed"]
    assert not decide(None, "manage_agents", unidentified="read_only")["allowed"]
    # The roster does not ride along with read-only board access.
    assert roster_scope_for(None, unidentified="read_only")["scope"] == "none"
    # Sign-up is the exception, and the exception's exception is the admin tier.
    assert decide(None, "mint_invite", {"role": "user"}, unidentified="read_only")["allowed"]
    assert not decide(None, "mint_invite", {"role": "admin"}, unidentified="read_only")["allowed"]


def test_every_read_only_outcome_reports_the_anonymous_mode() -> None:
    """Allowed or refused, a caller that presented nothing is `anonymous`.

    Not `operator`, which it was never granted, and not `rejected`, which would say
    a credential failed to verify when none was offered.
    """
    for action in ACTIONS:
        assert decide(None, action, unidentified="read_only")["mode"] == "anonymous", action
    assert decide(None, "read", unidentified="deny")["mode"] == "anonymous"


def test_the_cli_stance_can_still_bootstrap_the_first_admin() -> None:
    """If this fails, the model is unbootstrappable.

    Minting an *admin* invite needs an admin, which needs a redeemed admin invite —
    so the first one has to come from a caller with no identity at all. Open sign-up
    does not rescue this: sign-up only ever yields a ``user``.
    """
    assert decide(None, "manage_agents")["allowed"]
    assert decide(None, "manage_agents", unidentified="operator")["allowed"]
    assert decide(None, "mint_invite", {"role": "admin"}, unidentified="operator")["allowed"]


def test_a_stance_never_overrides_a_real_tier() -> None:
    user = {"actor": "laptop-claude", "role": "user"}
    for stance in UNIDENTIFIED_STANCES:
        decision = decide(user, "delete", {"id": "ex-1", "created_by": "laptop-claude"}, unidentified=stance)
        assert decision["allowed"], f"stance {stance} must not affect an identified user"
        assert decision["mode"] == "agent"


def test_require_identity_stays_an_alias_for_the_deny_stance() -> None:
    """The flag predates the stance and every surface still reads it from the
    environment, so it must keep tightening a stance it disagrees with rather than
    losing to it."""
    for stance in UNIDENTIFIED_STANCES:
        decision = decide(None, "read", unidentified=stance, require_identity=True)
        assert not decision["allowed"], stance
        assert decision["mode"] == "anonymous", stance
        assert roster_scope_for(None, unidentified=stance, require_identity=True)["scope"] == "none", stance


def test_require_identity_from_env_reads_the_spellings_a_person_would_type() -> None:
    for raw in ["1", "true", "TRUE", "yes"]:
        assert require_identity_from_env({REQUIRE_AGENT_ENV: raw}), raw


def test_require_identity_from_env_treats_anything_else_as_off() -> None:
    for raw in ["0", "false", "no", ""]:
        assert not require_identity_from_env({REQUIRE_AGENT_ENV: raw}), raw
    assert not require_identity_from_env({})
