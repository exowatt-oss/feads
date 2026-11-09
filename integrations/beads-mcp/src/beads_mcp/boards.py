"""Read-only access to the feads board registry.

A "board" is one beads database — a ``.beads/`` directory holding an embedded Dolt
DB. bd itself only ever knows about the single board it resolves from the working
directory, so an agent has no way to ask "which boards exist, and which one does
this task belong to?". The registry answers that: it records every board plus the
signals needed to route work to it (a description and the repos it covers).

The registry is a SQLite database owned by the Node CLI (``scripts/feads-board.mjs``;
schema and routing algorithm in ``boards/registry.mjs``). This module is the Python
reader for it and is deliberately read-only — two runtimes racing to create or
migrate the same schema is the one failure mode that would corrupt the board list
for everybody. Connections use ``mode=ro`` so SQLite enforces that rather than us.
Writes exist, but not here: :mod:`beads_mcp.boards_write` spawns that same CLI, so
the Python process never holds a write handle even when it is the one asking.

Scoring in :func:`route_task` mirrors ``routeTask`` in ``boards/registry.mjs``
weight for weight. The CLI, the UI and this server all rank candidates for the
same task, and an agent that gets three different answers has no reason to trust
any of them.
"""

import os
import pathlib
import re
import sqlite3
from typing import Any, TypedDict

REGISTRY_DB_ENV = "FEADS_REGISTRY_DB"

# Routing weights, mirrored from routeTask() in boards/registry.mjs. An *explicit*
# repo dominates on purpose: "which repo does this touch" is a hard, checkable
# signal, while description overlap is inference — so a task naming a repo lands on
# the board that owns it even when another board's description reads closer.
#
# But a board is NOT tied to a repo; it may list zero, one or many. So no component
# may scale with the size of a board's repo list, and every one of them is bounded.
# The repo signal takes the best single match rather than a sum, and a repo named in
# the task text is credited once per board however many of its repos appear.
SCORE_REPO_EXACT = 100
SCORE_REPO_SHORT_NAME = 60
SCORE_REPO_IN_TEXT = 25
SCORE_TOKEN_HIT = 5

# Description is capped so a keyword-stuffed description cannot dominate, but the
# cap sits above SCORE_REPO_IN_TEXT so a genuinely well-matched description can
# still outrank an incidental repo mention — a repo-less board has nothing else.
MAX_DESCRIPTION_SCORE = 40

# Tokens below this length ("a", "to", "the") match everything and rank nothing.
MIN_TOKEN_LENGTH = 4
# A repo short name has to be at least this long before a substring hit in free
# text means anything ("ui" would match half the English language).
MIN_REPO_MENTION_LENGTH = 3
# Reasons stay readable: only the first few overlapping tokens are named.
MAX_REPORTED_TOKEN_HITS = 6

# Columns are listed explicitly rather than SELECT *, so a column added by a later
# Node-side migration cannot silently change the shape this server promises.
_BOARD_SELECT = "SELECT id, name, board_dir, workspace_dir, description, created_at, updated_at FROM boards"

_TOKEN_SPLIT = re.compile(r"[^a-z0-9]+")

_SETUP_HINT = (
    "No boards are registered. Register an existing board with the board_register tool "
    "(or `feads-board register <path-to-.beads> --name <name> --description <what it is "
    "for> --repo <owner/name>`), or create a new one with board_create (or `feads-board "
    "create <project-dir> --name <name>`). Every write runs through that CLI — the tools "
    "spawn it; this server itself only reads the registry."
)


class Board(TypedDict):
    """One registered beads database and the signals used to route work to it."""

    id: str
    name: str
    board_dir: str
    workspace_dir: str
    description: str
    repos: list[str]
    created_at: int
    updated_at: int


class RouteCandidate(TypedDict):
    """A board scored against a task, with the reasons it scored."""

    board: Board
    score: int
    reasons: list[str]


class RegistryUnavailableError(RuntimeError):
    """The registry is missing, unreadable, or has no schema yet.

    Carries ``hint`` so tools can tell an agent how to fix it instead of handing
    back a traceback.
    """

    def __init__(self, message: str, hint: str = _SETUP_HINT) -> None:
        super().__init__(message)
        self.hint = hint


