import { html, render } from 'lit-html';
import { debug } from '../utils/logging.js';
import { currentSpaceOf } from './accounts-pages.js';

/**
 * feads addition — the sign-in / sign-up panel.
 *
 * ## Why it does not blank the board
 *
 * The board stays visible behind this panel, and that is the design rather than an
 * oversight. An unidentified visitor is `read_only`, not refused: the point of a
 * login prompt here is "you can look, sign in to act", and a wall would gate
 * *looking* on a ceremony while changing nothing about what the shell next to the
 * browser can do. The panel is therefore a card at the top of the page rather than a
 * modal, and the only case where it may block is the `deny` stance
 * (`FEADS_REQUIRE_AGENT=1`), where the server refuses reads too and there is
 * genuinely nothing behind it.
 *
 * ## Two doors, because there are two situations
 *
 * A first-time visitor has one of two problems, and one form cannot ask both:
 *
 * - **Sign in.** They already have the token their agent uses (or an invite). This
 *   is the flow that makes the dashboard show *the same thing the agent sees* —
 *   same identity, same tier, same `created_by` on everything it filed.
 * - **Sign up.** They have no agent yet. They name one, and get back a token to
 *   hand to it. Minting is open to anyone, so this is not an admin ceremony —
 *   though the admin tier is deliberately not on offer here, because a tier you can
 *   grant yourself is not a tier.
 *
 * ## The token is shown once, and the UI has to say so
 *
 * Only a SHA-256 hash of an agent token is stored, so the sign-up response is the
 * only moment the token can ever be displayed. If the reader closes the panel
 * without copying it, the agent it was minted for has no way to authenticate and the
 * only remedy is revoking it and signing up again. That makes "shown once" a
 * functional warning rather than security theatre, which is why it is stated
 * loudly and why the panel keeps the token on screen until it is explicitly
 * dismissed.
 *
 * ## What the human hands their agent is an MCP connection
 *
 * Not a shell incantation. The agent reaches feads over MCP and the MCP server
 * carries its own instructions, so what this panel produces is a connection —
 * endpoint plus `Authorization: Bearer <token>` — and no pasted context. Two forms
 * of the same thing are offered because agents are configured both ways: a JSON block
 * for a config file, and a single `claude mcp add` line for a terminal.
 *
 * The endpoint comes from the server (`server/mcp-endpoint.js`), which will decline
 * to guess. When it cannot determine one, the panel says so and names the variable to
 * set rather than printing a URL that would send the reader debugging their agent.
 *
 * ## After connecting
 *
 * Setup is documented in the README quickstart. No bundled marketplace plugin
 * or workflow skill is needed to use the standalone release.
 *
 * ## What this module holds, and for how long
 *
 * The persistent credential is an HttpOnly cookie that page JavaScript cannot read
 * — see `server/agent-cookie.js`. The one exception is the token this panel is
 * *showing you*, which necessarily lives in a variable while it is on screen: minted
 * by sign-up, or typed into the sign-in field by the reader. It is never written to
 * `localStorage` or `sessionStorage`, never sent anywhere but the login route it came
 * from, and dropped when the panel is dismissed. Everything else about identity comes
 * from `whoami`, which carries no token at all.
 *
 * Note the consequence for sign-in: the connection snippet there is composed in the
 * browser from the token the reader just typed. The server does not echo a pasted
 * token back, and does not need to.
 *
 * ## Why signing in reloads the page
 *
 * The cookie is read from the WebSocket *handshake*, which already happened. A
 * browser cannot attach a new cookie to an open socket, so the connection has to be
 * made again — and a reload is the honest way to do that, since every view's data
 * was fetched as the previous identity. Anything cleverer would leave parts of the
 * page speaking for someone who is no longer signed in.
 *
 * Nothing here decides what a caller may do. The server does, on every message; a
 * disabled button is a courtesy, not a control.
 */

/**
 * @typedef {import('../state.js').AppState} AppState
 */

/**
 * What the panel shows after a successful sign-in or sign-up.
 *
 * `minted` is the difference that matters to the reader: a token this dashboard has
 * just created is unrecoverable and must be copied now, while one they pasted is
 * already in their possession and needs no warning.
 *
 * @typedef {Object} Connection
 * @property {string} token - In memory only, for the life of the panel.
 * @property {boolean} minted - Whether sign-up created it just now.
 * @property {string} actor
 * @property {string} mcp_url - `''` when the server could not determine one.
 * @property {string} mcp_reason - Why that URL, or why there is none.
 */

/**
 * Whether the optional SSO block is present on a whoami identity. Presence is
 * server-provided; the client never infers silo mode from a hostname or storage.
 *
 * @param {{ sso?: unknown } | null | undefined} identity
 * @returns {boolean}
 */
function hasSsoBlock(identity) {
  return Boolean(
    identity &&
    Object.hasOwn(identity, 'sso') &&
    identity.sso !== null &&
    identity.sso !== undefined
  );
}

/**
 * Whether an SSO reply represents an unavailable/rejected SSO door. This is only
 * used for copy; authorization remains the server-provided mode/stance.
 *
 * @param {any} sso
 * @returns {boolean}
 */
