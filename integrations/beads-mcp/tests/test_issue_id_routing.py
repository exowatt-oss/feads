"""Issue-id → board auto-routing (feads-jq6).

A call that names an issue id has already named its board: ids are minted as
``<prefix>-<suffix>`` and prefixes are unique per board. These tests pin the
resolution order (explicit param > issue id > session context > env), the
longest-prefix match, the deps parsing, the fail-open contract, and that the
whole feature stays off without FEADS_PG_DSN.
"""

import os
from unittest.mock import AsyncMock, patch

import pytest

import beads_mcp.server as server
from beads_mcp.server import (
    _candidate_issue_ids,
    _workspace_for_issue_ids,
    with_workspace,
)
from beads_mcp.tools import current_workspace, workspace_was_explicit


def _reset_cache() -> None:
    server._id_routing_cache["at"] = 0.0
    server._id_routing_cache["prefixes"] = {}
    server._id_routing_cache["workspaces"] = {}


# ---------------------------------------------------------------------------
# _candidate_issue_ids: which kwargs name an issue
# ---------------------------------------------------------------------------


def test_candidates_orders_issue_id_first():
    ids = _candidate_issue_ids({"issue_id": "it-7sy", "depends_on_id": "lab-2a2"})
    assert ids == ["it-7sy", "lab-2a2"]


def test_candidates_reads_lists_and_deps():
    ids = _candidate_issue_ids(
        {
            "issue_ids": ["forca-1rh", "forca-2aa"],
            "deps": ["parent-child:feads-f22", "blocks:it-9", "ac-ob0"],
        }
    )
    assert ids == ["forca-1rh", "forca-2aa", "feads-f22", "it-9", "ac-ob0"]


def test_candidates_skips_non_ids():
    assert _candidate_issue_ids({"issue_id": "nohyphen", "id": None, "deps": [42]}) == []


# ---------------------------------------------------------------------------
# _workspace_for_issue_ids: resolution and fail-open
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_routing_disabled_without_pg_dsn(monkeypatch):
    _reset_cache()
    monkeypatch.delenv("FEADS_PG_DSN", raising=False)
    assert await _workspace_for_issue_ids({"issue_id": "it-7sy"}) is None


@pytest.mark.asyncio
async def test_routing_resolves_board_workspace(monkeypatch):
    _reset_cache()
    monkeypatch.setenv("FEADS_PG_DSN", "postgresql://x")
    with (
        patch.object(server.pgstore, "list_board_prefixes", AsyncMock(return_value={"it": "it"})),
        patch.object(server, "_resolve_board_workspace", AsyncMock(return_value="/var/lib/feads/boards/it")),
    ):
        assert await _workspace_for_issue_ids({"issue_id": "it-7sy"}) == "/var/lib/feads/boards/it"


@pytest.mark.asyncio
async def test_routing_prefers_longest_prefix(monkeypatch):
    _reset_cache()
    monkeypatch.setenv("FEADS_PG_DSN", "postgresql://x")
    prefixes = {"app": "app", "sample-platform": "sample-platform"}
    resolve = AsyncMock(return_value="/var/lib/feads/boards/sample-platform")
    with (
        patch.object(server.pgstore, "list_board_prefixes", AsyncMock(return_value=prefixes)),
        patch.object(server, "_resolve_board_workspace", resolve),
    ):
        result = await _workspace_for_issue_ids({"issue_id": "sample-platform-3kf"})
    assert result == "/var/lib/feads/boards/sample-platform"
    resolve.assert_awaited_once_with("sample-platform")


@pytest.mark.asyncio
async def test_routing_unknown_prefix_falls_through(monkeypatch):
    _reset_cache()
    monkeypatch.setenv("FEADS_PG_DSN", "postgresql://x")
    with patch.object(server.pgstore, "list_board_prefixes", AsyncMock(return_value={"it": "it"})):
        assert await _workspace_for_issue_ids({"issue_id": "zz-1"}) is None


@pytest.mark.asyncio
async def test_routing_fails_open_on_store_error(monkeypatch):
    _reset_cache()
    monkeypatch.setenv("FEADS_PG_DSN", "postgresql://x")
    with patch.object(server.pgstore, "list_board_prefixes", AsyncMock(side_effect=RuntimeError("pg down"))):
        assert await _workspace_for_issue_ids({"issue_id": "it-7sy"}) is None


