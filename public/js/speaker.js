// Speaker console: drives slides (chapter skeleton) and ASR (page-level narration).

import { roomId, apiUrl, token, subscribe, sendEvent, sendEphemeral, control, authHeaders, getAuthToken, setAuthToken } from './ws-client.js';
import { esc } from './util.js';

let latest = null;

// ---- login gate: Speaker requires a logged-in user (audience/screen do not) ----
(async function authGate() {
  const ov = document.getElementById('authGate');
  if (!ov) return;
  const msg = document.getElementById('agMsg');
  async function authedOk() {
    const t = getAuthToken();
    if (!t) return false;
    try {
      const r = await fetch('/api/auth/me', { headers: { 'x-auth-token': t } });
      if (!r.ok) return false;
      const d = await r.json();
      return d.ok && (d.role === 'speaker' || d.role === 'admin');
    } catch { return false; }
  }
  async function doLogin() {
    const u = document.getElementById('agUser').value.trim();
    const p = document.getElementById('agPass').value;
    if (!u || !p) { msg.textContent = '请输入用户名和密码'; return; }
    msg.textContent = '登录中…';
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
      const d = await r.json();
      if (d.ok) { setAuthToken(d.token); location.reload(); } // reload so the WS reconnects authed
      else msg.textContent = d.error || '登录失败';
    } catch (e) { msg.textContent = '请求失败：' + e.message; }
  }
  if (await authedOk()) { ov.style.display = 'none'; return; }
  setAuthToken(''); // clear any stale/expired token
  ov.style.display = 'flex';
  document.getElementById('agLogin').addEventListener('click', doLogin);
  document.getElementById('agPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
})();

window.mcLogout = () => { setAuthToken(''); location.reload(); };

// ---- 数据备份（localStorage）+ 导出 ----
const LS_KEY = 'mc_data_' + roomId;
let lastSaveAt = 0;
function persistLocal(state) {
  const now = Date.now();
  if (now - lastSaveAt < 4000) return; // throttle
  lastSaveAt = now;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ savedAt: now, room: roomId, title: state.config.title, state }));
    const h = document.getElementById('backupHint');
    if (h) h.textContent = '已本地备份 · ' + new Date(now).toLocaleTimeString() + '（localStorage，可随时导出）';
  } catch (e) {
    const h = document.getElementById('backupHint');
    if (h) h.textContent = '本地备份失败（可能超出浏览器容量）：' + e.message;
  }
}
function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function transcriptText(state) {
  const root = state.nodes[state.root];
  const secs = (root.children || []).map((id) => state.nodes[id]).filter(Boolean);
  let out = (state.config.title || '会议') + '\n\n';
  secs.forEach((s, i) => {
    out += `## ${i + 1}. ${s.text}\n`;
    (s.children || []).map((id) => state.nodes[id]).filter(Boolean).forEach((p) => {
      out += (p.speaker ? `[${p.speaker}] ` : '') + p.text + '\n';
    });
    out += '\n';
  });
  return out;
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
document.getElementById('exportJson').addEventListener('click', () => {
  const data = localStorage.getItem(LS_KEY) || JSON.stringify({ room: roomId, state: latest });
  download(`mindcanvas-${roomId}-${stamp()}.json`, data, 'application/json');
});
document.getElementById('exportTxt').addEventListener('click', () => {
  if (!latest) return;
  download(`mindcanvas-${roomId}-${stamp()}.txt`, transcriptText(latest), 'text/plain;charset=utf-8');
});
document.getElementById('exportMd').addEventListener('click', async () => {
  const h = document.getElementById('backupHint');
  if (h) h.textContent = '生成纪要中…';
  try {
    const res = await fetch(apiUrl('/api/digest'));
    const d = await res.json();
    if (d.ok) download(`mindcanvas-纪要-${roomId}-${stamp()}.md`, d.markdown, 'text/markdown;charset=utf-8');
    if (h) h.textContent = '已导出纪要 Markdown';
  } catch (e) {
    if (h) h.textContent = '导出纪要失败：' + e.message;
  }
});

// ---- room ----
document.getElementById('roomName').textContent = roomId;
document.getElementById('roomLink').value = location.origin + '/?room=' + encodeURIComponent(roomId);
document.getElementById('openAudience').href = '/?room=' + encodeURIComponent(roomId); // room-aware (bare / 404s)
document.getElementById('copyRoomLink').addEventListener('click', () => {
  navigator.clipboard?.writeText(document.getElementById('roomLink').value);
  toast('观众链接已复制');
});
document.getElementById('newRoomBtn').addEventListener('click', () => {
  const id = 'r' + Math.random().toString(36).slice(2, 8);
  location.href = '/speaker?room=' + id;
});
document.getElementById('openScreen').addEventListener('click', () => {
  window.open('/screen?room=' + encodeURIComponent(roomId), '_blank');
});

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// ---- ① title ----
document.getElementById('setTitleBtn').addEventListener('click', () => {
  const title = document.getElementById('titleInput').value.trim();
  if (!title) return;
  sendEvent({ type: 'session.config', title });
  toast('标题已设置');
});

// ---- ② slides ----
function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}

