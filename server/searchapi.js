// 资料补充 · 内网检索 API 适配器（MINDCANVAS_SEARCH_MODE=api）。
// 把「当前正在讲的内容」作为 query 调用你内网的检索接口，返回若干命中片段，
// 再交给 llm.js 的 llmSearchLocal() 提炼成一条 ≤45 字、带来源的补充。
//
// 配置（环境变量 / .env）：
//   MINDCANVAS_SEARCH_API_URL    必填，内网检索接口地址
//   MINDCANVAS_SEARCH_API_KEY    可选，作为 Authorization: Bearer <key>
//   MINDCANVAS_SEARCH_API_METHOD POST(默认) | GET
//
// 默认请求/响应约定（不符合就改下面标注「按你的接口调整」的两处）：
//   POST  body = {"query": "...", "top_k": 3}        GET   ?q=...&top_k=3
//   resp  = {"results":[{"title","snippet","url"}]}  也兼容 data/hits/items 或直接数组

export function searchApiAvailable() {
  return !!process.env.MINDCANVAS_SEARCH_API_URL;
}

export async function searchApi(query, k = 3) {
  const url = process.env.MINDCANVAS_SEARCH_API_URL;
  if (!url) return [];
  const method = (process.env.MINDCANVAS_SEARCH_API_METHOD || 'POST').toUpperCase();
  const headers = { 'content-type': 'application/json' };
  if (process.env.MINDCANVAS_SEARCH_API_KEY) headers.authorization = 'Bearer ' + process.env.MINDCANVAS_SEARCH_API_KEY;

  let res;
  try {
    if (method === 'GET') {
      const u = url + (url.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(query) + '&top_k=' + k;
      res = await fetch(u, { headers, signal: AbortSignal.timeout(8000) });
    } else {
      // ←—— 按你的接口调整：请求体字段名（query / top_k） ——→
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query, top_k: k }), signal: AbortSignal.timeout(8000) });
    }
  } catch (e) { console.warn('[searchapi] request failed:', e.message); return []; }
  if (!res.ok) { console.warn('[searchapi] HTTP', res.status); return []; }

  const data = await res.json().catch(() => null);
  // ←—— 按你的接口调整：响应里命中数组与字段名 ——→
  const rows = Array.isArray(data) ? data : (data?.results || data?.data || data?.hits || data?.items || []);
  return rows.slice(0, k).map((r) => ({
    file: r.title || r.source || r.name || r.doc || r.url || '内网资料',
    loc: r.url || r.loc || r.page || '',
    text: r.snippet || r.content || r.text || r.summary || r.body || '',
  })).filter((h) => h.text);
}
