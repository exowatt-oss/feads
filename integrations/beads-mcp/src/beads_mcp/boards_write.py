"""Registry writes — by spawning the one blessed writer, never by writing.

:mod:`beads_mcp.boards` opens the registry ``mode=ro`` and that guarantee is kept
here, deliberately: **nothing in this process ever opens the registry for
writing.** A write tool call spawns ``scripts/feads-board.mjs`` — the same CLI a
human uses — and relays its answer. The registry keeps exactly one writer
implementation (``boards/registry.mjs``), one schema owner, one set of conflict
rules, and this server cannot race it on creation or migration because it never
holds a write handle at all.

## Why a subprocess and not a port

The same argument :mod:`beads_mcp.signup` makes for proxying registration over
HTTP, applied to a surface whose writer is a CLI rather than a dashboard route.
``upsertBoard`` owns slug derivation, the board_dir-uniqueness conflict rule and
the timestamp discipline; a Python re-implementation would be a second copy of all
three, drifting silently until two surfaces disagree about whether a board exists.
Routing already costs us one dual-implementation parity contract; writes get zero.

A subprocess rather than the dashboard's HTTP API because the failure mode is
better: the CLI ships in the same checkout as this server and needs only ``node``
(already a hard requirement of feads), while the dashboard is a *second daemon*
that may be stopped — and board writes should not fail because a browser-facing
process is down. Sign-up genuinely needs the dashboard (its single-use invite
semantics live in SQL the dashboard executes); board writes need only the CLI.

## Authorization

These builders do not gate — the tools that call them wear ``@require_write``,
the same policy gate as every bead mutation, resolved per request from the wire
identity. The CLI runs as the server's local user and would happily write for
anyone; the gate in front of it is what makes "a `user` may edit boards, an
anonymous HTTP caller may not" true. That is the reason the CLI's *operator*
stance is not inherited by callers of this server.

## Failure taxonomy

Mirrors signup's discipline: every distinguishable failure gets its own ``code``
so an agent can branch without parsing prose. ``cli_unavailable`` (the writer is
not on this machine — a deployment problem, not a refusal), ``board_not_found``
(with the known ids, so the agent's next call can be right), ``dir_conflict``
(the directory belongs to another board id), ``no_database`` (the directory holds
no board, so registering it would promise a home no issue would actually reach),
``invalid`` (the request was wrong before any subprocess ran), and ``cli_failed``
(the writer refused; its stderr is the reason).
"""

import json
import logging
import os
import shutil
import subprocess
from collections.abc import Mapping, Sequence
from typing import Any

from beads_mcp.boards import RegistryUnavailableError, list_boards, registry_path

logger = logging.getLogger(__name__)

# Explicit override for where the writer CLI lives. Set by deployments that
# install this package outside the feads checkout.
BOARD_CLI_ENV = "FEADS_BOARD_CLI"

# Node binary override. Defaults to `node` on PATH — Node >= 22 is already a hard
# requirement of feads (the UI cannot run without it), so this is not a new
# dependency, only a new caller of an existing one.
NODE_BIN_ENV = "FEADS_NODE_BIN"

# `create` may run `bd init`, which builds an embedded Dolt database — seconds,
# not milliseconds. Everything else is two SQLite statements.
CREATE_TIMEOUT_SECONDS = 120.0
WRITE_TIMEOUT_SECONDS = 30.0

# stderr is relayed as the failure reason; the cap is for the pathological case
# (a wedged bd init dumping a stack trace per retry), not the normal one.
_MAX_STDERR_CHARS = 2000

_CLI_UNAVAILABLE_HINT = (
    "Registry writes are made by scripts/feads-board.mjs (the one blessed writer) and "
    "this server could not find or run it. If this server runs inside a feads checkout "
    "it is found automatically; otherwise set FEADS_BOARD_CLI to the script's path and "
    "make sure `node` is on PATH (or set FEADS_NODE_BIN). Reads are unaffected. A human "
    "can always make the same edit directly: `feads-board repos <id> --repo <owner/name> --add`."
)


def _find_board_cli(env: Mapping[str, str] | None = None) -> str:
    """Locate ``scripts/feads-board.mjs``, or return ``""``.

    Precedence: the explicit env override, then a walk up from this file — which
    finds the script whenever this package runs from its home in the feads
    checkout (``integrations/beads-mcp/src/beads_mcp``), however the checkout got
    there. No PATH fallback: an unrelated ``feads-board`` on PATH writing a
    *different* registry schema is a worse outcome than a clean
    ``cli_unavailable``.
    """
    source = os.environ if env is None else env
    override = str(source.get(BOARD_CLI_ENV, "") or "").strip()
    if override:
        return override if os.path.isfile(override) else ""

    here = os.path.dirname(os.path.abspath(__file__))
    for _ in range(8):
        candidate = os.path.join(here, "scripts", "feads-board.mjs")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    return ""


