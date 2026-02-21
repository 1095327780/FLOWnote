const { Notice } = require("obsidian");
const { normalizeMarkdownForDisplay } = require("../../assistant-payload-utils");
const { domUtils } = require("./dom-utils");

const {
  safeSetIcon,
  copyTextToClipboard,
  applyCopyGlyph,
  showCopyFeedback,
} = domUtils;

function renderMessages() {
  const container = this.elements.messages;
  if (!container) return;
  this.bindMessagesScrollTracking();
  const shouldStickToBottom = this.shouldAutoScrollMessages();
  const prevScrollTop = Number(container.scrollTop || 0);
  container.empty();

  const messages = this.plugin.sessionStore.getActiveMessages();
  this.pruneQuestionAnswerStates(messages);
  if (!messages.length) {
    const welcome = container.createDiv({ cls: "oc-welcome" });
    welcome.createDiv({ cls: "oc-welcome-greeting", text: "今天想整理什么？" });
    welcome.createDiv({ cls: "oc-empty", text: "发送一条消息，或先从技能下拉中选择一个技能。" });
    this.renderInlineQuestionPanel(messages);
    if (shouldStickToBottom) {
      this.scheduleScrollMessagesToBottom(true);
    } else {
      container.scrollTop = 0;
    }
    return;
  }

  messages.forEach((m) => this.renderMessageItem(container, m));
  this.syncRuntimeStatusToPendingTail();
  this.renderInlineQuestionPanel(messages);
  if (shouldStickToBottom) {
    this.scheduleScrollMessagesToBottom(true);
  } else {
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(prevScrollTop, maxTop));
  }
}

function renderUserActions(row, message) {
  const actions = row.createDiv({ cls: "oc-user-msg-actions" });

  const copyBtn = actions.createEl("button", { cls: "oc-inline-action" });
  copyBtn.setAttr("type", "button");
  safeSetIcon(copyBtn, "copy");
  copyBtn.setAttr("aria-label", "复制消息");
  copyBtn.addEventListener("click", async () => {
    await copyTextToClipboard(message.text || "");
    new Notice("用户消息已复制");
  });

  const retryBtn = actions.createEl("button", { cls: "oc-inline-action" });
  retryBtn.setAttr("type", "button");
  safeSetIcon(retryBtn, "rotate-ccw");
  retryBtn.setAttr("aria-label", "基于此消息重试");
  retryBtn.addEventListener("click", async () => {
    await this.sendPrompt(message.text || "");
  });
}

function addTextCopyButton(textBlock, sourceText) {
  if (!textBlock || textBlock.querySelector(".oc-text-copy-btn")) return;
  const copyBtn = textBlock.createEl("button", { cls: "oc-text-copy-btn" });
  copyBtn.setAttr("type", "button");
  copyBtn.setAttr("aria-label", "复制文本块");
  applyCopyGlyph(copyBtn);

  copyBtn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyTextToClipboard(sourceText || "");
      showCopyFeedback(copyBtn, () => {
        applyCopyGlyph(copyBtn);
      });
    } catch {
      new Notice("复制失败");
    }
  });
}


function renderMessageItem(parent, message) {
  const row = parent.createDiv({ cls: ["oc-message", `oc-message-${message.role}`] });
  row.dataset.messageId = message.id || "";
  if (message.pending) row.addClass("is-pending");

  const head = row.createDiv({ cls: "oc-msg-head" });
  head.createDiv({ cls: "oc-msg-role", text: message.role.toUpperCase() });
  if (message.error) head.createDiv({ cls: "oc-msg-error", text: message.error });

  const body = row.createDiv({ cls: "oc-message-content", attr: { dir: "auto" } });

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
  const finalText = textForRender || fallbackText;

  if (finalText) {
    const textBlock = body.createDiv({ cls: "oc-text-block" });
    this.renderMarkdownSafely(textBlock, finalText, () => {
      this.enhanceCodeBlocks(textBlock);
      if (message.role === "assistant") {
        this.addTextCopyButton(textBlock, finalText);
      }
    });
  }

  if (message.role === "assistant" && hasReasoning && !hasReasoningBlocks) {
    const reasoningBody = this.ensureReasoningContainer(row, !textForRender);
    if (reasoningBody) {
      const reasoningText = normalizeMarkdownForDisplay(message.reasoning || "");
      this.renderMarkdownSafely(reasoningBody, reasoningText, () => {
        this.enhanceCodeBlocks(reasoningBody);
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


const messageListMethods = {
  renderMessages,
  renderUserActions,
  addTextCopyButton,
  renderMessageItem,
};

module.exports = { messageListMethods };
