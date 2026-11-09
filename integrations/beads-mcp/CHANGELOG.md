# Changelog

All notable changes to beads-mcp will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`FEADS_PG_DSN`: issue data can now come from Postgres instead of a `bd` subprocess.**
  Set it and `create`, `update`, `close`, `reopen`, `claim`, `list`, `show`, `ready`,
  `blocked`, `dep`, `comment`, `comments`, `note` and `stats` run SQL; leave it unset and
  every one of them spawns `bd` exactly as before. Rollback is unsetting one variable,
  which is the point — the two paths are selected at
  `tools._get_client`, and nothing above it knows which one answered.

  **The tool contract is unchanged, and that is checked rather than asserted.** The new
  store (`beads_mcp/pgstore.py`) hands the tool layer the same dicts `bd --json` printed
  and lets the existing `_sanitize_issue_deps` + pydantic validation run on them, so bd's
  own quirks survive: `dependency_count` on a list row is the count of *all* dependency
  records (the sanitizer's rewrite, not bd's blocks-only number), `show` counts every
  edge type where `list` counts only blockers, and `reopen` of an already-open issue
  raises. `tests/test_pgstore_contract.py` diffs pg-mode reads field by field against
  golden `bd` output captured from all five live boards.

  Two differences are known and accepted, both orderings bd does not itself guarantee:
  `show`'s `dependencies` array is sorted here and storage-natural there, and
  `blocked_by` is sorted here and unsorted there.

  **Every write announces itself.** A write runs in one transaction that also appends an
  `events` row and fires `NOTIFY feads_events`, the stream the dashboard's live push and
  its notification engine consume — so an `@mention` in a comment written over MCP still
  reaches the mentioned agent's inbox, by the same route a dashboard comment does.

  **Artifacts follow the setting too**, because they are issue metadata and artifact
  responses are issue comments. This is the part that could not be left half-done: a ref
  is a join key, so an `artifact_add` landing in Postgres while an `artifact_search` read
  Dolt would not report "unknown", it would report *"free to work on"* — a coordination
  tool confidently telling two agents to edit the same file. `artifact_add`,
  `artifact_remove`, `artifact_list`, `artifact_search` (including the cross-board sweep)
  and `artifact_respond` (comment **and** the `waiting` dependency) all go through the
  store, with the same event row and notification as any other write. Reply shapes are
  unchanged.

  **`admin` refuses instead of answering from the archive.** `validate`, `repair`,
  `schema`, `migration` and `pollution` inspect and repair a `bd` database. In pg mode
  nothing writes the Dolt board any more, so those would have described a snapshot as if
  it were live — and `validate --fix` / `pollution --clean` would have repaired the
  snapshot while the real rows kept the defect. Both failures look like success, so they
  now raise, naming the workaround (run with `FEADS_PG_DSN` unset if you mean the
  archive). `admin(action='debug')` and `beads://quickstart` are unaffected: neither
  reads board data.

  **A board created after the cutover is usable immediately.** `board_create` and
  `context(action='init')` used to build the board on disk and register it in SQLite
  only, so the agent that had just made a board got "board is not in the feads Postgres
  store" from its own first `create`. Both now insert the `boards` row as well, with the
  prefix `bd init` actually used. `board_register` deliberately does not: it adopts a
  board whose issues are in Dolt and not here, and declaring it empty would replace a
  loud error with a quiet wrong answer.

  **`owner` is the acting agent, not the host's git config.** bd fills `owner` from
  `git config user.email`, which on a shared daemon is whoever's checkout the server
  runs in — that leak is how rows attributed to a human who had filed nothing appeared
  on a live board. In pg mode `owner` and `created_by` are both the verified caller.
  This is a deliberate improvement over bd's behaviour, not a parity gap.

  Requires the `pg` extra (`pip install 'beads-mcp[pg]'`); `asyncpg` is imported lazily,
  so a deployment that has not cut over carries nothing new.

