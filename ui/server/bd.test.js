import { spawn as spawnMock } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getBdBin, getGitUserName, runBd, runBdJson } from './bd.js';

// Mock child_process.spawn before importing the module under test
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

/**
 * @param {string} stdoutText
 * @param {string} stderrText
 * @param {number} code
 */
function makeFakeProc(stdoutText, stderrText, code) {
  const cp = /** @type {any} */ (new EventEmitter());
  const out = new PassThrough();
  const err = new PassThrough();
  cp.stdout = out;
  cp.stderr = err;
  // Simulate async emission
  setTimeout(() => {
    if (stdoutText) {
      out.write(stdoutText);
    }
    out.end();
    if (stderrText) {
      err.write(stderrText);
    }
    err.end();
    cp.emit('close', code);
  }, 0);
  return cp;
}

const mockedSpawn = /** @type {import('vitest').Mock} */ (spawnMock);
/** @type {string[]} */
const temp_dirs = [];

function make_temp_dir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdui-bd-'));
  temp_dirs.push(dir);
  return dir;
}

beforeEach(() => {
  mockedSpawn.mockReset();
});

afterEach(() => {
  for (const dir of temp_dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('getBdBin', () => {
  test('returns env BD_BIN when set', () => {
    const prev = process.env.BD_BIN;
    process.env.BD_BIN = '/custom/bd';
    expect(getBdBin()).toBe('/custom/bd');
    if (prev) {
      process.env.BD_BIN = prev;
    } else {
      delete process.env.BD_BIN;
    }
  });
});

describe('runBd', () => {
  test('prepends --sandbox by default', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['list', '--json']);

    const args = mockedSpawn.mock.calls[0][1];
    expect(args[0]).toBe('--sandbox');
    expect(args.slice(1)).toEqual(['list', '--json']);
  });

  test('does not duplicate --sandbox when caller already provides it', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['--sandbox', 'list', '--json']);

    const args = mockedSpawn.mock.calls[0][1];
    expect(args).toEqual(['--sandbox', 'list', '--json']);
  });

  test('allows disabling default sandbox via BDUI_BD_SANDBOX', async () => {
    const prev = process.env.BDUI_BD_SANDBOX;
    process.env.BDUI_BD_SANDBOX = '0';
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));

    await runBd(['list', '--json']);

    const args = mockedSpawn.mock.calls[0][1];
    expect(args).toEqual(['list', '--json']);

    if (prev === undefined) {
      delete process.env.BDUI_BD_SANDBOX;
    } else {
      process.env.BDUI_BD_SANDBOX = prev;
    }
  });

  test('returns stdout/stderr and exit code', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    const res = await runBd(['--version']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ok');
  });

  test('non-zero exit propagates code and stderr', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('', 'boom', 1));
    const res = await runBd(['list']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('boom');
  });

  test('sets BEADS_DB for workspace-local SQLite db', async () => {
    const root = make_temp_dir();
    const beads_dir = path.join(root, '.beads');
    fs.mkdirSync(beads_dir, { recursive: true });
    const workspace_db = path.join(beads_dir, 'ui.db');
    fs.writeFileSync(workspace_db, '');

    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['list'], { cwd: root, env: {} });

    const options = mockedSpawn.mock.calls[0][2];
    expect(options.env.BEADS_DB).toBe(workspace_db);
  });

  test('does not force BEADS_DB when workspace has no local SQLite db', async () => {
    const root = make_temp_dir();

    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['list'], { cwd: root, env: {} });

    const options = mockedSpawn.mock.calls[0][2];
    expect(options.env.BEADS_DB).toBeUndefined();
  });

  test('preserves explicit BEADS_DB from caller env', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['list'], { env: { BEADS_DB: '/custom/workspace.db' } });

    const options = mockedSpawn.mock.calls[0][2];
    expect(options.env.BEADS_DB).toBe('/custom/workspace.db');
  });

  test('required actor resolution rejects an empty actor before spawning', async () => {
    const result = await runBd(['comments', 'add', 'UI-7', 'note'], {
      env: { BEADS_ACTOR: 'ambient-malicious-actor' },
      require_actor: true,
      actor: () => ''
    });

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Unable to resolve actor'
    });
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  test('required actor resolution rejects a thrown resolver before spawning', async () => {
    const result = await runBd(['create', 'new issue'], {
      env: { BEADS_ACTOR: 'ambient-malicious-actor' },
      require_actor: true,
      actor: () => {
        throw new Error('private registry details');
      }
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Unable to resolve actor');
    expect(result.stderr).not.toContain('private registry details');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  test('required actor resolution rejects non-string values before spawning', async () => {
    const result = await runBd(['update', 'UI-7'], {
      env: { BEADS_ACTOR: 'ambient-malicious-actor' },
      require_actor: true,
      actor: () => /** @type {any} */ ({ actor: 'not-a-verified-result' })
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Unable to resolve actor');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  test('required actor stamps the explicit actor and replaces ambient attribution', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));

    const result = await runBd(['comments', 'add', 'UI-7', 'note'], {
      env: { BEADS_ACTOR: 'ambient-malicious-actor' },
      require_actor: true,
      actor: 'silo-agent'
    });

    expect(result.code).toBe(0);
    expect(mockedSpawn.mock.calls[0][2].env.BEADS_ACTOR).toBe('silo-agent');
  });

  test('base mode preserves ambient attribution when actor resolution is empty or throws', async () => {
    mockedSpawn
      .mockReturnValueOnce(makeFakeProc('empty', '', 0))
      .mockReturnValueOnce(makeFakeProc('thrown', '', 0));

    await runBd(['list'], {
      env: { BEADS_ACTOR: 'ambient-operator' },
      actor: () => ''
    });
    await runBd(['list'], {
      env: { BEADS_ACTOR: 'ambient-operator' },
      actor: () => {
        throw new Error('registry unavailable');
      }
    });

    expect(mockedSpawn.mock.calls[0][2].env.BEADS_ACTOR).toBe(
      'ambient-operator'
    );
    expect(mockedSpawn.mock.calls[1][2].env.BEADS_ACTOR).toBe(
      'ambient-operator'
    );
  });

  test('a failed required call releases the queue for the next verified call', async () => {
    let release_actor = () => {};
    /** @type {Promise<void>} */
    const actor_started = new Promise((resolve) => {
      release_actor = () => resolve();
    });

    mockedSpawn.mockReturnValueOnce(
      makeFakeProc(JSON.stringify([{ id: 'UI-7' }]), '', 0)
    );

    const failed = runBd(['comments', 'add', 'UI-7', 'note'], {
      cwd: '/boards/alpha',
      board_dir: '/boards/alpha/.beads',
      env: { BEADS_ACTOR: 'ambient-malicious-actor' },
      require_actor: true,
      actor: async () => {
        await actor_started;
        return '';
      }
    });
    const verified = runBdJson(['comments', 'UI-7', '--json'], {
      cwd: '/boards/bravo',
      board_dir: '/boards/bravo/.beads',
      env: { BEADS_ACTOR: 'ambient-malicious-actor' },
      require_actor: true,
      actor: 'silo-agent'
    });

    // The first call owns the queue while its required identity is unresolved;
    // the second call must not jump ahead and spawn with the ambient identity.
    await Promise.resolve();
    expect(mockedSpawn).not.toHaveBeenCalled();

    release_actor();
    const [failed_result, verified_result] = await Promise.all([
      failed,
      verified
    ]);

    expect(failed_result.code).toBe(1);
    expect(verified_result.code).toBe(0);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(mockedSpawn.mock.calls[0][2].env.BEADS_ACTOR).toBe('silo-agent');
    expect(mockedSpawn.mock.calls[0][2].env.BEADS_DIR).toBe(
      '/boards/bravo/.beads'
    );
  });

  test('runBdJson stamps a required actor on a follow-up command', async () => {
    mockedSpawn.mockReturnValueOnce(
      makeFakeProc(JSON.stringify([{ id: 'UI-7' }]), '', 0)
    );

    const result = await runBdJson(['comments', 'UI-7', '--json'], {
      env: { BEADS_ACTOR: 'ambient-malicious-actor' },
      require_actor: true,
      actor: 'silo-agent'
    });

    expect(result.code).toBe(0);
    expect(result.stdoutJson).toEqual([{ id: 'UI-7' }]);
    expect(mockedSpawn.mock.calls[0][2].env.BEADS_ACTOR).toBe('silo-agent');
  });

  test('logs non-zero exit with args and stderr (parity with runBdJson)', async () => {
    // Enable the bd debug namespace and capture stderr writes so we can
    // assert the new exit log fires. Without this log, write failures from
    // mutation handlers (which use runBd, not runBdJson) leave no trace.
    const debug_mod = await import('debug');
    const prev_enabled = process.env.DEBUG;
    debug_mod.default.enable('beads-ui:bd');

    /** @type {string[]} */
    const captured = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(
      /** @param {any} chunk */ (chunk) => {
        captured.push(String(chunk));
        return true;
      }
    );

    try {
      mockedSpawn.mockReturnValueOnce(makeFakeProc('', 'boom', 2));
      const res = await runBd(['update', 'UI-7', '--status', 'in_progress']);
      expect(res.code).toBe(2);

      const joined = captured.join('');
      expect(joined).toMatch(/beads-ui:bd/);
      expect(joined).toMatch(/code 2/);
      expect(joined).toMatch(/update/);
      expect(joined).toMatch(/boom/);
    } finally {
      spy.mockRestore();
      if (prev_enabled === undefined) {
        debug_mod.default.disable();
      } else {
        debug_mod.default.enable(prev_enabled);
      }
    }
  });
});

describe('runBdJson', () => {
  test('parses valid JSON output', async () => {
    const json = JSON.stringify([{ id: 'UI-1' }]);
    mockedSpawn.mockReturnValueOnce(makeFakeProc(json, '', 0));
    const res = await runBdJson(['list', '--json']);
    expect(res.code).toBe(0);
    expect(Array.isArray(res.stdoutJson)).toBe(true);
  });

  test('invalid JSON yields stderr message with code 0', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('not-json', '', 0));
    const res = await runBdJson(['list', '--json']);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('Invalid JSON');
  });

  test('non-zero exit returns code and stderr', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('', 'oops', 2));
    const res = await runBdJson(['list', '--json']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('oops');
  });
});

describe('getGitUserName', () => {
  test('returns git user name on success', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('Alice Smith\n', '', 0));
    const name = await getGitUserName();
    expect(name).toBe('Alice Smith');
  });

  test('returns empty string on failure', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('', 'error', 1));
    const name = await getGitUserName();
    expect(name).toBe('');
  });
});