document.getElementById('addSlideBtn').addEventListener('click', async () => {
  const titleEl = document.getElementById('slideTitle');
  const bodyEl = document.getElementById('slideBody');
  const fileEl = document.getElementById('slideImage');
  let title = titleEl.value.trim();
  let body = bodyEl.value.trim();
  let imageUrl = null;

  if (fileEl.files[0]) {
    imageUrl = await fileToDataUrl(fileEl.files[0]);
    // try server-side OCR to prefill title/body (only works if a key is configured)
    if (!title) {
      try {
        const res = await fetch('/api/ocr', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ dataUrl: imageUrl }),
        });
        const data = await res.json();
        if (data.ok) { title = title || data.title; body = body || data.body; }
      } catch {}
    }
  }

  if (!title && !imageUrl) { toast('请填写幻灯片标题或上传图片'); return; }
  sendEvent({ type: 'slide.change', title: title || '（未命名幻灯片）', body, imageUrl, ocrText: body });
  titleEl.value = '';
  bodyEl.value = '';
  fileEl.value = '';
  toast('已翻到新页 → 新章节');
});

function renderSlides(state) {
  const el = document.getElementById('slideList');
  if (!state.slides.length) { el.innerHTML = '<div style="color:var(--faint)">尚无幻灯片</div>'; return; }
  el.innerHTML = state.slides
    .map((s, i) => `<div>${i + 1}. ${esc(s.title)} ${s.id === state.currentSlideId ? '◀ 当前' : ''}</div>`)
    .join('');
}

// ---- ③ ASR: STREAMING over a NON-STREAMING backend ----
// glm-asr is request/response (one clip ≤30s), not streaming. We turn it into a
// streaming experience with client-side VAD (voice-activity detection): capture mic
// continuously, segment at natural PAUSES (not fixed windows, so words aren't cut),
// and fire each utterance to the batch ASR the moment the speaker pauses. An ordered
// queue keeps the transcript in sequence. Encodes WAV in-browser (no Google, no ffmpeg).
const micBtn = document.getElementById('micBtn');
const asrStatus = document.getElementById('asrStatus');
const asrLive = document.getElementById('asrLive');

let micOn = false;
let audioCtx = null, micStream = null, srcNode = null, procNode = null;
let sampleRate = 16000, chunkSeq = 0;

// VAD parameters (RMS hysteresis + silence hang-over)
const VAD_ON = 0.014, VAD_OFF = 0.008;
const HANG_MS = 650;     // trailing silence that ends an utterance
const MIN_MS = 350;      // ignore blips
const MAX_MS = 18000;    // force-cut long monologues (stay under the 30s API limit)
const PREROLL_MS = 280;  // keep audio just before speech so onsets aren't clipped

let inSpeech = false, silenceMs = 0, uttMs = 0, uttBuf = [], preRoll = [], preMs = 0;

function encodeWAV(samples, sr) {
  const n = samples.length;
  const dv = new DataView(new ArrayBuffer(44 + n * 2));
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
  return new Blob([dv.buffer], { type: 'audio/wav' });
}
const rmsOf = (b) => { let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / b.length); };
const frameMs = (b) => (b.length / sampleRate) * 1000;

