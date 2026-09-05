const { Notice, Platform = {} } = require("obsidian");
const { normalizeMarkdownForDisplay } = require("../../assistant-payload-utils");
const { domUtils } = require("./dom-utils");
const { executionStatusLabel } = require("./execution-status");
const { tFromContext } = require("../../i18n-runtime");
const { resolveUserExecutionAction } = require("./user-execution-action");
const { terminalUserMessage } = require("./terminal-user-message");
const { blockUtilsMethods } = require("./block-utils");

const {
  safeSetIcon,
  copyTextToClipboard,
  applyCopyGlyph,
  showCopyFeedback,
} = domUtils;

// Empty-state suggestion cards mapped onto the user's highest-value
// flows. Order is by frequency-of-use, not alphabetical.
// Each entry has a category color that tints the card's bottom border.
const SUGGEST_CARDS = [
  { cmd: "/ah-note",    titleZh: "今日聚焦",      titleEn: "Today Focus",      hintZh: "开启今日的日记 + 任务", hintEn: "Start today's note and tasks", emoji: "🌅", accent: "var(--m-accent)" },
  { cmd: "/ah-card",    titleZh: "新建永久笔记",  titleEn: "Permanent Note",   hintZh: "把灵感做成卡片",        hintEn: "Turn an idea into a card", emoji: "📝", accent: "var(--m-accent-warm)" },
  { cmd: "/ah-capture", titleZh: "速记一段",      titleEn: "Quick Capture",    hintZh: "倒进收件箱再整理",      hintEn: "Drop it into the inbox", emoji: "💡", accent: "var(--m-accent-lime)" },
  { cmd: "/ah-read",    titleZh: "记录文献",      titleEn: "Reading Note",     hintZh: "B 站 / 书 / 文章",       hintEn: "Video / book / article", emoji: "📚", accent: "var(--m-accent-violet)" },
  { cmd: "/ah-review",  titleZh: "本周回顾",      titleEn: "Weekly Review",    hintZh: "回看本周的笔记节奏",    hintEn: "Review this week's rhythm", emoji: "🔁", accent: "var(--m-accent-warm)" },
  { cmd: "/ah",         titleZh: "总入口",        titleEn: "Main Router",      hintZh: "不确定？让 AI 路由",     hintEn: "Not sure? Let AI route it", emoji: "🌳", accent: "var(--m-accent)" },
];

function isZhContext(viewCtx) {
  if (viewCtx && viewCtx.plugin && typeof viewCtx.plugin.getEffectiveLocale === "function") {
    return viewCtx.plugin.getEffectiveLocale() === "zh-CN";
  }
  return false;
}

function insertSuggestionCommand(viewCtx, card) {
  const inputEl = viewCtx.elements && viewCtx.elements.input;
  if (!inputEl) return;
  inputEl.value = `${card.cmd} `;
  inputEl.focus();
  inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
  if (typeof viewCtx.syncLinkedContextPickerFromInputMention === "function") {
    viewCtx.syncLinkedContextPickerFromInputMention();
  }
}

function renderSuggestionCards(viewCtx, wrap, isMobile) {
  const grid = wrap.createDiv({
    cls: isMobile ? "oc-mobile-suggest-grid" : "oc-suggest-grid",
  });
  const useZh = isZhContext(viewCtx);
  for (const card of SUGGEST_CARDS) {
    const item = grid.createEl("button", {
      cls: isMobile ? "oc-mobile-suggest-card" : "oc-suggest-card",
      attr: { type: "button" },
    });
    item.style.setProperty("--card-accent", card.accent);
    item.createDiv({
      cls: isMobile ? "oc-mobile-suggest-emoji" : "oc-suggest-emoji",
      text: card.emoji,
    });
    item.createDiv({
      cls: isMobile ? "oc-mobile-suggest-cmd" : "oc-suggest-cmd",
      text: card.cmd,
    });
    item.createDiv({
      cls: isMobile ? "oc-mobile-suggest-title" : "oc-suggest-title",
      text: useZh ? card.titleZh : card.titleEn,
    });
    item.createDiv({
      cls: isMobile ? "oc-mobile-suggest-hint" : "oc-suggest-hint",
      text: useZh ? card.hintZh : card.hintEn,
    });
    item.addEventListener("click", () => insertSuggestionCommand(viewCtx, card));
  }
}

function renderDesktopWelcome(viewCtx, container) {
  const welcome = container.createDiv({ cls: "oc-welcome" });
  welcome.createDiv({
    cls: "oc-welcome-greeting",
    text: tFromContext(viewCtx, "view.welcome.greeting", "What would you like to organize today?"),
  });
  welcome.createDiv({
    cls: "oc-empty",
    text: tFromContext(viewCtx, "view.welcome.empty", "Send a message, or type / to pick a skill command."),
  });
  renderSuggestionCards(viewCtx, welcome, false);
}

