/**
 * Authenticated ingestion for ephemeral agent runtime presence (phi, P3, …).
 *
 * Runtime rows are advisory and owner-scoped. The route deliberately resolves the
 * durable owner from the verified HTTP credential and never accepts an actor or
 * agent id from the request body.
 *
 * Outcomes are observable: every non-2xx answer logs one line (never a token,
 * header, cookie or row content beyond the fields below), and successes log only
 * a runtime's first heartbeat in this process and an agent's recovery after a
 * recorded failure. Attributable failures are remembered in memory
 * (runtime-presence-outcomes.js) so Agentwatch can show "heartbeats rejected".
 */
import { rateLimit } from 'express-rate-limit';
import { openRegistry } from '../../boards/registry.mjs';
import {
  RuntimePresenceConflictError,
  RuntimePresenceValidationError,
  dropRuntimePresence,
  upsertRuntimePresence
} from '../../boards/runtime-presence.mjs';
import {
  isSiloBrowserMutationAllowed,
  resolveHttpActor
} from './notifications-engine.js';
import { siloMode } from './platform-sso.js';
import {
  recordPresenceFailure,
  recordPresenceSuccess
} from './runtime-presence-outcomes.js';

const BATCH_KEYS = new Set(['version', 'rows']);
const DELETE_KEYS = new Set(['runtime_id', 'run_ids']);
const RUNTIME_PRESENCE_WINDOW_MS = 60_000;
const RUNTIME_PRESENCE_PRINCIPAL_LIMIT = 1_200;
// Edge traffic shares one proxy address, so this is a process-wide safety valve,
// not an identity boundary. It is intentionally much higher than the per-agent
// budget and therefore cannot recreate the old 120-request shared bucket.
const RUNTIME_PRESENCE_GLOBAL_LIMIT = 12_000;
const LOG_PREFIX = '[feads runtime-presence]';
// Only the namespace of a presented bearer is ever logged, never the secret.
const CREDENTIAL_PREFIXES = ['fdsa_', 'fdss_'];
const MAX_LOGGED_CLIENTS = 8;

/**
 * @typedef {{ actor: string, agent?: any, error_code?: string, via: string }} RuntimePresenceAuth
 */

/**
 * @typedef {import('express').Request & {
 *   runtime_presence_auth: RuntimePresenceAuth,
 *   runtime_presence_principal: string,
 *   runtime_presence_rows: Array<Record<string, unknown>>,
 *   runtime_presence_delete: { runtime_id: string, run_ids?: string[] }
 * }} RuntimePresenceRequest
 */

/**
 * Keep the rejection body stable while express-rate-limit supplies Retry-After and
 * draft-8 RateLimit/RateLimit-Policy headers before invoking this handler.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function runtimePresenceRateLimitHandler(req, res) {
  fail(req, res, 429, 'rate_limited');
}

/**
 * Create one global and one per-principal limiter. The production attachment below
 * uses one process-wide pair, while the optional stores let focused tests isolate the
 * counters without issuing thousands of real requests.
 *
 * @param {{ globalStore?: import('express-rate-limit').Store,
 *           principalStore?: import('express-rate-limit').Store }} [options]
 * @returns {{ global: import('express-rate-limit').RateLimitRequestHandler,
 *             principal: import('express-rate-limit').RateLimitRequestHandler }}
 */
export function createRuntimePresenceRateLimiters(options = {}) {
  return {
    global: rateLimit({
      windowMs: RUNTIME_PRESENCE_WINDOW_MS,
      limit: RUNTIME_PRESENCE_GLOBAL_LIMIT,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      identifier: 'runtime-presence-global',
      keyGenerator: () => 'runtime-presence-global',
      ...(options.globalStore ? { store: options.globalStore } : {}),
      handler: runtimePresenceRateLimitHandler,
      validate: {
        xForwardedForHeader: false,
        keyGeneratorIpFallback: false
      }
    }),
    principal: rateLimit({
      windowMs: RUNTIME_PRESENCE_WINDOW_MS,
      limit: RUNTIME_PRESENCE_PRINCIPAL_LIMIT,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      identifier: 'runtime-presence-principal',
      keyGenerator: (req) => {
        const principal = /** @type {RuntimePresenceRequest} */ (req)
          .runtime_presence_principal;
        return `runtime-presence-principal:${principal}`;
      },
      ...(options.principalStore ? { store: options.principalStore } : {}),
      handler: runtimePresenceRateLimitHandler,
      validate: {
        xForwardedForHeader: false,
        keyGeneratorIpFallback: false
      }
    })
  };
}

