// MindCanvas server: central reducer + cheap broadcast, now MULTI-ROOM. Each room is an
// independent meeting (its own Store / sim / history / loops). Clients pick a room via
// ?room=<id> on the WebSocket and the HTTP API; default room is "main". The LLM engine
// key is process-global (one key powers all rooms), configured at runtime from the UI.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import * as Auth from './auth.js';
import { Store } from './store.js';
import { clusterNode } from './clustering.js';
import { segmentNarration } from './narration.js';
import { runSimulation } from './simulation.js';
import { runTranscript } from './transcript.js';
import { buildDigest, digestToMarkdown } from './digest.js';
import * as DB from './db.js';
import { uid } from './util.js';
import { llmEnabled, llmInfo, llmReadSlide, setLlmConfig, llmPing, llmTranscribe, asrAvailable, llmCorrectPoints, llmPersonaComment, llmPersonaReply, searchMode, visionAvailable } from './llm.js';
import * as docsearch from './docsearch.js';
import * as search from './search.js';
import { extractText } from './extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// load project-root .env (keys for the synthesis engine) — no dependency needed
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* no .env — heuristic fallback */
}

const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 8787;
const HISTORY_EVERY_MS = 1500;
const HISTORY_MAX = 260;
const ROOM_TTL_MS = 30 * 60 * 1000;
const DB_PATH = process.env.MINDCANVAS_DB || path.join(__dirname, '..', 'data', 'mindcanvas.db');
// shareable digest snapshots (/d/<id>) live next to the DB so they're on the same
// persistent volume in prod (survive redeploys), not the ephemeral container FS.
const DIGESTS = process.env.MINDCANVAS_DIGESTS || path.join(path.dirname(DB_PATH), 'digests');
// offline 资料补充 corpus (Word/PDF/PPT indexed to JSON, or a folder of txt/md)
const DOCS_INDEX = process.env.MINDCANVAS_DOCS_INDEX || path.join(path.dirname(DB_PATH), 'docs-index.json');
const DOCS_DIR = process.env.MINDCANVAS_DOCS_DIR || path.join(path.dirname(DB_PATH), 'docs');
const DOCS_SEED = process.env.MINDCANVAS_DOCS_SEED || path.join(__dirname, '..', 'seed-docs'); // shipped fallback corpus

// ---- persistence (SQLite) ----
try {
  DB.initDb(DB_PATH);
  // restore the LLM config that admin persisted (so the server "remembers" the key)
  const sp = DB.getSetting('provider');
  const sk = DB.getSetting('api_key');
  if (sk) setLlmConfig({ provider: sp || 'zhipu', key: sk, model: DB.getSetting('model') || undefined, endpoint: DB.getSetting('base_url') || undefined });
  const sm = DB.getSetting('search_mode'); // 资料补充模式（speaker/admin 可切换并持久化）
  if (sm) process.env.MINDCANVAS_SEARCH_MODE = sm;
  console.log(`  数据库:    ${DB_PATH}${sk ? '  (已恢复 LLM 配置)' : ''}`);
} catch (e) {
  console.warn('[db] init failed — running without persistence:', e.message);
}

// ---- offline document corpus (for local-mode 资料补充) — after key restore so searchMode() is accurate ----
try {
  const info = docsearch.loadCorpus({ indexPath: DOCS_INDEX, docsDir: DOCS_DIR, seedDir: DOCS_SEED });
  if (info.chunks) console.log(`  本地资料:  ${info.files} 个文件 · ${info.chunks} 段 (搜索模式: ${searchMode()})`);
} catch (e) {
  console.warn('[docsearch] load failed:', e.message);
}

