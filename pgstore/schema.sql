-- feads pgstore: one database, all boards (board_id column).
-- Issue ids are globally unique (per-board prefix), so cross-table refs skip board_id.
-- Timestamps are timestamptz; imported values are kept verbatim from bd export.

CREATE TABLE IF NOT EXISTS boards (
  id         text PRIMARY KEY,          -- registry board id ('example', 'lab', ...)
  prefix     text NOT NULL UNIQUE,      -- issue id prefix ('ex', 'lab', ...)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issues (
  id                  text PRIMARY KEY,
  board_id            text NOT NULL REFERENCES boards(id),
  title               text NOT NULL,
  description         text,
  design              text,
  acceptance_criteria text,
  notes               text,
  close_reason        text,
  status              text NOT NULL DEFAULT 'open',   -- open|in_progress|closed|deferred
  issue_type          text NOT NULL DEFAULT 'task',   -- bug|feature|task|epic|chore|decision
  priority            integer NOT NULL DEFAULT 2,
  assignee            text,
  owner               text,
  created_by          text,
  external_ref        text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- carries artifact:* keys etc.
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  closed_at           timestamptz,
  started_at          timestamptz,
  deleted_at          timestamptz,                    -- tombstone
  lease_expires_at    timestamptz,                    -- claim lease
  heartbeat_at        timestamptz,                    -- claim holder heartbeat
  claim_label         text                            -- holding session (accounts mode)
);
-- Existing databases: pgstore/migrations/0001-claim-label.sql
ALTER TABLE issues ADD COLUMN IF NOT EXISTS claim_label text;
CREATE INDEX IF NOT EXISTS issues_board_status_idx ON issues (board_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS issues_updated_idx ON issues (board_id, updated_at DESC);

-- depends_on_id is deliberately not a foreign key: bd data in the wild contains
-- dangling targets (deleted blockers), and bd treats them as non-blocking.
CREATE TABLE IF NOT EXISTS deps (
  issue_id      text NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  depends_on_id text NOT NULL,
  dep_type      text NOT NULL DEFAULT 'blocks',
  created_at    timestamptz,
  created_by    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (issue_id, depends_on_id, dep_type)
);
CREATE INDEX IF NOT EXISTS deps_target_idx ON deps (depends_on_id, dep_type);

CREATE TABLE IF NOT EXISTS comments (
  id         text PRIMARY KEY,
  issue_id   text NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author     text,
  body       text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_issue_idx ON comments (issue_id, created_at);

CREATE TABLE IF NOT EXISTS labels (
  issue_id text NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label    text NOT NULL,
  PRIMARY KEY (issue_id, label)
);

-- Append-only audit + change-propagation stream. Every write from any surface
-- (dashboard WS, MCP) inserts a row in the same transaction and fires
--   NOTIFY feads_events, '<board_id>:<issue_id>:<kind>'
-- Consumers (WS push, notifications minting) read the stream; seq is the cursor.
CREATE TABLE IF NOT EXISTS events (
  seq      bigserial PRIMARY KEY,
  board_id text NOT NULL,
  issue_id text,
  actor    text,
  kind     text NOT NULL,          -- created|updated|status|comment|dep_added|dep_removed|label|deleted|claimed
  payload  jsonb NOT NULL DEFAULT '{}'::jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_board_seq_idx ON events (board_id, seq);
CREATE INDEX IF NOT EXISTS events_at_seq_idx ON events (at, seq);

-- Read-path indexes from the 2026-10 perf pass. An existing database gets them
-- from pgstore/migrations/0002-perf-indexes.sql (CONCURRENTLY); see that file
-- for what each one serves.
CREATE INDEX IF NOT EXISTS events_issue_seq_idx
  ON events (board_id, issue_id, seq DESC) WHERE issue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS issues_board_closed_idx
  ON issues (board_id, closed_at DESC NULLS LAST, updated_at DESC)
  WHERE status = 'closed' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS issues_live_artifacts_idx
  ON issues (board_id)
  WHERE metadata ? 'has_artifacts' AND deleted_at IS NULL AND status <> 'closed';
