const { Notice, MarkdownRenderer, setIcon } = require("obsidian");
const { normalizeMarkdownForDisplay } = require("../assistant-payload-utils");

function renderMessages() {
  const container = this.elements.messages;
  if (!container) return;
  container.empty();

  const messages = this.plugin.sessionStore.getActiveMessages();
  this.pruneQuestionAnswerStates(messages);
  if (!messages.length) {
    const welcome = container.createDiv({ cls: "oc-welcome" });
    welcome.createDiv({ cls: "oc-welcome-greeting", text: "今天想整理什么？" });
    welcome.createDiv({ cls: "oc-empty", text: "发送一条消息，或先从技能下拉中选择一个技能。" });
    this.renderInlineQuestionPanel(messages);
    return;
  }

  messages.forEach((m) => this.renderMessageItem(container, m));
  this.syncRuntimeStatusToPendingTail();
  container.scrollTop = container.scrollHeight;
  this.renderInlineQuestionPanel(messages);
}

function renderUserActions(row, message) {
  const actions = row.createDiv({ cls: "oc-user-msg-actions" });

  const copyBtn = actions.createEl("button", { cls: "oc-inline-action" });
  setIcon(copyBtn, "copy");
  copyBtn.setAttr("aria-label", "复制消息");
  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(message.text || "");
    new Notice("用户消息已复制");
  });

  const retryBtn = actions.createEl("button", { cls: "oc-inline-action" });
  setIcon(retryBtn, "rotate-ccw");
  retryBtn.setAttr("aria-label", "基于此消息重试");
  retryBtn.addEventListener("click", async () => {
    await this.sendPrompt(message.text || "");
  });
}

function attachCodeCopyButtons(container) {
  if (!container) return;
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".oc-copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "oc-copy-btn";
    btn.textContent = "复制";
    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      await navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
      new Notice("代码已复制");
    });
    pre.prepend(btn);
  });
}

function ensureReasoningContainer(row, openByDefault) {
  let details = row.querySelector(".oc-message-reasoning");
  if (!details) {
    details = document.createElement("details");
    details.addClass("oc-message-reasoning");
    details.createEl("summary", { text: "思考过程（可折叠）" });
    details.createDiv({ cls: "oc-message-reasoning-body" });
    const body = row.querySelector(".oc-message-content");
    if (body && body.parentElement === row) {
      row.insertBefore(details, body);
    } else {
      row.appendChild(details);
    }
  }
  if (openByDefault) details.open = true;
  return details.querySelector(".oc-message-reasoning-body");
}

function ensureBlocksContainer(row) {
  let container = row.querySelector(".oc-part-list");
  if (!container) {
    container = row.createDiv({ cls: "oc-part-list" });
  }
  return container;
}

function reorderAssistantMessageLayout(row) {
  if (!row) return;
  const body = row.querySelector(".oc-message-content");
  if (!body || body.parentElement !== row) return;

  const reasoning = row.querySelector(".oc-message-reasoning");
  if (reasoning && reasoning.parentElement === row) {
    row.insertBefore(reasoning, body);
  }

  const parts = row.querySelector(".oc-part-list");
  if (parts && parts.parentElement === row) {
    row.insertBefore(parts, body);
  }

  const meta = row.querySelector(".oc-message-meta");
  if (meta && meta.parentElement === row) {
    row.insertBefore(meta, body);
  }

  row.appendChild(body);
}

function normalizeBlockStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (["completed", "running", "pending", "error"].includes(value)) return value;
  return "pending";
}

function blockTypeLabel(type) {
  const value = String(type || "").trim();
  const map = {
    tool: "工具调用",
    subtask: "子任务",
    agent: "子代理",
    file: "文件",
    patch: "补丁",
    retry: "重试",
    compaction: "压缩",
    snapshot: "快照",
  };
  return map[value] || value || "输出";
}

function blockStatusLabel(status) {
  const value = this.normalizeBlockStatus(status);
  if (value === "completed") return "已完成";
  if (value === "running") return "进行中";
  if (value === "error") return "失败";
  return "等待中";
}

function toolDisplayName(block) {
  if (!block || typeof block !== "object") return "";
  if (typeof block.tool === "string" && block.tool.trim()) return block.tool.trim();
  const summary = typeof block.summary === "string" ? block.summary.trim() : "";
  const summaryMatch = summary.match(/^工具:\s*(.+)$/);
  if (summaryMatch && summaryMatch[1]) return summaryMatch[1].trim();
  const title = typeof block.title === "string" ? block.title.trim() : "";
  return title;
}

