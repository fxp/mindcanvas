// Outline view (默认 · 分享内容): the proposal tree grows live. This is the SHARE
// side — ONLY the speakers' spoken content (sections + ASR points, with speaker labels
// when available). All discussion signals/clusters live in the right panel, so this
// stays a clean transcript of what was said.

import { esc, speakerTag } from '../util.js';

function renderPoint(node, selectedId) {
  const sel = node.id === selectedId ? ' selected' : '';
  const open = node.open ? ' open' : '';
  return `
    <div class="point${sel}${open}" data-node="${node.id}">
      ${speakerTag(node.speaker)}<span class="ptext">${esc(node.text)}</span>
    </div>`;
}

export function renderOutline(state, container, ctx) {
  const root = state.nodes[state.root];
  const sections = (root.children || []).map((id) => state.nodes[id]).filter(Boolean);

  if (!sections.length) {
    container.innerHTML = `<div class="canvas-inner"><p style="color:var(--faint);font-style:italic">等待主讲开始… 打开主讲台开始演讲，或点「▶ 模拟」。</p></div>`;
    return;
  }

  const html = sections
    .map((sec) => {
      const active = sec.id === state.currentSectionId ? ' active' : '';
      const pts = (sec.children || []).map((id) => state.nodes[id]).filter(Boolean);
      const ptsHtml = pts.map((p) => renderPoint(p, ctx.selectedId)).join('');
      const secSel = sec.id === ctx.selectedId ? ' selected' : '';
      const live =
        sec.id === state.currentSectionId && state.liveTranscript
          ? `<div class="speaking">🎙 ${esc(state.liveTranscript)}<span class="cursor">▍</span></div>`
          : '';
      const provis = sec.provisional ? ' provisional' : '';
      const provisTag = sec.provisional ? ' <span class="provis-tag">提炼标题中…</span>' : '';
      return `
      <div class="section${active}">
        <div class="section-head">
          <h2 class="point${secSel}${provis}" data-node="${sec.id}" style="cursor:pointer">${esc(sec.text)}${provisTag}</h2>
        </div>
        ${ptsHtml}
        ${live}
      </div>`;
    })
    .join('');

  container.innerHTML = `<div class="canvas-inner">${html}</div>`;

  container.querySelectorAll('[data-node]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.selectNode(el.getAttribute('data-node'));
    });
  });
}
