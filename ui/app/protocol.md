# beads-ui WebSocket Protocol (v2.0.0)

Note (2025-10-26)

- The server no longer implements legacy read RPCs `list-issues` and
  `epic-status`. Clients must use the push-only protocol described in
  `docs/protocol/issues-push-v2.md` (subscribe-list with per-subscription events
  snapshot/upsert/delete). The shapes below are retained for historical
  reference of v1.

This document defines the JSON messages exchanged between the browser client and
the local server.

- Transport: single WebSocket connection
- Encoding: JSON text frames
- Correlation: all request/response pairs share the same `id`

## Envelope Shapes

- RequestEnvelope: `{ id: string, type: string, payload?: any }`
- ReplyEnvelope:
  `{ id: string, ok: boolean, type: string, payload?: any, error?: { code: string, message: string, details?: any } }`

Server may send unsolicited events (e.g., subscription
`snapshot`/`upsert`/`delete`) using the ReplyEnvelope shape with `ok: true` and
a generated `id`.

## Message Types

- Removed in v2: `list-issues` (use subscriptions + push stores)
- `update-status` payload:
  `{ id: string, status: 'open'|'in_progress'|'closed' }`
- `edit-text` payload:
  `{ id: string, field: 'title'|'description'|'acceptance'|'notes'|'design', value: string }`
- `update-priority` payload: `{ id: string, priority: 0|1|2|3|4 }`
- `create-issue` payload:
  `{ title: string, type?: 'bug'|'feature'|'task'|'epic'|'chore', priority?: 0|1|2|3|4, description?: string }`
- `list-ready` payload: `{}`
- Removed in v2: `subscribe-updates` and the `issues-changed` event. All list
  and detail updates flow via per-subscription push envelopes
  (`snapshot`/`upsert`/`delete`).
- `dep-add` payload: `{ a: string, b: string, view_id?: string }` where `a`
  depends on `b` (i.e., `a` is blocked by `b`). Reply payload is the updated
  issue for `view_id` (or `a` when omitted).
- `dep-remove` payload: `{ a: string, b: string, view_id?: string }` removing
  the `a` depends on `b` link. Reply payload is the updated issue for `view_id`
  (or `a`).

## Agentwatch (feads)

Agentwatch is a read-only, live snapshot subscription for the executive view. It
uses the configured Postgres data layer across boards; it is not limited to the
connection's selected board and is not assembled by merging client-side list
subscriptions.

- `watch-agentwatch` has no contract-defined payload fields. The server fetches
  the initial snapshot before attaching the connection as a watcher, then
  replies with the ordinary correlated success envelope. The reply payload is
  the `AgentwatchSnapshot` described below. This request is read-gated and
  returns `pg_error` when the Postgres data layer is not configured or the
  snapshot query fails.
- `unwatch-agentwatch` has no contract-defined payload fields. It removes the
  connection from the watcher set and replies with `{ watching: false }`. It is
  idempotent, does not require read authorization, and is safe during connection
  cleanup.

A stop request and its reply are:

```json
{ "id": "req-10", "type": "unwatch-agentwatch" }
```

```json
{
  "id": "req-10",
  "ok": true,
  "type": "unwatch-agentwatch",
  "payload": { "watching": false }
}
```

For example:

```json
{ "id": "req-9", "type": "watch-agentwatch" }
```

The initial reply carries the snapshot in the normal response envelope:

```json
{ "id": "req-9", "ok": true, "type": "watch-agentwatch", "payload": {} }
```

While watching, the server sends unsolicited `agentwatch` events using the
ordinary event envelope. The event payload is the snapshot itself, not a list
subscription payload nested inside another object:

```json
{ "id": "evt-1785339132000", "ok": true, "type": "agentwatch", "payload": {} }
```

The snapshot shape is:

