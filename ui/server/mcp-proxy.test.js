import express from 'express';
import http from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { attachMcpProxy } from './mcp-proxy.js';

/** @type {http.Server[]} */
const servers = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = /** @type {http.Server} */ (servers.pop());
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

/**
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @returns {Promise<{ server: http.Server, port: number }>}
 */
async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('local test server did not expose a port');
  }
  return { server, port: address.port };
}

/**
 * @param {import('express').Express} app
 * @returns {Promise<{ server: http.Server, port: number }>}
 */
async function listenApp(app) {
  return listen((req, res) => app(req, res));
}

/**
 * @param {string | undefined} target
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ app: import('express').Express, attached: boolean }}
 */
function makeApp(target, env) {
  const app = express();
  const attached = attachMcpProxy(app, { target, env });
  app.use(express.json());
  app.use((_req, res) => res.status(404).end());
  return { app, attached };
}

/**
 * @param {{
 *   port: number,
 *   method: string,
 *   path: string,
 *   headers?: import('node:http').OutgoingHttpHeaders | readonly string[],
 *   body?: Buffer | string
 * }} options
 * @returns {Promise<{
 *   status: number,
 *   headers: import('node:http').IncomingHttpHeaders,
 *   body: Buffer
 * }>}
 */
function request(options) {
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('end', () => {
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    client.once('error', reject);
    if (options.body === undefined) {
      client.end();
    } else {
      client.end(options.body);
    }
  });
}

/**
 * Resolve after the first response chunk, while leaving a promise for the complete body.
 * This distinguishes a flushed SSE event from a response that only becomes visible at end.
 *
 * @param {number} port
 * @param {string} path
 * @returns {Promise<{
 *   first: string,
 *   status: number,
 *   headers: import('node:http').IncomingHttpHeaders,
 *   done: Promise<string>
 * }>}
 */
function requestAfterFirstChunk(port, path) {
  return new Promise((resolve, reject) => {
    const client = http.request(
      { hostname: '127.0.0.1', port, method: 'GET', path },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let first = true;
        /** @type {(value: string) => void} */
        let resolve_done;
        /** @type {(reason?: unknown) => void} */
        let reject_done;
        const done = new Promise((resolve_body, reject_body) => {
          resolve_done = resolve_body;
          reject_done = reject_body;
        });

        response.on('data', (chunk) => {
          const buffer = Buffer.from(chunk);
          chunks.push(buffer);
          if (first) {
            first = false;
            resolve({
              first: buffer.toString(),
              status: response.statusCode || 0,
              headers: response.headers,
              done
            });
          }
        });
        response.once('error', (error) => {
          if (first) {
            reject(error);
          }
          reject_done(error);
        });
        response.once('end', () => {
          resolve_done(Buffer.concat(chunks).toString());
        });
      }
    );
    client.once('error', reject);
    client.end();
  });
}

