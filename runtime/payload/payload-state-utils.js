const { normalizedRenderableText } = require("./markdown-utils");

function hasRenderablePayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const textLen = normalizedRenderableText(p.text || "").length;
  const reasoningLen = String(p.reasoning || "").trim().length;
  const blocksLen = Array.isArray(p.blocks) ? p.blocks.length : 0;
  return textLen > 0 || reasoningLen > 0 || blocksLen > 0;
}

function hasSufficientPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const textLen = normalizedRenderableText(p.text || "").length;
  const reasoningLen = String(p.reasoning || "").trim().length;
  const blocksLen = Array.isArray(p.blocks) ? p.blocks.length : 0;
  if (textLen > 1) return true;
  if (blocksLen > 0) return true;
  if (reasoningLen > 40) return true;
  return false;
}

function isIntermediateToolCallPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const text = normalizedRenderableText(p.text || "");
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  const hasToolBlock = blocks.some((b) => b && b.type === "tool");
  const hasToolCallsFinish = blocks.some(
    (b) => b && b.type === "step-finish" && String(b.summary || "").trim().toLowerCase() === "tool-calls",
  );
  if (!hasToolBlock || !hasToolCallsFinish) return false;
  if (!text) return true;
  if (/^\d+$/.test(text)) return true;
  if (text.length <= 1) return true;
  return false;
}

function hasTerminalStepFinish(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  for (const b of blocks) {
    if (!b || b.type !== "step-finish") continue;
    const reason = String(b.summary || "").trim().toLowerCase();
    if (!reason) continue;
    if (reason === "tool-calls") continue;
    return true;
  }
  return false;
}

function payloadLooksInProgress(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  const hasRenderableText = normalizedRenderableText(p.text || "").length > 1;
  const hasReasoningText = String(p.reasoning || "").trim().length > 0;
  const hasToolInFlight = blocks.some((b) => {
    if (!b || b.type !== "tool") return false;
    const status = String(b.status || "").trim().toLowerCase();
    if (!status) return true;
    return status !== "completed" && status !== "error";
  });
  const hasStepStart = blocks.some((b) => b && b.type === "step-start");
  const hasTerminalFinish = hasTerminalStepFinish(payload);
  const hasToolCallsFinish = blocks.some(
    (b) => b && b.type === "step-finish" && String(b.summary || "").trim().toLowerCase() === "tool-calls",
  );
  if (hasTerminalFinish) return false;
  if (hasToolCallsFinish && !hasRenderableText) return true;
  if (hasToolInFlight) return true;
  if (hasStepStart && !hasRenderableText && !hasReasoningText) return true;
  return false;
}

function hasTerminalPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (hasTerminalStepFinish(p)) return true;
  if (payloadLooksInProgress(p)) return false;
  if (normalizedRenderableText(p.text || "").length > 1) return true;
  return false;
}

function responseRichnessScore(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const text = normalizedRenderableText(p.text || "");
  const reasoning = String(p.reasoning || "").trim();
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  const meta = String(p.meta || "").trim();
  const hasFallbackText = /^\(无文本返回：session\.status=/.test(text);
  const terminal = hasTerminalPayload(p);
  const inProgress = payloadLooksInProgress(p);

  let score = 0;
  score += Math.min(text.length, 400) * 1.4;
  score += Math.min(reasoning.length, 300) * 0.45;
  score += Math.min(blocks.length, 10) * 8;
  score += Math.min(meta.length, 200) * 0.15;
  if (terminal) score += 120;
  if (inProgress) score -= 40;
  if (hasFallbackText) score -= 30;
  return score;
}

function mergeBlockLists(primaryBlocks, secondaryBlocks) {
  const out = [];
  const indexByKey = new Map();
  const statusRank = (value) => {
    const status = String(value || "").trim().toLowerCase();
    if (status === "error") return 4;
    if (status === "completed") return 3;
    if (status === "running") return 2;
    if (status === "pending") return 1;
    return 0;
  };
  const lists = [Array.isArray(primaryBlocks) ? primaryBlocks : [], Array.isArray(secondaryBlocks) ? secondaryBlocks : []];
  for (const list of lists) {
    for (let idx = 0; idx < list.length; idx += 1) {
      const block = list[idx];
      if (!block || typeof block !== "object") continue;
      const key = String(block.id || "") || `${String(block.type || "block")}::${String(block.title || "")}::${String(block.summary || "")}::${idx}`;
      if (!indexByKey.has(key)) {
        indexByKey.set(key, out.length);
        out.push(block);
        continue;
      }

      const existingIndex = Number(indexByKey.get(key));
      const existing = out[existingIndex];
      const existingRank = statusRank(existing && existing.status);
      const nextRank = statusRank(block.status);
      const existingDetailLen = String(existing && existing.detail ? existing.detail : "").length;
      const nextDetailLen = String(block.detail || "").length;
      const shouldReplace = nextRank > existingRank || (nextRank === existingRank && nextDetailLen > existingDetailLen);
      if (shouldReplace) {
        out[existingIndex] = block;
      }
    }
  }
  return out;
}

function mergeAssistantPayload(preferred, fallback) {
  if (!fallback) return preferred;
  if (!preferred) return fallback;

  const p = preferred && typeof preferred === "object" ? preferred : {};
  const f = fallback && typeof fallback === "object" ? fallback : {};
  const pMessageId = String(p.messageId || "").trim();
  const fMessageId = String(f.messageId || "").trim();
  if (pMessageId && fMessageId && pMessageId !== fMessageId) {
    return preferred;
  }

  return {
    messageId: pMessageId || fMessageId || "",
    text: normalizedRenderableText(p.text || "") ? String(p.text || "") : String(f.text || ""),
    reasoning: String(p.reasoning || "").trim() ? String(p.reasoning || "") : String(f.reasoning || ""),
    meta: String(p.meta || "").trim() ? String(p.meta || "") : String(f.meta || ""),
    blocks: mergeBlockLists(p.blocks, f.blocks),
    completed: Boolean(p.completed) || Boolean(f.completed),
  };
}

function chooseRicherResponse(primary, secondary) {
  if (!secondary) return primary;
  if (!primary) return secondary;

  const p = primary && typeof primary === "object" ? primary : {};
  const s = secondary && typeof secondary === "object" ? secondary : {};
  const pTextLen = normalizedRenderableText(p.text || "").length;
  const sTextLen = normalizedRenderableText(s.text || "").length;
  const pTerminal = hasTerminalPayload(p);
  const sTerminal = hasTerminalPayload(s);

  if (sTerminal && !pTerminal) return mergeAssistantPayload(secondary, primary);
  if (pTerminal && !sTerminal) return mergeAssistantPayload(primary, secondary);
  if (sTextLen > 0 && pTextLen === 0) return mergeAssistantPayload(secondary, primary);
  if (pTextLen > 0 && sTextLen === 0) return mergeAssistantPayload(primary, secondary);

  const pScore = responseRichnessScore(primary);
  const sScore = responseRichnessScore(secondary);
  return sScore >= pScore
    ? mergeAssistantPayload(secondary, primary)
    : mergeAssistantPayload(primary, secondary);
}

module.exports = {
  hasRenderablePayload,
  hasSufficientPayload,
  isIntermediateToolCallPayload,
  hasTerminalStepFinish,
  payloadLooksInProgress,
  hasTerminalPayload,
  responseRichnessScore,
  mergeBlockLists,
  mergeAssistantPayload,
  chooseRicherResponse,
};
