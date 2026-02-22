const { InlineAskUserQuestionPanel } = require("../../inline-ask-user-question-panel");

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

function findActiveQuestionInteraction(messages) {
  const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
  if (!activeSessionId || !(this.pendingQuestionRequests instanceof Map)) return null;

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
  return null;
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
        this.setRuntimeStatus("已取消提问回答", "info");
        return;
      }
      void this.submitInlineQuestionResult(interaction, result);
    },
    this.currentAbort ? this.currentAbort.signal : undefined,
    {
      title: "FLOWnote has a question",
      showCustomInput: true,
      immediateSelect: interaction.questions.length === 1 && Array.isArray(interaction.questions[0].options) && interaction.questions[0].options.length > 0,
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
  findActiveQuestionInteraction,
  renderInlineQuestionPanel,
  prefillComposerInput,
  hasVisibleQuestionToolCard,
};

module.exports = { inlinePanelMethods };
