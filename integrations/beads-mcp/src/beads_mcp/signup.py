"""Getting an identity without a human in the loop — by asking the Node writer.

This is the one place in the Python MCP that causes a registry **write**, and it
causes it by *asking the dashboard to write*, never by writing itself. That
distinction is the entire design, so it is worth being precise about: nothing here
opens the registry for writing, nothing here mints or redeems a token, and
:mod:`beads_mcp.agents` keeps its ``mode=ro`` guarantee intact. What changed is only
that this server may now place an HTTP call to a surface that does write.

## Why a proxy and not a port

Registration's single-use guarantee is not a pure function. ``registerAgent`` in
``boards/agents.mjs`` consumes an invite with a conditional ``UPDATE … WHERE
redeemed_at = 0`` inside ``BEGIN IMMEDIATE``, and leans on a *partial* unique index
(``agents_live_actor_idx``) to reject an actor name taken between mint and redeem. The
invariant is enforced by SQL and transaction semantics over a WAL database.

That is exactly why it cannot be ported the way the policy was. ``beads_mcp.authz`` is
a second implementation of ``boards/authz.mjs``, and the only thing that makes two
implementations of a security-relevant rule tolerable is ``boards/authz-cases.json``:
a shared fixture both suites read, so a divergence fails a test instead of quietly
splitting the surfaces. There is no fixture that could do the same for "two writers
racing on one invite, one of them wins" — a table of inputs and expected outputs does
not describe it, and a Python re-implementation would therefore be an *unfixtured*
second copy of a security invariant. Proxying keeps one implementation, and the
argument in :mod:`beads_mcp.agents`' header (points 1, 2 and 4) is unchanged: the
registry still has the writers it had yesterday.

## What it costs, and why the unreachable path is written so carefully

A proxy needs the proxied thing to be running. Until now this package depended on
nothing but the ``bd`` binary and a readable SQLite file, and an agent could do
everything it was allowed to do with the dashboard stopped. Sign-up cannot: it needs
``POST {FEADS_DASHBOARD_URL}/api/agent/signup`` to answer.

So a connection failure gets its own outcome (``dashboard_unreachable``), names the
URL that was tried, and says the dashboard is not running — because the failure mode
to avoid is an agent reading "could not sign up" as "I am not allowed to sign up".
The first is fixed by ``make run``; the second is not fixed by anything the agent can
do, and an agent that confuses them either gives up when it should retry or retries
forever when it should ask. Every other failure is likewise translated to its own code
rather than collapsed, for the same reason: the right next move differs per code, and
a single "signup failed" string makes an agent guess.

## What this can keep out of a log, and what it cannot

The token is returned exactly once, so a copy anywhere else outlives the agent's only
copy. Nothing here logs it: the success path logs the recorded *actor*, failures log a
code, and the raw response body — the one string that does contain the token — is never
logged at all. The one place bytes we did not predict get relayed (a 2xx we could not
parse) is scrubbed by pattern first.

What this module cannot control is that the token is, necessarily, the tool's *result*.
An MCP client or host that logs tool results at debug level will log it, exactly as a
browser devtools panel sees the dashboard's own sign-up response. That is inherent to
handing a credential to whoever asked for it, not something a scrubber can fix.

## The honesty line, restated

This is an integrity control, not a security boundary, and ``agent_signup`` does not
weaken it because it grants nothing new. Whoever can reach this server on stdio can
already open the dashboard, run ``feads-agent``, or edit the SQLite file directly; over
HTTP the ``read_only`` stance already permits sign-up (``mint_invite`` for the ``user``
tier) precisely because "present a credential" is a closed loop otherwise, and the
browser has offered the same open sign-up from the start. What this removes is a human
round trip, not a gate. The **admin** tier is still unreachable from here — see
:data:`SIGNUP_ROLE`.
"""

import base64
import binascii
import json
import logging
import os
import re
import unicodedata
from collections.abc import Mapping
from typing import Any, Literal
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from beads_mcp import accounts as _accounts
from beads_mcp.agents import (
    AGENT_TOKEN_ENV,
    AGENT_TOKEN_PREFIX,
    HOME_BOARD_NOTE,
    accounts_edge_email,
    request_credential,
    resolve_identity,
)
from beads_mcp.authz import decide
from beads_mcp.bd_client import ActorResolutionError, silo_configured
from beads_mcp.tools import _find_beads_db_in_tree, current_workspace
from beads_mcp.transport import DASHBOARD_URL_ENV, dashboard_url, serving_http

logger = logging.getLogger(__name__)

# The dashboard route this proxies. Contract read from `ui/server/agent-session.js`:
# `{display_name, actor?, surface?, board_dir?}` in, a body carrying `token` and
# `created: true` out, and a documented error taxonomy in `failureFor`/the route body
# that `_HINTS` below mirrors code for code.
SIGNUP_PATH = "/api/agent/signup"
DELEGATE_PATH = "/api/agent/delegate"

