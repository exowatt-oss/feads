"""Notifications, the ``@mention`` directory, and the two parsers everyone shares.

Three things get more attention than the rest, because each is silent when broken:

- **The parsers are a cross-runtime contract.** The same two regexes live in the Node
  notification engine (which decides who is notified) and in the browser (which links
  and highlights). A divergence does not raise anywhere; it just means this server
  reports a mention the engine will not deliver, or stays quiet about one it will. The
  parsing cases below are therefore written against the contract's own regexes rather
  than against what this implementation happens to do — every one of them is a case
  where a plausible simplification changes the answer.
- **A registry with no ``notifications`` table is normal, not broken.** It is what a
  machine looks like before its dashboard is new enough to have notified anyone, and
  the only correct answer there is "you have nothing". The same goes one column finer for
  ``handled_at``, which arrives with schema v4: a registry without it is old, so the
  fallback to ``read_at`` is a case under test rather than a safety net nobody exercises.
- **Seen and handled are different, and this surface queues on handled.** ``read_at`` is a
  human having glanced at the bell; ``handled_at`` is an agent having answered. Getting
  this backwards is silent in both directions — a human's glance would discharge the
  agent's obligation, or an acked row would keep reappearing — so the cases below pin
  which timestamp each filter and each count reads.
- **The ack sends a credential.** The HTTP layer is stubbed, never live, and the
  assertions are about *what was sent* — which body, which header, and on which
  transport — because the dangerous case is an anonymous HTTP caller acking the host
  agent's inbox through the dashboard's loopback fallback.
"""

import email.message
import io
import json
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request

import pytest
from fastmcp.client import Client

from beads_mcp import notifications as notify
from beads_mcp import transport as wire
from beads_mcp.agents import AGENT_TOKEN_ENV, AGENT_TOKEN_PREFIX, SESSION_ID_ENV, hash_token
from beads_mcp.authz import REQUIRE_AGENT_ENV
from beads_mcp.boards import REGISTRY_DB_ENV
from beads_mcp.models import Comment
from beads_mcp.notifications import (
    ACK_PATH,
    MAX_NOTIFICATION_LIMIT,
    annotate_comments,
    comment_enrichment,
    enrich_comment_result,
    issue_url,
    notifications_ack_payload,
    notifications_payload,
    parse_issue_refs,
    parse_mentions,
    read_notifications,
    resolve_mentions,
    users_list_payload,
)
from beads_mcp.server import mcp
from tests.agent_registry_fixture import build_registry

USER_TOKEN = f"{AGENT_TOKEN_PREFIX}1111111111111111111111111111111a"
OTHER_TOKEN = f"{AGENT_TOKEN_PREFIX}2222222222222222222222222222222b"
REVOKED_TOKEN = f"{AGENT_TOKEN_PREFIX}3333333333333333333333333333333c"

DASHBOARD = "http://127.0.0.1:4141"
ACK_URL = f"{DASHBOARD}{ACK_PATH}"


@pytest.fixture(autouse=True)
def stdio_transport(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Pin the transport to stdio and strip ambient identity.

    The transport flag is process-wide module state, so a test that flips it and does
    not restore it turns every later assertion about the ack body into a false pass.
    """
    for name in (AGENT_TOKEN_ENV, SESSION_ID_ENV, REQUIRE_AGENT_ENV, REGISTRY_DB_ENV, wire.DASHBOARD_URL_ENV):
        monkeypatch.delenv(name, raising=False)
    previous = wire.serving_http()
    wire.set_http_transport(False)
    yield
    wire.set_http_transport(previous)


def agent_rows() -> list[dict[str, Any]]:
    """Two live agents on two boards, plus one revoked.

    Two boards on purpose: the directory and the mention matcher are both specified as
    cross-board, and a single-board fixture cannot tell a cross-board lookup from one
    that silently scoped itself to the caller's board.
    """
    return [
        {
            "id": "ag_user",
            "actor": "laptop-claude",
            "display_name": "laptop claude",
            "role": "user",
            "token_hash": hash_token(USER_TOKEN),
            "last_seen_at": 300,
        },
        {
            "id": "ag_other",
            "actor": "desk-claude",
            "display_name": "desk claude",
            "role": "admin",
            "board_id": "ops",
            "token_hash": hash_token(OTHER_TOKEN),
            "last_seen_at": 200,
        },
        {
            "id": "ag_dead",
            "actor": "old-agent",
            "role": "user",
            "token_hash": hash_token(REVOKED_TOKEN),
            "revoked_at": 500,
            "revoke_reason": "rotated",
        },
    ]


def notification_rows() -> list[dict[str, Any]]:
    """Four rows for ``laptop-claude`` (one dealt with, one on another board) and one for somebody else.

    ``n_old`` is stamped seen *and* handled, which is what an agent's own ack leaves
    behind. The rows where the two timestamps disagree are the interesting ones and get
    their own registries below, so that the fixture every other case reads stays a
    fixture about listing, ordering and scope rather than about the split.
    """
    return [
        {
            "id": "n_old",
            "recipient_actor": "laptop-claude",
            "type": "comment_on_owned",
            "issue_id": "lab-aaa",
            "issue_title": "Older, already read",
            "actor": "desk-claude",
            "snippet": "an earlier comment",
            "created_at": 1000,
            "read_at": 1500,
            "handled_at": 1500,
        },
        {
            "id": "n_mid",
            "recipient_actor": "laptop-claude",
            "type": "mention",
            "issue_id": "lab-bbb",
            "issue_title": "You were named",
            "actor": "desk-claude",
            "snippet": "@laptop-claude can you look at this",
            "created_at": 2000,
        },
        {
            "id": "n_new",
            "board_id": "ops",
            "recipient_actor": "laptop-claude",
            "type": "dependency_completed",
            "issue_id": "ops-ccc",
            "issue_title": "Unblocked",
            "actor": "desk-claude",
            "related_issue": "ops-bbb",
            "created_at": 3000,
        },
        {
            "id": "n_theirs",
            "recipient_actor": "desk-claude",
            "type": "assigned",
            "issue_id": "lab-ddd",
            "issue_title": "Not yours",
            "created_at": 4000,
        },
    ]


@pytest.fixture
def registry(tmp_path: Path) -> str:
    """A v4 registry: two live agents, one revoked, and an inbox for each."""
    return build_registry(
        tmp_path / "registry.db",
        agent_rows(),
        boards=("lab", "ops"),
        notifications=notification_rows(),
    )


@pytest.fixture
def registry_v2(tmp_path: Path) -> str:
    """A registry from before the notification engine existed — no ``notifications`` table."""
    return build_registry(tmp_path / "old.db", agent_rows(), boards=("lab", "ops"))


@pytest.fixture
def registry_v3(tmp_path: Path) -> str:
    """A registry from before the seen/handled split — a ``notifications`` table, no ``handled_at``.

    The same rows as :func:`registry`, so the two fixtures are directly comparable: every
    assertion that holds on one and not the other is the split showing, not the data
    differing.
    """
    return build_registry(
        tmp_path / "v3.db",
        agent_rows(),
        boards=("lab", "ops"),
        notifications=notification_rows(),
        handled_column=False,
    )


def as_user(**extra: str) -> dict[str, str]:
    """An environment presenting ``laptop-claude``'s token."""
    return {AGENT_TOKEN_ENV: USER_TOKEN, **extra}


# =============================================================================
# The parsers
# =============================================================================


class TestMentionParsing:
    """``/(^|[^\\w@])@([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)/gi``, ported character for character."""

    @pytest.mark.parametrize(
        "text,expected",
        [
            ("@mira", ["mira"]),
            ("ask @mira about it", ["mira"]),
            ("(@mira) and [@desk-claude]", ["mira", "desk-claude"]),
            ("dots.and_underscores: @a.b_c-d", ["a.b_c-d"]),
            ("digits lead too: @2claude", ["2claude"]),
            ("newline\n@mira", ["mira"]),
            # A handle never ends in `.`, `_` or `-`: sentence punctuation is not part of it.
            ("cc @mira.", ["mira"]),
            ("ping @dana-laptop- and @a.b_c-d_.", ["dana-laptop", "a.b_c-d"]),
            ("thanks @mira...", ["mira"]),
        ],
    )
    def test_names_are_found_wherever_a_boundary_precedes_them(self, text: str, expected: list[str]) -> None:
        assert parse_mentions(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            # The case the leading group exists for. Without it every email address in
            # every comment would notify somebody.
            "mail me at user@example.com",
            "x@y",
            # `@` is excluded from the preceding class, so `@@` is not a mention of the
            # second one — decorative doubling stays decorative.
            "@@mira",
            # A name has to start with a letter or digit.
            "@-mira",
            "@.mira",
            # A bare sigil is not a name.
            "look @ this",
        ],
    )
    def test_non_mentions_are_not_mentions(self, text: str) -> None:
        assert parse_mentions(text) == []

    def test_matching_is_case_insensitive_but_the_spelling_survives(self) -> None:
        """Case folding belongs to the *matcher*, not the parser.

        The parser hands back what was written, so a caller can quote the comment back
        accurately; resolving `@mira` to the actor `mira` is
        :func:`resolve_mentions`' job, which needs the registry to do it.
        """
        assert parse_mentions("@mira and @LAPTOP-Claude") == ["mira", "LAPTOP-Claude"]

    def test_one_name_written_twice_in_any_case_is_one_mention(self) -> None:
        assert parse_mentions("@mira ... @mira ... @mira") == ["mira"]

    def test_a_name_stops_at_sixty_four_characters(self) -> None:
        """`[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?` — at most 64 characters."""
        assert parse_mentions("@" + "a" * 64) == ["a" * 64]
        assert parse_mentions("@" + "a" * 70) == ["a" * 64]

    def test_a_non_ascii_letter_is_still_a_boundary(self) -> None:
        """``re.ASCII`` is load-bearing.

        Python's ``\\w`` is Unicode-aware and JavaScript's is not, so without the flag
        this server would disagree with the notification engine about whether
        ``café@bob`` names anybody — the engine delivers, and this would say nothing
        was addressed.
        """
        assert parse_mentions("café@bob") == ["bob"]


