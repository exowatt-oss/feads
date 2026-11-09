"""Pytest configuration and fixtures for beads-mcp tests.

This module provides safety checks to prevent test pollution in production databases (bd-2c5a).
"""

import os
from pathlib import Path

import pytest

from beads_mcp.agents import request_authorization


@pytest.fixture(autouse=True)
def clear_request_authorization_context():
    """Keep direct authorization unit tests from seeding the next test task."""
    token = request_authorization.set(None)
    try:
        yield
    finally:
        request_authorization.reset(token)


def pytest_configure(config):
    """Called before test collection starts - ensure we're not polluting production."""
    # CRITICAL (bd-2c5a): Prevent tests from polluting production database

    # Set test mode flag
    os.environ["BEADS_TEST_MODE"] = "1"

    # Get the project root (where .git exists)
    current_dir = Path(__file__).parent.absolute()
    project_root = current_dir

    while project_root.parent != project_root:
        if (project_root / ".git").exists():
            break
        project_root = project_root.parent

    # If BEADS_DB or BEADS_WORKING_DIR point to production .beads/, fail immediately
    beads_db = os.environ.get("BEADS_DB", "")
    working_dir = os.environ.get("BEADS_WORKING_DIR", "")

    production_beads = str(project_root / ".beads")

    if beads_db and beads_db.startswith(production_beads):
        pytest.exit(
            f"PRODUCTION DATABASE POLLUTION DETECTED (bd-2c5a):\n"
            f"  BEADS_DB={beads_db}\n"
            f"  Production .beads/: {production_beads}\n"
            f"  Tests MUST use isolated temp databases.\n"
            f"  Remove BEADS_DB env var or point it to a temp directory.",
            returncode=1,
        )

    if (
        working_dir
        and working_dir.startswith(str(project_root))
        and Path(working_dir).resolve() == project_root.resolve()
    ):
        pytest.exit(
            f"PRODUCTION DATABASE POLLUTION RISK (bd-2c5a):\n"
            f"  BEADS_WORKING_DIR={working_dir}\n"
            f"  Project root: {project_root}\n"
            f"  Tests should use isolated temp directories.\n"
            f"  Remove BEADS_WORKING_DIR or set it to a temp directory.",
            returncode=1,
        )


@pytest.fixture(autouse=True)
def _no_ambient_agent_identity(monkeypatch):
    """Strip the maintainer's own agent identity from every test.

    Session-wide, not just in the identity suites, and the reason is new: the mutating
    tools are now gated on the `write` permission, so *any* test that calls
    `create`/`update`/`close` resolves an identity against whatever the developer's
    environment happens to hold. `CLAUDE_CODE_SESSION_ID` is the dangerous one — Claude
    Code exports it into every session, including the one running these tests, so a
    maintainer whose session id belongs to a revoked agent would see writes refused
    across unrelated suites, with a failure that reproduces on exactly one machine.

    `FEADS_REQUIRE_AGENT`, `FEADS_HOSTED`, and `FEADS_REGISTRY_DB` go too: any one
    can turn a green suite red for reasons that have nothing to do with the code under test.
    """
    for name in (
        "FEADS_AGENT_TOKEN",
        "CLAUDE_CODE_SESSION_ID",
        "FEADS_REQUIRE_AGENT",
        "FEADS_HOSTED",
        "FEADS_REGISTRY_DB",
        "FEADS_DASHBOARD_URL",
    ):
        monkeypatch.delenv(name, raising=False)


def pytest_runtest_setup(item):
    """Called before each test - verify test isolation."""
    # Check if test is using bd_client fixture
    if "bd_client" in item.fixturenames:
        # Verify BEADS_DB is not set to production during test execution
        beads_db = os.environ.get("BEADS_DB", "")
        if beads_db and ".beads/beads.db" in beads_db:
            # Get temp directory
            import tempfile

            if not beads_db.startswith(tempfile.gettempdir()):
                pytest.fail(
                    f"Test {item.name} is using production database (bd-2c5a):\n"
                    f"  BEADS_DB={beads_db}\n"
                    f"  This test must use a temporary database.",
                    pytrace=False,
                )