# Where the identity came from, for the roster's provenance columns. The endpoint
# *maps* this to `kind` and `created_by` (`mcp` → `kind: 'agent'`,
# `created_by: 'mcp-signup'`) rather than taking either of those from us, and that
# indirection is the point: free-text provenance is spoofable, so a caller that could
# send `created_by` could attribute an identity to an actor that never created it. A
# whitelisted enum can only ever say which door was used.
#
# Sent as a literal, never from an argument, for the same reason `SIGNUP_ROLE` is: this
# *is* the MCP, so there is nothing for a caller to choose. Which also makes the
# endpoint's `400` for an unrecognised surface unreachable from here — deliberately not
# given its own entry in `_HINTS`, since a hint for an impossible case is noise. If it
# ever did arrive it would land on `bad_request` with the endpoint's own message, which
# is the honest fallback rather than a special case.
SURFACE = "mcp"

# The only tier this can ever ask for, and it is not a parameter.
#
# Not "the default" — the *only* value, hard-coded here and absent from the tool
# schema. The policy refuses an admin invite to anyone who is not already an admin
# (`_wants_admin_invite` in beads_mcp.authz), and this caller is by construction
# unidentified, so a `role` parameter could only ever be refused. Offering one would
# be a lie in the tool schema: an agent reads a parameter as a capability, would ask
# for `admin` because why not, and would get a refusal that reads like a bug in the
# server rather than the design. The dashboard's own sign-up form makes the same
# choice for the same reason.
SIGNUP_ROLE = "user"

# A hung dashboard must not hang the tool call. Ten seconds is generous for a local
# express route doing two SQLite statements, and short enough that an agent gets an
# actionable `dashboard_unreachable` rather than sitting in a tool call.
SIGNUP_TIMEOUT_SECONDS = 10.0

# The SSO resolver is on the same loopback dashboard, but identity resolution is on
# the hot path of every hosted request. Keep its timeout bounded independently of
# the signup tool's longer human-facing request.
SSO_RESOLVE_TIMEOUT_SECONDS = 5.0

# The response is a few hundred bytes. The cap is not about the dashboard: it is about
# `FEADS_DASHBOARD_URL` pointing at something else entirely — a dev server, a log
# stream, a proxy error page — where an unbounded read is how a tool call never returns.
_MAX_BODY_BYTES = 64 * 1024

# Any agent token, by shape rather than by value. `ui/server/agent-session.js` scrubs
# by the exact secret because it always has it; here the dangerous case is a body we
# did *not* expect to contain one (a 200 we could not parse, a relayed error message),
# so the pattern is what applies. Defensive rather than decorative: an error path is
# precisely where a credential leaks without anyone noticing.
_TOKEN_PATTERN = re.compile(rf"{AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]+")
_SSO_EMAIL_PATTERN = re.compile(r"^[^@\s]+@example\.com$", re.IGNORECASE)
_SSO_SECRET_HEX_PATTERN = re.compile(r"^(?:[0-9a-fA-F]{2})+$")
_SSO_SECRET_BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
_SSO_SECRET_MIN_BYTES = 32

# What went wrong, in one word an agent can branch on. The first seven are the
# dashboard's own codes, relayed unchanged; the last three are ours, describing failures
# the dashboard never sees because they happen before or around the call. Two of the
# seven share a status (409: `board_unregistered` and `name_taken`) and want opposite
# actions, which is why the code is carried through rather than re-derived from the
# status.
FailureCode = Literal[
    "bad_request",
    "forbidden",
    "board_unregistered",
    "name_taken",
    "no_registry",
    "registry_failed",
    "token_rejected",
    "already_identified",
    "dashboard_unreachable",
    "unexpected_response",
]


class DashboardUnreachableError(RuntimeError):
    """The signup endpoint could not be reached at all.

    Separate from every HTTP status, including 5xx: a 500 means the dashboard
    answered and something inside it failed, while this means nothing answered. The
    two need different words in front of an agent, and conflating them is how "the
    dashboard is not running" comes to read as "you are not permitted".
    """


def _scrub(text: str) -> str:
    """Remove anything token-shaped from a string bound for a log or a response."""
    return _TOKEN_PATTERN.sub("«token»", str(text or ""))


def _read_body(status: int, response: Any) -> tuple[int, Any, str]:
    """Read a response into ``(status, parsed_json_or_None, raw_text)``.

    Parse failures are not an error here. A non-JSON body is a *diagnosis* — almost
    always that ``FEADS_DASHBOARD_URL`` points at something that is not the feads
    dashboard — so the raw text is carried out to be reported (scrubbed, and only in
    that one case), rather than raising and losing the one clue available.
    """
    raw = response.read(_MAX_BODY_BYTES).decode("utf-8", errors="replace")
    if not raw.strip():
        return status, None, raw
    try:
        return status, json.loads(raw), raw
    except ValueError:
        return status, None, raw


