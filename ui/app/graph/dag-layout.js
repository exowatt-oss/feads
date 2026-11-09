/**
 * feads addition — layered layout for the epic story flowchart.
 *
 * Pure geometry: no DOM, no state. Given nodes and `[blocker, blocked]` edges,
 * it assigns every node a tier (blockers strictly above the things they
 * block), an order within its tier, and pixel coordinates. The story view
 * feeds it the *union* graph of everything an epic has ever contained, so a
 * node keeps its position through the whole replay — frames only recolor.
 *
 * Tiering is longest-path from the sources: `tier(n) = 1 + max(tier of
 * blockers)`, 0 for a node nothing blocks. That is exactly the "what could
 * start when" reading the view promises — a node sits one row below its
 * slowest prerequisite. Cycles (possible in the data, meaningless for
 * scheduling) are broken by ignoring the back edge rather than throwing: a
 * drawable, slightly-wrong chart beats a blank panel.
 *
 * Within a tier, nodes are ordered by the barycenter of their blockers'
 * positions (two down-sweeps), which keeps edges short without a full
 * crossing-minimization pass — epics are tens of nodes, not thousands. Wide
 * tiers wrap onto sub-rows so a 20-task tier stays a readable block instead of
 * a 6000px ribbon.
 */

/**
 * @typedef {Object} LayoutOptions
 * @property {number} [node_w] - Node box width.
 * @property {number} [node_h] - Node box height.
 * @property {number} [h_gap] - Horizontal gap between nodes.
 * @property {number} [v_gap] - Vertical gap between tiers.
 * @property {number} [max_per_row] - Wrap a tier wider than this.
 * @property {number} [pad] - Outer padding.
 */

/**
 * @typedef {Object} NodePosition
 * @property {number} x - Left edge.
 * @property {number} y - Top edge.
 * @property {number} tier
 */

/**
 * Assign tiers by longest path from the sources, ignoring cycle back-edges.
 *
 * @param {string[]} ids
 * @param {Array<[string, string]>} edges - `[blocker, blocked]`.
 * @returns {Map<string, number>}
 */
export function assignTiers(ids, edges) {
  /** @type {Map<string, string[]>} */
  const blockers_of = new Map();
  const id_set = new Set(ids);
  for (const id of ids) {
    blockers_of.set(id, []);
  }
  for (const [from, to] of edges) {
    if (id_set.has(from) && id_set.has(to) && from !== to) {
      blockers_of.get(to)?.push(from);
    }
  }

  /** @type {Map<string, number>} */
  const tiers = new Map();
  /** @type {Set<string>} */
  const in_stack = new Set();

  /**
   * @param {string} id
   * @returns {number}
   */
  function tierOf(id) {
    const known = tiers.get(id);
    if (known !== undefined) {
      return known;
    }
    if (in_stack.has(id)) {
      // Cycle: treat the back edge as absent. The node keeps whatever tier
      // its acyclic blockers give it.
      return -1;
    }
    in_stack.add(id);
    let best = -1;
    for (const blocker of blockers_of.get(id) || []) {
      const t = tierOf(blocker);
      if (t > best) {
        best = t;
      }
    }
    in_stack.delete(id);
    const tier = best + 1;
    tiers.set(id, tier);
    return tier;
  }

  for (const id of ids) {
    tierOf(id);
  }
  return tiers;
}

/**
 * Layout the graph.
 *
 * @param {Array<{ id: string }>} nodes - Order is the tiebreak (pass creation
 * order for stable, chronological rows).
 * @param {Array<[string, string]>} edges - `[blocker, blocked]`.
 * @param {LayoutOptions} [options]
 * @returns {{ positions: Map<string, NodePosition>, width: number, height: number, node_w: number, node_h: number, tier_count: number }}
 */
export function layoutDag(nodes, edges, options = {}) {
  const node_w = options.node_w ?? 190;
  const node_h = options.node_h ?? 54;
  const h_gap = options.h_gap ?? 28;
  const v_gap = options.v_gap ?? 46;
  const max_per_row = Math.max(1, options.max_per_row ?? 6);
  const pad = options.pad ?? 16;

  const ids = nodes.map((n) => String(n.id));
  const tiers = assignTiers(ids, edges);

  /** @type {Map<number, string[]>} */
  const by_tier = new Map();
  for (const id of ids) {
    const t = tiers.get(id) ?? 0;
    const list = by_tier.get(t) || [];
    list.push(id);
    by_tier.set(t, list);
  }
  const tier_keys = Array.from(by_tier.keys()).sort((a, b) => a - b);

  // Barycenter ordering: two top-down sweeps, ordering each tier by the mean
  // index of its blockers in the tier above. Input order is the tiebreak.
  /** @type {Map<string, string[]>} */
  const blockers_of = new Map();
  const id_set = new Set(ids);
  for (const id of ids) {
    blockers_of.set(id, []);
  }
  for (const [from, to] of edges) {
    if (id_set.has(from) && id_set.has(to) && from !== to) {
      blockers_of.get(to)?.push(from);
    }
  }
  /** @type {Map<string, number>} */
  const order_index = new Map();
  for (const t of tier_keys) {
    const list = by_tier.get(t) || [];
    list.forEach((id, i) => order_index.set(id, i));
  }
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const t of tier_keys) {
      const list = by_tier.get(t) || [];
      /** @type {Map<string, number>} */
      const score = new Map();
      list.forEach((id, i) => {
        const blockers = (blockers_of.get(id) || []).filter(
          (b) => (tiers.get(b) ?? 0) < t
        );
        if (blockers.length === 0) {
          score.set(id, i);
          return;
        }
        let sum = 0;
        for (const b of blockers) {
          sum += order_index.get(b) ?? 0;
        }
        score.set(id, sum / blockers.length);
      });
      list.sort((a, b) => {
        const d = (score.get(a) ?? 0) - (score.get(b) ?? 0);
        return d !== 0 ? d : ids.indexOf(a) - ids.indexOf(b);
      });
      list.forEach((id, i) => order_index.set(id, i));
    }
  }

  // Coordinates. Wide tiers wrap; every (sub-)row is centered on the widest
  // row so the chart reads as a column of centered ranks.
  /** @type {Map<string, NodePosition>} */
  const positions = new Map();
  /** @type {Array<{ tier: number, row_ids: string[] }>} */
  const rows = [];
  for (const t of tier_keys) {
    const list = by_tier.get(t) || [];
    for (let i = 0; i < list.length; i += max_per_row) {
      rows.push({ tier: t, row_ids: list.slice(i, i + max_per_row) });
    }
  }
  const widest = rows.reduce((w, r) => Math.max(w, r.row_ids.length), 1);
  const width = pad * 2 + widest * node_w + (widest - 1) * h_gap;
  let y = pad;
  for (const row of rows) {
    const row_w =
      row.row_ids.length * node_w + (row.row_ids.length - 1) * h_gap;
    let x = pad + (width - pad * 2 - row_w) / 2;
    for (const id of row.row_ids) {
      positions.set(id, { x, y, tier: row.tier });
      x += node_w + h_gap;
    }
    y += node_h + v_gap;
  }
  const height = rows.length > 0 ? y - v_gap + pad : pad * 2;

  return {
    positions,
    width,
    height,
    node_w,
    node_h,
    tier_count: tier_keys.length
  };
}
