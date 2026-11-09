/**
 * Artifacts — the files, directories, repos and pull requests a bead is working on.
 *
 * beads can only express bead → bead dependencies. So an agent that has claimed a
 * bead has nowhere to record *what it is touching*, and no way to ask the inverse
 * question — "who else is in this file?" — which is the one that prevents two
 * agents editing the same lines and discovering it at merge time.
 *
 * An **artifact** is one such surface, attached to one bead:
 *
 * ```
 * repo   example-org/feads                     the whole repository
 * file   example-org/feads:ui/server/bd.js     one file
 * dir    example-org/feads:ui/server/          a subtree (trailing slash)
 * pr     example-org/feads#4141                a pull request
 * ```
 *
 * ## Why the ref is repo-relative and lowercased
 *
 * The ref is the join key: an agent searching for a path finds the beads holding
 * artifacts that overlap it, and that only works if every agent spells the same
 * file the same way. Absolute paths cannot — `/Users/ana/src/feads/ui/server/bd.js`
 * and `/home/bo/work/feads/ui/server/bd.js` are the same file and would never
 * match. So a ref names the repo, never the checkout, and `resolveRef` turns a
 * local path into one.
 *
 * The repo half is lowercased for the same reason (GitHub treats `example-org`
 * and `example-org` as one repo, and two spellings here would be two keys, i.e. a
 * missed collision). The path half is *not*: paths are case-sensitive on Linux,
 * where the work actually builds.
 *
 * ## Why one metadata key per artifact
 *
 * Artifacts live in the bead's own metadata under `artifact:<ref>` — one top-level
 * key each — plus a `has_artifacts` marker. Not a single `artifacts: [...]` list,
 * which is the obvious shape and is wrong: `bd update --metadata` merges shallowly
 * *inside the transaction*, so distinct top-level keys from two concurrent agents
 * both survive, while a list makes every attach a read-modify-write and silently
 * drops one of them. Concurrency is the whole point of the feature; a storage shape
 * that loses one of two simultaneous attachments defeats it. Verified against the
 * embedded Dolt backend, not assumed.
 *
 * That storage choice also means an artifact travels with its bead through
 * `bd dolt push`/`pull` like any other field — no second database to sync, and
 * nothing to reconcile.
 *
 * ## Parity
 *
 * Everything in this file that is pure is mirrored in
 * `integrations/beads-mcp/src/beads_mcp/artifacts.py`, because the MCP server is
 * Python and cannot call into Node per tool call. As with routing and authz, the
 * fixture is the contract: **`boards/artifact-cases.json`** is asserted by both
 * `boards/artifacts.test.mjs` and `integrations/beads-mcp/tests/test_artifact_parity.py`.
 * Two canonicalizers that disagree produce two keys for one file, which reads as
 * "nobody else is touching this" — the exact wrong answer, arrived at silently. If
 * you change a rule here, change the fixture and the Python twin in the same commit.
 *
 * bd itself is never invoked from this module; reading and writing beads belongs to
 * the surfaces (`scripts/feads-artifact.mjs`, and the MCP tools on the Python side).
 */

/**
 * A ref decomposed into its parts, plus its canonical spelling. `path` is set for
 * `file`/`dir`, `pr` for `pr`, neither for `repo`.
 *
 * @typedef {{ kind: string, repo: string, path?: string, pr?: number, ref?: string }} ArtifactRef
 */

/** Artifact kinds. `dir` is a subtree, written with a trailing slash. */
export const KIND_REPO = 'repo';
export const KIND_FILE = 'file';
export const KIND_DIR = 'dir';
export const KIND_PR = 'pr';

/** @type {readonly string[]} */
export const KINDS = [KIND_REPO, KIND_FILE, KIND_DIR, KIND_PR];

/**
 * What a bead is doing to an artifact.
 *
 * `editing` is the only one that conflicts with another `editing`; the rest are
 * declarations of interest. Kept deliberately short — a vocabulary an agent has to
 * think about is a vocabulary it will use inconsistently.
 */
export const INTENT_EDITING = 'editing';
export const INTENT_READING = 'reading';
export const INTENT_PLANNED = 'planned';
export const INTENT_DONE = 'done';

/** @type {readonly string[]} */
export const INTENTS = [INTENT_EDITING, INTENT_READING, INTENT_PLANNED, INTENT_DONE];

