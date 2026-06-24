// Big-screen ambient display. Read-only: shows what's being discussed and SPOTLIGHTS
// the latest audience interactions — new comments pop into a spotlight + feed, new
// emoji float up, counters bump. Diffs each snapshot against the last to find "new".

import { roomId, subscribe, onStatus } from './ws-client.js';
import { esc, personaColor } from './util.js';

const $ = (id) => document.getElementById(id);
const seen = new Set();
let firstSnap = true;
let prevReactions = 0;
let prevP = 0, prevI = 0;
let spotlightId = null;
let asrInfo = null, clockOffset = 0;

function activeNode(state) {
  const sec = state.nodes[state.currentSectionId];
  if (!sec) return null;
  for (const id of sec.children) if (state.nodes[id]?.open) return state.nodes[id];
  if (sec.children.length) return state.nodes[sec.children[sec.children.length - 1]];
  return sec;
}
function nodeText(state, id) { return state.nodes[id]?.text || ''; }
function agoText(t) {
  const s = Math.max(0, Math.round((Date.now() + clockOffset - t) / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return s + ' 秒前';
  return Math.floor(s / 60) + ' 分前';
}

function bump(el, prev, val) {
  el.textContent = val;
  if (val !== prev) {
    const box = el.parentElement;
    box.classList.remove('bump');
    void box.offsetWidth;
    box.classList.add('bump');
  }
}

function spawnFloat(emoji) {
  const el = document.createElement('div');
  el.className = 'float';
  el.textContent = emoji;
  const x = 55 + Math.random() * 40; // right side, where the interactions live
  el.style.left = x + 'vw';
  el.style.bottom = '8vh';
  $('floats').appendChild(el);
  const drift = (Math.random() - 0.5) * 120;
  el.animate(
    [
      { transform: 'translate(0,0) scale(.6)', opacity: 0 },
      { transform: `translate(${drift * 0.4}px,-12vh) scale(1.1)`, opacity: 1, offset: 0.15 },
      { transform: `translate(${drift}px,-72vh) scale(1)`, opacity: 0 },
    ],
    { duration: 3200 + Math.random() * 1200, easing: 'cubic-bezier(.3,.7,.4,1)' }
  ).onfinish = () => el.remove();
}

function setSpotlight(c, state, animate) {
  spotlightId = c.id;
  const sp = $('spotlight');
  sp.classList.remove('empty');
  const author = c.byAgent ? `<span style="color:${personaColor(c.persona)}">🤖 ${esc(c.persona)}</span>` : '匿名观众';
  sp.innerHTML = `
    <div class="who">${c.replyTo ? '↩ 回应 · ' : ''}${author} · ${agoText(c.t)}${c.isQuestion ? ' · 提问' : ''}</div>
    <div class="txt">${esc(c.text)}</div>
    <div class="anchor">↳ ${esc(nodeText(state, c.anchorNodeId) || '当前内容')}</div>`;
  if (animate) { sp.classList.remove('flash'); void sp.offsetWidth; sp.classList.add('flash'); }
}

function addFeedItem(c, animate) {
  const feed = $('feed');
  const div = document.createElement('div');
  div.className = 'item';
  if (!animate) div.style.animation = 'none';
  const author = c.byAgent ? `<b style="color:${personaColor(c.persona)}">🤖${esc(c.persona)}</b> ` : '';
  div.innerHTML = `<span class="tag ${c.isQuestion ? 'question' : 'comment'}">${c.isQuestion ? '问' : '评'}</span>${c.replyTo ? '<span style="color:var(--hot)">↩</span> ' : ''}${author}${esc(c.text)}`;
  feed.insertBefore(div, feed.firstChild);
  while (feed.children.length > 12) feed.removeChild(feed.lastChild);
}

function render(state) {
  $('title').textContent = state.config.title || '';
  $('roomChip').textContent = '房间 ' + roomId;
  clockOffset = (state.serverTime || Date.now()) - Date.now();
  asrInfo = state.asr || null;

  // left: ONLY the current paragraph's core — its title (GLM gist) + the latest point
  const sec = state.nodes[state.currentSectionId];
  const nt = $('nowTitle');
  nt.textContent = sec ? sec.text : '等待开始…';
  nt.classList.toggle('prov', !!(sec && sec.provisional));
  let core = '';
  if (sec) {
    const pts = (sec.children || []).map((id) => state.nodes[id]).filter(Boolean);
    const cur = pts[pts.length - 1];
    if (cur) core = esc(cur.text);
  }
  $('nowCore').innerHTML = core;
  $('speaking').innerHTML = state.liveTranscript ? `🎙 ${esc(state.liveTranscript)}<span class="cur">▍</span>` : '';

  // counters (bump on change)
  const P = state.stats.participants || 0;
  const I = (state.stats.reactionCount || 0) + (state.stats.commentCount || 0);
  bump($('nP'), prevP, P); bump($('nI'), prevI, I); prevP = P; prevI = I;

  // comments → spotlight + feed (newest highlighted)
  const comments = Object.values(state.comments || {}).sort((a, b) => a.t - b.t);
  if (firstSnap) {
    comments.forEach((c) => seen.add(c.id));
    comments.slice(-6).forEach((c) => addFeedItem(c, false));
    const last = comments[comments.length - 1];
    if (last) setSpotlight(last, state, false);
  } else {
    const fresh = comments.filter((c) => !seen.has(c.id));
    fresh.forEach((c) => { seen.add(c.id); addFeedItem(c, true); });
    if (fresh.length) setSpotlight(fresh[fresh.length - 1], state, true);
  }

  // emoji → floating reactions (diff by monotonic reactionCount)
  const rc = state.stats.reactionCount || 0;
  if (firstSnap) {
    prevReactions = rc;
  } else if (rc > prevReactions) {
    const n = Math.min(rc - prevReactions, 14);
    const tail = (state.reactions || []).slice(-n);
    tail.forEach((r, i) => setTimeout(() => spawnFloat(r.emoji), i * 120));
    prevReactions = rc;
  }

  // emoji tally
  const tally = {};
  for (const n of Object.values(state.nodes)) for (const [e, c] of Object.entries(n.emoji || {})) tally[e] = (tally[e] || 0) + c;
  $('tally').innerHTML = Object.entries(tally).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])
    .map(([e, c]) => `<span>${e} <b>${c}</b></span>`).join('') || '<span style="color:var(--faint);font-size:18px">等待表情…</span>';

  // 🔎 web-search supplements (latest first)
  const sups = (state.supplements || []).slice(-3).reverse();
  $('supps').innerHTML = sups.length
    ? sups.map((s) => `<div class="supp"><div class="supp-t">${esc(s.text)}</div><div class="supp-s">— ${esc(s.source || '网络')}${s.nodeText ? ' · ↳ ' + esc(s.nodeText) : ''}</div></div>`).join('')
    : '<div style="color:var(--faint);font-size:16px">（开启 AI 同事后会联网补充相关资料）</div>';

  // focus questions
  const qs = (state.questions || []).slice(0, 3);
  $('questions').innerHTML = qs.length
    ? qs.map((q) => `<div class="q"><span class="cnt">×${q.size}</span>${esc(q.label)}</div>`).join('')
    : '<div style="color:var(--faint);font-size:18px">暂无</div>';

  firstSnap = false;
}

function updateAsrChip() {
  const el = $('asrChip');
  const last = asrInfo ? Math.max(asrInfo.lastSegmentAt || 0, asrInfo.lastInterimAt || 0) : 0;
  if (!last) { el.textContent = '🎙 待接入'; return; }
  const ago = Math.max(0, Math.round((Date.now() + clockOffset - last) / 1000));
  el.textContent = ago <= 4 ? `🎙 识别中 · ${asrInfo.segments || 0}` : ago <= 15 ? `🎙 等待 ${ago}s` : `⚠ ASR ${ago}s`;
}
setInterval(updateAsrChip, 1000);

onStatus((s) => { $('liveLabel').textContent = s === 'open' ? 'LIVE' : '重连中'; });
subscribe(render);
