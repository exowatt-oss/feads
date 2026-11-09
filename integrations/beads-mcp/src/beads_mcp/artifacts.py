"""Artifacts — the files, dirs, repos and PRs a bead is working on. The Python half.

This is the **second of two implementations**. The first is ``boards/artifacts.mjs``
(Node: the ``feads-artifact`` CLI); this one binds the MCP server. Read that module
first — it carries the ref grammar, the storage rationale and the overlap rules, and
it is the primary document.

Neither implementation owns the behaviour. **``boards/artifact-cases.json`` is the
contract**, and both suites are readers of it: ``boards/artifacts.test.mjs`` on the
Node side, ``tests/test_artifact_parity.py`` here. A ref is a join key — an agent
finds who else is touching a file by matching refs — so two canonicalizers that
disagree do not produce a wrong answer, they produce "nobody else is touching this",
silently. Keep this file a transliteration of the .mjs, not a reinterpretation of it:
if a rule seems worth improving, change the .mjs and the fixture, then follow here.

Why two at all: the MCP is Python and cannot call into Node per tool call, the same
reason routing and authz each pay a parity cost.

## What lives where

Pure ref logic is the top half and mirrors the .mjs function for function. The bottom
half reaches the store and shapes tool payloads, which the Node CLI does in
``scripts/feads-artifact.mjs`` — those halves are peers, not copies, and only the pure
half is fixture-bound.

## Which database an artifact lives in

An artifact is issue metadata and a response is an issue comment, so artifacts follow
the same store as every other issue tool: `bd` normally, Postgres when ``FEADS_PG_DSN``
is set. They **have** to, and the reason is the whole point of the feature — a ref is a
join key, and an agent that attaches a file in one database while another searches the
other is not told "conflict unknown", it is told *"free to work on"*. That is worse than
having no coordination surface at all.

The seam is five functions (``_show_issue``, ``_beads_with_artifacts``,
``_apply_metadata``, ``_post_comment``, ``_add_blocks_dep``) and nothing above them
branches. In bd mode each spawns the CLI directly rather than going through
``BdCliClient``: a cross-board search has to target an arbitrary board directory while a
pooled client is bound to one workspace, and that keeps an upstream file untouched. In
pg mode each goes through :class:`~beads_mcp.pgstore.PgStoreClient`, so an artifact
write carries the same events row and ``NOTIFY`` as any other write and the dashboard
sees it.
"""

import asyncio
import datetime
import json
import os
import re
from functools import lru_cache
from typing import Any, TypedDict, cast

from . import accounts as _accounts
from . import pgstore
from .agents import acting_actor, authorized_mutation_context, resolve_identity
from .bd_client import ActorResolutionError, silo_configured
from .bd_stderr import advisories, failure_detail, redact_bd_args
from .boards import Board, RegistryUnavailableError, get_board, list_boards
from .config import load_config
from .models import AddCommentParams, AddDependencyParams

# =============================================================================
# Vocabulary (mirrors boards/artifacts.mjs)
# =============================================================================

KIND_REPO = "repo"
KIND_FILE = "file"
KIND_DIR = "dir"
KIND_PR = "pr"

KINDS: tuple[str, ...] = (KIND_REPO, KIND_FILE, KIND_DIR, KIND_PR)

INTENT_EDITING = "editing"
INTENT_READING = "reading"
INTENT_PLANNED = "planned"
INTENT_DONE = "done"

INTENTS: tuple[str, ...] = (INTENT_EDITING, INTENT_READING, INTENT_PLANNED, INTENT_DONE)

# Conflict ordering for search results: an `editing` overlap is what an agent needs to
# see first, and a `done` one is history.
_INTENT_RANK: dict[str, int] = {
    INTENT_EDITING: 0,
    INTENT_PLANNED: 1,
    INTENT_READING: 2,
    INTENT_DONE: 3,
}

ACTION_TAKING = "taking"
ACTION_SKIPPING = "skipping"
ACTION_WAITING = "waiting"

ACTIONS: tuple[str, ...] = (ACTION_TAKING, ACTION_SKIPPING, ACTION_WAITING)

# The intent a responder records on its *own* bead per action. `skipping` records
# nothing: an agent that decided not to touch a file has no business claiming it.
ACTION_INTENT: dict[str, str | None] = {
    ACTION_TAKING: INTENT_EDITING,
    ACTION_SKIPPING: None,
    ACTION_WAITING: INTENT_PLANNED,
}

METADATA_PREFIX = "artifact:"

# Set on attach and never cleared — see MARKER_KEY in boards/artifacts.mjs. A stale
# marker costs one row that decodes to zero artifacts; a missing one costs a missed
# collision.
MARKER_KEY = "has_artifacts"

REL_EXACT = "exact"
REL_INSIDE = "inside"
REL_COVERS = "covers"

_REPO_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")
_PR_NUMBER = re.compile(r"^[1-9][0-9]*$")
_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
_CREDENTIALS = re.compile(r"^[^@/]*@")
_WINDOWS_DRIVE = re.compile(r"^[a-zA-Z]:[\\/]")


