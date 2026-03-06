const { InlineAskUserQuestionPanel } = require("../../inline-ask-user-question-panel");
const { tFromContext } = require("../../i18n-runtime");

function clearInlineQuestionWidget(silent = true) {
  if (this.inlineQuestionWidget && typeof this.inlineQuestionWidget.destroy === "function") {
    this.inlineQuestionWidget.destroy(silent);
  }
  this.inlineQuestionWidget = null;
  this.inlineQuestionKey = "";
  if (this.elements.inlineQuestionHost) {
    this.elements.inlineQuestionHost.removeClass("is-active");
    this.elements.inlineQuestionHost.empty();
  }
  if (this.elements.composer) {
    this.elements.composer.removeClass("is-inline-hidden");
  }
}

function formatInlineQuestionPayload(questions, result) {
  const list = Array.isArray(questions) ? questions : [];
  const answerMap = result && typeof result === "object" ? result : {};
  const lines = [];
  for (const question of list) {
    if (!question || typeof question !== "object") continue;
    const qText = typeof question.question === "string" ? question.question.trim() : "";
    if (!qText) continue;
    const answer = typeof answerMap[qText] === "string" ? answerMap[qText].trim() : "";
    if (!answer) continue;
    if (list.length === 1) lines.push(answer);
    else lines.push(`${qText}: ${answer}`);
  }

  if (!lines.length) {
    for (const raw of Object.values(answerMap)) {
      const answer = typeof raw === "string" ? raw.trim() : "";
      if (answer) lines.push(answer);
    }
  }
  return lines.join("\n");
}

async function submitInlineQuestionResult(interaction, result) {
  if (!interaction || !interaction.key) return;
  const state = interaction.state || this.getQuestionAnswerState(interaction.key, interaction.questions.length);
  if (state.submitted || state.sending) return;

  const payload = this.formatInlineQuestionPayload(interaction.questions, result);
  if (!String(payload || "").trim()) return;
  const questionAnswers = this.buildQuestionAnswerArrays(interaction.questions, result, state);

  await this.submitQuestionAnswers(interaction.key, interaction.questions, state, payload, {
    sessionId: interaction.sessionId,
    requestId: interaction.requestId || "",
    questionAnswers,
    message: interaction.message || null,
    block: interaction.block || null,
  });
}

function extractQuestionRequestIdFromBlock(block) {
  const source = block && typeof block === "object" ? block : {};
  const raw = source.raw && typeof source.raw === "object" ? source.raw : {};
  const state = raw.state && typeof raw.state === "object" ? raw.state : {};
  const request = state.request && typeof state.request === "object" ? state.request : {};

  const candidates = [
    source.requestID,
    source.requestId,
    raw.requestID,
    raw.requestId,
    raw.id,
    state.requestID,
    state.requestId,
    request.id,
    request.requestID,
    request.requestId,
  ];

  for (const value of candidates) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function findQuestionInteractionFromLatestAssistantBlock(messages, activeSessionId) {
  const list = Array.isArray(messages) ? messages : [];
  const hasActiveRequest = Boolean(this.currentAbort && this.currentAbort.signal && !this.currentAbort.signal.aborted);
  const now = Date.now();

  for (let messageIndex = list.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = list[messageIndex];
    if (!message || message.role !== "assistant") continue;
    const messageCreatedAt = Number(message.createdAt || 0);
    const isRecent = messageCreatedAt > 0 ? now - messageCreatedAt <= 3 * 60 * 1000 : false;
    if (!message.pending && !hasActiveRequest && !isRecent) break;

    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (!block || typeof block !== "object") continue;
      if (String(block.type || "").trim().toLowerCase() !== "tool") continue;
      if (String(block.tool || "").trim().toLowerCase() !== "question") continue;

      const status = String(block.status || "").trim().toLowerCase();
      if (status === "error") continue;
      const questions = this.extractQuestionItemsFromBlock(block);
      if (!questions.length) continue;

      const requestId = this.extractQuestionRequestIdFromBlock(block);
      const fallbackKey = `${activeSessionId}::question-block::${String(message.id || messageIndex)}::${String(block.id || blockIndex)}`;
      const key = requestId
        ? this.getQuestionRequestInteractionKey(activeSessionId, requestId)
        : fallbackKey;
      const state = this.getQuestionAnswerState(key, questions.length);
      if (state.submitted || state.sending) continue;

      return {
        key,
        sessionId: activeSessionId,
        message,
        block,
        questions,
        state,
        requestId,
      };
    }
  }
  return null;
}

