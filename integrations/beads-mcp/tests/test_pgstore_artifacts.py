"""Artifacts in pg mode: one store, across boards, with nothing left behind in Dolt.

Artifacts are the coordination surface — an agent asks "who else is touching this file"
and acts on the answer — and they are stored as issue metadata, which means they follow
whichever database issues live in. The failure this suite exists to prevent is not a
crash: it is ``artifact_search`` answering **"free to work on"** because the attach
landed in Postgres and the search read Dolt. A split-brain coordination tool is worse
than no coordination tool, because it is confidently wrong.

So the claims here are deliberately end-to-end and deliberately paranoid:

* an attach is visible to a search *from another board* (the sweep is the feature);
* every artifact write appends its ``events`` row, like every other write in pg mode,
  so the dashboard and the notification miner see it;
* a detach leaves the key present with a ``null`` value, which is what "released"
  means (bd's metadata-key validator cannot delete these keys, so absence is not
  available as a representation);
* and ``bd`` is never spawned at all — asserted by making the spawn itself fatal.

Gated on ``FEADS_PG_TEST_DSN``. The suite owns two private boards and wipes them either
side, so it can run against a database holding real board data.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from beads_mcp import artifacts, pgstore, server
from beads_mcp.models import CreateIssueParams

TEST_DSN_ENV = "FEADS_PG_TEST_DSN"
BOARD_A = "mcpt-artifacts-a"
BOARD_B = "mcpt-artifacts-b"
# Registered in the board registry and absent from the store — the state a board is in
# between `bd init` and an import, and the one where answering "no conflicts" would be
# a lie rather than a fact.
BOARD_ORPHAN = "mcpt-artifacts-orphan"
PREFIX_A = "mcpta"
PREFIX_B = "mcptb"
ACTOR = "agent-ana"

# Refs no real bead can be claiming. The sweep with no board named reads every board in
# the store, including the imported production ones, so a hit on a plausible path would
# make this suite depend on somebody else's data.
REF = "example/pgstore-fixture:src/only/here.py"
REF_DIR = "example/pgstore-fixture:src/only/"

requires_pg = pytest.mark.skipif(
    not os.environ.get(TEST_DSN_ENV),
    reason=f"set {TEST_DSN_ENV} to run the Postgres store tests",
)

REGISTRY_SCHEMA = """
CREATE TABLE boards (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  board_dir     TEXT NOT NULL UNIQUE,
  workspace_dir TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE board_repos (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  repo     TEXT NOT NULL,
  PRIMARY KEY (board_id, repo)
);
CREATE TABLE schema_meta (version INTEGER NOT NULL);
INSERT INTO schema_meta (version) VALUES (1);
"""


class Fixture:
    """The two boards, their clients, and the paths the registry points at."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.dir_a = root / BOARD_A / ".beads"
        self.dir_b = root / BOARD_B / ".beads"
        self.dir_orphan = root / BOARD_ORPHAN / ".beads"
        self.a = pgstore.PgStoreClient(board_id=BOARD_A, actor=ACTOR)
        self.b = pgstore.PgStoreClient(board_id=BOARD_B, actor=ACTOR)


@pytest.fixture
async def boards(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Two private boards, present in *both* registries: SQLite and Postgres.

    The board id a pg call resolves is the basename of the directory holding ``.beads``
    (``board_id_for_workspace``, ``boardIdForDir``), so the temp directories are named
    for the board ids rather than arbitrarily — otherwise the registry and the store
    would name the same board differently and every read would refuse.
    """
    dsn = os.environ[TEST_DSN_ENV]
    monkeypatch.setenv("FEADS_PG_DSN", dsn)
    monkeypatch.setenv("BEADS_ACTOR", ACTOR)
    await pgstore.close_pool()

    fixture = Fixture(tmp_path)
    fixture.dir_a.mkdir(parents=True)
    fixture.dir_b.mkdir(parents=True)
    fixture.dir_orphan.mkdir(parents=True)

    registry = tmp_path / "registry.db"
    conn = sqlite3.connect(registry)
    try:
        conn.executescript(REGISTRY_SCHEMA)
        for index, (board_id, beads_dir) in enumerate(
            (
                (BOARD_A, fixture.dir_a),
                (BOARD_B, fixture.dir_b),
                (BOARD_ORPHAN, fixture.dir_orphan),
            )
        ):
            conn.execute(
                "INSERT INTO boards (id, name, board_dir, workspace_dir, description, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (board_id, board_id, str(beads_dir), str(beads_dir.parent), "", 1000 + index, 2000 + index),
            )
            conn.execute(
                "INSERT INTO board_repos (board_id, repo) VALUES (?, ?)",
                (board_id, "example/pgstore-fixture"),
            )
        conn.commit()
    finally:
        conn.close()
    monkeypatch.setenv("FEADS_REGISTRY_DB", str(registry))

    pool = await pgstore.get_pool()
    async with pool.acquire() as conn_pg:
        await _wipe(conn_pg)
        for board_id, prefix in ((BOARD_A, PREFIX_A), (BOARD_B, PREFIX_B)):
            await conn_pg.execute(
                "INSERT INTO boards (id, prefix) VALUES ($1, $2) "
                "ON CONFLICT (id) DO UPDATE SET prefix = EXCLUDED.prefix",
                board_id,
                prefix,
            )
    try:
        yield fixture
    finally:
        server._session_context().pop("BEADS_WORKING_DIR", None)
        pool = await pgstore.get_pool()
        async with pool.acquire() as conn_pg:
            await _wipe(conn_pg)
            await conn_pg.execute("DELETE FROM boards WHERE id = ANY($1::text[])", [BOARD_A, BOARD_B])
        await pgstore.close_pool()


async def _wipe(conn: Any) -> None:
    for board_id in (BOARD_A, BOARD_B):
        await conn.execute("DELETE FROM events WHERE board_id = $1", board_id)
        await conn.execute("DELETE FROM issues WHERE board_id = $1", board_id)


async def _events(board_id: str, kind: str | None = None) -> list[dict[str, Any]]:
    pool = await pgstore.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT issue_id, actor, kind, payload FROM events WHERE board_id = $1 "
            "AND ($2::text IS NULL OR kind = $2) ORDER BY seq",
            board_id,
            kind,
        )
    return [dict(row) for row in rows]


def _payload(event: dict[str, Any]) -> dict[str, Any]:
    """An event payload, whichever way asyncpg handed back the jsonb column."""
    raw = event["payload"]
    return dict(json.loads(raw) if isinstance(raw, str) else (raw or {}))


async def _raw_metadata(issue_id: str) -> dict[str, Any]:
    """The metadata column as stored — including released keys, which reads hide."""
    pool = await pgstore.get_pool()
    async with pool.acquire() as conn:
        raw = await conn.fetchval("SELECT metadata FROM issues WHERE id = $1", issue_id)
    return dict(json.loads(raw) if isinstance(raw, str) else (raw or {}))


async def _comments(issue_id: str) -> list[str]:
    pool = await pgstore.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT body FROM comments WHERE issue_id = $1 ORDER BY created_at", issue_id)
    return [str(row["body"]) for row in rows]


@requires_pg
class TestAttachAndSearch:
    async def test_an_attach_is_found_by_a_search_on_the_other_board(self, boards: Fixture) -> None:
        """The whole point: a sweep with no board named crosses boards in one database."""
        mine = await boards.a.create(CreateIssueParams(title="Board A work"))
        theirs = await boards.b.create(CreateIssueParams(title="Board B work"))

        added = await artifacts.artifact_add_payload(mine.id, [REF], board=BOARD_A)
        assert added["attached"] == [REF]
        assert added["board"] == BOARD_A
        assert added["others_claiming"] == []

        # Naming no board is what widens the conflict check to every board, and it is
        # the case that matters: attaching on B reports the claim already standing on A,
        # unprompted, at the one moment the agent can still choose differently.
        server._session_context()["BEADS_WORKING_DIR"] = str(boards.dir_b.parent)
        also = await artifacts.artifact_add_payload(theirs.id, [REF])
        assert also["board"] == BOARD_B
        assert [hit["issue_id"] for hit in also["others_claiming"]] == [mine.id]
        assert also["others_claiming"][0]["board"] == BOARD_A

        found = await artifacts.artifact_search_payload(REF)
        assert sorted(hit["issue_id"] for hit in found["hits"]) == sorted([mine.id, theirs.id])
        assert {hit["board"] for hit in found["hits"]} == {BOARD_A, BOARD_B}
        assert found["count"] == 2

    async def test_a_directory_claim_covers_a_file_search(self, boards: Fixture) -> None:
        """Overlap is computed from the decoded artifact, so the pg read must decode it."""
        owner = await boards.a.create(CreateIssueParams(title="Owns the subtree"))
        await artifacts.artifact_add_payload(owner.id, [REF_DIR], board=BOARD_A)

        found = await artifacts.artifact_search_payload(REF, board=BOARD_A)
        assert [hit["relation"] for hit in found["hits"]] == ["inside"]

    async def test_the_metadata_and_marker_land_and_an_event_announces_them(self, boards: Fixture) -> None:
        mine = await boards.a.create(CreateIssueParams(title="Watched"))
        await artifacts.artifact_add_payload(mine.id, [REF], intent="planned", board=BOARD_A)

        stored = await _raw_metadata(mine.id)
        assert stored[artifacts.MARKER_KEY] is True
        value = stored[artifacts.metadata_key(REF)]
        assert value["intent"] == "planned"
        assert value["actor"] == ACTOR

        updates = await _events(BOARD_A, "updated")
        assert [event["issue_id"] for event in updates] == [mine.id]
        assert updates[0]["actor"] == ACTOR
        payload = _payload(updates[0])
        assert payload["field"] == "metadata"
        assert artifacts.metadata_key(REF) in payload["keys"]

    async def test_a_listed_bead_shows_what_was_attached(self, boards: Fixture) -> None:
        mine = await boards.a.create(CreateIssueParams(title="Listed"))
        await artifacts.artifact_add_payload(mine.id, [REF], note="mine for now", board=BOARD_A)

        listed = await artifacts.artifact_list_payload(mine.id, board=BOARD_A)
        assert listed["issue"] == mine.id
        assert listed["count"] == 1
        assert listed["artifacts"][0]["ref"] == REF
        assert listed["artifacts"][0]["note"] == "mine for now"


@requires_pg
class TestRespond:
    async def test_taking_comments_on_the_other_bead_and_records_our_own_claim(self, boards: Fixture) -> None:
        theirs = await boards.a.create(CreateIssueParams(title="Theirs"))
        mine = await boards.a.create(CreateIssueParams(title="Mine"))
        await artifacts.artifact_add_payload(theirs.id, [REF], board=BOARD_A)

        answered = await artifacts.artifact_respond_payload(
            REF, mine.id, "taking", board=BOARD_A, note="I have the context"
        )
        assert [row["issue_id"] for row in answered["answered"]] == [theirs.id]
        assert answered["recorded_intent"] == "editing"

        bodies = await _comments(theirs.id)
        assert len(bodies) == 1
        assert bodies[0].startswith(f"[feads-artifact] {mine.id} is taking {REF}")
        assert "I have the context" in bodies[0]

        # The comment is a write like any other: it announces itself, so an open
        # dashboard and the notification miner both see somebody was answered.
        comment_events = await _events(BOARD_A, "comment")
        assert [event["issue_id"] for event in comment_events] == [theirs.id]
        assert comment_events[0]["actor"] == ACTOR

        # And our own bead carries the claim we just announced.
        assert artifacts.metadata_key(REF) in await _raw_metadata(mine.id)

    async def test_waiting_adds_a_real_dependency_on_the_same_board(self, boards: Fixture) -> None:
        theirs = await boards.a.create(CreateIssueParams(title="Blocker"))
        mine = await boards.a.create(CreateIssueParams(title="Waiter"))
        await artifacts.artifact_add_payload(theirs.id, [REF], board=BOARD_A)

        answered = await artifacts.artifact_respond_payload(REF, mine.id, "waiting", board=BOARD_A)
        assert answered["answered"][0]["dep_added"] is True
        assert answered["recorded_intent"] == "planned"

        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            edge = await conn.fetchrow(
                "SELECT dep_type FROM deps WHERE issue_id = $1 AND depends_on_id = $2",
                mine.id,
                theirs.id,
            )
        assert edge is not None and edge["dep_type"] == "blocks"
        assert [event["issue_id"] for event in await _events(BOARD_A, "dep_added")] == [mine.id]

    async def test_waiting_across_boards_comments_but_adds_no_dependency(self, boards: Fixture) -> None:
        """One database now, but still separate boards: a cross-board edge would lie."""
        theirs = await boards.b.create(CreateIssueParams(title="Theirs, elsewhere"))
        mine = await boards.a.create(CreateIssueParams(title="Mine, here"))
        await artifacts.artifact_add_payload(theirs.id, [REF], board=BOARD_B)

        # No board named, so the responder's own board comes from the session context —
        # the same route a real agent takes after context(board=...).
        server._session_context()["BEADS_WORKING_DIR"] = str(boards.dir_a.parent)
        answered = await artifacts.artifact_respond_payload(REF, mine.id, "waiting")

        assert answered["answered"][0]["board"] == BOARD_B
        assert answered["answered"][0]["dep_added"] is False
        assert "No dependency was added across boards" in answered["hint"]
        assert len(await _comments(theirs.id)) == 1


@requires_pg
class TestRemove:
    async def test_remove_releases_the_key_without_deleting_it(self, boards: Fixture) -> None:
        mine = await boards.a.create(CreateIssueParams(title="Released"))
        await artifacts.artifact_add_payload(mine.id, [REF], board=BOARD_A)

        removed = await artifacts.artifact_remove_payload(mine.id, [REF], board=BOARD_A)
        assert removed["detached"] == [REF]

        stored = await _raw_metadata(mine.id)
        # Present and null, not absent: bd's metadata-key validator rejects the `-`,
        # `:` and `/` a ref is made of, so `--unset-metadata` cannot remove these keys
        # and "released" has to be representable as a value.
        assert artifacts.metadata_key(REF) in stored
        assert stored[artifacts.metadata_key(REF)] is None
        assert stored[artifacts.MARKER_KEY] is True  # deliberately not cleared

        listed = await artifacts.artifact_list_payload(mine.id, board=BOARD_A)
        assert listed["count"] == 0
        found = await artifacts.artifact_search_payload(REF, board=BOARD_A)
        assert found["hits"] == []
        assert "free to work on" in found["hint"]


@requires_pg
class TestNothingReachesDolt:
    async def test_no_artifact_operation_spawns_bd(self, boards: Fixture, monkeypatch: pytest.MonkeyPatch) -> None:
        """The claim the cutover rests on, asserted rather than reasoned about.

        Every path that used to shell out is exercised — attach, search, list, respond
        (comment + dependency), detach — with the spawn itself made fatal. A future
        edit that reintroduces one fails here instead of quietly writing half the
        artifact graph into a database nobody reads any more.
        """

        async def explode(args: list[str], board_dir: str = "") -> str:
            raise AssertionError(f"pg mode spawned bd: {args}")

        monkeypatch.setattr(artifacts, "_run_bd", explode)

        theirs = await boards.b.create(CreateIssueParams(title="Theirs"))
        mine = await boards.a.create(CreateIssueParams(title="Mine"))

        await artifacts.artifact_add_payload(theirs.id, [REF], board=BOARD_B)
        await artifacts.artifact_add_payload(mine.id, [REF_DIR], board=BOARD_A)
        await artifacts.artifact_list_payload(mine.id, board=BOARD_A)
        await artifacts.artifact_search_payload(REF)
        await artifacts.artifact_canon_payload([REF], board=BOARD_A)

        server._session_context()["BEADS_WORKING_DIR"] = str(boards.dir_a.parent)
        answered = await artifacts.artifact_respond_payload(REF, mine.id, "taking")
        assert [row["issue_id"] for row in answered["answered"]] == [theirs.id]

        removed = await artifacts.artifact_remove_payload(mine.id, [REF_DIR], board=BOARD_A)
        assert removed["detached"] == [REF_DIR]


@requires_pg
class TestUnmappedBoard:
    async def test_a_board_the_store_does_not_know_is_refused_not_answered(self, boards: Fixture) -> None:
        """A board that was never imported must not be able to answer "nothing here".

        A read that names the board says so, loudly, and names the boards that do
        exist. The cross-board sweep deliberately does not — one unreachable board must
        not fail a search the other boards can still answer — and that asymmetry is the
        pre-existing contract, asserted in the second half.
        """
        listed = await artifacts.artifact_list_payload("mcpta-xxx", board=BOARD_ORPHAN)
        assert "not in the feads Postgres store" in listed["error"]
        assert BOARD_A in listed["error"]  # the message names where the caller could go

        mine = await boards.a.create(CreateIssueParams(title="Findable"))
        await artifacts.artifact_add_payload(mine.id, [REF], board=BOARD_A)
        found = await artifacts.artifact_search_payload(REF)
        assert BOARD_ORPHAN in found["boards_searched"]
        assert [hit["issue_id"] for hit in found["hits"]] == [mine.id]