class TestMentionCasesFixture:
    """boards/mention-cases.json — the same cases boards/mentions.mjs and rich-text.js run."""

    CASES = json.loads((Path(__file__).resolve().parents[3] / "boards" / "mention-cases.json").read_text())[
        "cases"
    ]

    @pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
    def test_shared_case(self, case: dict[str, Any]) -> None:
        assert parse_mentions(case["text"]) == case["handles"]
        if "tokens" in case:
            assert [dict(t) for t in notify.extract_mentions(case["text"])] == case["tokens"]

    def test_lookup_keys(self) -> None:
        assert notify.mention_lookup_keys("mira") == ["mira"]
        assert notify.mention_lookup_keys("mira@example.test") == ["mira@example.test", "mira"]
        assert notify.mention_lookup_keys("dana.lee@example.test") == [
            "dana.lee@example.test",
            "dana-lee",
        ]
        assert notify.mention_lookup_keys("") == []


class TestIssueRefParsing:
    """``/(^|[^\\w#])#([a-z][a-z0-9]*-[a-zA-Z0-9._-]*[a-zA-Z0-9_])/g`` — note: no ``i`` flag."""

    @pytest.mark.parametrize(
        "text,expected",
        [
            ("#ex-abc", ["ex-abc"]),
            ("see #ex-abc and #bd-1f2e", ["ex-abc", "bd-1f2e"]),
            ("mixed case after the dash is fine: #ex-AbC", ["ex-AbC"]),
            ("dots inside: #ex-a.b", ["ex-a.b"]),
            ("(#ex-abc)", ["ex-abc"]),
        ],
    )
    def test_ids_are_found(self, text: str, expected: list[str]) -> None:
        assert parse_issue_refs(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            # A prefix has to be lowercase, which is what keeps prose out. Matching
            # case-insensitively would turn "#Chapter-2" into a broken link.
            "#EX-abc",
            "#Chapter-2",
            # No prefix at all: a plain number is a GitHub issue, not a bead.
            "see #123",
            # A bare prefix with nothing after the dash.
            "#ex-",
            # Preceded by a word character, so `abc#ex-1` is not a reference.
            "abc#ex-1",
            # `#` is excluded from the preceding class.
            "##ex-abc",
        ],
    )
    def test_non_refs_are_not_refs(self, text: str) -> None:
        assert parse_issue_refs(text) == []

    def test_trailing_punctuation_is_left_out_of_the_id(self) -> None:
        """The closing `[a-zA-Z0-9_]` is why a sentence can end in a reference."""
        assert parse_issue_refs("fixed by #ex-abc.") == ["ex-abc"]
        assert parse_issue_refs("fixed by #ex-abc-") == ["ex-abc"]

    def test_the_same_id_twice_is_one_ref(self) -> None:
        assert parse_issue_refs("#ex-abc then #ex-abc again") == ["ex-abc"]

    def test_the_url_is_the_dashboard_origin_plus_the_hash_route(self) -> None:
        """Locked: `{dashboard_url()}/#/issues?issue=X`, byte for byte with the UI's own link."""
        assert issue_url("ex-abc") == f"{DASHBOARD}/#/issues?issue=ex-abc"
        assert issue_url("ex-abc", {"FEADS_DASHBOARD_URL": "http://box:9000/"}) == (
            "http://box:9000/#/issues?issue=ex-abc"
        )

    def test_a_public_url_wins_over_the_proxy_url_for_links(self) -> None:
        """FEADS_PUBLIC_URL is what a browser can reach; the loopback proxy URL must not leak into links."""
        env = {
            "FEADS_DASHBOARD_URL": "http://127.0.0.1:4141",
            "FEADS_PUBLIC_URL": "https://feads.apps.example.test/",
        }
        assert issue_url("ex-abc", env) == ("https://feads.apps.example.test/#/issues?issue=ex-abc")
        # Without the split configured, single-host setups keep the old behavior.
        assert issue_url("ex-abc", {"FEADS_DASHBOARD_URL": "http://box:9000"}) == (
            "http://box:9000/#/issues?issue=ex-abc"
        )


class TestResolvingMentionsAgainstTheRegistry:
    def test_live_actors_are_returned_in_the_registrys_spelling(self, registry: str) -> None:
        match = resolve_mentions("@LAPTOP-Claude and @Desk-Claude", registry)
        assert match["mentioned"] == ["laptop-claude", "desk-claude"]
        assert match["unmatched"] == []
        assert match["verified"] is True

    def test_matching_crosses_boards(self, registry: str) -> None:
        """``desk-claude`` is registered on ``ops``; naming it from anywhere must work."""
        assert resolve_mentions("@desk-claude", registry)["mentioned"] == ["desk-claude"]

    def test_a_revoked_agent_is_not_a_live_actor(self, registry: str) -> None:
        match = resolve_mentions("@old-agent", registry)
        assert match["mentioned"] == []
        assert match["unmatched"] == ["old-agent"]

    def test_a_name_belonging_to_nobody_is_reported_as_unmatched(self, registry: str) -> None:
        match = resolve_mentions("@laptop-claude and @nobody", registry)
        assert match["mentioned"] == ["laptop-claude"]
        assert match["unmatched"] == ["nobody"]

    def test_an_unreadable_registry_degrades_to_the_raw_candidates(self, tmp_path: Path) -> None:
        """Documented behaviour: candidates, flagged unverified, rather than nothing.

        Claiming every name is unmatched would be a confident answer with no basis, and
        dropping them would hide that the comment addressed anybody at all.
        """
        match = resolve_mentions("@mira and @nobody", str(tmp_path / "absent.db"))
        assert match["mentioned"] == ["mira", "nobody"]
        assert match["unmatched"] == []
        assert match["verified"] is False

    def test_text_with_no_names_never_opens_the_registry(self, tmp_path: Path) -> None:
        match = resolve_mentions("no names here", str(tmp_path / "absent.db"))
        assert match == {"mentioned": [], "unmatched": [], "verified": True}