// ---- auth (simple user login) ----
try {
  let secret = DB.getSetting('auth_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); DB.setSetting('auth_secret', secret); }
  Auth.setAuthSecret(secret);
  if (DB.countUsers() === 0) {
    const ap = process.env.MINDCANVAS_ADMIN_PASSWORD || 'admin';
    const spw = process.env.MINDCANVAS_SPEAKER_PASSWORD || 'speaker';
    DB.upsertUser('admin', Auth.hashPassword(ap), 'admin');
    DB.upsertUser('speaker', Auth.hashPassword(spw), 'speaker');
    console.log('  用户:      已创建默认账户 admin / speaker（请尽快在管理后台修改密码）');
  }
} catch (e) {
  console.warn('[auth] init failed:', e.message);
}

// auth helpers: a request is authed via Bearer / x-auth-token session token.
function authUser(req) {
  const h = req.headers['authorization'];
  const tok = (h && h.startsWith('Bearer ') ? h.slice(7) : null) || req.headers['x-auth-token'];
  return tok ? Auth.verifyToken(tok) : null;
}
function isAdmin(req) {
  const u = authUser(req);
  return !!(u && u.role === 'admin');
}
function isSpeaker(req) {
  const u = authUser(req);
  return !!(u && (u.role === 'speaker' || u.role === 'admin'));
}

// Audience may submit only these event types anonymously; everything else
// (slide.change / asr.* / session.config — speaker content) requires login.
const OPEN_EVENT_TYPES = new Set(['comment.create', 'emoji.react']);
function eventAllowed(ev, authed) {
  return authed || (ev && OPEN_EVENT_TYPES.has(ev.type));
}

const NOT_FOUND_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>404 · MindCanvas</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
background:#1c1917;color:#e7e5e4;font-family:ui-serif,Georgia,serif}.c{text-align:center;padding:24px}
.c .n{font-size:72px;font-weight:600;letter-spacing:-2px}.c p{color:#a8a29e;font-family:ui-monospace,monospace;font-size:14px;margin:6px 0}
</style></head><body><div class="c"><div class="n">404</div>
<p>缺少会议房间参数 ?room=&lt;房间号&gt;</p><p>请使用主讲人分发的观众链接进入对应会议。</p></div></body></html>`;

// room-scoped pages require ?room=<id>. Returns the sanitized id, or '' if absent/invalid.
function roomParam(url) {
  const raw = url.searchParams.get('room');
  if (raw == null) return '';
  return String(raw).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}
function safeDb(fn) {
  try { return fn(); } catch { return undefined; }
}
function persistMeeting(room, status) {
  try {
    const s = room.store;
    let pts = 0;
    for (const n of s.nodes.values()) if (n.kind === 'point') pts++;
    if (pts === 0 && s.comments.size === 0 && !status) return;
    const snap = s.snapshot();
    DB.upsertMeeting({
      room: room.id,
      title: s.config.title || '',
      status,
      stats: JSON.stringify({ ...snap.stats, sections: (s.nodes.get(s.root)?.children || []).length, points: pts }),
      snapshot: JSON.stringify(snap),
      digest_md: room.digest ? room.digest.markdown : null,
    });
  } catch (e) {
    console.warn('[persist]', e.message);
  }
}

// §participation: AI "colleague" personas that comment at irregular intervals
const PERSONAS = [
  { id: 'pm', name: '产品经理·小薇', role: '关注落地与用户价值', style: '务实，常问怎么落地、用户买不买单、优先级' },
  { id: 'arch', name: '架构师·老陈', role: '关注实现与性能', style: '技术向，关心实现细节、性能、可扩展性、成本' },
  { id: 'skeptic', name: '怀疑派·阿杰', role: '爱唱反调', style: '质疑、找反例、戳破过度乐观' },
  { id: 'newbie', name: '新人·小白', role: '初学者', style: '问基础问题、把术语翻成人话、好奇' },
  { id: 'data', name: '数据控·Max', role: '要证据', style: '要数据/案例/量化，常说有数据支撑吗' },
  { id: 'biz', name: '行业观察·Lisa', role: '看趋势与竞品', style: '联想行业趋势、竞品、商业模式' },
];
function pickPersona(room) {
  const pool = PERSONAS.filter((p) => p.id !== room.lastPersona);
  const p = pool[Math.floor(Math.random() * pool.length)];
  room.lastPersona = p.id;
  return p;
}

// ---- rooms --------------------------------------------------------------
class Room {
  constructor(id) {
    this.id = id;
    this.store = new Store();
    this.sessionId = uid('s');          // §按 session 留痕：一场「开讲→结束」
    this.sessionStartedAt = Date.now();
    this.sim = null;
    this.history = []; // §「演化回放」snapshots of rendered state over time
    this.lastHistoryAt = 0;
    this.dirty = true;
    this.clustering = false;
    this.segmenting = false;
    this.correcting = false;
    this.agentsOn = false; // §participation: AI colleague personas auto-comment
    this.agentBusy = false;
    this.nextAgentAt = 0;
    this.lastPersona = null;
    this.suppBusy = false; // §资料补充: web-search supplement agent
    this.nextSupplementAt = 0;
    this.digest = null; // §每分钟纪要: cached, auto-regenerated digest
    this.digestAt = 0;
    this.digestSig = '';
    this.digesting = false;
    this.ended = false; // §会议结束（仅管理后台）：locked + read-only
    this.frozenSnapshot = null;
    this.audioSeq = 0;
    this.persistSig = '';
    this.lastActive = Date.now();
  }
  reset() {
    if (this.sim) this.sim.stop();
    this.sim = null;
    this.store = new Store();
    this.history.length = 0;
    this.lastHistoryAt = 0;
    this.digest = null;
    this.digestAt = 0;
    this.digestSig = '';
    this.audioSeq = 0;
    this.sessionId = uid('s');          // 新的一场 session
    this.sessionStartedAt = Date.now();
    this.dirty = true;
  }
}

const rooms = new Map();
function sanitizeRoomId(id) {
  const s = String(id || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return s || 'main';
}
function getRoom(id) {
  const rid = sanitizeRoomId(id);
  let r = rooms.get(rid);
  if (!r) {
    r = new Room(rid);
    // "ended stays ended" across restarts: restore the frozen final state from the DB
    try {
      const m = DB.getMeeting(rid);
      if (m && m.status === 'ended') {
        r.ended = true;
        r.frozenSnapshot = m.snapshot ? JSON.parse(m.snapshot) : null;
      }
    } catch { /* no db */ }
    rooms.set(rid, r);
  }
  r.lastActive = Date.now();
  return r;
}

function applyEvent(room, ev) {
  if (room.ended) return; // locked
  room.store.applyEvent(ev);
  // §逐事件留痕：记录到 events 表（按 room+session）。剥离大字段（如幻灯片 base64 图）。
  safeDb(() => {
    const { imageUrl, dataUrl, ...rest } = ev || {};
    DB.addEvent(room.id, room.sessionId, (ev && ev.type) || 'unknown', JSON.stringify(rest));
  });
  room.dirty = true;
}

// §session 留痕：把当前 store 状态写入 sessions 表（按 sessionId，不覆盖跨场）
function persistSession(room, status) {
  try {
    const s = room.store;
    let pts = 0;
    for (const n of s.nodes.values()) if (n.kind === 'point') pts++;
    if (pts === 0 && s.comments.size === 0 && !status) return; // 空场不存
    const snap = s.snapshot();
    DB.upsertSession({
      id: room.sessionId,
      room: room.id,
      title: s.config.title || '',
      status,
      started_at: room.sessionStartedAt,
      stats: JSON.stringify({ ...snap.stats, sections: (s.nodes.get(s.root)?.children || []).length, points: pts }),
      snapshot: JSON.stringify(snap),
      digest_md: room.digest ? room.digest.markdown : null,
    });
  } catch (e) {
    console.warn('[session]', e.message);
  }
}

// 封存当前 session（开讲→结束的「结束」）后开一场新的：reset 会换新的 sessionId
function newSession(room) {
  persistSession(room, 'ended');
  if (room.sessionId) safeDb(() => DB.endSession(room.sessionId));
  room.reset();
}

function handleControl(room, msg) {
  if (room.ended) return; // locked — only admin can reopen
  switch (msg.action) {
    case 'sim.start':
      // a simulation always starts from a blank canvas (seal previous session)
      newSession(room);
      room.sim = runSimulation((ev) => applyEvent(room, ev), { speed: msg.speed || 1 });
      room.dirty = true;
      break;
    case 'transcript.start':
      newSession(room);
      room.sim = runTranscript((ev) => applyEvent(room, ev), { speed: msg.speed || 2.5 });
      room.dirty = true;
      break;
    case 'sim.stop':
      if (room.sim) room.sim.stop();
      room.sim = null;
      break;
    case 'reset':
      newSession(room);
      break;
    case 'agents.on':
      room.agentsOn = true;
      room.nextAgentAt = Date.now() + 6000 + Math.random() * 12000;
      room.nextSupplementAt = Date.now() + 20000 + Math.random() * 15000;
      break;
    case 'agents.off':
      room.agentsOn = false;
      break;
    default:
      break;
  }
}

// ---- saved digest snapshots (global, by id) → shareable /d/<id> links ----
const savedDigests = new Map();
function saveDigest(digest, markdown) {
  const id = uid('d').replace(/[^a-z0-9]/gi, '').slice(-10);
  const rec = { id, digest, markdown, savedAt: Date.now() };
  savedDigests.set(id, rec);
  try {
    fs.mkdirSync(DIGESTS, { recursive: true });
    fs.writeFileSync(path.join(DIGESTS, id + '.json'), JSON.stringify(rec));
  } catch (e) {
    console.warn('[digest save]', e.message);
  }
  return id;
}
function loadDigest(id) {
  if (!id || !/^[a-z0-9]+$/i.test(id)) return null;
  if (savedDigests.has(id)) return savedDigests.get(id);
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(DIGESTS, id + '.json'), 'utf8'));
    savedDigests.set(id, rec);
    return rec;
  } catch {
    return null;
  }
}

// ---- HTTP static + small JSON API ---------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

function readBodyBuffer(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/api/health') {
    return json(200, { ok: true, rooms: rooms.size, ...llmInfo() });
  }

  // ---- auth (login for speaker / admin; audience & screen stay open) ----
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const u = safeDb(() => DB.getUser(String(body.username || '').trim().toLowerCase()));
      if (!u || !Auth.verifyPassword(body.password || '', u.pass)) return json(401, { ok: false, error: '用户名或密码错误' });
      return json(200, { ok: true, token: Auth.issueToken({ username: u.username, role: u.role }), username: u.username, role: u.role });
    } catch (e) { return json(400, { ok: false, error: e.message }); }
  }
  if (url.pathname === '/api/auth/me') {
    const u = authUser(req);
    if (!u) return json(401, { ok: false });
    return json(200, { ok: true, username: u.username, role: u.role });
  }

  // runtime LLM engine config — GLOBAL (one key powers every room). No key in the deploy.
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return json(200, { ok: true, info: llmInfo() });
  }
  if (url.pathname === '/api/config' && req.method === 'POST') {
    try {
      if (!isSpeaker(req)) return json(401, { ok: false, error: '需要登录' });
      const body = JSON.parse(await readBody(req));
      const key = (body.key || '').trim();
      if (!key) return json(400, { ok: false, error: 'key required' });
      const envKeys = ['BIGMODEL_API_KEY', 'ZHIPU_API_KEY', 'ANTHROPIC_API_KEY', 'MINDCANVAS_MODEL', 'BIGMODEL_BASE_URL', 'ANTHROPIC_BASE_URL'];
      const prev = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
      setLlmConfig({ provider: body.provider, key, model: body.model, endpoint: body.endpoint });
      let valid = false;
      let verr = null;
      try { await llmPing(); valid = true; } catch (e) { verr = e.message; }
      if (!valid) {
        for (const k of envKeys) {
          if (prev[k] === undefined) delete process.env[k];
          else process.env[k] = prev[k];
        }
      }
      for (const r of rooms.values()) r.dirty = true; // refresh engine badge everywhere
      return json(200, { ok: true, valid, error: verr, info: llmInfo() }); // never echo the key
    } catch (e) {
      return json(400, { ok: false, error: e.message });
    }
  }

  // ---- admin backend (token-gated) ----
  if (url.pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return json(401, { ok: false, error: 'unauthorized' });

    if (url.pathname === '/api/admin/check') return json(200, { ok: true });

    // 重新加载本地资料语料（往 /data/docs 放/改文件后无需重启容器）
    if (url.pathname === '/api/admin/reload-docs' && req.method === 'POST') {
      const info = docsearch.loadCorpus({ indexPath: DOCS_INDEX, docsDir: DOCS_DIR, seedDir: DOCS_SEED });
      return json(200, { ok: true, ...info });
    }

    if (url.pathname === '/api/admin/config' && req.method === 'GET') {
      return json(200, { ok: true, info: llmInfo(), persisted: !!safeDb(() => DB.getSetting('api_key')) });
    }
    if (url.pathname === '/api/admin/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const key = (body.key || '').trim();
      if (!key) return json(400, { ok: false, error: 'key required' });
      const envKeys = ['BIGMODEL_API_KEY', 'ZHIPU_API_KEY', 'ANTHROPIC_API_KEY', 'MINDCANVAS_MODEL', 'BIGMODEL_BASE_URL', 'ANTHROPIC_BASE_URL'];
      const prev = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
      setLlmConfig({ provider: body.provider, key, model: body.model, endpoint: body.endpoint });
      let valid = false, verr = null;
      try { await llmPing(); valid = true; } catch (e) { verr = e.message; }
      if (!valid) { for (const k of envKeys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
      else safeDb(() => { DB.setSetting('provider', body.provider || 'zhipu'); DB.setSetting('api_key', key); DB.setSetting('model', body.model || ''); DB.setSetting('base_url', body.endpoint || ''); });
      for (const r of rooms.values()) r.dirty = true;
      return json(200, { ok: true, valid, error: verr, info: llmInfo() });
    }
    if (url.pathname === '/api/admin/config' && req.method === 'DELETE') {
      safeDb(() => DB.setSetting('api_key', ''));
      setLlmConfig({ provider: 'zhipu', key: '' });
      for (const r of rooms.values()) r.dirty = true;
      return json(200, { ok: true, info: llmInfo() });
    }

    if (url.pathname === '/api/admin/meetings') {
      const byRoom = new Map();
      for (const m of safeDb(() => DB.listMeetings()) || []) byRoom.set(m.room, { ...m, stats: m.stats ? JSON.parse(m.stats) : null, live: false });
      for (const room of rooms.values()) {
        const s = room.store;
        let pts = 0; for (const n of s.nodes.values()) if (n.kind === 'point') pts++;
        const snap = room.ended ? room.frozenSnapshot : s.snapshot();
        const cur = byRoom.get(room.id) || { room: room.id, created_at: null, updated_at: Date.now() };
        cur.title = (room.ended ? room.frozenSnapshot?.config?.title : s.config.title) || cur.title;
        cur.status = room.ended ? 'ended' : 'active';
        cur.live = true;
        cur.stats = snap ? { ...snap.stats, sections: (s.nodes.get(s.root)?.children || []).length, points: pts } : cur.stats;
        cur.audio = safeDb(() => DB.audioInfo(room.id));
        byRoom.set(room.id, cur);
      }
      return json(200, { ok: true, meetings: [...byRoom.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)) });
    }
    if (url.pathname === '/api/admin/meeting/end' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const room = getRoom(body.room);
      persistMeeting(room, 'ended');
      persistSession(room, 'ended');
      safeDb(() => { DB.endMeeting(room.id); DB.endSession(room.sessionId); });
      room.frozenSnapshot = room.store.snapshot();
      room.ended = true;
      if (room.sim) room.sim.stop();
      room.dirty = true;
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/admin/meeting/reopen' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const room = getRoom(body.room);
      safeDb(() => DB.reopenMeeting(room.id));
      room.ended = false; room.frozenSnapshot = null; room.dirty = true;
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/admin/meeting/start' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const rid = sanitizeRoomId(body.room || 'r' + Math.random().toString(36).slice(2, 7));
      const room = getRoom(rid);
      room.ended = false; newSession(room);
      safeDb(() => DB.reopenMeeting(rid));
      if (body.title) applyEvent(room, { type: 'session.config', title: body.title });
      return json(200, { ok: true, room: rid });
    }
    if (url.pathname === '/api/admin/meeting' && req.method === 'DELETE') {
      const body = JSON.parse(await readBody(req));
      const rid = sanitizeRoomId(body.room);
      safeDb(() => DB.deleteMeeting(rid));
      rooms.delete(rid);
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/admin/meeting/data') {
      const rid = sanitizeRoomId(url.searchParams.get('room'));
      const m = safeDb(() => DB.getMeeting(rid));
      const room = rooms.get(rid);
      const snap = room && !room.ended ? room.store.snapshot() : (m && m.snapshot ? JSON.parse(m.snapshot) : room?.frozenSnapshot || null);
      return json(200, { ok: true, meeting: m, snapshot: snap, digest_md: (m && m.digest_md) || room?.digest?.markdown || null, audio: safeDb(() => DB.audioInfo(rid)) });
    }
    if (url.pathname === '/api/admin/meeting/audio') {
      const rid = sanitizeRoomId(url.searchParams.get('room'));
      const seq = Number(url.searchParams.get('seq') || 1);
      const c = safeDb(() => DB.getAudioChunk(rid, seq));
      if (!c) return json(404, { ok: false });
      res.writeHead(200, { 'content-type': c.mime || 'audio/wav', 'content-disposition': `attachment; filename="${rid}-${seq}.wav"` });
      res.end(Buffer.from(c.bytes));
      return;
    }

    // ---- user management ----
    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      return json(200, { ok: true, users: safeDb(() => DB.listUsers()) || [] });
    }
    if (url.pathname === '/api/admin/users' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      const username = String(b.username || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
      if (!username || !b.password) return json(400, { ok: false, error: '用户名/密码必填' });
      const role = b.role === 'admin' ? 'admin' : 'speaker';
      safeDb(() => DB.upsertUser(username, Auth.hashPassword(b.password), role));
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/admin/users/password' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      if (!b.username || !b.password) return json(400, { ok: false, error: '缺少参数' });
      safeDb(() => DB.setUserPassword(String(b.username).toLowerCase(), Auth.hashPassword(b.password)));
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/admin/users' && req.method === 'DELETE') {
      const b = JSON.parse(await readBody(req));
      const uname = String(b.username || '').toLowerCase();
      const u = safeDb(() => DB.getUser(uname));
      if (u && u.role === 'admin' && (safeDb(() => DB.countAdmins()) || 0) <= 1) return json(400, { ok: false, error: '不能删除唯一的管理员' });
      safeDb(() => DB.deleteUser(uname));
      return json(200, { ok: true });
    }

    // ---- 会话留痕：按频道+session 浏览/导出 ----
    if (url.pathname === '/api/admin/sessions' && req.method === 'GET') {
      const room = url.searchParams.get('room') ? sanitizeRoomId(url.searchParams.get('room')) : null;
      // 也把当前进行中的活跃 session 合进来（可能还没落库）
      const rows = safeDb(() => DB.listSessions(room)) || [];
      const known = new Set(rows.map((r) => r.id));
      for (const rm of rooms.values()) {
        if (room && rm.id !== room) continue;
        if (!known.has(rm.sessionId)) {
          const snap = rm.store.snapshot();
          let pts = 0; for (const n of rm.store.nodes.values()) if (n.kind === 'point') pts++;
          if (pts || rm.store.comments.size) rows.unshift({ id: rm.sessionId, room: rm.id, title: rm.store.config.title || '', status: rm.ended ? 'ended' : 'live', started_at: rm.sessionStartedAt, ended_at: null, updated_at: Date.now(), stats: JSON.stringify(snap.stats), events: '~', audio: { n: 0, bytes: 0 }, live: true });
        }
      }
      return json(200, { ok: true, sessions: rows });
    }
    if (url.pathname === '/api/admin/session' && req.method === 'GET') {
      const s = safeDb(() => DB.getSession(url.searchParams.get('id')));
      if (!s) return json(404, { ok: false });
      return json(200, { ok: true, session: { ...s, snapshot: undefined }, snapshot: s.snapshot ? JSON.parse(s.snapshot) : null });
    }
    if (url.pathname === '/api/admin/session/events' && req.method === 'GET') {
      const evs = safeDb(() => DB.listEvents(url.searchParams.get('id'), Number(url.searchParams.get('limit') || 5000))) || [];
      return json(200, { ok: true, events: evs.map((e) => ({ seq: e.seq, t: e.t, type: e.type, payload: (() => { try { return JSON.parse(e.payload); } catch { return e.payload; } })() })) });
    }
    if (url.pathname === '/api/admin/session/audio') {
      const sid = url.searchParams.get('id');
      const seq = Number(url.searchParams.get('seq') || 1);
      const c = safeDb(() => DB.getSessionAudioChunk(sid, seq));
      if (!c) return json(404, { ok: false });
      res.writeHead(200, { 'content-type': c.mime || 'audio/wav', 'content-disposition': `attachment; filename="${sid}-${seq}.wav"` });
      res.end(Buffer.from(c.bytes));
      return;
    }
    if (url.pathname === '/api/admin/session/export' && req.method === 'GET') {
      const s = safeDb(() => DB.getSession(url.searchParams.get('id')));
      if (!s) return json(404, { ok: false });
      const events = safeDb(() => DB.listEvents(s.id, 100000)) || [];
      const bundle = {
        session: { id: s.id, room: s.room, title: s.title, status: s.status, started_at: s.started_at, ended_at: s.ended_at, stats: s.stats ? JSON.parse(s.stats) : null },
        snapshot: s.snapshot ? JSON.parse(s.snapshot) : null,
        digest_md: s.digest_md || null,
        events: events.map((e) => ({ seq: e.seq, t: e.t, type: e.type, payload: (() => { try { return JSON.parse(e.payload); } catch { return e.payload; } })() })),
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="session-${s.id}.json"` });
      res.end(JSON.stringify(bundle, null, 2));
      return;
    }
    if (url.pathname === '/api/admin/session' && req.method === 'DELETE') {
      const b = JSON.parse(await readBody(req));
      safeDb(() => DB.deleteSession(b.id));
      return json(200, { ok: true });
    }

    return json(404, { ok: false, error: 'unknown admin route' });
  }

  // event ingestion over plain HTTP — external streaming-ASR worker → center (§2.2).
  // Room from ?room= or body.room. Accepts {event} / {events:[]} / {control}.
  if (url.pathname === '/api/ingest' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const room = getRoom(url.searchParams.get('room') || body.room);
      const speaker = isSpeaker(req);
      if (body.control) { if (!speaker) return json(401, { ok: false, error: '需要登录' }); handleControl(room, body.control); }
      const all = [body.event, ...(Array.isArray(body.events) ? body.events : [])].filter(Boolean);
      if (all.some((ev) => !eventAllowed(ev, speaker))) return json(401, { ok: false, error: '该事件需要登录（仅观众评论/表情可匿名提交）' });
      const accepted = [];
      if (body.event) { applyEvent(room, body.event); if (body.event.id) accepted.push(body.event.id); }
      if (Array.isArray(body.events)) {
        for (const ev of body.events) { applyEvent(room, ev); if (ev.id) accepted.push(ev.id); }
      }
      return json(200, { ok: true, room: room.id, accepted }); // worker clears these from its outbox
    } catch (e) {
      return json(400, { ok: false, error: e.message });
    }
  }

  // 演化回放：recorded state snapshots for a room
  if (url.pathname === '/api/history') {
    const room = getRoom(url.searchParams.get('room'));
    return json(200, { ok: true, room: room.id, startedAt: room.store.config.startedAt, frames: room.history });
  }

  // final fused outline / 会议纪要 — speaker content + best audience comments
  if (url.pathname === '/api/digest') {
    try {
      const room = getRoom(url.searchParams.get('room'));
      // serve the auto-regenerated cached digest when fresh (≤65s); else build now
      if (room.digest && Date.now() - room.digestAt < 65000 && url.searchParams.get('fresh') !== '1') {
        return json(200, { ok: true, digest: room.digest, markdown: room.digest.markdown, cached: true, ageMs: Date.now() - room.digestAt });
      }
      const digest = await buildDigest(room.store);
      const markdown = digestToMarkdown(digest);
      room.digest = { ...digest, markdown };
      room.digestAt = Date.now();
      room.digestSig = digestSig(room.store);
      return json(200, { ok: true, digest, markdown });
    } catch (e) {
      return json(500, { ok: false, error: e.message });
    }
  }

  // save the current digest as a shareable snapshot (global by id)
  if (url.pathname === '/api/digest/save' && req.method === 'POST') {
    try {
      const room = getRoom(url.searchParams.get('room'));
      const digest = await buildDigest(room.store);
      const id = saveDigest(digest, digestToMarkdown(digest));
      return json(200, { ok: true, id });
    } catch (e) {
      return json(500, { ok: false, error: e.message });
    }
  }

  // fetch a saved digest snapshot (for the standalone share page)
  if (url.pathname === '/api/saved-digest') {
    const rec = loadDigest(url.searchParams.get('id'));
    return json(rec ? 200 : 404, rec ? { ok: true, digest: rec.digest, markdown: rec.markdown, savedAt: rec.savedAt } : { ok: false });
  }

  // standalone shareable digest page: /d/<id>
  if (url.pathname.startsWith('/d/')) {
    return serveFile(res, path.join(PUBLIC, 'digest.html'));
  }

  // browser mic ASR via BigModel glm-asr: raw WAV body → transcribe → ingest into room.
  // id makes retries idempotent (store dedups). Works in China (no Google dependency).
  if (url.pathname === '/api/asr' && req.method === 'POST') {
    if (!isSpeaker(req)) return json(401, { ok: false, error: '需要登录' });
    if (!asrAvailable()) return json(400, { ok: false, error: 'ASR 不可用：请先在主讲台配置 BigModel(GLM) key' });
    try {
      const room = getRoom(url.searchParams.get('room'));
      if (room.ended) return json(403, { ok: false, error: '会议已结束' });
      const id = (url.searchParams.get('id') || 'mic_' + uid('a')).replace(/[^a-z0-9_-]/gi, '').slice(0, 48);
      const buf = await readBodyBuffer(req);
      if (!buf.length) return json(400, { ok: false, error: 'empty audio' });
      try { DB.addAudio(room.id, ++room.audioSeq, 'audio/wav', buf, room.sessionId); } catch { /* no db */ } // §会议音频保存（按 session）
      const r = await llmTranscribe(buf);
      if (r.segments && r.segments.length) {
        // diarized: one asr.segment per speaker turn
        r.segments.forEach((s, i) => applyEvent(room, { id: id + '_' + i, type: 'asr.segment', text: s.text, source: 'glm-asr', speaker: s.speaker }));
        return json(200, { ok: true, text: r.segments.map((s) => s.text).join(' ') });
      }
      if (r.text) applyEvent(room, { id, type: 'asr.segment', text: r.text, source: 'glm-asr' });
      return json(200, { ok: true, text: r.text });
    } catch (e) {
      // a silent/blank frame → glm-asr "1210 no audio segment": benign, just skip it
      if (/1210|no audio/i.test(e.message)) return json(200, { ok: true, text: '', skipped: 'silent' });
      return json(500, { ok: false, error: e.message });
    }
  }

  // optional slide OCR (only useful when a key is present); safe no-op otherwise
  if (url.pathname === '/api/ocr' && req.method === 'POST') {
    if (!isSpeaker(req)) return json(401, { ok: false, error: '需要登录' });
    if (!visionAvailable()) return json(200, { ok: false, reason: 'vision-off' }); // intranet w/o vision → manual title/body
    if (!llmEnabled()) return json(200, { ok: false, reason: 'no-llm' });
    try {
      const body = JSON.parse(await readBody(req));
      const parsed = await llmReadSlide(body.dataUrl);
      return json(200, { ok: true, ...parsed });
    } catch (e) {
      return json(200, { ok: false, reason: e.message });
    }
  }

  // ---- speaker 上传资料到「资料补充·本地检索」语料（local 模式）----
  if (url.pathname === '/api/docs' && req.method === 'GET') {
    if (!isSpeaker(req)) return json(401, { ok: false, error: '需要登录' });
    let files = [];
    try { files = fs.readdirSync(DOCS_DIR).filter((f) => /\.(txt|md|markdown)$/i.test(f)).map((f) => ({ name: f, size: fs.statSync(path.join(DOCS_DIR, f)).size })); } catch { /* dir 未建 */ }
    return json(200, { ok: true, files, corpus: docsearch.corpusInfo(), mode: searchMode() });
  }
  if (url.pathname === '/api/docs/upload' && req.method === 'POST') {
    if (!isSpeaker(req)) return json(401, { ok: false, error: '需要登录' });
    try {
      const raw = url.searchParams.get('name') || 'upload.txt';
      const buf = await readBodyBuffer(req);
      if (!buf.length) return json(400, { ok: false, error: '空文件' });
      if (buf.length > 12 * 1024 * 1024) return json(400, { ok: false, error: '文件过大（上限 12MB）' });
      const r = extractText(raw, buf);
      if (!r.ok) return json(400, { ok: false, error: r.reason });
      const text = (r.text || '').trim();
      if (text.length < 12) return json(400, { ok: false, error: '未提取到足够文本' });
      const ext = (raw.split('.').pop() || '').toLowerCase();
      const base = (raw.replace(/\.[^.]+$/, '').replace(/[\/\\]/g, '_').replace(/[^\w.一-鿿-]/g, '_').slice(0, 60)) || 'doc';
      const isText = ext === 'txt' || ext === 'md' || ext === 'markdown';
      const fname = isText ? base + '.' + (ext === 'markdown' ? 'md' : ext) : base + '.txt'; // docx/pptx → 抽出的 .txt
      fs.mkdirSync(DOCS_DIR, { recursive: true });
      fs.writeFileSync(path.join(DOCS_DIR, fname), text, 'utf8');
      const corpus = docsearch.loadCorpus({ indexPath: DOCS_INDEX, docsDir: DOCS_DIR, seedDir: DOCS_SEED });
      return json(200, { ok: true, saved: fname, chars: text.length, corpus });
    } catch (e) { return json(400, { ok: false, error: e.message }); }
  }
  if (url.pathname === '/api/docs' && req.method === 'DELETE') {
    if (!isSpeaker(req)) return json(401, { ok: false, error: '需要登录' });
    const name = (url.searchParams.get('name') || '').replace(/[\/\\]/g, '');
    if (!name || !/\.(txt|md|markdown)$/i.test(name)) return json(400, { ok: false, error: '非法文件名' });
    const fp = path.join(DOCS_DIR, name);
    if (!fp.startsWith(DOCS_DIR)) return json(400, { ok: false, error: '非法路径' });
    try { fs.unlinkSync(fp); } catch { /* 不存在 */ }
    return json(200, { ok: true, corpus: docsearch.loadCorpus({ indexPath: DOCS_INDEX, docsDir: DOCS_DIR, seedDir: DOCS_SEED }) });
  }
  if (url.pathname === '/api/docs/mode' && req.method === 'POST') {
    if (!isSpeaker(req)) return json(401, { ok: false, error: '需要登录' });
    const body = JSON.parse(await readBody(req));
    const m = String(body.mode || '').toLowerCase();
    if (!['web', 'local', 'api', 'custom', 'off'].includes(m)) return json(400, { ok: false, error: '无效模式' });
    process.env.MINDCANVAS_SEARCH_MODE = m;
    safeDb(() => DB.setSetting('search_mode', m));
    return json(200, { ok: true, mode: searchMode() });
  }

  // room-scoped pages need ?room=. Audience/screen → 404; speaker → spin up a fresh room.
  if (url.pathname === '/' || url.pathname === '/screen' || url.pathname === '/speaker') {
    if (!roomParam(url)) {
      if (url.pathname === '/speaker') {
        res.writeHead(302, { Location: '/speaker?room=r' + Math.random().toString(36).slice(2, 7) });
        return res.end();
      }
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(NOT_FOUND_HTML);
    }
  }

  let pathname = url.pathname;
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/speaker') pathname = '/speaker.html';
  if (pathname === '/screen') pathname = '/screen.html';
  if (pathname === '/admin') pathname = '/admin.html';

  // prevent path traversal
  const filePath = path.join(PUBLIC, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, filePath);
});

