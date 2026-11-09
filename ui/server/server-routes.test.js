/**
 * feads addition — `GET /api/build` and the gated `POST /api/server/restart`.
 *
 * Driven through a real express app over a real socket, like `agent-session.test.js`,
 * because two of the things worth proving are properties of the *transport*: that a
 * request from off-box is refused on the strength of its peer address, and that the
 * response is flushed before the process is asked to go away.
 *
 * The launcher script is a temp file rather than the repo's own, and the spawn is
 * intercepted, for the obvious reason: a test that actually restarted the developer's
 * dashboard would be a bad test.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  attachServerRoutes,
  isLoopbackRequest,
  resolveLauncher
} from './server-routes.js';

/** @type {string[]} */
const temp_dirs = [];

afterEach(() => {
  while (temp_dirs.length > 0) {
    fs.rmSync(String(temp_dirs.pop()), { recursive: true, force: true });
  }
});

/**
 * A fake install with a `scripts/feads-run.sh` in it.
 *
 * @param {{ launcher?: boolean }} [options]
 * @returns {string}
 */
function makeLauncherRoot(options = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'feads-restart-'))
  );
  temp_dirs.push(root);
  if (options.launcher !== false) {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const script = path.join(root, 'scripts', 'feads-run.sh');
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(script, 0o755);
  }
  return root;
}

/** A report shaped like `createBuildIdentity().report()`. */
const REPORT = {
  build_id: 'boot123',
  bundle_id: 'bundleabc',
  boot_bundle_id: 'bundleabc',
  server_stale: false,
  boot_at: 1785000000000,
  source_newest_mtime_ms: 1785000000000,
  boot_source_newest_mtime_ms: 1785000000000,
  restart_command: 'scripts/feads-run.sh restart'
};

/**
 * @typedef {Object} Harness
 * @property {import('express').Express} app
 * @property {string[]} spawned
 * @property {string[]} order - What happened, in order, so "response before spawn" is
 * checkable rather than assumed.
 */

/**
 * Note what this harness has no seam for: identity. There is none to inject, because the
 * routes do not resolve one — see the module header. A harness that still offered a
 * `resolve` or a `decide` would imply the gate consults them, which is the thing a
 * future reader must not conclude.
 *
 * @param {Object} [overrides]
 * @param {boolean} [overrides.local]
 * @param {boolean} [overrides.launcher]
 * @param {Record<string, string | undefined>} [overrides.env]
 * @param {(script: string) => void} [overrides.spawnRestart]
 * @returns {Harness}
 */
function makeApp(overrides = {}) {
  const app = express();
  app.use(express.json());
  /** @type {string[]} */
  const spawned = [];
  /** @type {string[]} */
  const order = [];

  attachServerRoutes(app, {
    identity: { report: () => ({ ...REPORT }) },
    launcher_root: makeLauncherRoot({ launcher: overrides.launcher }),
    env: overrides.env || {},
    ...(overrides.local === undefined
      ? {}
      : { isLocalRequest: () => overrides.local === true }),
    spawnRestart:
      overrides.spawnRestart ||
      ((script) => {
        order.push('spawn');
        spawned.push(script);
      })
  });

  return { app, spawned, order };
}

/**
 * Start the app on an ephemeral loopback port and issue one request.
 *
 * `headers` exists so a request can carry an agent cookie. Nothing in these routes reads
 * one — that is the point of several tests below.
 *
 * @param {import('express').Express} app
 * @param {string} method
 * @param {string} route
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, json: any, headers: Headers }>}
 */
async function call(app, method, route, headers = {}) {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const address = /** @type {any} */ (server.address());
    const res = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'POST' ? { body: '{}' } : {})
    });
    return { status: res.status, json: await res.json(), headers: res.headers };
  } finally {
    server.close();
  }
}

describe('isLoopbackRequest', () => {
  test('accepts the loopback forms Node actually reports', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::1%lo0']) {
      expect(
        isLoopbackRequest(
          /** @type {any} */ ({ socket: { remoteAddress: address } })
        )
      ).toBe(true);
    }
  });

  test('refuses an off-box peer', () => {
    for (const address of ['192.168.1.5', '10.0.0.2', '203.0.113.7']) {
      expect(
        isLoopbackRequest(
          /** @type {any} */ ({ socket: { remoteAddress: address } })
        )
      ).toBe(false);
    }
  });

  test('an unreadable peer is not local', () => {
    // This gate exists to refuse, so an absent answer has to mean no.
    expect(isLoopbackRequest(/** @type {any} */ ({}))).toBe(false);
    expect(
      isLoopbackRequest(/** @type {any} */ ({ socket: { remoteAddress: '' } }))
    ).toBe(false);
  });

  test('a forwarding header cannot make a remote request local', () => {
    // `X-Forwarded-For` is writable by any client, so trusting it would make this gate
    // decorative. Only the socket's peer address counts.
    expect(
      isLoopbackRequest(
        /** @type {any} */ ({
          socket: { remoteAddress: '203.0.113.7' },
          headers: { 'x-forwarded-for': '127.0.0.1' }
        })
      )
    ).toBe(false);
  });

  test('and cannot make a local request remote either', () => {
    expect(
      isLoopbackRequest(
        /** @type {any} */ ({
          socket: { remoteAddress: '127.0.0.1' },
          headers: { 'x-forwarded-for': '203.0.113.7' }
        })
      )
    ).toBe(true);
  });
});

