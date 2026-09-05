const { Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { runDirectAgentTurn } = require("./direct-agent-runner");
const { resolvePermissionRequestDecision } = require("../agent/permission-policy");
const { reduceExecutionEvents } = require("../agent/execution-ledger");

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

function getAgentMode(view) {
  const settings = view && view.plugin && view.plugin.settings;
  const agentProvider = settings && settings.agentProvider;
  return agentProvider && agentProvider.mode === "direct" ? "direct" : "opencode-legacy";
}

function isLocalSessionId(sessionId) {
  return /^local-[a-z0-9]/i.test(String(sessionId || "").trim());
}

function getSessionTitle(view, sessionId) {
  const store = view && view.plugin && view.plugin.sessionStore;
  const st = store && typeof store.state === "function" ? store.state() : null;
  const sessions = st && Array.isArray(st.sessions) ? st.sessions : [];
  const found = sessions.find((session) => session && String(session.id || "") === String(sessionId || ""));
  return String((found && found.title) || "").trim();
}

function getSessionMessages(view, sessionId) {
  const store = view && view.plugin && view.plugin.sessionStore;
  if (!store) return [];
  if (typeof store.getSessionMessages === "function") {
    const messages = store.getSessionMessages(sessionId);
    return Array.isArray(messages) ? messages : [];
  }
  const st = typeof store.state === "function" ? store.state() : null;
  const messages = st && st.messagesBySession ? st.messagesBySession[sessionId] : null;
  return Array.isArray(messages) ? messages : [];
}

function isSessionActive(view, sessionId) {
  const store = view && view.plugin && view.plugin.sessionStore;
  const st = store && typeof store.state === "function" ? store.state() : null;
  return Boolean(st && String(st.activeSessionId || "") === String(sessionId || ""));
}

async function ensureCompatibleSessionForAgentMode(view, sessionId, agentMode) {
  if (agentMode !== "opencode-legacy" || !isLocalSessionId(sessionId)) return sessionId;
  const title = getSessionTitle(view, sessionId);
  const session = await view.plugin.createSession(title || "");
  const nextSessionId = String((session && session.id) || "").trim();
  if (!nextSessionId) return sessionId;
  view.plugin.sessionStore.setActiveSession(nextSessionId);
  if (typeof view.render === "function") view.render();
  return nextSessionId;
}

function mountPendingDraft(
  view,
  sessionId,
  userText,
  hideUserMessage,
  linkedContextFiles = [],
  protectedMessageIds = [],
) {
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
    stats: null,
    createdAt: Date.now(),
    pending: true,
    error: "",
  };

  if (!hideUserMessage) {
    view.plugin.sessionStore.appendMessage(sessionId, userMessage, { protectedMessageIds });
  }
  view.plugin.sessionStore.appendMessage(sessionId, draft, { protectedMessageIds });

  if (typeof view.setForceBottomWindow === "function") view.setForceBottomWindow(0);
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

function renderDraftBlocks(view, sessionId, draftId) {
  if (!isSessionActive(view, sessionId)) return;
  const messages = view.elements.messages;
  if (!messages) return;

  const target = view.findMessageRow(draftId);
  if (!target) return;

  const currentDraft = getSessionMessages(view, sessionId)
    .find((msg) => msg && msg.id === draftId);
  if (!currentDraft) return;

  view.renderAssistantBlocks(target, currentDraft);
  view.removeStandaloneReasoningContainer(target);
  view.reorderAssistantMessageLayout(target);
}

function mutateMessageViewport(view, callback) {
  if (view && typeof view.mutateMessagesPreservingViewport === "function") {
    view.mutateMessagesPreservingViewport(callback);
    return;
  }
  callback();
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

function executionSnapshotIsTerminal(events) {
  const state = reduceExecutionEvents(events);
  return Object.values(state.runs).some((run) => Boolean(run && run.terminal));
}

function createTransportHandlers(view, sessionId, draftId, signal) {
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
  let deferredTerminalExecution = null;

  const flushToken = () => {
    const currentDraft = getSessionMessages(view, sessionId)
      .find((msg) => msg && msg.id === draftId);
    if (!currentDraft || !currentDraft.pending) return;
    const partial = String(tokenState.latest || "");
    view.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, partial);
    const refreshedDraft = getSessionMessages(view, sessionId)
      .find((msg) => msg && msg.id === draftId);
    if (!refreshedDraft || !refreshedDraft.pending) return;
    const displayedText = currentDraft && typeof currentDraft.text === "string"
      ? String((refreshedDraft && refreshedDraft.text) || "")
      : partial;

    if (!isSessionActive(view, sessionId)) return;

    if (displayedText.trim()) {
      view.setRuntimeStatus(tr(view, "view.runtime.generating", "Generating response..."), "working");
    }

    const messages = view.elements.messages;
    if (!messages) return;
    mutateMessageViewport(view, () => {
      const target = view.findMessageRow(draftId);
      if (target) {
        const body = target.querySelector(".oc-message-content");
        if (body) {
          const hasStreamTextBlocks = Array.isArray(refreshedDraft.blocks)
            && refreshedDraft.blocks.some((block) => String((block && block.type) || "").trim().toLowerCase() === "stream-text");
          if (hasStreamTextBlocks) {
            body.empty();
          } else {
            // Rich Markdown rendering is asynchronous. Re-running it for every
            // token lets fast streams overtake earlier renders and makes the
            // response appear all at once. Keep the pending node stable and
            // synchronous; terminal rendering upgrades it to Markdown once.
            body.textContent = displayedText;
          }
        }
      }
    });
    view.scheduleScrollMessagesToBottom();
  };

  const flushReasoning = () => {
    const currentDraft = getSessionMessages(view, sessionId)
      .find((msg) => msg && msg.id === draftId);
    if (!currentDraft || !currentDraft.pending) return;
    const partialReasoning = String(reasoningState.latest || "");
    view.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, partialReasoning);
    const refreshedDraft = getSessionMessages(view, sessionId)
      .find((msg) => msg && msg.id === draftId);
    if (!refreshedDraft || !refreshedDraft.pending) return;
    const displayedReasoning = currentDraft && typeof currentDraft.reasoning === "string"
      ? String((refreshedDraft && refreshedDraft.reasoning) || "")
      : partialReasoning;

    if (!isSessionActive(view, sessionId)) return;

    if (displayedReasoning.trim()) {
      view.setRuntimeStatus(tr(view, "view.runtime.reasoning", "Model is reasoning..."), "working");
    }

    const messages = view.elements.messages;
    if (!messages) return;
    const target = view.findMessageRow(draftId);
    if (!target) return;

    mutateMessageViewport(view, () => {
      const hasReasoningBlocks = view.hasReasoningBlock(refreshedDraft && refreshedDraft.blocks);
      if (hasReasoningBlocks && refreshedDraft) {
        view.removeStandaloneReasoningContainer(target);
      } else {
        const reasoningBody = view.ensureReasoningContainer(target, true);
        if (reasoningBody) reasoningBody.textContent = displayedReasoning || "...";
      }
    });
    view.scheduleScrollMessagesToBottom();
  };

  const flushBlocks = () => {
    const currentDraft = getSessionMessages(view, sessionId)
      .find((msg) => msg && msg.id === draftId);
    if (!currentDraft || !currentDraft.pending) return;
    const blocks = Array.isArray(blockState.latest) ? blockState.latest : [];
    view.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, undefined, undefined, blocks);
    if (!isSessionActive(view, sessionId)) return;
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

    mutateMessageViewport(view, () => {
      renderDraftBlocks(view, sessionId, draftId);
      view.renderInlineQuestionPanel(getSessionMessages(view, sessionId));
    });
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
      const mode = view && view.plugin && view.plugin.settings
        ? view.plugin.settings.toolPermissionMode
        : "";
      const policyDecision = resolvePermissionRequestDecision(mode, permission || {});
      if (policyDecision && policyDecision.behavior === "allow") {
        return "always";
      }
      view.setRuntimeStatus(tr(view, "view.permission.waiting", "Waiting for permission confirmation..."), "info");
      const decision = await view.showPermissionRequestModal(permission || {}, signal);
      if (!decision) return "reject";
      if (decision === "always" || decision === "once" || decision === "reject") {
        return decision;
      }
      return "reject";
    },

    onAskUser: async (payload) => {
      // Direct-mode ask_user bridge. The chat view opens an AskUserQuestionModal
      // and resolves with { answers } or { dismissed: true }.
      view.setRuntimeStatus(tr(view, "view.ask.waiting", "Waiting for your answer..."), "info");
      try {
        return await view.showAskUserModal(payload || { questions: [] }, signal);
      } finally {
        view.setRuntimeStatus(null);
      }
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
      if (!isSessionActive(view, sessionId)) return;
      view.setRuntimeStatus(tr(view, "view.question.answerInPanel", "Please answer in the panel below."), "info");
      view.renderInlineQuestionPanel(getSessionMessages(view, sessionId));
    },

    onQuestionResolved: (info) => {
      const sessionIdFromEvent = String((info && info.sessionId) || "").trim();
      const requestIdFromEvent = String((info && info.requestId) || "").trim();
      if (requestIdFromEvent) {
        view.removePendingQuestionRequest(sessionIdFromEvent || sessionId, requestIdFromEvent);
      }
      const affectedSessionId = sessionIdFromEvent || sessionId;
      if (isSessionActive(view, affectedSessionId)) {
        view.renderInlineQuestionPanel(getSessionMessages(view, affectedSessionId));
      }
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

    onExecutionSnapshot: async (events) => {
      // A terminal journal is not written into shared runtime state yet: any
      // unrelated settings/view save could otherwise persist it before the
      // runner has assembled matching text and blocks. The prompt owner folds
      // this snapshot into finalizeAssistantDraft as one memory transaction.
      if (executionSnapshotIsTerminal(events)) {
        deferredTerminalExecution = {
          version: 1,
          events: JSON.parse(JSON.stringify(events)),
        };
        return;
      }
      view.plugin.sessionStore.setAssistantExecution(sessionId, draftId, events);
      await view.plugin.persistState();
    },

    getDeferredTerminalExecution: () => (
      deferredTerminalExecution
        ? JSON.parse(JSON.stringify(deferredTerminalExecution))
        : null
    ),
  };
}