# =============================================================================
# users_list
# =============================================================================


class TestUsersListPayload:
    def test_live_agents_from_every_board_are_listed(self, registry: str) -> None:
        payload = users_list_payload(env=as_user(), db_path=registry)
        assert [user["actor"] for user in payload["users"]] == ["laptop-claude", "desk-claude"]
        assert payload["count"] == 2
        assert payload["registry_path"] == registry

    def test_revoked_agents_are_excluded_by_default(self, registry: str) -> None:
        payload = users_list_payload(env=as_user(), db_path=registry)
        assert "old-agent" not in [user["actor"] for user in payload["users"]]
        assert all("revoked_at" not in user for user in payload["users"])

    def test_include_revoked_adds_the_rows_and_the_column(self, registry: str) -> None:
        payload = users_list_payload(include_revoked=True, env=as_user(), db_path=registry)
        by_actor = {user["actor"]: user for user in payload["users"]}
        assert "old-agent" in by_actor
        assert by_actor["old-agent"]["revoked_at"] == 500
        assert by_actor["laptop-claude"]["revoked_at"] == 0

    def test_the_directory_carries_no_host_or_session_columns(self, registry: str) -> None:
        """Narrower than the roster on purpose — "what do I call them", not "where are they"."""
        user = users_list_payload(env=as_user(), db_path=registry)["users"][0]
        assert set(user) == {
            "actor",
            "display_name",
            "role",
            "kind",
            "board_id",
            "registered_at",
            "last_seen_at",
        }

    def test_an_anonymous_caller_gets_an_empty_directory_and_a_hint(self, registry: str) -> None:
        wire.set_http_transport(True)  # anonymous over HTTP is `anonymous`, not `operator`
        payload = users_list_payload(env={}, db_path=registry)
        assert payload["users"] == []
        assert payload["count"] == 0
        assert payload["reason"] == "anonymous"
        assert "agent_signup" in payload["hint"]

    def test_a_rejected_credential_does_not_fall_back_to_the_anonymous_answer(self, registry: str) -> None:
        """A revoked agent must not see *more* than it did before it was revoked."""
        payload = users_list_payload(env={AGENT_TOKEN_ENV: REVOKED_TOKEN}, db_path=registry)
        assert payload["users"] == []
        assert payload["reason"] == "rejected"

    def test_the_operator_on_stdio_reads_the_directory(self, registry: str) -> None:
        """Unrestricted locally, and there is nothing administrative in a list of names."""
        payload = users_list_payload(env={}, db_path=registry)
        assert payload["count"] == 2
        assert "reason" not in payload

    def test_a_missing_registry_is_an_empty_directory_with_a_hint(self, tmp_path: Path) -> None:
        payload = users_list_payload(env={}, db_path=str(tmp_path / "absent.db"))
        assert payload["users"] == []
        assert "error" in payload
        assert "hint" in payload


# =============================================================================
# notifications
# =============================================================================


class TestReadNotifications:
    def test_a_registry_without_the_table_answers_empty(self, registry_v2: str) -> None:
        """The state of a machine whose dashboard predates the feature — not a fault."""
        rows, unread = read_notifications("laptop-claude", db_path=registry_v2)
        assert rows == []
        assert unread == 0

    def test_unread_only_filters_the_listing(self, registry: str) -> None:
        rows, _ = read_notifications("laptop-claude", unread_only=True, db_path=registry)
        assert [row["id"] for row in rows] == ["n_new", "n_mid"]

    def test_dropping_unread_only_includes_acknowledged_rows(self, registry: str) -> None:
        rows, _ = read_notifications("laptop-claude", unread_only=False, db_path=registry)
        assert [row["id"] for row in rows] == ["n_new", "n_mid", "n_old"]

    def test_rows_come_back_newest_first_across_every_board(self, registry: str) -> None:
        rows, _ = read_notifications("laptop-claude", unread_only=False, db_path=registry)
        assert [row["created_at"] for row in rows] == [3000, 2000, 1000]
        assert {row["board_id"] for row in rows} == {"lab", "ops"}

    def test_only_the_recipients_own_rows_are_returned(self, registry: str) -> None:
        rows, _ = read_notifications("laptop-claude", unread_only=False, db_path=registry)
        assert "n_theirs" not in [row["id"] for row in rows]

    def test_the_unread_count_ignores_both_the_filter_and_the_limit(self, registry: str) -> None:
        """So "showing 1 of 2" is expressible and a page cannot be mistaken for the inbox."""
        rows, unread = read_notifications("laptop-claude", unread_only=False, limit=1, db_path=registry)
        assert len(rows) == 1
        assert unread == 2

    def test_the_limit_is_clamped_rather_than_trusted(self, registry: str) -> None:
        rows, _ = read_notifications("laptop-claude", unread_only=False, limit=10**9, db_path=registry)
        assert len(rows) == 3
        assert MAX_NOTIFICATION_LIMIT == 200

    def test_every_row_carries_the_wire_shape_with_an_absolute_url(self, registry: str) -> None:
        rows, _ = read_notifications("laptop-claude", unread_only=True, db_path=registry)
        row = next(entry for entry in rows if entry["id"] == "n_new")
        assert row == {
            "id": "n_new",
            "board_id": "ops",
            "recipient_actor": "laptop-claude",
            "type": "dependency_completed",
            "issue_id": "ops-ccc",
            "issue_title": "Unblocked",
            "actor": "desk-claude",
            "snippet": "",
            "related_issue": "ops-bbb",
            "created_at": 3000,
            "read_at": 0,
            "handled_at": 0,
            "url": f"{DASHBOARD}/#/issues?issue=ops-ccc",
            # Additive since the human/agent split: a registry without the collapse
            # columns reports one event and derives the guidance the engine would store.
            "count": 1,
            "guidance": (
                "Blocker #ops-bbb is closed — #ops-ccc may be ready; check ready() and pick it up if it is yours."
            ),
            "audience": "agent",
        }

    def test_an_empty_actor_has_no_inbox(self, registry: str) -> None:
        assert read_notifications("", db_path=registry) == ([], 0)


