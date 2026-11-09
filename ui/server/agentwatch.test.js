import { describe, expect, test, vi } from 'vitest';
import { fetchAgentwatchSnapshot } from './agentwatch.js';

/**
 * @typedef {Object} FakeStoreData
 * @property {Array<Record<string, unknown>>} active_rows
 * @property {Array<Record<string, unknown>>} discussion_rows
 * @property {Array<Record<string, unknown>>} [count_rows] - uncapped
 * per-actor, per-board counts; none by default
 */

/**
 * @typedef {Object} FakeStore
 * @property {Array<{ text: string, values: unknown[] }>} calls
 * @property {(text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>} query
 */

/**
 * Build a fake Postgres store that returns one result for each bounded query.
 *
 * @param {FakeStoreData} data - Rows to return.
 * @returns {FakeStore}
 */
function createStore(data) {
  /** @type {Array<{ text: string, values: unknown[] }>} */
  const calls = [];
  const query = vi.fn(async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes('GROUP BY BTRIM(i.assignee), i.board_id')) {
      return { rows: data.count_rows || [] };
    }
    return {
      rows: text.includes('candidate_discussions')
        ? data.discussion_rows
        : data.active_rows
    };
  });
  return { calls, query };
}

const ACTIVE_ISSUE = {
  id: 'ex-1',
  board_id: 'example',
  title: 'Active issue',
  status: 'in_progress',
  priority: 1,
  issue_type: 'task',
  updated_at: '2026-01-02T00:00:00.000Z',
  started_at: '2026-01-01T00:00:00.000Z',
  comment_count: 2
};

const DISCUSSION = {
  id: 'ex-discussion',
  board_id: 'example',
  title: 'Shared thread',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  updated_at: '2026-01-02T00:00:00.000Z',
  comment_count: 3,
  participants: [
    {
      actor: 'alice',
      comment_count: 1,
      last_commented_at: '2026-01-01T00:00:00.000Z'
    },
    {
      actor: 'bob',
      comment_count: 2,
      last_commented_at: '2026-01-02T00:00:00.000Z'
    }
  ],
  latest_comment: {
    author: 'bob',
    body: 'Latest reply',
    created_at: '2026-01-02T00:00:00.000Z'
  }
};

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function runtimeRow(overrides = {}) {
  const row = {
    agent_id: 'owner-secret-must-not-leak',
    actor: 'alex-laptop',
    session_id: 'session-1',
    runtime_id: 'runtime-1',
    run_id: 'runtime-1',
    parent_run_id: '',
    kind: 'main',
    handle: 'main',
    display_name: 'Session name',
    status: 'working',
    model: 'example/sol',
    activity: 'thinking',
    context_percent: 37.2,
    started_at: 100,
    ended_at: 0,
    heartbeat_at: 400,
    liveness: 'live',
    arbitrary_secret: 'do-not-publish'
  };
  return { ...row, ...overrides };
}

