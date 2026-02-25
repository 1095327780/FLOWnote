const {
  buildQuestionAnswerArrays: buildQuestionAnswerArraysRuntime,
  tokenizeQuestionAnswer: tokenizeQuestionAnswerRuntime,
} = require("../../question-runtime");
const { tFromContext } = require("../../i18n-runtime");

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

    if (!requestId && interactionKey && interactionKey.includes("::question-request::")) {
      const parsedId = interactionKey.split("::question-request::")[1];
      if (parsedId) requestId = String(parsedId).trim();
    }

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
      throw new Error(tFromContext(this, "view.question.requestMissing", "No pending question request ID found"));
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
    this.setRuntimeStatus(tFromContext(this, "view.question.submitted", "Answers submitted, waiting for model to continue..."), "info");
  } catch (e) {
    state.submitted = false;
    const msg = e instanceof Error ? e.message : String(e);
    this.setRuntimeStatus(tFromContext(this, "view.question.submitFailed", "Failed to submit answers: {message}", { message: msg }), "error");
  } finally {
    state.sending = false;
    if (interactionKey) this.questionAnswerStates.set(interactionKey, state);
    this.renderMessages();
  }
}


const submissionMethods = {
  buildQuestionAnswerPayload,
  tokenizeQuestionAnswer,
  buildQuestionAnswerArrays,
  submitQuestionAnswers,
};

module.exports = { submissionMethods };