const runtimePresenceRateLimiters = createRuntimePresenceRateLimiters();

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reject body keys not in the small, versioned wire contract.
 *
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @returns {Record<string, unknown>}
 */
function strictObject(value, allowed) {
  if (!isObject(value)) {
    throw new RuntimePresenceValidationError('request body must be an object');
  }
  const body = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new RuntimePresenceValidationError(
        'request contains an unknown field'
      );
    }
  }
  return body;
}

/**
 * @param {unknown} body
 * @returns {Array<Record<string, unknown>>}
 */
function batchRows(body) {
  const value = strictObject(body, BATCH_KEYS);
  if (value.version !== 1) {
    throw new RuntimePresenceValidationError(
      'unsupported runtime-presence version'
    );
  }
  if (
    !Array.isArray(value.rows) ||
    value.rows.length < 1 ||
    value.rows.length > 64
  ) {
    throw new RuntimePresenceValidationError(
      'rows must contain between 1 and 64 entries'
    );
  }
  return /** @type {Array<Record<string, unknown>>} */ (value.rows);
}

/**
 * @param {unknown} body
 * @returns {{ runtime_id: string, run_ids?: string[] }}
 */
function deletePayload(body) {
  const value = strictObject(body, DELETE_KEYS);
  if (typeof value.runtime_id !== 'string' || value.runtime_id.length === 0) {
    throw new RuntimePresenceValidationError('runtime_id is required');
  }
  if (value.run_ids !== undefined && !Array.isArray(value.run_ids)) {
    throw new RuntimePresenceValidationError('run_ids must be an array');
  }
  if (Array.isArray(value.run_ids) && value.run_ids.length > 64) {
    throw new RuntimePresenceValidationError(
      'run_ids may contain at most 64 entries'
    );
  }
  return {
    runtime_id: value.runtime_id,
    ...(value.run_ids === undefined
      ? {}
      : { run_ids: /** @type {string[]} */ (value.run_ids) })
  };
}

/**
 * One log field: printable ASCII without spaces, bounded, `-` when empty.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function logField(value, max = 64) {
  const text = String(value ?? '')
    .replace(/[^\x21-\x7e]/g, '_')
    .slice(0, max);
  return text.length > 0 ? text : '-';
}

/**
 * The presented bearer's namespace only (`fdsa_`, `fdss_`, `none`, `other`).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function bearerKind(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || header.trim().length === 0) {
    return 'none';
  }
  const match = /^bearer\s+(\S+)/i.exec(header.trim());
  const token = match ? match[1] : '';
  return (
    CREDENTIAL_PREFIXES.find((prefix) => token.startsWith(prefix)) || 'other'
  );
}

/**
 * Distinct sanitized `client` values of a PUT body's rows, when parseable.
 *
 * @param {unknown} body
 * @returns {string[]}
 */
function bodyClients(body) {
  const rows = isObject(body) && Array.isArray(body.rows) ? body.rows : [];
  /** @type {Set<string>} */
  const clients = new Set();
  for (const row of rows) {
    if (clients.size >= MAX_LOGGED_CLIENTS) {
      break;
    }
    if (!isObject(row) || row.client === undefined || row.client === '') {
      continue;
    }
    clients.add(
      typeof row.client === 'string'
        ? row.client.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 32)
        : '?'
    );
  }
  return Array.from(clients);
}

/**
 * How many rows (PUT) or run ids (DELETE) the body carried, when parseable.
 *
 * @param {unknown} body
 * @returns {string}
 */
function bodyRowCount(body) {
  if (isObject(body) && Array.isArray(body.rows)) {
    return String(body.rows.length);
  }
  if (isObject(body) && Array.isArray(body.run_ids)) {
    return String(body.run_ids.length);
  }
  return '-';
}

/**
 * The caller's address: the first X-Forwarded-For hop (the edge proxy is the
 * socket peer), else the socket address.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function clientIp(req) {
  const header = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  const first = typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  const ip = first || req.ip || req.socket?.remoteAddress || '';
  return logField(String(ip).replace(/[^0-9A-Fa-f:.]/g, ''));
}

/**
 * The agent a request resolved to, or `null` when it has no identity.
 *
 * @param {RuntimePresenceAuth | undefined} auth
 * @returns {{ agent_id: string, actor: string } | null}
 */
