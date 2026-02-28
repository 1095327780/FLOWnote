const {
  normalizeSessionTitleInput,
  isPlaceholderSessionTitle,
  deriveSessionTitleFromPrompt,
} = require("./domain/session-title");

class SessionStore {
  constructor(plugin) {
    this.plugin = plugin;
  }

  state() {
    if (!this.plugin.runtimeState) {
      this.plugin.runtimeState = { sessions: [], activeSessionId: "", messagesBySession: {}, deletedSessionIds: [] };
    }
    if (!Array.isArray(this.plugin.runtimeState.deletedSessionIds)) {
      this.plugin.runtimeState.deletedSessionIds = [];
    }
    return this.plugin.runtimeState;
  }

  static normalizeSessionTitleInput(value) {
    return normalizeSessionTitleInput(value);
  }

  static isPlaceholderTitle(title) {
    return isPlaceholderSessionTitle(title);
  }

  static deriveTitleFromPrompt(prompt) {
    return deriveSessionTitleFromPrompt(prompt);
  }

  static normalizeTimestampMs(value) {
    const raw = Number(value || 0);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    if (raw >= 1e14) return Math.floor(raw / 1000);
    if (raw >= 1e12) return Math.floor(raw);
    if (raw >= 1e9) return Math.floor(raw * 1000);
    return Math.floor(raw);
  }

  static normalizeLinkedContextFiles(value) {
    const list = Array.isArray(value) ? value : [];
    const seen = new Set();
    const normalized = [];
    list.forEach((rawPath) => {
      const next = String(rawPath || "").trim().replace(/^\/+/, "");
      if (!next || seen.has(next)) return;
      seen.add(next);
      normalized.push(next);
    });
    return normalized;
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

  renameSession(sessionId, title) {
    const st = this.state();
    const session = st.sessions.find((s) => s.id === sessionId);
    if (!session) return false;

    const normalized = normalizeSessionTitleInput(title);
    if (!normalized) return false;

    session.title = normalized;
    session.updatedAt = Date.now();
    return true;
  }

  removeSession(sessionId) {
    const st = this.state();
    const before = st.sessions.length;
    st.sessions = st.sessions.filter((s) => s.id !== sessionId);
    const removed = st.sessions.length !== before;
    if (!removed) return false;

    delete st.messagesBySession[sessionId];

    if (!st.deletedSessionIds.includes(sessionId)) {
      st.deletedSessionIds.push(sessionId);
    }

    if (st.activeSessionId === sessionId) {
      st.activeSessionId = st.sessions.length ? st.sessions[0].id : "";
    }

    return true;
  }

  setSessionMessages(sessionId, messages) {
    const st = this.state();
    const sid = String(sessionId || "").trim();
    if (!sid) return false;
    const source = Array.isArray(messages) ? messages : [];
    const normalized = source
      .map((message, index) => {
        const row = message && typeof message === "object" ? message : null;
        if (!row) return null;
        const roleRaw = String(row.role || "").trim().toLowerCase();
        const role = roleRaw === "assistant" ? "assistant" : roleRaw === "user" ? "user" : "";
        if (!role) return null;
        const createdAt = SessionStore.normalizeTimestampMs(row.createdAt || row.updatedAt || row.timestamp || 0);
        const linkedContextFiles = role === "user"
          ? SessionStore.normalizeLinkedContextFiles(row.linkedContextFiles)
          : [];
        return {
          id: String(row.id || `${role}-${Date.now()}-${index}`),
          role,
          text: String(row.text || ""),
          linkedContextFiles,
          reasoning: role === "assistant" ? String(row.reasoning || "") : "",
          meta: role === "assistant" ? String(row.meta || "") : "",
          blocks: role === "assistant" && Array.isArray(row.blocks) ? row.blocks : [],
          pending: false,
          error: String(row.error || ""),
          createdAt: createdAt || Date.now(),
        };
      })
      .filter(Boolean)
      .slice(-200);

    st.messagesBySession[sid] = normalized;

    const session = st.sessions.find((s) => s.id === sid);
    if (session) {
      const latestMessage = normalized.length ? normalized[normalized.length - 1] : null;
      if (latestMessage && Number(latestMessage.createdAt || 0) > 0) {
        session.updatedAt = Number(latestMessage.createdAt || Date.now());
      }
      const latestUserMessage = [...normalized]
        .reverse()
        .find((row) => row && row.role === "user" && String(row.text || "").trim().length > 0);
      if (latestUserMessage) {
        session.lastUserPrompt = String(latestUserMessage.text || "");
        if (isPlaceholderSessionTitle(session.title)) {
          const nextTitle = deriveSessionTitleFromPrompt(session.lastUserPrompt);
          if (nextTitle) session.title = nextTitle;
        }
      }
    }

    return true;
  }

  appendMessage(sessionId, message) {
    const st = this.state();
    const list = st.messagesBySession[sessionId] || [];
    const nextMessage = message && typeof message === "object"
      ? Object.assign({}, message)
      : message;
    if (nextMessage && typeof nextMessage === "object" && nextMessage.role === "user") {
      nextMessage.linkedContextFiles = SessionStore.normalizeLinkedContextFiles(nextMessage.linkedContextFiles);
    }
    list.push(nextMessage);
    st.messagesBySession[sessionId] = list.slice(-200);

    const session = st.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.updatedAt = Date.now();
      if (message.role === "user") {
        const promptText = typeof message.text === "string" ? message.text : "";
        session.lastUserPrompt = promptText;
        if (isPlaceholderSessionTitle(session.title)) {
          const nextTitle = deriveSessionTitleFromPrompt(promptText);
          if (nextTitle) session.title = nextTitle;
        }
      }
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
    if (incomingTrimmed.startsWith(existingTrimmed) || incomingTrimmed.endsWith(existingTrimmed)) return incoming;
    if (existingTrimmed.startsWith(incomingTrimmed) || existingTrimmed.endsWith(incomingTrimmed)) return existing;

    const overlapSuffixPrefix = (leftText, rightText) => {
      const left = String(leftText || "");
      const right = String(rightText || "");
      const max = Math.min(left.length, right.length, 2048);
      for (let len = max; len >= 16; len -= 1) {
        if (left.slice(left.length - len) === right.slice(0, len)) return len;
      }
      return 0;
    };

    const overlap = overlapSuffixPrefix(existing, incoming);
    if (overlap > 0) return `${existing}${incoming.slice(overlap)}`;
    const reverseOverlap = overlapSuffixPrefix(incoming, existing);
    if (reverseOverlap > 0) return `${incoming}${existing.slice(reverseOverlap)}`;

    return incoming.length >= existing.length ? incoming : `${existing}\n\n${incoming}`;
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
