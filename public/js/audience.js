// Audience app: left = 分享内容 (the talk), right = 参与讨论 (synthesized audience
// voice). Comment composer uses compose-time anchoring (§2.3); one-click emoji is a
// zero-cost signal (§2.5). A follow-latest toggle keeps the talk pinned to the live edge.

import { token, roomId, apiUrl, subscribe, sendEvent, control, onStatus } from './ws-client.js';
import { esc } from './util.js';
import { renderOutline } from './views/outline.js';
import { renderCards } from './views/cards.js';
import { renderTimeline } from './views/timeline.js';
import { renderMindmap } from './views/mindmap.js';
import { renderDigestBody, digestMeta } from './digest-render.js';

const VIEWS = { outline: renderOutline, cards: renderCards, timeline: renderTimeline, mindmap: renderMindmap };
let currentView = 'outline';
let latest = null;

let selectedId = null; // explicit anchor (clicked a node)
let composeAnchorId = null; // frozen anchor captured when composing started

const canvas = document.getElementById('canvas');
const input = document.getElementById('commentInput');
const sendBtn = document.getElementById('sendBtn');
const followBtn = document.getElementById('followBtn');

// ---- follow-latest (default ON): stick the share canvas to the live edge ----
let follow = true;
let programmaticScroll = false;

function scrollToLatest() {
  programmaticScroll = true;
  canvas.scrollTop = canvas.scrollHeight;
  setTimeout(() => { programmaticScroll = false; }, 140);
}
function updateFollowBtn() {
  followBtn.classList.toggle('on', follow);
  followBtn.textContent = follow ? '↓ 跟随最新' : '↑ 已暂停';
}
canvas.addEventListener('scroll', () => {
  if (programmaticScroll) return; // ignore our own auto-scroll
  const atBottom = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 90;
  if (atBottom !== follow) { follow = atBottom; updateFollowBtn(); }
});
followBtn.addEventListener('click', () => {
  follow = !follow;
  updateFollowBtn();
  if (follow) scrollToLatest();
});

// the node currently "in focus" of the talk = deepest live node
function activeNodeId(state) {
  const sec = state.nodes[state.currentSectionId];
  if (!sec) return state.root;
  for (const id of sec.children) if (state.nodes[id]?.open) return id;
  if (sec.children.length) return sec.children[sec.children.length - 1];
  return sec.id;
}
function nodeText(state, id) {
  const n = state.nodes[id];
  return n ? n.text : '';
}
// short label for the anchor pill / toast — never spill a long (or runaway) node text into the UI
function clip(s, n = 48) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function selectNode(id) {
  selectedId = id;
  composeAnchorId = null;
  input.focus();
  render(latest);
}

function render(state) {
  latest = state;
  document.getElementById('meetingTitle').textContent = state.config.title || '';
  document.getElementById('statParticipants').textContent = state.stats.participants || 0;
  document.getElementById('statPeople').textContent = state.stats.reactionCount + state.stats.commentCount;
  document.getElementById('statComments').textContent = state.stats.commentCount;

  // ASR pipeline status — capture for the live ticker (works even when broadcasts pause)
  asrInfo = state.asr || null;
  serverClockOffset = (state.serverTime || Date.now()) - Date.now();
  updateAsrChip();

  // 回放 owns its own canvas + discussion (historical frames) — don't clobber it.
  if (currentView === 'replay') { renderAnchorPreview(); return; }

  // the 纪要 (digest) view is a generated artifact — rendered on tab-switch / refresh,
  // not on every snapshot, so it doesn't churn while the talk is still live.
  if (currentView !== 'digest') {
    VIEWS[currentView](state, canvas, { selectedId, selectNode });
    if (follow) scrollToLatest();
  }
  renderDiscussion(state);
  renderAnchorPreview();
}

// ---- 回放 / 演化回放：scrub through recorded state snapshots ----
let replayFrames = null;
let replayIdx = 0;
let replayTimer = null;

function stopReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  const b = document.getElementById('rpPlay');
  if (b) b.textContent = '▶ 播放';
}