function identityOf(auth) {
  const agent_id = auth?.agent?.id;
  if (typeof agent_id !== 'string' || agent_id.length === 0) {
    return null;
  }
  return { agent_id, actor: String(auth?.actor || auth?.agent?.actor || '') };
}

/**
 * The credential's label or provenance — `conn:<label>`, `key:<label>`, the
 * legacy agent actor, `web` — never the credential itself.
 *
 * @param {RuntimePresenceAuth | undefined} auth
 * @returns {string}
 */
function credentialLabel(auth) {
  const label = /** @type {any} */ (auth)?.resolved?.principal?.label;
  if (typeof label === 'string' && label.length > 0) {
    return label;
  }
  const provenance = auth?.agent?.provenance_actor;
  if (typeof provenance === 'string' && provenance.length > 0) {
    return provenance;
  }
  return typeof auth?.agent?.actor === 'string' ? auth.agent.actor : '';
}

/**
 * The fields every outcome line shares after the method/status/what prefix.
 *
 * @param {import('express').Request} req
 * @param {RuntimePresenceAuth | undefined} auth
 * @param {string[]} clients
 * @returns {string}
 */
function outcomeContext(req, auth, clients) {
  const who = identityOf(auth);
  return [
    `actor=${who ? logField(who.actor) : 'unidentified'}`,
    `via=${logField(who ? credentialLabel(auth) : '', 96)}`,
    `cred=${bearerKind(req)}`,
    `client=${clients.length > 0 ? clients.join(',') : '-'}`,
    `rows=${bodyRowCount(req.body)}`,
    `ip=${clientIp(req)}`
  ].join(' ');
}

/**
 * Log one non-2xx answer and remember it when it is attributable. Never throws:
 * observability must not change the response.
 *
 * @param {import('express').Request} req
 * @param {number} status
 * @param {string} error
 * @param {RuntimePresenceAuth} [auth] - defaults to the request's resolved auth
 */
function observeFailure(req, status, error, auth) {
  try {
    const resolved =
      auth || /** @type {RuntimePresenceRequest} */ (req).runtime_presence_auth;
    const clients = bodyClients(req.body);
    console.warn(
      `${LOG_PREFIX} ${logField(req.method, 8)} ${status} ${logField(error)} ${outcomeContext(req, resolved, clients)}`
    );
    const who = identityOf(resolved);
    if (who) {
      recordPresenceFailure({
        ...who,
        at: Date.now(),
        status,
        error,
        client: clients.join(','),
        via: credentialLabel(resolved)
      });
    }
  } catch {
    // Logging is best effort.
  }
}

/**
 * Remember a 2xx answer; log it only for a runtime's first heartbeat in this
 * process or an agent's recovery after a recorded failure.
 *
 * @param {import('express').Request} req
 * @param {RuntimePresenceAuth} auth
 * @param {string[]} runtime_ids
 */
function observeSuccess(req, auth, runtime_ids) {
  try {
    const who = identityOf(auth);
    if (!who) {
      return;
    }
    const at = Date.now();
    const outcome = recordPresenceSuccess({ ...who, at, runtime_ids });
    if (!outcome.recovered && outcome.first_seen.length === 0) {
      return;
    }
    const method = logField(req.method, 8);
    const context = outcomeContext(req, auth, bodyClients(req.body));
    if (outcome.recovered) {
      const failure = outcome.recovered;
      const age_s = Math.max(0, Math.round((at - failure.at) / 1000));
      console.log(
        `${LOG_PREFIX} ${method} 200 recovered after=${failure.status}:${logField(failure.error)} age=${age_s}s ${context}`
      );
    }
    if (outcome.first_seen.length > 0) {
      console.log(
        `${LOG_PREFIX} ${method} 200 first-seen runtime=${outcome.first_seen.map((id) => logField(id)).join(',')} ${context}`
      );
    }
  } catch {
    // Logging is best effort.
  }
}

/**
 * Answer a failure and observe it.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} error
 * @param {RuntimePresenceAuth} [auth]
 */
function fail(req, res, status, error, auth) {
  res.status(status).json({ ok: false, error });
  observeFailure(req, status, error, auth);
}

/**
 * @param {unknown} error
 * @returns {{ status: number, error: string }}
 */
function routeError(error) {
  if (error instanceof RuntimePresenceValidationError) {
    return { status: 400, error: 'bad_request' };
  }
  if (error instanceof RuntimePresenceConflictError) {
    return { status: 409, error: 'conflict' };
  }
  return { status: 503, error: 'registry_unavailable' };
}

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function hasBaseBearer(req) {
  const header = req.headers?.authorization;
  return (
    typeof header === 'string' &&
    header.startsWith('Bearer ') &&
    header.slice(7).trim().length > 0
  );
}