/**
 * Render the mobile-only welcome screen. A small greeting plus a 2x3
 * grid of category-tinted skill cards. Tapping a card inserts the
 * slash command into the composer and focuses it.
 */
function renderMobileWelcome(viewCtx, container) {
  const wrap = container.createDiv({ cls: "oc-welcome" });
  wrap.createDiv({
    cls: "oc-welcome-greeting",
    text: tFromContext(viewCtx, "view.welcome.mobileGreeting", "你想做点什么？"),
  });
  wrap.createDiv({
    cls: "oc-empty",
    text: tFromContext(viewCtx, "view.welcome.mobileHint", "选一张卡片快速开始，或在下面直接说话。"),
  });
  renderSuggestionCards(viewCtx, wrap, true);
}

const MAX_RENDER_MARKDOWN_CHARS = 24000;
const MAX_RENDER_REASONING_CHARS = 16000;

function clampRenderText(value, maxLen = MAX_RENDER_MARKDOWN_CHARS) {
  const raw = String(value || "");
  const limit = Math.max(512, Number(maxLen) || MAX_RENDER_MARKDOWN_CHARS);
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}\n\n...(truncated ${raw.length - limit} chars)`;
}

function mergeTerminalWarning(text, terminalText, terminalMessageKey) {
  const primary = String(text || "").trim();
  const warning = String(terminalText || "").trim();
  if (terminalMessageKey === "terminalInterruptedMutation" && primary && warning) {
    return `${primary}\n\n${warning}`;
  }
  return primary || warning;
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
    if (Platform.isMobile) {
      renderMobileWelcome(this, container);
    } else {
      renderDesktopWelcome(this, container);
    }
    this.renderInlineQuestionPanel(messages);
    if (shouldStickToBottom) {
      this.scheduleScrollMessagesToBottom(true);
    } else {
      container.scrollTop = 0;
    }
    return;
  }

  messages.forEach((m) => this.renderMessageItem(container, m));
  this.syncRuntimeStatusToPendingMessage();
  this.renderInlineQuestionPanel(messages);
  if (shouldStickToBottom) {
    this.scheduleScrollMessagesToBottom(true);
  } else {
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(prevScrollTop, maxTop));
  }
}

function refreshMessageItem(messageId) {
  const id = String(messageId || "").trim();
  const container = this.elements && this.elements.messages;
  if (!id || !container) return false;
  const message = this.plugin.sessionStore.getActiveMessages()
    .find((item) => item && String(item.id || "") === id);
  const row = typeof this.findMessageRow === "function" ? this.findMessageRow(id) : null;
  if (!message || !row || message.role !== "assistant") return false;

  const shouldStickToBottom = this.shouldAutoScrollMessages();
  const previousScrollTop = Number(container.scrollTop || 0);
  row.dataset.messageId = id;
  row.classList.toggle("is-pending", Boolean(message.pending));
  ["running", "completed", "failed", "blocked", "cancelled", "suspended", "interrupted"]
    .forEach((status) => row.classList.remove(`is-${status}`));
  const executionStatus = String(message.status || "").trim().toLowerCase();
  if (executionStatus) row.classList.add(`is-${executionStatus}`);

  const head = row.querySelector(".oc-msg-head");
  const previousStatus = head && head.querySelector(".oc-msg-status");
  if (previousStatus) previousStatus.remove();
  const statusLabel = executionStatusLabel(this, executionStatus);
  row.classList.toggle("has-execution-status", Boolean(statusLabel));
  if (head && statusLabel) head.createDiv({ cls: "oc-msg-status", text: statusLabel });

  const body = row.querySelector(".oc-message-content");
  if (!body) return false;
  const runtimeStatus = row.querySelector(".oc-runtime-status");
  if (!message.pending && runtimeStatus) runtimeStatus.remove();
  body.removeClass("oc-runtime-tail", "is-info", "is-working", "is-error");
  const textForRender = normalizeMarkdownForDisplay(
    clampRenderText(message.text || "", MAX_RENDER_MARKDOWN_CHARS),
  );
  const hasReasoning = Boolean(message.reasoning && String(message.reasoning).trim());
  const hasReasoningBlocks = this.hasReasoningBlock(message.blocks);
  const hasBlocks = this.visibleAssistantBlocks(message.blocks).length > 0;
  const terminalMessageKey = terminalUserMessage(message, {
    hasStructuredContent: hasReasoning || hasBlocks,
  });
  const terminalText = terminalMessageKey
    ? tFromContext(this, `view.message.${terminalMessageKey}`, "This response was not completed. Try again.")
    : "";
  const hasTimelineFinal = blockUtilsMethods.hasTimelineFinalBlock(message.blocks);
  const finalText = hasTimelineFinal
    ? ""
    : mergeTerminalWarning(textForRender, terminalText, terminalMessageKey);

  body.empty();
  if (finalText) {
    const textBlock = body.createDiv({ cls: "oc-text-block" });
    this.renderMarkdownSafely(textBlock, finalText, () => {
      this.enhanceCodeBlocks(textBlock);
    });
  }

  if (hasReasoning && !hasReasoningBlocks) {
    const reasoningBody = this.ensureReasoningContainer(row, !textForRender);
    if (reasoningBody) {
      const reasoningText = normalizeMarkdownForDisplay(
        clampRenderText(message.reasoning || "", MAX_RENDER_REASONING_CHARS),
      );
      reasoningBody.empty();
      this.renderMarkdownSafely(reasoningBody, reasoningText, () => {
        this.enhanceCodeBlocks(reasoningBody);
      });
    }
  } else if (hasReasoningBlocks) {
    this.removeStandaloneReasoningContainer(row);
  }

  this.renderAssistantBlocks(row, message);
  const previousMeta = row.querySelector(".oc-message-meta");
  if (previousMeta) previousMeta.remove();
  this.renderAssistantMeta(row, message);
  if (typeof this.renderAssistantActions === "function") {
    this.renderAssistantActions(row, message, finalText);
  }
  this.reorderAssistantMessageLayout(row);

  const restoreViewport = () => {
    container.scrollLeft = 0;
    if (shouldStickToBottom) {
      container.scrollTop = container.scrollHeight;
      return;
    }
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(previousScrollTop, maxTop));
  };
  if (typeof this.withProgrammaticScroll === "function") {
    this.withProgrammaticScroll(container, restoreViewport);
  } else {
    restoreViewport();
  }
  return true;
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

  const messages = this.plugin && this.plugin.sessionStore
    && typeof this.plugin.sessionStore.getActiveMessages === "function"
    ? this.plugin.sessionStore.getActiveMessages()
    : [];
  const sessionStore = this.plugin && this.plugin.sessionStore;
  let sessionId = "";
  if (sessionStore && typeof sessionStore.state === "function") {
    try {
      sessionId = String((sessionStore.state() || {}).activeSessionId || "").trim();
    } catch (_error) {
      sessionId = "";
    }
  }
  const action = resolveUserExecutionAction(messages, message && message.id, {
    sessionStore,
    sessionId,
  });
  if (action.mode === "none") return;
  const retryBtn = actions.createEl("button", { cls: "oc-inline-action" });
  retryBtn.setAttr("type", "button");
  if (action.mode === "continue") {
    safeSetIcon(retryBtn, "play");
    if (!retryBtn.querySelector("svg")) retryBtn.setText("▶");
    retryBtn.setAttr("aria-label", tFromContext(this, "view.message.continue", "Continue suspended workflow"));
    retryBtn.setAttr("title", tFromContext(this, "view.message.continue", "Continue suspended workflow"));
    retryBtn.addEventListener("click", async () => {
      await this.sendPrompt("继续", {
        sessionId,
        continuationMessageId: action.assistantId,
        continuationRunId: action.runId,
      });
    });
  } else if (action.mode === "continuing") {
    safeSetIcon(retryBtn, "loader-circle");
    if (!retryBtn.querySelector("svg")) retryBtn.setText("…");
    retryBtn.disabled = true;
    retryBtn.setAttr("aria-disabled", "true");
    retryBtn.setAttr("aria-label", tFromContext(this, "view.message.continuing", "Continuing suspended workflow"));
    retryBtn.setAttr("title", tFromContext(this, "view.message.continuing", "Continuing suspended workflow"));
    if (typeof retryBtn.addClass === "function") retryBtn.addClass("is-disabled");
  } else if (action.mode === "inspect") {
    const uncertain = action.uncertain === true;
    safeSetIcon(retryBtn, uncertain ? "file-question" : "file-check-2");
    if (!retryBtn.querySelector("svg")) retryBtn.setText(uncertain ? "?" : "✓");
    const inspectLabel = uncertain
      ? tFromContext(this, "view.message.inspectUncertainChanges", "Check operation result before retrying")
      : tFromContext(this, "view.message.inspectChanges", "Inspect preserved changes");
    retryBtn.setAttr("aria-label", inspectLabel);
    retryBtn.setAttr("title", inspectLabel);
    retryBtn.addEventListener("click", () => {
      const target = typeof this.findMessageRow === "function" ? this.findMessageRow(action.assistantId) : null;
      if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
    });
  } else {
    safeSetIcon(retryBtn, "rotate-ccw");
    if (!retryBtn.querySelector("svg")) retryBtn.setText("↺");
    retryBtn.setAttr("aria-label", tFromContext(this, "view.message.retry", "Retry from this message"));
    retryBtn.setAttr("title", tFromContext(this, "view.message.retry", "Retry from this message"));
    retryBtn.addEventListener("click", async () => {
      await this.sendPrompt(message.text || "");
    });
  }
}

function addTextCopyButton(textBlock, sourceText) {
  if (!textBlock || textBlock.querySelector(".oc-text-copy-btn")) return;
  const copyBtn = textBlock.createEl("button", { cls: "oc-text-copy-btn" });
  copyBtn.setAttr("type", "button");
  copyBtn.setAttr("aria-label", tFromContext(this, "view.message.copy", "Copy response"));
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

function assistantCopyText(message, fallbackText = "") {
  const blocks = Array.isArray(message && message.blocks) ? message.blocks : [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (String(block && block.type || "").trim().toLowerCase() !== "stream-text") continue;
    if (String(block && block.phase || "").trim().toLowerCase() !== "final") continue;
    const text = String((block && (block.detail || block.text)) || "");
    if (text.trim()) return normalizeMarkdownForDisplay(text);
  }
  return normalizeMarkdownForDisplay(String(fallbackText || (message && message.text) || ""));
}

function renderAssistantActions(row, message, fallbackText = "") {
  if (!row) return;
  const sourceText = assistantCopyText(message, fallbackText);
  const previous = row.querySelector(".oc-assistant-msg-actions");
  if (previous) previous.remove();
  if (!sourceText.trim()) return;
  const actions = row.createDiv({ cls: "oc-assistant-msg-actions" });
  this.addTextCopyButton(actions, sourceText);
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
  const executionStatus = String(message.status || "").trim().toLowerCase();
  if (executionStatus) row.addClass(`is-${executionStatus}`);

  const head = row.createDiv({ cls: "oc-msg-head" });
  head.createDiv({ cls: "oc-msg-role", text: message.role.toUpperCase() });
  const statusLabel = executionStatusLabel(this, executionStatus);
  if (statusLabel) {
    row.addClass("has-execution-status");
    head.createDiv({ cls: "oc-msg-status", text: statusLabel });
  }
  // Errors recorded by transports and providers are diagnostics, not product
  // copy. Terminal projection below gives users a localized next action while
  // the detailed execution record remains available in the activity blocks.

  const body = row.createDiv({ cls: "oc-message-content", attr: { dir: "auto" } });

  if (message.pending) {
    let pendingText = typeof message.text === "string" ? message.text : "";
    const hasPendingText = Boolean(String(pendingText || "").trim());
    const hasStreamTextBlocks = message.role === "assistant" && this
      .visibleAssistantBlocks(message.blocks)
      .some((block) => String((block && block.type) || "").trim().toLowerCase() === "stream-text");
    body.removeClass("oc-runtime-tail", "is-info", "is-working", "is-error");
    if (message.role === "assistant" && hasPendingText && hasStreamTextBlocks) {
      body.empty();
    } else {
      body.setText(clampRenderText(pendingText, MAX_RENDER_MARKDOWN_CHARS));
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
  const terminalMessageKey = terminalUserMessage(message, {
    hasStructuredContent: hasReasoning || hasBlocks,
  });
  const terminalText = terminalMessageKey
    ? tFromContext(this, `view.message.${terminalMessageKey}`, "This response was not completed. Try again.")
    : "";
  const hasTimelineFinal = message.role === "assistant" && blockUtilsMethods.hasTimelineFinalBlock(message.blocks);
  const finalText = hasTimelineFinal
    ? ""
    : mergeTerminalWarning(textForRender, terminalText, terminalMessageKey);

  if (finalText) {
    const textBlock = body.createDiv({ cls: "oc-text-block" });
    this.renderMarkdownSafely(textBlock, finalText, () => {
      this.enhanceCodeBlocks(textBlock);
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
    if (typeof this.renderAssistantActions === "function") {
      this.renderAssistantActions(row, message, finalText);
    }
    this.reorderAssistantMessageLayout(row);
  }

  if (message.role === "user") {
    this.renderUserLinkedContextFiles(row, message);
    this.renderUserActions(row, message);
  }
}


const messageListMethods = {
  renderMessages,
  refreshMessageItem,
  renderUserActions,
  addTextCopyButton,
  renderAssistantActions,
  renderUserLinkedContextFiles,
  renderMessageItem,
};

module.exports = { messageListMethods, executionStatusLabel };