function ssoIsUnavailable(sso) {
  if (!sso || typeof sso !== 'object') {
    return false;
  }
  if (sso.available === false || sso.rejected === true) {
    return true;
  }
  return ['unavailable', 'rejected', 'error', 'failed', 'denied'].includes(
    String(sso.status || '').toLowerCase()
  );
}

/**
 * Return the platform logout target for an SSO identity. The default is the
 * platform endpoint, not the Feads token-cookie endpoint: clearing a Feads
 * cookie cannot truthfully claim to log the browser out of hosted SSO.
 *
 * @param {any} sso
 * @returns {string}
 */
export function ssoLogoutTarget(sso) {
  for (const key of [
    'sign_out_url',
    'signout_url',
    'logout_url',
    'logout_target',
    'signout_target',
    'logout',
    'sign_out',
    'target'
  ]) {
    if (typeof sso?.[key] === 'string' && sso[key].trim()) {
      return sso[key];
    }
  }
  return '/oauth2/sign_out';
}

/**
 * Whether this session may change anything.
 *
 * Exported because the header's New-issue button, the detail view and this panel
 * must agree — and because the alternative, each of them testing `mode` for itself,
 * is how one of them ends up offering a button that fails on click.
 *
 * `loaded` is required: before `whoami` answers, nothing is known, and offering
 * write affordances that are then taken away reads as a bug. Erring towards
 * "cannot" for the duration of one round trip is the cheaper mistake.
 *
 * The mode is the compatibility fallback. When a server supplies permissions,
 * an explicit write/mutate flag is authoritative; the client never grants a
 * write because it recognizes an SSO provider or guesses from an actor name.
 *
 * @param {{ identity?: { loaded?: boolean, mode?: string, permissions?: Record<string, boolean> | string[] | null } }} state
 * @returns {boolean}
 */
export function canMutate(state) {
  const identity = state?.identity;
  if (!identity?.loaded) {
    return false;
  }
  if (identity.mode !== 'agent' && identity.mode !== 'operator') {
    return false;
  }
  if (Array.isArray(identity.permissions)) {
    return (
      identity.permissions.includes('write') ||
      identity.permissions.includes('mutate')
    );
  }
  if (identity.permissions && typeof identity.permissions === 'object') {
    if (typeof identity.permissions.write === 'boolean') {
      return identity.permissions.write;
    }
    if (typeof identity.permissions.mutate === 'boolean') {
      return identity.permissions.mutate;
    }
    if (typeof identity.permissions.can_write === 'boolean') {
      return identity.permissions.can_write;
    }
  }
  return identity.mode === 'agent' || identity.mode === 'operator';
}

/**
 * Whether a write affordance should still be offered.
 *
 * Deliberately *not* the same question as `canMutate`, and the difference is the
 * unanswered case. `canMutate` says "do we know this session may write", and answers
 * no before `whoami` lands. Taking a button *away* on that basis is a worse mistake
 * than leaving it: a `whoami` that never answers — a transport hiccup, a build with no
 * identity support — would permanently disable the New-issue button and make the
 * dashboard look broken, whereas leaving it offered costs at most one refusal from the
 * server, which is where the real check lives anyway.
 *
 * So: hide the affordance only once the server has actually said this session cannot
 * write.
 *
 * @param {{ identity?: { loaded?: boolean, mode?: string, permissions?: Record<string, boolean> | string[] | null } }} state
 * @returns {boolean}
 */
export function isWriteAffordanceOffered(state) {
  if (!state?.identity?.loaded) {
    return true;
  }
  return canMutate(state);
}

/**
 * Whether the panel should be shown at all.
 *
 * Not shown in operator mode. That is the "no registry on this machine" case, where
 * there is nothing to sign in to and no token anyone could paste — offering a login
 * box there would be a form that cannot succeed.
 *
 * @param {{ identity?: { loaded?: boolean, mode?: string } }} state
 * @returns {boolean}
 */
export function isLoginPanelVisible(state) {
  const identity = state?.identity;
  if (!identity?.loaded) {
    return false;
  }
  return identity.mode === 'anonymous' || identity.mode === 'rejected';
}

/**
 * The connection to hand an agent, in one of two shapes.
 *
 * Exported so it can be asserted directly. Both shapes say the same thing — this
 * endpoint, with this bearer token — and both are offered because agents get
 * configured both ways: a JSON block goes into an MCP config file, and the one-liner
 * is what someone with a terminal open will actually run.
 *
 * The token appears in the output, necessarily: it *is* the credential the agent will
 * present. That is the whole purpose of the snippet, and it is the reason this string
 * is built in the browser and copied to the clipboard rather than stored anywhere.
 *
 * @param {{ token: string, mcp_url: string }} connection
 * @param {'json'|'cli'} form
 * @returns {string}
 */