/**
 * Probe only the registry availability needed to classify an authentication
 * failure. Authentication itself remains in notifications-engine.js; this
 * route-local probe prevents an unavailable registry from looking like a bad
 * bearer or verified SSO credential without changing legacy auth behavior.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
function registryAvailable(env) {
  let db = null;
  try {
    db = openRegistry({ env });
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Preserve the availability result; the next request will retry.
    }
  }
}

/**
 * Resolve the HTTP identity used by both mutation routes.
 *
 * @param {import('express').Request} req
 * @param {{ env: Record<string, string | undefined>, ssoVerifier?: any }} options
 * @returns {Promise<{ actor: string, agent?: any, error_code?: string, via: string }>}
 */
async function authenticate(req, options) {
  // Cache the provider result for this request so a route-local availability
  // classification never performs a second SSO verification. The shared auth
  // module still owns all credential and binding policy.
  /** @type {{ ok?: boolean } | undefined} */
  let ssoVerification;
  const verifier = options.ssoVerifier;
  const ssoVerifier =
    verifier && typeof verifier.verify === 'function'
      ? {
          verify: async (/** @type {import('express').Request} */ request) => {
            ssoVerification = await verifier.verify(request);
            return ssoVerification;
          }
        }
      : verifier;
  const auth = await resolveHttpActor(req, {
    env: options.env,
    ssoVerifier
  });
  if (!auth.actor || !auth.agent) {
    const mode = siloMode(options.env);
    const verifiedSso = mode === 'silo' && ssoVerification?.ok === true;
    const baseBearer = mode === 'base' && hasBaseBearer(req);
    if (
      auth.error_code !== 'registry_unavailable' &&
      (baseBearer || verifiedSso) &&
      !registryAvailable(options.env)
    ) {
      return { ...auth, error_code: 'registry_unavailable' };
    }
    return auth;
  }
  if (!isSiloBrowserMutationAllowed(req, auth, options.env)) {
    return { ...auth, actor: '', error_code: 'origin_forbidden' };
  }
  return auth;
}

/**
 * Send the documented response for an authentication failure. The caller has
 * no usable identity, so the failure is logged but not attributed.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {RuntimePresenceAuth} auth
 */
function rejectAuthentication(req, res, auth) {
  const code = auth.error_code || 'not_identified';
  fail(
    req,
    res,
    code === 'registry_unavailable' ? 503 : code === 'bad_request' ? 400 : 401,
    code,
    { actor: '', via: '' }
  );
}

/**
 * Authenticate before the principal limiter sees the request. The global limiter is
 * mounted before this middleware as a separate abuse safety valve; it is not allowed
 * to stand in for the authenticated identity bucket.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {{ env: Record<string, string | undefined>, ssoVerifier?: any }} options
 */
async function authenticateRuntimePresenceRequest(req, res, next, options) {
  const auth = await authenticate(req, options);
  if (auth.error_code === 'origin_forbidden') {
    // The credential resolved; only the browser origin was refused.
    fail(req, res, 403, 'origin_forbidden', auth);
    return;
  }
  if (!auth.actor || !auth.agent) {
    rejectAuthentication(req, res, auth);
    return;
  }
  if (typeof auth.agent.id !== 'string' || auth.agent.id.length === 0) {
    rejectAuthentication(req, res, { ...auth, actor: '' });
    return;
  }

  const runtime_request = /** @type {RuntimePresenceRequest} */ (req);
  runtime_request.runtime_presence_auth = auth;
  runtime_request.runtime_presence_principal = auth.agent.id;
  next();
}

/**
 * Validate a PUT body before consuming the authenticated principal's quota.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validateRuntimePresenceBatch(req, res, next) {
  try {
    const runtime_request = /** @type {RuntimePresenceRequest} */ (req);
    runtime_request.runtime_presence_rows = batchRows(req.body);
    next();
  } catch (error) {
    const result = routeError(error);
    fail(req, res, result.status, result.error);
  }
}

/**
 * Validate a DELETE body before consuming the authenticated principal's quota.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validateRuntimePresenceDelete(req, res, next) {
  try {
    const runtime_request = /** @type {RuntimePresenceRequest} */ (req);
    runtime_request.runtime_presence_delete = deletePayload(req.body);
    next();
  } catch (error) {
    const result = routeError(error);
    fail(req, res, result.status, result.error);
  }
}