/**
 * Conflict ordering for search results: an `editing` overlap is what an agent
 * needs to see first, and a `done` one is history.
 *
 * @type {Record<string, number>}
 */
const INTENT_RANK = {
  [INTENT_EDITING]: 0,
  [INTENT_PLANNED]: 1,
  [INTENT_READING]: 2,
  [INTENT_DONE]: 3
};

/** How a responder answers an overlap. */
export const ACTION_TAKING = 'taking';
export const ACTION_SKIPPING = 'skipping';
export const ACTION_WAITING = 'waiting';

/** @type {readonly string[]} */
export const ACTIONS = [ACTION_TAKING, ACTION_SKIPPING, ACTION_WAITING];

/**
 * The intent a responder records on its *own* bead for each action. `skipping`
 * records nothing: an agent that has decided not to touch a file has no business
 * claiming it, and a stale `skipping` marker would read as interest forever.
 *
 * @type {Record<string, string | null>}
 */
export const ACTION_INTENT = {
  [ACTION_TAKING]: INTENT_EDITING,
  [ACTION_SKIPPING]: null,
  [ACTION_WAITING]: INTENT_PLANNED
};

/** Metadata key prefix for one artifact. */
export const METADATA_PREFIX = 'artifact:';

/**
 * Marker key that makes a cross-board scan proportional to the beads that have
 * artifacts rather than to every bead on every board (`bd list --has-metadata-key`).
 *
 * It is **set on attach and never cleared**, including when the last artifact is
 * removed. That asymmetry is deliberate: clearing it requires knowing no other
 * artifact keys remain, which races an attach on another key and would leave a bead
 * holding artifacts that the scan filters out. A stale marker costs one row that
 * decodes to zero artifacts and is dropped; a missing one costs a missed collision.
 */
export const MARKER_KEY = 'has_artifacts';

/** Relations between a queried ref and an attached one. See {@link overlap}. */
export const REL_EXACT = 'exact';
export const REL_INSIDE = 'inside';
export const REL_COVERS = 'covers';

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const PR_NUMBER = /^[1-9][0-9]*$/;

/**
 * A ref that cannot be parsed, carrying a hint an agent can act on. Bad refs are
 * the common failure here — an agent pastes a checkout path, or a repo it never
 * registered — so the message has to say what to type instead.
 */
export class ArtifactRefError extends Error {
  /**
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(message, hint = '') {
    super(message);
    this.name = 'ArtifactRefError';
    this.hint = hint;
  }
}

/**
 * Normalize a repo-relative path: `/` separators, no leading slash or `./`, `.`
 * and `..` segments resolved, duplicate slashes collapsed.
 *
 * A trailing slash is meaningful and preserved — it is what distinguishes a
 * subtree from a file, and the subtree is what makes "somebody owns this whole
 * directory" expressible.
 *
 * @param {string} input
 * @returns {{ path: string, is_dir: boolean }}
 */
export function normalizeArtifactPath(input) {
  const raw = String(input == null ? '' : input).replace(/\\/g, '/');
  const wants_dir = /\/\s*$/.test(raw);
  const parts = [];
  for (const seg of raw.split('/')) {
    const s = seg.trim();
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (parts.length === 0) {
        throw new ArtifactRefError(
          `path escapes the repository root: ${input}`,
          'A ref is relative to the repo root, so it can never start above it.'
        );
      }
      parts.pop();
      continue;
    }
    parts.push(s);
  }
  if (parts.length === 0) {
    // `owner/repo:` and `owner/repo:/` both mean the repository itself, which has
    // its own kind. Refusing here keeps one surface from having two spellings.
    throw new ArtifactRefError(
      `empty path in ref: ${input}`,
      'Drop the colon to name the whole repo: owner/repo'
    );
  }
  return { path: parts.join('/') + (wants_dir ? '/' : ''), is_dir: wants_dir };
}

