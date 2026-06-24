// §2.2 off-deck segmentation. When there are no slides, the chapter skeleton has to
// be DERIVED from the speech. This runs on a cadence over the CURRENT ASR-driven
// section: it titles the section once enough has been heard, and splits off a new
// section when the latest speech shifts topic. Older (already-titled) sections are
// frozen — we only ever work the live edge, which is why titles necessarily lag a
// little behind what's being said right now (exactly the real-world behavior).
//
// Preferred path: the LLM proposes title + boundary. Fallback (no key / no quota):
// a discourse-marker heuristic that catches explicit enumeration cues
// (一曰… / 二曰… / 首先 / 第一 / secondly …) — cheap, and good for structured talks.

import { llmEnabled, llmSegmentNarration } from './llm.js';

// "一曰抱定宗旨。" → "抱定宗旨"; "第二，要砥砺德行" → "要砥砺德行"; English cues too.
const MARKER = /^(?:[一二三四五六七八九十]曰|第[一二三四五六七八九十]+[、，：:]?|首先|其次|再次|最后|另外|接下来|then|first(?:ly)?|second(?:ly)?|third(?:ly)?|finally)\s*[，,、:：]?\s*([^。！？，,、；;]{1,14})?/i;

function markerTitle(text) {
  const m = (text || '').match(MARKER);
  if (m && m[1] && m[1].trim()) return m[1].trim();
  return null;
}
function isBoundary(text) {
  return MARKER.test((text || '').trim()) && /^(?:[一二三四五六七八九十]曰|第[一二三四五六七八九十]|首先|其次|再次|最后|另外|接下来|first|second|third|finally)/i.test((text || '').trim());
}

export async function segmentNarration(store) {
  const secId = store.currentSectionId;
  const sec = store.nodes.get(secId);
  if (!sec || !sec.asrDriven) return;

  const points = sec.children.map((id) => store.nodes.get(id)).filter((p) => p && p.kind === 'point');
  if (points.length < 3) return; // need enough to title meaningfully

  // throttle: a titled section is only re-examined after it grows by ≥2 points;
  // a still-provisional section is always examined (we want to title it ASAP).
  const grown = points.length - (sec._lastSegLen || 0);
  if (!sec.provisional && grown < 2) return;
  sec._lastSegLen = points.length;

  if (llmEnabled()) {
    try {
      // give the segmenter the previous section's title so it can avoid near-duplicates
      const rootChildren = store.nodes.get(store.root).children;
      const here = rootChildren.indexOf(secId);
      const prevTitle = here > 0 ? store.nodes.get(rootChildren[here - 1])?.text || '' : '';
      const res = await llmSegmentNarration(points.map((p) => p.text), prevTitle);
      if (res.title) store.retitleSection(secId, res.title);
      if (Number.isInteger(res.splitAt) && res.splitAt >= 2 && res.splitAt < points.length) {
        store.splitSectionAtPoint(secId, points[res.splitAt].id, res.newTitle || null);
      }
      return;
    } catch (e) {
      console.warn('[narration] LLM unavailable, marker heuristic:', e.message);
    }
  }

  // --- marker heuristic fallback ---
  const isFirstSection = store.nodes.get(store.root).children[0] === secId;
  if (sec.provisional) {
    const mt = markerTitle(points[0].text);
    store.retitleSection(secId, mt || (isFirstSection ? '开场' : points[0].text.slice(0, 12) + '…'));
  }
  // split at the first discourse-marker point after index 0. Without an LLM we only
  // split on explicit markers — splitting marker-less prose by count is arbitrary,
  // so a marker-less monologue stays one section (the LLM is what handles that case).
  let splitIdx = -1;
  for (let i = 1; i < points.length; i++) {
    if (isBoundary(points[i].text)) { splitIdx = i; break; }
  }
  if (splitIdx >= 1) {
    store.splitSectionAtPoint(secId, points[splitIdx].id, markerTitle(points[splitIdx].text));
  }
}
