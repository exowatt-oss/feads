import http from 'node:http';

/**
 * Headers whose meaning is limited to one HTTP connection and must not cross the proxy.
 *
 * @type {Set<string>}
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer'
]);

/**
 * Only forward headers needed by the MCP HTTP/SSE transport. An allowlist is
 * intentional here: the browser-facing route is not allowed to smuggle edge
 * credentials or framework identity claims into the MCP child.
 *
 * @type {Set<string>}
 */
const MCP_PROTOCOL_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'cache-control',
  'content-encoding',
  'content-language',
  'content-length',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'origin',
  'user-agent'
]);

const MCP_USER_HEADER_PREFIX = 'x-mcp-user-';
const FEADS_AGENT_BEARER_PATTERN = /^Bearer[ \t]+fdsa_[A-Za-z0-9_-]+$/i;

/**
 * @param {{ headers?: Record<string, string|string[]|undefined>, rawHeaders?: string[] }} request
 * @param {string} name
 * @returns {{ values: Array<string|string[]|undefined>, raw_count: number }}
 */
function headerState(request, name) {
  const wanted = name.toLowerCase();
  const values = Object.entries(request.headers || {})
    .filter(([key]) => key.toLowerCase() === wanted)
    .map(([, value]) => value);
  let raw_count = 0;
  const raw_headers = request.rawHeaders || [];
  for (let index = 0; index < raw_headers.length; index += 2) {
    if (raw_headers[index]?.toLowerCase() === wanted) raw_count += 1;
  }
  return { values, raw_count };
}

/**
 * @param {{ headers?: Record<string, string|string[]|undefined>, rawHeaders?: string[] }} request
 * @returns {boolean}
 */
function hasAnyMcpUserHeader(request) {
  if (
    Object.keys(request.headers || {}).some((name) =>
      name.toLowerCase().startsWith(MCP_USER_HEADER_PREFIX)
    )
  ) {
    return true;
  }
  const raw_headers = request.rawHeaders || [];
  for (let index = 0; index < raw_headers.length; index += 2) {
    if (raw_headers[index]?.toLowerCase().startsWith(MCP_USER_HEADER_PREFIX)) {
      return true;
    }
  }
  return false;
}

/**
 * Authorization is intentionally a stricter boundary in silo mode. Node may
 * expose duplicate headers as an array or as one comma-joined string; neither
 * form identifies one credential unambiguously.
 *
 * @param {{ headers?: Record<string, string|string[]|undefined>, rawHeaders?: string[] }} request
 * @returns {{ ambiguous: boolean, value?: string }}
 */
