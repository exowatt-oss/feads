# beads-mcp

MCP server for [beads](https://github.com/gastownhall/beads) issue tracker and agentic memory system.
Enables AI agents to manage tasks using bd CLI through Model Context Protocol.

> **Note:** For environments with shell access (Claude Code, Cursor, Windsurf), the **CLI + hooks approach is recommended** over MCP. It uses ~1-2k tokens vs 10-50k for MCP schemas, resulting in lower compute cost and latency. See the [main README](../../README.md) for CLI setup.
>
> **Use this MCP server** for MCP-only environments like Claude Desktop where CLI access is unavailable.

## Installing

Install from PyPI:

```bash
# Using uv (recommended)
uv tool install beads-mcp

# Or using pip
pip install beads-mcp
```

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "beads": {
      "command": "beads-mcp"
    }
  }
}
```

### Development Installation

For development, clone the repository:

```bash
git clone https://github.com/gastownhall/beads
cd beads/integrations/beads-mcp
uv sync
```

Then use in Claude Desktop config:

```json
{
  "mcpServers": {
    "beads": {
      "command": "uv",
      "args": [
        "--directory",
        "/path/to/beads-mcp",
        "run",
        "beads-mcp"
      ]
    }
  }
}
```

**Environment Variables** (all optional):
- `BEADS_PATH` - Path to bd executable (default: `~/.local/bin/bd`)
- `BEADS_DB` - Path to beads database file (default: auto-discover from cwd)
- `BEADS_WORKING_DIR` - Working directory for bd commands (default: `$PWD` or current directory). Used for multi-repo setups - see below
- `BEADS_ACTOR` - Actor name for audit trail (default: `$USER`)
- `BEADS_NO_AUTO_FLUSH` - Disable automatic sync (default: `false`)
- `BEADS_NO_AUTO_IMPORT` - Disable automatic import (default: `false`)
- `FEADS_SILO` - **feads addition.** Internal hosted-silo slug. When set, the MCP advertises
  `serverInfo.name` as `feads-<slug>` during `initialize`; the base instance omits it and
  advertises the stable name `feads`. The slug is revalidated at startup and must be a valid,
  non-reserved Feads silo slug. This changes no tool names or protocol behavior.
- `FEADS_PG_DSN` - **feads addition.** Read and write issue data in Postgres instead of
  spawning `bd` (default: unset, i.e. `bd`). The tool contract is identical either way;
  what changes is the store beneath it, and the board a call lands on is still resolved
  from the workspace exactly as below — the board id is the directory holding `.beads`.
  Needs the `pg` extra (`pip install 'beads-mcp[pg]'`). Unset it to roll back.

  Everything that touches an issue follows the setting, artifacts included (they are
  issue metadata, and a coordination tool split across two databases answers "free to
  work on" when it should answer "somebody else is here"). What does *not* move: board
  discovery and the agent registry, which live in SQLite. What **refuses** rather than
  moves: `admin`'s `validate` / `repair` / `schema` / `migration` / `pollution` — those
  inspect a `bd` database, and in pg mode the on-disk board is a frozen archive, so an
  answer from it would describe a snapshot as if it were live. Run those against a
  workspace with `FEADS_PG_DSN` unset if the archive is genuinely what you mean. See
  `src/beads_mcp/pgstore.py`.

## Multi-Repository Setup

**Recommended:** Use a single MCP server instance for all beads projects - it automatically routes to per-project Dolt servers.

### Single MCP Server (Recommended)

**Simple config - works for all projects:**
```json
{
  "mcpServers": {
    "beads": {
      "command": "beads-mcp"
    }
  }
}
```

**How it works (LSP model):**
1. MCP server detects the beads project in your current workspace
2. Routes requests to the **per-project Dolt server** based on working directory
3. Auto-starts the local Dolt server if not running
4. **Each project gets its own isolated Dolt server** serving only its database

**Architecture:**
```
MCP Server (one instance)
    ↓
Per-Project Dolt Servers (one per workspace)
    ↓
