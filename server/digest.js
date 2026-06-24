// 最终大纲 / 会议纪要：融合【讲者内容】与【现场高质量评论】。
//
// 对每个章节：收集该节(及其页内要点)挂载的讲者要点 + 观众评论簇，交给 LLM 融成
// 「小结 + 现场高光」。再把各节小结融成全场总览。无 LLM 时退回结构化拼装。

import { llmEnabled, llmFuseSection, llmDigestOverview, llmExtractActions } from './llm.js';
import { collapseRepeats, isLowInfo } from './util.js';

const KIND_CN = {
  question: '提问',
  opinion: '观点',
  agreement: '认同',
  confusion: '困惑',
  suggestion: '建议',
  other: '声音',
};

const ACTION_CN = {
  action: '行动项',
  decision: '决议',
  question: '待解答',
  risk: '风险/争议',
};

function collectSection(store, sec) {
  const points = [];
  const clusters = [];
  const add = (node) => {
    // keep only high-information points — drop filler / mic-checks / 语气词 / repetition loops
    if (node.kind === 'point') {
      const t = collapseRepeats((node.text || '').trim(), 400);
      if (t && !isLowInfo(t)) points.push(t);
    }
    for (const cl of node.clusters || []) {
      if (cl.size >= 1) clusters.push({ type: cl.type, label: cl.label, size: cl.size, summary: cl.summary || '' });
    }
  };
  add(sec);
  for (const pid of sec.children || []) {
    const p = store.nodes.get(pid);
    if (p) add(p);
  }
  clusters.sort((a, b) => b.size - a.size);
  return { points, clusters: clusters.slice(0, 6) };
}

export async function buildDigest(store) {
  const root = store.nodes.get(store.root);
  const sections = (root.children || []).map((id) => store.nodes.get(id)).filter((s) => s && s.kind === 'section');

  // fuse every section CONCURRENTLY — sequential would be ~N×LLM-latency (too slow)
  const candidates = sections
    .map((sec) => ({ sec, ...collectSection(store, sec) }))
    .filter((c) => c.points.length || c.clusters.length);

  // whole-talk material for action-item extraction (runs alongside the sections)
  const allPoints = candidates.flatMap((c) => c.points);
  const allClusters = candidates.flatMap((c) => c.clusters).sort((a, b) => b.size - a.size).slice(0, 16);

  const [out, actions] = await Promise.all([
    Promise.all(
      candidates.map(async ({ sec, points, clusters }) => {
        let summary = '';
        let highlights = [];
        if (llmEnabled()) {
          try {
            const r = await llmFuseSection(sec.text, points, clusters);
            summary = r.summary;
            highlights = r.highlights;
          } catch (e) {
            console.warn('[digest] fuse failed:', e.message);
          }
        }
        if (!summary) {
          // heuristic fallback: first couple points + top clusters verbatim
          summary = points.slice(0, 3).join(' ');
          highlights = clusters.slice(0, 3).map((c) => ({ kind: c.type, label: c.label, size: c.size, note: '' }));
        }
        return { title: sec.text, provisional: !!sec.provisional, summary, highlights, pointCount: points.length };
      })
    ),
    (async () => {
      if (!llmEnabled() || (!allPoints.length && !allClusters.length)) return [];
      try {
        return await llmExtractActions(store.config.title, allPoints, allClusters);
      } catch (e) {
        console.warn('[digest] actions failed:', e.message);
        return [];
      }
    })(),
  ]);

  let overview = '';
  if (llmEnabled() && out.length) {
    try {
      overview = await llmDigestOverview(store.config.title, out.map((s) => s.summary));
    } catch (e) {
      console.warn('[digest] overview failed:', e.message);
    }
  }

  return { title: store.config.title, generatedAt: store.snapshot().serverTime, overview, actions, sections: out, stats: store.snapshot().stats };
}

export function digestToMarkdown(d) {
  const lines = [];
  lines.push(`# ${d.title} · 会议纪要`);
  lines.push('');
  lines.push(`> 融合讲者内容与现场 ${d.stats.participants} 位参与者的 ${d.stats.commentCount} 条评论、${d.stats.reactionCount} 次互动。`);
  lines.push('');
  if (d.overview) {
    lines.push('## 全场总览');
    lines.push('');
    lines.push(d.overview);
    lines.push('');
  }
  if (d.actions && d.actions.length) {
    lines.push('## 行动项 · 决议 · 待办');
    lines.push('');
    const order = ['action', 'decision', 'question', 'risk'];
    for (const t of order) {
      const items = d.actions.filter((a) => a.type === t);
      if (!items.length) continue;
      for (const a of items) {
        const note = a.note ? `（${a.note}）` : '';
        lines.push(`- \`${ACTION_CN[t] || t}\` ${a.text}${note}`);
      }
    }
    lines.push('');
  }
  d.sections.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${s.title}`);
    lines.push('');
    if (s.summary) { lines.push(s.summary); lines.push(''); }
    if (s.highlights && s.highlights.length) {
      lines.push('**现场高光：**');
      for (const h of s.highlights) {
        const k = KIND_CN[h.kind] || '声音';
        const note = h.note ? `（${h.note}）` : '';
        lines.push(`- \`${k} · ${h.size}人\` ${h.label}${note}`);
      }
      lines.push('');
    }
  });
  return lines.join('\n');
}