/**
 * Call the optional process-wide Agentwatch refresh nudge without making the
 * advisory ingestion request depend on a WebSocket scheduler.
 *
 * @param {(() => unknown | Promise<unknown>) | undefined} callback
 * @returns {Promise<void>}
 */
async function nudge(callback) {
  if (typeof callback !== 'function') return;
  try {
    await callback();
  } catch {
    // Runtime presence remains successful when the browser refresh scheduler is down.
  }
}

/**
 * @param {unknown} error
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function runtimePresenceErrorHandler(error, req, res, next) {
  const failure = /** @type {any} */ (error);
  if (failure?.type === 'entity.parse.failed') {
    fail(req, res, 400, 'bad_request');
    return;
  }
  // Anything else (an oversized body, an unexpected throw) keeps Express's
  // default answer; it is still worth one log line.
  const status = Number(failure?.status || failure?.statusCode) || 500;
  observeFailure(
    req,
    status >= 400 && status <= 599 ? status : 500,
    typeof failure?.type === 'string' ? failure.type : 'internal_error'
  );
  next(error);
}

/**
 * Mount the authenticated runtime-presence API.
 *
 * @param {import('express').Express} app
 * @param {{ env?: Record<string, string | undefined>, ssoVerifier?: any,
 *           nudgeAgentwatchRefresh?: () => unknown | Promise<unknown> }} [options]
 */
export function attachRuntimePresenceRoutes(app, options = {}) {
  const env = options.env || process.env;
  const authOptions = { env, ssoVerifier: options.ssoVerifier };
  const limiters = runtimePresenceRateLimiters;

  // PUT and DELETE share one authenticated principal budget: both mutate the same
  // presence collection, while the global limiter remains a separate safety cap.
  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const authenticateRequest = (req, res, next) =>
    authenticateRuntimePresenceRequest(req, res, next, authOptions);

  app.put(
    '/api/runtime-presence',
    limiters.global,
    authenticateRequest,
    validateRuntimePresenceBatch,
    limiters.principal,
    async (req, res) => {
      const runtime_request = /** @type {RuntimePresenceRequest} */ (req);
      const auth = runtime_request.runtime_presence_auth;
      const body_rows = runtime_request.runtime_presence_rows;
      let result;
      let db = null;
      try {
        db = openRegistry({ env });
        result = upsertRuntimePresence(
          db,
          auth.agent.id,
          body_rows,
          Date.now()
        );
      } catch (error) {
        const mapped = routeError(error);
        fail(req, res, mapped.status, mapped.error);
        return;
      } finally {
        try {
          db?.close();
        } catch {
          // Ignore close failures after the transaction has committed or rolled back.
        }
      }

      observeSuccess(req, auth, [
        ...new Set(
          body_rows
            .map((row) => row.runtime_id)
            .filter(
              (runtime_id) =>
                typeof runtime_id === 'string' && runtime_id.length > 0
            )
            .map(String)
        )
      ]);
      await nudge(options.nudgeAgentwatchRefresh);
      res.status(200).json({
        ok: true,
        accepted: result.accepted,
        heartbeat_at: result.heartbeat_at
      });
    }
  );

  app.delete(
    '/api/runtime-presence',
    limiters.global,
    authenticateRequest,
    validateRuntimePresenceDelete,
    limiters.principal,
    async (req, res) => {
      const runtime_request = /** @type {RuntimePresenceRequest} */ (req);
      const auth = runtime_request.runtime_presence_auth;
      const payload = runtime_request.runtime_presence_delete;
      let db = null;
      try {
        db = openRegistry({ env });
        dropRuntimePresence(
          db,
          auth.agent.id,
          payload.runtime_id,
          payload.run_ids
        );
      } catch (error) {
        const mapped = routeError(error);
        fail(req, res, mapped.status, mapped.error);
        return;
      } finally {
        try {
          db?.close();
        } catch {
          // Ignore close failures after the transaction has committed or rolled back.
        }
      }

      observeSuccess(req, auth, []);
      await nudge(options.nudgeAgentwatchRefresh);
      res.status(200).json({ ok: true });
    }
  );

  // express.json() reports malformed JSON before the route handler runs. Keep the
  // documented 400 response scoped to these two endpoints rather than changing all
  // other JSON APIs in the application.
  app.use('/api/runtime-presence', runtimePresenceErrorHandler);
}