def _post_delegate(url: str, request_body: dict[str, Any], token: str) -> tuple[int, Any, str]:
    data = json.dumps(request_body).encode("utf-8")
    request = Request(
        url,
        data=data,
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urlopen(request, timeout=SIGNUP_TIMEOUT_SECONDS) as response:
            return _read_body(int(response.status), response)
    except HTTPError as error:
        with error:
            return _read_body(int(error.code), error)
    except OSError as error:
        raise DashboardUnreachableError(f"{type(error).__name__}: {error}") from error


def _canonical_sso_email(email: str) -> str:
    """Match Node's canonical spelling before crossing the internal SSO door."""
    return unicodedata.normalize("NFKC", email).strip().lower()


def _post_sso_resolve(url: str, email: str, secret: str) -> tuple[int, Any, str]:
    """POST one worker email to the dashboard's internal SSO resolver.

    This helper deliberately has a separate request shape from signup and delegate:
    the resolver accepts only the SSO email as data and the private internal header
    as authentication. In particular, no ambient request headers are forwarded and
    no caller-controlled actor, role, board, or id is added to the body.

    The raw body is returned only to the caller for validation. Callers must not log
    it: a future dashboard error page must not become a credential or provider-body
    leak through this adapter.

    Raises:
        DashboardUnreachableError: If nothing answered.
    """
    data = json.dumps(
        {"sso_email": _canonical_sso_email(email)}, separators=(",", ":")
    ).encode("utf-8")
    request = Request(
        url,
        data=data,
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "X-Feads-Sso-Internal": secret,
        },
    )
    try:
        with urlopen(request, timeout=SSO_RESOLVE_TIMEOUT_SECONDS) as response:
            return _read_body(int(response.status), response)
    except HTTPError as error:
        with error:
            return _read_body(int(error.code), error)
    except OSError as error:
        raise DashboardUnreachableError(f"{type(error).__name__}: {error}") from error


def _post_signup(url: str, request_body: dict[str, str]) -> tuple[int, Any, str]:
    """POST the signup request and return its status and body.

    Deliberately ``urllib.request`` rather than ``httpx``. ``httpx`` is present in
    every install — ``fastmcp`` depends on it — but only *transitively*, and building
    a runtime code path on a dependency this package does not declare is how a future
    ``fastmcp`` release removes it from under us. Declaring it instead would add a
    direct dependency for one POST with a JSON body, no connection reuse, and no
    streaming. Synchronous for the same reason every other payload builder here is:
    the tool wraps it in ``asyncio.to_thread``, so there is no event loop to block.

    Raises:
        DashboardUnreachableError: If nothing answered.
    """
    data = json.dumps(request_body).encode("utf-8")
    request = Request(
        url,
        data=data,
        method="POST",
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=SIGNUP_TIMEOUT_SECONDS) as response:
            return _read_body(int(response.status), response)
    except HTTPError as error:
        # An HTTPError *is* the response: urllib raises on 4xx/5xx, and the body it
        # carries is where the dashboard's own error code lives. Discarding it would
        # throw away the entire taxonomy and leave every failure as a bare status.
        # Caught before OSError below because HTTPError is a subclass of URLError,
        # which is a subclass of OSError.
        with error:
            return _read_body(int(error.code), error)
    except OSError as error:
        # URLError, TimeoutError and every ConnectionError are all OSError subclasses,
        # so one clause covers connection refused, DNS failure, TLS failure and the
        # read timeout without enumerating them — and without a bare `except` that
        # would also swallow a bug in the code above.
        raise DashboardUnreachableError(f"{type(error).__name__}: {error}") from error


# What to do about each failure, written as the *next move* rather than as a
# restatement of the error. The dashboard's own message says what happened and is
# relayed verbatim as `reason`; this says what to do next, which the dashboard cannot
# know because it is answering a browser and these words are for an agent.
_HINTS: dict[str, str] = {
    "bad_request": (
        "Call agent_signup again with a display_name — a short name for you, like "
        "'laptop-claude'. It is what the board attributes your work to, and what other "
        "agents see in the roster."
    ),
    "forbidden": (
        "This is a policy refusal, not a fault, and nothing you can do from here changes "
        "it: this deployment does not offer open sign-up. Ask your human for a token from "
        "the dashboard, or for an invite (`feads-agent invite --name <you>`)."
    ),
    "board_unregistered": (
        "An agent row references a board row, so the board has to exist in the feads "
        "registry first. The directory this server named is reported as `board_dir` — ask "
        "your human to register it (`feads-board register <board-dir> --name <name>`) and "
        "then try again. Nothing about your request was wrong."
    ),
    "name_taken": (
        "That actor name is already live on the board. Call agent_signup again with a "
        "different display_name (or pass `actor` explicitly). If the existing row is one "
        "*you* created a moment ago, do not sign up again — you already have an identity; "
        "call agent_whoami to see whether this session is presenting it."
    ),
    "no_registry": (
        "There is no feads registry on the dashboard's machine, so nobody has registered a "
        "board yet — this is a setup step, not a permission problem. Ask your human to "
        "create one (`feads-board register <board-dir> --name <name>`)."
    ),
    "registry_failed": (
        "An agent row may have been created without a token coming back, which makes it "
        "unusable — only a hash is stored, so a token nobody was shown is a token nobody "
        "can use. Do not retry blindly: ask your human to revoke it on the dashboard "
        "first, otherwise the name is taken by a row nothing can authenticate as."
    ),
    "token_rejected": (
        "The dashboard minted a token and then could not verify it, which points at the "
        "registry rather than at your request. Ask your human to check the dashboard's log."
    ),
    "unexpected_response": (
        f"Something answered, but it was not the feads dashboard, so ${DASHBOARD_URL_ENV} "
        "is probably pointing at the wrong port. Ask your human which port the feads "
        "dashboard is on."
    ),
}


