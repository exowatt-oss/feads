import { describe, expect, test, vi } from 'vitest';
import {
  canMutate,
  createAgentLoginPanel,
  createIdentityChip,
  identityRoleLabel,
  isLoginPanelVisible,
  isWriteAffordanceOffered,
  pluginInstallSnippet,
  snippetFor,
  ssoDenialKind
} from './agent-login.js';

/**
 * The sign-in / sign-up panel.
 *
 * Three things this suite is actually for, beyond the obvious rendering:
 *
 * 1. that a token never leaves this module by any route except the clipboard and the
 *    login request — not into `localStorage`, not into a DOM value that outlives the
 *    screen;
 * 2. that the board is *not* blanked in the ordinary read-only case, since that is
 *    the whole premise of a read-only stance rather than a refusal;
 * 3. that a minted token is announced as unrecoverable, because it is;
 * 4. that the success state hands over the whole 1-2-3 — a connected agent that never
 *    heard of the workflow skills is the failure this panel exists to prevent.
 */

/**
 * A minimal store, carrying only what these views read.
 *
 * Returned as `any` because `AppState` also has `filters`, `board` and `workspace`,
 * none of which the panel or the chip touch — the same shortcut agents-admin.test.js
 * takes, done once here rather than at every call site.
 *
 * @param {Record<string, any>} [identity]
 * @returns {any}
 */
function makeStore(identity = {}) {
  const state = {
    view: 'issues',
    selected_id: null,
    identity: {
      loaded: true,
      agent: null,
      mode: 'anonymous',
      stance: 'read_only',
      require_identity: false,
      ...identity
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
    patchIdentity(patch) {
      state.identity = { ...state.identity, ...patch };
      for (const fn of listeners) {
        fn(state);
      }
    }
  };
}

/**
 * A `fetch` stub that records what it was asked and answers with one body.
 *
 * @param {Record<string, any>} body
 * @param {{ status?: number, ok?: boolean }} [options]
 */
function stubFetch(body, options = {}) {
  const calls =
    /** @type {Array<{ url: string, body: any, init: any }>} */ ([]);
  /** @type {any} */
  const fn = vi.fn(async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      init
    });
    return {
      ok: options.ok !== false,
      status: options.status || 200,
      async json() {
        return body;
      }
    };
  });
  fn.calls = calls;
  return fn;
}

/**
 * @returns {HTMLElement}
 */
function mount() {
  document.body.innerHTML = '<div id="panel"></div>';
  return /** @type {HTMLElement} */ (document.getElementById('panel'));
}

/**
 * Let a submit handler's promise chain settle.
 */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/**
 * A panel that has just signed up, which is the only state the handover is in.
 *
 * Worth a helper because every assertion about the success state has to get through the
 * same three interactions first, and repeating them buries what each test is about.
 *
 * @param {Record<string, any>} [body] - Overrides for the sign-up response.
 * @param {Record<string, any>} [options] - Extra panel options (`copy`, `onSignedIn`).
 * @returns {Promise<HTMLElement>} The mount element, rendered.
 */
async function signedUpPanel(body = {}, options = {}) {
  const fetchStub = stubFetch({
    ok: true,
    created: true,
    token: 'fdsa_minted',
    identity: { actor: 'alex-laptop' },
    mcp_url: 'http://127.0.0.1:4143/mcp',
    ...body
  });
  const el = mount();
  createAgentLoginPanel(el, makeStore(), { fetch: fetchStub, ...options });
  /** @type {HTMLButtonElement} */ (
    el.querySelector('.agent-login__secondary')
  ).click();
  /** @type {HTMLInputElement} */ (
    el.querySelector('#agent-login-name')
  ).value = 'alex Laptop';
  /** @type {HTMLFormElement} */ (
    el.querySelector('.agent-login__form')
  ).dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  return el;
}

