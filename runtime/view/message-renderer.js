const { Notice, MarkdownRenderer, setIcon } = require("obsidian");
const { normalizeMarkdownForDisplay } = require("../assistant-payload-utils");

const TOOL_ICON_MAP = {
  read: "file-text",
  write: "file-pen",
  edit: "file-pen",
  bash: "terminal-square",
  ls: "folder-tree",
  glob: "search",
  grep: "search-code",
  web_search: "globe",
  web_fetch: "globe",
  skill: "sparkles",
  question: "circle-help",
  todo_write: "list-checks",
};

function safeSetIcon(el, iconName) {
  if (!el) return;
  try {
    setIcon(el, iconName);
  } catch {
    try {
      setIcon(el, "circle");
    } catch {
      // ignore invalid icon names
    }
  }
}

async function copyTextToClipboard(text) {
  await navigator.clipboard.writeText(String(text || ""));
}

function applyCopyGlyph(el) {
  if (!el) return;
  el.innerHTML = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const rectBack = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rectBack.setAttribute("x", "9");
  rectBack.setAttribute("y", "9");
  rectBack.setAttribute("width", "11");
  rectBack.setAttribute("height", "11");
  rectBack.setAttribute("rx", "2");
  rectBack.setAttribute("fill", "none");
  rectBack.setAttribute("stroke", "currentColor");
  rectBack.setAttribute("stroke-width", "1.8");
  const rectFront = document.createElementNS("http://www.w3.org/2000/svg", "path");
  rectFront.setAttribute("d", "M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1");
  rectFront.setAttribute("fill", "none");
  rectFront.setAttribute("stroke", "currentColor");
  rectFront.setAttribute("stroke-width", "1.8");
  rectFront.setAttribute("stroke-linecap", "round");
  rectFront.setAttribute("stroke-linejoin", "round");
  svg.appendChild(rectBack);
  svg.appendChild(rectFront);
  el.appendChild(svg);
}

function showCopyFeedback(el, restore) {
  if (!el) return;
  const prev = el.getAttribute("data-copying");
  if (prev === "1") return;
  el.setAttribute("data-copying", "1");
  el.classList.add("copied");
  el.textContent = "copied!";
  setTimeout(() => {
    el.removeAttribute("data-copying");
    el.classList.remove("copied");
    if (typeof restore === "function") restore();
  }, 1400);
}

function resolveToolIconName(toolName) {
  const key = String(toolName || "").trim().toLowerCase();
  return TOOL_ICON_MAP[key] || "wrench";
}

function applyToolStatusIcon(el, status) {
  if (!el) return;
  const normalizedStatus = String(status || "pending").trim().toLowerCase();
  el.className = "oc-tool-status";
  el.classList.add(`status-${normalizedStatus}`);
  el.empty();

  if (normalizedStatus === "completed") {
    safeSetIcon(el, "check");
    return;
  }
  if (normalizedStatus === "error") {
    safeSetIcon(el, "x");
    return;
  }
  if (normalizedStatus === "running") {
    safeSetIcon(el, "loader-circle");
    return;
  }
  safeSetIcon(el, "clock3");
}

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

function ensureCodeWrapper(pre) {
  if (!pre || !pre.parentElement) return null;
  if (pre.parentElement.classList.contains("oc-code-wrapper")) {
    return pre.parentElement;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "oc-code-wrapper";
  pre.parentElement.insertBefore(wrapper, pre);
  wrapper.appendChild(pre);
  return wrapper;
}

function ensureCodeCopyButton(wrapper, codeText) {
  if (!wrapper) return;
  let btn = wrapper.querySelector(".oc-code-copy-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "oc-code-copy-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "复制代码");
    wrapper.appendChild(btn);
  }

  applyCopyGlyph(btn);
  btn.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyTextToClipboard(codeText || "");
      showCopyFeedback(btn, () => {
        applyCopyGlyph(btn);
      });
    } catch {
      new Notice("复制失败");
    }
  };
}

