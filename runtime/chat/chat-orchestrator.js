const { Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");

function tr(view, key, fallback, params = {}) {
  return tFromContext(view, key, fallback, params);
}

function createMessageId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function collectUserLinkedContextFiles(view, hideUserMessage) {
  if (hideUserMessage || !view || typeof view.getLinkedContextFilePaths !== "function") return [];
  const rawPaths = view.getLinkedContextFilePaths();
  if (!Array.isArray(rawPaths) || !rawPaths.length) return [];
  const seen = new Set();
  const normalized = [];
  rawPaths.forEach((rawPath) => {
    const next = String(rawPath || "").trim().replace(/^\/+/, "");
    if (!next || seen.has(next)) return;
    seen.add(next);
    normalized.push(next);
  });
  return normalized;
}

function mountPendingDraft(view, sessionId, userText, hideUserMessage, linkedContextFiles = []) {
  const userMessage = { id: createMessageId("msg"), role: "user", text: userText, createdAt: Date.now() };
  if (Array.isArray(linkedContextFiles) && linkedContextFiles.length) {
    userMessage.linkedContextFiles = linkedContextFiles.slice();
  }
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
  if (typeof view.renderMessages === "function") {
    view.renderMessages({ forceBottom: true });
  }
  if (typeof view.refreshHistoryMenu === "function") {
    view.refreshHistoryMenu();
  }
  if (typeof view.scheduleScrollMessagesToBottom === "function") {
    view.scheduleScrollMessagesToBottom(true);
  }

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

function isQuestionToolBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (String(block.type || "").trim().toLowerCase() !== "tool") return false;
  const toolName = String(block.tool || "").trim().toLowerCase();
  if (toolName === "question") return true;
  const raw = block.raw && typeof block.raw === "object" ? block.raw : {};
  const candidate =
    String(raw.tool || "").trim().toLowerCase()
    || String(raw.name || "").trim().toLowerCase()
    || String(raw.type || "").trim().toLowerCase();
  return candidate === "question";
}

function hasQuestionToolBlock(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  return list.some((block) => isQuestionToolBlock(block));
}

function createTransportHandlers(view, sessionId, draftId) {
  const queueFrame = (flush, state) => {
    if (!state || typeof state !== "object") return;
    if (state.scheduled) return;
    if (typeof requestAnimationFrame === "function") {
      state.scheduled = requestAnimationFrame(() => {
        state.scheduled = 0;
        flush();
      });
      return;
    }
    flush();
  };

  const tokenState = { latest: "", scheduled: 0 };
  const reasoningState = { latest: "", scheduled: 0 };
  const blockState = { latest: [], scheduled: 0 };
  const questionRefreshState = { lastAt: 0 };

  const flushToken = () => {
    const currentDraft = view.plugin
      .sessionStore
      .getActiveMessages()
      .find((msg) => msg && msg.id === draftId);
    if (!currentDraft || !currentDraft.pending) return;
    const partial = String(tokenState.latest || "");
    view.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, partial);
    const refreshedDraft = view.plugin
      .sessionStore
      .getActiveMessages()
      .find((msg) => msg && msg.id === draftId);
    if (!refreshedDraft || !refreshedDraft.pending) return;
    const displayedText = currentDraft && typeof currentDraft.text === "string"
      ? String((refreshedDraft && refreshedDraft.text) || "")
      : partial;

    if (displayedText.trim()) {
      view.setRuntimeStatus(tr(view, "view.runtime.generating", "Generating response..."), "working");
    }

    const messages = view.elements.messages;
    if (!messages) return;
    const target = view.findMessageRow(draftId);
    if (target) {
      const body = target.querySelector(".oc-message-content");
      if (body) {
        const hasStreamTextBlocks = Array.isArray(refreshedDraft.blocks)
          && refreshedDraft.blocks.some((block) => String((block && block.type) || "").trim().toLowerCase() === "stream-text");
        if (hasStreamTextBlocks) {
          body.empty();
        } else if (displayedText.trim() && typeof view.renderMarkdownSafely === "function") {
          view.renderMarkdownSafely(body, displayedText, () => {
            if (typeof view.enhanceCodeBlocks === "function") view.enhanceCodeBlocks(body);
          });
        } else {
          body.textContent = displayedText;
        }
      }
    }
    view.scheduleScrollMessagesToBottom();
  };

  const flushReasoning = () => {
    const currentDraft = view.plugin
      .sessionStore
      .getActiveMessages()
      .find((msg) => msg && msg.id === draftId);
    if (!currentDraft || !currentDraft.pending) return;
    const partialReasoning = String(reasoningState.latest || "");
    view.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, partialReasoning);
    const refreshedDraft = view.plugin
      .sessionStore
      .getActiveMessages()
      .find((msg) => msg && msg.id === draftId);
    if (!refreshedDraft || !refreshedDraft.pending) return;
    const displayedReasoning = currentDraft && typeof currentDraft.reasoning === "string"
      ? String((refreshedDraft && refreshedDraft.reasoning) || "")
      : partialReasoning;

    if (displayedReasoning.trim()) {
      view.setRuntimeStatus(tr(view, "view.runtime.reasoning", "Model is reasoning..."), "working");
    }

    const messages = view.elements.messages;
    if (!messages) return;
    const target = view.findMessageRow(draftId);
    if (!target) return;

    const hasReasoningBlocks = view.hasReasoningBlock(refreshedDraft && refreshedDraft.blocks);
    if (hasReasoningBlocks && refreshedDraft) {
      view.removeStandaloneReasoningContainer(target);
    } else {
      const reasoningBody = view.ensureReasoningContainer(target, true);
      if (reasoningBody) reasoningBody.textContent = displayedReasoning || "...";
    }
    view.scheduleScrollMessagesToBottom();
  };

  const flushBlocks = () => {
    const currentDraft = view.plugin
      .sessionStore
      .getActiveMessages()
      .find((msg) => msg && msg.id === draftId);
    if (!currentDraft || !currentDraft.pending) return;
    const blocks = Array.isArray(blockState.latest) ? blockState.latest : [];
    view.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, undefined, undefined, blocks);
    const runtimeStatus = view.runtimeStatusFromBlocks(blocks);
    if (runtimeStatus && runtimeStatus.text) {
      view.setRuntimeStatus(runtimeStatus.text, runtimeStatus.tone);
    }

    if (
      hasQuestionToolBlock(blocks)
      && typeof view.refreshPendingQuestionRequests === "function"
      && Date.now() - Number(questionRefreshState.lastAt || 0) >= 300
    ) {
      questionRefreshState.lastAt = Date.now();
      void view.refreshPendingQuestionRequests({
        minIntervalMs: 300,
        silent: true,
      }).catch(() => {});
    }

    renderDraftBlocks(view, draftId);
    view.renderInlineQuestionPanel(view.plugin.sessionStore.getActiveMessages());
    view.scheduleScrollMessagesToBottom();
  };

  return {
    onToken: (partial) => {
      tokenState.latest = String(partial || "");
      queueFrame(flushToken, tokenState);
    },

    onReasoning: (partialReasoning) => {
      reasoningState.latest = String(partialReasoning || "");
      queueFrame(flushReasoning, reasoningState);
    },

    onBlocks: (blocks) => {
      blockState.latest = Array.isArray(blocks) ? blocks : [];
      queueFrame(flushBlocks, blockState);
    },

    onPermissionRequest: async (permission) => {
      view.setRuntimeStatus(tr(view, "view.permission.waiting", "Waiting for permission confirmation..."), "info");
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
      view.setRuntimeStatus(tr(view, "view.question.answerInPanel", "Please answer in the panel below."), "info");
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
      view.setRuntimeStatus(tr(view, "view.promptAppend.waiting", "Waiting for additional input..."), "info");
      if (view.hasVisibleQuestionToolCard()) {
        view.setRuntimeStatus(tr(view, "view.question.answerAndSubmit", "Please answer and submit in the panel below."), "info");
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
      messageId: response.messageId || "",
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
    view.setRuntimeStatus(tr(view, "view.question.waiting", "Waiting for question answers..."), "info");
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
      new Notice(tr(view, "view.model.hiddenUnavailable", "Model may be unavailable and has been hidden: {model}", { model: activeModel }));
    }
  }

  view.setRuntimeStatus(tr(view, "view.request.failed", "Request failed: {message}", { message: msg }), "error");
  view.plugin.sessionStore.finalizeAssistantDraft(
    sessionId,
    draftId,
    tr(view, "view.request.failed", "Request failed: {message}", { message: msg }),
    msg,
  );
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

  if (typeof view.renderMessages === "function") {
    view.renderMessages({ forceBottom: true });
  }
  if (typeof view.refreshHistoryMenu === "function") {
    view.refreshHistoryMenu();
  }
  if (typeof view.scheduleScrollMessagesToBottom === "function") {
    view.scheduleScrollMessagesToBottom(true);
  }
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

  const linkedContextFiles = collectUserLinkedContextFiles(view, hideUserMessage);
  const { draftId } = mountPendingDraft(view, sessionId, userText, hideUserMessage, linkedContextFiles);
  if (!hideUserMessage) {
    if (typeof view.clearLinkedContextFiles === "function") {
      view.clearLinkedContextFiles({ closePicker: true });
    } else if (Array.isArray(view.linkedContextFiles)) {
      view.linkedContextFiles = [];
      if (typeof view.refreshLinkedContextIndicators === "function") {
        view.refreshLinkedContextIndicators();
      }
    }
  }

  view.currentAbort = new AbortController();
  view.setBusy(true);
  view.setRuntimeStatus(tr(view, "view.runtime.waitingResponse", "Waiting for FLOWnote response..."), "working");
  let shouldRerenderModelPicker = false;

  try {
    const skillCommand = skillMatch && typeof skillMatch.command === "string"
      ? String(skillMatch.command).trim()
      : "";
    const useNativeSkillCommand = Boolean(skillMatch && skillMatch.skill && skillCommand);
    let prompt = "";
    if (useNativeSkillCommand) {
      let commandArgs = String(skillMatch.promptText || "").trim();
      if (typeof view.composePromptWithLinkedFiles === "function") {
        commandArgs = await view.composePromptWithLinkedFiles(commandArgs, { linkedPaths: linkedContextFiles });
      }
      prompt = commandArgs ? `${skillCommand} ${commandArgs}` : skillCommand;
    } else {
      prompt = view.plugin.skillService.buildInjectedPrompt(
        skillMatch.skill,
        view.plugin.settings.skillInjectMode,
        skillMatch.promptText || userText,
      );
      if (typeof view.composePromptWithLinkedFiles === "function") {
        prompt = await view.composePromptWithLinkedFiles(prompt, { linkedPaths: linkedContextFiles });
      }
    }

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
