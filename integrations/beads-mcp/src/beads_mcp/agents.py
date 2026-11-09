"""Which registered agent is calling, resolved read-only from the registry.

Mirrors the **read half** of ``boards/agents.mjs``, including
``resolveAgentIdentity`` — whose order is itself pinned by ``resolution_cases`` in
``boards/authz-cases.json``, because resolution turned out to be as
security-sensitive as the policy and was drifting between surfaces. Payload shapes
follow ``ui/server/identity.js`` so the dashboard and this server describe an agent
with the same keys.

Nothing here decides anything: it resolves an identity, hands it to
:mod:`beads_mcp.authz`, and reports the answer. Adding a rule here would start
exactly the two-implementations drift that ``boards/authz-cases.json`` exists to
prevent.

Why an agent identity at all: bd identifies an actor by whatever ``BEADS_ACTOR``
happens to hold, falling back to git's ``user.name`` and then ``$USER``. That
fallback is the problem — ``bd update <id> --claim`` is idempotent *for the same
actor*, so two agents sharing a fallback identity both get a ✓ on the same bead
and the collision detection the board exists for silently reports success.
Identity has to be minted, not guessed.

## This module never writes. Registration happens elsewhere.

Specifically: sign-up and sign-in are the **dashboard**'s, whose Node server calls
``signupAgent``/``registerAgent`` in ``boards/agents.mjs`` directly. A human can drive
that from the browser and hand the token to their agent; an agent can also drive it
itself through ``agent_signup``, which is a **proxy** to that same Node route and
lives in :mod:`beads_mcp.signup`. Either way the write happens over there, this module
still opens the registry ``mode=ro``, and :func:`how_to_get_a_credential` is the one
sentence that tells an agent how to obtain a credential by whichever route.

The proxy shape is not incidental — a Python *port* of registration is still refused,
and the reasons compound:

1. **The registry has few writers, and that is what makes concurrent access safe
   without a locking protocol.** The Node CLI and the dashboard's server write;
   this server opens ``mode=ro``. ``boards.py`` already states the failure
   mode being avoided — two runtimes racing to create or migrate the same schema
   corrupts the board list for everybody — and the hosted-registry proposal names
   sole-writer as the property a hosted design has to reproduce (see
   ``the excluded hosted-provider design``, "Who writes the
   catalog?"). Adding a second writer here spends that property on convenience.
2. **Registration is not one INSERT; it is a transactional single-use guard.**
   ``registerAgent`` consumes the invite with a conditional ``UPDATE`` inside
   ``BEGIN IMMEDIATE`` and relies on a *partial* unique index
   (``agents_live_actor_idx``) to reject a name taken between mint and redeem.
   Porting that means a second implementation of a security invariant — the same
   hazard as two ``can()`` implementations, except this one has no fixture that
   could catch a divergence, because the invariant is enforced by SQL and
   transaction semantics rather than by a pure function.
3. **Minting the first admin invite is a bootstrap act and cannot be
   authenticated anyway.** Minting an *admin* invite requires an admin identity,
   which requires a redeemed admin invite. The first one must therefore come from
   outside the authenticated path — the operator's shell. So the CLI has to be
   able to do this regardless, and an MCP duplicate buys nothing but a second
   writer. (Minting a *user* invite is open to anyone — sign-up is not gated —
   which changes who may ask, not which process writes the row.)
4. **The credential is the agent's file, not the server's.** ``feads-agent``
   writes ``~/.feads/agents/<agent_id>.json`` at 0600 after registering. Written
   by a long-lived MCP server process it would carry that process's identity and
   umask, not the registering agent's, and an HTTP-transport MCP would be writing
   it on the wrong machine entirely.

Two consequences worth stating plainly.

This server cannot refresh ``last_seen_at`` (``touchAgent`` is a write). The
stale-claim sweep leans on that column, so an agent working purely through the MCP
looks idle to it. The fix is ``feads-agent heartbeat`` from the shell, not a write
from here.

And a token obtained through ``agent_signup`` — like one obtained in the browser —
has **no credential file** anywhere: only ``feads-agent`` writes one, and the
dashboard's sign-up route does not. The token exists in that one response and
nowhere else, since the registry stores only its hash. That is why the tool says so
in as many words instead of leaving an agent to assume it can look it up again.
"""

import hashlib
import os
import sqlite3
from collections.abc import Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

from beads_mcp import accounts as _accounts

# Reusing the registry reader's own connection helpers rather than opening SQLite
# again here. A second mode=ro connect path is how one of them ends up without
# the mode=ro, or without the "file is missing" pre-check that turns a generic
# "unable to open database file" into a message naming the path it tried.
from beads_mcp.authz import (
    REQUIRE_AGENT_ENV,
    Mode,
    ModeDecision,
    StanceName,
    decide,
    is_role,
    require_identity_from_env,
    roster_scope_for,
)
from beads_mcp.boards import RegistryUnavailableError, _connect, _query, registry_path
from beads_mcp.silo import FEADS_SILO_ENV, configured_silo  # noqa: F401

# The wire layer decides which stance this surface takes and pulls a credential off
# an HTTP request. It is a separate module because "how did this call arrive" is a
# different question from "who is calling", and conflating them is how the stance
# came to be a constant that was wrong for one of two transports.
from beads_mcp.transport import (
    bearer_token,
    dashboard_url,
    public_dashboard_url,
    serving_http,
    surface_stance,
)

# Agent tokens, minted at registration and held by the agent. Invite tokens
# (fdsi_) are never presented to this server: redeeming one is a write.
AGENT_TOKEN_PREFIX = "fdsa_"

# Where a token arrives from. On stdio it is the process environment; over HTTP it
# is `Authorization: Bearer fdsa_…` on the request, which is the only one of the two
# that can carry a *per-caller* identity — one HTTP server serves many agents, so an
# environment variable there would name the host, not the caller. Both feed the same
# slot in `resolve_agent_identity`, so the resolution order pinned by
# `resolution_cases` covers both without a second code path.
AGENT_TOKEN_ENV = "FEADS_AGENT_TOKEN"
# Claude Code exports a stable session id for the whole session, and registration
# records it, so an agent finds itself in a later shell without a credential file
# lookup. Two concurrent sessions on one machine therefore resolve to different
# agents, which a host-wide lookup could not do.
SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID"

