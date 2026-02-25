const { tFromContext } = require("../i18n-runtime");

function runtimeStatusFromBlocks(rawBlocks) {
  const blocks = this.visibleAssistantBlocks(rawBlocks);
  const reasoningBlocks = blocks.filter((block) => block && String(block.type || "").trim().toLowerCase() === "reasoning");
  const reasoningRunning = reasoningBlocks.some((block) => {
    const status = this.normalizeBlockStatus(block && block.status);
    return status === "running" || status === "pending";
  });
  if (reasoningRunning) {
    return { tone: "working", text: tFromContext(this, "view.runtime.reasoning", "Model is reasoning...") };
  }

  const tools = blocks.filter((block) => block && String(block.type || "").trim().toLowerCase() === "tool");
  if (!tools.length) {
    if (reasoningBlocks.length) {
      return { tone: "info", text: tFromContext(this, "view.runtime.reasoningDone", "Reasoning complete, preparing response...") };
    }
    return null;
  }

  const names = [...new Set(tools.map((block) => this.toolDisplayName(block)).filter(Boolean))];
  const shortNames = names.slice(0, 3).join(", ");
  const suffix = names.length > 3 ? "…" : "";
  const statusText = shortNames || tFromContext(this, "view.runtime.tool", "Tools");
  const running = tools.some((block) => {
    const status = this.normalizeBlockStatus(block && block.status);
    return status === "running" || status === "pending";
  });
  if (running) {
    return {
      tone: "working",
      text: tFromContext(this, "view.runtime.toolRunning", "Running: {statusText}{suffix}", { statusText, suffix }),
    };
  }

  const failed = tools.some((block) => this.normalizeBlockStatus(block && block.status) === "error");
  if (failed) {
    return {
      tone: "error",
      text: tFromContext(this, "view.runtime.toolFailed", "Tool failed: {statusText}{suffix}", { statusText, suffix }),
    };
  }

  return { tone: "info", text: tFromContext(this, "view.runtime.toolDone", "Tool finished, preparing response...") };
}

function syncRuntimeStatusToPendingTail() {
  const container = this.elements.messages;
  if (!container) return;
  const rows = container.querySelectorAll(".oc-message-assistant.is-pending");
  if (!rows || !rows.length) return;
  const row = rows[rows.length - 1];
  if (!row) return;

  const body = row.querySelector(".oc-message-content");
  if (!body) return;

  const messageId = String((row.dataset && row.dataset.messageId) || "").trim();
  const draft = messageId
    ? this.plugin.sessionStore.getActiveMessages().find((msg) => msg && msg.id === messageId)
    : null;
  const draftText = draft && typeof draft.text === "string" ? draft.text.trim() : "";

  body.removeClass("oc-runtime-tail", "is-info", "is-working", "is-error");
  if (draftText) return;

  const statusText = String((this.runtimeStatusState && this.runtimeStatusState.text) || "").trim();
  body.setText(statusText);
  if (!statusText) return;

  body.addClass("oc-runtime-tail");
  const tone = String((this.runtimeStatusState && this.runtimeStatusState.tone) || "info");
  if (tone === "error") body.addClass("is-error");
  else if (tone === "working") body.addClass("is-working");
  else body.addClass("is-info");
}

function setRuntimeStatus(text, tone = "info") {
  const normalizedText = String(text || "").trim();
  const normalizedTone = tone === "error" || tone === "working" ? tone : "info";
  this.runtimeStatusState = { text: normalizedText, tone: normalizedTone };
  this.syncRuntimeStatusToPendingTail();
}

module.exports = { runtimeStatusMethods: {
  runtimeStatusFromBlocks,
  syncRuntimeStatusToPendingTail,
  setRuntimeStatus,
} };