// ---- WebSocket: per-room ingest + broadcast ------------------------------
const wss = new WebSocketServer({ server });

function broadcastRoom(room) {
  const state = room.ended ? (room.frozenSnapshot || room.store.snapshot()) : room.store.snapshot();
  if (!room.ended && state.serverTime - room.lastHistoryAt >= HISTORY_EVERY_MS && Object.keys(state.nodes).length > 1) {
    room.lastHistoryAt = state.serverTime;
    room.history.push({ t: state.serverTime, state });
    if (room.history.length > HISTORY_MAX) room.history.shift();
  }
  const msg = JSON.stringify({ kind: 'snapshot', engine: llmInfo(), room: room.id, ended: room.ended, state });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.roomId === room.id) client.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  ws.roomId = sanitizeRoomId(u.searchParams.get('room'));
  // controls (sim/agents/...) require a logged-in speaker/admin; audience connects anonymously
  const au = u.searchParams.get('auth') ? Auth.verifyToken(u.searchParams.get('auth')) : null;
  ws.authed = !!(au && (au.role === 'speaker' || au.role === 'admin'));
  const room = getRoom(ws.roomId);
  ws.send(JSON.stringify({ kind: 'snapshot', engine: llmInfo(), room: room.id, ended: room.ended, state: room.ended ? (room.frozenSnapshot || room.store.snapshot()) : room.store.snapshot() }));

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const r = getRoom(ws.roomId);
    // ack durable events so the client can clear its outbox; dedup is in the store,
    // so we ack even duplicates (a retransmit whose first ack was lost).
    if (msg.kind === 'event' && msg.event) {
      if (eventAllowed(msg.event, ws.authed)) applyEvent(r, msg.event); // privileged events need a logged-in speaker
      if (msg.event.id) ws.send(JSON.stringify({ kind: 'ack', ids: [msg.event.id] })); // ack regardless so the client outbox clears
      return;
    }
    if (msg.kind === 'events' && Array.isArray(msg.events)) {
      const ids = [];
      for (const ev of msg.events) { if (eventAllowed(ev, ws.authed)) applyEvent(r, ev); if (ev.id) ids.push(ev.id); }
      if (ids.length) ws.send(JSON.stringify({ kind: 'ack', ids }));
      return;
    }
    if (msg.kind === 'control') { if (!ws.authed) return; handleControl(r, msg); }
  });
});