function enterReplay() {
  stopReplay();
  replayFrames = null;
  canvas.innerHTML = `<div class="canvas-inner"><div class="digest-loading">加载回放…</div></div>`;
  document.getElementById('discussion').innerHTML = '';
  fetch(apiUrl('/api/history'))
    .then((r) => r.json())
    .then(({ frames }) => {
      replayFrames = frames || [];
      if (!replayFrames.length) {
        canvas.innerHTML = `<div class="canvas-inner"><div class="digest-loading">还没有可回放的记录。先播放一段演讲（主讲台「模拟 / 真实文稿」或喂入 ASR），再来回看它如何生长。</div></div>`;
        return;
      }
      replayIdx = replayFrames.length - 1;
      renderReplayShell();
      renderReplayFrame();
    })
    .catch((e) => { canvas.innerHTML = `<div class="canvas-inner"><div class="digest-loading">加载失败：${esc(e.message)}</div></div>`; });
}

function renderReplayShell() {
  canvas.innerHTML = `
    <div class="replay-bar">
      <button class="btn" id="rpPlay" style="font-size:13px;padding:8px 16px">▶ 播放</button>
      <input type="range" id="rpSlider" min="0" max="${replayFrames.length - 1}" value="${replayIdx}" />
      <span class="rp-time" id="rpTime"></span>
    </div>
    <div id="replayFrame"></div>`;
  document.getElementById('rpPlay').addEventListener('click', toggleReplayPlay);
  document.getElementById('rpSlider').addEventListener('input', (e) => {
    stopReplay();
    replayIdx = +e.target.value;
    renderReplayFrame();
  });
}

function renderReplayFrame() {
  const f = replayFrames[replayIdx];
  if (!f) return;
  const st = f.state;
  renderOutline(st, document.getElementById('replayFrame'), { selectedId: null, selectNode: () => {} });
  renderDiscussion(st);
  const rel = Math.max(0, Math.round((f.t - st.config.startedAt) / 1000));
  const tl = document.getElementById('rpTime');
  if (tl) tl.textContent = `第 ${replayIdx + 1}/${replayFrames.length} 帧 · +${Math.floor(rel / 60)}:${String(rel % 60).padStart(2, '0')}`;
  const sl = document.getElementById('rpSlider');
  if (sl) sl.value = replayIdx;
}

function toggleReplayPlay() {
  if (replayTimer) { stopReplay(); return; }
  if (replayIdx >= replayFrames.length - 1) replayIdx = 0;
  const b = document.getElementById('rpPlay');
  if (b) b.textContent = '⏸ 暂停';
  replayTimer = setInterval(() => {
    if (replayIdx >= replayFrames.length - 1) { renderReplayFrame(); stopReplay(); return; }
    replayIdx++;
    renderReplayFrame();
  }, 280);
}

// ---- 纪要：融合讲者内容 + 现场高质量评论（按需生成） ----
let digestHtml = null;
let digestMarkdown = '';
let digestLoading = false;
let digestTimer = null;

// silent refresh (no loading flash) — used by the 1-min auto-update while viewing 纪要
function refreshDigest() {
  fetch(apiUrl('/api/digest'))
    .then((r) => r.json())
    .then(({ ok, digest, markdown }) => {
      if (!ok) return;
      digestMarkdown = markdown || '';
      digestHtml = renderDigestHTML(digest);
      if (currentView === 'digest') { canvas.innerHTML = digestHtml; bindDigest(); }
    })
    .catch(() => {});
}

function ensureDigest(force) {
  if (force) digestHtml = null;
  if (digestHtml) { canvas.innerHTML = digestHtml; bindDigest(); return; }
  if (digestLoading) return;
  digestLoading = true;
  canvas.innerHTML = `<div class="canvas-inner"><div class="digest-loading">正在融合讲者内容与现场评论，生成纪要…</div></div>`;
  fetch(apiUrl('/api/digest'))
    .then((r) => r.json())
    .then(({ digest, markdown }) => {
      digestMarkdown = markdown || '';
      digestHtml = renderDigestHTML(digest);
      digestLoading = false;
      if (currentView === 'digest') { canvas.innerHTML = digestHtml; bindDigest(); }
    })
    .catch((e) => {
      digestLoading = false;
      canvas.innerHTML = `<div class="canvas-inner"><div class="digest-loading">生成失败：${esc(e.message)}</div></div>`;
    });
}

