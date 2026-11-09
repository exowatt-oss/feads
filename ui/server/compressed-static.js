/**
 * feads addition — precompressed static assets.
 *
 * The dashboard ships ~320 KB of JavaScript and ~150 KB of CSS, and nothing
 * between the browser and this process compresses them: the platform edge
 * proxies bytes as-is. Every cold load moved ~470 KB that gzip/brotli shrink to
 * ~120 KB. This middleware compresses each text asset once per (path, mtime,
 * size) — brotli and gzip, cached in memory — and serves whichever the client
 * accepts, with a strong ETag so revalidation is a 304.
 *
 * The bundle is also the one asset whose URL is versioned (`?v=<bundle_id>`,
 * stamped into index.html by app.js), so when the requested version is the
 * current build it is served `immutable`: a reload re-fetches only the no-store
 * HTML. Every other asset keeps `max-age=0` + ETag, exactly as express.static
 * served it.
 *
 * Anything it does not handle (non-text types, missing files, `Accept-Encoding`
 * without br/gzip, a path outside the app directory) falls through to
 * `express.static` unchanged.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Text types worth compressing, by extension. */
const COMPRESSIBLE = /** @type {Record<string, string>} */ ({
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8'
});

/** Below this, the headers cost more than the savings. */
const MIN_BYTES = 1024;

/**
 * @typedef {Object} CompressedEntry
 * @property {number} mtime_ms
 * @property {number} size
 * @property {Buffer} br
 * @property {Buffer} gzip
 * @property {string} etag - Hash of the identity bytes; suffixed per encoding.
 */

/**
 * Pick the encoding to serve from an `Accept-Encoding` header.
 *
 * Deliberately simple: q-values of 0 opt out, otherwise brotli wins over gzip.
 *
 * @param {string} header
 * @returns {'br' | 'gzip' | ''}
 */
export function pickEncoding(header) {
  const accepted = new Map();
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    accepted.set(name, q);
  }
  const ok = (/** @type {string} */ name) =>
    (accepted.get(name) ?? accepted.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return '';
}

/**
 * Create the middleware.
 *
 * @param {string} root - The app directory static files are served from.
 * @param {{ bundleId?: () => string }} [options] - `bundleId` names the current
 * build, so a request for the bundle at that version can be cached immutably.
 * @returns {(req: any, res: any, next: () => void) => void}
 */
export function createCompressedStatic(root, options = {}) {
  const base = path.resolve(root);
  /** @type {Map<string, CompressedEntry>} */
  const cache = new Map();

  /**
   * @param {string} file
   * @param {fs.Stats} st
   * @returns {CompressedEntry}
   */
  function load(file, st) {
    const hit = cache.get(file);
    if (hit && hit.mtime_ms === st.mtimeMs && hit.size === st.size) {
      return hit;
    }
    const raw = fs.readFileSync(file);
    /** @type {CompressedEntry} */
    const entry = {
      mtime_ms: st.mtimeMs,
      size: st.size,
      br: zlib.brotliCompressSync(raw, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
        }
      }),
      gzip: zlib.gzipSync(raw, { level: 9 }),
      etag: crypto
        .createHash('sha256')
        .update(raw)
        .digest('base64url')
        .slice(0, 27)
    };
    cache.set(file, entry);
    return entry;
  }

  return function compressedStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    let rel = '';
    try {
      rel = decodeURIComponent(String(req.path || ''));
    } catch {
      next();
      return;
    }
    const type = COMPRESSIBLE[path.extname(rel).toLowerCase()];
    const encoding = pickEncoding(String(req.headers['accept-encoding'] || ''));
    if (!type || !encoding || rel.includes('\0')) {
      next();
      return;
    }
    const file = path.resolve(base, `.${path.posix.normalize(`/${rel}`)}`);
    if (file !== base && !file.startsWith(base + path.sep)) {
      next();
      return;
    }
    /** @type {fs.Stats | undefined} */
    let st;
    try {
      st = fs.statSync(file, { throwIfNoEntry: false });
    } catch {
      st = undefined;
    }
    if (!st || !st.isFile() || st.size < MIN_BYTES) {
      next();
      return;
    }
    /** @type {CompressedEntry} */
    let entry;
    try {
      entry = load(file, st);
    } catch {
      next();
      return;
    }
    const body = encoding === 'br' ? entry.br : entry.gzip;
    const etag = `"${entry.etag}-${encoding}"`;
    const current = options.bundleId ? String(options.bundleId() || '') : '';
    const versioned =
      current.length > 0 &&
      path.basename(file) === 'main.bundle.js' &&
      String(req.query?.v || '') === current;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', etag);
    res.setHeader(
      'Cache-Control',
      versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=0'
    );
    const inm = String(req.headers['if-none-match'] || '');
    if (inm.length > 0 && inm.split(',').some((t) => t.trim() === etag)) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Length', String(body.length));
    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }
    res.status(200).end(body);
  };
}
