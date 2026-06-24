// Optional LLM layer. The whole app runs WITHOUT a key (heuristic fallbacks in
// clustering.js); with a key we use a real model for the "many-to-one synthesis"
// that is the actual moat (§ intro). Two providers, auto-detected from env:
//
//   BIGMODEL_API_KEY  → 智谱 / Zhipu GLM   (OpenAI-compatible endpoint)
//   ANTHROPIC_API_KEY → Claude
//
// GLM-5.1 / 4.5 are reasoning models: we send thinking:{type:'disabled'} so the
// answer lands in `content` fast (real-time triage, §2.7) instead of burning the
// token budget on chain-of-thought.

const DEFAULT_ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// base URL is overridable from the frontend (custom / self-hosted / proxy endpoints)
const zhipuBase = () => (process.env.BIGMODEL_BASE_URL || DEFAULT_ZHIPU_BASE).replace(/\/+$/, '');
const zhipuChatUrl = () => zhipuBase() + '/chat/completions';
const zhipuAsrUrl = () => zhipuBase() + '/audio/transcriptions';
const anthropicUrl = () => process.env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_URL;

const zhipuKey = () => process.env.BIGMODEL_API_KEY || process.env.ZHIPU_API_KEY;
const anthropicKey = () => process.env.ANTHROPIC_API_KEY;

export function provider() {
  if (zhipuKey()) return 'zhipu';
  if (anthropicKey()) return 'anthropic';
  return null;
}

export function llmEnabled() {
  return !!provider();
}

function chatModel() {
  if (provider() === 'zhipu') return process.env.MINDCANVAS_MODEL || 'glm-5.1';
  return process.env.MINDCANVAS_MODEL || 'claude-haiku-4-5-20251001';
}
function visionModel() {
  if (provider() === 'zhipu') return process.env.MINDCANVAS_VISION_MODEL || 'glm-4.5v';
  return process.env.MINDCANVAS_VISION_MODEL || 'claude-haiku-4-5-20251001';
}

export function llmInfo() {
  const p = provider();
  if (!p) return { enabled: false, provider: null, label: '启发式综合' };
  const model = chatModel();
  const label = (p === 'zhipu' ? model.toUpperCase() : 'Claude') + ' 综合';
  return { enabled: true, provider: p, model, label, endpoint: p === 'zhipu' ? zhipuBase() : anthropicUrl() };
}

// set the active key + optional custom endpoint at runtime (configured from the frontend).
// Kept in process env only — never persisted, never returned to clients.
export function setLlmConfig({ provider: prov = 'zhipu', key, model, endpoint } = {}) {
  const ep = (endpoint || '').trim().replace(/\/+$/, '');
  if (prov === 'anthropic') {
    process.env.ANTHROPIC_API_KEY = key;
    delete process.env.BIGMODEL_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    if (ep) process.env.ANTHROPIC_BASE_URL = ep; else delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.BIGMODEL_BASE_URL;
  } else {
    process.env.BIGMODEL_API_KEY = key;
    delete process.env.ANTHROPIC_API_KEY;
    if (ep) process.env.BIGMODEL_BASE_URL = ep; else delete process.env.BIGMODEL_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
  }
  if (model) process.env.MINDCANVAS_MODEL = model;
  return llmInfo();
}

// tiny validation round-trip; throws if the key/model is unusable.
export async function llmPing() {
  await chat({ system: '只回复两个字：可用', user: 'ping', maxTokens: 16 });
  return true;
}

export function asrAvailable() {
  return provider() === 'zhipu'; // BigModel/Zhipu glm-asr; Anthropic has no ASR here
}
// Vision (slide-image OCR) is OPTIONAL — only powers /api/ocr auto-fill. Set
// MINDCANVAS_VISION=off to disable on intranets without a vision model.
export function visionAvailable() {
  if ((process.env.MINDCANVAS_VISION || '').toLowerCase() === 'off') return false;
  return llmEnabled();
}
// 资料补充 source: 'web' (GLM web_search, needs internet), 'local' (offline file
// corpus), or 'off'. Default: web when a zhipu key exists, else off.
export function searchMode() {
  const m = (process.env.MINDCANVAS_SEARCH_MODE || '').toLowerCase();
  if (m === 'web' || m === 'local' || m === 'off') return m;
  return provider() === 'zhipu' ? 'web' : 'off';
}
export function searchAvailable() {
  return searchMode() === 'web' && provider() === 'zhipu';
}

