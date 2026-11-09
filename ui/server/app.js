/**
 * @import { Express, Request, Response } from 'express'
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropFlare, listFlares, raiseFlare } from '../../boards/flares.mjs';
import { openRegistry } from '../../boards/registry.mjs';
import { attachAccountsInternalEdgeRoutes } from './accounts-internal-edge.js';
import { attachAccountsRoutes } from './accounts-routes.js';
import {
  accountsOn,
  boardAccess,
  boardSpaces,
  decide,
  readableBoardIds
} from './accounts.js';
import { findNearestBoardDir } from './active-board.js';
import { attachAgentSessionRoutes } from './agent-session.js';
import { attachAgentwatchRoutes } from './agentwatch-routes.js';
import { attachBotIdentityRoutes } from './bot-identities.js';
import { createBuildIdentity } from './build-identity.js';
import { attachChangeFeedRoutes } from './change-feed.js';
import { createCompressedStatic } from './compressed-static.js';
import { attachIssueRoutes } from './issues-routes.js';
import { attachMcpProxy } from './mcp-proxy.js';
import {
  attachNotificationRoutes,
  isSiloBrowserMutationAllowed,
  resolveHttpActor
} from './notifications-engine.js';
import { boardIdForDir } from './pg-store.js';
import {
  assertValidSiloEnvironment,
  createPlatformSsoVerifier,
  siloMode
} from './platform-sso.js';
import {
  getAvailableWorkspaces,
  registerWorkspace
} from './registry-watcher.js';
import { attachRuntimePresenceRoutes } from './runtime-presence.js';
import { attachServerRoutes } from './server-routes.js';

const SERVER_DIR = path.dirname(fileURLToPath(new URL(import.meta.url)));

/**
 * Create and configure the Express application.
 *
 * @param {{ host: string, port: number, app_dir: string, root_dir: string }} config - Server configuration.
 * @param {Object} [options]
 * @param {Record<string, string | undefined>} [options.env] - Trusted deployment
 * configuration seam for tests.
 * @param {ReturnType<typeof createPlatformSsoVerifier>} [options.ssoVerifier]
 * @param {any} [options.accountsVerifier] - Accounts-mode SSO verifier (tests).
 * @param {ReturnType<typeof createBuildIdentity>} [options.identity] - feads: the
 * build this process is running. Passed in by `index.js` so the HTTP routes, the
 * version-stamped script URL and the WebSocket's `build-info` event all describe the
 * *same* snapshot — two independently captured boot identities would disagree about
 * what "boot" meant the moment anything on disk changed between them.
 * @param {() => unknown | Promise<unknown>} [options.nudgeAgentwatchRefresh] - Best-effort
 * refresh callback for committed runtime-presence writes.
 * @returns {Express} Configured Express app instance.
 */
