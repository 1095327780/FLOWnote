const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadRunSendPromptWithMockObsidian(options = {}) {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Notice: class NoticeMock {},
      };
    }
    if (
      typeof options.runDirectAgentTurn === "function"
      && (request === "./direct-agent-runner" || String(request).endsWith("/direct-agent-runner"))
    ) {
      return {
        runDirectAgentTurn: options.runDirectAgentTurn,
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
        target.execution = payload.execution || null;
        target.status = String(payload.status || (error ? "failed" : "completed"));
      } else {
        target.text = String(payload || "");
      }
      target.error = String(error || "");
      target.pending = false;
    },
    setAssistantExecution(sessionId, draftId, events) {
      const target = (runtimeState.messagesBySession[sessionId] || []).find((row) => row.id === draftId);
      if (!target) return false;
      target.execution = { version: 1, events: JSON.parse(JSON.stringify(events)) };
      const terminal = [...events].reverse().find((event) => /^run_(completed|failed|blocked|cancelled|suspended|interrupted)$/.test(String(event && event.type || "")));
      target.status = terminal ? String(terminal.type).slice(4) : "running";
      target.pending = !terminal;
      return true;
    },
    getActiveMessages() {
      return runtimeState.messagesBySession[runtimeState.activeSessionId] || [];
    },
    getSessionMessages(sessionId) {
      return runtimeState.messagesBySession[sessionId] || [];
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
  let sentPrompt = "";
  let composeLinkedPaths = [];
  let clearLinkedContextCalled = 0;
  const forceBottomDurations = [];
  const renderMessageOptions = [];
  const refreshedMessageIds = [];

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
          sentPrompt = String(options && options.prompt ? options.prompt : "");
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
    linkedContextFiles: ["Project/alpha.md", "Work/todo.md"],

    parseModelSlashCommand() { return null; },
    parseSkillSelectorSlashCommand() { return null; },
    resolveSkillFromPrompt() { return { skill: null, promptText: "hello" }; },
    getLinkedContextFilePaths() { return this.linkedContextFiles.slice(); },
    clearLinkedContextFiles() {
      clearLinkedContextCalled += 1;
      this.linkedContextFiles = [];
    },
    composePromptWithLinkedFiles(prompt, options = {}) {
      composeLinkedPaths = Array.isArray(options.linkedPaths) ? options.linkedPaths.slice() : [];
      return `${prompt}\n\n[linked=${composeLinkedPaths.join(",")}]`;
    },

    render() {},
    renderMessages(options) { renderMessageOptions.push(options || {}); },
    refreshMessageItem(messageId) {
      refreshedMessageIds.push(String(messageId || ""));
      return true;
    },
    renderSidebar() {},
    scheduleScrollMessagesToBottom() {},
    setForceBottomWindow(durationMs) { forceBottomDurations.push(durationMs); },
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
    assert.deepEqual(messages[0].linkedContextFiles, ["Project/alpha.md", "Work/todo.md"]);
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].text, "final");
    assert.equal(messages[1].pending, false);
    assert.deepEqual(composeLinkedPaths, ["Project/alpha.md", "Work/todo.md"]);
    assert.match(sentPrompt, /\[linked=Project\/alpha\.md,Work\/todo\.md\]/);
    assert.equal(clearLinkedContextCalled, 1);
    assert.deepEqual(view.linkedContextFiles, []);
    assert.equal(persisted, 1);
    assert.equal(forceBottomDurations.some((duration) => Number(duration) > 0), false);
    assert.equal(renderMessageOptions.length, 1, "completion should not rebuild the entire transcript");
    assert.equal(renderMessageOptions[0].forceBottom, true);
    assert.deepEqual(refreshedMessageIds, [messages[1].id]);
  } finally {
    fixture.restore();
  }
});

