/**
 * feads addition — the banner that says the dashboard is out of date, and which of the
 * two things is.
 *
 * ## Why this exists at all
 *
 * A daemon had been up for four hours across a deploy. The page showed none of the new
 * UI, because the browser held a cached bundle *and* the Node process predated the
 * routes that bundle would have called. Neither fact was visible. It looked exactly like
 * a dashboard that had never had the feature.
 *
 * ## Two states, two remedies, never merged
 *
 * - **Client stale** — the bundle in this browser is not the one on the server. Reload.
 * - **Server stale** — the daemon is not running the code on disk. A reload changes
 *   nothing; the process has to be restarted.
 *
 * Collapsing them into one "out of date, reload" would be worse than showing nothing:
 * the person reloads, sees the same thing, reloads again, and has no way to tell that
 * from a bug. So the two get separate rows with separate actions, and the server-stale
 * row never offers a reload.
 *
 * ## Non-blocking, and dismissible
 *
 * A modal would be wrong. The dashboard still works — it is *old*, not broken — and
 * someone in the middle of triaging a board should not have to answer a dialog to keep
 * reading it. It is also dismissible, per state: a person who has decided to live with a
 * stale process for now should not be nagged, and the dismissal is deliberately not
 * persisted, so the next load tells them again.
 *
 * ## The command is always shown
 *
 * Even when the restart button is offered, and *especially* when it is refused or
 * absent. The button can fail — the launcher may be missing, the policy may refuse, the
 * spawn may not take — and a person left staring at a failed restart with no idea what
 * to type is back where they started. The copyable command is the part that always
 * works.
 */
import { html, render } from 'lit-html';
import { debug } from '../utils/logging.js';

/**
 * @typedef {Object} BuildState
 * @property {boolean} loaded - Whether the server has reported anything yet. Nothing is
 * shown before it has: a banner that flashes on every page load would be noise, and
 * "unknown" is not "stale".
 * @property {boolean} client_stale
 * @property {boolean} server_stale
 * @property {string} restart_command
 * @property {boolean} restart_offered - Whether this deployment has the feature at all.
 * @property {boolean} restart_allowed - Whether *this request* would be permitted, which
 * turns on where it came from rather than on who is signed in.
 * @property {string} restart_reason - Why not, when not.
 */

/**
 * Create the staleness banner (feads).
 *
 * @param {HTMLElement} mount_element
 * @param {{ getState: () => any, subscribe: (fn: (s: any) => void) => () => void }} store
 * @param {Object} [options]
 * @param {typeof fetch} [options.fetch] - Test seam.
 * @param {() => void} [options.onReload] - What "Reload" does. Injected because jsdom
 * has no navigation; the default is the real thing.
 * @param {(text: string) => Promise<void>} [options.copy] - Test seam for the clipboard,
 * which jsdom does not implement.
 * @returns {{ destroy: () => void }}
 */