// throttled broadcast (cheap fan-out) — per dirty room
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.dirty) { room.dirty = false; broadcastRoom(room); }
  }
}, 350);

// clustering loop — expensive synthesis, once per dirty node, across all rooms (§2.7)
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clustering) continue;
    const ids = room.store.takeDirtyNodes();
    if (!ids.length) continue;
    room.clustering = true;
    Promise.allSettled(ids.map((id) => clusterNode(room.store, id)))
      .then(() => { room.dirty = true; })
      .catch((e) => console.warn('[cluster]', e.message))
      .finally(() => { room.clustering = false; });
  }
}, 3000);

// narration segmentation loop — derive chapter structure from pure speech (§2.2)
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.segmenting) continue;
    const sec = room.store.nodes.get(room.store.currentSectionId);
    if (!sec || !sec.asrDriven) continue;
    room.segmenting = true;
    segmentNarration(room.store)
      .then(() => { room.dirty = true; })
      .catch((e) => console.warn('[narration]', e.message))
      .finally(() => { room.segmenting = false; });
  }
}, 4500);

// §定期校正：periodically re-read recent ASR points and fix recognition errors using
// context (homophones / names / numbers). Each point is corrected once; the live
// (open) point is left alone until it closes.
setInterval(() => {
  if (!llmEnabled()) return;
  for (const room of rooms.values()) {
    if (room.correcting) continue;
    const pts = [];
    for (const n of room.store.nodes.values()) {
      if (n.kind === 'point' && !n._corrected && n.t_end != null) pts.push(n);
    }
    if (pts.length < 3) continue;
    const batch = pts.slice(-12);
    room.correcting = true;
    const ctx = room.store.nodes.get(room.store.currentSectionId)?.text || room.store.config.title;
    llmCorrectPoints(ctx, batch.map((p) => p.text))
      .then((fixed) => {
        // only apply on exact length match → no index misalignment; else leave for retry
        if (!Array.isArray(fixed) || fixed.length !== batch.length) return;
        let changed = false;
        batch.forEach((p, i) => { if (fixed[i] != null && room.store.correctPoint(p.id, String(fixed[i]).trim())) changed = true; });
        if (changed) room.dirty = true;
      })
      .catch((e) => console.warn('[correct]', e.message))
      .finally(() => { room.correcting = false; });
  }
}, 25000);

