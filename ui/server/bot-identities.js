/**
 * The bot-mint door: a trusted provisioner (an external service) mints, rotates
 * and revokes Feads identities for AI teammates ("bots").
 *
 *   POST   /api/bot-identities          mint (201) / rotate or reactivate (200)
 *   GET    /api/bot-identities/:actor   metadata only — never a hash or token
 *   DELETE /api/bot-identities/:actor   revoke every key + disable (idempotent)
 *
 * A bot is a service account (`users.kind = 'service'`, `users.source =
 * 'service:bot'`) whose steward is a live person and whose reach is bounded, at
 * every resolution, by that steward's current agent-visible spaces
 * (`boards/accounts.mjs serviceMemberships`).
 *
 * Authentication is deliberately separate from every other door:
 *
 * - the ONLY accepted credential is `Authorization: Bearer fdbm_<32 hex>` whose
 *   SHA-256 matches one entry of `FEADS_BOT_MINT_TOKEN_SHA256` (comma list of
 *   64-hex digests, compared in constant time against every entry);
 * - SSO cookies, superadmins, `fdsa_`/`fdss_` tokens and the token cookie are
 *   never consulted here, and an `fdbm_` bearer is refused as an identity on
 *   every other route (`accounts-http.js bearerOf`);
 * - with the variable unset (or holding no valid digest) or accounts mode off,
 *   every route answers 404 — the feature does not exist.
 *
 * Mounted before the app-wide JSON parser so it gets its own small body limit,
 * and with its own rate limits (per credential; failed attempts in a separate bucket). Design: the excluded hosted-provider design
 */
import express from 'express';
import crypto from 'node:crypto';
import { accountsOn, resetAccountsCache, withAccounts } from './accounts.js';
import { debug } from './logging.js';

const log = debug('bot-identities');

export const BOT_MINT_HASHES_ENV = 'FEADS_BOT_MINT_TOKEN_SHA256';
export const BOT_MINT_TOKEN_PREFIX = 'fdbm_';
export const BOT_MINT_PATH = '/api/bot-identities';
const BOT_MINT_TOKEN_RE = /^fdbm_[0-9a-f]{32}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
/** Requests per credential (and per minute of failed attempts) (override: FEADS_BOT_MINT_RATE_PER_MIN). */
export const BOT_MINT_RATE_LIMIT = 30;
const BODY_LIMIT = '4kb';

/**
 * The configured credential digests, in order. Invalid entries are ignored.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Buffer[]}
 */
export function botMintDigests(env) {
  return String(env[BOT_MINT_HASHES_ENV] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => DIGEST_RE.test(s))
    .map((s) => Buffer.from(s, 'hex'));
}

/**
 * Index of the configured digest a presented header matches, else -1. Every
 * configured digest is compared (no early exit), each in constant time.
 *
 * @param {unknown} header
 * @param {Buffer[]} digests
 * @returns {number}
 */
export function matchBotMintCredential(header, digests) {
  if (typeof header !== 'string' || digests.length === 0) return -1;
  const m = /^Bearer[ \t]+(\S+)$/.exec(header.trim());
  const token = m ? m[1] : '';
  // A malformed value is still hashed and compared, so its timing says nothing.
  const presented = crypto.createHash('sha256').update(token, 'utf8').digest();
  let found = -1;
  for (let i = 0; i < digests.length; i += 1) {
    const hit = crypto.timingSafeEqual(presented, digests[i]);
    if (hit && found === -1) found = i;
  }
  return BOT_MINT_TOKEN_RE.test(token) ? found : -1;
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} [message]
 */
function fail(res, status, code, message) {
  res
    .status(status)
    .json({ ok: false, error: code, ...(message ? { message } : {}) });
}

/**
 * A tiny per-key token bucket (one minute window, refilled continuously).
 *
 * @param {number} per_minute
 */
function createBucket(per_minute) {
  /** @type {Map<string, { tokens: number, at: number }>} */
  const buckets = new Map();
  return {
    /** @param {string} key */
    take(key) {
      const now = Date.now();
      const b = buckets.get(key) || { tokens: per_minute, at: now };
      b.tokens = Math.min(
        per_minute,
        b.tokens + ((now - b.at) / 60_000) * per_minute
      );
      b.at = now;
      if (buckets.size > 10_000) buckets.clear();
      if (b.tokens < 1) {
        buckets.set(key, b);
        return false;
      }
      b.tokens -= 1;
      buckets.set(key, b);
      return true;
    }
  };
}

/**
 * The public shape of a bot in a response.
 *
 * @param {any} m - accounts modules
 * @param {any} db
 * @param {any} bot
 * @param {Record<string, string | undefined>} env
 */
function shape(m, db, bot, env) {
  return m.accounts.botIdentityShape(db, bot, env);
}

