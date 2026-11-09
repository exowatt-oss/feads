/**
 * feads addition — what `main.js` does with `build-info`.
 *
 * Two things, and the second is the one that matters most: it puts the two kinds of
 * staleness into the store (so the banner can show them), and it reloads the page when a
 * *different* daemon starts answering.
 *
 * That second rule is keyed on the reported `build_id` rather than on "did I click the
 * restart button", and that is deliberate. `build_id` is the boot identity of the
 * process, so it cannot change while a process lives — a different one over a
 * reconnected socket means a different daemon. One rule then covers the button, a
 * `feads-run.sh restart` typed in a terminal, and a crash something else restarted.
 * Sitting on the new socket showing the old page would be the same failure in a new
 * costume: every store, subscription and byte of the bundle belongs to the process that
 * died.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

/** @type {any} */
let CLIENT = null;
vi.mock('./ws.js', () => ({
  createWsClient: () => CLIENT
}));

/**
 * @returns {any}
 */
function makeClient() {
  /** @type {Map<string, (p: any) => void>} */
  const handlers = new Map();
  return {
    send: vi.fn(async () => []),
    /**
     * @param {string} type
     * @param {(p: any) => void} handler
     */
    on(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    onConnection() {
      return () => {};
    },
    /**
     * @param {string} type
     * @param {any} payload
     */
    emit(type, payload) {
      handlers.get(type)?.(payload);
    },
    close() {},
    getState() {
      return 'open';
    }
  };
}

/**
 * @param {Record<string, any>} [overrides]
 */
function report(overrides = {}) {
  return {
    build_id: 'boot-1',
    bundle_id: 'bundle-1',
    boot_bundle_id: 'bundle-1',
    server_stale: false,
    restart_command: 'scripts/feads-run.sh restart',
    restart_offered: true,
    restart_allowed: true,
    restart_reason: 'operator mode',
    ...overrides
  };
}

/**
 * @returns {{ root: HTMLElement, reload: import('vitest').Mock }}
 */
function boot() {
  document.body.innerHTML = '<main id="app"></main>';
  const root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const reload = vi.fn();
  bootstrap(root, { reload });
  return { root, reload };
}

beforeEach(() => {
  CLIENT = makeClient();
  document.body.innerHTML = '';
});

describe('build-info handling', () => {
  test('a stale server raises the banner, and the banner does not offer a reload', async () => {
    const { reload } = boot();
    await Promise.resolve();

    CLIENT.emit('build-info', report({ server_stale: true }));
    await Promise.resolve();

    const banner = document.getElementById('staleness-root');
    expect(String(banner?.textContent)).toContain('Server is running old code');
    expect(String(banner?.textContent)).toContain('reloading will not help');
    expect(reload).not.toHaveBeenCalled();
  });

  test('a current server raises nothing', async () => {
    boot();
    await Promise.resolve();
    CLIENT.emit('build-info', report());
    await Promise.resolve();
    expect(document.getElementById('staleness-root')?.textContent?.trim()).toBe(
      ''
    );
  });

  test('the first report never triggers a reload', async () => {
    // There is nothing to compare it against, and reloading on connect would be an
    // infinite loop rather than a feature.
    const { reload } = boot();
    await Promise.resolve();
    CLIENT.emit('build-info', report());
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a repeated report from the same daemon does not reload either', async () => {
    // `build-info` is re-sent whenever the build changes — a rebuild, say — and that is
    // the same process still.
    const { reload } = boot();
    await Promise.resolve();
    CLIENT.emit('build-info', report());
    CLIENT.emit('build-info', report({ bundle_id: 'bundle-2' }));
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a different build_id means a different daemon, so the page reloads once', async () => {
    const { reload } = boot();
    await Promise.resolve();

    CLIENT.emit('build-info', report({ build_id: 'boot-1' }));
    expect(reload).not.toHaveBeenCalled();

    // The restart landed and a new process is answering.
    CLIENT.emit('build-info', report({ build_id: 'boot-2' }));
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a report with no build_id is not mistaken for a new daemon', async () => {
    // An older daemon, or a truncated payload. Reloading on an absent field would be a
    // reload loop against a server that cannot say otherwise.
    const { reload } = boot();
    await Promise.resolve();
    CLIENT.emit('build-info', report({ build_id: 'boot-1' }));
    CLIENT.emit('build-info', report({ build_id: '' }));
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
  });

  test('the restart affordance follows what the server said about this caller', async () => {
    // The server refuses for a hosted deployment or an off-box request, never for a tier
    // — a loopback caller may restart whatever it is signed in as. See
    // `server/server-routes.js` for why a role check there was theatre.
    boot();
    await Promise.resolve();
    CLIENT.emit(
      'build-info',
      report({
        server_stale: true,
        restart_allowed: false,
        restart_reason: 'FEADS_REQUIRE_AGENT is set, so restart is not offered'
      })
    );
    await Promise.resolve();

    const banner = document.getElementById('staleness-root');
    expect(banner?.querySelector('.staleness__action')).toBeNull();
    expect(String(banner?.textContent)).toContain('FEADS_REQUIRE_AGENT');
    // And the command a person can run is still there.
    expect(banner?.querySelector('.staleness__command')?.textContent).toBe(
      'scripts/feads-run.sh restart'
    );
  });
});
