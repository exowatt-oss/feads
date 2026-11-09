"""The standalone MCP cannot be switched into hosted identity mode by env flags."""

from beads_mcp.accounts import accounts_enabled
import pytest

import beads_mcp.transport as transport
from beads_mcp.silo import configured_silo


def test_hosted_accounts_stay_disabled() -> None:
    assert not accounts_enabled({"FEADS_ACCOUNTS": "1", "FEADS_REGISTRY_DB": "/tmp/unused"})


def test_no_http_identity_header_reader() -> None:
    # HTTP supports bearer credentials, not proxy-supplied identity headers.
    assert not hasattr(transport, "worker_email")


def test_hosted_silo_refuses_to_start() -> None:
    assert configured_silo({}) is None
    with pytest.raises(ValueError, match="unavailable"):
        configured_silo({"FEADS_SILO": "demo"})
