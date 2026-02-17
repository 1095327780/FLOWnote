class SessionStore {
  constructor(plugin) {
    this.plugin = plugin;
  }

  getState() {
    if (!this.plugin.runtimeState) {
      this.plugin.runtimeState = {
        sessions: [],
        activeSessionId: "",
        messagesBySession: {},
      };
    }
    return this.plugin.runtimeState;
  }

  setState(nextState) {
    this.plugin.runtimeState = nextState;
  }

  upsertSession(session) {
    const state = this.getState();
    const idx = state.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      state.sessions[idx] = Object.assign({}, state.sessions[idx], session);
    } else {
      state.sessions.unshift(session);
    }

    state.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  removeSession(sessionId) {
    const state = this.getState();
    state.sessions = state.sessions.filter((s) => s.id !== sessionId);
    delete state.messagesBySession[sessionId];

    if (state.activeSessionId === sessionId) {
      state.activeSessionId = state.sessions.length ? state.sessions[0].id : "";
    }
  }

  setActiveSession(sessionId) {
    const state = this.getState();
    state.activeSessionId = sessionId;
  }

  appendMessage(sessionId, message) {
    const state = this.getState();
    const list = state.messagesBySession[sessionId] || [];
    list.push(message);
    state.messagesBySession[sessionId] = list.slice(-200);

    const session = state.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.updatedAt = Date.now();
      if (message.role === "user") {
        session.lastUserPrompt = message.text;
      }
    }
  }

  updateAssistantDraft(sessionId, draftId, text) {
    const state = this.getState();
    const list = state.messagesBySession[sessionId] || [];
    const target = list.find((item) => item.id === draftId);
    if (target) {
      target.text = text;
    }
  }

  finalizeAssistantDraft(sessionId, draftId, text, error) {
    const state = this.getState();
    const list = state.messagesBySession[sessionId] || [];
    const target = list.find((item) => item.id === draftId);
    if (target) {
      target.text = text;
      target.error = error || "";
      target.pending = false;
    }
  }

  getActiveSession() {
    const state = this.getState();
    return state.sessions.find((s) => s.id === state.activeSessionId) || null;
  }

  getActiveMessages() {
    const state = this.getState();
    const id = state.activeSessionId;
    return state.messagesBySession[id] || [];
  }

  serialize() {
    return this.getState();
  }
}

module.exports = {
  SessionStore,
};
