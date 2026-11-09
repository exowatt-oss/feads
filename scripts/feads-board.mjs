#!/usr/bin/env node
/**
 * feads-board — manage the board registry.
 *
 * beads gives you one board per `bd init`, but nothing that knows a *set* of
 * boards exists or what each one is for. This CLI owns the SQLite registry that
 * fills that gap, so an agent can ask "which board does this task belong to?"
 * and get a defensible answer instead of guessing.
 *
 * Writes go through here; the UI server and the MCP server read the same
 * database (read-only, in the MCP's case).
 *
 * Usage:
 *   feads-board list [--json]
 *   feads-board show <id> [--json]
 *   feads-board create <dir> --name <name> [--id <slug>] [--prefix <p>]
 *                            [--description <text>] [--repo <owner/name>]... [--json]
 *   feads-board register <board-dir> --name <name> [--id <slug>]
 *                            [--workspace <dir>] [--description <text>] [--repo ...]
 *                            [--force] [--json]
 *       the dir must already hold a board database; --force registers anyway
 *   feads-board describe <id> [--description <text>] [--name <text>]
 *                            [--expect-description <text>] [--json]
 *       --expect-description is the description you last read: the write is refused
 *       (exit 3) if somebody changed it since, instead of clobbering their edit
 *   feads-board history <id> [--limit <n>] [--json]
 *       every description this board has had replaced, newest first
 *   feads-board repos <id> [--repo <r>]... [--add | --remove] [--json]
 *       no flag replaces the list; --add appends, --remove deletes just those
 *   feads-board route <text...> [--repo <owner/name>]... [--json]
 *       repos are optional; a board may have 0, 1 or many
 *   feads-board remove <id> [--json]
 *   feads-board path
 *
 * Exit codes: 0 ok · 1 error · 2 nothing matched (route) · 3 description conflict
 *
 * Env:
 *   FEADS_REGISTRY_DB   registry location (default ~/.feads/registry.db)
 *   BEADS_ACTOR         recorded as the author of a description change
 *   BD_BIN              bd binary used by `create` (default: ./bd, then PATH)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addRepos,
  describeBoard,
  getBoard,
  isBoardDir,
  getRegistryPath,
  listBoards,
  listDescriptionHistory,
  openRegistry,
  removeBoard,
  removeRepos,
  routeTask,
  setRepos,
  slugify,
  upsertBoard
} from '../boards/registry.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A description write was refused because somebody else had changed it. */
const EXIT_CONFLICT = 3;

/**
 * @param {string} msg
 * @param {number} [code]
 */
const die = (msg, code = 1) => {
  process.stderr.write(`feads-board: ${msg}\n`);
  process.exit(code);
};

/**
 * Parse argv into a command, positionals and flags. `--repo` accumulates.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const out = { cmd: argv[0] || 'help', args: [], repos: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') {
      const v = argv[++i];
      if (!v) die('--repo needs a value');
      out.repos.push(v);
    } else if (a === '--json' || a === '--add' || a === '--remove' || a === '--force') {
      out.flags[a.slice(2)] = true;
    } else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      out.flags[a.slice(2)] = v;
    } else {
      out.args.push(a);
    }
  }
  return out;
}

/**
 * Locate the bd binary for `create`. Prefer this repo's build so a board is made
 * by the same backend that will serve it — a mismatched older bd on PATH can be
 * behind on schema migrations.
 *
 * @returns {string}
 */
function resolveBdBin() {
  if (process.env.BD_BIN) return process.env.BD_BIN;
  const local = path.join(REPO_ROOT, 'bd');
  if (fs.existsSync(local)) return local;
  return 'bd';
}