function visibleAssistantBlocks(rawBlocks) {
  const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];
  return blocks.filter((block) => {
    if (!block || typeof block !== "object") return false;
    const type = String(block.type || "").trim().toLowerCase();
    if (!type) return false;
    if (type === "step-start" || type === "step-finish") return false;
    return true;
  });
}

function hasReasoningBlock(rawBlocks) {
  const blocks = this.visibleAssistantBlocks(rawBlocks);
  return blocks.some((block) => String((block && block.type) || "").trim().toLowerCase() === "reasoning");
}

function removeStandaloneReasoningContainer(row) {
  if (!row) return;
  const reasoning = row.querySelector(".oc-message-reasoning:not(.oc-part-reasoning)");
  if (reasoning && reasoning.parentElement) {
    reasoning.parentElement.removeChild(reasoning);
  }
}

function findMessageRow(messageId) {
  if (!this.elements.messages || !messageId) return null;
  const rows = this.elements.messages.querySelectorAll(".oc-message");
  for (const row of rows) {
    if (row && row.dataset && row.dataset.messageId === messageId) return row;
  }
  return null;
}

function renderReasoningPart(container, block, messagePending) {
  const details = container.createEl("details", { cls: "oc-message-reasoning oc-part-reasoning" });
  const status = this.normalizeBlockStatus(block && block.status);
  details.addClass(`is-${status}`);
  details.setAttr("data-part-type", "reasoning");

  const summary = details.createEl("summary");
  summary.createSpan({ cls: "oc-part-reasoning-title", text: "思考过程（可折叠）" });
  summary.createSpan({
    cls: "oc-part-reasoning-status",
    text: this.blockStatusLabel(status),
  });

  const body = details.createDiv({ cls: "oc-message-reasoning-body" });
  const detailText = typeof block.detail === "string" ? block.detail : "";
  const content = normalizeMarkdownForDisplay(detailText);
  if (content) {
    MarkdownRenderer.render(this.app, content, body, "", this.plugin).then(() => {
      this.attachCodeCopyButtons(body);
    });
  } else {
    body.setText("...");
  }

  details.open = Boolean(messagePending || status === "running" || status === "pending");
}

function renderAssistantBlocks(row, message) {
  const blocks = this.visibleAssistantBlocks(message.blocks);
  const container = this.ensureBlocksContainer(row);
  container.empty();
  if (!blocks.length) {
    container.toggleClass("is-empty", true);
    return;
  }
  container.toggleClass("is-empty", false);

  blocks.forEach((block) => {
    if (block && String(block.type || "").trim().toLowerCase() === "reasoning") {
      this.renderReasoningPart(container, block, Boolean(message && message.pending));
      return;
    }

    const card = container.createDiv({ cls: "oc-part-card" });
    const status = this.normalizeBlockStatus(block && block.status);
    card.addClass(`is-${status}`);
    card.setAttr("data-part-type", String((block && block.type) || ""));

    const head = card.createDiv({ cls: "oc-part-head" });
    head.createDiv({
      cls: "oc-part-type",
      text: this.blockTypeLabel(block && block.type),
    });
    head.createDiv({
      cls: "oc-part-status",
      text: this.blockStatusLabel(status),
    });

    const title = typeof block.title === "string" ? block.title.trim() : "";
    if (title) {
      card.createDiv({ cls: "oc-part-title", text: title });
    }

    const summary = typeof block.summary === "string" ? block.summary.trim() : "";
    if (summary) {
      card.createDiv({ cls: "oc-part-summary", text: summary });
    }
    const preview = typeof block.preview === "string" ? block.preview.trim() : "";
    if (preview) {
      card.createDiv({ cls: "oc-part-preview", text: preview });
    }

    if (block && block.type === "tool" && block.tool === "question" && this.extractQuestionItemsFromBlock(block).length) {
      card.createDiv({
        cls: "oc-question-inline-note",
        text: "请在下方面板中回答。",
      });
    }

    const detail = typeof block.detail === "string" ? block.detail.trim() : "";
    if (detail) {
      const details = card.createEl("details", { cls: "oc-part-details" });
      details.createEl("summary", { text: "查看详情" });
      details.createEl("pre", { cls: "oc-part-detail", text: detail });
    }
  });
}

