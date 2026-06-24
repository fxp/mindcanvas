// Standalone shareable digest page (/d/<id>): read-only render of a saved snapshot.

import { esc } from './util.js';
import { renderDigestBody, digestMeta } from './digest-render.js';

const page = document.getElementById('page');
const id = decodeURIComponent(location.pathname.replace(/^\/d\//, '').replace(/\/$/, ''));
let markdown = '';

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1600);
}

function fmtTime(ms) {
  try {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return '';
  }
}

page.innerHTML = `<div class="canvas-inner"><p style="color:var(--faint)">加载纪要…</p></div>`;

fetch('/api/saved-digest?id=' + encodeURIComponent(id))
  .then((r) => r.json())
  .then(({ ok, digest, markdown: md, savedAt }) => {
    if (!ok) {
      page.innerHTML = `<div class="canvas-inner"><p style="color:var(--faint)">未找到该纪要（链接可能已失效）。</p></div>`;
      return;
    }
    markdown = md || '';
    page.innerHTML = `
      <div class="canvas-inner digest">
        <div class="dg-head">
          <div>
            <h1>${esc(digest.title)} · 会议纪要</h1>
            <div class="dg-meta">${esc(digestMeta(digest))} · 生成于 ${fmtTime(savedAt)}</div>
          </div>
        </div>
        ${renderDigestBody(digest)}
        <div class="dg-foot">由 MindCanvas 自动融合讲者内容与现场讨论生成 · 快照</div>
      </div>`;
  })
  .catch((e) => {
    page.innerHTML = `<div class="canvas-inner"><p style="color:var(--faint)">加载失败：${esc(e.message)}</p></div>`;
  });

document.getElementById('copyMd').addEventListener('click', () => {
  navigator.clipboard?.writeText(markdown);
  toast('已复制 Markdown');
});