/**
 * Normalize the repo half of a ref. Lowercased; `owner/name` or a bare `name`.
 *
 * A bare name is legal rather than an error. It is what agents and humans both
 * say, it is still identical across checkouts (which is the property that matters),
 * and {@link expandRepo} upgrades it to `owner/name` whenever the registry knows
 * one. Rejecting it would push agents towards the absolute paths this exists to
 * replace.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeRepo(input) {
  const raw = String(input == null ? '' : input).trim().replace(/\.git$/i, '');
  const segments = raw.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new ArtifactRefError('missing repo in ref', 'Refs start with a repo: owner/name');
  }
  if (segments.length > 2) {
    throw new ArtifactRefError(
      `repo has too many segments: ${raw}`,
      'A repo is owner/name; separate a path with a colon — owner/name:path/to/file'
    );
  }
  for (const s of segments) {
    if (!REPO_SEGMENT.test(s)) {
      throw new ArtifactRefError(
        `invalid character in repo: ${raw}`,
        'Repo segments may hold letters, digits, dot, dash and underscore.'
      );
    }
  }
  return segments.join('/').toLowerCase();
}

/**
 * Parse a repo-qualified ref into its canonical form.
 *
 * Pure: no filesystem, no registry, no git. `resolveRef` is the layer that adds
 * those, so this function is the one the parity fixture can pin exactly.
 *
 * Accepts `owner/repo`, `owner/repo:path`, `owner/repo:path/`, `owner/repo#123`
 * and their bare-name equivalents.
 *
 * @param {string} input
 * @returns {{ kind: string, repo: string, path?: string, pr?: number, ref: string }}
 */
export function parseRef(input) {
  const raw = String(input == null ? '' : input).trim();
  if (raw === '') {
    throw new ArtifactRefError('empty ref', 'Pass owner/repo, owner/repo:path or owner/repo#123');
  }

  const hash = raw.indexOf('#');
  if (hash >= 0) {
    const repo = normalizeRepo(raw.slice(0, hash));
    const number = raw.slice(hash + 1).trim();
    if (!PR_NUMBER.test(number)) {
      throw new ArtifactRefError(
        `invalid pull request number: ${raw}`,
        'A PR ref is owner/repo#N, where N is a positive integer.'
      );
    }
    return { kind: KIND_PR, repo, pr: Number(number), ref: `${repo}#${number}` };
  }

  const colon = raw.indexOf(':');
  if (colon >= 0) {
    const repo = normalizeRepo(raw.slice(0, colon));
    const { path, is_dir } = normalizeArtifactPath(raw.slice(colon + 1));
    return {
      kind: is_dir ? KIND_DIR : KIND_FILE,
      repo,
      path,
      ref: `${repo}:${path}`
    };
  }

  const repo = normalizeRepo(raw);
  return { kind: KIND_REPO, repo, ref: repo };
}

/**
 * Render a parsed artifact back to its canonical ref. Round-trips with
 * {@link parseRef}; the fixture asserts it.
 *
 * @param {{ kind: string, repo: string, path?: string, pr?: number }} parts
 * @returns {string}
 */
export function formatRef(parts) {
  const repo = normalizeRepo(parts.repo);
  switch (parts.kind) {
    case KIND_REPO:
      return repo;
    case KIND_PR:
      if (!PR_NUMBER.test(String(parts.pr))) {
        throw new ArtifactRefError(`invalid pull request number: ${parts.pr}`);
      }
      return `${repo}#${parts.pr}`;
    case KIND_FILE:
    case KIND_DIR: {
      const { path, is_dir } = normalizeArtifactPath(String(parts.path || ''));
      const want_dir = parts.kind === KIND_DIR;
      const bare = is_dir ? path.slice(0, -1) : path;
      return `${repo}:${bare}${want_dir ? '/' : ''}`;
    }
    default:
      throw new ArtifactRefError(`unknown artifact kind: ${parts.kind}`, `Kinds: ${KINDS.join(', ')}`);
  }
}

/**
 * Expand a bare repo name against the repos the registry knows about.
 *
 * Case-insensitive, and matches either a full `owner/name` or the name half of
 * one. An ambiguous bare name is an error rather than a guess: silently picking
 * one of two owners would attach the artifact to a file in the wrong repository,
 * and nothing downstream could notice.
 *
 * @param {string} repo bare name or `owner/name`
 * @param {string[]} known_repos e.g. every `board_repos` row
 * @returns {{ repo: string, matched: boolean, candidates: string[] }}
 */