export function snippetFor(connection, form) {
  const url = String(connection.mcp_url || '');
  const token = String(connection.token || '');
  if (form === 'cli') {
    // --scope user makes the registration machine-global. The default (local)
    // scope registers feads only for the directory the command runs in, which
    // presents as fully working there and silently absent everywhere else —
    // the exact failure of the first external onboarding (feads-2xb). Must
    // stay in sync with docs/workflow/setup.md step 3.
    return [
      'claude mcp add --transport http --scope user feads',
      url,
      `--header "Authorization: Bearer ${token}"`
    ].join(' ');
  }
  // Two spaces, four levels: this is meant to be pasted into a config file next to
  // whatever else is in it, so it is formatted the way such a file already looks.
  return JSON.stringify(
    {
      mcpServers: {
        feads: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    },
    null,
    2
  );
}

/** Public setup pointer; retained for callers of the old snippet helper. */
export function pluginInstallSnippet() {
  return 'https://github.com/exowatt-oss/feads#quickstart';
}

/**
 * Read an error message out of a fetch response body.
 *
 * @param {any} body
 * @param {string} fallback
 * @returns {string}
 */
function errorMessage(body, fallback) {
  const message = body?.error?.message;
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

/**
 * Which SSO refusal this is, for copy and the recovery offered. The codes are
 * the server's (`resolveEmailIdentity`, the roster gate); anything unknown is
 * the generic "could not authenticate".
 *
 * - `roster`: Google signed the person in, Feads does not admit that account.
 * - `missing`: no SSO session reached Feads at all.
 * - `other`: the provider refused or could not be reached, or a token got in
 *   the way.
 *
 * @param {any} sso
 * @returns {'roster'|'missing'|'other'}
 */
export function ssoDenialKind(sso) {
  const code = String(sso?.error_code || '');
  if (['not_on_roster', 'roster_inactive', 'user_disabled'].includes(code)) {
    return 'roster';
  }
  if (code === 'sso_required') {
    return 'missing';
  }
  return 'other';
}

/**
 * @param {string} code
 * @returns {string}
 */
function rosterDenialText(code) {
  switch (code) {
    case 'roster_inactive':
      return 'Hosted account sign-in is unavailable in this release; use per-agent tokens.';
    case 'user_disabled':
      return 'Feads access for this Google account has been turned off. If that is a mistake, ask a Feads superadmin.';
    case 'sso_required':
      return 'Hosted account sign-in is unavailable in this release; use per-agent tokens.';
    default:
      return 'Hosted account sign-in is unavailable in this release; use per-agent tokens.';
  }
}

/**
 * The panel's heading: the answer first, so a refused visitor does not read
 * an invitation to "link an agent" as the explanation.
 *
 * @param {AppState} s
 * @returns {string}
 */
function panelTitle(s) {
  if (
    hasSsoBlock(s.identity) &&
    (s.identity.mode === 'rejected' || ssoIsUnavailable(s.identity.sso))
  ) {
    const kind = ssoDenialKind(s.identity.sso);
    return kind === 'roster'
      ? 'No access to Feads'
      : kind === 'missing'
        ? 'Sign in to Feads'
        : 'Could not sign you in';
  }
  return 'Link this browser to an agent';
}

/**
 * Create the sign-in / sign-up panel (feads).
 *
 * @param {HTMLElement} mount_element
 * @param {{ getState: () => AppState, subscribe: (fn: (s: AppState) => void) => () => void }} store
 * @param {Object} [options]
 * @param {typeof fetch} [options.fetch] - Test seam.
 * @param {() => void} [options.onSignedIn] - What to do once a credential is
 * stored. Defaults to reloading; injected so a test does not have to.
 * @param {() => void|Promise<void>} [options.onRetrySso] - Retry the silo SSO
 * preflight after an actionable failure.
 * @param {(target: string) => void} [options.navigate] - Test seam for platform
 * SSO logout navigation.
 * @param {(text: string) => Promise<void>} [options.copy] - Test seam for the
 * clipboard, which jsdom does not implement.
 * @returns {{ destroy: () => void }}
 */
export function createAgentLoginPanel(mount_element, store, options = {}) {
  const log = debug('views:agent-login');
  const doFetch = options.fetch || ((...args) => window.fetch(...args));
  const onSignedIn = options.onSignedIn || (() => window.location.reload());
  const onRetrySso = options.onRetrySso || (() => window.location.reload());
  const copyText =
    options.copy || ((text) => window.navigator.clipboard.writeText(text));
  const navigate =
    options.navigate || ((target) => window.location.assign(target));

  /** @type {'choose'|'signin'|'signup'} */
  let step = 'choose';
  /** @type {'idle'|'busy'|'done'} */
  let phase = 'idle';
  /** @type {'idle'|'busy'} */
  let sso_action_phase = 'idle';
  let sso_action_error = '';
  let error = '';
  let copied = false;
  /** Tracked apart from `copied`: two blocks, two buttons, two answers. */
  let copied_plugins = false;
  /** @type {Connection | null} */
  let connection = null;
  /** @type {'json'|'cli'} */
  let snippet_form = 'json';
  /** Collapsed by the reader; the identity chip in the header still shows who they are. */
  let dismissed = false;

  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /**
   * @param {'choose'|'signin'|'signup'} next
   */
  function goto(next) {
    step = next;
    error = '';
    phase = 'idle';
    doRender();
    // Focus the field the reader is now expected to type in. Done after the render
    // so the element exists, and only for a real field so it cannot steal focus back
    // to a panel someone has just left.
    const field = /** @type {HTMLElement | null} */ (
      mount_element.querySelector('[data-autofocus]')
    );
    field?.focus();
  }

  /**
   * @param {string} url
   * @param {Record<string, unknown>} body
   * @returns {Promise<any | null>} The response body, or null when it failed (with
   * `error` already set for the render).
   */
  async function submit(url, body) {
    phase = 'busy';
    error = '';
    doRender();
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `same-origin` is the default, but stated because it is what carries the
        // HttpOnly cookie the server is about to set — and what carries an existing
        // one on sign-up, so the policy check sees this browser's identity.
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        error = errorMessage(json, `Request failed (${res.status})`);
        phase = 'idle';
        doRender();
        return null;
      }
      return json;
    } catch (err) {
      // A transport failure, not a refusal. Said differently so the reader does not
      // go hunting for a bad token.
      log('request failed: %o', err);
      error = 'Could not reach the dashboard server. Is it still running?';
      phase = 'idle';
      doRender();
      return null;
    }
  }

  /**
   * @param {Event} ev
   */
  async function onSignIn(ev) {
    ev.preventDefault();
    const form = /** @type {HTMLFormElement} */ (ev.currentTarget);
    const input = /** @type {HTMLInputElement} */ (
      form.elements.namedItem('token')
    );
    const token = String(input?.value || '').trim();
    if (token.length === 0) {
      error = 'Paste the token your agent uses.';
      doRender();
      return;
    }
    const json = await submit('/api/agent/login', { token });
    if (!json) {
      return;
    }
    // Cleared from the DOM immediately. The value carries on in `connection` for as
    // long as the snippet is on screen, but a token sitting in an input's `value`
    // survives things a variable does not — a browser's form restore, an extension
    // reading the field, a screenshot of a focused password box.
    input.value = '';
    connection = {
      token,
      // Not minted here: an invite the server redeemed produced a token the reader
      // has never seen, so it is treated as minted and warned about accordingly.
      minted: json.redeemed === true,
      actor: String(json.identity?.actor || ''),
      mcp_url: String(json.mcp_url || ''),
      mcp_reason: String(json.mcp_reason || '')
    };
    if (json.redeemed === true) {
      // The invite is spent and the agent token was never shown anywhere else, so
      // the panel must display the one the server minted, not the invite pasted.
      connection.token = String(json.token || '');
    }
    phase = 'done';
    copied = false;
    copied_plugins = false;
    log('signed in as %s', connection.actor);
    doRender();
  }

  /**
   * @param {Event} ev
   */
  async function onSignUp(ev) {
    ev.preventDefault();
    const form = /** @type {HTMLFormElement} */ (ev.currentTarget);
    const name = String(
      /** @type {HTMLInputElement} */ (form.elements.namedItem('display_name'))
        ?.value || ''
    ).trim();
    const actor = String(
      /** @type {HTMLInputElement} */ (form.elements.namedItem('actor'))
        ?.value || ''
    ).trim();
    if (name.length === 0) {
      error = 'Give the agent a name.';
      doRender();
      return;
    }
    // feads: the board this tab is looking at. Board selection lives on the
    // WebSocket now (two tabs can be on two boards), and an HTTP POST has no socket
    // to be asked, so the tab has to say. Without it the server falls back to the
    // board the daemon started on and the new agent would be registered somewhere
    // other than where its owner is looking — a sign-up that appears to succeed and
    // leaves the agent off the roster on screen.
    const board_dir = String(
      store.getState().workspace?.current?.board_dir || ''
    );
    const json = await submit('/api/agent/signup', {
      display_name: name,
      actor,
      board_dir
    });
    if (!json) {
      return;
    }
    // Deliberately does *not* reload here. The token is on screen and unrecoverable,
    // so the reader gets to copy it first and reload on their own say-so.
    connection = {
      token: String(json.token || ''),
      minted: true,
      actor: String(json.identity?.actor || name),
      mcp_url: String(json.mcp_url || ''),
      mcp_reason: String(json.mcp_reason || '')
    };
    phase = 'done';
    copied = false;
    copied_plugins = false;
    log('signed up as %s', connection.actor);
    doRender();
  }

  /**
   * Both copy buttons go through here, so a clipboard that is unavailable — as it is
   * over plain HTTP in some browsers — says the same thing whichever block was asked
   * for, and both blocks stay selectable by hand.
   *
   * @param {string} text
   * @returns {Promise<boolean>} Whether it landed.
   */
  async function copyToClipboard(text) {
    try {
      await copyText(text);
      return true;
    } catch (err) {
      log('clipboard write failed: %o', err);
      error =
        'Could not reach the clipboard — select the block you need and copy it by hand.';
      return false;
    }
  }

  async function onCopy() {
    if (!connection) {
      return;
    }
    copied = await copyToClipboard(snippetFor(connection, snippet_form));
    doRender();
  }

  function onDoneWithToken() {
    // The token leaves memory here, not merely the screen — and the re-render before
    // the reload is deliberate. If the reload is slow, blocked, or stubbed out, the
    // token must already be off screen; leaving it there and trusting the navigation
    // to take it away would leave a credential visible for as long as that took.
    connection = null;
    dismissed = false;
    doRender();
    onSignedIn();
  }

  /**
   * @param {'json'|'cli'} form
   */
  function onSnippetForm(form) {
    return () => {
      snippet_form = form;
      copied = false;
      doRender();
    };
  }

  function onDismiss() {
    dismissed = true;
    doRender();
  }

  function chooseTemplate() {
    if (hasSsoBlock(store.getState().identity)) {
      // An SSO-fronted dashboard (a silo, or the base instance in accounts
      // mode) has no open sign-up: identities come from SSO, and agent tokens
      // from Access → Connect an agent once signed in. Both are the way in for
      // someone else, so they sit below the SSO answer as quiet notes rather
      // than as two cards competing with it.
      return html`
        <div class="agent-login__choices agent-login__choices--quiet">
          <section class="agent-login__choice">
            <h3 class="agent-login__choice-title">I already have an agent</h3>
            <p class="agent-login__choice-body">
              Paste its token and this browser sees exactly what the agent sees.
            </p>
            <button
              type="button"
              class="agent-login__link"
              @click=${() => goto('signin')}
            >
              Sign in with a token
            </button>
          </section>
          <section class="agent-login__choice agent-login__choice--sso">
            <h3 class="agent-login__choice-title">Connect an agent</h3>
            <p class="agent-login__choice-body">
              Hosted SSO is not included in this build. Use an agent token as described in the README quickstart.
            </p>
          </section>
        </div>
      `;
    }
    return html`
      <div class="agent-login__choices">
        <section class="agent-login__choice">
          <h3 class="agent-login__choice-title">I already have an agent</h3>
          <p class="agent-login__choice-body">
            Paste the token your agent uses and this browser sees exactly what
            it sees — the same board, the same identity, the same permissions.
          </p>
          <button
            type="button"
            class="agent-login__primary"
            @click=${() => goto('signin')}
          >
            Sign in with a token
          </button>
        </section>
        <section class="agent-login__choice">
          <h3 class="agent-login__choice-title">Set up a new agent</h3>
          <p class="agent-login__choice-body">
            Name an agent and we will mint its token, then give you the two
            lines to paste into it. Anyone can do this; no invite needed.
          </p>
          <button
            type="button"
            class="agent-login__secondary"
            @click=${() => goto('signup')}
          >
            Create an agent
          </button>
        </section>
      </div>
    `;
  }

  function signInTemplate() {
    const busy = phase === 'busy';
    return html`
      <form class="agent-login__form" @submit=${onSignIn}>
        <label class="agent-login__label" for="agent-login-token">
          Agent token
        </label>
        <input
          id="agent-login-token"
          name="token"
          type="password"
          class="agent-login__input"
          autocomplete="off"
          spellcheck="false"
          placeholder="fdsa_…"
          data-autofocus
          ?disabled=${busy}
        />
        <p class="agent-login__hint">
          The <code>fdsa_…</code> token your agent presents to feads — it is in
          the agent's own MCP configuration, as
          <code>Authorization: Bearer …</code>.${hasSsoBlock(
            store.getState().identity
          )
            ? ''
            : html` An invite (<code>fdsi_…</code>) works here too and will be
              redeemed.`}
        </p>
        ${errorTemplate()}
        <div class="agent-login__actions">
          <button type="submit" class="agent-login__primary" ?disabled=${busy}>
            ${busy ? 'Checking…' : 'Sign in'}
          </button>
          <button
            type="button"
            class="agent-login__link"
            ?disabled=${busy}
            @click=${() => goto('choose')}
          >
            Back
          </button>
        </div>
      </form>
    `;
  }

  function signUpTemplate() {
    const busy = phase === 'busy';
    return html`
      <form class="agent-login__form" @submit=${onSignUp}>
        <label class="agent-login__label" for="agent-login-name">
          What should we call this agent?
        </label>
        <input
          id="agent-login-name"
          name="display_name"
          type="text"
          class="agent-login__input"
          autocomplete="off"
          placeholder="alex's laptop Claude"
          data-autofocus
          ?disabled=${busy}
        />
        <label class="agent-login__label" for="agent-login-actor">
          Short name <span class="agent-login__optional">(optional)</span>
        </label>
        <input
          id="agent-login-actor"
          name="actor"
          type="text"
          class="agent-login__input"
          autocomplete="off"
          spellcheck="false"
          placeholder="alex-laptop"
          ?disabled=${busy}
        />
        <p class="agent-login__hint">
          The short name is what appears on every bead this agent files. Left
          blank, it is derived from the name above.
        </p>
        ${errorTemplate()}
        <div class="agent-login__actions">
          <button type="submit" class="agent-login__primary" ?disabled=${busy}>
            ${busy ? 'Creating…' : 'Create agent'}
          </button>
          <button
            type="button"
            class="agent-login__link"
            ?disabled=${busy}
            @click=${() => goto('choose')}
          >
            Back
          </button>
        </div>
      </form>
    `;
  }

  function pluginsStepTemplate() {
    return html`<p class="agent-login__hint">
      3. Follow the <a href="https://github.com/exowatt-oss/feads#quickstart"
      target="_blank" rel="noreferrer">README quickstart</a> for local setup.
      No marketplace plugin is required.
    </p>`;
  }

  function connectionTemplate() {
    const result = /** @type {Connection} */ (connection);
    const snippet = snippetFor(result, snippet_form);
    return html`
      <div class="agent-login__created">
        <p class="agent-login__created-lede">
          You are signed in as <strong>${result.actor}</strong>. This browser
          now sees what that agent sees.
        </p>
        ${result.minted
          ? html`<p class="agent-login__warning">
              Copy this now — it is the only time the token is shown. Only a
              hash is stored, so it cannot be recovered later.
            </p>`
          : ''}
        <p class="agent-login__step-done">
          <span class="agent-login__step-check" aria-hidden="true">✓</span>
          1. Register this agent — done, that is what just happened.
        </p>
        ${result.mcp_url
          ? html`
              <div class="agent-login__snippet-head">
                <span class="agent-login__label">2. Connect your agent</span>
                <span class="agent-login__toggle" role="group">
                  <button
                    type="button"
                    class="agent-login__toggle-btn ${snippet_form === 'json'
                      ? 'is-active'
                      : ''}"
                    aria-pressed=${snippet_form === 'json'}
                    @click=${onSnippetForm('json')}
                  >
                    Config
                  </button>
                  <button
                    type="button"
                    class="agent-login__toggle-btn ${snippet_form === 'cli'
                      ? 'is-active'
                      : ''}"
                    aria-pressed=${snippet_form === 'cli'}
                    @click=${onSnippetForm('cli')}
                  >
                    One line
                  </button>
                </span>
              </div>
              <pre class="agent-login__snippet">${snippet}</pre>
              <p class="agent-login__hint">
                That is all the agent needs to reach the board — the MCP server
                carries its own instructions, so there is no context to paste
                alongside it.
                <span class="agent-login__muted">${result.mcp_reason}</span>
              </p>
            `
          : html`
              <p class="agent-login__warning">
                ${result.mcp_reason ||
                'The MCP endpoint for this dashboard could not be determined.'}
              </p>
              <span class="agent-login__label">
                2. Connect your agent — the agent’s token
              </span>
              <pre class="agent-login__snippet">${result.token}</pre>
              <p class="agent-login__hint">
                Point the agent at this board’s MCP server with
                <code>Authorization: Bearer</code> and the token above.
              </p>
            `}
        ${pluginsStepTemplate()} ${errorTemplate()}
        <div class="agent-login__actions">
          <button
            type="button"
            class="agent-login__primary"
            @click=${() => void onCopy()}
          >
            ${copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            class="agent-login__link"
            @click=${onDoneWithToken}
          >
            ${result.minted ? 'I have saved it' : 'Done'}
          </button>
        </div>
      </div>
    `;
  }

  function errorTemplate() {
    if (!error) {
      return html``;
    }
    return html`<p class="agent-login__error" role="alert">${error}</p>`;
  }

  /**
   * Clear the Feads token only when the reader explicitly chooses that recovery.
   * This is deliberately not the identity chip's SSO sign-out path: the latter
   * belongs to oauth2-proxy and must not be presented as a token repair.
   *
   * @param {boolean} clear_token
   */
  async function recoverSso(clear_token) {
    if (sso_action_phase === 'busy') {
      return;
    }
    sso_action_phase = 'busy';
    sso_action_error = '';
    doRender();
    try {
      if (clear_token) {
        const response = await doFetch('/api/agent/logout', {
          method: 'POST',
          credentials: 'same-origin'
        });
        if (response && response.ok === false) {
          throw new Error('logout failed');
        }
      }
      await onRetrySso();
      sso_action_phase = 'idle';
      doRender();
    } catch (err) {
      log('SSO recovery failed: %o', err);
      sso_action_phase = 'idle';
      sso_action_error = clear_token
        ? 'The Feads token could not be cleared. Try again.'
        : 'The sign-in could not be retried. Try again.';
      doRender();
    }
  }

  /**
   * The action for a terminal SSO result. It is intentionally rendered inside
   * the identity explanation rather than as a generic toast, so keyboard and
   * screen-reader users get the same recovery control.
   *
   * @param {AppState} s
   */
  function ssoActionTemplate(s) {
    if (!hasSsoBlock(s.identity)) {
      return html``;
    }
    const sso = s.identity.sso;
    const clear_token = sso?.action === 'clear_token';
    if (
      s.identity.mode !== 'rejected' &&
      !ssoIsUnavailable(sso) &&
      sso?.terminal !== true
    ) {
      return html``;
    }
    const kind = ssoDenialKind(sso);
    const busy = sso_action_phase === 'busy';
    // A roster refusal is about *which* Google account this is, so the way
    // forward is a different one; retrying the same account changes nothing
    // until someone adds it, so that is the quieter second choice.
    const primary =
      kind === 'roster'
        ? html`<button
            type="button"
            class="agent-login__sso-action"
            @click=${() => navigate(ssoLogoutTarget(sso))}
          >
            Use a different Google account
          </button>`
        : html`<button
            type="button"
            class="agent-login__sso-action"
            ?disabled=${busy}
            @click=${() => void recoverSso(clear_token)}
          >
            ${busy
              ? clear_token
                ? 'Clearing Feads token…'
                : 'Retrying…'
              : clear_token
                ? 'Clear Feads token and retry SSO'
                : kind === 'missing'
                  ? 'Sign in with Google'
                  : 'Retry SSO sign-in'}
          </button>`;
    return html`
      <div class="agent-login__sso-actions">
        ${primary}
        ${kind === 'roster'
          ? html`<button
              type="button"
              class="agent-login__sso-retry"
              ?disabled=${busy}
              @click=${() => void recoverSso(false)}
            >
              ${busy ? 'Checking…' : 'Check again'}
            </button>`
          : ''}
        ${sso_action_error
          ? html`<p class="agent-login__error" role="alert">
              ${sso_action_error}
            </p>`
          : ''}
      </div>
    `;
  }

  /**
   * The lede, which is the whole explanation of why the page looks read-only.
   *
   * @param {AppState} s
   */
  function ledeTemplate(s) {
    // A silo's SSO door is a separate credential boundary. Do not describe an
    // SSO rejection as a stale Feads token: that would send a human looking for
    // a token problem when the platform identity was unavailable or refused.
    if (
      hasSsoBlock(s.identity) &&
      (s.identity.mode === 'rejected' || ssoIsUnavailable(s.identity.sso))
    ) {
      const clear_token = s.identity.sso?.action === 'clear_token';
      const kind = ssoDenialKind(s.identity.sso);
      if (kind === 'roster' || kind === 'missing') {
        // Not signed in yet is a step, not a fault: no red rule for it.
        return html`
          <p
            class="agent-login__lede ${kind === 'roster'
              ? 'agent-login__lede--rejected'
              : ''}"
          >
            ${rosterDenialText(String(s.identity.sso?.error_code || ''))}
          </p>
          ${ssoActionTemplate(s)}
        `;
      }
      return html`
        <p class="agent-login__lede agent-login__lede--rejected">
          Hosted SSO could not authenticate this browser, so access is denied.
          ${clear_token
            ? 'A stale Feads token may be taking precedence over SSO.'
            : 'Try signing in again, or use a Feads token if you have one.'}
        </p>
        ${ssoActionTemplate(s)}
      `;
    }
    if (s.identity.mode === 'rejected') {
      return html`
        <p class="agent-login__lede agent-login__lede--rejected">
          The token this browser presented was not accepted — the agent may have
          been revoked, or the token may be stale. Sign in again, or set up a
          new agent.
        </p>
      `;
    }
    if (s.identity.require_identity) {
      return html`
        <p class="agent-login__lede">
          This dashboard requires an agent identity (<code
            >FEADS_REQUIRE_AGENT</code
          >
          is set), so nothing is readable until you sign in.
        </p>
      `;
    }
    return html`
      <p class="agent-login__lede">
        You are viewing this board read-only. Sign in as an agent to file, edit
        and close issues.
      </p>
    `;
  }

  function bodyTemplate() {
    if (connection) {
      return connectionTemplate();
    }
    if (step === 'signin') {
      return signInTemplate();
    }
    if (step === 'signup') {
      return signUpTemplate();
    }
    return chooseTemplate();
  }

  function template() {
    const s = store.getState();
    if (!isLoginPanelVisible(s)) {
      return html``;
    }
    // The `deny` stance is the only one that may block: the server refuses reads
    // too, so there is nothing behind the panel to preserve.
    const blocking = s.identity.require_identity === true;
    if (dismissed && !blocking && !connection) {
      return html`
        <div class="agent-login agent-login--collapsed">
          <span class="agent-login__collapsed-text">Viewing read-only.</span>
          <button
            type="button"
            class="agent-login__link"
            @click=${() => {
              dismissed = false;
              doRender();
            }}
          >
            Sign in
          </button>
        </div>
      `;
    }
    return html`
      <div
        class="agent-login ${blocking ? 'agent-login--blocking' : ''}"
        role="region"
        aria-label="Agent sign-in"
      >
        <header class="agent-login__header">
          <h2 class="agent-login__title">
            ${connection ? 'Your agent is ready' : panelTitle(s)}
          </h2>
          ${blocking || connection
            ? ''
            : html`<button
                type="button"
                class="agent-login__dismiss"
                title="Keep browsing read-only"
                aria-label="Dismiss"
                @click=${onDismiss}
              >
                ✕
              </button>`}
        </header>
        ${connection ? '' : ledeTemplate(s)} ${bodyTemplate()}
      </div>
    `;
  }

  function doRender() {
    render(template(), mount_element);
  }

  doRender();
  // The panel depends on the identity in the store, which arrives after the first
  // render — `whoami` is a round trip.
  unsubscribe = store.subscribe(() => doRender());

  return {
    destroy() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      connection = null;
      render(html``, mount_element);
    }
  };
}

