// Shared client: WebSocket + anonymous session token (§2.6) + reliable outbox.
//
// Reliability (断点重传): every outbound durable event gets a stable id and goes into
// an outbox persisted in sessionStorage. It's sent immediately if connected, resent on
// reconnect, and removed only when the server acks it. A periodic timer re-sends
// unacked events (covers lost acks / brief drops). The server dedups by id, so resends
// are idempotent. Downstream (server→client) resumes via full snapshot on reconnect.

function makeToken() {
  let t = sessionStorage.getItem('mc_token');
  if (!t) {
    t = 'a' + Math.random().toString(36).slice(2, 9);
    sessionStorage.setItem('mc_token', t);
  }
  return t;
}
export const token = makeToken();

// ---- login session token (speaker/admin). Audience/screen never set this. ----
export function getAuthToken() { try { return localStorage.getItem('mc_auth') || ''; } catch { return ''; } }
export function setAuthToken(t) { try { if (t) localStorage.setItem('mc_auth', t); else localStorage.removeItem('mc_auth'); } catch { /* */ } }
export function authHeaders() { const t = getAuthToken(); return t ? { 'x-auth-token': t } : {}; }

// room id from ?room=<id> (default "main"). Each room is an independent meeting.
function sanitizeRoom(id) {
  const s = String(id || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return s || 'main';
}
export const roomId = sanitizeRoom(new URLSearchParams(location.search).get('room'));
export function apiUrl(path) {
  return path + (path.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(roomId);
}

let ws = null;
let state = null;
let engine = { llm: false };
let connected = false;
let seq = 0;
const subs = new Set();
const statusSubs = new Set();

const OUTBOX_KEY = 'mc_outbox_' + roomId;
function loadOutbox() {
  try { return JSON.parse(sessionStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}
let outbox = loadOutbox(); // unacked durable events
function persistOutbox() {
  try { sessionStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.slice(-300))); } catch { /* quota */ }
}
export function pendingCount() { return outbox.length; }

function notifyStatus() {
  const s = connected ? 'open' : 'closed';
  statusSubs.forEach((f) => f(s, outbox.length));
}

function rawSend(ev) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ kind: 'event', event: ev })); return true; } catch { /* fallthrough */ }
  }
  return false;
}
function resend() {
  for (const ev of outbox) rawSend(ev);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const auth = getAuthToken();
  ws = new WebSocket(`${proto}://${location.host}/?room=${encodeURIComponent(roomId)}${auth ? '&auth=' + encodeURIComponent(auth) : ''}`);
  ws.addEventListener('open', () => {
    connected = true;
    notifyStatus();
    resend(); // flush anything queued while disconnected
  });
  ws.addEventListener('close', () => {
    connected = false;
    notifyStatus();
    setTimeout(connect, 1200); // auto-reconnect
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.kind === 'snapshot') {
      state = msg.state;
      if (state) state.ended = !!msg.ended; // 会议已结束（只读）
      if (msg.engine) engine = msg.engine;
      subs.forEach((f) => f(state, engine));
    } else if (msg.kind === 'ack' && Array.isArray(msg.ids)) {
      const acked = new Set(msg.ids);
      const before = outbox.length;
      outbox = outbox.filter((ev) => !acked.has(ev.id));
      if (outbox.length !== before) { persistOutbox(); notifyStatus(); }
    }
  });
}

export function subscribe(cb) {
  subs.add(cb);
  if (state) cb(state, engine);
  return () => subs.delete(cb);
}

export function onStatus(cb) {
  statusSubs.add(cb);
  cb(connected ? 'open' : 'closed', outbox.length);
  return () => statusSubs.delete(cb);
}

// durable event → reliable delivery (id + outbox + retransmit)
export function sendEvent(event) {
  if (!event.id) event.id = 'e_' + token + '_' + ++seq;
  outbox.push(event);
  persistOutbox();
  rawSend(event);
  notifyStatus();
}

// ephemeral events (e.g. asr.interim) — fire-and-forget, never outboxed/retried
export function sendEphemeral(event) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ kind: 'event', event })); } catch { /* ignore */ }
  }
}

// control messages (sim/reset/transcript) are host actions — fire-and-forget
export function control(action, extra = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ kind: 'control', action, ...extra }));
}

export function getState() { return state; }
export function getEngine() { return engine; }

// retransmit unacked events periodically (lost ack / flaky link); dedup makes it safe
setInterval(() => { if (connected && outbox.length) resend(); }, 4000);

connect();
