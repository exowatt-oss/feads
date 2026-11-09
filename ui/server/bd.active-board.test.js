/**
 * feads addition — `bd` children must carry the *caller's* board, not the board
 * the daemon happened to inherit and not a board some other caller selected.
 *
 * This is the regression guard for two bugs at once: the original one where
 * switching boards changed only the label, and ex-dh0, where the board was per
 * daemon so one browser tab's switch redirected another tab's reads.
 */
import { spawn as spawnMock } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindSeedBoard } from './active-board.js';
import { runBd } from './bd.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const mockedSpawn = /** @type {import('vitest').Mock} */ (spawnMock);

function makeFakeProc() {
  const cp = /** @type {any} */ (new EventEmitter());
  cp.stdout = new PassThrough();
  cp.stderr = new PassThrough();
  setTimeout(() => {
    cp.stdout.end();
    cp.stderr.end();
    cp.emit('close', 0);
  }, 0);
  return cp;
}

beforeEach(() => {
  mockedSpawn.mockReset();
});

afterEach(() => {
  bindSeedBoard(null);
});

test('spawns bd with BEADS_DIR set to the board the caller named', async () => {
  mockedSpawn.mockReturnValueOnce(makeFakeProc());
  await runBd(['count'], {
    cwd: '/tmp',
    env: {},
    board_dir: '/boards/alpha/.beads'
  });

  const options = mockedSpawn.mock.calls[0][2];
  expect(options.env.BEADS_DIR).toBe('/boards/alpha/.beads');
});

test("the caller's board outranks a BEADS_DIR inherited by the daemon", async () => {
  mockedSpawn.mockReturnValueOnce(makeFakeProc());
  await runBd(['count'], {
    cwd: '/tmp',
    env: { BEADS_DIR: '/boards/alpha/.beads' },
    board_dir: '/boards/bravo/.beads'
  });

  const options = mockedSpawn.mock.calls[0][2];
  expect(options.env.BEADS_DIR).toBe('/boards/bravo/.beads');
});

test("the caller's board outranks the seed board", async () => {
  // ex-dh0 in one assertion: the seed is what a caller gets when it names no
  // board, and it must never override one that did.
  bindSeedBoard('/boards/alpha/.beads');
  mockedSpawn.mockReturnValueOnce(makeFakeProc());
  await runBd(['count'], {
    cwd: '/tmp',
    env: {},
    board_dir: '/boards/bravo/.beads'
  });

  expect(mockedSpawn.mock.calls[0][2].env.BEADS_DIR).toBe(
    '/boards/bravo/.beads'
  );
});

test('interleaved calls each carry their own board', async () => {
  // Two connections' invocations pass through the same choke point and the same
  // run queue. Neither may pick up the other's board.
  mockedSpawn.mockReturnValueOnce(makeFakeProc());
  mockedSpawn.mockReturnValueOnce(makeFakeProc());
  await Promise.all([
    runBd(['count'], {
      cwd: '/tmp',
      env: {},
      board_dir: '/boards/alpha/.beads'
    }),
    runBd(['count'], {
      cwd: '/tmp',
      env: {},
      board_dir: '/boards/bravo/.beads'
    })
  ]);

  const boards = mockedSpawn.mock.calls.map((call) => call[2].env.BEADS_DIR);
  expect(boards.sort()).toEqual([
    '/boards/alpha/.beads',
    '/boards/bravo/.beads'
  ]);
});

test('a board-less selection unsets an inherited BEADS_DIR', async () => {
  mockedSpawn.mockReturnValueOnce(makeFakeProc());
  await runBd(['count'], {
    cwd: '/tmp',
    env: { BEADS_DIR: '/boards/alpha/.beads' },
    board_dir: ''
  });

  const options = mockedSpawn.mock.calls[0][2];
  expect(options.env.BEADS_DIR).toBeUndefined();
});

test('a call that names no board falls back to the seed', async () => {
  // The safe default for a call site that has not been threaded — including any
  // added by a future upstream merge.
  bindSeedBoard('/boards/alpha/.beads');
  mockedSpawn.mockReturnValueOnce(makeFakeProc());
  await runBd(['count'], { cwd: '/tmp', env: {} });

  const options = mockedSpawn.mock.calls[0][2];
  expect(options.env.BEADS_DIR).toBe('/boards/alpha/.beads');
});

test('an unbound server leaves the inherited environment alone', async () => {
  bindSeedBoard(null);
  mockedSpawn.mockReturnValueOnce(makeFakeProc());
  await runBd(['count'], {
    cwd: '/tmp',
    env: { BEADS_DIR: '/boards/alpha/.beads' }
  });

  const options = mockedSpawn.mock.calls[0][2];
  expect(options.env.BEADS_DIR).toBe('/boards/alpha/.beads');
});

test('required actor stamping preserves the caller board and clears ambient actor', async () => {
  mockedSpawn.mockReturnValueOnce(makeFakeProc());
  await runBd(['comments', 'add', 'UI-7', 'note'], {
    cwd: '/boards/bravo',
    env: {
      BEADS_DIR: '/boards/alpha/.beads',
      BEADS_ACTOR: 'ambient-malicious-actor'
    },
    board_dir: '/boards/bravo/.beads',
    require_actor: true,
    actor: () => 'silo-agent'
  });

  const options = mockedSpawn.mock.calls[0][2];
  expect(options.env.BEADS_DIR).toBe('/boards/bravo/.beads');
  expect(options.env.BEADS_ACTOR).toBe('silo-agent');
});