function ensureCodeLanguageLabel(wrapper, codeEl, codeText) {
  if (!wrapper || !codeEl) return;
  const match = String(codeEl.className || "").match(/language-([A-Za-z0-9_+-]+)/);
  const hasLanguage = Boolean(match && match[1]);
  wrapper.classList.toggle("has-language", hasLanguage);

  let labelBtn = wrapper.querySelector(".oc-code-lang-label");
  if (!hasLanguage) {
    if (labelBtn) labelBtn.remove();
    return;
  }

  const language = String(match[1] || "").toLowerCase();
  if (!labelBtn) {
    labelBtn = document.createElement("button");
    labelBtn.className = "oc-code-lang-label";
    labelBtn.type = "button";
    labelBtn.setAttribute("aria-label", `复制 ${language} 代码`);
    wrapper.appendChild(labelBtn);
  }

  labelBtn.textContent = language;
  labelBtn.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyTextToClipboard(codeText || "");
      showCopyFeedback(labelBtn, () => {
        labelBtn.textContent = language;
      });
    } catch {
      new Notice("复制失败");
    }
  };
}

function enhanceCodeBlocks(container) {
  if (!container) return;
  container.querySelectorAll("pre").forEach((pre) => {
    const wrapper = ensureCodeWrapper(pre);
    if (!wrapper) return;

    const codeEl = pre.querySelector("code");
    const codeText = codeEl ? codeEl.innerText : pre.innerText;

    ensureCodeLanguageLabel(wrapper, codeEl, codeText);
    ensureCodeCopyButton(wrapper, codeText);

    const obsidianCopy = wrapper.querySelector(".copy-code-button");
    if (obsidianCopy) obsidianCopy.remove();
  });
}

