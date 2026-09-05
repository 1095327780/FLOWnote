const {
  projectDirectToolBlock,
} = require("./direct-tool-blocks");

function cloneBlock(block) {
  return block && typeof block === "object"
    ? JSON.parse(JSON.stringify(block))
    : block;
}

/**
 * Append-only visible activity projection for one Direct assistant response.
 *
 * Ordering is assigned exactly once, when text/tool activity first appears.
 * Later deltas and tool results only update the matching stable entry.
 */
function createDirectActivityTimeline(runId) {
  const stableRunId = String(runId || "run").trim() || "run";
  const entries = [];
  const toolIndex = new Map();
  let turnIndex = 0;
  let turnHadTools = false;
  let textSegment = 0;
  let activeTextIndex = -1;

  const currentTextBlock = () => (
    activeTextIndex >= 0 && entries[activeTextIndex] && entries[activeTextIndex].type === "stream-text"
      ? entries[activeTextIndex]
      : null
  );

  const closeText = () => {
    activeTextIndex = -1;
  };

  const completeTextBlock = (block, phase) => {
    if (!block || block.type !== "stream-text") return;
    block.phase = phase === "final" ? "final" : "process";
    block.status = "completed";
  };

  const appendText = (deltaText) => {
    const delta = String(deltaText || "");
    if (!delta) return;
    let block = currentTextBlock();
    if (!block) {
      block = {
        id: `direct:${stableRunId}:turn:${turnIndex}:text:${textSegment}`,
        type: "stream-text",
        text: "",
        phase: "streaming",
        status: "running",
        turnIndex,
      };
      textSegment += 1;
      entries.push(block);
      activeTextIndex = entries.length - 1;
    }
    block.text += delta;
  };

  const startTool = (toolUse, receipt) => {
    const id = String(toolUse && toolUse.id || "").trim();
    if (!id) return;
    closeText();
    turnHadTools = true;
    const existingIndex = toolIndex.get(id);
    const block = projectDirectToolBlock(toolUse, receipt);
    if (Number.isInteger(existingIndex)) {
      entries[existingIndex] = { ...entries[existingIndex], ...block, id };
      return;
    }
    toolIndex.set(id, entries.length);
    entries.push(block);
  };

  const finishTool = (toolUseId, patch = {}, receipt) => {
    const id = String(toolUseId || "").trim();
    const index = toolIndex.get(id);
    if (!Number.isInteger(index)) return;
    const existing = entries[index] || {};
    const normalizedToolUse = {
      id,
      name: existing.tool,
      status: patch.status || existing.status,
      input: patch.input,
      output: patch.output,
      isError: patch.isError === true,
      capabilities: patch.capabilities || existing.capabilities,
      outcome: patch.outcome || existing.outcome,
      durationMs: patch.durationMs,
    };
    entries[index] = {
      ...existing,
      ...projectDirectToolBlock(normalizedToolUse, receipt),
      id,
    };
  };

  const syncTool = (toolUse, receipt) => {
    const id = String(toolUse && toolUse.id || "").trim();
    if (!id) return;
    const index = toolIndex.get(id);
    if (!Number.isInteger(index)) {
      startTool(toolUse, receipt);
      return;
    }
    entries[index] = {
      ...entries[index],
      ...projectDirectToolBlock(toolUse, receipt),
      id,
    };
  };

  const appendFinalText = (value) => {
    const text = String(value || "");
    if (!text) return "";
    const active = currentTextBlock();
    const last = entries.length ? entries[entries.length - 1] : null;
    if (active && active === last && String(active.text || "") === text) {
      completeTextBlock(active, "final");
      closeText();
      return text;
    }
    if (active) completeTextBlock(active, "process");
    closeText();
    entries.push({
      id: `direct:${stableRunId}:turn:${turnIndex}:final:${textSegment}`,
      type: "stream-text",
      text,
      phase: "final",
      status: "completed",
      turnIndex,
    });
    textSegment += 1;
    return text;
  };

  const completeTurn = ({ forceProcess = false } = {}) => {
    for (const entry of entries) {
      if (entry.type !== "stream-text" || entry.turnIndex !== turnIndex) continue;
      if (entry.phase === "final") {
        completeTextBlock(entry, "final");
        continue;
      }
      completeTextBlock(entry, forceProcess || turnHadTools ? "process" : "final");
    }
    closeText();
    turnIndex += 1;
    turnHadTools = false;
    textSegment = 0;
  };

  const settle = (finalText) => {
    const normalizedFinal = String(finalText || "");
    const unfinishedText = entries.filter((entry) => (
      entry.type === "stream-text" && entry.phase === "streaming"
    ));
    if (unfinishedText.length) {
      for (const entry of unfinishedText) {
        entry.phase = turnHadTools ? "process" : "final";
        entry.status = "completed";
      }
    }

    let finalBlock = [...entries].reverse().find((entry) => (
      entry.type === "stream-text" && entry.phase === "final"
    ));
    if (!finalBlock && normalizedFinal) {
      finalBlock = {
        id: `direct:${stableRunId}:turn:${turnIndex}:text:0`,
        type: "stream-text",
        text: normalizedFinal,
        phase: "final",
        status: "completed",
        turnIndex,
      };
      entries.push(finalBlock);
    } else if (finalBlock && normalizedFinal && finalBlock.text !== normalizedFinal) {
      finalBlock.text = normalizedFinal;
    }

    for (const entry of entries) {
      if (entry.type === "stream-text" && entry !== finalBlock && entry.phase !== "process") {
        entry.phase = "process";
        entry.status = "completed";
      }
    }
    return entries.map(cloneBlock);
  };

  const finalText = () => {
    const block = [...entries].reverse().find((entry) => (
      entry.type === "stream-text" && entry.phase === "final"
    ));
    if (block) return String(block.text || "");
    const active = currentTextBlock();
    return active && !turnHadTools ? String(active.text || "") : "";
  };

  return {
    appendText,
    appendFinalText,
    startTool,
    finishTool,
    syncTool,
    completeTurn,
    settle,
    finalText,
    blocks: () => entries.map(cloneBlock),
  };
}

module.exports = {
  createDirectActivityTimeline,
};
