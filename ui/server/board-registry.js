/**
 * feads addition — read side of the SQLite board registry.
 *
 * Upstream beads-ui only learns about workspaces that a running `bd` daemon
 * advertises in `~/.beads/registry.json`, which records a path and nothing else.
 * feads keeps the authoritative list of boards — and what each one is for — in a
 * SQLite registry shared with the Python MCP server; this module is the UI
 * server's read side of it.
 *
 * Every function degrades to "no boards" instead of throwing. A machine that has
 * never registered a board must still serve the single discovered one, and the
 * dashboard must not be the thing that authors the registry, so a missing
 * registry file is left missing rather than created.
 */
import fs from 'node:fs';
import path from 'node:path';
import { debug } from './logging.js';

const log = debug('board-registry');

/**
 * @typedef {Object} RegistryBoard
 * @property {string} id
 * @property {string} name
 * @property {string} board_dir - Absolute path of the board's `.beads` directory.
 * @property {string} workspace_dir - Project root, or `''` when unrecorded.
 * @property {string} description
 * @property {string[]} repos
 * @property {boolean} exists - Whether `board_dir` is still present on disk.
 */

/**
 * Load `boards/registry.mjs` lazily.
 *
 * Dynamic so that a Node without `node:sqlite`, or a checkout without the
 * boards module, costs the dashboard nothing but the registry feature.
 *
 * @returns {Promise<any | null>}
 */
async function loadRegistryModule() {
  try {
    return await import('../../boards/registry.mjs');
  } catch (err) {
    log('board registry module unavailable: %o', err);
    return null;
  }
}

/**
 * Run `fn` against an open registry, or return `null` if there is none.
 *
 * @template T
 * @param {(mod: any, db: any) => T} fn
 * @returns {Promise<T | null>}
 */
async function withRegistry(fn) {
  const mod = await loadRegistryModule();
  if (!mod) {
    return null;
  }
  /** @type {string} */
  let registry_path;
  try {
    registry_path = mod.getRegistryPath();
  } catch (err) {
    log('cannot resolve registry path: %o', err);
    return null;
  }
  // openRegistry() would create the file. An absent registry means "no boards
  // registered", not "make one" — registry authorship belongs to the CLI.
  if (!fs.existsSync(registry_path)) {
    log('no board registry at %s', registry_path);
    return null;
  }
  /** @type {any} */
  let db = null;
  try {
    db = mod.openRegistry();
    return fn(mod, db);
  } catch (err) {
    log('board registry read failed (%s): %o', registry_path, err);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * @param {any} row
 * @returns {RegistryBoard}
 */
function toRegistryBoard(row) {
  const board_dir = path.resolve(String(row.board_dir || ''));
  return {
    id: String(row.id || ''),
    name: String(row.name || ''),
    board_dir,
    workspace_dir: row.workspace_dir
      ? path.resolve(String(row.workspace_dir))
      : '',
    description: String(row.description || ''),
    repos: Array.isArray(row.repos)
      ? row.repos.map((/** @type {unknown} */ r) => String(r))
      : [],
    exists: dirExists(board_dir)
  };
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every registered board.
 *
 * @returns {Promise<RegistryBoard[]>}
 */
export async function listRegistryBoards() {
  const boards = await withRegistry((mod, db) =>
    mod.listBoards(db).map(toRegistryBoard)
  );
  return boards || [];
}

/**
 * Look a board up by the *project* directory it was registered for.
 *
 * `getBoard` matches an id or a `.beads` directory, which is right for a caller
 * naming a board. A caller naming its **workspace** is a different question with a
 * different answer column, and it is the question a sign-up asks: "which board
 * belongs to the tree I am working in?" Without this, a workspace root resolves to
 * nothing and the caller falls back to the seed board — which is how new agents
 * ended up homed on a catch-all they had no relationship to.
 *
 * Compared on the resolved path, because `workspace_dir` is stored resolved.
 *
 * @param {string} workspace_dir
 * @returns {Promise<RegistryBoard | null>}
 */
export async function findRegistryBoardByWorkspace(workspace_dir) {
  const key = String(workspace_dir || '').trim();
  if (key.length === 0) {
    return null;
  }
  const wanted = path.resolve(key);
  const board = await withRegistry((mod, db) => {
    const row = mod
      .listBoards(db)
      .find(
        (/** @type {any} */ b) =>
          b.workspace_dir && path.resolve(String(b.workspace_dir)) === wanted
      );
    return row ? toRegistryBoard(row) : null;
  });
  return board || null;
}

/**
 * Look a board up by registry id, falling back to its `board_dir`.
 *
 * @param {string} id_or_dir
 * @returns {Promise<RegistryBoard | null>}
 */
export async function findRegistryBoard(id_or_dir) {
  const key = String(id_or_dir || '').trim();
  if (key.length === 0) {
    return null;
  }
  const board = await withRegistry((mod, db) => {
    const row = mod.getBoard(db, key);
    return row ? toRegistryBoard(row) : null;
  });
  return board || null;
}