class TestTheHandledQueue:
    """Which of the two timestamps this surface filters and counts on.

    Every case here is a row where ``read_at`` and ``handled_at`` disagree, because that is
    the only place the split is observable — and where getting it backwards is silent.
    """

    def one_row(self, tmp_path: Path, name: str, **stamps: int) -> str:
        """A registry holding a single row for ``laptop-claude``, stamped as asked."""
        return build_registry(
            tmp_path / f"{name}.db",
            agent_rows(),
            boards=("lab", "ops"),
            notifications=[
                {
                    "id": "n_one",
                    "recipient_actor": "laptop-claude",
                    "issue_id": "lab-aaa",
                    "created_at": 100,
                    **stamps,
                }
            ],
        )

    def test_a_row_a_human_read_is_still_unhandled_here(self, tmp_path: Path) -> None:
        """The case the split exists for.

        Somebody clicked the dashboard's bell. Nothing about that means the agent it was
        addressed to has answered, so it is still listed and still counted — under the old
        one-timestamp reading it would have vanished from the agent's queue unasked.
        """
        seen = self.one_row(tmp_path, "seen", read_at=1500, handled_at=0)
        rows, unhandled = read_notifications("laptop-claude", unread_only=True, db_path=seen)
        assert [row["id"] for row in rows] == ["n_one"]
        assert unhandled == 1
        assert rows[0]["read_at"] == 1500
        assert rows[0]["handled_at"] == 0

    def test_a_handled_row_leaves_the_queue_even_if_no_human_ever_saw_it(self, tmp_path: Path) -> None:
        """And the converse: an agent's ack settles the row on its own authority."""
        handled = self.one_row(tmp_path, "handled", read_at=0, handled_at=1500)
        rows, unhandled = read_notifications("laptop-claude", unread_only=True, db_path=handled)
        assert rows == []
        assert unhandled == 0

        history, _ = read_notifications("laptop-claude", unread_only=False, db_path=handled)
        assert [row["id"] for row in history] == ["n_one"]
        assert history[0]["handled_at"] == 1500

    def test_the_count_is_the_unhandled_count_not_the_unseen_one(self, tmp_path: Path) -> None:
        """`unread_only=False` widens the listing; the count still answers "what is unhandled"."""
        seen = self.one_row(tmp_path, "counted", read_at=1500, handled_at=0)
        rows, unhandled = read_notifications("laptop-claude", unread_only=False, db_path=seen)
        assert len(rows) == 1
        assert unhandled == 1


class TestAPreSplitRegistry:
    """A registry with the ``notifications`` table but no ``handled_at``: old, not broken.

    Nothing here should look different from how this module behaved before the split
    existed, because on such a registry ``read_at`` genuinely was the answer to both
    questions. The one thing that must still hold is the wire shape — an agent reading
    ``handled_at`` cannot be handed a missing key just because the dashboard is old.
    """

    def test_the_filter_and_the_count_fall_back_to_read_at(self, registry_v3: str) -> None:
        rows, unread = read_notifications("laptop-claude", unread_only=True, db_path=registry_v3)
        assert [row["id"] for row in rows] == ["n_new", "n_mid"]
        assert unread == 2

    def test_every_row_still_carries_handled_at_mirroring_read_at(self, registry_v3: str) -> None:
        """The pre-split world stated in the new vocabulary: seeing *was* handling."""
        rows, _ = read_notifications("laptop-claude", unread_only=False, db_path=registry_v3)
        by_id = {row["id"]: row for row in rows}
        assert by_id["n_old"]["read_at"] == 1500
        assert by_id["n_old"]["handled_at"] == 1500
        assert by_id["n_mid"]["handled_at"] == 0

    def test_the_missing_column_is_not_reported_as_an_unreadable_registry(self, registry_v3: str) -> None:
        """The whole point of probing rather than catching: this must be an answer, not an error."""
        payload = notifications_payload(env=as_user(), db_path=registry_v3)
        assert [row["id"] for row in payload["notifications"]] == ["n_new", "n_mid"]
        assert payload["unread_count"] == 2
        assert "error" not in payload


class TestNotificationsPayload:
    def test_the_acting_identity_decides_whose_inbox_this_is(self, registry: str) -> None:
        payload = notifications_payload(env=as_user(), db_path=registry)
        assert payload["actor"] == "laptop-claude"
        assert [row["id"] for row in payload["notifications"]] == ["n_new", "n_mid"]
        assert payload["unread_count"] == 2

    def test_another_agents_token_reads_that_agents_inbox(self, registry: str) -> None:
        payload = notifications_payload(env={AGENT_TOKEN_ENV: OTHER_TOKEN}, db_path=registry)
        assert payload["actor"] == "desk-claude"
        assert [row["id"] for row in payload["notifications"]] == ["n_theirs"]

    def test_an_unidentified_caller_gets_an_empty_inbox_rather_than_a_refusal(self, registry: str) -> None:
        """Including the operator on stdio, who is unrestricted and still has no address."""
        payload = notifications_payload(env={}, db_path=registry)
        assert payload["notifications"] == []
        assert payload["unread_count"] == 0
        assert payload["actor"] is None
        assert "addressed to a registered actor" in payload["hint"]
        assert "error" not in payload

    def test_a_rejected_credential_is_not_an_actor(self, registry: str) -> None:
        """A revoked agent reads nobody's inbox, least of all the one it used to have."""
        payload = notifications_payload(env={AGENT_TOKEN_ENV: REVOKED_TOKEN}, db_path=registry)
        assert payload["actor"] is None
        assert payload["notifications"] == []

    def test_a_registry_without_the_table_is_an_empty_inbox_not_an_error(self, registry_v2: str) -> None:
        payload = notifications_payload(env=as_user(), db_path=registry_v2)
        assert payload["actor"] == "laptop-claude"
        assert payload["notifications"] == []
        assert payload["unread_count"] == 0
        assert "error" not in payload

    def test_urls_are_absolute_and_follow_the_configured_dashboard(self, registry: str) -> None:
        payload = notifications_payload(
            env=as_user(FEADS_DASHBOARD_URL="http://box:9000"),
            db_path=registry,
        )
        assert payload["notifications"][0]["url"] == "http://box:9000/#/issues?issue=ops-ccc"

    def test_an_inbox_acked_to_the_end_still_points_at_its_history(self, tmp_path: Path) -> None:
        """Nothing unhandled is not nothing at all — the hint says how to see the rest."""
        acked = build_registry(
            tmp_path / "allread.db",
            agent_rows(),
            boards=("lab", "ops"),
            notifications=[
                {
                    "id": "n_done",
                    "recipient_actor": "laptop-claude",
                    "issue_id": "lab-aaa",
                    "created_at": 100,
                    "read_at": 200,
                    "handled_at": 200,
                }
            ],
        )
        unread_view = notifications_payload(env=as_user(), db_path=acked)
        assert unread_view["notifications"] == []
        assert unread_view["unread_count"] == 0
        assert "unread_only=False" in unread_view["hint"]

        full_view = notifications_payload(unread_only=False, env=as_user(), db_path=acked)
        assert [row["id"] for row in full_view["notifications"]] == ["n_done"]
        assert "hint" not in full_view

    def test_the_unread_count_counts_what_nobody_acked_not_what_nobody_read(self, tmp_path: Path) -> None:
        """The wire key keeps its name across surfaces; on this one it carries the unhandled count.

        A row the human already cleared from their bell is still the agent's to answer, so
        it is still listed and still counted — and the hint has to be the one that says
        there is something here, not the one that says the queue is empty.
        """
        seen_not_handled = build_registry(
            tmp_path / "seen.db",
            agent_rows(),
            boards=("lab", "ops"),
            notifications=[
                {
                    "id": "n_seen",
                    "recipient_actor": "laptop-claude",
                    "issue_id": "lab-aaa",
                    "created_at": 100,
                    "read_at": 200,
                    "handled_at": 0,
                }
            ],
        )
        payload = notifications_payload(env=as_user(), db_path=seen_not_handled)
        assert [row["id"] for row in payload["notifications"]] == ["n_seen"]
        assert payload["unread_count"] == 1
        assert "hint" not in payload

    def test_the_empty_queue_hint_says_which_queue_was_empty(self, tmp_path: Path) -> None:
        """Saying "nothing unread" would read as "nobody looked", which is not what was checked."""
        empty = build_registry(
            tmp_path / "nothing.db",
            agent_rows(),
            boards=("lab", "ops"),
            notifications=[],
        )
        hint = notifications_payload(env=as_user(), db_path=empty)["hint"]
        assert "acknowledged" in hint
        assert "bell" in hint

    def test_an_empty_unread_inbox_hints_at_unread_only_false(self, tmp_path: Path) -> None:
        empty = build_registry(
            tmp_path / "empty.db",
            agent_rows(),
            boards=("lab", "ops"),
            notifications=[],
        )
        payload = notifications_payload(env=as_user(), db_path=empty)
        assert payload["notifications"] == []
        assert "unread_only=False" in payload["hint"]


