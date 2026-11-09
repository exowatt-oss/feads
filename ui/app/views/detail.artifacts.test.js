import { describe, expect, test, vi } from 'vitest';
import { createDetailView } from './detail.js';

/**
 * Mount the detail view on one issue, fed through the push store the app really uses.
 * Mirrors the harness in detail.dates.test.js — a transport-based stub renders
 * "Loading…" forever, so a negative assertion would pass for the wrong reason.
 *
 * @param {Record<string, any> & { id: string }} issue
 * @returns {Promise<HTMLElement>}
 */
async function mountIssue(issue) {
  document.body.innerHTML =
    '<section class="panel"><div id="mount"></div></section>';
  const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
  const client_id = `detail:${issue.id}`;
  const stores = {
    /** @param {string} id */
    snapshotFor(id) {
      return id === client_id ? [issue] : [];
    },
    subscribe() {
      return () => {};
    }
  };
  const send = vi.fn(async () => {
    throw new Error('Unexpected send');
  });
  const view = createDetailView(mount, send, undefined, stores);
  await view.load(issue.id);
  return mount;
}

/**
 * Metadata as bd returns it for a bead carrying artifacts.
 *
 * Written out literally rather than built with attachPatch, so this test would catch a
 * change to the storage shape instead of following it.
 */
const METADATA_WITH_ARTIFACTS = {
  has_artifacts: true,
  team: 'platform',
  'artifact:example-org/feads:ui/server/bd.js': {
    kind: 'file',
    repo: 'example-org/feads',
    path: 'ui/server/bd.js',
    intent: 'editing',
    actor: 'laptop-claude',
    at: '2026-07-28T20:38:20Z',
    note: 'rewiring the spawn choke point'
  },
  'artifact:example-org/feads#4141': {
    kind: 'pr',
    repo: 'example-org/feads',
    pr: 4141,
    intent: 'done'
  },
  'artifact:example-org/feads:go.mod': null
};

describe('views/detail artifacts card', () => {
  test('lists what the bead is working on, decoded from bead metadata', async () => {
    const mount = await mountIssue({
      id: 'ex-dh0',
      title: 'feads UI: board selection is daemon-global',
      status: 'in_progress',
      metadata: METADATA_WITH_ARTIFACTS
    });

    const card = mount.querySelector('[data-testid="artifacts"]');
    expect(card).not.toBeNull();
    const rows = Array.from(mount.querySelectorAll('.artifact'));
    // Sorted by ref in code-point order (so the CLI, the MCP and this agree), and the
    // released (null) artifact is not one.
    expect(
      rows.map((r) => r.querySelector('.mono')?.textContent?.trim())
    ).toEqual(['#4141', 'ui/server/bd.js']);
    expect(
      rows.map((r) => r.querySelector('.intent-badge')?.textContent?.trim())
    ).toEqual(['done', 'editing']);
    // The full ref is on the row, since the label shows only the readable half.
    expect(rows[1].getAttribute('title')).toBe(
      'example-org/feads:ui/server/bd.js'
    );
    expect(card?.textContent).toContain('rewiring the spawn choke point');
    expect(card?.textContent).toContain('laptop-claude');
  });

  test('a bead with no artifacts renders no card at all', async () => {
    const mount = await mountIssue({
      id: 'ex-old',
      title: 'filed before the feature existed',
      status: 'open',
      metadata: { team: 'platform' }
    });

    expect(mount.querySelector('[data-testid="artifacts"]')).toBeNull();
  });

  test('a bead whose every artifact was released renders no card either', async () => {
    const mount = await mountIssue({
      id: 'ex-rel',
      title: 'released everything',
      status: 'open',
      metadata: {
        has_artifacts: true,
        'artifact:example-org/feads:go.mod': null
      }
    });

    expect(mount.querySelector('[data-testid="artifacts"]')).toBeNull();
  });

  test('metadata that is missing entirely does not break the view', async () => {
    const mount = await mountIssue({
      id: 'ex-nom',
      title: 'no metadata key',
      status: 'open'
    });

    expect(mount.querySelector('[data-testid="artifacts"]')).toBeNull();
    expect(mount.textContent).toContain('no metadata key');
  });
});