function attachCodeCopyButtons(container) {
  this.enhanceCodeBlocks(container);
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

function truncateSummaryText(text, maxLength = 88) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}...` : raw;
}

function fileNameOnly(pathLike) {
  const raw = String(pathLike || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function pickToolInput(block) {
  if (!block || typeof block !== "object") return null;
  if (block.toolInput && typeof block.toolInput === "object") return block.toolInput;
  if (block.raw && block.raw.state && block.raw.state.input && typeof block.raw.state.input === "object") {
    return block.raw.state.input;
  }
  if (block.raw && block.raw.input && typeof block.raw.input === "object") return block.raw.input;
  return null;
}

function inferToolSummary(block, toolName) {
  const normalizedTool = String(toolName || "").trim().toLowerCase();
  const rawSummary = String((block && (block.preview || block.summary)) || "").trim();
  const summary = /^工具:\s*/.test(rawSummary) ? "" : rawSummary;
  if (summary) return truncateSummaryText(summary);

  const input = pickToolInput(block);
  if (!input) return "";

  if (["read", "write", "edit"].includes(normalizedTool)) {
    const pathText = input.filePath || input.file_path || input.path || input.target_path || "";
    return truncateSummaryText(fileNameOnly(pathText));
  }

  if (normalizedTool === "bash") {
    const command = input.command || input.cmd || input.script || "";
    return truncateSummaryText(command, 72);
  }

  if (normalizedTool === "web_search") {
    return truncateSummaryText(input.query || input.keyword || "", 72);
  }

  if (normalizedTool === "web_fetch") {
    return truncateSummaryText(input.url || input.uri || "", 72);
  }

  if (normalizedTool === "ls") {
    return truncateSummaryText(fileNameOnly(input.path || "."), 72);
  }

  if (normalizedTool === "grep" || normalizedTool === "glob") {
    return truncateSummaryText(input.pattern || input.query || "", 72);
  }

  if (normalizedTool === "skill") {
    return truncateSummaryText(input.skill || input.name || "", 72);
  }

  return "";
}

function extractPatchFiles(block, detailText = "") {
  if (block && block.raw && Array.isArray(block.raw.files)) {
    return block.raw.files
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  const lines = String(detailText || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
  return lines;
}

function patchHash(block) {
  if (block && block.raw && typeof block.raw.hash === "string" && block.raw.hash.trim()) {
    return block.raw.hash.trim();
  }
  const summary = String((block && block.summary) || "").trim();
  const match = summary.match(/hash:\s*([a-f0-9]+)/i);
  return match && match[1] ? match[1] : "";
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
  const details = container.createEl("details", { cls: "oc-thinking-block oc-part-reasoning" });
  const status = this.normalizeBlockStatus(block && block.status);
  details.addClass(`is-${status}`);
  details.setAttr("data-part-type", "reasoning");

  const summary = details.createEl("summary", { cls: "oc-thinking-header" });
  summary.createSpan({ cls: "oc-thinking-label", text: "Thought" });
  summary.createSpan({
    cls: "oc-thinking-state",
    text: this.blockStatusLabel(status),
  });

  const body = details.createDiv({ cls: "oc-thinking-content" });
  const detailText = typeof block.detail === "string" ? block.detail : "";
  const content = normalizeMarkdownForDisplay(detailText);
  if (content) {
    MarkdownRenderer.render(this.app, content, body, "", this.plugin).then(() => {
      this.enhanceCodeBlocks(body);
    });
  } else {
    body.setText("...");
  }

  details.open = Boolean(messagePending || status === "running" || status === "pending");
}

function renderToolPart(container, block) {
  const status = this.normalizeBlockStatus(block && block.status);
  const toolName = this.toolDisplayName(block) || "tool";
  const normalizedToolName = String((block && block.tool) || toolName || "tool").trim().toLowerCase();
  let summaryText = inferToolSummary(block, normalizedToolName || toolName);
  const questionItems = normalizedToolName === "question"
    ? this.extractQuestionItemsFromBlock(block)
    : [];
  if (!summaryText && questionItems.length) {
    const firstQuestion = String((questionItems[0] && questionItems[0].question) || "").trim();
    const suffix = questionItems.length > 1 ? ` (+${questionItems.length - 1})` : "";
    summaryText = truncateSummaryText(`${firstQuestion}${suffix}`);
  }
  const detailText = String((block && block.detail) || "").trim();

  const details = container.createEl("details", { cls: "oc-tool-call" });
  details.addClass(`is-${status}`);
  details.setAttr("data-part-type", "tool");
  details.setAttr("data-tool-name", normalizedToolName || "tool");
  details.open = status === "running" || status === "error";

  const header = details.createEl("summary", { cls: "oc-tool-header" });
  const iconEl = header.createSpan({ cls: "oc-tool-icon" });
  safeSetIcon(iconEl, resolveToolIconName(normalizedToolName || toolName));

  header.createSpan({ cls: "oc-tool-name", text: toolName });

  const summaryEl = header.createSpan({ cls: "oc-tool-summary" });
  summaryEl.setText(summaryText);

  const statusEl = header.createSpan({ cls: "oc-tool-status" });
  applyToolStatusIcon(statusEl, status);

  const content = details.createDiv({ cls: "oc-tool-content" });

  if (questionItems.length) {
    content.createDiv({
      cls: "oc-question-inline-note",
      text: "请在下方面板中回答。",
    });
    const firstQuestion = String((questionItems[0] && questionItems[0].question) || "").trim();
    if (firstQuestion) {
      content.createDiv({
        cls: "oc-question-inline-prompt",
        text: firstQuestion,
      });
    }
  }

  if (detailText) {
    const pre = content.createEl("pre", { cls: "oc-tool-detail", text: detailText });
    pre.setAttr("dir", "auto");
  } else if (summaryText) {
    content.createDiv({ cls: "oc-tool-result-text", text: summaryText });
  } else {
    content.createDiv({ cls: "oc-tool-result-text", text: "暂无返回内容" });
  }
}

function renderPatchPart(container, block) {
  const status = this.normalizeBlockStatus(block && block.status);
  const detailText = String((block && block.detail) || "").trim();
  const files = extractPatchFiles(block, detailText);
  const hash = patchHash(block);
  const shortHash = hash ? hash.slice(0, 12) : "";
  const summaryText = files.length
    ? `${files.length} 个文件${shortHash ? ` · ${shortHash}` : ""}`
    : shortHash
      ? `hash ${shortHash}`
      : "文件改动";

  const details = container.createEl("details", { cls: "oc-tool-call oc-tool-patch" });
  details.addClass(`is-${status}`);
  details.setAttr("data-part-type", "patch");
  details.setAttr("data-tool-name", "patch");
  details.open = status === "running" || status === "error";

  const header = details.createEl("summary", { cls: "oc-tool-header" });
  const iconEl = header.createSpan({ cls: "oc-tool-icon" });
  safeSetIcon(iconEl, "git-commit-horizontal");
  header.createSpan({ cls: "oc-tool-name", text: "补丁" });
  header.createSpan({ cls: "oc-tool-summary", text: summaryText });
  const statusEl = header.createSpan({ cls: "oc-tool-status" });
  applyToolStatusIcon(statusEl, status);

  const content = details.createDiv({ cls: "oc-tool-content oc-tool-patch-content" });
  if (hash) {
    content.createDiv({ cls: "oc-tool-result-text", text: `hash: ${shortHash}` });
  }

  if (files.length) {
    const list = content.createDiv({ cls: "oc-tool-file-list" });
    files.forEach((file) => {
      const item = list.createDiv({ cls: "oc-tool-file-item", text: file });
      item.setAttr("title", file);
    });
  } else if (detailText) {
    const pre = content.createEl("pre", { cls: "oc-tool-detail", text: detailText });
    pre.setAttr("dir", "auto");
  } else {
    content.createDiv({ cls: "oc-tool-result-text", text: "未检测到文件变更详情" });
  }
}

function renderGenericPart(container, block) {
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
  if (title) card.createDiv({ cls: "oc-part-title", text: title });

  const summary = typeof block.summary === "string" ? block.summary.trim() : "";
  if (summary) card.createDiv({ cls: "oc-part-summary", text: summary });

  const preview = typeof block.preview === "string" ? block.preview.trim() : "";
  if (preview) card.createDiv({ cls: "oc-part-preview", text: preview });

  const detail = typeof block.detail === "string" ? block.detail.trim() : "";
  if (detail) {
    const details = card.createEl("details", { cls: "oc-part-details" });
    details.createEl("summary", { text: "查看详情" });
    details.createEl("pre", { cls: "oc-part-detail", text: detail });
  }
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
    const type = String((block && block.type) || "").trim().toLowerCase();
    if (type === "reasoning") {
      this.renderReasoningPart(container, block, Boolean(message && message.pending));
      return;
    }
    if (type === "tool") {
      this.renderToolPart(container, block);
      return;
    }
    if (type === "patch") {
      this.renderPatchPart(container, block);
      return;
    }

    this.renderGenericPart(container, block);
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
    MarkdownRenderer.render(this.app, finalText, textBlock, "", this.plugin).then(() => {
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
      MarkdownRenderer.render(this.app, reasoningText, reasoningBody, "", this.plugin).then(() => {
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

module.exports = { messageRendererMethods: {
  renderMessages,
  renderUserActions,
  addTextCopyButton,
  attachCodeCopyButtons,
  enhanceCodeBlocks,
  ensureReasoningContainer,
  ensureBlocksContainer,
  reorderAssistantMessageLayout,
  normalizeBlockStatus,
  blockTypeLabel,
  blockStatusLabel,
  inferToolSummary,
  toolDisplayName,
  visibleAssistantBlocks,
  hasReasoningBlock,
  removeStandaloneReasoningContainer,
  findMessageRow,
  renderReasoningPart,
  renderToolPart,
  renderPatchPart,
  renderGenericPart,
  renderAssistantBlocks,
  renderAssistantMeta,
  renderMessageItem,
} };