test("runSendPrompt should keep explicit skill command for native command routing", async () => {
  const fixture = loadRunSendPromptWithMockObsidian();
  const runtimeState = {
    sessions: [{ id: "s1", title: "新会话", updatedAt: 0 }],
    activeSessionId: "s1",
    messagesBySession: { s1: [] },
  };

  const sessionStore = createSessionStore(runtimeState);
  let sentPrompt = "";
  let buildInjectedPromptCalled = 0;

  const view = {
    plugin: {
      sessionStore,
      settings: { skillInjectMode: "summary", defaultModel: "" },
      skillService: {
        buildInjectedPrompt() {
          buildInjectedPromptCalled += 1;
          return "legacy-injected";
        },
      },
      opencodeClient: {
        async sendMessage(options) {
          sentPrompt = String(options && options.prompt ? options.prompt : "");
          return { text: "done", reasoning: "", meta: "", blocks: [] };
        },
      },
      async createSession() {
        throw new Error("createSession should not be called when active session exists");
      },
      async persistState() {},
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
    linkedContextFiles: ["Project/alpha.md"],

    parseModelSlashCommand() { return null; },
    parseSkillSelectorSlashCommand() { return null; },
    resolveSkillFromPrompt() {
      return {
        skill: { id: "ah-init", name: "ah-init" },
        promptText: "请按技能执行当前任务",
        command: "/ah-init",
      };
    },
    getLinkedContextFilePaths() { return this.linkedContextFiles.slice(); },
    clearLinkedContextFiles() {
      this.linkedContextFiles = [];
    },
    composePromptWithLinkedFiles(prompt, options = {}) {
      const linkedPaths = Array.isArray(options.linkedPaths) ? options.linkedPaths.slice() : [];
      return `${prompt}\n\n[linked=${linkedPaths.join(",")}]`;
    },

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
    await fixture.runSendPrompt(view, "/ah-init");

    assert.equal(buildInjectedPromptCalled, 0);
    assert.match(sentPrompt, /^\/ah-init\b/);
    assert.match(sentPrompt, /请按技能执行当前任务/);
    assert.match(sentPrompt, /\[linked=Project\/alpha\.md\]/);
  } finally {
    fixture.restore();
  }
});

test("runSendPrompt should preserve empty slash-skill arguments in direct mode", async () => {
  const runtimeState = {
    sessions: [{ id: "s1", title: "新会话", updatedAt: 0 }],
    activeSessionId: "s1",
    messagesBySession: { s1: [] },
  };

  let captured = null;
  const fixture = loadRunSendPromptWithMockObsidian({
    async runDirectAgentTurn(options) {
      captured = options;
      return { text: "done", reasoning: "", meta: "", blocks: [] };
    },
  });
  const sessionStore = createSessionStore(runtimeState);
  const appendOptions = [];
  const originalAppendMessage = sessionStore.appendMessage.bind(sessionStore);
  sessionStore.appendMessage = (sessionId, message, options) => {
    appendOptions.push(options);
    originalAppendMessage(sessionId, message);
  };

  const view = {
    plugin: {
      sessionStore,
      settings: { agentProvider: { mode: "direct" }, defaultModel: "" },
      skillService: {
        buildInjectedPrompt() {
          throw new Error("direct explicit slash skills should be preloaded by the runner");
        },
      },
      async createSession() {
        throw new Error("createSession should not be called when active session exists");
      },
      async persistState() {},
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
    linkedContextFiles: [],

    parseModelSlashCommand() { return null; },
    parseSkillSelectorSlashCommand() { return null; },
    resolveSkillFromPrompt() {
      return {
        skill: {
          slug: "ah-card",
          name: "ah-card",
          completionPolicy: {
            state: "declared",
            mode: "effect",
            requiredEffects: [],
            requiredInteractions: ["ask_user"],
            minReceipts: null,
            errorCode: null,
          },
        },
        promptText: "请使用 skill ah-card 完成这个任务。",
        command: "",
      };
    },
    getLinkedContextFilePaths() { return []; },
    clearLinkedContextFiles() {},
    composePromptWithLinkedFiles(prompt) {
      return String(prompt || "");
    },

    render() {},
    renderMessages() {},
    renderSidebar() {},
    refreshHistoryMenu() {},
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
    await fixture.runSendPrompt(view, "/ah-card", {
      continuationMessageId: "assistant-paused",
      continuationRunId: "run-paused",
    });

    assert.ok(captured, "direct runner should be called");
    assert.equal(captured.userText, "请使用 skill ah-card 完成这个任务。");
    assert.equal(captured.intentText, "/ah-card");
    assert.deepEqual(captured.preloadedSkillCommand, {
      skill: "ah-card",
      args: "",
      command: "/ah-card",
      completionPolicy: {
        state: "declared",
        mode: "effect",
        requiredEffects: [],
        requiredInteractions: ["ask_user"],
        minReceipts: null,
        errorCode: null,
      },
    });
    assert.equal(captured.continuationMessageId, "assistant-paused");
    assert.equal(captured.continuationRunId, "run-paused");
    assert.deepEqual(appendOptions, [
      { protectedMessageIds: ["assistant-paused"] },
      { protectedMessageIds: ["assistant-paused"] },
    ]);
  } finally {
    fixture.restore();
  }
});

test("runSendPrompt persists a terminal execution only together with final text and blocks", async () => {
  const runtimeState = {
    sessions: [{ id: "s1", title: "new chat", updatedAt: 0 }],
    activeSessionId: "s1",
    messagesBySession: { s1: [] },
  };
  const executionEvents = [
    { seq: 0, time: 1, type: "run_started", runId: "draft" },
    { seq: 1, time: 2, type: "tool_started", runId: "draft", toolUseId: "read-1", tool: "vault_read" },
    { seq: 2, time: 3, type: "tool_finished", runId: "draft", toolUseId: "read-1", isError: false },
    { seq: 3, time: 4, type: "run_completed", runId: "draft" },
  ];
  const persisted = [];
  const fixture = loadRunSendPromptWithMockObsidian({
    async runDirectAgentTurn(options) {
      await options.handlers.onExecutionSnapshot(executionEvents.slice(0, 3));
      await options.handlers.onExecutionSnapshot(executionEvents);
      // Simulate an unrelated settings/view save landing after the terminal
      // event but before the runner has assembled its final response.
      await options.view.plugin.persistState();
      return {
        text: "final answer",
        reasoning: "",
        meta: "",
        blocks: [{ type: "tool", tool: "vault_read", status: "done" }],
        status: "completed",
        execution: { version: 1, events: executionEvents },
      };
    },
  });
  const sessionStore = createSessionStore(runtimeState);
  const view = {
    plugin: {
      sessionStore,
      settings: { agentProvider: { mode: "direct" }, defaultModel: "" },
      skillService: null,
      async createSession() { throw new Error("unexpected createSession"); },
      async persistState() {
        persisted.push(JSON.parse(JSON.stringify(runtimeState.messagesBySession.s1)));
      },
      markModelUnavailable() { return { hidden: false }; },
      async saveSettings() {},
    },
    root: { querySelector() { return null; } },
    elements: { messages: null },
    selectedModel: "",
    autoScrollEnabled: true,
    silentAbortBudget: 0,
    currentAbort: null,
    linkedContextFiles: [],
    parseModelSlashCommand() { return null; },
    parseSkillSelectorSlashCommand() { return null; },
    resolveSkillFromPrompt() { return { skill: null, promptText: "hello" }; },
    getLinkedContextFilePaths() { return []; },
    clearLinkedContextFiles() {},
    composePromptWithLinkedFiles(prompt) { return String(prompt || ""); },
    render() {}, renderMessages() {}, refreshHistoryMenu() {}, scheduleScrollMessagesToBottom() {},
    setForceBottomWindow() {}, setBusy() {}, setRuntimeStatus() {}, findMessageRow() { return null; },
    hasReasoningBlock() { return false; }, renderAssistantBlocks() {}, removeStandaloneReasoningContainer() {},
    reorderAssistantMessageLayout() {}, renderInlineQuestionPanel() {}, showPermissionRequestModal: async () => "reject",
    upsertPendingQuestionRequest() { return null; }, removePendingQuestionRequest() {}, hasVisibleQuestionToolCard() { return false; },
    showPromptAppendModal() {}, handleToastEvent() {}, isAbortLikeError() { return false; },
  };

  try {
    await fixture.runSendPrompt(view, "hello");
    const terminalSnapshots = persisted
      .map((messages) => messages.find((message) => message.role === "assistant"))
      .filter((message) => message && message.status === "completed");
    assert.ok(terminalSnapshots.length > 0);
    assert.ok(terminalSnapshots.every((message) => message.text === "final answer"));
    assert.ok(terminalSnapshots.every((message) => message.blocks.length === 1));
    assert.equal(persisted.at(-1).find((message) => message.role === "assistant").pending, false);
  } finally {
    fixture.restore();
  }
});

test("runSendPrompt atomically finalizes a deferred failed journal when the runner throws", async () => {
  const runtimeState = {
    sessions: [{ id: "s1", title: "new chat", updatedAt: 0 }],
    activeSessionId: "s1",
    messagesBySession: { s1: [] },
  };
  const failedEvents = [
    { seq: 0, time: 1, type: "run_started", runId: "draft" },
    { seq: 1, time: 2, type: "run_failed", runId: "draft", code: "PROVIDER_FAILURE" },
  ];
  const persisted = [];
  const fixture = loadRunSendPromptWithMockObsidian({
    async runDirectAgentTurn(options) {
      await options.handlers.onExecutionSnapshot(failedEvents.slice(0, 1));
      await options.handlers.onExecutionSnapshot(failedEvents);
      await options.view.plugin.persistState();
      throw new Error("provider disconnected");
    },
  });
  const sessionStore = createSessionStore(runtimeState);
  const view = {
    plugin: {
      sessionStore,
      settings: { agentProvider: { mode: "direct" }, defaultModel: "" },
      skillService: null,
      async createSession() { throw new Error("unexpected createSession"); },
      async persistState() { persisted.push(JSON.parse(JSON.stringify(runtimeState.messagesBySession.s1))); },
      markModelUnavailable() { return { hidden: false }; },
      async saveSettings() {},
    },
    root: { querySelector() { return null; } }, elements: { messages: null }, selectedModel: "",
    autoScrollEnabled: true, silentAbortBudget: 0, currentAbort: null, linkedContextFiles: [],
    parseModelSlashCommand() { return null; }, parseSkillSelectorSlashCommand() { return null; },
    resolveSkillFromPrompt() { return { skill: null, promptText: "hello" }; },
    getLinkedContextFilePaths() { return []; }, clearLinkedContextFiles() {},
    composePromptWithLinkedFiles(prompt) { return String(prompt || ""); },
    render() {}, renderMessages() {}, refreshHistoryMenu() {}, scheduleScrollMessagesToBottom() {},
    setForceBottomWindow() {}, setBusy() {}, setRuntimeStatus() {}, findMessageRow() { return null; },
    hasReasoningBlock() { return false; }, renderAssistantBlocks() {}, removeStandaloneReasoningContainer() {},
    reorderAssistantMessageLayout() {}, renderInlineQuestionPanel() {}, showPermissionRequestModal: async () => "reject",
    upsertPendingQuestionRequest() { return null; }, removePendingQuestionRequest() {}, hasVisibleQuestionToolCard() { return false; },
    showPromptAppendModal() {}, handleToastEvent() {}, isAbortLikeError() { return false; },
  };

  try {
    await fixture.runSendPrompt(view, "hello");
    const assistantSnapshots = persisted
      .map((messages) => messages.find((message) => message.role === "assistant"))
      .filter(Boolean);
    const failedSnapshots = assistantSnapshots.filter((message) => message.status === "failed");
    assert.ok(assistantSnapshots.some((message) => message.status === "running"));
    assert.ok(failedSnapshots.length > 0);
    assert.ok(failedSnapshots.every((message) => /provider disconnected/.test(message.text)));
    assert.ok(failedSnapshots.every((message) => message.execution.events.at(-1).type === "run_failed"));
  } finally {
    fixture.restore();
  }
});

test("runSendPrompt should create an OpenCode session when legacy mode is active on a local session", async () => {
  const fixture = loadRunSendPromptWithMockObsidian();
  const runtimeState = {
    sessions: [{ id: "local-existing", title: "本地会话", updatedAt: 0 }],
    activeSessionId: "local-existing",
    messagesBySession: { "local-existing": [] },
  };

  const sessionStore = createSessionStore(runtimeState);
  let sentSessionId = "";
  let createdTitle = "";

  const view = {
    plugin: {
      sessionStore,
      settings: { agentProvider: { mode: "opencode-legacy" }, defaultModel: "" },
      skillService: null,
      opencodeClient: {
        async sendMessage(options) {
          sentSessionId = String(options && options.sessionId ? options.sessionId : "");
          return { text: "legacy final", reasoning: "", meta: "", blocks: [] };
        },
      },
      async createSession(title) {
        createdTitle = String(title || "");
        const session = { id: "remote-1", title: createdTitle || "新会话", updatedAt: 1 };
        runtimeState.sessions.unshift(session);
        runtimeState.messagesBySession[session.id] = [];
        return session;
      },
      async persistState() {},
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
    linkedContextFiles: [],

    parseModelSlashCommand() { return null; },
    parseSkillSelectorSlashCommand() { return null; },
    resolveSkillFromPrompt() { return { skill: null, promptText: "hello" }; },
    getLinkedContextFilePaths() { return []; },
    clearLinkedContextFiles() {},

    render() {},
    renderMessages() {},
    renderSidebar() {},
    refreshHistoryMenu() {},
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

    assert.equal(createdTitle, "本地会话");
    assert.equal(runtimeState.activeSessionId, "remote-1");
    assert.equal(sentSessionId, "remote-1");
    assert.equal(runtimeState.messagesBySession["local-existing"].length, 0);
    assert.equal(runtimeState.messagesBySession["remote-1"].length, 2);
    assert.equal(runtimeState.messagesBySession["remote-1"][1].text, "legacy final");
  } finally {
    fixture.restore();
  }
});

test("stream handlers stay bound to their request session after the user switches chats", async () => {
  const runtimeState = {
    sessions: [{ id: "s1", title: "First" }, { id: "s2", title: "Second" }],
    activeSessionId: "s1",
    messagesBySession: { s1: [], s2: [] },
  };
  const sessionStore = createSessionStore(runtimeState);
  let streamedDraft = null;
  let backgroundPanelRenders = 0;
  let backgroundBlockStatusReads = 0;

  const fixture = loadRunSendPromptWithMockObsidian();
  const view = {
    plugin: {
      sessionStore,
      settings: { defaultModel: "" },
      skillService: null,
      opencodeClient: {
        async sendMessage(options) {
          runtimeState.activeSessionId = "s2";
          options.onToken("partial in first chat");
          options.onReasoning("reasoning in first chat");
          options.onBlocks([{ type: "stream-text", text: "partial in first chat" }]);
          const currentDraft = runtimeState.messagesBySession.s1.find((message) => message.role === "assistant");
          streamedDraft = currentDraft
            ? {
                text: currentDraft.text,
                reasoning: currentDraft.reasoning,
                blocks: Array.isArray(currentDraft.blocks) ? currentDraft.blocks.slice() : [],
              }
            : null;
          return { text: "final in first chat", reasoning: "", meta: "", blocks: [] };
        },
      },
      async createSession() { throw new Error("unexpected createSession"); },
      async persistState() {},
      markModelUnavailable() { return { hidden: false }; },
      async saveSettings() {},
    },
    root: { querySelector() { return null; } },
    elements: { messages: null },
    selectedModel: "",
    autoScrollEnabled: true,
    silentAbortBudget: 0,
    currentAbort: null,
    linkedContextFiles: [],
    parseModelSlashCommand() { return null; },
    parseSkillSelectorSlashCommand() { return null; },
    resolveSkillFromPrompt() { return { skill: null, promptText: "hello" }; },
    getLinkedContextFilePaths() { return []; },
    clearLinkedContextFiles() {},
    render() {},
    renderMessages() {},
    refreshHistoryMenu() {},
    scheduleScrollMessagesToBottom() {},
    setForceBottomWindow() {},
    setBusy() {},
    setRuntimeStatus() {},
    findMessageRow() { return null; },
    hasReasoningBlock() { return false; },
    renderAssistantBlocks() {},
    removeStandaloneReasoningContainer() {},
    reorderAssistantMessageLayout() {},
    renderInlineQuestionPanel() { backgroundPanelRenders += 1; },
    runtimeStatusFromBlocks() {
      backgroundBlockStatusReads += 1;
      return { text: "background", tone: "working" };
    },
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

    assert.ok(streamedDraft);
    assert.equal(streamedDraft.text, "partial in first chat");
    assert.equal(streamedDraft.reasoning, "reasoning in first chat");
    assert.deepEqual(streamedDraft.blocks, [{ type: "stream-text", text: "partial in first chat" }]);
    assert.deepEqual(runtimeState.messagesBySession.s2, []);
    assert.equal(backgroundPanelRenders, 0, "a background request must not redraw the newly active chat");
    assert.equal(backgroundBlockStatusReads, 0, "a background request must not replace the active chat status");
  } finally {
    fixture.restore();
  }
});