@pytest.mark.asyncio
async def test_routing_caches_unresolvable_board(monkeypatch):
    _reset_cache()
    monkeypatch.setenv("FEADS_PG_DSN", "postgresql://x")
    resolve = AsyncMock(return_value="Error: no such board: it")
    with (
        patch.object(server.pgstore, "list_board_prefixes", AsyncMock(return_value={"it": "it"})),
        patch.object(server, "_resolve_board_workspace", resolve),
    ):
        assert await _workspace_for_issue_ids({"issue_id": "it-7sy"}) is None
        assert await _workspace_for_issue_ids({"issue_id": "it-8aa"}) is None
    resolve.assert_awaited_once()  # the failure was cached, not retried per call


# ---------------------------------------------------------------------------
# with_workspace: precedence end to end
# ---------------------------------------------------------------------------


def _capture_tool():
    captured: dict[str, object] = {}

    @with_workspace
    async def tool(**kwargs):
        captured["workspace"] = current_workspace.get()
        captured["explicit"] = workspace_was_explicit.get()
        return "ok"

    return tool, captured


@pytest.mark.asyncio
async def test_with_workspace_uses_issue_id_board(monkeypatch):
    _reset_cache()
    monkeypatch.setenv("FEADS_PG_DSN", "postgresql://x")
    monkeypatch.delenv("BEADS_WORKING_DIR", raising=False)
    tool, captured = _capture_tool()
    with (
        patch.object(server, "_session_context", return_value={}),
        patch.object(server.pgstore, "list_board_prefixes", AsyncMock(return_value={"it": "it"})),
        patch.object(server, "_resolve_board_workspace", AsyncMock(return_value="/boards/it")),
    ):
        assert await tool(issue_id="it-7sy") == "ok"
    assert captured["workspace"] == "/boards/it"
    assert captured["explicit"] is True


@pytest.mark.asyncio
async def test_with_workspace_issue_id_outranks_session(monkeypatch):
    """Answering a mention on another board must not require a context switch."""
    _reset_cache()
    monkeypatch.setenv("FEADS_PG_DSN", "postgresql://x")
    tool, captured = _capture_tool()
    session = {"BEADS_WORKING_DIR": "/boards/lab", "BEADS_WORKSPACE_EXPLICIT": "1"}
    with (
        patch.object(server, "_session_context", return_value=session),
        patch.object(server.pgstore, "list_board_prefixes", AsyncMock(return_value={"it": "it"})),
        patch.object(server, "_resolve_board_workspace", AsyncMock(return_value="/boards/it")),
    ):
        await tool(issue_id="it-7sy")
    assert captured["workspace"] == "/boards/it"


@pytest.mark.asyncio
async def test_with_workspace_explicit_param_outranks_issue_id(monkeypatch):
    _reset_cache()
    monkeypatch.setenv("FEADS_PG_DSN", "postgresql://x")
    tool, captured = _capture_tool()
    lookup = AsyncMock(return_value={"it": "it"})
    with (
        patch.object(server, "_session_context", return_value={}),
        patch.object(server.pgstore, "list_board_prefixes", lookup),
    ):
        await tool(issue_id="it-7sy", workspace_root="/named/elsewhere")
    assert captured["workspace"] == "/named/elsewhere"
    lookup.assert_not_awaited()  # no routing work when the caller named a workspace


@pytest.mark.asyncio
async def test_with_workspace_falls_back_to_session_when_unroutable(monkeypatch):
    _reset_cache()
    monkeypatch.setenv("FEADS_PG_DSN", "postgresql://x")
    tool, captured = _capture_tool()
    session = {"BEADS_WORKING_DIR": "/boards/lab", "BEADS_WORKSPACE_EXPLICIT": "1"}
    with (
        patch.object(server, "_session_context", return_value=session),
        patch.object(server.pgstore, "list_board_prefixes", AsyncMock(return_value={"it": "it"})),
    ):
        await tool(issue_id="zz-1")
    assert captured["workspace"] == "/boards/lab"
    assert captured["explicit"] is True