export function createApp(config, options = {}) {
  const env = options.env || process.env;
  assertValidSiloEnvironment(env);
  const ssoVerifier = options.ssoVerifier || createPlatformSsoVerifier({ env });
  // How every route here resolves its caller: the silo verifier, plus the
  // accounts-mode SSO verifier when one is injected (tests; production builds its
  // own from the environment).
  const httpAuth = {
    env,
    ssoVerifier,
    ...(options.accountsVerifier
      ? { accountsVerifier: options.accountsVerifier }
      : {})
  };
  const app = express();
  const identity =
    options.identity ||
    createBuildIdentity({ app_dir: config.app_dir, server_dir: SERVER_DIR });

  // Basic hardening and config
  app.disable('x-powered-by');

  // Health endpoint
  /**
   * @param {Request} _req
   * @param {Response} res
   */
  app.get('/healthz', (_req, res) => {
    res.type('application/json');
    res.status(200).send({ ok: true });
  });

  // Mount before JSON parsing so MCP bodies stream byte-for-byte to the upstream.
  attachMcpProxy(app);

  // The bot-mint door (accounts mode, base instance only): its own credential,
  // body limit and rate limit, so it mounts ahead of the app-wide JSON parser and
  // never meets the SSO / token resolution the other accounts routes use. 404
  // unless FEADS_BOT_MINT_TOKEN_SHA256 is configured and accounts mode is on.
  if (siloMode(env) === 'base') attachBotIdentityRoutes(app, { env });

  // Enable JSON body parsing for API endpoints
  app.use(express.json());

  // Register workspace endpoint - allows CLI to register workspaces dynamically
  // when the server is already running
  /**
   * @param {Request} req
   * @param {Response} res
   */
  app.post('/api/register-workspace', async (req, res) => {
    if (siloMode(env) === 'silo') {
      const auth = await resolveHttpActor(req, {
        env,
        ssoVerifier
      });
      if (!auth.actor) {
        const code = auth.error_code || 'not_identified';
        const status =
          code === 'registry_unavailable'
            ? 503
            : code === 'bad_request'
              ? 400
              : 401;
        res.status(status).json({ ok: false, error: code });
        return;
      }
      if (!isSiloBrowserMutationAllowed(req, auth, env)) {
        res.status(403).json({ ok: false, error: 'origin_forbidden' });
        return;
      }
    } else if (await accountsOn(env)) {
      // Accounts mode: registering a workspace is `board_create` on the space of
      // the board it names (DESIGN "Enforcement map"). Its database must be that
      // board's own. A path naming no registered board is for callers that read
      // every space; an unknown board and one in another space answer alike.
      const auth = await resolveHttpActor(req, httpAuth);
      if (!auth.actor || !auth.agent) {
        const code = auth.system
          ? 'forbidden'
          : auth.error_code || 'not_identified';
        res
          .status(
            code === 'forbidden'
              ? 403
              : code === 'registry_unavailable'
                ? 503
                : 401
          )
          .json({ ok: false, error: code });
        return;
      }
      if (!isSiloBrowserMutationAllowed(req, auth, env)) {
        res.status(403).json({ ok: false, error: 'origin_forbidden' });
        return;
      }
      const body = req.body || {};
      if (
        !(await workspaceRegistrable(
          auth.resolved,
          { path: body.path, database: body.database },
          env
        ))
      ) {
        res.status(403).json({ ok: false, error: 'forbidden' });
        return;
      }
    }
    const { path: workspace_path, database } = req.body || {};
    if (!workspace_path || typeof workspace_path !== 'string') {
      res.status(400).json({ ok: false, error: 'Missing or invalid path' });
      return;
    }
    if (!database || typeof database !== 'string') {
      res.status(400).json({ ok: false, error: 'Missing or invalid database' });
      return;
    }
    registerWorkspace({ path: workspace_path, database });
    res.status(200).json({ ok: true, registered: workspace_path });
  });

  // List all known workspaces (file-based registry + in-memory)
  app.get('/api/workspaces', async (req, res) => {
    const workspaces = getAvailableWorkspaces();
    if (siloMode(env) === 'base' && (await accountsOn(env))) {
      // Accounts mode: any identified caller, each entry only when every board it
      // names is readable (F). Entries naming no registered board are server-local
      // paths, listed only to callers that read every space.
      const auth = await resolveHttpActor(req, httpAuth);
      if (!auth.resolved?.principal || (!auth.actor && !auth.system)) {
        const code = auth.error_code || 'not_identified';
        res
          .status(code === 'registry_unavailable' ? 503 : 401)
          .json({ ok: false, error: code });
        return;
      }
      const readable = await readableBoardIds(auth.resolved, env);
      res.status(200).json({
        ok: true,
        workspaces: workspaces.filter((w) => workspaceReadable(w, readable))
      });
      return;
    }
    res.status(200).json({ ok: true, workspaces });
  });

  // feads: paste-a-token login, and logout. Over HTTP rather than the WebSocket
  // because the credential lands in a `Set-Cookie` header, and a WebSocket frame
  // has no way to set one — which is also what keeps the token out of page
  // JavaScript entirely. See agent-session.js.
  attachAgentSessionRoutes(app, {
    root_dir: config.root_dir,
    env,
    ssoVerifier,
    ...(options.accountsVerifier
      ? { accountsVerifier: options.accountsVerifier }
      : {})
  });

  // feads: "is this daemon running the code on disk?", and the button that fixes it
  // when the answer is no. Over HTTP rather than the WebSocket because the whole point
  // is to be answerable when the socket is the broken thing — and because the restart
  // has to return a response to a request that is about to outlive the process.
  if (siloMode(env) === 'silo') {
    app.use('/api/server/restart', (req, res, next) => {
      if (req.method === 'POST') {
        res.status(403).json({ ok: false, error: 'restart_disabled' });
        return;
      }
      next();
    });
  }
  attachServerRoutes(app, {
    identity,
    env,
    launcher_root: repoRootFrom(config)
  });

  // Authenticated, keyset-paged cross-board changes for programmatic consumers.
  attachChangeFeedRoutes(app, { env, ssoVerifier });

  // feads: the notification inbox over HTTP. Exists for the MCP server, which
  // reads the store directly but must not write it — the ack goes through the
  // dashboard, the registry's one writer, exactly as agent sign-up does.
  attachNotificationRoutes(app, { env, ssoVerifier });

  // Ephemeral phi process/session presence. The optional nudge is deliberately
  // injected by the WebSocket layer to avoid an import cycle; ingestion remains
  // successful if that scheduler is unavailable.
  attachRuntimePresenceRoutes(app, {
    env,
    ssoVerifier,
    nudgeAgentwatchRefresh: options.nudgeAgentwatchRefresh
  });

  // Agentwatch for agent-token readers (P3's Agents panel): the dashboard's
  // WebSocket snapshot over HTTP, scoped to what the caller may see.
  attachAgentwatchRoutes(app, {
    env,
    ssoVerifier,
    ...(options.accountsVerifier
      ? { accountsVerifier: options.accountsVerifier }
      : {})
  });

  // Cross-board issue list for agent-token readers (P3's "My work" feed).
  attachIssueRoutes(app, {
    env,
    ssoVerifier,
    ...(options.accountsVerifier
      ? { accountsVerifier: options.accountsVerifier }
      : {})
  });


  // Accounts mode: spaces, memberships, connections, system keys, access panel.
  // Every route answers 404 accounts_off until the registry enables the mode.
  if (siloMode(env) === 'base') {
    attachAccountsRoutes(app, {
      env,
      ...(options.accountsVerifier
        ? { verifier: options.accountsVerifier }
        : {})
    });
    attachAccountsInternalEdgeRoutes(app, { env });
  }

  // Ephemeral advisory presence. Flares are never consulted by authorization or
  // claim paths; they only tell readers who is probably working here.
  app.put('/api/flares', async (req, res) => {
    const auth = await resolveHttpActor(req, httpAuth);
    if (!auth.actor || !auth.agent) {
      const code = auth.error_code || 'not_identified';
      const status =
        code === 'registry_unavailable'
          ? 503
          : code === 'bad_request'
            ? 400
            : 401;
      res.status(status).json({ ok: false, error: code });
      return;
    }
    if (!isSiloBrowserMutationAllowed(req, auth, env)) {
      res.status(403).json({ ok: false, error: 'origin_forbidden' });
      return;
    }
    const body = req.body || {};
    const board_id = String(body.board_id || '').trim();
    const issue_id = String(body.issue_id || '').trim();
    if (!board_id || !issue_id) {
      res.status(400).json({ ok: false, error: 'bad_request' });
      return;
    }
    if (auth.resolved?.principal) {
      const access = await boardAccess(auth.resolved, board_id, true, env);
      if (!access.allowed) {
        res.status(403).json({ ok: false, error: 'forbidden' });
        return;
      }
    }
    const db = openRegistry({ env });
    try {
      const flare = raiseFlare(db, {
        agent_id: auth.agent.id,
        actor: auth.actor,
        parent_actor: auth.agent.parent_actor || '',
        board_id,
        issue_id
      });
      res.json({ ok: true, flare });
    } finally {
      db.close();
    }
  });
  app.delete('/api/flares', async (req, res) => {
    const auth = await resolveHttpActor(req, httpAuth);
    if (!auth.actor || !auth.agent) {
      const code = auth.error_code || 'not_identified';
      const status =
        code === 'registry_unavailable'
          ? 503
          : code === 'bad_request'
            ? 400
            : 401;
      res.status(status).json({ ok: false, error: code });
      return;
    }
    if (!isSiloBrowserMutationAllowed(req, auth, env)) {
      res.status(403).json({ ok: false, error: 'origin_forbidden' });
      return;
    }
    const body = req.body || {};
    const board_id = String(body.board_id || '').trim();
    const issue_id = String(body.issue_id || '').trim();
    if (!board_id || !issue_id) {
      res.status(400).json({ ok: false, error: 'bad_request' });
      return;
    }
    if (auth.resolved?.principal) {
      // Same W check as raising one: dropping a flare is a write on its board.
      const access = await boardAccess(auth.resolved, board_id, true, env);
      if (!access.allowed) {
        res.status(403).json({ ok: false, error: 'forbidden' });
        return;
      }
    }
    const db = openRegistry({ env });
    try {
      let agent_id = auth.agent.id;
      const owner = db
        .prepare(
          'SELECT agent_id FROM work_flares WHERE board_id = ? AND issue_id = ? AND agent_id = ?'
        )
        .get(board_id, issue_id, agent_id);
      if (!owner) {
        const child = db
          .prepare(
            'SELECT f.agent_id FROM work_flares f JOIN agents a ON a.id = f.agent_id WHERE f.board_id = ? AND f.issue_id = ? AND a.parent_agent_id = ?'
          )
          .get(board_id, issue_id, agent_id);
        if (child) agent_id = child.agent_id;
      }
      const dropped = dropFlare(db, { agent_id, board_id, issue_id });
      res.json({ ok: true, dropped });
    } finally {
      db.close();
    }
  });
  app.get('/api/flares', async (req, res) => {
    const auth = await resolveHttpActor(req, httpAuth);
    if (!auth.actor && !auth.system) {
      res.status(401).json({ ok: false, error: 'not_identified' });
      return;
    }
    const readable = auth.resolved?.principal
      ? await readableBoardIds(auth.resolved, env)
      : null;
    const db = openRegistry({ env });
    try {
      res.json({
        ok: true,
        flares: listFlares(db, {
          board_id: String(req.query.board_id || ''),
          issue_id: String(req.query.issue_id || '')
        }).filter(
          (/** @type {any} */ f) =>
            readable === null || readable.has(String(f.board_id))
        )
      });
    } finally {
      db.close();
    }
  });

  if (
    !fs.statSync(path.resolve(config.app_dir, 'main.bundle.js'), {
      throwIfNoEntry: false
    })
  ) {
    /**
     * On-demand bundle for the browser using esbuild.
     *
     * @param {Request} _req
     * @param {Response} res
     */
    app.get('/main.bundle.js', async (_req, res) => {
      try {
        const esbuild = await import('esbuild');
        const entry = path.join(config.app_dir, 'main.js');
        const result = await esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: 'esm',
          platform: 'browser',
          target: 'es2020',
          sourcemap: 'inline',
          minify: false,
          write: false
        });
        const out = result.outputFiles && result.outputFiles[0];
        if (!out) {
          res.status(500).type('text/plain').send('Bundle failed: no output');
          return;
        }
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(out.text);
      } catch (err) {
        res
          .status(500)
          .type('text/plain')
          .send('Bundle error: ' + (err && /** @type {any} */ (err).message));
      }
    });
  }

  if (
    !fs.statSync(path.resolve(config.app_dir, 'people.bundle.js'), {
      throwIfNoEntry: false
    })
  ) {
    /**
     * feads: on-demand person hover card bundle (React + the optional directory component), for an
     * unbuilt checkout — the same build `npm run build` writes to disk.
     *
     * @type {Promise<Map<string, string>> | null}
     */
    let people = null;
    const buildPeople = () => {
      people ??= (async () => {
        const esbuild = await import('esbuild');
        const result = await esbuild.build({
          entryPoints: [path.join(config.app_dir, 'people', 'hover-card.js')],
          bundle: true,
          format: 'esm',
          platform: 'browser',
          target: 'es2020',
          outfile: path.join(config.app_dir, 'people.bundle.js'),
          define: { 'process.env.NODE_ENV': '"development"' },
          write: false
        });
        const files = new Map();
        for (const f of result.outputFiles || []) {
          files.set(path.basename(f.path), f.text);
        }
        return files;
      })().catch((err) => {
        people = null;
        throw err;
      });
      return people;
    };
    for (const [name, type] of [
      ['people.bundle.js', 'application/javascript; charset=utf-8'],
      ['people.bundle.css', 'text/css; charset=utf-8']
    ]) {
      app.get(`/${name}`, async (_req, res) => {
        try {
          const text = (await buildPeople()).get(name);
          if (text === undefined) {
            res.status(404).type('text/plain').send('not built');
            return;
          }
          res.setHeader('Content-Type', type);
          res.setHeader('Cache-Control', 'no-store');
          res.send(text);
        } catch (err) {
          res
            .status(500)
            .type('text/plain')
            .send('Bundle error: ' + (err && /** @type {any} */ (err).message));
        }
      });
    }
  }

  /**
   * Serve `index.html` with the bundle URL stamped with the current bundle id, and
   * with caching switched off (feads).
   *
   * This is the mechanism that makes "reload" actually fetch new *bytes*, and it needs
   * both halves:
   *
   * - **`Cache-Control: no-store` on the HTML** so a reload genuinely re-fetches the
   *   document rather than replaying the copy in the browser's cache. Without this the
   *   browser can satisfy the navigation from cache and never learn the script URL
   *   changed, which is precisely the loop where a person reloads and reloads and keeps
   *   getting the old UI.
   * - **`?v=<bundle_id>` on the script** so that when the bundle changes, its URL
   *   changes. A revalidation of a fixed URL depends on ETag and heuristics; a
   *   different URL is a different resource and cannot be served from the old entry.
   *
   * It also gives the client its own identity for free: the bundle reads the `v` from
   * `import.meta.url`, so it knows which build it *is* without the build having to
   * embed a stamp it cannot compute (a bundle cannot contain its own hash). See
   * `app/build-info.js`.
   *
   * Registered before `express.static`, because static would otherwise answer
   * `/index.html` (and `/`) from disk with no rewriting and its own cache headers.
   *
   * @param {Request} _req
   * @param {Response} res
   * @returns {void}
   */
  function sendIndex(_req, res) {
    const index_path = path.join(config.app_dir, 'index.html');
    /** @type {string} */
    let html;
    try {
      html = fs.readFileSync(index_path, 'utf8');
    } catch {
      res.status(500).type('text/plain').send('index.html not found');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(stampBundleUrl(html, identity.bundleId()));
  }

  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);

  // Bundled fonts are immutable per filename — cache them hard so a reload
  // (which re-fetches the no-store HTML) does not re-negotiate every face.
  app.use(
    '/fonts',
    express.static(path.join(config.app_dir, 'fonts'), {
      maxAge: '30d',
      immutable: true
    })
  );

  // feads: text assets compressed once per build (br/gzip) with strong ETags,
  // and the versioned bundle cached immutably — see compressed-static.js.
  // Anything it declines falls through to plain express.static.
  app.use(
    createCompressedStatic(config.app_dir, {
      bundleId: () => identity.bundleId()
    })
  );

  // Static assets from /app
  app.use(express.static(config.app_dir));

  return app;
}

