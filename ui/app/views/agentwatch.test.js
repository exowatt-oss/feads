import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setOwnerDirectory } from '../utils/owners.js';
import { createAgentwatchView } from './agentwatch.js';

/**
 * @typedef {ReturnType<typeof makeClient>} TestClient
 */

/**
 * Create a small event client that mirrors the websocket `on` contract.
 *
 * @returns {{ on: any, emit: (event_name: string, payload: unknown) => void, unsubscribe: any }}
 */
function makeClient() {
  /** @type {Map<string, Set<(payload: unknown) => void>>} */
  const handlers = new Map();
  const unsubscribe = vi.fn();
  /**
   * @param {'agentwatch'} event_name
   * @param {(payload: unknown) => void} handler
   */
  function on(event_name, handler) {
    if (!handlers.has(event_name)) {
      handlers.set(event_name, new Set());
    }
    handlers.get(event_name)?.add(handler);
    return () => {
      unsubscribe(event_name, handler);
      handlers.get(event_name)?.delete(handler);
    };
  }
  /**
   * @param {string} event_name
   * @param {unknown} payload
   */
  function emit(event_name, payload) {
    for (const handler of handlers.get(event_name) || []) {
      handler(payload);
    }
  }
  const client = {
    on: vi.fn(on),
    emit,
    unsubscribe
  };
  return client;
}

/**
 * Return a mount point for one isolated jsdom test.
 *
 * @returns {HTMLElement}
 */
function makeMount() {
  document.body.innerHTML = '<main id="agentwatch-test-mount"></main>';
  return /** @type {HTMLElement} */ (
    document.getElementById('agentwatch-test-mount')
  );
}

/**
 * Read text from an optional element without relying on a matcher extension.
 *
 * @param {Element | null} element
 * @returns {string}
 */
function textOf(element) {
  return String(element?.textContent || '');
}

/**
 * Make a payload with the server's grouping and ordering already established.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
function makePayload(overrides = {}) {
  return {
    generated_at: new Date().toISOString(),
    stats: {
      live_work: 3,
      active_agents: 2,
      discussions: 1,
      comment_count: 4
    },
    agents: [
      {
        actor: 'fable',
        item_count: 1,
        display_name: 'Fable',
        status: 'working',
        issues: [
          {
            id: 'feads-101',
            title: 'Prepare the executive brief',
            board_id: 'platform',
            status: 'in_progress',
            priority: 1
          }
        ]
      },
      {
        actor: 'luna',
        item_count: 1,
        display_name: 'Luna',
        status: 'blocked',
        issues: [
          {
            id: 'feads-102',
            title: 'Verify the shared rollout thread',
            board_id: 'platform',
            status: 'waiting',
            priority: 2
          }
        ]
      }
    ],
    discussions: [
      {
        id: 'feads-102',
        title: 'Verify the shared rollout thread',
        board_id: 'platform',
        participants: [
          { actor: 'fable', comment_count: 2 },
          { actor: 'luna', comment_count: 2 }
        ],
        comment_count: 4,
        latest_comment: {
          author: 'luna',
          body: 'The evidence is ready for review.',
          created_at: new Date().toISOString()
        }
      }
    ],
    ...overrides
  };
}

/**
 * Make a sanitized runtime row for Agentwatch projection tests.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
function makeRuntimeRow(overrides = {}) {
  const now = Date.now();
  return {
    run_id: 'run-main',
    handle: 'main',
    display_name: 'Runtime session',
    status: 'working',
    model: 'example/sol',
    activity: 'working',
    context_percent: 37.2,
    started_at: now - 37_000,
    ended_at: 0,
    heartbeat_at: now - 2_000,
    liveness: 'live',
    ...overrides
  };
}

/**
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
function makeRuntimeSession(overrides = {}) {
  const now = Date.now();
  return {
    session_id: '01a02071-b6dc-7f8e-bd10-5417e3c3a3fe',
    runtime_id: '019d14e7-882a-7b0d-a8b5-a86b6c07ff7a',
    last_seen: now - 2_000,
    main: makeRuntimeRow(),
    subagents: [],
    ...overrides
  };
}

/**
 * @param {any} send
 * @param {TestClient} client
 * @param {Partial<import('./agentwatch.js').AgentwatchOptions>} [overrides]
 */
function makeView(send, client, overrides = {}) {
  return createAgentwatchView(makeMount(), {
    send,
    client,
    ...overrides
  });
}

/**
 * Switch the mounted view into the detailed grid, where the full card DOM
 * lives. Compact is the default density.
 */
