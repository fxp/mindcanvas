// Shared renderer for the fused digest body (overview + action items + sections).
// Used by the in-app 纪要 view (audience.js) and the standalone share page (digest-page.js).

import { esc } from './util.js';

export const KIND_CN = { question: '提问', opinion: '观点', agreement: '认同', confusion: '困惑', suggestion: '建议', other: '声音' };
export const ACTION_CN = { action: '行动项', decision: '决议', question: '待解答', risk: '风险/争议' };
const ACTION_ORDER = ['action', 'decision', 'question', 'risk'];

export function renderDigestBody(d) {
  const overview = d.overview
    ? `<div class="dg-overview"><div class="dg-hl-label">全场总览</div><p>${esc(d.overview)}</p></div>`
    : '';

  let actions = '';
  if (d.actions && d.actions.length) {
    const items = ACTION_ORDER.flatMap((t) =>
      d.actions
        .filter((a) => a.type === t)
        .map((a) => {
          const note = a.note ? `<span class="dg-note">（${esc(a.note)}）</span>` : '';
          return `<li><span class="dg-act ${esc(t)}">${ACTION_CN[t] || esc(t)}</span> ${esc(a.text)}${note}</li>`;
        })
    ).join('');
    actions = `<div class="dg-actions-block"><div class="dg-hl-label">行动项 · 决议 · 待办</div><ul class="dg-act-list">${items}</ul></div>`;
  }

  const secs = (d.sections || [])
    .map((s, i) => {
      const hl = (s.highlights || [])
        .map((h) => {
          const k = KIND_CN[h.kind] || '声音';
          const note = h.note ? `<span class="dg-note">（${esc(h.note)}）</span>` : '';
          return `<li><span class="dg-kind ${esc(h.kind)}">${k} · ${h.size}人</span> ${esc(h.label)}${note}</li>`;
        })
        .join('');
      return `
      <section class="dg-sec">
        <h2>${i + 1}. ${esc(s.title)}</h2>
        ${s.summary ? `<p class="dg-summary">${esc(s.summary)}</p>` : ''}
        ${hl ? `<div class="dg-hl-label">现场高光</div><ul class="dg-hl">${hl}</ul>` : ''}
      </section>`;
    })
    .join('');

  return `${overview}${actions}${secs}`;
}

export function digestMeta(d) {
  return `融合讲者内容 + 现场 ${d.stats.participants} 人 / ${d.stats.commentCount} 评论 / ${d.stats.reactionCount} 互动`;
}