describe('canMutate / isWriteAffordanceOffered / isLoginPanelVisible', () => {
  test('an agent and the operator may mutate; anonymous and rejected may not', () => {
    expect(canMutate({ identity: { loaded: true, mode: 'agent' } })).toBe(true);
    expect(canMutate({ identity: { loaded: true, mode: 'operator' } })).toBe(
      true
    );
    expect(canMutate({ identity: { loaded: true, mode: 'anonymous' } })).toBe(
      false
    );
    expect(canMutate({ identity: { loaded: true, mode: 'rejected' } })).toBe(
      false
    );
  });

  test('honors an explicit server write permission', () => {
    expect(
      canMutate({
        identity: { loaded: true, mode: 'agent', permissions: { write: false } }
      })
    ).toBe(false);
    expect(
      isWriteAffordanceOffered({
        identity: { loaded: true, mode: 'agent', permissions: { write: false } }
      })
    ).toBe(false);
    expect(
      canMutate({
        identity: {
          loaded: true,
          mode: 'anonymous',
          permissions: { write: true }
        }
      })
    ).toBe(false);
  });

  test('nothing may mutate before whoami answers', () => {
    expect(canMutate({ identity: { loaded: false, mode: 'agent' } })).toBe(
      false
    );
  });

  test('but the affordance is still offered before whoami answers', () => {
    // The asymmetry is deliberate. Disabling a button on the strength of an
    // unanswered round trip would make a `whoami` that never lands look like a
    // broken dashboard, and the server refuses the write regardless.
    expect(
      isWriteAffordanceOffered({ identity: { loaded: false, mode: 'agent' } })
    ).toBe(true);
    expect(
      isWriteAffordanceOffered({
        identity: { loaded: true, mode: 'anonymous' }
      })
    ).toBe(false);
  });

  test('the panel is offered to anonymous and rejected, never to the operator', () => {
    // Operator mode is the "no registry on this machine" case: there is nothing to
    // sign in to and no token anyone could paste, so a login box would be a form
    // that cannot succeed.
    expect(
      isLoginPanelVisible({ identity: { loaded: true, mode: 'anonymous' } })
    ).toBe(true);
    expect(
      isLoginPanelVisible({ identity: { loaded: true, mode: 'rejected' } })
    ).toBe(true);
    expect(
      isLoginPanelVisible({ identity: { loaded: true, mode: 'operator' } })
    ).toBe(false);
    expect(
      isLoginPanelVisible({ identity: { loaded: true, mode: 'agent' } })
    ).toBe(false);
    expect(
      isLoginPanelVisible({ identity: { loaded: false, mode: 'anonymous' } })
    ).toBe(false);
  });
});

describe('snippetFor', () => {
  const connection = {
    token: 'fdsa_abc',
    mcp_url: 'http://127.0.0.1:4143/mcp'
  };

  test('the config form is valid JSON with a bearer header', () => {
    const parsed = JSON.parse(snippetFor(connection, 'json'));

    expect(parsed.mcpServers.feads.url).toBe('http://127.0.0.1:4143/mcp');
    expect(parsed.mcpServers.feads.type).toBe('http');
    expect(parsed.mcpServers.feads.headers.Authorization).toBe(
      'Bearer fdsa_abc'
    );
  });

  test('the one-line form is a claude mcp add command', () => {
    const line = snippetFor(connection, 'cli');

    // --scope user is load-bearing: without it the registration is
    // project-local and feads silently does not exist outside the setup
    // directory (feads-2xb). Pinned to match docs/workflow/setup.md step 3.
    expect(line).toContain(
      'claude mcp add --transport http --scope user feads'
    );
    expect(line).toContain('http://127.0.0.1:4143/mcp');
    expect(line).toContain('Authorization: Bearer fdsa_abc');
  });

  test('neither form mentions the CLI env exports', () => {
    // The agent reaches feads over MCP and the MCP server carries its own
    // instructions, so there is nothing to export and no context to paste.
    for (const form of /** @type {const} */ (['json', 'cli'])) {
      const text = snippetFor(connection, form);
      expect(text).not.toContain('FEADS_AGENT_TOKEN');
      expect(text).not.toContain('feads-agent env');
    }
  });
});

describe('pluginInstallSnippet', () => {
  test('points to the standalone quickstart, not an unavailable plugin', () => {
    expect(pluginInstallSnippet()).toBe('https://github.com/exowatt-oss/feads#quickstart');
    expect(pluginInstallSnippet()).not.toContain('/plugin');
  });

  test('is not an MCP registration', () => {
    // The two blocks answer different questions — reaching feads, versus knowing how
    // this org uses it — and a reader who pasted one for the other gets a confusing
    // failure in a different tool.
    expect(pluginInstallSnippet()).not.toContain('mcp add');
    expect(pluginInstallSnippet()).not.toContain('fdsa_');
  });
});

