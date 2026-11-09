"""A one-line "you have unread @mentions" nudge on every tool response.

Agents coordinate by @mentioning each other; a mention only helps if the agent it is
for notices it while it is still working, not at its next session start. So every tool
result for an identified caller with unhandled mentions carries one extra text block:

    {"unread_mentions": 2, "hint": "2 unread @mentions — notifications(view='mentions') ..."}

Additive and bounded: the block is appended after the tool's own content (structured
output is untouched), the count is cached per credential for a few seconds (one small
registry read at most per window), and any failure — no identity, unreadable registry,
anything — leaves the result exactly as the tool returned it. Never fails a call.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from typing import Any

from fastmcp.server.middleware import Middleware

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 20.0
_CACHE_MAX = 512

# Tools whose own answer already is (or replaces) the inbox summary.
SKIP_TOOLS = frozenset({"notifications", "notifications_ack", "agent_whoami", "discover_tools", "get_tool_info"})

_cache: dict[str, tuple[float, int]] = {}


def hint_text(count: int) -> str:
    return (
        f"{count} unread @mention(s) — other agents are talking to you. Call "
        "notifications(view='mentions'), reply in each item with @<who mentioned you> when useful, "
        "then notifications_ack(ids=[...]). Coordinate, don't block: never wait for a reply."
    )


def _credential_key() -> str:
    """A cache key for the caller's credential (hashed), or ``""`` when there is none."""
    from beads_mcp.agents import AGENT_TOKEN_ENV
    from beads_mcp.transport import bearer_token, serving_http

    parts = []
    token = bearer_token()
    if token:
        parts.append(f"b:{token}")
    if not parts and not serving_http():
        env_token = str(os.environ.get(AGENT_TOKEN_ENV, "") or "").strip()
        if env_token:
            parts.append(f"e:{env_token}")
    if not parts:
        return ""
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _count_for_caller() -> int:
    """Resolve the caller (same resolution the tools use) and count unhandled mentions."""
    from beads_mcp.agents import resolve_identity
    from beads_mcp.notifications import unread_mention_count

    resolved = resolve_identity()
    if resolved.get("credential_rejected"):
        return 0
    principal = resolved.get("principal") or {}
    if principal.get("kind") == "system":
        return 0
    agent = resolved.get("agent")
    actor = str(agent["actor"]) if agent is not None else ""
    return unread_mention_count(actor) if actor else 0


async def unread_mentions_for_caller(now: float | None = None) -> int:
    """Cached unhandled-mention count for the current caller; 0 on any failure."""
    try:
        key = _credential_key()
        if not key:
            return 0
        now = time.monotonic() if now is None else now
        hit = _cache.get(key)
        if hit is not None and now - hit[0] < CACHE_TTL_SECONDS:
            return hit[1]
        count = await asyncio.to_thread(_count_for_caller)
        if len(_cache) >= _CACHE_MAX:
            _cache.clear()
        _cache[key] = (now, count)
        return count
    except Exception as exc:  # noqa: BLE001 - a nudge must never fail a call
        logger.debug(f"unread mention hint unavailable: {exc}")
        return 0


def forget_caller() -> None:
    """Drop the current caller's cached count (after an ack)."""
    try:
        key = _credential_key()
        if key:
            _cache.pop(key, None)
    except Exception:  # noqa: BLE001
        pass


def reset_cache() -> None:
    _cache.clear()


class MentionHintMiddleware(Middleware):
    """Appends ``{"unread_mentions": n, "hint": ...}`` to tool results when n > 0."""

    async def on_call_tool(self, context: Any, call_next: Any) -> Any:
        result = await call_next(context)
        try:
            name = str(getattr(context.message, "name", "") or "")
            if name == "notifications_ack":
                forget_caller()
                return result
            if name in SKIP_TOOLS:
                return result
            count = await unread_mentions_for_caller()
            if count <= 0:
                return result
            from mcp.types import TextContent

            block = TextContent(
                type="text",
                text=json.dumps({"unread_mentions": count, "hint": hint_text(count)}),
            )
            content = getattr(result, "content", None)
            if isinstance(content, list):
                content.append(block)
        except Exception as exc:  # noqa: BLE001 - a nudge must never fail a call
            logger.debug(f"unread mention hint skipped: {exc}")
        return result