def _refusal(base: dict[str, Any], code: FailureCode, reason: str, **extra: Any) -> dict[str, Any]:
    """Assemble a failure payload: what happened, and what to do next.

    Returned rather than raised, and that is a considered difference from the write and
    delete gates, which raise :class:`fastmcp.exceptions.ToolError`. Those gate tools
    whose success has nothing to do with authorization, so an exception is the only
    channel. Here "you may not", "that name is taken" and "the dashboard is not
    running" are all *expected answers to the question the tool asks*, they need
    different next moves, and an agent can only branch on them if they arrive as data.
    A string exception would be read, at best, as "sign-up failed" — the one summary
    that leads to the wrong action in most of these cases.
    """
    payload = dict(base)
    payload.update({"created": False, "code": code, "reason": _scrub(reason)})
    hint = _HINTS.get(code)
    if hint:
        payload["hint"] = hint
    payload.update(extra)
    return payload


def _board_dir(env: Mapping[str, str] | None = None) -> str:
    """The ``.beads`` directory of the board this process is working on, or ``""``.

    Sent to the endpoint so a new agent lands in the roster of the board its owner is
    actually watching. Without it the dashboard falls back to its own board, and the
    sign-up then *appears* to succeed while the agent is nowhere the person looking for
    it would think to look — the roster is board-scoped, so "registered, but on some
    other board" reads as "not registered".

    Resolved the same way every other tool here resolves a workspace, and through the
    same function (``_find_beads_db_in_tree``), so this cannot become a second
    board-resolution path: the explicit workspace if one was set, otherwise a walk up
    from the working directory, redirects and worktrees included. That function returns
    a workspace *root* in every branch — including the redirect branch, which returns
    the parent of the redirected ``.beads`` — so appending ``.beads`` is right in all of
    them, and the registry stores exactly that (see ``board_dir`` in
    :mod:`beads_mcp.boards`).

    Returns ``""`` rather than a best guess when nothing is found, because a directory
    the registry does not know is now a hard ``409``: an omitted field falls back, while
    a wrong one fails the sign-up outright. The ``isdir`` check is the same rule applied
    to the value itself — only a directory that was actually seen on disk is sent.

    Note the residual case this cannot rule out: a board registered under a different
    spelling of the same directory (a symlinked checkout, say) resolves here to a path
    the registry has never seen, and the endpoint answers ``board_unregistered``. That
    is why the resolved directory is reported in the payload — so the ``409`` names the
    path that was not found instead of leaving the reader to guess which board it meant.
    """
    source = os.environ if env is None else env
    # `current_workspace` is set by the `with_workspace` decorator, which this tool does
    # not wear (it touches no board). Read anyway: it costs nothing, it keeps the
    # precedence identical to `tools._get_workspace_or_fail`, and it means the answer
    # stays right if this tool ever does become workspace-scoped.
    configured = str(current_workspace.get() or source.get("BEADS_WORKING_DIR") or "").strip()
    # Walked from the configured root rather than used as-is: a workspace root is not
    # necessarily the project root, and only the project root has the `.beads`.
    root = _find_beads_db_in_tree(configured or None)
    if not root:
        return ""
    board_dir = os.path.join(root, ".beads")
    return board_dir if os.path.isdir(board_dir) else ""


def _error_field(body: Mapping[str, Any], key: str) -> str:
    """Pull ``error.code`` / ``error.message`` out of the dashboard's envelope."""
    error = body.get("error")
    if not isinstance(error, Mapping):
        return ""
    return str(error.get(key) or "")


