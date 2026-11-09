#!/usr/bin/env bash
# feads-run.sh — bring up both halves of feads together:
#
#   1. the bd backend — Go binary + embedded Dolt, built to ./bd
#   2. the web UI     — vendored beads-ui (ui/), served on 127.0.0.1:4141
#
# The UI has no database access of its own: it shells out to `bd` for every read
# and write, and streams results to the browser over a WebSocket. So the two
# halves have to agree on *which bd binary* and *which board*. Left to their own
# devices they don't — the UI resolves `bd` from PATH (finding a Homebrew build,
# not this repo's) and bd resolves the board from cwd (stopping at the nearest
# git boundary, which since feads is itself a git repo is feads, not the board
# you meant).
#
# BD_BIN is therefore pinned for the life of the daemon. BEADS_DIR is different:
# it only *seeds* the board the UI starts on. Once running, the UI stamps the
# selected board onto every `bd` child itself (ui/server/active-board.js), which
# is what makes switching boards change the issues you see rather than just the
# label — bd reads BEADS_DIR ahead of cwd, so a single exported value would
# otherwise outrank every later selection.
#
# Usage:
#   scripts/feads-run.sh [start|stop|restart|status|verify] [--open] [--board <id>]
#
# Env:
#   FEADS_PORT         UI port                (default 4141)
#   FEADS_HOST         UI bind address        (default 127.0.0.1)
#   BEADS_DIR          board to start on      (default: auto-resolved, see resolve_board)
#   BEADS_ACTOR        claim identity for bd  (default: auto-derived, see resolve_actor)
#   FEADS_REGISTRY_DB  board registry         (default ~/.feads/registry.db)
#   FEADS_MCP_PORT     MCP HTTP port          (default 4143)
#   FEADS_MCP          set to 0 to skip starting the MCP server
#
# The MCP server comes up with the UI, and that is not a convenience: the dashboard
# hands a human an MCP endpoint plus a bearer token to paste into their agent, so an
# endpoint that is only running when someone remembered `make mcp-http` would make the
# dashboard print instructions that do not work.

set -uo pipefail

# These credentials belong to the hosted silo manager/platform boundary. This
# local launcher has no manager and must not pass inherited values to its UI or
# MCP daemon children (including daemon restarts).
# The local/base launcher has no silo manager or platform auth boundary. Clear
# inherited silo SSO settings before any dashboard/MCP child can see them.
unset \
  PROVISIONING_API_KEY \
  MCP_UPSTREAM_SHARED_SECRET \
  FEADS_SILO \
  FEADS_SSO_INTERNAL_SECRET \
  FEADS_AUTH_PROXY_URL

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UI_DIR="$REPO_ROOT/ui"
BD_BIN_PATH="$REPO_ROOT/bd"

PORT="${FEADS_PORT:-4141}"
HOST="${FEADS_HOST:-127.0.0.1}"

# Keep our daemon's pidfile separate from any globally-installed `bdui`, so
# stopping feads never stops someone else's dashboard and vice versa.
# .runtime/ is already gitignored upstream.
export BDUI_RUNTIME_DIR="${BDUI_RUNTIME_DIR:-$REPO_ROOT/.runtime/feads-ui}"

MCP_PORT="${FEADS_MCP_PORT:-4143}"
MCP_ENABLED="${FEADS_MCP:-1}"
MCP_RUNTIME_DIR="$REPO_ROOT/.runtime/feads-mcp"
MCP_PIDFILE="$MCP_RUNTIME_DIR/mcp.pid"
MCP_LOG="$MCP_RUNTIME_DIR/mcp.log"

OPEN_BROWSER=0
CMD="start"
BOARD_ID=""
_want_board=0
for arg in "$@"; do
  if [ "$_want_board" = "1" ]; then
    BOARD_ID="$arg"
    _want_board=0
    continue
  fi
  case "$arg" in
    start | stop | restart | status | verify) CMD="$arg" ;;
    --open) OPEN_BROWSER=1 ;;
    --board) _want_board=1 ;;
    -h | --help)
      sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "feads-run: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror\033[0m %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1${2:+ ($2)}"
}

