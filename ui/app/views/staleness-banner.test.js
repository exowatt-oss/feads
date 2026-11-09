/**
 * feads addition — the staleness banner.
 *
 * The assertions worth making are almost all about the *distinction* between the two
 * kinds of stale. The failure mode this guards is offering a reload for a stale
 * process: a reload cannot fix that, so the person reloads, sees the same thing, and has
 * no way to tell it from a bug.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createStalenessBanner } from './staleness-banner.js';

/**
 * @param {Record<string, any>} [build]
 */
function makeStore(build = {}) {
  const state = {
    view: 'issues',
    selected_id: null,
    build: {
      loaded: true,
      build_id: 'boot1',
      bundle_id: 'new',
      client_stale: false,
      server_stale: false,
      restart_command: 'scripts/feads-run.sh restart',
      restart_offered: true,
      restart_allowed: true,
      restart_reason: '',
      ...build
    }
  };
  /** @type {Array<(s: any) => void>} */
  const listeners = [];
  return {
    getState: () => state,
    /** @param {(s: any) => void} fn */
    subscribe(fn) {
      listeners.push(fn);
      return () => void 0;
    },
    /** @param {Record<string, any>} patch */
    patchBuild(patch) {
      state.build = { ...state.build, ...patch };
      for (const fn of listeners) {
        fn(state);
      }
    }
  };
}

function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/**
 * @param {any} body
 * @param {{ ok?: boolean, status?: number }} [options]
 */
function stubFetch(body, options = {}) {
  /** @type {Array<{ url: string, init: any }>} */
  const calls = [];
  /** @type {any} */
  const fn = async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init });
    return {
      ok: options.ok !== false,
      status: options.status ?? 200,
      json: async () => body
    };
  };
  fn.calls = calls;
  return fn;
}