```json
{
  "generated_at": 1785339132000,
  "stats": {
    "active_agents": 2,
    "registered_agents": 4,
    "active_issues": 3,
    "shared_discussions": 1
  },
  "agents": [
    {
      "actor": "agent-a",
      "item_count": 2,
      "latest_activity": 1785339000000,
      "last_seen": 1785339120000,
      "flare": {
        "actor": "agent-a",
        "board_id": "example",
        "issue_id": "ex-abc",
        "heartbeat_at": 1785339120000,
        "liveness": "live"
      },
      "issues": [
        {
          "id": "ex-abc",
          "board_id": "example",
          "title": "…",
          "status": "in_progress",
          "priority": 1,
          "issue_type": "task",
          "updated_at": 1785339000000,
          "started_at": 1785338000000,
          "comment_count": 2
        }
      ]
    }
  ],
  "discussions": [
    {
      "id": "ex-def",
      "board_id": "other-board",
      "title": "…",
      "status": "open",
      "priority": 2,
      "issue_type": "task",
      "updated_at": 1785339000000,
      "comment_count": 4,
      "participants": [
        {
          "actor": "agent-a",
          "comment_count": 2,
          "last_commented_at": 1785338000000
        }
      ],
      "latest_comment": {
        "author": "agent-a",
        "body": "…",
        "created_at": 1785339000000
      }
    }
  ]
}
```

All public timestamps in the snapshot are epoch milliseconds; null or invalid
source timestamps are represented as `0`. Active work is strict: an issue is
included only when it is nondeleted (`deleted_at IS NULL`), its status is
exactly `in_progress`, and its assignee is nonblank after trimming. The trimmed
assignee is the `actor` used for server-side grouping. `active_issues` is the
sum of the groups' `item_count` values.

### Registered roster lanes

Every registered actor in the registry (nonrevoked, nonarchived, nonexpired)
always appears in `agents`, active or not, so the wall never hides a quiet
teammate. A lane that exists only because of registration has empty `issues`, no
flare, no runtime sessions, and its `last_seen` is the registry's
`last_seen_at`. Roster-backed lanes additionally carry `registered: true`,
`kind` (`"human"` or `"agent"`), and — when the registry has one —
`display_name`. `stats.registered_agents` counts distinct registered actors;
`stats.active_agents` still counts only lanes with live work, a live or fading
flare, or a nonterminal runtime row. The roster is advisory like flares: a
registry failure omits it without degrading the snapshot.

### Optional runtime sessions

An actor lane may carry an additive `runtime_sessions` field when the server has
short-lived phi runtime presence for that durable actor:

```json
{
  "session_id": "01a02071-b6dc-7f8e-bd10-5417e3c3a3fe",
  "runtime_id": "019d14e7-882a-7b0d-a8b5-a86b6c07ff7a",
  "last_seen": 1787250765000,
  "main": {
    "run_id": "019d14e7-882a-7b0d-a8b5-a86b6c07ff7a",
    "handle": "main",
    "display_name": "Assess Lab dashboard proposal",
    "status": "working",
    "model": "example/sol",
    "activity": "subagent",
    "context_percent": 37.2,
    "started_at": 1787250710000,
    "ended_at": 0,
    "heartbeat_at": 1787250765000,
    "liveness": "live",
    "client": "p3"
  },
  "subagents": []
}
```

`runtime_sessions` is an array of these session groups. Each group has the
opaque durable `session_id`, the process/session-start incarnation `runtime_id`,
the group's current `last_seen`, a `main` runtime row (or `null` during a
startup/arrival race), and a `subagents` array. Runtime rows carry the safe
status, model, activity category, context percentage, display fields,
timestamps, and liveness needed by Agentwatch, plus `client`: the launcher/ADE
that started the runtime, e.g. `p3`, `forca`; empty when the runtime was started
directly (optional on `PUT /api/runtime-presence`; always a string on the
snapshot). They are not issue rows.