// §participation: AI colleague personas drop in-character comments at irregular
// intervals (15–45s), anchored to whatever's being discussed. Toggle per room.
setInterval(() => {
  if (!llmEnabled()) return;
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.agentsOn || room.agentBusy || now < room.nextAgentAt) continue;
    const pts = [];
    for (const n of room.store.nodes.values()) if (n.kind === 'point') pts.push(n.text);
    if (pts.length < 3) continue;
    const persona = pickPersona(room);
    const sec = room.store.nodes.get(room.store.currentSectionId);
    const secTitle = sec ? sec.text : '';
    const allC = [...room.store.comments.values()];
    const recent = allC.slice(-4).map((c) => c.text);
    // ~55% of the time, REPLY to a recent real (human) comment → forms a thread
    const humanRecent = allC.filter((c) => !c.byAgent && c.text && now - c.t < 90000).slice(-6);
    const target = humanRecent.length && Math.random() < 0.55 ? humanRecent[Math.floor(Math.random() * humanRecent.length)] : null;
    room.agentBusy = true;
    const gen = target
      ? llmPersonaReply(persona, target.text, secTitle).then((text) => ({ text, anchorNodeId: target.anchorNodeId, replyTo: target.id }))
      : llmPersonaComment(persona, secTitle, pts, recent).then((text) => ({ text, anchorNodeId: undefined, replyTo: null }));
    gen
      .then((r) => {
        if (r.text) applyEvent(room, { type: 'comment.create', token: 'agent_' + persona.id, text: r.text, persona: persona.name, byAgent: true, replyTo: r.replyTo, anchorNodeId: r.anchorNodeId, t_compose: Date.now() });
      })
      .catch((e) => console.warn('[agent]', e.message))
      .finally(() => { room.agentBusy = false; room.nextAgentAt = Date.now() + 14000 + Math.random() * 26000; });
  }
}, 7000);

