/**
 * feads addition — build identity and the two kinds of staleness.
 *
 * The subject is a distinction, not a mechanism: a stale *bundle* and a stale
 * *process* need different remedies, and the failure this guards against is reporting
 * one as the other. So the assertions are mostly of the form "this changed and that
 * did not".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  RESTART_COMMAND,
  createBuildIdentity,
  snapshotBundle,
  snapshotSources,
  watchBuildIdentity
} from './build-identity.js';

/** @type {string[]} */
const temp_dirs = [];

afterEach(() => {
  while (temp_dirs.length > 0) {
    fs.rmSync(String(temp_dirs.pop()), { recursive: true, force: true });
  }
});

/**
 * A fake install: an `app/` with a built bundle and a `server/` with sources.
 *
 * @param {{ bundle?: string | null, server?: Record<string, string> }} [options]
 * @returns {{ root: string, app_dir: string, server_dir: string }}
 */
function makeInstall(options = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'feads-build-'))
  );
  temp_dirs.push(root);
  const app_dir = path.join(root, 'app');
  const server_dir = path.join(root, 'server');
  fs.mkdirSync(app_dir, { recursive: true });
  fs.mkdirSync(server_dir, { recursive: true });
  if (options.bundle !== null) {
    fs.writeFileSync(
      path.join(app_dir, 'main.bundle.js'),
      options.bundle ?? 'console.log(1);'
    );
  }
  for (const [name, content] of Object.entries(
    options.server ?? { 'ws.js': 'export const a = 1;' }
  )) {
    fs.writeFileSync(path.join(server_dir, name), content);
  }
  return { root, app_dir, server_dir };
}

/**
 * @param {{ app_dir: string, server_dir: string }} install
 * @returns {ReturnType<typeof createBuildIdentity>}
 */
function identityFor(install) {
  return createBuildIdentity({
    app_dir: install.app_dir,
    server_dir: install.server_dir,
    // Pointed at a directory that does not exist, so the real repo's `boards/` cannot
    // leak into a test's digest and make it depend on the checkout it runs in.
    boards_dir: path.join(install.server_dir, 'no-boards-here')
  });
}

describe('snapshotSources', () => {
  test('a content change changes the digest', () => {
    const install = makeInstall();
    const before = snapshotSources([install.server_dir]);
    fs.writeFileSync(
      path.join(install.server_dir, 'ws.js'),
      'export const a = 2;'
    );
    expect(snapshotSources([install.server_dir]).digest).not.toBe(
      before.digest
    );
  });

  test('a touch with no content change does not', () => {
    // The reason this is content-hashed rather than mtime-compared: a `touch`, a `git
    // checkout` that rewrites an identical file, and a real edit all look "newer", and
    // telling somebody to restart a process that is running exactly the code on disk
    // is how a warning gets ignored.
    const install = makeInstall();
    const before = snapshotSources([install.server_dir]);
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(path.join(install.server_dir, 'ws.js'), later, later);
    const after = snapshotSources([install.server_dir]);
    expect(after.digest).toBe(before.digest);
    expect(after.newest_mtime_ms).toBeGreaterThan(before.newest_mtime_ms);
  });

  test('test files are excluded', () => {
    // A `*.test.js` is never loaded by the daemon, so editing one cannot make the
    // running process stale. Counting them would light the banner permanently for
    // anyone working on this repo.
    const install = makeInstall();
    const before = snapshotSources([install.server_dir]);
    fs.writeFileSync(
      path.join(install.server_dir, 'ws.test.js'),
      'test("x", () => {});'
    );
    expect(snapshotSources([install.server_dir]).digest).toBe(before.digest);
  });

  test('a removed file changes the digest', () => {
    // "Stale" is "the process no longer matches disk", not "disk is newer". A revert or
    // a deletion leaves the process running code that is gone.
    const install = makeInstall({
      server: { 'ws.js': 'export const a = 1;', 'db.js': 'export const b = 2;' }
    });
    const before = snapshotSources([install.server_dir]);
    fs.rmSync(path.join(install.server_dir, 'db.js'));
    expect(snapshotSources([install.server_dir]).digest).not.toBe(
      before.digest
    );
  });

  test('a moved file changes the digest even with identical content', () => {
    const install = makeInstall();
    const before = snapshotSources([install.server_dir]);
    fs.renameSync(
      path.join(install.server_dir, 'ws.js'),
      path.join(install.server_dir, 'websocket.js')
    );
    expect(snapshotSources([install.server_dir]).digest).not.toBe(
      before.digest
    );
  });

  test('a missing directory contributes nothing rather than throwing', () => {
    const snapshot = snapshotSources(['/definitely/not/here']);
    expect(snapshot.file_count).toBe(0);
  });
});

