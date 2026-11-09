#!/usr/bin/env node
/**
 * feads-artifact — attach the files, dirs, repos and PRs a bead is working on, and
 * ask the inverse question: who else is in this path?
 *
 * beads only relates beads to beads. So an agent that claims a bead has nowhere to
 * say "I am editing ui/server/bd.js", and an agent about to edit that file has no
 * way to find out somebody already is. Both halves are here.
 *
 * Refs are repo-relative and identical for every agent — `example-org/feads:ui/
 * server/bd.js`, never `/Users/ana/src/feads/ui/server/bd.js`. A path inside a
 * checkout is converted for you (git toplevel + origin remote), so from inside the
 * repo you can pass the path you were about to edit.
 *
 * Usage:
 *   feads-artifact add <issue> <ref|path>... [--intent editing|reading|planned|done]
 *                                           [--note <text>] [--board <id|dir>]
 *   feads-artifact rm <issue> <ref|path>...  [--board <id|dir>]
 *   feads-artifact list <issue> [--json] [--board <id|dir>]
 *   feads-artifact search <ref|path> [--board <id|dir>] [--include-closed]
 *                                    [--intent <i>] [--json]
 *   feads-artifact respond <ref|path> --mine <issue> --action taking|skipping|waiting
 *                                    [--target <issue>] [--note <text>] [--json]
 *   feads-artifact canon <ref|path>... [--json]
 *
 * Exit status:
 *   0  did the thing / found hits
 *   1  error
 *   2  nothing matched (search found no bead claiming the path — usually the answer
 *      you want, and branchable without parsing output, as with `feads-board route`)
 *
 * Env:
 *   BD_BIN              bd binary (default: ./bd in this repo, then PATH)
 *   BEADS_DIR           board to use when --board is not passed (bd's own rule)
 *   BEADS_ACTOR         recorded as the artifact's actor
 *   FEADS_REGISTRY_DB   registry location (default ~/.feads/registry.db)
 *
 * The grammar, the overlap rules and the comment text live in boards/artifacts.mjs
 * and are shared with the MCP server through boards/artifact-cases.json. Nothing in
 * this file may decide what a ref means.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIONS,
  ACTION_INTENT,
  ACTION_WAITING,
  INTENTS,
  INTENT_EDITING,
  MARKER_KEY,
  artifactsFromMetadata,
  attachPatch,
  detachPatch,
  looksLocal,
  overlap,
  refFromLocalPath,
  resolveRef,
  respondComment,
  sortHits
} from '../boards/artifacts.mjs';
import { getBoard, listBoards, openRegistry } from '../boards/registry.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const die = (msg, hint = '') => {
  process.stderr.write(`feads-artifact: ${msg}\n` + (hint ? `  ${hint}\n` : ''));
  process.exit(1);
};

/** Flags that take no value. Everything else consumes the next argv entry. */
const BOOLEAN_FLAGS = new Set(['json', 'include-closed']);

/**
 * Parse argv into a command, positionals and flags.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const out = { cmd: argv[0] || 'help', args: [], flags: /** @type {Record<string, any>} */ ({}) };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        out.flags[name] = true;
      } else {
        const v = argv[++i];
        if (v === undefined) die(`${a} needs a value`);
        out.flags[name] = v;
      }
    } else {
      out.args.push(a);
    }
  }
  return out;
}

/**
 * Locate bd. Prefer this repo's build: a stale bd on PATH can be behind on schema
 * migrations, and the board it opens is the one the rest of feads is serving.
 *
 * @returns {string}
 */
function resolveBdBin() {
  if (process.env.BD_BIN) return process.env.BD_BIN;
  const local = path.join(REPO_ROOT, 'bd');
  if (fs.existsSync(local)) return local;
  return 'bd';
}

const BD = resolveBdBin();

