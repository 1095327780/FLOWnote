const { normalizeMarkdownForDisplay } = require("../../assistant-payload-utils");
const { MARKDOWN_RENDER_STATE } = require("./markdown-methods");
const { domUtils } = require("./dom-utils");
const { blockUtilsMethods, blockUtilsInternal } = require("./block-utils");

const {
  setNodeText,
  safeSetIcon,
  resolveToolIconName,
  applyToolStatusIcon,
} = domUtils;

const {
  inferToolSummary,
} = blockUtilsMethods;

const {
  truncateSummaryText,
  extractPatchFiles,
  patchHash,
} = blockUtilsInternal;

function renderReasoningPart(container, block, messagePending) {
  const details = container.createEl("details", { cls: "oc-thinking-block oc-part-reasoning" });
  const status = this.resolveDisplayBlockStatus(block, messagePending);
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
    if (messagePending) {
      MARKDOWN_RENDER_STATE.delete(body);
      setNodeText(body, content);
    } else {
      this.renderMarkdownSafely(body, content, () => {
        this.enhanceCodeBlocks(body);
      });
    }
  } else {
    MARKDOWN_RENDER_STATE.delete(body);
    setNodeText(body, "...");
  }

  details.open = Boolean(messagePending && (status === "running" || status === "pending"));
}

function renderToolPart(container, block, messagePending) {
  const status = this.resolveDisplayBlockStatus(block, messagePending);
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
  details.open = messagePending ? (status === "running" || status === "error") : status === "error";

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

function renderPatchPart(container, block, messagePending) {
  const status = this.resolveDisplayBlockStatus(block, messagePending);
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
  details.open = messagePending ? (status === "running" || status === "error") : status === "error";

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

function renderGenericPart(container, block, messagePending) {
  const card = container.createDiv({ cls: "oc-part-card" });
  const status = this.resolveDisplayBlockStatus(block, messagePending);
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
  const messagePending = Boolean(message && message.pending);
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
      this.renderReasoningPart(container, block, messagePending);
      return;
    }
    if (type === "tool") {
      this.renderToolPart(container, block, messagePending);
      return;
    }
    if (type === "patch") {
      this.renderPatchPart(container, block, messagePending);
      return;
    }

    this.renderGenericPart(container, block, messagePending);
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


const blockRenderMethods = {
  renderReasoningPart,
  renderToolPart,
  renderPatchPart,
  renderGenericPart,
  renderAssistantBlocks,
  renderAssistantMeta,
};

module.exports = { blockRenderMethods };
