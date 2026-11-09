import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSubscriptionIssueStore } from './data/subscription-issue-store.js';
import { boardClosedSpec, createConnectionStatus } from './main.js';

describe('connection status pill (feads)', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.removeAttribute('data-ws');
  });

  test('hidden while open; says reconnecting and marks the page stale while down', () => {
    document.body.innerHTML =
      '<div class="header-actions"><span id="x"></span></div>';
    const host = document.querySelector('.header-actions');
    const status = createConnectionStatus(host);
    const el = /** @type {HTMLElement} */ (
      document.getElementById('conn-status')
    );
    expect(host?.firstElementChild).toBe(el);
    expect(el.getAttribute('role')).toBe('status');
    expect(el.hidden).toBe(true);

    status.set('reconnecting');
    expect(el.hidden).toBe(false);
    expect(el.textContent).toMatch(/Reconnecting…/);
    expect(el.getAttribute('aria-label')).toMatch(/showing data from/);
    expect(document.body.getAttribute('data-ws')).toBe('stale');

    status.set('open');
    expect(el.hidden).toBe(true);
    expect(document.body.hasAttribute('data-ws')).toBe(false);
  });

  test('a fast first connect never flashes the pill', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div class="header-actions"></div>';
    const status = createConnectionStatus(
      document.querySelector('.header-actions')
    );
    const el = /** @type {HTMLElement} */ (
      document.getElementById('conn-status')
    );
    status.set('connecting');
    vi.advanceTimersByTime(200);
    status.set('open');
    vi.advanceTimersByTime(2000);
    expect(el.hidden).toBe(true);

    status.set('connecting');
    vi.advanceTimersByTime(700);
    expect(el.hidden).toBe(false);
    expect(el.textContent).toMatch(/Connecting/);
  });
});

describe('board Done-column subscription (feads)', () => {
  test('asks for closures since local midnight eight days ago', () => {
    const now = new Date(2026, 9, 5, 15, 42).getTime();
    const spec = boardClosedSpec(now);
    expect(spec.type).toBe('closed-issues');
    expect(spec.params.since).toBe(new Date(2026, 8, 27, 0, 0, 0, 0).getTime());
    // Same key all day, so every tab shares one server-side subscription.
    expect(boardClosedSpec(new Date(2026, 9, 5, 0, 1).getTime())).toEqual(spec);
  });
});

describe('subscription issue store isLoaded (feads)', () => {
  test('false until the first snapshot, reset by dispose', () => {
    const store = createSubscriptionIssueStore('tab:x');
    expect(store.isLoaded()).toBe(false);
    store.applyPush({
      type: 'upsert',
      id: 'tab:x',
      revision: 1,
      issue: { id: 'A', updated_at: 1 }
    });
    expect(store.isLoaded()).toBe(false);
    store.applyPush({ type: 'snapshot', id: 'tab:x', revision: 2, issues: [] });
    expect(store.isLoaded()).toBe(true);
    store.dispose();
    expect(store.isLoaded()).toBe(false);
  });
});