function renderDigestHTML(d) {
  return `
    <div class="canvas-inner digest">
      <div class="dg-head">
        <div>
          <h1>${esc(d.title)} · 会议纪要</h1>
          <div class="dg-meta">${esc(digestMeta(d))}</div>
        </div>
        <div class="dg-actions">
          <button class="btn ghost" id="dgShare" style="font-size:12px;padding:6px 12px">🔗 生成分享页</button>
          <button class="btn ghost" id="dgCopy" style="font-size:12px;padding:6px 12px">复制 Markdown</button>
          <button class="btn ghost" id="dgRefresh" style="font-size:12px;padding:6px 12px">↻ 重新生成</button>
        </div>
      </div>
      <div class="dg-share-link" id="dgShareLink" style="display:none"></div>
      ${renderDigestBody(d)}
    </div>`;
}

function bindDigest() {
  const c = document.getElementById('dgCopy');
  const r = document.getElementById('dgRefresh');
  const s = document.getElementById('dgShare');
  if (c) c.addEventListener('click', () => { navigator.clipboard?.writeText(digestMarkdown); toast('已复制 Markdown'); });
  if (r) r.addEventListener('click', () => ensureDigest(true));
  if (s) s.addEventListener('click', async () => {
    s.disabled = true; s.textContent = '生成中…';
    try {
      const res = await fetch(apiUrl('/api/digest/save'), { method: 'POST' });
      const { ok, id } = await res.json();
      if (!ok) throw new Error('save failed');
      const url = `${location.origin}/d/${id}`;
      const el = document.getElementById('dgShareLink');
      el.style.display = 'flex';
      el.innerHTML = `<span>分享链接（快照，可发给没来的人）：</span><a href="${url}" target="_blank">${url}</a><button class="btn ghost" id="dgCopyLink" style="font-size:11px;padding:4px 10px">复制链接</button>`;
      document.getElementById('dgCopyLink').addEventListener('click', () => { navigator.clipboard?.writeText(url); toast('链接已复制'); });
      toast('分享页已生成');
    } catch (e) {
      toast('生成失败：' + e.message);
    } finally {
      s.disabled = false; s.textContent = '🔗 生成分享页';
    }
  });
}

