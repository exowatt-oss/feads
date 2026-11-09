#!/usr/bin/env node
/**
 * feads-agent — mint invites, register agents, and answer "who am I, and what may I do?"
 *
 * beads identifies an actor by whatever BEADS_ACTOR holds, falling back to git's
 * user.name and then $USER. That fallback is the bug this fixes: `bd update <id>
 * --claim` is idempotent *for the same actor*, so two agents sharing a fallback
 * identity both get a ✓ on the same bead and the collision detection the board
 * exists for silently reports success. Identities are minted here instead.
 *
 * Usage:
 *   feads-agent signup --name <display> [--actor <slug>] [--board <id>] [--json]
 *                      mint an invite and redeem it in one step — open to anyone
 *   feads-agent invite --name <display> [--actor <slug>] [--role user|admin]
 *                      [--board <id>] [--expires 7d|24h|never] [--notes <text>] [--json]
 *   feads-agent register --token <fdsi_…> [--display-name <text>] [--workspace <dir>] [--json]
 *   feads-agent list [--board <id>] [--all] [--json]        the roster
 *   feads-agent invites [--board <id>] [--all] [--json]     unredeemed invites
 *   feads-agent show <actor|agent-id> [--board <id>] [--json]
 *   feads-agent whoami [--json]
 *   feads-agent env [--actor <slug>] [--board <id>]         exports for `eval`
 *   feads-agent heartbeat [--actor <slug>] [--json]
 *   feads-agent role <actor|agent-id> --role user|admin     admin only
 *   feads-agent revoke <actor|agent-id> [--reason <text>]   admin only
 *   feads-agent revoke-invite <invite-id>                   admin only
 *   feads-agent can <read|write|delete> [--item <bead-id>] [--json]
 *   feads-agent path
 *
 * Two tiers, no more: `user` reads everything and writes anything but deletes only
 * items it created; `admin` deletes anything, manages agents, and sees the roster.
 * The tier is fixed when the invite is minted, so an agent cannot elect its own.
 *
 * **Sign-up is open.** Anyone may mint a `user` invite — this is not a secret system,
 * and the point of an identity is that claims stop lying about who holds them, not
 * that access is rationed. Minting an **admin** invite is the one exception, because
 * a self-service admin tier would be no tier at all.
 *
 * Who is allowed to run the administrative commands: if this process presents an
 * identity (FEADS_AGENT_TOKEN, or a session that registered), it is held to that
 * identity's tier — so a `user` agent cannot mint itself an *admin* invite. With no
 * identity you are the *operator*, and the operator is unrestricted, because
 * whoever can run this script can already edit the SQLite file it writes. That is
 * a stated trust boundary, not an oversight; see boards/authz.mjs.
 *
 * Exit codes: 0 ok · 1 error · 2 not found · 3 token rejected · 4 forbidden
 *
 * Env:
 *   FEADS_REGISTRY_DB       registry location (default ~/.feads/registry.db)
 *   FEADS_AGENT_TOKEN       this process's agent token, if it has one
 *   FEADS_REQUIRE_AGENT     refuse unidentified callers instead of treating them as operator
 *   BEADS_DIR               board directory, used to resolve which board is meant
 *   CLAUDE_CODE_SESSION_ID  recorded at registration so `env`/`whoami` can self-resolve
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countAgentsByRole,
  createInvite,
  getAgent,
  getInvite,
  HOME_BOARD_NOTE,
  inviteStatus,
  listAgents,
  listInvites,
  readCredential,
  registerAgent,
  removeCredential,
  resolveAgentIdentity,
  revokeAgent,
  revokeInvite,
  setAgentRole,
  signupAgent,
  touchAgent,
  writeCredential,
  TokenError
} from '../boards/agents.mjs';
import {
  decide,
  isRole,
  normalizeRole,
  requireIdentityFromEnv,
  rosterScopeFor,
  stanceFor
} from '../boards/authz.mjs';
import { getBoard, getRegistryPath, listBoards, openRegistry } from '../boards/registry.mjs';

// The CLI is the local trust root: an unidentified caller here already owns the SQLite
// file, and this is the only path that can mint the *first* admin invite — minting admin
// needs admin, so a read-only CLI would make the model unbootstrappable. The browser
// takes the `read_only` stance instead. FEADS_REQUIRE_AGENT still tightens this to deny.
const CLI_STANCE = stanceFor('operator');

const EXIT_ERROR = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_TOKEN = 3;
const EXIT_FORBIDDEN = 4;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const OFF = '\x1b[0m';

/**
 * @param {string} msg
 * @param {number} [code]
 * @returns {never}
 */