export function createStalenessBanner(mount_element, store, options = {}) {
  const log = debug('views:staleness');
  const doFetch = options.fetch || ((...args) => window.fetch(...args));
  const doReload = options.onReload || (() => reloadForNewBundle());
  const copyText =
    options.copy || ((text) => window.navigator.clipboard.writeText(text));

  /** @type {'idle'|'restarting'|'failed'} */
  let restart_phase = 'idle';
  let restart_error = '';
  let copied = false;
  /** Dismissed per kind, so living with one does not hide the other. */
  const dismissed = { client: false, server: false };
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /**
   * @returns {BuildState}
   */
  function buildState() {
    const s = store.getState();
    return (
      s.build || {
        loaded: false,
        client_stale: false,
        server_stale: false,
        restart_command: '',
        restart_offered: false,
        restart_allowed: false,
        restart_reason: ''
      }
    );
  }

  async function onRestart() {
    restart_phase = 'restarting';
    restart_error = '';
    doRender();
    try {
      const res = await doFetch('/api/server/restart', {
        method: 'POST',
        // `same-origin` is the default, and stated for consistency with the other
        // requests this panel's neighbours make rather than because the route needs it:
        // the restart gate reads the peer address and `FEADS_REQUIRE_AGENT`, and resolves
        // no identity at all. See `server/server-routes.js` for why a role check there
        // would have been theatre.
        credentials: 'same-origin'
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        restart_phase = 'failed';
        restart_error =
          typeof json?.error?.message === 'string'
            ? json.error.message
            : `Restart failed (${res.status})`;
        doRender();
        return;
      }
      // Stay in `restarting`. The socket is about to drop and `main.js` reloads the
      // page once the new daemon answers, so there is nothing more to say here — and
      // saying "done" would be a claim this code cannot verify from inside a process
      // that is being killed.
      log('restart acknowledged');
    } catch (err) {
      // The response may genuinely not arrive if the process went down early. Say so
      // as a maybe rather than as a failure, and leave the command on screen.
      log('restart request failed: %o', err);
      restart_phase = 'failed';
      restart_error =
        'The restart request did not come back. The server may be restarting anyway — ' +
        'if the page does not reconnect, run the command below.';
    }
    doRender();
  }

  async function onCopy() {
    try {
      await copyText(buildState().restart_command);
      copied = true;
    } catch (err) {
      log('copy failed: %o', err);
      copied = false;
    }
    doRender();
  }

  /**
   * @param {'client'|'server'} kind
   */
  function dismiss(kind) {
    dismissed[kind] = true;
    doRender();
  }

  function clientRow() {
    return html`
      <div class="staleness__row staleness__row--client" role="status">
        <span class="staleness__label">Update available</span>
        <span class="staleness__text">
          This page is running an older build than the server. Reloading will
          pick up the new one.
        </span>
        <button
          type="button"
          class="staleness__action"
          @click=${() => doReload()}
        >
          Reload
        </button>
        <button
          type="button"
          class="staleness__dismiss"
          aria-label="Dismiss update notice"
          @click=${() => dismiss('client')}
        >
          ×
        </button>
      </div>
    `;
  }

  function serverRow() {
    const build = buildState();
    return html`
      <div class="staleness__row staleness__row--server" role="status">
        <span class="staleness__label">Server is running old code</span>
        <span class="staleness__text">
          The dashboard process started before the current files were written,
          so
          <strong>reloading will not help</strong> — it has to be restarted.
        </span>
        ${build.restart_offered && build.restart_allowed
          ? html`
              <button
                type="button"
                class="staleness__action"
                ?disabled=${restart_phase === 'restarting'}
                @click=${() => void onRestart()}
              >
                ${restart_phase === 'restarting'
                  ? 'Restarting…'
                  : 'Restart server'}
              </button>
            `
          : html`
              <span class="staleness__note"
                >${build.restart_reason ||
                'this dashboard cannot restart itself'}</span
              >
            `}
        <code class="staleness__command">${build.restart_command}</code>
        <button
          type="button"
          class="staleness__copy"
          @click=${() => void onCopy()}
        >
          ${copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          class="staleness__dismiss"
          aria-label="Dismiss restart notice"
          @click=${() => dismiss('server')}
        >
          ×
        </button>
      </div>
      ${restart_phase === 'failed'
        ? html`<div class="staleness__error" role="alert">
            ${restart_error}
          </div>`
        : html``}
    `;
  }

  function template() {
    const build = buildState();
    if (!build.loaded) {
      return html``;
    }
    const show_client = build.client_stale && !dismissed.client;
    const show_server = build.server_stale && !dismissed.server;
    if (!show_client && !show_server) {
      return html``;
    }
    return html`
      <div class="staleness">
        ${show_client ? clientRow() : html``}
        ${show_server ? serverRow() : html``}
      </div>
    `;
  }

  function doRender() {
    render(template(), mount_element);
  }

  doRender();
  unsubscribe = store.subscribe(() => {
    // A fresh report is new information, so a dismissal of the *old* state should not
    // suppress it. Reset only the kind that has changed shape — otherwise a periodic
    // re-report of the same staleness would undo a dismissal every few seconds.
    doRender();
  });

  return {
    destroy() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      render(html``, mount_element);
    }
  };
}

/**
 * Reload in a way that actually fetches the new bundle.
 *
 * The server already does the load-bearing half: `index.html` is served `no-store` and
 * its script URL carries the current bundle id, so a re-fetched document points at a
 * *different* URL for a different build and cannot be satisfied from the old cache
 * entry. See `stampBundleUrl` in `server/app.js`.
 *
 * `location.reload()` is the right call on top of that, and `reload(true)` is not an
 * option — the boolean argument has been ignored by every current browser for years, so
 * code that passes it reads as a guarantee it does not provide.
 *
 * @returns {void}
 */
function reloadForNewBundle() {
  window.location.reload();
}
