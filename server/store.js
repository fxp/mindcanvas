// Canonical state = a time-stamped outline tree, built by an event-sourced reducer.
//
//   Slides define the coarse chapter skeleton  (§2.2  翻页 = 章节边界)
//   ASR fills in fine-grained points within a section
//   Comments / emoji anchor onto nodes          (§2.3  时间戳→内容 自动锚定)
//
// Every input (asr / slide / comment / emoji) is an `event`. The reducer only ever
// PATCHES the existing tree — it never regenerates the whole thing. This is what gives
// us coherence + replayability (the event log is the source of truth).

import { uid, now, splitSentences, looksLikeQuestion, collapseRepeats } from './util.js';
import { anchorByTime } from './anchoring.js';

const ROOT = 'root';

// Punctuation that marks the end of a complete utterance (CJK + latin).
function endsComplete(text) {
  return /[。！？!?；;\.]\s*$/u.test(text || '');
}

export class Store {
  constructor() {
    this.root = ROOT;
    this.events = []; // append-only log
    this.config = { title: '未命名会议', startedAt: now() };

    this.nodes = new Map(); // id -> node
    this.slides = []; // ordered slide records
    this.comments = new Map(); // id -> comment
    this.reactions = []; // lightweight emoji reactions (for timeline)
    this.tokens = new Set(); // distinct anonymous participants seen (§2.6)

    // dedup of durable events by producer-assigned id → safe retransmission
    this.seenIds = new Set();
    this.seenQueue = [];
    // ASR pipeline health, surfaced to the frontend (segments seen, last activity, source)
    this.asr = { segments: 0, lastSegmentAt: 0, lastInterimAt: 0, source: null, startedAt: 0 };
    this.supplements = []; // §资料补充: web-search enrichments anchored to content

    this.currentSectionId = null;
    this.currentSlideId = null;
    this.liveTranscript = ''; // interim ASR, not yet finalized into nodes

    this.dirtyNodes = new Set(); // nodes whose comments changed → need (re)clustering

    // root node
    this.nodes.set(ROOT, {
      id: ROOT,
      parentId: null,
      kind: 'root',
      text: this.config.title,
      t_start: this.config.startedAt,
      t_end: null,
      slideId: null,
      children: [],
      commentIds: [],
      emoji: {},
      clusters: [],
      metrics: { heat: 0, confusion: 0, controversy: 0 },
    });
  }

  // ---- event entry point ------------------------------------------------
  applyEvent(ev) {
    // interim ASR is ephemeral + high-frequency — never dedup or log it
    if (ev.type === 'asr.interim') {
      this.liveTranscript = ev.text || '';
      this.asr.lastInterimAt = now();
      if (ev.source) this.asr.source = ev.source;
      return { live: true };
    }
    // dedup durable events by producer-assigned id → retransmission is idempotent
    if (ev.id && this.seenIds.has(ev.id)) return { duplicate: true, id: ev.id };
    if (!ev.id) ev.id = uid('ev');
    this.seenIds.add(ev.id);
    this.seenQueue.push(ev.id);
    if (this.seenQueue.length > 5000) this.seenIds.delete(this.seenQueue.shift());

    if (!ev.t) ev.t = now();
    this.events.push(ev);

    if (ev.type === 'asr.segment') {
      this.asr.segments++;
      this.asr.lastSegmentAt = ev.t;
      if (!this.asr.startedAt) this.asr.startedAt = ev.t;
      if (ev.source) this.asr.source = ev.source;
    }

    switch (ev.type) {
      case 'session.config':
        return this._onConfig(ev);
      case 'slide.change':
        return this._onSlide(ev);
      case 'asr.segment':
        return this._onAsr(ev);
      case 'comment.create':
        return this._onComment(ev);
      case 'emoji.react':
        return this._onEmoji(ev);
      case 'supplement.add':
        return this._onSupplement(ev);
      default:
        return { ignored: true };
    }
  }

  _node(id) {
    return this.nodes.get(id);
  }

  _newNode(node) {
    this.nodes.set(node.id, node);
    return node;
  }

  // ---- reducers ---------------------------------------------------------
  _onConfig(ev) {
    if (ev.title) {
      this.config.title = ev.title;
      this._node(ROOT).text = ev.title;
    }
    return {};
  }

