"""Two tiers, one policy — the Python half.

This is the **second of two implementations** of the feads authorization policy.
The first is ``boards/authz.mjs`` (Node: the ``feads-agent`` CLI and the UI
server); this one binds the MCP server. Read that module first — it carries the
tier table and the rationale for every rule, and it is the primary document.

Neither implementation owns the behaviour. **``boards/authz-cases.json`` is the
contract**, and both suites are merely readers of it: ``boards/authz.test.mjs``
on the Node side, ``tests/test_authz_parity.py`` here. Adding a case to that file
is how the policy changes. Changing one implementation without changing the
fixture leaves the other suite green, which is exactly the drift the fixture
exists to catch.

Two implementations of a permission check is how surfaces come to disagree, and a
disagreement here is a security bug rather than a routing quirk. So why two? The
MCP is Python and cannot call into Node per tool call, and the routing code
already pays a [parity cost](https://github.com/exowatt-oss/feads#configuration) for the
same reason. The fixture is the mitigation, not an excuse: keep this file a
transliteration of ``boards/authz.mjs``, not a reinterpretation of it. If a rule
seems worth improving, change the .mjs and the fixture, then follow here.

## What this can and cannot enforce

Restated from ``boards/authz.mjs`` because it must not drift out of any surface's
understanding: these checks bind the surfaces that route through feads. They do
**not** bind a shell that runs ``bd delete`` directly — ``bd`` is a local Go
binary reading a local Dolt database, with no auth layer to hook. So today this
is an *integrity* control against an agent doing something destructive by mistake
or by misreading its remit, not a *security boundary* against a hostile local
process. Do not describe it as sandboxing an untrusted agent, because it is not.

That gap closes when the registry moves behind HTTP (see
``the excluded hosted-provider design``), because then the service,
not the caller, holds the database.
"""

import os
from collections.abc import Mapping
from typing import Any, Literal, TypedDict

# The only two tiers. There is no third, and no per-action grants.
ROLES: tuple[str, ...] = ("user", "admin")

# What an *unidentified* caller is treated as. Not a tier — tiers belong to
# registered agents — but the stance a surface takes toward someone who presented
# nothing at all.
#
#   operator  — unrestricted. Correct for the CLI, which is the local trust root:
#               whoever can run it can already edit the SQLite file it writes, and
#               it is the only path that can mint the first *admin* invite. Minting
#               one needs an admin, which needs a redeemed admin invite, so a CLI
#               without operator mode would make the model unbootstrappable. (Open
#               sign-up does not rescue that: it only ever yields a `user`.)
#   read_only — may read every board, may change nothing. Correct for the browser,
#               where presenting a credential is a real affordance (a login box)
#               and "view the board, log in to act" is the honest offer.
#   deny      — refuse outright. What a hosted deployment sets, where the service
#               holds the database and the caller does not.
#
# The stance is per surface on purpose. One global answer would force either a CLI
# that cannot bootstrap or a browser that hands full delete rights to anyone who
# opens the page. Which stance *this* surface takes is decided in
# beads_mcp.agents, not here — see MCP_UNIDENTIFIED_STANCE.
UNIDENTIFIED_STANCES: tuple[str, ...] = ("operator", "read_only", "deny")

# What a surface assumes when it says nothing: the pre-existing CLI behaviour.
# Annotated for the same reason as DEFAULT_ROLE below.
DEFAULT_UNIDENTIFIED_STANCE: Literal["operator"] = "operator"

# What a caller may attempt. `mint_invite` is the odd one out: it is open to every
# tier and to an anonymous caller, and only the *admin* tier is gated — see can().
ACTIONS: tuple[str, ...] = (
    "read",
    "write",
    "delete",
    "mint_invite",
    "manage_agents",
    "manage_silos",
    "view_roster",
    "delegate_agent",
)

# Annotated, not merely assigned: normalize_role() returns this on every
# unrecognized input, and an inferred `str` would let a later edit widen the
# fail-closed default without the type checker noticing.
DEFAULT_ROLE: Literal["user"] = "user"