# Hosted silos do not share the registry file with the base MCP process. Their
# worker-email identity therefore has to cross the dashboard boundary, where the
# silo's own registry is authoritative. These names are kept here rather than
# importing server.py: server.py imports this module while constructing the MCP.

# token_hash is deliberately absent, matching AGENT_COLUMNS in boards/agents.mjs:
# keeping it out of every read path means it cannot be leaked by a caller that
# JSON-dumps whatever it was handed. Columns are listed explicitly rather than
# SELECT * for the same reason boards.py does it — a column added by a later
# Node-side migration must not silently change the shape this server promises.
_AGENT_COLUMNS = (
    "id, board_id, actor, display_name, role, invite_id, host, workspace_dir, "
    "session_id, kind, registered_at, last_seen_at, revoked_at, revoke_reason, metadata"
)

_AGENT_SELECT = f"SELECT {_AGENT_COLUMNS} FROM agents"

# Which credential won, in the vocabulary boards/authz-cases.json uses for
# `resolution_cases`. Kept identical to the fixture's spelling so the parity test
# reads a case's expectation straight across rather than translating it.
Via = Literal["token", "session", "rejected", "none", "system_key"]

# The source of an agent token or session. Hosted identity is disabled.
CredentialSource = Literal["authorization_header", "environment", "session", "none"]


class AgentRow(TypedDict):
    """One row of the ``agents`` table, as :func:`beads_mcp.authz.can` wants it.

    Server-side shape. Use :func:`to_identity` or :func:`to_roster_row` for
    anything that reaches a client.
    """

    id: str
    board_id: str
    actor: str
    display_name: str
    role: str
    invite_id: str
    host: str
    workspace_dir: str
    session_id: str
    kind: str
    registered_at: int
    last_seen_at: int
    revoked_at: int
    revoke_reason: str
    metadata: str


class AgentIdentity(TypedDict):
    """Client-safe projection of a registered agent — what ``agent_whoami`` returns."""

    agent_id: str
    # The value the agent uses as BEADS_ACTOR, which is what an item's
    # `created_by` is compared against when a delete is authorized.
    actor: str
    display_name: str
    role: str
    board_id: str
    last_seen_at: int


class RosterRow(AgentIdentity):
    """One row of the agent roster."""

    host: str
    workspace_dir: str
    session_id: str
    kind: str
    registered_at: int
    revoked_at: int
    revoke_reason: str


class AgentResolution(TypedDict):
    """The output of :func:`resolve_agent_identity`, shaped like ``resolution_cases``.

    ``credential_rejected`` means a credential was presented and refused, which is
    a different thing from ``via == "none"`` (nothing was presented). Collapsing
    the two is the bug the fixture exists to pin.
    """

    agent: AgentRow | None
    credential_rejected: bool
    via: Via


@dataclass(frozen=True)
class AuthorizationContext:
    """The identity and decision established for one tool invocation.

    A pooled bd/PG client must never retain this object: it belongs to the
    request's context, not to the board or client. Keeping the exact resolved row
    beside the actor also lets attribution consume the same answer that authorization
    used, rather than resolving the registry a second time during a role/revocation
    race.
    """

    agent: AgentRow | None
    actor: str
    action: str
    allowed: bool


# Set by ``authorize`` and cleared by the server's per-tool wrappers. ContextVars
# flow through ``asyncio.to_thread`` when a tool performs blocking I/O, while still
# isolating concurrent MCP requests from one another.
request_authorization: ContextVar[AuthorizationContext | None] = ContextVar(
    "beads_request_authorization", default=None
)


_MUTATING_AUTH_ACTIONS = frozenset(
    {"write", "delete", "mint_invite", "manage_agents", "manage_silos", "delegate_agent"}
)


def authorized_mutation_context() -> AuthorizationContext | None:
    """Return the current context only when it authorized a mutation."""
    context = request_authorization.get()
    if context is None or not context.allowed or context.action not in _MUTATING_AUTH_ACTIONS:
        return None
    return context


class _ResolvedBase(TypedDict):
    identity: AgentIdentity | None
    # The registry row, for the policy. Server-side only.
    agent: AgentRow | None
    mode: Mode
    # This surface's stance toward an unidentified caller, after the environment has
    # had its say. Carried rather than recomputed at each call site so one tool call
    # cannot resolve an identity under one stance and authorize under another.
    stance: StanceName
    require_identity: bool
    # How the identity was established, or how it failed to be — see
    # resolve_agent_identity. Named `via` to match the shared fixture rather than
    # inventing a second word for it.
    via: Via
    # *Where* the token came from, which `via` deliberately does not say: `via` is
    # shared-fixture vocabulary (token|session|rejected|none) and must not grow a
    # fifth value for a detail only this surface has. Reported because "my token does
    # not work" is the first question wire auth produces, and the answer is usually
    # that the token went into the environment of a server serving somebody else, or
    # into a header a stdio server never reads.
    credential_source: CredentialSource
    credential_rejected: bool


class ResolvedIdentity(_ResolvedBase, total=False):
    """The acting agent, or the absence of one.

    ``registry_error`` is present only when the registry could not be read at
    all. It is reported rather than raised — see :func:`resolve_identity`.
    """

    registry_error: str
    # Accounts mode only (the excluded hosted-provider design): the principal
    # beads_mcp.access judges — user / legacy_agent / system / operator / anonymous.
    principal: dict[str, Any]


