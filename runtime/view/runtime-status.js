const { tFromContext } = require("../i18n-runtime");

function runtimeStatusFromBlocks(rawBlocks) {
  const blocks = this.visibleAssistantBlocks(rawBlocks);
  const blockType = (block) => String(block && block.type || "").trim().toLowerCase();
  const blockStatus = (block) => this.normalizeBlockStatus(block && block.status);
  const isRunning = (block) => {
    const status = blockStatus(block);
    return status === "running" || status === "pending";
  };
  const reasoningBlocks = blocks.filter((block) => blockType(block) === "reasoning");
  const reasoningRunning = reasoningBlocks.some(isRunning);
  if (reasoningRunning) {
    return { tone: "working", text: tFromContext(this, "view.runtime.reasoning", "Model is reasoning...") };
  }

  const tools = blocks.filter((block) => blockType(block) === "tool");
  const runningTools = tools.filter(isRunning);
  if (runningTools.length) {
    const names = [...new Set(runningTools.map((block) => {
      const rawName = this.toolDisplayName(block);
      const toolId = String(block && block.tool || "").trim().toLowerCase();
      return toolId ? tFromContext(this, `view.tools.${toolId}`, rawName || toolId) : rawName;
    }).filter(Boolean))];
    const shortNames = names.slice(0, 3).join(", ");
    const suffix = names.length > 3 ? "…" : "";
    const statusText = shortNames || tFromContext(this, "view.runtime.tool", "Tools");
    return {
      tone: "working",
      text: tFromContext(this, "view.runtime.toolRunning", "Running {statusText}{suffix}...", { statusText, suffix }),
    };
  }

  // Blocks form an append-only history. Project liveness from the newest
  // activity instead of letting any historical error poison the turn forever.
  const latestBlock = blocks.length ? blocks[blocks.length - 1] : null;
  const latestType = blockType(latestBlock);
  if (latestType === "stream-text") {
    return {
      tone: "working",
      text: tFromContext(this, "view.runtime.generating", "Generating response..."),
    };
  }

  if (latestType === "retry") {
    return { tone: "working", text: tFromContext(this, "view.runtime.retrying", "Retrying...") };
  }

  const latestTool = [...tools].reverse().find(Boolean);
  if (latestTool) {
    if (blockStatus(latestTool) === "error") {
      // While the draft remains pending, the detailed failure belongs in the
      // process timeline. The turn-level marker describes active recovery.
      return {
        tone: "working",
        text: tFromContext(this, "view.runtime.recovering", "Trying another approach..."),
      };
    }
    return { tone: "working", text: tFromContext(this, "view.runtime.toolDone", "Tool finished, preparing response...") };
  }

  if (reasoningBlocks.length) {
    return { tone: "working", text: tFromContext(this, "view.runtime.reasoningDone", "Reasoning complete, preparing response...") };
  }
  return null;
}

function syncRuntimeStatusToPendingMessage() {
  const container = this.elements.messages;
  if (!container) return;
  const rows = container.querySelectorAll(".oc-message-assistant.is-pending");
  if (!rows || !rows.length) return;
  const row = rows[rows.length - 1];
  if (!row) return;

  const body = row.querySelector(".oc-message-content");
  if (!body) return;
  // Legacy builds rendered liveness inside the reply body. Clear those
  // attributes, but keep streamed prose in its own timeline blocks.
  body.removeClass("oc-runtime-tail", "is-info", "is-working", "is-error");
  body.removeAttribute("role");
  body.removeAttribute("aria-live");
  body.removeAttribute("aria-atomic");

  const statusText = String((this.runtimeStatusState && this.runtimeStatusState.text) || "").trim();
  let status = row.querySelector(".oc-runtime-status");
  if (!statusText) {
    if (status) status.remove();
    return;
  }
  if (!status) {
    status = typeof row.createDiv === "function"
      ? row.createDiv({ cls: "oc-runtime-status" })
      : document.createElement("div");
    if (!status.parentElement) {
      status.className = "oc-runtime-status";
      row.appendChild(status);
    }
  }
  status.setText(statusText);
  status.removeClass("is-info", "is-working", "is-error");
  const tone = String((this.runtimeStatusState && this.runtimeStatusState.tone) || "info");
  // Announce only coarse state transitions. Streamed assistant text is never
  // a live region, avoiding one accessibility announcement per token.
  status.setAttribute("role", tone === "error" ? "alert" : "status");
  status.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  status.setAttribute("aria-atomic", "true");
  if (tone === "error") status.addClass("is-error");
  else if (tone === "working") status.addClass("is-working");
  else status.addClass("is-info");
  if (typeof this.reorderAssistantMessageLayout === "function") {
    this.reorderAssistantMessageLayout(row);
  }
}

function setRuntimeStatus(text, tone = "info") {
  const normalizedText = String(text || "").trim();
  const normalizedTone = tone === "error" || tone === "working" ? tone : "info";
  this.runtimeStatusState = { text: normalizedText, tone: normalizedTone };
  this.syncRuntimeStatusToPendingMessage();
}

module.exports = { runtimeStatusMethods: {
  runtimeStatusFromBlocks,
  syncRuntimeStatusToPendingMessage,
  setRuntimeStatus,
} };