def _next_steps(has_mcp_url: bool) -> str:
    """What to do with a token that will never be shown again.

    Transport-specific, and the difference is the whole reason this is prose rather
    than a constant. Over HTTP the token rides on the request, so the agent is
    authenticated on its very next call. On stdio the server read
    ``FEADS_AGENT_TOKEN`` from its environment once at startup and cannot pick one up
    mid-session — so a token obtained here is real, recorded, and **not usable by this
    session**. Saying otherwise would send an agent into the exact loop this tool was
    supposed to end: sign up, still anonymous, sign up again, collide on the name.

    Nothing here adopts the token in-process to close that gap, and that restraint is
    deliberate. Writing it into ``os.environ`` would put a live credential where every
    ``bd`` subprocess inherits it and where ``admin(action="debug")`` dumps environment
    variables, in exchange for an identity that silently depends on tool-call order.
    """
    once = (
        "This token is returned exactly once — only a hash is stored, so nobody, "
        "including your human, can show it to you again. Keep it for the rest of this "
        "session and do not paste it into a file the board tracks."
    )
    if serving_http():
        return (
            f"{once} Send it on every later call as an `Authorization: Bearer <token>` "
            "header. This server reads the token off each request, so nothing needs "
            "restarting — your next call is already authenticated. Call agent_whoami to "
            "confirm, and do not call agent_signup again: you have an identity now."
        )
    return (
        f"{once} This session cannot use it: a stdio server reads "
        f"{AGENT_TOKEN_ENV} from its environment once at startup, so it takes effect "
        "only after your human puts it in the `env` block of this server's MCP entry and "
        "restarts the server. Hand it over and carry on unidentified until then — do "
        "**not** call agent_signup again while you wait, because the row already exists: "
        "the same name is refused as `name_taken`, and a different one would create a "
        "second identity that does not own the first one's items."
        + (
            " The token also works immediately against the HTTP endpoint reported as "
            "`mcp_url`, if one is being served."
            if has_mcp_url
            else ""
        )
    )


def _contains_native_credential(value: Any) -> bool:
    """Reject credential-shaped material from an internal route response."""
    if isinstance(value, str):
        return _TOKEN_PATTERN.search(value) is not None
    if isinstance(value, Mapping):
        return any(
            (isinstance(key, str) and "token" in key.casefold()) or _contains_native_credential(nested)
            for key, nested in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(_contains_native_credential(item) for item in value)
    return False


def _valid_sso_internal_secret(secret: str) -> bool:
    """Match the Node silo secret contract without exposing the secret."""
    if _SSO_SECRET_HEX_PATTERN.fullmatch(secret) and len(secret) >= _SSO_SECRET_MIN_BYTES * 2:
        return True
    if not _SSO_SECRET_BASE64URL_PATTERN.fullmatch(secret) or len(secret) < 43:
        return False
    try:
        decoded = base64.urlsafe_b64decode(secret + "=" * (-len(secret) % 4))
    except (ValueError, binascii.Error):
        return False
    return (
        len(decoded) >= _SSO_SECRET_MIN_BYTES and base64.urlsafe_b64encode(decoded).decode().rstrip("=") == secret
    )


def _native_sso_credentials(env: Mapping[str, str] | None = None) -> None:
    """No trusted edge identity or hosted SSO provider ships with this release."""
    return None


def _post_internal_sso_json(
    url: str,
    method: str,
    request_body: Mapping[str, Any],
    email: str,
    secret: str,
) -> tuple[int, Any, str]:
    """Send a silo mutation with the private SSO door, never a bearer or actor."""
    body = dict(request_body)
    body["sso_email"] = email
    request = Request(
        url,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        method=method,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "X-Feads-Sso-Internal": secret,
        },
    )
    try:
        with urlopen(request, timeout=SSO_RESOLVE_TIMEOUT_SECONDS) as response:
            return _read_body(int(response.status), response)
    except HTTPError as error:
        with error:
            return _read_body(int(error.code), error)
    except OSError as error:
        raise DashboardUnreachableError(f"{type(error).__name__}") from error