/**
 * The role the header chip shows (feads).
 *
 * Accounts mode names the person's standing, never the legacy agent tier behind
 * their principal row (which reads `admin` for every superadmin and `user` for
 * everyone else): `superadmin`, else their role in the space on screen
 * (`space admin` / `member`), `agent` for an unclaimed legacy agent, and nothing
 * while the space is not known yet. Outside accounts mode the tier is the role.
 *
 * @param {any} state
 * @returns {string}
 */
export function identityRoleLabel(state) {
  const identity = state?.identity || {};
  const accounts =
    identity.accounts && typeof identity.accounts === 'object'
      ? identity.accounts
      : null;
  if (!accounts || !accounts.kind) {
    return String(identity.agent?.role || '');
  }
  if (accounts.kind === 'legacy_agent') return 'agent';
  if (accounts.kind === 'service')
    return accounts.read_only === true ? 'service (read-only)' : 'service';
  if (accounts.kind === 'system') return 'read-only key';
  if (accounts.superadmin === true) return 'superadmin';
  const space = currentSpaceOf(state);
  const role =
    space && accounts.memberships && typeof accounts.memberships === 'object'
      ? String(accounts.memberships[space] || '')
      : '';
  if (role === 'admin') return 'space admin';
  if (role === 'member') return 'member';
  return '';
}