describe('fetchAgentwatchSnapshot', () => {
  test('returns grouped agents and stable newest-first ordering', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'bob',
          item_count: 2,
          latest_activity: '2026-01-02T00:00:00.000Z',
          issues: [
            { ...ACTIVE_ISSUE, id: 'ex-z', updated_at: '2026-01-01T00:00:00Z' },
            { ...ACTIVE_ISSUE, id: 'ex-a', updated_at: '2026-01-03T00:00:00Z' }
          ]
        },
        {
          actor: 'alice',
          item_count: 1,
          latest_activity: '2026-01-03T00:00:00.000Z',
          issues: [{ ...ACTIVE_ISSUE, id: 'ex-b' }]
        }
      ],
      discussion_rows: [
        {
          ...DISCUSSION,
          id: 'ex-old',
          latest_comment: {
            ...DISCUSSION.latest_comment,
            created_at: '2026-01-01T00:00:00Z'
          }
        },
        DISCUSSION
      ]
    });

    const snapshot = await fetchAgentwatchSnapshot(store, {
      generated_at: 123
    });

    expect(snapshot.generated_at).toBe(123);
    expect(snapshot.agents.map((agent) => agent.actor)).toEqual([
      'alice',
      'bob'
    ]);
    const bob_agent = snapshot.agents.at(1);
    if (!bob_agent) {
      throw new Error('expected bob agent');
    }
    expect(bob_agent.issues.map((issue) => issue.id)).toEqual(['ex-a', 'ex-z']);
    expect(snapshot.discussions.map((discussion) => discussion.id)).toEqual([
      'ex-discussion',
      'ex-old'
    ]);
    expect(snapshot.stats).toEqual({
      active_agents: 2,
      registered_agents: 0,
      active_issues: 3,
      shared_discussions: 2
    });
  });

  test('encodes lifecycle, author, and tombstone exclusions in SQL', async () => {
    const store = createStore({ active_rows: [], discussion_rows: [] });

    await fetchAgentwatchSnapshot(store, { generated_at: 123 });

    const active_call = store.calls.find((call) =>
      call.text.includes('active_items')
    );
    const discussion_call = store.calls.find((call) =>
      call.text.includes('candidate_discussions')
    );
    if (!active_call || !discussion_call) {
      throw new Error('expected both Agentwatch queries');
    }
    const active_sql = active_call.text;
    const discussion_sql = discussion_call.text;
    expect(active_sql).toContain('GROUP BY actor');
    expect(active_sql).toContain('jsonb_agg(');
    expect(active_sql).toContain(
      'ORDER BY MAX(updated_at) DESC NULLS LAST, actor ASC'
    );
    expect(active_sql).toContain('i.deleted_at IS NULL');
    expect(active_sql).toContain("i.status = 'in_progress'");
    expect(active_sql).toContain("NULLIF(BTRIM(i.assignee), '') IS NOT NULL");
    expect(discussion_sql).toContain(
      'ORDER BY d.latest_comment_at DESC NULLS LAST, d.id ASC'
    );
    expect(discussion_sql).toContain('i.deleted_at IS NULL');
    expect(discussion_sql).toContain("i.status <> 'closed'");
    expect(discussion_sql).toContain(
      "COUNT(DISTINCT NULLIF(LOWER(BTRIM(c.author)), '')) >= 2"
    );
    expect(discussion_sql).toContain('LEFT(c.body, 360) AS body');
  });

  test('uses bounded queries and returns a compact projection', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'alice',
          item_count: 1,
          latest_activity: 100,
          issues: [{ ...ACTIVE_ISSUE, description: 'secret prose' }]
        }
      ],
      discussion_rows: [
        {
          ...DISCUSSION,
          notes: 'secret notes',
          latest_comment: { ...DISCUSSION.latest_comment, description: 'nope' }
        }
      ]
    });

    const snapshot = await fetchAgentwatchSnapshot(store, { generated_at: 1 });

    expect(store.calls).toHaveLength(3);
    expect(store.calls.map((call) => call.values)).toEqual([[250], [], [100]]);
    for (const call of store.calls) {
      expect(call.text).not.toMatch(
        /description|design|notes|acceptance_criteria/
      );
    }
    // The detail lists are bounded; the per-actor counts are one aggregate row
    // per actor and board, so they need no cap.
    expect(store.calls[0].text).toContain('LIMIT $1');
    expect(store.calls[2].text).toContain('LIMIT $1');
    expect(store.calls[1].text).not.toContain('LIMIT');
    expect(store.calls[1].text).toContain('COUNT(*)::int AS item_count');
    expect(Object.keys(snapshot.agents[0].issues[0]).sort()).toEqual([
      'board_id',
      'comment_count',
      'id',
      'issue_type',
      'priority',
      'started_at',
      'status',
      'title',
      'updated_at'
    ]);
    expect(Object.keys(snapshot.discussions[0].latest_comment).sort()).toEqual([
      'author',
      'body',
      'created_at'
    ]);
  });

  test('maps distinct participants and latest comment fields', async () => {
    const store = createStore({
      active_rows: [],
      discussion_rows: [DISCUSSION]
    });

    const snapshot = await fetchAgentwatchSnapshot(store, { generated_at: 1 });

    expect(snapshot.discussions[0].participants).toEqual([
      {
        actor: 'alice',
        comment_count: 1,
        last_commented_at: Date.parse('2026-01-01T00:00:00.000Z')
      },
      {
        actor: 'bob',
        comment_count: 2,
        last_commented_at: Date.parse('2026-01-02T00:00:00.000Z')
      }
    ]);
    expect(snapshot.discussions[0].latest_comment).toEqual({
      author: 'bob',
      body: 'Latest reply',
      created_at: Date.parse('2026-01-02T00:00:00.000Z')
    });
  });

  test('returns empty collections and zero stats for empty query results', async () => {
    const store = createStore({ active_rows: [], discussion_rows: [] });

    const snapshot = await fetchAgentwatchSnapshot(store, { generated_at: 7 });

    expect(snapshot).toEqual({
      generated_at: 7,
      stats: {
        active_agents: 0,
        registered_agents: 0,
        active_issues: 0,
        shared_discussions: 0
      },
      agents: [],
      discussions: []
    });
  });

  test('merges flare heartbeats into last_seen and resorts by recency', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'alice',
          item_count: 1,
          latest_activity: '2026-01-03T00:00:00.000Z',
          issues: [{ ...ACTIVE_ISSUE, id: 'ex-b' }]
        },
        {
          actor: 'bob',
          item_count: 1,
          latest_activity: '2026-01-02T00:00:00.000Z',
          issues: [{ ...ACTIVE_ISSUE, id: 'ex-z' }]
        }
      ],
      discussion_rows: []
    });
    const bob_heartbeat = Date.parse('2026-01-04T00:00:00.000Z');

    const snapshot = await fetchAgentwatchSnapshot(store, {
      generated_at: 1,
      flares: [
        {
          actor: 'bob',
          board_id: 'example',
          issue_id: 'ex-z',
          heartbeat_at: bob_heartbeat,
          liveness: 'live'
        },
        {
          actor: 'bob',
          board_id: 'example',
          issue_id: 'ex-q',
          heartbeat_at: bob_heartbeat - 1000,
          liveness: 'fading'
        }
      ]
    });

    expect(snapshot.agents.map((agent) => agent.actor)).toEqual([
      'bob',
      'alice'
    ]);
    const bob_agent = snapshot.agents[0];
    expect(bob_agent.last_seen).toBe(bob_heartbeat);
    expect(bob_agent.latest_activity).toBe(
      Date.parse('2026-01-02T00:00:00.000Z')
    );
    expect(bob_agent.flare).toEqual({
      actor: 'bob',
      board_id: 'example',
      issue_id: 'ex-z',
      heartbeat_at: bob_heartbeat,
      liveness: 'live'
    });
    const alice_agent = snapshot.agents[1];
    expect(alice_agent.flare).toBeNull();
    expect(alice_agent.last_seen).toBe(alice_agent.latest_activity);
  });

  test('creates a lane for a flare-only actor and drops malformed flares', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'alice',
          item_count: 1,
          latest_activity: '2026-01-01T00:00:00.000Z',
          issues: [{ ...ACTIVE_ISSUE, id: 'ex-b' }]
        }
      ],
      discussion_rows: []
    });
    const heartbeat = Date.parse('2026-01-05T00:00:00.000Z');

    const snapshot = await fetchAgentwatchSnapshot(store, {
      generated_at: 1,
      flares: [
        {
          actor: 'scout',
          board_id: 'feads',
          issue_id: 'fd-7',
          heartbeat_at: heartbeat,
          liveness: 'live'
        },
        { actor: '   ', heartbeat_at: heartbeat, liveness: 'live' },
        { actor: 'ghost', heartbeat_at: 'not-a-timestamp', liveness: 'live' },
        'not-a-flare'
      ]
    });

    expect(snapshot.agents.map((agent) => agent.actor)).toEqual([
      'scout',
      'alice'
    ]);
    const scout_lane = snapshot.agents[0];
    expect(scout_lane.issues).toEqual([]);
    expect(scout_lane.item_count).toBe(0);
    expect(scout_lane.last_seen).toBe(heartbeat);
    expect(scout_lane.flare?.issue_id).toBe('fd-7');
    expect(snapshot.stats.active_agents).toBe(2);
  });

  test('converts invalid and null timestamps to numeric zero', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'alice',
          item_count: 1,
          latest_activity: null,
          issues: [
            {
              ...ACTIVE_ISSUE,
              updated_at: 'not-a-timestamp',
              started_at: null
            }
          ]
        }
      ],
      discussion_rows: [
        {
          ...DISCUSSION,
          participants: [
            { actor: 'alice', comment_count: 1, last_commented_at: null },
            { actor: 'bob', comment_count: 1, last_commented_at: 'invalid' }
          ],
          latest_comment: { author: null, body: 'body', created_at: null }
        }
      ]
    });

    const snapshot = await fetchAgentwatchSnapshot(store, { generated_at: 1 });

    expect(snapshot.agents[0].latest_activity).toBe(0);
    expect(snapshot.agents[0].issues[0].updated_at).toBe(0);
    expect(snapshot.agents[0].issues[0].started_at).toBe(0);
    expect(snapshot.discussions[0].participants).toEqual([
      { actor: 'alice', comment_count: 1, last_commented_at: 0 },
      { actor: 'bob', comment_count: 1, last_commented_at: 0 }
    ]);
    expect(snapshot.discussions[0].latest_comment).toEqual({
      author: '',
      body: 'body',
      created_at: 0
    });
    expect(typeof snapshot.agents[0].latest_activity).toBe('number');
  });

  test('groups runtime-only, mixed, terminal, and concurrent incarnation lanes', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'mixed',
          item_count: 1,
          latest_activity: 100,
          issues: [{ ...ACTIVE_ISSUE, id: 'mixed-issue', updated_at: 100 }]
        }
      ],
      discussion_rows: []
    });

    const snapshot = await fetchAgentwatchSnapshot(store, {
      generated_at: 500,
      runtime_presence: [
        runtimeRow({
          actor: 'mixed',
          session_id: 'session-1',
          runtime_id: 'runtime-1',
          run_id: 'child-terminal',
          parent_run_id: 'runtime-1',
          kind: 'subagent',
          handle: 'terminal-child',
          status: 'done',
          heartbeat_at: 450,
          ended_at: 450,
          liveness: 'terminal'
        }),
        runtimeRow({
          actor: 'mixed',
          session_id: 'session-1',
          runtime_id: 'runtime-1',
          run_id: 'child-active',
          parent_run_id: 'runtime-1',
          kind: 'subagent',
          handle: 'active-child',
          heartbeat_at: 300
        }),
        runtimeRow({
          actor: 'mixed',
          session_id: 'session-1',
          runtime_id: 'runtime-1',
          heartbeat_at: 400
        }),
        runtimeRow({
          actor: 'mixed',
          session_id: 'session-1',
          runtime_id: 'runtime-2',
          run_id: 'runtime-2',
          heartbeat_at: 200,
          display_name: 'Second incarnation'
        }),
        runtimeRow({
          actor: 'runtime-only',
          session_id: 'runtime-session',
          runtime_id: 'runtime-only-1',
          run_id: 'runtime-only-1',
          heartbeat_at: 350
        }),
        runtimeRow({
          actor: 'terminal-only',
          session_id: 'terminal-session',
          runtime_id: 'terminal-runtime',
          run_id: 'terminal-runtime',
          status: 'failed',
          ended_at: 250,
          heartbeat_at: 250,
          liveness: 'terminal'
        })
      ]
    });

    expect(snapshot.agents.map((agent) => agent.actor)).toEqual([
      'mixed',
      'runtime-only',
      'terminal-only'
    ]);
    const mixed = snapshot.agents[0];
    expect(
      mixed.runtime_sessions?.map((session) => session.runtime_id)
    ).toEqual(['runtime-1', 'runtime-2']);
    expect(mixed.runtime_sessions?.[0]).toMatchObject({
      session_id: 'session-1',
      runtime_id: 'runtime-1',
      last_seen: 450,
      main: expect.objectContaining({
        run_id: 'runtime-1',
        handle: 'main',
        display_name: 'Session name',
        status: 'working',
        liveness: 'live'
      })
    });
    expect(
      mixed.runtime_sessions?.[0].subagents.map((row) => row.run_id)
    ).toEqual(['child-active', 'child-terminal']);
    expect(mixed.runtime_sessions?.[1].main?.display_name).toBe(
      'Second incarnation'
    );
    expect(snapshot.agents[1].issues).toEqual([]);
    expect(snapshot.agents[2].runtime_sessions?.[0].main?.status).toBe(
      'failed'
    );
    expect(snapshot.stats).toEqual({
      active_agents: 2,
      registered_agents: 0,
      active_issues: 1,
      shared_discussions: 0
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('owner-secret-must-not-leak');
    expect(serialized).not.toContain('arbitrary_secret');
    expect(serialized).not.toContain('do-not-publish');
    expect(Object.keys(mixed.runtime_sessions?.[0].main || {}).sort()).toEqual([
      'activity',
      'client',
      'context_percent',
      'display_name',
      'ended_at',
      'handle',
      'heartbeat_at',
      'liveness',
      'model',
      'run_id',
      'started_at',
      'status'
    ]);
  });

  test('passes the runtime client through and defaults it to empty', async () => {
    const store = createStore({ active_rows: [], discussion_rows: [] });
    const legacy = runtimeRow({ actor: 'legacy', session_id: 'legacy' });
    delete legacy.client;
    const snapshot = await fetchAgentwatchSnapshot(store, {
      generated_at: 1,
      runtime_presence: [
        runtimeRow({ actor: 'p3-user', client: 'p3' }),
        runtimeRow({ actor: 'forca-user', client: 'forca' }),
        legacy,
        runtimeRow({ actor: 'bad-client', client: 42 })
      ]
    });
    const clients = Object.fromEntries(
      snapshot.agents.map((item) => [
        item.actor,
        item.runtime_sessions?.[0].main?.client
      ])
    );
    expect(clients).toEqual({
      'p3-user': 'p3',
      'forca-user': 'forca',
      legacy: '',
      'bad-client': ''
    });
  });

  test('retains a child-only session until its main row arrives', async () => {
    const store = createStore({ active_rows: [], discussion_rows: [] });
    const snapshot = await fetchAgentwatchSnapshot(store, {
      generated_at: 1,
      runtime_presence: [
        runtimeRow({
          actor: 'child-owner',
          session_id: 'child-session',
          runtime_id: 'child-runtime',
          run_id: 'child-run',
          parent_run_id: 'child-runtime',
          kind: 'subagent'
        })
      ]
    });

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0].runtime_sessions).toEqual([
      expect.objectContaining({
        session_id: 'child-session',
        runtime_id: 'child-runtime',
        main: null,
        subagents: [expect.objectContaining({ run_id: 'child-run' })]
      })
    ]);
    expect(snapshot.stats.active_agents).toBe(1);
  });

  test('drops malformed runtime rows without removing issue lanes', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'alice',
          item_count: 1,
          latest_activity: 100,
          issues: [{ ...ACTIVE_ISSUE, id: 'alice-issue', updated_at: 100 }]
        }
      ],
      discussion_rows: []
    });

    const snapshot = await fetchAgentwatchSnapshot(store, {
      generated_at: 1,
      runtime_presence: [
        runtimeRow({ actor: 'alice', context_percent: 'secret' }),
        runtimeRow({ actor: {}, heartbeat_at: 900 }),
        runtimeRow({
          actor: 'alice',
          kind: 'subagent',
          run_id: 'orphan',
          parent_run_id: 'wrong-runtime'
        }),
        { agent_id: 'owner-secret-must-not-leak', arbitrary: 'bad' }
      ]
    });

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0].actor).toBe('alice');
    expect(snapshot.agents[0].issues.map((issue) => issue.id)).toEqual([
      'alice-issue'
    ]);
    expect(snapshot.agents[0]).not.toHaveProperty('runtime_sessions');
    expect(snapshot.stats.active_agents).toBe(1);
  });

  test('merges the registered roster as always-present inactive lanes', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'alice',
          item_count: 1,
          latest_activity: 500,
          issues: [{ ...ACTIVE_ISSUE, id: 'alice-issue', updated_at: 500 }]
        }
      ],
      discussion_rows: []
    });

    const snapshot = await fetchAgentwatchSnapshot(store, {
      generated_at: 1,
      roster: [
        {
          actor: 'alice',
          display_name: 'Alice',
          kind: 'human',
          last_seen_at: 90,
          token_hash: 'roster-secret-must-not-leak',
          host: 'laptop.internal'
        },
        {
          actor: 'alice',
          display_name: '',
          kind: 'human',
          last_seen_at: 900
        },
        // The same actor on a second board is one roster entry, newest wins.
        {
          actor: 'quiet-agent',
          display_name: '',
          kind: 'agent',
          last_seen_at: 200
        },
        {
          actor: 'quiet-agent',
          display_name: 'Quiet Agent',
          kind: 'agent',
          last_seen_at: 300
        },
        {
          actor: '   ',
          display_name: 'Blank actors are dropped',
          last_seen_at: 5
        }
      ]
    });

    expect(snapshot.agents.map((agent) => agent.actor)).toEqual([
      'alice',
      'quiet-agent'
    ]);
    const alice = snapshot.agents[0];
    expect(alice.registered).toBe(true);
    expect(alice.kind).toBe('human');
    expect(alice.display_name).toBe('Alice');
    expect(alice.last_seen).toBe(900);
    expect(alice.issues).toHaveLength(1);
    const quiet = snapshot.agents[1];
    expect(quiet.registered).toBe(true);
    expect(quiet.kind).toBe('agent');
    expect(quiet.display_name).toBe('Quiet Agent');
    expect(quiet.last_seen).toBe(300);
    expect(quiet.issues).toEqual([]);
    expect(quiet.item_count).toBe(0);
    expect(snapshot.stats.active_agents).toBe(1);
    expect(snapshot.stats.registered_agents).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain(
      'roster-secret-must-not-leak'
    );
    expect(JSON.stringify(snapshot)).not.toContain('laptop.internal');
  });
});

