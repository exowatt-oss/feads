"""Artifact ref conformance for the Python implementation.

The cases live in ``boards/artifact-cases.json``, not here, because the same table is
asserted by the Node implementation in ``boards/artifacts.test.mjs``. A ref is a join
key — an agent finds who else is touching a file by matching refs — so two
canonicalizers that disagree do not report a wrong answer, they report "nobody else is
touching this", silently.

This file mirrors ``boards/artifacts.test.mjs`` group for group. The
``test_every_group_in_the_fixture_is_asserted`` guard at the bottom fails when a group
is added to the fixture and not read here, which is the point.
"""

import json
import os
from pathlib import Path
from typing import Any

import pytest

from beads_mcp.artifacts import (
    ACTION_INTENT,
    ACTIONS,
    INTENTS,
    KINDS,
    MARKER_KEY,
    METADATA_PREFIX,
    ArtifactError,
    artifact_value,
    artifacts_from_metadata,
    attach_patch,
    detach_patch,
    expand_repo,
    format_ref,
    intent_rank,
    looks_local,
    metadata_key,
    normalize_artifact_path,
    normalize_repo,
    now_iso,
    overlap,
    parse_ref,
    parse_remote_url,
    ref_from_local_path,
    ref_from_metadata_key,
    resolve_ref,
    respond_comment,
    sort_hits,
)

FIXTURE_ENV = "FEADS_ARTIFACT_CASES"


def _find_fixture() -> Path:
    """Locate ``boards/artifact-cases.json``.

    Resolved relative to this file rather than to the cwd: pytest can be invoked from
    the repo root (``make mcp-test``) or from ``integrations/beads-mcp``, and a
    cwd-relative path would find the fixture in one case and not the other.

    A missing fixture is a hard error rather than a skip. This suite's only claim is
    "the two implementations agree", and a skipped conformance suite reports that claim
    as verified when nothing checked it.
    """
    override = os.environ.get(FIXTURE_ENV, "")
    if override:
        path = Path(override).expanduser().resolve()
        if not path.is_file():
            raise RuntimeError(f"{FIXTURE_ENV}={override} does not point at a readable file")
        return path

    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "boards" / "artifact-cases.json"
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        "cannot find boards/artifact-cases.json above "
        f"{here} — the ref grammar contract is unreadable, so this suite cannot verify "
        f"anything. Set {FIXTURE_ENV} to its path if the Node half is not checked out here."
    )


FIXTURE_PATH = _find_fixture()
FIXTURE: dict[str, Any] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

PARSE_CASES: list[dict[str, Any]] = FIXTURE["parse"]
FORMAT_CASES: list[dict[str, Any]] = FIXTURE["format"]
EXPAND_REPO_CASES: list[dict[str, Any]] = FIXTURE["expand_repo"]
RESOLVE_CASES: list[dict[str, Any]] = FIXTURE["resolve"]
REMOTE_URL_CASES: list[dict[str, Any]] = FIXTURE["remote_url"]
LOCAL_PATH_CASES: list[dict[str, Any]] = FIXTURE["local_path"]
OVERLAP_CASES: list[dict[str, Any]] = FIXTURE["overlap"]
METADATA_CASES: list[dict[str, Any]] = FIXTURE["metadata"]
SORT_HITS_CASES: list[dict[str, Any]] = FIXTURE["sort_hits"]
COMMENT_CASES: list[dict[str, Any]] = FIXTURE["comment"]

# Every case-bearing key this file asserts. The fixture's other top-level keys are
# "_"-prefixed prose; anything else is a group nobody is reading.
ASSERTED_GROUPS: dict[str, list[dict[str, Any]]] = {
    "parse": PARSE_CASES,
    "format": FORMAT_CASES,
    "expand_repo": EXPAND_REPO_CASES,
    "resolve": RESOLVE_CASES,
    "remote_url": REMOTE_URL_CASES,
    "local_path": LOCAL_PATH_CASES,
    "overlap": OVERLAP_CASES,
    "metadata": METADATA_CASES,
    "sort_hits": SORT_HITS_CASES,
    "comment": COMMENT_CASES,
}

# Filled in as the parametrized tests run, then checked at the bottom of the file. A
# parametrized case that is silently never executed is precisely the failure this suite
# must not have.
_ASSERTED: dict[str, list[str]] = {name: [] for name in ASSERTED_GROUPS}


