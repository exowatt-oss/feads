"""Tests for the artifact tool payloads and their MCP wiring.

``bd`` is stubbed at :func:`beads_mcp.artifacts._run_bd` rather than spawned, so these
tests assert the exact argv the tools build. That is where the interesting bugs live:
dropping ``--limit 0`` from the sweep makes a busy board answer "no conflict" from its
first 50 beads, and stamping the wrong ``BEADS_DIR`` searches one board twice instead of
two boards once. Neither shows up in a passing round-trip against a small fixture board.

The pure ref grammar is not tested here — it is fixture-bound in
``test_artifact_parity.py`` against the Node implementation.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from fastmcp.client import Client

from beads_mcp import artifacts
from beads_mcp.artifacts import (
    artifact_add_payload,
    artifact_canon_payload,
    artifact_list_payload,
    artifact_remove_payload,
    artifact_respond_payload,
    artifact_search_payload,
)
from beads_mcp.boards import REGISTRY_DB_ENV
from beads_mcp.server import mcp
from tests.test_boards_registry import make_registry


class BdStub:
    """Records every bd invocation and answers from canned board state."""

    def __init__(self, boards: dict[str, list[dict[str, Any]]], ambient: str = "") -> None:
        # board_dir → the beads bd should report for it. The empty-string key answers
        # calls made with no BEADS_DIR stamped (bd's own resolution).
        self.boards = boards
        self.ambient = ambient
        self.calls: list[tuple[str, list[str]]] = []

    async def __call__(self, args: list[str], board_dir: str = "") -> str:
        self.calls.append((board_dir, list(args)))
        command = args[0] if args else ""
        if command == "info":
            return json.dumps({"database_path": f"{self.ambient}/embeddeddolt"} if self.ambient else {})
        if command == "list":
            return json.dumps(self.boards.get(board_dir, []))
        if command == "show":
            wanted = args[1]
            for issue in self.boards.get(board_dir, []):
                if issue.get("id") == wanted:
                    return json.dumps([issue])
            raise artifacts.BdFailedError(args, f"no issue found matching {wanted}")
        # update / comment / dep — bd prints a confirmation line, nobody parses it.
        return "ok\n"

    def argv_for(self, command: str) -> list[list[str]]:
        """Every recorded argv whose first element is ``command``."""
        return [args for _, args in self.calls if args and args[0] == command]

    def boards_swept(self, command: str) -> list[str]:
        """The BEADS_DIR stamped on each call to ``command``, in order."""
        return [board_dir for board_dir, args in self.calls if args and args[0] == command]


def bead(
    issue_id: str,
    refs: dict[str, str] | None = None,
    status: str = "open",
    title: str = "",
) -> dict[str, Any]:
    """A bead row as ``bd list --json`` returns it, with artifacts in metadata.

    Args:
        issue_id: Bead id
        refs: ref → intent
        status: Bead status
        title: Bead title
    """
    metadata: dict[str, Any] = {}
    if refs:
        metadata[artifacts.MARKER_KEY] = True
        for ref, intent in refs.items():
            metadata[artifacts.metadata_key(ref)] = {"intent": intent, "actor": "agent-ana"}
    return {
        "id": issue_id,
        "title": title or f"bead {issue_id}",
        "status": status,
        "metadata": metadata,
    }


@pytest.fixture
def one_board(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    """A registry with a single board that owns example-org/feads."""
    board_dir = str(tmp_path / "feads" / ".beads")
    registry = make_registry(
        tmp_path / "registry.db",
        [
            {
                "id": "feads",
                "name": "feads",
                "board_dir": board_dir,
                "description": "feads itself",
                "repos": ["example-org/feads"],
            }
        ],
    )
    monkeypatch.setenv(REGISTRY_DB_ENV, registry)
    return board_dir


@pytest.fixture
def two_boards(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    """A registry with two boards, each owning a different repo."""
    feads_dir = str(tmp_path / "feads" / ".beads")
    ems_dir = str(tmp_path / "lab" / ".beads")
    registry = make_registry(
        tmp_path / "registry.db",
        [
            {
                "id": "feads",
                "name": "feads",
                "board_dir": feads_dir,
                "repos": ["example-org/feads"],
            },
            {
                "id": "lab",
                "name": "Lab",
                "board_dir": ems_dir,
                "repos": ["example-lab/sample-controller"],
            },
        ],
    )
    monkeypatch.setenv(REGISTRY_DB_ENV, registry)
    return feads_dir, ems_dir


def install(monkeypatch: pytest.MonkeyPatch, stub: BdStub) -> BdStub:
    monkeypatch.setattr(artifacts, "_run_bd", stub)
    return stub


class TestAdd:
    async def test_writes_one_metadata_key_per_ref_plus_the_marker(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stub = install(monkeypatch, BdStub({one_board: []}, ambient=one_board))
        payload = await artifact_add_payload(
            "feads-a", ["feads:ui/server/bd.js", "feads:ui/server/"], intent="editing", note="rewiring"
        )

        assert payload["attached"] == [
            "example-org/feads:ui/server/bd.js",
            "example-org/feads:ui/server/",
        ]
        update = stub.argv_for("update")[0]
        assert update[:2] == ["update", "feads-a"]
        assert update[2] == "--metadata"
        patch = json.loads(update[3])
        # One update for both refs: bd merges metadata inside the transaction, so this is
        # one commit rather than one per file.
        assert len(stub.argv_for("update")) == 1
        assert patch[artifacts.MARKER_KEY] is True
        assert sorted(k for k in patch if k != artifacts.MARKER_KEY) == [
            "artifact:example-org/feads:ui/server/",
            "artifact:example-org/feads:ui/server/bd.js",
        ]
        assert patch["artifact:example-org/feads:ui/server/bd.js"]["note"] == "rewiring"

    async def test_reports_the_beads_already_claiming_the_path(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        existing = bead("feads-old", {"example-org/feads:ui/server/": "editing"}, title="the incumbent")
        install(monkeypatch, BdStub({one_board: [existing]}, ambient=one_board))

        payload = await artifact_add_payload("feads-new", ["feads:ui/server/bd.js"])

        assert [hit["issue_id"] for hit in payload["others_claiming"]] == ["feads-old"]
        assert payload["others_claiming"][0]["relation"] == "inside"
        assert "artifact_respond" in payload["hint"]

    async def test_the_bead_being_written_is_not_reported_as_its_own_conflict(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        mine = bead("feads-a", {"example-org/feads:ui/server/bd.js": "editing"})
        install(monkeypatch, BdStub({one_board: [mine]}, ambient=one_board))

        payload = await artifact_add_payload("feads-a", ["feads:ui/server/bd.js"])

        assert payload["others_claiming"] == []

    async def test_a_finished_claim_is_not_a_conflict(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        done = bead("feads-old", {"example-org/feads:ui/server/bd.js": "done"})
        install(monkeypatch, BdStub({one_board: [done]}, ambient=one_board))

        payload = await artifact_add_payload("feads-new", ["feads:ui/server/bd.js"])

        assert payload["others_claiming"] == []

    async def test_an_unknown_intent_is_refused_before_anything_is_written(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stub = install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        payload = await artifact_add_payload("feads-a", ["feads:go.mod"], intent="vibing")

        assert "unknown intent" in payload["error"]
        assert stub.calls == []

    async def test_a_checkout_path_is_refused_with_the_reason(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        payload = await artifact_add_payload("feads-a", ["/Users/ana/src/feads/go.mod"])

        assert "not a ref" in payload["error"]
        assert "owner/repo:path" in payload["hint"]


class TestSearch:
    async def test_the_sweep_is_unlimited_and_prefiltered(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stub = install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        await artifact_search_payload("feads:go.mod")

        listed = stub.argv_for("list")[0]
        # --limit 0 is load-bearing: bd defaults to 50 rows, and a truncated sweep
        # answers "no conflict" from the first page of a busy board.
        assert "--limit" in listed and listed[listed.index("--limit") + 1] == "0"
        assert listed[listed.index("--has-metadata-key") + 1] == artifacts.MARKER_KEY
        assert "--all" not in listed, "closed beads are history, not conflict, unless asked for"

    async def test_include_closed_asks_bd_for_them(self, one_board: str, monkeypatch: pytest.MonkeyPatch) -> None:
        stub = install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        await artifact_search_payload("feads:go.mod", include_closed=True)

        assert "--all" in stub.argv_for("list")[0]

    async def test_every_registered_board_is_swept_with_its_own_beads_dir(
        self, two_boards: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        feads_dir, ems_dir = two_boards
        stub = install(
            monkeypatch,
            BdStub(
                {
                    feads_dir: [bead("feads-a", {"example-org/feads:ui/server/bd.js": "editing"})],
                    ems_dir: [bead("lab-a", {"example-org/feads:ui/server/bd.js": "reading"})],
                }
            ),
        )

        payload = await artifact_search_payload("example-org/feads:ui/server/bd.js")

        # A board that is not stamped is a board that is not queried: bd reads BEADS_DIR
        # ahead of cwd, so sweeping without stamping would read one board twice. The
        # order is the registry's (by name), not this test's.
        assert sorted(stub.boards_swept("list")) == sorted([feads_dir, ems_dir])
        # Urgency wins over board order: an `editing` claim outranks a `reading` one
        # wherever it lives.
        assert [hit["issue_id"] for hit in payload["hits"]] == ["feads-a", "lab-a"]
        assert sorted(payload["boards_searched"]) == sorted(["lab", "feads"])

    async def test_a_named_board_narrows_the_sweep(
        self, two_boards: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        feads_dir, ems_dir = two_boards
        stub = install(monkeypatch, BdStub({feads_dir: [], ems_dir: []}))

        payload = await artifact_search_payload("example-org/feads:go.mod", board="lab")

        assert stub.boards_swept("list") == [ems_dir]
        assert payload["boards_searched"] == ["lab"]

    async def test_an_unknown_board_says_so_instead_of_searching_nothing(
        self, two_boards: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        install(monkeypatch, BdStub({}))

        payload = await artifact_search_payload("example-org/feads:go.mod", board="nope")

        assert "no such board" in payload["error"]
        assert "boards_list" in payload["hint"]

    async def test_an_unreadable_board_does_not_sink_the_other_boards(
        self, two_boards: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        feads_dir, ems_dir = two_boards

        class OneBoardBroken(BdStub):
            async def __call__(self, args: list[str], board_dir: str = "") -> str:
                if args and args[0] == "list" and board_dir == ems_dir:
                    raise artifacts.BdFailedError(args, "database is locked")
                return await super().__call__(args, board_dir)

        install(
            monkeypatch,
            OneBoardBroken({feads_dir: [bead("feads-a", {"example-org/feads:go.mod": "editing"})]}),
        )

        payload = await artifact_search_payload("example-org/feads:go.mod")

        assert [hit["issue_id"] for hit in payload["hits"]] == ["feads-a"]

    async def test_no_hits_says_the_path_is_free(self, one_board: str, monkeypatch: pytest.MonkeyPatch) -> None:
        install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        payload = await artifact_search_payload("feads:go.mod")

        assert payload["count"] == 0
        assert "free to work on" in payload["hint"]

    async def test_hits_are_ordered_by_urgency_and_the_count_survives_a_limit(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        install(
            monkeypatch,
            BdStub(
                {
                    one_board: [
                        bead("feads-reading", {"example-org/feads:go.mod": "reading"}),
                        bead("feads-editing", {"example-org/feads:go.mod": "editing"}),
                        bead("feads-planned", {"example-org/feads:go.mod": "planned"}),
                    ]
                },
                ambient=one_board,
            ),
        )

        payload = await artifact_search_payload("feads:go.mod", limit=1)

        assert [hit["issue_id"] for hit in payload["hits"]] == ["feads-editing"]
        assert payload["count"] == 3, "the total is not the page size"
        assert payload["truncated"] is True

    async def test_filtering_by_intent(self, one_board: str, monkeypatch: pytest.MonkeyPatch) -> None:
        install(
            monkeypatch,
            BdStub(
                {
                    one_board: [
                        bead("feads-a", {"example-org/feads:go.mod": "editing"}),
                        bead("feads-b", {"example-org/feads:go.mod": "reading"}),
                    ]
                },
                ambient=one_board,
            ),
        )

        payload = await artifact_search_payload("feads:go.mod", intent="reading")

        assert [hit["issue_id"] for hit in payload["hits"]] == ["feads-b"]


class TestRespond:
    async def test_waiting_records_planned_comments_and_adds_a_real_dependency(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        theirs = bead("feads-old", {"example-org/feads:ui/server/bd.js": "editing"})
        mine = bead("feads-new")
        stub = install(monkeypatch, BdStub({one_board: [theirs, mine]}, ambient=one_board))

        payload = await artifact_respond_payload(
            "feads:ui/server/bd.js", "feads-new", "waiting", note="need the new signature"
        )

        assert payload["recorded_intent"] == "planned"
        # The dependency is the point: bd ready must stop offering the waiting bead.
        assert stub.argv_for("dep")[0] == ["dep", "add", "feads-new", "feads-old", "--type", "blocks"]
        comment = stub.argv_for("comment")[0]
        assert comment[1] == "feads-old"
        assert "is waiting on this bead" in comment[2]
        assert "blocked-by dependency added: feads-new → feads-old" in comment[2]
        assert payload["answered"][0]["dep_added"] is True

    async def test_our_own_stance_is_written_before_anyone_is_told(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        theirs = bead("feads-old", {"example-org/feads:go.mod": "editing"})
        stub = install(monkeypatch, BdStub({one_board: [theirs, bead("feads-new")]}, ambient=one_board))

        await artifact_respond_payload("feads:go.mod", "feads-new", "taking")

        commands = [args[0] for _, args in stub.calls]
        # A comment claiming we are taking a file, with nothing on our bead to show it,
        # is worse than no comment.
        assert commands.index("update") < commands.index("comment")

    async def test_skipping_records_nothing_on_our_bead_but_still_tells_them(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        theirs = bead("feads-old", {"example-org/feads:go.mod": "editing"})
        stub = install(monkeypatch, BdStub({one_board: [theirs, bead("feads-new")]}, ambient=one_board))

        payload = await artifact_respond_payload("feads:go.mod", "feads-new", "skipping")

        assert payload["recorded_intent"] is None
        assert stub.argv_for("update") == [], "a bead that decided not to touch a file must not claim it"
        assert "will not touch" in stub.argv_for("comment")[0][2]

    async def test_one_comment_per_bead_however_many_of_its_artifacts_overlap(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        theirs = bead(
            "feads-old",
            {
                "example-org/feads:ui/server/bd.js": "editing",
                "example-org/feads:ui/server/": "editing",
                "example-org/feads": "editing",
            },
        )
        stub = install(monkeypatch, BdStub({one_board: [theirs, bead("feads-new")]}, ambient=one_board))

        payload = await artifact_respond_payload("feads:ui/server/bd.js", "feads-new", "taking")

        assert len(stub.argv_for("comment")) == 1
        assert len(payload["answered"]) == 1

    async def test_waiting_across_boards_comments_but_claims_no_dependency(
        self, two_boards: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        feads_dir, ems_dir = two_boards
        stub = install(
            monkeypatch,
            BdStub(
                {
                    feads_dir: [bead("feads-new")],
                    ems_dir: [bead("lab-old", {"example-org/feads:go.mod": "editing"})],
                },
                ambient=feads_dir,
            ),
        )

        payload = await artifact_respond_payload("example-org/feads:go.mod", "feads-new", "waiting")

        assert stub.argv_for("dep") == [], "a dependency cannot cross two databases"
        assert payload["answered"][0]["dep_added"] is False
        assert "blocked-by dependency added" not in stub.argv_for("comment")[0][2]
        assert "per-board databases" in payload["hint"]

    async def test_answering_a_bead_that_does_not_claim_the_path_is_an_error(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stub = install(monkeypatch, BdStub({one_board: [bead("feads-new")]}, ambient=one_board))

        payload = await artifact_respond_payload("feads:go.mod", "feads-new", "taking", target_issue="feads-old")

        assert "does not claim" in payload["error"]
        assert stub.argv_for("comment") == []

    async def test_nobody_to_tell_is_reported_rather_than_read_as_success(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        install(monkeypatch, BdStub({one_board: [bead("feads-new")]}, ambient=one_board))

        payload = await artifact_respond_payload("feads:go.mod", "feads-new", "taking")

        assert payload["answered"] == []
        assert "nobody to tell" in payload["hint"]

    async def test_an_unknown_action_is_refused_before_anything_is_written(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stub = install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        payload = await artifact_respond_payload("feads:go.mod", "feads-new", "yoinking")

        assert "unknown action" in payload["error"]
        assert stub.calls == []


class TestListAndRemove:
    async def test_list_decodes_a_beads_artifacts(self, one_board: str, monkeypatch: pytest.MonkeyPatch) -> None:
        mine = bead(
            "feads-a",
            {"example-org/feads:ui/server/bd.js": "editing", "example-org/feads#4141": "reading"},
        )
        install(monkeypatch, BdStub({one_board: [mine]}, ambient=one_board))

        payload = await artifact_list_payload("feads-a")

        assert [a["ref"] for a in payload["artifacts"]] == [
            "example-org/feads#4141",
            "example-org/feads:ui/server/bd.js",
        ]
        assert payload["count"] == 2
        assert payload["board"] == "feads"

    async def test_list_on_a_missing_bead_says_so(self, one_board: str, monkeypatch: pytest.MonkeyPatch) -> None:
        install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        payload = await artifact_list_payload("feads-nope")

        # Whether bd exits non-zero (the usual case) or returns nothing, the error names
        # the bead the agent asked for rather than a traceback.
        assert "feads-nope" in payload["error"]

    async def test_remove_nulls_the_key_and_leaves_the_marker(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stub = install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        payload = await artifact_remove_payload("feads-a", ["feads:ui/server/bd.js"])

        patch = json.loads(stub.argv_for("update")[0][3])
        # bd's --unset-metadata rejects the dashes and colons a ref is made of, so a null
        # is how a release is written; the marker stays set on purpose.
        assert patch == {"artifact:example-org/feads:ui/server/bd.js": None}
        assert payload["detached"] == ["example-org/feads:ui/server/bd.js"]


class TestCanon:
    async def test_a_bare_repo_name_expands_against_the_registry(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        payload = await artifact_canon_payload(["feads/ui/server/bd.js", "feads#4141", "feads:ui/server/"])

        assert [ref["ref"] for ref in payload["refs"]] == [
            "example-org/feads:ui/server/bd.js",
            "example-org/feads#4141",
            "example-org/feads:ui/server/",
        ]
        assert [ref["kind"] for ref in payload["refs"]] == ["file", "pr", "dir"]

    async def test_an_unresolvable_slash_form_explains_both_readings(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        install(monkeypatch, BdStub({one_board: []}, ambient=one_board))

        payload = await artifact_canon_payload(["mystery/deep/path/file.py"])

        assert "cannot tell where the repo ends" in payload["error"]
        assert "mystery:deep/path/file.py" in payload["hint"]


class TestArtifactToolsOverMcp:
    async def test_tools_are_registered_and_catalogued(self) -> None:
        expected = {
            "artifact_add",
            "artifact_search",
            "artifact_respond",
            "artifact_list",
            "artifact_remove",
            "artifact_canon",
        }
        async with Client(mcp) as client:
            names = {tool.name for tool in await client.list_tools()}
            catalog = await client.call_tool("discover_tools", {})
        assert expected <= names
        assert expected <= set(catalog.data["tools"])

    async def test_get_tool_info_documents_every_artifact_tool(self) -> None:
        async with Client(mcp) as client:
            for name in (
                "artifact_add",
                "artifact_search",
                "artifact_respond",
                "artifact_list",
                "artifact_remove",
                "artifact_canon",
            ):
                info = await client.call_tool("get_tool_info", {"tool_name": name})
                assert info.data["name"] == name
                assert info.data["description"]

    async def test_search_through_the_client_reads_the_registry_from_the_env(
        self, one_board: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        install(
            monkeypatch,
            BdStub(
                {one_board: [bead("feads-a", {"example-org/feads:ui/server/bd.js": "editing"})]},
                ambient=one_board,
            ),
        )

        async with Client(mcp) as client:
            result = await client.call_tool("artifact_search", {"ref": "example-org/feads:ui/server/bd.js"})

        assert [hit["issue_id"] for hit in result.data["hits"]] == ["feads-a"]
        assert result.data["query"] == "example-org/feads:ui/server/bd.js"
