"""How a credential and a transport arrive — and what that implies about trust.

Three layers, and the dependency arrow only points one way:

- :mod:`beads_mcp.authz` — what a caller may do, given who it is. Knows nothing
  about servers.
- :mod:`beads_mcp.agents` — who is calling, resolved from the registry.
- **this module** — how the credential reached us, and which stance that earns.

It exists because the answer to "may an unidentified caller act?" is not a property
of the policy or of the registry. It is a property of *the pipe the call came in
on*, and getting that wrong is a live vulnerability rather than a style question.

## The stance depends on the transport, and it has to

``boards/authz.mjs`` justifies the ``operator`` stance with one sentence: *whoever
can reach this already owns the database file.* That is true of stdio — the server
is a subprocess of the agent, on the agent's machine, reading a SQLite file the
agent can open itself — and it is simply **false** of HTTP, where the caller is
whoever can reach a port. Holding the stance at ``operator`` for both would mean an
unauthenticated HTTP request is the operator, and the operator may delete any item
on any board (``admin(action="pollution", clean=True)``) and mint itself an *admin*
invite. Revoking an agent would be pointless: it could just stop sending its token.

This is not hypothetical. ``scripts/feads-run.sh`` starts this server over HTTP by
default (``--http``, port ``FEADS_MCP_PORT``, default 4143), so the HTTP path is the
normal configuration rather than an exotic one. It binds loopback by default, which
narrows the blast radius to processes on the same machine — but ``FEADS_HOST`` is a
documented knob, and a stance that is only safe until someone sets a documented knob
is not a safe stance.

So: ``operator`` on stdio, ``read_only`` on HTTP.

**Do not "simplify" this to a single stance.** ``read_only`` over HTTP is not
excessive caution; it is the only reading of that pipe that is true. And ``operator``
on stdio is not laziness either — see :data:`MCP_STDIO_STANCE` for why stdio
specifically *cannot* offer the read-only bargain that makes it right for a browser.

## What ``read_only`` still allows, deliberately

Reads, and **sign-up** — ``mint_invite`` for the ``user`` tier. An anonymous caller
must be able to obtain an identity, or "present a credential" is a closed loop. The
admin tier stays gated, so sign-up cannot be a self-promotion button. All of that is
the shared policy's doing, not this module's; see ``decide`` in
:mod:`beads_mcp.authz`. This module only chooses *which stance to ask under*.
"""

import os
from collections.abc import Mapping

from beads_mcp.authz import StanceName, stance_for


# What an unidentified caller is treated as, per transport.
#
# stdio — `operator`. The server is a subprocess of the agent that launched it,
# reading a registry that agent can open with sqlite3 itself, so refusing its writes
# would be a locked door in a room with no walls. The load-bearing reason is not
# "it would break today's unregistered agents" (true, but that expires): it is that
# **stdio cannot make the read-only offer**. What earns a browser `read_only` is a
# login box — "you may look; sign in to act" is an offer the user can accept on the
# spot. Here the credential arrives from the process environment at startup, so an
# agent refused mid-session has no way to present one without its human restarting
# the server with a different environment. Refusing it is not an invitation to
# authenticate; it is a dead end.
MCP_STDIO_STANCE: StanceName = "operator"

# HTTP — `read_only`. The caller is whoever reached the port, the *server* holds the
# database, and "they could run `bd` anyway" stops being true. This is the same
# position the browser is in, and it gets the same answer: read the board, sign up
# for an identity, present a token to do anything else. Unlike stdio, that offer is
# real here — the token rides on the request (see `bearer_token`), so a caller can
# act on the refusal immediately without restarting anything.
MCP_HTTP_STANCE: StanceName = "read_only"

# The credential header, and the only scheme read from it. A non-Bearer scheme is
# treated as "no credential presented" rather than as a rejected one: `Basic` or a
# proxy's own `Negotiate` is not an agent credential failing to verify, it is
# somebody else's header, and refusing every gated call because a proxy added one
# would be a denial of service with a security-shaped explanation. A `Bearer` token
# that is not a valid agent token *is* a rejection — that is the shared resolution
# contract's job, not this module's.
AUTHORIZATION_HEADER = "authorization"
BEARER_SCHEME = "bearer"

# Where the human signs in or signs up. Overridable because the port is: the
# launcher (`scripts/feads-run.sh`) serves the dashboard on `FEADS_PORT`, default
# 4141, and does not currently pass that choice down to this process — so the
# default below is the launcher's documented default rather than an observed fact,
# and this variable is how a non-default deployment corrects it.
DASHBOARD_URL_ENV = "FEADS_DASHBOARD_URL"
DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4141"

# Where a human's *browser* reaches the dashboard, when that differs from where
# this process reaches it. A hosted deployment proxies ack/signup to the
# dashboard over loopback (FEADS_DASHBOARD_URL) while people browse it behind
# a public hostname — links composed into notification rows must use the
# latter or every URL handed to a human points at somebody else's localhost.
PUBLIC_URL_ENV = "FEADS_PUBLIC_URL"