def _ids(cases: list[dict[str, Any]]) -> list[str]:
    return [str(case["why"]) for case in cases]


def _assert_subset(actual: Any, expected: dict[str, Any], label: str) -> None:
    """Assert every key the fixture states, ignoring extra keys on the actual value.

    Cases name the fields they are about; a case that restated every field would obscure
    which one it exists to pin.
    """
    for key, want in expected.items():
        assert actual.get(key) == want, f"{label}: {key} — expected {want!r}, got {actual.get(key)!r}"


def _run(fn: Any, case: dict[str, Any]) -> Any:
    """Run a fixture case that may be an error case.

    Returns the result, or ``None`` for an asserted raise. ``message_contains`` is
    matched case-insensitively against the message *or* the hint, so wording may differ
    between the two implementations but the diagnosis may not.
    """
    if not case.get("throws"):
        return fn()
    with pytest.raises(ArtifactError) as excinfo:
        fn()
    wanted = case.get("message_contains")
    if wanted:
        haystack = f"{excinfo.value} {getattr(excinfo.value, 'hint', '')}".lower()
        assert wanted.lower() in haystack, f"{case['why']}: message/hint should mention {wanted} — got {haystack}"
    return None


@pytest.mark.parametrize("case", PARSE_CASES, ids=_ids(PARSE_CASES))
def test_parse_case(case: dict[str, Any]) -> None:
    got = _run(lambda: parse_ref(case["input"]), case)
    if got is not None:
        _assert_subset(got, case["expect"], str(case["why"]))
    _ASSERTED["parse"].append(str(case["why"]))


@pytest.mark.parametrize("case", FORMAT_CASES, ids=_ids(FORMAT_CASES))
def test_format_case(case: dict[str, Any]) -> None:
    got = _run(lambda: format_ref(case["input"]), case)
    if got is not None:
        assert got == case["expect"], str(case["why"])
    _ASSERTED["format"].append(str(case["why"]))


@pytest.mark.parametrize("case", EXPAND_REPO_CASES, ids=_ids(EXPAND_REPO_CASES))
def test_expand_repo_case(case: dict[str, Any]) -> None:
    got = _run(lambda: expand_repo(case["input"]["repo"], case["input"].get("known_repos")), case)
    if got is not None:
        _assert_subset(got, case["expect"], str(case["why"]))
    _ASSERTED["expand_repo"].append(str(case["why"]))


@pytest.mark.parametrize("case", RESOLVE_CASES, ids=_ids(RESOLVE_CASES))
def test_resolve_case(case: dict[str, Any]) -> None:
    spec = case["input"]
    got = _run(
        lambda: resolve_ref(
            spec["input"],
            known_repos=spec.get("known_repos"),
            preferred_repos=spec.get("preferred_repos"),
            current_repo=spec.get("current_repo", ""),
        ),
        case,
    )
    if got is not None:
        _assert_subset(got, case["expect"], str(case["why"]))
    _ASSERTED["resolve"].append(str(case["why"]))


@pytest.mark.parametrize("case", REMOTE_URL_CASES, ids=_ids(REMOTE_URL_CASES))
def test_remote_url_case(case: dict[str, Any]) -> None:
    assert parse_remote_url(case["input"]) == case["expect"], str(case["why"])
    _ASSERTED["remote_url"].append(str(case["why"]))


@pytest.mark.parametrize("case", LOCAL_PATH_CASES, ids=_ids(LOCAL_PATH_CASES))
def test_local_path_case(case: dict[str, Any]) -> None:
    spec = case["input"]
    got = _run(
        lambda: ref_from_local_path(
            path=spec["path"],
            toplevel=spec["toplevel"],
            remote=spec.get("remote", ""),
            repo_hint=spec.get("repo_hint", ""),
            is_dir=bool(spec.get("is_dir")),
        ),
        case,
    )
    if got is not None:
        assert got["ref"] == case["expect"], str(case["why"])
    _ASSERTED["local_path"].append(str(case["why"]))


@pytest.mark.parametrize("case", OVERLAP_CASES, ids=_ids(OVERLAP_CASES))
def test_overlap_case(case: dict[str, Any]) -> None:
    assert overlap(case["query"], case["attached"]) == case["expect"], str(case["why"])
    _ASSERTED["overlap"].append(str(case["why"]))