/**
 * @param {import('express').Express} app
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export function attachBotIdentityRoutes(app, options = {}) {
  const env = options.env || process.env;
  const configured = Number.parseInt(
    String(env.FEADS_BOT_MINT_RATE_PER_MIN || ''),
    10
  );
  const per_minute =
    Number.isInteger(configured) && configured > 0
      ? configured
      : BOT_MINT_RATE_LIMIT;
  // Two separate budgets. An authenticated caller spends the bucket of the
  // credential it presented (keyed by the matched digest index, never the IP —
  // every request arrives from the same proxy). Failed attempts share one
  // separate bucket, so a flood of bad credentials can only ever 429 itself and
  // never exhausts a valid caller's budget.
  const bucket = createBucket(per_minute);
  const failures = createBucket(per_minute);
  const router = express.Router();

  // Gate: feature on → credential → rate limit (per credential, or the shared
  // failure bucket). Runs before the body parser so a caller without the
  // credential never gets a body parsed.
  router.use(async (req, res, next) => {
    const digests = botMintDigests(env);
    if (digests.length === 0 || !(await accountsOn(env))) {
      fail(res, 404, 'not_found');
      return;
    }
    const raw = req.headers.authorization;
    const index = matchBotMintCredential(
      Array.isArray(raw) ? '' : raw,
      digests
    );
    if (index < 0) {
      if (!failures.take('unauthenticated')) fail(res, 429, 'rate_limited');
      else fail(res, 401, 'not_authenticated');
      return;
    }
    if (!bucket.take(`credential:${index}`)) {
      fail(res, 429, 'rate_limited');
      return;
    }
    /** @type {any} */ (req).__botMintIndex = index;
    next();
  });
  router.use(express.json({ limit: BODY_LIMIT, strict: true }));

  router.post('/', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      fail(res, 400, 'bad_request');
      return;
    }
    const hash_index = /** @type {any} */ (req).__botMintIndex;
    try {
      const out = await withAccounts(
        (m, db) => {
          const r = m.accounts.mintBotIdentity(db, {
            actor: body.actor,
            display_name: body.display_name,
            owner_email: body.owner_email,
            spaces: body.spaces,
            read_only: body.read_only,
            bot_ref: body.bot_ref,
            rotate: body.rotate,
            hash_index,
            env
          });
          return {
            status: r.status,
            service: shape(m, db, r.service, env),
            credential_id: String(r.credential?.id || ''),
            token: r.token
          };
        },
        { env, rethrow: true }
      );
      if (!out) {
        fail(res, 503, 'registry_unavailable');
        return;
      }
      resetAccountsCache();
      res
        .status(out.status === 'created' ? 201 : 200)
        .json({ ok: true, ...out });
    } catch (error) {
      answerError(res, error);
    }
  });

  router.get('/:actor', async (req, res) => {
    try {
      const out = await withAccounts(
        (m, db) => {
          const bot = m.accounts.getBotIdentity(db, String(req.params.actor));
          return bot ? { service: shape(m, db, bot, env) } : { missing: true };
        },
        { env, rethrow: true }
      );
      if (!out) fail(res, 503, 'registry_unavailable');
      else if (out.missing) fail(res, 404, 'bot_not_found');
      else res.json({ ok: true, service: out.service });
    } catch (error) {
      answerError(res, error);
    }
  });

  router.delete('/:actor', async (req, res) => {
    const hash_index = /** @type {any} */ (req).__botMintIndex;
    try {
      const out = await withAccounts(
        (m, db) =>
          m.accounts.revokeBotIdentity(db, String(req.params.actor), {
            hash_index
          }),
        { env, rethrow: true }
      );
      if (!out) {
        fail(res, 503, 'registry_unavailable');
        return;
      }
      resetAccountsCache();
      res.json({ ok: true, ...out });
    } catch (error) {
      answerError(res, error);
    }
  });

  // Anything else under the prefix (and a body too large / not JSON).
  router.use((_req, res) => fail(res, 404, 'not_found'));
  router.use(
    /** @type {import('express').ErrorRequestHandler} */ (
      // Express recognises an error handler by its four parameters.
      // eslint-disable-next-line no-unused-vars
      (err, _req, res, _next) => {
        const status = Number(err?.status || err?.statusCode || 400);
        fail(
          res,
          status === 413 ? 413 : 400,
          status === 413 ? 'body_too_large' : 'bad_request'
        );
      }
    )
  );

  app.use(BOT_MINT_PATH, router);
}

/**
 * @param {import('express').Response} res
 * @param {any} error
 */
function answerError(res, error) {
  if (error?.name === 'AccountsError' && Number.isInteger(error.status)) {
    const status = Number(error.status);
    fail(
      res,
      status >= 400 && status < 500 ? status : 400,
      String(error.code || 'bad_request'),
      String(error.message || '')
    );
    return;
  }
  log('bot-mint request failed: %o', error);
  fail(res, 500, 'internal_error');
}
