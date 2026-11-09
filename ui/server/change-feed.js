import { readableBoardIds } from './accounts.js';
import { resolveHttpActor } from './notifications-engine.js';
import { getPgStore } from './pg-store.js';

const MAX_PAGE_SIZE = 500;

/**
 * Mount the authenticated cross-board change feed.
 *
 * Reads are intentionally unscoped after authentication: boards/authz.mjs makes
 * the read permission an all-board permission so agents can coordinate across
 * boards. A token is still required here; this endpoint is an agent API, not a
 * browser's anonymous read surface.
 *
 * @param {import('express').Express} app
 * @param {{ env?: Record<string, string | undefined>, ssoVerifier?: any }} [options]
 */
export function attachChangeFeedRoutes(app, options = {}) {
  const env = options.env || process.env;
  const authOptions = { env, ssoVerifier: options.ssoVerifier };

  app.get('/api/v1/changes', async (req, res) => {
    const auth = await resolveHttpActor(req, authOptions);
    // Accounts mode admits read-only system keys here (they carry no actor).
    if (!auth.actor && !auth.system) {
      const code = auth.error_code || 'not_identified';
      res.status(code === 'registry_unavailable' ? 503 : 401).json({
        ok: false,
        error: code
      });
      return;
    }

    const store = getPgStore(env);
    if (!store) {
      res.status(503).json({ ok: false, error: 'change_feed_unavailable' });
      return;
    }

    const limit_raw = String(req.query?.limit ?? '100');
    const limit = Number.parseInt(limit_raw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      res.status(400).json({
        ok: false,
        error: 'bad_request',
        message: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`
      });
      return;
    }

    const boards_raw = req.query?.boards ?? req.query?.['boards[]'];
    const boards = (Array.isArray(boards_raw) ? boards_raw : [boards_raw])
      .filter((/** @type {unknown} */ value) => value !== undefined)
      .flatMap((/** @type {unknown} */ value) => String(value).split(','))
      .map((/** @type {string} */ value) => value.trim())
      .filter(Boolean);
    const since = optionalQuery(req.query?.since);
    const until = optionalQuery(req.query?.until);
    if ((since && !validDate(since)) || (until && !validDate(until))) {
      res.status(400).json({
        ok: false,
        error: 'bad_request',
        message: 'since and until must be ISO-8601 timestamps'
      });
      return;
    }

    // Accounts mode: only boards in spaces the caller may read. An explicit
    // request for anything else narrows to nothing instead of erroring, so the
    // feed is not an oracle for which boards exist.
    let scoped = boards;
    if (auth.resolved?.principal) {
      const readable = await readableBoardIds(auth.resolved, env);
      if (readable !== null) {
        scoped = (boards.length ? boards : [...readable]).filter((b) =>
          readable.has(b)
        );
        if (scoped.length === 0) {
          res
            .status(200)
            .json({ changes: [], next_cursor: null, complete: true });
          return;
        }
      }
    }

    try {
      const result = await store.fetchChanges({
        after_cursor: optionalQuery(req.query?.after_cursor),
        since,
        until,
        boards: scoped,
        limit
      });
      res.status(200).json(result);
    } catch (error) {
      const fault = /** @type {any} */ (error);
      const code = String(fault?.code || '');
      const status = code === 'bad_request' ? 400 : 503;
      res.status(status).json({
        ok: false,
        error: code || 'change_feed_unavailable',
        ...(code === 'bad_request' ? { message: fault.message } : {})
      });
    }
  });
}

/** @param {unknown} value */
function optionalQuery(value) {
  const text = Array.isArray(value) ? value[0] : value;
  const result = String(text ?? '').trim();
  return result || null;
}

/** @param {string} value */
function validDate(value) {
  return Number.isFinite(Date.parse(value));
}
