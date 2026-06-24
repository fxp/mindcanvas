// 思维导图 view: the outline tree (root → sections → points) as a live left-to-right
// mind map. Re-rendered on every snapshot, so it grows/updates with the talk.

import { esc } from '../util.js';

const trunc = (s, n) => { s = s || ''; return s.length > n ? s.slice(0, n) + '…' : s; };

export function renderMindmap(state, container) {
  const root = state.nodes[state.root];
  const sections = (root.children || []).map((id) => state.nodes[id]).filter(Boolean);
  if (!sections.length) {
    container.innerHTML = `<div class="canvas-inner"><p style="color:var(--faint);font-style:italic">等待内容… 思维导图会随演讲实时生长。</p></div>`;
    return;
  }

  const ROW = 30, PAD = 28, X0 = 30, X1 = 320, X2 = 600, W = 940;
  let row = 0;
  const layout = [];
  for (const s of sections) {
    const pts = (s.children || []).map((id) => state.nodes[id]).filter(Boolean);
    const start = row;
    const ptRows = pts.map(() => row++);
    if (!pts.length) row++;
    const cy = ((start + (row - 1)) / 2) * ROW + PAD + ROW / 2;
    layout.push({ s, pts, ptRows, cy });
  }
  const H = Math.max(row, 1) * ROW + PAD * 2;
  const rootY = H / 2;

  const link = (x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2;
    return `<path class="mm-link" d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" />`;
  };
  const dot = (x, y, cls) => `<circle class="mm-dot ${cls}" cx="${x}" cy="${y}" r="4" />`;
  const label = (x, y, text, cls, id) =>
    `<text class="mm-label ${cls}" x="${x + 9}" y="${y + 4}"${id ? ` data-node="${id}"` : ''}>${esc(text)}</text>`;

  let svg = dot(X0, rootY, 'mm-root') + label(X0, rootY, trunc(state.config.title || '演讲', 22), 'mm-root');
  for (const L of layout) {
    const heat = L.s.metrics ? L.s.metrics.heat : 0;
    svg += link(X0 + 4, rootY, X1, L.cy);
    svg += dot(X1, L.cy, 'mm-sec') + label(X1, L.cy, trunc((L.s.provisional ? '○ ' : '') + L.s.text, 22), 'mm-sec', L.s.id);
    if (heat) svg += `<text class="mm-heat" x="${X1 + 9}" y="${L.cy + 16}">🔥 ${heat}</text>`;
    L.pts.forEach((p, i) => {
      const py = L.ptRows[i] * ROW + PAD + ROW / 2;
      svg += link(X1 + 4, L.cy, X2, py);
      svg += dot(X2, py, 'mm-pt') + label(X2, py, trunc(p.text, 32), 'mm-pt', p.id);
    });
  }

  container.innerHTML = `<div class="mm-wrap"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${svg}</svg></div>`;
}