export function expandRepo(repo, known_repos = []) {
  const want = normalizeRepo(repo);
  const known = Array.from(
    new Set((known_repos || []).map((r) => String(r || '').trim().toLowerCase()).filter(Boolean))
  ).sort();
  if (want.includes('/')) {
    return { repo: want, matched: known.includes(want), candidates: [] };
  }
  const candidates = known.filter((r) => r === want || r.split('/').pop() === want);
  if (candidates.length === 1) {
    return { repo: candidates[0], matched: true, candidates: [] };
  }
  if (candidates.length > 1) {
    throw new ArtifactRefError(
      `ambiguous repo name: ${want}`,
      `Registered as ${candidates.join(' and ')} — name the owner.`
    );
  }
  return { repo: want, matched: false, candidates: [] };
}

/**
 * Parse `owner/name` out of a git remote URL (ssh, https, git or scp form).
 *
 * This is how a local checkout becomes a shared ref, so it is pure and
 * fixture-pinned rather than a regex written twice.
 *
 * @param {string} url
 * @returns {string | null} normalized `owner/name`, or null if unrecognizable
 */
export function parseRemoteUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  if (raw === '') return null;
  // A path-shaped remote (a bare mirror on disk, or file://) has no owner to
  // report. Taking its last two directories would invent one — `/srv/git/mirrors/
  // feads.git` is not `mirrors/feads` — so say nothing and let the caller fall back
  // to the checkout's name.
  if (/^file:/i.test(raw) || raw.startsWith('/') || raw.startsWith('.') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return null;
  }
  // Strip scheme and any credentials, then the host, leaving owner/name[/...].
  let rest = raw
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]*@/, '');
  const scp = rest.indexOf(':');
  const slash = rest.indexOf('/');
  if (scp >= 0 && (slash < 0 || scp < slash)) {
    rest = rest.slice(scp + 1); // git@github.com:owner/name.git
  } else if (slash >= 0) {
    rest = rest.slice(slash + 1); // https://github.com/owner/name.git
  } else {
    return null;
  }
  const segments = rest
    .replace(/\.git$/i, '')
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  try {
    // Some hosts nest groups (gitlab.com/group/sub/name); the last two segments
    // are the ones GitHub-style refs mean by owner/name.
    return normalizeRepo(segments.slice(-2).join('/'));
  } catch {
    return null;
  }
}

/**
 * Whether a string looks like a path on this machine rather than a ref.
 *
 * Refs are repo-qualified and use `:`/`#`; a checkout path is what an agent
 * reaches for by reflex. Detecting it (rather than failing) is what lets
 * `resolveRef` do the conversion the agent forgot.
 *
 * @param {string} input
 * @returns {boolean}
 */
export function looksLocal(input) {
  const raw = String(input == null ? '' : input).trim();
  if (raw === '') return false;
  if (raw.startsWith('/') || raw.startsWith('~')) return true;
  if (raw.startsWith('./') || raw.startsWith('../')) return true;
  return /^[a-zA-Z]:[\\/]/.test(raw); // C:\src\feads\...
}

/**
 * Resolve a ref an agent typed into a canonical one, using what the registry
 * knows and (optionally) which repo the caller is standing in.
 *
 * The hard case is the slash-only form. `owner/repo:path` is unambiguous, but
 * agents write `feads/ui/server/bd.js` — and that has two readings, repo
 * `feads/ui` plus path `server/bd.js`, or bare repo `feads` plus path
 * `ui/server/bd.js`. They produce different keys for one file, so guessing wrong
 * is not a cosmetic error: it is a collision that never gets reported. The order
 * below resolves it from evidence, and refuses when there is none:
 *
 *   1. the whole string is a repo the registry knows           → that repo
 *   2. its first two segments are a repo the registry knows    → repo + path
 *   3. its first segment expands to one registered repo        → repo + path
 *   4. its first segment is the repo the caller is standing in → repo + path
 *   5. exactly two segments and nothing above matched          → owner/repo
 *   6. otherwise                                              → error with both
 *      spellings, so the agent can say which it meant
 *
 * Rule 3 sitting above rule 5 is what makes `feads/go.mod` a file rather than a
 * repository called `feads/go.mod`: a registered repo name in the first segment is
 * evidence, and a top-level file is exactly where the two readings collide.
 *
 * `preferred_repos` (the repos of the board being written to) are consulted before
 * `known_repos` (every registered repo). The union is what makes a bare name
 * expandable at all, but it is also what makes it ambiguous — two boards can each
 * own a `feads` — and the board an agent is actually filing against is the better
 * evidence when they disagree.
 *
 * Pure — `current_repo` is passed in rather than read from git here, so the whole
 * decision procedure is fixture-pinned. Local checkout paths are the caller's job
 * to convert first (see {@link looksLocal} and {@link refFromLocalPath}).
 *
 * @param {string} input
 * @param {{ known_repos?: string[], preferred_repos?: string[], current_repo?: string }} [options]
 * @returns {{ kind: string, repo: string, path?: string, pr?: number, ref: string }}
 */