/**
 * Add `?v=<bundle_id>` to the bundle's `<script src>`.
 *
 * Exported for the test that proves the reload mechanism: what makes a reload get new
 * bytes is that this string changes when the bundle does.
 *
 * A no-op when there is no id (nothing to stamp with) or when the tag already carries
 * a query, so serving an already-stamped file cannot produce `?v=a?v=b`.
 *
 * @param {string} html
 * @param {string} bundle_id
 * @returns {string}
 */
export function stampBundleUrl(html, bundle_id) {
  const id = String(bundle_id || '');
  if (id.length === 0) {
    return html;
  }
  return html.replace(
    /(<script[^>]*\ssrc=")([^"?]*main\.bundle\.js)(")/,
    (_match, before, src, after) =>
      `${before}${src}?v=${encodeURIComponent(id)}${after}`
  );
}

/**
 * Where `scripts/feads-run.sh` should be, given the installed package layout.
 *
 * `app_dir` is `<package>/app`, so the package root is its parent and the repo that
 * holds the launcher is the parent of that. Derived from `app_dir` rather than from
 * `root_dir`, which is the directory the process was *invoked* in and has nothing to do
 * with where this code was installed.
 *
 * @param {{ app_dir: string }} config
 * @returns {string}
 */
function repoRootFrom(config) {
  return path.resolve(config.app_dir, '..', '..');
}

