const { Notice } = require("obsidian");

function createMessageId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function mountPendingDraft(view, sessionId, userText, hideUserMessage) {
  const userMessage = { id: createMessageId("msg"), role: "user", text: userText, createdAt: Date.now() };
  const draftId = createMessageId("msg");
  const draft = {
    id: draftId,
    role: "assistant",
    text: "",
    reasoning: "",
    meta: "",
    blocks: [],
    createdAt: Date.now(),
    pending: true,
    error: "",
  };

  if (!hideUserMessage) {
    view.plugin.sessionStore.appendMessage(sessionId, userMessage);
  }
  view.plugin.sessionStore.appendMessage(sessionId, draft);

  if (typeof view.setForceBottomWindow === "function") {
    view.setForceBottomWindow(12000);
  }
  view.autoScrollEnabled = true;
  view.renderMessages({ forceBottom: true });
  view.renderSidebar(view.root.querySelector(".oc-side"));
  view.scheduleScrollMessagesToBottom(true);

  return { draftId };
}

function renderDraftBlocks(view, draftId) {
  const messages = view.elements.messages;
  if (!messages) return;

  const target = view.findMessageRow(draftId);
  if (!target) return;

  const currentDraft = view.plugin
    .sessionStore
    .getActiveMessages()
    .find((msg) => msg && msg.id === draftId);
  if (!currentDraft) return;

  view.renderAssistantBlocks(target, currentDraft);
  view.removeStandaloneReasoningContainer(target);
  view.reorderAssistantMessageLayout(target);
}

function createTransportHandlers(view, sessionId, draftId) {
  return {
    onToken: (partial) => {
      view.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, partial);
      if (String(partial || "").trim()) {
        view.setRuntimeStatus("正在生成回复…", "working");
      }

      const messages = view.elements.messages;
      if (!messages) return;
      const target = view.findMessageRow(draftId);
      if (target) {
        const body = target.querySelector(".oc-message-content");
        if (body) body.textContent = partial;
      }
      view.scheduleScrollMessagesToBottom();
    },

    onReasoning: (partialReasoning) => {
      view.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, partialReasoning);
      if (String(partialReasoning || "").trim()) {
        view.setRuntimeStatus("模型思考中…", "working");
      }

      const messages = view.elements.messages;
      if (!messages) return;
      const target = view.findMessageRow(draftId);
      if (!target) return;

      const currentDraft = view.plugin
        .sessionStore
        .getActiveMessages()
        .find((msg) => msg && msg.id === draftId);
      const hasReasoningBlocks = view.hasReasoningBlock(currentDraft && currentDraft.blocks);
      if (hasReasoningBlocks && currentDraft) {
        renderDraftBlocks(view, draftId);
      } else {
        const reasoningBody = view.ensureReasoningContainer(target, true);
        if (reasoningBody) reasoningBody.textContent = partialReasoning || "...";
      }
      view.scheduleScrollMessagesToBottom();
    },

    onBlocks: (blocks) => {
      view.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, undefined, undefined, blocks);
      const runtimeStatus = view.runtimeStatusFromBlocks(blocks);
      if (runtimeStatus && runtimeStatus.text) {
        view.setRuntimeStatus(runtimeStatus.text, runtimeStatus.tone);
      }

      renderDraftBlocks(view, draftId);
      view.renderInlineQuestionPanel(view.plugin.sessionStore.getActiveMessages());
      view.scheduleScrollMessagesToBottom();
    },

    onPermissionRequest: async (permission) => {
      view.setRuntimeStatus("等待权限确认…", "info");
      const decision = await view.showPermissionRequestModal(permission || {});
      if (!decision) return "reject";
      if (decision === "always" || decision === "once" || decision === "reject") {
        return decision;
      }
      return "reject";
    },

    onQuestionRequest: (questionRequest) => {
      const request = view.upsertPendingQuestionRequest(questionRequest || {});
      if (!request) return;
      if (view.plugin && typeof view.plugin.log === "function") {
        view.plugin.log(`question requested ${JSON.stringify({
          id: request.id,
          sessionId: request.sessionId,
          count: Array.isArray(request.questions) ? request.questions.length : 0,
        })}`);
      }
      view.setRuntimeStatus("请在下方问题面板中回答。", "info");
      view.renderInlineQuestionPanel(view.plugin.sessionStore.getActiveMessages());
    },

    onQuestionResolved: (info) => {
      const sessionIdFromEvent = String((info && info.sessionId) || "").trim();
      const requestIdFromEvent = String((info && info.requestId) || "").trim();
      if (requestIdFromEvent) {
        view.removePendingQuestionRequest(sessionIdFromEvent || sessionId, requestIdFromEvent);
      }
      view.renderInlineQuestionPanel(view.plugin.sessionStore.getActiveMessages());
    },

    onPromptAppend: (appendText) => {
      view.setRuntimeStatus("等待补充输入…", "info");
      if (view.hasVisibleQuestionToolCard()) {
        view.setRuntimeStatus("请在下方问题面板中回答并提交。", "info");
        return;
      }
      view.showPromptAppendModal(appendText);
    },

    onToast: (toast) => {
      view.handleToastEvent(toast || {});
    },
  };
}