  _onSlide(ev) {
    const t = ev.t;
    // close the previous section + its open point
    if (this.currentSectionId) {
      const prev = this._node(this.currentSectionId);
      if (prev) {
        prev.t_end = t;
        if (prev._openPointId) {
          const op = this._node(prev._openPointId);
          if (op) op.t_end = t;
          prev._openPointId = null;
          prev._buffer = '';
        }
      }
    }

    const slideId = ev.slideId || uid('slide');
    const slide = {
      id: slideId,
      index: this.slides.length,
      title: ev.title || `幻灯片 ${this.slides.length + 1}`,
      body: ev.body || '',
      ocrText: ev.ocrText || ev.body || '',
      imageUrl: ev.imageUrl || null,
      t_start: t,
      t_end: null,
    };
    if (this.currentSlideId) {
      const prevSlide = this.slides.find((s) => s.id === this.currentSlideId);
      if (prevSlide) prevSlide.t_end = t;
    }
    this.slides.push(slide);
    this.currentSlideId = slideId;

    // a slide creates a new top-level SECTION (chapter skeleton from the deck)
    const section = this._newNode({
      id: uid('sec'),
      parentId: ROOT,
      kind: 'section',
      text: slide.title,
      t_start: t,
      t_end: null,
      slideId,
      children: [],
      commentIds: [],
      emoji: {},
      clusters: [],
      metrics: { heat: 0, confusion: 0, controversy: 0 },
      _buffer: '',
      _openPointId: null,
    });
    this._node(ROOT).children.push(section.id);
    this.currentSectionId = section.id;
    return { sectionId: section.id, slideId };
  }

  _ensureSection() {
    if (this.currentSectionId && this._node(this.currentSectionId)) return this._node(this.currentSectionId);
    // no slide yet → open an ASR-driven section. Its title is PROVISIONAL: the
    // narration segmenter (§2.2 off-deck) titles it once it has heard enough.
    const t = now();
    const section = this._newNode({
      id: uid('sec'),
      parentId: ROOT,
      kind: 'section',
      text: '（正在聆听…）',
      t_start: t,
      t_end: null,
      slideId: null,
      children: [],
      commentIds: [],
      emoji: {},
      clusters: [],
      metrics: { heat: 0, confusion: 0, controversy: 0 },
      _buffer: '',
      _openPointId: null,
      asrDriven: true,
      provisional: true,
      _lastSegLen: 0,
    });
    this._node(ROOT).children.push(section.id);
    this.currentSectionId = section.id;
    return section;
  }

  // narration segmenter writes here: give an ASR-driven section its title
  retitleSection(id, title) {
    const n = this._node(id);
    if (!n || !title) return;
    n.text = title;
    n.provisional = false;
  }

  // §思维导图：存一节提炼出的核心观点（不影响大纲里的原始要点）
  setKeyPoints(id, points) {
    const n = this._node(id);
    if (!n) return;
    n.keyPoints = points;
    n._kpLen = (n.children || []).length;
  }

  // §定期校正：replace a point's ASR text with a context-corrected version (once)
  correctPoint(id, text) {
    const n = this._node(id);
    if (!n || n.kind !== 'point') return false;
    n._corrected = true;
    if (!text || n.text === text) return false;
    n.text = text;
    return true;
  }

  // split an ASR-driven section at a point: points from `pointId` onward become a
  // new section (a detected topic shift). Comments anchored to points move with them.
  splitSectionAtPoint(sectionId, pointId, newTitle) {
    const sec = this._node(sectionId);
    if (!sec) return null;
    const idx = sec.children.indexOf(pointId);
    if (idx <= 0) return null; // keep at least one point in the original section
    const moved = sec.children.slice(idx);
    sec.children = sec.children.slice(0, idx);
    const firstMoved = this._node(moved[0]);
    const tStart = firstMoved ? firstMoved.t_start : now();
    sec.t_end = tStart;

    const ns = this._newNode({
      id: uid('sec'),
      parentId: ROOT,
      kind: 'section',
      text: newTitle || '（正在聆听…）',
      t_start: tStart,
      t_end: null,
      slideId: null,
      children: moved,
      commentIds: [],
      emoji: {},
      clusters: [],
      metrics: { heat: 0, confusion: 0, controversy: 0 },
      _buffer: '',
      _openPointId: null,
      asrDriven: true,
      provisional: !newTitle,
      _lastSegLen: 0,
    });
    for (const pid of moved) {
      const p = this._node(pid);
      if (p) p.parentId = ns.id;
    }
    // transfer the open (in-progress) point if it moved into the new section
    if (sec._openPointId && moved.includes(sec._openPointId)) {
      ns._openPointId = sec._openPointId;
      ns._buffer = sec._buffer;
      sec._openPointId = null;
      sec._buffer = '';
    }
    // place the new section right after the original in document order
    const rootChildren = this._node(ROOT).children;
    const sIdx = rootChildren.indexOf(sectionId);
    rootChildren.splice(sIdx + 1, 0, ns.id);
    this.currentSectionId = ns.id;
    return ns.id;
  }

