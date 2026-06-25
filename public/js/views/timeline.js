// Timeline view: the talk runs along one time axis; slides / comments / emoji hang
// as annotations at the moment they happened (§3).

import { esc, relTime } from '../util.js';

export function renderTimeline(state, container) {
  const startedAt = state.config.startedAt;
  const items = [];

  // 演讲主体：章节 + 逐句要点沿时间轴（没有幻灯片时这才是主线）
  const root = state.nodes[state.root];
  for (const secId of (root && root.children) || []) {
    const sec = state.nodes[secId];
    if (!sec) continue;
    const pts = (sec.children || []).map((id) => state.nodes[id]).filter((p) => p && p.kind === 'point');
    const secT = sec.t_start || (pts[0] && pts[0].t_start) || startedAt;
    if (sec.kind === 'section') items.push({ t: secT, kind: 'section', body: sec.text });
    for (const p of pts) items.push({ t: p.t_start || secT, kind: 'point', body: p.text, speaker: p.speaker });
  }

  for (const slide of state.slides) {
    items.push({ t: slide.t_start, kind: 'slide', body: slide.title });
  }
  for (const c of Object.values(state.comments)) {
    const anchor = state.nodes[c.anchorNodeId];
    items.push({
      t: c.t,
      kind: 'comment',
      body: c.text,
      anchor: anchor ? anchor.text : '',
      q: c.isQuestion,
    });
  }
  for (const r of state.reactions) {
    const anchor = state.nodes[r.nodeId];
    items.push({ t: r.t, kind: 'emoji', body: r.emoji, anchor: anchor ? anchor.text : '' });
  }

  items.sort((a, b) => a.t - b.t);
  const recent = items.slice(-160);

  if (!recent.length) {
    container.innerHTML = `<div class="canvas-inner"><p style="color:var(--faint);font-style:italic">时间线为空，等待事件…</p></div>`;
    return;
  }

  const html = recent
    .map((it) => {
      const time = relTime(it.t, startedAt);
      let body = '';
      if (it.kind === 'section') {
        body = `<strong>▎${esc(it.body)}</strong>`;
      } else if (it.kind === 'point') {
        body = `🗣 ${it.speaker ? '[' + esc(it.speaker) + '] ' : ''}${esc(it.body)}`;
      } else if (it.kind === 'slide') {
        body = `▸ ${esc(it.body)}`;
      } else if (it.kind === 'comment') {
        body = `${it.q ? '❓ ' : '💬 '}${esc(it.body)}`;
      } else {
        body = `${esc(it.body)}`;
      }
      const anchor = it.anchor ? `<div class="tl-anchor">↳ ${esc(it.anchor)}</div>` : '';
      return `
      <div class="tl-item ${it.kind}">
        <div class="tl-time">${time}</div>
        <div class="tl-body">${body}</div>
        ${anchor}
      </div>`;
    })
    .join('');

  container.innerHTML = `<div class="canvas-inner"><div class="timeline">${html}</div></div>`;
  // scrolling is handled centrally by the follow-latest toggle in audience.js
}
