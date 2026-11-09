/**
 * feads addition — layout math for the epic story flowchart.
 */
import { describe, expect, test } from 'vitest';
import { assignTiers, layoutDag } from './dag-layout.js';

/**
 * @param {string[]} ids
 * @returns {Array<{ id: string }>}
 */
function nodes(ids) {
  return ids.map((id) => ({ id }));
}

describe('assignTiers', () => {
  test('sources sit at tier 0, blocked nodes below their slowest blocker', () => {
    const tiers = assignTiers(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'b'],
        ['b', 'd'],
        ['c', 'd']
      ]
    );
    expect(tiers.get('a')).toBe(0);
    expect(tiers.get('c')).toBe(0);
    expect(tiers.get('b')).toBe(1);
    // d waits on b (tier 1) and c (tier 0) — the longest path wins.
    expect(tiers.get('d')).toBe(2);
  });

  test('a cycle does not hang or throw; nodes still get tiers', () => {
    const tiers = assignTiers(
      ['a', 'b'],
      [
        ['a', 'b'],
        ['b', 'a']
      ]
    );
    expect(tiers.size).toBe(2);
    for (const t of tiers.values()) {
      expect(t).toBeGreaterThanOrEqual(0);
    }
  });

  test('edges to unknown nodes are ignored', () => {
    const tiers = assignTiers(['a'], [['ghost', 'a']]);
    expect(tiers.get('a')).toBe(0);
  });
});

describe('layoutDag', () => {
  test('positions every node, blockers strictly above', () => {
    const { positions, width, height } = layoutDag(nodes(['a', 'b', 'c']), [
      ['a', 'b'],
      ['a', 'c']
    ]);
    expect(positions.size).toBe(3);
    const a = positions.get('a');
    const b = positions.get('b');
    const c = positions.get('c');
    expect(a && b && a.y < b.y).toBe(true);
    expect(a && c && a.y < c.y).toBe(true);
    expect(b && c && b.y === c.y).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  test('wide tiers wrap onto sub-rows instead of growing without bound', () => {
    const many = nodes(
      Array.from({ length: 14 }, (_, i) => `n${String(i).padStart(2, '0')}`)
    );
    const { positions, width } = layoutDag(many, [], { max_per_row: 6 });
    const ys = new Set(Array.from(positions.values()).map((p) => p.y));
    expect(ys.size).toBe(3); // 6 + 6 + 2
    // Width is bounded by the widest row, not by all 14 nodes.
    const single_row = layoutDag(many.slice(0, 6), [], { max_per_row: 6 });
    expect(width).toBe(single_row.width);
  });

  test('layout is deterministic for the same input', () => {
    const edges = /** @type {Array<[string, string]>} */ ([
      ['a', 'c'],
      ['b', 'c'],
      ['c', 'd']
    ]);
    const one = layoutDag(nodes(['a', 'b', 'c', 'd']), edges);
    const two = layoutDag(nodes(['a', 'b', 'c', 'd']), edges);
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(one.positions.get(id)).toEqual(two.positions.get(id));
    }
  });

  test('an empty graph yields an empty, finite canvas', () => {
    const { positions, width, height } = layoutDag([], []);
    expect(positions.size).toBe(0);
    expect(Number.isFinite(width)).toBe(true);
    expect(Number.isFinite(height)).toBe(true);
  });
});
