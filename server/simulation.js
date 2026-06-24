// A realistic scripted talk + a hundreds-strong simulated audience, driving the SAME
// event pipeline as real input. Goal: feel like an actual large meeting —
//   - ASR streams (interim → final) with disfluencies and mid-sentence chunks
//   - hundreds of anonymous participants, mostly emoji, fewer comments
//   - each "theme" has many paraphrase variants so clustering has real work to do
//   - skepticism / disagreement (controversy), confusion bursts on hard slides,
//     off-topic noise, repeat commenters (stance evolution)

import { uid } from './util.js';

// a large pool of anonymous tokens → participant count climbs into the hundreds
const POOL = Array.from({ length: 240 }, (_, i) => 'sim' + i.toString(36));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const who = () => pick(POOL);

// surface-form mutation so comments aren't byte-identical but still clusterable
const PRE = ['', '', '', '请问', '想问下', '那', '所以', '不过', '我觉得', '说真的'];
const POST = ['', '', '', '', '？', '?', '。', '求解答', '谢谢', '🙏'];
function vary(text) {
  let t = text;
  if (!/[？?。!！]$/.test(t) && Math.random() < 0.5) t += pick(POST);
  if (Math.random() < 0.35) t = pick(PRE) + t;
  return t;
}

// ---- the talk -------------------------------------------------------------
// say[]   = utterances, streamed as interim→final (some include 呃/那个/然后 fillers)
// themes[] = {type, weight, variants[]} → sampled `weight`-ish times across the slide
// emoji[]  = bursts {emoji, n}
// noise[]  = generic off-topic / meta chatter
const SCRIPT = [
  {
    title: 'MindCanvas · 把听众的声音收回来',
    body: '实时会议 Agent\n讲者：产品团队',
    say: [
      '呃，大家好，能听清吗？',
      '好，那我们开始。我是产品团队的，今天想跟大家聊一个我们做了挺久的东西。',
      '它叫 MindCanvas，一句话说，就是想把台下几百个人的声音，实时收回来。',
    ],
    themes: [
      { type: 'agreement', weight: 5, variants: ['期待！', '终于等到这个分享了', '坐等干货', '这个主题有意思', '冲！'] },
      { type: 'other', weight: 3, variants: ['音量有点小', '后排听不太清', '麦克风能开大点吗', '声音再大点谢谢'] },
    ],
    emoji: [{ emoji: '👏', n: 28 }, { emoji: '👍', n: 18 }],
    noise: ['沙发', '前排留名', '哈喽', '到', '1', '在听'],
  },
  {
    title: '痛点：大型分享是单向广播',
    body: '一人讲，几百人听\n• 困惑没人知道\n• 反例没机会说\n• 互动只剩点赞',
    say: [
      '我们先说痛点。你有没有这种感觉，',
      '就是在一个几百人的大会场里，台上一个人讲，台下几百个人……其实是沉默的。',
      '有人困惑、有人有反例、有人想补充，但是呢，绝大多数声音都浪费掉了。',
      '弹幕？弹幕是刷过去就没了，它不沉淀，也不收敛。',
    ],
    themes: [
      { type: 'agreement', weight: 8, variants: ['太真实了', '这痛点我天天遇到', '深有同感', '说到心坎里了', '对对对就是这样', '我开会全程沉默+1'] },
      { type: 'question', weight: 4, variants: ['有数据支撑吗', '有没有调研过到底多少人想发言', '这个痛点有多普遍', '有量化过吗'] },
      { type: 'opinion', weight: 3, variants: ['我觉得沉默也挺好的，省得吵', '有的人就是不想发言啊', '不发言不代表没在听', '安静听讲不好吗'] },
    ],
    emoji: [{ emoji: '😕', n: 6 }, { emoji: '👍', n: 22 }, { emoji: '🔥', n: 10 }],
    noise: ['哈哈哈', '+1', '真实', '笑死', '楼上说得对'],
  },
  {
    title: '洞察：many-to-one 实时综合',
    body: '不是转录+摘要\n而是把几百个声音\n实时收敛成一份连贯的东西',
    say: [
      '那我们的洞察是什么呢，',
      '关键不是转录加摘要，那个谁都会做。',
      '关键是 many-to-one，就是在中间放一个 LLM，把几百个声音实时收敛成一份连贯、可读、可参与的东西。',
      '这个收敛，才是真正难的地方，也是我们认为的壁垒。',
    ],
    themes: [
      { type: 'question', weight: 9, variants: ['这跟弹幕到底有啥区别', '和普通弹幕的差异是什么', '弹幕不就够了吗', '这不就是高级弹幕？', '和弹幕的本质区别在哪', '弹幕+AI 总结 是一回事吗'] },
      { type: 'question', weight: 5, variants: ['和 XX 会议纪要工具有啥不同', '和飞书妙记那种区别大吗', '市面上不是有很多转录工具了吗', '和现有的 AI 纪要比优势在哪'] },
      { type: 'agreement', weight: 4, variants: ['收敛这个词用得好', '这个洞察我认可', 'many-to-one 这个提法有意思', '确实，难点在收敛'] },
      { type: 'opinion', weight: 2, variants: ['LLM 收敛会不会失真', '会不会收敛成正确的废话', '中间加 LLM 不会有偏见吗'] },
    ],
    emoji: [{ emoji: '🔥', n: 26 }, { emoji: '🤔', n: 14 }, { emoji: '👍', n: 16 }],
    noise: ['术语好多', '记笔记中', '截图了'],
  },
  {
    title: '核心机制：带时间轴的提纲树',
    body: '幻灯片定章节骨架\n语音填页内讲解\n评论/emoji 挂节点\n— 永远 patch，不重生成',
    say: [
      '来看核心机制。状态是一棵带时间轴的提纲树。',
      '幻灯片定章节骨架，语音填页内的讲解，观众的评论和 emoji 挂到对应的节点上。',
      '注意啊，所有处理都是对这棵树打补丁，而不是每次重新生成全文，',
      '呃……这点很关键，因为这样它才能永远保持连贯，而且天然可以回放。',
      '每条评论都带时间戳，自动锚定到你开始写的那一刻、正在讲的那个节点。',
    ],
    themes: [
      { type: 'question', weight: 6, variants: ['锚定用的是发送时间还是开始写的时间', '如果我写得慢，发出去时主讲翻篇了怎么办', '时间戳取的是哪个时刻', '锚定会不会锚错节点', '写到一半翻页了怎么办'] },
      { type: 'question', weight: 5, variants: ['提纲树会不会越长越乱', '一直 patch 树会不会变得很臃肿', '长会议这棵树不会爆吗', '节点太多了怎么收起来'] },
      { type: 'agreement', weight: 5, variants: ['这个数据结构挺优雅', 'event-sourcing 好评', '永远 patch 这个设计赞', '回放功能很实用', '提纲树这个抽象漂亮'] },
      { type: 'confusion', weight: 4, variants: ['没太懂打补丁是啥意思', '事件溯源能再解释下吗', '这块有点抽象，没跟上', '补丁和重新生成区别在哪'] },
    ],
    emoji: [{ emoji: '😕', n: 14 }, { emoji: '🤔', n: 18 }, { emoji: '🔥', n: 12 }, { emoji: '👍', n: 14 }],
    noise: ['信息量好大', '这页要截图', '讲快了一点'],
  },
  {
    title: '视觉通道：幻灯片即骨架',
    body: '翻页 = 最干净的话题边界\nOCR 取图表/公式\nVLM 解析，只在翻页时跑',
    say: [
      '我们还有一条视觉通道。摄像头对着舞台和屏幕，',
      '翻页其实是最干净的话题边界，幻灯片标题直接就是章节标题，比从语音里猜准多了。',
      '然后只在翻页的时候跑一次 OCR 和 VLM，三十页大概也就三十次调用，很省。',
    ],
    themes: [
      { type: 'question', weight: 6, variants: ['需要额外装摄像头吗', '是用摄像头还是直接接 HDMI', '没有摄像头能用吗', '投屏信号能直接拿吗', '硬件要求高不高'] },
      { type: 'question', weight: 5, variants: ['隐私怎么办，会拍到观众吗', '摄像头会不会拍到台下', '录像存哪，安全吗', '隐私这块怎么保证'] },
      { type: 'question', weight: 3, variants: ['OCR 准确率怎么样', '中英文混排能识别吗', '公式和代码也能 OCR？'] },
      { type: 'opinion', weight: 2, variants: ['临场 demo 没有 PPT 怎么办', '万一不用幻灯片呢', '白板内容能抓到吗'] },
    ],
    emoji: [{ emoji: '👍', n: 16 }, { emoji: '🤔', n: 10 }, { emoji: '😮', n: 8 }],
    noise: ['这个我关心', '隐私+1', '记一下'],
  },
  {
    title: '规模：几百人怎么扛',
    body: '① 窗口批处理\n② 廉价前置过滤\n③ 分层模型\n④ 只浮现 Top-N',
    say: [
      '几百人同时发言，怎么扛？我们有四件套。',
      '评论攒五到十秒一批，前面用便宜的小模型做去重和过滤，',
      '然后分层，小模型 triage、大模型综合，最后只浮现 Top-N，其余折叠。',
      '贵的推理只在中心做一次，渲染结果再向几百端廉价广播。',
    ],
    themes: [
      { type: 'question', weight: 9, variants: ['延迟能控制在多少', '实时性怎么保证，会不会卡', '几百人同时发延迟大不大', '端到端延迟大概几秒', '高并发下会不会很卡', '响应有多快'] },
      { type: 'question', weight: 5, variants: ['前置过滤会不会误杀有用评论', '过滤掉的评论还能找回来吗', '万一把好评论当 spam 删了呢', '过滤的标准是什么'] },
      { type: 'question', weight: 4, variants: ['成本大概多少', '一场会要烧多少 token', '这么多模型调用很贵吧', '价格能扛得住吗'] },
      { type: 'opinion', weight: 3, variants: ['几百人真的扛得住吗，我有点怀疑', '听起来很理想，落地呢', '这套架构是不是过度设计了'] },
      { type: 'confusion', weight: 3, variants: ['四件套没记全，能重复下吗', '分层模型那块没听懂', 'triage 是啥意思'] },
    ],
    emoji: [{ emoji: '😕', n: 16 }, { emoji: '🤔', n: 16 }, { emoji: '🔥', n: 10 }, { emoji: '👍', n: 12 }],
    noise: ['这页信息密度爆炸', '四件套记住了', '工程量不小啊'],
  },
  {
    title: '现场演示',
    body: '（切到 live demo）',
    say: [
      '光说不练假把式，我现场放一段。大家现在手机上应该能看到画布在动了。',
      '呃……稍等，我点一下……好，看，左边大纲在长，右边问题在冒出来。',
      '诶，这个就是刚才有人问的那个问题，它自己聚到一起了。',
    ],
    themes: [
      { type: 'agreement', weight: 8, variants: ['卧槽有点酷', '这也太丝滑了吧', '真的在动！', '现场就能看到效果，可以', '我手机上看到了', '问题真的自己聚起来了'] },
      { type: 'question', weight: 3, variants: ['刚刚卡了一下是延迟吗', '能再演示一遍吗', '换个场景也能这样吗'] },
      { type: 'opinion', weight: 2, variants: ['demo 效果和真实场景差距大吗', '是不是提前准备好的数据'] },
    ],
    emoji: [{ emoji: '🔥', n: 40 }, { emoji: '👏', n: 30 }, { emoji: '😮', n: 14 }, { emoji: '❤️', n: 10 }],
    noise: ['哇', '6', '666', '绝了', '截屏了'],
  },
  {
    title: '路线图与开放问题',
    body: '第一期：骨架已跑通\n第二期：困惑热力图 / 观点光谱 / 主讲副驾\n欢迎提问',
    say: [
      '最后是路线图。第一期的骨架今天已经跑通了，就是你们正在看的这个。',
      '第二期我们会做困惑热力图、观点光谱、还有给主讲一个私有的副驾。',
      '好，差不多就这些，剩下时间留给大家提问。',
    ],
    themes: [
      { type: 'question', weight: 8, variants: ['什么时候能用上', '正式发布是什么时候', '现在能试用吗', '什么时候开放注册', '有内测名额吗', 'GA 时间定了吗'] },
      { type: 'question', weight: 7, variants: ['开源吗', '会不会开源', '代码开放吗', '有没有开源计划'] },
      { type: 'question', weight: 6, variants: ['能私有化部署吗', '支持本地部署吗', '能部署到我们自己服务器吗', '私有化方案有吗'] },
      { type: 'question', weight: 4, variants: ['支持多语言吗', '英文场子能用吗', '中英混讲识别准吗'] },
      { type: 'agreement', weight: 5, variants: ['很期待第二期', '观点光谱听起来很顶', '主讲副驾这个我想要', '做得不错，关注了'] },
    ],
    emoji: [{ emoji: '🔥', n: 30 }, { emoji: '❤️', n: 20 }, { emoji: '👏', n: 26 }, { emoji: '👍', n: 18 }],
    noise: ['辛苦了', '感谢分享', '关注了', '求个联系方式', '什么时候再分享'],
  },
];

