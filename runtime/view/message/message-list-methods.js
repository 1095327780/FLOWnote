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

const MAX_RENDER_MARKDOWN_CHARS = 24000;
const MAX_RENDER_REASONING_CHARS = 16000;

function clampRenderText(value, maxLen = MAX_RENDER_MARKDOWN_CHARS) {
  const raw = String(value || "");
  const limit = Math.max(512, Number(maxLen) || MAX_RENDER_MARKDOWN_CHARS);
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}\n\n...(truncated ${raw.length - limit} chars)`;
}

function syncPatchDiffCacheSession(view) {
  if (!view || !view.plugin || !view.plugin.sessionStore) return;
  const activeSessionId = String(view.plugin.sessionStore.state().activeSessionId || "").trim();
  const previousSessionId = String(view.patchDiffCacheSessionId || "").trim();
  if (activeSessionId === previousSessionId) return;
  view.patchDiffCacheSessionId = activeSessionId;
  if (view.patchDiffCache instanceof Map) view.patchDiffCache.clear();
  if (view.patchDiffInflight instanceof Map) view.patchDiffInflight.clear();
}

function renderMessages(options = {}) {
  const container = this.elements.messages;
  if (!container) return;
  syncPatchDiffCacheSession(this);
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
      text: tFromContext(this, "view.welcome.empty", "Send a message, or type / to pick a skill command."),
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
  if (!copyBtn.querySelector("svg")) copyBtn.setText("C");
  copyBtn.setAttr("aria-label", tFromContext(this, "view.message.copy", "Copy message"));
  copyBtn.setAttr("title", tFromContext(this, "view.message.copy", "Copy message"));
  copyBtn.addEventListener("click", async () => {
    await copyTextToClipboard(message.text || "");
    new Notice(tFromContext(this, "view.message.copied", "Message copied"));
  });

  const retryBtn = actions.createEl("button", { cls: "oc-inline-action" });
  retryBtn.setAttr("type", "button");
  safeSetIcon(retryBtn, "rotate-ccw");
  if (!retryBtn.querySelector("svg")) retryBtn.setText("↺");
  retryBtn.setAttr("aria-label", tFromContext(this, "view.message.retry", "Retry from this message"));
  retryBtn.setAttr("title", tFromContext(this, "view.message.retry", "Retry from this message"));
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

function isLinkedContextFolderPath(view, pathValue) {
  const normalized = String(pathValue || "").trim().replace(/^\/+/, "");
  if (!normalized) return false;
  const vault = view && view.app && view.app.vault;
  if (!vault || typeof vault.getAbstractFileByPath !== "function") return false;
  const target = vault.getAbstractFileByPath(normalized);
  return Boolean(target && Array.isArray(target.children));
}

function renderUserLinkedContextFiles(row, message) {
  const linkedFiles = normalizeMessageLinkedContextFiles(message);
  if (!linkedFiles.length) return;

  const panel = row.createDiv({ cls: "oc-message-context-files" });
  panel.createDiv({
    cls: "oc-message-context-label",
    text: tFromContext(this, "view.message.linkedFiles", "Linked context"),
  });
  const chips = panel.createDiv({ cls: "oc-message-context-list" });

  linkedFiles.forEach((pathValue) => {
    const isFolder = isLinkedContextFolderPath(this, pathValue);
    const chip = isFolder
      ? chips.createDiv({
        cls: "oc-message-context-chip is-folder",
        attr: { title: pathValue },
      })
      : chips.createEl("a", {
        cls: "oc-message-context-chip internal-link",
        attr: {
          href: pathValue,
          "data-href": pathValue,
          title: pathValue,
        },
      });
    const iconEl = chip.createSpan({ cls: "oc-message-context-chip-icon" });
    safeSetIcon(iconEl, isFolder ? "folder" : "file-text");
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
    const hasStreamTextBlocks = message.role === "assistant" && this
      .visibleAssistantBlocks(message.blocks)
      .some((block) => String((block && block.type) || "").trim().toLowerCase() === "stream-text");
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
    if (message.role === "assistant" && hasPendingText && hasStreamTextBlocks) {
      body.empty();
    } else if (message.role === "assistant" && pendingText.trim()) {
      const pendingMarkdown = normalizeMarkdownForDisplay(
        clampRenderText(pendingText, MAX_RENDER_MARKDOWN_CHARS),
      );
      this.renderMarkdownSafely(body, pendingMarkdown, () => {
        this.enhanceCodeBlocks(body);
      });
    } else {
      body.setText(pendingText);
    }

    const hasReasoningBlocks = this.hasReasoningBlock(message.blocks);
    if (message.role === "assistant" && message.reasoning && !hasReasoningBlocks) {
      const reasoningBody = this.ensureReasoningContainer(row, true);
      if (reasoningBody) reasoningBody.textContent = clampRenderText(message.reasoning, MAX_RENDER_REASONING_CHARS);
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

  const textForRender = normalizeMarkdownForDisplay(clampRenderText(message.text || "", MAX_RENDER_MARKDOWN_CHARS));
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
        const reasoningText = normalizeMarkdownForDisplay(
          clampRenderText(message.reasoning || "", MAX_RENDER_REASONING_CHARS),
        );
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
