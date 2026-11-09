/**
 * feads addition — the epic story view: rendering, replay controls, and the
 * live-frame merge, against a fake transport.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { REPLAY_FRAME_MS, createEpicStoryView } from './epic-story.js';

/** @type {HTMLElement} */
let mount;
/** @type {ReturnType<typeof createEpicStoryView>} */
let view;
/** @type {string[]} */
let visited;

const GRAPH = {
  epic: { id: 'ex-epic', title: 'Ship the thing', status: 'in_progress' },
  t: 3000,
  nodes: [
    {
      id: 'ex-a',
      title: 'Server half',
      issue_type: 'task',
      assignee: '',
      status: 'closed'
    },
    {
      id: 'ex-b',
      title: 'Client half',
      issue_type: 'task',
      assignee: '',
      status: 'in_progress'
    },
    {
      id: 'ex-c',
      title: 'Ship it',
      issue_type: 'task',
      assignee: '',
      status: 'open'
    }
  ],
  edges: [
    ['ex-a', 'ex-b'],
    ['ex-b', 'ex-c']
  ]
};

const HISTORY = {
  epic_id: 'ex-epic',
  frames: [
    {
      t: 1000,
      epic_status: 'open',
      statuses: { 'ex-a': 'open', 'ex-b': 'open' },
      m: 0
    },
    {
      t: 2000,
      epic_status: 'in_progress',
      statuses: { 'ex-a': 'in_progress', 'ex-b': 'open' },
      m: 0
    }
  ],
  metas: [
    {
      epic: { title: 'Ship the thing' },
      nodes: {
        'ex-a': { title: 'Server half', type: 'task', assignee: '' },
        'ex-b': { title: 'Client half', type: 'task', assignee: '' }
      },
      edges: [['ex-a', 'ex-b']]
    }
  ]
};

/**
 * @param {string} type
 * @returns {Promise<any>}
 */
async function fakeTransport(type) {
  if (type === 'epic-graph') {
    return structuredClone(GRAPH);
  }
  if (type === 'epic-history') {
    return structuredClone(HISTORY);
  }
  return [];
}

beforeEach(() => {
  mount = document.createElement('div');
  document.body.appendChild(mount);
  visited = [];
  view = createEpicStoryView(
    mount,
    fakeTransport,
    (id) => visited.push(id),
    () => visited.push('__epics__')
  );
});

afterEach(() => {
  view.unload();
  mount.remove();
});

