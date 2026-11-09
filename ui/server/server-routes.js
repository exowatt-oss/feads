/**
 * feads addition — the two HTTP routes that let a browser find out the dashboard is
 * lying to it, and do something about it.
 *
 * - `GET /api/build` — what build this process is running, and which kind of
 *   staleness (if any) the caller has. Deliberately reachable without a WebSocket, so
 *   a script, a health check or a person with `curl` can ask "is this daemon current?"
 *   without opening a socket and waiting for an event.
 * - `POST /api/server/restart` — bounce the daemon, because for server staleness a
 *   reload is not the remedy and there is nothing else the browser can do.
 *
 * See `build-identity.js` for why the two kinds of staleness are separate.
 *
 * ## The restart is gated two ways, and identity is deliberately not one of them
 *
 * Both must pass, checked most-categorical first so a refusal reports the fundamental
 * reason rather than whichever check happened to run:
 *
 * 1. **`FEADS_REQUIRE_AGENT` unset.** A deployment that sets it is one where the
 *    service holds the database and the callers do not — a hosted dashboard must not
 *    have a button that takes the service down for everybody, and it must not have it
 *    *at all* rather than have it behind a role. Checked first so no amount of
 *    credential can talk its way past it.
 * 2. **The request is from loopback.** Whoever can reach the local UI already owns the
 *    process. A request from off-box is categorically not that person, whatever it
 *    presents.
 *
 * Then it is allowed, **identified or not**. That reads as a loosening and is not, so
 * here is the reasoning, because the alternative was written first and looked more
 * responsible:
 *
 * An earlier version required the policy to allow `manage_agents` — operator or admin.
 * That was the board policy misapplied to something that is not a board operation.
 * Restarting the local dev daemon changes no issue, no identity and no registry row,
 * and the person at a loopback browser can already type `scripts/feads-run.sh restart`
 * in the terminal next to it. So the check prevented nothing; it merely hid the button
 * from the machine's owner — the same species of theatre as binding a token to an IP
 * address that every local client shares. Worse, it hid it in the *common* case: a
 * machine with an agent registry gives an unidentified browser the `read_only` stance,
 * so the button was invisible by default to exactly the person entitled to press it.
 *
 * The protection that is real — several people sharing one hosted daemon, where an
 * anonymous viewer must not bounce it under everyone else — is delivered by the two
 * checks above, and it is delivered *better* by them: `FEADS_REQUIRE_AGENT` is what a
 * hosted deployment sets, and the loopback check is what a shared one fails. **Do not
 * reinstate a role check here as a security fix.** It would restore the theatre without
 * adding a boundary, and the tests below assert the opposite so that the attempt fails
 * loudly.
 *
 * `X-Forwarded-For` is deliberately **not** consulted for the loopback check. It is a
 * header any client can write, so trusting it would make the check decorative; the peer
 * address of the socket is the only thing here that cannot be forged by the caller.
 * The consequence — a genuine reverse proxy in front of this would see every request
 * as local — is the safe direction, because such a deployment is exactly the one that
 * should be setting `FEADS_REQUIRE_AGENT` and failing the first check.
 *
 * ## Why the response goes out before the process does
 *
 * `feads-run.sh restart` stops this process. If the child were spawned before the
 * response were flushed, the browser would see a dropped connection rather than an
 * acknowledgement, and could not tell a successful restart from a crash — so it could
 * not know whether to wait for the daemon to come back. The spawn is therefore hung
 * off the response's own `finish` event, which Node emits once the response has been
 * handed to the OS.
 *
 * The child is **detached**, with its stdio disconnected. It has to outlive us: it is
 * going to kill this process and then start a new one, so a child in this process's
 * group would be killed halfway through and leave nothing running at all.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RESTART_COMMAND } from './build-identity.js';
import { debug } from './logging.js';

const log = debug('server-routes');

/**
 * Loopback peer addresses. `::ffff:127.0.0.1` is the IPv4-mapped form Node reports on
 * a dual-stack listener, and omitting it would refuse ordinary local requests on some
 * machines and not others.
 */
