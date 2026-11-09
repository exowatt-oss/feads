"""Spawn-failure discrimination (ex-eyu).

asyncio.create_subprocess_exec raises the same FileNotFoundError for a missing
program and a missing working directory. bd_client used to report both as
"bd CLI not found at: <bd_path>", which sent a hosted-server caller chasing a
phantom local bd install when the real problem was a client-local
workspace_root that does not exist on the server. These tests pin the
distinction with real subprocess spawns — no mocks — because the bug lives in
the OS error, not in our code's happy path.
"""

import pytest

from beads_mcp.bd_client import BdClient, BdError, BdNotFoundError

# Any executable that certainly exists; the spawn must fail on the cwd, not on it.
EXISTING_PROGRAM = "/bin/echo"


async def test_missing_working_dir_is_not_reported_as_missing_binary(tmp_path):
    missing_dir = str(tmp_path / "does-not-exist")
    client = BdClient(bd_path=EXISTING_PROGRAM, working_dir=missing_dir)

    with pytest.raises(BdError) as excinfo:
        await client._run_command("list")

    assert not isinstance(excinfo.value, BdNotFoundError)
    message = str(excinfo.value)
    assert "Working directory does not exist" in message
    assert missing_dir in message
    assert "bd CLI not found" not in message
    # The message must steer a hosted caller to the fix, not to an install script.
    assert "context(board=" in message


async def test_missing_binary_still_reports_installation_message(tmp_path):
    missing_bd = str(tmp_path / "no-such-bd")
    client = BdClient(bd_path=missing_bd, working_dir=str(tmp_path))

    with pytest.raises(BdNotFoundError) as excinfo:
        await client._run_command("list")

    assert "bd CLI not found at" in str(excinfo.value)
    assert missing_bd in str(excinfo.value)


async def test_check_version_missing_working_dir(tmp_path):
    missing_dir = str(tmp_path / "gone")
    client = BdClient(bd_path=EXISTING_PROGRAM, working_dir=missing_dir)

    with pytest.raises(BdError) as excinfo:
        await client._check_version()

    assert not isinstance(excinfo.value, BdNotFoundError)
    assert "Working directory does not exist" in str(excinfo.value)


async def test_run_text_command_missing_working_dir(tmp_path):
    missing_dir = str(tmp_path / "vanished")
    client = BdClient(bd_path=EXISTING_PROGRAM, working_dir=missing_dir)

    with pytest.raises(BdError) as excinfo:
        await client._run_text_command("comment", "ex-xyz", "hello")

    assert not isinstance(excinfo.value, BdNotFoundError)
    assert "Working directory does not exist" in str(excinfo.value)