describe('epic story view', () => {
  test('renders the union graph with the live frame selected', async () => {
    await view.load('ex-epic');
    // Three frames: two history + live.
    const scrubber = /** @type {HTMLInputElement} */ (
      mount.querySelector('.story-scrubber')
    );
    expect(scrubber.max).toBe('2');
    expect(scrubber.value).toBe('2');
    expect(mount.querySelector('.story-time')?.textContent).toContain('LIVE');
    // ex-c exists only in the live frame but is laid out from the union.
    const groups = Array.from(mount.querySelectorAll('.story-node'));
    expect(groups).toHaveLength(3);
    const by_label = new Map(
      groups.map((g) => [g.getAttribute('aria-label') || '', g])
    );
    expect(Array.from(by_label.keys()).some((k) => k.startsWith('ex-c'))).toBe(
      true
    );
    // Live frame statuses color the nodes.
    expect(
      mount.querySelector('.story-node.is-closed [class*="story-node-id"]')
        ?.textContent
    ).toBe('ex-a');
  });

  test('scrubbing to an earlier frame ghosts not-yet-created tasks', async () => {
    await view.load('ex-epic');
    const scrubber = /** @type {HTMLInputElement} */ (
      mount.querySelector('.story-scrubber')
    );
    scrubber.value = '0';
    scrubber.dispatchEvent(new Event('input', { bubbles: true }));
    // Frame 0: a and b open, c absent.
    const absent = Array.from(mount.querySelectorAll('.story-node.is-absent'));
    expect(absent).toHaveLength(1);
    expect(absent[0].getAttribute('aria-label') || '').toContain('ex-c');
    expect(mount.querySelector('.story-time')?.textContent).not.toContain(
      'LIVE'
    );
  });

  test('a node click navigates to the issue; back navigates to epics', async () => {
    await view.load('ex-epic');
    const node = /** @type {HTMLElement} */ (
      mount.querySelector('.story-node')
    );
    node.dispatchEvent(new Event('click', { bubbles: true }));
    expect(visited.length).toBe(1);
    const back = /** @type {HTMLElement} */ (
      mount.querySelector('.story-back')
    );
    back.dispatchEvent(new Event('click', { bubbles: true }));
    expect(visited[1]).toBe('__epics__');
  });

  test('play steps the cursor through frames and stops at live', async () => {
    vi.useFakeTimers();
    try {
      await view.load('ex-epic');
      const play = /** @type {HTMLButtonElement} */ (
        mount.querySelector('.story-play')
      );
      play.dispatchEvent(new Event('click', { bubbles: true }));
      // Playback from live restarts at frame 0.
      let scrubber = /** @type {HTMLInputElement} */ (
        mount.querySelector('.story-scrubber')
      );
      expect(scrubber.value).toBe('0');
      await vi.advanceTimersByTimeAsync(REPLAY_FRAME_MS);
      scrubber = /** @type {HTMLInputElement} */ (
        mount.querySelector('.story-scrubber')
      );
      expect(scrubber.value).toBe('1');
      await vi.advanceTimersByTimeAsync(REPLAY_FRAME_MS * 2);
      scrubber = /** @type {HTMLInputElement} */ (
        mount.querySelector('.story-scrubber')
      );
      expect(scrubber.value).toBe('2');
      expect(mount.querySelector('.story-time')?.textContent).toContain('LIVE');
    } finally {
      vi.useRealTimers();
    }
  });

  test('the default cadence is unhurried and is what the timer honours', async () => {
    // A frame is a change in the world; the eye needs time to find it.
    expect(REPLAY_FRAME_MS).toBe(1500);
    vi.useFakeTimers();
    try {
      await view.load('ex-epic');
      const play = /** @type {HTMLButtonElement} */ (
        mount.querySelector('.story-play')
      );
      play.dispatchEvent(new Event('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(REPLAY_FRAME_MS - 1);
      expect(
        /** @type {HTMLInputElement} */ (mount.querySelector('.story-scrubber'))
          .value
      ).toBe('0');
      await vi.advanceTimersByTimeAsync(1);
      expect(
        /** @type {HTMLInputElement} */ (mount.querySelector('.story-scrubber'))
          .value
      ).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  test('the colour key names every state the graph can paint', async () => {
    await view.load('ex-epic');
    const legend = /** @type {HTMLElement} */ (
      mount.querySelector('.story-legend')
    );
    const swatches = Array.from(legend.querySelectorAll('.story-swatch'));
    expect(swatches.map((el) => el.getAttribute('class'))).toEqual([
      'story-swatch is-open',
      'story-swatch is-waiting',
      'story-swatch is-in_progress',
      'story-swatch is-blocked',
      'story-swatch is-deferred',
      'story-swatch is-closed',
      'story-swatch is-absent',
      'story-swatch is-edge',
      'story-swatch is-edge is-done'
    ]);
    expect(legend.textContent).toContain('waiting on blocker');
    expect(legend.textContent).toContain('not yet created');
    // Whatever the current frame actually paints has an entry here.
    const painted = Array.from(mount.querySelectorAll('.story-node')).map(
      (g) => (g.getAttribute('class') || '').match(/is-[a-z_]+/)?.[0] || ''
    );
    expect(painted.length).toBeGreaterThan(0);
    for (const state of painted) {
      expect(swatches.some((el) => el.classList.contains(state))).toBe(true);
    }
  });

  test('the colour key sits above the canvas, not below the graph', async () => {
    await view.load('ex-epic');
    const shell = /** @type {HTMLElement} */ (
      mount.querySelector('.story-shell')
    );
    const kids = Array.from(shell.children).map((el) => el.className);
    // A legend under a tall graph is a legend nobody scrolls to.
    expect(kids.indexOf('story-legend muted')).toBeLessThan(
      kids.indexOf('story-canvas')
    );
  });

  test('an epic the server does not know renders an error, not a crash', async () => {
    const failing = async () => [];
    const v = createEpicStoryView(
      mount,
      failing,
      () => {},
      () => {}
    );
    await v.load('ex-ghost');
    expect(mount.textContent).toContain('Could not load epic ex-ghost');
    v.unload();
  });
});