describe('the panel', () => {
  test('renders nothing until whoami answers', () => {
    const el = mount();
    createAgentLoginPanel(el, makeStore({ loaded: false }));

    expect(el.textContent?.trim()).toBe('');
  });

  test('offers two choices on a first visit', () => {
    const el = mount();
    createAgentLoginPanel(el, makeStore());

    const choices = el.querySelectorAll('.agent-login__choice');
    expect(choices).toHaveLength(2);
    expect(String(el.textContent)).toContain('I already have an agent');
    expect(String(el.textContent)).toContain('Set up a new agent');
  });

  test('behind SSO (accounts mode, silos) there is no sign-up: Connect an agent instead', () => {
    const el = mount();
    createAgentLoginPanel(
      el,
      makeStore({
        mode: 'rejected',
        stance: 'deny',
        require_identity: true,
        sso: {
          status: 'denied',
          error_code: 'not_on_roster',
          action: 'retry_sso',
          terminal: true
        }
      })
    );
    const text = String(el.textContent);
    expect(text).not.toContain('Create an agent');
    expect(text).not.toContain('Set up a new agent');
    expect(text).not.toContain('no invite needed');
    expect(text).toContain('Connect an agent');
    expect(text).toContain('Hosted SSO is not included');
    expect(el.querySelector('.agent-login__choice--sso')).not.toBeNull();
    // The base instance in accounts mode shares this panel with silos: no
    // silo-only wording.
    expect(text).not.toMatch(/silo/i);
  });

  test('says the board is readable rather than blocking it', () => {
    // The premise of the read-only stance: gating a *look* on a ceremony would
    // change nothing about what the shell next to the browser can do.
    const el = mount();
    createAgentLoginPanel(el, makeStore());

    expect(String(el.textContent)).toContain('read-only');
    expect(el.querySelector('.agent-login--blocking')).toBeNull();
    // Dismissible, so the panel can be got out of the way of the board.
    expect(el.querySelector('.agent-login__dismiss')).not.toBeNull();
  });

  test('blocks, and cannot be dismissed, under FEADS_REQUIRE_AGENT', () => {
    // The one case where a wall is honest: the server refuses reads too, so there is
    // nothing behind the panel to preserve.
    const el = mount();
    createAgentLoginPanel(
      el,
      makeStore({ require_identity: true, stance: 'deny' })
    );

    expect(el.querySelector('.agent-login--blocking')).not.toBeNull();
    expect(el.querySelector('.agent-login__dismiss')).toBeNull();
    expect(String(el.textContent)).toContain('FEADS_REQUIRE_AGENT');
  });

  test('a rejected credential is explained as a rejection, not as read-only', () => {
    const el = mount();
    createAgentLoginPanel(el, makeStore({ mode: 'rejected' }));

    expect(el.querySelector('.agent-login__lede--rejected')).not.toBeNull();
    expect(String(el.textContent)).toContain('revoked');
  });

  test('an SSO rejection is denied without calling the Feads token stale', () => {
    const el = mount();
    createAgentLoginPanel(
      el,
      makeStore({
        mode: 'rejected',
        sso: { status: 'rejected', email: 'person@example.test' }
      })
    );

    expect(el.querySelector('.agent-login__lede--rejected')).not.toBeNull();
    expect(String(el.textContent)).toContain('Hosted SSO');
    expect(String(el.textContent)).toMatch(/access is\s+denied/);
    expect(String(el.textContent)).not.toContain('stale');
  });

  test('clears a stale Feads token only after explicit SSO recovery action', async () => {
    const fetch_stub = stubFetch({ ok: true });
    const retry_sso = vi.fn();
    const el = mount();
    createAgentLoginPanel(
      el,
      makeStore({
        mode: 'rejected',
        stance: 'deny',
        require_identity: true,
        sso: {
          status: 'denied',
          action: 'clear_token',
          error_code: 'token_rejected',
          terminal: true
        }
      }),
      { fetch: fetch_stub, onRetrySso: retry_sso }
    );

    const action = /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__sso-action')
    );
    action.click();
    await settle();

    expect(fetch_stub.calls[0].url).toBe('/api/agent/logout');
    expect(fetch_stub.calls[0].init.credentials).toBe('same-origin');
    expect(retry_sso).toHaveBeenCalledTimes(1);
  });

  test('a roster refusal says so, and offers another Google account first', async () => {
    const navigate = vi.fn();
    const retry_sso = vi.fn();
    const el = mount();
    createAgentLoginPanel(
      el,
      makeStore({
        mode: 'rejected',
        stance: 'deny',
        require_identity: true,
        sso: {
          status: 'denied',
          error_code: 'not_on_roster',
          action: 'retry_sso',
          terminal: true
        }
      }),
      { navigate, onRetrySso: retry_sso }
    );
    const text = String(el.textContent);
    expect(el.querySelector('.agent-login__title')?.textContent).toContain(
      'No access to Feads'
    );
    expect(text).toContain('Hosted account sign-in is unavailable');
    // Signed in to Google is not the problem, so the copy must not say it was.
    expect(text).not.toContain('could not authenticate');
    const primary = /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__sso-action')
    );
    expect(primary.textContent).toContain('different Google account');
    primary.click();
    expect(navigate).toHaveBeenCalledWith('/oauth2/sign_out');
    expect(retry_sso).not.toHaveBeenCalled();
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__sso-retry')
    ).click();
    await settle();
    expect(retry_sso).toHaveBeenCalledTimes(1);
    // The other ways in are quiet notes under the answer, not competing cards.
    expect(el.querySelector('.agent-login__choices--quiet')).not.toBeNull();
    expect(el.querySelector('.agent-login__primary')).toBeNull();
  });

  test('no SSO session yet is a sign-in step, not a fault', () => {
    const el = mount();
    createAgentLoginPanel(
      el,
      makeStore({
        mode: 'rejected',
        stance: 'deny',
        require_identity: true,
        sso: {
          status: 'denied',
          error_code: 'sso_required',
          action: 'retry_sso',
          terminal: true
        }
      })
    );
    expect(el.querySelector('.agent-login__title')?.textContent).toContain(
      'Sign in to Feads'
    );
    expect(el.querySelector('.agent-login__lede--rejected')).toBeNull();
    expect(el.querySelector('.agent-login__sso-action')?.textContent).toContain(
      'Sign in with Google'
    );
  });

  test('ssoDenialKind sorts the server codes', () => {
    expect(ssoDenialKind({ error_code: 'not_on_roster' })).toBe('roster');
    expect(ssoDenialKind({ error_code: 'roster_inactive' })).toBe('roster');
    expect(ssoDenialKind({ error_code: 'user_disabled' })).toBe('roster');
    expect(ssoDenialKind({ error_code: 'sso_required' })).toBe('missing');
    expect(ssoDenialKind({ error_code: 'token_rejected' })).toBe('other');
    expect(ssoDenialKind(null)).toBe('other');
  });

  test('dismissing leaves a way back in', () => {
    const el = mount();
    createAgentLoginPanel(el, makeStore());

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__dismiss')
    ).click();

    expect(el.querySelector('.agent-login--collapsed')).not.toBeNull();
    expect(el.querySelector('.agent-login__link')).not.toBeNull();
  });

  test('signing in posts the token and shows the connection', async () => {
    const fetchStub = stubFetch({
      ok: true,
      identity: { actor: 'laptop-claude', role: 'user' },
      mode: 'agent',
      redeemed: false,
      mcp_url: 'http://127.0.0.1:4143/mcp',
      mcp_reason: 'the default MCP address'
    });
    const el = mount();
    const onSignedIn = vi.fn();
    createAgentLoginPanel(el, makeStore(), {
      fetch: fetchStub,
      onSignedIn
    });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__primary')
    ).click();
    const input = /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-token')
    );
    input.value = 'fdsa_abc';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(fetchStub.calls[0].url).toBe('/api/agent/login');
    expect(fetchStub.calls[0].body).toEqual({ token: 'fdsa_abc' });
    // The cookie the server is about to set only comes back if the request carried
    // credentials, so the mode is stated rather than left to a default.
    expect(fetchStub.calls[0].init.credentials).toBe('same-origin');
    expect(String(el.textContent)).toContain('laptop-claude');
    // The config form is shown first, composed in the browser from the token the
    // reader just typed — the server does not echo a pasted token back.
    expect(String(el.textContent)).toContain('mcpServers');
    expect(String(el.textContent)).toContain('Bearer fdsa_abc');
    // Not reloaded yet: the reader gets to copy the connection first.
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test('the pasted token is cleared from the DOM immediately', async () => {
    // It carries on in a variable while the snippet is on screen, but a token sitting
    // in an input's `value` survives things a variable does not — a form restore, an
    // extension reading the field, a screenshot of a focused password box.
    const fetchStub = stubFetch({
      ok: true,
      identity: { actor: 'laptop-claude' },
      mcp_url: 'http://127.0.0.1:4143/mcp'
    });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__primary')
    ).click();
    const input = /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-token')
    );
    input.value = 'fdsa_abc';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(input.value).toBe('');
  });

  test('an empty token is refused client-side without a request', async () => {
    const fetchStub = stubFetch({ ok: true });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__primary')
    ).click();
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(fetchStub).not.toHaveBeenCalled();
    expect(el.querySelector('.agent-login__error')).not.toBeNull();
  });

  test('a server refusal is shown and the form stays usable', async () => {
    const fetchStub = stubFetch(
      {
        ok: false,
        error: {
          code: 'token_rejected',
          message: 'that token was not accepted'
        }
      },
      { ok: false, status: 401 }
    );
    const el = mount();
    const onSignedIn = vi.fn();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub, onSignedIn });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__primary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-token')
    ).value = 'fdsa_bad';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(String(el.textContent)).toContain('that token was not accepted');
    expect(el.querySelector('#agent-login-token')).not.toBeNull();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test('a transport failure says so, rather than blaming the token', async () => {
    /** @type {any} */
    const fetchStub = vi.fn(async () => {
      throw new Error('network down');
    });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__primary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-token')
    ).value = 'fdsa_abc';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(String(el.textContent)).toContain('Could not reach');
  });

  test('signing up posts a name and announces the token as unrecoverable', async () => {
    const fetchStub = stubFetch({
      ok: true,
      created: true,
      token: 'fdsa_minted',
      identity: { actor: 'alex-laptop', display_name: 'alex Laptop' },
      mcp_url: 'http://127.0.0.1:4143/mcp',
      mcp_reason: 'the default MCP address'
    });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__secondary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-name')
    ).value = 'alex Laptop';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(fetchStub.calls[0].url).toBe('/api/agent/signup');
    expect(fetchStub.calls[0].body).toEqual({
      display_name: 'alex Laptop',
      actor: '',
      // feads: the board this tab is on. Boards are per WebSocket connection now
      // and an HTTP POST has no socket, so the tab has to say which one it means —
      // otherwise the agent is registered against the board the daemon started on
      // and never appears on the roster its owner is looking at.
      board_dir: ''
    });
    // Only a hash is stored, so a token nobody copied is a token nobody can use.
    // That makes "shown once" a functional warning, and it has to be unmissable.
    const warning = el.querySelector('.agent-login__warning');
    expect(warning).not.toBeNull();
    expect(String(warning?.textContent)).toContain('only time');
    expect(String(el.textContent)).toContain('fdsa_minted');
  });

  test('sign-up never offers an admin tier', () => {
    // The policy refuses it for an anonymous caller, so a UI that implied otherwise
    // would only produce a confusing refusal.
    const el = mount();
    createAgentLoginPanel(el, makeStore());

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__secondary')
    ).click();

    expect(String(el.textContent).toLowerCase()).not.toContain('admin');
    expect(el.querySelector('[name="role"]')).toBeNull();
  });

  test('an optional actor slug is forwarded when given', async () => {
    const fetchStub = stubFetch({
      ok: true,
      created: true,
      token: 'fdsa_minted',
      identity: { actor: 'alex-laptop' },
      mcp_url: 'http://x/mcp'
    });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__secondary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-name')
    ).value = 'alex Laptop';
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-actor')
    ).value = 'alex-laptop';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(fetchStub.calls[0].body.actor).toBe('alex-laptop');
  });

  test('the connection can be copied in either form', async () => {
    /** @type {string[]} */
    const copied = [];
    const fetchStub = stubFetch({
      ok: true,
      created: true,
      token: 'fdsa_minted',
      identity: { actor: 'alex-laptop' },
      mcp_url: 'http://127.0.0.1:4143/mcp'
    });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), {
      fetch: fetchStub,
      async copy(text) {
        copied.push(text);
      }
    });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__secondary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-name')
    ).value = 'alex Laptop';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__primary')
    ).click();
    await settle();
    expect(JSON.parse(copied[0]).mcpServers.feads.headers.Authorization).toBe(
      'Bearer fdsa_minted'
    );

    // The other form, for someone with a terminal open.
    const toggles = el.querySelectorAll('.agent-login__toggle-btn');
    /** @type {HTMLButtonElement} */ (toggles[1]).click();
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__primary')
    ).click();
    await settle();
    expect(copied[1]).toContain('claude mcp add');
  });

  test('a clipboard failure tells the reader to select it by hand', async () => {
    const fetchStub = stubFetch({
      ok: true,
      created: true,
      token: 'fdsa_minted',
      identity: { actor: 'alex-laptop' },
      mcp_url: 'http://x/mcp'
    });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), {
      fetch: fetchStub,
      async copy() {
        throw new Error('no clipboard');
      }
    });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__secondary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-name')
    ).value = 'alex Laptop';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__primary')
    ).click();
    await settle();

    expect(String(el.textContent)).toContain('by hand');
  });

  test('an undeterminable MCP endpoint says so instead of printing a wrong URL', async () => {
    // A plausible but wrong URL sends someone debugging their agent's config.
    const fetchStub = stubFetch({
      ok: true,
      created: true,
      token: 'fdsa_minted',
      identity: { actor: 'alex-laptop' },
      mcp_url: '',
      mcp_reason: 'FEADS_MCP_HOST is 0.0.0.0, which is a bind address'
    });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__secondary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-name')
    ).value = 'alex Laptop';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(String(el.textContent)).toContain('bind address');
    expect(String(el.textContent)).not.toContain('claude mcp add');
    // The token is still shown: it is the part that cannot be recovered.
    expect(String(el.textContent)).toContain('fdsa_minted');
  });

  test('acknowledging the token drops it and reloads', async () => {
    const fetchStub = stubFetch({
      ok: true,
      created: true,
      token: 'fdsa_minted',
      identity: { actor: 'alex-laptop' },
      mcp_url: 'http://x/mcp'
    });
    const el = mount();
    const onSignedIn = vi.fn();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub, onSignedIn });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__secondary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-name')
    ).value = 'alex Laptop';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__link')
    ).click();
    await settle();

    // The reload is what makes the WebSocket present the new cookie: a browser cannot
    // attach one to a socket that is already open.
    expect(onSignedIn).toHaveBeenCalled();
    expect(String(el.textContent)).not.toContain('fdsa_minted');
  });

  test('no token is ever written to web storage', async () => {
    // The whole reason the persistent credential is an HttpOnly cookie: anything in
    // `localStorage` is readable by every script on the origin, including whatever
    // ends up in a rendered issue description.
    window.localStorage.clear();
    window.sessionStorage.clear();
    const fetchStub = stubFetch({
      ok: true,
      created: true,
      token: 'fdsa_minted',
      identity: { actor: 'alex-laptop' },
      mcp_url: 'http://x/mcp'
    });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__secondary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-name')
    ).value = 'alex Laptop';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(JSON.stringify({ ...window.localStorage })).not.toContain('fdsa_');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('fdsa_');
  });

  test('destroying the panel clears it', () => {
    const el = mount();
    const panel = createAgentLoginPanel(el, makeStore());

    panel.destroy();

    expect(el.textContent?.trim()).toBe('');
  });
});

