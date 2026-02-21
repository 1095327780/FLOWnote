const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadRunSendPromptWithMockObsidian() {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Notice: class NoticeMock {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("../../runtime/chat/chat-orchestrator");
  delete require.cache[modulePath];
  const { runSendPrompt } = require(modulePath);

  return {
    runSendPrompt,
    restore() {
      Module._load = originalLoad;
      delete require.cache[modulePath];
    },
  };
}

function createSessionStore(runtimeState) {
  return {
    state() {
      return runtimeState;
    },
    setActiveSession(sessionId) {
      runtimeState.activeSessionId = sessionId;
    },
    appendMessage(sessionId, message) {
      if (!runtimeState.messagesBySession[sessionId]) runtimeState.messagesBySession[sessionId] = [];
      runtimeState.messagesBySession[sessionId].push(message);
    },
    updateAssistantDraft(sessionId, draftId, text, reasoning, meta, blocks) {
      const target = (runtimeState.messagesBySession[sessionId] || []).find((row) => row.id === draftId);
      if (!target) return;
      if (typeof text === "string") target.text = text;
      if (typeof reasoning === "string") target.reasoning = reasoning;
      if (typeof meta === "string") target.meta = meta;
      if (Array.isArray(blocks)) target.blocks = blocks;
    },
    finalizeAssistantDraft(sessionId, draftId, payload, error) {
      const target = (runtimeState.messagesBySession[sessionId] || []).find((row) => row.id === draftId);
      if (!target) return;
      if (payload && typeof payload === "object") {
        target.text = String(payload.text || "");
        target.reasoning = String(payload.reasoning || "");
        target.meta = String(payload.meta || "");
        target.blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
      } else {
        target.text = String(payload || "");
      }
      target.error = String(error || "");
      target.pending = false;
    },
    getActiveMessages() {
      return runtimeState.messagesBySession[runtimeState.activeSessionId] || [];
    },
  };
}

test("runSendPrompt should orchestrate draft lifecycle and finalize assistant response", async () => {
  const fixture = loadRunSendPromptWithMockObsidian();
  const runtimeState = {
    sessions: [{ id: "s1", title: "新会话", updatedAt: 0 }],
    activeSessionId: "s1",
    messagesBySession: { s1: [] },
  };

  const sessionStore = createSessionStore(runtimeState);
  let persisted = 0;

  const view = {
    plugin: {
      sessionStore,
      settings: { skillInjectMode: "summary", defaultModel: "" },
      skillService: {
        buildInjectedPrompt(_skill, _mode, promptText) {
          return String(promptText || "");
        },
      },
      opencodeClient: {
        async sendMessage(options) {
          if (typeof options.onToken === "function") options.onToken("partial");
          return { text: "final", reasoning: "", meta: "", blocks: [] };
        },
      },
      async createSession() {
        throw new Error("createSession should not be called when active session exists");
      },
      async persistState() {
        persisted += 1;
      },
      markModelUnavailable() {
        return { hidden: false };
      },
      async saveSettings() {},
    },
    root: { querySelector() { return null; } },
    elements: { messages: null },
    selectedModel: "",
    autoScrollEnabled: true,
    silentAbortBudget: 0,
    currentAbort: null,

    parseModelSlashCommand() { return null; },
    parseSkillSelectorSlashCommand() { return null; },
    resolveSkillFromPrompt() { return { skill: null, promptText: "hello" }; },

    render() {},
    renderMessages() {},
    renderSidebar() {},
    scheduleScrollMessagesToBottom() {},
    setForceBottomWindow() {},
    setBusy() {},
    setRuntimeStatus() {},

    findMessageRow() { return null; },
    hasReasoningBlock() { return false; },
    renderAssistantBlocks() {},
    removeStandaloneReasoningContainer() {},
    reorderAssistantMessageLayout() {},
    renderInlineQuestionPanel() {},
    showPermissionRequestModal: async () => "reject",
    upsertPendingQuestionRequest() { return null; },
    removePendingQuestionRequest() {},
    hasVisibleQuestionToolCard() { return false; },
    showPromptAppendModal() {},
    handleToastEvent() {},
    isAbortLikeError() { return false; },
  };

  try {
    await fixture.runSendPrompt(view, "hello");

    const messages = runtimeState.messagesBySession.s1;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].text, "final");
    assert.equal(messages[1].pending, false);
    assert.equal(persisted, 1);
  } finally {
    fixture.restore();
  }
});