The server owns all grouping and ordering. It groups rows under their durable
actor, groups each runtime incarnation separately, and attaches children by
lineage rather than by handle or display name. Two processes may therefore share
a durable `session_id` while remaining separate `runtime_id` groups. Actor lanes
are ordered by current `last_seen`, session groups by current `last_seen`, and
children by active rows first followed by terminal rows, with stable run-ID tie
breakers. A runtime heartbeat also advances its owning actor lane's `last_seen`.
A child that arrives before its main row is retained as a valid group with
`main: null`; it is not dropped or attached by guessing from names. Clients must
render the supplied hierarchy and order without regrouping it.

Active runtime rows are live for a heartbeat age under 45 seconds and fading
through 90 seconds; a crashed non-terminal row is then omitted and lazily
expired. `done`, `failed`, and `aborted` rows are terminal, are not refreshed,
and remain visible for five minutes before omission and lazy expiry. An orderly
disposal may remove active rows immediately, but the time limits remain the
crash-safe behavior.

`active_issues` remains issue-only. `active_agents` includes a lane with an
in-progress issue, a live or fading flare, or at least one non-terminal runtime
row. A runtime-only actor lane is valid, and a lane containing only retained
terminal history remains visible without increasing `active_agents`.

Runtime presence does not create a Feads actor, delegated identity, issue,
claim, or flare. Delegation remains the separate mechanism for a child that
needs its own durable identity or write authority; work flares remain
issue-scoped advisory presence. The projection excludes owner `agent_id`, host,
workspace, email, token, prompt, task text, raw tool detail, shell commands,
environment variables, absolute paths, PIDs, token/cost totals, and arbitrary
metadata.

Runtime presence is fail-open. If the runtime registry cannot be read, the
server uses an empty runtime-presence set and still returns the existing issue,
flare, discussion, and stats data. It never turns the existing Agentwatch
subscription into a new protocol error. When an actor has no runtime rows, the
server omits `runtime_sessions` rather than sending an empty array, so a
snapshot without presence has the legacy shape and clients can use the exact
pre-presence rendering path. The `watch-agentwatch`, `agentwatch`, and
`unwatch-agentwatch` message types, envelopes, payload rules, and lifecycle
remain unchanged; runtime presence is only an optional field in the existing
snapshot.

Advisory work flares are merged into the snapshot as agent heartbeats. An
agent's `last_seen` is the maximum of its `latest_activity` and the
`heartbeat_at` of its newest live or fading flare; `flare` carries that newest
flare, or `null` when the actor has none. An actor with a flare but no
in-progress issue still appears as an agent lane, with `item_count: 0`,
`latest_activity: 0`, and an empty `issues` array — presence is worth showing
before an issue row is written. Flare lanes do not loosen issue strictness:
`active_issues` still counts only grouped in-progress rows, while
`active_agents` counts every lane with an in-progress issue, a live or fading
flare, or a non-terminal runtime row. A lane containing only retained terminal
runtime history remains visible but does not inflate `active_agents`. Agents are
ordered by `last_seen` descending, with the actor as a stable tie breaker.

A shared discussion is a nondeleted issue whose status is not `closed` and whose
comments contain at least two distinct nonblank authors after trimming. Blank
comment authors do not become participants. The server groups participants and
keeps their comment counts and last-comment timestamps; `latest_comment`
contains only the latest comment's author, body, and creation timestamp.

The Postgres queries are bounded before grouping: at most 250 active issue rows
and 100 discussion rows are considered. The payload is a compact projection — it
carries the fields above rather than full issue prose — so the stats describe
the bounded snapshot returned on the wire. The server owns grouping, ordering,
and aggregate counts. **The frontend must render `agents` and `discussions` as
provided; it must not regroup them or derive a second grouping from `issues` or
`participants`.**