def hash_token(token: str) -> str:
    """Hash a token for lookup, mirroring ``hashToken`` in boards/agents.mjs.

    Plain SHA-256 rather than a password KDF is deliberate: these are 128-bit
    random strings, not human-chosen passwords, so there is no dictionary to
    stretch against, and a KDF would put a deliberate delay on the hot path of
    every authenticated call.

    Lookup is by hash equality in SQL rather than by comparing candidates in
    Python. That sidesteps the timing-comparison question entirely: the index is
    consulted with a value derived from the presented token, and nothing about a
    128-bit random secret is recoverable from how long that takes.
    """
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def _to_agent(row: sqlite3.Row) -> AgentRow:
    """Build an :class:`AgentRow` from an ``agents`` row."""
    return AgentRow(
        id=str(row["id"]),
        board_id=str(row["board_id"]),
        actor=str(row["actor"]),
        display_name=str(row["display_name"]),
        role=str(row["role"]),
        invite_id=str(row["invite_id"]),
        host=str(row["host"]),
        workspace_dir=str(row["workspace_dir"]),
        session_id=str(row["session_id"]),
        kind=str(row["kind"]),
        registered_at=int(row["registered_at"]),
        last_seen_at=int(row["last_seen_at"]),
        revoked_at=int(row["revoked_at"]),
        revoke_reason=str(row["revoke_reason"]),
        metadata=str(row["metadata"]),
    )


def to_identity(agent: AgentRow) -> AgentIdentity:
    """Project a registry row onto the wire.

    Built field by field rather than by copying the dict. ``_AGENT_COLUMNS``
    already keeps ``token_hash`` out of every SELECT, so this is the second of
    two independent reasons a hash cannot reach a client — and the one that still
    holds if a future column joins that list. Mirrors ``toIdentity`` in
    ``ui/server/identity.js`` field for field, so the two surfaces describe an
    agent with the same keys.
    """
    return AgentIdentity(
        agent_id=agent["id"],
        actor=agent["actor"],
        display_name=agent["display_name"],
        role=agent["role"],
        board_id=agent["board_id"],
        last_seen_at=agent["last_seen_at"],
    )


def to_roster_row(agent: AgentRow) -> RosterRow:
    """Project a registry row onto the wire, with the roster's extra columns."""
    return RosterRow(
        **to_identity(agent),
        host=agent["host"],
        workspace_dir=agent["workspace_dir"],
        session_id=agent["session_id"],
        kind=agent["kind"],
        registered_at=agent["registered_at"],
        revoked_at=agent["revoked_at"],
        revoke_reason=agent["revoke_reason"],
    )


