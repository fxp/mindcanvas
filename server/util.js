// Small shared helpers: ids, time, text.

let _counter = 0;
export function uid(prefix = 'id') {
  _counter = (_counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}_${_counter.toString(36)}`;
}

export function now() {
  return Date.now();
}

// Naive sentence splitter that works for both CJK and latin punctuation.
export function splitSentences(text) {
  if (!text) return [];
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?；;\.])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

// Cheap tokenizer for similarity: keep CJK chars as tokens, latin words lowercased.
export function tokenize(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9]+/g) || [];
  const cjk = lower.match(/[一-鿿]/g) || [];
  return [...latin, ...cjk];
}

export function jaccard(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const QUESTION_HINTS = [
  'why', 'how', 'what', 'when', 'where', 'who', 'which', 'can ', 'could ', 'should ', 'is it', 'are we', 'do you',
  '为什么', '怎么', '如何', '为何', '是否', '吗', '呢', '能不能', '可不可以', '什么', '哪', '多少',
];

export function looksLikeQuestion(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (t.includes('?') || t.includes('？')) return true;
  return QUESTION_HINTS.some((h) => t.includes(h));
}

// Collapse degenerate ASR repetition loops (e.g. "这个是嗯，这个是嗯，…"×100, or "abcabcabc")
// and hard-cap a single utterance. Normal speech is essentially untouched.
export function collapseRepeats(text, maxLen = 280) {
  if (!text) return '';
  let s = String(text).trim();
  if (s.length > 4000) s = s.slice(0, 4000); // guard against ReDoS on pathological input
  // collapse 3+ immediate repeats of a 1–40 char unit (handles with/without delimiters)
  s = s.replace(/(.{1,40}?)\1{2,}/gu, '$1');
  // collapse consecutive duplicate phrases split on CJK/ASCII punctuation or whitespace
  const parts = s.split(/[，,。.!?！？、;；\s]+/u).filter(Boolean);
  if (parts.length > 3) {
    const out = [];
    for (const p of parts) if (!out.length || out[out.length - 1] !== p) out.push(p);
    if (out.length < parts.length) s = out.join('，');
  }
  if (s.length > maxLen) s = s.slice(0, maxLen).trim() + '…';
  return s.trim();
}

// Low-information / filler utterance: greetings, mic checks, pure 语气词, or near-empty.
// Used to keep the digest to content that actually supports the talk's logic chain.
const FILLER_RE = /^(?:[嗯呃啊哦呀哈嘿喂的了吧呢吗么你我他它们这那个是不就对好嘛呐唉哎咳]|这个是|那个是|可以听到吗|听得到吗|喂+|test|测试|ok|okay|哈+|嗯+|啊+)+[。.!?！？，,、\s]*$/iu;
export function isLowInfo(text) {
  const s = collapseRepeats(String(text || '').trim(), 9999).replace(/[。.!?！？，,、\s]+$/u, '');
  if (!s) return true;
  // strip spaces/punct to measure substance
  const core = s.replace(/[\s，,。.!?！？、;；:：—\-…"'「」『』（）()]/gu, '');
  if (core.length < 4) return true;               // too short to carry an idea
  if (FILLER_RE.test(s) || FILLER_RE.test(core)) return true; // pure filler / mic-check / greeting
  return false;
}