class ArtifactError(ValueError):
    """Base for artifact failures an agent can fix, carrying an actionable hint."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


class ArtifactRefError(ArtifactError):
    """A ref that cannot be parsed.

    Bad refs are the common failure here — an agent pastes a checkout path, or a repo
    nobody registered — so the message says what to type instead.
    """


class BoardNotFoundError(ArtifactError):
    """A board id or directory that is not in the registry."""


class ParsedRef(TypedDict, total=False):
    """A ref decomposed into its parts, plus its canonical spelling."""

    kind: str
    repo: str
    path: str
    pr: int
    ref: str


class Artifact(TypedDict, total=False):
    """One artifact as stored on a bead."""

    ref: str
    kind: str
    repo: str
    path: str
    pr: int
    intent: str
    note: str
    actor: str
    at: str


class Hit(TypedDict, total=False):
    """One bead whose artifacts overlap a queried ref."""

    board: str
    board_dir: str
    issue_id: str
    title: str
    status: str
    assignee: str
    relation: str
    artifact: Artifact


# =============================================================================
# Pure ref logic — fixture-bound, mirrors boards/artifacts.mjs
# =============================================================================


def normalize_artifact_path(value: str) -> tuple[str, bool]:
    """Normalize a repo-relative path. Returns ``(path, is_dir)``.

    A trailing slash is meaningful and preserved: it is what distinguishes a subtree
    from a file, and the subtree is what makes "somebody owns this whole directory"
    expressible.
    """
    raw = ("" if value is None else str(value)).replace("\\", "/")
    wants_dir = raw.rstrip().endswith("/")
    parts: list[str] = []
    for segment in raw.split("/"):
        s = segment.strip()
        if s in ("", "."):
            continue
        if s == "..":
            if not parts:
                raise ArtifactRefError(
                    f"path escapes the repository root: {value}",
                    "A ref is relative to the repo root, so it can never start above it.",
                )
            parts.pop()
            continue
        parts.append(s)
    if not parts:
        # `owner/repo:` and `owner/repo:/` both mean the repository itself, which has
        # its own kind. Refusing here keeps one surface from having two spellings.
        raise ArtifactRefError(
            f"empty path in ref: {value}",
            "Drop the colon to name the whole repo: owner/repo",
        )
    return "/".join(parts) + ("/" if wants_dir else ""), wants_dir


def normalize_repo(value: str) -> str:
    """Normalize the repo half of a ref: lowercased ``owner/name`` or a bare ``name``.

    A bare name is legal rather than an error — it is what agents and humans both say,
    it is still identical across checkouts, and :func:`expand_repo` upgrades it when
    the registry knows an owner.
    """
    raw = re.sub(r"\.git$", "", ("" if value is None else str(value)).strip(), flags=re.IGNORECASE)
    segments = [s for s in raw.split("/") if s]
    if not segments:
        raise ArtifactRefError("missing repo in ref", "Refs start with a repo: owner/name")
    if len(segments) > 2:
        raise ArtifactRefError(
            f"repo has too many segments: {raw}",
            "A repo is owner/name; separate a path with a colon — owner/name:path/to/file",
        )
    for s in segments:
        if not _REPO_SEGMENT.match(s):
            raise ArtifactRefError(
                f"invalid character in repo: {raw}",
                "Repo segments may hold letters, digits, dot, dash and underscore.",
            )
    return "/".join(segments).lower()


def parse_ref(value: str) -> ParsedRef:
    """Parse a repo-qualified ref into its canonical form.

    Pure: no filesystem, no registry, no git. :func:`resolve_ref` is the layer that
    adds those, so this function is the one the parity fixture pins exactly.
    """
    raw = ("" if value is None else str(value)).strip()
    if raw == "":
        raise ArtifactRefError("empty ref", "Pass owner/repo, owner/repo:path or owner/repo#123")

    hash_at = raw.find("#")
    if hash_at >= 0:
        repo = normalize_repo(raw[:hash_at])
        number = raw[hash_at + 1 :].strip()
        if not _PR_NUMBER.match(number):
            raise ArtifactRefError(
                f"invalid pull request number: {raw}",
                "A PR ref is owner/repo#N, where N is a positive integer.",
            )
        return {"kind": KIND_PR, "repo": repo, "pr": int(number), "ref": f"{repo}#{number}"}

    colon = raw.find(":")
    if colon >= 0:
        repo = normalize_repo(raw[:colon])
        path, is_dir = normalize_artifact_path(raw[colon + 1 :])
        return {
            "kind": KIND_DIR if is_dir else KIND_FILE,
            "repo": repo,
            "path": path,
            "ref": f"{repo}:{path}",
        }

    repo = normalize_repo(raw)
    return {"kind": KIND_REPO, "repo": repo, "ref": repo}


def format_ref(parts: dict[str, Any]) -> str:
    """Render parsed parts back to a canonical ref. Round-trips with :func:`parse_ref`."""
    repo = normalize_repo(str(parts.get("repo", "")))
    kind = parts.get("kind")
    if kind == KIND_REPO:
        return repo
    if kind == KIND_PR:
        if not _PR_NUMBER.match(str(parts.get("pr", ""))):
            raise ArtifactRefError(f"invalid pull request number: {parts.get('pr')}")
        return f"{repo}#{parts['pr']}"
    if kind in (KIND_FILE, KIND_DIR):
        path, is_dir = normalize_artifact_path(str(parts.get("path", "")))
        bare = path[:-1] if is_dir else path
        return f"{repo}:{bare}{'/' if kind == KIND_DIR else ''}"
    raise ArtifactRefError(f"unknown artifact kind: {kind}", f"Kinds: {', '.join(KINDS)}")


class ExpandedRepo(TypedDict):
    """Result of expanding a bare repo name against the registry."""

    repo: str
    matched: bool
    candidates: list[str]


def expand_repo(repo: str, known_repos: list[str] | None = None) -> ExpandedRepo:
    """Expand a bare repo name against the repos the registry knows about.

    An ambiguous bare name is an error rather than a guess: silently picking one of
    two owners would attach the artifact to a file in the wrong repository, and
    nothing downstream could notice.
    """
    want = normalize_repo(repo)
    known = sorted({str(r or "").strip().lower() for r in (known_repos or []) if str(r or "").strip()})
    if "/" in want:
        return {"repo": want, "matched": want in known, "candidates": []}
    candidates = [r for r in known if r == want or r.split("/")[-1] == want]
    if len(candidates) == 1:
        return {"repo": candidates[0], "matched": True, "candidates": []}
    if len(candidates) > 1:
        raise ArtifactRefError(
            f"ambiguous repo name: {want}",
            f"Registered as {' and '.join(candidates)} — name the owner.",
        )
    return {"repo": want, "matched": False, "candidates": []}


def parse_remote_url(url: str) -> str | None:
    """Parse ``owner/name`` out of a git remote URL (ssh, https, git or scp form)."""
    raw = ("" if url is None else str(url)).strip()
    if raw == "":
        return None
    # A path-shaped remote (a bare mirror on disk, or file://) has no owner to report,
    # and taking its last two directories would invent one.
    if raw.lower().startswith("file:") or raw.startswith("/") or raw.startswith(".") or _WINDOWS_DRIVE.match(raw):
        return None
    rest = _CREDENTIALS.sub("", _SCHEME.sub("", raw))
    scp = rest.find(":")
    slash = rest.find("/")
    if scp >= 0 and (slash < 0 or scp < slash):
        rest = rest[scp + 1 :]  # git@github.com:owner/name.git
    elif slash >= 0:
        rest = rest[slash + 1 :]  # https://github.com/owner/name.git
    else:
        return None
    segments = [s for s in re.sub(r"\.git$", "", rest, flags=re.IGNORECASE).split("/") if s]
    if len(segments) < 2:
        return None
    try:
        # Some hosts nest groups (gitlab.com/group/sub/name); the last two segments are
        # what GitHub-style refs mean by owner/name.
        return normalize_repo("/".join(segments[-2:]))
    except ArtifactRefError:
        return None


def looks_local(value: str) -> bool:
    """Whether a string looks like a path on this machine rather than a ref."""
    raw = ("" if value is None else str(value)).strip()
    if raw == "":
        return False
    if raw.startswith("/") or raw.startswith("~"):
        return True
    if raw.startswith("./") or raw.startswith("../"):
        return True
    return bool(_WINDOWS_DRIVE.match(raw))


def resolve_ref(
    value: str,
    known_repos: list[str] | None = None,
    preferred_repos: list[str] | None = None,
    current_repo: str = "",
) -> ParsedRef:
    """Resolve a ref an agent typed into a canonical one.

    The hard case is the slash-only form: ``feads/ui/server/bd.js`` reads either as
    repo ``feads/ui`` plus path ``server/bd.js`` or as bare repo ``feads`` plus path
    ``ui/server/bd.js``, and those are different keys for one file. The order below
    resolves it from evidence and refuses when there is none — see the .mjs for the
    numbered rules and why rule 3 outranks rule 5.
    """
    raw = ("" if value is None else str(value)).strip()
    known = known_repos or []
    preferred = preferred_repos or []
    current = normalize_repo(current_repo) if current_repo else ""

    if raw == "":
        raise ArtifactRefError("empty ref", "Pass owner/repo, owner/repo:path or owner/repo#123")
    if looks_local(raw):
        raise ArtifactRefError(
            f"{raw} is a path on this machine, not a ref",
            "Refs name the repo, not the checkout, so they match across machines. "
            "Run this from inside the repo and the path will be converted, or pass owner/repo:path.",
        )

    def expand(candidate: str) -> ExpandedRepo:
        scoped = expand_repo(candidate, preferred)
        return scoped if scoped["matched"] else expand_repo(candidate, known)

    if ":" in raw or "#" in raw:
        parsed = parse_ref(raw)
        parts: dict[str, Any] = {**parsed, "repo": expand(str(parsed["repo"]))["repo"]}
        parts["ref"] = format_ref(parts)
        return cast(ParsedRef, parts)

    segments = [s for s in raw.split("/") if s]
    # Splitting drops the empty trailing segment, and with it the one thing that
    # distinguishes a subtree from a file. Carry it separately.
    dir_suffix = "/" if raw.endswith("/") else ""

    def is_known(candidate: str) -> bool:
        try:
            return expand(candidate)["matched"]
        except ArtifactRefError:
            return False  # ambiguous bare name: not evidence, fall through

    if len(segments) <= 2 and is_known(raw):
        repo = expand(raw)["repo"]
        return {"kind": KIND_REPO, "repo": repo, "ref": repo}
    if len(segments) >= 2:
        first_two = "/".join(segments[:2])
        if len(segments) > 2 and is_known(first_two):
            return parse_ref(f"{expand(first_two)['repo']}:{'/'.join(segments[2:])}{dir_suffix}")
        if is_known(segments[0]):
            return parse_ref(f"{expand(segments[0])['repo']}:{'/'.join(segments[1:])}{dir_suffix}")
        if current and current.split("/")[-1] == segments[0].lower():
            return parse_ref(f"{current}:{'/'.join(segments[1:])}{dir_suffix}")
        if len(segments) == 2:
            repo = normalize_repo(raw)
            return {"kind": KIND_REPO, "repo": repo, "ref": repo}
        raise ArtifactRefError(
            f"cannot tell where the repo ends in {raw}",
            f"Use a colon: {first_two}:{'/'.join(segments[2:])} or {segments[0]}:{'/'.join(segments[1:])}",
        )
    repo = expand(raw)["repo"]
    return {"kind": KIND_REPO, "repo": repo, "ref": repo}


def ref_from_local_path(
    path: str,
    toplevel: str,
    remote: str = "",
    repo_hint: str = "",
    is_dir: bool = False,
) -> ParsedRef:
    """Turn a path inside a checkout into a ref, given that checkout's git facts.

    Pure, and separate from running git, because the interesting failure is not "git
    errored" — it is a repo with no usable remote, where the honest answer is a
    bare-name ref rather than a checkout path.
    """

    def to_posix(value: str) -> str:
        return ("" if value is None else str(value)).replace("\\", "/").rstrip("/")

    abs_path = to_posix(path)
    top = to_posix(toplevel)
    if top == "":
        raise ArtifactRefError(
            f"{path} is not inside a git repository",
            "Artifacts are repo-relative. Pass owner/repo:path explicitly for a path outside one.",
        )
    if abs_path != top and not abs_path.startswith(top + "/"):
        raise ArtifactRefError(
            f"{path} is outside {toplevel}",
            "Pass a path inside the repository, or name the ref explicitly.",
        )

    from_remote = parse_remote_url(remote) if remote else None
    hint = repo_hint if repo_hint else top.split("/")[-1]
    repo = normalize_repo(from_remote or hint)

    relative = "" if abs_path == top else abs_path[len(top) + 1 :]
    if relative == "":
        return {"kind": KIND_REPO, "repo": repo, "ref": repo}
    return parse_ref(f"{repo}:{relative}{'/' if is_dir else ''}")


def overlap(query: str | dict[str, Any], attached: str | dict[str, Any]) -> str | None:
    """How a queried ref relates to an attached one — the whole search predicate.

    ``exact`` same thing; ``inside`` the query lies inside the attached artifact (the
    repo, or a directory above it); ``covers`` the query contains the attached
    artifact; ``None`` unrelated. Both directions matter: only checking equality would
    miss "somebody claimed the directory", which is how a collision check comes to
    report no collisions.
    """
    q = parse_ref(query) if isinstance(query, str) else query
    a = parse_ref(attached) if isinstance(attached, str) else attached
    if q.get("repo") != a.get("repo"):
        return None

    q_kind, a_kind = q.get("kind"), a.get("kind")
    if q_kind == KIND_REPO and a_kind == KIND_REPO:
        return REL_EXACT
    if q_kind == KIND_REPO:
        return REL_COVERS
    if a_kind == KIND_REPO:
        return REL_INSIDE

    if q_kind == KIND_PR or a_kind == KIND_PR:
        if q_kind == KIND_PR and a_kind == KIND_PR:
            return REL_EXACT if q.get("pr") == a.get("pr") else None
        # A PR is a review surface, not a location: it does not conflict with a file.
        return None

    q_path = str(q.get("path", ""))
    a_path = str(a.get("path", ""))
    q_dir = q_kind == KIND_DIR
    a_dir = a_kind == KIND_DIR
    q_bare = q_path[:-1] if q_dir else q_path
    a_bare = a_path[:-1] if a_dir else a_path

    if q_bare == a_bare:
        # `ui/server` as a file and `ui/server/` as a subtree are different claims on
        # the same name, and the subtree is the broader one.
        if q_dir == a_dir:
            return REL_EXACT
        return REL_COVERS if q_dir else REL_INSIDE
    if a_dir and q_bare.startswith(a_bare + "/"):
        return REL_INSIDE
    if q_dir and a_bare.startswith(q_bare + "/"):
        return REL_COVERS
    return None


def metadata_key(ref: str) -> str:
    """Metadata key holding one artifact."""
    return METADATA_PREFIX + str(parse_ref(ref)["ref"])


def ref_from_metadata_key(key: str) -> str | None:
    """The ref inside an artifact metadata key, or None for any other key.

    Unparseable keys return None rather than raising: metadata is an open namespace,
    and one hand-edited key must not make a whole bead unreadable.
    """
    raw = "" if key is None else str(key)
    if not raw.startswith(METADATA_PREFIX):
        return None
    try:
        return str(parse_ref(raw[len(METADATA_PREFIX) :])["ref"])
    except ArtifactRefError:
        return None


def now_iso() -> str:
    """Timestamp format shared by both implementations — second precision, ``Z``.

    ``datetime.isoformat()`` would write ``+00:00`` and Node writes milliseconds;
    either difference makes two agents' records look different for no reason.
    """
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def artifact_value(
    ref: str,
    intent: str = INTENT_EDITING,
    note: str = "",
    actor: str = "",
    at: str = "",
) -> dict[str, Any]:
    """Build the metadata value stored under an artifact key.

    Empty annotation is omitted rather than stored as ``""`` — a blank string in
    ``bd show`` reads as "somebody set this to nothing".
    """
    parsed = parse_ref(ref)
    if intent not in INTENTS:
        raise ArtifactRefError(f"unknown intent: {intent}", f"Intents: {', '.join(INTENTS)}")
    value: dict[str, Any] = {"kind": parsed["kind"], "repo": parsed["repo"], "intent": intent}
    if "path" in parsed:
        value["path"] = parsed["path"]
    if "pr" in parsed:
        value["pr"] = parsed["pr"]
    if note:
        value["note"] = str(note)
    if actor:
        value["actor"] = str(actor)
    value["at"] = at or now_iso()
    return value


def attach_patch(artifacts: list[dict[str, Any]]) -> dict[str, Any]:
    """The metadata patch that attaches artifacts to a bead.

    One key per ref plus the marker, in a single object, so a multi-file attach is one
    ``bd update --metadata`` — one transaction, one commit, one audit entry.
    """
    patch: dict[str, Any] = {MARKER_KEY: True}
    for artifact in artifacts:
        patch[metadata_key(str(artifact["ref"]))] = artifact_value(
            ref=str(artifact["ref"]),
            intent=str(artifact.get("intent", INTENT_EDITING)),
            note=str(artifact.get("note", "") or ""),
            actor=str(artifact.get("actor", "") or ""),
            at=str(artifact.get("at", "") or ""),
        )
    return patch


def detach_patch(refs: list[str]) -> dict[str, None]:
    """The metadata patch that releases artifacts — a ``null`` per ref.

    See :func:`artifacts_from_metadata` for why detach is a null rather than an unset.
    The marker is deliberately not cleared.
    """
    return {metadata_key(ref): None for ref in refs}


def artifacts_from_metadata(metadata: dict[str, Any] | None) -> list[Artifact]:
    """Decode every artifact on one bead from its metadata.

    A key whose value is ``None`` is a **released** artifact and is skipped. That is
    how detaching works, and the reason is bd's: its metadata-key validator
    (``^[a-zA-Z_][a-zA-Z0-9_./]*$``) rejects the ``-``, ``:`` and ``#`` that refs are
    made of, so ``--unset-metadata`` cannot remove a key that ``--metadata`` is
    willing to create.
    """
    out: list[Artifact] = []
    for key, raw in (metadata or {}).items():
        ref = ref_from_metadata_key(key)
        if not ref:
            continue
        if raw is None:
            continue  # released
        parsed = parse_ref(ref)
        value: dict[str, Any] = raw if isinstance(raw, dict) else {}
        artifact: Artifact = {
            "ref": ref,
            "kind": str(parsed["kind"]),
            "repo": str(parsed["repo"]),
            # The key is authoritative for identity, the value for annotation: a
            # hand-edited value must not be able to make an artifact claim a different
            # file than its key says.
            "intent": str(value["intent"]) if value.get("intent") in INTENTS else INTENT_EDITING,
        }
        if "path" in parsed:
            artifact["path"] = str(parsed["path"])
        if "pr" in parsed:
            artifact["pr"] = int(parsed["pr"])
        if value.get("note"):
            artifact["note"] = str(value["note"])
        if value.get("actor"):
            artifact["actor"] = str(value["actor"])
        if value.get("at"):
            artifact["at"] = str(value["at"])
        out.append(artifact)
    return sorted(out, key=lambda a: str(a["ref"]))


def intent_rank(intent: str) -> int:
    """Rank of an intent for conflict reporting. Lower sorts first."""
    return _INTENT_RANK.get(intent, len(INTENTS))


def sort_hits(hits: list[Hit]) -> list[Hit]:
    """Order search hits so the ones an agent must act on come first.

    ``editing`` before ``planned`` before ``reading`` before ``done``, exact overlaps
    before broad ones, then by bead id so repeated searches read the same.
    """
    relation_rank = {REL_EXACT: 0, REL_INSIDE: 1, REL_COVERS: 2}

    def key(hit: Hit) -> tuple[int, int, str]:
        artifact = hit.get("artifact") or {}
        return (
            intent_rank(str(artifact.get("intent", ""))),
            relation_rank.get(str(hit.get("relation", "")), 3),
            str(hit.get("issue_id", "")),
        )

    return sorted(hits, key=key)


def respond_comment(
    mine: str,
    action: str,
    ref: str,
    attached_ref: str = "",
    attached_intent: str = "",
    note: str = "",
    target: str = "",
    dep_added: bool = False,
) -> str:
    """The comment a responder leaves on an overlapping bead.

    Both surfaces must write the *same* sentence: an agent reading a bead's comments
    should not have to tell "an agent using the MCP" from "an agent using the CLI", and
    a grep for coordination traffic should find all of it.
    """
    if action not in ACTIONS:
        raise ArtifactRefError(f"unknown action: {action}", f"Actions: {', '.join(ACTIONS)}")
    canonical = str(parse_ref(ref)["ref"])
    verb = {
        ACTION_TAKING: "is taking",
        ACTION_SKIPPING: "will not touch",
        ACTION_WAITING: "is waiting on this bead before touching",
    }[action]

    lines = [f"[feads-artifact] {mine} {verb} {canonical}"]
    if attached_ref:
        parsed_attached = str(parse_ref(attached_ref)["ref"])
        lines.append(f"yours: {attached_intent or INTENT_EDITING} {parsed_attached}")
    if action == ACTION_WAITING and dep_added and target:
        lines.append(f"blocked-by dependency added: {mine} → {target}")
    if note:
        lines.append(str(note))
    return "\n".join(lines)


# =============================================================================
# Reaching the store — the peer of scripts/feads-artifact.mjs, not of the .mjs module
# =============================================================================
# Two stores, one set of call sites. Artifacts are issue metadata and artifact
# responses are issue comments, so which database holds them is the same question
# ``FEADS_PG_DSN`` answers for every other issue tool — and it has to get the same
# answer *here*, or an agent attaches a file in Postgres and another agent searching
# the Dolt board is told nobody is touching it. A split-brain coordination surface is
# worse than no coordination surface: it reports "free to work on" with authority.
#
# The five operations below are the whole seam. In bd mode each spawns the CLI exactly
# as it always did; in pg mode each goes through :class:`~beads_mcp.pgstore.PgStoreClient`,
# whose writes carry the events row and the NOTIFY that the dashboard and the
# notification miner read. Reply shapes do not branch — both sides return bd's dicts.


class BdFailedError(RuntimeError):
    """bd exited non-zero. Carries the line that says why, which is the useful part.

    Neither half of the message is the raw truth, on purpose (#feads-r8d):

    * The command is redacted. ``--metadata`` carries the whole serialized artifact
      object and ``comment`` carries free text, so quoting the argv put payload into
      an error string that is logged and returned over the wire. A reader needs the
      subcommand and the issue id; see :func:`~beads_mcp.bd_stderr.redact_bd_args`.
    * ``detail`` is the first *substantive* stderr line, not the first line. bd
      prefixes every run in a role-less clone with an advisory, and reporting line one
      told callers a warning had failed their write while the real error sat below it.

    Advisories are not thrown away — they ride along in :attr:`warnings` so a caller
    that wants them can still see them, clearly labelled as what they are.
    """

    def __init__(self, args: list[str], detail: str, warnings: list[str] | None = None) -> None:
        super().__init__(f"bd {redact_bd_args(args)} failed: {detail}")
        self.detail = detail
        self.warnings = warnings or []


@lru_cache(maxsize=1)
def _bd_path() -> str:
    """The bd binary, resolved once. ``load_config`` validates it is executable."""
    return load_config().beads_path


async def _run_bd(args: list[str], board_dir: str = "", *, mutation: bool = False) -> str:
    """Run bd against one board and return stdout.

    ``board_dir`` is stamped onto the child as BEADS_DIR rather than relying on the
    ambient one, because a cross-board search runs bd once per board in the same
    process, and bd reads BEADS_DIR ahead of cwd — a board you did not stamp is a board
    you did not query.
    """
    env = os.environ.copy()
    if board_dir:
        env["BEADS_DIR"] = board_dir
    # Attribution rides the same per-call resolution as the artifact's own actor
    # annotation. Without this, bd falls back to the *server's* BEADS_ACTOR — the
    # host's identity, not the caller's.
    effective_mutation = mutation or (
        bool(args) and args[0] in {"comment", "create", "dep", "init", "note", "reopen", "update"}
    )
    actor = _actor(mutation=effective_mutation)
    if actor:
        env["BEADS_ACTOR"] = actor
    process = await asyncio.create_subprocess_exec(
        _bd_path(),
        *args,
        stdin=asyncio.subprocess.DEVNULL,  # never inherit the MCP's stdin
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        raw = stderr.decode("utf-8", errors="replace")
        raise BdFailedError(args, failure_detail(raw, process.returncode), advisories(raw))
    return stdout.decode("utf-8", errors="replace")


async def _run_bd_json(args: list[str], board_dir: str = "") -> Any:
    """Run bd with --json and parse the result."""
    raw = await _run_bd([*args, "--json"], board_dir)
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BdFailedError(args, f"did not return JSON: {exc}") from exc


async def _ambient_board_dir() -> str:
    """Where bd resolves its board on its own — ``$BEADS_DIR``, or by walking up from cwd.

    Needed as a concrete path so ``artifact_respond`` can tell whether a bead found
    while sweeping the registry lives on the *same* board as the responder: a
    dependency can only be added inside one database.

    In pg mode this is answered from the environment instead of by asking bd. Not an
    optimization: a deployment that has cut over need not ship the binary at all, and
    the fallback that used to cost a subprocess would then cost the whole call. The
    variable is the same one bd would have read first anyway.
    """
    if pgstore.pg_enabled():
        env_dir = os.path.abspath(os.environ.get("BEADS_DIR", "").strip() or ".")
        return env_dir if os.path.basename(env_dir) == ".beads" else ""
    try:
        info = await _run_bd_json(["info"])
    except BdFailedError:
        return ""
    path = str((info or {}).get("database_path") or "")
    # database_path names the backend inside the board directory (embeddeddolt/, or a
    # .db file), so climb to the .beads directory that contains it.
    while path and os.path.basename(path) != ".beads" and path != os.path.dirname(path):
        path = os.path.dirname(path)
    return path if os.path.basename(path) == ".beads" else ""


class BoardTarget(TypedDict):
    """A board to run bd against: its registry id (may be empty), dir and repos."""

    id: str
    dir: str
    repos: list[str]


def _registered_boards() -> list[Board]:
    """Every registered board, or an empty list when there is no registry."""
    try:
        return list_boards()
    except RegistryUnavailableError:
        return []


def _known_repos() -> list[str]:
    """Every repo any board claims — the vocabulary bare names expand against."""
    seen: dict[str, None] = {}
    for board in _registered_boards():
        for repo in board["repos"]:
            seen[repo] = None
    return list(seen)


_NO_SUCH_BOARD_HINT = "Pass a board id from boards_list(), or the path of its .beads directory."


def _no_such_board(board: str) -> BoardNotFoundError:
    """The one answer for a named board that does not exist *or* that the caller cannot
    read — same message, same hint, so the two cannot be told apart."""
    return BoardNotFoundError(f"no such board: {board}", _NO_SUCH_BOARD_HINT)


def _read_scope(board: str = "") -> list[BoardTarget]:
    """The boards a read sweeps: one when named, else every registered one.

    A path search that skipped the board holding the conflict would answer "nobody is
    touching this" — the failure this exists to prevent — so the default is all of
    them.
    """
    if board:
        found = get_board(board)
        if found is None:
            raise _no_such_board(board)
        return [{"id": found["id"], "dir": found["board_dir"], "repos": found["repos"]}]
    registered = _registered_boards()
    if not registered:
        # No registry: bd still resolves a board from BEADS_DIR or cwd, and passing no
        # dir is how we let it.
        return [{"id": "", "dir": "", "repos": []}]
    return [{"id": b["id"], "dir": b["board_dir"], "repos": b["repos"]} for b in registered]


def _session_board_dir() -> str:
    """The ``.beads`` directory of this session's context(board=/workspace_root=), or ''.

    Artifact writes used to lean on the daemon's ambient BEADS_DIR, which pinned every
    session's artifacts onto the default board — and which the hosted launcher no
    longer exports. The session store is the same source every workspace-decorated
    tool routes by, so artifacts land on the board the caller actually switched to.
    Imported late because ``server`` imports this module's payload functions.
    """
    try:
        from . import server

        workspace = str(server._session_context().get("BEADS_WORKING_DIR") or "")
    except Exception:
        return ""
    if not workspace:
        return ""
    beads_dir = os.path.join(workspace, ".beads")
    return beads_dir if os.path.isdir(beads_dir) else ""


async def _issue_board_dir(issue_id: str) -> str:
    """The board directory an issue id's prefix names, or '' to fall through.

    Ids are minted ``<prefix>-<suffix>`` with prefixes unique per board, so an
    artifact call that names a bead has already named its board — the same
    longest-prefix routing the issue tools use, applied to artifact writes.
    Hosted-store only (FEADS_PG_DSN records the prefixes) and strictly
    fail-open: any miss or error returns '' and resolution proceeds exactly as
    it did before this existed.
    """
    if not issue_id or "-" not in issue_id or not os.environ.get("FEADS_PG_DSN"):
        return ""
    try:
        prefixes = await pgstore.list_board_prefixes()
        best: str | None = None
        for prefix in prefixes:
            if issue_id.startswith(prefix + "-") and (best is None or len(prefix) > len(best)):
                best = prefix
        if best is None:
            return ""
        found = get_board(prefixes[best])
        return str(found["board_dir"]) if found is not None else ""
    except Exception:  # noqa: BLE001 - routing is a convenience; never break the write
        return ""


async def _write_target(board: str = "", issue_id: str = "") -> BoardTarget:
    """The single board a write goes to: the named one, else the issue id's own,
    else the session's, else the ambient default."""
    if board:
        return _read_scope(board)[0]
    for candidate in (await _issue_board_dir(issue_id), _session_board_dir(), await _ambient_board_dir()):
        if not candidate:
            continue
        try:
            found = get_board(candidate)
        except RegistryUnavailableError:
            found = None
        if found is not None:
            return {"id": found["id"], "dir": found["board_dir"], "repos": found["repos"]}
        return {"id": "", "dir": candidate, "repos": []}
    return {"id": "", "dir": "", "repos": []}


def _resolve(value: str, preferred_repos: list[str]) -> ParsedRef:
    """Canonicalize one agent-supplied ref.

    Unlike the CLI, a checkout path is refused rather than converted: the MCP may be
    running on a different machine from the agent's editor, so converting one here
    would be guessing about a filesystem we cannot see. The error says what to pass.
    """
    return resolve_ref(value, known_repos=_known_repos(), preferred_repos=preferred_repos)


def _error_payload(exc: Exception) -> dict[str, Any]:
    """Turn a ref or store failure into a payload an agent can act on.

    ``warnings`` is reported beside ``error`` rather than folded into it: bd's
    advisories are addressed to whoever owns the server, and an agent that reads them
    as the reason its attach failed goes and fixes the wrong thing (#feads-r8d).
    """
    payload: dict[str, Any] = {"error": str(exc)}
    hint = getattr(exc, "hint", "")
    if hint:
        payload["hint"] = hint
    warnings = getattr(exc, "warnings", None)
    if warnings:
        payload["warnings"] = list(warnings)
    return payload


# -----------------------------------------------------------------------------
# The Postgres side of the seam
# -----------------------------------------------------------------------------


def _pg_board_id(board_dir: str, board_id: str = "") -> str:
    """The pgstore board id a target refers to.

    Derived from the ``.beads`` directory — ``<root>/<board_id>/.beads`` → ``<board_id>``
    — because that is the one rule every surface uses: ``boardIdForDir`` in
    ui/server/pg-store.js, ``board_id_for_workspace`` in the tools layer, and here. A
    second derivation would route a read and a write to different boards, silently.

    The registry id is the fallback for the one target that has no directory (a
    registry-less deployment sweeping the boards table), never the primary: a registry
    row's id and its directory basename are allowed to differ, and only the directory
    one names a board this store can find.
    """
    if board_dir:
        return pgstore.board_id_for_workspace(os.path.dirname(os.path.abspath(board_dir)))
    return board_id


def _pg_client(board_dir: str, board_id: str = "", *, mutation: bool = False) -> pgstore.PgStoreClient:
    """A store client for one board, or a refusal naming what could not be resolved."""
    try:
        in_silo = silo_configured()
    except ActorResolutionError as exc:
        raise ArtifactError(str(exc)) from exc
    resolved = _pg_board_id(board_dir, board_id)
    if not resolved:
        raise ArtifactError(
            "no board on this call, and the Postgres store needs one",
            "Pass board=<id> (boards_list() has them), or switch this session onto a "
            "board with context(board='<id>').",
        )
    actor = _actor(mutation=mutation) if mutation or not in_silo else None
    return pgstore.PgStoreClient(
        board_id=resolved,
        workspace_root=os.path.dirname(os.path.abspath(board_dir)) if board_dir else "",
        actor=actor or None,
    )


async def _pg_board_ids() -> list[str]:
    """Every board the store knows, for a sweep with no registry to enumerate."""
    pool = await pgstore.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT id FROM boards ORDER BY id")
    return [str(row["id"]) for row in rows]


def _as_artifact_error(exc: Exception) -> ArtifactError:
    """Re-word a store failure as one this module's payload builders already catch."""
    if isinstance(exc, ArtifactError):
        return exc
    return ArtifactError(str(exc))


async def _read_targets(board: str = "") -> list[BoardTarget]:
    """:func:`_read_scope`, with the store consulted when the registry cannot answer.

    The registry is still the source for *which repos* a board covers (the vocabulary
    bare refs expand against), so it is used whenever it has rows. Its absence is the
    only case that changes: bd could fall back to "whatever board the environment
    resolves", which is one board, while the store knows all of them — and a sweep that
    saw one board would report "nobody is touching this" for a conflict on another.
    """
    targets = _read_scope(board)
    if pgstore.pg_enabled() and len(targets) == 1 and not targets[0]["dir"] and not targets[0]["id"]:
        targets = [{"id": board_id, "dir": "", "repos": []} for board_id in await _pg_board_ids()]
    return await _scope_targets(targets, board)


async def _scope_targets(targets: list[BoardTarget], board: str) -> list[BoardTarget]:
    """Accounts mode: drop boards in spaces the caller cannot read (deny by default).

    A named board the caller cannot read is reported exactly like an unknown one.
    """
    if not await asyncio.to_thread(_accounts.accounts_enabled, os.environ):
        return targets
    principal = (await asyncio.to_thread(resolve_identity)).get("principal")
    readable = await asyncio.to_thread(_accounts.readable_boards, principal)
    if readable is None:
        return targets
    kept = [t for t in targets if t["id"] and t["id"] in readable]
    if board and not kept:
        raise _no_such_board(board)
    return kept


# -----------------------------------------------------------------------------
# The five store operations, one call site each
# -----------------------------------------------------------------------------


async def _beads_with_artifacts(board_dir: str, include_closed: bool, board_id: str = "") -> list[dict[str, Any]]:
    """Every bead on a board that carries artifacts.

    The marker key keeps this proportional to the beads that have artifacts rather than
    to the whole board, and ``--limit 0`` is load-bearing: bd defaults to 50 rows,
    which would silently answer "no conflict" on a busy board.
    """
    if pgstore.pg_enabled():
        try:
            return await _pg_client(board_dir, board_id).issues_with_metadata_key(
                MARKER_KEY, include_closed=include_closed
            )
        except ArtifactError:
            raise
        except Exception:
            # Same tolerance as the bd branch below, for the same reason.
            return []

    args = ["list", "--limit", "0", "--has-metadata-key", MARKER_KEY]
    if include_closed:
        args.append("--all")
    try:
        rows = await _run_bd_json(args, board_dir)
    except BdFailedError:
        # One unreachable board must not fail a cross-board sweep; the other boards
        # still hold the answer. Reported in the payload as a scanned/failed board.
        return []
    return [row for row in (rows or []) if isinstance(row, dict)]


async def _show_issue(issue_id: str, board_dir: str, board_id: str = "") -> dict[str, Any]:
    """Read one bead, with its metadata."""
    if pgstore.pg_enabled():
        try:
            return await _pg_client(board_dir, board_id).read_issue(issue_id)
        except Exception as exc:
            raise _as_artifact_error(exc) from exc

    result = await _run_bd_json(["show", issue_id], board_dir)
    issue = result[0] if isinstance(result, list) and result else result
    if not isinstance(issue, dict) or not issue.get("id"):
        raise BdFailedError(["show", issue_id], f"no bead found matching {issue_id}")
    return issue


async def _apply_metadata(issue_id: str, patch: dict[str, Any], board_dir: str, board_id: str = "") -> None:
    """Merge an artifact patch into one bead's metadata.

    One call per attach or detach however many refs it carries — bd merges the whole
    object inside its transaction and so does the store, so a multi-file attach stays
    one write, one audit entry, one notification.
    """
    if pgstore.pg_enabled():
        try:
            await _pg_client(board_dir, board_id, mutation=True).patch_metadata(issue_id, patch)
        except Exception as exc:
            raise _as_artifact_error(exc) from exc
        return
    await _run_bd(["update", issue_id, "--metadata", json.dumps(patch)], board_dir)


async def _post_comment(issue_id: str, text: str, board_dir: str, board_id: str = "") -> None:
    """Leave the coordination comment on somebody else's bead."""
    if pgstore.pg_enabled():
        try:
            await _pg_client(board_dir, board_id, mutation=True).add_comment(
                AddCommentParams(issue_id=issue_id, text=text)
            )
        except Exception as exc:
            raise _as_artifact_error(exc) from exc
        return
    await _run_bd(["comment", issue_id, text], board_dir)


async def _add_blocks_dep(issue_id: str, blocker_id: str, board_dir: str, board_id: str = "") -> None:
    """Record that ``issue_id`` is blocked by ``blocker_id`` — same board only."""
    if pgstore.pg_enabled():
        try:
            await _pg_client(board_dir, board_id, mutation=True).add_dependency(
                AddDependencyParams(issue_id=issue_id, depends_on_id=blocker_id, dep_type="blocks")
            )
        except Exception as exc:
            raise _as_artifact_error(exc) from exc
        return
    await _run_bd(["dep", "add", issue_id, blocker_id, "--type", "blocks"], board_dir)


def _same_board(hit: Hit, mine: BoardTarget) -> bool:
    """Whether a hit lives on the same board as the responder.

    A dependency edge only exists inside one board, so this decides whether ``waiting``
    can add one or has to settle for the comment. Under bd the board *is* the
    directory; in pg mode boards are rows in one database and a target swept out of the
    store may carry no directory at all, so the ids are compared instead — which is the
    same claim, spelled in whatever identifies a board on this deployment.
    """
    if pgstore.pg_enabled():
        return _pg_board_id(hit["board_dir"], hit["board"]) == _pg_board_id(mine["dir"], mine["id"])
    return hit["board_dir"] == mine["dir"] or (not hit["board_dir"] and not mine["dir"])


async def _search_hits(
    ref: str,
    boards: list[BoardTarget],
    include_closed: bool = False,
    intent: str = "",
    exclude: str = "",
) -> list[Hit]:
    """Find every bead whose artifacts overlap a ref."""
    hits: list[Hit] = []
    for board in boards:
        for issue in await _beads_with_artifacts(board["dir"], include_closed, board["id"]):
            if exclude and issue.get("id") == exclude:
                continue
            for artifact in artifacts_from_metadata(issue.get("metadata")):
                if intent and artifact.get("intent") != intent:
                    continue
                relation = overlap(ref, dict(artifact))
                if not relation:
                    continue
                hits.append(
                    {
                        "board": board["id"],
                        "board_dir": board["dir"],
                        "issue_id": str(issue.get("id", "")),
                        "title": str(issue.get("title", "") or ""),
                        "status": str(issue.get("status", "") or ""),
                        "assignee": str(issue.get("assignee", "") or ""),
                        "relation": relation,
                        "artifact": artifact,
                    }
                )
    return sort_hits(hits)


# =============================================================================
# Tool payloads
# =============================================================================
# Shaped here rather than in server.py so the JSON an agent sees can be asserted on
# without standing up an MCP client — the same split boards.py uses.


def _actor(*, mutation: bool = False) -> str:
    """The actor recorded on an artifact, resolved per call.

    The caller's verified wire identity wins, for the reason :func:`acting_actor`
    gives: one HTTP server serves many agents, and the process environment
    describes the host, not the caller. The environment stays as the fallback for
    a caller that verified as nobody — on stdio that environment genuinely is the
    caller's own, and on HTTP an unverified caller cannot reach a write anyway.

    This must agree with what bd stamps into ``created_by`` for the same call
    (see ``_run_bd``): the artifact's ``actor`` annotation and the bead's creator
    are two records of one fact, and letting them diverge would make the
    dashboard disagree with the audit trail.
    """
    try:
        # Do not even read the configured fallback in a silo. Mutations must use
        # the exact identity authorized for this tool, not a second resolution.
        if mutation and silo_configured():
            context = authorized_mutation_context()
            if context is None or not context.actor:
                raise ActorResolutionError("a valid FEADS_SILO requires an authorized acting actor")
            return context.actor
        actor = acting_actor()
        if silo_configured():
            return actor
        fallback = os.environ.get("BEADS_ACTOR", "") or (load_config().beads_actor or "")
        return actor or fallback
    except ActorResolutionError as exc:
        # Payload builders already expose ArtifactError as structured tool data.
        raise ArtifactError(str(exc)) from exc


async def artifact_canon_payload(refs: list[str], board: str = "") -> dict[str, Any]:
    """Build the ``artifact_canon`` result.

    A named board's repo list steers bare-name expansion, so naming one is a read of
    that board: under accounts mode an unreadable board answers exactly like a missing
    one (and the server refuses an anonymous caller before this runs).
    """
    try:
        target = await _write_target(board)
        if board:
            target = (await _scope_targets([target], board))[0]
        resolved = [_resolve(r, target["repos"]) for r in refs]
    except (ArtifactError, BdFailedError) as exc:
        return _error_payload(exc)
    return {"refs": [dict(r) for r in resolved]}


async def artifact_list_payload(issue_id: str, board: str = "") -> dict[str, Any]:
    """Build the ``artifact_list`` result.

    A read of the bead's board: the server authorizes the issue id where it lives
    before this runs; the board check here covers a store with no id index (bd).
    """
    try:
        target = await _write_target(board, issue_id)
        if not await _scope_targets([target], board):
            raise ArtifactError(f"refused: {issue_id} is not available to this identity")
        issue = await _show_issue(issue_id, target["dir"], target["id"])
    except (ArtifactError, BdFailedError) as exc:
        return _error_payload(exc)
    artifacts = artifacts_from_metadata(issue.get("metadata"))
    return {
        "issue": issue.get("id"),
        "title": issue.get("title", ""),
        "status": issue.get("status", ""),
        "board": target["id"],
        "artifacts": [dict(a) for a in artifacts],
        "count": len(artifacts),
    }


async def artifact_add_payload(
    issue_id: str,
    refs: list[str],
    intent: str = INTENT_EDITING,
    note: str = "",
    board: str = "",
) -> dict[str, Any]:
    """Build the ``artifact_add`` result.

    Reports the other beads that already claim these refs, unprompted: attaching is the
    moment an agent can still choose differently, and a collision it has to run a
    second tool to discover is a collision it will not look for.
    """
    if intent not in INTENTS:
        return {"error": f"unknown intent: {intent}", "hint": f"Intents: {', '.join(INTENTS)}"}
    try:
        actor = _actor(mutation=True)
        target = await _write_target(board, issue_id)
        resolved = [_resolve(r, target["repos"]) for r in refs]
        patch = attach_patch(
            [{"ref": str(r["ref"]), "intent": intent, "note": note, "actor": actor} for r in resolved]
        )
        await _apply_metadata(issue_id, patch, target["dir"], target["id"])
        scope = await _read_targets(board)
        conflicts: list[Hit] = []
        for r in resolved:
            found = await _search_hits(str(r["ref"]), scope, exclude=issue_id)
            conflicts.extend(h for h in found if h["artifact"].get("intent") != INTENT_DONE)
    except (ArtifactError, BdFailedError) as exc:
        return _error_payload(exc)
    payload: dict[str, Any] = {
        "issue": issue_id,
        "intent": intent,
        "attached": [str(r["ref"]) for r in resolved],
        "board": target["id"],
        "others_claiming": [dict(h) for h in conflicts],
    }
    if conflicts:
        payload["hint"] = (
            "Another bead already claims this. Answer it with "
            "artifact_respond(ref, mine, action='taking'|'skipping'|'waiting')."
        )
    return payload


async def artifact_remove_payload(issue_id: str, refs: list[str], board: str = "") -> dict[str, Any]:
    """Build the ``artifact_remove`` result."""
    try:
        _actor(mutation=True)
        target = await _write_target(board, issue_id)
        resolved = [_resolve(r, target["repos"]) for r in refs]
        patch = detach_patch([str(r["ref"]) for r in resolved])
        await _apply_metadata(issue_id, patch, target["dir"], target["id"])
    except (ArtifactError, BdFailedError) as exc:
        return _error_payload(exc)
    return {"issue": issue_id, "detached": [str(r["ref"]) for r in resolved], "board": target["id"]}


async def artifact_search_payload(
    ref: str,
    board: str = "",
    include_closed: bool = False,
    intent: str = "",
    limit: int | None = None,
) -> dict[str, Any]:
    """Build the ``artifact_search`` result."""
    if intent and intent not in INTENTS:
        return {"error": f"unknown intent: {intent}", "hint": f"Intents: {', '.join(INTENTS)}"}
    try:
        boards = await _read_targets(board)
        preferred = boards[0]["repos"] if len(boards) == 1 else []
        query = _resolve(ref, preferred)
        hits = await _search_hits(str(query["ref"]), boards, include_closed=include_closed, intent=intent)
    except (ArtifactError, BdFailedError) as exc:
        return _error_payload(exc)
    total = len(hits)
    if limit is not None and limit > 0:
        hits = hits[:limit]
    payload: dict[str, Any] = {
        "query": query["ref"],
        "kind": query["kind"],
        "boards_searched": [b["id"] or b["dir"] or "(ambient)" for b in boards],
        "hits": [dict(h) for h in hits],
        "count": total,
    }
    if total == 0:
        payload["hint"] = f"No bead claims {query['ref']} — it is free to work on."
    elif limit is not None and 0 < limit < total:
        payload["truncated"] = True
    return payload


async def artifact_respond_payload(
    ref: str,
    mine: str,
    action: str,
    target_issue: str = "",
    note: str = "",
    board: str = "",
) -> dict[str, Any]:
    """Build the ``artifact_respond`` result.

    ``waiting`` adds a real ``blocks`` dependency as well as the comment, so ``bd
    ready`` stops offering the waiting bead. That only works inside one board — boards
    are separate databases — so across boards the comment is the whole record, and the
    payload says so rather than implying a dependency exists.
    """
    if action not in ACTIONS:
        return {"error": f"unknown action: {action}", "hint": f"Actions: {', '.join(ACTIONS)}"}
    try:
        actor = _actor(mutation=True)
        my_board = await _write_target(board, mine)
        my_issue = await _show_issue(mine, my_board["dir"], my_board["id"])
        query = _resolve(ref, my_board["repos"])
        scope = await _read_targets(board)
        all_hits = await _search_hits(str(query["ref"]), scope, exclude=str(my_issue["id"]))
        hits = [h for h in all_hits if h["issue_id"] == target_issue] if target_issue else all_hits
        if target_issue and not hits:
            return {
                "error": f"{target_issue} does not claim {query['ref']}",
                "hint": "Run artifact_search first, or omit target_issue to answer every overlap.",
            }

        # Record our own stance before telling anyone: a comment claiming we are taking
        # a file, with nothing on our bead to show it, is worse than no comment.
        own_intent = ACTION_INTENT[action]
        if own_intent:
            patch = attach_patch([{"ref": str(query["ref"]), "intent": own_intent, "note": note, "actor": actor}])
            await _apply_metadata(str(my_issue["id"]), patch, my_board["dir"], my_board["id"])

        answered: list[dict[str, Any]] = []
        seen: set[str] = set()
        for hit in hits:
            if hit["issue_id"] in seen:
                continue  # one comment per bead, not per artifact
            seen.add(hit["issue_id"])
            same_board = _same_board(hit, my_board)
            dep_added = False
            if action == ACTION_WAITING and same_board:
                await _add_blocks_dep(str(my_issue["id"]), hit["issue_id"], my_board["dir"], my_board["id"])
                dep_added = True
            text = respond_comment(
                mine=str(my_issue["id"]),
                action=action,
                ref=str(query["ref"]),
                attached_ref=str(hit["artifact"]["ref"]),
                attached_intent=str(hit["artifact"].get("intent", "")),
                note=note,
                target=hit["issue_id"],
                dep_added=dep_added,
            )
            await _post_comment(hit["issue_id"], text, hit["board_dir"], hit["board"])
            answered.append(
                {
                    "issue_id": hit["issue_id"],
                    "board": hit["board"],
                    "dep_added": dep_added,
                    "comment": text,
                }
            )
    except (ArtifactError, BdFailedError) as exc:
        return _error_payload(exc)

    payload: dict[str, Any] = {
        "mine": my_issue["id"],
        "action": action,
        "ref": query["ref"],
        "recorded_intent": own_intent,
        "answered": answered,
    }
    if not answered:
        payload["hint"] = f"No bead claims {query['ref']} — there was nobody to tell."
    elif action == ACTION_WAITING and any(not a["dep_added"] for a in answered):
        payload["hint"] = (
            "No dependency was added across boards — beads live in per-board databases, "
            "so the comment is the only record there."
        )
    return payload
