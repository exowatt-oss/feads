"""``_snapshot`` must consume exactly the columns the feed query selects."""

import asyncio
import os
from datetime import datetime, timezone

import pytest

from beads_mcp import change_feed, pgstore


def test_snapshot_reads_every_selected_column_including_deleted_at() -> None:
    now = datetime(2026, 9, 22, tzinfo=timezone.utc)
    row = dict.fromkeys(pgstore._ISSUE_COLUMN_NAMES)
    row.update(
        id="ex-1",
        board_id="example",
        title="t",
        status="open",
        metadata={"k": "v"},
        created_at=now,
        updated_at=now,
        deleted_at=None,
        labels=["b", "a"],
        dependencies=None,
        dependents=None,
        comments=None,
    )
    # Regression: this raised KeyError('deleted_at') for every non-empty page.
    snap = change_feed._snapshot(row)
    assert snap["id"] == "ex-1"
    assert snap["deleted_at"] is None
    assert snap["labels"] == ["a", "b"]
    assert snap["dependencies"] == snap["dependents"] == snap["comments"] == []
    assert snap["metadata"] == {"k": "v"}
    assert "deleted_at" in change_feed._SNAPSHOT_COLUMNS_I


def test_fit_page_cuts_before_the_sse_event_limit_but_keeps_one() -> None:
    big = {"events": [{"seq": "1"}], "description": "x" * 600}
    pages = [{**big, "events": [{"seq": str(i)}]} for i in range(5)]
    kept, cut = change_feed._fit_page(pages, max_bytes=1500)
    assert cut and len(kept) == 2 and kept[-1]["events"][-1]["seq"] == "1"
    kept, cut = change_feed._fit_page(pages[:1], max_bytes=10)
    assert not cut and len(kept) == 1
    assert change_feed._fit_page([]) == ([], False)


# =============================================================================
# Bounded pages and bounded time (FOLLOWUPS #9: prod `changes` silent for 50 min)
# =============================================================================


def test_an_oversized_change_is_shrunk_to_fit_and_says_so() -> None:
    """One change over the budget would be an undeliverable page that pins the cursor."""
    comments = [{"id": f"c{i}", "body": "y" * 300} for i in range(40)]
    change = {
        "id": "ex-1",
        "description": "d" * (change_feed.CLIPPED_FIELD_CHARS + 50),
        "comments": comments,
        "events": [{"seq": "7"}],
    }
    shrunk = change_feed._shrink_change(change, max_bytes=change_feed.CLIPPED_FIELD_CHARS + 4000)
    assert change_feed._json_size(shrunk) <= change_feed.CLIPPED_FIELD_CHARS + 4000
    assert shrunk["description"].endswith("call show() for the full text]")
    kept = shrunk["comments"]
    assert kept and kept[-1]["id"] == "c39", "the newest comments are the ones kept"
    assert shrunk["truncated"]["comments_omitted"] == 40 - len(kept)
    assert shrunk["truncated"]["fields_clipped"] == ["description"]
    assert shrunk["events"] == [{"seq": "7"}], "the cursor-bearing event is never dropped"
    small = {"id": "ex-2", "comments": [], "events": [{"seq": "8"}]}
    assert change_feed._shrink_change(small) is small


async def test_a_wedged_feed_answers_with_a_retryable_error_instead_of_hanging(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def wedged(**_: object) -> dict[str, object]:
        await asyncio.sleep(60)
        return {}

    monkeypatch.setattr(change_feed, "_fetch_changes", wedged)
    with pytest.raises(RuntimeError, match=r"did not finish within 0\.05s.*retry the same after_cursor"):
        await change_feed.fetch_changes(after_cursor="18804", limit=500, timeout=0.05)


def test_the_timeouts_are_configurable_and_sane(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(change_feed.CHANGES_TIMEOUT_ENV, "12")
    assert change_feed.changes_timeout() == 12
    monkeypatch.setenv(change_feed.CHANGES_TIMEOUT_ENV, "nonsense")
    assert change_feed.changes_timeout() == change_feed.DEFAULT_CHANGES_TIMEOUT_S
    monkeypatch.delenv(pgstore.PG_COMMAND_TIMEOUT_ENV, raising=False)
    assert pgstore.pg_command_timeout() == pgstore.DEFAULT_PG_COMMAND_TIMEOUT_S
    monkeypatch.setenv(pgstore.PG_COMMAND_TIMEOUT_ENV, "0")
    assert pgstore.pg_command_timeout() is None


FEED_BOARD = "beads-mcp-feed-pytest"


@pytest.mark.skipif(not os.environ.get("FEADS_PG_TEST_DSN"), reason="set FEADS_PG_TEST_DSN")
async def test_a_page_reads_only_the_snapshots_it_returns_and_the_cursor_walks_to_the_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FEADS_PG_DSN", os.environ["FEADS_PG_TEST_DSN"])
    await pgstore.close_pool()
    pool = await pgstore.get_pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM events WHERE board_id = $1", FEED_BOARD)
        await conn.execute("DELETE FROM issues WHERE board_id = $1", FEED_BOARD)
        await conn.execute(
            "INSERT INTO boards (id, prefix) VALUES ($1, 'fdt') ON CONFLICT (id) DO NOTHING", FEED_BOARD
        )
        start = int(await conn.fetchval("SELECT COALESCE(MAX(seq), 0) FROM events"))
        for i in range(30):
            issue_id = f"fdt-{i:03d}"
            await conn.execute(
                "INSERT INTO issues (id, board_id, title, description, status, priority, issue_type,"
                " created_at, updated_at) VALUES ($1, $2, $3, $4, 'open', 2, 'task', now(), now())",
                issue_id,
                FEED_BOARD,
                f"issue {i}",
                "x" * 2000,
            )
            await conn.execute(
                "INSERT INTO events (board_id, issue_id, actor, kind, payload, at)"
                " VALUES ($1, $2, 'tester', 'created', '{}'::jsonb, now())",
                FEED_BOARD,
                issue_id,
            )
    reads: list[int] = []
    real_read = change_feed._read_snapshots

    async def counting(conn: object, rows: list[object]) -> object:
        reads.append(len(rows))
        return await real_read(conn, rows)

    monkeypatch.setattr(change_feed, "_read_snapshots", counting)
    monkeypatch.setattr(change_feed, "SNAPSHOT_CHUNK", 5)
    monkeypatch.setattr(change_feed, "MAX_PAGE_BYTES", 12_000)
    try:
        cursor: str | None = str(start)
        seen: list[str] = []
        for _ in range(20):
            page = await change_feed.fetch_changes(after_cursor=cursor, boards=[FEED_BOARD], limit=500)
            seen += [c["id"] for c in page["changes"]]
            # ~2.4 KB per change against a 12 KB budget: a handful per page, and the
            # page read only a chunk or two of snapshots — never all 30 it was offered.
            assert 1 <= len(page["changes"]) <= 6
            assert sum(reads) <= len(page["changes"]) + 5
            reads.clear()
            if page["complete"]:
                break
            cursor = page["next_cursor"]
        assert seen == [f"fdt-{i:03d}" for i in range(30)], "every change exactly once, in seq order"
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM events WHERE board_id = $1", FEED_BOARD)
            await conn.execute("DELETE FROM issues WHERE board_id = $1", FEED_BOARD)
            await conn.execute("DELETE FROM boards WHERE id = $1", FEED_BOARD)
        await pgstore.close_pool()