/**
 * Make sure a board has an explicit `beads.role`, and say so when it did not.
 *
 * bd resolves the role from git config, and in a git work tree with no `beads.role`
 * it prefixes **every** subsequent run with a three-line advisory on stderr. That
 * advisory is how #feads-r8d happened: a wrapper reporting the first stderr line told
 * the caller a warning had failed its write, while bd's real error sat on the line
 * below it. The wrappers no longer read stderr that way; this is the other half —
 * a board that never emits the advisory in the first place.
 *
 * `bd init` already writes the role for a board it creates, so a *fresh* board was
 * never the gap. The gap is the adopted one: `create` on a directory that already
 * holds a database registers it without ever running init, which is exactly the shape
 * of the board a previous adopted-board incident happened on. So this runs on both paths, and
 * only writes when the value is missing — an operator who deliberately set
 * `contributor` on a checkout keeps it.
 *
 * A server-owned board is genuinely the maintainer of its own database, so there is
 * no judgement call here to defer to a human.
 *
 * Best effort by design: a directory that is not a git work tree has no git config to
 * write, and bd does not warn there either, so a failure is nothing to report and
 * certainly nothing to fail `create` over.
 *
 * @param {string} project_dir
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.WritableStream} progress
 * @returns {void}
 */
function provisionBeadsRole(project_dir, env, progress) {
  const opts = { cwd: project_dir, env, stdio: /** @type {const} */ ('pipe') };
  try {
    const existing = String(
      execFileSync('git', ['config', '--get', 'beads.role'], opts)
    ).trim();
    if (existing) return;
  } catch {
    // Unset, not a work tree, or no git — the write below decides which.
  }
  try {
    execFileSync('git', ['config', 'beads.role', 'maintainer'], opts);
    progress.write(
      'set beads.role=maintainer (bd warns on every run in a git repo without it)\n'
    );
  } catch {
    // Not a git work tree, or no git: bd will not emit the advisory either.
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} board
 * @returns {string}
 */
function formatBoard(db, board) {
  const missing = fs.existsSync(board.board_dir) ? '' : '  \x1b[31m(missing)\x1b[0m';
  const lines = [`\x1b[1m${board.id}\x1b[0m  ${board.name}${missing}`];
  if (board.description) lines.push(`  ${board.description}`);
  lines.push(`  dir:   ${board.board_dir}`);
  if (board.workspace_dir) lines.push(`  proj:  ${board.workspace_dir}`);
  lines.push(`  repos: ${board.repos.length > 0 ? board.repos.join(', ') : '(none)'}`);
  return lines.join('\n');
}

/** @param {any} obj */
const printJson = (obj) => {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
};

function main() {
  const { cmd, args, repos, flags } = parseArgs(process.argv.slice(2));

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      fs
        .readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(2, 40)
        .map((l) => l.replace(/^ \* ?/, '').replace(/^ \*\/$/, ''))
        .join('\n') + '\n'
    );
    return;
  }

  if (cmd === 'path') {
    process.stdout.write(getRegistryPath() + '\n');
    return;
  }

  const db = openRegistry();

  switch (cmd) {
    case 'list': {
      const boards = listBoards(db);
      if (flags.json) {
        process.stdout.write(JSON.stringify({ boards }, null, 2) + '\n');
        return;
      }
      if (boards.length === 0) {
        process.stdout.write(
          `no boards registered (${getRegistryPath()})\n` +
            `  register the current one:  feads-board register <board-dir> --name <name>\n` +
            `  or create a new one:       feads-board create <project-dir> --name <name>\n`
        );
        return;
      }
      process.stdout.write(boards.map((b) => formatBoard(db, b)).join('\n\n') + '\n');
      return;
    }

    case 'show': {
      const id = args[0];
      if (!id) die('show needs a board id');
      const board = getBoard(db, id);
      if (!board) die(`no such board: ${id}`);
      process.stdout.write(
        flags.json
          ? JSON.stringify(board, null, 2) + '\n'
          : formatBoard(db, board) + '\n'
      );
      return;
    }

    case 'register': {
      const dir = args[0];
      if (!dir) die('register needs a board directory (the .beads dir)');
      if (!flags.name) die('register needs --name');
      const board_dir = path.resolve(dir);
      if (!fs.existsSync(board_dir)) die(`no such directory: ${board_dir}`);
      // A registration is a promise that issues filed against this id land in that
      // directory. A directory with no database behind it cannot keep that promise:
      // bd falls back to whatever BEADS_DIR or the cwd resolves to, and the issues
      // appear on some other board. `create` tests the same thing before deciding
      // whether to run bd init; this is the same test, without the init.
      if (!flags.force && !isBoardDir(board_dir)) {
        die(
          `${board_dir} holds no board database (no config.yaml, metadata.json, ` +
            `embeddeddolt/ or *.db)\n` +
            `  create one instead:  feads-board create ${path.dirname(board_dir)} --name ${flags.name}\n` +
            `  or, if you know the database is coming, re-run with --force`
        );
      }
      const board = upsertBoard(db, {
        id: flags.id,
        name: flags.name,
        board_dir,
        // Default the project root to the board dir's parent, which is the
        // convention bd itself establishes (<project>/.beads).
        workspace_dir: flags.workspace || path.dirname(board_dir),
        // Absent means "leave whatever is there", not "clear it": re-registering an
        // already-registered board (a repair, a moved checkout) must not silently
        // erase the description routing scores against. `describe` is how you clear.
        description: flags.description !== undefined ? String(flags.description) : undefined,
        repos
      });
      if (flags.json) {
        printJson({ registered: true, board });
        return;
      }
      process.stdout.write(`registered ${board.id}\n\n${formatBoard(db, board)}\n`);
      return;
    }

    case 'create': {
      const dir = args[0];
      if (!dir) die('create needs a project directory');
      if (!flags.name) die('create needs --name');
      const project_dir = path.resolve(dir);
      fs.mkdirSync(project_dir, { recursive: true });

      const board_dir = path.join(project_dir, '.beads');
      const id = slugify(flags.id || flags.name);

      // Under --json, stdout carries exactly one JSON document, so progress —
      // ours and bd init's — goes to stderr instead of corrupting it.
      const progress = flags.json ? process.stderr : process.stdout;

      // bd aborts if BEADS_DIR points at an existing board, so it must be
      // stripped — otherwise `create` silently refuses inside any session that
      // has a board exported.
      const child_env = { ...process.env };
      delete child_env.BEADS_DIR;
      delete child_env.BEADS_ACTOR;

      // Test for a real board, not merely a directory: beads ships a `.beads/`
      // holding only formulas/, which exists but has no database behind it.
      let initialized = false;
      if (!isBoardDir(board_dir)) {
        const bd = resolveBdBin();
        const prefix = flags.prefix || id.slice(0, 12);
        progress.write(`initializing board in ${project_dir} (prefix ${prefix})\n`);
        try {
          execFileSync(bd, ['init', '--non-interactive', '--prefix', prefix], {
            cwd: project_dir,
            env: child_env,
            stdio: ['ignore', flags.json ? 2 : 'inherit', 'inherit']
          });
        } catch (err) {
          die(`bd init failed in ${project_dir}: ${err.message}`);
        }
        initialized = true;
      } else {
        progress.write(`board already exists at ${board_dir} — registering it\n`);
      }

      // Both paths, deliberately — see the note on the function. The one bd init
      // already handled is not the one that bit us (#feads-r8d).
      provisionBeadsRole(project_dir, child_env, progress);

      const board = upsertBoard(db, {
        id,
        name: flags.name,
        board_dir,
        workspace_dir: project_dir,
        // As in `register`: absent leaves an existing description alone. `create` on
        // a directory that already holds a board is a registration, not a reset.
        description: flags.description !== undefined ? String(flags.description) : undefined,
        repos
      });

      // Postgres-mode wiring (feads): a board the pg store has no row for
      // fails every read loudly (unknown_board), so a *freshly initialized*
      // board — empty by construction — registers its row here, at birth.
      // An *adopted* directory does NOT: its issues live in its Dolt db, and
      // a row without an import would answer "no issues" for a board that
      // has some — a quiet wrong answer. Print the backfill instead (the
      // 2026-07-31 example-project incident, in both directions).
      let pg_store;
      const pg_dsn = String(process.env.FEADS_PG_DSN || '').trim();
      if (pg_dsn) {
        const register_script = path.join(REPO_ROOT, 'pgstore', 'register-board.mjs');
        if (initialized) {
          const prefix = flags.prefix || id.slice(0, 12);
          try {
            const out = execFileSync(
              process.execPath,
              [register_script, '--dsn', pg_dsn, id, '--prefix', prefix],
              { encoding: 'utf8' }
            );
            pg_store = JSON.parse(out);
          } catch (err) {
            // The board exists either way; a failed pg registration must be
            // loud but not fatal — the operator can re-run register-board.mjs.
            pg_store = { registered: false, error: String(err.message || err) };
            progress.write(
              `WARNING: pg store registration failed — run: node ${register_script} --dsn '${pg_dsn}' ${id} --prefix ${prefix}\n`
            );
          }
        } else {
          progress.write(
            `NOTE: pg mode is active and this adopted board's issues live in its Dolt db.\n` +
              `They will NOT appear until backfilled:\n` +
              `  BEADS_DIR=${board_dir} bd --sandbox export > /tmp/${id}.jsonl\n` +
              `  node ${path.join(REPO_ROOT, 'pgstore', 'import-jsonl.mjs')} --dsn '${pg_dsn}' ${id}=/tmp/${id}.jsonl\n`
          );
        }
      }

      if (flags.json) {
        printJson({ created: true, initialized, board, ...(pg_store ? { pg_store } : {}) });
        return;
      }
      process.stdout.write(`\n${formatBoard(db, board)}\n`);
      return;
    }

    case 'describe': {
      const id = args[0];
      if (!id) die('describe needs a board id');
      if (flags.description === undefined && flags.name === undefined)
        die('describe needs --description and/or --name');
      const board = getBoard(db, id);
      if (!board) die(`no such board: ${id}`);
      /** @type {{ board: any, previous: any, changed: boolean }} */
      let result;
      try {
        result = describeBoard(db, {
          id: board.id,
          name: flags.name !== undefined ? String(flags.name) : undefined,
          description:
            flags.description !== undefined ? String(flags.description) : undefined,
          // Opt-in compare-and-set. Absent, this is the old blind overwrite — which
          // is still the right default for a human who just read the board on screen,
          // and is why the refusal below has to be worth reading when it does fire.
          expected_description:
            flags['expect-description'] !== undefined
              ? String(flags['expect-description'])
              : undefined
        });
      } catch (err) {
        if (/** @type {any} */ (err)?.name === 'DescriptionConflictError') {
          // Exit 3 rather than 1 so a caller can branch on "somebody else edited
          // this" without parsing prose, exactly as `route` exits 2 for "no match".
          die(String(/** @type {any} */ (err).message), EXIT_CONFLICT);
        }
        die(String(/** @type {any} */ (err)?.message || err));
        return;
      }
      if (flags.json) {
        // `previous` on every describe, not only on conflict: this is the record
        // that makes an overwrite recoverable from the transcript alone.
        printJson({
          updated: true,
          changed: result.changed,
          previous: result.previous,
          board: result.board
        });
        return;
      }
      process.stdout.write(
        formatBoard(db, result.board) +
          '\n' +
          (result.changed
            ? `\n\x1b[2mreplaced:\x1b[0m ${result.previous.name}\n` +
              `\x1b[2m  ${result.previous.description || '(no description)'}\x1b[0m\n` +
              `\x1b[2m  recover it with: feads-board history ${result.board.id}\x1b[0m\n`
            : '')
      );
      return;
    }

    case 'history': {
      const id = args[0];
      if (!id) die('history needs a board id');
      const board = getBoard(db, id);
      // Deliberately not fatal when the board is gone: `remove` unregisters a board
      // without deleting its history, and "what did that board say?" is a question
      // worth answering after the fact.
      const board_id = board ? board.id : String(id);
      const limit = flags.limit !== undefined ? Number(flags.limit) : undefined;
      const rows = listDescriptionHistory(db, board_id, { limit });
      if (flags.json) {
        printJson({ board_id, history: rows });
        return;
      }
      if (rows.length === 0) {
        process.stdout.write(
          `no description has been replaced on ${board_id}\n` +
            `  history starts the first time one is overwritten\n`
        );
        return;
      }
      process.stdout.write(
        rows
          .map(
            (r) =>
              `\x1b[1m${new Date(r.replaced_at).toISOString()}\x1b[0m` +
              `  ${r.actor || '(unknown actor)'}\n` +
              `  name: ${r.name}\n` +
              `  ${r.description || '(no description)'}`
          )
          .join('\n\n') + '\n'
      );
      return;
    }

    case 'repos': {
      const id = args[0];
      if (!id) die('repos needs a board id');
      if (flags.add && flags.remove) die('pass --add or --remove, not both');
      const board = getBoard(db, id);
      if (!board) die(`no such board: ${id}`);
      if (repos.length === 0) {
        if (flags.json) {
          printJson({ board });
          return;
        }
        process.stdout.write(
          (board.repos.length > 0 ? board.repos.join('\n') : '(none)') + '\n'
        );
        return;
      }
      let removed = 0;
      if (flags.add) addRepos(db, board.id, repos);
      else if (flags.remove) removed = removeRepos(db, board.id, repos);
      else setRepos(db, board.id, repos);
      const updated = getBoard(db, board.id);
      if (flags.json) {
        printJson(
          flags.remove ? { updated: true, removed, board: updated } : { updated: true, board: updated }
        );
        return;
      }
      process.stdout.write(formatBoard(db, updated) + '\n');
      return;
    }

    case 'route': {
      const text = args.join(' ');
      // A task can touch several repos (or none), so pass them all — routing
      // takes the best match rather than summing, so extra repos never inflate.
      const query_repos = repos.length > 0 ? repos : flags.repo ? [flags.repo] : [];
      if (!text && query_repos.length === 0) die('route needs task text and/or --repo');
      const ranked = routeTask(db, { text, repos: query_repos });
      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            {
              query: { text, repos: query_repos },
              candidates: ranked.map((r) => ({
                id: r.board.id,
                name: r.board.name,
                board_dir: r.board.board_dir,
                score: r.score,
                reasons: r.reasons
              }))
            },
            null,
            2
          ) + '\n'
        );
        return;
      }
      if (ranked.length === 0) {
        process.stdout.write(
          'no board matched — add repos or a description so routing has signal:\n' +
            '  feads-board repos <id> --repo owner/name\n' +
            '  feads-board describe <id> --description "..."\n'
        );
        // Exit non-zero so a caller can branch on "unroutable" without parsing text.
        process.exit(2);
      }
      for (const r of ranked) {
        process.stdout.write(
          `\x1b[1m${String(r.score).padStart(4)}\x1b[0m  ${r.board.id}  ${r.board.name}\n` +
            r.reasons.map((x) => `        · ${x}`).join('\n') +
            '\n'
        );
      }
      return;
    }

    case 'remove': {
      const id = args[0];
      if (!id) die('remove needs a board id');
      const board = getBoard(db, id);
      if (!board) die(`no such board: ${id}`);
      removeBoard(db, board.id);
      // Deliberately does not delete the board's database — unregistering is a
      // registry operation, and silently destroying issue data would be a trap.
      if (flags.json) {
        printJson({ removed: true, id: board.id, board_dir: board.board_dir });
        return;
      }
      process.stdout.write(
        `unregistered ${board.id}\n` +
          `  its database is untouched at ${board.board_dir}\n`
      );
      return;
    }

    default:
      die(`unknown command: ${cmd} (try: feads-board help)`);
  }
}

main();