# Read from the environment so a deployment can tighten every surface at once
# without a code change.
REQUIRE_AGENT_ENV = "FEADS_REQUIRE_AGENT"

# A registry row, or anything shaped like one. Deliberately loose (rather than a
# TypedDict of the agents table) because callers hand this whatever they have: a
# sqlite3.Row converted to a dict, a fixture literal from authz-cases.json, or a
# partial identity carrying only actor and role. The .mjs twin is equally loose,
# and the policy only ever reads four keys: id, actor, role, revoked_at.
AgentLike = Mapping[str, Any]

RoleName = Literal["user", "admin"]
StanceName = Literal["operator", "read_only", "deny"]
# "rejected" is not a third trust level; it is a failed authentication, and it is
# spelled out as a mode because "denied" and "denied for this specific reason" are
# different things to an agent deciding what to do next.
#
# "anonymous" covers *every* outcome for a caller who presented nothing — allowed
# under `read_only`, refused under `deny`. Note that the refusal reports
# `anonymous` and not `operator`: a refused caller was never granted operator
# standing, and saying so would misdescribe why it was denied.
Mode = Literal["agent", "operator", "anonymous", "rejected"]
ScopeName = Literal["all", "self", "none"]


class Decision(TypedDict):
    """Whether an action is permitted, and why.

    ``reason`` is always populated, including on allow, so a caller can log why
    something was permitted as readily as why it was not.
    """

    allowed: bool
    reason: str


class ModeDecision(Decision):
    """A :class:`Decision` that also reports which trust mode produced it."""

    mode: Mode


class _RosterScopeBase(TypedDict):
    scope: ScopeName


class RosterScope(_RosterScopeBase, total=False):
    """How much of the agent roster a caller may see.

    ``agent_id`` is present only for ``scope == "self"``. Split across two
    classes because a single ``total=False`` TypedDict would also make ``scope``
    optional, and every code path sets it.
    """

    agent_id: str


