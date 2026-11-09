import { spawn } from 'node:child_process';
import { applyBoardEnv } from './active-board.js';
import { resolveDbPath } from './db.js';
import { debug } from './logging.js';

const log = debug('bd');
const ACTOR_RESOLUTION_ERROR = 'Unable to resolve actor';
/** @type {Promise<void>} */
let bd_run_queue = Promise.resolve();

/**
 * Get the git user name from git config.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<string>}
 */
export async function getGitUserName(options = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', ['config', 'user.name'], {
      cwd: options.cwd || process.cwd(),
      shell: false,
      windowsHide: true
    });

    /** @type {string[]} */
    const chunks = [];

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => chunks.push(String(chunk)));
    }

    child.on('error', () => resolve(''));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve('');
        return;
      }
      resolve(chunks.join('').trim());
    });
  });
}

/**
 * Resolve the bd executable path.
 *
 * @returns {string}
 */
export function getBdBin() {
  const env_value = process.env.BD_BIN;
  if (env_value && env_value.length > 0) {
    return env_value;
  }
  return 'bd';
}

/**
 * Run the `bd` CLI with provided arguments.
 * Shell is not used to avoid injection; args must be pre-split.
 *
 * feads: `board_dir` is the caller's board — see the note at the spawn site. It is
 * the one option that must be threaded from every call path, because the process
 * no longer has a single board to fall back on.
 *
 * @param {string[]} args - Arguments to pass (e.g., ["list", "--json"]).
 * @param {BdRunOptions} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runBd(args, options = {}) {
  return withBdRunQueue(async () => {
    const resolved_options = await resolveActor(options);
    if (!resolved_options) {
      return { code: 1, stdout: '', stderr: ACTOR_RESOLUTION_ERROR };
    }
    return runBdUnlocked(args, resolved_options);
  });
}

/**
 * Resolve `options.actor` when it was handed over as a thunk (feads).
 *
 * `bd` attributes a write to `$BEADS_ACTOR`, and the daemon's own is the launching
 * shell's — so without this every bead filed from a signed-in browser was recorded as
 * `feads-<sid>` or the host's git user.name rather than the agent who filed it
 * (#feads-tb5). The actor is a property of the *connection*, exactly like `board_dir`
 * beside it, and it is threaded from the same place for the same reason: a per-handler
 * stamp is a stamp some later handler forgets.
 *
 * It arrives as a function because resolving an identity means reading the registry,
 * and the message handler builds these options for every message including the reads
 * that never spawn `bd`. Deferring it to the spawn puts that cost only where the
 * attribution is actually used, and memoizing in the caller keeps a multi-`bd` message
 * to one lookup.
 *
 * @param {BdRunOptions} options
 * @returns {Promise<BdRunOptions | null>}
 */
async function resolveActor(options) {
  const require_actor = options.require_actor === true;

  if (typeof options.actor !== 'function') {
    if (require_actor && !isNonEmptyActor(options.actor)) {
      return null;
    }
    return options;
  }

  try {
    const resolved_actor = await options.actor();
    if (require_actor) {
      // A required actor is a verified value from the caller's resolver. Do not
      // coerce arbitrary values or let bd consult ambient identity sources.
      return isNonEmptyActor(resolved_actor)
        ? { ...options, actor: resolved_actor }
        : null;
    }
    return { ...options, actor: String(resolved_actor || '') };
  } catch (err) {
    if (require_actor) {
      // Deliberately keep this generic: resolver failures may contain auth or
      // registry details that must not cross the bd/WebSocket boundary.
      log('required actor resolution failed');
      return null;
    }
    // An unreachable registry must not fail the write it was only annotating. bd
    // falls back to its own resolution, which is what happened before this existed.
    log('actor resolution failed, leaving BEADS_ACTOR to bd: %o', err);
    return { ...options, actor: '' };
  }
}

/**
 * @param {unknown} actor
 * @returns {actor is string}
 */
function isNonEmptyActor(actor) {
  return typeof actor === 'string' && actor.length > 0;
}

/**
 * @typedef {Object} BdRunOptions
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env]
 * @property {number} [timeout_ms]
 * @property {string | null} [board_dir] - feads: the `.beads` directory this
 * invocation must read. `''` means a workspace holding no board, `null` means
 * inherited discovery, and omitting it means "no board named", which falls back
 * to the seed board.
 * @property {string | (() => unknown | Promise<unknown>)} [actor] - feads: who this
 * invocation is acting as, stamped as `$BEADS_ACTOR`. A function is resolved at
 * spawn time (see `resolveActor`); omitting it leaves bd's own resolution alone
 * unless `require_actor` is true.
 * @property {boolean} [require_actor] - Require a non-empty string actor before
 * spawning. When true, resolution failure is returned as a generic bd failure and
 * no inherited actor or fallback identity is used.
 */

