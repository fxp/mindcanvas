// Offline 资料补充 corpus: replaces web search when there's no internet.
// Source = local files (Word/PDF/PPT/txt/md). Two ways to populate:
//   1. A prebuilt index JSON (MINDCANVAS_DOCS_INDEX) produced by tools/index_docs.py
//      — handles .docx/.pptx/.pdf/.txt/.md robustly (run offline by an admin).
//   2. A folder (MINDCANVAS_DOCS_DIR) of .txt/.md — read directly here (no deps).
// Retrieval is CJK-aware token overlap (no embeddings, no network).

import fs from 'node:fs';
import path from 'node:path';
import { tokenize } from './util.js';

let CHUNKS = []; // [{ file, loc, text, _tok:Set }]
let FILES = new Set();

function pushChunk(file, loc, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 12) return; // skip near-empty
  CHUNKS.push({ file, loc: loc || '', text: t, _tok: new Set(tokenize(t)) });
  FILES.add(file);
}

// chunk a long plain text into ~paragraph windows
function chunkText(file, raw) {
  const paras = String(raw).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  let buf = '';
  let n = 0;
  const flush = () => { if (buf) { pushChunk(file, '段落' + (++n), buf); buf = ''; } };
  for (const p of paras) {
    if ((buf + ' ' + p).length > 400) flush();
    buf = buf ? buf + ' ' + p : p;
    if (buf.length > 280) flush();
  }
  flush();
}

function scanDir(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(txt|md|markdown)$/i.test(f)) continue;
    chunkText(f, fs.readFileSync(path.join(dir, f), 'utf8'));
  }
}

// indexPath: prebuilt JSON (handles docx/pdf/pptx). seedDir: shipped fallback corpus
// (txt/md, in the image). docsDir: operator-added files on the volume (txt/md).
export function loadCorpus({ indexPath, docsDir, seedDir } = {}) {
  CHUNKS = [];
  FILES = new Set();
  try {
    if (indexPath && fs.existsSync(indexPath)) {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const arr = Array.isArray(raw) ? raw : raw.chunks || [];
      for (const c of arr) pushChunk(c.file || c.source || 'doc', c.loc || c.page || '', c.text);
    }
  } catch (e) {
    console.warn('[docsearch] index load failed:', e.message);
  }
  try { scanDir(seedDir); } catch (e) { console.warn('[docsearch] seed scan failed:', e.message); }
  try { scanDir(docsDir); } catch (e) { console.warn('[docsearch] dir scan failed:', e.message); }
  return corpusInfo();
}

export function ready() { return CHUNKS.length > 0; }
export function corpusInfo() { return { ready: CHUNKS.length > 0, chunks: CHUNKS.length, files: FILES.size }; }

// Return the top-k chunks most relevant to the query (section title + recent points).
export function searchLocal(query, k = 3) {
  if (!CHUNKS.length) return [];
  const q = new Set(tokenize(String(query || '')));
  if (!q.size) return [];
  const scored = [];
  for (const c of CHUNKS) {
    let hit = 0;
    for (const t of q) if (c._tok.has(t)) hit++;
    if (hit >= 2) scored.push({ file: c.file, loc: c.loc, text: c.text, score: hit / Math.sqrt(c._tok.size || 1) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