function authorizationState(request) {
  const state = headerState(request, 'authorization');
  if (state.values.length === 0 && state.raw_count === 0) {
    return { ambiguous: false };
  }
  if (
    state.values.length !== 1 ||
    state.raw_count > 1 ||
    Array.isArray(state.values[0]) ||
    typeof state.values[0] !== 'string'
  ) {
    return { ambiguous: true };
  }
  const value = state.values[0];
  if (value.includes(',')) return { ambiguous: true };
  return { ambiguous: false, value };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidFeadsBearer(value) {
  return typeof value === 'string' && FEADS_AGENT_BEARER_PATTERN.test(value);
}

/**
 * @param {import('express').Response} response
 * @param {string} error
 */
function rejectMcpRequest(response, error) {
  const body = Buffer.from(JSON.stringify({ error }));
  response.writeHead(401, {
    'content-type': 'application/json',
    'content-length': body.length
  });
  response.end(body);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function shouldForwardHeader(name) {
  const lower = name.toLowerCase();
  if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host') return false;
  if (lower === 'authorization') return true;
  if (lower.startsWith('cf-access-')) return false;
  if (lower.startsWith('x-auth-request-')) return false;
  if (lower === 'x-mcp-worker-token') return false;
  // Browser-provided identity headers never cross into the MCP child.
  if (lower.startsWith(MCP_USER_HEADER_PREFIX)) return false;
  return MCP_PROTOCOL_HEADERS.has(lower);
}

/**
 * Attach a streaming proxy for the streamable HTTP MCP endpoint.
 *
 * @param {import('express').Express} app
 * @param {{ target?: string, httpLib?: Pick<typeof http, 'request'>, env?: Record<string, string|undefined> }} [options]
 * @returns {boolean} Whether the proxy was attached.
 */
export function attachMcpProxy(app, options = {}) {
  const env = options.env || process.env;
  const target =
    options.target === undefined
      ? process.env.FEADS_MCP_PROXY_TARGET
      : options.target;
  if (!target) {
    return false;
  }

  const target_url = new URL(target);
  const http_lib = options.httpLib || http;
  // A hosted silo cannot start in this build. Keep stricter bearer handling
  // for direct callers of this proxy, but never forward identity headers.
  const silo_mode = typeof env.FEADS_SILO === 'string' && env.FEADS_SILO !== '';

  app.use((req, res, next) => {
    const request_url = req.originalUrl || req.url;
    const request_path = request_url.split('?', 1)[0];
    if (request_path !== '/mcp' && !request_path.startsWith('/mcp/')) {
      next();
      return;
    }
    // FastMCP mounts the streamable HTTP app at /mcp (without a trailing
    // slash). Starlette redirects /mcp/ back to /mcp using the upstream Host,
    // which would expose the loopback target to an authenticated client. The
    // dashboard owns both public spellings, so send the slash form directly to
    // the child's canonical route instead of making Claude follow an internal
    // redirect. Keep any query string intact for transport extensions.
    const upstream_path =
      request_path === '/mcp/'
        ? `/mcp${request_url.slice(request_path.length)}`
        : request_url;

    const authorization = silo_mode ? authorizationState(req) : null;
    if (silo_mode && authorization?.ambiguous) {
      rejectMcpRequest(res, 'mcp_authorization_ambiguous');
      return;
    }
    if (silo_mode && hasAnyMcpUserHeader(req)) {
      rejectMcpRequest(res, 'mcp_identity_untrusted');
      return;
    }

    /** @type {import('node:http').OutgoingHttpHeaders} */
    const headers = {};
    // Only protocol headers and an agent bearer may cross into the MCP child.
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (!shouldForwardHeader(name)) continue;
      if (lower === 'authorization' && silo_mode) {
        const authorization_value = authorization?.value;
        if (isValidFeadsBearer(authorization_value)) {
          headers.authorization = authorization_value;
        }
        continue;
      }
      if (value !== undefined) {
        headers[lower] = value;
      }
    }
    headers.host = target_url.host;

    let client_disconnected = false;
    let upstream_response_finished = false;

    const upstream_request = http_lib.request(
      {
        hostname: target_url.hostname,
        port: target_url.port || undefined,
        method: req.method,
        path: upstream_path,
        headers
      },
      (upstream_response) => {
        upstream_response.once('end', () => {
          upstream_response_finished = true;
        });
        upstream_response.once('error', () => {
          res.destroy();
        });

        /** @type {import('node:http').OutgoingHttpHeaders} */
        const response_headers = {};
        for (const [name, value] of Object.entries(upstream_response.headers)) {
          if (
            !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) &&
            value !== undefined
          ) {
            response_headers[name] = value;
          }
        }
        res.writeHead(upstream_response.statusCode || 502, response_headers);
        res.flushHeaders();
        upstream_response.pipe(res);
      }
    );

    const handle_upstream_error = () => {
      if (client_disconnected) {
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const body = Buffer.from(
        JSON.stringify({ error: 'mcp_upstream_unreachable' })
      );
      res.writeHead(502, {
        'content-type': 'application/json',
        'content-length': body.length
      });
      res.end(body);
    };
    upstream_request.once('error', handle_upstream_error);

    const abort_upstream = () => {
      client_disconnected = true;
      if (!upstream_response_finished && !upstream_request.destroyed) {
        upstream_request.destroy();
      }
    };
    req.once('aborted', abort_upstream);
    res.once('close', abort_upstream);

    req.pipe(upstream_request);
  });

  return true;
}
