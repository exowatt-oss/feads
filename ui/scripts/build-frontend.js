#!/usr/bin/env node
/**
 * Build the browser bundles for the UI using esbuild.
 *
 * - `app/main.bundle.js` — the dashboard (lit-html), with an external source map.
 * - `app/people.bundle.js` + `app/people.bundle.css` — the person hover card
 *   (React + `@example/ux`), a separate bundle the main one imports on the
 *   first hover of a name (`app/people/hover-controller.js`). Kept apart so
 *   React never weighs on the first paint.
 * - Minifies; ESM output targeting modern browsers.
 *
 * @import { BuildOptions } from 'esbuild'
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug } from '../server/logging.js';

/**
 * The esbuild options for both bundles (shared with the server's on-demand
 * development build).
 *
 * @param {string} app_dir
 * @returns {{ main: BuildOptions, people: BuildOptions }}
 */
export function frontendBuildOptions(app_dir) {
  /** @type {BuildOptions} */
  const common = {
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    sourcemap: true, // write external .map file next to the bundle
    minify: true,
    legalComments: 'none'
  };
  return {
    main: {
      ...common,
      entryPoints: [path.join(app_dir, 'main.js')],
      outfile: path.join(app_dir, 'main.bundle.js')
    },
    people: {
      ...common,
      entryPoints: [path.join(app_dir, 'people', 'hover-card.js')],
      // .js and, from the CSS it imports, .css
      outfile: path.join(app_dir, 'people.bundle.js'),
      define: { 'process.env.NODE_ENV': '"production"' }
    }
  };
}

/**
 * Build both bundles.
 */
async function run() {
  const log = debug('build');
  // Resolve repo root regardless of where this script is launched from
  const this_file = fileURLToPath(new URL(import.meta.url));
  const repo_root = path.resolve(path.dirname(this_file), '..');
  const app_dir = path.join(repo_root, 'app');

  // Ensure output directory exists when running from a fresh checkout
  mkdirSync(app_dir, { recursive: true });

  const options = frontendBuildOptions(app_dir);
  try {
    const esbuild = await import('esbuild');
    await Promise.all([
      esbuild.build(options.main),
      esbuild.build(options.people)
    ]);
    log('built main.bundle.js and people.bundle.{js,css}');
  } catch (err) {
    log('bundle error %o', err);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  run();
}