Postgres change notifications schedule one process-wide refresh for all current
watchers. Signals arriving within the 200 ms coalescing window produce one
shared recomputation and the latest `agentwatch` snapshot event per watcher,
rather than one event per mutation. In-process registry flare writes nudge the
same coalesced refresh, and while at least one watcher is attached the server
also recomputes on a fixed 20-second cadence — flare heartbeats written by other
processes produce no Postgres notification, and recency decays on its own even
when nothing is written. If a refresh fails, the server retains the last
successful snapshot and emits no error event. Disconnecting or unwatching
removes the connection from the live stream, and the cadence timer retires when
the last watcher leaves.

## Agent identity (feads)

- `whoami` payload: none. Reply payload:
  `{ identity: { agent_id, actor, display_name, role, board_id, last_seen_at } | null, mode: 'agent'|'operator'|'rejected', require_identity: boolean, credential_rejected: boolean }`.
  Never an error, including for a rejected credential — an error envelope is
  indistinguishable from a transport failure, and the client needs the mode in
  order to say what happened. Three modes, all meaningful:
  - `operator` — nothing was presented. The ordinary answer on a machine where
    no agent has registered; the caller may do anything unless
    `FEADS_REQUIRE_AGENT` is set.
  - `agent` — a credential verified; `identity` names the agent and its tier.
  - `rejected` — a credential _was_ presented and did not verify (unknown,
    malformed, or belonging to a revoked agent). Denied for every action,
    regardless of `FEADS_REQUIRE_AGENT`: the permissive default is for callers
    who never claimed an identity, not for one whose claim was refused. Without
    this distinction, revoking an agent would promote it to the operator.
- `list-agents` payload: `{ include_revoked?: boolean }` (the whole payload is
  optional). Reply payload:
  `{ agents: RosterRow[], scope: 'all'|'self'|'none', board_id: string, reason: string, mode, require_identity }`.
  `scope` is the server's decision — an `admin` and the operator get every agent
  on the active board, a `user` gets its own row — and no request field can
  widen it. A `RosterRow` never carries `token_hash`.

`delete-issue` is the only destructive message, and the only one the two-tier
model gates. `dep-remove` and `label-remove` mutate an item rather than destroy
one, so both tiers may call them.

## Epic story (feads)

Both are reads and sit behind the ordinary read gate. See
`server/story-snapshots.js` for the recorder that produces the history.

- `epic-graph` payload: `{ id: string }` — an epic id. Reply payload:
  `{ epic: { id, title, status }, t, nodes: [{ id, title, issue_type, assignee, status }], edges: [[blocker, blocked], …] }`.
  The graph comes from a **fresh capture** of the caller's board (one
  `bd export`), which also appends a history frame for every epic that changed —
  opening a story is itself a snapshot point. Membership is the `parent-child`
  closure below the epic; edges are scheduling dependencies (`blocks`,
  `conditional-blocks`, `waits-for`) between two members. An unknown epic is
  `not_found`.
- `epic-history` payload: `{ id: string }`. Reply payload:
  `{ epic_id, frames: [{ t, epic_status, statuses: { issue_id: status }, m }], metas: [{ epic: { title }, nodes, edges }] }`.
  Frames carry only statuses; `m` indexes into `metas`, which holds the
  structural half (node table and edges) and changes only when the structure
  did. A never-recorded epic replies `ok` with empty arrays rather than an error
  — no history is a legitimate state.

## Notifications and the user directory (feads)

One notification row is the same JSON everywhere it appears — this socket, the
HTTP API and the MCP tools all serve the shape below, so an agent that learned
it from one surface can read it on the others:

```json
{
  "id": "n_ab12…",
  "board_id": "example",
  "recipient_actor": "mira-example",
  "type": "mention",
  "issue_id": "ex-abc",
  "issue_title": "Fix the flux capacitor",
  "actor": "other-agent",
  "snippet": "first ~200 chars of the comment or change summary",
  "related_issue": "",
  "created_at": 1785270000000,
  "read_at": 0,
  "url": "#/issues?issue=ex-abc"
}
```