describe('snapshotBundle', () => {
  test('hashes the built bundle when there is one', () => {
    const install = makeInstall({ bundle: 'console.log("a");' });
    const before = snapshotBundle(install.app_dir);
    expect(before.from).toBe('bundle');
    expect(before.bundle_id.length).toBeGreaterThan(0);

    fs.writeFileSync(
      path.join(install.app_dir, 'main.bundle.js'),
      'console.log("b");'
    );
    expect(snapshotBundle(install.app_dir).bundle_id).not.toBe(
      before.bundle_id
    );
  });

  test('falls back to the app sources when there is no bundle', () => {
    // Dev mode: `app.js` bundles the sources on demand, so the sources *are* what the
    // browser receives. Hashing only a missing file would make a dev dashboard unable
    // to notice its own bundle changing.
    const install = makeInstall({ bundle: null });
    fs.writeFileSync(
      path.join(install.app_dir, 'main.js'),
      'export const x=1;'
    );
    const before = snapshotBundle(install.app_dir);
    expect(before.from).toBe('sources');
    expect(before.bundle_id.length).toBeGreaterThan(0);

    fs.writeFileSync(
      path.join(install.app_dir, 'main.js'),
      'export const x=2;'
    );
    expect(snapshotBundle(install.app_dir).bundle_id).not.toBe(
      before.bundle_id
    );
  });

  test('reports no id when there is nothing to serve', () => {
    const install = makeInstall({ bundle: null });
    expect(snapshotBundle(install.app_dir)).toEqual({
      bundle_id: '',
      from: 'none'
    });
  });
});

describe('createBuildIdentity', () => {
  test('a rebuilt bundle is client staleness, not server staleness', () => {
    // The distinction the whole feature rests on. A new bundle is served straight off
    // disk, so the *process* is fine and a reload is the entire remedy.
    const install = makeInstall({ bundle: 'old' });
    const identity = identityFor(install);
    expect(identity.report().server_stale).toBe(false);

    fs.writeFileSync(path.join(install.app_dir, 'main.bundle.js'), 'new');
    const report = identity.report();
    expect(report.server_stale).toBe(false);
    expect(report.bundle_id).not.toBe(report.boot_bundle_id);
    // The process identity does not move: it is a property of what was loaded.
    expect(report.build_id).toBe(identity.boot.build_id);
  });

  test('an edited server source is server staleness, not client staleness', () => {
    // And this is the half a reload cannot fix.
    const install = makeInstall();
    const identity = identityFor(install);
    expect(identity.report().server_stale).toBe(false);

    fs.writeFileSync(
      path.join(install.server_dir, 'ws.js'),
      'export const a = 99;'
    );
    const report = identity.report();
    expect(report.server_stale).toBe(true);
    // The bundle is untouched, so the browser has nothing to re-fetch.
    expect(report.bundle_id).toBe(report.boot_bundle_id);
  });

  test('both at once, which is what a deploy over a running daemon looks like', () => {
    const install = makeInstall({ bundle: 'old' });
    const identity = identityFor(install);
    fs.writeFileSync(path.join(install.app_dir, 'main.bundle.js'), 'new');
    fs.writeFileSync(
      path.join(install.server_dir, 'ws.js'),
      'export const a = 99;'
    );
    const report = identity.report();
    expect(report.server_stale).toBe(true);
    expect(report.bundle_id).not.toBe(report.boot_bundle_id);
  });

  test('carries the command a person can run by hand', () => {
    const identity = identityFor(makeInstall());
    expect(identity.report().restart_command).toBe(RESTART_COMMAND);
  });

  test('bundleId tracks the bundle on disk, which is what versions the script URL', () => {
    const install = makeInstall({ bundle: 'one' });
    const identity = identityFor(install);
    const first = identity.bundleId();
    fs.writeFileSync(path.join(install.app_dir, 'main.bundle.js'), 'two');
    expect(identity.bundleId()).not.toBe(first);
  });
});