export function resolveRef(input, options = {}) {
  const raw = String(input == null ? '' : input).trim();
  const known_repos = options.known_repos || [];
  const preferred_repos = options.preferred_repos || [];
  const current_repo = options.current_repo ? normalizeRepo(options.current_repo) : '';

  /**
   * Expand a repo against the board's own repos first, then every registered one.
   *
   * @param {string} candidate
   * @returns {{ repo: string, matched: boolean, candidates: string[] }}
   */
  const expand = (candidate) => {
    const scoped = expandRepo(candidate, preferred_repos);
    return scoped.matched ? scoped : expandRepo(candidate, known_repos);
  };

  if (raw === '') {
    throw new ArtifactRefError('empty ref', 'Pass owner/repo, owner/repo:path or owner/repo#123');
  }
  if (looksLocal(raw)) {
    throw new ArtifactRefError(
      `${raw} is a path on this machine, not a ref`,
      'Refs name the repo, not the checkout, so they match across machines. ' +
        'Run this from inside the repo and the path will be converted, or pass owner/repo:path.'
    );
  }

  if (/[:#]/.test(raw)) {
    const parsed = parseRef(raw);
    const parts = { ...parsed, repo: expand(parsed.repo).repo };
    return { ...parts, ref: formatRef(parts) };
  }

  const segments = raw.split('/').filter((s) => s.length > 0);
  // Splitting drops the empty trailing segment, and with it the one thing that
  // distinguishes a subtree from a file. Carry it separately.
  const dir_suffix = /\/$/.test(raw) ? '/' : '';
  /** @param {string} candidate */
  const is_known = (candidate) => {
    try {
      return expand(candidate).matched;
    } catch {
      return false; // ambiguous bare name: not evidence, fall through
    }
  };

  if (segments.length <= 2 && is_known(raw)) {
    const repo = expand(raw).repo;
    return { kind: KIND_REPO, repo, ref: repo };
  }
  if (segments.length >= 2) {
    const first_two = segments.slice(0, 2).join('/');
    if (segments.length > 2 && is_known(first_two)) {
      return parseRef(`${expand(first_two).repo}:${segments.slice(2).join('/')}${dir_suffix}`);
    }
    if (is_known(segments[0])) {
      return parseRef(`${expand(segments[0]).repo}:${segments.slice(1).join('/')}${dir_suffix}`);
    }
    if (current_repo && current_repo.split('/').pop() === segments[0].toLowerCase()) {
      return parseRef(`${current_repo}:${segments.slice(1).join('/')}${dir_suffix}`);
    }
    if (segments.length === 2) {
      const repo = normalizeRepo(raw);
      return { kind: KIND_REPO, repo, ref: repo };
    }
    throw new ArtifactRefError(
      `cannot tell where the repo ends in ${raw}`,
      `Use a colon: ${first_two}:${segments.slice(2).join('/')} ` +
        `or ${segments[0]}:${segments.slice(1).join('/')}`
    );
  }
  const repo = expand(raw).repo;
  return { kind: KIND_REPO, repo, ref: repo };
}

/**
 * Turn a path inside a checkout into a ref, given that checkout's git facts.
 *
 * Pure, and separate from running git, because the interesting failure is not
 * "git errored" — it is a repo with no usable remote, where the honest answer is a
 * bare-name ref (`feads:ui/server/bd.js`) rather than a checkout path. A bare name
 * is still the same string for every agent working that repo, which is all the join
 * key needs.
 *
 * @param {{ path: string, toplevel: string, remote?: string, repo_hint?: string,
 *           is_dir?: boolean }} input
 *   `path` and `toplevel` are absolute; `remote` is the origin URL if any;
 *   `repo_hint` names the repo when there is no remote (usually the toplevel's
 *   directory name).
 * @returns {{ kind: string, repo: string, path?: string, ref: string }}
 */
export function refFromLocalPath(input) {
  /** @param {string} value */
  const to_posix = (value) => String(value == null ? '' : value).replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = to_posix(input.path);
  const top = to_posix(input.toplevel);
  if (top === '') {
    throw new ArtifactRefError(
      `${input.path} is not inside a git repository`,
      'Artifacts are repo-relative. Pass owner/repo:path explicitly for a path outside one.'
    );
  }
  if (abs !== top && !abs.startsWith(top + '/')) {
    throw new ArtifactRefError(
      `${input.path} is outside ${input.toplevel}`,
      'Pass a path inside the repository, or name the ref explicitly.'
    );
  }

  const from_remote = input.remote ? parseRemoteUrl(input.remote) : null;
  const hint = input.repo_hint ? String(input.repo_hint) : top.split('/').pop() || '';
  const repo = normalizeRepo(from_remote || hint);

  const relative = abs === top ? '' : abs.slice(top.length + 1);
  if (relative === '') {
    return { kind: KIND_REPO, repo, ref: repo };
  }
  const suffix = input.is_dir ? '/' : '';
  return parseRef(`${repo}:${relative}${suffix}`);
}

/**
 * How a queried ref relates to an attached one — the whole search predicate.
 *
 * Labels are from the query's point of view:
 *
 * - `exact`  — the same thing.
 * - `inside` — what you asked about lies **inside** the attached artifact (it is
 *              the repo, or a directory above your file).
 * - `covers` — what you asked about **contains** the attached artifact (you asked
 *              about the repo, or a directory above their file).
 * - `null`   — unrelated.
 *
 * Both directions matter. "Who is editing this file?" needs `inside` (someone
 * claimed the directory); "who is working anywhere under ui/server/?" needs
 * `covers`. Only checking equality would answer neither, which is how a
 * path-collision check comes to report no collisions.
 *
 * A PR relates to its repo but not to any path: a PR is a review surface, not a
 * location, and pretending otherwise would report a merged PR as a conflict with
 * every file it ever touched.
 *
 * @param {string | ArtifactRef} query ref string or parsed artifact
 * @param {string | ArtifactRef} attached ref string or parsed artifact
 * @returns {string | null}
 */
export function overlap(query, attached) {
  const q = typeof query === 'string' ? parseRef(query) : query;
  const a = typeof attached === 'string' ? parseRef(attached) : attached;
  if (q.repo !== a.repo) return null;

  if (q.kind === KIND_REPO && a.kind === KIND_REPO) return REL_EXACT;
  if (q.kind === KIND_REPO) return REL_COVERS;
  if (a.kind === KIND_REPO) return REL_INSIDE;

  if (q.kind === KIND_PR || a.kind === KIND_PR) {
    if (q.kind === KIND_PR && a.kind === KIND_PR) {
      return q.pr === a.pr ? REL_EXACT : null;
    }
    return null;
  }

  const q_path = String(q.path || '');
  const a_path = String(a.path || '');
  const q_dir = q.kind === KIND_DIR;
  const a_dir = a.kind === KIND_DIR;
  const q_bare = q_dir ? q_path.slice(0, -1) : q_path;
  const a_bare = a_dir ? a_path.slice(0, -1) : a_path;

  if (q_bare === a_bare) {
    // `ui/server` as a file and `ui/server/` as a subtree are different claims on
    // the same name, and the subtree is the broader one.
    if (q_dir === a_dir) return REL_EXACT;
    return q_dir ? REL_COVERS : REL_INSIDE;
  }
  if (a_dir && q_bare.startsWith(a_bare + '/')) return REL_INSIDE;
  if (q_dir && a_bare.startsWith(q_bare + '/')) return REL_COVERS;
  return null;
}

/**
 * Metadata key holding one artifact.
 *
 * @param {string} ref canonical ref
 * @returns {string}
 */
export function metadataKey(ref) {
  return METADATA_PREFIX + parseRef(ref).ref;
}

/**
 * The ref inside an artifact metadata key, or null for any other key.
 *
 * Unparseable keys return null rather than throwing: metadata is an open
 * namespace, and one hand-edited key must not make a whole bead unreadable.
 *
 * @param {string} key
 * @returns {string | null}
 */
export function refFromMetadataKey(key) {
  const raw = String(key == null ? '' : key);
  if (!raw.startsWith(METADATA_PREFIX)) return null;
  try {
    return parseRef(raw.slice(METADATA_PREFIX.length)).ref;
  } catch {
    return null;
  }
}

/**
 * Timestamp format shared by both implementations — second precision, `Z`.
 *
 * Python's `isoformat()` would write `+00:00` and Node's `toISOString()` writes
 * milliseconds; either difference makes two agents' records look different for no
 * reason.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function nowIso(now = new Date()) {
  return now.toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * Build the metadata value stored under an artifact key.
 *
 * The parsed parts are stored alongside the ref so a reader never has to re-parse
 * (and so a future ref-grammar change stays diagnosable), and `actor`/`note` are
 * omitted when empty rather than stored as `""` — an empty string in `bd show`
 * reads as "somebody set this to nothing".
 *
 * @param {{ ref: string, intent?: string, note?: string, actor?: string, at?: string }} input
 * @returns {object}
 */
export function artifactValue(input) {
  const parsed = parseRef(input.ref);
  const intent = input.intent || INTENT_EDITING;
  if (!INTENTS.includes(intent)) {
    throw new ArtifactRefError(`unknown intent: ${intent}`, `Intents: ${INTENTS.join(', ')}`);
  }
  /** @type {Record<string, any>} */
  const value = { kind: parsed.kind, repo: parsed.repo, intent };
  if (parsed.path !== undefined) value.path = parsed.path;
  if (parsed.pr !== undefined) value.pr = parsed.pr;
  if (input.note) value.note = String(input.note);
  if (input.actor) value.actor = String(input.actor);
  value.at = input.at || nowIso();
  return value;
}

/**
 * The metadata patch that attaches artifacts to a bead.
 *
 * One key per ref plus the marker, in a single object, so a multi-file attach is one
 * `bd update --metadata` — one transaction, one commit, one audit entry.
 *
 * @param {Array<{ ref: string, intent?: string, note?: string, actor?: string, at?: string }>} artifacts
 * @returns {Record<string, any>}
 */
export function attachPatch(artifacts) {
  /** @type {Record<string, any>} */
  const patch = { [MARKER_KEY]: true };
  for (const artifact of artifacts) {
    patch[metadataKey(artifact.ref)] = artifactValue(artifact);
  }
  return patch;
}

/**
 * The metadata patch that releases artifacts — a `null` per ref.
 *
 * See {@link artifactsFromMetadata} for why detach is a null rather than an unset.
 * The marker is deliberately not cleared (see {@link MARKER_KEY}).
 *
 * @param {string[]} refs
 * @returns {Record<string, null>}
 */
export function detachPatch(refs) {
  /** @type {Record<string, null>} */
  const patch = {};
  for (const ref of refs) patch[metadataKey(ref)] = null;
  return patch;
}

/**
 * Decode every artifact on one bead from its metadata.
 *
 * A key whose value is `null` is a **released** artifact and is skipped. That is how
 * detaching works, and the reason is bd's, not ours: its metadata-key validator
 * (`^[a-zA-Z_][a-zA-Z0-9_./]*$`) rejects the `-`, `:` and `#` that refs are made of,
 * so `--unset-metadata` cannot remove a key that `--metadata` is perfectly willing to
 * create. The alternatives were mangling every ref into a regex-safe encoding —
 * unreadable in `bd show`, since repo names are mostly dashes — or patching the
 * validator in vendored Go. Writing `null` over the key keeps detach on the same
 * footing as attach: one key, no read-modify-write, so releasing one file cannot
 * clobber another agent attaching a different one.
 *
 * @param {object} metadata bead metadata as returned by `bd show --json`
 * @returns {Array<{ ref: string, kind: string, repo: string, path?: string, pr?: number,
 *                   intent: string, note?: string, actor?: string, at?: string }>}
 */
export function artifactsFromMetadata(metadata) {
  const out = [];
  for (const [key, raw] of Object.entries(metadata || {})) {
    const ref = refFromMetadataKey(key);
    if (!ref) continue;
    if (raw === null || raw === undefined) continue; // released
    const parsed = parseRef(ref);
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    out.push({
      ref,
      kind: parsed.kind,
      repo: parsed.repo,
      ...(parsed.path !== undefined ? { path: parsed.path } : {}),
      ...(parsed.pr !== undefined ? { pr: parsed.pr } : {}),
      // The key is authoritative for identity, the value for annotation: a
      // hand-edited value must not be able to make an artifact claim a different
      // file than its key says.
      intent: INTENTS.includes(value.intent) ? value.intent : INTENT_EDITING,
      ...(value.note ? { note: String(value.note) } : {}),
      ...(value.actor ? { actor: String(value.actor) } : {}),
      ...(value.at ? { at: String(value.at) } : {})
    });
  }
  return out.sort(compareCodepoints);
}

/**
 * Compare two strings by code point, the way Python's `sorted()` does.
 *
 * Not `localeCompare`: it reorders punctuation, so `…feads#4141` and
 * `…feads:ui/server/bd.js` come out in one order here and the other in the Python twin.
 * The order is cosmetic on its own — but "two agents reading one bead see one order" is
 * a claim the fixture makes, and a claim that only holds on one surface is worse than
 * no claim.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @param {{ ref: string }} a
 * @param {{ ref: string }} b
 * @returns {number}
 */
function compareCodepoints(a, b) {
  return compareStrings(a.ref, b.ref);
}

/**
 * Rank of an intent for conflict reporting. Lower sorts first.
 *
 * @param {string} intent
 * @returns {number}
 */
export function intentRank(intent) {
  const rank = INTENT_RANK[intent];
  return rank === undefined ? INTENTS.length : rank;
}

/**
 * Order search hits so the ones an agent must act on come first: `editing`
 * before `planned` before `reading` before `done`, exact overlaps before broad
 * ones, then by bead id so output is stable.
 *
 * @param {Array<{ issue_id: string, artifact: { intent: string }, relation: string }>} hits
 * @returns {Array<any>}
 */
export function sortHits(hits) {
  /** @type {Record<string, number>} */
  const relation_rank = { [REL_EXACT]: 0, [REL_INSIDE]: 1, [REL_COVERS]: 2 };
  return [...hits].sort((a, b) => {
    const by_intent = intentRank(a.artifact.intent) - intentRank(b.artifact.intent);
    if (by_intent !== 0) return by_intent;
    const by_relation = (relation_rank[a.relation] ?? 3) - (relation_rank[b.relation] ?? 3);
    if (by_relation !== 0) return by_relation;
    return compareStrings(a.issue_id, b.issue_id);
  });
}

/**
 * The comment a responder leaves on an overlapping bead.
 *
 * Both surfaces must write the *same* sentence: an agent reading a bead's comments
 * should not have to tell "an agent using the MCP" from "an agent using the CLI",
 * and a grep for coordination traffic should find all of it. Hence pure, and in
 * the fixture.
 *
 * @param {{ mine: string, action: string, ref: string, attached_ref?: string,
 *           attached_intent?: string, note?: string, dep_added?: boolean,
 *           target?: string }} input
 * @returns {string}
 */
export function respondComment(input) {
  const action = input.action;
  if (!ACTIONS.includes(action)) {
    throw new ArtifactRefError(`unknown action: ${action}`, `Actions: ${ACTIONS.join(', ')}`);
  }
  const ref = parseRef(input.ref).ref;
  const verb = {
    [ACTION_TAKING]: 'is taking',
    [ACTION_SKIPPING]: 'will not touch',
    [ACTION_WAITING]: 'is waiting on this bead before touching'
  }[action];

  const lines = [`[feads-artifact] ${input.mine} ${verb} ${ref}`];
  if (input.attached_ref) {
    const parsed_attached = parseRef(input.attached_ref).ref;
    const intent = input.attached_intent || INTENT_EDITING;
    lines.push(`yours: ${intent} ${parsed_attached}`);
  }
  if (action === ACTION_WAITING && input.dep_added && input.target) {
    lines.push(`blocked-by dependency added: ${input.mine} → ${input.target}`);
  }
  if (input.note) lines.push(String(input.note));
  return lines.join('\n');
}