Dolt Databases (complete isolation)
```

**Why per-project Dolt servers?**
- Complete database isolation between projects
- No cross-project pollution or git worktree conflicts
- Simpler mental model: one project = one database = one Dolt server
- Follows LSP (Language Server Protocol) architecture
- One MCP config works for unlimited projects

### Alternative: Per-Project MCP Instances (Not Recommended)

Configure separate MCP servers for specific projects using `BEADS_WORKING_DIR`:

```json
{
  "mcpServers": {
    "beads-webapp": {
      "command": "beads-mcp",
      "env": {
        "BEADS_WORKING_DIR": "/Users/yourname/projects/webapp"
      }
    },
    "beads-api": {
      "command": "beads-mcp",
      "env": {
        "BEADS_WORKING_DIR": "/Users/yourname/projects/api"
      }
    }
  }
}
```

⚠️ **Problem**: AI may select the wrong MCP server for your workspace, causing commands to operate on the wrong database. Use single MCP server instead.

## Multi-Project Support

The MCP server supports managing multiple beads projects in a single session using per-request workspace routing.

### Using `workspace_root` Parameter

Every tool accepts an optional `workspace_root` parameter for explicit project targeting:

```python
# Query issues from different projects concurrently
results = await asyncio.gather(
    beads_ready_work(workspace_root="/Users/you/project-a"),
    beads_ready_work(workspace_root="/Users/you/project-b"),
)

# Create issue in specific project
await beads_create_issue(
    title="Fix auth bug",
    priority=1,
    workspace_root="/Users/you/project-a"
)
```

### Architecture

**Connection Pool**: The MCP server maintains a connection pool keyed by canonical workspace path:
- Each workspace gets its own Dolt server connection
- Paths are canonicalized (symlinks resolved, git toplevel detected)
- Concurrent requests use `asyncio.Lock` to prevent race conditions
- No LRU eviction (keeps all connections open for session)

**ContextVar Routing**: Per-request workspace context is managed via Python's `ContextVar`:
- Each tool call sets the workspace for its duration
- Properly isolated for concurrent calls (no cross-contamination)
- Falls back to `BEADS_WORKING_DIR` if `workspace_root` not provided

**Path Canonicalization**:
- Symlinks are resolved to physical paths (prevents duplicate connections)
- Git submodules with `.beads` directories use local context
- Git toplevel is used for non-initialized directories
- Results are cached for performance

### Backward Compatibility

The `set_context()` tool still works and sets a default workspace:

```python
# Old way (still supported)
await set_context(workspace_root="/Users/you/project-a")
await beads_ready_work()  # Uses project-a

# New way (more flexible)
await beads_ready_work(workspace_root="/Users/you/project-a")
```

### Concurrency Gotchas

⚠️ **IMPORTANT**: Tool implementations must NOT spawn background tasks using `asyncio.create_task()`.

**Why?** ContextVar doesn't propagate to spawned tasks, which can cause cross-project data leakage.

**Solution**: Keep all tool logic synchronous or use sequential `await` calls.

### Troubleshooting

**Symlink aliasing**: Different paths to same project are deduplicated automatically via `realpath`.

**Submodule handling**: Submodules with their own `.beads` directory are treated as separate projects.

**Stale connections**: Currently no health checks. Phase 2 will add retry-on-failure if monitoring shows need.

**Version mismatches**: Dolt server version is auto-checked. Mismatched servers are automatically restarted.

## Features

**Resource:**
- `beads://quickstart` - Quickstart guide for using beads