- **`agent_signup`: an agent can now get an identity without a human**, taking the server
  from 23 tools to 24. Until now a caller with no credential could only be *told* where to
  get one; this mints it. Open to anyone, no admin needed, and it returns the agent token
  **exactly once** — only a hash is stored, and no credential file is written (only
  `feads-agent` writes one of those). There is deliberately no `role` parameter: the policy
  refuses an admin invite to a caller that is not already an admin, so the parameter could
  only ever be refused, and a parameter an agent cannot use is a lie in the tool schema.

  **It is a proxy, not a port.** The tool POSTs the dashboard's
  `/api/agent/signup` (`FEADS_DASHBOARD_URL`, default `http://127.0.0.1:4141`) and this
  server still never writes the registry. Registration's single-use guarantee is
  `BEGIN IMMEDIATE` + a conditional `UPDATE … WHERE redeemed_at = 0` + a partial unique
  index on the live actor name — enforced by SQL and transaction semantics rather than by a
  pure function. Two implementations of the *policy* are tolerable only because
  `boards/authz-cases.json` is a shared fixture that fails on a divergence; nothing could
  play that role for "two writers race on one invite", so a Python port would be an
  unfixtured second copy of a security invariant. See `beads_mcp/signup.py`.

  **The roster row says where the identity came from.** The request carries
  `surface: "mcp"`, which the endpoint *maps* to `kind: 'agent'` and
  `created_by: 'mcp-signup'` — it does not accept either of those from a caller, because
  free-text provenance is spoofable and could attribute an identity to an actor that
  never created it. It also carries `board_dir`, the `.beads` directory of the board this
  process is working on, so a new agent lands in the roster its owner is watching rather
  than on the daemon's seed board. That directory is resolved through the same
  `_find_beads_db_in_tree` every other tool uses, and is **omitted** when it cannot be
  determined — an unregistered directory is a hard `409`, so a guess costs the sign-up
  outright while an omission simply falls back. The resolved value is reported in the
  payload, so a `board_unregistered` refusal names the path it looked for. Neither field
  is depended on: an endpoint predating them ignores it and records a `human`-kind row on
  its own board, which is a successful sign-up and not an error.

  **Authorization is asked before the socket is touched.** Signing up is `mint_invite` with
  `role: 'user'`, which the shared policy already answers: allowed for an anonymous caller
  under `operator` and `read_only`, refused under `deny`. So a deployment with
  `FEADS_REQUIRE_AGENT=1` never sees a signup attempt in its dashboard's log, and its
  refusal is correct with the dashboard stopped. A rejected credential is refused too —
  otherwise revocation could be undone by the one tool that hands out identities. An
  already-identified caller is refused rather than served: a second identity is a
  *different* agent, and since `created_by` on everything it already filed names the first
  actor and a `user` may delete only its own items, minting one would silently cost the
  agent the right to delete its own work.

  **Failures are translated, not collapsed**, because the right next move differs per code:
  `bad_request`, `forbidden`, `board_unregistered`, `name_taken`, `no_registry`,
  `registry_failed`, `token_rejected` (the dashboard's own codes, relayed with its wording),
  plus `already_identified`, `unexpected_response`, and `dashboard_unreachable`. That last
  one is the reason for the taxonomy: a dashboard that is not running must not read as a
  policy refusal, since one is fixed by `make run` and the other is not fixed by anything
  the agent can do. Every failure carries a `hint` naming what to do next.

  Refusals arrive as data (`created: false`, `code`, `reason`, `hint`) rather than as a
  `ToolError`, unlike the write and delete gates. Those gate tools whose success has nothing
  to do with authorization; here "you may not", "that name is taken" and "the dashboard is
  down" are all expected answers to the question the tool asks.

  **On stdio the token cannot be used by the session that asked for it**, and the tool says
  so: the server read `FEADS_AGENT_TOKEN` once at startup, so a human has to set it and
  restart. Saying otherwise would loop an agent through sign up → still anonymous → sign up
  again → collide on the name it just took. Nothing adopts the token in-process to close
  that gap, deliberately: a live credential in `os.environ` is inherited by every `bd`
  subprocess and printed by `admin(action="debug")`, in exchange for an identity that
  depends on tool-call order.

  The server's `instructions` and `agent_whoami`'s hint have been rewritten accordingly —
  they used to tell an agent it could not fix a missing credential itself, which is now
  false. The human path stays as the documented fallback, and under the `deny` stance the
  hint goes *back* to naming the human, because `deny` refuses sign-up too and pointing an
  agent at a certain refusal reads as a fault rather than as policy.
- Two-tier agent registration (feads). New `agents_list` and `agent_whoami` tools, taking
  the server from 21 tools to 23. An agent registers once against a board with a
  single-use invite and holds a durable token; this server recognizes it from
  `FEADS_AGENT_TOKEN`, or failing that from `CLAUDE_CODE_SESSION_ID`. There are exactly
  two tiers — a `user` reads and writes anything but deletes only what it created, an
  `admin` deletes anything and sees the full roster. Presenting no identity is operator
  mode, which is allowed because a local caller already owns the registry file;
  `FEADS_REQUIRE_AGENT=1` refuses unidentified callers instead.

  What an unidentified caller gets is a **stance** rather than one global answer:
  `operator` (unrestricted), `read_only` (reads every board, changes nothing) or `deny`
  (refuses). `FEADS_REQUIRE_AGENT=1` upgrades any of them to `deny` and can only ever
  tighten. A refusal for having presented nothing reports `mode: "anonymous"` rather than
  `"operator"` — a refused caller was never granted operator standing. The modes are
  `agent`, `operator`, `anonymous` and `rejected`.

  **The stance depends on the transport: `operator` on stdio, `read_only` over HTTP.**
  The justification for `operator` is "a local caller already owns the database file",
  which is true of a stdio subprocess and false of whoever reached a port — so holding it
  for both would let an unauthenticated HTTP request delete any item on any board and
  mint itself an admin invite. stdio keeps `operator` for a reason that is not
  backwards-compatibility: unlike a browser, it cannot *offer* the read-only bargain,
  because the token is read from the environment once at startup, so refusing a stdio
  caller is a dead end rather than an invitation to authenticate.

- **Identity over the wire.** On the HTTP transport the credential rides on the request as
  `Authorization: Bearer fdsa_…`, read per call, and feeds the same resolution order as
  `FEADS_AGENT_TOKEN` — so a header token that does not verify is a *rejection* rather
  than an anonymous caller, without which revocation would invert over the wire exactly as
  it would locally. The request wins over the process environment when both are present:
  one HTTP server serves many agents, so a token in *its* environment names the host, not
  the caller. `agent_whoami` reports `credential_source`
  (`authorization_header|environment|session|none`), because "my token does not work" is
  the first question wire auth produces and the answer is usually that it went into the
  wrong one of two places.

- **The mutating tools are now gated on `write`** — `create`, `claim`, `update`, `close`,
  `reopen`, `dep`, `comment`, `note`. No change for any registered agent (every tier may
  write) or for stdio operators; what it binds is an anonymous caller over HTTP or under
  `FEADS_REQUIRE_AGENT`. Previously left ungated on the grounds that it would "only bite
  unidentified callers under FEADS_REQUIRE_AGENT" — reasoning that expired when HTTP took
  the `read_only` stance, since without the gate `read_only` refused deletes while letting
  an anonymous caller create and close anything.

- **The server's `instructions` now carry the permission model and how to get a
  credential**, so an agent with only this MCP configured can work the board and explain
  what it may not do without any pasted context. An agent never registers itself: a human
  signs in or signs up on the dashboard (`FEADS_DASHBOARD_URL`, default
  `http://127.0.0.1:4141`) and hands over the token. `agent_whoami` answers an anonymous
  caller with that instruction rather than an error, and words it per transport — send a
  header over HTTP, set the environment variable and restart on stdio.

  Sign-up is open in the shared policy: any tier, and an anonymous caller under
  `read_only`, may mint a `user` invite, because requiring an identity in order to obtain
  one is a closed loop. Only an *admin* invite needs an admin — a self-service admin tier
  would make "a user may only delete its own items" mean nothing. This server exposes no
  minting tool, so that reaches it only as policy: `agent_whoami` reports what the tools
  here will actually let you do.

  A credential that does not verify is refused outright rather than falling back to
  operator mode, regardless of `FEADS_REQUIRE_AGENT` or of the stance. Without that, revoking an agent
  would *promote* it: a revoked `user` resolves to no agent, and no agent means operator,
  which may delete anything. Three distinctions, all pinned by `resolution_cases` in
  `boards/authz-cases.json`: a `FEADS_AGENT_TOKEN` that does not verify is a rejection and
  is **not** rescued by a session id that would have matched; a `CLAUDE_CODE_SESSION_ID`
  matching a *revoked* agent is a rejection (the likelier door for a long-lived daemon,
  which has no token but always has a session id); a session id matching *nothing* is not
  a rejection, because every Claude Code session exports one whether or not an agent was
  ever registered.

  The policy is `beads_mcp/authz.py`, a port of `boards/authz.mjs`. Neither
  implementation owns the behaviour: `boards/authz-cases.json` is the contract and both
  test suites assert against it (`tests/test_authz_parity.py` here,
  `boards/authz.test.mjs` on the Node side), because a permission check that disagrees
  between two surfaces is a security bug rather than a routing quirk.

  Registry access stays read-only (`mode=ro`, no migration) exactly as for the board
  tools: registration is a write, and it stays in the `feads-agent` CLI so the registry
  keeps having exactly one writer — the property that makes concurrent access safe
  without a locking protocol.

  Two tool calls are now gated on the `delete` permission, so a `user` is refused and an
  admin or the operator is not: `admin(action="pollution", clean=True)` and
  `admin(action="validate", fix_all=True)`. Both delete issue rows, and neither can be
  checked per item — bd finds and deletes the rows inside one invocation — so they are
  checked once, as a bulk delete of items whose ownership cannot be established. The
  ordinary write path (`create`, `update`, `close`, …) is **not** gated.

  This is an integrity control, not a sandbox. It binds callers arriving through this
  server, not the shell next to it, where `bd delete` is a local Go binary on a local
  Dolt database with no auth layer to hook.
- Board-registry awareness (feads). New `boards_list`, `board_show` and `board_route`
  tools read the SQLite board registry (`~/.feads/registry.db`, or
  `$FEADS_REGISTRY_DB`), so an agent can see which boards exist, what each is for,
  and which one a task belongs to. Previously all tools operated on the single board
  auto-detected from the working directory with no way to enumerate or choose. Access
  is read-only (`mode=ro`) — the `feads-board` CLI owns every write — and `board_route`
  mirrors the scoring in `boards/registry.mjs` weight for weight so the CLI, the UI and
  the MCP rank candidates identically.
- Opt-in HTTP transport via `--http` / `FEADS_MCP_HTTP=1`, with `--host`/`--port`/`--path`
  (and `FEADS_MCP_HOST`/`FEADS_MCP_PORT`/`FEADS_MCP_PATH`). stdio remains the default and
  running with no arguments is unchanged.
- New `comment`, `comments`, and `note` MCP tools, wrapping the existing
  `bd comment` / `bd comments` / `bd note` CLI commands. Previously the MCP
  server exposed no way to add or read comments, so MCP-only agents could only
  overwrite the single `notes` field — `show()` reports `comment_count` but not
  the bodies. `comment` leaves a durable, timestamped work trail, `comments`
  reads them back, and `note` appends to the notes field.

### Fixed
- **Writes are attributed to the verified wire identity.** `created_by` recorded
  whatever `BEADS_ACTOR` this server's process inherited — on the HTTP daemon,
  whichever shell ran `feads-run.sh start` — so every authenticated agent's writes
  collapsed onto one leaked identity while `agent_whoami` reported the right one,
  and the delete-own policy compared against a string the writing agent never held.
  Attribution now rides the same per-call resolution as authorization
  (`agents.acting_actor()`): the verified identity's actor wins on every `bd`
  invocation, the process environment survives only as the unidentified-stdio
  fallback, and a rejected credential attributes to nobody. The launcher also stops
  passing `BEADS_ACTOR`/`FEADS_AGENT_TOKEN` into the daemon MCP's environment.

- `mcp__beads__show()` no longer crashes with `pydantic literal_error` when an
  issue has dependency types beyond the original four (`blocks`, `related`,
  `parent-child`, `discovered-from`). `DependencyType` is now `str`, matching
  the pattern already used for `IssueStatus` and `IssueType`. The bd CLI
  remains the source of truth for validation. (GH#3133)

## [0.41.0] - 2024-12-30

### Changed
- Minor maintenance release

## [0.24.0] - 2024-01-15

### Changed

#### Breaking: Context Engineering Optimizations

The `ready()` and `list()` MCP tools now return `list[IssueMinimal]` or `CompactedResult` instead of `list[Issue]`. This **breaking change** reduces context window usage by ~80%.

**What changed:**
- `ready()` returns `list[IssueMinimal] | CompactedResult` (was `list[Issue]`)
- `list()` returns `list[IssueMinimal] | CompactedResult` (was `list[Issue]`)
- `show()` still returns full `Issue` (unchanged)

**IssueMinimal includes:**
- `id`, `title`, `status`, `priority`, `issue_type`
- `assignee`, `labels`, `dependency_count`, `dependent_count`

**IssueMinimal excludes (use show() for these):**
- `description`, `design`, `acceptance_criteria`, `notes`
- `created_at`, `updated_at`, `closed_at`
- `dependencies`, `dependents` (full objects)

**CompactedResult (returned when >20 results):**
```python
{
    "compacted": True,
    "total_count": 47,
    "preview": [/* first 5 IssueMinimal */],
    "preview_count": 5,
    "hint": "Use show(issue_id) for full details"
}
```

**Migration guide:**

1. Check for compacted results:
   ```python
   if isinstance(response, dict) and response.get("compacted"):
       issues = response["preview"]
   else:
       issues = response
   ```

2. Use `show()` for full details:
   ```python
   for issue in issues:
       full_issue = show(issue_id=issue.id)
       print(full_issue.description)
   ```

3. Available options for list operations:
   - `brief=True` - Returns `BriefIssue` (id, title, status, priority only)
   - `fields=["id", "title"]` - Custom field projection
   - `max_description_length=100` - Truncate descriptions

**Rationale:**
- Reduces context usage from ~400 bytes/issue to ~80 bytes/issue
- Prevents context overflow for large issue lists (>20 items)
- Encourages efficient "list then show" pattern for AI agents

See [CONTEXT_ENGINEERING.md](./CONTEXT_ENGINEERING.md) for full migration guide.

### Added
- `discover_tools()` - Lightweight tool catalog for lazy schema loading
- `get_tool_info(tool_name)` - On-demand tool details
- `CompactedResult` model for large result sets
- `IssueMinimal` model for list views
- `BriefIssue` model for ultra-compact responses
- `brief`, `fields`, `max_description_length` parameters for all list operations
- Environment variables for compaction tuning:
  - `BEADS_MCP_COMPACTION_THRESHOLD` (default: 20)
  - `BEADS_MCP_PREVIEW_COUNT` (default: 5)

## [0.23.0] and earlier

See git history for changes prior to context engineering optimizations.