def verify_agent_token(token: str, db_path: str | None = None) -> AgentRow | None:
    """Authenticate an agent by its durable token.

    Mirrors ``verifyAgentToken`` in boards/agents.mjs, including that it returns
    None for unknown *or* revoked, so a revoked token is indistinguishable from a
    wrong one to a caller.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    presented = str(token or "").strip()
    if not presented.startswith(AGENT_TOKEN_PREFIX):
        return None
    # Accounts mode: a legacy token owned by a user authenticates as that user's
    # principal row; a personal connection token resolves the same way; an
    # unclaimed legacy token is unchanged. Mirrors verifyAgentToken in agents.mjs.
    if _accounts.accounts_enabled(os.environ, db_path):
        resolved = _accounts.resolve_token_principal(presented, os.environ, db_path)
        if resolved is None or resolved[0] is None:
            return None
        return _agent_by_id(resolved[0], db_path)
    conn = _connect(db_path)
    try:
        rows = _query(
            conn,
            f"{_AGENT_SELECT} WHERE token_hash = ? AND revoked_at = 0",
            (hash_token(presented),),
        )
        return _to_agent(rows[0]) if rows else None
    finally:
        conn.close()


def _agent_by_id(agent_id: str, db_path: str | None = None) -> AgentRow | None:
    """A live agent row by id (accounts mode's acting row)."""
    conn = _connect(db_path)
    try:
        rows = _query(conn, f"{_AGENT_SELECT} WHERE id = ? AND revoked_at = 0", (agent_id,))
        return _to_agent(rows[0]) if rows else None
    finally:
        conn.close()


def find_agent_by_session(
    session_id: str,
    board_id: str = "",
    include_revoked: bool = False,
    db_path: str | None = None,
) -> AgentRow | None:
    """Resolve the agent belonging to a session.

    Mirrors ``findAgentBySession`` in boards/agents.mjs, including its ordering.

    ``include_revoked`` is how a caller tells "this session never registered" from
    "this session's agent was revoked" — two states that a filtered lookup alone
    collapses into a single ``None``, and collapsing them is what let revocation
    promote an agent to operator. :func:`resolve_agent_identity` is the caller
    that needs both answers.

    Callers should leave ``board_id`` empty — see :func:`resolve_agent_identity`
    for why scoping identity to a board is a trap.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    if not session_id:
        return None
    where = ["session_id = ?"]
    params: list[Any] = [session_id]
    if board_id:
        where.append("board_id = ?")
        params.append(board_id)
    if not include_revoked:
        where.append("revoked_at = 0")

    conn = _connect(db_path)
    try:
        rows = _query(
            conn,
            f"{_AGENT_SELECT} WHERE {' AND '.join(where)} "
            "ORDER BY revoked_at = 0 DESC, registered_at DESC LIMIT 1",
            tuple(params),
        )
        return _to_agent(rows[0]) if rows else None
    finally:
        conn.close()


def find_agent_by_actor(
    actor: str,
    include_revoked: bool = False,
    db_path: str | None = None,
) -> AgentRow | None:
    """Resolve an agent by its actor slug.

    Exists for the worker-email door (public MCP edge), where the caller's
    identity is an SSO-authenticated email and the deterministic actor derived
    from it is the lookup key. Same ``include_revoked`` contract as
    :func:`find_agent_by_session`, and for the same reason: "never registered"
    and "revoked" must stay distinguishable or revocation quietly re-provisions.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    slug = str(actor or "").strip()
    if not slug:
        return None
    where = ["actor = ?"]
    params: list[Any] = [slug]
    if not include_revoked:
        where.append("revoked_at = 0")
    conn = _connect(db_path)
    try:
        rows = _query(
            conn,
            f"{_AGENT_SELECT} WHERE {' AND '.join(where)} "
            "ORDER BY revoked_at = 0 DESC, registered_at DESC LIMIT 1",
            tuple(params),
        )
        return _to_agent(rows[0]) if rows else None
    finally:
        conn.close()


def _sso_rejected_resolution() -> AgentResolution:
    """Reject an unsupported hosted identity without falling into operator mode."""
    # A failed internal lookup must not become stdio operator mode when the
    # deployment forgot FEADS_REQUIRE_AGENT. The worker supplied a credential, but
    # this process could not verify it against the silo's registry.
    return AgentResolution(agent=None, credential_rejected=True, via="rejected")


def list_agents(
    board_id: str = "",
    include_revoked: bool = False,
    db_path: str | None = None,
) -> list[AgentRow]:
    """List registered agents, ordered live-first then most recently seen.

    Mirrors ``listAgents`` in boards/agents.mjs, including its ordering. An empty
    ``board_id`` means "every board", matching the Node signature's falsy
    board_id.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    where: list[str] = []
    params: list[Any] = []
    if board_id:
        where.append("board_id = ?")
        params.append(board_id)
    if not include_revoked:
        where.append("revoked_at = 0")
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    conn = _connect(db_path)
    try:
        rows = _query(
            conn,
            f"{_AGENT_SELECT} {clause} ORDER BY revoked_at = 0 DESC, last_seen_at DESC",
            tuple(params),
        )
        return [_to_agent(row) for row in rows]
    finally:
        conn.close()


def resolve_agent_identity(
    env: Mapping[str, str], board_id: str = "", db_path: str | None = None
) -> AgentResolution:
    """Work out who is calling, from the environment alone.

    Ports ``resolveAgentIdentity`` in ``boards/agents.mjs`` step for step, and the
    order is **pinned by ``resolution_cases`` in boards/authz-cases.json** —
    resolution turned out to be as security-sensitive as the policy, and unlike
    the policy it was actively drifting between surfaces. The CLI refused a token
    that would not verify while the UI treated the same token as merely
    unidentified, which locally means operator. Both doors lead to one inversion:
    **revoking an agent would promote it.**

    The three distinctions that carry the whole file:

    - **A token that does not verify is a rejection**, and it is *not* rescued by
      a session id. An explicitly presented credential that fails must not fall
      back to a weaker one that happens to succeed, or revoking a token would be
      defeated by the session id sitting next to it in the same environment.
    - **A session matching a *revoked* agent is a rejection.** This is the likelier
      door for a long-lived daemon, which has no token but always has a session
      id — and it is why :func:`find_agent_by_session` needs
      ``include_revoked``: a lookup that filters revoked rows answers ``None`` for
      "never registered" and for "revoked" alike, and treating the second as the
      first is exactly the promotion.
    - **A session matching *nothing* is not a rejection.** Claude Code exports
      ``CLAUDE_CODE_SESSION_ID`` into every session whether or not anyone ever
      registered, so treating an unmatched session as a refused credential would
      deny nearly every caller.

    ``board_id`` exists for parity with the Node signature; the MCP leaves it
    empty on purpose. An agent registers against one board, and scoping the
    session lookup to whichever board a tool call happens to touch would find no
    row the moment it differed — which, since nothing-registered is not a
    rejection, is operator mode again. Scoping would therefore *reintroduce* the
    promotion through a third door. The policy decides what an agent may do to a
    board it is not registered on; resolution must not pre-empt that by losing
    the identity.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    token = str(env.get(AGENT_TOKEN_ENV, "") or "").strip()
    if token:
        agent = verify_agent_token(token, db_path)
        if agent is not None:
            return AgentResolution(agent=agent, credential_rejected=False, via="token")
        return AgentResolution(agent=None, credential_rejected=True, via="rejected")

    session = str(env.get(SESSION_ID_ENV, "") or "").strip()
    if session:
        live = find_agent_by_session(session, board_id=board_id, db_path=db_path)
        if live is not None and _accounts.accounts_enabled(env, db_path):
            mapped = _accounts.principal_for_agent_id(str(live["id"]), env, db_path)
            acting = _agent_by_id(mapped[0], db_path) if mapped and mapped[0] else None
            if acting is None:
                return AgentResolution(agent=None, credential_rejected=True, via="rejected")
            return AgentResolution(agent=acting, credential_rejected=False, via="session")
        if live is not None:
            return AgentResolution(agent=live, credential_rejected=False, via="session")
        revoked = find_agent_by_session(session, board_id=board_id, include_revoked=True, db_path=db_path)
        if revoked is not None:
            return AgentResolution(agent=None, credential_rejected=True, via="rejected")

    return AgentResolution(agent=None, credential_rejected=False, via="none")


def resolve_identity(env: Mapping[str, str] | None = None, db_path: str | None = None) -> ResolvedIdentity:
    """Resolve the agent acting on this tool call.

    Resolves to operator mode — not a rejection — whenever no agent can be
    identified, **including when the registry is unreachable**. A registry that
    does not exist means "nobody has registered an agent", which is the normal
    state of a machine that has not run ``feads-agent invite`` yet; raising there
    would make every gated tool fail on a working local setup. The error is
    reported in ``registry_error`` instead so a caller can say why nobody was
    identified.

    Note that this failure-open is bounded by the same flag as everything else:
    under ``FEADS_REQUIRE_AGENT`` an unidentified caller is refused, so a hosted
    deployment whose registry is unreadable denies rather than admits.

    An unreadable registry is deliberately **not** reported as a rejected
    credential even when a token was presented. Rejection means "this credential
    was checked and found wanting"; here nothing was checked. Conflating the two
    would turn a machine that has simply never minted an invite into one that
    refuses every gated call, and the registry being absent is the normal state
    of exactly that machine.

    ``openRegistry`` is never called: it would create and migrate the file. An
    absent registry means "nobody has registered", not "make one".

    ## A token on the request outranks one in the environment

    Over HTTP the credential rides on the call (``Authorization: Bearer fdsa_…``)
    and is spliced into the same slot ``FEADS_AGENT_TOKEN`` fills, so the shared
    resolution order applies unchanged and a header token that does not verify is a
    **rejection** rather than an anonymous caller — without which revocation inverts
    over the wire exactly as it would locally.

    The request wins when both are present, and that precedence is the whole point:
    one HTTP server serves many agents, so a token in *its* environment describes the
    host that launched it, not whoever is calling. Letting the host's token win would
    hand every anonymous caller the host's identity — a promotion, and a confusing
    one, since the roster would show one agent doing everybody's work.
    """
    source_env = os.environ if env is None else env
    # Read through authz so this server and the CLI cannot disagree about what
    # counts as set, or about how the flag interacts with a surface's own stance.
    require_identity = require_identity_from_env(source_env)
    stance = surface_stance(source_env)

    presented = bearer_token()
    if presented:
        source_env = {**source_env, AGENT_TOKEN_ENV: presented}

    registry_error = ""
    silo: str | None = None
    try:
        silo = configured_silo(source_env)
    except ValueError:
        # A malformed silo must not be rescued by a host token or operator mode.
        found = _sso_rejected_resolution()
    else:
        try:
            found = resolve_agent_identity(source_env, db_path=db_path)
        except RegistryUnavailableError as exc:
            found = AgentResolution(agent=None, credential_rejected=False, via="none")
            registry_error = str(exc)

    # Accounts mode (base instance only): system keys are not agents, so they are
    # resolved here rather than through the parity-pinned order above, which
    # correctly reports an fdss_ token as an unverifiable agent credential.
    accounts_on = silo is None and not registry_error and _accounts.accounts_enabled(source_env, db_path)
    principal: dict[str, Any] | None = None
    env_token = str(source_env.get(AGENT_TOKEN_ENV, "") or "").strip()
    if accounts_on and env_token.startswith(_accounts.SYSTEM_KEY_PREFIX):
        system = _accounts.resolve_token_principal(env_token, source_env, db_path)
        if system is None:
            found = AgentResolution(agent=None, credential_rejected=True, via="rejected")
        else:
            found = AgentResolution(agent=None, credential_rejected=False, via="system_key")
            principal = system[1]

    if silo is not None:
        found = _sso_rejected_resolution()

    row = found["agent"]
    credential_rejected = found["credential_rejected"]
    # Mirrors decide()'s own branching, which is why it reads the stance: an
    # unidentified caller is only the *operator* under the operator stance, and is
    # `anonymous` under the other two. Mode is action-independent in every branch of
    # decide(), so it can be settled here, before any action is known — and
    # test_agents_identity.py enumerates the combinations rather than trusting this
    # comment, because a mode that disagreed with the decision it describes would
    # mislead every agent that asks `agent_whoami` what it may do.
    if row is not None:
        mode: Mode = "agent"
    elif credential_rejected:
        mode = "rejected"
    elif stance == "operator":
        mode = "operator"
    else:
        mode = "anonymous"

    # Which door the credential came through. Derived from what was *presented*, not
    # from whether it worked: a rejected header token has to still report the header,
    # or the one message that would tell a caller where to look gets lost at exactly
    # the moment it is needed.
    credential_source: CredentialSource = "none"
    if presented:
        credential_source = "authorization_header"
    elif str(source_env.get(AGENT_TOKEN_ENV, "") or "").strip():
        credential_source = "environment"
    elif found["via"] == "session" or (
        credential_rejected and str(source_env.get(SESSION_ID_ENV, "") or "").strip()
    ):
        credential_source = "session"

    resolved = ResolvedIdentity(
        identity=to_identity(row) if row is not None else None,
        agent=row,
        mode=mode,
        stance=stance,
        require_identity=require_identity,
        via=found["via"],
        credential_source=credential_source,
        credential_rejected=credential_rejected,
    )
    if registry_error:
        resolved["registry_error"] = registry_error
    if not accounts_on:
        _accounts.request_principal.set(None)
    if accounts_on:
        if principal is None:
            principal = _principal_for_resolution(found, env_token, mode, source_env, db_path)
        resolved["principal"] = principal
        _accounts.request_principal.set(principal)
        _accounts.request_session_suffix.set(_mcp_session_suffix())
    return resolved


def _mcp_session_suffix() -> str:
    """``#<8 hex>`` of the MCP session id, for same-user claim labels."""
    try:
        from fastmcp.server.dependencies import get_context

        return _accounts.session_suffix_for(get_context().session_id or "")
    except Exception:  # noqa: BLE001 - outside a request there is no session
        return ""


def _principal_for_resolution(
    found: AgentResolution, env_token: str, mode: str, env: Mapping[str, str], db_path: str | None
) -> dict[str, Any]:
    """The accounts principal for an already-resolved caller."""
    row = found["agent"]
    if row is None:
        return {"kind": "operator", "via": "none"} if mode == "operator" else {"kind": "anonymous"}
    resolved: tuple[str | None, dict[str, Any]] | None
    if env_token:
        resolved = _accounts.resolve_token_principal(env_token, env, db_path)
    else:
        resolved = _accounts.principal_for_agent_id(str(row["id"]), env, db_path, via="session")
    return resolved[1] if resolved else {"kind": "anonymous"}


def registry_location(db_path: str | None = None) -> str:
    """Absolute path of the registry these lookups read."""
    return os.path.abspath(db_path) if db_path else registry_path()


def acting_actor(env: Mapping[str, str] | None = None, db_path: str | None = None) -> str:
    """The actor a bd write made on this call should be attributed to, or ``""``.

    Attribution is a property of the *caller*, resolved per call, exactly like
    authorization — and it must be the **same** resolution, or the two answers
    drift: ``agent_whoami`` says ``mira-example`` while ``created_by`` records
    whatever ``BEADS_ACTOR`` the server process happened to inherit. That is not a
    cosmetic mismatch. One HTTP server serves many agents, so its environment
    describes the host that launched it, not whoever is calling — and every
    caller's writes collapsing onto the host's identity defeats both things
    ``created_by`` exists for: the board stops showing who is doing what, and the
    delete-own policy compares against a string the writing agent never held, so
    an agent cannot delete the bead it just created.

    Returns the verified identity's actor, and only that. No fallback happens
    here on purpose: whether an *unidentified* caller still gets an actor (the
    process environment, on stdio, where the environment genuinely is the
    caller's) is the call site's decision, because it depends on which pipe the
    call came in on — the distinction :mod:`beads_mcp.transport` exists to hold.

    Never raises: an unreadable registry already resolves to "nobody verified"
    inside :func:`resolve_identity`, and attribution must not be able to fail a
    call that authorization let through.
    """
    context = request_authorization.get()
    if context is not None and env is None and db_path is None:
        return context.actor if context.allowed else ""
    row = resolve_identity(env, db_path)["agent"]
    return str(row["actor"]) if row is not None else ""


def request_credential(env: Mapping[str, str] | None = None) -> str:
    """The caller's own bearer credential, to relay to the dashboard, or ``""``.

    Over HTTP it is the request's ``Authorization: Bearer`` — never the server's
    ``FEADS_AGENT_TOKEN``, which describes the host that launched it (relaying that
    would act as the host for every caller). On stdio the environment *is* the
    caller's, so the environment token is the credential there.
    """
    if serving_http():
        return bearer_token()
    source = os.environ if env is None else env
    return str(source.get(AGENT_TOKEN_ENV, "") or "").strip()


def accounts_edge_email(env: Mapping[str, str] | None = None, db_path: str | None = None) -> str:
    """Hosted edge identity is unavailable; never relay an email to the dashboard."""
    return ""


def authorize(
    action: str,
    resource: Mapping[str, Any] | None = None,
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
) -> ModeDecision:
    """Resolve the caller and ask the policy whether it may do this.

    The one entry point for gating a tool. Resolution happens per call rather
    than being cached, for the reason ``ui/server/identity.js`` gives: a
    revocation or a role change has to take effect on the next call, not on the
    next server restart. The cost is one small read-only SQLite open per gated
    operation, and gated operations are deletes and roster reads, not the hot
    path.
    """
    resolved = resolve_identity(env, db_path)
    principal = resolved.get("principal") or {}
    if principal.get("kind") == "system" and action != "read":
        # A system key is read-only by construction; say so rather than letting the
        # anonymous-stance refusal suggest sign-up to a caller that has a credential.
        request_authorization.set(AuthorizationContext(agent=None, actor="", action=action, allowed=False))
        return ModeDecision(
            allowed=False,
            reason="this is a read-only system key — it can never write; use a personal connection for writes",
            mode="agent",
        )
    if principal.get("kind") == "service" and action != "read" and principal.get("read_only") is not False:
        # A read-only service account: same refusal, its own wording.
        actor_ro = str(resolved["agent"]["actor"]) if resolved["agent"] is not None else ""
        request_authorization.set(
            AuthorizationContext(agent=resolved["agent"], actor=actor_ro, action=action, allowed=False)
        )
        return ModeDecision(
            allowed=False,
            reason="this service account is read-only — it can never write; a superadmin can change that",
            mode="agent",
        )
    # The stance is passed rather than `require_identity`: `stance_for` has already
    # folded the flag into it, and passing both would leave two channels for the same
    # rule, one of which could be forgotten at a call site.
    decision = decide(
        resolved["agent"],
        action,
        resource,
        unidentified=resolved["stance"],
        credential_rejected=resolved["credential_rejected"],
    )
    actor = str(resolved["agent"]["actor"]) if resolved["agent"] is not None else ""
    request_authorization.set(
        AuthorizationContext(
            agent=resolved["agent"],
            actor=actor,
            action=action,
            allowed=decision["allowed"],
        )
    )
    return decision


# A `created_by` that no real agent can hold, for probing "may I delete someone
# else's item?" without naming a victim. The trap it avoids: a plausible-looking
# placeholder like "other-agent" is a perfectly legal actor slug, so an agent that
# actually registered under that name would be told it may delete other agents'
# items. Actor names are slugified to [a-z0-9-], so a value with a space in it is
# unrepresentable as one.
_UNOWNABLE_ACTOR = "another agent"


def how_to_get_a_credential(env: Mapping[str, str] | None = None) -> str:
    """The one place that says how an agent obtains an identity.

    Used by ``agent_whoami``'s hints, by the write gate's refusal, and by the server's
    ``instructions``, so a fresh agent gets the same answer whether it asked or was
    told.

    **It now leads with something the agent can do itself.** It used to say the
    opposite — sign-up is a write, this server does not write, so ask your human — and
    that stopped being true when ``agent_signup`` landed: the write still belongs to
    the dashboard, but this server may now *ask* it to happen (see
    :mod:`beads_mcp.signup`). The human path stays as the fallback rather than being
    deleted, because the dashboard genuinely may not be running, and that is the one
    failure an agent cannot resolve from here.

    The delivery half is transport-specific and that difference is the whole reason
    this is a function rather than a constant. Over HTTP the token rides on the
    request, so the agent can start using it on the very next call. On stdio it is
    read from the process environment exactly once, at startup, so no token can be
    adopted mid-session — saying "set the variable" without saying "and restart"
    would send an agent into a loop of trying a credential the server cannot see.

    Under the ``deny`` stance it still has to name the signup exception. The shared
    policy keeps ``mint_invite`` for the ``user`` tier open, because requiring an
    identity in order to obtain one is a closed loop; ``agent_signup`` is the path out
    of ``deny``. Only the other unidentified calls are refused. The stance is
    recomputed here rather than passed in so no call site can forget it — this text
    reaches an agent from three places (``agent_whoami``'s hint, the write gate's
    refusal, the server instructions) and only one of them knows the stance already.
    """
    # This sentence is aimed at a human, not at the proxy endpoint the MCP uses for
    # its POST. A silo reaches its dashboard over a public sibling hostname, so prefer
    # FEADS_PUBLIC_URL and keep dashboard_url() for the actual signup request.
    where = public_dashboard_url(env)
    if _accounts.accounts_enabled(env if env is not None else os.environ):
        # Accounts mode (proposals/sso-spaces-rbac.md): sign-up is retired and every
        # credential comes from the person's example sign-in. The token is set by the
        # human, never handed over in chat.
        return (
            "This instance identifies people through an external SSO provider; sign-up is retired here, "
            "so do not call agent_signup. Ask your human to connect you: the Claude connector "
            "(https://feads.mcp.example.test/mcp, which signs in with Google), or a personal "
            f"token from Access → Connect an agent in the dashboard at {where} that they set "
            f"as {AGENT_TOKEN_ENV} in your environment themselves — a token never goes in chat."
        )
    stance = surface_stance(env)
    deliver = (
        "Send that token on every later call as an `Authorization: Bearer <token>` "
        "header — this server reads the token off the request, so nothing needs "
        "restarting."
        if serving_http()
        else f"Then have your human set {AGENT_TOKEN_ENV}=<token> in this server's own "
        "environment (the `env` block of the MCP entry in your client config) and "
        "restart it. A stdio server reads the token once at startup and cannot pick "
        "one up mid-session, so the restart is required, not a formality."
    )
    # Only meaningful where the agent is being told it can sign itself up, and only on
    # stdio, where the wait between minting a token and being able to use it is exactly
    # the window in which an agent decides to try again.
    once_only = (
        ""
        if serving_http()
        else " Do not sign up a second time while you wait: the row already exists, so you "
        "would own two identities and the first one's items would not be yours to delete."
    )
    if stance == "deny":
        return (
            "To get one, call agent_signup(display_name='<a short name for you>'). This "
            f"surface refuses unidentified callers ({REQUIRE_AGENT_ENV} is set), reads "
            "included, but sign-up remains open for the `user` tier so enrollment can "
            f"break the loop — its `sign_up` permission is true. It signs you up through "
            f"the feads dashboard at {where} and returns an agent token beginning "
            f"`{AGENT_TOKEN_PREFIX}` exactly once. {deliver} If the dashboard is "
            f"unreachable, ask your human to sign in at {where} and set the token as "
            "FEADS_AGENT_TOKEN in your environment themselves — a token never goes in chat."
        )
    return (
        "To get one, call agent_signup(display_name='<a short name for you>'). It signs you "
        f"up through the feads dashboard at {where} — open to anyone, it needs no admin, and "
        f"it can only ever mint the `user` tier — and returns an agent token beginning "
        f"`{AGENT_TOKEN_PREFIX}` exactly once. {deliver}{once_only} If it answers "
        f"`dashboard_unreachable` then the dashboard is not running at {where}: that is the "
        "one part you cannot do yourself, so ask your human to start it (`make run`) or to "
        "sign up in the browser and set FEADS_AGENT_TOKEN for you themselves — a token "
        "never goes in chat."
    )


# What an identity's board_id means — and does not mean. One copy per language:
# the canonical text lives in boards/agents.mjs (HOME_BOARD_NOTE) next to the
# column it describes; this mirror exists because whoami/signup payloads on the
# MCP surface are built entirely in Python (feads-dzn). Keep the two in sync.
HOME_BOARD_NOTE: dict[str, Any] = {
    "home_board_is_registration_anchor": True,
    "home_board_hint": (
        "The board_id in this identity is where you are REGISTERED, not where your work "
        "goes: it scopes the roster and the claim-collision check, nothing else. Pick a "
        "board per item with board_route(), and switch a session with context(board=...). "
        "Filing everything on the board named here is exactly how a catch-all board "
        "becomes everyone's default."
    ),
}


def agent_whoami_payload(env: Mapping[str, str] | None = None, db_path: str | None = None) -> dict[str, Any]:
    """Build the ``agent_whoami`` tool result.

    Payloads are shaped here rather than in server.py for the reason boards.py
    gives: the JSON an agent sees can then be asserted on without standing up an
    MCP client.

    ``permissions`` is computed by asking :func:`beads_mcp.authz.decide` the real
    questions rather than by re-deriving the tier table. Re-deriving it would be a
    third implementation of the policy, in the one place whose whole job is to
    report the policy accurately.
    """
    resolved = resolve_identity(env, db_path)
    agent = resolved["agent"]
    stance = resolved["stance"]
    require_identity = resolved["require_identity"]
    credential_rejected = resolved["credential_rejected"]
    actor = agent["actor"] if agent is not None else ""

    def allowed(action: str, resource: Mapping[str, Any] | None = None) -> bool:
        return decide(
            agent,
            action,
            resource,
            unidentified=stance,
            credential_rejected=credential_rejected,
        )["allowed"]

    payload: dict[str, Any] = {
        "registry_path": registry_location(db_path),
        "identity": resolved["identity"],
        "mode": resolved["mode"],
        # How the identity was established, or how it failed to be, so an agent
        # can tell a presented credential from an ambient session — they fail for
        # different reasons and want different fixes.
        "via": resolved["via"],
        "credential_source": resolved["credential_source"],
        # The stance is reported, not just its consequences, because "why may I not
        # write?" has two very different answers — "you are anonymous on a shared
        # endpoint" and "you are a user and this is not your item" — and an agent that
        # cannot tell them apart will retry the wrong one.
        "stance": stance,
        "require_identity": require_identity,
        "credential_rejected": credential_rejected,
        # Reported as `sign_up` rather than as `mint_invite`, which is the action the
        # policy is actually asked about, because only one case of that action is
        # reachable from here: `agent_signup` mints the `user` tier and nothing else
        # (see beads_mcp.signup.SIGNUP_ROLE). Minting an *admin* invite still has no
        # tool, so reporting the general permission would promise something this
        # server cannot do. This key exists at all because sign-up is now something an
        # agent can attempt: under `deny` it is refused, and an agent that learns that
        # here does not have to learn it by trying.
        "permissions": {
            "read": allowed("read"),
            "write": allowed("write"),
            "sign_up": allowed("mint_invite", {"role": "user"}),
            "delete_own": allowed("delete", {"created_by": actor or _UNOWNABLE_ACTOR}),
            "delete_any": allowed("delete", {"created_by": _UNOWNABLE_ACTOR}),
            "manage_agents": allowed("manage_agents"),
            "view_roster": allowed("view_roster"),
        },
        "roster_scope": roster_scope_for(
            agent,
            unidentified=stance,
            credential_rejected=credential_rejected,
        )["scope"],
    }
    if resolved["identity"] is not None:
        # The identity names a board_id; say what that field is for before an
        # agent infers "file my work here" from it (feads-dzn).
        payload.update(HOME_BOARD_NOTE)
    if "registry_error" in resolved:
        payload["registry_error"] = resolved["registry_error"]

    if credential_rejected:
        which = {
            "authorization_header": "the token on this request's `Authorization: Bearer` header "
            "matched no live agent",
            "environment": f"{AGENT_TOKEN_ENV} was presented and matched no live agent",
        }.get(
            resolved["credential_source"],
            f"{SESSION_ID_ENV} matches an agent that has been revoked",
        )
        payload["hint"] = (
            f"{which} — most likely the agent was revoked, or the credential belongs to a "
            "different registry. Every gated call is refused until this is resolved, and "
            "deliberately so: falling back to operator mode here would let revoking an agent "
            "*increase* what it can do. " + how_to_get_a_credential(env)
        )
    elif agent is None:
        payload["hint"] = (
            "You have no agent identity. "
            + (
                "Reads are allowed and nothing else is, because this endpoint is shared — "
                "the server holds the registry and you are whoever reached the port. "
                if stance == "read_only"
                # The variable is deliberately not named here: how_to_get_a_credential
                # names it in the same breath as what to do about it, and saying it twice
                # in one paragraph reads like two different problems.
                else "This server refuses unidentified callers outright, reads included. "
                if stance == "deny"
                else "You are acting as the operator, which is allowed here because a caller "
                "on this transport already owns the registry file. "
            )
            + how_to_get_a_credential(env)
        )
    return payload


def agents_list_payload(
    board: str = "",
    include_revoked: bool = False,
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
) -> dict[str, Any]:
    """Build the ``agents_list`` tool result, narrowed to what the caller may see.

    Scoping goes through :func:`beads_mcp.authz.roster_scope_for`, never the bare
    ``roster_scope``. The difference is the trap: ``roster_scope`` is a pure tier
    lookup and answers ``none`` for a null agent, so an operator run through it
    gets an **empty** roster — indistinguishable from "no agents are registered".
    ``roster_scope_for`` adds the operator rule and honors
    ``FEADS_REQUIRE_AGENT``.

    One deliberate difference from the dashboard's roster
    (``listRoster`` in ``ui/server/identity.js``): omitting ``board`` here lists
    every board's agents, where the dashboard refuses to. That is a presentation
    difference, not a policy one — the dashboard shows a roster under the heading
    of one board, so cross-board rows there would be a lie, whereas the MCP is
    explicitly cross-board (see ``boards_list``/``board_route``) and every row
    carries its ``board_id``. The *authorization* is identical, which is the part
    that must not differ between surfaces.
    """
    resolved = resolve_identity(env, db_path)
    agent = resolved["agent"]
    stance = resolved["stance"]
    require_identity = resolved["require_identity"]
    credential_rejected = resolved["credential_rejected"]
    scope = roster_scope_for(agent, unidentified=stance, credential_rejected=credential_rejected)["scope"]

    payload: dict[str, Any] = {
        "registry_path": registry_location(db_path),
        "board_id": board or None,
        "mode": resolved["mode"],
        "via": resolved["via"],
        "require_identity": require_identity,
        "credential_rejected": credential_rejected,
        "scope": scope,
    }

    gate = decide(
        agent,
        "view_roster",
        {},
        unidentified=stance,
        credential_rejected=credential_rejected,
    )
    if not gate["allowed"]:
        payload.update({"allowed": False, "reason": gate["reason"], "scope": "none", "agents": [], "count": 0})
        return payload
    payload["allowed"] = True
    payload["reason"] = gate["reason"]

    if scope == "none":
        # Only reachable for a revoked row handed in directly: identity resolution
        # filters revoked agents out, so a revoked credential arrives here as
        # unidentified instead. Kept because the policy defines the case and a
        # surface that dropped it would diverge if resolution ever stopped
        # filtering.
        payload.update({"agents": [], "count": 0})
        return payload

    if scope == "self":
        # Answered from the row already in hand rather than by querying `board`:
        # an agent registered on board A must still be able to see itself while
        # working on board B.
        rows = [to_roster_row(agent)] if agent is not None else []
        payload.update({"agents": rows, "count": len(rows)})
        return payload

    try:
        agents = list_agents(board_id=board, include_revoked=include_revoked, db_path=db_path)
    except RegistryUnavailableError as exc:
        # No registry means nobody is registered, which is an empty roster rather
        # than a refusal. The caller is unidentified here by construction, and the
        # policy has already answered what an unidentified caller gets.
        payload.update(
            {
                "agents": [],
                "count": 0,
                "error": str(exc),
                "hint": (
                    "No agents are registered. The quickest fix is agent_signup("
                    "display_name='<a short name for you>'), which registers one through the "
                    "dashboard. An admin identity cannot be self-served: an admin mints that "
                    "invite with `feads-agent invite --name <agent> --role admin` and the agent "
                    "redeems it once with `feads-agent register --token fdsi_…`. This server "
                    "only ever reads the registry."
                ),
            }
        )
        return payload

    payload.update({"agents": [to_roster_row(row) for row in agents], "count": len(agents)})
    if not agents:
        payload["hint"] = (
            "No agents are registered"
            + (f" on board {board}" if board else "")
            + ". Mint one with `feads-agent invite --name <agent> [--role admin]`."
        )
    return payload