**Tools (all support `workspace_root` parameter):**
- `init` - Initialize bd in current directory
- `create` - Create new issue (bug, feature, task, epic, chore, decision)
- `list` - List issues with filters (status, priority, type, assignee)
- `ready` - Find tasks with no blockers ready to work on
- `show` - Show detailed issue info including dependencies
- `update` - Update issue (status, priority, design, notes, etc). Note: `status="closed"` or `status="open"` automatically route to `close` or `reopen` tools to respect approval workflows
- `close` - Close completed issue; pass `force=true` only when an authorized caller must close an issue assigned to another actor (the default assignee guard remains in place)
- `dep` - Add dependency (blocks, related, parent-child, discovered-from)
- `comment` - Add a durable, timestamped comment to an issue (a record of work/decisions)
- `comments` - List all comments on an issue (`show` reports comment_count but not the bodies)
- `note` - Append a note to an issue's notes field
- `blocked` - Get blocked issues
- `stats` - Get project statistics
- `reopen` - Reopen a closed issue with optional reason
- `set_context` - Set default workspace for subsequent calls (backward compatibility)

**Board registry tools (feads; read-only, no `workspace_root`):**

Every tool above operates on the single board auto-detected from the working directory. These
read the cross-board registry (`~/.feads/registry.db`, or `$FEADS_REGISTRY_DB`) so an agent can
see the other boards and route an item to the right one. Writes belong to `feads-board`
(`scripts/feads-board.mjs`); this server only reads, and scoring mirrors `boards/registry.mjs`.

- `boards_list` - List every registered board with its description and repos
- `board_show` - Show one board by id or by its `.beads` directory
- `board_route` - Rank boards against a task (`text`, `repo`, `limit`) with a score and reasons

**Agent registry tools (feads; no `workspace_root`):**

- `agents_list` - Agents registered on a board, narrowed to what you may see (an admin sees every
  agent, a user sees only itself). Read-only
- `agent_whoami` - Which agent this session is acting as, how that was established, and what it may
  do. Read-only
- `agent_signup` - Get an identity of your own; returns an agent token **once**. The only tool here
  that causes a registry write, and it causes it by proxy

`agent_signup` proxies the dashboard's `POST /api/agent/signup` (so the dashboard has to be
running) and never writes the registry itself. That is not squeamishness: registration's
single-use guarantee is `BEGIN IMMEDIATE` + a conditional `UPDATE … WHERE redeemed_at = 0` + a
partial unique index on the live actor name — an invariant enforced by SQL and transaction
semantics rather than by a pure function. The policy tolerates two implementations only because
`boards/authz-cases.json` is a shared fixture that catches a divergence; nothing could play that
role for "two writers race on one invite", so a Python port would be an *unfixtured* second copy
of a security invariant. See `beads_mcp/signup.py` for the full argument and what depending on
the dashboard costs.

The request declares `surface: "mcp"`, which the endpoint maps to the roster's provenance columns
(`kind: 'agent'`, `created_by: 'mcp-signup'`) rather than accepting either from the caller —
free-text provenance is spoofable, and a caller that could send `created_by` could attribute an
identity to an actor that never created it. It also sends `board_dir`, the `.beads` directory of the
board this process is working on, so the new agent appears in the roster its owner is watching
instead of on the daemon's seed board; that directory is omitted when it cannot be resolved, because
an unregistered one is a hard `409` while an omission just falls back. Neither field is depended on:
an endpoint that predates them ignores it, records a `human`-kind row on its own board, and that is
a successful sign-up.

It can only ever mint the `user` tier, and there is deliberately no `role` parameter — the policy
refuses an admin invite to a caller that is not already an admin, so the parameter could only ever
be refused, and a parameter an agent cannot use is a lie in the tool schema. Minting *invites* is
still not exposed here at all: that stays in `feads-agent` (`scripts/feads-agent.mjs`), including
the bootstrap case that makes an MCP-side admin mint unauthenticatable in principle.

### Agent tiers

An agent registers once against a board and gets a durable token; `FEADS_AGENT_TOKEN` (or, failing
that, `CLAUDE_CODE_SESSION_ID`) is how this server recognizes it. There are exactly two tiers:

| | `user` | `admin` |
| --- | --- | --- |
| Read anything, create and update anything | yes | yes |
| Delete an item it created | yes | yes |
| Delete anyone else's item | no | yes |
| See the agent roster | own row only | all rows |

### Where the token comes from, and what an anonymous caller may do

Two routes, and the token is shown exactly once either way — only a hash is stored, and no
credential file is written (only `feads-agent` writes one of those):