`type` is one of `mention`, `assigned`, `comment_on_owned`,
`update_on_commented`, `dependency_completed`. `actor` is whoever caused the
event and is `''` when that is unknowable; `related_issue` carries the closed
blocker for `dependency_completed` and is `''` otherwise. `created_at` and
`read_at` are epoch milliseconds, and `read_at: 0` means unread. `url` is a hash
path over this dashboard; the MCP tools prefix it with the dashboard origin,
which is the only difference between the surfaces.

- `list-notifications` payload: `{ unread_only?: boolean, limit?: number }`
  (defaults `true` and `50`, limit capped at 200). Reply payload:
  `{ notifications: Row[], unread_count: number, actor: string|null }`, newest
  first, across every board the recipient has rows on. A connection with no
  identity is answered `ok` with
  `{ notifications: [], unread_count: 0, actor: null }` rather than an error:
  not being signed in is a state the bell renders, not a failure it reports.
- `ack-notifications` payload: `{ ids?: string[], all?: boolean }`. Reply
  payload: `{ acked: number, unread_count: number }`. Requires an identity —
  without one the reply is an error with code `not_identified` — and only ever
  marks rows whose `recipient_actor` is the caller, so an id belonging to
  somebody else is silently not acked rather than refused.
- `list-users` payload: `{}`. Reply payload: `{ users: User[] }` where a `User`
  is
  `{ actor, display_name, role, kind, board_id, registered_at, last_seen_at }` —
  live agents on every board, and deliberately none of the `host`,
  `workspace_dir`, `session_id` or token fields the admin roster carries. This
  is the directory of handles that may be `@`-mentioned, so it is read-gated
  like any other read rather than restricted to admins.
- `notification` is a server-initiated event, sent to each connected socket
  whose identity actor is the recipient. Payload:
  `{ type: 'notification', notification: Row, unread_count: number }`. It
  carries the running unread count alongside the row because a client that
  incremented its own counter would drift from the server the first time two
  tabs, or a `notifications_ack` from the MCP side, acked the same row.

The two syntaxes that produce `mention` rows and in-app links are shared with
the CLI and the MCP server, so all three parsers must agree:

- Mention — `@` followed by an actor:
  `/(^|[^\w@])@([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)/gi`, capture group 2,
  compared case-insensitively against live registry actors. A handle never
  ends in `.`, `_` or `-`, so trailing punctuation (`cc @mira.`) is not part
  of the name.
- Ticket reference — `#` followed by an issue id:
  `/(^|[^\w#])#([a-z][a-z0-9]*-[a-zA-Z0-9._-]*[a-zA-Z0-9_])/g`, capture group 2.
  The deep link for an id `X` is the hash path `#/issues?issue=X`.

## Mapping to `bd` CLI

- Removed in v2: `list-issues` → use subscriptions and push
  (`docs/protocol/issues-push-v2.md`)
- `update-status` → `bd update <id> --status <status>`
- `edit-text` → `bd update <id> --title <t>` or `--description <d>` or
  `--acceptance-criteria <a>` or `--notes <n>` or `--design <z>`
- `update-priority` → `bd update <id> --priority <n>`
- `create-issue` → `bd create "title" -t <type> -p <prio> -d "desc"`
- `list-ready` → `bd ready --json`

## Errors

Errors follow the shape `{ code, message, details? }`. Common codes:

- `bad_request` – malformed payload or unknown type
- `not_found` – entity not found (e.g., issue id)
- `bd_error` – underlying `bd` command failed
- `forbidden` (feads) – the acting caller may not perform the operation.
  `details` carries `{ id, mode }`, and `mode` says which kind of refusal it
  was: `agent` (the tier forbids it), `operator` (`FEADS_REQUIRE_AGENT` is set
  and nothing was presented), or `rejected` (a credential was presented and did
  not verify). Payload validation runs first, so a malformed request is
  `bad_request` even when the caller would also have been refused.