def registry_path() -> str:
    """Location of the registry database.

    Mirrors ``getRegistryPath()`` in boards/registry.mjs: ``$FEADS_REGISTRY_DB``
    when set, otherwise ``~/.feads/registry.db``.
    """
    override = os.environ.get(REGISTRY_DB_ENV, "")
    if override:
        return os.path.abspath(override)
    return os.path.join(os.path.expanduser("~"), ".feads", "registry.db")


def _connect(db_path: str | None = None) -> sqlite3.Connection:
    """Open the registry read-only.

    Args:
        db_path: Registry location. Defaults to :func:`registry_path`.

    Returns:
        A read-only connection with ``sqlite3.Row`` rows.

    Raises:
        RegistryUnavailableError: If the file is absent or cannot be opened.
    """
    path = os.path.abspath(db_path) if db_path else registry_path()

    # mode=ro will not create a missing file, but it reports that as a generic
    # "unable to open database file" — check first so a typo'd FEADS_REGISTRY_DB
    # says which path was tried.
    if not os.path.isfile(path):
        raise RegistryUnavailableError(f"no board registry at {path}")

    uri = f"{pathlib.Path(path).as_uri()}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as exc:
        raise RegistryUnavailableError(f"cannot open board registry at {path}: {exc}") from exc

    conn.row_factory = sqlite3.Row
    return conn


