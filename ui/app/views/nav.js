import { html, render } from 'lit-html';
import { debug } from '../utils/logging.js';
import { accountsActive } from './accounts-pages.js';
import { isAgentsTabVisible } from './agents-admin.js';

/**
 * Render the top navigation and handle route changes.
 *
 * feads: the Agents tab is conditional — see `isAgentsTabVisible`, which owns
 * that rule so the tab and the page it leads to cannot disagree. Users is not:
 * it is the directory you address a mention from, and gating it would make the
 * `@handle` syntax unusable for exactly the tier that has to ask for help.
 * Agentwatch is likewise read-only and visible to every dashboard session. The
 * server still owns authorization: on a deny-stance deployment an identified
 * agent may read while an anonymous deep link receives the ordinary refusal.
 *
 * @param {HTMLElement} mount_element
 * @param {{ getState: () => any, subscribe: (fn: (s: any) => void) => () => void }} store
 * @param {{ gotoView: (v: 'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'access'|'departments') => void }} router
 */
export function createTopNav(mount_element, store, router) {
  const log = debug('views:nav');
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /**
   * @param {'issues'|'epics'|'board'|'agentwatch'|'users'|'agents'|'admin'|'access'|'departments'} view
   * @returns {(ev: MouseEvent) => void}
   */
  function onClick(view) {
    return (ev) => {
      ev.preventDefault();
      log('click tab %s', view);
      router.gotoView(view);
    };
  }

  function template() {
    const s = store.getState();
    const active = s.view || 'issues';
    return html`
      <nav class="header-nav" aria-label="Primary">
        <a
          href="#/issues"
          class="tab ${active === 'issues' ? 'active' : ''}"
          @click=${onClick('issues')}
          >Issues</a
        >
        <a
          href="#/epics"
          class="tab ${active === 'epics' ? 'active' : ''}"
          @click=${onClick('epics')}
          >Epics</a
        >
        <a
          href="#/board"
          class="tab ${active === 'board' ? 'active' : ''}"
          @click=${onClick('board')}
          >Board</a
        >
        <a
          href="#/agentwatch"
          class="tab tab--agentwatch ${active === 'agentwatch' ? 'active' : ''}"
          @click=${onClick('agentwatch')}
          >Agentwatch <span class="agentwatch-new-badge">New</span></a
        >
        <a
          href="#/users"
          class="tab ${active === 'users' ? 'active' : ''}"
          @click=${onClick('users')}
          >Users</a
        >
        ${accountsActive(s)
          ? html`<a
                href="#/departments"
                class="tab ${active === 'departments' ? 'active' : ''}"
                @click=${onClick('departments')}
                >Departments</a
              ><a
                href="#/access"
                class="tab ${active === 'access' ? 'active' : ''}"
                @click=${onClick('access')}
                >Access</a
              >`
          : ''}
        ${isAgentsTabVisible(s) && !accountsActive(s)
          ? html`<a
              href="#/agents"
              class="tab ${active === 'agents' ? 'active' : ''}"
              @click=${onClick('agents')}
              >Agents</a
            >`
          : ''}
        ${isAgentsTabVisible(s)
          ? html`<a
              href="#/admin"
              class="tab ${active === 'admin' ? 'active' : ''}"
              @click=${onClick('admin')}
              >Silos</a
            >`
          : ''}
      </nav>
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