describe('fetchAgentwatchSnapshot counts', () => {
  test('counts in-progress issues per actor past the 250-row list bound', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'alice',
          item_count: 2,
          latest_activity: 500,
          issues: [
            { ...ACTIVE_ISSUE, id: 'ex-1', updated_at: 500 },
            { ...ACTIVE_ISSUE, id: 'ex-2', updated_at: 400 }
          ]
        }
      ],
      count_rows: [
        { actor: 'alice', board_id: 'example', item_count: 300 },
        { actor: 'alice', board_id: 'lab', item_count: 12 },
        { actor: 'bob', board_id: 'lab', item_count: 4, latest_activity: 90 }
      ],
      discussion_rows: []
    });

    const snapshot = await fetchAgentwatchSnapshot(store, { generated_at: 1 });

    const alice = snapshot.agents.find((agent) => agent.actor === 'alice');
    expect(alice?.item_count).toBe(312);
    expect(alice?.board_item_counts).toEqual({ example: 300, lab: 12 });
    expect(alice?.issues).toHaveLength(2);
    const bob = snapshot.agents.find((agent) => agent.actor === 'bob');
    expect(bob).toMatchObject({
      item_count: 4,
      issues: [],
      latest_activity: 90,
      board_item_counts: { lab: 4 }
    });
    expect(snapshot.stats.active_issues).toBe(316);
    expect(snapshot.stats.active_agents).toBe(2);
  });

  test('keeps the list-derived count for a lane the counts do not mention', async () => {
    const store = createStore({
      active_rows: [
        {
          actor: 'alice',
          item_count: 1,
          latest_activity: 500,
          issues: [{ ...ACTIVE_ISSUE, id: 'ex-1', updated_at: 500 }]
        }
      ],
      count_rows: [{ actor: 'bob', board_id: 'lab', item_count: 2 }],
      discussion_rows: []
    });

    const snapshot = await fetchAgentwatchSnapshot(store, { generated_at: 1 });

    const alice = snapshot.agents.find((agent) => agent.actor === 'alice');
    expect(alice?.item_count).toBe(1);
    expect(alice).not.toHaveProperty('board_item_counts');
    expect(snapshot.stats.active_issues).toBe(3);
  });
});

