class SessionStore {
  constructor(plugin) {
    this.plugin = plugin;
  }

  state() {
    if (!this.plugin.runtimeState) {
      this.plugin.runtimeState = { sessions: [], activeSessionId: "", messagesBySession: {} };
    }
    return this.plugin.runtimeState;
  }

  upsertSession(session) {
    const st = this.state();
    const i = st.sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) st.sessions[i] = Object.assign({}, st.sessions[i], session);
    else st.sessions.unshift(session);

    st.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  setActiveSession(id) {
    this.state().activeSessionId = id;
  }

  appendMessage(sessionId, message) {
    const st = this.state();
    const list = st.messagesBySession[sessionId] || [];
    list.push(message);
    st.messagesBySession[sessionId] = list.slice(-200);

    const session = st.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.updatedAt = Date.now();
      if (message.role === "user") session.lastUserPrompt = message.text;
    }
  }

  static blockStatusRank(status) {
    const value = String(status || "").trim().toLowerCase();
    if (value === "error") return 4;
    if (value === "completed") return 3;
    if (value === "running") return 2;
    if (value === "pending") return 1;
    return 0;
  }

  static blockMergeKey(block, index) {
    if (!block || typeof block !== "object") return `invalid:${index}`;
    const id = String(block.id || "").trim();
    if (id) return `id:${id}`;
    const type = String(block.type || "").trim();
    const title = String(block.title || "").trim();
    const summary = String(block.summary || "").trim();
    return `fallback:${type}::${title}::${summary}::${index}`;
  }

  static mergeReasoningText(existingReasoning, incomingReasoning) {
    const existing = String(existingReasoning || "");
    const incoming = String(incomingReasoning || "");
    const existingTrimmed = existing.trim();
    const incomingTrimmed = incoming.trim();

    if (!incomingTrimmed) return existing;
    if (!existingTrimmed) return incoming;
    if (incoming === existing) return existing;
    if (incoming.includes(existing)) return incoming;
    if (existing.includes(incoming)) return existing;
    return `${existing}\n\n${incoming}`;
  }

  mergeBlocks(previousBlocks, nextBlocks) {
    const prev = Array.isArray(previousBlocks) ? previousBlocks : [];
    const next = Array.isArray(nextBlocks) ? nextBlocks : [];
    if (!next.length) return prev;

    const merged = prev.slice();
    const indexByKey = new Map();
    merged.forEach((block, idx) => {
      indexByKey.set(SessionStore.blockMergeKey(block, idx), idx);
    });

    next.forEach((block, idx) => {
      if (!block || typeof block !== "object") return;
      const key = SessionStore.blockMergeKey(block, idx);
      if (!indexByKey.has(key)) {
        indexByKey.set(key, merged.length);
        merged.push(block);
        return;
      }

      const existingIndex = Number(indexByKey.get(key));
      const existing = merged[existingIndex];
      const existingRank = SessionStore.blockStatusRank(existing && existing.status);
      const nextRank = SessionStore.blockStatusRank(block.status);
      const existingDetailLen = String(existing && existing.detail ? existing.detail : "").length;
      const nextDetailLen = String(block.detail || "").length;
      const shouldReplace = nextRank > existingRank || (nextRank === existingRank && nextDetailLen >= existingDetailLen);
      if (shouldReplace) {
        merged[existingIndex] = block;
      }
    });

    return merged;
  }

  updateAssistantDraft(sessionId, draftId, text, reasoning, meta, blocks) {
    const list = this.state().messagesBySession[sessionId] || [];
    const t = list.find((x) => x.id === draftId);
    if (!t) return;
    if (typeof text === "string") t.text = text;
    if (typeof reasoning === "string") {
      const nextReasoning = String(reasoning || "");
      const hasExistingReasoning = String(t.reasoning || "").trim().length > 0;
      // Avoid wiping already streamed reasoning when transport emits transient empty snapshots.
      if (nextReasoning.trim().length > 0) {
        t.reasoning = SessionStore.mergeReasoningText(t.reasoning, nextReasoning);
      } else if (!hasExistingReasoning) {
        t.reasoning = "";
      }
    }
    if (typeof meta === "string") t.meta = meta;
    if (Array.isArray(blocks)) t.blocks = this.mergeBlocks(t.blocks, blocks);
  }

  finalizeAssistantDraft(sessionId, draftId, text, error) {
    const list = this.state().messagesBySession[sessionId] || [];
    const t = list.find((x) => x.id === draftId);
    const payload =
      text && typeof text === "object"
        ? text
        : {
          text: String(text || ""),
          reasoning: "",
          meta: "",
          blocks: [],
        };
    if (t) {
      t.text = String(payload.text || "");
      {
        const nextReasoning = String(payload.reasoning || "");
        const hasExistingReasoning = String(t.reasoning || "").trim().length > 0;
        // Keep streamed reasoning if final payload omits it, and merge when snapshots are partial.
        if (nextReasoning.trim().length > 0) {
          t.reasoning = SessionStore.mergeReasoningText(t.reasoning, nextReasoning);
        } else if (!hasExistingReasoning) {
          t.reasoning = "";
        }
      }
      {
        const nextMeta = String(payload.meta || "");
        const hasNextMeta = nextMeta.trim().length > 0;
        const hasExistingMeta = String(t.meta || "").trim().length > 0;
        if (hasNextMeta || !hasExistingMeta) {
          t.meta = nextMeta;
        }
      }
      t.blocks = this.mergeBlocks(t.blocks, Array.isArray(payload.blocks) ? payload.blocks : []);
      t.error = error || "";
      t.pending = false;
    }
  }

  getActiveMessages() {
    const st = this.state();
    return st.messagesBySession[st.activeSessionId] || [];
  }
}


module.exports = { SessionStore };
