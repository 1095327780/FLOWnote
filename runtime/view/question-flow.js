const { InlineAskUserQuestionPanel } = require("../inline-ask-user-question-panel");
const {
  buildQuestionAnswerArrays: buildQuestionAnswerArraysRuntime,
  findPendingQuestionRequest: findPendingQuestionRequestRuntime,
  getQuestionRequestInteractionKey: getQuestionRequestInteractionKeyRuntime,
  normalizeQuestionRequest: normalizeQuestionRequestRuntime,
  questionRequestMapKey: questionRequestMapKeyRuntime,
  questionTextSignature: questionTextSignatureRuntime,
  removePendingQuestionRequest: removePendingQuestionRequestRuntime,
  tokenizeQuestionAnswer: tokenizeQuestionAnswerRuntime,
  upsertPendingQuestionRequest: upsertPendingQuestionRequestRuntime,
} = require("../question-runtime");

function parseMaybeJsonObject(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function splitQuestionOptionString(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const byLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (byLines.length > 1) return byLines;
  if (text.includes(" / ")) {
    return text
      .split(" / ")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (text.includes("、")) {
    return text
      .split("、")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [text];
}

function normalizeQuestionOption(raw) {
  if (raw && typeof raw === "object") {
    const obj = raw;
    const label =
      (typeof obj.label === "string" && obj.label.trim()) ||
      (typeof obj.value === "string" && obj.value.trim()) ||
      (typeof obj.text === "string" && obj.text.trim()) ||
      (typeof obj.name === "string" && obj.name.trim()) ||
      "";
    const description =
      (typeof obj.description === "string" && obj.description.trim()) ||
      (typeof obj.desc === "string" && obj.desc.trim()) ||
      (typeof obj.hint === "string" && obj.hint.trim()) ||
      "";
    if (!label) return null;
    return { label, description };
  }
  const label = String(raw || "").trim();
  if (!label) return null;
  return { label, description: "" };
}

function parseQuestionOptions(rawOptions) {
  const collected = [];
  const pushOption = (value) => {
    const normalized = this.normalizeQuestionOption(value);
    if (normalized) collected.push(normalized);
  };

  if (Array.isArray(rawOptions)) {
    rawOptions.forEach((value) => pushOption(value));
  } else if (rawOptions && typeof rawOptions === "object") {
    const obj = rawOptions;
    if (Array.isArray(obj.options)) {
      obj.options.forEach((value) => pushOption(value));
    } else if (Array.isArray(obj.choices)) {
      obj.choices.forEach((value) => pushOption(value));
    } else if (Array.isArray(obj.items)) {
      obj.items.forEach((value) => pushOption(value));
    } else {
      Object.entries(obj).forEach(([key, value]) => {
        if (typeof value === "string" && value.trim()) {
          pushOption({ label: key, description: value.trim() });
          return;
        }
        if (value === true || value === false || typeof value === "number") {
          pushOption({ label: key, description: String(value) });
          return;
        }
        pushOption(value);
      });
    }
  } else if (typeof rawOptions === "string") {
    this.splitQuestionOptionString(rawOptions).forEach((value) => pushOption(value));
  }

  const deduped = [];
  const seen = new Set();
  for (const option of collected) {
    const label = String(option.label || "").trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    deduped.push({
      label,
      description: String(option.description || "").trim(),
    });
  }
  return deduped;
}

function normalizeQuestionItem(rawItem, index) {
  const obj = rawItem && typeof rawItem === "object"
    ? rawItem
    : { question: String(rawItem || "") };

  const question =
    (typeof obj.question === "string" && obj.question.trim()) ||
    (typeof obj.prompt === "string" && obj.prompt.trim()) ||
    (typeof obj.ask === "string" && obj.ask.trim()) ||
    (typeof obj.query === "string" && obj.query.trim()) ||
    (typeof obj.content === "string" && obj.content.trim()) ||
    (typeof obj.text === "string" && obj.text.trim()) ||
    (typeof obj.title === "string" && obj.title.trim()) ||
    (typeof obj.name === "string" && obj.name.trim()) ||
    "";
  if (!question) return null;

  const options = this.parseQuestionOptions(
    obj.options !== undefined
      ? obj.options
      : obj.choices !== undefined
        ? obj.choices
        : obj.items !== undefined
          ? obj.items
          : obj.answers !== undefined
            ? obj.answers
            : obj.selections !== undefined
              ? obj.selections
              : obj.values !== undefined
                ? obj.values
                : obj.select_options !== undefined
                  ? obj.select_options
                  : obj.selectOptions !== undefined
                    ? obj.selectOptions
                    : obj.candidates,
  );

  return {
    question,
    header: (typeof obj.header === "string" && obj.header.trim()) || `Q${index + 1}`,
    options,
    multiSelect: Boolean(obj.multiSelect || obj.multiple || obj.allowMultiple),
  };
}

function normalizeQuestionInput(rawInput) {
  const parsedFromString = this.parseMaybeJsonObject(rawInput);
  const input = parsedFromString || rawInput;

  let rawQuestions = [];
  if (Array.isArray(input)) {
    rawQuestions = input;
  } else if (input && typeof input === "object") {
    if (Array.isArray(input.questions)) {
      rawQuestions = input.questions;
    } else if (typeof input.questions === "string") {
      const parsedQuestions = this.parseMaybeJsonObject(input.questions);
      if (Array.isArray(parsedQuestions)) rawQuestions = parsedQuestions;
    } else if (input.questions && typeof input.questions === "object") {
      rawQuestions = Object.values(input.questions);
    } else if (typeof input.question === "string" || typeof input.prompt === "string" || typeof input.text === "string") {
      rawQuestions = [input];
    }
  }

  const normalized = [];
  const seenQuestion = new Set();
  for (let i = 0; i < rawQuestions.length; i += 1) {
    const item = this.normalizeQuestionItem(rawQuestions[i], i);
    if (!item) continue;
    const qKey = String(item.question || "").trim();
    if (!qKey || seenQuestion.has(qKey)) continue;
    seenQuestion.add(qKey);
    normalized.push(item);
  }
  return normalized;
}

function parseQuestionsFromDetailText(detailText) {
  const text = String(detailText || "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const questions = [];
  let current = null;

  const pushCurrent = () => {
    if (!current || !String(current.question || "").trim()) return;
    current.options = this.parseQuestionOptions(current.options);
    questions.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    if (line.startsWith("问题:")) {
      pushCurrent();
      current = {
        question: line.replace(/^问题:\s*/, "").trim(),
        header: `Q${questions.length + 1}`,
        options: [],
        multiSelect: false,
      };
      continue;
    }
    if (line.startsWith("选项:")) {
      if (!current) continue;
      const optionText = line.replace(/^选项:\s*/, "").trim();
      current.options = this.splitQuestionOptionString(optionText);
    }
  }
  pushCurrent();

  return questions.filter((item) => item && String(item.question || "").trim());
}

function extractQuestionItemsFromBlock(block) {
  if (!block || typeof block !== "object") return [];
  const sources = [];
  if (block.toolInput !== undefined) sources.push(block.toolInput);
  if (block.raw && block.raw.state && block.raw.state.input !== undefined) sources.push(block.raw.state.input);
  if (block.raw && block.raw.input !== undefined) sources.push(block.raw.input);

  for (const source of sources) {
    const normalized = this.normalizeQuestionInput(source);
    if (normalized.length) return normalized;
  }
  if (typeof block.detail === "string" && block.detail.trim()) {
    const fromDetail = this.parseQuestionsFromDetailText(block.detail);
    if (fromDetail.length) return fromDetail;
  }
  return [];
}

function questionTextSignature(questions) {
  return questionTextSignatureRuntime(questions);
}

function questionRequestMapKey(sessionId, requestId) {
  return questionRequestMapKeyRuntime(sessionId, requestId);
}

function getQuestionRequestInteractionKey(sessionId, requestId) {
  return getQuestionRequestInteractionKeyRuntime(sessionId, requestId);
}

function normalizeQuestionRequest(raw) {
  return normalizeQuestionRequestRuntime(raw, (input) => this.normalizeQuestionInput(input));
}

function upsertPendingQuestionRequest(raw) {
  return upsertPendingQuestionRequestRuntime(
    this.pendingQuestionRequests,
    raw,
    (input) => this.normalizeQuestionInput(input),
  );
}

function removePendingQuestionRequest(sessionId, requestId) {
  removePendingQuestionRequestRuntime(this.pendingQuestionRequests, sessionId, requestId);
}

function findPendingQuestionRequest(interaction) {
  return findPendingQuestionRequestRuntime(this.pendingQuestionRequests, interaction);
}

function getQuestionInteractionKey(message, block, messageIndex = -1, blockIndex = -1) {
  const sessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim() || "active-session";
  const messageId = String(
    (message && (message.id || message.messageId || message.messageID || message.createdAt)) ||
    (messageIndex >= 0 ? `m${messageIndex}` : ""),
  ).trim();
  const blockId = String(
    (block && (block.id || (block.raw && block.raw.id) || (block.raw && block.raw.partID))) ||
    (blockIndex >= 0 ? `b${blockIndex}` : `question:${String((block && block.tool) || "question")}`),
  ).trim();
  if (!messageId || !blockId) return "";
  return `${sessionId}::${messageId}::${blockId}`;
}

function getQuestionAnswerState(key, totalQuestions) {
  const total = Math.max(1, Number(totalQuestions) || 1);
  if (!key) return { total, answers: {}, submitted: false, sending: false };
  const existing = this.questionAnswerStates.get(key);
  if (existing && Number(existing.total) === total) {
    return existing;
  }
  const next = { total, answers: {}, submitted: false, sending: false };
  this.questionAnswerStates.set(key, next);
  return next;
}

function buildQuestionAnswerPayload(questions, state) {
  const list = Array.isArray(questions) ? questions : [];
  const answers = state && state.answers ? state.answers : {};
  const lines = [];
  for (let index = 0; index < list.length; index += 1) {
    const question = list[index] && typeof list[index] === "object" ? list[index] : {};
    const answer = answers[index];
    if (!answer || typeof answer.value !== "string" || !answer.value.trim()) continue;
    const qid =
      (typeof question.id === "string" && question.id.trim()) ||
      `question_${index + 1}`;
    const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
    const content = custom ? `${answer.value.trim()} | ${custom}` : answer.value.trim();
    lines.push(`${qid}: ${content}`);
  }
  return lines.join("\n");
}

function tokenizeQuestionAnswer(rawAnswer) {
  return tokenizeQuestionAnswerRuntime(rawAnswer);
}

function buildQuestionAnswerArrays(questions, result, state) {
  return buildQuestionAnswerArraysRuntime(questions, result, state);
}

function pruneQuestionAnswerStates(messages) {
  if (!(this.questionAnswerStates instanceof Map) || !this.questionAnswerStates.size) return;
  const activeMessages = Array.isArray(messages) ? messages : [];
  const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
  const keepKeys = new Set();
  for (let mi = 0; mi < activeMessages.length; mi += 1) {
    const message = activeMessages[mi];
    if (!message || message.role !== "assistant") continue;
    const blocks = this.visibleAssistantBlocks(message.blocks);
    for (let bi = 0; bi < blocks.length; bi += 1) {
      const block = blocks[bi];
      if (!block || block.type !== "tool" || block.tool !== "question") continue;
      const questions = this.extractQuestionItemsFromBlock(block);
      if (!questions.length) continue;
      const key = this.getQuestionInteractionKey(message, block, mi, bi);
      if (key) keepKeys.add(key);
    }
  }
  if (activeSessionId && this.pendingQuestionRequests instanceof Map) {
    for (const request of this.pendingQuestionRequests.values()) {
      if (!request || request.sessionId !== activeSessionId) continue;
      const questions = Array.isArray(request.questions) ? request.questions : [];
      if (!questions.length) continue;
      const requestKey = this.getQuestionRequestInteractionKey(activeSessionId, request.id);
      if (requestKey) keepKeys.add(requestKey);
    }
  }
  for (const key of this.questionAnswerStates.keys()) {
    if (!keepKeys.has(key)) this.questionAnswerStates.delete(key);
  }
  if (this.questionSubmitAt instanceof Map) {
    for (const key of this.questionSubmitAt.keys()) {
      if (!keepKeys.has(key)) this.questionSubmitAt.delete(key);
    }
  }
}

async function submitQuestionAnswers(interactionKey, questions, state, directPayload = "", options = {}) {
  if (!state || state.submitted || state.sending) return;
  if (interactionKey) {
    const now = Date.now();
    const lastAt = Number(this.questionSubmitAt.get(interactionKey) || 0);
    if (now - lastAt < 1200) return;
    this.questionSubmitAt.set(interactionKey, now);
  }
  const payload = String(directPayload || "").trim() || this.buildQuestionAnswerPayload(questions, state);
  if (!payload.trim()) return;

  state.sending = true;
  state.submitted = true;
  this.renderMessages();

  try {
    const sessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
    let requestId = typeof options.requestId === "string" ? options.requestId.trim() : "";
    const providedAnswers = Array.isArray(options.questionAnswers) ? options.questionAnswers : null;

    if (!requestId) {
      const pending = this.findPendingQuestionRequest({
        key: interactionKey,
        sessionId,
        questions,
        message: options.message || null,
        block: options.block || null,
      });
      if (pending && pending.id) requestId = pending.id;
    }

    if (!requestId) {
      const listed = await this.plugin.opencodeClient.listQuestions({ signal: this.currentAbort ? this.currentAbort.signal : undefined });
      if (Array.isArray(listed)) {
        for (const req of listed) this.upsertPendingQuestionRequest(req);
      }
      const refreshed = this.findPendingQuestionRequest({
        key: interactionKey,
        sessionId,
        questions,
        message: options.message || null,
        block: options.block || null,
      });
      if (refreshed && refreshed.id) requestId = refreshed.id;
    }

    if (!requestId) {
      throw new Error("未找到可回复的 question 请求 ID");
    }

    const answers = providedAnswers && providedAnswers.length
      ? providedAnswers
      : this.buildQuestionAnswerArrays(questions, null, state);
    await this.plugin.opencodeClient.replyQuestion({
      requestId,
      sessionId,
      answers,
      signal: this.currentAbort ? this.currentAbort.signal : undefined,
    });
    this.removePendingQuestionRequest(sessionId, requestId);
    this.setRuntimeStatus("已提交问题回答，等待模型继续执行…", "info");
  } catch (e) {
    state.submitted = false;
    const msg = e instanceof Error ? e.message : String(e);
    this.setRuntimeStatus(`提交回答失败：${msg}`, "error");
  } finally {
    state.sending = false;
    if (interactionKey) this.questionAnswerStates.set(interactionKey, state);
    this.renderMessages();
  }
}

function clearInlineQuestionWidget(silent = true) {
  if (this.inlineQuestionWidget && typeof this.inlineQuestionWidget.destroy === "function") {
    this.inlineQuestionWidget.destroy(silent);
  }
  this.inlineQuestionWidget = null;
  this.inlineQuestionKey = "";
  if (this.elements.inlineQuestionHost) {
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
  const list = Array.isArray(messages) ? messages : [];
  const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
  const unresolved = [];
  for (let mi = list.length - 1; mi >= 0; mi -= 1) {
    const message = list[mi];
    if (!message || message.role !== "assistant") continue;
    const blocks = this.visibleAssistantBlocks(message.blocks);
    for (let bi = blocks.length - 1; bi >= 0; bi -= 1) {
      const block = blocks[bi];
      if (!block || block.type !== "tool" || block.tool !== "question") continue;
      const questions = this.extractQuestionItemsFromBlock(block);
      if (!questions.length) {
        unresolved.push({
          reason: "empty-questions",
          messageId: String((message && message.id) || ""),
          blockId: String((block && block.id) || ""),
          toolInputKeys: block && block.toolInput && typeof block.toolInput === "object"
            ? Object.keys(block.toolInput)
            : [],
        });
        continue;
      }
      const key = this.getQuestionInteractionKey(message, block, mi, bi);
      if (!key) {
        unresolved.push({
          reason: "missing-key",
          messageId: String((message && message.id) || ""),
          blockId: String((block && block.id) || ""),
          questionCount: questions.length,
        });
        continue;
      }
      const state = this.getQuestionAnswerState(key, questions.length);
      if (state.submitted) {
        unresolved.push({
          reason: "already-submitted",
          key,
          questionCount: questions.length,
        });
        continue;
      }
      const pendingRequest = this.findPendingQuestionRequest({
        key,
        sessionId: activeSessionId,
        message,
        block,
        questions,
      });
      return {
        key,
        sessionId: activeSessionId,
        message,
        block,
        questions,
        state,
        requestId: pendingRequest && pendingRequest.id ? pendingRequest.id : "",
      };
    }
  }

  if (activeSessionId && this.pendingQuestionRequests instanceof Map) {
    const pending = [];
    for (const request of this.pendingQuestionRequests.values()) {
      if (!request || request.sessionId !== activeSessionId) continue;
      if (!Array.isArray(request.questions) || !request.questions.length) continue;
      pending.push(request);
    }
    if (pending.length) {
      pending.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      for (const request of pending) {
        const key = this.getQuestionRequestInteractionKey(activeSessionId, request.id);
        if (!key) continue;
        const state = this.getQuestionAnswerState(key, request.questions.length);
        if (state.submitted) continue;
        return {
          key,
          sessionId: activeSessionId,
          message: null,
          block: null,
          questions: request.questions,
          state,
          requestId: request.id,
        };
      }
    }
  }

  const now = Date.now();
  if (unresolved.length && now - Number(this.lastQuestionResolveLogAt || 0) > 1200) {
    this.lastQuestionResolveLogAt = now;
    console.log("[opencode-assistant] question interaction unresolved", unresolved.slice(0, 5));
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
  if (this.inlineQuestionWidget && this.inlineQuestionKey === interaction.key) {
    return;
  }

  this.clearInlineQuestionWidget(true);
  this.inlineQuestionKey = interaction.key;
  console.log("[opencode-assistant] inline question panel", {
    key: interaction.key,
    count: Array.isArray(interaction.questions) ? interaction.questions.length : 0,
  });
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
      title: "OpenCode has a question",
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

module.exports = { questionFlowMethods: {
  parseMaybeJsonObject,
  splitQuestionOptionString,
  normalizeQuestionOption,
  parseQuestionOptions,
  normalizeQuestionItem,
  normalizeQuestionInput,
  parseQuestionsFromDetailText,
  extractQuestionItemsFromBlock,
  questionTextSignature,
  questionRequestMapKey,
  getQuestionRequestInteractionKey,
  normalizeQuestionRequest,
  upsertPendingQuestionRequest,
  removePendingQuestionRequest,
  findPendingQuestionRequest,
  getQuestionInteractionKey,
  getQuestionAnswerState,
  buildQuestionAnswerPayload,
  tokenizeQuestionAnswer,
  buildQuestionAnswerArrays,
  pruneQuestionAnswerStates,
  submitQuestionAnswers,
  clearInlineQuestionWidget,
  formatInlineQuestionPayload,
  submitInlineQuestionResult,
  findActiveQuestionInteraction,
  renderInlineQuestionPanel,
  prefillComposerInput,
  hasVisibleQuestionToolCard,
} };
