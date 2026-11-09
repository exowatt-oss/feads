"""Artifact writes follow the session's board (regression for the ambient-pin removal).

The hosted launcher no longer exports BEADS_DIR to the MCP daemon, and artifact
writes used to resolve their board from exactly that ambient pin — so with the pin
gone, artifact_add with no explicit board answered "no beads database found" even
for a session that had just switched boards with context(board=...). _write_target
must consult the session workspace before falling back to bd's own resolution.
"""

from beads_mcp import artifacts, server


async def test_write_target_prefers_session_board(tmp_path):
    workspace = tmp_path / "boardws"
    beads_dir = workspace / ".beads"
    beads_dir.mkdir(parents=True)

    session = server._session_context()
    session["BEADS_WORKING_DIR"] = str(workspace)
    try:
        target = await artifacts._write_target("")
        assert target["dir"] == str(beads_dir)
    finally:
        session.pop("BEADS_WORKING_DIR", None)


async def test_write_target_without_session_or_ambient_is_empty(tmp_path, monkeypatch):
    """No session, no ambient: the target stays unbound rather than guessing."""

    async def no_ambient() -> str:
        return ""

    monkeypatch.setattr(artifacts, "_ambient_board_dir", no_ambient)
    session = server._session_context()
    session.pop("BEADS_WORKING_DIR", None)

    target = await artifacts._write_target("")
    assert target["dir"] == ""