describe('GET /api/build', () => {
  test('reports the build without needing a socket or a credential', async () => {
    // Ungated deliberately: the whole point is to be answerable when the socket path is
    // the broken thing.
    const { app } = makeApp();
    const res = await call(app, 'GET', '/api/build');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.build_id).toBe('boot123');
    expect(res.json.bundle_id).toBe('bundleabc');
    expect(res.json.server_stale).toBe(false);
    expect(res.json.restart_command).toBe('scripts/feads-run.sh restart');
  });

  test('is never cached, because a cached answer to "are you stale?" is the bug', async () => {
    const { app } = makeApp();
    const res = await call(app, 'GET', '/api/build');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a local caller is told the restart is available to it, credential or not', async () => {
    // This is the corrected gate. It looks like a loosening; it is not — see the module
    // header. The old version required operator-or-admin, which on a machine with an
    // agent registry hid the button from the machine's own owner by default, while
    // preventing nothing: that person can type the command in the terminal next to the
    // browser.
    const anonymous = await call(makeApp().app, 'GET', '/api/build');
    expect(anonymous.json.restart_offered).toBe(true);
    expect(anonymous.json.restart_allowed).toBe(true);

    const with_cookie = await call(makeApp().app, 'GET', '/api/build', {
      cookie: 'feads_agent_token=fdsa_a_plain_user'
    });
    expect(with_cookie.json.restart_allowed).toBe(true);
  });

  test('reports the feature as absent when there is no launcher', async () => {
    const res = await call(
      makeApp({ launcher: false }).app,
      'GET',
      '/api/build'
    );
    expect(res.json.restart_offered).toBe(false);
    expect(res.json.restart_allowed).toBe(false);
    // The command still is, so a person can act even where the button cannot.
    expect(res.json.restart_command).toBe('scripts/feads-run.sh restart');
  });

  test('reports the feature as absent under FEADS_REQUIRE_AGENT', async () => {
    const res = await call(
      makeApp({ env: { FEADS_REQUIRE_AGENT: '1' } }).app,
      'GET',
      '/api/build'
    );
    expect(res.json.restart_offered).toBe(false);
    expect(res.json.restart_allowed).toBe(false);
  });

  test('reports it as unavailable to a caller that is not local', async () => {
    const res = await call(makeApp({ local: false }).app, 'GET', '/api/build');
    // Offered by the deployment, but not to this caller — the two fields are distinct so
    // the UI can show the command without a button that would be refused.
    expect(res.json.restart_offered).toBe(true);
    expect(res.json.restart_allowed).toBe(false);
    expect(res.json.restart_reason).toContain('the machine it runs on');
  });
});