const die = (msg, code = EXIT_ERROR) => {
  process.stderr.write(`feads-agent: ${msg}\n`);
  process.exit(code);
};

/**
 * Parse argv into a command, positionals and flags.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const out = { cmd: argv[0] || 'help', args: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--all') {
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
 * Parse a human duration into milliseconds. `never` means no expiry.
 *
 * @param {string} input
 * @returns {number} ms, or 0 for never
 */
function parseDuration(input) {
  const raw = String(input).trim().toLowerCase();
  if (raw === 'never' || raw === '0') return 0;
  const m = raw.match(/^(\d+)\s*(m|h|d|w)$/);
  if (!m) die(`cannot read --expires ${input} (try 30m, 24h, 7d, 2w, or never)`);
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]];
  return n * unit;
}

/**
 * Which board a command is about.
 *
 * Resolution order matters: an explicit --board is unambiguous; BEADS_DIR is what
 * every agent session already exports and what `bd` itself reads; cwd/.beads is
 * the convention `bd init` establishes. Only when none of those resolve do we fall
 * back to "there is exactly one board, so it must be that one" — guessing among
 * several would silently mint an invite on the wrong board.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} flags
 * @returns {string} board id
 */
function resolveBoardId(db, flags) {
  if (flags.board) {
    const board = getBoard(db, String(flags.board));
    if (!board) die(`no such board: ${flags.board}`, EXIT_NOT_FOUND);
    return board.id;
  }
  for (const candidate of [process.env.BEADS_DIR, path.join(process.cwd(), '.beads')]) {
    if (!candidate) continue;
    const board = getBoard(db, path.resolve(candidate));
    if (board) return board.id;
  }
  const all = listBoards(db);
  if (all.length === 1) return all[0].id;
  if (all.length === 0) {
    die(
      'no boards are registered yet — register one first:\n' +
        '  scripts/feads-board.mjs register <board-dir> --name <name>',
      EXIT_NOT_FOUND
    );
  }
  die(
    `several boards are registered and none is implied by BEADS_DIR or the cwd — pass --board:\n` +
      all.map((b) => `  ${b.id}  ${b.name}`).join('\n'),
    EXIT_NOT_FOUND
  );
}

/**
 * Resolve the identity this process is acting as.
 *
 * The order lives in `boards/agents.mjs` so the CLI, the UI server and the MCP all
 * derive identity identically — they were already drifting on the one case that
 * matters, and a surface that resolves a revoked agent to "anonymous" hands it
 * operator powers locally.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ board_id?: string }} [options]
 * @returns {{ agent: any | null, via: 'token'|'session'|'rejected'|'none' }}
 */
function resolveIdentity(db, options = {}) {
  const resolved = resolveAgentIdentity(db, process.env, options);
  // The CLI turns a rejection into an exit rather than passing it to the policy: every
  // command here would refuse anyway, and the actionable message ("you were probably
  // revoked") is worth more than a generic forbidden.
  if (resolved.credential_rejected) {
    die(
      'the credential this process presented does not match any live agent — you may ' +
        'have been revoked.\n' +
        '  ask the operator for a fresh invite, or present nothing to act as the operator',
      EXIT_FORBIDDEN
    );
  }
  return { agent: resolved.agent, via: resolved.via };
}

