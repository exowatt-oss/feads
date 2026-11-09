/**
 * feads: a confirmation step for destructive or far-reaching actions.
 *
 * Replaces `window.confirm`, which renders outside the app (no theme, no way to
 * say *what* will happen in more than one line) and blocks the page. Built on
 * the `.dialog` primitive: title, a body that names the consequence, and a
 * footer with Cancel then the action — filled red (`.btn--danger`) when the
 * action destroys something. Cancel has focus first, so Enter on a reflex
 * does not destroy anything.
 */
import { html, render } from 'lit-html';

let seq = 0;

/**
 * @param {Object} options
 * @param {string} options.title - A question naming the thing: "Revoke laptop-phi?"
 * @param {unknown} [options.body] - What happens, in a sentence or two (text or a lit template).
 * @param {string} [options.confirm] - The action's verb: "Revoke", "Delete department".
 * @param {string} [options.cancel]
 * @param {boolean} [options.danger] - Destroys or takes away something.
 * @returns {Promise<boolean>} Whether the reader confirmed.
 */
export function confirmDialog(options) {
  const {
    title,
    body = '',
    confirm = 'Confirm',
    cancel = 'Cancel',
    danger = false
  } = options;
  return new Promise((resolve) => {
    const id = `confirm-dialog-${++seq}`;
    const previous = /** @type {HTMLElement | null} */ (document.activeElement);
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog dialog--confirm';
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.setAttribute('aria-describedby', `${id}-body`);
    let settled = false;

    /** @param {boolean} value */
    function done(value) {
      if (settled) return;
      settled = true;
      try {
        dialog.close();
      } catch {
        // jsdom / an already-closed dialog
      }
      dialog.remove();
      if (previous && document.contains(previous)) previous.focus();
      resolve(value);
    }

    render(
      html`<header class="dialog__header">
          <h2 class="dialog__title" id=${`${id}-title`}>${title}</h2>
        </header>
        <div class="dialog__body" id=${`${id}-body`}>${body}</div>
        <footer class="dialog__footer">
          <button
            type="button"
            class="btn btn--ghost"
            data-cancel
            @click=${() => done(false)}
          >
            ${cancel}
          </button>
          <button
            type="button"
            class="btn ${danger ? 'btn--danger' : 'btn--primary'}"
            data-confirm
            @click=${() => done(true)}
          >
            ${confirm}
          </button>
        </footer>`,
      dialog
    );
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      done(false);
    });
    dialog.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        done(false);
      }
    });
    // A click on the backdrop lands on the dialog element itself.
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) done(false);
    });
    document.body.append(dialog);
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch {
      dialog.setAttribute('open', '');
    }
    /** @type {HTMLElement | null} */ (
      dialog.querySelector('[data-cancel]')
    )?.focus();
  });
}
