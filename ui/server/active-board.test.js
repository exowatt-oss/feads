/**
 * feads addition — tests for per-call board binding.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  applyBoardEnv,
  bindConnectionBoard,
  bindSeedBoard,
  findNearestBoardDir,
  getConnectionBoardDir,
  getSeedBoardDir,
  hasConnectionBoard,
  isBoardDir,
  releaseConnectionBoard,
  resolveInitialBoardDir
} from './active-board.js';

/** @type {string[]} */
const temp_dirs = [];

/**
 * @param {{ board?: boolean, empty_beads?: boolean }} [options]
 * @returns {string}
 */
function makeWorkspace(options = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bdui-board-'))
  );
  temp_dirs.push(root);
  if (options.board || options.empty_beads) {
    const beads_dir = path.join(root, '.beads');
    fs.mkdirSync(beads_dir, { recursive: true });
    if (options.board) {
      fs.writeFileSync(path.join(beads_dir, 'metadata.json'), '{}');
    }
  }
  return root;
}

afterEach(() => {
  bindSeedBoard(null);
  for (const dir of temp_dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('applyBoardEnv', () => {
  test('leaves the environment untouched while unbound', () => {
    bindSeedBoard(null);
    expect(getSeedBoardDir()).toBe(null);
    const env = applyBoardEnv({ BEADS_DIR: '/inherited/.beads' });
    expect(env.BEADS_DIR).toBe('/inherited/.beads');
  });

  test('overrides an inherited BEADS_DIR with the named board', () => {
    const env = applyBoardEnv(
      { BEADS_DIR: '/inherited/.beads' },
      '/boards/alpha/.beads'
    );
    expect(env.BEADS_DIR).toBe('/boards/alpha/.beads');
  });

  test('drops an inherited BEADS_DIR for a board-less workspace', () => {
    const env = applyBoardEnv({ BEADS_DIR: '/inherited/.beads' }, '');
    expect('BEADS_DIR' in env).toBe(false);
  });

  test('a caller that names no board gets the seed', () => {
    bindSeedBoard('/boards/alpha/.beads');
    expect(applyBoardEnv({}).BEADS_DIR).toBe('/boards/alpha/.beads');
    bindSeedBoard('/boards/bravo/.beads');
    expect(applyBoardEnv({}).BEADS_DIR).toBe('/boards/bravo/.beads');
  });

  test('a named board is not affected by the seed', () => {
    // The whole point of ex-dh0: what one caller reads must not depend on what
    // another caller (or the daemon's own startup) selected.
    bindSeedBoard('/boards/alpha/.beads');
    expect(applyBoardEnv({}, '/boards/bravo/.beads').BEADS_DIR).toBe(
      '/boards/bravo/.beads'
    );
  });
});

describe('per-connection board binding', () => {
  test('a connection that has chosen nothing reads through to the seed', () => {
    const conn = {};
    bindSeedBoard('/boards/alpha/.beads');
    expect(hasConnectionBoard(conn)).toBe(false);
    expect(getConnectionBoardDir(conn)).toBe('/boards/alpha/.beads');
    // …and follows a later seed correction, which is why "has not chosen" is
    // represented by absence rather than by a copy of the seed.
    bindSeedBoard('/boards/bravo/.beads');
    expect(getConnectionBoardDir(conn)).toBe('/boards/bravo/.beads');
  });

  test('one connection selecting a board does not move another', () => {
    const anonymous = {};
    const identified = {};
    bindSeedBoard('/boards/alpha/.beads');
    bindConnectionBoard(identified, '/boards/alpha/.beads');
    bindConnectionBoard(anonymous, '/boards/bravo/.beads');

    expect(getConnectionBoardDir(identified)).toBe('/boards/alpha/.beads');
    expect(getConnectionBoardDir(anonymous)).toBe('/boards/bravo/.beads');
    // Nor does it move the seed, which is what new connections start on.
    expect(getSeedBoardDir()).toBe('/boards/alpha/.beads');
  });

  test('a connection binding does not leak into the environment of another', () => {
    const conn = {};
    bindSeedBoard('/boards/alpha/.beads');
    bindConnectionBoard(conn, '/boards/bravo/.beads');
    expect(applyBoardEnv({}, getConnectionBoardDir(conn)).BEADS_DIR).toBe(
      '/boards/bravo/.beads'
    );
    expect(applyBoardEnv({}, getConnectionBoardDir({})).BEADS_DIR).toBe(
      '/boards/alpha/.beads'
    );
  });

  test('releasing a connection returns it to the seed', () => {
    const conn = {};
    bindSeedBoard('/boards/alpha/.beads');
    bindConnectionBoard(conn, '/boards/bravo/.beads');
    releaseConnectionBoard(conn);
    expect(hasConnectionBoard(conn)).toBe(false);
    expect(getConnectionBoardDir(conn)).toBe('/boards/alpha/.beads');
  });

  test('a connection bound to nothing keeps inherited discovery', () => {
    // Distinct from "has not chosen": this connection was explicitly bound to no
    // board, so the seed must not stand in for it.
    const conn = {};
    bindSeedBoard('/boards/alpha/.beads');
    bindConnectionBoard(conn, null);
    expect(hasConnectionBoard(conn)).toBe(true);
    expect(getConnectionBoardDir(conn)).toBe(null);
    expect(
      applyBoardEnv(
        { BEADS_DIR: '/inherited/.beads' },
        getConnectionBoardDir(conn)
      ).BEADS_DIR
    ).toBe('/inherited/.beads');
  });

  test('binding relative paths resolves them, per connection', () => {
    const conn = {};
    bindConnectionBoard(conn, 'boards/alpha/.beads');
    expect(getConnectionBoardDir(conn)).toBe(
      path.resolve('boards/alpha/.beads')
    );
  });

  test('a non-object connection is ignored rather than fatal', () => {
    // `WeakMap.set` throws on a primitive. A handler with nothing to key on should
    // fall back to the seed, not kill the socket.
    bindSeedBoard('/boards/alpha/.beads');
    expect(() =>
      bindConnectionBoard(/** @type {any} */ (undefined), '/x/.beads')
    ).not.toThrow();
    expect(getConnectionBoardDir(/** @type {any} */ (undefined))).toBe(
      '/boards/alpha/.beads'
    );
  });
});

describe('isBoardDir', () => {
  test('an empty .beads directory is not a board', () => {
    const root = makeWorkspace({ empty_beads: true });
    expect(isBoardDir(path.join(root, '.beads'))).toBe(false);
  });

  test('a .beads directory with metadata is a board', () => {
    const root = makeWorkspace({ board: true });
    expect(isBoardDir(path.join(root, '.beads'))).toBe(true);
  });
});

describe('findNearestBoardDir', () => {
  test('finds a board in a parent directory', () => {
    const root = makeWorkspace({ board: true });
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(findNearestBoardDir(nested)).toBe(path.join(root, '.beads'));
  });

  test('returns empty string when there is no board', () => {
    const root = makeWorkspace();
    expect(findNearestBoardDir(root)).toBe('');
  });
});

describe('resolveInitialBoardDir', () => {
  test('prefers BEADS_DIR from the environment', () => {
    const root = makeWorkspace({ board: true });
    const resolved = resolveInitialBoardDir(root, {
      BEADS_DIR: '/exported/.beads'
    });
    expect(resolved).toBe('/exported/.beads');
  });

  test('falls back to discovery when BEADS_DIR is unset', () => {
    const root = makeWorkspace({ board: true });
    expect(resolveInitialBoardDir(root, {})).toBe(path.join(root, '.beads'));
  });
});