// §资料补充: enrich the current content with a relevant fact/datum + source, at a slower
// cadence (~40–70s). Tied to the same AI-participation toggle. Source depends on searchMode:
// 来源由统一适配层 server/search.js 决定（web / local / api / custom / off）。
setInterval(() => {
  if (!search.searchEnabled()) return;
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.agentsOn || room.suppBusy || now < room.nextSupplementAt) continue;
    const sec = room.store.nodes.get(room.store.currentSectionId);
    const pts = sec ? (sec.children || []).map((id) => room.store.nodes.get(id)).filter((n) => n && n.kind === 'point').map((p) => p.text) : [];
    if (pts.length < 3) continue;
    room.suppBusy = true;
    search.supplement(sec.text, pts)
      .then((r) => { if (r.text) applyEvent(room, { type: 'supplement.add', text: r.text, source: r.source, nodeId: room.store.currentSectionId }); })
      .catch((e) => console.warn('[supplement]', e.message))
      .finally(() => { room.suppBusy = false; room.nextSupplementAt = Date.now() + 40000 + Math.random() * 30000; });
  }
}, 9000);

// §每分钟纪要: auto-regenerate each active room's digest about once a minute (only when
// content changed since the last build), so the 纪要 tab / share / export is always fresh.
function digestSig(store) {
  let pts = 0;
  for (const n of store.nodes.values()) if (n.kind === 'point') pts++;
  return pts + '/' + store.comments.size + '/' + (store.supplements || []).length;
}
setInterval(() => {
  if (!llmEnabled()) return;
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.digesting) continue;
    let pts = 0;
    for (const n of room.store.nodes.values()) if (n.kind === 'point') pts++;
    if (pts < 3) continue;
    const sig = digestSig(room.store);
    if (room.digest && (sig === room.digestSig || now - room.digestAt < 58000)) continue; // unchanged or too soon
    room.digesting = true;
    buildDigest(room.store)
      .then((d) => { room.digest = { ...d, markdown: digestToMarkdown(d) }; room.digestAt = Date.now(); room.digestSig = sig; room.dirty = true; })
      .catch((e) => console.warn('[digest loop]', e.message))
      .finally(() => { room.digesting = false; });
  }
}, 20000);

// §持久化: save each active room's meeting record to SQLite when its content changed
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.ended) continue;
    const sig = digestSig(room.store);
    if (sig === room.persistSig) continue;
    room.persistSig = sig;
    persistMeeting(room);
    persistSession(room); // §按 session 留痕（滚动快照）
  }
}, 25000);

// reap idle empty rooms (keep "main") so rooms don't accumulate forever
setInterval(() => {
  const now = Date.now();
  const active = new Set();
  for (const client of wss.clients) if (client.roomId) active.add(client.roomId);
  for (const [id, room] of rooms) {
    if (id === 'main') continue;
    if (!active.has(id) && now - room.lastActive > ROOM_TTL_MS) {
      if (room.sim) room.sim.stop();
      rooms.delete(id);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n  MindCanvas v0.2 (multi-room)  ▸  http://localhost:${PORT}`);
  console.log(`  观众画布:  http://localhost:${PORT}/            (?room=<id>)`);
  console.log(`  主讲台:    http://localhost:${PORT}/speaker`);
  const info = llmInfo();
  console.log(`  LLM 综合:  ${info.enabled ? `已启用 (${info.provider} · ${info.model})` : '未启用 (启发式回退) — 前端配置或设 BIGMODEL_API_KEY'}\n`);
});