# =============================================================================
# notifications_ack — what gets sent, and to whom
# =============================================================================


class FakeResponse:
    """A 2xx response, shaped like what ``urlopen`` yields."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self._body = io.BytesIO(body.encode("utf-8"))

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def http_error(status: int, body: str) -> HTTPError:
    """A 4xx/5xx as ``urlopen`` raises it.

    A real :class:`HTTPError` rather than a stand-in, because the code under test
    relies on an ``HTTPError`` *being* a response — reading the body off the exception
    is what recovers the endpoint's own error code.
    """
    return HTTPError(ACK_URL, status, "", email.message.Message(), io.BytesIO(body.encode("utf-8")))


class Dashboard:
    """A stand-in for the ack endpoint that records what it was asked.

    Recording matters as much as answering: the interesting assertions here are about
    the request, not the reply.
    """

    def __init__(self, outcome: object) -> None:
        self.outcome = outcome
        self.requests: list[Request] = []

    def __call__(self, request: Request, timeout: float | None = None) -> object:
        self.requests.append(request)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome

    @property
    def called(self) -> bool:
        return bool(self.requests)

    def body(self, index: int = 0) -> dict[str, Any]:
        data = self.requests[index].data
        assert isinstance(data, bytes)
        parsed = json.loads(data.decode("utf-8"))
        assert isinstance(parsed, dict)
        return parsed

    def header(self, name: str, index: int = 0) -> str:
        return str(self.requests[index].get_header(name.capitalize()) or "")


def ok_response(acked: int = 2, unread: int = 0, unhandled: int | None = None) -> FakeResponse:
    """A successful ack, answering with both counts as the dashboard has since the split.

    ``unhandled`` defaults to ``unread`` so the cases that care about neither read the same
    whichever number the code picks up; the two are passed apart only where the point is
    which one this surface reports.
    """
    body = {
        "ok": True,
        "acked": acked,
        "unread_count": unread,
        "unhandled_count": unread if unhandled is None else unhandled,
    }
    return FakeResponse(200, json.dumps(body))


def ack(
    dashboard: Dashboard,
    monkeypatch: pytest.MonkeyPatch,
    registry: str,
    ids: list[str] | None = None,
    all: bool = False,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Call the payload builder with the HTTP layer stubbed."""
    monkeypatch.setattr(notify, "urlopen", dashboard)
    return notifications_ack_payload(ids, all, env if env is not None else as_user(), registry)


