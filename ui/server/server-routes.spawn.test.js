/**
 * feads addition — the restart child has to outlive the process it is restarting.
 *
 * Its own file because `vi.mock('node:child_process')` is module-wide, and
 * `server-routes.test.js` next door needs a real `express` listening on a real socket.
 *
 * What is asserted here is not "spawn was called" but the three flags that decide
 * whether the restart works at all. All three fail silently: a non-detached child is in
 * this process's group, so the `stop` half of `feads-run.sh restart` kills it halfway
 * through and leaves *nothing* running; a child that is not `unref`'d holds this event
 * loop open and the stop hangs; and inherited stdio leaves the child blocked on a write
 * to a pipe whose reader is dead. In every case the dashboard simply never comes back,
 * with no error anywhere.
 */
import { spawn as spawnMock } from 'node:child_process';
import { beforeEach, expect, test, vi } from 'vitest';
import { spawnDetachedRestart } from './server-routes.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const mockedSpawn = /** @type {import('vitest').Mock} */ (spawnMock);

beforeEach(() => {
  mockedSpawn.mockReset();
  mockedSpawn.mockReturnValue({ unref: vi.fn() });
});

test('the restart child is detached, unref’d and has no stdio', () => {
  spawnDetachedRestart('/repo/scripts/feads-run.sh');

  const [command, args, options] = mockedSpawn.mock.calls[0];
  expect(command).toBe('/repo/scripts/feads-run.sh');
  expect(args).toEqual(['restart']);
  expect(options.detached).toBe(true);
  expect(options.stdio).toBe('ignore');
  // No shell: the path is not a command line, and running it through one would make an
  // install path containing a space or a quote into an injection.
  expect(options.shell).toBe(false);

  const child = mockedSpawn.mock.results[0].value;
  expect(child.unref).toHaveBeenCalled();
});

test('the child runs from the repo root, not from wherever the daemon was started', () => {
  // `feads-run.sh` resolves paths relative to its own repo, and the daemon's cwd is
  // whichever directory somebody typed `make run` in — which may be a nested repo.
  spawnDetachedRestart('/repo/scripts/feads-run.sh');
  expect(mockedSpawn.mock.calls[0][2].cwd).toBe('/repo');
});
