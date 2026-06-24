// Inject a live audience alongside a talk: themed Chinese comments + emoji, sent with
// t_compose=now and NO explicit anchor, so the server auto-anchors each to whatever
// node is live at that moment (§2.3). Used together with asr_stream.mjs to produce a
// real talk + real discussion, which the digest then fuses.
//
//   node tools/audience_inject.mjs [durationSec] [intensity]

const durationSec = Number(process.argv[2] || 75);
const intensity = Number(process.argv[3] || 1);

const POOL = Array.from({ length: 180 }, (_, i) => 'aud' + i.toString(36));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const PRE = ['', '', '', '请问', '想问下', '所以', '那', '我觉得', '说真的'];
const POST = ['', '', '', '？', '?', '。', '求解答', '谢谢'];
const vary = (t) => {
  let s = t;
  if (!/[？?。!！]$/.test(s) && Math.random() < 0.5) s += pick(POST);
  if (Math.random() < 0.3) s = pick(PRE) + s;
  return s;
};

// themed for an AI / OpenAI / alignment talk — many paraphrases per theme so the
// per-node clustering has real merging to do, and the digest has high-signal material.
const THEMES = [
  { type: 'question', w: 9, v: ['AI 真的会统治世界吗', '人类会被 AI 取代吗', 'AI 会不会毁灭世界', '通用人工智能还有多远', 'AGI 什么时候到来', 'AI 会抢走我的工作吗'] },
  { type: 'question', w: 8, v: ['对齐问题到底怎么解决', '怎么让 AI 理解人类模糊的目标', '价值对齐有具体方案吗', '目标函数怎么定义人类价值', '怎么保证 AI 的目标和人类一致'] },
  { type: 'question', w: 6, v: ['OpenAI 的安全措施够吗', '安全和能力哪个更优先', 'RLHF 真的有效吗', '现在的对齐方法可靠吗'] },
  { type: 'agreement', w: 6, v: ['讲得太好了', '这个观点很认同', '深有同感', '说到点子上了', '受教了', '这段很有启发'] },
  { type: 'opinion', w: 5, v: ['我觉得风险被夸大了', '没那么快吧，有点危言耸听', '商业利益会不会压过安全', '监管跟不上技术', '不能只靠企业自律'] },
  { type: 'confusion', w: 5, v: ['对齐到底是什么意思', '目标函数那段没太懂', 'RLHF 能再解释一下吗', '没跟上，能举个例子吗', '这块有点抽象'] },
  { type: 'suggestion', w: 3, v: ['音量可以再大点', 'PPT 字有点小', '语速能慢一点吗'] },
];
const EMOJI = ['👍', '🔥', '🤔', '😕', '👏', '❤️'];

const ROOM = process.env.MC_ROOM || 'main';
const BASE = (process.env.MC_SERVER || 'http://localhost:8787').replace(/^http/, 'ws');
const ws = new WebSocket(BASE + '/?room=' + encodeURIComponent(ROOM));
ws.addEventListener('error', (e) => { console.error('WS error — server on :8787?', e.message || e); process.exit(1); });

ws.addEventListener('open', () => {
  const weighted = [];
  for (const th of THEMES) for (let i = 0; i < th.w; i++) weighted.push(th);
  const endAt = Date.now() + durationSec * 1000;
  let n = 0;

  function tick() {
    if (Date.now() >= endAt) {
      console.log(`injected ${n} audience events over ${durationSec}s`);
      setTimeout(() => { ws.close(); process.exit(0); }, 500);
      return;
    }
    // mostly emoji (cheap), some comments
    if (Math.random() < 0.55) {
      ws.send(JSON.stringify({ kind: 'event', event: { type: 'emoji.react', token: pick(POOL), emoji: pick(EMOJI), t_compose: Date.now() } }));
    } else {
      const th = pick(weighted);
      ws.send(JSON.stringify({ kind: 'event', event: { type: 'comment.create', token: pick(POOL), text: vary(pick(th.v)), t_compose: Date.now() } }));
    }
    n++;
    setTimeout(tick, (300 + Math.random() * 900) / intensity);
  }
  // ramp up after the talk has a node or two to anchor onto
  setTimeout(tick, 3000);
});