function findActiveQuestionInteraction(messages) {
  const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
  if (!activeSessionId) return null;

  if (!(this.pendingQuestionRequests instanceof Map)) {
    return this.findQuestionInteractionFromLatestAssistantBlock(messages, activeSessionId);
  }

  const pending = [];
  for (const request of this.pendingQuestionRequests.values()) {
    if (!request || request.sessionId !== activeSessionId) continue;
    pending.push(request);
  }
  if (!pending.length) return null;

  pending.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  for (const request of pending) {
    const questions = Array.isArray(request.questions) && request.questions.length
      ? request.questions
      : this.buildFallbackQuestionItemsFromRequest(request);
    if (!questions.length) continue;
    const key = this.getQuestionRequestInteractionKey(activeSessionId, request.id);
    if (!key) continue;
    const state = this.getQuestionAnswerState(key, questions.length);
    if (state.submitted) continue;
    return {
      key,
      sessionId: activeSessionId,
      message: null,
      block: null,
      questions,
      state,
      requestId: request.id,
    };
  }

  const fallback = this.findQuestionInteractionFromLatestAssistantBlock(messages, activeSessionId);
  if (
    fallback
    && typeof this.refreshPendingQuestionRequests === "function"
    && Date.now() - Number(this.pendingQuestionFallbackRefreshAt || 0) >= 300
  ) {
    this.pendingQuestionFallbackRefreshAt = Date.now();
    void this.refreshPendingQuestionRequests({
      minIntervalMs: 300,
      silent: true,
    }).catch(() => {});
  }
  return fallback;
}

function renderInlineQuestionPanel(messages) {
  if (!this.elements.inlineQuestionHost || !this.elements.composer) return;
  if (this.inlineQuestionWidget && this.inlineQuestionWidget.rootEl && !this.inlineQuestionWidget.rootEl.isConnected) {
    this.inlineQuestionWidget = null;
    this.inlineQuestionKey = "";
  }
  const interaction = this.findActiveQuestionInteraction(messages);
  if (!interaction) {
    this.clearInlineQuestionWidget(true);
    return;
  }

  this.elements.composer.addClass("is-inline-hidden");
  this.elements.inlineQuestionHost.addClass("is-active");
  if (this.inlineQuestionWidget && this.inlineQuestionKey === interaction.key) {
    return;
  }

  this.clearInlineQuestionWidget(true);
  this.inlineQuestionKey = interaction.key;
  this.inlineQuestionWidget = new InlineAskUserQuestionPanel(
    this.elements.inlineQuestionHost,
    { questions: interaction.questions },
    (result) => {
      if (!result) {
        this.clearInlineQuestionWidget(true);
        this.setRuntimeStatus(tFromContext(this, "view.question.canceled", "Question response canceled"), "info");
        return;
      }
      void this.submitInlineQuestionResult(interaction, result);
    },
    this.currentAbort ? this.currentAbort.signal : undefined,
    {
      title: tFromContext(this, "view.question.title", "FLOWnote has a question"),
      showCustomInput: true,
      immediateSelect: interaction.questions.length === 1
        && Array.isArray(interaction.questions[0].options)
        && interaction.questions[0].options.length > 0
        && !Boolean(interaction.questions[0].multiSelect),
    },
  );
  this.inlineQuestionWidget.render();
}

function prefillComposerInput(text, options = {}) {
  const inputEl = this.elements.input;
  if (!inputEl) return;
  const content = String(text || "").trim();
  if (!content) return;
  const current = String(inputEl.value || "");
  inputEl.value = current && !current.endsWith("\n") ? `${current}\n${content}` : `${current}${content}`;
  inputEl.focus();
  if (options.sendNow) {
    void this.handleSend();
  }
}

function hasVisibleQuestionToolCard() {
  const messages = this.plugin.sessionStore.getActiveMessages();
  return Boolean(this.findActiveQuestionInteraction(messages));
}


const inlinePanelMethods = {
  clearInlineQuestionWidget,
  formatInlineQuestionPayload,
  submitInlineQuestionResult,
  extractQuestionRequestIdFromBlock,
  findQuestionInteractionFromLatestAssistantBlock,
  findActiveQuestionInteraction,
  renderInlineQuestionPanel,
  prefillComposerInput,
  hasVisibleQuestionToolCard,
};

module.exports = { inlinePanelMethods };