# ---------------------------------------------------------------- board -----
# A directory is a usable board only if it actually holds a database or config.
# feads ships upstream's .beads/ containing nothing but formulas/, which looks
# like a board to a naive check and is not one — hence the explicit test.
#
# Keep these markers in step with isBoardDir() in boards/registry.mjs and
# ui/server/active-board.js — three implementations of one rule, and a board this
# script rejects but the registry accepts is a confusing half-failure.
is_board() {
  local d="$1"
  [ -d "$d" ] || return 1
  [ -f "$d/config.yaml" ] && return 0
  [ -d "$d/embeddeddolt" ] && return 0
  [ -f "$d/metadata.json" ] && return 0
  compgen -G "$d"/*.db >/dev/null 2>&1 && return 0
  return 1
}

resolve_board() {
  # An explicit --board wins over everything: the point of naming a board is to
  # not care where it lives on disk.
  if [ -n "$BOARD_ID" ]; then
    local dir
    dir=$("$REPO_ROOT/scripts/feads-board.mjs" show "$BOARD_ID" --json 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).board_dir||"")}catch{}})')
    [ -n "$dir" ] || die "no board registered as \"$BOARD_ID\"
  List them with:  $REPO_ROOT/scripts/feads-board.mjs list"
    is_board "$dir" || die "board \"$BOARD_ID\" is registered but its directory is gone: $dir"
    echo "$dir"
    return
  fi
  if [ -n "${BEADS_DIR:-}" ]; then
    is_board "$BEADS_DIR" || die "BEADS_DIR=$BEADS_DIR is not a beads board (no config.yaml, embeddeddolt/ or *.db)"
    echo "$BEADS_DIR"
    return
  fi
  # Sibling layout: feads checked out next to the board it serves, which is how
  # the example superrepo is arranged (<superrepo>/.beads + <superrepo>/feads).
  if is_board "$REPO_ROOT/../.beads"; then
    (cd "$REPO_ROOT/.." && pwd -P | sed 's|$|/.beads|')
    return
  fi
  if is_board "$REPO_ROOT/.beads"; then
    echo "$REPO_ROOT/.beads"
    return
  fi
  die "no beads board found.
  Looked at: \$BEADS_DIR (unset), $REPO_ROOT/../.beads, $REPO_ROOT/.beads
  Point this at an existing board:   BEADS_DIR=/path/to/.beads $0 $CMD
  Or create one here:                (cd $REPO_ROOT && ./bd init)"
}

# The picker can only show a name, description and repo list for boards the
# registry knows about, and it only renders as a switcher once there is more than
# one. Registering whatever board we just resolved means `make run` produces a
# working picker with no separate setup step.
ensure_registered() {
  local dir="$1"
  if "$REPO_ROOT/scripts/feads-board.mjs" show "$dir" --json >/dev/null 2>&1; then
    return
  fi
  local name
  name=$(basename "$(dirname "$dir")")
  say "registering this board as \"$name\" (not seen before)"
  if "$REPO_ROOT/scripts/feads-board.mjs" register "$dir" --name "$name" >/dev/null 2>&1; then
    ok "registered — describe it with: scripts/feads-board.mjs describe <id> --description ..."
  else
    warn "could not register this board; the picker will fall back to a bare label"
  fi
}

# Distinct actor per session, so `bd update --claim` can actually detect a
# collision instead of silently succeeding (--claim is idempotent per actor).
resolve_actor() {
  if [ -n "${BEADS_ACTOR:-}" ]; then
    echo "$BEADS_ACTOR"
    return
  fi
  local sid="${CLAUDE_CODE_SESSION_ID:-}"
  [ -n "$sid" ] || sid="pid$$"
  echo "feads-${sid:0:6}"
}

# ---------------------------------------------------------------- build -----
build_backend() {
  need_cmd go "install Go 1.24+"
  if [ -x "$BD_BIN_PATH" ]; then
    ok "bd already built ($("$BD_BIN_PATH" --version 2>/dev/null | head -1))"
    return
  fi
  say "building bd backend (CGO + gms_pure_go; first build is slow)"
  make -C "$REPO_ROOT" build || die "bd build failed — run 'make doctor-build' to diagnose"
  [ -x "$BD_BIN_PATH" ] || die "make build reported success but $BD_BIN_PATH is missing"
  ok "built $BD_BIN_PATH"
}

build_ui() {
  need_cmd node "Node >=22 required by beads-ui"
  need_cmd npm
  if [ ! -d "$UI_DIR/node_modules" ]; then
    say "installing UI dependencies (npm ci)"
    (cd "$UI_DIR" && npm ci --no-audit --no-fund) || die "npm ci failed in $UI_DIR"
  fi
  # main.bundle.js is generated, never committed (see ui/.gitignore). Rebuild it
  # whenever any front-end source is newer than the bundle.
  local bundle="$UI_DIR/app/main.bundle.js"
  if [ ! -f "$bundle" ] || [ -n "$(find "$UI_DIR/app" "$UI_DIR/scripts" -name '*.js' -newer "$bundle" -not -name '*.test.js' -print -quit 2>/dev/null)" ]; then
    say "building UI bundle"
    (cd "$UI_DIR" && npm run build) || die "UI bundle build failed"
  fi
  ok "UI bundle ready ($(wc -c <"$bundle" | tr -d ' ') bytes)"
}

# ---------------------------------------------------------------- daemon ----
port_holder_pid() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

bdui() {
  (cd "$REPO_ROOT" && node "$UI_DIR/bin/bdui.js" "$@")
}

# ------------------------------------------------------------------- mcp ----
# The MCP server is what an *agent* talks to, over HTTP, with a bearer token. It is
# started as a plain background process rather than through a daemon manager because
# it has no state to protect: killing it loses nothing, and it reads the same registry
# the UI does.

mcp_pid() {
  # Trust the port over the pidfile: a stale pidfile after a hard kill would otherwise
  # report a running server that is not there.
  lsof -tiTCP:"$MCP_PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

start_mcp() {
  [ "$MCP_ENABLED" = "0" ] && { say "MCP disabled (FEADS_MCP=0)"; return 0; }

  local existing
  existing=$(mcp_pid)
  if [ -n "$existing" ]; then
    ok "MCP already listening on $HOST:$MCP_PORT (pid $existing)"
    return 0
  fi

  if ! command -v uv >/dev/null 2>&1; then
    # Warn rather than die: the dashboard is still useful without it, but say plainly
    # that the connection details it prints will not work, since a silent failure here
    # surfaces later as an agent that cannot connect for no visible reason.
    warn "uv not found — not starting the MCP server"
    warn "agents will not be able to connect, and the dashboard's connection snippet will not work"
    warn "install uv, or run the MCP yourself:  make mcp-http"
    return 0
  fi

  mkdir -p "$MCP_RUNTIME_DIR"
  say "starting MCP on http://$HOST:$MCP_PORT/mcp"
  (
    cd "$REPO_ROOT/integrations/beads-mcp" || exit 1
    # FEADS_DASHBOARD_URL: the MCP tells a token-less agent to go and sign in at the
    # dashboard, so it needs the real URL rather than its own default —
    # ui/server/config.js defaults to port 3000 on its own while this launcher serves
    # 4141, so passing it down makes that instruction exact instead of usually-right.
    #
    # BEADS_ACTOR / FEADS_AGENT_TOKEN are emptied, not passed through. This daemon
    # serves many callers over HTTP, and either variable in *its* environment
    # describes whichever shell ran `start` — an identity every caller's writes
    # would then collapse onto (observed: a restart from an agent session stamped
    # that session's actor on every authenticated agent's beads). The MCP
    # attributes writes to the verified wire identity instead, and an unverified
    # HTTP caller cannot write at all, so the daemon needs no ambient identity.
    #
    # Keep every assignment on the continued line: a comment between backslash-
    # continued lines silently ends the command, which would turn the rest of these
    # into unexported shell variables the MCP process never sees. bash -n does not
    # catch it, because it is valid syntax that means something else.
    FEADS_MCP_HTTP=1 \
    FEADS_MCP_HOST="$HOST" \
    FEADS_MCP_PORT="$MCP_PORT" \
    FEADS_SILO= \
    FEADS_SSO_INTERNAL_SECRET= \
    FEADS_AUTH_PROXY_URL= \
    BEADS_DIR="$BEADS_DIR" \
    BD_BIN="$BD_BIN" \
    BEADS_ACTOR= \
    FEADS_AGENT_TOKEN= \
    FEADS_DASHBOARD_URL="http://$HOST:$PORT" \
      nohup uv run beads-mcp --http --host "$HOST" --port "$MCP_PORT" \
        >>"$MCP_LOG" 2>&1 &
    echo $! >"$MCP_PIDFILE"
  )

  local i pid=""
  for i in $(seq 1 40); do
    pid=$(mcp_pid)
    [ -n "$pid" ] && break
    sleep 0.5
  done
  if [ -z "$pid" ]; then
    warn "MCP did not start listening on $HOST:$MCP_PORT — see $MCP_LOG"
    warn "the dashboard will still work; agents will not be able to connect"
    return 0
  fi
  ok "MCP healthy (pid $pid)"
}

stop_mcp() {
  local pid
  pid=$(mcp_pid)
  if [ -z "$pid" ]; then
    ok "MCP port $MCP_PORT free"
    rm -f "$MCP_PIDFILE"
    return 0
  fi
  # Only kill what we started. Someone else's server on our port is theirs to stop —
  # the same rule the UI path already follows for its port.
  local ours=""
  [ -f "$MCP_PIDFILE" ] && ours=$(cat "$MCP_PIDFILE" 2>/dev/null)
  say "stopping MCP (pid $pid)"
  kill "$pid" 2>/dev/null || true
  sleep 0.5
  if [ -n "$(mcp_pid)" ]; then
    warn "MCP still on port $MCP_PORT (pid $(mcp_pid)); started by us: ${ours:-unknown}"
  else
    ok "MCP stopped"
  fi
  rm -f "$MCP_PIDFILE"
}

do_stop() {
  stop_mcp
  say "stopping feads UI"
  bdui stop 2>&1 | sed 's/^/  /'
  local pid
  pid=$(port_holder_pid)
  if [ -n "$pid" ]; then
    warn "port $PORT still held by pid $pid ($(ps -o comm= -p "$pid" 2>/dev/null))"
    warn "not ours to kill — stop it yourself if you want the port back"
  else
    ok "port $PORT free"
  fi
}

do_status() {
  local pid
  pid=$(port_holder_pid)
  if [ -z "$pid" ]; then
    echo "feads UI: not running (nothing listening on $HOST:$PORT)"
    return 1
  fi
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$HOST:$PORT/healthz" 2>/dev/null)
  echo "feads UI: pid $pid on http://$HOST:$PORT (/healthz -> ${code:-no response})"
  local mcp
  mcp=$(mcp_pid)
  if [ -n "$mcp" ]; then
    echo "feads MCP: pid $mcp on http://$HOST:$MCP_PORT/mcp"
  else
    echo "feads MCP: not running (nothing listening on $HOST:$MCP_PORT)"
  fi
  [ "$code" = "200" ]
}

# Prove the UI can actually reach the backend, rather than just that a port is
# open: subscribe over the WebSocket and require a real snapshot back. A served
# page with a broken bd underneath renders an empty board and looks healthy.
do_verify() {
  need_cmd node
  FEADS_URL="ws://$HOST:$PORT/ws" node "$REPO_ROOT/scripts/feads-verify.mjs"
}

do_start() {
  build_backend
  build_ui

  local board actor
  board=$(resolve_board) || exit 1
  actor=$(resolve_actor)

  export BEADS_DIR="$board"
  export BEADS_ACTOR="$actor"
  export BD_BIN="$BD_BIN_PATH" # pin the UI to *this* repo's backend
  export PORT="$PORT"
  export HOST="$HOST"

  say "board  $BEADS_DIR"
  say "bd     $BD_BIN"
  say "actor  $BEADS_ACTOR"

  # Confirm the backend can open that board before handing it to the UI, so a
  # broken board fails here with bd's own error instead of as an empty page.
  if ! "$BD_BIN" ping >/dev/null 2>&1; then
    die "bd cannot reach the board at $BEADS_DIR
  Reproduce with:  BEADS_DIR=$BEADS_DIR $BD_BIN ping"
  fi
  ok "backend reachable ($("$BD_BIN" count 2>/dev/null | tr -d ' ') issues)"
  ensure_registered "$board"

  # Clear our own previous daemon, then refuse to fight anyone else for the port.
  bdui stop >/dev/null 2>&1 || true
  local pid
  pid=$(port_holder_pid)
  if [ -n "$pid" ]; then
    die "port $PORT is already held by pid $pid ($(ps -o comm= -p "$pid" 2>/dev/null))
  If that's a globally-installed bdui, stop it with:  bdui stop
  Or serve feads elsewhere:                           FEADS_PORT=4142 $0 start"
  fi

  say "starting UI on http://$HOST:$PORT"
  local start_args=(start --port "$PORT" --host "$HOST")
  [ "$OPEN_BROWSER" = "1" ] && start_args+=(--open)
  # A shared UI daemon must not inherit a caller agent token (possibly for a
  # different registry), nor enable hosted SSO. Clients authenticate per request.
  FEADS_AGENT_TOKEN= FEADS_SILO= FEADS_SSO_INTERNAL_SECRET= FEADS_AUTH_PROXY_URL= \
    bdui "${start_args[@]}" 2>&1 | sed 's/^/  /'

  # Wait for readiness rather than sleeping a guessed interval.
  local i code=""
  for i in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://$HOST:$PORT/healthz" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 0.5
  done
  [ "$code" = "200" ] || die "UI did not become healthy on $HOST:$PORT (last /healthz: ${code:-no response})
  Daemon log: $BDUI_RUNTIME_DIR/server.log"
  ok "UI healthy"

  do_verify || die "UI is serving but could not read the board through bd — see $BDUI_RUNTIME_DIR/server.log"

  start_mcp

  echo
  printf '\033[1;32mfeads is up\033[0m  →  \033[4mhttp://%s:%s\033[0m\n' "$HOST" "$PORT"
  echo "  backend  $BD_BIN"
  echo "  board    $BEADS_DIR"
  if [ -n "$(mcp_pid)" ]; then
    echo "  agents   http://$HOST:$MCP_PORT/mcp  (bearer token from the dashboard)"
  fi
  echo "  stop     scripts/feads-run.sh stop"
}

case "$CMD" in
  start) do_start ;;
  stop) do_stop ;;
  restart)
    do_stop
    do_start
    ;;
  status) do_status ;;
  verify) do_verify ;;
esac