// ---- right panel: the synthesized audience voice (§2.4) ----
function renderDiscussion(state) {
  const el = document.getElementById('discussion');

  // emoji tally across all nodes
  const tally = {};
  for (const n of Object.values(state.nodes)) {
    for (const [e, c] of Object.entries(n.emoji || {})) tally[e] = (tally[e] || 0) + c;
  }
  const tallyHtml = Object.entries(tally)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([e, c]) => `<span>${e} <b>${c}</b></span>`)
    .join('');

  // questions grouped by node (server-derived, already top-N)
  const qs = state.questions || [];
  const qHtml = qs.length
    ? qs
        .map(
          (q) => `
      <div class="q" data-node="${q.nodeId}">
        <span class="qcount">×${q.size}</span>
        <div class="qlabel">${esc(q.label)}</div>
        <div class="qmeta">↳ ${esc(q.nodeText || '')}</div>
      </div>`
        )
        .join('')
    : `<div class="empty">还没有浮现的问题。观众提问后会按内容节点聚到这里。</div>`;

  // non-question clusters: opinions / agreement / confusion / suggestions
  const others = [];
  for (const n of Object.values(state.nodes)) {
    for (const cl of n.clusters || []) {
      if (cl.type === 'question') continue;
      others.push({ ...cl, nodeText: n.text, nodeId: n.id });
    }
  }
  others.sort((a, b) => b.size - a.size);
  const oHtml = others.length
    ? others
        .slice(0, 14)
        .map((cl) => {
          const members = (cl.commentIds || [])
            .map((id) => state.comments[id])
            .filter(Boolean)
            .map((c) => `<div>· ${c.replyTo ? '↩ ' : ''}${c.byAgent ? '🤖' + esc(c.persona) + '：' : ''}${esc(c.text)}</div>`)
            .join('');
          return `
      <div class="cluster" data-cluster="${cl.id}" data-node="${cl.nodeId}">
        <span class="csize">×${cl.size}</span>
        <span class="ctype ${esc(cl.type)}">${esc(cl.type)}</span>
        <span class="clabel">${esc(cl.label)}</span>
        ${cl.summary ? `<div class="csummary">${esc(cl.summary)}</div>` : ''}
        <div class="cmeta">↳ ${esc(cl.nodeText)}</div>
        <div class="cmembers">${members}</div>
      </div>`;
        })
        .join('')
    : `<div class="empty">暂无观点 / 反馈。</div>`;

  // 🔎 web-search supplements
  const sups = (state.supplements || []).slice(-4).reverse();
  const supHtml = sups
    .map((s) => `<div class="supp-item" data-node="${s.nodeId}"><div>${esc(s.text)}</div><div class="supp-src">— ${esc(s.source || '网络')}${s.nodeText ? ' · ↳ ' + esc(s.nodeText) : ''}</div></div>`)
    .join('');

  el.innerHTML = `
    ${tallyHtml ? `<div class="emoji-tally">${tallyHtml}</div>` : ''}
    ${supHtml ? `<div class="disc-group"><h3>🔎 资料补充 · 实时检索</h3>${supHtml}</div>` : ''}
    <div class="disc-group"><h3>❓ 焦点问题 · 按节点</h3>${qHtml}</div>
    <div class="disc-group"><h3>💬 观点与反馈</h3>${oHtml}</div>`;

  el.querySelectorAll('.q').forEach((d) =>
    d.addEventListener('click', () => { const id = d.getAttribute('data-node'); jumpToNode(id); selectNode(id); })
  );
  el.querySelectorAll('.cluster').forEach((d) =>
    d.addEventListener('click', () => { d.classList.toggle('expanded'); jumpToNode(d.getAttribute('data-node')); })
  );
  el.querySelectorAll('.supp-item').forEach((d) =>
    d.addEventListener('click', () => jumpToNode(d.getAttribute('data-node')))
  );
}