describe('attachMcpProxy', () => {
  test('streams a JSON-RPC POST and propagates the upstream response', async () => {
    /** @type {{ method?: string, url?: string, body?: Buffer, headers?: import('node:http').IncomingHttpHeaders }} */
    const seen = {};
    const upstream = await listen((req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.once('end', () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.body = Buffer.concat(chunks);
        seen.headers = req.headers;
        res.writeHead(201, {
          'content-type': 'application/json',
          'x-upstream-value': 'preserved',
          connection: 'keep-alive'
        });
        res.end('{"accepted":true}');
      });
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`).app
    );
    const body = Buffer.from('{"jsonrpc":"2.0","id":1}');

    const response = await request({
      port: app.port,
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer exact-test-token',
        'x-mcp-user-email': 'worker-stamped@example.com',
        'x-mcp-user-id': 'worker-user-123',
        'X-MCP-User-Name': 'Worker Name',
        'X-MCP-User-Email-Extra': 'secret-suffix',
        'X-MCP-User-DisplayName': 'browser-claim',
        'X-MCP-Worker-Token': 'worker-origin-secret',
        'CF-Access-Client-Id': 'service-client-id',
        'cF-aCcEsS-cLiEnT-SeCrEt': 'service-client-secret',
        'X-Auth-Request-Email': 'untrusted@example.com',
        'X-Auth-Request-Secret': 'framework-secret',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'session-123',
        'mcp-protocol-version': '2025-03-26',
        'content-length': body.length
      },
      body
    });

    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/mcp');
    expect(seen.body).toEqual(body);
    expect(seen.headers?.['content-type']).toBe('application/json');
    expect(seen.headers?.authorization).toBe('Bearer exact-test-token');
    expect(seen.headers?.['x-mcp-user-email']).toBeUndefined();
    expect(seen.headers?.['x-mcp-user-id']).toBeUndefined();
    expect(seen.headers?.['x-mcp-user-name']).toBeUndefined();
    expect(seen.headers?.accept).toBe('application/json, text/event-stream');
    expect(seen.headers?.['mcp-session-id']).toBe('session-123');
    expect(seen.headers?.['mcp-protocol-version']).toBe('2025-03-26');
    expect(seen.headers?.['x-mcp-user-email-extra']).toBeUndefined();
    expect(seen.headers?.['x-mcp-user-displayname']).toBeUndefined();
    expect(seen.headers?.['x-mcp-worker-token']).toBeUndefined();
    expect(seen.headers?.['cf-access-client-id']).toBeUndefined();
    expect(seen.headers?.['cf-access-client-secret']).toBeUndefined();
    expect(seen.headers?.['x-auth-request-email']).toBeUndefined();
    expect(seen.headers?.['x-auth-request-secret']).toBeUndefined();
    expect(seen.headers?.host).toBe(`127.0.0.1:${upstream.port}`);
    expect(response.status).toBe(201);
    expect(response.body.toString()).toBe('{"accepted":true}');
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['x-upstream-value']).toBe('preserved');
  });

  test('base proxy strips all claimed worker identity headers', async () => {
    /** @type {{ headers?: import('node:http').IncomingHttpHeaders }} */
    const seen = {};
    const upstream = await listen((req, res) => {
      seen.headers = req.headers;
      res.end('trusted-silo-ok');
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`, {
        FEADS_SILO: ''
      }).app
    );

    const response = await request({
      port: app.port,
      method: 'POST',
      path: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': 2,
        'X-MCP-User-Email': 'worker@example.com',
        'X-MCP-User-ID': 'worker-123',
        'X-MCP-User-Name': 'Worker',
        'X-MCP-User-Email-Extra': 'must-not-cross',
        'X-MCP-User-DisplayName': 'spoofed-field'
      },
      body: '{}'
    });

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('trusted-silo-ok');
    expect(seen.headers?.['x-mcp-user-email']).toBeUndefined();
    expect(seen.headers?.['x-mcp-user-id']).toBeUndefined();
    expect(seen.headers?.['x-mcp-user-name']).toBeUndefined();
    expect(seen.headers?.['x-mcp-user-email-extra']).toBeUndefined();
    expect(seen.headers?.['x-mcp-user-displayname']).toBeUndefined();
    expect(seen.headers?.authorization).toBeUndefined();
  });

  test('rejects any identity header on a purported silo before opening the child', async () => {
    let upstream_requests = 0;
    const upstream = await listen((_req, res) => {
      upstream_requests += 1;
      res.end('should-not-reach-child');
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`, {
        FEADS_SILO: 'controls'
      }).app
    );

    const response = await request({
      port: app.port,
      method: 'GET',
      path: '/mcp',
      headers: {
        'X-McP-UsEr-EmAiL': 'spoofed@example.com',
        'X-MCP-User-Email-Extra': 'spoofed-field',
        'X-Forwarded-For': '203.0.113.44',
        host: 'feads-demo.apps.example.test',
        origin: 'https://feads-demo.apps.example.test'
      }
    });

    expect(response.status).toBe(401);
    expect(upstream_requests).toBe(0);
  });

  test('strips provider bearer credentials and unrelated headers in a silo', async () => {
    /** @type {{ headers?: import('node:http').IncomingHttpHeaders }} */
    const seen = {};
    const upstream = await listen((req, res) => {
      seen.headers = req.headers;
      res.end('provider-stripped');
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`, {
        FEADS_SILO: 'controls'
      }).app
    );

    const response = await request({
      port: app.port,
      method: 'GET',
      path: '/mcp',
      headers: {
        authorization: 'Bearer google-provider-token',
        'X-MCP-Worker-Token': 'worker-origin-secret',
        'X-Forwarded-For': '203.0.113.44',
        'X-Auth-Request-Email': 'provider@example.com'
      }
    });

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('provider-stripped');
    expect(seen.headers?.authorization).toBeUndefined();
    expect(seen.headers?.['x-mcp-worker-token']).toBeUndefined();
    expect(seen.headers?.['x-forwarded-for']).toBeUndefined();
    expect(seen.headers?.['x-auth-request-email']).toBeUndefined();
    expect(seen.headers?.['x-mcp-user-email-extra']).toBeUndefined();
  });

  test('forwards a direct valid Feads bearer without worker identity headers', async () => {
    /** @type {{ headers?: import('node:http').IncomingHttpHeaders }} */
    const seen = {};
    const upstream = await listen((req, res) => {
      seen.headers = req.headers;
      res.end('fdsa-forwarded');
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`, {
        FEADS_SILO: 'controls'
      }).app
    );

    const response = await request({
      port: app.port,
      method: 'GET',
      path: '/mcp',
      headers: { authorization: 'Bearer fdsa_direct_agent_123' }
    });

    expect(response.status).toBe(200);
    expect(seen.headers?.authorization).toBe('Bearer fdsa_direct_agent_123');
  });

  test('rejects duplicate or array-shaped silo Authorization headers', async () => {
    let upstream_requests = 0;
    const upstream = await listen((_req, res) => {
      upstream_requests += 1;
      res.end('should-not-reach-child');
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`, {
        FEADS_SILO: 'controls'
      }).app
    );

    const response = await request({
      port: app.port,
      method: 'GET',
      path: '/mcp',
      headers: /** @type {any} */ ({
        authorization: ['Bearer fdsa_first', 'Bearer fdsa_second']
      })
    });

    expect(response.status).toBe(401);
    expect(upstream_requests).toBe(0);
  });

  test('keeps base/unset silo proxy behavior unchanged', async () => {
    /** @type {{ headers?: import('node:http').IncomingHttpHeaders }} */
    const seen = {};
    const upstream = await listen((req, res) => {
      seen.headers = req.headers;
      res.end('base-parity');
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`, { FEADS_SILO: '' }).app
    );

    const response = await request({
      port: app.port,
      method: 'GET',
      path: '/mcp',
      headers: {
        authorization: 'Bearer provider-or-test-value',
        'X-MCP-User-Email': 'untrusted-header'
      }
    });

    expect(response.status).toBe(200);
    expect(seen.headers?.authorization).toBe('Bearer provider-or-test-value');
    expect(seen.headers?.['x-mcp-user-email']).toBeUndefined();
  });

  test('canonicalizes authenticated Claude initialize before the child route', async () => {
    /** @type {{ method?: string, url?: string, body?: Buffer, headers?: import('node:http').IncomingHttpHeaders }} */
    const seen = {};
    const upstream = await listen((req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.once('end', () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.body = Buffer.concat(chunks);
        seen.headers = req.headers;
        if (req.url?.startsWith('/mcp/')) {
          res.writeHead(307, { location: 'http://127.0.0.1:4501/mcp' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          'mcp-session-id': 'claude-session'
        });
        res.end(
          'event: message\\r\\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}\\r\\n\\r\\n'
        );
      });
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`).app
    );
    const body = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"Claude","version":"1.0"}}}'
    );

    const response = await request({
      port: app.port,
      method: 'POST',
      path: '/mcp/?transport=streamable-http',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer exact-test-token',
        'content-type': 'application/json',
        'content-length': body.length,
        'mcp-protocol-version': '2025-03-26'
      },
      body
    });

    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/mcp?transport=streamable-http');
    expect(seen.body).toEqual(body);
    expect(seen.headers?.authorization).toBe('Bearer exact-test-token');
    expect(seen.headers?.['mcp-protocol-version']).toBe('2025-03-26');
    expect(response.status).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(response.headers['mcp-session-id']).toBe('claude-session');
    expect(response.body.toString()).toContain(
      '"protocolVersion":"2025-03-26"'
    );
  });

  test('flushes SSE events before the upstream response ends', async () => {
    let upstream_finished = false;
    const upstream = await listen((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      });
      res.flushHeaders();
      res.write('event: first\ndata: one\n\n');
      setTimeout(() => {
        upstream_finished = true;
        res.end('event: second\ndata: two\n\n');
      }, 150);
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`).app
    );

    const response = await requestAfterFirstChunk(app.port, '/mcp');

    expect(response.first).toBe('event: first\ndata: one\n\n');
    expect(upstream_finished).toBe(false);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(await response.done).toBe(
      'event: first\ndata: one\n\nevent: second\ndata: two\n\n'
    );
  });

  test('preserves GET subpaths and query strings', async () => {
    /** @type {{ method?: string, url?: string }} */
    const seen = {};
    const upstream = await listen((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      res.end('subpath-ok');
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`).app
    );

    const response = await request({
      port: app.port,
      method: 'GET',
      path: '/mcp/subpath?x=1'
    });

    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('/mcp/subpath?x=1');
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('subpath-ok');
  });

  test('returns a JSON 502 when the upstream is down', async () => {
    const upstream = await listen(() => {});
    await new Promise((resolve) => upstream.server.close(resolve));
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`).app
    );

    const response = await request({
      port: app.port,
      method: 'GET',
      path: '/mcp'
    });

    expect(response.status).toBe(502);
    expect(response.headers['content-type']).toContain('application/json');
    expect(JSON.parse(response.body.toString())).toEqual({
      error: 'mcp_upstream_unreachable'
    });
  });

  test('does not attach without a target and leaves /mcp as a 404', async () => {
    const previous_target = process.env.FEADS_MCP_PROXY_TARGET;
    delete process.env.FEADS_MCP_PROXY_TARGET;
    try {
      const app = express();
      expect(attachMcpProxy(app)).toBe(false);
      app.use(express.json());
      app.use((_req, res) => res.status(404).end());
      const server = await listenApp(app);
      const response = await request({
        port: server.port,
        method: 'GET',
        path: '/mcp'
      });
      expect(response.status).toBe(404);
    } finally {
      if (previous_target === undefined) {
        delete process.env.FEADS_MCP_PROXY_TARGET;
      } else {
        process.env.FEADS_MCP_PROXY_TARGET = previous_target;
      }
    }
  });

  test('forwards invalid JSON bytes before express.json can consume them', async () => {
    /** @type {Buffer | undefined} */
    let seen_body;
    const upstream = await listen((req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.once('end', () => {
        seen_body = Buffer.concat(chunks);
        res.end('raw-body-ok');
      });
    });
    const app = await listenApp(
      makeApp(`http://127.0.0.1:${upstream.port}`).app
    );
    const body = Buffer.from('{"jsonrpc":"2.0",');

    const response = await request({
      port: app.port,
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length
      },
      body
    });

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('raw-body-ok');
    expect(seen_body).toEqual(body);
  });
});