# Set once, at startup, by the entry point that chose the transport. A module global
# rather than a parameter threaded through every call site because it describes the
# *process*: one server serves one transport for its lifetime, and passing it down
# through `authorize` into `decide` would be plumbing that buys nothing.
_http_transport = False


def set_http_transport(enabled: bool = True) -> None:
    """Record that this process serves HTTP rather than stdio.

    Called by the entry point in :mod:`beads_mcp.server` once the transport is
    known. Not needed for correctness on the request path — :func:`serving_http`
    also detects an active HTTP request on its own — but it makes the stance right
    for anything that runs *outside* a request on an HTTP server, and it makes the
    choice visible at startup instead of implicit.
    """
    global _http_transport
    _http_transport = enabled


def serving_http() -> bool:
    """Whether this call should be treated as arriving over HTTP.

    Two independent signals, and **either one is enough**, because both failure
    modes of a single signal fail open — which here means handing an anonymous
    network caller the operator's delete rights:

    1. The startup flag (:func:`set_http_transport`). Authoritative when the server
       was launched through this package's entry point.
    2. An active HTTP request context. This is what covers the case the flag cannot:
       ``mcp`` is an importable module-level object, so an embedder can mount it in
       their own ASGI app with uvicorn and never call our ``main()``. The flag would
       be ``False`` there and the stance would silently become ``operator`` over a
       real network socket.

    Note that the *absence* of headers proves nothing: FastMCP's
    ``get_http_headers()`` strips ``host``, ``content-type``, ``content-length`` and
    ``accept`` by default, which is very nearly the entire header set of a minimal
    MCP POST — so an empty dict is a perfectly normal HTTP request and must never be
    read as "this is stdio". The request *context* is the signal; the headers are
    only cargo.
    """
    if _http_transport:
        return True
    try:
        from fastmcp.server.dependencies import get_http_request

        get_http_request()
    except (ImportError, RuntimeError):
        # RuntimeError: no active request — stdio, or an HTTP server between
        # requests. ImportError: a FastMCP without the dependency helpers, in which
        # case there is no HTTP request to be in.
        return False
    return True


def bearer_token() -> str:
    """The agent token presented on this HTTP request, or ``""``.

    ``Authorization: Bearer fdsa_…``. Returns the empty string on stdio, where
    there is no request to read, so the caller falls back to the environment.

    The trap this function exists to absorb: FastMCP's ``get_http_headers()``
    **strips ``authorization`` by default** (it is on an exclusion list meant to stop
    credentials being forwarded to downstream services). Reading it requires opting
    back in with ``include={"authorization"}``, and without that this returns ``""``
    for a request that plainly carried a token — an authentication bug that looks
    exactly like a client sending the wrong header.
    """
    try:
        from fastmcp.server.dependencies import get_http_headers
    except ImportError:  # pragma: no cover - fastmcp always provides this
        return ""

    raw = str(get_http_headers(include={AUTHORIZATION_HEADER}).get(AUTHORIZATION_HEADER, "") or "").strip()
    if not raw:
        return ""
    scheme, _, credential = raw.partition(" ")
    if scheme.strip().lower() != BEARER_SCHEME:
        return ""
    return credential.strip()


# HTTP callers authenticate only with bearer tokens; no identity-header reader
# exists on this transport, irrespective of proxy address or environment.


def surface_stance(env: Mapping[str, str] | None = None) -> StanceName:
    """The stance this surface takes toward a caller that presented no identity.

    The transport picks the default; ``FEADS_REQUIRE_AGENT`` can then tighten it to
    ``deny`` but never loosen it, which is :func:`beads_mcp.authz.stance_for`'s
    guarantee rather than something re-derived here.
    """
    return stance_for(MCP_HTTP_STANCE if serving_http() else MCP_STDIO_STANCE, env)


def dashboard_url(env: Mapping[str, str] | None = None) -> str:
    """Where a human goes to sign in or sign up, for hints and instructions.

    Whitespace-stripped, trailing slash removed, and never empty: an agent is going
    to paste this into a sentence aimed at a person, and a blank or half-formed URL
    there is worse than the default being wrong, because the person cannot tell it is
    a placeholder. The ``or`` at the end also catches an override of ``"/"``, which
    would otherwise strip to nothing.
    """
    source = os.environ if env is None else env
    configured = str(source.get(DASHBOARD_URL_ENV, "") or "").strip().rstrip("/")
    return configured or DEFAULT_DASHBOARD_URL


def public_dashboard_url(env: Mapping[str, str] | None = None) -> str:
    """Where a human's browser reaches the dashboard, for links put in front of people.

    ``FEADS_PUBLIC_URL`` when set, else :func:`dashboard_url` — a single-host
    setup has no split to express, so the fallback keeps it zero-config there.
    Same normalization rules as :func:`dashboard_url`, for the same reason.
    """
    source = os.environ if env is None else env
    configured = str(source.get(PUBLIC_URL_ENV, "") or "").strip().rstrip("/")
    return configured or dashboard_url(env)
