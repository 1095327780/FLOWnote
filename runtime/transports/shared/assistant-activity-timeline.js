function normalizeType(block) {
  return String(block && block.type || "part").trim().toLowerCase() || "part";
}

function normalizeActivityId(block, index = 0) {
  const type = normalizeType(block);
  const raw = String(block && (block.id || block.callId) || "").trim();
  if (raw) {
    const prefix = `${type}:`;
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  }
  return `${String(block && (block.tool || block.title || block.summary) || "").trim()}:${index}`;
}

function activityKey(block, index = 0) {
  return `${normalizeType(block)}:${normalizeActivityId(block, index)}`;
}

function isTimelineText(block) {
  return normalizeType(block) === "stream-text";
}

function timelineText(block) {
  return String(block && (block.text || block.detail) || "");
}

function stripKnownProcessPrefix(terminalText, processTexts) {
  let remaining = String(terminalText || "").trim();
  if (!remaining) return "";
  for (const rawProcessText of processTexts) {
    const processText = String(rawProcessText || "").trim();
    if (!processText) continue;
    if (!remaining.startsWith(processText)) continue;
    remaining = remaining.slice(processText.length).replace(/^[\s\n\r:：—-]+/, "").trim();
  }
  return remaining;
}

function mergeTerminalBlocksInPlace(liveBlocks, terminalBlocks) {
  const out = (Array.isArray(liveBlocks) ? liveBlocks : [])
    .filter((block) => block && typeof block === "object")
    .map((block) => ({ ...block }));
  const indexByKey = new Map();
  out.forEach((block, index) => indexByKey.set(activityKey(block, index), index));

  const missing = [];
  (Array.isArray(terminalBlocks) ? terminalBlocks : []).forEach((block, index) => {
    if (!block || typeof block !== "object" || isTimelineText(block)) return;
    const key = activityKey(block, index);
    if (indexByKey.has(key)) {
      const existingIndex = Number(indexByKey.get(key));
      out[existingIndex] = { ...out[existingIndex], ...block };
      return;
    }
    missing.push({ ...block });
  });

  if (missing.length) {
    let finalIndex = out.findIndex((block) => (
      isTimelineText(block)
      && String(block.phase || "").trim().toLowerCase() === "final"
    ));
    if (finalIndex < 0) {
      const lastTextIndex = out.reduce((found, block, index) => (isTimelineText(block) ? index : found), -1);
      const lastStructuredIndex = out.reduce((found, block, index) => (
        ["tool", "patch", "reasoning", "subtask", "agent"].includes(normalizeType(block)) ? index : found
      ), -1);
      if (lastTextIndex > lastStructuredIndex && lastStructuredIndex >= 0) finalIndex = lastTextIndex;
    }
    if (finalIndex >= 0) out.splice(finalIndex, 0, ...missing);
    else out.push(...missing);
  }
  return out;
}

function reconcileTerminalAssistantTimeline(livePayload, terminalPayload) {
  const live = livePayload && typeof livePayload === "object" ? livePayload : {};
  const terminal = terminalPayload && typeof terminalPayload === "object" ? terminalPayload : {};
  const terminalText = String(terminal.text || "").trim();
  const blocks = mergeTerminalBlocksInPlace(live.blocks, terminal.blocks);

  const structuredIndexes = blocks
    .map((block, index) => ({ type: normalizeType(block), index }))
    .filter(({ type }) => ["tool", "patch", "reasoning", "subtask", "agent"].includes(type))
    .map(({ index }) => index);
  const lastStructuredIndex = structuredIndexes.length ? Math.max(...structuredIndexes) : -1;
  const textIndexes = blocks
    .map((block, index) => (isTimelineText(block) ? index : -1))
    .filter((index) => index >= 0);
  let finalTextIndex = textIndexes.length ? textIndexes[textIndexes.length - 1] : -1;
  if (finalTextIndex >= 0 && finalTextIndex < lastStructuredIndex) finalTextIndex = -1;

  const processTexts = textIndexes
    .filter((index) => index !== finalTextIndex)
    .map((index) => timelineText(blocks[index]));
  let resolvedFinalText = finalTextIndex >= 0 ? timelineText(blocks[finalTextIndex]).trim() : "";
  const terminalFinalCandidate = stripKnownProcessPrefix(terminalText, processTexts);

  if (finalTextIndex >= 0) {
    if (
      terminalFinalCandidate
      && (
        !resolvedFinalText
        || terminalFinalCandidate === resolvedFinalText
        || terminalFinalCandidate.endsWith(resolvedFinalText)
        || terminalFinalCandidate.length > resolvedFinalText.length
      )
    ) {
      resolvedFinalText = terminalFinalCandidate;
    }
  } else if (terminalFinalCandidate) {
    const messageId = String(terminal.messageId || live.messageId || "terminal").trim() || "terminal";
    finalTextIndex = blocks.length;
    resolvedFinalText = terminalFinalCandidate;
    blocks.push({
      id: `stream-text:${messageId}:final`,
      type: "stream-text",
      phase: "final",
      status: "completed",
      text: resolvedFinalText,
      detail: resolvedFinalText,
    });
  }

  textIndexes.forEach((index) => {
    const isFinal = index === finalTextIndex;
    const text = isFinal ? resolvedFinalText : timelineText(blocks[index]);
    blocks[index] = {
      ...blocks[index],
      phase: isFinal ? "final" : "process",
      status: String(blocks[index].status || "").trim().toLowerCase() === "error" ? "error" : "completed",
      text,
      detail: text,
    };
  });

  if (finalTextIndex >= textIndexes.length && blocks[finalTextIndex]) {
    blocks[finalTextIndex] = {
      ...blocks[finalTextIndex],
      phase: "final",
      status: "completed",
      text: resolvedFinalText,
      detail: resolvedFinalText,
    };
  }

  return {
    ...live,
    ...terminal,
    messageId: String(terminal.messageId || live.messageId || ""),
    text: resolvedFinalText || terminalText || String(live.text || ""),
    reasoning: String(terminal.reasoning || live.reasoning || ""),
    meta: String(terminal.meta || live.meta || ""),
    blocks,
    completed: Boolean(terminal.completed || live.completed),
  };
}

module.exports = {
  reconcileTerminalAssistantTimeline,
  activityKey,
};