describe('the three-step handover', () => {
  test('numbers all three steps, with registration already done', async () => {
    // The numbering is the point: a panel that showed only the MCP snippet left the
    // reader with no way to know anything else was expected of them.
    const el = await signedUpPanel();
    const text = String(el.textContent);

    expect(text).toContain('1. Register this agent');
    expect(el.querySelector('.agent-login__step-done')).not.toBeNull();
    expect(text).toContain('2. Connect your agent');
    expect(text).toContain('3. Follow the');
  });

  test('step 3 links the README and does not advertise a private plugin', async () => {
    const text = String((await signedUpPanel()).textContent);
    expect(text).toContain('README quickstart');
    expect(text).not.toContain('/plugin');
    expect(text).not.toContain('/feads:setup-feads');
  });

  test('any other harness is sent to the setup page, not given commands', async () => {
    const el = await signedUpPanel();

    const link = el.querySelector('a[href*="feads#quickstart"]');
    expect(link?.getAttribute('href')).toBe(
      'https://github.com/exowatt-oss/feads#quickstart'
    );
  });

  test('the connection copy button copies only MCP configuration', async () => {
    /** @type {string[]} */
    const copied = [];
    const el = await signedUpPanel({}, { async copy(text) { copied.push(text); } });
    /** @type {HTMLButtonElement} */ (el.querySelector('.agent-login__primary')).click();
    await settle();
    expect(copied[0]).toContain('mcpServers');
    expect(copied[0]).not.toContain('/plugin');
  });

  test('README setup is offered even without a discovered MCP endpoint', async () => {
    const el = await signedUpPanel({ mcp_url: '', mcp_reason: 'endpoint not found' });
    expect(String(el.textContent)).toContain('README quickstart');
  });

  test('signing in with a token already in hand gets the same handover', async () => {
    // Same component, same success state — and someone who pasted a token they already
    // had is exactly as likely to be missing the skills as someone who just minted one.
    const fetchStub = stubFetch({
      ok: true,
      identity: { actor: 'laptop-claude', role: 'user' },
      mode: 'agent',
      redeemed: false,
      mcp_url: 'http://127.0.0.1:4143/mcp'
    });
    const el = mount();
    createAgentLoginPanel(el, makeStore(), { fetch: fetchStub });

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.agent-login__primary')
    ).click();
    /** @type {HTMLInputElement} */ (
      el.querySelector('#agent-login-token')
    ).value = 'fdsa_abc';
    /** @type {HTMLFormElement} */ (
      el.querySelector('.agent-login__form')
    ).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(String(el.textContent)).toContain('README quickstart');
    expect(String(el.textContent)).not.toContain('/feads:setup-feads');
  });
});

