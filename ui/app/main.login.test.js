import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

/**
 * feads: the app shell's login wiring — the panel, the header chip, the New-issue
 * button, and the document marking that makes a read-only session look read-only.
 *
 * The panel's own behaviour is covered in `views/agent-login.test.js`; what is
 * unproven until here is that the shell mounts it, feeds it the mode `whoami`
 * reported, and does **not** blank the board around it. That last one is the whole
 * premise of a read-only stance rather than a refusal, and it is exactly the kind of
 * thing a well-tested panel can get right while the page it lives on gets wrong.
 */

/** What the stub `whoami` answers. Mutated per test. */
/** @type {Record<string, any>} */
let whoami_reply = {
  identity: null,
  mode: 'anonymous',
  stance: 'read_only',
  require_identity: false,
  credential_rejected: false
};

vi.mock('./utils/toast.js', () => ({ showToast: vi.fn() }));

vi.mock('./ws.js', () => ({
  createWsClient: () => ({
    /**
     * @param {string} type
     * @returns {Promise<any>}
     */
    async send(type) {
      if (type === 'whoami') {
        return whoami_reply;
      }
      return null;
    },
    on() {
      return () => {};
    },
    close() {},
    getState() {
      return 'open';
    }
  })
}));

/**
 * `whoami` is a round trip and the store notification another, so a handful of
 * microtasks are needed before the panel reflects it.
 */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/**
 * The header markup the panel and chip mount into, matching `app/index.html`.
 *
 * @returns {HTMLElement}
 */
function boot() {
  window.location.hash = '#/issues';
  document.body.innerHTML =
    '<nav id="top-nav"></nav>' +
    '<div id="identity-chip"></div>' +
    '<button id="new-issue-btn" type="button">New issue</button>' +
    '<main id="app"></main>';
  const root = /** @type {HTMLElement} */ (document.getElementById('app'));
  bootstrap(root);
  return root;
}