@pytest.mark.parametrize("case", METADATA_CASES, ids=_ids(METADATA_CASES))
def test_metadata_case(case: dict[str, Any]) -> None:
    got = artifacts_from_metadata(case["input"])
    assert len(got) == len(case["expect"]), f"{case['why']}: artifact count"
    for i, want in enumerate(case["expect"]):
        _assert_subset(got[i], want, f"{case['why']}[{i}]")
    _ASSERTED["metadata"].append(str(case["why"]))


@pytest.mark.parametrize("case", SORT_HITS_CASES, ids=_ids(SORT_HITS_CASES))
def test_sort_hits_case(case: dict[str, Any]) -> None:
    ordered = [hit["issue_id"] for hit in sort_hits(case["input"])]
    assert ordered == case["expect"], str(case["why"])
    _ASSERTED["sort_hits"].append(str(case["why"]))


@pytest.mark.parametrize("case", COMMENT_CASES, ids=_ids(COMMENT_CASES))
def test_comment_case(case: dict[str, Any]) -> None:
    spec = case["input"]
    got = _run(
        lambda: respond_comment(
            mine=spec["mine"],
            action=spec["action"],
            ref=spec["ref"],
            attached_ref=spec.get("attached_ref", ""),
            attached_intent=spec.get("attached_intent", ""),
            note=spec.get("note", ""),
            target=spec.get("target", ""),
            dep_added=bool(spec.get("dep_added")),
        ),
        case,
    )
    if got is not None:
        assert got == case["expect"], str(case["why"])
    _ASSERTED["comment"].append(str(case["why"]))


# =============================================================================
# Fixture integrity — a silently empty or unread fixture must not pass
# =============================================================================


def test_the_fixture_actually_has_cases() -> None:
    for name, cases in ASSERTED_GROUPS.items():
        assert isinstance(cases, list), f"{name} is missing"
        assert len(cases) >= 2, f"{name} has only {len(cases)} cases"
    assert len(PARSE_CASES) >= 15, f"only {len(PARSE_CASES)} parse cases"
    assert len(OVERLAP_CASES) >= 18, f"only {len(OVERLAP_CASES)} overlap cases"


def test_every_group_in_the_fixture_is_asserted() -> None:
    unread = [key for key in FIXTURE if not key.startswith("_") and key not in ASSERTED_GROUPS]
    assert unread == [], f"unread fixture groups: {', '.join(unread)}"


def test_every_case_ran() -> None:
    for name, cases in ASSERTED_GROUPS.items():
        assert len(_ASSERTED[name]) == len(cases), (
            f"{name}: {len(_ASSERTED[name])} of {len(cases)} cases asserted — a case is being skipped"
        )


# =============================================================================
# Python-side unit tests, mirroring the non-fixture describes in artifacts.test.mjs
# =============================================================================


def test_refs_round_trip_through_format() -> None:
    for case in PARSE_CASES:
        if case.get("throws"):
            continue
        once = parse_ref(case["input"])
        twice = parse_ref(format_ref(dict(once)))
        assert twice["ref"] == once["ref"], case["input"]
        assert twice["kind"] == once["kind"], case["input"]


def test_the_metadata_key_carries_the_canonical_ref_back_unchanged() -> None:
    for ref in [
        "example-org/feads",
        "example-org/feads:ui/server/bd.js",
        "example-org/feads:ui/server/",
        "example-org/feads#4141",
    ]:
        assert ref_from_metadata_key(metadata_key(ref)) == ref


def test_a_non_canonical_ref_is_canonicalized_on_the_way_into_the_key() -> None:
    assert (
        metadata_key("example-org/feads:./ui/server/bd.js")
        == f"{METADATA_PREFIX}example-org/feads:ui/server/bd.js"
    )


def test_keys_that_are_not_artifacts_are_not_artifacts() -> None:
    for key in ["team", "has_artifacts", "artifacts", "", "artifactory:thing"]:
        assert ref_from_metadata_key(key) is None, key


def test_overlap_is_symmetric_in_the_way_the_labels_claim() -> None:
    for case in OVERLAP_CASES:
        back = overlap(case["attached"], case["query"])
        if case["expect"] == "inside":
            assert back == "covers", case["why"]
        elif case["expect"] == "covers":
            assert back == "inside", case["why"]
        else:
            assert back == case["expect"], case["why"]


