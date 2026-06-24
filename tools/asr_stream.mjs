// Stream a Whisper ASR transcript into a running MindCanvas server, preserving the
// REAL timing of the recording. This is the genuine pipeline: audio → Whisper → events.
//
//   1. yt-dlp -f bestaudio -o audio.webm <url>
//   2. ffmpeg -i audio.webm -t 360 -ar 16000 -ac 1 audio.wav
//   3. whisper audio.wav --model base --output_format json --output_dir .
//   4. node tools/asr_stream.mjs audio.json [speed] ["Title"]
//
// Each Whisper segment carries start/end seconds; we replay them on that schedule
// (÷ speed), emitting an interim (partial) then the final segment — exactly what a
// real streaming ASR feeding the speaker console would do. No slides → the off-deck
// narration segmenter (§2.2) must derive the chapter structure from the speech.

import fs from 'node:fs';

const file = process.argv[2] || '/tmp/jobs.json';
const speed = Number(process.argv[3] || 4);
const title = process.argv[4] || '真实录音 → Whisper ASR';

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const raw = (data.segments || []).filter((s) => s.text && s.text.trim());
if (!raw.length) {
  console.error('no segments in', file);
  process.exit(1);
}

// Whisper's CJK output often has NO punctuation and very short segments. Coalesce
// consecutive segments into sentence-sized chunks (flushing on terminal punctuation,
// length, or a speech pause) and add terminal punctuation, so the store finalizes
// each chunk into a clean point. English (already punctuated) passes through ~1:1.
const TERM = /[。！？.!?；;]$/;
const isCJK = (t) => /[一-鿿]/.test(t);
const segs = [];
let acc = null;
const flush = () => {
  if (!acc) return;
  if (!TERM.test(acc.text)) acc.text += isCJK(acc.text) ? '。' : '.';
  segs.push(acc);
  acc = null;
};
for (let i = 0; i < raw.length; i++) {
  const s = raw[i];
  const t = s.text.trim();
  if (!acc) acc = { text: t, start: s.start, end: s.end };
  else { acc.text += (isCJK(t) ? '' : ' ') + t; acc.end = s.end; }
  const gap = raw[i + 1] ? raw[i + 1].start - s.end : 99;
  if (TERM.test(acc.text) || acc.text.length >= 26 || gap >= 0.7) flush();
}
flush();

const ws = new WebSocket('ws://localhost:8787');
const timers = [];

ws.addEventListener('error', (e) => {
  console.error('WS error — is the server running on :8787?', e.message || e);
  process.exit(1);
});

ws.addEventListener('open', () => {
  // start from a blank canvas
  ws.send(JSON.stringify({ kind: 'control', action: 'reset' }));
  setTimeout(() => ws.send(JSON.stringify({ kind: 'event', event: { type: 'session.config', title } })), 120);

  const offset = 400;
  for (const s of segs) {
    const text = s.text.trim();
    const startMs = offset + (s.start * 1000) / speed;
    const endMs = offset + (s.end * 1000) / speed;
    const partial = text.slice(0, Math.max(2, Math.round(text.length * 0.6)));
    timers.push(
      setTimeout(() => ws.send(JSON.stringify({ kind: 'event', event: { type: 'asr.interim', text: partial } })), startMs)
    );
    timers.push(
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({ kind: 'event', event: { type: 'asr.segment', text, t_start: Date.now() - 800, t_end: Date.now() } })
          ),
        endMs
      )
    );
  }

  const totalMs = offset + (segs[segs.length - 1].end * 1000) / speed + 2500;
  console.log(`streaming ${segs.length} real ASR segments at ${speed}× → ~${Math.round(totalMs / 1000)}s …`);
  setTimeout(() => {
    console.log('done.');
    ws.close();
    process.exit(0);
  }, totalMs);
});
