// 文件目录 → 兼容「搜索 API」的独立小服务。
// 把本地某个目录 serve 成 MindCanvas `api` 模式可直接消费的检索接口；零依赖（仅 Node ≥18）。
//
// 运行：
//   DOCS_DIR=/path/to/docs PORT=8079 node search-service/server.js
//   # txt/md 直接读；Word/PDF/PPT 先用 tools/index_docs.py 生成 docs-index.json，再 DOCS_INDEX 指过去
//
// 契约（与 server/searchapi.js 默认约定一致）：
//   POST /search  {"query":"...","top_k":3}  ->  {"results":[{"title","snippet","url"}]}
//   GET  /search?q=...&top_k=3                ->  同上
//   GET  /health   /reload
//
// MindCanvas 侧接它：MINDCANVAS_SEARCH_MODE=api，MINDCANVAS_SEARCH_API_URL=http://<本机>:8079/search

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 8079;
const DOCS_DIR = process.env.DOCS_DIR || './docs';
const DOCS_INDEX = process.env.DOCS_INDEX || '';

// CJK 友好的轻量分词（与主程序一致：中文按字、英文按词）
const tokenize = (t) => {
  if (!t) return [];
  const s = String(t).toLowerCase();
  return [...(s.match(/[a-z0-9]+/g) || []), ...(s.match(/[一-鿿]/g) || [])];
};

let CHUNKS = [];
const FILES = new Set();
function pushChunk(file, loc, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 12) return;
  CHUNKS.push({ file, loc: loc || '', text: t, tok: new Set(tokenize(t)) });
  FILES.add(file);
}
function chunkText(file, raw) {
  const paras = String(raw).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  let buf = '', n = 0;
  const flush = () => { if (buf) { pushChunk(file, '段落' + (++n), buf); buf = ''; } };
  for (const p of paras) { if ((buf + ' ' + p).length > 400) flush(); buf = buf ? buf + ' ' + p : p; if (buf.length > 280) flush(); }
  flush();
}
function load() {
  CHUNKS = []; FILES.clear();
  if (DOCS_INDEX && fs.existsSync(DOCS_INDEX)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DOCS_INDEX, 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.chunks || []);
      for (const c of arr) pushChunk(c.file || c.source || 'doc', c.loc || c.page || '', c.text);
    } catch (e) { console.warn('[file-search] index load:', e.message); }
  }
  if (fs.existsSync(DOCS_DIR)) {
    for (const f of fs.readdirSync(DOCS_DIR)) {
      if (!/\.(txt|md|markdown)$/i.test(f)) continue;
      try { chunkText(f, fs.readFileSync(path.join(DOCS_DIR, f), 'utf8')); } catch { /* skip */ }
    }
  }
}
function search(query, k = 3) {
  const qs = new Set(tokenize(query));
  if (!qs.size) return [];
  const scored = [];
  for (const c of CHUNKS) {
    let hit = 0;
    for (const t of qs) if (c.tok.has(t)) hit++;
    if (hit >= 2) scored.push({ title: c.file, snippet: c.text, url: c.loc, score: hit / Math.sqrt(c.tok.size || 1) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(({ score, ...r }) => r);
}

load();
console.log(`[file-search] ${FILES.size} files / ${CHUNKS.length} chunks  DOCS_DIR=${DOCS_DIR}${DOCS_INDEX ? '  DOCS_INDEX=' + DOCS_INDEX : ''}`);

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (u.pathname === '/health') return res.end(JSON.stringify({ ok: true, files: FILES.size, chunks: CHUNKS.length }));
  if (u.pathname === '/reload') { load(); return res.end(JSON.stringify({ ok: true, files: FILES.size, chunks: CHUNKS.length })); }
  if (u.pathname === '/search') {
    let query = u.searchParams.get('q') || '';
    let k = +(u.searchParams.get('top_k') || 3);
    if (req.method === 'POST') {
      let b = ''; for await (const c of req) b += c;
      try { const j = JSON.parse(b || '{}'); query = j.query || j.q || query; k = j.top_k || j.k || k; } catch { /* ignore */ }
    }
    return res.end(JSON.stringify({ results: search(query, k) }));
  }
  res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
}).listen(PORT, () => console.log(`[file-search] listening :${PORT}  ·  POST /search {query,top_k}`));
