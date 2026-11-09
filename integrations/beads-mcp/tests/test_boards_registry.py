"""Tests for the read-only board registry accessor and its MCP tools.

Fixture registries are built with stdlib sqlite3 rather than by shelling out to
the Node CLI, so these tests stay fast and do not need node on PATH. The schema
here must match ``boards/registry.mjs``.
"""

import sqlite3
from pathlib import Path

import pytest
from fastmcp.client import Client

from beads_mcp.boards import (
    REGISTRY_DB_ENV,
    RegistryUnavailableError,
    board_route_payload,
    board_show_payload,
    boards_list_payload,
    get_board,
    list_boards,
    registry_path,
    route_task,
)
from beads_mcp.server import mcp

SCHEMA = """
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


def make_registry(path: Path, boards: list[dict] | None = None) -> str:
    """Create a registry database with the given boards.

    Args:
        path: Database file to create
        boards: Board dicts with id, name, description, repos, and optional dirs

    Returns:
        The database path as a string
    """
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SCHEMA)
        for index, board in enumerate(boards or []):
            conn.execute(
                "INSERT INTO boards (id, name, board_dir, workspace_dir, description,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    board["id"],
                    board["name"],
                    board.get("board_dir", f"/tmp/{board['id']}/.beads"),
                    board.get("workspace_dir", f"/tmp/{board['id']}"),
                    board.get("description", ""),
                    1000 + index,
                    2000 + index,
                ),
            )
            for repo in board.get("repos", []):
                conn.execute(
                    "INSERT INTO board_repos (board_id, repo) VALUES (?, ?)",
                    (board["id"], repo),
                )
        conn.commit()
    finally:
        conn.close()
    return str(path)


@pytest.fixture
def two_board_registry(tmp_path: Path) -> str:
    """A registry where one board owns the repo and the other reads closer in prose."""
    return make_registry(
        tmp_path / "registry.db",
        [
            {
                "id": "lab",
                "name": "Lab",
                "description": "Energy management system work",
                "repos": ["example-lab/sample-controller", "example-lab/sample-web-ui"],
            },
            {
                "id": "platform",
                "name": "Platform",
                "description": "Energy management system controller relay heartbeat platform work",
                "repos": ["example-org/sample-platform"],
            },
        ],
    )


class TestRegistryPath:
    """Tests for registry location resolution."""

    def test_env_override_is_absolutized(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """FEADS_REGISTRY_DB wins and is resolved to an absolute path."""
        monkeypatch.setenv(REGISTRY_DB_ENV, "/tmp/some/place.db")
        assert registry_path() == "/tmp/some/place.db"

    def test_default_is_under_home(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """With no override the registry lives at ~/.feads/registry.db."""
        monkeypatch.delenv(REGISTRY_DB_ENV, raising=False)
        assert registry_path().endswith("/.feads/registry.db")


class TestMissingRegistry:
    """Tests for a registry that does not exist or has no schema."""

    def test_list_boards_raises_with_path(self, tmp_path: Path) -> None:
        """A missing file names the path it tried, not a bare sqlite error."""
        missing = str(tmp_path / "nope.db")
        with pytest.raises(RegistryUnavailableError, match="no board registry at"):
            list_boards(missing)
        assert not (tmp_path / "nope.db").exists(), "read-only accessor must not create the registry"

    def test_registry_without_schema_reads_as_unavailable(self, tmp_path: Path) -> None:
        """A database some other tool created is 'unavailable', not an internal error."""
        empty = tmp_path / "empty.db"
        sqlite3.connect(empty).close()
        with pytest.raises(RegistryUnavailableError, match="not readable"):
            list_boards(str(empty))

    def test_payload_returns_empty_list_and_hint(self, tmp_path: Path) -> None:
        """The tool payload degrades to an empty list plus a how-to hint."""
        payload = boards_list_payload(str(tmp_path / "nope.db"))
        assert payload["boards"] == []
        assert payload["count"] == 0
        assert "feads-board register" in payload["hint"]
        assert "no board registry at" in payload["error"]

    def test_route_payload_degrades(self, tmp_path: Path) -> None:
        """Routing against a missing registry returns no candidates and a hint."""
        payload = board_route_payload(text="anything", db_path=str(tmp_path / "nope.db"))
        assert payload["candidates"] == []
        assert "feads-board register" in payload["hint"]


class TestListBoards:
    """Tests for listing registered boards."""

    def test_empty_registry_lists_nothing(self, tmp_path: Path) -> None:
        """A registry with schema but no rows is not an error."""
        db_path = make_registry(tmp_path / "registry.db")
        assert list_boards(db_path) == []

        payload = boards_list_payload(db_path)
        assert payload["count"] == 0
        assert "hint" in payload, "an empty board list should say how to populate it"

    def test_boards_are_ordered_by_name_with_repos(self, two_board_registry: str) -> None:
        """Boards come back name-ordered, each hydrated with its sorted repo list."""
        boards = list_boards(two_board_registry)
        assert [board["id"] for board in boards] == ["lab", "platform"]
        assert boards[0]["repos"] == ["example-lab/sample-controller", "example-lab/sample-web-ui"]
        assert boards[0]["description"] == "Energy management system work"
        assert boards[0]["board_dir"] == "/tmp/lab/.beads"

    def test_get_board_by_id_and_by_dir(self, two_board_registry: str) -> None:
        """Lookup accepts a board id or the board directory."""
        by_id = get_board("lab", two_board_registry)
        assert by_id is not None
        by_dir = get_board("/tmp/lab/.beads", two_board_registry)
        assert by_dir == by_id
        assert get_board("nonexistent", two_board_registry) is None

    def test_show_payload_lists_known_boards_on_miss(self, two_board_registry: str) -> None:
        """An unknown board reports what is registered instead of just failing."""
        payload = board_show_payload("nonexistent", two_board_registry)
        assert payload["board"] is None
        assert payload["known_boards"] == ["lab", "platform"]


class TestRouting:
    """Tests mirroring routeTask() in boards/registry.mjs."""

    def test_exact_repo_match_scores_100(self, two_board_registry: str) -> None:
        """An exact owner/name hit is worth 100 and says so."""
        ranked = route_task(repo="example-lab/sample-controller", db_path=two_board_registry)
        assert [candidate["board"]["id"] for candidate in ranked] == ["lab"]
        assert ranked[0]["score"] == 100
        assert ranked[0]["reasons"] == ["exact repo match: example-lab/sample-controller"]

    def test_short_repo_name_match_scores_60(self, two_board_registry: str) -> None:
        """A bare repo name still lands on the board that owns the full path."""
        ranked = route_task(repo="sample-controller", db_path=two_board_registry)
        assert ranked[0]["board"]["id"] == "lab"
        assert ranked[0]["score"] == 60
        assert "repo name match" in ranked[0]["reasons"][0]

    def test_repo_match_beats_closer_prose(self, two_board_registry: str) -> None:
        """A repo match outranks a board whose description reads much closer.

        The 'platform' board's description contains every scoring token in the
        query; 'lab' matches none of them but owns the repo. Repo wins.
        """
        ranked = route_task(
            text="controller relay heartbeat rollout",
            repo="example-lab/sample-controller",
            db_path=two_board_registry,
        )
        assert [candidate["board"]["id"] for candidate in ranked] == ["lab", "platform"]
        # 100 for the repo and nothing else: 'lab' matches no query token.
        assert ranked[0]["score"] == 100
        # 3 tokens x 5 = 15 for prose overlap alone.
        assert ranked[1]["score"] == 15

    def test_repo_mentioned_in_text_scores_25(self, two_board_registry: str) -> None:
        """Naming a repo in free text counts, for less than the repo argument."""
        ranked = route_task(text="sample-web-ui needs a spinner", db_path=two_board_registry)
        assert ranked[0]["board"]["id"] == "lab"
        assert any("text mentions repo" in reason for reason in ranked[0]["reasons"])

    def test_short_tokens_are_ignored(self, tmp_path: Path) -> None:
        """Tokens under 4 characters contribute nothing, so nothing matches."""
        db_path = make_registry(
            tmp_path / "registry.db",
            [{"id": "lab", "name": "Lab", "description": "the lab bot ran fast", "repos": []}],
        )
        # Every token here is <4 chars and present in the haystack; a naive
        # implementation would score this board.
        assert route_task(text="the lab bot ran", db_path=db_path) == []
        # Adding one 4-char token from the same haystack does score, proving the boundary.
        ranked = route_task(text="the lab bot ran fast", db_path=db_path)
        assert [candidate["score"] for candidate in ranked] == [5]
        assert ranked[0]["reasons"] == ["description/name overlap: fast"]

    def test_zero_score_boards_are_filtered(self, two_board_registry: str) -> None:
        """Boards that match nothing are dropped rather than returned with score 0."""
        assert route_task(text="entirely unrelated subject matter", db_path=two_board_registry) == []

    def test_ties_break_on_board_id(self, tmp_path: Path) -> None:
        """Equal scores sort by board id so the ranking is deterministic."""
        db_path = make_registry(
            tmp_path / "registry.db",
            [
                {"id": "zulu", "name": "Zulu", "description": "telemetry", "repos": []},
                {"id": "alpha", "name": "Alpha", "description": "telemetry", "repos": []},
            ],
        )
        ranked = route_task(text="telemetry", db_path=db_path)
        assert [candidate["board"]["id"] for candidate in ranked] == ["alpha", "zulu"]

    def test_route_payload_limit_and_shape(self, two_board_registry: str) -> None:
        """The payload flattens candidates and honours limit."""
        payload = board_route_payload(
            text="controller relay heartbeat rollout",
            repo="example-lab/sample-controller",
            limit=1,
            db_path=two_board_registry,
        )
        assert payload["count"] == 1
        assert payload["candidates"][0]["id"] == "lab"
        assert payload["candidates"][0]["repos"] == [
            "example-lab/sample-controller",
            "example-lab/sample-web-ui",
        ]
        # `repos` normalizes the singular `repo` plus any extras, so a caller
        # sees one list whichever form it passed.
        assert payload["query"] == {
            "text": "controller relay heartbeat rollout",
            "repo": "example-lab/sample-controller",
            "repos": ["example-lab/sample-controller"],
        }

    def test_route_payload_requires_text_or_repo(self, two_board_registry: str) -> None:
        """Routing with neither text nor repo is a usage error, not an empty result."""
        payload = board_route_payload(db_path=two_board_registry)
        assert payload["error"] == "board_route needs text and/or repo"


class TestBoardToolsOverMcp:
    """Tests that the board tools are registered and callable through MCP."""

    async def test_tools_are_registered(self) -> None:
        """The three board tools appear in the server's tool list and the catalog."""
        async with Client(mcp) as client:
            names = {tool.name for tool in await client.list_tools()}
        assert {"boards_list", "board_show", "board_route"} <= names

        async with Client(mcp) as client:
            catalog = await client.call_tool("discover_tools", {})
        assert {"boards_list", "board_show", "board_route"} <= set(catalog.data["tools"])

    async def test_boards_list_and_route_through_client(
        self, two_board_registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Calling the tools over MCP reads the registry pointed at by the env var."""
        monkeypatch.setenv(REGISTRY_DB_ENV, two_board_registry)

        async with Client(mcp) as client:
            listed = await client.call_tool("boards_list", {})
            routed = await client.call_tool("board_route", {"text": "relay heartbeat", "repo": "sample-controller"})
            shown = await client.call_tool("board_show", {"board": "platform"})

        assert [board["id"] for board in listed.data["boards"]] == ["lab", "platform"]
        assert routed.data["candidates"][0]["id"] == "lab"
        assert routed.data["candidates"][0]["score"] == 60
        assert shown.data["board"]["repos"] == ["example-org/sample-platform"]

    async def test_get_tool_info_documents_board_tools(self) -> None:
        """get_tool_info() covers the new tools so discovery stays complete."""
        async with Client(mcp) as client:
            info = await client.call_tool("get_tool_info", {"tool_name": "board_route"})
        assert info.data["name"] == "board_route"
        assert "repo" in info.data["parameters"]


class TestRepoMentionWordBoundary:
    """Repo mentions in free text match whole words, not raw substrings.

    A substring test scored a board owning ``.../api`` on "therapist" and
    "rapid" — misrouting tasks, which is the exact failure routing exists to
    prevent. Mirrors the same assertions in boards/registry.test.mjs; the two
    implementations must stay identical or the CLI and the MCP will disagree.
    """

    @pytest.fixture
    def api_registry(self, tmp_path: Path) -> str:
        return make_registry(
            tmp_path / "registry.db",
            [
                {
                    "id": "api",
                    "name": "API",
                    "board_dir": str(tmp_path / "api"),
                    "description": "edge",
                    "repos": ["example-lab/api"],
                }
            ],
        )

    @pytest.mark.parametrize("text", ["therapist notes", "rapid capital gains"])
    def test_short_repo_name_does_not_match_inside_a_word(self, api_registry: str, text: str) -> None:
        assert route_task(text=text, db_path=api_registry) == []

    def test_the_real_word_still_matches(self, api_registry: str) -> None:
        ranked = route_task(text="the api is down", db_path=api_registry)
        assert [c["board"]["id"] for c in ranked] == ["api"]
        assert ranked[0]["score"] == 25

    @pytest.mark.parametrize("text", ["sample controller dispatch", "sample_controller dispatch"])
    def test_separators_are_normalized_on_both_sides(self, tmp_path: Path, text: str) -> None:
        """Repos are hyphenated; people writing tasks are not."""
        db = make_registry(
            tmp_path / "sep.db",
            [
                {
                    "id": "lab",
                    "name": "Lab",
                    "board_dir": str(tmp_path / "lab"),
                    "description": "",
                    "repos": ["example-lab/sample-controller"],
                }
            ],
        )
        ranked = route_task(text=text, db_path=db)
        assert [c["board"]["id"] for c in ranked] == ["lab"]
        assert ranked[0]["score"] == 25


class TestBoardsNotCoupledToRepos:
    """A board may list zero, one or many repos; repos are an optional hint.

    Without these properties an optional hint quietly becomes a requirement for
    being findable. Mirrors the same block in boards/registry.test.mjs — the two
    implementations must stay identical.
    """

    @pytest.fixture
    def mixed_registry(self, tmp_path: Path) -> str:
        return make_registry(
            tmp_path / "registry.db",
            [
                {
                    "id": "platform",
                    "name": "Platform",
                    "board_dir": str(tmp_path / "platform"),
                    "description": (
                        "shared platform infrastructure deploy tooling terraform observability runbooks"
                    ),
                    "repos": [],
                },
                {
                    "id": "many",
                    "name": "Many",
                    "board_dir": str(tmp_path / "many"),
                    "description": "unrelated things",
                    "repos": ["o/alpha", "o/bravo", "o/charlie", "o/delta", "o/echo"],
                },
            ],
        )

    def test_a_repo_less_board_is_routable_on_description_alone(self, mixed_registry: str) -> None:
        ranked = route_task(text="shared platform deploy tooling", db_path=mixed_registry)
        assert ranked[0]["board"]["id"] == "platform"
        assert ranked[0]["score"] > 0

    def test_repo_mentions_are_credited_once_per_board(self, mixed_registry: str) -> None:
        """Crediting each repo separately scored a 3-repo board 75 vs 10."""
        ranked = route_task(text="alpha bravo charlie delta echo", db_path=mixed_registry)
        assert ranked[0]["board"]["id"] == "many"
        assert ranked[0]["score"] == 25, "five mentioned repos must score like one"

    def test_well_described_repo_less_board_beats_incidental_mention(self, mixed_registry: str) -> None:
        ranked = route_task(
            text=("shared platform infrastructure deploy tooling terraform observability alpha"),
            db_path=mixed_registry,
        )
        assert ranked[0]["board"]["id"] == "platform"
        assert ranked[0]["score"] > ranked[1]["score"]

    def test_description_score_is_capped(self, mixed_registry: str) -> None:
        ranked = route_task(
            text=("shared platform infrastructure deploy tooling terraform observability runbooks"),
            db_path=mixed_registry,
        )
        assert ranked[0]["score"] == 40

    def test_explicit_repo_still_beats_the_description_cap(self, mixed_registry: str) -> None:
        ranked = route_task(
            text=("shared platform infrastructure deploy tooling terraform observability runbooks"),
            repo="o/alpha",
            db_path=mixed_registry,
        )
        assert ranked[0]["board"]["id"] == "many"
        assert ranked[0]["score"] == 100

    def test_several_query_repos_take_the_best_match_not_a_sum(self, mixed_registry: str) -> None:
        one = route_task(repos=["o/alpha"], db_path=mixed_registry)
        three = route_task(repos=["o/alpha", "o/bravo", "o/unknown"], db_path=mixed_registry)
        assert one[0]["score"] == 100
        assert three[0]["score"] == 100, "three matching repos must score like one"

    def test_scores_are_bounded(self, mixed_registry: str) -> None:
        ranked = route_task(
            text="alpha bravo charlie delta echo unrelated things",
            repo="o/alpha",
            db_path=mixed_registry,
        )
        assert all(c["score"] <= 100 + 25 + 40 for c in ranked)