function finalizeAssistantDraft(view, sessionId, draftId, response) {
  view.plugin.sessionStore.finalizeAssistantDraft(
    sessionId,
    draftId,
    {
      text: response.text || "",
      reasoning: response.reasoning || "",
      meta: response.meta || "",
      blocks: Array.isArray(response.blocks) ? response.blocks : [],
    },
    /error|failed|失败|status=\d{3}/i.test(String(response.meta || "")) ? String(response.meta || "") : "",
  );
}

async function handlePromptFailure(view, sessionId, draftId, error) {
  const msg = error instanceof Error ? error.message : String(error);
  const isSilentAbort = view.silentAbortBudget > 0 && view.isAbortLikeError(msg);

  if (isSilentAbort) {
    view.silentAbortBudget = Math.max(0, Number(view.silentAbortBudget || 0) - 1);
    const existing = (view.plugin.sessionStore.state().messagesBySession[sessionId] || []).find((x) => x && x.id === draftId);
    view.plugin.sessionStore.finalizeAssistantDraft(
      sessionId,
      draftId,
      {
        text: existing && typeof existing.text === "string" ? existing.text : "",
        reasoning: existing && typeof existing.reasoning === "string" ? existing.reasoning : "",
        meta: existing && typeof existing.meta === "string" ? existing.meta : "",
        blocks: existing && Array.isArray(existing.blocks) ? existing.blocks : [],
      },
      "",
    );
    view.setRuntimeStatus("等待问题回答…", "info");
    return { shouldRerenderModelPicker: false };
  }

  let shouldRerenderModelPicker = false;
  const activeModel = String(view.selectedModel || view.plugin.settings.defaultModel || "").trim();
  if (activeModel && view.plugin && typeof view.plugin.markModelUnavailable === "function") {
    const tracked = view.plugin.markModelUnavailable(activeModel, msg);
    if (tracked && tracked.hidden) {
      shouldRerenderModelPicker = true;
      if (String(view.plugin.settings.defaultModel || "").trim() === activeModel) {
        view.selectedModel = "";
        view.plugin.settings.defaultModel = "";
        try {
          await view.plugin.saveSettings();
        } catch {
        }
      }
      new Notice(`模型可能不可用，已从列表暂时隐藏：${activeModel}`);
    }
  }

  view.setRuntimeStatus(`请求失败：${msg}`, "error");
  view.plugin.sessionStore.finalizeAssistantDraft(sessionId, draftId, `请求失败: ${msg}`, msg);
  new Notice(msg);
  return { shouldRerenderModelPicker };
}

async function finalizePromptCycle(view, shouldRerenderModelPicker) {
  view.currentAbort = null;
  view.setBusy(false);
  await view.plugin.persistState();

  if (typeof view.setForceBottomWindow === "function") {
    view.setForceBottomWindow(6000);
  }
  view.autoScrollEnabled = true;

  if (shouldRerenderModelPicker) {
    view.render();
    return;
  }

  view.renderMessages({ forceBottom: true });
  view.renderSidebar(view.root.querySelector(".oc-side"));
  view.scheduleScrollMessagesToBottom(true);
}

async function runSendPrompt(view, userText, options = {}) {
  const requestOptions = options && typeof options === "object" ? options : {};
  const forceSessionId = typeof requestOptions.sessionId === "string" ? requestOptions.sessionId.trim() : "";
  const hideUserMessage = Boolean(requestOptions.hideUserMessage);

  const modelSlash = view.parseModelSlashCommand(userText);
  if (modelSlash) {
    await view.handleModelSlashCommand(userText, modelSlash);
    return;
  }

  const skillSelectorSlash = view.parseSkillSelectorSlashCommand(userText);
  if (skillSelectorSlash) {
    view.openSkillSelector();
    return;
  }

  const skillMatch = view.resolveSkillFromPrompt(userText);

  const st = view.plugin.sessionStore.state();
  let sessionId = forceSessionId || st.activeSessionId;
  if (forceSessionId && st.activeSessionId !== forceSessionId) {
    view.plugin.sessionStore.setActiveSession(forceSessionId);
    view.render();
  }

  if (!sessionId) {
    const session = await view.plugin.createSession("");
    sessionId = session.id;
    view.plugin.sessionStore.setActiveSession(sessionId);
    view.render();
  }

  const { draftId } = mountPendingDraft(view, sessionId, userText, hideUserMessage);

  view.currentAbort = new AbortController();
  view.setBusy(true);
  view.setRuntimeStatus("正在等待 OpenCode 响应…", "working");
  let shouldRerenderModelPicker = false;

  try {
    const prompt = view.plugin.skillService.buildInjectedPrompt(
      skillMatch.skill,
      view.plugin.settings.skillInjectMode,
      skillMatch.promptText || userText,
    );

    const response = await view.plugin.opencodeClient.sendMessage({
      sessionId,
      prompt,
      signal: view.currentAbort.signal,
      ...createTransportHandlers(view, sessionId, draftId),
    });

    finalizeAssistantDraft(view, sessionId, draftId, response);
  } catch (error) {
    const out = await handlePromptFailure(view, sessionId, draftId, error);
    shouldRerenderModelPicker = Boolean(out && out.shouldRerenderModelPicker);
  } finally {
    await finalizePromptCycle(view, shouldRerenderModelPicker);
  }
}

module.exports = {
  runSendPrompt,
};