class Forbidden(RuntimeError):
    """An action was refused. Raised by :func:`require`.

    Mirrors the error ``require_()`` throws in ``boards/authz.mjs``, including
    its ``code = 'forbidden'`` marker, so a caller can branch on the code rather
    than on message text.
    """

    def __init__(self, reason: str, action: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.action = action
        self.code = "forbidden"


def _text(value: Any) -> str:
    """Mirror JavaScript's ``String(value || '')``.

    Falsy input — ``None``, ``0``, ``""`` — becomes the empty string rather than
    the literal ``"None"``. Python's ``str(None)`` would produce ``"None"``,
    which as an actor name would silently compare unequal to everything instead
    of reading as absent.

    The one place this *diverges* from the .mjs, and deliberately: a row with no
    ``actor`` or no ``id`` at all interpolates as the literal ``undefined`` in
    JavaScript (``can`` uses ``agent.actor`` raw), and as ``""`` here. Every
    decision still matches — only the refusal *text* differs, for a row shape no
    surface can produce, since ``actor`` and ``id`` are NOT NULL in the registry
    and :func:`beads_mcp.agents._to_agent` coerces both. Reproducing a JavaScript
    ``undefined`` in a Python message would be porting a wart, not a rule.
    """
    return "" if not value else str(value)


def _revoked(agent: AgentLike) -> bool:
    """Whether a row carries a revocation timestamp.

    Mirrors ``agent.revoked_at && Number(agent.revoked_at) > 0``. The
    ``try``/``except`` is what stands in for ``Number('nonsense') === NaN``:
    ``NaN > 0`` is false in JS, while ``int('nonsense')`` raises here, so an
    unparseable value has to be coerced back to "not revoked" for the two
    implementations to agree. ``float`` rather than ``int`` because epoch
    milliseconds arriving through JSON may carry a ``.0``.
    """
    raw = agent.get("revoked_at")
    if not raw:
        return False
    try:
        return float(raw) > 0
    except (TypeError, ValueError):
        return False


def normalize_role(value: Any = None) -> RoleName:
    """Coerce anything into a valid role, defaulting to the least privileged.

    Unknown input falls back to ``user`` rather than raising: a row written by a
    newer version with a role this build does not know must not fail open to
    admin.
    """
    role = _text(value).strip().lower()
    return "admin" if role == "admin" else DEFAULT_ROLE


def is_role(value: Any = None) -> bool:
    """Whether a string names a role exactly.

    Used to reject typos at a CLI boundary, where silently downgrading
    ``--role admni`` to ``user`` would be worse than an error.
    """
    return _text(value).strip().lower() in ROLES


def is_admin(agent: AgentLike | None) -> bool:
    """Whether a row is a live-tier admin. False for ``None`` and for junk."""
    return agent is not None and normalize_role(agent.get("role")) == "admin"


def _wants_admin_invite(resource: Mapping[str, Any] | None) -> bool:
    """Whether a ``mint_invite`` request is asking for the admin tier.

    Tested on the raw string rather than through :func:`normalize_role`, which maps
    anything unrecognized to ``user``. That fallback is right for reading a stored
    row and wrong here: a request for ``"Admin "`` or ``"ADMIN"`` must be recognized
    as an escalation attempt and checked, not quietly downgraded into an open
    sign-up. Mirrors ``wantsAdminInvite`` in ``boards/authz.mjs``, which is likewise
    private — the distinction is a detail of this one action, not policy vocabulary.
    """
    return _text((resource or {}).get("role")).strip().lower() == "admin"


def can(agent: AgentLike | None, action: str, resource: Mapping[str, Any] | None = None) -> Decision:
    """Decide whether an agent may perform an action.

    Args:
        agent: The registered agent, or None for an unidentified caller.
        action: One of :data:`ACTIONS`. Typed ``str`` rather than a ``Literal``
            on purpose — the fail-closed default branch has to stay reachable,
            and it is: tool arguments arrive as JSON, so an unknown action is
            entirely representable at runtime. A ``Literal`` would make the case
            unrepresentable to a type checker while the fixture asserts it.
        resource: For ``delete``, ``created_by`` is the item's creator — bd
            populates it from the creating agent's ``BEADS_ACTOR``, which is
            exactly the actor name the registry mints.

    Returns:
        A :class:`Decision`. Never raises; use :func:`require` for that.
    """
    if agent is None:
        return Decision(
            allowed=False,
            reason="no registered agent identity — run the feads register skill first",
        )
    if _revoked(agent):
        return Decision(allowed=False, reason=f"agent {_text(agent.get('actor'))} is revoked")

    resource = resource or {}
    role = normalize_role(agent.get("role"))
    admin = role == "admin"
    actor = _text(agent.get("actor"))

    if action == "read":
        # Unscoped by design — see the module header of boards/authz.mjs.
        return Decision(allowed=True, reason=f"{role} may read every board")

    if action == "write":
        return Decision(allowed=True, reason=f"{role} may create and update items")

    if action == "delete":
        if admin:
            return Decision(allowed=True, reason="admin may delete any item")
        item = _text(resource.get("id")) or "item"
        creator = _text(resource.get("created_by"))
        if not creator:
            # Refusing an unattributed item is the safe default: treating "no
            # creator recorded" as "yours" would let a user delete every item
            # that predates creator attribution.
            return Decision(
                allowed=False,
                reason=(
                    f"{item} has no recorded creator, so a user cannot "
                    "establish ownership — an admin must delete it"
                ),
            )
        if creator == actor:
            this_item = _text(resource.get("id")) or "this item"
            return Decision(allowed=True, reason=f"user created {this_item}")
        return Decision(
            allowed=False,
            reason=(f"{item} was created by {creator}, not {actor} — a user may only delete its own items"),
        )

    if action == "mint_invite":
        # Open to every tier, because sign-up is open: this is not a secret system,
        # and the point of an identity is that claims stop lying about who holds
        # them, not that access is rationed. The admin tier is the one exception —
        # self-service admin would let anyone step past the delete rules in one move,
        # and "a user may only delete its own items" would mean nothing at all.
        if _wants_admin_invite(resource):
            if admin:
                return Decision(allowed=True, reason="admin may mint an admin invite")
            return Decision(
                allowed=False,
                reason=(
                    f"{actor} is a user — only an admin may mint an admin invite "
                    "(minting a user invite is open to anyone)"
                ),
            )
        return Decision(allowed=True, reason=f"{role} may mint a user invite — sign-up is open")

    if action == "delegate_agent":
        return Decision(allowed=True, reason=f"{role} may delegate a user-tier child agent")

    if action == "manage_agents":
        if admin:
            # Minting is no longer part of this action — it is `mint_invite`, and
            # only its admin-tier case needs an admin.
            return Decision(allowed=True, reason="admin may revoke agents and change tiers")
        return Decision(
            allowed=False,
            reason=f"{actor} is a user — only an admin may manage agents",
        )

    if action == "manage_silos":
        if admin:
            return Decision(allowed=True, reason="admin may manage silos")
        return Decision(
            allowed=False,
            reason=f"{actor} is a user — only an admin may manage silos",
        )

    if action == "view_roster":
        # A user is not blocked outright: it may see itself. Callers narrow the
        # result with roster_scope_for(), so "allowed" here means "may call it at
        # all".
        return Decision(
            allowed=True,
            reason="admin sees every agent" if admin else "user sees itself",
        )

    return Decision(allowed=False, reason=f"unknown action: {action}")


def decide(
    agent: AgentLike | None,
    action: str,
    resource: Mapping[str, Any] | None = None,
    *,
    unidentified: Any = None,
    require_identity: bool = False,
    credential_rejected: bool = False,
) -> ModeDecision:
    """Decide, accounting for callers that present no identity at all.

    This is what surfaces actually call. It exists because "no identity" has to
    mean something coherent, and there are three coherent answers rather than
    two — which is why the caller passes a *stance* (see
    :data:`UNIDENTIFIED_STANCES`) rather than a boolean:

    - ``operator``. Whoever can reach the local MCP server or CLI already owns the
      database file. Treating them as the operator states that trust boundary
      instead of pretending to enforce one that does not exist. It is also the
      only stance that can bootstrap the first admin.
    - ``read_only``. Reads stay open and so is sign-up (``mint_invite`` for the
      ``user`` tier — requiring an identity in order to obtain one would be a closed
      loop); everything else waits for a credential. The browser's answer, where a
      login box makes presenting one a real affordance.
    - ``deny``. Refuse everything except sign-up (``mint_invite`` for the ``user``
      tier — enrollment is how a caller satisfies the requirement, and the hosted
      door already sits behind platform SSO). What a hosted deployment
      sets, where the service holds the database and "they could run ``bd`` anyway"
      stops being true — which is the point at which this becomes a real security
      boundary rather than an integrity control.

    ``require_identity`` (set from ``FEADS_REQUIRE_AGENT``) is kept as an alias for
    ``unidentified="deny"``, because that flag predates the stance and every
    surface still reads it from the environment. Absent both, the stance is
    ``operator`` — the pre-existing behaviour of every surface that passes nothing.

    ``credential_rejected`` outranks every stance, and it exists because the
    permissive stance would otherwise **invert revocation**. A ``user`` whose token
    stops verifying resolves to no agent, which locally means operator, which may
    delete anything — so revoking an agent would *promote* it. Both states produce
    a null agent at the call site, which is why the bug is invisible in review. So
    a credential that was presented and did not verify is refused, with
    ``mode == "rejected"``, whatever the stance says: neither the operator fallback
    nor the read-only one may apply to a failed authentication.

    An *identified* caller ignores the stance and both flags; its tier decides. For
    ``credential_rejected`` that is definitional — if an agent resolved, its
    credential verified, so the flag can only ever describe a failed resolution.

    Args:
        unidentified: The surface's stance. Typed ``Any`` for the same reason
            ``action`` is typed ``str``: it arrives from configuration or an
            environment, so an unrecognized value is representable at runtime, and
            the fixture asserts what happens to one.
    """
    if agent is not None:
        inner = can(agent, action, resource)
        return ModeDecision(allowed=inner["allowed"], reason=inner["reason"], mode="agent")
    # Checked before the stance, not after: rejection is the stricter answer and
    # must win under every one of them, permissive stances included.
    if credential_rejected:
        return ModeDecision(
            allowed=False,
            reason=(
                "a credential was presented and did not verify — the agent may have been "
                "revoked; register again with a fresh invite, or present no credential at all"
            ),
            mode="rejected",
        )

    stance: StanceName = "deny" if require_identity else normalize_stance(unidentified)

    if stance == "deny":
        # Sign-up stays open even here — with one carve-out for the admin tier.
        # Enrollment is how a caller *satisfies* the identity requirement (the
        # dashboard's login route carries no policy gate for the same reason),
        # and the hosted deployment sits behind the platform's hosted SSO, so
        # everyone who reaches this door is already an authenticated employee.
        # Mirrors boards/authz.mjs — keep the two in lockstep with the shared
        # fixture (boards/authz-cases.json).
        if action == "mint_invite":
            if _wants_admin_invite(resource):
                return ModeDecision(
                    allowed=False,
                    reason=(
                        "sign-up is open, but only an admin may mint an admin invite — "
                        "ask an existing admin, or mint one from the CLI"
                    ),
                    mode="anonymous",
                )
            return ModeDecision(
                allowed=True,
                reason=(
                    "sign-up is open to anyone — minting a user invite (this surface "
                    "requires an identity for everything else)"
                ),
                mode="anonymous",
            )
        # Deliberately stance-agnostic wording: a surface can be in `deny` because
        # of FEADS_REQUIRE_AGENT or because that is simply its default, and naming
        # the environment variable in the second case would send the caller to fix
        # something that is not set.
        return ModeDecision(
            allowed=False,
            reason=(
                "this surface requires an agent identity and none was presented — "
                "register with an invite token, or paste an existing agent token"
            ),
            mode="anonymous",
        )

    if stance == "read_only":
        # Reads stay open so the board is visible before you log in: hiding it would
        # gate *looking* on a ceremony while changing nothing about what a local
        # shell can do. Everything else waits for a credential.
        if action == "read":
            return ModeDecision(
                allowed=True,
                reason="no identity presented — read-only access to every board",
                mode="anonymous",
            )
        if action == "mint_invite":
            # Sign-up is the one *write* an anonymous visitor may cause, and it has to
            # be: this is how a first-time visitor gets an identity at all, and
            # requiring one in order to get one is a closed loop. Still not the admin
            # tier, which would make sign-up a self-promotion button.
            if _wants_admin_invite(resource):
                return ModeDecision(
                    allowed=False,
                    reason=(
                        "sign-up is open, but only an admin may mint an admin invite — "
                        "ask an existing admin, or mint one from the CLI"
                    ),
                    mode="anonymous",
                )
            return ModeDecision(
                allowed=True,
                reason="sign-up is open to anyone — minting a user invite",
                mode="anonymous",
            )
        return ModeDecision(
            allowed=False,
            reason=(
                "no identity presented, so this session is read-only — paste the token your "
                f"agent uses, or sign up for one, to {action} anything"
            ),
            mode="anonymous",
        )

    return ModeDecision(
        allowed=True,
        reason=(
            "operator mode: no agent identity presented, and a local caller already owns "
            f"the database (set {REQUIRE_AGENT_ENV}=1 to refuse instead)"
        ),
        mode="operator",
    )


def normalize_stance(value: Any = None) -> StanceName:
    """Coerce a stance, defaulting to the least surprising rather than the strictest.

    Note the asymmetry with :func:`normalize_role`, which fails *closed*: unknown
    input here falls back to ``operator`` because that is the *pre-existing*
    behaviour of every surface that passes no stance at all. Failing closed to
    ``deny`` would silently break the CLI on a typo, which is a worse outcome than
    the typo — and unlike an unknown role, an unknown stance grants nothing that a
    local caller did not already have. A surface that wants strictness says so
    explicitly; it must never get it by accident.
    """
    stance = _text(value).strip().lower()
    # Spelled out branch by branch rather than as a membership test so the return
    # type is a Literal without a cast: `x in (...)` does not narrow `str`.
    if stance == "read_only":
        return "read_only"
    if stance == "deny":
        return "deny"
    return DEFAULT_UNIDENTIFIED_STANCE


def stance_for(surface_default: Any, env: Mapping[str, str] | None = None) -> StanceName:
    """The stance a surface should take, given its own default and the environment.

    ``FEADS_REQUIRE_AGENT=1`` upgrades any surface to ``deny``; it can only ever
    tighten. A deployment can therefore harden every surface at once without any
    surface having to agree in advance, and no environment setting can loosen one.
    """
    if require_identity_from_env(env):
        return "deny"
    return normalize_stance(surface_default)


def require_identity_from_env(env: Mapping[str, str] | None = None) -> bool:
    """Whether unidentified callers should be refused, per ``FEADS_REQUIRE_AGENT``.

    Accepts the spellings someone would actually type. Anything else is off,
    including ``0``/``false``/``no``, so a deployment that means to tighten
    cannot do it by half.
    """
    source = os.environ if env is None else env
    raw = _text(source.get(REQUIRE_AGENT_ENV, "")).strip().lower()
    return raw in ("1", "true", "yes")


def require(agent: AgentLike | None, action: str, resource: Mapping[str, Any] | None = None) -> Decision:
    """Like :func:`can`, but raises :class:`Forbidden` on refusal.

    For call sites where the failure is exceptional rather than a branch. The
    .mjs twin is spelled ``require_`` only to dodge CommonJS's ``require``; the
    trailing underscore carries no meaning worth importing.
    """
    decision = can(agent, action, resource)
    if not decision["allowed"]:
        raise Forbidden(decision["reason"], action)
    return decision


def roster_scope(agent: AgentLike | None) -> RosterScope:
    """How much of the roster a caller's *tier* entitles it to see.

    The admin view is "every registered agent"; a user asking the same question
    gets its own row rather than an error, because knowing its own identity and
    tier is how an agent explains what it may do.

    Note the asymmetry with :func:`decide`: a ``None`` agent gets nothing here,
    because this function only knows about tiers. Whether an unidentified caller
    is a trusted operator is a separate question, and answering it here would
    bake the local trust assumption into a pure tier lookup. **Surfaces call
    :func:`roster_scope_for`, not this.**
    """
    if agent is None:
        return RosterScope(scope="none")
    # Revocation outranks tier, exactly as in can(). A revoked admin credential
    # that still returned the full roster would make revoking one cosmetic.
    if _revoked(agent):
        return RosterScope(scope="none")
    if is_admin(agent):
        return RosterScope(scope="all")
    return RosterScope(scope="self", agent_id=_text(agent.get("id")))


def roster_scope_for(
    agent: AgentLike | None,
    *,
    unidentified: Any = None,
    require_identity: bool = False,
    credential_rejected: bool = False,
) -> RosterScope:
    """The roster scope a *surface* should apply, operator mode included.

    Every surface that shows a roster must call this rather than
    :func:`roster_scope`, and this exists because getting it wrong is silent: an
    operator run through the plain tier lookup resolves to ``none`` and sees an
    **empty** roster, which reads as "no agents are registered" rather than "you
    were not recognized". That is a worse failure than an error, and it is not
    hypothetical — the CLI shipped it for exactly as long as it took to run the
    command by hand.

    Only the ``operator`` stance sees the roster. A ``read_only`` caller sees none
    of it even though it may read every board, because who else is registered is
    *administrative* data: the roster is the one read that is not simply "the
    board", so it does not ride along with read-only board access. A rejected
    credential sees nothing, not everything, for the same reason it is refused
    everywhere else.
    """
    if agent is not None:
        return roster_scope(agent)
    # Asked as a stance rather than by forwarding to decide(). The two agree today
    # — decide() refuses `view_roster` under every non-operator stance — but that
    # agreement is incidental, and a stance that ever granted `view_roster` for
    # board access would silently start leaking the roster through the delegation.
    # Stating the rule here keeps it a rule.
    stance: StanceName = "deny" if require_identity else normalize_stance(unidentified)
    if credential_rejected or stance != "operator":
        return RosterScope(scope="none")
    return RosterScope(scope="all")