class TestAckRequestComposition:
    def test_ids_are_sent_to_the_ack_route(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        dashboard = Dashboard(ok_response(acked=2, unread=1))
        result = ack(dashboard, monkeypatch, registry, ids=["n_mid", "n_new"])
        assert dashboard.requests[0].full_url == ACK_URL
        assert dashboard.body()["ids"] == ["n_mid", "n_new"]
        assert "all" not in dashboard.body()
        assert result["acked"] == 2
        assert result["unread_count"] == 1

    def test_all_is_sent_as_a_flag(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        dashboard = Dashboard(ok_response())
        ack(dashboard, monkeypatch, registry, all=True)
        assert dashboard.body() == {"all": True, "actor": "laptop-claude"}

    def test_the_count_reported_back_is_what_is_left_unhandled(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The dashboard answers with both; this surface's queue is the handled one.

        The two are deliberately different numbers here — five rows no human has seen,
        three no agent has answered — so a build that reported the bell's tally under the
        wire's ``unread_count`` key could not pass by coincidence.
        """
        dashboard = Dashboard(ok_response(acked=1, unread=5, unhandled=3))
        result = ack(dashboard, monkeypatch, registry, ids=["n_mid"])
        assert result["unread_count"] == 3

    def test_a_dashboard_from_before_the_split_still_reports_a_count(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An older dashboard sends only ``unread_count``, and there it meant both things."""
        legacy = FakeResponse(200, json.dumps({"ok": True, "acked": 1, "unread_count": 4}))
        result = ack(Dashboard(legacy), monkeypatch, registry, ids=["n_mid"])
        assert result["ok"] is True
        assert result["unread_count"] == 4

    def test_an_emptied_queue_is_reported_as_zero_rather_than_fallen_back_on(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`unhandled_count: 0` is the answer an ack usually earns, and it is falsy.

        Reading the field with `or` would treat the most common success as "the dashboard
        did not send it" and report the bell's count instead.
        """
        dashboard = Dashboard(ok_response(acked=2, unread=7, unhandled=0))
        result = ack(dashboard, monkeypatch, registry, all=True)
        assert result["unread_count"] == 0

    def test_blank_ids_are_dropped_rather_than_relayed(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(ok_response())
        ack(dashboard, monkeypatch, registry, ids=["n_mid", "  ", ""], all=False)
        assert dashboard.body()["ids"] == ["n_mid"]

    def test_on_stdio_the_actor_travels_in_the_body(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        """There is no request to hang a bearer on, so the loopback fallback needs a name."""
        dashboard = Dashboard(ok_response())
        ack(dashboard, monkeypatch, registry, ids=["n_mid"])
        assert dashboard.body()["actor"] == "laptop-claude"
        assert dashboard.header("authorization") == ""

    def test_over_http_the_callers_bearer_is_relayed_and_the_actor_is_not(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The header identifies *this* caller; the body could only ever name the host.

        The environment deliberately holds a token too, so the assertion that no
        ``actor`` was sent cannot pass merely because none could be resolved.
        """
        wire.set_http_transport(True)
        monkeypatch.setattr(notify, "bearer_token", lambda: OTHER_TOKEN)
        dashboard = Dashboard(ok_response())
        monkeypatch.setattr(notify, "urlopen", dashboard)
        result = notifications_ack_payload(["n_mid"], False, as_user(), registry)
        assert dashboard.header("authorization") == f"Bearer {OTHER_TOKEN}"
        assert "actor" not in dashboard.body()
        assert result["ok"] is True

    def test_over_http_without_a_bearer_the_hosts_actor_is_never_offered(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The security case this asymmetry exists for.

        The MCP server may hold a token in its own environment — over HTTP that
        describes the host that launched it, not whoever is calling. Sending it as the
        body `actor` would let anyone who can reach the MCP port clear the host agent's
        inbox through the dashboard's loopback fallback.
        """
        wire.set_http_transport(True)
        dashboard = Dashboard(ok_response())
        monkeypatch.setattr(notify, "urlopen", dashboard)
        result = notifications_ack_payload(["n_mid"], False, as_user(), registry)
        assert not dashboard.called
        assert result["code"] == "not_identified"


class TestAckRefusals:
    def test_an_unidentified_caller_is_refused_before_the_socket(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(ok_response())
        result = ack(dashboard, monkeypatch, registry, ids=["n_mid"], env={})
        assert not dashboard.called
        assert result["code"] == "not_identified"
        assert result == {**result, "acked": 0, "unread_count": 0, "ok": False}
        assert "agent_signup" in result["hint"]

    def test_asking_for_nothing_is_refused_before_the_socket(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(ok_response())
        result = ack(dashboard, monkeypatch, registry)
        assert not dashboard.called
        assert result["code"] == "nothing_to_ack"
        assert "all=True" in result["hint"]

    def test_an_unreachable_dashboard_gets_its_own_code_and_names_the_url(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A dead dashboard and a refusal need different words in front of an agent."""
        dashboard = Dashboard(URLError("Connection refused"))
        result = ack(dashboard, monkeypatch, registry, all=True)
        assert result["code"] == "dashboard_unreachable"
        assert result["acked"] == 0
        assert ACK_URL in result["reason"]
        assert DASHBOARD in result["hint"]

    def test_the_endpoints_plain_string_error_becomes_the_code(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """This route answers `{ok: false, error: 'not_identified'}` — a string, not an envelope."""
        dashboard = Dashboard(http_error(401, json.dumps({"ok": False, "error": "not_identified"})))
        result = ack(dashboard, monkeypatch, registry, all=True)
        assert result["code"] == "not_identified"
        assert result["status"] == 401

    def test_a_code_message_envelope_is_read_too(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        body = json.dumps({"ok": False, "error": {"code": "bad_request", "message": "no such id"}})
        result = ack(Dashboard(http_error(400, body)), monkeypatch, registry, ids=["n_nope"])
        assert result["code"] == "bad_request"
        assert result["reason"] == "no such id"

    def test_an_unrecognised_status_falls_back_to_an_unfamiliar_looking_code(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        result = ack(Dashboard(http_error(503, json.dumps({"ok": False}))), monkeypatch, registry, all=True)
        assert result["code"] == "http_503"

    def test_a_body_that_is_not_json_is_diagnosed_rather_than_crashed_on(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        dashboard = Dashboard(FakeResponse(200, "<html>vite dev server</html>"))
        result = ack(dashboard, monkeypatch, registry, all=True)
        assert result["code"] == "unexpected_response"
        assert "FEADS_DASHBOARD_URL" in result["hint"]

    def test_the_dashboard_url_is_reported_on_every_outcome(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Which dashboard this talked to is the first thing to check when the answer surprises."""
        success = ack(Dashboard(ok_response()), monkeypatch, registry, all=True)
        failure = ack(Dashboard(URLError("nope")), monkeypatch, registry, all=True)
        for result in (success, failure):
            assert result["dashboard_url"] == DASHBOARD
            assert result["ack_url"] == ACK_URL


# =============================================================================
# Comment enrichment
# =============================================================================


class TestCommentEnrichment:
    def test_the_original_confirmation_is_the_first_line_and_survives_intact(self, registry: str) -> None:
        result = enrich_comment_result("Added comment to lab-bbb", "@laptop-claude look", db_path=registry)
        assert result.splitlines()[0] == "Added comment to lab-bbb"

    def test_nothing_is_appended_when_the_text_has_no_conventions(self, registry: str) -> None:
        assert enrich_comment_result("Added comment to lab-bbb", "plain prose", db_path=registry) == (
            "Added comment to lab-bbb"
        )

    def test_live_actors_are_named_as_notified(self, registry: str) -> None:
        text = comment_enrichment("@laptop-claude and @Desk-Claude, please look", db_path=registry)
        human, machine = text.splitlines()
        assert human == "mentioned: @laptop-claude, @desk-claude"
        # The same answer, machine-readable, as the last line.
        assert machine.startswith("mentions: ")
        report = json.loads(machine.removeprefix("mentions: "))
        assert [(d["handle"], d["to"]) for d in report["delivered"]] == [
            ("laptop-claude", "laptop-claude"),
            ("Desk-Claude", "desk-claude"),
        ]
        assert report["not_delivered"] == []

    def test_a_name_matching_nobody_is_called_out_rather_than_dropped(self, registry: str) -> None:
        """The whole point: `bd` stores a typo'd @name happily and nobody is ever notified."""
        text = comment_enrichment("@laptop-claude @nobody", db_path=registry)
        assert "mentioned: @laptop-claude" in text
        assert "not delivered: @nobody" in text
        assert "users_list()" in text

    def test_a_revoked_agent_is_reported_as_undeliverable(self, registry: str) -> None:
        assert "not delivered: @old-agent" in comment_enrichment("@old-agent", db_path=registry)

    def test_refs_become_absolute_markdown_links(self, registry: str) -> None:
        text = comment_enrichment("done, see #lab-bbb and #ops-ccc", db_path=registry)
        assert text == (
            f"refs: [#lab-bbb]({DASHBOARD}/#/issues?issue=lab-bbb), [#ops-ccc]({DASHBOARD}/#/issues?issue=ops-ccc)"
        )

    def test_mentions_and_refs_appear_together(self, registry: str) -> None:
        lines = comment_enrichment("@laptop-claude see #lab-bbb", db_path=registry).splitlines()
        assert lines[0] == "mentioned: @laptop-claude"
        assert lines[1].startswith("refs: [#lab-bbb](")

    def test_an_unreadable_registry_says_the_names_are_unverified(self, tmp_path: Path) -> None:
        text = comment_enrichment("@somebody", db_path=str(tmp_path / "absent.db"))
        assert "mentioned (unverified): @somebody" in text
        assert "not delivered" not in text


# =============================================================================
# comments — the annotated Comment model
# =============================================================================


def comment_of(text: str, comment_id: str = "c1") -> Comment:
    return Comment(
        id=comment_id,
        issue_id="lab-bbb",
        author="desk-claude",
        text=text,
        created_at=datetime(2026, 7, 29, 12, 0, 0),
    )


class TestAnnotateComments:
    def test_mentions_and_refs_are_attached(self, registry: str) -> None:
        [annotated] = annotate_comments([comment_of("@laptop-claude see #lab-bbb")], db_path=registry)
        assert annotated.mentions == ["laptop-claude"]
        assert annotated.refs is not None
        assert annotated.refs[0].issue_id == "lab-bbb"
        assert annotated.refs[0].url == f"{DASHBOARD}/#/issues?issue=lab-bbb"

    def test_a_plain_comment_keeps_both_fields_null(self, registry: str) -> None:
        """Additive: a consumer written before these existed reads the same five fields."""
        [annotated] = annotate_comments([comment_of("just prose")], db_path=registry)
        assert annotated.mentions is None
        assert annotated.refs is None

    def test_only_live_actors_are_listed(self, registry: str) -> None:
        [annotated] = annotate_comments([comment_of("@old-agent @nobody @desk-claude")], db_path=registry)
        assert annotated.mentions == ["desk-claude"]

    def test_an_unreadable_registry_leaves_the_raw_names(self, tmp_path: Path) -> None:
        [annotated] = annotate_comments([comment_of("@somebody")], db_path=str(tmp_path / "absent.db"))
        assert annotated.mentions == ["somebody"]

    def test_a_batch_is_annotated_from_one_registry_read(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An issue's history runs to dozens of comments; the answer cannot change mid-call."""
        from beads_mcp import mentions as mention_mod

        mention_mod.reset_directory_cache()
        opens = 0
        original = mention_mod._read_directory

        def counted(conn: Any, accounts_on: bool) -> Any:
            nonlocal opens
            opens += 1
            return original(conn, accounts_on)

        monkeypatch.setattr(mention_mod, "_read_directory", counted)
        batch = [comment_of("@laptop-claude", "c1"), comment_of("@desk-claude", "c2")]
        annotated = annotate_comments(batch, db_path=registry)
        assert opens == 1
        assert [entry.mentions for entry in annotated] == [["laptop-claude"], ["desk-claude"]]

    def test_an_empty_batch_touches_nothing(self, tmp_path: Path) -> None:
        assert annotate_comments([], db_path=str(tmp_path / "absent.db")) == []

    def test_the_model_serialises_the_new_fields(self, registry: str) -> None:
        [annotated] = annotate_comments([comment_of("@laptop-claude #lab-bbb")], db_path=registry)
        dumped = annotated.model_dump()
        assert dumped["mentions"] == ["laptop-claude"]
        assert dumped["refs"] == [{"issue_id": "lab-bbb", "url": f"{DASHBOARD}/#/issues?issue=lab-bbb"}]


# =============================================================================
# Over a real MCP client
# =============================================================================


class TestThroughTheToolLayer:
    """The payload builders are asserted on directly above; this is the round trip.

    Worth its own section because the shapes here are ``TypedDict`` and pydantic
    models on their way through FastMCP's serializer, and that is precisely where a
    shape that reads correctly in Python arrives at an agent as something else.
    """

    async def test_users_list_returns_the_directory(self, registry: str, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        monkeypatch.setenv(AGENT_TOKEN_ENV, USER_TOKEN)
        async with Client(mcp) as client:
            result = await client.call_tool("users_list", {})
        assert [user["actor"] for user in result.data["users"]] == ["laptop-claude", "desk-claude"]
        assert result.data["count"] == 2

    async def test_notifications_returns_absolute_urls(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        monkeypatch.setenv(AGENT_TOKEN_ENV, USER_TOKEN)
        async with Client(mcp) as client:
            result = await client.call_tool("notifications", {})
        assert result.data["actor"] == "laptop-claude"
        assert result.data["unread_count"] == 2
        assert result.data["notifications"][0]["url"].startswith(f"{DASHBOARD}/#/issues?issue=")
        # Both timestamps survive the serializer: an agent deciding whether a row is still
        # its own to answer reads `handled_at`, and a key dropped in transit reads as zero.
        assert result.data["notifications"][0]["handled_at"] == 0
        assert result.data["notifications"][0]["read_at"] == 0

    async def test_notifications_ack_reaches_the_dashboard_with_the_actor(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        monkeypatch.setenv(AGENT_TOKEN_ENV, USER_TOKEN)
        dashboard = Dashboard(ok_response(acked=1, unread=1))
        monkeypatch.setattr(notify, "urlopen", dashboard)
        async with Client(mcp) as client:
            result = await client.call_tool("notifications_ack", {"ids": ["n_mid"]})
        assert dashboard.body() == {"ids": ["n_mid"], "actor": "laptop-claude"}
        assert result.data["acked"] == 1
        assert result.data["unread_count"] == 1

    async def test_notifications_ack_accepts_all_without_ids(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`all` is a Python builtin; the contract locks the name across all three surfaces."""
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        monkeypatch.setenv(AGENT_TOKEN_ENV, USER_TOKEN)
        dashboard = Dashboard(ok_response(acked=2, unread=0))
        monkeypatch.setattr(notify, "urlopen", dashboard)
        async with Client(mcp) as client:
            result = await client.call_tool("notifications_ack", {"all": True})
        assert dashboard.body()["all"] is True
        assert result.data["acked"] == 2

    async def test_an_anonymous_caller_is_answered_rather_than_erroring(
        self, registry: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Every one of these is an *answer*: an empty inbox and a hint, never a ToolError."""
        monkeypatch.setenv(REGISTRY_DB_ENV, registry)
        wire.set_http_transport(True)
        async with Client(mcp) as client:
            inbox = await client.call_tool("notifications", {})
            directory = await client.call_tool("users_list", {})
        assert inbox.data["actor"] is None
        assert inbox.data["notifications"] == []
        assert directory.data["reason"] == "anonymous"


class TestTheAgentInbox:
    """The human/agent split from the agents' side (feads perf/notify pass).

    Humans' bells show only mentions; this surface lists every type, says what to do
    about each row (``guidance``), collapses bursts (``count``) and summarizes the inbox
    by type — for ``notifications`` and for ``agent_whoami``.
    """

    def coordination_registry(self, tmp_path: Path, collapse_columns: bool = True) -> str:
        return build_registry(
            tmp_path / "coord.db",
            agent_rows(),
            boards=("lab", "ops"),
            collapse_columns=collapse_columns,
            notifications=[
                {
                    "id": "n_overlap",
                    "recipient_actor": "laptop-claude",
                    "type": "work_overlap",
                    "issue_id": "lab-new",
                    "issue_title": "Rewrite the parser",
                    "actor": "desk-claude",
                    "related_issue": "lab-mine",
                    "created_at": 5000,
                    "count": 3,
                    # Minted under older wording: the current policy is derived over it.
                    "guidance": "Leave one comment on #lab-new; @mention someone only if you need their decision.",
                },
                {
                    "id": "n_moved",
                    "recipient_actor": "laptop-claude",
                    "type": "status_on_owned",
                    "issue_id": "lab-mine",
                    "actor": "desk-claude",
                    "created_at": 4000,
                },
                {
                    "id": "n_named",
                    "recipient_actor": "laptop-claude",
                    "type": "mention",
                    "issue_id": "lab-q",
                    "actor": "desk-claude",
                    "created_at": 3000,
                },
                {
                    "id": "n_done",
                    "recipient_actor": "laptop-claude",
                    "type": "work_overlap",
                    "issue_id": "lab-old",
                    "created_at": 100,
                    "read_at": 200,
                    "handled_at": 200,
                },
            ],
        )

    def test_every_type_is_listed_with_count_guidance_and_audience(self, tmp_path: Path) -> None:
        rows, unread = read_notifications("laptop-claude", db_path=self.coordination_registry(tmp_path))
        assert [row["type"] for row in rows] == ["work_overlap", "status_on_owned", "mention"]
        assert unread == 3
        overlap, moved, named = rows
        assert overlap["count"] == 3
        # Guidance is the current policy, derived from the row's own fields — a row minted
        # under older wording ("@mention only if…") never tells an agent the old rule.
        assert overlap["guidance"].startswith(
            "Coordinate, don't block: @desk-claude is on #lab-new, which overlaps your #lab-mine"
        )
        assert "only if you need their decision" not in overlap["guidance"]
        assert overlap["audience"] == "agent"
        # No stored guidance: derived exactly as the engine words it.
        assert moved["guidance"] == (
            "#lab-mine was moved by @desk-claude — check it matches your plan; "
            "if it does not, comment on #lab-mine with @desk-claude rather than moving it back."
        )
        assert moved["count"] == 1
        assert named["audience"] == "all"

    def test_a_type_this_build_does_not_know_keeps_its_stored_guidance(self, tmp_path: Path) -> None:
        db = build_registry(
            tmp_path / "future.db",
            agent_rows(),
            boards=("lab",),
            collapse_columns=True,
            notifications=[
                {
                    "id": "n_future",
                    "recipient_actor": "laptop-claude",
                    "type": "some_future_type",
                    "issue_id": "lab-f",
                    "actor": "desk-claude",
                    "created_at": 50,
                    "guidance": "stored guidance for a type this build does not know",
                },
            ],
        )
        rows, _ = read_notifications("laptop-claude", db_path=db)
        assert rows[0]["guidance"] == "stored guidance for a type this build does not know"

    def test_a_registry_without_the_collapse_columns_still_answers_the_full_shape(self, tmp_path: Path) -> None:
        rows, _ = read_notifications(
            "laptop-claude", db_path=self.coordination_registry(tmp_path, collapse_columns=False)
        )
        overlap = rows[0]
        assert overlap["count"] == 1
        assert overlap["guidance"].startswith(
            "Coordinate, don't block: @desk-claude is on #lab-new, which overlaps your #lab-mine — "
            "comment on #lab-new with @desk-claude"
        )

    def test_types_narrow_the_listing_but_never_the_counts(self, tmp_path: Path) -> None:
        db = self.coordination_registry(tmp_path)
        rows, unread = read_notifications("laptop-claude", db_path=db, types=["mention"])
        assert [row["id"] for row in rows] == ["n_named"]
        assert unread == 3
        nothing, _ = read_notifications("laptop-claude", db_path=db, types=[])
        assert nothing == []

    def test_unhandled_by_type_reads_most_specific_first(self, tmp_path: Path) -> None:
        by_type = notify.unhandled_by_type("laptop-claude", self.coordination_registry(tmp_path))
        assert list(by_type.items()) == [("mention", 1), ("work_overlap", 1), ("status_on_owned", 1)]

    def test_the_payload_carries_the_digest_and_honours_types(self, tmp_path: Path) -> None:
        db = self.coordination_registry(tmp_path)
        payload = notifications_payload(env=as_user(), db_path=db, types=["work_overlap"])
        assert [row["id"] for row in payload["notifications"]] == ["n_overlap"]
        assert payload["unread_count"] == 3
        assert payload["unhandled_by_type"] == {"mention": 1, "work_overlap": 1, "status_on_owned": 1}

    def test_a_filter_that_matches_nothing_points_at_the_rest(self, tmp_path: Path) -> None:
        db = self.coordination_registry(tmp_path)
        payload = notifications_payload(env=as_user(), db_path=db, types=["assigned"])
        assert payload["notifications"] == []
        assert "3 other notification(s)" in payload["hint"]

    def test_whoami_gains_an_inbox_digest_only_when_something_waits(self, tmp_path: Path) -> None:
        db = self.coordination_registry(tmp_path)
        whoami = {"identity": {"actor": "laptop-claude"}, "credential_rejected": False}
        digest = notify.with_inbox_digest(dict(whoami), db)["inbox"]
        assert digest["unhandled_count"] == 3
        assert "1 mention, 1 work_overlap, 1 status_on_owned" in digest["hint"]
        assert "notifications()" in digest["hint"]
        # Someone with nothing waiting, an anonymous caller and a rejected credential
        # get whoami's own answer, untouched.
        assert "inbox" not in notify.with_inbox_digest({"identity": {"actor": "desk-claude"}}, db)
        assert "inbox" not in notify.with_inbox_digest({"identity": None}, db)
        rejected = {"identity": {"actor": "laptop-claude"}, "credential_rejected": True}
        assert "inbox" not in notify.with_inbox_digest(rejected, db)

    def test_an_unreadable_registry_never_breaks_whoami(self, tmp_path: Path) -> None:
        whoami = {"identity": {"actor": "laptop-claude"}}
        assert notify.with_inbox_digest(whoami, str(tmp_path / "missing.db")) == whoami

    def test_guidance_tells_the_agent_to_at_mention_the_other_person(self) -> None:
        """Feads is agents coordinating: when a row knows who acted, its guidance has the
        agent @mention them back (one handle reaches all of that person's agents)."""
        for name in notify.NOTIFICATION_TYPES:
            text = notify.guidance_for(name, "ex-1", "bob", "ex-2")
            assert text
            assert "only if you need their decision" not in text
            if name not in ("assigned", "dependency_completed"):
                assert "@bob" in text, name
        for name in ("mention", "work_overlap"):
            assert "never wait for a reply" in notify.guidance_for(name, "ex-1", "bob")

    def test_the_guidance_wording_matches_the_engine(self) -> None:
        """Word for word: a row minted by the engine and one derived here must read the same.

        boards/guidance-cases.json is generated from the Node engine's ``guidanceFor`` and
        checked by boards/notifications.test.mjs too."""
        fixture = json.loads((Path(__file__).resolve().parents[3] / "boards" / "guidance-cases.json").read_text())
        assert len(fixture["cases"]) >= 2 * len(notify.NOTIFICATION_TYPES)
        for case in fixture["cases"]:
            got = notify.guidance_for(case["type"], case["issue_id"], case["actor"], case["related_issue"])
            assert got == case["guidance"], (case["type"], case["actor"])

    def test_the_vocabulary_matches_the_engine(self) -> None:
        """Both runtimes enumerate the same types and the same human audience."""
        engine = (Path(__file__).resolve().parents[3] / "boards" / "notifications.mjs").read_text()
        for name in notify.NOTIFICATION_TYPES:
            assert f'"{name}"' in engine
        assert 'HUMAN_NOTIFICATION_TYPES = Object.freeze(["mention"])' in engine
        assert notify.HUMAN_NOTIFICATION_TYPES == ("mention",)

    async def test_types_and_the_digest_survive_the_tool_layer(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(REGISTRY_DB_ENV, self.coordination_registry(tmp_path))
        monkeypatch.setenv(AGENT_TOKEN_ENV, USER_TOKEN)
        async with Client(mcp) as client:
            inbox = await client.call_tool("notifications", {"types": ["work_overlap"]})
            whoami = await client.call_tool("agent_whoami", {})
        row = inbox.data["notifications"][0]
        assert row["id"] == "n_overlap"
        assert row["count"] == 3
        assert row["audience"] == "agent"
        assert inbox.data["unhandled_by_type"]["mention"] == 1
        assert whoami.data["inbox"]["unhandled_count"] == 3


# =============================================================================
# Discovery
# =============================================================================


class TestToolDiscovery:
    async def test_the_new_tools_are_registered(self) -> None:
        async with Client(mcp) as client:
            names = {tool.name for tool in await client.list_tools()}
        assert {"users_list", "notifications", "notifications_ack"} <= names

    async def test_the_catalog_lists_them(self) -> None:
        async with Client(mcp) as client:
            catalog = await client.call_tool("discover_tools", {})
        listed = catalog.data["tools"]
        for name in ("users_list", "notifications", "notifications_ack"):
            assert name in listed

    async def test_get_tool_info_documents_each_one(self) -> None:
        async with Client(mcp) as client:
            for name in ("users_list", "notifications", "notifications_ack"):
                info = await client.call_tool("get_tool_info", {"tool_name": name})
                assert info.data["name"] == name
                assert info.data["example"].startswith(name)

    async def test_the_notification_tools_document_the_seen_handled_split(self) -> None:
        """An agent has to learn from the schema that a human's bell click is not its ack."""
        async with Client(mcp) as client:
            inbox = await client.call_tool("get_tool_info", {"tool_name": "notifications"})
            acking = await client.call_tool("get_tool_info", {"tool_name": "notifications_ack"})
        assert "handled_at" in inbox.data["returns"]
        assert "handled" in acking.data["description"]
        assert "bell" in acking.data["description"]

    async def test_the_comment_tools_document_the_conventions(self) -> None:
        """An agent reading the schema has to learn @ and # from somewhere."""
        async with Client(mcp) as client:
            comment = await client.call_tool("get_tool_info", {"tool_name": "comment"})
            comments = await client.call_tool("get_tool_info", {"tool_name": "comments"})
        assert "@actor" in comment.data["description"]
        assert "#issue-id" in comment.data["description"]
        assert "mentions" in comments.data["returns"]

    async def test_the_instructions_send_agents_to_notifications_at_session_start(self) -> None:
        assert "notifications()" in (mcp.instructions or "")
        assert "agents_list()" in (mcp.instructions or "")