/**
 * Enforce the policy for an administrative command, exiting on refusal.
 *
 * @param {any | null} agent
 * @param {'read'|'write'|'delete'|'manage_agents'|'view_roster'} action
 * @param {{ created_by?: string, id?: string }} [resource]
 */
function enforce(agent, action, resource = {}) {
  const d = decide(agent, action, resource, {
    unidentified: CLI_STANCE
  });
  if (!d.allowed) die(d.reason, EXIT_FORBIDDEN);
  return d;
}

/**
 * Refuse acting *as* another agent unless you are an admin or the operator.
 *
 * `env` prints a token and `heartbeat` writes liveness, so `--actor <someone-else>`
 * is impersonation in both directions: it hands over a credential, and it makes an
 * abandoned claim look alive, which is precisely the signal the stale-claim sweep
 * trusts. Locally this is not a hard barrier — the credential files are 0600 under
 * the same OS user, so a determined local process can read them regardless — but a
 * user agent should not be able to do it by simply passing a flag.
 *
 * @param {any | null} self
 * @param {any} target
 */
function assertSelfOrAdmin(self, target) {
  if (!self) return; // operator: owns the files anyway
  if (self.id === target.id) return;
  const d = decide(self, 'manage_agents', {}, {
    unidentified: CLI_STANCE
  });
  if (!d.allowed) {
    die(
      `${self.actor} may not act as ${target.actor} — ${d.reason}`,
      EXIT_FORBIDDEN
    );
  }
}

/**
 * @param {number} ms
 * @returns {string}
 */
function relativeTime(ms) {
  if (!ms) return 'never';
  const delta = Date.now() - ms;
  const abs = Math.abs(delta);
  const units = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000]
  ];
  for (const [label, size] of units) {
    if (abs >= size) {
      // Past times floor ("3h ago" reads as at-least-3h). Future times round, because
      // flooring a 7-day expiry a millisecond after minting it prints "in 6d", which
      // looks like the TTL is off by one.
      const raw = abs / /** @type {number} */ (size);
      const n = delta >= 0 ? Math.floor(raw) : Math.round(raw);
      return delta >= 0 ? `${n}${label} ago` : `in ${n}${label}`;
    }
  }
  return 'just now';
}

/**
 * @param {any} agent
 * @returns {string}
 */
function formatAgent(agent) {
  const role = normalizeRole(agent.role);
  const badge = role === 'admin' ? `${YELLOW}admin${OFF}` : 'user';
  const dead = agent.revoked_at > 0 ? `  ${RED}(revoked ${relativeTime(agent.revoked_at)})${OFF}` : '';
  const lines = [`${BOLD}${agent.actor}${OFF}  ${badge}${dead}`];
  if (agent.display_name && agent.display_name !== agent.actor) {
    lines.push(`  name:  ${agent.display_name}`);
  }
  lines.push(`  id:    ${agent.id}`);
  // Said on the line itself, because the line is where the wrong inference is drawn:
  // this board is the roster the agent belongs to, not the board its work belongs on.
  lines.push(
    `  board: ${agent.board_id}  ${DIM}(registered here; board_route picks where work is filed)${OFF}`
  );
  lines.push(`  host:  ${agent.host || '(unknown)'}`);
  if (agent.workspace_dir) lines.push(`  proj:  ${agent.workspace_dir}`);
  if (agent.session_id) lines.push(`  sess:  ${agent.session_id}`);
  lines.push(
    `  seen:  ${relativeTime(agent.last_seen_at)}  ${DIM}(registered ${relativeTime(agent.registered_at)})${OFF}`
  );
  if (agent.revoke_reason) lines.push(`  why:   ${agent.revoke_reason}`);
  return lines.join('\n');
}

/**
 * @param {any} invite
 * @returns {string}
 */