/**
 * Let the click handlers' promises settle.
 *
 * @returns {Promise<void>}
 */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the staleness banner', () => {
  test('says nothing before the server has reported', () => {
    // Not-yet-reported and reported-as-current are different states. A banner that
    // flashed on every page load would be noise.
    const el = mount();
    createStalenessBanner(el, makeStore({ loaded: false, client_stale: true }));
    expect(el.textContent?.trim()).toBe('');
  });

  test('says nothing when nothing is stale', () => {
    const el = mount();
    createStalenessBanner(el, makeStore());
    expect(el.textContent?.trim()).toBe('');
  });

  test('offers a reload for a stale bundle', () => {
    const el = mount();
    const reload = vi.fn();
    createStalenessBanner(el, makeStore({ client_stale: true }), {
      onReload: reload
    });

    expect(String(el.textContent)).toContain('Update available');
    const button = /** @type {HTMLButtonElement} */ (
      el.querySelector('.staleness__row--client .staleness__action')
    );
    expect(button.textContent?.trim()).toBe('Reload');
    button.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a stale server is reported separately and never offers a reload', () => {
    // The crux. Reloading cannot fix a process that predates the code on disk, and
    // saying so is the difference between a warning and a trap.
    const el = mount();
    createStalenessBanner(el, makeStore({ server_stale: true }));

    const text = String(el.textContent);
    expect(text).toContain('Server is running old code');
    expect(text).toContain('reloading will not help');
    expect(el.querySelector('.staleness__row--client')).toBeNull();
    expect(
      el
        .querySelector('.staleness__row--server .staleness__action')
        ?.textContent?.trim()
    ).toBe('Restart server');
  });

  test('both kinds appear as two rows with two remedies', () => {
    // What a deploy over a running daemon actually looks like, which is the original
    // report.
    const el = mount();
    createStalenessBanner(
      el,
      makeStore({ client_stale: true, server_stale: true })
    );
    expect(el.querySelector('.staleness__row--client')).not.toBeNull();
    expect(el.querySelector('.staleness__row--server')).not.toBeNull();
  });

  test('the command is shown even when the button is offered', () => {
    // The button can fail — the spawn may not take, the launcher may be wrong — and a
    // person left staring at a failed restart with nothing to type is back where they
    // started.
    const el = mount();
    createStalenessBanner(el, makeStore({ server_stale: true }));
    expect(el.querySelector('.staleness__command')?.textContent).toBe(
      'scripts/feads-run.sh restart'
    );
  });

  test('the command replaces the button when this caller may not restart', () => {
    // The two cases where the server says no are a hosted deployment
    // (`FEADS_REQUIRE_AGENT`) and a request from off-box. Notably *not* a tier: a
    // loopback caller may restart whatever it is signed in as, because it can already
    // run the command from the shell. See `server/server-routes.js`.
    const el = mount();
    createStalenessBanner(
      el,
      makeStore({
        server_stale: true,
        restart_allowed: false,
        restart_reason: 'FEADS_REQUIRE_AGENT is set, so restart is not offered'
      })
    );
    expect(
      el.querySelector('.staleness__row--server .staleness__action')
    ).toBeNull();
    expect(String(el.textContent)).toContain('FEADS_REQUIRE_AGENT');
    expect(el.querySelector('.staleness__command')?.textContent).toBe(
      'scripts/feads-run.sh restart'
    );
  });

  test('and when the deployment has no launcher at all', () => {
    const el = mount();
    createStalenessBanner(
      el,
      makeStore({
        server_stale: true,
        restart_offered: false,
        restart_allowed: false,
        restart_reason: 'no launcher script on this install'
      })
    );
    expect(
      el.querySelector('.staleness__row--server .staleness__action')
    ).toBeNull();
    expect(el.querySelector('.staleness__command')).not.toBeNull();
  });

  test('copying the command reports that it happened', async () => {
    const el = mount();
    /** @type {string[]} */
    const copied = [];
    createStalenessBanner(el, makeStore({ server_stale: true }), {
      copy: async (text) => {
        copied.push(text);
      }
    });
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.staleness__copy')
    ).click();
    await settle();
    expect(copied).toEqual(['scripts/feads-run.sh restart']);
    expect(el.querySelector('.staleness__copy')?.textContent?.trim()).toBe(
      'Copied'
    );
  });

  test('restarting posts with credentials and stays in the restarting state', async () => {
    // Deliberately does not claim success: this process is being killed, so "done" would
    // be a claim the page cannot verify. `main.js` reloads when the new daemon answers.
    const el = mount();
    const fetchStub = stubFetch({ ok: true, restarting: true });
    createStalenessBanner(el, makeStore({ server_stale: true }), {
      fetch: fetchStub
    });
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.staleness__row--server .staleness__action')
    ).click();
    await settle();

    expect(fetchStub.calls[0].url).toBe('/api/server/restart');
    expect(fetchStub.calls[0].init.method).toBe('POST');
    // `same-origin` carries the HttpOnly agent cookie. The restart gate does not read
    // it — it is loopback plus `FEADS_REQUIRE_AGENT` and nothing else — but stating the
    // credentials mode keeps this request shaped like every other one the panel makes,
    // rather than making the reader wonder which requests are special.
    expect(fetchStub.calls[0].init.credentials).toBe('same-origin');
    expect(String(el.textContent)).toContain('Restarting…');
  });

  test('a refused restart shows the reason and leaves the command in reach', async () => {
    // The reachable refusals are the hosted flag and a non-loopback peer. Whatever the
    // server's reason, the copyable command has to survive it — a person left staring at
    // a failed restart with nothing to type is back where they started.
    const el = mount();
    const fetchStub = stubFetch(
      {
        ok: false,
        error: {
          code: 'not_local',
          message:
            'the dashboard can only be restarted from the machine it runs on'
        }
      },
      { ok: false, status: 403 }
    );
    createStalenessBanner(el, makeStore({ server_stale: true }), {
      fetch: fetchStub
    });
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.staleness__row--server .staleness__action')
    ).click();
    await settle();

    expect(el.querySelector('.staleness__error')?.textContent).toContain(
      'the machine it runs on'
    );
    expect(el.querySelector('.staleness__command')).not.toBeNull();
  });

  test('a request that never comes back is reported as a maybe, not a failure', async () => {
    // The process may genuinely have gone down before answering. Saying "failed" would
    // be wrong as often as it was right.
    const el = mount();
    createStalenessBanner(el, makeStore({ server_stale: true }), {
      fetch: async () => {
        throw new Error('network');
      }
    });
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.staleness__row--server .staleness__action')
    ).click();
    await settle();
    expect(el.querySelector('.staleness__error')?.textContent).toContain(
      'may be restarting anyway'
    );
  });

  test('each kind is dismissible on its own', () => {
    // Living with a stale process for now must not also hide a stale bundle, which has
    // a remedy that works.
    const el = mount();
    createStalenessBanner(
      el,
      makeStore({ client_stale: true, server_stale: true })
    );
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.staleness__row--server .staleness__dismiss')
    ).click();
    expect(el.querySelector('.staleness__row--server')).toBeNull();
    expect(el.querySelector('.staleness__row--client')).not.toBeNull();
  });

  test('it is a strip, not a dialog — nothing is blocked', () => {
    // The dashboard still works; it is old, not broken. Someone triaging a board should
    // not have to answer a dialog to keep reading it.
    const el = mount();
    createStalenessBanner(el, makeStore({ server_stale: true }));
    expect(el.querySelector('dialog')).toBeNull();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(el.querySelector('[role="status"]')).not.toBeNull();
  });

  test('a later report updates the banner', () => {
    const store = makeStore({ client_stale: false, server_stale: false });
    const el = mount();
    createStalenessBanner(el, store);
    expect(el.textContent?.trim()).toBe('');

    store.patchBuild({ server_stale: true });
    expect(String(el.textContent)).toContain('Server is running old code');
  });

  test('destroy clears the mount', () => {
    const el = mount();
    const panel = createStalenessBanner(el, makeStore({ server_stale: true }));
    expect(el.textContent?.trim().length).toBeGreaterThan(0);
    panel.destroy();
    expect(el.textContent?.trim()).toBe('');
  });
});