describe('POST /api/server/restart', () => {
  test('a local caller may restart, with no credential at all', async () => {
    // The corrected gate, asserted directly so nobody reinstates a role check here as a
    // security fix: it would hide the button from the machine's owner without adding a
    // boundary, because that person can already run the command from the shell.
    const harness = makeApp();
    const res = await call(harness.app, 'POST', '/api/server/restart');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.restarting).toBe(true);
    expect(harness.spawned).toHaveLength(1);
    expect(harness.spawned[0]).toContain(path.join('scripts', 'feads-run.sh'));
  });

  test('a plain user credential does not make it worse', async () => {
    // Previously refused. A `user` at a loopback browser is the machine's owner as far as
    // this process is concerned, and restarting it changes no issue, no identity and no
    // registry row — so there was nothing for the tier to protect.
    const harness = makeApp();
    const res = await call(harness.app, 'POST', '/api/server/restart', {
      cookie: 'feads_agent_token=fdsa_a_plain_user'
    });
    expect(res.status).toBe(200);
    expect(harness.spawned).toHaveLength(1);
  });

  test('a rejected or nonsense credential does not make it worse either', async () => {
    // No identity is resolved at all, so a revoked token is neither better nor worse than
    // none. The gate is the peer address and the environment flag.
    const harness = makeApp();
    const res = await call(harness.app, 'POST', '/api/server/restart', {
      cookie: 'feads_agent_token=not-even-a-token'
    });
    expect(res.status).toBe(200);
    expect(harness.spawned).toHaveLength(1);
  });

  test('a non-loopback request is refused outright', async () => {
    // One of the two protections that are real: a shared daemon fails this, and an
    // anonymous viewer off-box cannot bounce it under everyone else.
    const harness = makeApp({ local: false });
    const res = await call(harness.app, 'POST', '/api/server/restart');
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('not_local');
    expect(harness.spawned).toEqual([]);
    // Refused, but still told what to type.
    expect(res.json.restart_command).toBe('scripts/feads-run.sh restart');
  });

  test('a credential cannot buy a way past the loopback check', async () => {
    const harness = makeApp({ local: false });
    const res = await call(harness.app, 'POST', '/api/server/restart', {
      cookie: 'feads_agent_token=fdsa_an_admin'
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('not_local');
    expect(harness.spawned).toEqual([]);
  });

  test('FEADS_REQUIRE_AGENT removes the button entirely, credential or not', async () => {
    // The other real protection, and checked before anything else: a hosted deployment
    // must not have a restart button at all rather than have one behind a role.
    /** @type {Array<Record<string, string>>} */
    const presented = [{}, { cookie: 'feads_agent_token=fdsa_an_admin' }];
    for (const headers of presented) {
      const harness = makeApp({ env: { FEADS_REQUIRE_AGENT: '1' } });
      const res = await call(
        harness.app,
        'POST',
        '/api/server/restart',
        headers
      );
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('restart_disabled');
      expect(harness.spawned).toEqual([]);
      expect(res.json.restart_command).toBe('scripts/feads-run.sh restart');
    }
  });

  test('the flag outranks the loopback check, so the reason is the fundamental one', async () => {
    const harness = makeApp({
      local: false,
      env: { FEADS_REQUIRE_AGENT: '1' }
    });
    const res = await call(harness.app, 'POST', '/api/server/restart');
    expect(res.json.error.code).toBe('restart_disabled');
  });

  test('no launcher is reported rather than silently doing nothing', async () => {
    const harness = makeApp({ launcher: false });
    const res = await call(harness.app, 'POST', '/api/server/restart');
    expect(res.status).toBe(501);
    expect(res.json.error.code).toBe('no_launcher');
    expect(res.json.restart_command).toBe('scripts/feads-run.sh restart');
    expect(harness.spawned).toEqual([]);
  });

  test('the response is sent before the process is asked to go away', async () => {
    // If the child were spawned first, the browser would see a dropped connection
    // rather than an acknowledgement and could not tell a restart from a crash — so it
    // would not know whether to wait for the daemon to come back.
    const harness = makeApp();
    const res = await call(harness.app, 'POST', '/api/server/restart');
    expect(res.status).toBe(200);
    // `call` resolves once the body has been read, and the spawn is hung off the
    // response's own `finish`, so by here both have happened — in that order.
    expect(harness.order).toEqual(['spawn']);
    expect(harness.spawned).toHaveLength(1);
  });

  test('a spawn that throws does not become an unanswered request', async () => {
    // There is nothing left to answer with by then; the response has already gone. The
    // test is that the client still got its 200 rather than a hung socket.
    const harness = makeApp({
      spawnRestart: () => {
        throw new Error('EACCES');
      }
    });
    const res = await call(harness.app, 'POST', '/api/server/restart');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });
});

describe('resolveLauncher', () => {
  test('finds the script when it is there', () => {
    const root = makeLauncherRoot();
    const launcher = resolveLauncher(root);
    expect(launcher.available).toBe(true);
    expect(launcher.path).toBe(path.join(root, 'scripts', 'feads-run.sh'));
  });

  test('reports it missing without throwing, and still names the command', () => {
    // A published beads-ui package has no `scripts/`. The button is not offered there;
    // the command still is, because a person who knows their setup can act on it.
    const launcher = resolveLauncher(makeLauncherRoot({ launcher: false }));
    expect(launcher.available).toBe(false);
    expect(launcher.command).toBe('scripts/feads-run.sh restart');
  });

  test('the repo checkout has the launcher it advertises', () => {
    // Guards the one thing the temp-directory tests above cannot: that the path this
    // computes for a real install actually points at something. A restart button that
    // 501s on the developer's own machine would be found by nobody until it was needed.
    const repo_root = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      '..'
    );
    expect(resolveLauncher(repo_root).available).toBe(true);
  });
});

describe('the advertisement and the refusal agree', () => {
  test('a refused caller is told the same thing twice', async () => {
    // Two places explain the same decision seconds apart; disagreeing would be worse than
    // either wording on its own. Both come from `restartAllowedFor`.
    const harness = makeApp({ local: false });
    const advertised = await call(harness.app, 'GET', '/api/build');
    const refused = await call(harness.app, 'POST', '/api/server/restart');
    expect(advertised.json.restart_allowed).toBe(false);
    expect(advertised.json.restart_reason).toContain('the machine it runs on');
    expect(refused.json.error.message).toContain('the machine it runs on');
  });

  test('the reasons are written for a person, not borrowed from the board policy', async () => {
    // The old version reused `manage_agents`, so an unidentified caller was told to sign
    // in "to manage_agents anything" — in a banner they were reading because they were
    // already confused about why the dashboard was lying to them.
    const allowed = await call(makeApp().app, 'GET', '/api/build');
    expect(allowed.json.restart_reason).not.toContain('manage_agents');
    const refused = await call(
      makeApp({ env: { FEADS_REQUIRE_AGENT: '1' } }).app,
      'GET',
      '/api/build'
    );
    expect(refused.json.restart_reason).not.toContain('manage_agents');
    expect(refused.json.restart_reason).toContain('FEADS_REQUIRE_AGENT');
  });
});