function enterDetail() {
  document
    .querySelector('[data-mode="detail"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('views/agentwatch', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // Storage may be unavailable in some environments.
    }
  });

  test('defaults to Active agents and starts with a waiting state', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const view = makeView(send, client);

    expect(textOf(document.querySelector('.agentwatch-status'))).toContain(
      'Waiting'
    );
    expect(document.body.textContent).toContain('Waiting for live activity');

    await view.load();
    enterDetail();

    expect(
      document
        .querySelector('[data-tab="active"]')
        ?.getAttribute('aria-selected')
    ).toBe('true');
    expect(
      document
        .querySelector('[data-tab="discussions"]')
        ?.getAttribute('aria-selected')
    ).toBe('false');
    expect(
      document.querySelector('#agentwatch-panel-active')?.hasAttribute('hidden')
    ).toBe(false);
    view.destroy();
  });

  test('loads the initial server snapshot and renders the focal count', async () => {
    const client = makeClient();
    const payload = makePayload();
    const send = vi.fn().mockResolvedValue(payload);
    const view = makeView(send, client);

    await view.load();
    enterDetail();

    expect(send).toHaveBeenCalledWith('watch-agentwatch');
    expect(
      textOf(
        document.querySelector(
          '[data-stat="live-work"] .agentwatch-pulse__value'
        )
      )
    ).toContain('3');
    expect(textOf(document.querySelector('.agentwatch-status'))).toContain(
      'Live'
    );
    expect(
      textOf(
        document.querySelector('[data-stat="agents"] .agentwatch-pulse__value')
      )
    ).toContain('2');
    expect(
      textOf(
        document.querySelector(
          '[data-stat="discussions"] .agentwatch-pulse__value'
        )
      )
    ).toContain('1');
    expect(
      textOf(document.querySelector('[data-stat="active-now"]'))
    ).toContain('Active now');
  });

  test('switches subtabs with click and arrow-key navigation', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const discussions_tab = /** @type {HTMLButtonElement} */ (
      document.querySelector('[data-tab="discussions"]')
    );
    discussions_tab.click();

    expect(discussions_tab.getAttribute('aria-selected')).toBe('true');
    expect(
      document.querySelector('#agentwatch-panel-active')?.hasAttribute('hidden')
    ).toBe(true);
    expect(
      document
        .querySelector('#agentwatch-panel-discussions')
        ?.hasAttribute('hidden')
    ).toBe(false);

    discussions_tab.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
    );

    expect(
      document
        .querySelector('[data-tab="active"]')
        ?.getAttribute('aria-selected')
    ).toBe('true');
    expect(document.activeElement).toBe(
      document.querySelector('[data-tab="active"]')
    );
    view.destroy();
  });

  test('shows loading state while the initial watch is pending', async () => {
    const client = makeClient();
    /** @type {(value: any) => void} */
    let resolve_watch = () => {};
    const watch = new Promise((resolve) => {
      resolve_watch = resolve;
    });
    const send = vi.fn().mockReturnValue(watch);
    const view = makeView(send, client);

    const loading = view.load();

    expect(document.body.textContent).toContain('Loading live activity');
    expect(
      document.querySelector('.agentwatch-message--loading')
    ).not.toBeNull();

    resolve_watch(makePayload());
    await loading;

    expect(document.querySelector('.agentwatch-message--loading')).toBeNull();
    view.destroy();
  });

  test('shows a server error instead of pretending the snapshot is empty', async () => {
    const client = makeClient();
    const send = vi
      .fn()
      .mockRejectedValue(new Error('watch permission denied'));
    const view = makeView(send, client);

    await view.load();
    enterDetail();

    expect(
      textOf(document.querySelector('.agentwatch-message--error'))
    ).toContain('watch permission denied');
    expect(textOf(document.querySelector('.agentwatch-status'))).toContain(
      'Error'
    );
    view.destroy();
  });

  test('renders empty active and discussion panels from empty server arrays', async () => {
    const client = makeClient();
    const send = vi
      .fn()
      .mockResolvedValue(makePayload({ agents: [], discussions: [] }));
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    expect(
      textOf(document.querySelector('.agentwatch-empty--panel'))
    ).toContain('No agents are reporting live work');

    const discussions_tab = /** @type {HTMLButtonElement} */ (
      document.querySelector('[data-tab="discussions"]')
    );
    discussions_tab.click();

    expect(
      textOf(
        document.querySelector(
          '#agentwatch-panel-discussions .agentwatch-empty--panel'
        )
      )
    ).toContain('No shared discussions yet');
    view.destroy();
  });

  test('drops malformed actor, runtime, and discussion rows without hiding roster lanes', async () => {
    const client = makeClient();
    const valid_discussion = makePayload().discussions[0];
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: {},
            display_name: 'Malformed actor',
            issues: []
          },
          {
            actor: 'quiet-roster',
            display_name: 'Quiet Roster',
            registered: true,
            issues: [],
            runtime_sessions: [{}]
          }
        ],
        discussions: [valid_discussion, {}, { id: '', title: 'No identity' }]
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const cards = document.querySelectorAll('.agentwatch-card');
    expect(cards).toHaveLength(1);
    expect(textOf(cards[0])).toContain('Quiet Roster');
    expect(document.querySelector('.agentwatch-card--runtime')).toBeNull();
    expect(document.querySelector('.agentwatch-runtime-session')).toBeNull();
    expect(document.body.textContent).not.toContain('unknown agent');
    expect(document.body.textContent).not.toContain('unknown runtime');
    expect(
      document.querySelectorAll('.agentwatch-discussion-row')
    ).toHaveLength(1);
    view.destroy();
  });

  test('labels issue-active lanes with no agent reporting', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'issue-only',
            display_name: 'Issue Only',
            item_count: 1,
            issues: [
              {
                id: 'feads-no-runtime',
                title: 'Work without a live agent process',
                board_id: 'feads'
              }
            ]
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();

    expect(textOf(document.querySelector('.agentwatch-mini'))).toContain(
      'No agent reporting'
    );
    expect(document.body.textContent).not.toContain('phi');

    enterDetail();
    const card = document.querySelector('.agentwatch-card');
    expect(textOf(card)).toContain('No agent reporting.');
    expect(textOf(card)).not.toContain('No open work attached.');
    expect(textOf(card)).not.toContain('phi');
    view.destroy();
  });

  test('renders discussion labels, counts, excerpt, and recency', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    document
      .querySelector('[data-tab="discussions"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const discussion = document.querySelector('.agentwatch-discussion-row');
    const discussion_text = textOf(discussion).replace(/\s+/g, ' ');
    expect(discussion_text).toContain('Verify the shared rollout thread');
    expect(discussion_text).toContain('platform / feads-102');
    expect(discussion_text).toContain('fable · 2');
    expect(discussion_text).toContain('luna · 2');
    expect(discussion_text).toContain('2 participants');
    expect(discussion_text).toContain('4 comments');
    expect(discussion_text).toContain('The evidence is ready for review.');
    expect(discussion_text).toContain('Latest · luna');
    expect(discussion_text).toContain('just now');
    view.destroy();
  });

  test('renders server-provided agent grouping without regrouping client-side', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const cards = Array.from(document.querySelectorAll('.agentwatch-card'));
    expect(cards).toHaveLength(2);
    expect(textOf(cards[0])).toContain('Fable');
    expect(textOf(cards[0])).toContain('Prepare the executive brief');
    expect(textOf(cards[0])).not.toContain('Verify the shared rollout thread');
    expect(textOf(cards[1])).toContain('Luna');
    expect(textOf(cards[1])).toContain('Verify the shared rollout thread');
    expect(textOf(cards[1])).not.toContain('Prepare the executive brief');
    expect(
      cards.every(
        (card) => !card.classList.contains('agentwatch-card--runtime')
      )
    ).toBe(true);
    view.destroy();
  });

  test('maps heartbeats onto recency tiers and shows one focus issue', async () => {
    const client = makeClient();
    const now = Date.now();
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'fable',
            display_name: 'Fable',
            last_seen: now - 30_000,
            issues: [
              {
                id: 'feads-201',
                title: 'Latest touched work',
                board_id: 'platform',
                updated_at: now - 30_000
              },
              {
                id: 'feads-202',
                title: 'Older in-flight work',
                board_id: 'platform',
                updated_at: now - 3_600_000
              },
              {
                id: 'feads-203',
                title: 'Oldest in-flight work',
                board_id: 'platform',
                updated_at: now - 7_200_000
              }
            ]
          },
          {
            actor: 'luna',
            display_name: 'Luna',
            last_seen: now - 3 * 3_600_000,
            issues: [
              {
                id: 'feads-204',
                title: 'Cold work',
                board_id: 'platform',
                updated_at: now - 3 * 3_600_000
              }
            ]
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const cards = Array.from(document.querySelectorAll('.agentwatch-card'));
    expect(cards[0].classList.contains('agentwatch-card--now')).toBe(true);
    expect(textOf(cards[0].querySelector('.agentwatch-beat'))).toContain(
      'Active now'
    );
    expect(cards[1].classList.contains('agentwatch-card--idle')).toBe(true);
    expect(textOf(cards[1].querySelector('.agentwatch-beat'))).toContain(
      '3h ago'
    );

    // Only the newest issue shows; the remainder is collapsed behind a count.
    expect(textOf(cards[0])).toContain('Latest touched work');
    expect(textOf(cards[0])).not.toContain('Older in-flight work');
    const more = /** @type {HTMLButtonElement} */ (
      cards[0].querySelector('.agentwatch-card__more')
    );
    expect(textOf(more)).toContain('+2 more in flight');

    more.click();
    const expanded = document.querySelectorAll('.agentwatch-card')[0];
    expect(textOf(expanded)).toContain('Older in-flight work');
    expect(textOf(expanded)).toContain('Oldest in-flight work');
    expect(textOf(expanded.querySelector('.agentwatch-card__more'))).toContain(
      'Collapse'
    );
    view.destroy();
  });

  test('treats a live flare as active-now and renders flare-only lanes', async () => {
    const client = makeClient();
    const now = Date.now();
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'scout',
            last_seen: now - 20_000,
            flare: {
              actor: 'scout',
              board_id: 'platform',
              issue_id: 'feads-301',
              heartbeat_at: now - 20_000,
              liveness: 'live'
            },
            issues: []
          }
        ],
        discussions: []
      })
    );
    const goto_issue = vi.fn();
    const view = makeView(send, client, { gotoIssue: goto_issue });
    await view.load();
    enterDetail();

    const card = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-card')
    );
    expect(card.classList.contains('agentwatch-card--now')).toBe(true);
    expect(card.classList.contains('agentwatch-card--runtime')).toBe(false);
    expect(textOf(card)).toContain('Active now');
    expect(textOf(card)).toContain('feads-301');

    card
      .querySelector('.agentwatch-issue-row')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(goto_issue).toHaveBeenCalledWith('feads-301');
    view.destroy();
  });

  test('calls gotoIssue for issue and discussion click-through', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const goto_issue = vi.fn();
    const view = makeView(send, client, { gotoIssue: goto_issue });
    await view.load();
    enterDetail();

    document
      .querySelector('.agentwatch-issue-row')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(goto_issue).toHaveBeenCalledWith('feads-101');

    document
      .querySelector('[data-tab="discussions"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document
      .querySelector('.agentwatch-discussion-row')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(goto_issue).toHaveBeenLastCalledWith('feads-102');
    view.destroy();
  });

  test('renders a live update from the client event without a second watch', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      const send = vi.fn().mockResolvedValue(makePayload());
      const view = makeView(send, client);
      await view.load();
      enterDetail();

      client.emit(
        'agentwatch',
        makePayload({
          stats: { live_work: 7, active_agents: 2 },
          agents: [
            {
              actor: 'fable',
              display_name: 'Fable',
              status: 'working',
              issues: [
                {
                  id: 'feads-103',
                  title: 'New live work arrived',
                  board_id: 'platform',
                  status: 'active'
                }
              ]
            }
          ],
          discussions: []
        })
      );

      expect(
        textOf(
          document.querySelector(
            '[data-stat="live-work"] .agentwatch-pulse__value'
          )
        )
      ).toContain('7');
      expect(document.body.textContent).toContain('New live work arrived');
      expect(
        document
          .querySelector('.agentwatch-view')
          ?.classList.contains('agentwatch-view--updated')
      ).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(400);
      expect(
        document
          .querySelector('.agentwatch-view')
          ?.classList.contains('agentwatch-view--updated')
      ).toBe(false);
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('ignores pushed snapshots while isActive is false', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    let is_active = false;
    const view = makeView(send, client, { isActive: () => is_active });
    await view.load();
    enterDetail();

    client.emit(
      'agentwatch',
      makePayload({ stats: { live_work: 99 }, agents: [], discussions: [] })
    );
    expect(
      textOf(
        document.querySelector(
          '[data-stat="live-work"] .agentwatch-pulse__value'
        )
      )
    ).toContain('3');

    is_active = true;
    client.emit(
      'agentwatch',
      makePayload({ stats: { live_work: 99 }, agents: [], discussions: [] })
    );
    expect(
      textOf(
        document.querySelector(
          '[data-stat="live-work"] .agentwatch-pulse__value'
        )
      )
    ).toContain('99');
    view.destroy();
  });

  test('marks an old generated_at snapshot stale and a fresh event live', async () => {
    const client = makeClient();
    const stale_payload = makePayload({
      generated_at: new Date(Date.now() - 60_000).toISOString()
    });
    const send = vi.fn().mockResolvedValue(stale_payload);
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    expect(textOf(document.querySelector('.agentwatch-status'))).toContain(
      'Stale'
    );
    expect(document.querySelector('.agentwatch-status--stale')).not.toBeNull();

    client.emit('agentwatch', makePayload());

    expect(textOf(document.querySelector('.agentwatch-status'))).toContain(
      'Live'
    );
    expect(document.querySelector('.agentwatch-status--live')).not.toBeNull();
    view.destroy();
  });

  test('watches and unwatches idempotently', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const view = makeView(send, client);

    await Promise.all([view.load(), view.load(), view.load()]);
    expect(
      send.mock.calls.filter(([type]) => type === 'watch-agentwatch')
    ).toHaveLength(1);
    expect(client.on).toHaveBeenCalledTimes(1);

    await Promise.all([view.unload(), view.unload(), view.unload()]);
    expect(
      send.mock.calls.filter(([type]) => type === 'unwatch-agentwatch')
    ).toHaveLength(1);
    expect(client.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('cleans up the event handler and mount on destroy', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    view.destroy();
    const markup_after_destroy = document.body.innerHTML;

    expect(markup_after_destroy).not.toContain('agentwatch-view');
    expect(client.unsubscribe).toHaveBeenCalledTimes(1);
    expect(
      send.mock.calls.filter(([type]) => type === 'unwatch-agentwatch')
    ).toHaveLength(1);

    client.emit('agentwatch', makePayload({ stats: { live_work: 100 } }));
    expect(document.body.innerHTML).toBe(markup_after_destroy);
    view.destroy();
  });

  test('escapes server text through lit-html', async () => {
    const client = makeClient();
    const payload = makePayload({
      agents: [
        {
          actor: '<script>bad-agent</script>',
          display_name: '<img src=x onerror=alert(1)>',
          status: 'working',
          issues: [
            {
              id: 'feads-xss',
              title: '<b>Do not interpret this</b>',
              board_id: 'platform',
              status: 'active'
            }
          ]
        }
      ],
      discussions: [
        {
          issue_id: 'feads-xss',
          issue_title: '<i>Keep this as text</i>',
          board_id: 'platform',
          participants: ['<strong>agent</strong>', 'second-agent'],
          comment_count: 1,
          latest_author: '<em>author</em>',
          latest_excerpt: '<script>comment</script>',
          latest_at: new Date().toISOString()
        }
      ]
    });
    const send = vi.fn().mockResolvedValue(payload);
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<b>Do not interpret this</b>');
    expect(document.body.textContent).toContain('<script>comment</script>');
    // The name may legitimately appear inside attribute values (title,
    // aria-label); the DOM queries above prove it never parses as markup.
    view.destroy();
  });

  test('renders runtime-only and mixed lanes in server order with two sessions', async () => {
    const client = makeClient();
    const session_one = makeRuntimeSession({
      runtime_id: '019d14e7-882a-7b0d-a8b5-a86b6c07ff7a',
      main: makeRuntimeRow({
        display_name: 'sample controller review',
        model: 'example/sol',
        activity: 'subagent',
        context_percent: 37.2
      }),
      subagents: [
        makeRuntimeRow({
          run_id: 'report-backend-x7k2',
          handle: 'report-backend-x7k2',
          status: 'working',
          activity: 'bash',
          context_percent: 10
        }),
        makeRuntimeRow({
          run_id: 'report-ui-b2m8',
          handle: 'report-ui-b2m8',
          status: 'done',
          activity: 'edit',
          context_percent: 11,
          ended_at: Date.now() - 3_000,
          liveness: 'fading'
        })
      ]
    });
    const session_two = makeRuntimeSession({
      runtime_id: '019d14e7-882a-7b0d-a8b5-a86b6c07ff99',
      main: makeRuntimeRow({
        display_name: 'Cloud Lab audit',
        status: 'idle',
        model: 'example/terra',
        context_percent: 22,
        liveness: 'fading'
      }),
      subagents: [
        makeRuntimeRow({
          run_id: 'api-audit-q6v1',
          handle: 'api-audit-q6v1',
          status: 'done',
          context_percent: 9,
          ended_at: Date.now() - 4_000,
          liveness: 'fading'
        })
      ]
    });
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'alex-laptop',
            display_name: 'alex example Laptop',
            issues: [],
            runtime_sessions: [session_one, session_two]
          },
          {
            actor: 'mixed-principal',
            display_name: 'Mixed Principal',
            issues: [
              {
                id: 'feads-mixed',
                title: 'Keep issue focus at principal level',
                board_id: 'platform'
              }
            ],
            runtime_sessions: [makeRuntimeSession()]
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const cards = Array.from(document.querySelectorAll('.agentwatch-card'));
    expect(cards).toHaveLength(2);
    expect(cards[0].classList.contains('agentwatch-card--runtime')).toBe(true);
    expect(cards[1].classList.contains('agentwatch-card--runtime')).toBe(true);
    expect(textOf(cards[0])).toContain('alex example Laptop');
    expect(textOf(cards[0])).toContain('sample controller review');
    expect(textOf(cards[0])).toContain('Cloud Lab audit');
    expect(textOf(cards[0])).toContain('report-backend-x7k2');
    expect(textOf(cards[0])).toContain('report-ui-b2m8');
    expect(textOf(cards[0])).toContain('example/sol');
    expect(textOf(cards[0])).toContain('37% ctx');
    expect(textOf(cards[0])).toContain('Live');
    expect(textOf(cards[0])).toContain('bash');
    expect(textOf(cards[0])).toContain('10% ctx');
    expect(textOf(cards[0])).not.toContain('No open work attached.');
    expect(textOf(cards[1])).toContain('Keep issue focus at principal level');
    expect(textOf(cards[1])).toContain('Runtime sessions');

    const session_names = Array.from(
      document.querySelectorAll('.agentwatch-runtime-session h5')
    ).map((heading) => textOf(heading));
    expect(session_names).toEqual([
      'sample controller review',
      'Cloud Lab audit',
      'Runtime session'
    ]);
    expect(document.querySelector('[role="tree"]')).toBeNull();
    expect(
      document.querySelectorAll('.agentwatch-runtime-session')
    ).toHaveLength(3);
    view.destroy();
  });

  test('keeps child-before-main sessions visible and uses the agent short-id fallback', async () => {
    const client = makeClient();
    const runtime_id = '019d14e7-882a-7b0d-a8b5-a86b6c07ff7a';
    const child = makeRuntimeRow({
      run_id: 'child-first',
      handle: 'child-first',
      activity: 'edit'
    });
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'child-first-principal',
            issues: [],
            runtime_sessions: [
              makeRuntimeSession({ runtime_id, main: null, subagents: [child] })
            ]
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const session = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-runtime-session')
    );
    expect(textOf(session.querySelector('h5'))).toBe('agent · 019d…ff7a');
    expect(textOf(session)).toContain('Main session unavailable');
    expect(textOf(session)).toContain('child-first');
    expect(
      session
        .querySelector('.agentwatch-runtime-row')
        ?.getAttribute('data-runtime-kind')
    ).toBe('main-missing');
    expect(
      session
        .querySelector('.agentwatch-runtime-row--child')
        ?.getAttribute('data-runtime-kind')
    ).toBe('child');
    view.destroy();
  });

  test('renders every runtime status as text with an indicator and keeps row order', async () => {
    const statuses = [
      'working',
      'idle',
      'done',
      'failed',
      'aborted',
      'mystery'
    ];
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'status-principal',
            issues: [],
            runtime_sessions: [
              makeRuntimeSession({
                subagents: statuses.map((status, index) =>
                  makeRuntimeRow({
                    run_id: `status-${index}`,
                    handle: `status-${index}`,
                    status,
                    liveness: status === 'working' ? 'live' : 'fading'
                  })
                )
              })
            ]
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const rows = Array.from(
      document.querySelectorAll('.agentwatch-runtime-row--child')
    );
    expect(rows).toHaveLength(statuses.length);
    expect(rows.map((row) => row.getAttribute('data-runtime-status'))).toEqual([
      'working',
      'idle',
      'done',
      'failed',
      'aborted',
      'unknown'
    ]);
    expect(
      textOf(document.querySelector('.agentwatch-runtime-session'))
    ).toMatch(/working.*idle.*done.*failed.*aborted.*unknown/s);
    expect(
      document.querySelectorAll('.agentwatch-runtime-status__dot')
    ).toHaveLength(statuses.length + 1);
    expect(
      textOf(document.querySelector('.agentwatch-runtime-session'))
    ).toContain('Fading');
    view.destroy();
  });

  test('does not call a terminal-only lane Active now or count it as live', async () => {
    const now = Date.now();
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(
      makePayload({
        stats: { live_work: 0, active_agents: 0, discussions: 0 },
        agents: [
          {
            actor: 'completed-principal',
            issues: [],
            runtime_sessions: [
              makeRuntimeSession({
                last_seen: now - 2_000,
                main: makeRuntimeRow({
                  status: 'done',
                  ended_at: now - 2_000,
                  heartbeat_at: now - 2_000,
                  liveness: 'fading'
                }),
                subagents: [
                  makeRuntimeRow({
                    run_id: 'failed-child',
                    handle: 'failed-child',
                    status: 'failed',
                    ended_at: now - 2_000,
                    heartbeat_at: now - 2_000,
                    liveness: 'fading'
                  })
                ]
              })
            ]
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const card = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-card')
    );
    expect(card.classList.contains('agentwatch-card--now')).toBe(false);
    expect(textOf(card.querySelector('.agentwatch-beat'))).not.toContain(
      'Active now'
    );
    expect(textOf(card)).toContain('Completed recently');
    expect(
      textOf(document.querySelector('[data-stat="active-now"]'))
    ).toContain('0');
    view.destroy();
  });

  test('keeps runtime text safe and exposes full values through truncation titles', async () => {
    const client = makeClient();
    const html_like_name = '<img src=x onerror=alert(1)> long session name';
    const html_like_activity = '<script>steal()</script> safe activity';
    const html_like_handle = '<b>child</b>-handle';
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'safe-runtime-principal',
            display_name: 'Safe runtime principal',
            issues: [],
            runtime_sessions: [
              makeRuntimeSession({
                main: makeRuntimeRow({
                  display_name: html_like_name,
                  activity: html_like_activity
                }),
                subagents: [
                  makeRuntimeRow({
                    handle: html_like_handle,
                    activity: html_like_activity
                  })
                ]
              })
            ]
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain(html_like_name);
    expect(document.body.textContent).toContain(html_like_activity);
    expect(document.body.textContent).toContain(html_like_handle);
    expect(
      document
        .querySelector('.agentwatch-runtime-session h5')
        ?.getAttribute('title')
    ).toBe(html_like_name);
    expect(
      document
        .querySelector('.agentwatch-runtime-field--activity')
        ?.getAttribute('title')
    ).toBe(html_like_activity);
    expect(
      document
        .querySelector('.agentwatch-runtime-row--child strong')
        ?.getAttribute('title')
    ).toBe(html_like_handle);
    view.destroy();
  });

  test('uses the unchanged legacy card path when runtime_sessions is absent', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'legacy-principal',
            display_name: 'Legacy Principal',
            issues: []
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const card = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-card')
    );
    expect(document.querySelector('.agentwatch-runtime-sessions')).toBeNull();
    expect(card.classList.contains('agentwatch-card--runtime')).toBe(false);
    expect(textOf(card)).toContain('No open work attached.');
    expect(card.querySelector('.agentwatch-card__more')).toBeNull();

    // This is the origin/main no-runtime card shape. In particular, keep the
    // three Lit child-expression markers; an empty runtime interpolation would
    // add a fourth marker while leaving visible text unchanged.
    expect(
      Array.from(card.childNodes).map((node) => {
        if (node.nodeType === Node.COMMENT_NODE) return 'lit-marker';
        if (node.nodeType === Node.ELEMENT_NODE) {
          return node.nodeName.toLowerCase();
        }
        return 'text';
      })
    ).toEqual([
      'text',
      'div',
      'text',
      'lit-marker',
      'p',
      'text',
      'lit-marker',
      'text',
      'lit-marker',
      'text'
    ]);
    expect(
      Array.from(card.childNodes).filter(
        (node) => node.nodeType === Node.COMMENT_NODE
      )
    ).toHaveLength(3);
    view.destroy();
  });

  test('bounds long runtime-session headings for mobile truncation', async () => {
    const client = makeClient();
    const long_name =
      'A very long runtime session heading that must visibly ellipsize on a 390px viewport';
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'mobile-runtime',
            issues: [],
            runtime_sessions: [
              makeRuntimeSession({
                main: makeRuntimeRow({ display_name: long_name })
              })
            ]
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const heading = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-runtime-session h5')
    );
    expect(heading.textContent).toBe(long_name);
    expect(heading.getAttribute('title')).toBe(long_name);
    expect(heading.tagName).toBe('H5');
    expect(
      heading.parentElement?.classList.contains(
        'agentwatch-runtime-session__identity'
      )
    ).toBe(true);
    expect(document.querySelector('.agentwatch-card--runtime')).not.toBeNull();
    view.destroy();
  });

  test('defaults to the compact wall with per-agent glance stats', async () => {
    const client = makeClient();
    const now = Date.now();
    const send = vi.fn().mockResolvedValue(
      makePayload({
        agents: [
          {
            actor: 'alex-laptop',
            display_name: 'alex example Laptop',
            item_count: 2,
            issues: [
              {
                id: 'feads-401',
                title: 'Ship the wall',
                board_id: 'feads',
                updated_at: now - 10_000
              }
            ],
            runtime_sessions: [
              makeRuntimeSession({
                subagents: [
                  makeRuntimeRow({
                    run_id: 'sub-live',
                    handle: 'sub-live',
                    activity: 'bash',
                    heartbeat_at: now - 1_000
                  }),
                  makeRuntimeRow({
                    run_id: 'sub-done',
                    handle: 'sub-done',
                    status: 'done',
                    liveness: 'fading',
                    ended_at: now - 1_000
                  })
                ]
              })
            ]
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();

    expect(
      document
        .querySelector('[data-mode="compact"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    expect(document.querySelector('.agentwatch-compact-grid')).not.toBeNull();
    expect(document.querySelector('.agentwatch-card')).toBeNull();
    const mini = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-mini')
    );
    expect(mini.getAttribute('data-agent')).toBe('alex-laptop');
    expect(mini.classList.contains('agentwatch-mini--now')).toBe(true);
    expect(textOf(mini.querySelector('[data-mini-stat="sessions"]'))).toContain(
      '1'
    );
    expect(
      textOf(mini.querySelector('[data-mini-stat="subagents"]'))
    ).toContain('1');
    expect(textOf(mini.querySelector('[data-mini-stat="issues"]'))).toContain(
      '2'
    );
    const session_line = mini.querySelector('.agentwatch-mini__session');
    expect(textOf(session_line)).toContain('Runtime session');
    expect(
      textOf(session_line?.querySelector('.agentwatch-mini__session-activity'))
    ).toContain('bash');
    expect(textOf(mini.querySelector('.agentwatch-mini__foot'))).toContain(
      'Ship the wall'
    );

    enterDetail();
    expect(document.querySelector('.agentwatch-mini')).toBeNull();
    expect(document.querySelector('.agentwatch-card--runtime')).not.toBeNull();
    document
      .querySelector('[data-mode="compact"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.agentwatch-mini')).not.toBeNull();
    view.destroy();
  });

  test('opens the single-agent modal from a compact card and closes it', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const view = makeView(send, client);
    await view.load();

    const mini = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-mini[data-agent="fable"]')
    );
    mini.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const modal = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-modal')
    );
    expect(modal).not.toBeNull();
    expect(modal.querySelector('[role="dialog"]')).not.toBeNull();
    expect(textOf(modal)).toContain('Fable');
    expect(textOf(modal)).toContain('Prepare the executive brief');
    expect(modal.querySelector('.agentwatch-card')).not.toBeNull();
    expect(modal.querySelector('.agentwatch-card__expand')).toBeNull();
    expect(document.activeElement).toBe(
      modal.querySelector('.agentwatch-modal__close')
    );

    // A click inside the dialog stays open; the backdrop closes it.
    modal
      .querySelector('.agentwatch-modal__dialog')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.agentwatch-modal')).not.toBeNull();
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.agentwatch-modal')).toBeNull();

    // Reopen and close with Escape.
    mini.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document
      .querySelector('.agentwatch-modal')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.agentwatch-modal')).toBeNull();
    view.destroy();
  });

  test('opens the modal from the detailed grid expand control', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const expand = /** @type {HTMLButtonElement} */ (
      document.querySelector('.agentwatch-card .agentwatch-card__expand')
    );
    expect(expand).not.toBeNull();
    expand.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const modal = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-modal')
    );
    expect(textOf(modal)).toContain('Fable');
    expect(modal.querySelector('.agentwatch-card')).not.toBeNull();
    view.destroy();
  });

  test('shows registered-but-quiet actors as inactive cards with the roster stat', async () => {
    const client = makeClient();
    const now = Date.now();
    const send = vi.fn().mockResolvedValue(
      makePayload({
        stats: { live_work: 0, active_agents: 0, registered_agents: 5 },
        agents: [
          {
            actor: 'quiet-agent',
            display_name: 'Quiet Agent',
            registered: true,
            kind: 'agent',
            last_seen: now - 3 * 86_400_000,
            item_count: 0,
            issues: []
          }
        ],
        discussions: []
      })
    );
    const view = makeView(send, client);
    await view.load();

    expect(
      textOf(
        document.querySelector(
          '[data-stat="registered"] .agentwatch-pulse__value'
        )
      )
    ).toContain('5');
    const mini = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-mini')
    );
    expect(mini.classList.contains('agentwatch-mini--inactive')).toBe(true);
    expect(textOf(mini)).toContain('Quiet Agent');
    expect(
      mini.querySelector('.agentwatch-mini__session-empty')
    ).not.toBeNull();
    expect(textOf(mini.querySelector('.agentwatch-mini__foot'))).toContain(
      'Last seen 3d ago'
    );
    view.destroy();
  });

  test('remembers the selected density across view instances', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const first_view = makeView(send, client);
    await first_view.load();
    enterDetail();
    first_view.destroy();

    const second_view = makeView(
      vi.fn().mockResolvedValue(makePayload()),
      makeClient()
    );
    expect(
      document
        .querySelector('[data-mode="detail"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    second_view.destroy();
  });
});

