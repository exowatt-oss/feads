/**
 * feads addition — which board a caller's `bd` children read, and the child
 * environment that pins them to it.
 *
 * `bd` resolves its board from `$BEADS_DIR` *before* it walks up from cwd, so a
 * BEADS_DIR exported once to the daemon silently outranks every later board
 * selection: switching boards updated the label and the file watcher while `bd`
 * kept answering out of the original database. Board binding therefore has to be
 * decided per child process rather than per daemon, which is what this module
 * exists to do.
 *
 * Keeping it in its own module (instead of threading an env through the dozens
 * of `runBd` call sites) means the guarantee holds for call sites that have not
 * been touched, including any added by a future upstream merge.
 *
 * ## Board selection is per connection — there is no "current board" any more
 *
 * This module used to hold exactly one board, in a module-level variable, and
 * every `bd` child read it. That made the board a property of the *daemon* rather
 * than of the browser looking at it, and the consequence was a real defect
 * (ex-dh0): an anonymous tab calling `set-board` moved the board out from under a
 * logged-in agent's tab, whose next read or write then silently targeted a
 * different database. Two tabs could not look at two boards at all.
 *
 * The fix is not a permission check on the switcher. The dashboard's stance toward
 * an unidentified caller is `read_only`, which grants reading **every** board, so
 * refusing `set-board` would have quietly reduced that to whichever board the
 * daemon happened to start on — see the note on the ungated handlers in `ws.js`.
 * The board became per connection instead, keyed on the socket exactly as the
 * agent token in `ws.js` already is.
 *
 * **Do not reintroduce a module-level "active board".** If you find yourself
 * wanting one, the thing you actually want is `SEED_BOARD_DIR` below, and it is
 * deliberately write-once-at-startup.
 *
 * ## What is still module-level, and why that is not the same thing
 *
 * `SEED_BOARD_DIR` is the board a *new* connection starts on: the one `bd` itself
 * would have picked for the daemon's first request, from `$BEADS_DIR` when the
 * launcher exported one (`feads-run.sh` documents doing exactly that) and from
 * upward directory discovery otherwise. It is set once, at startup, by
 * `attachWsServer`. A `set-board` never writes it — that is the whole point, and
 * it is what makes the seed a *default* rather than a shared mutable board.
 *
 * A connection that has never selected anything is deliberately **not** recorded
 * in the WeakMap; it reads through to the seed. So there is one representation of
 * "hasn't chosen yet", and a later correction to the seed (the registry metadata
 * adoption in `ws.js`, say) is visible to every such connection without anyone
 * having to fan it out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { debug } from './logging.js';

const log = debug('active-board');

/**
 * Directory of the board a connection that has selected nothing should read.
 *
 * Three distinguishable states, because they need different child environments:
 * `null` = never bound (leave the inherited environment exactly as it is, which
 * is upstream's behavior), `''` = bound to a workspace that holds no board (drop
 * any inherited BEADS_DIR so it cannot stand in for the selection), a path =
 * bound to that board.
 *
 * @type {string | null}
 */
let SEED_BOARD_DIR = null;

/**
 * The board each connection selected, if it selected one.
 *
 * A `WeakMap` keyed on the socket, for the same two reasons `CONNECTION_CREDENTIALS`
 * in `ws.js` is one: nothing holding a `ws` can reach it without also holding this
 * module's private map, and an entry drops when the socket does, so a closed
 * connection's selection is not still pinning a board in memory. `ws.js` also
 * releases explicitly on close, because a socket can be referenced for a while
 * after it closes and a stale entry would otherwise keep the *board* string alive
 * — harmless, but it also keeps the watcher accounting honest.
 *
 * Absence from this map is meaningful: it means "has not chosen", which reads
 * through to the seed. It is not the same as being present with `null`, which
 * means "explicitly bound to nothing" and leaves the inherited environment alone.
 *
 * @type {WeakMap<object, { board_dir: string | null }>}
 */
const CONNECTION_BOARDS = new WeakMap();

/**
 * Normalize a caller-supplied board directory to the tri-state above.
 *
 * @param {string | null | undefined} board_dir
 * @returns {string | null}
 */
function normalizeBoardDir(board_dir) {
  if (board_dir === null || board_dir === undefined) {
    return null;
  }
  const value = String(board_dir);
  return value.length > 0 ? path.resolve(value) : '';
}

/**
 * Bind the board a connection that has selected nothing should read.
 *
 * Called once, at startup, from `attachWsServer`. `''` means a workspace that
 * holds no board; `null` restores inherited discovery.
 *
 * @param {string | null} board_dir - Absolute `.beads` directory.
 */
export function bindSeedBoard(board_dir) {
  SEED_BOARD_DIR = normalizeBoardDir(board_dir);
  log('seed board bound to %o', SEED_BOARD_DIR);
}