function onFrame(frame) {
  const ms = frameMs(frame);
  const rms = rmsOf(frame);
  // rolling pre-roll buffer (recent audio before speech onset)
  preRoll.push(frame); preMs += ms;
  while (preMs > PREROLL_MS && preRoll.length > 1) preMs -= frameMs(preRoll.shift());

  if (rms > VAD_ON && !inSpeech) { inSpeech = true; uttBuf = preRoll.slice(); uttMs = preMs; silenceMs = 0; }
  if (inSpeech) {
    uttBuf.push(frame); uttMs += ms;
    silenceMs = rms < VAD_OFF ? silenceMs + ms : 0;
    if (silenceMs >= HANG_MS || uttMs >= MAX_MS) endUtterance();
  }
}

function endUtterance() {
  const buf = uttBuf, dur = uttMs;
  inSpeech = false; uttBuf = []; uttMs = 0; silenceMs = 0;
  if (dur < MIN_MS) return;
  let len = 0; for (const f of buf) len += f.length;
  const samples = new Float32Array(len);
  let off = 0; for (const f of buf) { samples.set(f, off); off += f.length; }
  if (rmsOf(samples) < 0.006) return; // safety: skip silent → avoids glm-asr "no audio"
  enqueue(encodeWAV(samples, sampleRate));
}

// ordered queue → batch ASR one utterance at a time, so the transcript stays in order
const asrQueue = [];
let draining = false;
function enqueue(wav) { asrQueue.push(wav); drain(); }
async function drain() {
  if (draining) return;
  draining = true;
  while (asrQueue.length) {
    const wav = asrQueue.shift();
    const id = 'mic_' + token + '_' + ++chunkSeq;
    asrLive.textContent = '（识别中…）';
    sendEphemeral({ type: 'asr.interim', text: '（识别中…）', source: 'glm-asr' });
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try {
        const res = await fetch(apiUrl('/api/asr') + '&id=' + encodeURIComponent(id), {
          method: 'POST', headers: { 'content-type': 'audio/wav', ...authHeaders() }, body: wav,
        });
        const data = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
        if (data.ok) { asrLive.textContent = data.text || '（聆听中…）'; ok = true; }
        else { asrStatus.textContent = 'ASR：' + (data.error || '失败'); if (/no-llm|余额|资源|不可用/.test(data.error || '')) { asrQueue.length = 0; ok = true; } }
      } catch { await new Promise((r) => setTimeout(r, 500 * (i + 1))); } // backoff retry (断点重传)
    }
  }
  draining = false;
}

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sampleRate = audioCtx.sampleRate;
  srcNode = audioCtx.createMediaStreamSource(micStream);
  procNode = audioCtx.createScriptProcessor(4096, 1, 1);
  inSpeech = false; silenceMs = 0; uttMs = 0; uttBuf = []; preRoll = []; preMs = 0;
  procNode.onaudioprocess = (e) => { if (micOn) onFrame(new Float32Array(e.inputBuffer.getChannelData(0))); };
  srcNode.connect(procNode);
  procNode.connect(audioCtx.destination); // silent (we never write output) — required to run
}

function stopMic() {
  if (inSpeech) endUtterance(); // flush the tail
  try { if (procNode) procNode.disconnect(); } catch { /* */ }
  try { if (srcNode) srcNode.disconnect(); } catch { /* */ }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  audioCtx = micStream = srcNode = procNode = null;
}

micBtn.addEventListener('click', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    asrStatus.textContent = '此浏览器不支持麦克风采集，请用下方手动输入。';
    return;
  }
  micOn = !micOn;
  if (micOn) {
    try {
      await startMic();
      micBtn.textContent = '⏹ 停止语音转写';
      asrStatus.textContent = '🎙 聆听中…（每 ~6s 一段 → GLM-ASR）';
      asrStatus.classList.add('mic-on');
    } catch (e) {
      micOn = false;
      asrStatus.textContent = '⚠ 无法访问麦克风：' + e.message;
    }
  } else {
    stopMic();
    micBtn.textContent = '🎙 开始语音转写';
    asrStatus.textContent = '已停止';
    asrStatus.classList.remove('mic-on');
    asrLive.textContent = '（实时转写将显示在这里）';
  }
});