const LOOPBACK_ADDRESSES = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost'
]);

/**
 * Whether a request came from this machine, judged only by the socket's peer address.
 *
 * See the header for why no forwarding header is consulted. Anything unreadable —
 * a socket already gone, a mock without one — is **not** local: this gate exists to
 * refuse, so an absent answer has to mean no.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isLoopbackRequest(req) {
  const address = String(
    /** @type {any} */ (req)?.socket?.remoteAddress || ''
  ).trim();
  if (address.length === 0) {
    return false;
  }
  if (LOOPBACK_ADDRESSES.has(address)) {
    return true;
  }
  // A zone-suffixed IPv6 loopback, e.g. `::1%lo0`.
  return address.startsWith('::1%');
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {void}
 */
function fail(res, status, code, message, extra = {}) {
  res.status(status).json({ ok: false, error: { code, message }, ...extra });
}

/**
 * The launcher this can actually run, if it is present.
 *
 * A published beads-ui package has no `scripts/feads-run.sh`, and neither does a
 * checkout someone copied the `ui/` directory out of. In that case the button is not
 * offered — but the command still is, because a person who knows their own setup can
 * still act on it, and a dashboard that says "restart me" without saying how is worse
 * than one that says nothing.
 *
 * @param {string} [root_dir] - Where to look. Defaults to the repo above `ui/`.
 * @returns {{ path: string, available: boolean, command: string }}
 */
export function resolveLauncher(root_dir) {
  const base = root_dir
    ? path.resolve(root_dir)
    : path.resolve(new URL('..', import.meta.url).pathname, '..');
  const script = path.join(base, 'scripts', 'feads-run.sh');
  return {
    path: script,
    available: fs.existsSync(script),
    command: RESTART_COMMAND
  };
}

/**
 * @typedef {Object} ServerRouteOptions
 * @property {{ report: () => any }} identity - From `createBuildIdentity`.
 * @property {string} [launcher_root] - Where `scripts/feads-run.sh` lives.
 * @property {(req: import('express').Request) => boolean} [isLocalRequest]
 *   - Test seam. A non-loopback peer cannot be produced by binding a test server to
 *   127.0.0.1, and the alternative — binding to a routable address in CI — is worse
 *   than injecting the predicate and unit-testing it separately.
 * @property {Record<string, string | undefined>} [env]
 * @property {(script: string) => void} [spawnRestart]
 *   - Test seam. Asserting that the real spawn was detached is the point of one of the
 *   tests, so the default is exercised there rather than replaced.
 */

/**
 * Mount `GET /api/build` and `POST /api/server/restart`.
 *
 * @param {import('express').Express} app
 * @param {ServerRouteOptions} options
 * @returns {void}
 */