function finalizeAssistantDraft(view, sessionId, draftId, response) {
  const legacyFailed = !response.status && /error|failed|失败|status=\d{3}/i.test(String(response.meta || ""));
  const status = String(response.status || (legacyFailed ? "failed" : "completed"));
  view.plugin.sessionStore.finalizeAssistantDraft(
    sessionId,
    draftId,
    {
      messageId: response.messageId || "",
      text: response.text || "",
      reasoning: response.reasoning || "",
      meta: response.meta || "",
      blocks: Array.isArray(response.blocks) ? response.blocks : [],
      stats: response.stats || null,
      execution: response.execution || null,
      status,
    },
    status === "failed" ? String(response.meta || "Agent runtime failed.") : "",
  );
}

async function handlePromptFailure(view, sessionId, draftId, error, deferredTerminalExecution = null) {
  const msg = error instanceof Error ? error.message : String(error);
  const isUserAbort = view.isAbortLikeError(msg);
  const isSilentAbort = view.silentAbortBudget > 0 && isUserAbort;

  if (isSilentAbort || isUserAbort) {
    if (isSilentAbort) {
      view.silentAbortBudget = Math.max(0, Number(view.silentAbortBudget || 0) - 1);
    }
    const existing = (view.plugin.sessionStore.state().messagesBySession[sessionId] || []).find((x) => x && x.id === draftId);
    const execution = deferredTerminalExecution || (existing && existing.execution) || null;
    view.plugin.sessionStore.finalizeAssistantDraft(
      sessionId,
      draftId,
      {
        text: existing && typeof existing.text === "string" ? existing.text : "",
        reasoning: existing && typeof existing.reasoning === "string" ? existing.reasoning : "",
        meta: existing && typeof existing.meta === "string" ? existing.meta : "",
        blocks: existing && Array.isArray(existing.blocks) ? existing.blocks : [],
        execution,
        status: "cancelled",
      },
      "",
    );
    if (isSilentAbort) {
      view.setRuntimeStatus(tr(view, "view.question.waiting", "Waiting for question answers..."), "info");
    }
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

  const existing = (view.plugin.sessionStore.state().messagesBySession[sessionId] || [])
    .find((row) => row && row.id === draftId);
  const execution = deferredTerminalExecution || (existing && existing.execution) || null;
  const verifiedPaths = verifiedMutationPaths(execution);
  const failureCopy = verifiedPaths.length > 0
    ? tr(
        view,
        "view.request.failedPartial",
        "The workflow stopped, but {count} verified file change(s) were preserved. Check the items below before retrying.",
        { count: verifiedPaths.length },
      )
    : tr(view, "view.request.failed", "Request failed: {message}", { message: msg });
  view.setRuntimeStatus(failureCopy, "error");
  view.plugin.sessionStore.finalizeAssistantDraft(
    sessionId,
    draftId,
    {
      text: String((existing && existing.text) || failureCopy),
      reasoning: String((existing && existing.reasoning) || ""),
      meta: String((existing && existing.meta) || ""),
      blocks: existing && Array.isArray(existing.blocks) ? existing.blocks : [],
      execution,
      status: "failed",
    },
    msg,
  );
  new Notice(msg);
  return { shouldRerenderModelPicker };
}

function verifiedMutationPaths(execution) {
  const events = execution && execution.version === 1 && Array.isArray(execution.events)
    ? execution.events
    : null;
  if (!events) return [];
  try {
    const state = reduceExecutionEvents(events);
    return Array.from(new Set(Object.values(state.runs).flatMap((run) => (
      Object.values(run.tools || {}).flatMap((tool) => {
        const receipt = tool && tool.effect && tool.effect.status === "verified"
          ? tool.effect.receipt
          : null;
        if (!receipt || receipt.kind === "observation") return [];
        return Array.isArray(receipt.paths) ? receipt.paths.map(String) : [];
      })
    ))));
  } catch (_error) {
    return [];
  }
}

async function finalizePromptCycle(view, shouldRerenderModelPicker, requestAbort, sessionId, draftId) {
  const isCurrentRequest = !requestAbort || view.currentAbort === requestAbort;
  // Draft terminal state must be durable even if a newer UI request has
  // already taken ownership of the busy indicator.
  await view.plugin.persistState();
  if (!isCurrentRequest) return;
  view.currentAbort = null;
  view.setBusy(false);

  if (typeof view.setForceBottomWindow === "function") view.setForceBottomWindow(0);

  if (shouldRerenderModelPicker) {
    view.render();
    return;
  }

  const activeSession = isSessionActive(view, sessionId);
  let refreshedMessage = false;
  if (activeSession && typeof view.refreshMessageItem === "function") {
    refreshedMessage = Boolean(view.refreshMessageItem(draftId));
  }
  if (activeSession && !refreshedMessage && typeof view.renderMessages === "function") {
    view.renderMessages();
  }
  if (typeof view.refreshHistoryMenu === "function") {
    view.refreshHistoryMenu();
  }
  if (typeof view.scheduleScrollMessagesToBottom === "function") {
    view.scheduleScrollMessagesToBottom();
  }
}

async function runSendPrompt(view, userText, options = {}) {
  if (view.currentAbort) {
    new Notice(tr(view, "view.request.alreadyRunning", "A FLOWnote workflow is already running."));
    return;
  }
  const requestOptions = options && typeof options === "object" ? options : {};
  const forceSessionId = typeof requestOptions.sessionId === "string" ? requestOptions.sessionId.trim() : "";
  const hideUserMessage = Boolean(requestOptions.hideUserMessage);
  const continuationMessageId = String(requestOptions.continuationMessageId || "").trim();
  const continuationRunId = String(requestOptions.continuationRunId || "").trim();

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
  const agentMode = getAgentMode(view);
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
  sessionId = await ensureCompatibleSessionForAgentMode(view, sessionId, agentMode);

  const linkedContextFiles = collectUserLinkedContextFiles(view, hideUserMessage);
  const protectedMessageIds = continuationMessageId ? [continuationMessageId] : [];
  const { draftId } = mountPendingDraft(
    view,
    sessionId,
    userText,
    hideUserMessage,
    linkedContextFiles,
    protectedMessageIds,
  );
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

  const requestAbort = new AbortController();
  view.currentAbort = requestAbort;
  view.setBusy(true);
  view.setRuntimeStatus(tr(view, "view.runtime.waitingResponse", "Waiting for FLOWnote response..."), "working");
  let shouldRerenderModelPicker = false;
  let handlers = null;

  try {
    const matchedSkillCommand = skillMatch && typeof skillMatch.command === "string"
      ? String(skillMatch.command).trim()
      : "";
    const skillForTurn = skillMatch && skillMatch.skill ? skillMatch.skill : null;
    const skillIdentity = String(
      skillForTurn && (skillForTurn.id || skillForTurn.slug || skillForTurn.name) || "",
    ).replace(/^\/+/, "").trim();
    const skillCommand = matchedSkillCommand || (skillIdentity ? `/${skillIdentity}` : "");
    const directPreloadedSkill = agentMode === "direct" && skillForTurn
      ? {
          skill: String(
            skillForTurn.name
            || skillForTurn.id
            || skillForTurn.slug
            || skillCommand
            || "",
          ).replace(/^\/+/, "").trim(),
          args: resolveExplicitSlashArguments(userText, skillCommand, skillMatch.promptText),
          command: skillCommand,
          completionPolicy: skillForTurn.completionPolicy && typeof skillForTurn.completionPolicy === "object"
            ? skillForTurn.completionPolicy
            : undefined,
        }
      : null;
    const useNativeSkillCommand = Boolean(skillForTurn && skillCommand && agentMode !== "direct");
    let prompt = "";
    if (useNativeSkillCommand) {
      let commandArgs = String(skillMatch.promptText || "").trim();
      if (typeof view.composePromptWithLinkedFiles === "function") {
        commandArgs = await view.composePromptWithLinkedFiles(commandArgs, { linkedPaths: linkedContextFiles });
      }
      prompt = commandArgs ? `${skillCommand} ${commandArgs}` : skillCommand;
    } else {
      const rawPrompt = String(skillMatch && skillMatch.promptText ? skillMatch.promptText : userText);
      const skillService = view.plugin && view.plugin.skillService;
      const skillForInject = skillForTurn;
      // skillService is null on mobile (legacy fs-backed loader is desktop
      // only). When it's missing OR there's no matched skill, just send
      // the raw user prompt — the agent-side SkillRegistry handles skill
      // discovery via vault.adapter during the turn.
      if (
        !directPreloadedSkill
        && skillService
        && typeof skillService.buildInjectedPrompt === "function"
        && skillForInject
      ) {
        // Skill injection is always full-content. (The old "summary /
        // full / off" knob has been retired — summary mode tended to
        // produce incomplete results and "off" defeats the purpose.)
        prompt = skillService.buildInjectedPrompt(
          skillForInject,
          "full",
          rawPrompt,
        );
      } else {
        prompt = rawPrompt;
      }
      if (typeof view.composePromptWithLinkedFiles === "function") {
        prompt = await view.composePromptWithLinkedFiles(prompt, { linkedPaths: linkedContextFiles });
      }
    }

    handlers = createTransportHandlers(view, sessionId, draftId, requestAbort.signal);

    let response;
    if (agentMode === "direct") {
      // The persisted diagnostic trace contains counts only: linked note
      // paths and prompt content belong to the user's private vault.
      if (typeof view.plugin.traceDiagnostic === "function") {
        const linkedCount = Array.isArray(linkedContextFiles) ? linkedContextFiles.length : 0;
        void view.plugin.traceDiagnostic("agent.prompt_prepared", {
          linkedFileCount: linkedCount,
          hasLinkedFiles: linkedCount > 0,
          promptLength: String(prompt || "").length,
        });
      }
      response = await runDirectAgentTurn({
        view,
        sessionId,
        draftId,
        userText: prompt,
        intentText: String(userText || ""),
        continuationMessageId,
        continuationRunId,
        preloadedSkillCommand: directPreloadedSkill,
        handlers,
        signal: requestAbort.signal,
      });
    } else {
      response = await view.plugin.opencodeClient.sendMessage({
        sessionId,
        prompt,
        signal: requestAbort.signal,
        ...handlers,
      });
    }

    const deferredTerminalExecution = handlers && typeof handlers.getDeferredTerminalExecution === "function"
      ? handlers.getDeferredTerminalExecution()
      : null;
    if (deferredTerminalExecution && !(response && response.execution)) {
      response = { ...(response || {}), execution: deferredTerminalExecution };
    }
    finalizeAssistantDraft(view, sessionId, draftId, response);
  } catch (error) {
    const deferredTerminalExecution = handlers && typeof handlers.getDeferredTerminalExecution === "function"
      ? handlers.getDeferredTerminalExecution()
      : null;
    const out = await handlePromptFailure(view, sessionId, draftId, error, deferredTerminalExecution);
    shouldRerenderModelPicker = Boolean(out && out.shouldRerenderModelPicker);
  } finally {
    await finalizePromptCycle(view, shouldRerenderModelPicker, requestAbort, sessionId, draftId);
  }
}

function resolveExplicitSlashArguments(userText, command, fallback) {
  const input = String(userText || "").trim();
  const normalizedCommand = String(command || "").trim();
  if (normalizedCommand) {
    const lowerInput = input.toLowerCase();
    const lowerCommand = normalizedCommand.toLowerCase();
    if (lowerInput === lowerCommand) return "";
    if (lowerInput.startsWith(`${lowerCommand} `)) {
      return input.slice(normalizedCommand.length).trim();
    }
  }
  return String(fallback || "").trim();
}

module.exports = {
  runSendPrompt,
};
