const { Notice } = require("obsidian");
const { normalizeMarkdownForDisplay } = require("../../assistant-payload-utils");
const { domUtils } = require("./dom-utils");
const { tFromContext } = require("../../i18n-runtime");

const {
  safeSetIcon,
  copyTextToClipboard,
  applyCopyGlyph,
  showCopyFeedback,
} = domUtils;

function renderMessages(options = {}) {
  const container = this.elements.messages;
  if (!container) return;
  const cfg = options && typeof options === "object" ? options : {};
  const forceBottom = Boolean(cfg.forceBottom);
  if (forceBottom) this.autoScrollEnabled = true;
  this.bindMessagesScrollTracking();
  const shouldStickToBottom = forceBottom || this.shouldAutoScrollMessages();
  const prevScrollTop = Number(container.scrollTop || 0);
  container.empty();

  const messages = this.plugin.sessionStore.getActiveMessages();
  this.pruneQuestionAnswerStates(messages);
  if (!messages.length) {
    const welcome = container.createDiv({ cls: "oc-welcome" });
    welcome.createDiv({
      cls: "oc-welcome-greeting",
      text: tFromContext(this, "view.welcome.greeting", "What would you like to organize today?"),
    });
    welcome.createDiv({
      cls: "oc-empty",
      text: tFromContext(this, "view.welcome.empty", "Send a message, or pick a skill from the dropdown first."),
    });
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
  copyBtn.setAttr("aria-label", tFromContext(this, "view.message.copy", "Copy message"));
  copyBtn.addEventListener("click", async () => {
    await copyTextToClipboard(message.text || "");
    new Notice(tFromContext(this, "view.message.copied", "Message copied"));
  });

  const retryBtn = actions.createEl("button", { cls: "oc-inline-action" });
  retryBtn.setAttr("type", "button");
  safeSetIcon(retryBtn, "rotate-ccw");
  retryBtn.setAttr("aria-label", tFromContext(this, "view.message.retry", "Retry from this message"));
  retryBtn.addEventListener("click", async () => {
    await this.sendPrompt(message.text || "");
  });
}

function addTextCopyButton(textBlock, sourceText) {
  if (!textBlock || textBlock.querySelector(".oc-text-copy-btn")) return;
  const copyBtn = textBlock.createEl("button", { cls: "oc-text-copy-btn" });
  copyBtn.setAttr("type", "button");
  copyBtn.setAttr("aria-label", tFromContext(this, "view.message.copyBlock", "Copy text block"));
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
      new Notice(tFromContext(this, "view.message.copyFailed", "Copy failed"));
    }
  });
}

function normalizeMessageLinkedContextFiles(message) {
  const rawPaths = Array.isArray(message && message.linkedContextFiles) ? message.linkedContextFiles : [];
  const seen = new Set();
  const normalized = [];
  rawPaths.forEach((rawPath) => {
    const next = String(rawPath || "").trim().replace(/^\/+/, "");
    if (!next || seen.has(next)) return;
    seen.add(next);
    normalized.push(next);
  });
  return normalized;
}

function linkedContextDisplayName(pathValue) {
  const parts = String(pathValue || "").split("/");
  return parts.length ? parts[parts.length - 1] || String(pathValue || "") : String(pathValue || "");
}

function renderUserLinkedContextFiles(row, message) {
  const linkedFiles = normalizeMessageLinkedContextFiles(message);
  if (!linkedFiles.length) return;

  const panel = row.createDiv({ cls: "oc-message-context-files" });
  panel.createDiv({
    cls: "oc-message-context-label",
    text: tFromContext(this, "view.message.linkedFiles", "Linked files"),
  });
  const chips = panel.createDiv({ cls: "oc-message-context-list" });

  linkedFiles.forEach((pathValue) => {
    const chip = chips.createEl("a", {
      cls: "oc-message-context-chip internal-link",
      attr: {
        href: pathValue,
        "data-href": pathValue,
        title: pathValue,
      },
    });
    const iconEl = chip.createSpan({ cls: "oc-message-context-chip-icon" });
    safeSetIcon(iconEl, "file-text");
    chip.createSpan({
      cls: "oc-message-context-chip-name",
      text: linkedContextDisplayName(pathValue),
    });
  });

  if (typeof this.attachInternalLinkHandlers === "function") {
    this.attachInternalLinkHandlers(panel);
  }
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
  const localizedFallback = hasReasoning || hasBlocks
    ? tFromContext(this, "view.message.structuredFallback", "(Structured output returned. Expand details below.)")
    : "";
  const finalText = textForRender || localizedFallback;

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
    this.renderUserLinkedContextFiles(row, message);
    this.renderUserActions(row, message);
  }
}


const messageListMethods = {
  renderMessages,
  renderUserActions,
  addTextCopyButton,
  renderUserLinkedContextFiles,
  renderMessageItem,
};

module.exports = { messageListMethods };
