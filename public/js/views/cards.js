// Per-slide card view: one card per slide (image + points + that slide's signals).
// Naturally suited to minutes and to "for the people who didn't attend" (§3).

import { esc, signalChips, emojiSummary } from '../util.js';

export function renderCards(state, container, ctx) {
  if (!state.slides.length) {
    container.innerHTML = `<div class="canvas-inner"><p style="color:var(--faint);font-style:italic">还没有幻灯片。主讲在主讲台「下一页」即可生成卡片。</p></div>`;
    return;
  }

  // map slideId -> section node (sections carry the points + signals)
  const root = state.nodes[state.root];
  const secBySlide = {};
  (root.children || []).forEach((id) => {
    const s = state.nodes[id];
    if (s && s.slideId) secBySlide[s.slideId] = s;
  });

  const cards = state.slides
    .map((slide) => {
      const sec = secBySlide[slide.id];
      const pts = sec ? (sec.children || []).map((id) => state.nodes[id]).filter(Boolean) : [];
      const lis = pts.map((p) => `<li>${esc(p.text)}</li>`).join('');
      const clusterCount = sec ? (sec.clusters || []).length : 0;
      const commentCount = sec
        ? (sec.commentIds || []).length + pts.reduce((a, p) => a + (p.commentIds || []).length, 0)
        : 0;
      const emoji = {};
      if (sec) for (const [e, n] of Object.entries(sec.emoji || {})) emoji[e] = (emoji[e] || 0) + n;
      pts.forEach((p) => { for (const [e, n] of Object.entries(p.emoji || {})) emoji[e] = (emoji[e] || 0) + n; });
      const heat = sec ? sec.metrics.heat + pts.reduce((a, p) => a + p.metrics.heat, 0) : 0;
      const confusion = sec ? sec.metrics.confusion + pts.reduce((a, p) => a + p.metrics.confusion, 0) : 0;

      return `
      <div class="card">
        ${slide.imageUrl ? `<img src="${esc(slide.imageUrl)}" alt="">` : ''}
        <div class="card-top">
          <div class="card-idx">幻灯片 ${slide.index + 1}</div>
          <h2>${esc(slide.title)}</h2>
        </div>
        <div class="card-body">
          ${slide.body ? `<div style="color:var(--muted);margin-bottom:6px">${esc(slide.body)}</div>` : ''}
          ${lis ? `<ul>${lis}</ul>` : '<div style="color:var(--faint)">（暂无讲解要点）</div>'}
        </div>
        <div class="card-foot">
          ${signalChips({ heat, confusion, controversy: 0 }) || '<span class="chip">无信号</span>'}
          <span class="chip">💬 ${commentCount}</span>
          ${clusterCount ? `<span class="chip">🧩 ${clusterCount} 簇</span>` : ''}
          ${emojiSummary(emoji) ? `<span class="emoji-tag">${esc(emojiSummary(emoji))}</span>` : ''}
        </div>
      </div>`;
    })
    .join('');

  container.innerHTML = `<div class="cards">${cards}</div>`;
}