function formatInvite(invite) {
  const status = inviteStatus(invite);
  const color = status === 'pending' ? GREEN : status === 'redeemed' ? DIM : RED;
  const lines = [
    `${BOLD}${invite.actor}${OFF}  ${normalizeRole(invite.role)}  ${color}${status}${OFF}`
  ];
  lines.push(`  id:    ${invite.id}`);
  lines.push(`  board: ${invite.board_id}`);
  lines.push(
    `  made:  ${relativeTime(invite.created_at)}` +
      (invite.expires_at > 0 ? `   expires ${relativeTime(invite.expires_at)}` : '   no expiry')
  );
  if (invite.redeemed_at > 0) {
    lines.push(`  used:  ${relativeTime(invite.redeemed_at)} by ${invite.redeemed_by}`);
  }
  if (invite.notes) lines.push(`  note:  ${invite.notes}`);
  return lines.join('\n');
}

/**
 * Read an issue's creator so a `user`'s delete can be judged.
 *
 * Shells out to bd rather than reading Dolt directly: the board is bd's database and
 * its schema is bd's business. Returns null when the issue cannot be read, and the
 * caller must treat that as "cannot establish ownership" rather than "no owner" —
 * the two are different and only one of them is safe to allow.
 *
 * @param {string} issue_id
 * @param {string} board_dir
 * @returns {string | null}
 */