export function runSimulation(emit, { speed = 1.5, intensity = 1 } = {}) {
  const timers = [];
  const at = (delay, fn) => timers.push(setTimeout(fn, Math.max(0, delay)));
  const S = (ms) => ms / speed;

  let cursor = 600; // running clock in real ms

  // stream one utterance as interim updates → final segment; returns end time
  function streamUtterance(text, startAt) {
    const dur = Math.min(6500, Math.max(1400, text.length * 135));
    const steps = 3;
    for (let i = 1; i <= steps; i++) {
      const ratio = i / (steps + 1);
      const prefix = text.slice(0, Math.max(2, Math.round(text.length * ratio)));
      at(startAt + S(dur * ratio), () => emit({ type: 'asr.interim', text: prefix }));
    }
    at(startAt + S(dur), () =>
      emit({ type: 'asr.segment', text, t_start: Date.now() - 1000, t_end: Date.now() })
    );
    return startAt + S(dur) + S(350);
  }

  at(200, () => emit({ type: 'session.config', title: 'MindCanvas 产品分享会 · LIVE' }));

  for (const slide of SCRIPT) {
    const slideStart = cursor;
    at(slideStart, () => emit({ type: 'slide.change', title: slide.title, body: slide.body, ocrText: slide.body }));

    // narration streams through the slide
    let speakAt = slideStart + S(900);
    for (const line of slide.say) {
      speakAt = streamUtterance(line, speakAt);
    }
    const slideEnd = speakAt + S(1200);
    const window = slideEnd - slideStart;

    // build the audience reaction pool for this slide
    const reactions = [];
    for (const theme of slide.themes) {
      const count = Math.round(theme.weight * intensity);
      for (let i = 0; i < count; i++) {
        reactions.push({ kind: 'comment', text: vary(pick(theme.variants)) });
      }
    }
    const noiseCount = Math.round((slide.noise.length + 2) * intensity);
    for (let i = 0; i < noiseCount; i++) reactions.push({ kind: 'comment', text: pick(slide.noise) });

    // spread comments across the slide window (people react while listening)
    for (const r of reactions) {
      const when = slideStart + S(1200) + Math.random() * (window - S(1500));
      at(when, () => emit({ type: 'comment.create', token: who(), text: r.text, t_compose: Date.now() }));
    }

    // emoji bursts — cheap, high-volume, the bulk of "互动"
    for (const burst of slide.emoji || []) {
      const n = Math.round(burst.n * intensity);
      const burstCenter = slideStart + window * (0.3 + Math.random() * 0.5);
      for (let i = 0; i < n; i++) {
        const jitter = (Math.random() - 0.5) * S(4000);
        at(burstCenter + jitter, () =>
          emit({ type: 'emoji.react', token: who(), emoji: burst.emoji, t_compose: Date.now() })
        );
      }
    }

    cursor = slideEnd + S(900);
  }

  return {
    durationMs: cursor + 2000,
    stop() {
      for (const id of timers) clearTimeout(id);
      timers.length = 0;
    },
  };
}