- **The agent asks for it.** `agent_signup(display_name='<a short name for you>')`, which proxies
  the dashboard's sign-up route. Open to anyone, no admin needed, `user` tier only.
- **A human hands it over.** They open the dashboard (default `http://127.0.0.1:4141`; set
  `FEADS_DASHBOARD_URL` if yours differs), sign in or sign up, and paste the token to their agent.
  This is the fallback when `agent_signup` answers `dashboard_unreachable` — a dashboard that is
  not running is the one part of this an agent cannot fix.

How the agent then presents it depends on the transport, and so does what it may do without one:

| | **stdio** | **HTTP** |
| --- | --- | --- |
| Token arrives via | `FEADS_AGENT_TOKEN` in the server's environment | `Authorization: Bearer fdsa_…` on each request |
| Adoptable mid-session | no — read once at startup, so a restart is required | yes — read per request |
| Stance with no token | `operator` (unrestricted) | `read_only` (reads, plus sign-up) |

The stdio row is why `agent_signup` says so loudly that the token it just returned cannot be used
by the session that asked for it: the server read its token slot at startup, so the credential
takes effect only after a human puts it in the `env` block and restarts. An agent that assumes
otherwise signs up again and collides with the name it just took. Nothing adopts the token
in-process to close that gap, deliberately — writing a live credential into `os.environ` would put
it where every `bd` subprocess inherits it and where `admin(action="debug")` prints environment
variables, in exchange for an identity that silently depends on tool-call order.

**The stance differs because the trust does.** `operator` is justified by "a local caller already
owns the database file" — true of a stdio subprocess on your own machine, and false of whoever
reached a port. Holding `operator` over HTTP would let an unauthenticated request delete any item
on any board and mint itself an admin invite. `read_only` is the only honest reading of that pipe,
and it is also why stdio keeps `operator`: unlike a browser, stdio cannot *offer* the read-only
bargain, because a refused caller has no way to present a credential without a restart.

`FEADS_REQUIRE_AGENT=1` upgrades either transport to `deny`; it can only tighten. A refusal for
having presented nothing reports `mode: "anonymous"` — never `operator`, which the caller was
never granted. The four modes are `agent`, `operator`, `anonymous` and `rejected`.

Minting invites is open to any tier in the shared policy (only an *admin* invite needs an admin),
and `read_only` allows it for an anonymous caller too, because requiring an identity in order to
obtain one is a closed loop. That is the permission `agent_signup` asks for — `mint_invite` with
`role: 'user'` — and it asks **before** it opens a socket, so a deployment that has turned
sign-up off never sees an attempt and its refusal is correct with the dashboard stopped. `deny`
refuses sign-up along with everything else, which is why the hint an agent reads under that stance
goes back to naming its human rather than pointing at a tool certain to refuse it.

Presenting a credential that does not verify is **not** the same thing: it is refused outright,
whatever `FEADS_REQUIRE_AGENT` says. Otherwise revoking an agent would *promote* it — a revoked
`user` resolves to no agent, and no agent means operator, which may delete anything. Resolution
order is pinned by `resolution_cases` in `boards/authz-cases.json`:

| `FEADS_AGENT_TOKEN` | `CLAUDE_CODE_SESSION_ID` | result |
| --- | --- | --- |
| verifies | anything | that agent |
| does not verify | anything, including a session that would have matched | **refused** |
| absent | matches a live agent | that agent |
| absent | matches a **revoked** agent | **refused** |
| absent | matches nothing | operator |
| absent | absent | operator |

A token that fails is not rescued by a session id — an explicit credential that fails must not fall
back to a weaker one that happens to succeed. An unmatched session id is *not* a rejection, because
every Claude Code session exports one whether or not an agent was ever registered.

The policy lives in `beads_mcp/authz.py`, a port of `boards/authz.mjs`. Neither implementation owns
the behaviour — `boards/authz-cases.json` is the contract, asserted by `tests/test_authz_parity.py`
here and by `boards/authz.test.mjs` on the Node side. Change the fixture first.