/**
 * Run the `bd` CLI with provided arguments without queueing.
 *
 * @param {string[]} args
 * @param {BdRunOptions} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runBdUnlocked(args, options = {}) {
  const bin = getBdBin();
  const actor = typeof options.actor === 'string' ? options.actor : '';

  // Set BEADS_DB only when the workspace has a local SQLite DB.
  // Do not force BEADS_DB from global fallback paths; this can override
  // backend autodetection in non-SQLite workspaces (for example Dolt).
  const db_path = resolveDbPath({
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env
  });
  const env_with_db = { ...(options.env || process.env) };
  if (db_path.source === 'nearest' && db_path.exists) {
    env_with_db.BEADS_DB = db_path.path;
  }

  // feads: bd reads $BEADS_DIR ahead of cwd, so the board has to be stamped on
  // every child. A BEADS_DIR inherited by the daemon would otherwise outrank the
  // user's board selection and every board would return the same issues.
  //
  // This is the one choke point where that happens, which is why it takes a board
  // *directory* rather than a socket. Two kinds of caller need to stamp one and
  // only one of them has a connection: a message handler stamps the board of the
  // connection that sent the message, while a watcher-driven refresh stamps the
  // board that changed and fans the result out to every connection on it. Keying
  // this on the socket would have left the second caller with nothing to pass.
  //
  // An omitted `board_dir` resolves to the seed board rather than throwing. That
  // is the only safe default — it is the board `bd` would have picked unaided —
  // but note that for a connection which has switched boards it is the *wrong*
  // board, silently. So every call path threads it; see `bd_options` in `ws.js`
  // and `fetchListForSubscription` in `list-adapters.js`, which are the only two.
  applyBoardEnv(env_with_db, options.board_dir);

  // feads: the same argument as the board above, for the same reason. In the
  // required mode, clear the inherited value before stamping the verified actor so
  // a daemon-level identity can never survive a silo invocation. The preflight in
  // resolveActor prevents this path from spawning without a non-empty actor.
  if (options.require_actor === true) {
    delete env_with_db.BEADS_ACTOR;
  }
  if (actor) {
    env_with_db.BEADS_ACTOR = actor;
  }

  const spawn_opts = {
    cwd: options.cwd || process.cwd(),
    env: env_with_db,
    shell: false,
    windowsHide: true
  };

  /** @type {string[]} */
  const final_args = buildBdArgs(args);

  return new Promise((resolve) => {
    const child = spawn(bin, final_args, spawn_opts);

    /** @type {string[]} */
    const out_chunks = [];
    /** @type {string[]} */
    const err_chunks = [];

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out_chunks.push(String(chunk));
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        err_chunks.push(String(chunk));
      });
    }

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    if (options.timeout_ms && options.timeout_ms > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, options.timeout_ms);
      timer.unref?.();
    }

    /**
     * @param {number | string | null} code
     */
    const finish = (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        code: Number(code || 0),
        stdout: out_chunks.join(''),
        stderr: err_chunks.join('')
      });
    };

    child.on('error', (err) => {
      // Treat spawn error as an immediate non-zero exit; log for diagnostics.
      log('spawn error running %s %o', bin, err);
      finish(127);
    });
    child.on('close', (code) => {
      const exit_code = Number(code || 0);
      if (exit_code !== 0) {
        // Mirror the logging runBdJson already does so non-JSON callers
        // (mutation handlers) leave a debug trace on failure.
        log(
          'bd exited with code %d (args=%o) stderr=%s',
          exit_code,
          final_args,
          err_chunks.join('')
        );
      }
      finish(code);
    });
  });
}

/**
 * Build final bd CLI arguments.
 * bdui defaults to sandbox mode to avoid sync/autopush overhead on interactive
 * UI requests. Set `BDUI_BD_SANDBOX=0` (or "false") to opt out.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function buildBdArgs(args) {
  const arg_set = new Set(args);
  const raw_sandbox = String(process.env.BDUI_BD_SANDBOX || '').toLowerCase();
  const sandbox_disabled = raw_sandbox === '0' || raw_sandbox === 'false';
  const should_prepend_sandbox = !sandbox_disabled && !arg_set.has('--sandbox');

  if (!should_prepend_sandbox) {
    return args.slice();
  }

  return ['--sandbox', ...args];
}

/**
 * Serialize `bd` invocations.
 * Dolt embedded mode can crash when multiple `bd` processes run concurrently
 * against the same workspace.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withBdRunQueue(operation) {
  const previous = bd_run_queue;
  /** @type {() => void} */
  let release = () => {};
  bd_run_queue = new Promise((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * Run `bd` and parse JSON from stdout if exit code is 0.
 *
 * @param {string[]} args - Must include flags that cause JSON to be printed (e.g., `--json`).
 * @param {BdRunOptions} [options]
 * @returns {Promise<{ code: number, stdoutJson?: unknown, stderr?: string }>}
 */
export async function runBdJson(args, options = {}) {
  const result = await runBd(args, options);
  if (result.code !== 0) {
    // Non-zero exits are logged centrally in runBdUnlocked's child.on('close').
    return { code: result.code, stderr: result.stderr };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || 'null');
  } catch (err) {
    log('bd returned invalid JSON (args=%o): %o', args, err);
    return { code: 0, stderr: 'Invalid JSON from bd' };
  }
  return { code: 0, stdoutJson: parsed };
}