describe('fetchAgentwatchSnapshot alias folding', () => {
  const ALIASES = new Map([
    ['mira', 'mira'],
    ['alex-laptop', 'mira'],
    ['alex-cursor', 'mira'],
    ['mira@example.test', 'mira']
  ]);

  /**
   * @returns {FakeStore}
   */
  function aliasStore() {
    return createStore({
      active_rows: [
        {
          actor: 'alex-laptop',
          item_count: 1,
          latest_activity: 300,
          issues: [{ ...ACTIVE_ISSUE, id: 'ex-alias', updated_at: 300 }]
        },
        {
          actor: 'mira',
          item_count: 1,
          latest_activity: 200,
          issues: [{ ...ACTIVE_ISSUE, id: 'ex-own', updated_at: 200 }]
        },
        {
          actor: 'botty1',
          item_count: 1,
          latest_activity: 100,
          issues: [{ ...ACTIVE_ISSUE, id: 'ex-unowned', updated_at: 100 }]
        }
      ],
      count_rows: [
        { actor: 'alex-laptop', board_id: 'example', item_count: 280 },
        { actor: 'mira', board_id: 'example', item_count: 5 },
        { actor: 'mira', board_id: 'lab', item_count: 2 },
        { actor: 'botty1', board_id: 'example', item_count: 1 }
      ],
      discussion_rows: []
    });
  }

  const INPUTS = {
    flares: [
      {
        actor: 'alex-cursor',
        board_id: 'example',
        issue_id: 'ex-alias',
        heartbeat_at: 900,
        liveness: 'live'
      }
    ],
    runtime_presence: [
      runtimeRow({ actor: 'alex-laptop', heartbeat_at: 800 })
    ],
    roster: [
      {
        actor: 'mira',
        display_name: 'alex',
        kind: 'human',
        last_seen_at: 50
      },
      {
        actor: 'alex-laptop',
        display_name: 'alex-laptop',
        kind: 'agent',
        last_seen_at: 950
      },
      {
        actor: 'botty1',
        display_name: 'botty1',
        kind: 'agent',
        last_seen_at: 10
      }
    ]
  };

  test('merges an alias lane into its person in accounts mode', async () => {
    const snapshot = await fetchAgentwatchSnapshot(aliasStore(), {
      generated_at: 1,
      ...INPUTS,
      aliases: ALIASES
    });

    expect(snapshot.agents.map((agent) => agent.actor)).toEqual([
      'mira',
      'botty1'
    ]);
    const mira = snapshot.agents[0];
    expect(mira.aliases).toEqual(['alex-cursor', 'alex-laptop']);
    expect(mira.issues.map((issue) => issue.id)).toEqual([
      'ex-alias',
      'ex-own'
    ]);
    expect(mira.item_count).toBe(287);
    expect(mira.board_item_counts).toEqual({ example: 285, lab: 2 });
    expect(mira.flare?.issue_id).toBe('ex-alias');
    expect(mira.runtime_sessions?.[0].runtime_id).toBe('runtime-1');
    expect(mira.display_name).toBe('alex');
    expect(mira.kind).toBe('human');
    expect(mira.last_seen).toBe(950);
    expect(snapshot.agents[1]).not.toHaveProperty('aliases');
    expect(snapshot.stats).toEqual({
      active_agents: 2,
      registered_agents: 2,
      active_issues: 288,
      shared_discussions: 0
    });
  });

  test('keeps every actor its own lane without an alias map', async () => {
    const snapshot = await fetchAgentwatchSnapshot(aliasStore(), {
      generated_at: 1,
      ...INPUTS
    });

    expect(snapshot.agents.map((agent) => agent.actor).sort()).toEqual([
      'alex-cursor',
      'alex-laptop',
      'botty1',
      'mira'
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('"aliases"');
    const laptop = snapshot.agents.find(
      (agent) => agent.actor === 'alex-laptop'
    );
    expect(laptop?.item_count).toBe(280);
    expect(laptop?.runtime_sessions).toHaveLength(1);
    expect(snapshot.stats.registered_agents).toBe(3);
  });
});

describe('fetchAgentwatchSnapshot presence errors', () => {
  test('attaches the newest rejected heartbeat to its folded lane', async () => {
    const store = createStore({ active_rows: [], discussion_rows: [] });

    const snapshot = await fetchAgentwatchSnapshot(store, {
      generated_at: 1,
      roster: [
        { actor: 'mira', display_name: 'alex', kind: 'human' },
        { actor: 'dana', display_name: 'dana', kind: 'human' }
      ],
      presence_errors: [
        { actor: 'alex-laptop', at: 100, status: 409, error: 'conflict' },
        {
          actor: 'mira',
          at: 200,
          status: 400,
          error: 'bad_request',
          client: 'p3'
        },
        { actor: 'nobody-on-the-wall', at: 300, status: 400, error: 'x' },
        { actor: 'dana', at: 0, status: 400, error: 'no-time' }
      ],
      aliases: new Map([['alex-laptop', 'mira']])
    });

    const mira = snapshot.agents.find((agent) => agent.actor === 'mira');
    expect(mira?.presence_error).toEqual({
      at: 200,
      status: 400,
      error: 'bad_request',
      client: 'p3'
    });
    const dana = snapshot.agents.find((agent) => agent.actor === 'dana');
    expect(dana).not.toHaveProperty('presence_error');
    expect(snapshot.agents.map((agent) => agent.actor).sort()).toEqual([
      'dana',
      'mira'
    ]);
  });
});
