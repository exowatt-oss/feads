"""Space RBAC — the Python mirror of ``boards/access.mjs``.

``beads_mcp.authz`` answers "may this *tier* do this"; this module answers "may this
*principal* touch this *space*". Every MCP tool composes the two once accounts mode is
on. Pure: no SQL, no clock, no environment. ``boards/access-cases.json`` pins this
module and the JavaScript one to the same answers (``tests/test_access_parity.py``),
because a disagreement here is a cross-space leak.

Deny by default: unknown actions, unknown principal kinds, a missing space or a
malformed principal all answer ``allowed=False``.

Design: the excluded hosted-provider design
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, NamedTuple

PRINCIPAL_KINDS = ("user", "service", "legacy_agent", "system", "operator", "anonymous")
BROWSER_VIA = "sso"
ACCESS_ACTIONS = (
    "space_read",
    "item_write",
    "item_delete",
    "dep_link",
    "board_create",
    "board_manage",
    "space_create",
    "space_delete",
    "space_manage",
    "accounts_admin",
    "self_settings",
    "connection_mint",
    "connection_manage",
    "system_key_mint",
    "system_key_manage",
    "service_manage",
    "directory_read",
)


class AccessDecision(NamedTuple):
    allowed: bool
    reason: str


def _memberships(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    out: dict[str, str] = {}
    for space, role in value.items():
        if isinstance(space, str) and space:
            out[space] = "admin" if role == "admin" else "member"
    return out


def _strings(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [v for v in value if isinstance(v, str) and v]


def _kind(p: Any) -> str:
    kind = str(p.get("kind") or "") if isinstance(p, Mapping) else ""
    return kind if kind in PRINCIPAL_KINDS else "anonymous"


def _true(p: Mapping[str, Any], key: str) -> bool:
    return p.get(key) is True


def is_browser(p: Any) -> bool:
    return _kind(p) == "user" and str(p.get("via") or "") == BROWSER_VIA


def accessible_spaces(p: Any) -> set[str] | None:
    """The spaces a principal may read; ``None`` means every space."""
    kind = _kind(p)
    if kind == "operator":
        return None
    if kind == "anonymous":
        return set()
    assert isinstance(p, Mapping)
    if kind == "legacy_agent":
        default = str(p.get("default_space") or "")
        return {default} if default else set()
    if kind == "service":
        # Its own member spaces, nothing else: a service is never a superadmin and
        # never "all", whatever flags a malformed principal carries.
        return set(_memberships(p.get("memberships")))
    if kind == "system":
        if not _true(p, "minter_live"):
            return set()
        key = set(_strings(p.get("key_spaces")))
        if _true(p, "minter_superadmin") and _true(p, "minter_agents_all_spaces"):
            return key
        minter = _memberships(p.get("minter_memberships"))
        return {s for s in key if s in minter}
    if _true(p, "is_superadmin") and (is_browser(p) or _true(p, "agents_all_spaces")):
        return None
    return set(_memberships(p.get("memberships")))


def can_read_space(p: Any, space: Any) -> bool:
    if not isinstance(space, str) or not space:
        return False
    spaces = accessible_spaces(p)
    return True if spaces is None else space in spaces


def is_read_only(p: Any) -> bool:
    kind = _kind(p)
    if kind == "service":
        # Deny by default: a service writes only when its principal says, literally,
        # that it is not read-only.
        return not (isinstance(p, Mapping) and p.get("read_only") is False)
    return kind in ("system", "anonymous")


def _space_admin(p: Mapping[str, Any], space: str | None) -> bool:
    return space is not None and _memberships(p.get("memberships")).get(space) == "admin"


def decide_access(principal: Any, action: str, resource: Mapping[str, Any] | None = None) -> AccessDecision:
    """Decide one action — see ``decideAccess`` in boards/access.mjs for the contract."""
    p: Mapping[str, Any] = principal if isinstance(principal, Mapping) else {"kind": "anonymous"}
    kind = _kind(p)
    r: Mapping[str, Any] = resource if isinstance(resource, Mapping) else {}
    space = r.get("space") if isinstance(r.get("space"), str) else ""

    if action not in ACCESS_ACTIONS:
        return AccessDecision(False, f'unknown action "{action}"')
    if kind == "anonymous":
        return AccessDecision(False, "sign in with an external SSO provider or present a valid token")
    if kind == "operator":
        return AccessDecision(True, "local operator")

    superadmin = kind == "user" and _true(p, "is_superadmin")
    browser = is_browser(p)

    if action == "space_read":
        return (
            AccessDecision(True, "space member")
            if can_read_space(p, space)
            else AccessDecision(False, "no access to this space")
        )

    if action in ("item_write", "board_manage", "board_create"):
        if is_read_only(p):
            return AccessDecision(False, "this credential is read-only")
        return (
            AccessDecision(True, "space member")
            if can_read_space(p, space)
            else AccessDecision(False, "no access to this space")
        )

    if action == "dep_link":
        if is_read_only(p):
            return AccessDecision(False, "this credential is read-only")
        other = r.get("other_space") if isinstance(r.get("other_space"), str) else ""
        if not can_read_space(p, space) or not can_read_space(p, other):
            return AccessDecision(False, "no access to this space")
        return (
            AccessDecision(True, "same space")
            if space == other
            else AccessDecision(False, "dependencies cannot cross spaces")
        )

    if action == "item_delete":
        if is_read_only(p):
            return AccessDecision(False, "this credential is read-only")
        if not can_read_space(p, space):
            return AccessDecision(False, "no access to this space")
        creator = str(r.get("created_by") or "").lower()
        aliases = [a.lower() for a in _strings(p.get("aliases"))]
        if creator and creator in aliases:
            return AccessDecision(True, "own item")
        # Deleting someone else's item is a superadmin power of the dashboard session
        # only: an agent holding a superadmin's token deletes like any member.
        if superadmin and browser:
            return AccessDecision(True, "superadmin")
        if kind == "user" and _space_admin(p, space):
            return AccessDecision(True, "space admin")
        if kind == "legacy_agent" and str(p.get("legacy_role") or "") == "admin":
            return AccessDecision(True, "legacy admin tier")
        return AccessDecision(False, "only the creator, a space admin or a superadmin may delete")

    if action in ("space_create", "space_delete", "accounts_admin"):
        return (
            AccessDecision(True, "superadmin")
            if superadmin and browser
            else AccessDecision(False, "superadmins only, from the dashboard")
        )

    if action == "space_manage":
        if not browser:
            return AccessDecision(False, "manage spaces from the dashboard")
        if superadmin or _space_admin(p, space):
            return AccessDecision(True, "superadmin" if superadmin else "space admin")
        return AccessDecision(False, "only a space admin or superadmin may manage this space")

    owner = str(r.get("owner_user_id") or "")
    me = str(p.get("user_id") or "")

    if action == "self_settings":
        if superadmin and browser and owner == me:
            return AccessDecision(True, "own settings")
        return AccessDecision(False, "superadmins change only their own settings, from the dashboard")

    if action == "connection_mint":
        if kind == "user" and browser:
            return AccessDecision(True, "signed-in user")
        return AccessDecision(False, "connection tokens are minted from a signed-in dashboard session")

    if action == "connection_manage":
        if kind == "user" and browser and owner == me:
            return AccessDecision(True, "own connection")
        return AccessDecision(False, "only the owner may manage a connection")

    if action == "system_key_mint":
        if not (kind == "user" and browser):
            return AccessDecision(False, "system keys are minted from a signed-in dashboard session")
        wanted = _strings(r.get("spaces"))
        if not wanted:
            return AccessDecision(False, "choose at least one space")
        agent_view = accessible_spaces({**dict(p), "via": "personal_token"})
        if all(agent_view is None or s in agent_view for s in wanted):
            return AccessDecision(True, "within your spaces")
        return AccessDecision(False, "a key may only cover spaces your agents can access")

    if action == "service_manage":
        # Superadmin anywhere; a space admin only when every space the service has
        # (and every space asked for) is one they administer. From the dashboard.
        if not browser:
            return AccessDecision(False, "manage service accounts from the dashboard")
        if superadmin:
            return AccessDecision(True, "superadmin")
        spaces = _strings(r.get("spaces"))
        if not spaces:
            return AccessDecision(False, "only a superadmin may manage a service account with no spaces")
        if all(_space_admin(p, s) for s in spaces):
            return AccessDecision(True, "space admin of every space involved")
        return AccessDecision(
            False, "only a superadmin or an admin of every space involved may manage this service account"
        )

    if action == "system_key_manage":
        if not (kind == "user" and browser):
            return AccessDecision(False, "manage keys from the dashboard")
        if superadmin or owner == me:
            return AccessDecision(True, "superadmin" if superadmin else "own key")
        return AccessDecision(False, "only the minter or a superadmin may manage this key")

    if action == "directory_read":
        return AccessDecision(True, "identified caller")

    return AccessDecision(False, "denied")


def readable_board_ids(p: Any, boards: Iterable[Mapping[str, Any]]) -> list[str]:
    spaces = accessible_spaces(p)
    return [str(b.get("id")) for b in boards if spaces is None or str(b.get("space_id") or "") in spaces]
