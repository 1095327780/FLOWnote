const {
  findPendingQuestionRequest: findPendingQuestionRequestRuntime,
  getQuestionRequestInteractionKey: getQuestionRequestInteractionKeyRuntime,
  normalizeQuestionRequest: normalizeQuestionRequestRuntime,
  questionRequestMapKey: questionRequestMapKeyRuntime,
  questionTextSignature: questionTextSignatureRuntime,
  removePendingQuestionRequest: removePendingQuestionRequestRuntime,
  upsertPendingQuestionRequest: upsertPendingQuestionRequestRuntime,
} = require("../../question-runtime");

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


function pruneQuestionAnswerStates(messages) {
  if (!(this.questionAnswerStates instanceof Map) || !this.questionAnswerStates.size) return;
  const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
  const keepKeys = new Set();
  if (activeSessionId && this.pendingQuestionRequests instanceof Map) {
    for (const request of this.pendingQuestionRequests.values()) {
      if (!request || request.sessionId !== activeSessionId) continue;
      const questions = Array.isArray(request.questions) && request.questions.length
        ? request.questions
        : this.buildFallbackQuestionItemsFromRequest(request);
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

async function refreshPendingQuestionRequests(options = {}) {
  if (!this.plugin || !this.plugin.opencodeClient || typeof this.plugin.opencodeClient.listQuestions !== "function") {
    return;
  }
  const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
  if (!activeSessionId) return;

  const now = Date.now();
  const minIntervalMs = Math.max(400, Number(options.minIntervalMs || 1400));
  const force = Boolean(options.force);
  const silent = Boolean(options.silent);

  if (!force && this.pendingQuestionRefreshInflight) return this.pendingQuestionRefreshInflight;
  if (!force && now - Number(this.pendingQuestionRefreshAt || 0) < minIntervalMs) return;

  const refreshPromise = (async () => {
    this.pendingQuestionRefreshAt = Date.now();
    const listed = await this.plugin.opencodeClient.listQuestions({
      signal: this.currentAbort ? this.currentAbort.signal : undefined,
    });
    if (!Array.isArray(listed)) return;

    const keep = new Set();
    for (const raw of listed) {
      const normalized = this.upsertPendingQuestionRequest(raw);
      if (!normalized || normalized.sessionId !== activeSessionId) continue;
      const requestKey = this.questionRequestMapKey(activeSessionId, normalized.id);
      if (requestKey) keep.add(requestKey);
    }

    if (this.pendingQuestionRequests instanceof Map) {
      for (const [mapKey, request] of this.pendingQuestionRequests.entries()) {
        if (!request || request.sessionId !== activeSessionId) continue;
        if (!keep.has(mapKey)) this.pendingQuestionRequests.delete(mapKey);
      }
    }

    if (!silent) {
      this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
    }
  })();

  this.pendingQuestionRefreshInflight = refreshPromise;
  try {
    await refreshPromise;
  } finally {
    if (this.pendingQuestionRefreshInflight === refreshPromise) {
      this.pendingQuestionRefreshInflight = null;
    }
  }
}


const requestStateMethods = {
  questionTextSignature,
  questionRequestMapKey,
  getQuestionRequestInteractionKey,
  normalizeQuestionRequest,
  upsertPendingQuestionRequest,
  removePendingQuestionRequest,
  findPendingQuestionRequest,
  getQuestionAnswerState,
  pruneQuestionAnswerStates,
  refreshPendingQuestionRequests,
};

module.exports = { requestStateMethods };
