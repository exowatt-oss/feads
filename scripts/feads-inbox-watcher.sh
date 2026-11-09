#!/usr/bin/env bash
# feads inbox watcher — the canonical mid-session watcher.
# Docs: https://github.com/exowatt-oss/feads#quickstart
#
# Polls the dashboard's HTTP inbox for UNHANDLED notifications — the agents'
# queue: rows a human may well have *seen* in the bell but no agent has
# answered yet (the seen/handled split, registry v4).
#
# Three modes:
#   (default)   exit-on-arrival: the moment at least one unhandled row exists,
#               print the rows and exit 0. For harnesses that re-invoke the
#               owning agent when a background task exits (Claude Code: run
#               this via a background Bash). The woken agent handles the batch
#               per the answering protocol, acks, and RESTARTS the watcher.
#   --follow    never exit: print rows as they arrive, newest-only. For plain
#               shells, tmux panes, or harnesses that tail output instead of
#               waking on exit.
#   --once      poll exactly once, print whatever is unhandled, exit 0. The
#               binary-free session-open inbox read for checkouts whose bd
#               predates the prime inbox (session-protocol.md, the bd floor).
#
# Config (env — the same pair that powers bd prime's session-start inbox):
#   FEADS_AGENT_TOKEN          required: the fdsa_… bearer minted at sign-up
#   FEADS_DASHBOARD_URL        default http://127.0.0.1:4141
#   FEADS_WATCHER_INTERVAL_S   poll interval, default 60
#   FEADS_WATCHER_MAX_POLLS    self-expiry, default 480 (~8 h at 60 s) — a
#                              watcher must never outlive its session quietly
#
# This script NEVER acks. Acking is the handler's claim that a row was dealt
# with; a watcher that acked would destroy the handoff it exists to protect.

set -u

MODE=exit-on-arrival
[ "${1:-}" = "--follow" ] && MODE=follow
[ "${1:-}" = "--once" ] && MODE=once

BASE="${FEADS_DASHBOARD_URL:-http://127.0.0.1:4141}"
TOKEN="${FEADS_AGENT_TOKEN:-}"
INTERVAL="${FEADS_WATCHER_INTERVAL_S:-60}"
MAX_POLLS="${FEADS_WATCHER_MAX_POLLS:-480}"

if [ -z "$TOKEN" ]; then
  echo "feads-inbox-watcher: FEADS_AGENT_TOKEN is not set — wire the env pair first:" >&2
  echo "  https://github.com/exowatt-oss/feads#quickstart" >&2
  exit 1
fi

[ "$MODE" = once ] && MAX_POLLS=1

seen_max=0
polls=0
while [ "$polls" -lt "$MAX_POLLS" ]; do
  polls=$((polls + 1))
  body=$(curl -sf -m 8 "$BASE/api/notifications?unread_only=1&limit=10" \
           -H "Authorization: Bearer $TOKEN") || { sleep "$INTERVAL"; continue; }
  count=$(printf '%s' "$body" | python3 -c \
    'import json,sys; print(json.load(sys.stdin).get("unhandled_count", 0))' \
    2>/dev/null || echo 0)
  if [ "$count" -gt 0 ] 2>/dev/null; then
    if [ "$MODE" = once ] || [ "$MODE" = exit-on-arrival ]; then
      echo "INBOX: $count unhandled notification(s):"
      printf '%s' "$body" | python3 -c '
import json, sys
for r in json.load(sys.stdin).get("notifications", []):
    kind = r.get("type")
    issue = r.get("issue_id")
    actor = r.get("actor") or "?"
    snippet = str(r.get("snippet") or "")[:140]
    print(f"- [{kind}] {issue} from {actor}: {snippet}")
'
      exit 0
    fi
    if [ "$MODE" = follow ]; then
      # Print only rows newer than what this watcher already reported; the
      # MAX line carries the cursor between polls and never reaches stdout.
      out=$(printf '%s' "$body" | python3 -c '
import json, sys
since = int(sys.argv[1])
rows = [r for r in json.load(sys.stdin).get("notifications", [])
        if int(r.get("created_at", 0)) > since]
for r in rows:
    kind = r.get("type")
    issue = r.get("issue_id")
    actor = r.get("actor") or "?"
    snippet = str(r.get("snippet") or "")[:140]
    print(f"INBOX [{kind}] {issue} from {actor}: {snippet}")
print("MAX", max([int(r.get("created_at", 0)) for r in rows] + [since]))
' "$seen_max")
      seen_max=$(printf '%s\n' "$out" | awk '/^MAX /{print $2}')
      printf '%s\n' "$out" | grep -v '^MAX ' || true
    fi
  fi
  [ "$MODE" = once ] && exit 0
  sleep "$INTERVAL"
done

echo "feads-inbox-watcher: expired after $MAX_POLLS polls with a quiet inbox — restart if the session is still live"
exit 0
