"""Public MCP schema coverage for the hosted change and metadata surfaces."""

import pytest

from beads_mcp.server import mcp


@pytest.mark.asyncio
async def test_changes_and_metadata_are_exposed_in_public_tool_schemas() -> None:
    tools = {tool.name: tool for tool in await mcp.list_tools()}

    changes = tools["changes"]
    assert {"after_cursor", "since", "until", "boards", "limit"} <= set(changes.parameters["properties"])

    update = tools["update"]
    close = tools["close"]
    assert "metadata" in update.parameters["properties"]
    assert "metadata" in close.parameters["properties"]