def _flare_request(
    method: str, issue_id: str, board: str = "", env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    url = f"{dashboard_url(env)}/api/flares"
    try:
        in_silo = silo_configured(env)
    except ActorResolutionError:
        return {"ok": False, "error": "forbidden"}
    native_credentials = _native_sso_credentials(env)
    if in_silo:
        if native_credentials is None:
            return {"ok": False, "error": "forbidden"}
        email, secret = native_credentials
        try:
            status, payload, _raw = _post_internal_sso_json(
                url, method, {"board_id": board, "issue_id": issue_id}, email, secret
            )
        except DashboardUnreachableError:
            return {"ok": False, "error": "dashboard_unreachable"}
        if (
            status >= 400
            or not isinstance(payload, Mapping)
            or payload.get("ok") is not True
            or _contains_native_credential(payload)
        ):
            return {"ok": False, "error": "not_identified" if status == 401 else "forbidden"}
        return dict(payload)

    # The caller's own credential: the request's bearer over HTTP, never the server's
    # FEADS_AGENT_TOKEN (the host's identity, which the hosted server does not even hold).
    token = request_credential(env)
    if not token:
        edge_email = accounts_edge_email(env)
        if edge_email:
            return _edge_flare_request(method, issue_id, board, edge_email, env)
        return {"ok": False, "error": "forbidden", "message": "a live agent bearer token is required"}
    body = json.dumps({"board_id": board, "issue_id": issue_id}).encode("utf-8")
    request = Request(
        url,
        data=body,
        method=method,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urlopen(request, timeout=SIGNUP_TIMEOUT_SECONDS) as response:
            _, payload, raw = _read_body(int(response.status), response)
    except HTTPError as error:
        with error:
            _, payload, raw = _read_body(int(error.code), error)
    except OSError as error:
        return {"ok": False, "error": "dashboard_unreachable", "message": str(error)}
    return (
        payload
        if isinstance(payload, dict)
        else {"ok": False, "error": "unexpected_response", "message": _scrub(raw)}
    )


ACCOUNTS_INTERNAL_FLARES_PATH = "/api/accounts/internal/flares"


def _edge_flare_request(
    method: str, issue_id: str, board: str, email: str, env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """An MCP-edge user's flare, through the dashboard's loopback accounts-internal door
    (``ui/server/accounts-internal-edge.js``): the per-boot accounts secret plus the email
    this request was resolved from. Never a bearer, never an actor."""
    source = os.environ if env is None else env
    secret = str(source.get(_accounts.ACCOUNTS_INTERNAL_SECRET_ENV, "") or "").strip()
    if len(secret) < 32:
        return {
            "ok": False,
            "error": "forbidden",
            "message": "the dashboard's accounts internal door is not configured",
        }
    request = Request(
        f"{dashboard_url(env)}{ACCOUNTS_INTERNAL_FLARES_PATH}",
        data=json.dumps({"board_id": board, "issue_id": issue_id, "email": email}, separators=(",", ":")).encode(
            "utf-8"
        ),
        method=method,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            _accounts.ACCOUNTS_INTERNAL_HEADER: secret,
        },
    )
    try:
        with urlopen(request, timeout=SIGNUP_TIMEOUT_SECONDS) as response:
            status, payload, raw = _read_body(int(response.status), response)
    except HTTPError as error:
        with error:
            status, payload, raw = _read_body(int(error.code), error)
    except OSError:
        return {"ok": False, "error": "dashboard_unreachable"}
    if not isinstance(payload, Mapping):
        return {"ok": False, "error": "unexpected_response", "message": _scrub(raw)}
    if status >= 400 or payload.get("ok") is not True:
        return {"ok": False, "error": "not_identified" if status == 401 else "forbidden"}
    return dict(payload)


def flare_heartbeat_payload(
    issue_id: str, board: str = "", env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    return _flare_request("PUT", issue_id, board, env)


def flare_drop_payload(issue_id: str, board: str = "", env: Mapping[str, str] | None = None) -> dict[str, Any]:
    return _flare_request("DELETE", issue_id, board, env)


def agent_delegate_payload(
    handle: str,
    display_name: str = "",
    ttl_ms: int | None = None,
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
) -> dict[str, Any]:
    try:
        silo_configured(env)
    except ActorResolutionError:
        return {"created": False, "code": "forbidden", "reason": "invalid silo configuration"}
    resolved = resolve_identity(env, db_path)
    # The parent is the caller: the request's own bearer over HTTP (the env token only
    # on stdio). A delegated child inherits that credential's owner, so there is no
    # parent to delegate from without one.
    token = request_credential(env)
    if resolved.get("via") == "worker_email" and not token:
        # Orchestrator decision (d), 2026-10-05: an MCP-edge user has no bearer to
        # delegate from (the Worker strips Authorization), so delegation is refused.
        return {
            "created": False,
            "code": "forbidden",
            "reason": (
                "refused: agent_delegate needs a live parent bearer token, and a connection "
                "through the Feads MCP connector (MCP edge) carries none. Delegation is "
                "fail-open: launch the subagent without a lease, or connect an agent with a "
                "personal token (Access → Connect an agent) and delegate from that."
            ),
        }
    if not resolved["agent"] or not token:
        return {"created": False, "code": "forbidden", "reason": "a live parent bearer token is required"}
    body: dict[str, Any] = {"handle": handle}
    if display_name:
        body["display_name"] = display_name
    if ttl_ms is not None:
        body["ttl_ms"] = ttl_ms
    status, payload, raw = _post_delegate(f"{dashboard_url(env)}{DELEGATE_PATH}", body, token)
    if not isinstance(payload, Mapping):
        return {"created": False, "code": "unexpected_response", "reason": _scrub(raw)}
    if status >= 400 or payload.get("ok") is False:
        return {
            "created": False,
            "code": _error_field(payload, "code") or f"http_{status}",
            "reason": _error_field(payload, "message") or f"HTTP {status}",
        }
    return dict(payload)


def agent_signup_payload(
    display_name: str,
    actor: str = "",
    env: Mapping[str, str] | None = None,
    db_path: str | None = None,
) -> dict[str, Any]:
    """Sign this agent up for an identity, and return the token exactly once.

    Order of business, and the order matters:

    1. **Ask the policy first, before any network call.** Signing up is
       ``mint_invite`` with ``role: 'user'``, which the shared policy already answers:
       allowed for an anonymous caller under ``operator`` and ``read_only``, refused
       under ``deny`` (which is what ``FEADS_REQUIRE_AGENT=1`` produces). A deployment
       that refuses sign-up must not see a signup attempt in its logs, and a refusal
       must not depend on the dashboard being up to be correct.
    2. **Refuse a caller that already has an identity**, rather than minting a second
       one. See below.
    3. Only then place the call.

    Why an identified caller is refused rather than served: a second identity is not a
    duplicate, it is a *different* agent. ``created_by`` on every item already filed
    names the first actor, and a ``user`` may delete only its own items — so the agent
    would silently lose the ability to delete work it did itself an hour earlier, with
    nothing in the failure to suggest why. The roster would show two live rows for one
    worker, which is precisely the collision-detection noise the registry exists to
    remove. And the caller almost certainly did not mean it: an agent that already has
    a token reaching this tool is a symptom of not having called ``agent_whoami``, so
    the useful answer is its own identity plus a pointer, not a new row. A human who
    genuinely wants a second agent has the dashboard and ``feads-agent invite``.

    Args:
        display_name: What the board should call this agent. Required.
        actor: Optional slug override; the dashboard derives one from the name when
            omitted. There is deliberately no ``role`` — see :data:`SIGNUP_ROLE`.
        env: Environment to resolve identity and the dashboard URL from. Test seam.
        db_path: Registry to resolve identity against. Test seam.

    Returns:
        On success, ``created: True`` with ``token``, the resolved ``identity``, and
        ``next_steps`` saying what to do with a token that will not be shown again. On
        failure, ``created: False`` with a ``code`` from :data:`FailureCode`, the
        ``reason`` verbatim from whoever refused, and a ``hint`` naming the next move.
    """
    resolved = resolve_identity(env, db_path)
    agent = resolved["agent"]
    stance = resolved["stance"]
    where = dashboard_url(env)
    url = f"{where}{SIGNUP_PATH}"
    board_dir = _board_dir(env)

    # Reported on every outcome, success included: "which dashboard did this talk to"
    # is the first thing to check when the answer is surprising, and an agent cannot
    # read our environment to find out. `board_dir` is here for the sharper version of
    # the same problem — a `board_unregistered` refusal is unreadable unless it names the
    # directory that was not found.
    base: dict[str, Any] = {
        "dashboard_url": where,
        "signup_url": url,
        "mode": resolved["mode"],
        "stance": stance,
        "role": SIGNUP_ROLE,
        "surface": SURFACE,
        "board_dir": board_dir,
    }

    # (1) Authorization first — and asked of the shared policy rather than re-derived,
    # so this surface cannot come to a different answer than the dashboard's own route,
    # which asks the identical question (`mint_invite`, `role: 'user'`). A rejected
    # credential is refused here too, by the same rule that refuses it everywhere:
    # falling back to open sign-up for a revoked agent would let revocation be undone
    # by the surface that exists to hand out identities.
    gate = decide(
        agent,
        "mint_invite",
        {"role": SIGNUP_ROLE},
        unidentified=stance,
        credential_rejected=resolved["credential_rejected"],
    )
    if not gate["allowed"]:
        logger.info("agent signup refused by policy: %s", gate["reason"])
        return _refusal(base, "forbidden", gate["reason"])

    # (2) Already identified. Note this is checked *after* the policy question, which
    # an identified agent passes — sign-up is open to every tier — so the ordering is
    # not a shortcut. It keeps "the policy is consulted first" literally true.
    if agent is not None:
        return _refusal(
            base,
            "already_identified",
            (
                f"you are already registered as {agent['actor']} "
                f"({agent['role']}, resolved via {resolved['via']}) — signing up again would "
                "create a second, different agent that does not own this one's items"
            ),
            identity=resolved["identity"],
            hint=(
                "You do not need a new identity. Call agent_whoami to see what this one may "
                "do. If your human genuinely wants a second agent, they can create it on the "
                "dashboard or mint an invite with `feads-agent invite --name <name>`."
            ),
        )

    # (3) The name, checked here as well as at the endpoint. Not redundant: a round
    # trip to be told "you gave no name" is a round trip an agent waits on for nothing,
    # and the dashboard may be down — in which case a missing name would be reported as
    # `dashboard_unreachable`, sending the agent to fix the wrong thing. The endpoint's
    # own 400 is still translated below, because this check being here does not make
    # that one stop existing.
    name = str(display_name or "").strip()
    if not name:
        return _refusal(
            base,
            "bad_request",
            "give the agent a name so its work can be attributed to it",
        )

    # `surface` is always sent; the other two are omitted when empty rather than sent
    # blank, so the dashboard's own defaults (derive a slug from the display name; fall
    # back to its own board) stay in one place instead of being half-decided here.
    #
    # An endpoint that predates either field ignores it — express drops body keys it does
    # not read — so nothing here depends on them being honoured, and no version probe is
    # needed. Concretely: an older endpoint records the agent as `kind: 'human'` and
    # attaches it to its own board, and that is a **successful sign-up**. The token is
    # valid and usable either way, nothing in this module reads `kind` (it is not even in
    # the identity projection), and treating a provenance label as a failure would refuse
    # an identity that works.
    request_body = {"display_name": name, "surface": SURFACE}
    slug = str(actor or "").strip()
    if slug:
        request_body["actor"] = slug
    if board_dir:
        request_body["board_dir"] = board_dir

    try:
        status, body, raw = _post_signup(url, request_body)
    except DashboardUnreachableError as error:
        logger.info("agent signup could not reach %s: %s", url, error)
        return _refusal(
            base,
            "dashboard_unreachable",
            f"nothing answered at {url} ({error})",
            # Written out here rather than in `_HINTS` because it is the one hint that
            # has to name the URL, and a hint that says "the dashboard" without saying
            # *which* dashboard is what makes this failure look like a refusal.
            hint=(
                f"The feads dashboard is not running at {where}, or is running somewhere "
                "else — this is not a refusal, and your request was fine. Ask your human to "
                f"start it (`make run`), or to set ${DASHBOARD_URL_ENV} on this server if the "
                "dashboard is on another port. Failing that, they can sign up in the browser "
                "and set the token as FEADS_AGENT_TOKEN in your environment themselves (a "
                "token never goes in chat); that path needs nothing from you. This is the one "
                "part of getting an identity you cannot do yourself."
            ),
        )

    if not isinstance(body, Mapping):
        return _refusal(
            base,
            "unexpected_response",
            # Scrubbed and truncated. A body we could not parse is the one case where we
            # relay bytes we never predicted, so it is also the one case that could carry
            # a token — see `_TOKEN_PATTERN`.
            f"HTTP {status} from {url} with a body that is not the JSON this endpoint "
            f"returns: {_scrub(raw)[:200]!r}",
            status=status,
        )

    if status >= 400 or body.get("ok") is False:
        # The dashboard's code is used verbatim where it has one, rather than being
        # re-derived from the status: two different 409s (`board_unregistered` and
        # `name_taken`) want different actions, and the status cannot tell them apart.
        # `http_<status>` is the fallback for a future code this build has not been
        # taught, and it is deliberately not a friendly synonym — a code an agent has
        # never seen should look unfamiliar rather than be silently folded into one of
        # ours.
        code = _error_field(body, "code") or f"http_{status}"
        message = _error_field(body, "message") or f"HTTP {status} from {url}"
        logger.info("agent signup refused: %s (HTTP %s)", code, status)
        # Cast: `code` may be a string outside FailureCode when the endpoint grows a new
        # one. Reported as-is on purpose (see above) — the Literal documents what this
        # build knows, not what the wire may carry.
        return _refusal(base, code, message, status=status)  # type: ignore[arg-type]

    token = str(body.get("token") or "")
    if not token:
        # A 2xx with no token. The endpoint promises exactly one, and its own 500 path
        # covers the case it can see; this covers a 200 that somehow carries none — the
        # agent may exist and be unauthenticatable, which is the same predicament and
        # gets the same code and hint rather than a novel one.
        return _refusal(
            base,
            "registry_failed",
            f"HTTP {status} from {url} reported success but returned no token",
            status=status,
        )

    identity = body.get("identity") if isinstance(body.get("identity"), Mapping) else None
    mcp_url = str(body.get("mcp_url") or "")
    # The actor as *recorded*, not as requested: the dashboard slugifies the display
    # name, and an agent needs the recorded value because that is what `created_by`
    # will hold and what a delete decision is compared against.
    recorded_actor = str((identity or {}).get("actor") or name)

    # Logged by actor and never by token — this whole file is grep-checked for that in
    # `tests/test_agent_signup.py`. Note `raw` is never logged either: on this path it
    # contains the credential.
    logger.info("agent signup created %s via %s", recorded_actor, url)

    payload = dict(base)
    payload.update(
        {
            "created": True,
            "token": token,
            "token_shown_once": True,
            "identity": identity,
            "actor": recorded_actor,
            # Which board the new agent was actually attached to, as the *registry* id.
            # Normally the board named in `board_dir` above, but reported rather than
            # assumed: it is the dashboard's fallback board when we could not resolve one,
            # and an endpoint predating `board_dir` ignores ours entirely.
            #
            # Worth having either way, because identity is deliberately not scoped by
            # board — `resolve_agent_identity` leaves `board_id` empty on purpose, so an
            # agent registered against one board is recognized while working on another.
            # What this does decide is which board's *roster* the new agent shows up in,
            # which is what collision detection reads.
            "board_id": str((identity or {}).get("board_id") or ""),
            "mcp_url": mcp_url,
            "next_steps": _next_steps(bool(mcp_url)),
        }
    )
    # Say what board_id is for at the one moment every agent reads its own
    # identity closely — right after minting it (feads-dzn).
    payload.update(HOME_BOARD_NOTE)
    return payload
