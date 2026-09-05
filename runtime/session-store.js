const {
  normalizeSessionTitleInput,
  isPlaceholderSessionTitle,
  deriveSessionTitleFromPrompt,
} = require("./domain/session-title");
const { reduceExecutionEvents, recoverInterruptedRun } = require("./agent/execution-ledger");
const { mergeDurableToolBlocks } = require("./chat/execution-block-projection");

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
        const execution = role === "assistant" && row.execution && Array.isArray(row.execution.events)
          ? { version: 1, events: row.execution.events }
          : null;
        return {
          id: String(row.id || `${role}-${Date.now()}-${index}`),
          messageId: String(row.messageId || row.messageID || row.id || "").trim(),
          role,
          text: String(row.text || ""),
          linkedContextFiles,
          reasoning: role === "assistant" ? String(row.reasoning || "") : "",
          meta: role === "assistant" ? String(row.meta || "") : "",
          blocks: role === "assistant" && Array.isArray(row.blocks) ? row.blocks : [],
          stats: role === "assistant" && row.stats && typeof row.stats === "object"
            ? JSON.parse(JSON.stringify(row.stats))
            : null,
          execution,
          continuationClaimedBy: role === "assistant" ? String(row.continuationClaimedBy || "") : "",
          continuationConsumedBy: role === "assistant" ? String(row.continuationConsumedBy || "") : "",
          status: role === "assistant" ? String(row.status || (row.error ? "failed" : "completed")) : "completed",
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

  appendMessage(sessionId, message, options = {}) {
    const st = this.state();
    const list = st.messagesBySession[sessionId] || [];
    const nextMessage = message && typeof message === "object"
      ? Object.assign({}, message)
      : message;
    if (nextMessage && typeof nextMessage === "object" && nextMessage.role === "user") {
      nextMessage.linkedContextFiles = SessionStore.normalizeLinkedContextFiles(nextMessage.linkedContextFiles);
    }
    list.push(nextMessage);
    const protectedIds = new Set(
      (Array.isArray(options.protectedMessageIds) ? options.protectedMessageIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    );
    if (list.length <= 200 || protectedIds.size === 0) {
      st.messagesBySession[sessionId] = list.slice(-200);
    } else {
      // A targeted continuation may sit at the retention boundary. Keep that
      // exact suspended message long enough for the direct runner to claim it,
      // while retaining the newest messages (including this append).
      const protectedIndexes = list
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item && protectedIds.has(String(item.id || "")))
        .map(({ index }) => index)
        .slice(-199);
      const selected = new Set(protectedIndexes);
      for (let index = list.length - 1; index >= 0 && selected.size < 200; index -= 1) {
        selected.add(index);
      }
      st.messagesBySession[sessionId] = list.filter((_item, index) => selected.has(index));
    }

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

  updateAssistantDraft(sessionId, draftId, text, reasoning, meta, blocks) {
    const list = this.state().messagesBySession[sessionId] || [];
    const t = list.find((x) => x.id === draftId);
    if (!t) return;
    if (typeof text === "string") t.text = text;
    if (typeof reasoning === "string") t.reasoning = reasoning;
    if (typeof meta === "string") t.meta = meta;
    if (Array.isArray(blocks)) t.blocks = blocks;
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
      const messageId = String(payload.messageId || payload.messageID || "").trim();
      if (messageId) {
        t.messageId = messageId;
      }
      t.text = String(payload.text || "");
      t.reasoning = String(payload.reasoning || "");
      t.meta = String(payload.meta || "");
      if (payload.stats && typeof payload.stats === "object") {
        t.stats = JSON.parse(JSON.stringify(payload.stats));
      }
      const payloadBlocks = Array.isArray(payload.blocks) ? payload.blocks : [];
      if (payload.execution && Array.isArray(payload.execution.events)) {
        t.execution = { version: 1, events: payload.execution.events };
        t.blocks = mergeDurableToolBlocks(payloadBlocks, payload.execution.events);
      } else {
        t.blocks = payloadBlocks;
      }
      t.status = String(payload.status || (error ? "failed" : "completed"));
      t.error = error || "";
      t.pending = false;
      this.markContinuationOwnerDisposition(sessionId, draftId, t.status);
    }
  }

  setAssistantExecution(sessionId, draftId, events) {
    const list = this.state().messagesBySession[sessionId] || [];
    const message = list.find((item) => item && item.id === draftId);
    if (!message || message.role !== "assistant" || !Array.isArray(events)) return false;
    const state = reduceExecutionEvents(events);
    const runs = Object.values(state.runs);
    const run = runs.length ? runs[runs.length - 1] : null;
    message.execution = { version: 1, events: JSON.parse(JSON.stringify(events)) };
    message.blocks = mergeDurableToolBlocks(message.blocks, events);
    message.status = run ? run.status : "pending";
    message.pending = message.status === "running";
    this.markContinuationOwnerDisposition(sessionId, draftId, message.status);
    return true;
  }

  markContinuationOwnerDisposition(sessionId, draftId, status) {
    const normalizedStatus = String(status || "").trim();
    if (!["completed", "suspended", "blocked"].includes(normalizedStatus)) return;
    const ownerId = String(draftId || "").trim();
    if (!ownerId) return;
    const list = this.state().messagesBySession[sessionId] || [];
    for (const source of list) {
      if (!source || String(source.continuationClaimedBy || "") !== ownerId) continue;
      source.continuationConsumedBy = ownerId;
    }
  }

  getContinuationClaimState(sessionId, messageId) {
    const list = this.state().messagesBySession[sessionId] || [];
    const message = list.find((item) => item && item.id === messageId && item.role === "assistant");
    if (!message || String(message.status || "") !== "suspended") {
      return { status: "stale", ownerDraftId: "" };
    }
    const consumedBy = String(message.continuationConsumedBy || "").trim();
    if (consumedBy) return { status: "consumed", ownerDraftId: consumedBy };
    const existing = String(message.continuationClaimedBy || "").trim();
    if (!existing) return { status: "available", ownerDraftId: "" };
    const owner = list.find((item) => item && item.id === existing && item.role === "assistant");
    if (!owner) return { status: "reclaimable", ownerDraftId: existing };
    const ownerStatus = String(owner.status || (owner.pending ? "running" : "")).trim();
    if (owner.pending || ownerStatus === "running" || ownerStatus === "pending") {
      return { status: "active", ownerDraftId: existing };
    }
    if (["completed", "suspended", "blocked"].includes(ownerStatus)) {
      return { status: "consumed", ownerDraftId: existing };
    }
    return { status: "reclaimable", ownerDraftId: existing };
  }

  claimContinuation(sessionId, messageId, draftId, continuationRunId = "") {
    const list = this.state().messagesBySession[sessionId] || [];
    const message = list.find((item) => item && item.id === messageId && item.role === "assistant");
    const claim = String(draftId || "").trim();
    if (!message || !claim || String(message.status || "") !== "suspended") {
      return { status: "stale", ownerDraftId: "" };
    }
    const expectedRunId = String(continuationRunId || "").trim();
    if (expectedRunId) {
      try {
        const events = message.execution && message.execution.version === 1
          ? message.execution.events
          : null;
        const state = Array.isArray(events) ? reduceExecutionEvents(events) : null;
        const run = state && state.runs ? state.runs[expectedRunId] : null;
        if (!run || run.status !== "suspended") {
          return { status: "stale", ownerDraftId: "", runId: expectedRunId };
        }
      } catch (_error) {
        return { status: "stale", ownerDraftId: "", runId: expectedRunId };
      }
    }
    const existing = String(message.continuationClaimedBy || "").trim();
    if (existing === claim) return { status: "claimed", ownerDraftId: claim, reclaimed: false };
    const current = this.getContinuationClaimState(sessionId, messageId);
    if (current.status === "active" || current.status === "consumed") return current;
    message.continuationClaimedBy = claim;
    delete message.continuationConsumedBy;
    return { status: "claimed", ownerDraftId: claim, reclaimed: Boolean(existing) };
  }

  releaseContinuation(sessionId, messageId, draftId) {
    const list = this.state().messagesBySession[sessionId] || [];
    const message = list.find((item) => item && item.id === messageId && item.role === "assistant");
    const claim = String(draftId || "").trim();
    if (!message || !claim || String(message.continuationClaimedBy || "") !== claim) return false;
    message.continuationClaimedBy = "";
    delete message.continuationConsumedBy;
    return true;
  }

  recoverInterruptedExecutions(time = Date.now()) {
    let recoveredCount = 0;
    const st = this.state();
    for (const messages of Object.values(st.messagesBySession || {})) {
      for (const message of Array.isArray(messages) ? messages : []) {
        const events = message && message.execution && message.execution.events;
        if (!Array.isArray(events) || !events.length) {
          if (message && message.role === "assistant" && message.pending) {
            message.status = "interrupted";
            message.pending = false;
            recoveredCount += 1;
          }
          continue;
        }
        try {
          const state = reduceExecutionEvents(events);
          const hasOpenRun = Object.values(state.runs).some((run) => !run.terminal);
          if (!hasOpenRun) continue;
          const recovered = recoverInterruptedRun(events, {
            time: Math.max(Number(time) || 0, state.lastTime),
          });
          message.execution = { version: 1, events: recovered.events };
          message.status = "interrupted";
          message.pending = false;
          recoveredCount += 1;
        } catch (error) {
          message.status = "failed";
          message.pending = false;
          message.executionError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    return recoveredCount;
  }

  getActiveMessages() {
    const st = this.state();
    return st.messagesBySession[st.activeSessionId] || [];
  }

  getSessionMessages(sessionId) {
    const st = this.state();
    return st.messagesBySession[String(sessionId || "")] || [];
  }
}


module.exports = { SessionStore };