  _newPoint(section, text, t_start, t_end, speaker = null) {
    const p = this._newNode({
      id: uid('pt'),
      parentId: section.id,
      kind: 'point',
      text,
      t_start,
      t_end,
      slideId: section.slideId,
      speaker, // §diarization: which speaker said this (when ASR provides it)
      children: [],
      commentIds: [],
      emoji: {},
      clusters: [],
      metrics: { heat: 0, confusion: 0, controversy: 0 },
    });
    section.children.push(p.id);
    return p;
  }

  // Streaming ASR → incremental points. Completed sentences become closed points;
  // the trailing fragment stays as one "open" point that keeps updating live.
  _onAsr(ev) {
    // collapse degenerate ASR repetition loops so a "这个是嗯，…"×100 hallucination
    // can't balloon into one giant point (and break the canvas / anchor preview).
    const text = collapseRepeats((ev.text || '').trim());
    if (!text) return {};
    this.liveTranscript = '';
    const section = this._ensureSection();
    const tEnd = ev.t_end || ev.t;
    const tStart = ev.t_start || ev.t;
    const speaker = ev.speaker || null;

    const combined = collapseRepeats((section._buffer ? section._buffer + ' ' : '') + text);
    const sentences = splitSentences(combined);
    const complete = endsComplete(combined) ? sentences : sentences.slice(0, -1);
    const remainder = endsComplete(combined) ? '' : sentences[sentences.length - 1] || '';

    if (complete.length) {
      // first completed sentence closes the currently-open point (if any)
      let idx = 0;
      if (section._openPointId) {
        const op = this._node(section._openPointId);
        if (op) {
          op.text = complete[0];
          op.t_end = tEnd;
          if (speaker) op.speaker = speaker;
        }
        section._openPointId = null;
        idx = 1;
      }
      for (; idx < complete.length; idx++) {
        this._newPoint(section, complete[idx], tStart, tEnd, speaker);
      }
    }

    if (remainder) {
      if (section._openPointId && this._node(section._openPointId)) {
        const op = this._node(section._openPointId);
        op.text = remainder;
        if (speaker) op.speaker = speaker;
      } else {
        const op = this._newPoint(section, remainder, tStart, null, speaker);
        section._openPointId = op.id;
      }
      section._buffer = remainder;
    } else {
      section._buffer = '';
    }
    return { sectionId: section.id };
  }

  _resolveAnchor(ev) {
    // A node id may arrive two ways:
    //   - explicit: user clicked a node to comment on it directly (§2.3 “无视时间”)
    //   - auto:     client captured the node active at compose time (clock-skew safe)
    // Either way we honor it; `explicit` only affects how the UI labels the anchor.
    if (ev.anchorNodeId && this._node(ev.anchorNodeId)) {
      const n = this._node(ev.anchorNodeId);
      return { nodeId: n.id, slideId: n.slideId, explicit: ev.explicit === undefined ? true : !!ev.explicit };
    }
    // else anchor purely by the COMPOSE timestamp (§2.3 关键细节: 取开始撰写时, 不是发送时)
    const t = ev.t_compose || ev.t;
    const nodeId = anchorByTime(this, t) || this.currentSectionId || ROOT;
    const node = this._node(nodeId);
    return { nodeId, slideId: node ? node.slideId : this.currentSlideId, explicit: false };
  }

  _onComment(ev) {
    const { nodeId, slideId, explicit } = this._resolveAnchor(ev);
    const c = {
      id: ev.commentId || uid('c'),
      token: ev.token || 'anon',
      text: (ev.text || '').trim(),
      t: ev.t,
      t_compose: ev.t_compose || ev.t,
      anchorNodeId: nodeId,
      anchorSlideId: slideId,
      explicit: !!explicit,
      isQuestion: looksLikeQuestion(ev.text),
      byAgent: !!ev.byAgent, // §participation: AI colleague persona
      persona: ev.persona || null,
      replyTo: ev.replyTo || null, // points at the comment this is a reply to (thread)
      clusterId: null,
    };
    if (!c.text) return {};
    if (c.token) this.tokens.add(c.token);
    this.comments.set(c.id, c);
    const node = this._node(nodeId);
    node.commentIds.push(c.id);
    this.dirtyNodes.add(nodeId);
    this._recomputeMetrics(nodeId);
    return { commentId: c.id, nodeId };
  }

  _onEmoji(ev) {
    const { nodeId, slideId } = this._resolveAnchor(ev);
    if (ev.token) this.tokens.add(ev.token);
    const node = this._node(nodeId);
    const emoji = ev.emoji || '👍';
    node.emoji[emoji] = (node.emoji[emoji] || 0) + 1;
    this.reactions.push({
      id: uid('r'),
      token: ev.token || 'anon',
      emoji,
      nodeId,
      slideId,
      t: ev.t,
    });
    this._recomputeMetrics(nodeId);
    return { nodeId, emoji };
  }