/**
 * The boards a server workspace entry names (accounts mode): the board whose
 * `.beads` directory holds its project root, and the board whose `.beads`
 * directory holds its database. `null` for a database outside any `.beads`
 * directory — a path that cannot be attributed to a board.
 *
 * @param {{ path?: unknown, database?: unknown }} entry
 * @returns {{ from_path: string, from_db: string | null }}
 */
function workspaceBoards(entry) {
  const root = typeof entry.path === 'string' ? entry.path : '';
  const from_path = root
    ? boardIdForDir(findNearestBoardDir(path.resolve(root)))
    : '';
  const database = typeof entry.database === 'string' ? entry.database : '';
  if (!database) return { from_path, from_db: '' };
  const db_dir = path.dirname(path.resolve(database));
  return {
    from_path,
    from_db: path.basename(db_dir) === '.beads' ? boardIdForDir(db_dir) : null
  };
}

/**
 * Whether one `/api/workspaces` entry may be listed to a caller whose readable
 * boards are `readable` (`null` = every board).
 *
 * @param {{ path?: unknown, database?: unknown }} entry
 * @param {Set<string> | null} readable
 * @returns {boolean}
 */
function workspaceReadable(entry, readable) {
  if (readable === null) return true;
  const { from_path, from_db } = workspaceBoards(entry);
  if (!from_path || !readable.has(from_path)) return false;
  return from_db === '' || (from_db !== null && readable.has(from_db));
}

/**
 * Accounts mode: may this caller register this workspace? `board_create` on the
 * space of the board it names, with the database inside that same board. A
 * caller reading every space may also register a path naming no registered
 * board. Unknown and unreadable boards both answer no.
 *
 * @param {any} resolved
 * @param {{ path?: unknown, database?: unknown }} entry
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<boolean>}
 */
async function workspaceRegistrable(resolved, entry, env) {
  const readable = await readableBoardIds(resolved, env);
  const kind = String(resolved?.principal?.kind || 'anonymous');
  if (readable === null) return kind === 'user' || kind === 'operator';
  const { from_path, from_db } = workspaceBoards(entry);
  if (!from_path || from_db !== from_path) return false;
  const space = (await boardSpaces(env)).get(from_path) || '';
  return (await decide(resolved, 'board_create', { space })).allowed;
}