export function attachServerRoutes(app, options) {
  const identity = options.identity;
  // No identity resolution and no policy call anywhere in this module, and that absence
  // is the design rather than an omission — see the header. Restarting the local dev
  // daemon is not a board operation, and a loopback caller can already do it from the
  // shell. The two gates that mean something are the environment flag and the peer
  // address, neither of which needs to know who anybody is.
  const isLocal = options.isLocalRequest || isLoopbackRequest;
  const env = options.env || process.env;
  const launcher = resolveLauncher(options.launcher_root);
  const startRestart = options.spawnRestart || spawnDetachedRestart;

  /**
   * Whether the restart *feature* exists on this deployment at all, independent of
   * who is asking. Sent to clients so the UI can offer the copyable command alone
   * rather than a button that is going to be refused.
   *
   * @returns {boolean}
   */
  function restartOffered() {
    return launcher.available && !requireAgent(env);
  }

  app.get(
    '/api/build',
    /**
     * Ungated, deliberately. It carries content hashes, mtimes and a boot timestamp —
     * nothing that is not already inferable from the files being served — and the
     * whole purpose is to be answerable when the socket path is the thing that is
     * broken or absent. Gating the message that says "this dashboard is out of date"
     * behind the dashboard working is the loop this work exists to break.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {void}
     */
    (req, res) => {
      const report = identity.report();
      const allowed = restartAllowedFor(req);
      // `no-store`, because a cached answer to "are you stale?" is the exact bug.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        ok: true,
        ...report,
        restart_offered: restartOffered(),
        restart_allowed: allowed.allowed,
        restart_reason: allowed.reason
      });
    }
  );

  app.post(
    '/api/server/restart',
    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {void}
     */
    (req, res) => {
      if (requireAgent(env)) {
        log('restart refused: FEADS_REQUIRE_AGENT is set');
        fail(
          res,
          403,
          'restart_disabled',
          'this deployment sets FEADS_REQUIRE_AGENT, so it does not offer a ' +
            'restart button — restart it the way it was started',
          { restart_command: launcher.command }
        );
        return;
      }
      if (!isLocal(req)) {
        log('restart refused: not a local request');
        fail(
          res,
          403,
          'not_local',
          'restarting the dashboard is only possible from the machine it runs on',
          { restart_command: launcher.command }
        );
        return;
      }

      // No third check. A loopback caller on a deployment that has not set
      // `FEADS_REQUIRE_AGENT` may restart, identified or not — see the header for why a
      // role check here was theatre rather than a boundary, and why reinstating one
      // would not make this safer.
      if (!launcher.available) {
        fail(
          res,
          501,
          'no_launcher',
          `no launcher script at ${launcher.path}, so this dashboard cannot ` +
            'restart itself — run it by hand',
          { restart_command: launcher.command }
        );
        return;
      }

      // Answer first. The child is going to stop this process, and a browser that saw
      // a dropped socket instead of an acknowledgement could not tell a restart from a
      // crash — so it would not know whether to wait for the daemon to come back.
      res.status(200).json({
        ok: true,
        restarting: true,
        restart_command: launcher.command
      });
      res.on('finish', () => {
        log('restart acknowledged; spawning %s', launcher.path);
        try {
          startRestart(launcher.path);
        } catch (err) {
          // Nothing left to answer with — the response has already gone. Logged so the
          // terminal that launched the daemon says why it is still up.
          log('restart spawn failed: %o', err);
        }
      });
    }
  );

  /**
   * Whether a restart from this request would be permitted, without doing it.
   *
   * Shared by `GET /api/build` so the UI can offer the button only when it would work,
   * and so the advertised reason and the POST's refusal cannot disagree. The POST still
   * re-checks rather than trusting this: an advertisement is not an authorization, and
   * the two are seconds apart at best.
   *
   * Depends on the request only through its peer address — there is no identity in it,
   * for the reasons in the header. The reasons returned here are written for a person
   * reading a banner, not borrowed from the board policy, which phrases its refusals
   * around board actions and would tell somebody to sign in "to manage_agents anything".
   *
   * @param {import('express').Request} req
   * @returns {{ allowed: boolean, reason: string }}
   */
  function restartAllowedFor(req) {
    if (!launcher.available) {
      return { allowed: false, reason: 'no launcher script on this install' };
    }
    if (requireAgent(env)) {
      return {
        allowed: false,
        reason: 'FEADS_REQUIRE_AGENT is set, so restart is not offered'
      };
    }
    if (!isLocal(req)) {
      return {
        allowed: false,
        reason:
          'the dashboard can only be restarted from the machine it runs on'
      };
    }
    return {
      allowed: true,
      reason:
        'a local caller already owns this process — it can be restarted from the shell too'
    };
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
function requireAgent(env) {
  const raw = String(env.FEADS_REQUIRE_AGENT || '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Start the launcher so that it survives this process.
 *
 * `detached` puts it in its own process group and `unref` drops it from this event
 * loop, so the `stop` half of the restart — which kills us — does not kill the thing
 * doing the restarting. `stdio: 'ignore'` for the same reason: a pipe to a dead parent
 * is a child blocked on a write nobody will ever read.
 *
 * @param {string} script
 * @returns {void}
 */
export function spawnDetachedRestart(script) {
  const child = spawn(script, ['restart'], {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
    cwd: path.dirname(path.dirname(script))
  });
  child.unref();
}