  _onSupplement(ev) {
    const nodeId = ev.nodeId || this.currentSectionId;
    const s = {
      id: ev.id || uid('sup'),
      text: (ev.text || '').trim(),
      source: ev.source || '',
      nodeId,
      nodeText: this._node(nodeId)?.text || '',
      t: ev.t,
    };
    if (!s.text) return {};
    this.supplements.push(s);
    if (this.supplements.length > 30) this.supplements.shift();
    return { supplement: s.id };
  }

  _recomputeMetrics(nodeId) {
    const node = this._node(nodeId);
    if (!node) return;
    const emojiTotal = Object.values(node.emoji).reduce((a, b) => a + b, 0);
    const confusionEmoji = (node.emoji['😕'] || 0) + (node.emoji['❓'] || 0) + (node.emoji['🤔'] || 0);
    let questionCount = 0;
    for (const cid of node.commentIds) {
      const c = this.comments.get(cid);
      if (c && c.isQuestion) questionCount++;
    }
    node.metrics.heat = node.commentIds.length + emojiTotal;
    node.metrics.confusion = confusionEmoji + questionCount;
    // controversy is filled in by the clustering pass
  }

  // ---- written to by the clustering pass --------------------------------
  setClusters(nodeId, clusters, controversy) {
    const node = this._node(nodeId);
    if (!node) return;
    node.clusters = clusters;
    if (typeof controversy === 'number') node.metrics.controversy = controversy;
    for (const cl of clusters) {
      for (const cid of cl.commentIds) {
        const c = this.comments.get(cid);
        if (c) c.clusterId = cl.id;
      }
    }
  }

  takeDirtyNodes() {
    const ids = [...this.dirtyNodes];
    this.dirtyNodes.clear();
    return ids;
  }

  // ---- derived: surfaced questions, grouped by node (§4 第一期) ----------
  deriveQuestions() {
    const out = [];
    for (const node of this.nodes.values()) {
      // question clusters
      for (const cl of node.clusters || []) {
        if (cl.type === 'question') {
          out.push({
            clusterId: cl.id,
            nodeId: node.id,
            nodeText: node.text,
            slideId: node.slideId,
            label: cl.label,
            size: cl.size,
          });
        }
      }
    }
    // ungrouped question comments on nodes that haven't been clustered yet
    for (const node of this.nodes.values()) {
      const clustered = new Set();
      for (const cl of node.clusters || []) for (const cid of cl.commentIds) clustered.add(cid);
      const loose = node.commentIds
        .map((id) => this.comments.get(id))
        .filter((c) => c && c.isQuestion && !clustered.has(c.id));
      if (loose.length) {
        out.push({
          clusterId: `loose_${node.id}`,
          nodeId: node.id,
          nodeText: node.text,
          slideId: node.slideId,
          label: loose[0].text,
          size: loose.length,
        });
      }
    }
    return out.sort((a, b) => b.size - a.size).slice(0, 12);
  }

  // ---- serializable snapshot for broadcast ------------------------------
  snapshot() {
    const nodes = {};
    for (const [id, n] of this.nodes) {
      nodes[id] = {
        id: n.id,
        parentId: n.parentId,
        kind: n.kind,
        text: n.text,
        t_start: n.t_start,
        t_end: n.t_end,
        slideId: n.slideId,
        children: n.children,
        commentIds: n.commentIds,
        emoji: n.emoji,
        clusters: n.clusters,
        metrics: n.metrics,
        provisional: !!n.provisional,
        asrDriven: !!n.asrDriven,
        keyPoints: n.keyPoints || null, // §思维导图：提炼后的核心观点
        speaker: n.speaker || null,
        open: n.id === (this._node(this.currentSectionId)?._openPointId),
      };
    }
    const comments = {};
    for (const [id, c] of this.comments) comments[id] = c;
    return {
      config: this.config,
      root: ROOT,
      nodes,
      slides: this.slides,
      comments,
      reactions: this.reactions.slice(-400),
      questions: this.deriveQuestions(),
      currentSectionId: this.currentSectionId,
      currentSlideId: this.currentSlideId,
      liveTranscript: this.liveTranscript,
      asr: { ...this.asr },
      supplements: this.supplements.slice(-12),
      stats: {
        commentCount: this.comments.size,
        reactionCount: this.reactions.length,
        slideCount: this.slides.length,
        eventCount: this.events.length,
        participants: this.tokens.size,
      },
      serverTime: now(),
    };
  }
}