describe('watchBuildIdentity', () => {
  test('fires once per change, not per check', () => {
    const install = makeInstall({ bundle: 'one' });
    const identity = identityFor(install);
    /** @type {any[]} */
    const seen = [];
    const watch = watchBuildIdentity(identity, {
      interval_ms: 1000000,
      onChange: (report) => seen.push(report)
    });
    try {
      watch.check();
      expect(seen).toHaveLength(0);

      fs.writeFileSync(path.join(install.app_dir, 'main.bundle.js'), 'two');
      watch.check();
      watch.check();
      expect(seen).toHaveLength(1);
      expect(seen[0].bundle_id).not.toBe(identity.boot.bundle_id);
    } finally {
      watch.stop();
    }
  });

  test('a changed mtime alone does not wake every client', () => {
    // The signature is deliberately narrower than the report: mtimes move whenever
    // anything is touched, and broadcasting for one that changed neither answer would
    // re-render the banner in every open browser on a timer.
    const install = makeInstall();
    const identity = identityFor(install);
    /** @type {any[]} */
    const seen = [];
    const watch = watchBuildIdentity(identity, {
      interval_ms: 1000000,
      onChange: (report) => seen.push(report)
    });
    try {
      const later = new Date(Date.now() + 60000);
      fs.utimesSync(path.join(install.server_dir, 'ws.js'), later, later);
      watch.check();
      expect(seen).toHaveLength(0);
    } finally {
      watch.stop();
    }
  });

  test('reports server staleness when the sources change', () => {
    const install = makeInstall();
    const identity = identityFor(install);
    /** @type {any[]} */
    const seen = [];
    const watch = watchBuildIdentity(identity, {
      interval_ms: 1000000,
      onChange: (report) => seen.push(report)
    });
    try {
      fs.writeFileSync(
        path.join(install.server_dir, 'ws.js'),
        'export const a = 3;'
      );
      watch.check();
      expect(seen).toHaveLength(1);
      expect(seen[0].server_stale).toBe(true);
    } finally {
      watch.stop();
    }
  });
});

describe('watchBuildIdentity degradation', () => {
  test('an unreadable report at construction does not throw', () => {
    // This runs inside `attachWsServer`, at daemon boot. Throwing here would take the
    // whole dashboard down at startup over a diagnostic — a far worse outcome than not
    // knowing whether the build is current.
    expect(() =>
      watchBuildIdentity(
        {
          report: () => {
            throw new Error('unreadable');
          }
        },
        { interval_ms: 1000000, onChange: () => {} }
      ).stop()
    ).not.toThrow();
  });

  test('a report that starts working is then broadcast', () => {
    // The recovery that falls out of using `''` as the baseline: clients are told the
    // moment there is something to tell them.
    let broken = true;
    /** @type {any[]} */
    const seen = [];
    const watch = watchBuildIdentity(
      {
        report: () => {
          if (broken) {
            throw new Error('unreadable');
          }
          return {
            build_id: 'b',
            bundle_id: 'bundle1',
            boot_bundle_id: 'bundle1',
            server_stale: false,
            boot_at: 0,
            source_newest_mtime_ms: 0,
            boot_source_newest_mtime_ms: 0,
            restart_command: RESTART_COMMAND
          };
        }
      },
      { interval_ms: 1000000, onChange: (report) => seen.push(report) }
    );
    try {
      broken = false;
      watch.check();
      expect(seen).toHaveLength(1);
    } finally {
      watch.stop();
    }
  });

  test('a report that throws mid-life is skipped, not fatal', () => {
    let broken = false;
    const watch = watchBuildIdentity(
      {
        report: () => {
          if (broken) {
            throw new Error('vanished');
          }
          return {
            build_id: 'b',
            bundle_id: 'bundle1',
            boot_bundle_id: 'bundle1',
            server_stale: false,
            boot_at: 0,
            source_newest_mtime_ms: 0,
            boot_source_newest_mtime_ms: 0,
            restart_command: RESTART_COMMAND
          };
        }
      },
      { interval_ms: 1000000, onChange: () => {} }
    );
    try {
      broken = true;
      expect(() => watch.check()).not.toThrow();
    } finally {
      watch.stop();
    }
  });
});