def _find_node(env: Mapping[str, str] | None = None) -> str:
    """Locate the node binary, or return ``""``."""
    source = os.environ if env is None else env
    override = str(source.get(NODE_BIN_ENV, "") or "").strip()
    if override:
        return override
    return shutil.which("node") or ""


def _known_board_ids() -> list[str]:
    """Best-effort list of registered board ids, for not-found payloads."""
    try:
        return [str(board["id"]) for board in list_boards()]
    except RegistryUnavailableError:
        return []


def _failure(verb: str, code: str, reason: str, **extra: Any) -> dict[str, Any]:
    """One failed write, as data an agent can branch on."""
    payload: dict[str, Any] = {
        verb: False,
        "code": code,
        "reason": reason,
        "registry_path": registry_path(),
    }
    payload.update(extra)
    return payload


def _run_board_cli(
    args: Sequence[str],
    verb: str,
    env: Mapping[str, str] | None = None,
    timeout: float = WRITE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Spawn the writer CLI with ``--json`` and return its parsed answer.

    The child inherits the caller's environment so ``FEADS_REGISTRY_DB`` (and
    ``BD_BIN``, which ``create`` uses) point at the same world the read path
    sees. On failure, stderr *is* the reason — the CLI writes its refusals there
    in one line — translated to a code where the line is recognizable.
    """
    source = dict(os.environ if env is None else env)
    cli = _find_board_cli(source)
    node = _find_node(source)
    if not cli or not node:
        missing = "scripts/feads-board.mjs" if not cli else "node"
        return _failure(
            verb,
            "cli_unavailable",
            f"cannot run the registry writer: {missing} was not found",
            hint=_CLI_UNAVAILABLE_HINT,
        )

    command = [node, cli, *args, "--json"]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=source,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return _failure(
            verb,
            "cli_unavailable",
            f"could not run {node}: {type(exc).__name__}: {exc}",
            hint=_CLI_UNAVAILABLE_HINT,
        )

    stderr = (result.stderr or "").strip()[:_MAX_STDERR_CHARS]
    if result.returncode != 0:
        # The CLI's one-line refusals, mapped to codes an agent can branch on.
        # Anything unrecognized is relayed verbatim under `cli_failed` — an
        # unfamiliar failure should look unfamiliar, not be folded into a code
        # that suggests a next move it does not have.
        if "no such board:" in stderr:
            return _failure(
                verb,
                "board_not_found",
                stderr,
                known_boards=_known_board_ids(),
                hint="Pass a board id from boards_list(), or the absolute path of its .beads directory.",
            )
        if "holds no board database" in stderr:
            return _failure(
                verb,
                "no_database",
                stderr,
                hint=(
                    "That directory is not a board — registering it would promise a home "
                    "for issues that do not have one, and they would land on whatever "
                    "board the environment resolves instead. Use board_create() on the "
                    "project directory, which runs bd init and registers the result."
                ),
            )
        if "already registered as" in stderr:
            return _failure(
                verb,
                "dir_conflict",
                stderr,
                hint=(
                    "That directory already belongs to another board id. Use that board "
                    "(boards_list() shows it) instead of registering a duplicate."
                ),
            )
        if "changed since you read it" in stderr:
            return _failure(
                verb,
                "description_conflict",
                stderr,
                hint=(
                    "Somebody updated this board's description after your read. Re-read it "
                    "(boards_list or board_show), merge deliberately, and retry with the "
                    "fresh value as expected_description."
                ),
            )
        return _failure(verb, "cli_failed", stderr or f"exit {result.returncode} with no stderr")

    try:
        parsed = json.loads(result.stdout)
    except ValueError:
        return _failure(
            verb,
            "cli_failed",
            f"the writer exited 0 but its output was not JSON: {result.stdout[:200]!r}",
        )

    payload: dict[str, Any] = {"registry_path": registry_path()}
    payload.update(parsed)
    return payload


def _clean_repos(verb: str, repos: Sequence[str]) -> tuple[list[str], dict[str, Any] | None]:
    """Trim, de-duplicate and sanity-check a repo list before spawning anything.

    Returns ``(repos, None)`` or ``([], failure_payload)``. Repos without a
    ``/`` are accepted — routing matches bare names — but flagged, because
    ``owner/name`` is what makes two boards' lists comparable.
    """
    cleaned: list[str] = []
    for repo in repos:
        trimmed = str(repo or "").strip()
        if trimmed and trimmed not in cleaned:
            cleaned.append(trimmed)
    if not cleaned:
        return [], _failure(
            verb,
            "invalid",
            "no repos given",
            hint="Pass at least one repo as owner/name, e.g. example-lab/sample-web-ui.",
        )
    return cleaned, None


def _repo_warnings(repos: Sequence[str]) -> list[str]:
    """Non-fatal hygiene notes for a repo list."""
    return [
        f"{repo!r} has no owner/ prefix — owner/name is the convention that keeps boards comparable"
        for repo in repos
        if "/" not in repo
    ]


def _with_warnings(payload: dict[str, Any], warnings: list[str]) -> dict[str, Any]:
    if warnings:
        payload["warnings"] = warnings
    return payload


def board_repos_add_payload(
    board: str, repos: Sequence[str], env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Append repos to a board's list, leaving existing entries alone.

    Add and remove are the only repo verbs this server offers — deliberately not
    replace. Replace is a read-modify-write, and two agents replacing at once
    silently drop each other's edits; adds are row-targeted and compose in any
    order. The CLI keeps replace for humans.
    """
    board_id = str(board or "").strip()
    if not board_id:
        return _failure("updated", "invalid", "no board given")
    cleaned, failure = _clean_repos("updated", repos)
    if failure:
        return failure
    result = _run_board_cli(["repos", board_id, *_repo_flags(cleaned), "--add"], "updated", env)
    return _with_warnings(result, _repo_warnings(cleaned))