def test_normalize_repo_folds_case_and_rejects_impossible_names() -> None:
    assert normalize_repo("example-org/FEADS") == "example-org/feads"
    for bad in ["owner/na me", "owner/na:me", "own er"]:
        with pytest.raises(ArtifactError, match="invalid character"):
            normalize_repo(bad)
    with pytest.raises(ArtifactError, match="missing repo"):
        normalize_repo("   ")


def test_normalize_artifact_path_reports_the_subtree_intent_separately() -> None:
    assert normalize_artifact_path("ui/server/") == ("ui/server/", True)
    assert normalize_artifact_path("ui/server") == ("ui/server", False)


def test_looks_local_recognizes_checkout_paths_but_not_refs() -> None:
    for path in [
        "/Users/ana/src/feads/go.mod",
        "~/src/feads/go.mod",
        "./go.mod",
        "../feads/go.mod",
        "C:\\src\\feads\\go.mod",
    ]:
        assert looks_local(path), path
    for ref in ["example-org/feads", "example-org/feads:ui/server/bd.js", "feads#41", ""]:
        assert not looks_local(ref), ref


def test_artifact_value_records_the_parsed_shape_and_omits_blanks() -> None:
    value = artifact_value(
        ref="example-org/feads:ui/server/bd.js",
        intent="reading",
        actor="Laptop Claude",
        note="reads the spawn choke point",
        at="2026-07-28T20:38:20Z",
    )
    assert value == {
        "kind": "file",
        "repo": "example-org/feads",
        "path": "ui/server/bd.js",
        "intent": "reading",
        "note": "reads the spawn choke point",
        "actor": "Laptop Claude",
        "at": "2026-07-28T20:38:20Z",
    }
    bare = artifact_value(ref="example-org/feads", actor="", note="")
    assert "actor" not in bare
    assert "note" not in bare
    assert bare["intent"] == "editing", "editing is the cautious default"
    with pytest.raises(ArtifactError, match="unknown intent"):
        artifact_value(ref="example-org/feads", intent="maybe")


def test_now_iso_is_second_precision_utc_matching_the_node_side() -> None:
    stamp = now_iso()
    assert len(stamp) == 20 and stamp.endswith("Z"), stamp
    assert stamp[4] == "-" and stamp[10] == "T"


def test_attach_patch_writes_one_key_per_ref_plus_the_marker() -> None:
    patch = attach_patch(
        [
            {"ref": "example-org/feads:go.mod", "intent": "editing", "at": "2026-07-28T20:38:20Z"},
            {"ref": "example-org/feads:ui/server/", "intent": "reading", "at": "2026-07-28T20:38:20Z"},
        ]
    )
    assert patch[MARKER_KEY] is True
    assert sorted(k for k in patch if k != MARKER_KEY) == [
        "artifact:example-org/feads:go.mod",
        "artifact:example-org/feads:ui/server/",
    ]


def test_detach_patch_nulls_the_key_and_leaves_the_marker_alone() -> None:
    patch = detach_patch(["example-org/feads:go.mod"])
    assert patch == {"artifact:example-org/feads:go.mod": None}
    assert MARKER_KEY not in patch, "clearing the marker would race a concurrent attach"


def test_a_released_artifact_can_be_reattached() -> None:
    metadata: dict[str, Any] = {MARKER_KEY: True}
    metadata.update(detach_patch(["example-org/feads:go.mod"]))
    assert artifacts_from_metadata(metadata) == []
    metadata.update(attach_patch([{"ref": "example-org/feads:go.mod", "at": "2026-07-28T20:38:20Z"}]))
    assert [a["ref"] for a in artifacts_from_metadata(metadata)] == ["example-org/feads:go.mod"]


def test_every_action_records_an_intent_the_vocabulary_knows_or_nothing() -> None:
    for action in ACTIONS:
        intent = ACTION_INTENT[action]
        assert intent is None or intent in INTENTS, action


def test_every_intent_has_a_conflict_rank_and_editing_ranks_first() -> None:
    for intent in INTENTS:
        assert intent_rank(intent) < len(INTENTS), intent
    assert min(intent_rank(i) for i in INTENTS) == intent_rank("editing")
    assert intent_rank("vibing") >= len(INTENTS), "an unknown intent sorts last, not first"


def test_kinds_and_the_marker_key_are_what_the_storage_layer_promises() -> None:
    assert sorted(KINDS) == ["dir", "file", "pr", "repo"]
    assert MARKER_KEY == "has_artifacts"
    assert METADATA_PREFIX == "artifact:"