describe('app shell login wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('data-identity-mode');
    whoami_reply = {
      identity: null,
      mode: 'anonymous',
      stance: 'read_only',
      require_identity: false,
      credential_rejected: false
    };
  });

  test('an anonymous visitor gets the panel and keeps the board', async () => {
    boot();
    await settle();

    const panel = document.getElementById('agent-login-root');
    expect(panel).not.toBeNull();
    expect(String(panel?.textContent)).toContain('I already have an agent');
    // The board is still there. A wall would gate *looking* on a ceremony while
    // changing nothing about what the shell next to the browser can do.
    const issues_root = /** @type {HTMLElement} */ (
      document.getElementById('issues-root')
    );
    expect(issues_root).not.toBeNull();
    expect(issues_root.hidden).toBe(false);
  });

  test('the New-issue button is disabled for an anonymous visitor', async () => {
    boot();
    await settle();

    const btn = /** @type {HTMLButtonElement} */ (
      document.getElementById('new-issue-btn')
    );
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('Sign in');
  });

  test('the document is marked read-only so the inline editors dim', async () => {
    // One attribute rather than every view learning about identity. The CSS reaches
    // the detail view's editors, which would otherwise take a click and answer
    // "Failed to save title" — true, and a poor explanation of "you are not signed
    // in".
    boot();
    await settle();

    expect(document.documentElement.dataset.identityMode).toBe('anonymous');
  });

  test('an identified agent gets no panel, a chip, and a live button', async () => {
    whoami_reply = {
      identity: {
        agent_id: 'ag_1',
        actor: 'laptop-claude',
        display_name: 'Laptop Claude',
        role: 'user',
        board_id: 'example',
        last_seen_at: 1753718400000
      },
      mode: 'agent',
      stance: 'read_only',
      require_identity: false,
      credential_rejected: false
    };
    boot();
    await settle();

    expect(
      String(document.getElementById('agent-login-root')?.textContent).trim()
    ).toBe('');
    const chip = document.getElementById('identity-chip');
    expect(String(chip?.textContent)).toContain('laptop-claude');
    expect(chip?.querySelector('.identity-chip__signout')).not.toBeNull();
    expect(
      /** @type {HTMLButtonElement} */ (
        document.getElementById('new-issue-btn')
      ).disabled
    ).toBe(false);
  });

  test('a silo SSO identity keeps the actor primary and does not persist email', async () => {
    whoami_reply = {
      identity: {
        agent_id: 'ag_sso',
        actor: 'person-one',
        display_name: 'Person One',
        role: 'user',
        board_id: 'controls',
        last_seen_at: 1753718400000
      },
      mode: 'agent',
      stance: 'deny',
      require_identity: true,
      permissions: { write: true },
      sso: { email: 'person.one@example.test' }
    };
    window.localStorage.clear();
    window.sessionStorage.clear();
    boot();
    await settle();

    const chip = document.getElementById('identity-chip');
    expect(chip?.querySelector('.identity-chip--sso')).not.toBeNull();
    expect(String(chip?.textContent)).toContain('person-one');
    expect(String(chip?.textContent)).toContain('Signed in with hosted SSO');
    expect(String(chip?.textContent)).toContain('person.one@example.test');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(
      'person.one@example.test'
    );
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(
      'person.one@example.test'
    );
  });

  test('a server permission can withhold the New-issue affordance', async () => {
    whoami_reply = {
      identity: {
        agent_id: 'ag_1',
        actor: 'laptop-claude',
        display_name: 'Laptop Claude',
        role: 'user',
        board_id: 'example',
        last_seen_at: 1753718400000
      },
      mode: 'agent',
      stance: 'read_only',
      require_identity: false,
      permissions: { write: false }
    };
    boot();
    await settle();

    expect(
      /** @type {HTMLButtonElement} */ (
        document.getElementById('new-issue-btn')
      ).disabled
    ).toBe(true);
  });

  test('operator mode gets no panel — there is nothing to sign in to', async () => {
    // The "no registry on this machine" case. A login box there would be a form that
    // cannot succeed.
    whoami_reply = {
      identity: null,
      mode: 'operator',
      stance: 'operator',
      require_identity: false,
      credential_rejected: false
    };
    boot();
    await settle();

    expect(
      String(document.getElementById('agent-login-root')?.textContent).trim()
    ).toBe('');
    expect(
      String(document.getElementById('identity-chip')?.textContent)
    ).toContain('operator');
    expect(
      /** @type {HTMLButtonElement} */ (
        document.getElementById('new-issue-btn')
      ).disabled
    ).toBe(false);
  });

  test('the deny stance blocks, and only then', async () => {
    whoami_reply = {
      identity: null,
      mode: 'anonymous',
      stance: 'deny',
      require_identity: true,
      credential_rejected: false
    };
    boot();
    await settle();

    const panel = document.getElementById('agent-login-root');
    expect(panel?.querySelector('.agent-login--blocking')).not.toBeNull();
    expect(panel?.querySelector('.agent-login__dismiss')).toBeNull();
  });

  test('an unanswered whoami leaves the page as it was', async () => {
    // Not fatal, and not a reason to disable the write affordances: a `whoami` that
    // never lands would otherwise look like a broken dashboard.
    whoami_reply = /** @type {any} */ (null);
    boot();
    await settle();

    expect(
      String(document.getElementById('agent-login-root')?.textContent).trim()
    ).toBe('');
    expect(
      /** @type {HTMLButtonElement} */ (
        document.getElementById('new-issue-btn')
      ).disabled
    ).toBe(false);
    expect(document.documentElement.dataset.identityMode).toBe('unknown');
  });

  test('no page state ever holds a token', async () => {
    // The cookie is HttpOnly precisely so this is true by construction; asserted
    // because it is the property the whole design turns on.
    whoami_reply = {
      identity: {
        agent_id: 'ag_1',
        actor: 'laptop-claude',
        display_name: 'Laptop Claude',
        role: 'user',
        board_id: 'example',
        last_seen_at: 1753718400000
      },
      mode: 'agent',
      stance: 'read_only',
      require_identity: false,
      credential_rejected: false
    };
    window.localStorage.clear();
    boot();
    await settle();

    expect(String(document.body.innerHTML)).not.toContain('fdsa_');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('fdsa_');
  });
});
