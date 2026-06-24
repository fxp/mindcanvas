// §2.3  Timestamp → content auto-anchoring.
//
// Given a compose-time timestamp `t`, find the node that was being discussed then.
// We prefer the DEEPEST (most specific) node whose [t_start, t_end] contains t — i.e.
// a fine-grained point beats the coarse section it lives in. An ongoing node has
// t_end = null, treated as "until now".

import { now } from './util.js';

export function anchorByTime(store, t) {
  let best = null;
  let bestDepth = -1;
  for (const node of store.nodes.values()) {
    if (node.kind === 'root') continue;
    const start = node.t_start ?? 0;
    const end = node.t_end ?? now();
    if (t >= start && t <= end) {
      const depth = node.kind === 'point' ? 2 : 1;
      // deeper wins; on a tie prefer the one that started later (more recent)
      if (depth > bestDepth || (depth === bestDepth && best && node.t_start > best.t_start)) {
        best = node;
        bestDepth = depth;
      }
    }
  }
  if (best) return best.id;

  // nothing contains t (e.g. t is just after the last close) → snap to the
  // node whose start is closest to t.
  let nearest = null;
  let nearestGap = Infinity;
  for (const node of store.nodes.values()) {
    if (node.kind === 'root') continue;
    const gap = Math.abs((node.t_start ?? 0) - t);
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = node;
    }
  }
  return nearest ? nearest.id : null;
}
