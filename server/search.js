// 资料补充 · 统一检索适配层。按 MINDCANVAS_SEARCH_MODE 选择来源，对外只暴露
// searchEnabled() 与 supplement(sectionTitle, points) → { text, source }。
//
//   web     外部联网检索（GLM web_search，自带检索+综合）
//   local   内置离线文件语料（server/docsearch.js：txt/md 目录 或 docs-index.json）
//   api     内网检索 HTTP 接口（server/searchapi.js；兼容契约见 search-service/）
//   custom  客户自定义检索（server/search-custom.js，改两个函数即可）
//   off     关闭
//
// 加新来源：在 PROVIDERS 里加一项 { available, supplement } 即可，其它代码不用动。

import { searchMode, provider, llmSearchSupplement, llmSearchLocal } from './llm.js';
import * as docsearch from './docsearch.js';
import * as searchapi from './searchapi.js';
import * as custom from './search-custom.js';

const q = (title, points) => `${title} ${(points || []).slice(-4).join(' ')}`.trim();

// web 由 GLM 一步出 {text,source}；local/api/custom 各自取「命中片段」再交 llmSearchLocal 提炼。
const PROVIDERS = {
  web: {
    available: () => provider() === 'zhipu',
    supplement: (t, p) => llmSearchSupplement(t, p),
  },
  local: {
    available: () => docsearch.ready(),
    supplement: (t, p) => llmSearchLocal(t, p, docsearch.searchLocal(q(t, p))),
  },
  api: {
    available: () => searchapi.searchApiAvailable(),
    supplement: async (t, p) => llmSearchLocal(t, p, await searchapi.searchApi(q(t, p))),
  },
  custom: {
    available: () => custom.available(),
    supplement: async (t, p) => llmSearchLocal(t, p, await custom.search(q(t, p))),
  },
};

export function searchEnabled() {
  const m = searchMode();
  return m !== 'off' && !!(PROVIDERS[m] && PROVIDERS[m].available());
}

export async function supplement(sectionTitle, points) {
  const m = searchMode();
  const prov = PROVIDERS[m];
  if (!prov || !prov.available()) return { text: '', source: '' };
  try {
    return await prov.supplement(sectionTitle, points);
  } catch (e) {
    console.warn('[search:' + m + ']', e.message);
    return { text: '', source: '' };
  }
}

export { searchMode };