describe('the identity chip', () => {
  test('names the agent this browser is acting as, with a way out', () => {
    const el = mount();
    createIdentityChip(
      el,
      makeStore({
        mode: 'agent',
        agent: { actor: 'laptop-claude', role: 'user' }
      })
    );

    expect(String(el.textContent)).toContain('laptop-claude');
    expect(String(el.textContent)).toContain('user');
    expect(el.querySelector('.identity-chip__signout')).not.toBeNull();
  });

  test('keeps the base/token chip unchanged when whoami has no SSO block', () => {
    const el = mount();
    createIdentityChip(
      el,
      makeStore({
        mode: 'agent',
        agent: { actor: 'laptop-claude', role: 'user' }
      })
    );

    const chip = el.querySelector('.identity-chip');
    expect(chip?.className).toBe('identity-chip');
    expect(chip?.querySelector('.identity-chip__provenance')).toBeNull();
    expect(String(chip?.textContent)).not.toContain('hosted SSO');
  });

  test('shows the silo SSO provenance and full accessible email', () => {
    const el = mount();
    createIdentityChip(
      el,
      makeStore({
        mode: 'agent',
        agent: { actor: 'person-one', role: 'user' },
        sso: { email: 'person.one@example.test' }
      })
    );

    const chip = el.querySelector('.identity-chip--sso');
    expect(chip).not.toBeNull();
    expect(String(chip?.textContent)).toContain('person-one');
    expect(String(chip?.textContent)).toContain('Signed in with hosted SSO');
    expect(String(chip?.textContent)).toContain('person.one@example.test');
    expect(chip?.getAttribute('aria-label')).toContain(
      'person.one@example.test'
    );
    expect(chip?.getAttribute('title')).toContain('person.one@example.test');
    expect(
      chip?.querySelector('.identity-chip__signout')?.getAttribute('aria-label')
    ).toBe('Sign out of hosted SSO');
  });

  describe.skip('hosted accounts role (provider excluded)', () => {
    /**
     * @param {Record<string, any>} accounts
     * @param {string} [space_id]
     */
    function accountsStore(accounts, space_id = 'sp_team_a') {
      const store = makeStore({
        mode: 'agent',
        // The principal row's legacy tier: `admin` for every superadmin.
        agent: { actor: accounts.actor || 'mira', role: 'admin' },
        accounts: { kind: 'user', via: 'sso', memberships: {}, ...accounts }
      });
      /** @type {any} */ (store.getState()).workspace = {
        current: { path: '/b/example', key: '/b/example', space_id },
        available: []
      };
      return store;
    }

    test('a superadmin reads superadmin, never the legacy tier', () => {
      const el = mount();
      createIdentityChip(
        el,
        accountsStore({
          superadmin: true,
          memberships: { sp_team_a: 'admin' }
        })
      );
      const role = el.querySelector('.identity-chip__role');
      expect(role?.textContent).toBe('superadmin');
      expect(
        String(el.querySelector('.identity-chip')?.getAttribute('title'))
      ).toBe('Signed in as mira (superadmin)');
    });

    test('everyone else reads their role in the space on screen', () => {
      const admin = mount();
      createIdentityChip(
        admin,
        accountsStore(
          {
            actor: 'eve',
            superadmin: false,
            memberships: { sp_team_b: 'admin', sp_team_a: 'member' }
          },
          'sp_team_b'
        )
      );
      expect(admin.querySelector('.identity-chip__role')?.textContent).toBe(
        'space admin'
      );
      const member = mount();
      createIdentityChip(
        member,
        accountsStore(
          {
            actor: 'eve',
            superadmin: false,
            memberships: { sp_team_b: 'admin', sp_team_a: 'member' }
          },
          'sp_team_a'
        )
      );
      expect(member.querySelector('.identity-chip__role')?.textContent).toBe(
        'member'
      );
      expect(String(member.textContent)).not.toContain('admin');
    });

    test('no role badge until the space is known, and never the tier', () => {
      const el = mount();
      createIdentityChip(
        el,
        accountsStore(
          {
            actor: 'dana',
            superadmin: false,
            memberships: { sp_team_a: 'member' }
          },
          ''
        )
      );
      expect(el.querySelector('.identity-chip__role')).toBeNull();
      expect(String(el.textContent)).not.toContain('admin');
    });

    test('identityRoleLabel: unclaimed agents and accounts-off', () => {
      expect(
        identityRoleLabel({
          identity: {
            agent: { role: 'user' },
            accounts: { kind: 'legacy_agent' }
          }
        })
      ).toBe('agent');
      expect(
        identityRoleLabel({ identity: { agent: { role: 'admin' } } })
      ).toBe('admin');
    });
  });

  test('names operator mode rather than staying blank', () => {
    // An unlabelled dashboard that can delete anything reads as ordinary until it is
    // not, so this is the state most worth naming.
    const el = mount();
    createIdentityChip(el, makeStore({ mode: 'operator' }));

    expect(String(el.textContent)).toContain('operator');
    expect(el.querySelector('.identity-chip__signout')).toBeNull();
  });

  test('says read-only when anonymous', () => {
    const el = mount();
    createIdentityChip(el, makeStore({ mode: 'anonymous' }));

    expect(String(el.textContent)).toContain('read-only');
  });

  test('renders nothing before whoami answers', () => {
    const el = mount();
    createIdentityChip(el, makeStore({ loaded: false }));

    expect(el.textContent?.trim()).toBe('');
  });

  test('signing out of SSO navigates to the platform target without Feads logout', async () => {
    const fetchStub = stubFetch({ ok: true });
    const navigate = vi.fn();
    const onSignedOut = vi.fn();
    const el = mount();
    createIdentityChip(
      el,
      makeStore({
        mode: 'agent',
        agent: { actor: 'person-one', role: 'user' },
        sso: { email: 'person@example.test' }
      }),
      { fetch: fetchStub, navigate, onSignedOut }
    );

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.identity-chip__signout')
    ).click();
    await settle();

    expect(fetchStub).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/oauth2/sign_out');
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  test('SSO sign-out delegates the platform path and app-close callback', async () => {
    const navigate = vi.fn();
    const close_app = vi.fn();
    const el = mount();
    createIdentityChip(
      el,
      makeStore({
        mode: 'agent',
        agent: { actor: 'person-one', role: 'user' },
        sso: { email: 'person@example.test' }
      }),
      {
        navigate,
        onSsoSignedOut: (target) => {
          close_app();
          navigate(target);
        }
      }
    );

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.identity-chip__signout')
    ).click();
    await settle();

    expect(close_app).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/oauth2/sign_out');
  });

  test('SSO uses a server-provided logout target when present', async () => {
    const navigate = vi.fn();
    const el = mount();
    createIdentityChip(
      el,
      makeStore({
        mode: 'agent',
        agent: { actor: 'person-one', role: 'user' },
        sso: {
          email: 'person@example.test',
          logout_url: 'https://auth.example.test/oauth2/sign_out?rd=/signed-out'
        }
      }),
      { navigate }
    );

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.identity-chip__signout')
    ).click();
    await settle();

    expect(navigate).toHaveBeenCalledWith(
      'https://auth.example.test/oauth2/sign_out?rd=/signed-out'
    );
  });

  test('signing out posts to the logout route and reloads', async () => {
    const fetchStub = stubFetch({ ok: true });
    const onSignedOut = vi.fn();
    const el = mount();
    createIdentityChip(
      el,
      makeStore({
        mode: 'agent',
        agent: { actor: 'laptop-claude', role: 'user' }
      }),
      { fetch: fetchStub, onSignedOut }
    );

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.identity-chip__signout')
    ).click();
    await settle();

    expect(fetchStub.calls[0].url).toBe('/api/agent/logout');
    expect(fetchStub.calls[0].init.credentials).toBe('same-origin');
    expect(onSignedOut).toHaveBeenCalled();
  });

  test('a failed logout still reloads, so the truth is shown', async () => {
    // Signing out is clearing a cookie. If the request never landed the cookie is
    // still there, and reloading shows that honestly rather than pretending.
    /** @type {any} */
    const fetchStub = vi.fn(async () => {
      throw new Error('network down');
    });
    const onSignedOut = vi.fn();
    const el = mount();
    createIdentityChip(
      el,
      makeStore({
        mode: 'agent',
        agent: { actor: 'laptop-claude', role: 'user' }
      }),
      { fetch: fetchStub, onSignedOut }
    );

    /** @type {HTMLButtonElement} */ (
      el.querySelector('.identity-chip__signout')
    ).click();
    await settle();

    expect(onSignedOut).toHaveBeenCalled();
  });
});