/**
 * Run bd against one board and return stdout.
 *
 * `board_dir` is stamped onto the child as BEADS_DIR rather than relying on the
 * ambient one, because a cross-board search runs bd once per board in the same
 * process — the UI learned the same lesson (see ui/server/active-board.js): bd reads
 * BEADS_DIR ahead of cwd, so a board you did not stamp is a board you did not query.
 *
 * @param {string[]} args
 * @param {{ board_dir?: string, allow_failure?: boolean }} [options]
 * @returns {string}
 */
function bd(args, options = {}) {
  const env = { ...process.env };
  if (options.board_dir) env.BEADS_DIR = options.board_dir;
  try {
    return execFileSync(BD, args, {
      env,
      encoding: 'utf8',
      // `bd list --limit 0 --json` over a large board is megabytes; the 1 MB default
      // would truncate it into a JSON parse error that looks like corruption.
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    if (options.allow_failure) return '';
    const detail = String(err.stderr || err.message || '').trim();
    die(`bd ${args.join(' ')} failed`, detail.split('\n')[0] || '');
    return '';
  }
}

/**
 * Run bd with --json and parse the result.
 *
 * @param {string[]} args
 * @param {{ board_dir?: string, allow_failure?: boolean }} [options]
 * @returns {any}
 */
function bdJson(args, options = {}) {
  const raw = bd([...args, '--json'], options);
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    if (options.allow_failure) return null;
    die(`bd ${args.join(' ')} did not return JSON`, raw.trim().split('\n')[0]);
    return null;
  }
}

/**
 * Open the registry if there is one.
 *
 * A missing registry is not an error here: this tool needs it only to expand bare
 * repo names and to know which boards to sweep, and a single-board setup that never
 * ran `feads-board register` should still be able to attach artifacts.
 *
 * @returns {import('node:sqlite').DatabaseSync | null}
 */
function openRegistryIfAny() {
  try {
    return openRegistry();
  } catch {
    return null;
  }
}

/**
 * The boards a command should touch.
 *
 * `--board` narrows to one. Otherwise reads sweep **every registered board** and
 * writes go to the ambient one: a path search that skipped the board holding the
 * conflict would answer "nobody is touching this" — the failure this tool exists to
 * prevent — while a write has exactly one correct destination.
 *
 * @param {import('node:sqlite').DatabaseSync | null} db
 * @param {Record<string, any>} flags
 * @returns {Array<{ id: string, dir: string, repos: string[] }>}
 */
function boardsInScope(db, flags) {
  if (flags.board) {
    if (!db) die(`--board ${flags.board} needs a registry`, 'Register boards with feads-board register.');
    const board = getBoard(db, flags.board);
    if (!board) die(`no such board: ${flags.board}`, 'feads-board list shows the registered ones.');
    return [{ id: board.id, dir: board.board_dir, repos: board.repos }];
  }
  const registered = db ? listBoards(db) : [];
  if (registered.length === 0) {
    // No registry: bd still resolves a board from BEADS_DIR or cwd. Passing no
    // board_dir is how we let it.
    return [{ id: '', dir: '', repos: [] }];
  }
  return registered.map((b) => ({ id: b.id, dir: b.board_dir, repos: b.repos }));
}

/**
 * The single board a write goes to: `--board`, else whatever bd resolves on its own.
 *
 * @param {import('node:sqlite').DatabaseSync | null} db
 * @param {Record<string, any>} flags
 * @returns {{ id: string, dir: string, repos: string[] }}
 */
function writeBoard(db, flags) {
  if (flags.board) return boardsInScope(db, flags)[0];
  const ambient = ambientBoardDir();
  if (ambient && db) {
    const board = getBoard(db, ambient);
    if (board) return { id: board.id, dir: board.board_dir, repos: board.repos };
  }
  return { id: '', dir: ambient, repos: [] };
}

/**
 * Every repo any board claims — the vocabulary bare names expand against.
 *
 * @param {import('node:sqlite').DatabaseSync | null} db
 * @returns {string[]}
 */
function allKnownRepos(db) {
  if (!db) return [];
  return Array.from(new Set(listBoards(db).flatMap((b) => b.repos)));
}

/**
 * Run git in a directory, returning '' rather than throwing.
 *
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** @type {string | null} */
let current_repo_cache = null;

/**
 * The repo the caller is standing in, as `owner/name`, or ''.
 *
 * This is the last piece of evidence `resolveRef` uses to decide where the repo
 * ends in `feads/ui/server/bd.js`, so it is worth two git calls — but only once per
 * process, since several refs get resolved per command.
 *
 * @returns {string}
 */
function currentRepo() {
  if (current_repo_cache !== null) return current_repo_cache;
  const toplevel = git(['rev-parse', '--show-toplevel']);
  if (!toplevel) {
    current_repo_cache = '';
    return current_repo_cache;
  }
  const remote = git(['remote', 'get-url', 'origin']);
  try {
    current_repo_cache = refFromLocalPath({ path: toplevel, toplevel, remote }).repo;
  } catch {
    current_repo_cache = '';
  }
  return current_repo_cache;
}

/**
 * Where bd resolves its board on its own — `$BEADS_DIR`, or by walking up from cwd.
 *
 * Needed as a concrete path, not as "whatever bd decides", because `respond` has to
 * know whether a bead it found while sweeping the registry lives on the *same* board
 * as the responder: a dependency can only be added inside one database. Comparing
 * against an unresolved '' would answer "different board" for the common case of
 * both being on the ambient one, and silently degrade waiting to a comment.
 *
 * @returns {string}
 */
function ambientBoardDir() {
  const info = bdJson(['info'], { allow_failure: true });
  let dir = info && info.database_path ? String(info.database_path) : '';
  // database_path names the backend inside the board directory (embeddeddolt/, or a
  // .db file), so climb to the .beads directory that contains it.
  while (dir && path.basename(dir) !== '.beads' && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  return path.basename(dir) === '.beads' ? dir : '';
}

/**
 * Convert a path in this checkout to a ref, or return null if it is not one.
 *
 * @param {string} target path as typed, `~` already expanded
 * @param {boolean} exists whether it is on disk
 * @returns {{ kind: string, repo: string, path?: string, ref: string } | null}
 */
function localRef(target, exists) {
  const abs = path.resolve(target);
  const is_dir = exists ? fs.statSync(abs).isDirectory() : /[/\\]$/.test(target);
  // A file that does not exist yet is a normal thing to claim — you are about to
  // create it — so git is asked about the nearest directory that does.
  let probe = is_dir && exists ? abs : path.dirname(abs);
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const toplevel = git(['-C', probe, 'rev-parse', '--show-toplevel']);
  if (!toplevel) return null;
  const remote = git(['-C', probe, 'remote', 'get-url', 'origin']);
  try {
    return refFromLocalPath({ path: abs, toplevel, remote, is_dir });
  } catch {
    return null;
  }
}

/**
 * Turn one user-supplied ref or checkout path into a canonical ref.
 *
 * Order matters, and it is evidence-ordered rather than convenient:
 *
 *   1. an explicit local path (`./x`, `/x`, `~/x`), or a path that exists here — an
 *      agent naming a file it can see means that file;
 *   2. a ref the registry can resolve — `feads/go.mod` is a ref even though it could
 *      be read as a path, because a registered repo name is hard evidence;
 *   3. failing that, a path whose *first segment* exists here. This is the file an agent
 *      is about to create, which is a completely ordinary thing to claim and would
 *      otherwise be refused as an unresolvable ref. The first segment has to exist so
 *      that a misspelled repo (`feadz/ui/x.js`) still errors instead of being silently
 *      stored as a path in the current repo — a wrong claim nobody would notice.
 *      For a *top-level* file that does not exist yet, write `./newfile.js`; a bare
 *      `newfile.js` is indistinguishable from a bare repo name.
 *
 * @param {string} input
 * @param {{ known_repos: string[], preferred_repos: string[] }} context
 * @returns {{ kind: string, repo: string, path?: string, pr?: number, ref: string }}
 */
function toRef(input, context) {
  const raw = String(input || '').trim();
  const expanded = raw.startsWith('~') ? path.join(process.env.HOME || '', raw.slice(1)) : raw;
  const exists = !/[:#]/.test(raw) && fs.existsSync(expanded);

  if (looksLocal(raw) || exists) {
    const local = localRef(expanded, exists);
    if (local) return local;
    die(
      `${raw} is not inside a git repository`,
      'Artifacts are repo-relative. Pass owner/repo:path for a path outside one.'
    );
  }

  try {
    return resolveRef(raw, {
      known_repos: context.known_repos,
      preferred_repos: context.preferred_repos,
      current_repo: currentRepo()
    });
  } catch (err) {
    const first_segment = raw.split('/')[0];
    if (!/[:#]/.test(raw) && raw.includes('/') && first_segment && fs.existsSync(first_segment)) {
      const local = localRef(expanded, false);
      if (local) return local;
    }
    die(err.message, err.hint || '');
    throw err; // unreachable; keeps the return type honest
  }
}

/**
 * Read one bead, with its metadata.
 *
 * @param {string} issue_id
 * @param {string} board_dir
 * @returns {any}
 */
function showIssue(issue_id, board_dir) {
  const result = bdJson(['show', issue_id], { board_dir });
  const issue = Array.isArray(result) ? result[0] : result;
  if (!issue || !issue.id) die(`no bead found matching ${issue_id}`);
  return issue;
}

/**
 * Every bead on a board that carries artifacts.
 *
 * The marker key is what keeps this proportional to the beads that have artifacts
 * rather than to the whole board, and `--limit 0` is load-bearing: bd defaults to 50
 * rows, which would silently answer "no conflict" on a busy board.
 *
 * @param {string} board_dir
 * @param {boolean} include_closed
 * @returns {any[]}
 */
function beadsWithArtifacts(board_dir, include_closed) {
  const args = ['list', '--limit', '0', '--has-metadata-key', MARKER_KEY];
  if (include_closed) args.push('--all');
  const rows = bdJson(args, { board_dir, allow_failure: true });
  return Array.isArray(rows) ? rows : [];
}

/**
 * Find every bead whose artifacts overlap a ref.
 *
 * @param {{ ref: string }} query
 * @param {Array<{ id: string, dir: string }>} boards
 * @param {{ include_closed?: boolean, intent?: string, exclude?: string }} [options]
 * @returns {Array<any>}
 */
function searchHits(query, boards, options = {}) {
  const hits = [];
  for (const board of boards) {
    for (const issue of beadsWithArtifacts(board.dir, Boolean(options.include_closed))) {
      if (options.exclude && issue.id === options.exclude) continue;
      for (const artifact of artifactsFromMetadata(issue.metadata)) {
        if (options.intent && artifact.intent !== options.intent) continue;
        const relation = overlap(query.ref, artifact.ref);
        if (!relation) continue;
        hits.push({
          board: board.id,
          board_dir: board.dir,
          issue_id: issue.id,
          title: issue.title || '',
          status: issue.status || '',
          assignee: issue.assignee || '',
          relation,
          artifact
        });
      }
    }
  }
  return sortHits(hits);
}

/**
 * @param {any[]} artifacts
 * @returns {string}
 */
function formatArtifacts(artifacts) {
  if (artifacts.length === 0) return '  (no artifacts)\n';
  return artifacts
    .map((a) => {
      const meta = [a.actor, a.at].filter(Boolean).join(' · ');
      return (
        `  \x1b[1m${a.intent.padEnd(8)}\x1b[0m ${a.ref}\n` +
        (meta ? `           ${meta}\n` : '') +
        (a.note ? `           note: ${a.note}\n` : '')
      );
    })
    .join('');
}

/**
 * @param {any[]} hits
 * @returns {string}
 */
function formatHits(hits) {
  return hits
    .map((h) => {
      const where = [h.board ? `board ${h.board}` : '', h.assignee ? `@${h.assignee}` : '']
        .filter(Boolean)
        .join(' · ');
      return (
        `  \x1b[1m${h.artifact.intent.padEnd(8)}\x1b[0m ${h.relation.padEnd(7)} ` +
        `${h.issue_id}  ${h.status}  ${h.title}\n` +
        `           ${h.artifact.ref}${where ? ` · ${where}` : ''}\n` +
        (h.artifact.note ? `           note: ${h.artifact.note}\n` : '')
      );
    })
    .join('');
}

const HELP = `feads-artifact — what a bead is working on, and who else is in this path

  add <issue> <ref|path>...      attach artifacts to a bead
      --intent ${INTENTS.join('|')}
      --note <text>              why this bead touches it
  rm <issue> <ref|path>...       detach
  list <issue>                   what this bead is working on
  search <ref|path>              which beads claim this path (exit 2 if none)
      --include-closed           include closed beads
      --intent <i>               only this intent
  respond <ref|path> --mine <issue> --action ${ACTIONS.join('|')}
      --target <issue>           answer one bead instead of every overlap
      --note <text>
  canon <ref|path>...            show the canonical ref for a path

  --board <id|dir>  one board instead of the ambient one (writes) or all (reads)
  --json            machine-readable output

A ref names the repo, not your checkout: example-org/feads:ui/server/bd.js.
Directories end in a slash and cover their subtree; PRs are owner/repo#N. Paths
inside a git checkout are converted for you, including a file you are about to
create — write ./newfile.js for a new top-level one, since a bare newfile.js
reads as a repo name.
`;

function main() {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));
  if (cmd === 'help' || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  const db = openRegistryIfAny();
  const known_repos = allKnownRepos(db);
  const actor = process.env.BEADS_ACTOR || '';

  switch (cmd) {
    case 'canon': {
      if (args.length === 0) die('canon needs a ref or path');
      const board = writeBoard(db, flags);
      const refs = args.map((a) => toRef(a, { known_repos, preferred_repos: board.repos }));
      if (flags.json) {
        process.stdout.write(JSON.stringify({ refs }, null, 2) + '\n');
        return;
      }
      for (const r of refs) process.stdout.write(`${r.kind.padEnd(5)} ${r.ref}\n`);
      return;
    }

    case 'add': {
      const [issue_id, ...inputs] = args;
      if (!issue_id) die('add needs a bead id');
      if (inputs.length === 0) die('add needs at least one ref or path');
      const intent = String(flags.intent || INTENT_EDITING);
      if (!INTENTS.includes(intent)) die(`unknown --intent ${intent}`, `Intents: ${INTENTS.join(', ')}`);

      const board = writeBoard(db, flags);
      const refs = inputs.map((a) => toRef(a, { known_repos, preferred_repos: board.repos }));

      // One update for every ref: bd merges metadata inside the transaction, so this
      // is a single commit and a single audit entry rather than one per file.
      const patch = attachPatch(refs.map((r) => ({ ref: r.ref, intent, note: flags.note, actor })));
      bd(['update', issue_id, '--metadata', JSON.stringify(patch)], { board_dir: board.dir });

      // The whole point is coordination, so say who else is there — unprompted, and in
      // both output modes. A collision an agent has to run a second command to discover
      // is a collision it will not look for.
      const boards = boardsInScope(db, flags.board ? flags : {});
      const conflicts = refs.flatMap((r) =>
        searchHits(r, boards, { exclude: issue_id }).filter((h) => h.artifact.intent !== 'done')
      );

      if (flags.json) {
        // Same shape as the MCP artifact_add payload, so an agent reading either surface
        // does not need two parsers.
        process.stdout.write(
          JSON.stringify(
            {
              issue: issue_id,
              intent,
              attached: refs.map((r) => r.ref),
              board: board.id,
              others_claiming: conflicts
            },
            null,
            2
          ) + '\n'
        );
        return;
      }
      process.stdout.write(
        `${issue_id} is ${intent}:\n` + refs.map((r) => `  ${r.ref}\n`).join('')
      );
      if (conflicts.length > 0) {
        process.stdout.write(
          `\n\x1b[1m${conflicts.length} other ${conflicts.length === 1 ? 'bead claims' : 'beads claim'} this\x1b[0m\n` +
            formatHits(conflicts) +
            `  answer one with: feads-artifact respond <ref> --mine ${issue_id} --action taking|skipping|waiting\n`
        );
      }
      return;
    }

    case 'rm': {
      const [issue_id, ...inputs] = args;
      if (!issue_id) die('rm needs a bead id');
      if (inputs.length === 0) die('rm needs at least one ref or path');
      const board = writeBoard(db, flags);
      const refs = inputs.map((a) => toRef(a, { known_repos, preferred_repos: board.repos }));
      // Releasing writes a null over the key rather than unsetting it: bd's
      // --unset-metadata validates keys against a pattern that rejects the dashes and
      // colons refs are made of, and a null reads as released everywhere. The
      // has_artifacts marker is deliberately left set — see MARKER_KEY in
      // boards/artifacts.mjs. A stale marker costs one filtered row; clearing it
      // races a concurrent attach and would hide that bead from every search.
      const patch = detachPatch(refs.map((r) => r.ref));
      bd(['update', issue_id, '--metadata', JSON.stringify(patch)], { board_dir: board.dir });
      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            { issue: issue_id, detached: refs.map((r) => r.ref), board: board.id },
            null,
            2
          ) + '\n'
        );
        return;
      }
      process.stdout.write(`${issue_id} released:\n` + refs.map((r) => `  ${r.ref}\n`).join(''));
      return;
    }

    case 'list': {
      const [issue_id] = args;
      if (!issue_id) die('list needs a bead id');
      const board = writeBoard(db, flags);
      const issue = showIssue(issue_id, board.dir);
      const artifacts = artifactsFromMetadata(issue.metadata);
      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            {
              issue: issue.id,
              title: issue.title || '',
              status: issue.status || '',
              board: board.id,
              artifacts,
              count: artifacts.length
            },
            null,
            2
          ) + '\n'
        );
        return;
      }
      process.stdout.write(`\x1b[1m${issue.id}\x1b[0m  ${issue.status}  ${issue.title}\n`);
      process.stdout.write(formatArtifacts(artifacts));
      return;
    }

    case 'search': {
      const [input] = args;
      if (!input) die('search needs a ref or path');
      const boards = boardsInScope(db, flags);
      const preferred = boards.length === 1 ? boards[0].repos : [];
      const query = toRef(input, { known_repos, preferred_repos: preferred });
      const intent = flags.intent ? String(flags.intent) : '';
      if (intent && !INTENTS.includes(intent)) {
        die(`unknown --intent ${intent}`, `Intents: ${INTENTS.join(', ')}`);
      }
      const hits = searchHits(query, boards, {
        include_closed: Boolean(flags['include-closed']),
        intent
      });
      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            {
              query: query.ref,
              kind: query.kind,
              boards_searched: boards.map((b) => b.id || b.dir || '(ambient)'),
              hits,
              count: hits.length
            },
            null,
            2
          ) + '\n'
        );
      } else if (hits.length === 0) {
        process.stdout.write(`no bead claims ${query.ref}\n`);
      } else {
        process.stdout.write(
          `\x1b[1m${hits.length}\x1b[0m ${hits.length === 1 ? 'claim' : 'claims'} on ${query.ref}\n` +
            formatHits(hits)
        );
      }
      // Exit 2 for "nothing matched", as `feads-board route` does, so a caller can
      // branch on a free path without parsing output.
      if (hits.length === 0) process.exit(2);
      return;
    }

    case 'respond': {
      const [input] = args;
      const mine = flags.mine ? String(flags.mine) : '';
      const action = String(flags.action || '');
      if (!input) die('respond needs a ref or path');
      if (!mine) die('respond needs --mine <issue>', 'It records which bead is answering.');
      if (!ACTIONS.includes(action)) die(`--action must be one of ${ACTIONS.join(', ')}`);

      const my_board = writeBoard(db, flags);
      const my_issue = showIssue(mine, my_board.dir);
      const query = toRef(input, { known_repos, preferred_repos: my_board.repos });

      // Targets are read across every board (a path can be claimed anywhere), but a
      // dependency can only be added inside one database — boards are isolated.
      const boards = boardsInScope(db, flags.board ? flags : {});
      const all_hits = searchHits(query, boards, { exclude: my_issue.id });
      const hits = flags.target ? all_hits.filter((h) => h.issue_id === String(flags.target)) : all_hits;
      if (flags.target && hits.length === 0) {
        die(
          `${flags.target} does not claim ${query.ref}`,
          'Run feads-artifact search first, or drop --target to answer every overlap.'
        );
      }

      // Record our own stance before telling anyone: a comment claiming we are taking
      // a file, with nothing on our bead to show it, is worse than no comment.
      const own_intent = ACTION_INTENT[action];
      if (own_intent) {
        const patch = attachPatch([{ ref: query.ref, intent: own_intent, note: flags.note, actor }]);
        bd(['update', my_issue.id, '--metadata', JSON.stringify(patch)], { board_dir: my_board.dir });
      }

      const answered = [];
      const seen = new Set();
      for (const hit of hits) {
        if (seen.has(hit.issue_id)) continue; // one comment per bead, not per artifact
        seen.add(hit.issue_id);

        // Waiting means blocked, and blocked has a first-class representation: a real
        // dependency, so `bd ready` stops offering our bead. Only possible within one
        // board — cross-board, the comment is the whole of it.
        let dep_added = false;
        const same_board = hit.board_dir === my_board.dir || (!hit.board_dir && !my_board.dir);
        if (action === ACTION_WAITING && same_board) {
          bd(['dep', 'add', my_issue.id, hit.issue_id, '--type', 'blocks'], { board_dir: my_board.dir });
          dep_added = true;
        }

        const text = respondComment({
          mine: my_issue.id,
          action,
          ref: query.ref,
          attached_ref: hit.artifact.ref,
          attached_intent: hit.artifact.intent,
          note: flags.note,
          target: hit.issue_id,
          dep_added
        });
        bd(['comment', hit.issue_id, text], { board_dir: hit.board_dir });
        answered.push({ issue_id: hit.issue_id, board: hit.board, dep_added, comment: text });
      }

      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            { mine: my_issue.id, action, ref: query.ref, recorded_intent: own_intent, answered },
            null,
            2
          ) + '\n'
        );
        return;
      }
      if (own_intent) process.stdout.write(`${my_issue.id} is ${own_intent} ${query.ref}\n`);
      if (answered.length === 0) {
        process.stdout.write(`no bead claims ${query.ref} — nobody to tell\n`);
        return;
      }
      for (const a of answered) {
        process.stdout.write(
          `  commented on ${a.issue_id}${a.board ? ` (board ${a.board})` : ''}` +
            `${a.dep_added ? `, ${my_issue.id} now blocked by it` : ''}\n`
        );
      }
      if (action === ACTION_WAITING && answered.some((a) => !a.dep_added)) {
        process.stdout.write(
          '  note: no dependency added across boards — beads are per-board, so the comment is the record\n'
        );
      }
      return;
    }

    default:
      die(`unknown command: ${cmd} (try: feads-artifact help)`);
  }
}

main();