describe('views/agentwatch under accounts mode (post-ship 2026-10-06)', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // Storage may be unavailable in some environments.
    }
  });
  afterEach(() => {
    setOwnerDirectory([]);
  });

  test('an alias lane is named as its person, the agent as "via"; discussions too', async () => {
    setOwnerDirectory([
      { actor: 'mira', display_name: 'alex', aliases: ['fable'] },
      { actor: 'dana', display_name: 'dana', aliases: ['luna'] }
    ]);
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(makePayload());
    const view = makeView(send, client);
    await view.load();

    const mini = document.querySelector('.agentwatch-mini[data-agent="fable"]');
    expect(mini).not.toBeNull();
    expect(textOf(mini?.querySelector('.agentwatch-mini__name') || null)).toBe(
      'alex'
    );
    expect(
      textOf(mini?.querySelector('.agentwatch-mini__handle') || null).trim()
    ).toBe('via fable');
    expect(String(mini?.getAttribute('aria-label'))).toContain('alex');

    enterDetail();
    const card = document.querySelector('[data-agent="fable"]');
    expect(textOf(card?.querySelector('h3') || null)).toBe('alex');
    expect(textOf(card?.querySelector('code') || null)).toBe('via fable');

    document
      .querySelector('[data-tab="discussions"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const body = String(document.body.textContent);
    expect(body).toContain('Latest · dana (via luna)');
    expect(body).toContain('mira (via fable)');
    view.destroy();
  });
});

