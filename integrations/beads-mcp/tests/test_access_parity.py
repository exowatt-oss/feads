"""Pin beads_mcp.access to the same answers as boards/access.mjs.

Both suites load ``boards/access-cases.json``. A case that passes in one language
and fails in the other is a cross-space leak on one surface, so neither side may
be "fixed" alone.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from beads_mcp.access import accessible_spaces, decide_access, readable_board_ids

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "boards" / "access-cases.json").read_text())


@pytest.mark.parametrize(
    "case",
    VECTORS["cases"],
    ids=[f"{i}-{c['principal']}-{c['action']}" for i, c in enumerate(VECTORS["cases"])],
)
def test_decide_access_matches_shared_vectors(case):
    principal = VECTORS["principals"][case["principal"]]
    got = decide_access(principal, case["action"], case["resource"])
    assert got.allowed is case["allowed"], got.reason
    assert isinstance(got.reason, str)


@pytest.mark.parametrize("case", VECTORS["accessible_spaces"], ids=lambda c: c["principal"])
def test_accessible_spaces_matches_shared_vectors(case):
    got = accessible_spaces(VECTORS["principals"][case["principal"]])
    if case["all"]:
        assert got is None
    else:
        assert sorted(got) == sorted(case["spaces"])


@pytest.mark.parametrize("bad", [None, "mira", 42, [], {"kind": "root", "is_superadmin": True}])
def test_malformed_principals_are_anonymous(bad):
    assert decide_access(bad, "space_read", {"space": "sp_team_a"}).allowed is False


def test_superadmin_flag_must_be_literal_true():
    p = {"kind": "user", "via": "sso", "is_superadmin": "yes", "memberships": {}}
    assert decide_access(p, "space_read", {"space": "sp_team_a"}).allowed is False


def test_readable_board_ids_filters_by_space():
    boards = [{"id": "example", "space_id": "sp_team_a"}, {"id": "team_b-lab", "space_id": "sp_team_b"}]
    assert readable_board_ids(VECTORS["principals"]["member_sw"], boards) == ["example"]
    assert readable_board_ids(VECTORS["principals"]["team_b"], boards) == ["team_b-lab"]
    assert readable_board_ids(VECTORS["principals"]["super_browser"], boards) == ["example", "team_b-lab"]
    assert readable_board_ids(VECTORS["principals"]["anonymous"], boards) == []