function issueCreator(issue_id, board_dir) {
  const bd_bin = process.env.BD_BIN || findBd();
  if (!bd_bin) return null;
  try {
    const out = execFileSync(bd_bin, ['show', issue_id, '--json'], {
      env: { ...process.env, BEADS_DIR: board_dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const parsed = JSON.parse(out);
    const issue = Array.isArray(parsed) ? parsed[0] : parsed;
    return issue && typeof issue.created_by === 'string' ? issue.created_by : null;
  } catch {
    return null;
  }
}

/**
 * Prefer this repo's build over whatever is on PATH: a Homebrew `bd` is behind on
 * schema migrations and cannot even read this board (see FEADS.md).
 *
 * @returns {string | null}
 */
function findBd() {
  const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const local = path.join(repo_root, 'bd');
  if (fs.existsSync(local)) return local;
  return 'bd';
}

function main() {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      fs
        .readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(2, 48)
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
    case 'invite': {
      const board_id = resolveBoardId(db, flags);
      const { agent } = resolveIdentity(db, { board_id });

      const role = flags.role === undefined ? 'user' : String(flags.role);
      if (!isRole(role)) die(`--role must be user or admin (got ${role})`);
      // Minting a user invite is open to anyone; only the admin tier is gated. The
      // requested role is passed in so the policy can tell those two apart.
      enforce(agent, 'mint_invite', { role });
      const name = flags.name || flags.actor;
      if (!name) die('invite needs --name (the agent\'s display name)');

      let minted;
      try {
        minted = createInvite(db, {
          board_id,
          actor: flags.actor || String(name),
          display_name: String(name),
          role,
          created_by: agent ? agent.actor : `operator@${os.hostname()}`,
          ttl_ms: flags.expires === undefined ? undefined : parseDuration(String(flags.expires)),
          notes: flags.notes ? String(flags.notes) : ''
        });
      } catch (err) {
        die(err.message);
      }

      if (flags.json) {
        process.stdout.write(
          JSON.stringify({ invite: minted.invite, token: minted.token }, null, 2) + '\n'
        );
        return;
      }
      const { invite, token } = minted;
      process.stdout.write(
        `${formatInvite(invite)}\n\n` +
          `${BOLD}token (shown once — it is stored only as a hash):${OFF}\n\n` +
          `  ${GREEN}${token}${OFF}\n\n` +
          `hand it to the agent, which registers with:\n` +
          `  scripts/feads-agent.mjs register --token ${token}\n` +
          `${DIM}or paste the feads-register skill and give it the token${OFF}\n`
      );
      return;
    }

    case 'signup': {
      // Mint and redeem in one step. This is the flow a human wants: they end up
      // holding the *same* token their agent will use, which is what makes "the human
      // sees exactly what the agent sees" true rather than approximately true. The
      // two-step invite/register split still exists for handing a token to an agent
      // that will redeem it itself.
      const board_id = resolveBoardId(db, flags);
      const { agent: self } = resolveIdentity(db, { board_id });
      const name = flags.name || flags.actor;
      if (!name) die('signup needs --name (what to call this agent)');
      // Sign-up is open, so this is not a gate in practice — but it still runs, so a
      // revoked credential and FEADS_REQUIRE_AGENT are both honoured here.
      enforce(self, 'mint_invite', { role: 'user' });

      let result;
      try {
        // One implementation, shared with the dashboard's sign-up form and the MCP's
        // agent_signup tool — including the failure path, where the invite has to be
        // revoked or it lingers as a token nobody holds and nobody ever saw.
        result = signupAgent(db, {
          board_id,
          display_name: String(name),
          actor: flags.actor ? String(flags.actor) : undefined,
          workspace_dir: flags.workspace ? String(flags.workspace) : process.cwd(),
          session_id: process.env.CLAUDE_CODE_SESSION_ID || '',
          host: os.hostname(),
          kind: flags.kind ? String(flags.kind) : 'agent',
          created_by: self ? self.actor : `signup@${os.hostname()}`
        });
      } catch (err) {
        if (err instanceof TokenError) die(err.message, EXIT_TOKEN);
        die(err.message);
      }

      const { agent } = result;
      const credential = writeCredential(agent, result.token);
      const board = getBoard(db, agent.board_id);

      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            {
              agent,
              token: result.token,
              credential,
              board_dir: board ? board.board_dir : null,
              env: envExports(agent, result.token, board),
              // The identity has a board on it from this moment; so does the caveat.
              ...HOME_BOARD_NOTE
            },
            null,
            2
          ) + '\n'
        );
        return;
      }
      process.stdout.write(
        `${GREEN}✓${OFF} signed up as ${BOLD}${agent.actor}${OFF} (${normalizeRole(agent.role)})\n\n` +
          `${formatAgent(agent)}\n\n` +
          `${BOLD}its token (shown once — only a hash is stored):${OFF}\n\n` +
          `  ${GREEN}${result.token}${OFF}\n\n` +
          `  also written 0600 to ${credential}\n\n` +
          `${BOLD}give this to the agent${OFF} — one line at the top of any block running bd:\n\n` +
          `  export FEADS_AGENT_TOKEN=${result.token}\n` +
          `  eval "$(feads-agent env)"\n`
      );
      return;
    }

    case 'register': {
      const token = flags.token || process.env.FEADS_INVITE_TOKEN;
      if (!token) die('register needs --token <fdsi_…>');
      let result;
      try {
        result = registerAgent(db, {
          token: String(token),
          workspace_dir: flags.workspace ? String(flags.workspace) : process.cwd(),
          session_id: process.env.CLAUDE_CODE_SESSION_ID || '',
          display_name: flags['display-name'] ? String(flags['display-name']) : '',
          host: os.hostname()
        });
      } catch (err) {
        if (err instanceof TokenError) die(err.message, EXIT_TOKEN);
        die(err.message);
      }

      const { agent } = result;
      const credential = writeCredential(agent, result.token);
      const board = getBoard(db, agent.board_id);

      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            {
              agent,
              token: result.token,
              credential,
              board_dir: board ? board.board_dir : null,
              env: envExports(agent, result.token, board),
              // The identity has a board on it from this moment; so does the caveat.
              ...HOME_BOARD_NOTE
            },
            null,
            2
          ) + '\n'
        );
        return;
      }
      process.stdout.write(
        `${GREEN}✓${OFF} registered as ${BOLD}${agent.actor}${OFF} (${normalizeRole(agent.role)})\n\n` +
          `${formatAgent(agent)}\n\n` +
          `  token stored 0600 at ${credential}\n\n` +
          `${BOLD}use it in every shell that runs bd${OFF} — Claude Code starts a fresh shell per\n` +
          `command, so exports do not survive between calls:\n\n` +
          `  eval "$(scripts/feads-agent.mjs env)"\n\n` +
          (normalizeRole(agent.role) === 'admin'
            ? `you are an ${YELLOW}admin${OFF}: you may delete any item and manage agents.\n`
            : `you are a user: you may read and write anything, and delete only items you created.\n`)
      );
      return;
    }

    case 'list': {
      const board_id = resolveBoardId(db, flags);
      const { agent } = resolveIdentity(db, { board_id });
      enforce(agent, 'view_roster');
      const scope = rosterScopeFor(agent, { unidentified: CLI_STANCE });

      let agents = listAgents(db, { board_id, include_revoked: !!flags.all });
      // A `user` gets its own row rather than an error — knowing its own tier is how
      // an agent explains what it may do. Only an admin (or the operator) sees all.
      if (scope.scope === 'self') agents = agents.filter((a) => a.id === scope.agent_id);
      else if (scope.scope === 'none') agents = [];

      if (flags.json) {
        process.stdout.write(
          JSON.stringify({ board_id, scope: scope.scope, agents }, null, 2) + '\n'
        );
        return;
      }
      if (agents.length === 0) {
        process.stdout.write(
          `no agents registered on ${board_id}\n` +
            `  mint an invite:  scripts/feads-agent.mjs invite --name <agent-name>\n`
        );
        return;
      }
      const counts = countAgentsByRole(db, { board_id });
      process.stdout.write(
        agents.map(formatAgent).join('\n\n') +
          `\n\n${DIM}${counts.admin} admin, ${counts.user} user on ${board_id}${OFF}\n` +
          (counts.admin === 0
            ? `${YELLOW}no admin on this board${OFF} — mint one with --role admin\n`
            : '')
      );
      return;
    }

    case 'invites': {
      const board_id = resolveBoardId(db, flags);
      const { agent } = resolveIdentity(db, { board_id });
      enforce(agent, 'manage_agents');
      const invites = listInvites(db, { board_id, include_inactive: !!flags.all });
      if (flags.json) {
        process.stdout.write(JSON.stringify({ board_id, invites }, null, 2) + '\n');
        return;
      }
      if (invites.length === 0) {
        process.stdout.write(
          `no ${flags.all ? '' : 'pending '}invites on ${board_id}\n` +
            `  mint one:  scripts/feads-agent.mjs invite --name <agent-name>\n`
        );
        return;
      }
      process.stdout.write(invites.map(formatInvite).join('\n\n') + '\n');
      return;
    }

    case 'show': {
      const target = args[0];
      if (!target) die('show needs an actor name or agent id');
      const board_id = resolveBoardId(db, flags);
      const { agent: self } = resolveIdentity(db, { board_id });
      enforce(self, 'view_roster');
      const found = getAgent(db, target, { board_id });
      if (!found) die(`no such agent: ${target}`, EXIT_NOT_FOUND);
      const scope = rosterScopeFor(self, { unidentified: CLI_STANCE });
      if (scope.scope === 'self' && found.id !== scope.agent_id) {
        die(`only an admin may inspect other agents (you are ${self.actor}, a user)`, EXIT_FORBIDDEN);
      }
      process.stdout.write(
        flags.json ? JSON.stringify(found, null, 2) + '\n' : formatAgent(found) + '\n'
      );
      return;
    }

    case 'whoami': {
      const board_id = resolveBoardId(db, flags);
      const { agent, via } = resolveIdentity(db, { board_id });
      const require_identity = requireIdentityFromEnv();
      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            {
              identity: agent,
              mode: agent ? 'agent' : 'operator',
              resolved_via: via,
              require_identity,
              board_id,
              // What `board_id` above does and does not mean. Carried on whoami
              // because whoami is where an agent forms its idea of where it lives.
              ...HOME_BOARD_NOTE
            },
            null,
            2
          ) + '\n'
        );
        return;
      }
      if (!agent) {
        process.stdout.write(
          `${BOLD}operator${OFF} (no agent identity on this process)\n` +
            `  board: ${board_id}  ${DIM}(where a sign-up would register; board_route picks where work is filed)${OFF}\n` +
            `  ${require_identity ? `${RED}FEADS_REQUIRE_AGENT is set, so surfaces will refuse this caller${OFF}` : 'unrestricted here, because whoever runs this owns the registry file'}\n` +
            `  register with an invite:  scripts/feads-agent.mjs register --token <fdsi_…>\n`
        );
        return;
      }
      process.stdout.write(`${formatAgent(agent)}\n  via:   ${via}\n`);
      return;
    }

    case 'env': {
      const board_id = resolveBoardId(db, flags);
      const { agent: self } = resolveIdentity(db, { board_id });
      const agent = flags.actor ? getAgent(db, String(flags.actor), { board_id }) : self;
      if (!agent) {
        die(
          'no agent identity for this session — register first, or pass --actor\n' +
            '  scripts/feads-agent.mjs register --token <fdsi_…>',
          EXIT_NOT_FOUND
        );
      }
      assertSelfOrAdmin(self, agent);
      const credential = readCredential(agent.id);
      const board = getBoard(db, agent.board_id);
      // Touch on every env resolution: an agent evaluates this at the top of each
      // command block, which makes last_seen_at a genuine liveness signal for the
      // stale-claim sweep at almost no cost.
      touchAgent(db, agent.id, { session_id: process.env.CLAUDE_CODE_SESSION_ID || '' });
      process.stdout.write(envExports(agent, credential ? credential.token : '', board));
      return;
    }

    case 'heartbeat': {
      const board_id = resolveBoardId(db, flags);
      const { agent: self } = resolveIdentity(db, { board_id });
      const agent = flags.actor ? getAgent(db, String(flags.actor), { board_id }) : self;
      if (!agent) die('no agent identity to heartbeat — register first, or pass --actor', EXIT_NOT_FOUND);
      assertSelfOrAdmin(self, agent);
      const updated = touchAgent(db, agent.id, {
        session_id: process.env.CLAUDE_CODE_SESSION_ID || ''
      });
      if (flags.json) {
        process.stdout.write(JSON.stringify({ agent: updated }, null, 2) + '\n');
        return;
      }
      process.stdout.write(`${GREEN}✓${OFF} ${agent.actor} seen just now\n`);
      return;
    }

    case 'role': {
      const target = args[0];
      if (!target) die('role needs an actor name or agent id');
      if (flags.role === undefined) die('role needs --role user|admin');
      if (!isRole(String(flags.role))) die(`--role must be user or admin (got ${flags.role})`);
      const board_id = resolveBoardId(db, flags);
      const { agent: self } = resolveIdentity(db, { board_id });
      enforce(self, 'manage_agents');
      const found = getAgent(db, target, { board_id });
      if (!found) die(`no such agent: ${target}`, EXIT_NOT_FOUND);
      if (found.revoked_at > 0) die(`${found.actor} is revoked — re-invite instead`, EXIT_ERROR);
      const updated = setAgentRole(db, found.id, String(flags.role));
      process.stdout.write(
        flags.json ? JSON.stringify(updated, null, 2) + '\n' : formatAgent(updated) + '\n'
      );
      return;
    }

    case 'revoke': {
      const target = args[0];
      if (!target) die('revoke needs an actor name or agent id');
      const board_id = resolveBoardId(db, flags);
      const { agent: self } = resolveIdentity(db, { board_id });
      enforce(self, 'manage_agents');
      const found = getAgent(db, target, { board_id });
      if (!found) die(`no such agent: ${target}`, EXIT_NOT_FOUND);
      if (!revokeAgent(db, found.id, flags.reason ? String(flags.reason) : '')) {
        die(`${found.actor} was already revoked`, EXIT_ERROR);
      }
      // Remove the agent's own copy too, so a revoked agent stops presenting a token
      // that no longer verifies and gets a clear failure instead of a confusing one.
      const had_credential = removeCredential(found.id);
      process.stdout.write(
        `${GREEN}✓${OFF} revoked ${found.actor}\n` +
          `  its token no longer verifies and the name is free to re-invite\n` +
          (had_credential ? `  removed its local credential file\n` : '') +
          `  its rows and past claims are kept — the roster is a record of who worked the board\n`
      );
      return;
    }

    case 'revoke-invite': {
      const id = args[0];
      if (!id) die('revoke-invite needs an invite id');
      const board_id = resolveBoardId(db, flags);
      const { agent: self } = resolveIdentity(db, { board_id });
      enforce(self, 'manage_agents');
      const invite = getInvite(db, id);
      if (!invite) die(`no such invite: ${id}`, EXIT_NOT_FOUND);
      if (!revokeInvite(db, invite.id)) {
        die(
          `invite ${invite.id} is ${inviteStatus(invite)} — only a pending invite can be revoked`,
          EXIT_ERROR
        );
      }
      process.stdout.write(`${GREEN}✓${OFF} revoked invite ${invite.id} for ${invite.actor}\n`);
      return;
    }

    case 'can': {
      const action = args[0];
      if (!action) die('can needs an action: read, write or delete');
      if (!['read', 'write', 'delete'].includes(action)) {
        die(`can takes read, write or delete (got ${action})`);
      }
      const board_id = resolveBoardId(db, flags);
      const { agent } = resolveIdentity(db, { board_id });
      const board = getBoard(db, board_id);

      /** @type {{ id?: string, created_by?: string }} */
      const resource = {};
      if (action === 'delete') {
        if (!flags.item) die('can delete needs --item <bead-id> to judge ownership');
        resource.id = String(flags.item);
        const creator = board ? issueCreator(resource.id, board.board_dir) : null;
        // A creator we could not read is left undefined rather than set to '', so the
        // policy reports "no recorded creator" only when bd actually says so.
        if (creator !== null) resource.created_by = creator;
      }

      const d = decide(agent, /** @type {any} */ (action), resource, {
        unidentified: CLI_STANCE
      });
      if (flags.json) {
        process.stdout.write(
          JSON.stringify(
            { action, resource, allowed: d.allowed, reason: d.reason, mode: d.mode },
            null,
            2
          ) + '\n'
        );
      } else {
        process.stdout.write(
          `${d.allowed ? `${GREEN}allowed${OFF}` : `${RED}refused${OFF}`}  ${action}` +
            `${resource.id ? ` ${resource.id}` : ''}\n  ${d.reason}\n`
        );
      }
      process.exit(d.allowed ? 0 : EXIT_FORBIDDEN);
    }

    default:
      die(`unknown command: ${cmd} (try: feads-agent help)`);
  }
}

/**
 * The exports an agent needs in a fresh shell.
 *
 * Why this exists at all: Claude Code runs each Bash call in a new shell, so an
 * `export` in one call is gone by the next. Emitting them for `eval` is what lets a
 * registered agent put one line at the top of a command block instead of re-deriving
 * its identity — which is how sessions ended up sharing a fallback actor in the
 * first place.
 *
 * @param {any} agent
 * @param {string} token
 * @param {any} board
 * @returns {string}
 */
function envExports(agent, token, board) {
  const lines = [];
  if (board) lines.push(`export BEADS_DIR=${shellQuote(board.board_dir)}`);
  lines.push(`export BEADS_ACTOR=${shellQuote(agent.actor)}`);
  if (token) lines.push(`export FEADS_AGENT_TOKEN=${shellQuote(token)}`);
  return lines.join('\n') + '\n';
}

/**
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

main();
