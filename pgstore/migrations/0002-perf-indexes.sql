-- feads pgstore migration 0002: read-path indexes (2026-10, perf pass).
--
-- Additive and idempotent. Each index is also declared in schema.sql, so a fresh
-- database gets them from the schema; this file is for an existing database.
--
-- Apply to a live database with CONCURRENTLY (no write lock), one statement at a
-- time — CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so feed
-- this file to psql without -1 / --single-transaction:
--
--   psql "$FEADS_PG_DSN" -v ON_ERROR_STOP=1 -f pgstore/migrations/0002-perf-indexes.sql
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS <name>; for each name below.
-- Nothing reads these indexes by name; dropping one only costs the speed.

-- Latest event per issue, newest first. Serves the MCP change feed's
-- DISTINCT ON (board_id, issue_id) ... ORDER BY seq DESC (an index scan instead
-- of a sort over every event) and the notification engine's "who touched this
-- issue last" probe.
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_issue_seq_idx
  ON events (board_id, issue_id, seq DESC) WHERE issue_id IS NOT NULL;

-- The Board tab's Done column: newest closures per board, with or without a
-- since-window, without sorting the board's whole closed history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_board_closed_idx
  ON issues (board_id, closed_at DESC NULLS LAST, updated_at DESC)
  WHERE status = 'closed' AND deleted_at IS NULL;

-- Live work holding artifacts (the has_artifacts marker set by artifact_add):
-- the overlap universe the notification engine checks a new claim against.
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_live_artifacts_idx
  ON issues (board_id)
  WHERE metadata ? 'has_artifacts' AND deleted_at IS NULL AND status <> 'closed';
