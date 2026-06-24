// Client-side rendering helpers.

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function clockOffset(state) {
  // align client clock to the server clock so timeline labels are stable
  return state && state.serverTime ? state.serverTime - Date.now() : 0;
}

export function relTime(t, startedAt) {
  if (!t || !startedAt) return '';
  const s = Math.max(0, Math.round((t - startedAt) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function emojiSummary(emoji) {
  const entries = Object.entries(emoji || {}).filter(([, n]) => n > 0);
  return entries.map(([e, n]) => `${e} ${n}`).join('  ');
}

// stable vivid color (for dark big-screen) from a persona name
export function personaColor(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 72% 62%)`;
}

// §diarization: a color-coded speaker label (color is a stable hash of the label)
export function speakerTag(speaker) {
  if (!speaker) return '';
  let h = 0;
  for (let i = 0; i < speaker.length; i++) h = (h * 31 + speaker.charCodeAt(i)) % 360;
  const label = /^S\d+$/.test(speaker) ? '说话人 ' + speaker.slice(1) : speaker;
  return `<span class="spk" style="background:hsl(${h} 60% 91%);color:hsl(${h} 45% 32%)">${esc(label)}</span> `;
}

// signal chips for a node's metrics
export function signalChips(metrics) {
  if (!metrics) return '';
  const out = [];
  if (metrics.heat > 0) out.push(`<span class="chip heat">🔥 ${metrics.heat}</span>`);
  if (metrics.confusion > 0) out.push(`<span class="chip confuse">😕 ${metrics.confusion}</span>`);
  if (metrics.controversy >= 0.34) out.push(`<span class="chip controversy">⚡ 争议 ${(metrics.controversy * 100) | 0}%</span>`);
  return out.length ? `<span class="signals">${out.join('')}</span>` : '';
}
