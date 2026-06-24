#!/usr/bin/env python3
"""Streaming-audio ASR worker — transcribes audio INCREMENTALLY as it "arrives".

Unlike tools/asr_stream.mjs (which replays a pre-made Whisper transcript), this loads
the model ONCE and transcribes the audio in real-time windows, posting each window's
text to MindCanvas the moment ASR finishes — i.e. with genuine streaming latency. This
models the §2.2 edge deployment: audio stream -> on-box ASR -> structured events -> center.

Run with the Whisper venv python:
  /opt/homebrew/opt/openai-whisper/libexec/bin/python tools/asr_live.py <audio> [speed] [title] [chunkSec] [model] [lang]
"""
import sys, os, time, json, re, subprocess, tempfile, urllib.request

audio = sys.argv[1]
speed = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
title = sys.argv[3] if len(sys.argv) > 3 else '流式音频 → 实时 ASR'
# Whisper transcribes internally in 30s windows, so a window much smaller than ~20s
# wastes a full inference on padding. Default 18s keeps base ≈ real-time on CPU.
chunk = float(sys.argv[4]) if len(sys.argv) > 4 else 18.0
model_name = sys.argv[5] if len(sys.argv) > 5 else 'base'
lang = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] != '-' else None
BASE = os.environ.get('MC_SERVER', 'http://localhost:8787')
ROOM = os.environ.get('MC_ROOM', 'main')
SERVER = BASE + '/api/ingest'

TERM = re.compile(r'[。！？.!?；;]$')
CJK = re.compile(r'[一-鿿]')


def coalesce(segments):
    """Whisper's sub-segments → sentence-sized chunks with terminal punctuation, so
    the store finalizes each into its own point (CJK output often lacks punctuation)."""
    chunks, acc = [], None
    for s in segments:
        t = (s.get('text') or '').strip()
        if not t:
            continue
        acc = t if acc is None else acc + ('' if CJK.search(t) else ' ') + t
        if TERM.search(acc) or len(acc) >= 24:
            chunks.append(acc)
            acc = None
    if acc:
        chunks.append(acc)
    return [c if TERM.search(c) else c + ('。' if CJK.search(c) else '.') for c in chunks]


_seq = 0
_outbox = []  # unacked durable events → breakpoint resume across network drops


def _post(obj, tries=1):
    data = json.dumps(obj).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(SERVER, data=data, headers={'Content-Type': 'application/json'})
            return json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
        except Exception as e:
            if i + 1 >= tries:
                print('post err:', e, file=sys.stderr)
                return None
            time.sleep(min(0.5 * (2 ** i), 4))  # exponential backoff


def flush():
    """Resend every unacked durable event; drop the ones the server accepts. The server
    dedups by id, so resending after a drop is idempotent (no double-apply)."""
    if not _outbox:
        return
    resp = _post({'room': ROOM, 'events': _outbox}, tries=4)
    if resp and resp.get('ok'):
        accepted = set(resp.get('accepted') or [])
        _outbox[:] = [e for e in _outbox if e.get('id') not in accepted]


def emit_durable(ev):
    global _seq
    _seq += 1
    ev['id'] = 'live_%d' % _seq
    ev['source'] = 'live'
    _outbox.append(ev)
    flush()


def emit_ephemeral(ev):
    _post({'room': ROOM, 'event': ev}, tries=1)  # interim — fire-and-forget


def duration(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        capture_output=True, text=True).stdout.strip()
    return float(out) if out else 0.0


def main():
    import whisper
    dur = duration(audio)
    if dur <= 0:
        print('cannot read audio duration', file=sys.stderr); sys.exit(1)
    print(f'loading whisper "{model_name}" …', file=sys.stderr)
    model = whisper.load_model(model_name)
    print(f'streaming {dur:.0f}s in {chunk:.0f}s windows at {speed}x (model={model_name}, lang={lang or "auto"})', file=sys.stderr)

    _post({'room': ROOM, 'control': {'action': 'reset'}}, tries=3)
    emit_durable({'type': 'session.config', 'title': title})

    t0 = time.time()
    i = 0
    while i * chunk < dur:
        start = i * chunk
        end = min(dur, (i + 1) * chunk)
        # pace to wall clock: wait until this window has fully "played" (÷ speed)
        target = end / speed
        while time.time() - t0 < target:
            time.sleep(0.05)
        # mark the window as being recognized (live interim — ephemeral)
        emit_ephemeral({'type': 'asr.interim', 'text': '（识别中…）'})
        # extract the window and transcribe it (model already resident → no reload)
        wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
        subprocess.run(['ffmpeg', '-y', '-ss', str(start), '-i', audio, '-t', str(end - start),
                        '-ar', '16000', '-ac', '1', wav, '-loglevel', 'quiet'])
        kw = {'language': lang} if lang else {}
        t_asr = time.time()
        res = model.transcribe(wav, fp16=False, **kw)
        lat = time.time() - t_asr
        os.unlink(wav)
        chunks = coalesce(res.get('segments') or [])
        for c in chunks:
            emit_durable({'type': 'asr.segment', 'text': c})
        if chunks:
            q = (' [outbox %d]' % len(_outbox)) if _outbox else ''
            print(f'[{start:5.0f}-{end:4.0f}s] (asr {lat:4.1f}s, {len(chunks)} pts){q} {" / ".join(chunks)}', file=sys.stderr)
        i += 1
    # drain any unacked events before exiting (covers a drop near the end)
    for _ in range(5):
        if not _outbox:
            break
        flush()
        time.sleep(1)
    print(f'done. ({len(_outbox)} unacked left)', file=sys.stderr)


if __name__ == '__main__':
    main()
