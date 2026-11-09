import express from 'express';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createCompressedStatic, pickEncoding } from './compressed-static.js';

/** @type {string} */
let dir;
/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let base;
const BUNDLE = 'console.log("feads");\n'.repeat(400);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feads-static-'));
  fs.writeFileSync(path.join(dir, 'main.bundle.js'), BUNDLE);
  fs.writeFileSync(path.join(dir, 'tiny.css'), 'a{}');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.alloc(4096, 7));
  const app = express();
  app.use(createCompressedStatic(dir, { bundleId: () => 'build-1' }));
  app.use(express.static(dir));
  server = createServer(app);
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  );
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Raw GET through node:http so the encoded body is observed, not decoded.
 *
 * @param {string} p
 * @param {Record<string, string>} headers
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer }>}
 */
function get(p, headers) {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request(`${base}${p}`, { headers }, (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        );
      });
      req.on('error', reject);
      req.end();
    });
  });
}

describe('pickEncoding', () => {
  test('prefers brotli, honours q=0, falls back to gzip or nothing', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('identity')).toBe('');
    expect(pickEncoding('')).toBe('');
    expect(pickEncoding('*')).toBe('br');
  });
});

describe('createCompressedStatic', () => {
  test('serves brotli bytes that decode to the file, with an ETag', async () => {
    const res = await get('/main.bundle.js', { 'accept-encoding': 'br, gzip' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.body.length).toBeLessThan(BUNDLE.length / 5);
    expect(zlib.brotliDecompressSync(res.body).toString()).toBe(BUNDLE);
    expect(res.headers.etag).toMatch(/-br"$/);
  });

  test('gzip when brotli is not accepted', async () => {
    const res = await get('/main.bundle.js', { 'accept-encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(res.body).toString()).toBe(BUNDLE);
  });

  test('the current versioned bundle is immutable; anything else revalidates', async () => {
    const current = await get('/main.bundle.js?v=build-1', {
      'accept-encoding': 'br'
    });
    expect(current.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable'
    );
    const stale = await get('/main.bundle.js?v=old', {
      'accept-encoding': 'br'
    });
    expect(stale.headers['cache-control']).toBe('public, max-age=0');
  });

  test('a matching If-None-Match is a 304', async () => {
    const first = await get('/main.bundle.js', { 'accept-encoding': 'br' });
    const again = await get('/main.bundle.js', {
      'accept-encoding': 'br',
      'if-none-match': String(first.headers.etag)
    });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });

  test('declines tiny files, binary types, no-encoding clients and traversal', async () => {
    const tiny = await get('/tiny.css', { 'accept-encoding': 'br' });
    expect(tiny.headers['content-encoding']).toBeUndefined();
    expect(tiny.body.toString()).toBe('a{}');
    const png = await get('/logo.png', { 'accept-encoding': 'br' });
    expect(png.headers['content-encoding']).toBeUndefined();
    const plain = await get('/main.bundle.js', {});
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(BUNDLE);
    const escape = await get('/..%2f..%2fetc%2fpasswd.js', {
      'accept-encoding': 'br'
    });
    expect(escape.headers['content-encoding']).toBeUndefined();
  });
});
