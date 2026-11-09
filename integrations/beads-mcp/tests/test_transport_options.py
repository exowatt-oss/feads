"""Tests for transport selection (stdio by default, HTTP opt-in)."""

import pytest

from beads_mcp.server import (
    DEFAULT_HTTP_HOST,
    DEFAULT_HTTP_PATH,
    DEFAULT_HTTP_PORT,
    HTTP_TRANSPORT,
    _transport_options,
)


@pytest.fixture(autouse=True)
def clear_transport_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep an ambient FEADS_MCP_* setting from leaking into the defaults."""
    for name in ("FEADS_MCP_HTTP", "FEADS_MCP_HOST", "FEADS_MCP_PORT", "FEADS_MCP_PATH"):
        monkeypatch.delenv(name, raising=False)


class TestTransportOptions:
    """Tests for _transport_options()."""

    def test_no_args_is_stdio_only(self) -> None:
        """The default must stay exactly what Claude Code launches today."""
        assert _transport_options([]) == {"transport": "stdio"}

    def test_http_flag_enables_http_with_defaults(self) -> None:
        """--http switches transport and fills in the documented defaults."""
        assert _transport_options(["--http"]) == {
            "transport": HTTP_TRANSPORT,
            "host": DEFAULT_HTTP_HOST,
            "port": DEFAULT_HTTP_PORT,
            "path": DEFAULT_HTTP_PATH,
        }

    def test_http_env_var_enables_http(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """FEADS_MCP_HTTP=1 is equivalent to --http, for launchers that pass no args."""
        monkeypatch.setenv("FEADS_MCP_HTTP", "1")
        assert _transport_options([])["transport"] == HTTP_TRANSPORT

    def test_env_vars_set_host_port_and_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Bind address, port and path all come from the environment when set."""
        monkeypatch.setenv("FEADS_MCP_HTTP", "true")
        monkeypatch.setenv("FEADS_MCP_HOST", "0.0.0.0")
        monkeypatch.setenv("FEADS_MCP_PORT", "9999")
        monkeypatch.setenv("FEADS_MCP_PATH", "/beads")
        options = _transport_options([])
        assert options["host"] == "0.0.0.0"
        assert options["port"] == 9999
        assert options["path"] == "/beads"

    def test_flags_override_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Explicit flags win over the environment."""
        monkeypatch.setenv("FEADS_MCP_PORT", "9999")
        assert _transport_options(["--http", "--port", "5000"])["port"] == 5000

    def test_host_and_port_ignored_without_http(self) -> None:
        """Passing HTTP settings alone does not silently switch transports."""
        assert _transport_options(["--port", "5000"]) == {"transport": "stdio"}

    def test_no_http_flag_overrides_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """--no-http gets stdio back when the environment turned HTTP on machine-wide."""
        monkeypatch.setenv("FEADS_MCP_HTTP", "1")
        assert _transport_options(["--no-http"]) == {"transport": "stdio"}

    def test_non_numeric_port_is_a_usage_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A bad FEADS_MCP_PORT exits with argparse's message, not a traceback."""
        monkeypatch.setenv("FEADS_MCP_PORT", "not-a-port")
        with pytest.raises(SystemExit):
            _transport_options(["--http"])

    def test_http_transport_name_is_one_fastmcp_accepts(self) -> None:
        """Guard the transport string against a FastMCP rename."""
        assert HTTP_TRANSPORT in {"stdio", "http", "sse", "streamable-http"}