describe('views/agentwatch presence errors and folded aliases', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // Storage may be unavailable in some environments.
    }
  });
  afterEach(() => {
    setOwnerDirectory([]);
  });

  /**
   * @param {Record<string, any>} agent
   */
  function payloadWith(agent) {
    return makePayload({ agents: [agent], discussions: [] });
  }

  test('shows rejected heartbeats instead of "No agent reporting" on every density', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(
      payloadWith({
        actor: 'carol',
        display_name: 'carol',
        item_count: 1,
        issues: [
          { id: 'ex-1', title: 'Busy', board_id: 'example', priority: 1 }
        ],
        presence_error: {
          at: Date.now() - 3 * 60_000,
          status: 400,
          error: 'bad_request',
          client: 'p3'
        }
      })
    );
    const view = makeView(send, client);
    await view.load();

    const mini = document.querySelector('.agentwatch-mini');
    const warning = mini?.querySelector('[data-presence-error]');
    expect(textOf(warning || null).trim()).toBe(
      'Heartbeats rejected · 400 bad_request · 3m ago'
    );
    expect(textOf(mini || null)).not.toContain('No agent reporting');

    enterDetail();
    const card = document.querySelector('.agentwatch-card');
    expect(
      textOf(card?.querySelector('[data-presence-error]') || null).trim()
    ).toBe('Heartbeats rejected · 400 bad_request · 3m ago');
    expect(textOf(card)).not.toContain('No agent reporting');

    card
      ?.querySelector('.agentwatch-card__expand')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const modal = document.querySelector('.agentwatch-modal');
    expect(textOf(modal)).toContain('Heartbeats rejected · 400 bad_request');
    view.destroy();
  });

  test('keeps the no-runtime card marker structure with a presence error', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(
      payloadWith({
        actor: 'quiet',
        display_name: 'Quiet',
        issues: [],
        presence_error: { at: Date.now(), status: 409, error: 'conflict' }
      })
    );
    const view = makeView(send, client);
    await view.load();
    enterDetail();

    const card = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-card')
    );
    expect(textOf(card)).toContain(
      'Heartbeats rejected · 409 conflict · just now'
    );
    expect(textOf(card)).not.toContain('No open work attached.');
    expect(
      Array.from(card.childNodes).filter(
        (node) => node.nodeType === Node.COMMENT_NODE
      )
    ).toHaveLength(3);
    view.destroy();
  });

  test('counts uncapped work when the bounded list carries none of it', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(
      payloadWith({
        actor: 'busy',
        display_name: 'Busy',
        item_count: 312,
        issues: []
      })
    );
    const view = makeView(send, client);
    await view.load();

    expect(
      textOf(document.querySelector('[data-mini-stat="issues"] strong'))
    ).toBe('312');
    enterDetail();
    expect(textOf(document.querySelector('.agentwatch-card'))).toContain(
      '312 issues in flight.'
    );
    view.destroy();
  });

  test('names a folded lane by its person and lists its aliases in the modal', async () => {
    // The client directory still knows the aliases; a lane the server already
    // folded must not be renamed "via …" a second time.
    setOwnerDirectory([
      {
        actor: 'carol',
        display_name: 'carol Rees',
        aliases: ['carol', 'carol-cursor-example2']
      }
    ]);
    const client = makeClient();
    const send = vi.fn().mockResolvedValue(
      payloadWith({
        actor: 'carol',
        display_name: 'carol Rees',
        item_count: 2,
        aliases: ['carol-cursor-example2', 'carol'],
        issues: [
          { id: 'ex-alias', title: 'Alias work', board_id: 'example' },
          { id: 'ex-own', title: 'Own work', board_id: 'example' }
        ]
      })
    );
    const view = makeView(send, client);
    await view.load();

    const mini = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-mini[data-agent="carol"]')
    );
    const handle = mini.querySelector('.agentwatch-mini__handle');
    expect(textOf(handle).trim()).toBe('carol');
    expect(handle?.getAttribute('title')).toBe(
      'carol · also as carol-cursor-example2, carol'
    );
    mini.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const modal = /** @type {HTMLElement} */ (
      document.querySelector('.agentwatch-modal')
    );
    expect(textOf(modal.querySelector('h2'))).toBe('carol Rees');
    expect(textOf(modal.querySelector('.agentwatch-modal__aliases'))).toBe(
      'also as carol-cursor-example2, carol'
    );
    expect(textOf(modal)).toContain('Alias work');
    expect(textOf(modal)).toContain('+1 more in flight');
    view.destroy();
  });
});
