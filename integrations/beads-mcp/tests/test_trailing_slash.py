"""Both /mcp and /mcp/ reach one endpoint without a redirect.

A redirect can drop an MCP client credential; the trailing-slash alias avoids it.
"""

from __future__ import annotations

import asyncio
import contextlib
import socket
from collections.abc import AsyncIterator

import httpx
import pytest
import uvicorn

from beads_mcp.server import DEFAULT_HTTP_PATH, _http_middleware, mcp

INIT = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}},
}
HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@contextlib.asynccontextmanager
async def _serving(with_alias: bool) -> AsyncIterator[str]:
    port = _free_port()
    app = mcp.http_app(
        path=DEFAULT_HTTP_PATH, middleware=_http_middleware(DEFAULT_HTTP_PATH) if with_alias else None
    )
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(200):
            if server.started:
                break
            await asyncio.sleep(0.05)
        assert server.started, "uvicorn did not start"
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(task, timeout=10)


async def _post(base: str, path: str) -> httpx.Response:
    async with httpx.AsyncClient(follow_redirects=False, timeout=10) as client:
        return await client.post(base + path, json=INIT, headers=HEADERS)


class TestTrailingSlashAlias:
    @pytest.mark.parametrize("path", ["/mcp", "/mcp/"])
    async def test_both_doors_answer_initialize_without_a_redirect(self, path: str) -> None:
        async with _serving(with_alias=True) as base:
            response = await _post(base, path)
        assert response.status_code == 200, (response.status_code, response.headers.get("location"))
        assert '"protocolVersion"' in response.text

    async def test_without_the_alias_the_slash_door_redirects(self) -> None:
        """Documents the failure the alias exists for (Starlette's slash redirect)."""
        async with _serving(with_alias=False) as base:
            response = await _post(base, "/mcp/")
        assert response.status_code in (307, 308)

    async def test_other_paths_are_untouched(self) -> None:
        async with _serving(with_alias=True) as base:
            response = await _post(base, "/mcp/extra")
        assert response.status_code == 404