// §资料补充：use GLM's web_search tool to fetch ONE relevant supplement for the current
// content (a fact / datum / definition / latest progress) with a source name.
export async function llmSearchSupplement(sectionTitle, points) {
  if (provider() !== 'zhipu') throw new Error('需 BigModel key');
  const ctx = (points || []).slice(-6).join('；');
  const res = await fetch(zhipuChatUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${zhipuKey()}` },
    body: JSON.stringify({
      model: process.env.MINDCANVAS_SEARCH_MODEL || 'glm-4.6',
      thinking: { type: 'disabled' },
      temperature: 0.3,
      max_tokens: 600,
      tools: [{ type: 'web_search', web_search: { enable: true } }],
      messages: [
        { role: 'system', content: '你是分享会的资料员。联网检索，针对正在讲的内容补充【一条】有价值、相关、具体的信息（一个事实/数据/定义/最新进展/对比/案例），帮听众加深理解。≤45字、客观、并给出来源名（机构/网站/论文/作者）。严格只输出 JSON：{"text":"补充内容","source":"来源名"}。检索不到有价值信息就让 text 为空字符串。' },
        { role: 'user', content: `当前小节：「${sectionTitle || '分享'}」\n正在讲：${ctx}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`search ${res.status}: ${(await res.text().catch(() => '')).slice(0, 150)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const p = extractJson(content);
  return { text: (p.text || '').trim(), source: (p.source || '').trim() };
}

// §资料补充（离线版）：no internet — phrase a supplement from already-retrieved LOCAL
// document chunks (Word/PDF/PPT/txt indexed offline). `hits` = [{file, loc, text}].
// Falls back to a verbatim snippet when no LLM is configured.
export async function llmSearchLocal(sectionTitle, points, hits) {
  if (!hits || !hits.length) return { text: '', source: '' };
  const top = hits[0];
  const cite = top.file + (top.loc ? ' · ' + top.loc : '');
  if (!llmEnabled()) {
    // heuristic: trimmed snippet of the best-matching chunk
    const snip = top.text.replace(/\s+/g, ' ').trim().slice(0, 45);
    return { text: snip, source: cite };
  }
  const ctx = (points || []).slice(-6).join('；');
  const refs = hits.slice(0, 3).map((h, i) => `[${i + 1}] 《${h.file}》${h.loc ? '·' + h.loc : ''}: ${h.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
  const system =
    '你是分享会的资料员，只能引用【本地资料库】里检索到的内容（不得编造库外信息）。针对正在讲的内容，从下面的资料片段里提炼【一条】最相关、最有价值的补充（事实/数据/定义/对比/案例），帮听众加深理解。' +
    '≤45字、客观；source 必须是引用片段对应的文件名（可带页/页码）。若片段与当前内容无关，就让 text 为空字符串。严格只输出 JSON：{"text":"补充内容","source":"文件名"}。';
  const user = `当前小节：「${sectionTitle || '分享'}」\n正在讲：${ctx}\n\n【本地资料片段】\n${refs}`;
  try {
    const text = await chat({ system, user, maxTokens: 400 });
    const pj = extractJson(text);
    return { text: (pj.text || '').trim(), source: (pj.source || '').trim() || cite };
  } catch {
    const snip = top.text.replace(/\s+/g, ' ').trim().slice(0, 45);
    return { text: snip, source: cite };
  }
}

// Transcribe a WAV buffer via BigModel glm-asr. The endpoint wants multipart/form-data
// and only accepts wav/mp3 (NOT webm/m4a — so the browser captures WAV directly).
export async function llmTranscribe(buf, filename = 'audio.wav') {
  if (provider() !== 'zhipu') throw new Error('ASR 需要 BigModel(GLM) key');
  const model = process.env.MINDCANVAS_ASR_MODEL || 'glm-asr';
  const boundary = '----mc' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  const res = await fetch(zhipuAsrUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${zhipuKey()}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`GLM-ASR ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  // §diarization: if the model returns per-speaker segments, surface them; else plain text.
  const segments = Array.isArray(data.segments)
    ? data.segments
        .map((s) => ({
          text: (s.text || '').trim(),
          speaker: s.speaker != null ? String(s.speaker) : s.speaker_id != null ? 'S' + s.speaker_id : null,
        }))
        .filter((s) => s.text)
    : null;
  return { text: (data.text || '').trim(), segments };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no json object found');
  return JSON.parse(raw.slice(start, end + 1));
}

// Unified text completion across providers.
async function chat({ system, user, maxTokens = 1400 }) {
  const p = provider();
  if (p === 'zhipu') {
    const res = await fetch(zhipuChatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${zhipuKey()}` },
      body: JSON.stringify({
        model: chatModel(),
        thinking: { type: 'disabled' },
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`GLM ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json();
    const m = data.choices?.[0]?.message || {};
    return m.content || m.reasoning_content || '';
  }
  // anthropic
  const res = await fetch(anthropicUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': anthropicKey(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: chatModel(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('');
}

// map model-returned members (indices OR raw text) back to comment ids
function resolveMembers(members, comments) {
  const ids = [];
  for (const mem of members || []) {
    if (typeof mem === 'number' && comments[mem]) {
      ids.push(comments[mem].id);
      continue;
    }
    if (typeof mem === 'string') {
      const idx = parseInt(mem, 10);
      if (!Number.isNaN(idx) && String(idx) === mem.trim() && comments[idx]) {
        ids.push(comments[idx].id);
        continue;
      }
      const found = comments.find(
        (c) => c.text === mem || c.text.trim() === mem.trim() || mem.includes(c.text) || c.text.includes(mem)
      );
      if (found) ids.push(found.id);
    }
  }
  return [...new Set(ids)];
}

// Cluster the comments anchored to a single content node (§2.4 上下文内聚类).
export async function llmClusterComments(nodeText, comments) {
  const list = comments.map((c, i) => `${i}. ${c.isQuestion ? '[问] ' : ''}${c.text}`).join('\n');
  const system =
    '你是实时会议的内容综合引擎。下面是观众针对“同一个内容节点”发出的评论。' +
    '把它们按语义聚成若干簇（去重、合并相同诉求）。每个簇给出：' +
    'label（一句话概括该簇，≤20字）、type（question | opinion | agreement | confusion | suggestion | other）、' +
    'summary（簇内共识，≤40字）、members（该簇包含的评论“编号”数组，编号即每行开头的数字，必须是整数）。' +
    '再给出 controversy：0~1，表示这些评论立场的分歧程度。' +
    '严格只输出 JSON：{"clusters":[{"label":"","type":"","summary":"","members":[0,1]}],"controversy":0.0}';
  const user = `当前内容节点：「${nodeText}」\n\n评论列表（编号. 文本）：\n${list}`;
  const text = await chat({ system, user, maxTokens: 1400 });
  const parsed = extractJson(text);
  const clusters = (Array.isArray(parsed.clusters) ? parsed.clusters : [])
    .map((cl) => ({
      label: cl.label || '',
      type: cl.type || 'other',
      summary: cl.summary || '',
      commentIds: resolveMembers(cl.members, comments),
    }))
    .filter((cl) => cl.commentIds.length);
  return {
    clusters,
    controversy: typeof parsed.controversy === 'number' ? parsed.controversy : 0,
  };
}

// §定期校正：context-correct a batch of ASR points (fix homophones / names / numbers).
export async function llmCorrectPoints(contextTitle, texts) {
  const list = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const system =
    '下面是连续语音转写(ASR)的要点，含识别错误和口语里的语气词/口头禅。逐条做两件事：' +
    '1) 结合上下文校正明显的识别错误（错别字/同音/专有名词/数字）；' +
    '2) 删除语气词与口头禅（呃、嗯、啊、哦、那个、就是、就是说、对吧、是吧、然后(用作口头语时)、这个(用作口头语时) 等），让每条更书面、干净。' +
    '不要改变原意、不扩写、不合并、不增删条目。' +
    '严格只输出 JSON：{"fixed":["第1条","第2条",...]}，数组长度与输入完全一致、顺序一致；本就干净的条目原样返回。';
  const user = `主题：「${contextTitle || '演讲'}」\n要点：\n${list}`;
  const text = await chat({ system, user, maxTokens: 1600 });
  const p = extractJson(text);
  return Array.isArray(p.fixed) ? p.fixed : [];
}

// §2.2 off-deck: derive chapter structure from PURE speech (no slides). Given the
// running points of the current (untitled / growing) section, return a concise title
// for the current topic, and whether the latest points started a NEW topic.
export async function llmSegmentNarration(pointTexts, prevTitle = '') {
  const list = pointTexts.map((t, i) => `${i}. ${t}`).join('\n');
  const system =
    '你在为一段“没有幻灯片”的连续演讲做实时分段，只能依赖语音转写出来的要点。任务：' +
    '1) 为这些要点所讲的“当前话题”起一个具体、有信息量的标题（≤14字，用演讲所用的语言；避免“AI问题/谈一谈”这类空泛词）；' +
    '2) 判断靠后的要点是否【明显】开启了一个新话题。' +
    '【务必保守】：同一大主题下的展开、举例、递进都不算新话题，宁可不分也不要把一个话题切碎；只有话题实质转向时才分。' +
    '若分段，给出起始要点编号 splitAt（整数）与新话题标题 newTitle；否则 splitAt 用 null。' +
    (prevTitle ? `上一节标题是「${prevTitle}」——当前/新标题必须与它【明显不同】，不要近义重复；若内容其实是上一节的延续，就不要分段、并把 title 与上一节区分开。` : '') +
    '严格只输出 JSON：{"title":"","splitAt":null,"newTitle":""}';
  const user = `演讲要点（编号. 文本）：\n${list}`;
  const text = await chat({ system, user, maxTokens: 400 });
  const p = extractJson(text);
  return {
    title: p.title || '',
    splitAt: p.splitAt === null || p.splitAt === undefined ? null : Number(p.splitAt),
    newTitle: p.newTitle || '',
  };
}

// §participation: a short in-character comment from an AI "colleague" persona.
export async function llmPersonaComment(persona, sectionTitle, points, recentComments) {
  const pts = (points || []).slice(-6).map((t) => '- ' + t).join('\n') || '（暂无）';
  const cmts = (recentComments || []).slice(-4).map((t) => '- ' + t).join('\n');
  const system =
    `你在扮演线上分享会的一位听众「${persona.name}」（${persona.role}）。根据正在进行的分享内容，` +
    `以你的身份发一条简短、口语化、像真人随手发的评论或提问（性格：${persona.style}）。` +
    '要求：≤28字、自然、不要客套、不要重复别人已说过的、不要自我介绍、不要加引号。只输出这条评论文本本身。';
  const user = `当前小节：「${sectionTitle || '分享'}」\n最近讲到：\n${pts}` + (cmts ? `\n现场已有评论：\n${cmts}` : '');
  let text = await chat({ system, user, maxTokens: 90 });
  return text.trim().replace(/^["「『]+|["」』]+$/g, '').split('\n')[0].slice(0, 40);
}

// §participation: an AI persona REPLIES to a real audience comment → forms a thread.
export async function llmPersonaReply(persona, targetText, sectionTitle) {
  const system =
    `你在扮演线上分享会的听众「${persona.name}」（${persona.role}，性格：${persona.style}）。` +
    '现场另一位观众刚发了一条评论，请你以你的身份对它【简短回应】（附议/补充/反驳/追问都行，要自然、有来有往）。' +
    '≤28字、口语化、可带“楼上/这个”等指代、不要客套、不要自我介绍、不要加引号。只输出你的回应文本。';
  const user = `当前小节：「${sectionTitle || '分享'}」\n那条评论：「${targetText}」`;
  let text = await chat({ system, user, maxTokens: 90 });
  return text.trim().replace(/^["「『]+|["」』]+$/g, '').split('\n')[0].slice(0, 40);
}

// 纪要融合：把一段讲解的【讲者要点】与【现场评论簇】融合成高质量纪要片段。
// 返回 {summary, highlights:[{kind,label,size,note}]}。
export async function llmFuseSection(title, pointTexts, clusters) {
  const pts = pointTexts.map((t, i) => `${i + 1}. ${t}`).join('\n') || '（无）';
  const cls = clusters.length
    ? clusters.map((c) => `- [${c.type}·${c.size}人] ${c.label}${c.summary ? '：' + c.summary : ''}`).join('\n')
    : '（无现场评论）';
  const system =
    '你在为一场演讲写高质量纪要的某一节。只保留【高信息量】内容：能支撑这一节核心逻辑链的论点、结论、关键事实/数据、因果与取舍。' +
    '坚决丢弃：寒暄、试麦（喂喂、能听到吗）、口头语/语气词、重复或冗余、跑题闲聊、以及没有实质信息的句子。' +
    '把筛后的讲者要点凝练成 1~3 句连贯、有逻辑递进的中文小结（宁缺毋滥；若这一节没有实质内容，summary 给空字符串）。' +
    '再从【现场评论簇】里挑出最有价值的提问/观点/争议（最多 3 条，按热度优先），每条给出 kind（question|opinion|agreement|confusion|suggestion）、label（精炼后的一句话）、size（人数）、note（为什么值得记，≤20字）。' +
    '现场没有有价值评论就让 highlights 为空数组。严格只输出 JSON：{"summary":"","highlights":[{"kind":"","label":"","size":0,"note":""}]}';
  const user = `小节标题：「${title}」\n\n【讲者要点】\n${pts}\n\n【现场评论簇】\n${cls}`;
  const text = await chat({ system, user, maxTokens: 900 });
  const p = extractJson(text);
  return {
    summary: p.summary || '',
    highlights: Array.isArray(p.highlights) ? p.highlights : [],
  };
}

// 从全场讲者要点 + 现场评论里抽取「可落地的沉淀」：行动项 / 决议 / 待解答 / 风险争议。
export async function llmExtractActions(title, points, clusters) {
  const pts = points.slice(0, 140).map((t, i) => `${i + 1}. ${t}`).join('\n') || '（无）';
  const cls = clusters.length
    ? clusters.map((c) => `- [${c.type}·${c.size}人] ${c.label}${c.summary ? '：' + c.summary : ''}`).join('\n')
    : '（无）';
  const system =
    '你在从一场演讲的【讲者要点】与【现场评论】里，抽取可落地的沉淀，分四类：' +
    'action（行动项/待办，尽量含对象或负责人）、decision（达成的决议/明确结论）、question（仍待解答的问题，尤其现场高热度提问）、risk（风险/争议/分歧点）。' +
    '每条给 type、text（一句话，具体、可执行或可追踪）、note（来源或依据，≤16字）。只抽真正有价值的；某类没有就不出现。' +
    '最多 8 条。严格只输出 JSON：{"actions":[{"type":"","text":"","note":""}]}';
  const user = `演讲：「${title}」\n\n【讲者要点】\n${pts}\n\n【现场评论簇（按热度）】\n${cls}`;
  const text = await chat({ system, user, maxTokens: 1100 });
  const p = extractJson(text);
  return Array.isArray(p.actions) ? p.actions : [];
}

// 全场 TL;DR：把各节小结融成 2~3 句总览。
export async function llmDigestOverview(title, sectionSummaries) {
  const list = sectionSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const system = '把下面演讲各节的小结融成 2~3 句的全场总览（中文）。只串起支撑全场核心论点的主逻辑链：从问题/背景→关键主张→结论/价值，丢弃枝节与寒暄，不堆砌、不复述细节。只输出这段文字本身。';
  const text = await chat({ system, user: `演讲：「${title}」\n各节小结：\n${list}`, maxTokens: 400 });
  return text.trim();
}

// OCR / read a slide image into {title, body} (§2.2 视觉通道). Best-effort.
export async function llmReadSlide(dataUrl) {
  const m = /^data:(image\/[a-z.+-]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('not a data url');
  const p = provider();
  const sys = '你在解析一张幻灯片截图。输出 JSON：{"title":"幻灯片标题","body":"要点文本，保留要点换行"}。只输出 JSON。';

  if (p === 'zhipu') {
    const res = await fetch(zhipuChatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${zhipuKey()}` },
      body: JSON.stringify({
        model: visionModel(),
        max_tokens: 600,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: sys + '\n解析这张幻灯片。' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`GLM vision ${res.status}`);
    const data = await res.json();
    const txt = data.choices?.[0]?.message?.content || '';
    return extractJson(txt);
  }

  const res = await fetch(anthropicUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: visionModel(),
      max_tokens: 600,
      system: sys,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
            { type: 'text', text: '解析这张幻灯片。' },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Claude vision ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  return extractJson(text);
}
