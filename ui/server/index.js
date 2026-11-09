import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSeedBoardDir } from './active-board.js';
import { createApp } from './app.js';
import { listRegistryBoards } from './board-registry.js';
import { createBuildIdentity } from './build-identity.js';
import { printServerUrl } from './cli/daemon.js';
import { getConfig } from './config.js';
import { resolveWorkspaceDatabase } from './db.js';
import { assertDevSsoSafe } from './dev-sso.js';
import { debug, enableAllDebug } from './logging.js';
import { createNotificationsEngine } from './notifications-engine.js';
import { getPgStore } from './pg-store.js';
import { assertValidSiloEnvironment } from './platform-sso.js';
import { registerWorkspace, watchRegistry } from './registry-watcher.js';
import { startStorySnapshotter } from './story-snapshots.js';
import {
  attachWsServer,
  nudgeAgentwatchRefresh,
  pushNotificationRows,
  setNotificationsEngine
} from './ws.js';

if (process.argv.includes('--debug') || process.argv.includes('-d')) {
  enableAllDebug();
}

// Parse --host and --port from argv and set env vars before getConfig()
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--host' && process.argv[i + 1]) {
    process.env.HOST = process.argv[++i];
  }
  if (process.argv[i] === '--port' && process.argv[i + 1]) {
    process.env.PORT = process.argv[++i];
  }
}

const config = getConfig();
// Validate the silo gate before constructing the app or opening any registry/data
// layer. Empty FEADS_SILO is the unchanged base instance; every other invalid
// value is a deployment error, never a request-time fallback.
assertValidSiloEnvironment(process.env);
// The local-only SSO stub refuses to start anywhere it could be reached from outside.
assertDevSsoSafe(process.env);
// feads: captured here, once, and shared by the HTTP routes and the WebSocket. This is
// the *boot* snapshot — the whole point is to compare disk against what this process
// loaded — so it has to be taken before anything can change, and there has to be
// exactly one of it. Two independently captured identities would disagree about what
// "boot" meant as soon as a file changed between the two calls, and the disagreement
// would show up as a dashboard that reports itself stale and current at the same time.
const build_identity = createBuildIdentity({
  app_dir: config.app_dir,
  server_dir: path.dirname(fileURLToPath(new URL(import.meta.url)))
});
const app = createApp(config, {
  identity: build_identity,
  nudgeAgentwatchRefresh
});
const server = createServer(app);
const log = debug('server');

// feads: bring the Postgres data layer up before the first connection can
// arrive, so the pool is warm and — more importantly — the `LISTEN` connection
// is already subscribed. A store created lazily on the first read would miss
// every write that landed between boot and that read, and the dashboard would
// sit on stale lists until something else nudged it. A no-op when
// `FEADS_PG_DSN` is unset, which is the legacy `bd` path.
if (config.pg_dsn) {
  getPgStore();
  log('data layer: postgres');
} else {
  log('data layer: bd (legacy)');
}

// Register the initial workspace (from cwd) so it appears in the workspace picker
// even without the beads daemon running
const workspace_database = resolveWorkspaceDatabase({ cwd: config.root_dir });
if (workspace_database.source !== 'home-default' && workspace_database.exists) {
  registerWorkspace({
    path: config.root_dir,
    database: workspace_database.path
  });
}

// feads: the beads DB watcher used to be created here, once, for the one board the
// daemon served. Boards are per connection now, so watching them is too: the ws
// server owns a reference-counted pool that starts a watcher for each board somebody
// is looking at and closes it when the last of them goes. Creating one here would
// only be able to watch a single board, which is the bug — a second board on screen
// would never notice a change. See `board-watchers.js`.
attachWsServer(server, {
  path: '/ws',
  heartbeat_ms: 30000,
  // Coalesce DB change bursts into one refresh run
  refresh_debounce_ms: 75,
  root_dir: config.root_dir,
  build_identity
});

// Watch the global registry for workspace changes (e.g., when user starts
// bd daemon in a different project). This enables automatic workspace switching.
watchRegistry(
  (entries) => {
    log('registry changed: %d entries', entries.length);
    // Find if there's a newer workspace that matches our initial root
    // For now, we just log the change - users can switch via set-workspace
    // Future: could auto-switch if a workspace was started in a parent/child dir
  },
  { debounce_ms: 500 }
);

server.listen(config.port, config.host, () => {
  printServerUrl();
});

// feads: the epic story recorder. Every known board — the registry's plus the
// seed the daemon booted on — gets one `bd export` per tick, and each epic gets
// a history line only when something about it changed. Started after
// `attachWsServer` because that is what binds the seed board; set
// `FEADS_STORY_INTERVAL_MS=0` to disable.
const story_interval = Number.parseInt(
  process.env.FEADS_STORY_INTERVAL_MS || '',
  10
);
if (!Number.isFinite(story_interval) || story_interval > 0) {
  startStorySnapshotter({
    interval_ms: Number.isFinite(story_interval) ? story_interval : 120000,
    listBoards: async () => {
      /** @type {Array<{ board_dir: string | null, cwd?: string }>} */
      const boards = [];
      try {
        for (const board of await listRegistryBoards()) {
          if (board.exists) {
            boards.push({
              board_dir: board.board_dir,
              cwd: board.workspace_dir || config.root_dir
            });
          }
        }
      } catch (err) {
        log('story: registry listing failed %o', err);
      }
      const seed = getSeedBoardDir();
      if (seed && seed.length > 0) {
        boards.push({ board_dir: seed, cwd: config.root_dir });
      }
      return boards;
    }
  });
  log('story snapshotter started');
}

// feads: the notification engine. Watches every known board — the registry's
// plus the seed — and diffs `bd export` on change to mint notification rows
// (mentions, comments on owned issues, updates on commented issues, closed
// blockers). Owned here rather than by attachWsServer so tests attaching a ws
// server never scan the real registry; the ws layer gets a handle to nudge and
// pushes minted rows to connected recipients. `FEADS_NOTIFICATIONS=0` disables.
if (process.env.FEADS_NOTIFICATIONS !== '0') {
  const notifications_engine = createNotificationsEngine({
    listBoards: async () => {
      /** @type {Array<{ board_dir: string, cwd: string, board_id: string }>} */
      const boards = [];
      try {
        for (const board of await listRegistryBoards()) {
          if (board.exists) {
            boards.push({
              board_dir: board.board_dir,
              cwd: board.workspace_dir || config.root_dir,
              board_id: board.id
            });
          }
        }
      } catch (err) {
        log('notifications: registry listing failed %o', err);
      }
      const seed = getSeedBoardDir();
      if (
        seed &&
        seed.length > 0 &&
        !boards.some((b) => b.board_dir === seed)
      ) {
        boards.push({ board_dir: seed, cwd: config.root_dir, board_id: '' });
      }
      return boards;
    },
    onNotify: (rows) => {
      void pushNotificationRows(rows);
    }
  });
  setNotificationsEngine(notifications_engine);
  void notifications_engine.start().then(() => {
    log('notification engine started');
  });
}

server.on('error', (err) => {
  log('server error %o', err);
  process.exitCode = 1;
});