def board_repos_remove_payload(
    board: str, repos: Sequence[str], env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Remove exactly the named repos from a board's list."""
    board_id = str(board or "").strip()
    if not board_id:
        return _failure("updated", "invalid", "no board given")
    cleaned, failure = _clean_repos("updated", repos)
    if failure:
        return failure
    return _run_board_cli(["repos", board_id, *_repo_flags(cleaned), "--remove"], "updated", env)


def board_describe_payload(
    board: str,
    description: str | None = None,
    name: str | None = None,
    env: Mapping[str, str] | None = None,
    expected_description: str | None = None,
) -> dict[str, Any]:
    """Update a board's description and/or display name. The id never changes."""
    board_id = str(board or "").strip()
    if not board_id:
        return _failure("updated", "invalid", "no board given")
    if description is None and name is None:
        return _failure(
            "updated",
            "invalid",
            "nothing to update",
            hint="Pass description and/or name.",
        )
    args = ["describe", board_id]
    if expected_description is not None:
        # Compare-and-set: the registry refuses the write when the current
        # description differs from what the caller last read, instead of
        # silently clobbering the routing signal (feads-rnt).
        args += ["--expect-description", str(expected_description)]
    if description is not None:
        args += ["--description", str(description)]
    if name is not None:
        trimmed = str(name).strip()
        if not trimmed:
            return _failure("updated", "invalid", "name cannot be blank")
        args += ["--name", trimmed]
    return _run_board_cli(args, "updated", env)


def board_create_payload(
    project_dir: str,
    name: str,
    id: str = "",
    prefix: str = "",
    description: str = "",
    repos: Sequence[str] = (),
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Create a board for a project directory and register it.

    Runs ``bd init`` when the directory has no board yet, so this is the one
    write that costs real time and touches the *server's* filesystem —
    ``project_dir`` is a path where this server runs, not where the caller sits.
    """
    directory = str(project_dir or "").strip()
    board_name = str(name or "").strip()
    if not directory:
        return _failure("created", "invalid", "no project_dir given")
    if not board_name:
        return _failure("created", "invalid", "no name given")
    args = ["create", directory, "--name", board_name]
    if str(id or "").strip():
        args += ["--id", str(id).strip()]
    if str(prefix or "").strip():
        args += ["--prefix", str(prefix).strip()]
    if str(description or "").strip():
        args += ["--description", str(description)]
    cleaned = [str(r).strip() for r in repos if str(r or "").strip()]
    args += _repo_flags(cleaned)
    result = _run_board_cli(args, "created", env, timeout=CREATE_TIMEOUT_SECONDS)
    return _with_warnings(result, _repo_warnings(cleaned))


def board_register_payload(
    board_dir: str,
    name: str,
    id: str = "",
    workspace: str = "",
    description: str = "",
    repos: Sequence[str] = (),
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Register a board that already exists (a ``.beads`` directory) in the registry."""
    directory = str(board_dir or "").strip()
    board_name = str(name or "").strip()
    if not directory:
        return _failure("registered", "invalid", "no board_dir given")
    if not board_name:
        return _failure("registered", "invalid", "no name given")
    args = ["register", directory, "--name", board_name]
    if str(id or "").strip():
        args += ["--id", str(id).strip()]
    if str(workspace or "").strip():
        args += ["--workspace", str(workspace).strip()]
    if str(description or "").strip():
        args += ["--description", str(description)]
    cleaned = [str(r).strip() for r in repos if str(r or "").strip()]
    args += _repo_flags(cleaned)
    result = _run_board_cli(args, "registered", env)
    return _with_warnings(result, _repo_warnings(cleaned))


def _repo_flags(repos: Sequence[str]) -> list[str]:
    """``--repo <r>`` pairs, in caller order."""
    flags: list[str] = []
    for repo in repos:
        flags += ["--repo", repo]
    return flags
