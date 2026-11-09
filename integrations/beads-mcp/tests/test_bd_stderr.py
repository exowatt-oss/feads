"""bd's stderr, read honestly, and its command line quoted safely (#feads-r8d).

The incident these are written against: ``artifact_add`` on the feads board answered

    bd update ex-vof --metadata {"has_artifacts": true, ...} failed:
    warning: beads.role not configured (GH#2950).

Two defects in one line — the diagnosis was an advisory bd prints on *every* run in a
role-less clone, and the message quoted the whole serialized metadata payload back at
the caller. Both are properties of the error surface, not of the failure, so both are
testable here without a bd binary.
"""

from __future__ import annotations

import pytest

from beads_mcp import artifacts
from beads_mcp.bd_client import BdCommandError
from beads_mcp.bd_stderr import (
    ELISION,
    advisories,
    failure_detail,
    redact_bd_args,
    scrub_advisory_stderr,
    split_advisory,
)

# Verbatim, including the indented remediation lines, because the continuation lines
# are the part a naive line-splitter gets wrong.
ROLE_ADVISORY = (
    "warning: beads.role not configured (GH#2950).\n"
    "  Fix: git config beads.role maintainer\n"
    "  Or:  git config beads.role contributor\n"
)


class TestSplitAdvisory:
    def test_the_role_nudge_is_advisory_all_three_lines_of_it(self) -> None:
        advisory, substantive = split_advisory(ROLE_ADVISORY)

        assert len(advisory) == 3
        assert substantive == []

    def test_a_real_error_under_the_nudge_is_substantive(self) -> None:
        advisory, substantive = split_advisory(ROLE_ADVISORY + "error: issue ex-vof not found\n")

        assert substantive == ["error: issue ex-vof not found"]
        assert advisory[0].startswith("warning: beads.role")

    def test_an_indented_line_under_a_real_error_survives(self) -> None:
        """The continuation rule only applies inside an advisory block. A diagnosis
        that hangs its own detail off an indented line must not lose it."""
        _, substantive = split_advisory("error: cannot open database\n  Fix: check permissions\n")

        assert substantive == ["error: cannot open database", "  Fix: check permissions"]

    def test_scrub_matches_the_dashboards_scrubAdvisoryStderr(self) -> None:
        """The Python and JS scrubbers read one program's output and must agree; this
        is the exact case ui/server/list-adapters.test.js pins on the other side."""
        assert scrub_advisory_stderr(ROLE_ADVISORY + "bd: no such issue\n") == "bd: no such issue"

    def test_advisories_are_kept_not_discarded(self) -> None:
        assert advisories(ROLE_ADVISORY)[0] == "warning: beads.role not configured (GH#2950)."


class TestFailureDetail:
    def test_the_diagnosis_wins_over_the_warning_above_it(self) -> None:
        """The regression itself: line one was an advisory, and line one was reported."""
        assert failure_detail(ROLE_ADVISORY + "error: issue ex-vof not found", 1) == (
            "error: issue ex-vof not found"
        )

    def test_only_advisories_reports_the_exit_code_not_the_warning(self) -> None:
        """A warning is never promoted to a diagnosis. The caller still learns the
        write failed — silence would be the worse bug — but is not sent to fix the
        server's git config over it."""
        detail = failure_detail(ROLE_ADVISORY, 3)

        assert "beads.role" not in detail
        assert "exit 3" in detail
        assert "advisories" in detail

    def test_empty_stderr_still_says_something(self) -> None:
        assert failure_detail("", 2) == "exit 2"


class TestRedactBdArgs:
    def test_the_metadata_payload_never_reaches_the_message(self) -> None:
        args = ["update", "ex-vof", "--metadata", '{"has_artifacts": true, "artifact:o/r:docs/x.md": {}}']

        rendered = redact_bd_args(args)

        assert rendered == f"update ex-vof --metadata {ELISION}"
        assert "has_artifacts" not in rendered

    def test_comment_bodies_are_payload_too(self) -> None:
        rendered = redact_bd_args(["comment", "ex-vof", "some free text a human wrote"])

        assert rendered == f"comment ex-vof {ELISION}"

    def test_ids_and_subcommands_survive_because_a_reader_needs_them(self) -> None:
        assert redact_bd_args(["dep", "add", "feads-a", "feads-b", "--type", "parent-child"]) == (
            f"dep add feads-a feads-b --type {ELISION}"
        )

    def test_an_inline_flag_value_keeps_only_the_flag_name(self) -> None:
        assert redact_bd_args(["list", "--query=secret phrase"]) == "list --query"


class TestErrorsCarryIt:
    def test_BdFailedError_redacts_and_keeps_the_advisories_aside(self) -> None:
        exc = artifacts.BdFailedError(
            ["update", "ex-vof", "--metadata", '{"secret": 1}'],
            "error: issue ex-vof not found",
            advisories(ROLE_ADVISORY),
        )

        assert str(exc) == f"bd update ex-vof --metadata {ELISION} failed: error: issue ex-vof not found"
        assert "secret" not in str(exc)
        assert exc.warnings[0].startswith("warning: beads.role")

    def test_the_payload_reports_warnings_beside_the_error_never_as_it(self) -> None:
        payload = artifacts._error_payload(
            artifacts.BdFailedError(["update", "ex-vof"], "error: boom", advisories(ROLE_ADVISORY))
        )

        assert payload["error"].endswith("failed: error: boom")
        assert "beads.role" not in payload["error"]
        assert len(payload["warnings"]) == 3

    def test_a_failed_write_is_still_a_failure_and_says_so(self) -> None:
        """Hardening the message must not soften the verdict: the worst outcome of the
        original incident was a call that failed *and* silently no-opped."""
        payload = artifacts._error_payload(artifacts.BdFailedError(["update", "ex-vof"], "error: boom"))

        assert "error" in payload
        assert "warnings" not in payload

    def test_BdCommandError_message_leads_with_the_diagnosis(self) -> None:
        raw = ROLE_ADVISORY + "error: database is locked"

        exc = BdCommandError(f"bd command failed: {failure_detail(raw, 1)}", stderr=raw, returncode=1)

        assert str(exc) == "bd command failed: error: database is locked"
        # The raw output is still available for logs and for a human debugging bd.
        assert "beads.role" in exc.stderr


@pytest.mark.parametrize(
    "prefix",
    ["warning:", "WARNING:", "note:", "hint:", "info:", "deprecated:"],
)
def test_every_advisory_prefix_bd_uses_is_recognized(prefix: str) -> None:
    _, substantive = split_advisory(f"{prefix} something ambient\nerror: the real one")

    assert substantive == ["error: the real one"]
