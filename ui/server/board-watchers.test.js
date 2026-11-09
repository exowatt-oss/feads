/**
 * feads addition — the per-board watcher pool.
 *
 * The two failure modes this file is here to catch are both silent: a watcher that
 * outlives the connections that wanted it (an `fs.watch` handle is `persistent:
 * true`, so it holds the event loop open for the life of the process), and a watcher
 * closed while somebody is still on the board (that board simply stops updating, and
 * nothing says so).
 *
 * The watcher factory is injected throughout, so nothing here touches the
 * filesystem: a leaked real handle in a test suite shows up as a run that will not
 * exit rather than as a failure.
 */
import { describe, expect, test } from 'vitest';
import { createBoardWatcherPool } from './board-watchers.js';

/**
 * @returns {{ create: (board: any, notify: () => void) => any, created: any[] }}
 */
function fakeWatchers() {
  /** @type {any[]} */
  const created = [];
  return {
    created,
    create: (board, notify) => {
      /** @type {any} */
      const entry = {
        board,
        notify,
        closed: false,
        close() {
          entry.closed = true;
        }
      };
      created.push(entry);
      return entry;
    }
  };
}

/**
 * @param {string} key
 * @returns {{ key: string, root_dir: string }}
 */
function board(key) {
  return { key, root_dir: `/boards/${key}` };
}

describe('createBoardWatcherPool', () => {
  test('one watcher per board, however many connections are on it', () => {
    const fake = fakeWatchers();
    const pool = createBoardWatcherPool({ create: fake.create });
    const a = {};
    const b = {};
    const c = {};

    pool.retain(board('alpha'), a);
    pool.retain(board('alpha'), b);
    pool.retain(board('bravo'), c);

    // Three tabs, two boards, two watchers. A watcher per connection would deliver
    // every change on alpha twice.
    expect(fake.created).toHaveLength(2);
    expect(pool.size()).toBe(2);
    expect(pool.holderCount('alpha')).toBe(2);
    expect(pool.keys().sort()).toEqual(['alpha', 'bravo']);
  });

  test('retaining the same board twice from one connection is not counted twice', () => {
    // Re-selecting the board you are already on must not increment anything, or the
    // release on the next switch leaves the watcher behind forever.
    const fake = fakeWatchers();
    const pool = createBoardWatcherPool({ create: fake.create });
    const holder = {};

    pool.retain(board('alpha'), holder);
    pool.retain(board('alpha'), holder);
    expect(pool.holderCount('alpha')).toBe(1);

    pool.release('alpha', holder);
    expect(pool.size()).toBe(0);
    expect(fake.created[0].closed).toBe(true);
  });

  test('the watcher survives until the last holder releases', () => {
    const fake = fakeWatchers();
    const pool = createBoardWatcherPool({ create: fake.create });
    const a = {};
    const b = {};

    pool.retain(board('alpha'), a);
    pool.retain(board('alpha'), b);

    pool.release('alpha', a);
    expect(fake.created[0].closed).toBe(false);
    expect(pool.size()).toBe(1);

    pool.release('alpha', b);
    expect(fake.created[0].closed).toBe(true);
    expect(pool.size()).toBe(0);
  });

  test('releaseAll drops a connection from every board it held', () => {
    // A connection can hold two boards if it closed mid-switch, so a close handler
    // that released only its current board would leak the other.
    const fake = fakeWatchers();
    const pool = createBoardWatcherPool({ create: fake.create });
    const holder = {};

    pool.retain(board('alpha'), holder);
    pool.retain(board('bravo'), holder);
    expect(pool.size()).toBe(2);

    pool.releaseAll(holder);
    expect(pool.size()).toBe(0);
    expect(fake.created.every((w) => w.closed)).toBe(true);
  });

  test('releasing a board nobody holds is a no-op, not a throw', () => {
    const fake = fakeWatchers();
    const pool = createBoardWatcherPool({ create: fake.create });
    expect(() => pool.release('never-watched', {})).not.toThrow();
    expect(() => pool.releaseAll({})).not.toThrow();
    expect(fake.created).toHaveLength(0);
  });

  test('a change on one board notifies only that board', () => {
    /** @type {string[]} */
    const changed = [];
    const fake = fakeWatchers();
    const pool = createBoardWatcherPool({
      create: fake.create,
      onChange: (key) => changed.push(key)
    });
    pool.retain(board('alpha'), {});
    pool.retain(board('bravo'), {});

    fake.created[0].notify();
    expect(changed).toEqual(['alpha']);
    fake.created[1].notify();
    expect(changed).toEqual(['alpha', 'bravo']);
  });

  test('a watcher that cannot be created does not take the connection down', () => {
    // The ordinary case: a registered board whose directory has been deleted. The
    // holder accounting still has to be symmetric, or the release below would throw
    // or leak.
    const pool = createBoardWatcherPool({
      create: () => {
        throw new Error('ENOENT');
      }
    });
    const holder = {};
    expect(() => pool.retain(board('gone'), holder)).not.toThrow();
    expect(pool.holderCount('gone')).toBe(1);
    expect(() => pool.release('gone', holder)).not.toThrow();
    expect(pool.size()).toBe(0);
  });

  test('a watcher whose close throws does not block the pool', () => {
    const pool = createBoardWatcherPool({
      create: () => ({
        close() {
          throw new Error('already closed');
        }
      })
    });
    const holder = {};
    pool.retain(board('alpha'), holder);
    expect(() => pool.release('alpha', holder)).not.toThrow();
    expect(pool.size()).toBe(0);
  });

  test('a board with no key is refused rather than pooled under one', () => {
    // Every board is keyed by its `.beads` directory or its project root. An empty
    // key would collapse two boards onto one watcher.
    const fake = fakeWatchers();
    const pool = createBoardWatcherPool({ create: fake.create });
    pool.retain({ key: '', root_dir: '/somewhere' }, {});
    expect(pool.size()).toBe(0);
    expect(fake.created).toHaveLength(0);
  });

  test('closeAll closes every watcher and empties the pool', () => {
    const fake = fakeWatchers();
    const pool = createBoardWatcherPool({ create: fake.create });
    pool.retain(board('alpha'), {});
    pool.retain(board('bravo'), {});

    pool.closeAll();
    expect(pool.size()).toBe(0);
    expect(fake.created.every((w) => w.closed)).toBe(true);
  });
});