/**
 * The board a connection that has selected nothing reads, or `null` when unbound.
 *
 * @returns {string | null}
 */
export function getSeedBoardDir() {
  return SEED_BOARD_DIR;
}

/**
 * Bind the board *this connection's* `bd` children must read.
 *
 * @param {object} connection - The socket. Any object works; this module never
 * looks inside it, which is what lets a test drive the binding without a server.
 * @param {string | null} board_dir - Absolute `.beads` directory, `''` for a
 * workspace holding no board, `null` for inherited discovery.
 */
export function bindConnectionBoard(connection, board_dir) {
  if (!connection || typeof connection !== 'object') {
    // `WeakMap.set` throws on a primitive key. A caller with nothing to key on has
    // no per-connection board, and the seed is the honest answer for it — throwing
    // here would turn a missing argument into a dead socket.
    log('cannot bind a board to a non-object connection');
    return;
  }
  const value = normalizeBoardDir(board_dir);
  CONNECTION_BOARDS.set(connection, { board_dir: value });
  log('connection board bound to %o', value);
}

/**
 * Forget a connection's selection, so it reads through to the seed again.
 *
 * @param {object} connection
 */
export function releaseConnectionBoard(connection) {
  if (!connection || typeof connection !== 'object') {
    return;
  }
  CONNECTION_BOARDS.delete(connection);
}

/**
 * Whether a connection has selected a board of its own.
 *
 * Exported because "has not chosen" and "chose the same thing the seed says" are
 * the same *board* but different states: only the first follows a later change to
 * the seed. `ws.js` needs to tell them apart when it decides who hears about one.
 *
 * @param {object} connection
 * @returns {boolean}
 */
export function hasConnectionBoard(connection) {
  if (!connection || typeof connection !== 'object') {
    return false;
  }
  return CONNECTION_BOARDS.has(connection);
}

/**
 * The board directory this connection's `bd` children should read.
 *
 * Falls back to the seed for a connection that has selected nothing — which is
 * every connection until its first `set-board`, and every caller that has no
 * connection at all (the HTTP routes; see `agent-session.js`).
 *
 * @param {object} [connection]
 * @returns {string | null}
 */
export function getConnectionBoardDir(connection) {
  if (connection && typeof connection === 'object') {
    const bound = CONNECTION_BOARDS.get(connection);
    if (bound) {
      return bound.board_dir;
    }
  }
  return SEED_BOARD_DIR;
}

/**
 * Stamp a board onto an environment for a `bd` child. Mutates and returns `env`;
 * callers pass a copy they own.
 *
 * `board_dir` is the *caller's* board, threaded in from wherever the caller got
 * it — a message handler passes the board of the connection that sent the
 * message, a watcher-driven refresh passes the board that changed. Omitting it
 * (`undefined`) means "I did not name a board", which resolves to the seed: the
 * only safe default, because it is what `bd` would have picked on its own and it
 * is what an untouched or newly merged call site will pass.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string | null} [board_dir]
 * @returns {Record<string, string | undefined>}
 */
export function applyBoardEnv(env, board_dir) {
  const bound = board_dir === undefined ? SEED_BOARD_DIR : board_dir;
  if (bound === null) {
    return env;
  }
  if (bound.length > 0) {
    env.BEADS_DIR = bound;
  } else {
    delete env.BEADS_DIR;
  }
  return env;
}

/**
 * Whether a directory is a usable beads board.
 *
 * An empty `.beads/` is not a board — feads' own checkout ships one holding
 * nothing but `formulas/` — so presence of the directory is not enough.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isBoardDir(dir) {
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      if (
        entry.name === 'metadata.json' ||
        entry.name === 'config.yaml' ||
        entry.name.endsWith('.db')
      ) {
        return true;
      }
    } else if (entry.isDirectory() && entry.name === 'embeddeddolt') {
      return true;
    }
  }
  return false;
}

/**
 * Find the nearest usable `.beads` board by walking up from `start`.
 *
 * @param {string} start
 * @returns {string} - Absolute board directory, or `''` when none is found.
 */
export function findNearestBoardDir(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 100; i++) {
    const candidate = path.join(dir, '.beads');
    if (isBoardDir(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return '';
}

/**
 * Resolve the board to seed new connections with at startup.
 *
 * `$BEADS_DIR` wins here — and only here — because that is what `bd` itself
 * would have done for the daemon's first request. Later selections must ignore
 * it, otherwise the exported value keeps overriding whatever the user picked.
 *
 * @param {string} root_dir
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveInitialBoardDir(root_dir, env = process.env) {
  const from_env = String(env.BEADS_DIR || '').trim();
  if (from_env.length > 0) {
    return path.resolve(from_env);
  }
  return findNearestBoardDir(root_dir);
}
