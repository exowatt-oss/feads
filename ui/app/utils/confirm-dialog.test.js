import { afterEach, describe, expect, test } from 'vitest';
import { confirmDialog } from './confirm-dialog.js';

const open = () =>
  /** @type {HTMLDialogElement | null} */ (
    document.querySelector('dialog.dialog--confirm')
  );

describe('confirmDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('names the consequence and resolves true on the action', async () => {
    const answer = confirmDialog({
      title: 'Revoke laptop-phi?',
      body: 'Any agent using it stops working.',
      confirm: 'Revoke',
      danger: true
    });
    const dialog = open();
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Revoke laptop-phi?');
    expect(dialog?.textContent).toContain('stops working');
    const action = /** @type {HTMLButtonElement} */ (
      /** @type {HTMLElement} */ (dialog).querySelector('[data-confirm]')
    );
    // Destructive: the confirming step is the filled red one.
    expect(action.className).toContain('btn--danger');
    // Cancel has focus, so a reflexive Enter does not destroy anything.
    expect(document.activeElement?.hasAttribute('data-cancel')).toBe(true);
    action.click();
    await expect(answer).resolves.toBe(true);
    expect(open()).toBeNull();
  });

  test('Cancel and Escape both resolve false', async () => {
    const first = confirmDialog({ title: 'Move it?', confirm: 'Move' });
    expect(open()?.querySelector('[data-confirm]')?.className).toContain(
      'btn--primary'
    );
    /** @type {HTMLButtonElement} */ (
      /** @type {HTMLElement} */ (open()).querySelector('[data-cancel]')
    ).click();
    await expect(first).resolves.toBe(false);

    const second = confirmDialog({ title: 'Move it?' });
    open()?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    await expect(second).resolves.toBe(false);
    expect(open()).toBeNull();
  });
});
