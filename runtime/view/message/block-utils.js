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
    patch: "文件变更",
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

function normalizePatchChangeType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (["a", "add", "added", "new", "create", "created"].includes(raw)) return "added";
  if (["m", "mod", "modify", "modified", "update", "updated", "change", "changed", "edit", "edited"].includes(raw)) {
    return "modified";
  }
  if (["d", "del", "delete", "deleted", "remove", "removed"].includes(raw)) return "deleted";
  if (["r", "ren", "rename", "renamed", "move", "moved"].includes(raw)) return "renamed";
  if (["c", "copy", "copied"].includes(raw)) return "copied";
  return "unknown";
}

function patchChangeLabel(changeType) {
  const normalized = normalizePatchChangeType(changeType);
  if (normalized === "added") return "新增";
  if (normalized === "modified") return "修改";
  if (normalized === "deleted") return "删除";
  if (normalized === "renamed") return "重命名";
  if (normalized === "copied") return "复制";
  return "变更";
}

function normalizePatchPath(pathLike) {
  return String(pathLike || "").trim();
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

function parsePatchFromToPayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  const arrow = text.match(/^(.+?)\s*->\s*(.+)$/);
  if (arrow && arrow[1] && arrow[2]) {
    return {
      from: normalizePatchPath(arrow[1]),
      to: normalizePatchPath(arrow[2]),
    };
  }

  const tabParts = text.split(/\t+/).map((part) => normalizePatchPath(part)).filter(Boolean);
  if (tabParts.length >= 2) {
    return {
      from: tabParts[0],
      to: tabParts[tabParts.length - 1],
    };
  }

  const spacedParts = text.split(/\s{2,}/).map((part) => normalizePatchPath(part)).filter(Boolean);
  if (spacedParts.length >= 2) {
    return {
      from: spacedParts[0],
      to: spacedParts[spacedParts.length - 1],
    };
  }

  return null;
}

function normalizePatchFileEntry(entry) {
  if (entry === null || entry === undefined) return null;

  if (typeof entry === "string") {
    const text = normalizePatchPath(entry);
    if (!text) return null;

    const statusMatch = text.match(/^([ACDMRTUXB\?])(?:\d+)?\s+(.+)$/i);
    if (statusMatch) {
      const code = String(statusMatch[1] || "").toUpperCase();
      const payload = normalizePatchPath(statusMatch[2]);
      const parsedPair = parsePatchFromToPayload(payload);
      if (code === "R") {
        if (parsedPair) {
          return {
            action: "renamed",
            from: parsedPair.from,
            to: parsedPair.to,
            path: parsedPair.to || parsedPair.from,
          };
        }
        return { action: "renamed", path: payload };
      }
      if (code === "C") {
        if (parsedPair) {
          return {
            action: "copied",
            from: parsedPair.from,
            to: parsedPair.to,
            path: parsedPair.to || parsedPair.from,
          };
        }
        return { action: "copied", path: payload };
      }

      const actionMap = {
        A: "added",
        M: "modified",
        D: "deleted",
        T: "modified",
        U: "modified",
        X: "modified",
        B: "modified",
        "?": "unknown",
      };
      return {
        action: actionMap[code] || "unknown",
        path: payload,
      };
    }

    const renameFrom = text.match(/^rename from\s+(.+)$/i);
    if (renameFrom && renameFrom[1]) {
      return {
        action: "renamed",
        from: normalizePatchPath(renameFrom[1]),
      };
    }
    const renameTo = text.match(/^rename to\s+(.+)$/i);
    if (renameTo && renameTo[1]) {
      return {
        action: "renamed",
        to: normalizePatchPath(renameTo[1]),
        path: normalizePatchPath(renameTo[1]),
      };
    }

    const prefixed = text.match(/^\[?([a-zA-Z]+)\]?\s*:\s*(.+)$/);
    if (prefixed && prefixed[1] && prefixed[2]) {
      return {
        action: normalizePatchChangeType(prefixed[1]),
        path: normalizePatchPath(prefixed[2]),
      };
    }

    const pair = parsePatchFromToPayload(text);
    if (pair) {
      return {
        action: "renamed",
        from: pair.from,
        to: pair.to,
        path: pair.to || pair.from,
      };
    }

    return { action: "unknown", path: text };
  }

  if (typeof entry !== "object") {
    const raw = normalizePatchPath(entry);
    return raw ? { action: "unknown", path: raw } : null;
  }

  const rawAction = entry.action || entry.status || entry.changeType || entry.op || entry.kind || entry.type;
  const from = normalizePatchPath(entry.from || entry.oldPath || entry.previousPath || entry.source || entry.src || "");
  const to = normalizePatchPath(entry.to || entry.newPath || entry.target || entry.dest || entry.dst || "");
  let pathValue = normalizePatchPath(
    entry.path || entry.file || entry.filePath || entry.filename || entry.name || to || from || "",
  );
  let action = normalizePatchChangeType(rawAction);

  if (action === "unknown" && from && to && from !== to) action = "renamed";
  if (action === "renamed" && !pathValue) pathValue = to || from;
  if (action === "deleted" && !pathValue) pathValue = from;
  if (action === "added" && !pathValue) pathValue = to;
  if (!pathValue && !from && !to) return null;

  return {
    action,
    path: pathValue,
    from: from || "",
    to: to || "",
  };
}

