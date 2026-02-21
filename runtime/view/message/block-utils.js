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

function resolveDisplayBlockStatus(block, messagePending) {
  const status = this.normalizeBlockStatus(block && block.status);
  if (status === "error" || status === "completed") return status;
  if (messagePending) return status;
  return "completed";
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


const blockUtilsMethods = {
  ensureReasoningContainer,
  ensureBlocksContainer,
  reorderAssistantMessageLayout,
  normalizeBlockStatus,
  resolveDisplayBlockStatus,
  blockTypeLabel,
  blockStatusLabel,
  inferToolSummary,
  toolDisplayName,
  visibleAssistantBlocks,
  hasReasoningBlock,
  removeStandaloneReasoningContainer,
  findMessageRow,
};

const blockUtilsInternal = {
  truncateSummaryText,
  extractPatchFiles,
  patchHash,
};

module.exports = {
  blockUtilsMethods,
  blockUtilsInternal,
};
