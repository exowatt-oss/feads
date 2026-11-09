"""Contract conformance: pg-mode reads vs golden `bd` output from the live boards.

``tests/test_pgstore.py`` proves the store behaves; this proves it answers *the same
thing bd did*. The two are different claims and only this one is a contract test.

The evidence is ``.pg-fixtures/<board>.golden-{list,ready,blocked,epics}.json`` —
captured from `bd --json` against the five real boards on 2026-07-31, alongside the
``<board>.jsonl`` exports that were loaded into the store. Because both halves come from
the same snapshot, a field-by-field comparison is meaningful: any difference is this
module's, not the data's.

What is compared, and why each was worth comparing:

* **list** — the id set, the ORDER (``priority ASC, created_at DESC, id ASC``: a
  paginated caller sees a different page if this drifts), and every field the MCP's
  ``Issue`` model carries. That includes ``dependency_count``, which is *not* bd's own
  number: ``_sanitize_issue_deps`` rewrites it to the count of raw dependency records,
  and reproducing bd's raw value instead would be the wrong answer.
* **ready** / **blocked** — id sets, and for blocked the blocker id list. Not order:
  bd's ready order is `hybrid`, whose top bucket is "created in the last 48 hours", so
  it is a function of when you ask and a golden captured hours ago cannot pin it.
* **epics** — the ``epic_status`` view's rollup against `bd epic status`.

Known and accepted differences, asserted nowhere because no golden captures them:

* ``show``'s ``dependencies`` array is ordered ``(depends_on_id, dep_type)`` here and
  storage-natural (i.e. unspecified) in bd. The *contents* are identical; only the
  sequence differs, and bd's own sequence is not stable across boards.
* ``blocked_by`` is sorted here and unsorted in bd. It matches on every board in the
  fixtures, but a board where bd's order differed would still be correct.

Gated on ``FEADS_PG_TEST_DSN``. A failure here means either a real contract regression
or that the store was re-imported from data the fixtures no longer describe — the
assertion messages say which to check.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from beads_mcp import pgstore
from beads_mcp.models import ListIssuesParams, ReadyWorkParams

TEST_DSN_ENV = "FEADS_PG_TEST_DSN"
FIXTURES = Path(__file__).resolve().parents[3] / ".pg-fixtures"
BOARDS = ["example", "lab", "team-a", "team-b", "sample-apps"]

# Every field of the MCP's Issue model that a list row is supposed to carry. Omissions
# are deliberate: `dependencies`/`dependents` are emptied by the sanitizer on this path,
# and `external_ref` is absent from bd's list projection.
COMPARED_FIELDS = (
    "title",
    "status",
    "priority",
    "issue_type",
    "assignee",
    "labels",
    "description",
    "design",
    "acceptance_criteria",
    "notes",
    "created_at",
    "updated_at",
    "closed_at",
    "dependency_count",
    "dependent_count",
)

STALE = (
    "This can also mean the store was re-imported from data the golden fixtures no "
    "longer describe — re-capture .pg-fixtures/ before reading it as a regression."
)

pytestmark = [
    pytest.mark.skipif(
        not os.environ.get(TEST_DSN_ENV),
        reason=f"set {TEST_DSN_ENV} to run the contract conformance tests",
    ),
    pytest.mark.skipif(not FIXTURES.is_dir(), reason=f"no golden fixtures at {FIXTURES}"),
]


@pytest.fixture
async def pg(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FEADS_PG_DSN", os.environ[TEST_DSN_ENV])
    await pgstore.close_pool()
    try:
        yield
    finally:
        await pgstore.close_pool()


def golden(board: str, name: str) -> list[dict[str, object]]:
    path = FIXTURES / f"{board}.golden-{name}.json"
    if not path.is_file():
        pytest.skip(f"no golden capture at {path}")
    with path.open() as f:
        return json.load(f)


def bd_value(row: dict[str, object], field: str) -> object:
    """The golden row's value for a field, as the MCP's model would have carried it."""
    if field == "labels":
        return sorted(row.get("labels") or [])
    if field == "dependency_count":
        # The sanitizer's rewrite, not bd's own count. See the module docstring.
        deps = row.get("dependencies")
        return len(deps) if deps else (row.get("dependency_count") or 0)
    if field == "dependent_count":
        return row.get("dependent_count") or 0
    if field == "description":
        return row.get("description") or ""
    return row.get(field)


def pg_value(issue: object, field: str) -> object:
    value = getattr(issue, field)
    if field == "labels":
        return sorted(value)
    if field in ("created_at", "updated_at", "closed_at"):
        return None if value is None else value.strftime("%Y-%m-%dT%H:%M:%SZ")
    return value


@pytest.mark.parametrize("board", BOARDS)
class TestAgainstGoldenBdOutput:
    @pytest.mark.asyncio
    async def test_list_returns_the_same_rows_in_the_same_order(self, pg, board: str) -> None:
        want = golden(board, "list")
        got = await pgstore.PgStoreClient(board_id=board).list_issues(ListIssuesParams(limit=100))

        want_ids = [str(r["id"]) for r in want]
        got_ids = [i.id for i in got]
        assert set(got_ids) == set(want_ids), (
            f"{board}: list membership differs from bd — "
            f"missing {sorted(set(want_ids) - set(got_ids))}, "
            f"extra {sorted(set(got_ids) - set(want_ids))}. {STALE}"
        )
        assert got_ids == want_ids, f"{board}: list ORDER differs from bd. {STALE}"

    @pytest.mark.asyncio
    async def test_every_list_field_matches_bd(self, pg, board: str) -> None:
        want = golden(board, "list")
        got = {
            i.id: i for i in await pgstore.PgStoreClient(board_id=board).list_issues(ListIssuesParams(limit=100))
        }

        differences = []
        for row in want:
            issue = got.get(str(row["id"]))
            if issue is None:
                continue
            for field in COMPARED_FIELDS:
                a, b = bd_value(row, field), pg_value(issue, field)
                if a != b:
                    differences.append(f"{row['id']}.{field}: bd={a!r} pg={b!r}")
        assert not differences, f"{board}: {len(differences)} field difference(s):\n" + "\n".join(differences)

    @pytest.mark.asyncio
    async def test_ready_selects_the_same_beads(self, pg, board: str) -> None:
        want = {str(r["id"]) for r in golden(board, "ready")}
        got = {i.id for i in await pgstore.PgStoreClient(board_id=board).ready(ReadyWorkParams(limit=100))}
        assert got == want, (
            f"{board}: ready differs — missing {sorted(want - got)}, extra {sorted(got - want)}. {STALE}"
        )

    @pytest.mark.asyncio
    async def test_blocked_selects_the_same_beads_with_the_same_blockers(self, pg, board: str) -> None:
        want = golden(board, "blocked")
        got = await pgstore.PgStoreClient(board_id=board).blocked()

        want_ids = {str(r["id"]) for r in want}
        got_ids = {i.id for i in got}
        assert got_ids == want_ids, (
            f"{board}: blocked differs — missing {sorted(want_ids - got_ids)}, "
            f"extra {sorted(got_ids - want_ids)}. {STALE}"
        )

        by_id = {i.id: i for i in got}
        for row in want:
            issue = by_id[str(row["id"])]
            assert sorted(issue.blocked_by) == sorted(row.get("blocked_by") or []), (
                f"{board}/{row['id']}: blocker set differs"
            )
            assert issue.blocked_by_count == row.get("blocked_by_count")

    @pytest.mark.asyncio
    async def test_epic_rollup_matches_bd_epic_status(self, pg, board: str) -> None:
        want = {
            str(x["epic"]["id"]): (x["total_children"], x["closed_children"], x["eligible_for_close"])
            for x in golden(board, "epics")
        }
        pool = await pgstore.get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, total_children::int AS t, closed_children::int AS c, "
                "eligible_for_close AS e FROM epic_status WHERE board_id = $1",
                board,
            )
        got = {r["id"]: (r["t"], r["c"], r["e"]) for r in rows}
        assert got == want, f"{board}: epic rollup differs from bd. {STALE}"