// §「点击评论跳转到原文处」: switch to outline, scroll to the anchored node, flash it
function jumpToNode(id) {
  if (!id) return;
  if (currentView !== 'outline') {
    currentView = 'outline';
    document.querySelectorAll('#viewTabs button').forEach((b) => b.classList.toggle('active', b.getAttribute('data-view') === 'outline'));
    if (latest) render(latest);
  }
  follow = false;
  updateFollowBtn();
  requestAnimationFrame(() => {
    const el = canvas.querySelector(`[data-node="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('jump-flash');
    setTimeout(() => el.classList.remove('jump-flash'), 1600);
  });
}

function renderAnchorPreview() {
  const el = document.getElementById('anchorPreview');
  if (!latest) { el.innerHTML = ''; return; }
  if (selectedId) {
    el.innerHTML = `<span>已指定评论对象：</span><span class="pill">${esc(clip(nodeText(latest, selectedId)))}</span><span class="clear" id="clearAnchor">取消指定</span>`;
    el.querySelector('#clearAnchor').addEventListener('click', () => {
      selectedId = null; composeAnchorId = null; render(latest);
    });
    return;
  }
  const anchorId = composeAnchorId || activeNodeId(latest);
  const label = composeAnchorId ? '撰写中 · 锚定到' : '你正在评论';
  el.innerHTML = `<span>${label}：</span><span class="pill">${esc(clip(nodeText(latest, anchorId))) || '（开场）'}</span>`;
}

// freeze the anchor at the moment the user starts writing
input.addEventListener('focus', () => {
  if (!selectedId && !composeAnchorId && latest) {
    composeAnchorId = activeNodeId(latest);
    renderAnchorPreview();
  }
});
input.addEventListener('input', () => {
  if (!selectedId && !composeAnchorId && latest) composeAnchorId = activeNodeId(latest);
  sendBtn.disabled = !input.value.trim();
  renderAnchorPreview();
});
input.addEventListener('blur', () => {
  if (!input.value.trim()) { composeAnchorId = null; renderAnchorPreview(); }
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);

function send() {
  const text = input.value.trim();
  if (!text || !latest) return;
  const explicit = !!selectedId;
  const anchorNodeId = selectedId || composeAnchorId || activeNodeId(latest);
  sendEvent({ type: 'comment.create', token, text, t_compose: Date.now(), anchorNodeId, explicit });
  input.value = '';
  sendBtn.disabled = true;
  selectedId = null;
  composeAnchorId = null;
  toast('已发送 · 锚定到「' + (clip(nodeText(latest, anchorNodeId), 24) || '当前节点') + '」');
  renderAnchorPreview();
}

// emoji: anchored to the live active node, zero-cost (§2.5)
document.getElementById('emojiBar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-emoji]');
  if (!btn || !latest) return;
  // respect an explicitly-selected node; only fall back to the live node when none chosen
  const anchorNodeId = selectedId || activeNodeId(latest);
  sendEvent({
    type: 'emoji.react',
    token,
    emoji: btn.getAttribute('data-emoji'),
    t_compose: Date.now(),
    anchorNodeId,
    explicit: !!selectedId,
  });
  btn.animate([{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 180 });
});

// view tabs
document.getElementById('viewTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  const prev = currentView;
  currentView = btn.getAttribute('data-view');
  document.querySelectorAll('#viewTabs button').forEach((b) => b.classList.toggle('active', b === btn));
  if (prev === 'replay' && currentView !== 'replay') stopReplay();
  clearInterval(digestTimer);
  if (currentView === 'digest') {
    ensureDigest(true);
    renderDiscussion(latest);
    renderAnchorPreview();
    digestTimer = setInterval(() => { if (currentView === 'digest') refreshDigest(); }, 60000); // §每分钟更新
  } else if (currentView === 'replay') { enterReplay(); renderAnchorPreview(); }
  else if (latest) render(latest);
});

document.getElementById('demoBtn').addEventListener('click', () => {
  control('sim.start', { speed: 1.5 });
  follow = true;
  updateFollowBtn();
  toast('已开始模拟会议（从空白开始）');
});

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---- ASR status chip (client-clock ticker → detects stall even with no broadcasts) ----
let asrInfo = null;
let serverClockOffset = 0;
function updateAsrChip() {
  const el = document.getElementById('asrChip');
  if (!el) return;
  const last = asrInfo ? Math.max(asrInfo.lastSegmentAt || 0, asrInfo.lastInterimAt || 0) : 0;
  if (!last) { el.textContent = '🎙 ASR 未接入'; el.className = 'badge off'; return; }
  const ago = Math.max(0, Math.round((Date.now() + serverClockOffset - last) / 1000));
  const segs = asrInfo.segments || 0;
  const src = asrInfo.source ? ' · ' + asrInfo.source : '';
  if (ago <= 4) { el.textContent = `🎙 识别中 · ${segs} 段${src}`; el.className = 'badge on'; }
  else if (ago <= 15) { el.textContent = `🎙 等待语音 · ${ago}s`; el.className = 'badge'; }
  else { el.textContent = `⚠ ASR 中断? · ${ago}s 无数据`; el.className = 'badge warn'; }
}
setInterval(updateAsrChip, 1000);

// connection + outbox indicator: shows queued (unacked) events while the link is flaky
onStatus((s, pending) => {
  const label = document.getElementById('liveLabel');
  if (s === 'open') label.textContent = pending ? `LIVE · ${pending} 待发` : 'LIVE';
  else label.textContent = pending ? `重连中 · ${pending} 待发` : '重连中';
});

subscribe((state, engine) => {
  const badge = document.getElementById('llmBadge');
  badge.textContent = engine.label || (engine.enabled ? 'LLM 综合' : '启发式综合');
  badge.className = 'badge ' + (engine.enabled ? 'on' : 'off');
  const rc = document.getElementById('roomChip');
  if (rc) rc.textContent = '房间 ' + roomId + (state && state.ended ? ' · 已结束(只读)' : '');
  render(state);
});

updateFollowBtn();
document.getElementById('roomChip').textContent = '房间 ' + roomId;