/**
 * Create the header chip that says who this browser is acting as (feads).
 *
 * Separate from the panel because it lives in the header and outlives it: once you
 * are signed in there is no panel, and "who am I, and how do I stop being them" is
 * exactly what a reader needs then. In operator mode it says so rather than staying
 * blank — an unlabelled dashboard that can delete anything is the state most worth
 * naming.
 *
 * @param {HTMLElement} mount_element
 * @param {{ getState: () => AppState, subscribe: (fn: (s: AppState) => void) => () => void }} store
 * @param {Object} [options]
 * @param {typeof fetch} [options.fetch] - Test seam.
 * @param {() => void} [options.onSignedOut] - Defaults to reloading, for the same
 * reason signing in does: the socket's credential was fixed at its handshake.
 * @param {(target: string) => void} [options.onSsoSignedOut] - Close the app's
 * transport and navigate through the platform SSO sign-out route.
 * @param {(target: string) => void} [options.navigate] - Test seam for platform
 * SSO logout navigation.
 * @returns {{ destroy: () => void }}
 */
export function createIdentityChip(mount_element, store, options = {}) {
  const log = debug('views:agent-chip');
  const doFetch = options.fetch || ((...args) => window.fetch(...args));
  const onSignedOut = options.onSignedOut || (() => window.location.reload());
  const navigate =
    options.navigate || ((target) => window.location.assign(target));
  const onSsoSignedOut = options.onSsoSignedOut || navigate;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  let busy = false;

  async function onSignOut() {
    const identity = store.getState().identity;
    if (identity.mode === 'agent' && identity.agent && hasSsoBlock(identity)) {
      // A Feads cookie logout does not log the browser out of Google. Follow the
      // platform's target instead; the server may provide a silo-specific target,
      // while the standard oauth2-proxy path is the safe default.
      busy = true;
      doRender();
      onSsoSignedOut(ssoLogoutTarget(identity.sso));
      return;
    }

    // Preserve the token identity path exactly: this clears only the Feads
    // HttpOnly cookie and then reloads so the WebSocket presents no credential.
    busy = true;
    doRender();
    try {
      await doFetch('/api/agent/logout', {
        method: 'POST',
        credentials: 'same-origin'
      });
    } catch (err) {
      // Logging out is clearing a cookie; if the request never landed the cookie is
      // still there, and reloading will show that honestly rather than pretending.
      log('logout request failed: %o', err);
    }
    busy = false;
    onSignedOut();
  }

  function template() {
    const s = store.getState();
    const identity = s.identity;
    if (!identity.loaded) {
      return html``;
    }
    if (identity.mode === 'agent' && identity.agent) {
      const role = identityRoleLabel(s);
      if (hasSsoBlock(identity)) {
        const email =
          typeof identity.sso?.email === 'string' ? identity.sso.email : '';
        const provenance = email
          ? `Signed in with hosted SSO · ${email}`
          : 'Signed in with hosted SSO';
        const accessible_name = [identity.agent.actor, role, provenance]
          .filter(Boolean)
          .join(', ');
        return html`
          <div
            class="identity-chip identity-chip--sso"
            role="group"
            title=${accessible_name}
            aria-label=${accessible_name}
          >
            <span class="identity-chip__actor">${identity.agent.actor}</span>
            ${role
              ? html`<span class="identity-chip__role">${role}</span>`
              : ''}
            <span
              class="identity-chip__provenance identity-chip__sso"
              title=${provenance}
              aria-label=${provenance}
            >
              <span>Signed in with hosted SSO</span>
              ${email
                ? html`<span aria-hidden="true">·</span
                    ><span class="identity-chip__email identity-chip__sso-email"
                      >${email}</span
                    >`
                : ''}
            </span>
            <button
              type="button"
              class="identity-chip__signout"
              title="Sign out of hosted SSO"
              aria-label="Sign out of hosted SSO"
              ?disabled=${busy}
              @click=${() => void onSignOut()}
            >
              ${busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        `;
      }
      return html`
        <div
          class="identity-chip"
          title=${role
            ? `Signed in as ${identity.agent.actor} (${role})`
            : `Signed in as ${identity.agent.actor}`}
        >
          <span class="identity-chip__actor">${identity.agent.actor}</span>
          ${role ? html`<span class="identity-chip__role">${role}</span>` : ''}
          <button
            type="button"
            class="identity-chip__signout"
            title=${`Sign out ${identity.agent.actor}`}
            ?disabled=${busy}
            @click=${() => void onSignOut()}
          >
            ${busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      `;
    }
    if (identity.mode === 'operator') {
      return html`
        <div
          class="identity-chip identity-chip--operator"
          title="No agent registry on this machine, so this dashboard is unrestricted"
        >
          <span class="identity-chip__actor">operator</span>
        </div>
      `;
    }
    return html`
      <div class="identity-chip identity-chip--anonymous">
        <span class="identity-chip__actor">read-only</span>
      </div>
    `;
  }

  function doRender() {
    render(template(), mount_element);
  }

  doRender();
  unsubscribe = store.subscribe(() => doRender());

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