function patchFileDisplayPath(entry) {
  const item = entry && typeof entry === "object" ? entry : {};
  const action = normalizePatchChangeType(item.action);
  const from = normalizePatchPath(item.from || "");
  const to = normalizePatchPath(item.to || "");
  const pathText = normalizePatchPath(item.path || "");

  if ((action === "renamed" || action === "copied") && from && to) {
    return `${from} -> ${to}`;
  }
  return pathText || to || from || "";
}

function extractPatchFileEntries(block, detailText = "") {
  const fileEntries = [];
  let pendingRenameFrom = "";

  const inputEntries = (() => {
    if (block && block.raw && Array.isArray(block.raw.files) && block.raw.files.length) {
      return block.raw.files;
    }
    return String(detailText || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean);
  })();

  for (const sourceEntry of inputEntries) {
    const normalized = normalizePatchFileEntry(sourceEntry);
    if (!normalized) continue;

    const from = normalizePatchPath(normalized.from || "");
    const to = normalizePatchPath(normalized.to || "");
    const pathText = normalizePatchPath(normalized.path || "");
    const action = normalizePatchChangeType(normalized.action);

    if (action === "renamed" && from && !to && !pathText) {
      pendingRenameFrom = from;
      continue;
    }
    if (action === "renamed" && !from && (to || pathText) && pendingRenameFrom) {
      const resolvedTo = to || pathText;
      fileEntries.push({
        action: "renamed",
        from: pendingRenameFrom,
        to: resolvedTo,
        path: resolvedTo,
      });
      pendingRenameFrom = "";
      continue;
    }

    const entry = {
      action,
      from,
      to,
      path: pathText || to || from,
    };
    if (!entry.path && !entry.from && !entry.to) continue;
    fileEntries.push(entry);
  }

  if (pendingRenameFrom) {
    fileEntries.push({
      action: "unknown",
      path: pendingRenameFrom,
      from: "",
      to: "",
    });
  }

  return fileEntries;
}

function summarizePatchChanges(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return "";

  const counter = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    unknown: 0,
  };

  for (const entry of list) {
    const type = normalizePatchChangeType(entry && entry.action);
    counter[type] += 1;
  }

  const parts = [];
  if (counter.added) parts.push(`新增${counter.added}`);
  if (counter.modified) parts.push(`修改${counter.modified}`);
  if (counter.deleted) parts.push(`删除${counter.deleted}`);
  if (counter.renamed) parts.push(`重命名${counter.renamed}`);
  if (counter.copied) parts.push(`复制${counter.copied}`);
  if (counter.unknown) parts.push(`变更${counter.unknown}`);

  if (!parts.length) return `${list.length} 个变更文件`;
  return parts.join(" · ");
}

function inferPatchActionFromToolName(toolName) {
  const name = String(toolName || "").trim().toLowerCase();
  if (!name) return "";
  if (/(^|[._-])(delete|remove|unlink|rm|trash)([._-]|$)/.test(name)) return "deleted";
  if (/(^|[._-])(rename|move|mv)([._-]|$)/.test(name)) return "renamed";
  if (/(^|[._-])(copy|cp)([._-]|$)/.test(name)) return "copied";
  if (/(^|[._-])(create|touch|new)([._-]|$)/.test(name)) return "added";
  if (/(^|[._-])(write|edit|update|append|replace|patch)([._-]|$)/.test(name)) return "modified";
  return "";
}

function inferPatchActionFromMessage(message, patchBlockIndex) {
  const blocks = Array.isArray(message && message.blocks) ? message.blocks : [];
  const startIndex = Number.isFinite(patchBlockIndex) ? patchBlockIndex - 1 : blocks.length - 1;
  for (let i = Math.min(startIndex, blocks.length - 1); i >= 0; i -= 1) {
    const block = blocks[i];
    if (!block || typeof block !== "object") continue;
    const type = String(block.type || "").trim().toLowerCase();
    if (type !== "tool") continue;
    const candidates = [
      block.tool,
      block.title,
      block.summary,
      block.raw && block.raw.tool,
    ];
    for (const candidate of candidates) {
      const action = inferPatchActionFromToolName(candidate);
      if (action) return action;
    }
  }
  return "";
}

function withInferredPatchActions(entries, message, patchBlockIndex) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return list;
  const inferred = inferPatchActionFromMessage(message, patchBlockIndex);
  if (!inferred) return list;

  return list.map((entry) => {
    const action = normalizePatchChangeType(entry && entry.action);
    if (action !== "unknown") return entry;
    const next = entry && typeof entry === "object" ? { ...entry } : {};
    next.action = inferred;
    next.inferred = true;
    return next;
  });
}

function extractPatchFiles(block, detailText = "") {
  return extractPatchFileEntries(block, detailText)
    .map((entry) => patchFileDisplayPath(entry))
    .filter(Boolean);
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
  normalizePatchChangeType,
  patchChangeLabel,
  normalizePatchFileEntry,
  patchFileDisplayPath,
  extractPatchFileEntries,
  summarizePatchChanges,
  inferPatchActionFromToolName,
  inferPatchActionFromMessage,
  withInferredPatchActions,
  extractPatchFiles,
  patchHash,
};

module.exports = {
  blockUtilsMethods,
  blockUtilsInternal,
};
