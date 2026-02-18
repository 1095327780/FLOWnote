function runtimeStatusFromBlocks(rawBlocks) {
  const blocks = this.visibleAssistantBlocks(rawBlocks);
  const tools = blocks.filter((block) => block && String(block.type || "").trim().toLowerCase() === "tool");
  if (!tools.length) return null;

  const names = [...new Set(tools.map((block) => this.toolDisplayName(block)).filter(Boolean))];
  const shortNames = names.slice(0, 3).join(", ");
  const suffix = names.length > 3 ? "…" : "";
  const statusText = shortNames || "工具";
  const running = tools.some((block) => {
    const status = this.normalizeBlockStatus(block && block.status);
    return status === "running" || status === "pending";
  });
  if (running) {
    return { tone: "working", text: `正在调用：${statusText}${suffix}` };
  }

  const failed = tools.some((block) => this.normalizeBlockStatus(block && block.status) === "error");
  if (failed) {
    return { tone: "error", text: `工具执行失败：${statusText}${suffix}` };
  }

  return { tone: "working", text: "工具调用完成，正在整理回复…" };
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
