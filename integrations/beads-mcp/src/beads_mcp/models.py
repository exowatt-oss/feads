"""Pydantic models for beads issue tracker types."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_serializer, model_validator

from .workspace_state import lift_binding

# Type aliases for issue statuses, types, and dependencies
#
# IssueStatus, IssueType, and DependencyType are strings (not Literals) so the
# MCP layer doesn't have to be kept in lockstep with every dep type / status /
# issue type the bd CLI emits. The CLI is the source of truth and validates
# these values against the configured (or built-in) options.
#
# Custom statuses and types are configured via:
#   bd config set status.custom "in_review:active,qa_testing:wip,on_hold:frozen"
#   bd config set types.custom "agent,molecule,event"
#
# Custom statuses support optional category annotations (active, wip, done, frozen)
# that control behavior in bd ready and bd list. See docs/CLI_REFERENCE.md.
#
# Built-in statuses: open, in_progress, blocked, deferred, closed
# Built-in types: bug, feature, task, epic, chore, decision
# Built-in dependency types (see internal/types/types.go):
#   blocks, parent-child, conditional-blocks, waits-for, related,
#   discovered-from, replies-to, relates-to, duplicates, supersedes,
#   authored-by, assigned-to, approved-by, attests, tracks, until,
#   caused-by, validates, delegated-from
IssueStatus = str
IssueType = str
DependencyType = str
OperationAction = Literal["created", "updated", "claimed", "closed", "reopened"]


# =============================================================================
# CONTEXT ENGINEERING: Minimal Models for List Views
# =============================================================================
# These lightweight models reduce context window usage by ~80% for list operations.
# Use full Issue model only when detailed information is needed (show command).


class IssueMinimal(BaseModel):
    """Minimal issue model for list views (~80% smaller than full Issue).

    Use this for ready_work, list_issues, and other bulk operations.
    For full details including dependencies, use Issue model via show().
    """

    id: str
    title: str
    status: IssueStatus
    priority: int = Field(ge=0, le=4)
    issue_type: IssueType
    assignee: str | None = None
    labels: list[str] = Field(default_factory=list)
    dependency_count: int = 0
    dependent_count: int = 0

    # The workspace binding, when the issue carries one. Present here and not only on
    # the full Issue because `list` answers in this shape: a caller that filtered by
    # workspace_dir_prefix would otherwise get back rows it cannot tell apart by
    # worktree, and would have to call show() once per row to learn what it filtered on.
    workspace_dir: str | None = None
    session_id: str | None = None
    host: str | None = None

    @model_serializer(mode="wrap")
    def _drop_unbound(self, handler: Any) -> dict[str, Any]:
        """Omit the binding keys entirely when the issue has no binding.

        This model exists to be ~80% smaller than :class:`Issue`; three ``null`` keys on
        every row of every list on every board is exactly the kind of quiet growth it was
        introduced to prevent. Most issues are not session epics, so for most rows these
        keys are pure padding — and an absent key already means "unbound" here.
        """
        data: dict[str, Any] = handler(self)
        for key in ("workspace_dir", "session_id", "host"):
            if data.get(key) is None:
                data.pop(key, None)
        return data

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, v: int) -> int:
        if not 0 <= v <= 4:
            raise ValueError("Priority must be between 0 and 4")
        return v


class CompactedResult(BaseModel):
    """Result container for compacted list responses.

    When results exceed threshold, returns preview + metadata instead of full data.
    This prevents context window overflow for large issue lists.
    """

    compacted: bool = True
    total_count: int
    preview: list[IssueMinimal]
    preview_count: int
    hint: str = "Use show(issue_id) for full issue details"


class BriefIssue(BaseModel):
    """Ultra-minimal issue for scanning (4 fields).

    Use for quick scans where only identification + priority needed.
    ~95% smaller than full Issue.
    """

    id: str
    title: str
    status: IssueStatus
    priority: int = Field(ge=0, le=4)


class BriefDep(BaseModel):
    """Brief dependency for overview (5 fields).

    Use with brief_deps=True to get full issue but compact dependencies.
    ~90% smaller than full LinkedIssue.
    """

    id: str
    title: str
    status: IssueStatus
    priority: int = Field(ge=0, le=4)
    dependency_type: DependencyType | None = None


class OperationResult(BaseModel):
    """Minimal confirmation for write operations.

    Default response for create/update/close/reopen when verbose=False.
    ~97% smaller than returning full Issue object.
    """

    id: str
    action: OperationAction
    message: str | None = None
    # Who the @mentions in this write reached — `{"delivered": [...], "not_delivered":
    # [...]}` (see beads_mcp.mentions). Present only when the written text had any.
    mentions: dict[str, Any] | None = None

    @model_serializer(mode="wrap")
    def _omit_absent_mentions(self, handler: Any) -> Any:
        data = handler(self)
        if isinstance(data, dict) and data.get("mentions") is None:
            data.pop("mentions", None)
        return data


# =============================================================================
# ORIGINAL MODELS (unchanged for backward compatibility)
# =============================================================================


class IssueBase(BaseModel):
    """Base issue model with shared fields."""

    id: str
    title: str
    description: str = ""
    design: str | None = None
    acceptance_criteria: str | None = None
    notes: str | None = None
    external_ref: str | None = None
    status: IssueStatus
    priority: int = Field(ge=0, le=4)
    issue_type: IssueType
    created_at: datetime
    updated_at: datetime
    closed_at: datetime | None = None
    assignee: str | None = None
    labels: list[str] = Field(default_factory=list)
    dependency_count: int = 0
    dependent_count: int = 0

    # The durable workspace binding (:mod:`beads_mcp.workspace_state`). Stored in the
    # issue's `metadata` object by both stores and lifted to named fields by the
    # validator below, so every read path — show, list, ready, blocked, nested
    # dependencies, either store — surfaces them without knowing they exist. None means
    # "this issue carries no binding", which is the normal case for anything but a
    # session epic.
    workspace_dir: str | None = None
    session_id: str | None = None
    host: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _lift_workspace_binding(cls, data: Any) -> Any:
        """Promote `metadata.workspace_dir` & co. to named fields on the way in."""
        if isinstance(data, dict):
            return lift_binding(data)
        return data

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, v: int) -> int:
        """Validate priority is 0-4."""
        if not 0 <= v <= 4:
            raise ValueError("Priority must be between 0 and 4")
        return v


class LinkedIssue(IssueBase):
    """Issue reference in dependencies/dependents (avoids recursion)."""

    dependency_type: DependencyType | None = None


class Issue(IssueBase):
    """Issue model matching bd JSON output."""

    dependencies: list[LinkedIssue] = Field(default_factory=list)
    dependents: list[LinkedIssue] = Field(default_factory=list)


class Dependency(BaseModel):
    """Dependency relationship model."""

    from_id: str
    to_id: str
    dep_type: DependencyType


class CreateIssueParams(BaseModel):
    """Parameters for creating an issue."""

    title: str
    description: str = ""
    design: str | None = None
    acceptance: str | None = None
    external_ref: str | None = None
    priority: int = Field(default=2, ge=0, le=4)
    issue_type: IssueType = "task"
    assignee: str | None = None
    labels: list[str] = Field(default_factory=list)
    id: str | None = None
    deps: list[str] = Field(default_factory=list)
    # The workspace binding to stamp. On an epic these default to the workspace this
    # call resolved and the acting agent's registry row; see
    # :func:`beads_mcp.workspace_state.create_binding`.
    workspace_dir: str | None = None
    session_id: str | None = None
    host: str | None = None


class UpdateIssueParams(BaseModel):
    """Parameters for updating an issue.

    Every field is "leave it alone" when ``None``. ``labels`` is the one where that
    distinction does work: a list — including the empty list — **replaces** the whole
    label set, so ``[]`` clears the labels while ``None`` does not touch them. There is
    deliberately no add/remove pair here; a caller that already knows the set it wants
    cannot express it with deltas without first reading, and a read-modify-write across
    two tool calls is how two agents relabelling one bead lose each other's work.
    """

    issue_id: str
    status: IssueStatus | None = None
    priority: int | None = Field(default=None, ge=0, le=4)
    assignee: str | None = None
    title: str | None = None
    description: str | None = None
    design: str | None = None
    acceptance_criteria: str | None = None
    notes: str | None = None
    external_ref: str | None = None
    labels: list[str] | None = None
    metadata: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Top-level metadata merge; existing keys are preserved, non-null values "
            "overwrite, and null values delete keys. metadata.effort may contain "
            "pre_ai_hours, effective_hours, ai_accel, and source."
        ),
    )
    # Workspace binding. Merged into the issue's existing metadata rather than replacing
    # it — a re-bind after a worktree move must not drop the artifact claims sitting in
    # the same object.
    workspace_dir: str | None = None
    session_id: str | None = None
    host: str | None = None


class ClaimIssueParams(BaseModel):
    """Parameters for atomically claiming an issue."""

    issue_id: str
    # Accounts mode: take over *your own* claim held by another of your sessions.
    # Never overrides another user's claim.
    force: bool = False


class CloseIssueParams(BaseModel):
    """Parameters for closing an issue."""

    issue_id: str
    reason: str = "Completed"
    force: bool = False
    metadata: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Top-level metadata merge; existing keys are preserved, non-null values "
            "overwrite, and null values delete keys. metadata.effort may contain "
            "pre_ai_hours, effective_hours, ai_accel, and source."
        ),
    )


class ReopenIssueParams(BaseModel):
    """Parameters for reopening issues."""

    issue_ids: list[str]
    reason: str | None = None


class AddDependencyParams(BaseModel):
    """Parameters for adding a dependency."""

    issue_id: str
    depends_on_id: str
    dep_type: DependencyType = "blocks"


class RemoveDependencyParams(BaseModel):
    """Parameters for removing a dependency.

    No ``dep_type``: ``bd dep remove`` takes the pair and drops the edge whatever its
    type, and the MCP matches it rather than inventing a narrower contract. That is
    also the shape the caller needs — the reason to remove an edge is almost always
    that its *type* is wrong, and having to name the wrong type to delete it is the
    ergonomic trap this tool exists to escape (#feads-qyo).
    """

    issue_id: str
    depends_on_id: str


class ReadyWorkParams(BaseModel):
    """Parameters for querying ready work."""

    limit: int = Field(default=10, ge=1, le=100)
    priority: int | None = Field(default=None, ge=0, le=4)
    issue_type: str | None = None
    assignee: str | None = None
    labels: list[str] | None = None  # AND: must have ALL labels
    labels_any: list[str] | None = None  # OR: must have at least one
    unassigned: bool = False  # Filter to only unassigned issues
    sort_policy: str | None = None  # hybrid, priority, oldest
    parent_id: str | None = None  # Filter to descendants of this bead/epic


class BlockedParams(BaseModel):
    """Parameters for querying blocked issues."""

    parent_id: str | None = None  # Filter to descendants of this bead/epic


class ListIssuesParams(BaseModel):
    """Parameters for listing issues."""

    status: IssueStatus | None = None
    priority: int | None = Field(default=None, ge=0, le=4)
    issue_type: IssueType | None = None
    assignee: str | None = None
    labels: list[str] | None = None  # AND: must have ALL labels
    labels_any: list[str] | None = None  # OR: must have at least one
    query: str | None = None  # Search in title (case-insensitive)
    unassigned: bool = False  # Filter to only unassigned issues
    limit: int = Field(default=20, ge=1, le=100)  # Reduced to avoid MCP buffer overflow
    # Prefix match on the workspace binding: "every epic whose workspace_dir is under
    # ~/orca/workspaces/dev-tools" in one call. A prefix rather than equality because
    # the useful question is about a tree of worktrees, not one directory.
    workspace_dir_prefix: str | None = None
    # Only these issue ids (list(mentioned=True) passes the ids you were @mentioned on,
    # most recent mention first). With no `status`, closed ones are included but sorted
    # after open ones.
    ids: list[str] | None = None


class ShowIssueParams(BaseModel):
    """Parameters for showing issue details."""

    issue_id: str


class StatsSummary(BaseModel):
    """Summary statistics from bd stats."""

    total_issues: int
    open_issues: int
    in_progress_issues: int
    closed_issues: int
    blocked_issues: int
    deferred_issues: int = 0
    ready_issues: int
    tombstone_issues: int = 0
    pinned_issues: int = 0
    epics_eligible_for_closure: int = 0
    average_lead_time_hours: float


class RecentActivity(BaseModel):
    """Recent activity from bd stats."""

    hours_tracked: int = 24
    commit_count: int = 0
    issues_created: int = 0
    issues_closed: int = 0
    issues_updated: int = 0
    issues_reopened: int = 0
    total_changes: int = 0


class Stats(BaseModel):
    """Beads task statistics matching bd stats --json output."""

    summary: StatsSummary
    recent_activity: RecentActivity | None = None


class BlockedIssue(Issue):
    """Blocked issue with blocking information."""

    blocked_by_count: int
    blocked_by: list[str]


class InitParams(BaseModel):
    """Parameters for initializing bd."""

    prefix: str | None = None


class InitResult(BaseModel):
    """Result from bd init command."""

    database: str
    prefix: str
    message: str


# =============================================================================
# COMMENTS & NOTES
# =============================================================================


class IssueRef(BaseModel):
    """A `#issue-id` written in a comment, paired with a link that opens it.

    The URL is absolute (the dashboard origin plus its hash route), because the place
    these are read is a tool result an agent may paste into a message to a human, where
    a relative link has no origin to resolve against.
    """

    issue_id: str
    url: str


class Comment(BaseModel):
    """A comment on an issue (matches `bd comments <id> --json`).

    The last two fields are *computed*, not stored: `bd` knows nothing about mentions
    or issue refs, and both are parsed out of `text` by
    :mod:`beads_mcp.notifications` on the way out. They are optional and default to
    None so this stays additive — a consumer written before they existed sees the same
    five fields it always did, and one written after can tell "no mentions in this
    comment" (an empty parse, left as None) from "nobody annotated this comment".
    """

    id: str
    issue_id: str
    author: str | None = None
    text: str
    created_at: datetime
    # Live actors named with `@actor`, in the registry's own spelling. Falls back to
    # the raw parsed names when the registry cannot be read — see
    # :class:`beads_mcp.notifications.MentionMatch`.
    mentions: list[str] | None = None
    refs: list[IssueRef] | None = None


class AddCommentParams(BaseModel):
    """Parameters for adding a comment to an issue."""

    issue_id: str
    text: str


class ListCommentsParams(BaseModel):
    """Parameters for listing comments on an issue."""

    issue_id: str


class AddNoteParams(BaseModel):
    """Parameters for appending a note to an issue's notes field."""

    issue_id: str
    text: str