// manual ASR
function sendManual() {
  const el = document.getElementById('manualAsr');
  const text = el.value.trim();
  if (!text) return;
  sendEvent({ type: 'asr.segment', text, source: 'mic', t_start: Date.now(), t_end: Date.now() });
  el.value = '';
  toast('已发送讲解片段');
}
document.getElementById('sendManualBtn').addEventListener('click', sendManual);
document.getElementById('manualAsr').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendManual(); }
});

// upload an audio file (mp3/wav/m4a) → decode in-browser → 8s WAV chunks → GLM-ASR.
// Reuses encodeWAV + /api/asr (same path as the mic), so it works without ffmpeg.
document.getElementById('audioFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('fileStatus');
  status.textContent = '解码中…';
  try {
    const arr = await file.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ac.decodeAudioData(arr);
    ac.close();
    const ch = audio.getChannelData(0);
    const sr = audio.sampleRate;
    const SEG = Math.floor(sr * 8); // 8s windows (≤30s glm-asr limit)
    const total = Math.ceil(ch.length / SEG);
    sendEvent({ type: 'session.config', title: '音频测试 · ' + file.name });
    status.textContent = `时长 ${Math.round(audio.duration)}s，共 ${total} 段，开始转写…`;
    let fatal = '';
    for (let i = 0; i < total; i++) {
      const slice = ch.subarray(i * SEG, Math.min(ch.length, (i + 1) * SEG));
      let sum = 0;
      for (let j = 0; j < slice.length; j++) sum += slice[j] * slice[j];
      if (Math.sqrt(sum / slice.length) < 0.006) { status.textContent = `第 ${i + 1}/${total} 段静音，跳过`; continue; }
      const wav = encodeWAV(slice, sr);
      const id = 'file_' + token + '_' + Date.now() + '_' + i;
      status.textContent = `识别第 ${i + 1}/${total} 段…`;
      try {
        const res = await fetch(apiUrl('/api/asr') + '&id=' + encodeURIComponent(id), {
          method: 'POST', headers: { 'content-type': 'audio/wav', ...authHeaders() }, body: wav,
        });
        const data = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
        if (!data.ok && /余额|资源|no-llm|不可用/.test(data.error || '')) { fatal = data.error; break; }
      } catch (err) { await new Promise((r) => setTimeout(r, 600)); } // transient → keep going
    }
    status.textContent = fatal ? '已停止：' + fatal : '✓ 文件转写完成。';
  } catch (err) {
    status.textContent = '解码失败：' + err.message + '（试试 wav / 标准 mp3）';
  }
  e.target.value = '';
});

// ---- ④ simulation ----
document.getElementById('transcriptBtn').addEventListener('click', () => { control('transcript.start', { speed: 2.5 }); toast('开始播放真实文稿（纯语音）'); });
document.getElementById('simStartBtn').addEventListener('click', () => { control('sim.start', { speed: 1 }); toast('模拟开始'); });
document.getElementById('simStopBtn').addEventListener('click', () => { control('sim.stop'); toast('模拟停止'); });
// 会议「结束/清空」已收归管理后台（/admin）——主讲台不再能结束会议。

// 🤖 AI colleague personas toggle (optimistic)
let agentsOn = false;
document.getElementById('agentsBtn').addEventListener('click', () => {
  agentsOn = !agentsOn;
  control(agentsOn ? 'agents.on' : 'agents.off');
  const b = document.getElementById('agentsBtn');
  b.textContent = '🤖 AI 同事参与：' + (agentsOn ? '开' : '关');
  b.classList.toggle('on', agentsOn);
  toast(agentsOn ? 'AI 同事已加入，会不定时评论' : '已停止 AI 同事参与');
});