def _query(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    """Run a read query, turning any SQLite failure into RegistryUnavailableError.

    A registry file that exists but has no ``boards`` table is the normal state of
    a database some other tool created, so it reads as "unavailable" rather than
    as an internal error.
    """
    try:
        return conn.execute(sql, params).fetchall()
    except sqlite3.Error as exc:
        raise RegistryUnavailableError(f"board registry is not readable: {exc}") from exc


def _repos_by_board(conn: sqlite3.Connection, board_ids: list[str]) -> dict[str, list[str]]:
    """Repo lists for the given boards, each sorted by repo name."""
    if not board_ids:
        return {}

    placeholders = ",".join("?" for _ in board_ids)
    rows = _query(
        conn,
        f"SELECT board_id, repo FROM board_repos WHERE board_id IN ({placeholders}) ORDER BY repo",
        tuple(board_ids),
    )

    grouped: dict[str, list[str]] = {board_id: [] for board_id in board_ids}
    for row in rows:
        grouped[str(row["board_id"])].append(str(row["repo"]))
    return grouped


def _to_board(row: sqlite3.Row, repos: list[str]) -> Board:
    """Build a Board from a boards row plus its repo list."""
    return Board(
        id=str(row["id"]),
        name=str(row["name"]),
        board_dir=str(row["board_dir"]),
        workspace_dir=str(row["workspace_dir"]),
        description=str(row["description"]),
        repos=repos,
        created_at=int(row["created_at"]),
        updated_at=int(row["updated_at"]),
    )


def list_boards(db_path: str | None = None) -> list[Board]:
    """List every registered board, ordered by name.

    Mirrors ``listBoards()`` in boards/registry.mjs.

    Args:
        db_path: Registry location. Defaults to :func:`registry_path`.

    Returns:
        Every board in the registry (empty list if the registry has no rows).

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    conn = _connect(db_path)
    try:
        rows = _query(conn, f"{_BOARD_SELECT} ORDER BY name")
        repos = _repos_by_board(conn, [str(row["id"]) for row in rows])
        return [_to_board(row, repos.get(str(row["id"]), [])) for row in rows]
    finally:
        conn.close()


def get_board(id_or_dir: str, db_path: str | None = None) -> Board | None:
    """Look a board up by id, falling back to ``board_dir``.

    Mirrors ``getBoard()`` in boards/registry.mjs.

    Args:
        id_or_dir: Board id, or the path of its ``.beads`` directory.
        db_path: Registry location. Defaults to :func:`registry_path`.

    Returns:
        The board, or None if nothing matched.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    conn = _connect(db_path)
    try:
        rows = _query(conn, f"{_BOARD_SELECT} WHERE id = ?", (id_or_dir,))
        if not rows:
            rows = _query(conn, f"{_BOARD_SELECT} WHERE board_dir = ?", (os.path.abspath(id_or_dir),))
        if not rows:
            return None

        row = rows[0]
        repos = _repos_by_board(conn, [str(row["id"])])
        return _to_board(row, repos.get(str(row["id"]), []))
    finally:
        conn.close()


def _short_name(repo: str) -> str:
    """Bare repo name from an ``owner/name`` entry (or the entry itself)."""
    return repo.rsplit("/", 1)[-1]


def _normalize_separators(value: str) -> str:
    """Lowercase and collapse non-alphanumeric runs to single spaces.

    Makes "sample-controller", "sample_controller" and "sample controller" compare
    equal. Mirrors ``normalizeSeparators()`` in boards/registry.mjs.
    """
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def route_task(
    text: str = "",
    repo: str = "",
    db_path: str | None = None,
    repos: list[str] | None = None,
) -> list[RouteCandidate]:
    """Score boards against a task so an agent can decide where an item belongs.

    Mirrors ``routeTask()`` in boards/registry.mjs, weights included — see the
    module docstring for why that matters.

    **A board is not tied to a repo.** It may list zero, one or many, and repos are
    an optional hint rather than part of a board's identity. Two consequences that
    are easy to get wrong: no score component may scale with the size of a board's
    repo list (crediting each matching repo separately made a 3-repo board outscore
    a well-described repo-less board 75 to 10), and description must be able to win
    alone, because for a repo-less board it is the only signal.

    Args:
        text: Free-text task description.
        repo: A repo the task touches, as ``owner/name`` or a bare name.
        db_path: Registry location. Defaults to :func:`registry_path`.
        repos: Additional repos the task touches; a task may span several.

    Returns:
        Candidates scoring above zero, highest first, ties broken by board id.

    Raises:
        RegistryUnavailableError: If the registry is missing or unreadable.
    """
    lowered = text.lower()
    query_repos = [
        cleaned
        for cleaned in ((r or "").strip().lower() for r in ([repo] if repo else []) + (repos or []))
        if cleaned
    ]
    # dict.fromkeys dedupes while keeping first-seen order, matching the JS Set.
    tokens = list(dict.fromkeys(t for t in _TOKEN_SPLIT.split(lowered) if len(t) >= MIN_TOKEN_LENGTH))
    text_words = f" {_normalize_separators(text)} "

    candidates: list[RouteCandidate] = []
    for board in list_boards(db_path):
        score = 0
        reasons: list[str] = []
        board_repos = [entry.lower() for entry in board["repos"]]
        credited: set[str] = set()

        # Best single match across the query's repos, never a sum: a task touching
        # three repos of one board is not three times the evidence, and summing
        # would reintroduce repo-count scaling through the query side.
        repo_score = 0
        repo_reason = ""
        for wanted in query_repos:
            if wanted in board_repos:
                if repo_score < SCORE_REPO_EXACT:
                    repo_score = SCORE_REPO_EXACT
                    repo_reason = f"exact repo match: {wanted}"
                credited.add(wanted)
                continue
            # Accept a bare repo name against an owner/name entry, since agents
            # and humans both say "sample-controller" far more often than the
            # full path.
            short = _short_name(wanted)
            partial = next((r for r in board_repos if r == short or _short_name(r) == short), None)
            if partial is not None:
                credited.add(partial)
                if repo_score < SCORE_REPO_SHORT_NAME:
                    repo_score = SCORE_REPO_SHORT_NAME
                    repo_reason = f"repo name match: {short} ~ {partial}"
        if repo_score > 0:
            score += repo_score
            reasons.append(repo_reason)

        # A repo named in the free text counts too, but once for the board rather
        # than per repo. Separators are normalized on both sides because repos are
        # hyphenated while people describing a task are not, and the match is on
        # whole words — a board owning a short repo like `.../api` would otherwise
        # score on "therapist" or "rapid".
        mentioned: list[str] = []
        for entry in board["repos"]:
            if entry.lower() in credited:
                continue  # already scored above
            short = _normalize_separators(_short_name(entry))
            if len(short) >= MIN_REPO_MENTION_LENGTH and f" {short} " in text_words:
                mentioned.append(entry)
        if mentioned:
            score += SCORE_REPO_IN_TEXT
            reasons.append(f"text mentions repo: {', '.join(mentioned)}")

        # The only signal a repo-less board has, so it must be able to win alone.
        haystack = f"{board['name']} {board['description']}".lower()
        hits = [token for token in tokens if token in haystack]
        if hits:
            score += min(len(hits) * SCORE_TOKEN_HIT, MAX_DESCRIPTION_SCORE)
            reasons.append(f"description/name overlap: {', '.join(hits[:MAX_REPORTED_TOKEN_HITS])}")

        if score > 0:
            candidates.append(RouteCandidate(board=board, score=score, reasons=reasons))

    # Board ids are slugified to [a-z0-9-], so a plain string sort matches the
    # localeCompare tiebreak the Node side uses.
    candidates.sort(key=lambda candidate: (-candidate["score"], candidate["board"]["id"]))
    return candidates


# =============================================================================
# Tool payloads
# =============================================================================
# Shaped here rather than in server.py so the JSON an agent sees can be asserted
# on without standing up an MCP client.


def boards_list_payload(db_path: str | None = None) -> dict[str, Any]:
    """Build the ``boards_list`` tool result."""
    path = os.path.abspath(db_path) if db_path else registry_path()

    try:
        boards = list_boards(db_path)
    except RegistryUnavailableError as exc:
        return {
            "registry_path": path,
            "boards": [],
            "count": 0,
            "error": str(exc),
            "hint": exc.hint,
        }

    payload: dict[str, Any] = {"registry_path": path, "boards": boards, "count": len(boards)}
    if not boards:
        payload["hint"] = _SETUP_HINT
    return payload


def board_show_payload(board: str, db_path: str | None = None) -> dict[str, Any]:
    """Build the ``board_show`` tool result."""
    path = os.path.abspath(db_path) if db_path else registry_path()

    try:
        found = get_board(board, db_path)
        if found is not None:
            return {"registry_path": path, "board": found}
        known = [entry["id"] for entry in list_boards(db_path)]
    except RegistryUnavailableError as exc:
        return {"registry_path": path, "board": None, "error": str(exc), "hint": exc.hint}

    return {
        "registry_path": path,
        "board": None,
        "error": f"no such board: {board}",
        "known_boards": known,
        "hint": "Pass a board id from boards_list(), or the absolute path of its .beads directory.",
    }


def board_route_payload(
    text: str = "",
    repo: str = "",
    limit: int | None = None,
    db_path: str | None = None,
    repos: list[str] | None = None,
) -> dict[str, Any]:
    """Build the ``board_route`` tool result."""
    path = os.path.abspath(db_path) if db_path else registry_path()
    extra_repos = [r for r in (repos or []) if (r or "").strip()]
    query = {
        "text": text,
        "repo": repo or None,
        "repos": ([repo] if repo else []) + extra_repos,
    }

    if not text.strip() and not repo.strip() and not extra_repos:
        return {
            "registry_path": path,
            "query": query,
            "candidates": [],
            "count": 0,
            "error": "board_route needs text and/or repo",
            "hint": "Pass the task description as text, and repo='owner/name' when you know it.",
        }

    try:
        ranked = route_task(text=text, repo=repo, db_path=db_path, repos=extra_repos)
    except RegistryUnavailableError as exc:
        return {
            "registry_path": path,
            "query": query,
            "candidates": [],
            "count": 0,
            "error": str(exc),
            "hint": exc.hint,
        }

    if limit is not None and limit > 0:
        ranked = ranked[:limit]

    payload: dict[str, Any] = {
        "registry_path": path,
        "query": query,
        "candidates": [
            {
                "id": candidate["board"]["id"],
                "name": candidate["board"]["name"],
                "board_dir": candidate["board"]["board_dir"],
                "workspace_dir": candidate["board"]["workspace_dir"],
                "description": candidate["board"]["description"],
                "repos": candidate["board"]["repos"],
                "score": candidate["score"],
                "reasons": candidate["reasons"],
            }
            for candidate in ranked
        ],
    }
    payload["count"] = len(payload["candidates"])

    if not ranked:
        payload["hint"] = (
            "No board matched — routing has no signal for this task. Give the boards "
            "repos and descriptions with `feads-board repos <id> --repo owner/name` and "
            "`feads-board describe <id> --description '...'`, or pick one from boards_list()."
        )
    return payload
