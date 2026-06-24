// §2.4  Context-local clustering — the system's spine.
//
// Comments are clustered ONLY within their anchored node (not globally). That is
// cheaper, more accurate, and the signal is more actionable ("5 people are asking
// THIS specific point"). One anchoring feeds half the feature list: confusion heat,
// controversy, question queue, opinion spectrum — all derived from per-node signals.

import { uid, tokenize, jaccard, looksLikeQuestion } from './util.js';
import { llmEnabled, llmClusterComments } from './llm.js';

// crude stance lexicon for heuristic controversy
const POS = ['同意', '赞成', '支持', '对', '好', '没错', 'agree', 'yes', 'good', '+1', '👍'];
const NEG = ['不同意', '反对', '错', '不对', '质疑', '不', 'disagree', 'no', 'wrong', 'but', '但'];

// CJK/EN stopwords + question particles: dropped before similarity so SALIENT content
// (e.g. 弹幕 / 延迟) drives clustering instead of common glue words.
const STOP = new Set([
  '的', '了', '吗', '呢', '是', '在', '和', '与', '也', '都', '就', '还', '把', '被', '给', '让', '吧', '啊',
  '呀', '嘛', '我', '你', '他', '她', '它', '们', '这', '那', '个', '有', '不', '没', '要', '会', '能', '可',
  '以', '之', '其', '为', '对', '到', '地', '得', '着', '过', '一', '啥', '么', '什', '怎', '如', '何', '多',
  '少', '大', '小', 'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'it', 'this', 'that', 'do', 'you', 'we', 'i',
]);
function salient(tokens) {
  return tokens.filter((t) => !STOP.has(t));
}
function sharedCount(a, b) {
  const set = new Set(b);
  let n = 0;
  for (const t of new Set(a)) if (set.has(t)) n++;
  return n;
}

function stance(text) {
  const t = text.toLowerCase();
  let s = 0;
  for (const w of POS) if (t.includes(w)) s += 1;
  for (const w of NEG) if (t.includes(w)) s -= 1;
  return Math.max(-1, Math.min(1, s));
}

function classify(text) {
  if (looksLikeQuestion(text)) return 'question';
  const s = stance(text);
  if (s > 0) return 'agreement';
  if (s < 0) return 'opinion';
  return 'other';
}

// Greedy similarity clustering within one node's comment set. Two comments merge if
// they're similar enough (jaccard on salient tokens) OR share ≥2 salient content
// tokens — the latter rescues short CJK questions that share a keyword (弹幕 / 延迟).
function heuristicCluster(comments) {
  const items = comments.map((c) => ({ ...c, sal: salient(tokenize(c.text)) }));
  const clusters = [];
  const THRESH = 0.3;
  for (const it of items) {
    let placed = null;
    for (const cl of clusters) {
      const sim = jaccard(it.sal, cl.centroid);
      if (sim >= THRESH || sharedCount(it.sal, cl.centroid) >= 2) {
        placed = cl;
        break;
      }
    }
    if (!placed) {
      placed = { members: [], centroid: [], types: {} };
      clusters.push(placed);
    }
    placed.members.push(it);
    placed.centroid = Array.from(new Set([...placed.centroid, ...it.sal]));
    const ty = classify(it.text);
    placed.types[ty] = (placed.types[ty] || 0) + 1;
  }

  const stances = items.map((it) => stance(it.text));
  const mean = stances.reduce((a, b) => a + b, 0) / (stances.length || 1);
  const variance = stances.reduce((a, b) => a + (b - mean) ** 2, 0) / (stances.length || 1);

  const out = clusters
    .map((cl) => {
      const dominantType =
        Object.entries(cl.types).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
      // representative = longest member text
      const rep = cl.members.slice().sort((a, b) => b.text.length - a.text.length)[0];
      return {
        id: uid('cl'),
        label: rep.text.length > 40 ? rep.text.slice(0, 40) + '…' : rep.text,
        type: dominantType,
        summary: '',
        commentIds: cl.members.map((m) => m.id),
        size: cl.members.length,
      };
    })
    .sort((a, b) => b.size - a.size);

  return { clusters: out, controversy: Math.min(1, variance) };
}

// Cluster one node's comments. Tries Claude, falls back to heuristic on any error.
export async function clusterNode(store, nodeId) {
  const node = store.nodes.get(nodeId);
  if (!node || !node.commentIds.length) return;
  const comments = node.commentIds
    .map((id) => store.comments.get(id))
    .filter(Boolean)
    .map((c) => ({ id: c.id, text: c.text, isQuestion: c.isQuestion }));
  if (!comments.length) return;

  // Tiny sets aren't worth an API round-trip.
  if (llmEnabled() && comments.length >= 2) {
    try {
      const { clusters, controversy } = await llmClusterComments(node.text, comments);
      const mapped = clusters
        .map((cl) => {
          const ids = (cl.commentIds || []).filter(Boolean);
          if (!ids.length) return null;
          return {
            id: uid('cl'),
            label: cl.label || ids.length + ' 条评论',
            type: cl.type || 'other',
            summary: cl.summary || '',
            commentIds: ids,
            size: ids.length,
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.size - a.size);
      // include any comment the model dropped as its own singleton cluster
      const covered = new Set(mapped.flatMap((c) => c.commentIds));
      for (const c of comments) {
        if (!covered.has(c.id)) {
          mapped.push({
            id: uid('cl'),
            label: c.text.length > 40 ? c.text.slice(0, 40) + '…' : c.text,
            type: classify(c.text),
            summary: '',
            commentIds: [c.id],
            size: 1,
          });
        }
      }
      store.setClusters(nodeId, mapped, controversy);
      return;
    } catch (err) {
      console.warn('[clustering] LLM failed, falling back to heuristic:', err.message);
    }
  }

  const { clusters, controversy } = heuristicCluster(comments);
  store.setClusters(nodeId, clusters, controversy);
}