Gated on `delete`: `admin(action="pollution", clean=True)` and `admin(action="validate",
fix_all=True)`, both of which delete issues. Gated on `write`: the mutating tools — `create`,
`claim`, `update`, `close`, `reopen`, `dep`, `comment`, `note`. Every *tier* may write, so for a
registered agent the write gate never fires; what it binds is an anonymous caller on a surface
whose stance is not `operator`, which is HTTP and any `FEADS_REQUIRE_AGENT` deployment. Without it
`read_only` would be a label rather than a control — refusing deletes while letting an anonymous
caller create and close anything, with `agent_whoami` reporting `"write": false` the whole time.

**This is an integrity control, not a sandbox.** It binds callers arriving through this server. It
does not bind the shell next to it, where `bd delete` is a local Go binary on a local Dolt database
with no auth layer to hook. It stops an agent destroying work by misreading its remit; it does not
contain a hostile local process.

## Transport

stdio by default — that is how Claude Code launches the server, and running with no arguments
is unchanged. HTTP is opt-in, for hosting the server alongside the backend stack:

```bash
beads-mcp                                  # stdio (default)
beads-mcp --http                           # streamable HTTP on 127.0.0.1:4143/mcp
beads-mcp --http --host 0.0.0.0 --port 9000 --path /mcp
FEADS_MCP_HTTP=1 beads-mcp                 # same, for launchers that pass no arguments
```

| Env var | Flag | Default |
| --- | --- | --- |
| `FEADS_MCP_HTTP` | `--http` | off (stdio) |
| `FEADS_MCP_HOST` | `--host` | `127.0.0.1` |
| `FEADS_MCP_PORT` | `--port` | `4143` |
| `FEADS_MCP_PATH` | `--path` | `/mcp` |

## Known Issues

### ~~MCP Tools Not Loading in Claude Code~~ (Issue [#346](https://github.com/gastownhall/beads/issues/346)) - RESOLVED

**Status:** ✅ Fixed in v0.24.0+

This issue affected versions prior to v0.24.0. The problem was caused by self-referential Pydantic models (`Issue` with `dependencies: list["Issue"]`) generating invalid MCP schemas with `$ref` at root level.

**Solution:** The issue was fixed in commit f3a678f by refactoring the data models:
- Created `IssueBase` with common fields
- Created `LinkedIssue(IssueBase)` for dependency references
- Changed `Issue` to use `list[LinkedIssue]` instead of `list["Issue"]`

This breaks the circular reference and ensures all tool outputSchemas have `type: object` at root level.

**Upgrade:** If you're running beads-mcp < 0.24.0:
```bash
pip install --upgrade beads-mcp
```

All MCP tools now load correctly in Claude Code with v0.24.0+.


## Development

Baseline validation:
```bash
uv sync
uv run pytest
uv run python -m build
```

Integration tests require a current `bd` binary from this repository. In
particular, `bd init --help` must include `--non-interactive`, `--skip-agents`,
and `--skip-hooks`; older installed versions are skipped with a clear pytest
message.

Run MCP inspector:
```bash
# inside beads-mcp dir
uv run fastmcp dev src/beads_mcp/server.py
```

Type checking (source maintenance, not part of baseline validation yet):
```bash
uv run mypy src/beads_mcp
```

Linting and formatting (source maintenance, not part of baseline validation yet):
```bash
uv run ruff check src/beads_mcp
uv run ruff format src/beads_mcp
```

## Testing

Run all tests:
```bash
uv run pytest
```

With coverage:
```bash
uv run pytest --cov=beads_mcp tests/
```

Test suite includes both mocked unit tests and integration tests with real `bd` CLI.

### Multi-Repo Integration Test

Test Dolt server with multiple repositories:
```bash
# Start the Dolt server first
cd /path/to/beads
bd dolt start

# Run multi-repo test
cd integrations/beads-mcp
uv run python test_multi_repo.py
```

This test verifies that the Dolt server can handle operations across multiple repositories simultaneously using per-request context routing.