function renderAssistantMeta(row, message) {
  const metaText = typeof message.meta === "string" ? message.meta.trim() : "";
  if (!metaText) return;
  const pre = row.createEl("pre", { cls: "oc-message-meta", text: metaText });
  if (/error|failed|失败|status=\d{3}/i.test(metaText)) {
    pre.addClass("is-error");
  }
}

function renderMessageItem(parent, message) {
  const row = parent.createDiv({ cls: ["oc-message", `oc-message-${message.role}`] });
  row.dataset.messageId = message.id || "";
  if (message.pending) row.addClass("is-pending");

  const head = row.createDiv({ cls: "oc-msg-head" });
  head.createDiv({ cls: "oc-msg-role", text: message.role.toUpperCase() });
  if (message.error) head.createDiv({ cls: "oc-msg-error", text: message.error });

  const body = row.createDiv({ cls: "oc-message-content" });

  if (message.pending) {
    let pendingText = typeof message.text === "string" ? message.text : "";
    const hasPendingText = Boolean(String(pendingText || "").trim());
    const runtimeText = String((this.runtimeStatusState && this.runtimeStatusState.text) || "").trim();
    const runtimeTone = String((this.runtimeStatusState && this.runtimeStatusState.tone) || "info");
    const canShowRuntimeStatus = message.role === "assistant" && !hasPendingText && Boolean(runtimeText);
    body.removeClass("oc-runtime-tail", "is-info", "is-working", "is-error");
    if (canShowRuntimeStatus) {
      pendingText = runtimeText;
      body.addClass("oc-runtime-tail");
      if (runtimeTone === "error") body.addClass("is-error");
      else if (runtimeTone === "working") body.addClass("is-working");
      else body.addClass("is-info");
    }
    body.setText(pendingText);
    const hasReasoningBlocks = this.hasReasoningBlock(message.blocks);
    if (message.role === "assistant" && message.reasoning && !hasReasoningBlocks) {
      const reasoningBody = this.ensureReasoningContainer(row, true);
      if (reasoningBody) reasoningBody.textContent = message.reasoning;
    } else if (message.role === "assistant" && hasReasoningBlocks) {
      this.removeStandaloneReasoningContainer(row);
    }
    if (message.role === "assistant") {
      this.renderAssistantBlocks(row, message);
      this.renderAssistantMeta(row, message);
      this.reorderAssistantMessageLayout(row);
    }
    return;
  }

  const textForRender = normalizeMarkdownForDisplay(message.text || "");
  const hasReasoning = Boolean(message.reasoning && String(message.reasoning).trim());
  const hasReasoningBlocks = this.hasReasoningBlock(message.blocks);
  const hasBlocks = this.visibleAssistantBlocks(message.blocks).length > 0;
  const fallbackText = hasReasoning || hasBlocks ? "(结构化输出已返回，可展开下方详情查看。)" : "";
  MarkdownRenderer.render(this.app, textForRender || fallbackText, body, "", this.plugin).then(() => {
    this.attachCodeCopyButtons(body);
  });

  if (message.role === "assistant" && hasReasoning && !hasReasoningBlocks) {
    const reasoningBody = this.ensureReasoningContainer(row, !textForRender);
    if (reasoningBody) {
      const reasoningText = normalizeMarkdownForDisplay(message.reasoning || "");
      MarkdownRenderer.render(this.app, reasoningText, reasoningBody, "", this.plugin).then(() => {
        this.attachCodeCopyButtons(reasoningBody);
      });
    }
  } else if (message.role === "assistant" && hasReasoningBlocks) {
    this.removeStandaloneReasoningContainer(row);
  }
  if (message.role === "assistant") {
    this.renderAssistantBlocks(row, message);
    this.renderAssistantMeta(row, message);
    this.reorderAssistantMessageLayout(row);
  }

  if (message.role === "user") {
    this.renderUserActions(row, message);
  }
}

module.exports = { messageRendererMethods: {
  renderMessages,
  renderUserActions,
  attachCodeCopyButtons,
  ensureReasoningContainer,
  ensureBlocksContainer,
  reorderAssistantMessageLayout,
  normalizeBlockStatus,
  blockTypeLabel,
  blockStatusLabel,
  toolDisplayName,
  visibleAssistantBlocks,
  hasReasoningBlock,
  removeStandaloneReasoningContainer,
  findMessageRow,
  renderReasoningPart,
  renderAssistantBlocks,
  renderAssistantMeta,
  renderMessageItem,
} };
