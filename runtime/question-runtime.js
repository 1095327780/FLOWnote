function questionTextSignature(questions) {
  const list = Array.isArray(questions) ? questions : [];
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      return String(item.question || "").trim().toLowerCase();
    })
    .filter(Boolean)
    .join("||");
}

function questionRequestMapKey(sessionId, requestId) {
  const sid = String(sessionId || "").trim();
  const rid = String(requestId || "").trim();
  if (!sid || !rid) return "";
  return `${sid}::${rid}`;
}

function getQuestionRequestInteractionKey(sessionId, requestId) {
  const sid = String(sessionId || "").trim();
  const rid = String(requestId || "").trim();
  if (!sid || !rid) return "";
  return `${sid}::question-request::${rid}`;
}

function normalizeQuestionRequest(raw, normalizeQuestionInput) {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw;
  const requestId =
    (typeof obj.id === "string" && obj.id.trim()) ||
    (typeof obj.requestID === "string" && obj.requestID.trim()) ||
    "";
  const sessionId =
    (typeof obj.sessionID === "string" && obj.sessionID.trim()) ||
    (typeof obj.sessionId === "string" && obj.sessionId.trim()) ||
    "";
  if (!requestId || !sessionId) return null;

  const parser = typeof normalizeQuestionInput === "function" ? normalizeQuestionInput : () => [];
  const questions = parser(obj.questions !== undefined ? obj.questions : obj.input);
  const tool = obj.tool && typeof obj.tool === "object" ? obj.tool : {};

  return {
    id: requestId,
    sessionId,
    questions,
    questionSignature: questionTextSignature(questions),
    tool: {
      messageID: typeof tool.messageID === "string" ? tool.messageID : "",
      callID: typeof tool.callID === "string" ? tool.callID : "",
    },
    updatedAt: Date.now(),
  };
}

function upsertPendingQuestionRequest(pendingQuestionRequests, raw, normalizeQuestionInput) {
  if (!(pendingQuestionRequests instanceof Map)) return null;
  const normalized = normalizeQuestionRequest(raw, normalizeQuestionInput);
  if (!normalized) return null;
  const key = questionRequestMapKey(normalized.sessionId, normalized.id);
  if (!key) return null;

  const previous = pendingQuestionRequests.get(key);
  pendingQuestionRequests.set(
    key,
    previous
      ? {
        ...previous,
        ...normalized,
        updatedAt: Date.now(),
      }
      : normalized,
  );
  return pendingQuestionRequests.get(key) || null;
}

function removePendingQuestionRequest(pendingQuestionRequests, sessionId, requestId) {
  if (!(pendingQuestionRequests instanceof Map)) return;
  const key = questionRequestMapKey(sessionId, requestId);
  if (!key) return;
  pendingQuestionRequests.delete(key);
}

function findPendingQuestionRequest(pendingQuestionRequests, interaction) {
  if (!(pendingQuestionRequests instanceof Map) || !pendingQuestionRequests.size) return null;
  const sessionId = String((interaction && interaction.sessionId) || "").trim();
  if (!sessionId) return null;

  const pending = [];
  for (const request of pendingQuestionRequests.values()) {
    if (!request || request.sessionId !== sessionId) continue;
    pending.push(request);
  }
  if (!pending.length) return null;

  const interactionMessageId = String(
    (interaction && interaction.message && (interaction.message.id || interaction.message.messageID || interaction.message.messageId)) || "",
  ).trim();
  const interactionCallId = String(
    (interaction && interaction.block && (interaction.block.id || (interaction.block.raw && interaction.block.raw.id))) || "",
  ).trim();
  const interactionSig = questionTextSignature(interaction && interaction.questions ? interaction.questions : []);

  pending.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

  const byToolStrict = pending.find((request) => {
    const tool = request.tool || {};
    if (!tool.callID || !interactionCallId) return false;
    if (tool.callID !== interactionCallId) return false;
    if (tool.messageID && interactionMessageId && tool.messageID !== interactionMessageId) return false;
    return true;
  });
  if (byToolStrict) return byToolStrict;

  const byToolMessage = pending.find((request) => {
    const tool = request.tool || {};
    return Boolean(tool.messageID && interactionMessageId && tool.messageID === interactionMessageId);
  });
  if (byToolMessage) return byToolMessage;

  const bySignature = pending.find((request) => request.questionSignature && request.questionSignature === interactionSig);
  if (bySignature) return bySignature;

  return pending[0] || null;
}

function tokenizeQuestionAnswer(rawAnswer) {
  const text = String(rawAnswer || "").trim();
  if (!text) return [];
  return text
    .split(/\s*,\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildQuestionAnswerArrays(questions, result, state) {
  const list = Array.isArray(questions) ? questions : [];
  const resultMap = result && typeof result === "object" ? result : {};
  const stateAnswers = state && state.answers && typeof state.answers === "object" ? state.answers : {};

  return list.map((question, index) => {
    const q = question && typeof question === "object" ? question : {};
    const qText = String(q.question || "").trim();
    const optionLabels = new Set(
      (Array.isArray(q.options) ? q.options : [])
        .map((opt) => {
          if (opt && typeof opt === "object") return String(opt.label || "").trim();
          return String(opt || "").trim();
        })
        .filter(Boolean),
    );

    const answerText = qText && typeof resultMap[qText] === "string"
      ? String(resultMap[qText] || "")
      : "";
    const tokens = tokenizeQuestionAnswer(answerText);
    const selected = [];
    const extras = [];

    for (const token of tokens) {
      if (optionLabels.has(token)) selected.push(token);
      else extras.push(token);
    }

    if (!tokens.length) {
      const stateAnswer = stateAnswers[index];
      if (stateAnswer && typeof stateAnswer === "object") {
        const base = typeof stateAnswer.value === "string" ? stateAnswer.value.trim() : "";
        const custom = typeof stateAnswer.custom === "string" ? stateAnswer.custom.trim() : "";
        if (base) selected.push(base);
        if (custom) extras.push(custom);
      }
    }

    const merged = [...selected, ...extras]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!merged.length && answerText.trim()) return [answerText.trim()];
    return merged;
  });
}

module.exports = {
  buildQuestionAnswerArrays,
  findPendingQuestionRequest,
  getQuestionRequestInteractionKey,
  normalizeQuestionRequest,
  questionRequestMapKey,
  questionTextSignature,
  removePendingQuestionRequest,
  tokenizeQuestionAnswer,
  upsertPendingQuestionRequest,
};