// ⑥ runtime engine / API key config (frontend → server memory)
document.getElementById('cfgProvider').addEventListener('change', (e) => {
  const m = document.getElementById('cfgModel');
  m.placeholder = e.target.value === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'glm-5.1 / glm-4.6';
});
document.getElementById('cfgSave').addEventListener('click', async () => {
  const provider = document.getElementById('cfgProvider').value;
  const key = document.getElementById('cfgKey').value.trim();
  const model = document.getElementById('cfgModel').value.trim();
  const endpoint = document.getElementById('cfgEndpoint').value.trim();
  const status = document.getElementById('cfgStatus');
  if (!key) { status.textContent = '请填写 key'; return; }
  status.textContent = '校验中…';
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ provider, key, model: model || undefined, endpoint: endpoint || undefined }),
    });
    const data = await res.json();
    document.getElementById('cfgKey').value = ''; // never keep the key in the DOM
    if (data.ok && data.valid) {
      status.textContent = '✓ 已启用 ' + data.info.label;
      toast('引擎已配置：' + data.info.label);
    } else {
      status.textContent = '⚠ 校验失败：' + (data.error || '未知错误');
      toast('校验失败');
    }
  } catch (e) {
    status.textContent = '⚠ 请求失败：' + e.message;
  }
});

subscribe((state, engine) => {
  latest = state;
  persistLocal(state);
  renderSlides(state);
  const badge = document.getElementById('llmBadge');
  badge.textContent = engine.label || (engine.enabled ? 'LLM 综合' : '启发式综合');
  badge.className = 'badge ' + (engine.enabled ? 'on' : 'off');
});

// ---- ⑦ 上传资料到检索（资料补充·本地语料） ----
(function docsPanel() {
  const fileEl = document.getElementById('docFile');
  const statusEl = document.getElementById('docStatus');
  const listEl = document.getElementById('docList');
  const modeBtn = document.getElementById('docModeBtn');
  const modeHint = document.getElementById('docModeHint');
  if (!fileEl) return;
  let curMode = 'web';
  const fmtKB = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : Math.round(b / 1024) + 'KB');
  function renderMode() {
    const local = curMode === 'local';
    modeBtn.textContent = '本地检索：' + (local ? '开' : '关');
    modeBtn.classList.toggle('ghost', !local);
    modeHint.textContent = local ? '（资料补充用你上传的本地资料）' : '当前来源：' + curMode;
  }
  async function refresh() {
    try {
      const d = await (await fetch('/api/docs', { headers: authHeaders() })).json();
      if (!d.ok) return;
      curMode = d.mode; renderMode();
      const files = d.files || [];
      listEl.innerHTML = files.length
        ? files.map((f) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--line)"><span>${esc(f.name)} <span style="color:var(--faint)">· ${fmtKB(f.size)}</span></span><button class="btn ghost" data-del="${esc(f.name)}" style="font-size:11px;padding:2px 8px">删除</button></div>`).join('')
          + `<div style="color:var(--faint);margin-top:6px">语料：${d.corpus.files} 文件 · ${d.corpus.chunks} 段（含内置示例）</div>`
        : '<span style="color:var(--faint)">暂无上传资料（内置示例语料仍可用）</span>';
      listEl.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', () => delDoc(b.getAttribute('data-del'))));
    } catch { /* ignore */ }
  }
  async function delDoc(name) {
    if (!confirm('删除「' + name + '」？')) return;
    await fetch('/api/docs?name=' + encodeURIComponent(name), { method: 'DELETE', headers: authHeaders() });
    refresh();
  }
  document.getElementById('docUploadBtn').addEventListener('click', async () => {
    const f = fileEl.files[0];
    if (!f) { statusEl.textContent = '请选择文件'; return; }
    statusEl.textContent = '上传中…';
    try {
      const buf = await f.arrayBuffer();
      const res = await fetch('/api/docs/upload?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...authHeaders() }, body: buf });
      const d = await res.json();
      if (d.ok) { statusEl.textContent = '✓ 已加入（' + d.chars + ' 字）'; fileEl.value = ''; refresh(); }
      else statusEl.textContent = '⚠ ' + (d.error || '失败');
    } catch (e) { statusEl.textContent = '失败：' + e.message; }
  });
  modeBtn.addEventListener('click', async () => {
    const next = curMode === 'local' ? 'web' : 'local';
    try {
      const d = await (await fetch('/api/docs/mode', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ mode: next }) })).json();
      if (d.ok) { curMode = d.mode; renderMode(); toast('资料补充来源：' + curMode); }
    } catch { /* ignore */ }
  });
  refresh();
})();
