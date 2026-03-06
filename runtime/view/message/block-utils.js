const { tFromContext } = require("../../i18n-runtime");
const INTERNAL_NOISY_TOOL_NAMES = new Set([
  "background_output",
  "background_cancel",
]);
const PATCH_DEFAULT_CONTEXT_LINES = 3;
const PATCH_DEFAULT_MAX_MATRIX_CELLS = 120000;
const PATCH_DEFAULT_MAX_RENDERED_LINES = 320;
const PATCH_DIFF_MAX_TEXT_CHARS_PER_SIDE = 60000;

function ensureReasoningContainer(row, openByDefault) {
  let details = row.querySelector(".oc-message-reasoning");
  if (!details) {
    details = document.createElement("details");
    details.addClass("oc-message-reasoning");
    details.createEl("summary", { text: tFromContext(this, "view.block.reasoning", "Reasoning (collapsible)") });
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
    tool: tFromContext(this, "view.block.tool", "Tool"),
    subtask: tFromContext(this, "view.block.subtask", "Subtask"),
    agent: tFromContext(this, "view.block.agent", "Agent"),
    file: tFromContext(this, "view.block.file", "File"),
    patch: tFromContext(this, "view.block.patch", "Patch"),
    retry: tFromContext(this, "view.block.retry", "Retry"),
    compaction: tFromContext(this, "view.block.compaction", "Compaction"),
    snapshot: tFromContext(this, "view.block.snapshot", "Snapshot"),
  };
  return map[value] || value || tFromContext(this, "view.block.output", "Output");
}

function blockStatusLabel(status) {
  const value = this.normalizeBlockStatus(status);
  if (value === "completed") return tFromContext(this, "view.block.status.completed", "Completed");
  if (value === "running") return tFromContext(this, "view.block.status.running", "Running");
  if (value === "error") return tFromContext(this, "view.block.status.error", "Failed");
  return tFromContext(this, "view.block.status.pending", "Pending");
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
  const type = normalizePatchChangeType(changeType);
  if (type === "added") return tFromContext(this, "view.block.patchAction.added", "Added");
  if (type === "modified") return tFromContext(this, "view.block.patchAction.modified", "Modified");
  if (type === "deleted") return tFromContext(this, "view.block.patchAction.deleted", "Deleted");
  if (type === "renamed") return tFromContext(this, "view.block.patchAction.renamed", "Renamed");
  if (type === "copied") return tFromContext(this, "view.block.patchAction.copied", "Copied");
  return tFromContext(this, "view.block.patchLabel", "File change");
}

function normalizePatchPath(pathLike) {
  return String(pathLike || "").trim();
}

function splitPatchTextLines(value) {
  const text = String(value || "").replace(/\r/g, "");
  if (!text) return [];
  return text.split("\n");
}

function clampPatchSnapshotText(value, maxChars = PATCH_DIFF_MAX_TEXT_CHARS_PER_SIDE) {
  const raw = String(value || "");
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.max(2048, Math.floor(Number(maxChars)))
    : PATCH_DIFF_MAX_TEXT_CHARS_PER_SIDE;
  if (raw.length <= limit) return raw;
  const head = Math.max(1024, Math.floor(limit * 0.55));
  const tail = Math.max(1024, limit - head);
  const hidden = Math.max(0, raw.length - head - tail);
  return [
    raw.slice(0, head),
    "",
    `... [truncated ${hidden} chars for memory safety] ...`,
    "",
    raw.slice(raw.length - tail),
  ].join("\n");
}

function countPatchLineChanges(lines) {
  let added = 0;
  let removed = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const type = line && typeof line === "object" ? String(line.type || "") : "";
    if (type === "insert") added += 1;
    if (type === "delete") removed += 1;
  }
  return { added, removed };
}

function clampPatchDiffLines(lines, maxRenderedLines) {
  const source = Array.isArray(lines) ? lines : [];
  const limitRaw = Number(maxRenderedLines);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.max(24, Math.floor(limitRaw))
    : PATCH_DEFAULT_MAX_RENDERED_LINES;
  if (source.length <= limit) {
    return {
      lines: source,
      truncated: false,
      hiddenLineCount: 0,
    };
  }

  const head = Math.max(8, Math.floor(limit * 0.58));
  const tail = Math.max(8, limit - head - 1);
  const keptHead = source.slice(0, head);
  const keptTail = source.slice(source.length - tail);
  const hiddenLineCount = Math.max(0, source.length - keptHead.length - keptTail.length);
  const markerLine = {
    type: "omitted",
    text: `... ${hiddenLineCount} lines omitted ...`,
  };
  return {
    lines: [...keptHead, markerLine, ...keptTail],
    truncated: true,
    hiddenLineCount,
  };
}

function buildFallbackPatchLines(beforeLines, afterLines) {
  const lines = [];
  for (const text of beforeLines) {
    lines.push({ type: "delete", text: String(text || "") });
  }
  for (const text of afterLines) {
    lines.push({ type: "insert", text: String(text || "") });
  }
  return lines;
}

function buildPatchLineDiff(beforeText, afterText, options = {}) {
  const beforeLines = splitPatchTextLines(beforeText);
  const afterLines = splitPatchTextLines(afterText);
  const rows = beforeLines.length;
  const cols = afterLines.length;
  const maxMatrixCellsRaw = Number(options.maxMatrixCells);
  const maxMatrixCells = Number.isFinite(maxMatrixCellsRaw) && maxMatrixCellsRaw > 0
    ? Math.max(1024, Math.floor(maxMatrixCellsRaw))
    : PATCH_DEFAULT_MAX_MATRIX_CELLS;
  const maxRenderedLinesRaw = Number(options.maxRenderedLines);
  const maxRenderedLines = Number.isFinite(maxRenderedLinesRaw) && maxRenderedLinesRaw > 0
    ? Math.max(24, Math.floor(maxRenderedLinesRaw))
    : PATCH_DEFAULT_MAX_RENDERED_LINES;

  if (!rows && !cols) {
    return {
      lines: [],
      truncated: false,
      hiddenLineCount: 0,
      matrixLimited: false,
    };
  }

  const matrixCells = rows * cols;
  if (matrixCells > maxMatrixCells) {
    const fallbackLines = buildFallbackPatchLines(beforeLines, afterLines);
    const limitedFallback = clampPatchDiffLines(fallbackLines, maxRenderedLines);
    return {
      lines: limitedFallback.lines,
      truncated: limitedFallback.truncated,
      hiddenLineCount: limitedFallback.hiddenLineCount,
      matrixLimited: true,
    };
  }

  const width = cols + 1;
  const matrix = new Uint32Array((rows + 1) * width);

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      const idx = row * width + col;
      if (beforeLines[row] === afterLines[col]) {
        matrix[idx] = matrix[(row + 1) * width + (col + 1)] + 1;
      } else {
        const down = matrix[(row + 1) * width + col];
        const right = matrix[row * width + (col + 1)];
        matrix[idx] = down >= right ? down : right;
      }
    }
  }

  const lines = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    const beforeLine = beforeLines[row];
    const afterLine = afterLines[col];
    if (beforeLine === afterLine) {
      lines.push({ type: "equal", text: beforeLine });
      row += 1;
      col += 1;
      continue;
    }
    const down = matrix[(row + 1) * width + col];
    const right = matrix[row * width + (col + 1)];
    if (down >= right) {
      lines.push({ type: "delete", text: beforeLine });
      row += 1;
    } else {
      lines.push({ type: "insert", text: afterLine });
      col += 1;
    }
  }
  while (row < rows) {
    lines.push({ type: "delete", text: beforeLines[row] });
    row += 1;
  }
  while (col < cols) {
    lines.push({ type: "insert", text: afterLines[col] });
    col += 1;
  }

  const limited = clampPatchDiffLines(lines, maxRenderedLines);
  return {
    lines: limited.lines,
    truncated: limited.truncated,
    hiddenLineCount: limited.hiddenLineCount,
    matrixLimited: false,
  };
}

function splitPatchDiffHunks(diffLines, options = {}) {
  const lines = Array.isArray(diffLines) ? diffLines : [];
  if (!lines.length) return [];

  const contextLinesRaw = Number(options.contextLines);
  const contextLines = Number.isFinite(contextLinesRaw) && contextLinesRaw >= 0
    ? Math.min(24, Math.floor(contextLinesRaw))
    : PATCH_DEFAULT_CONTEXT_LINES;

  const changedIndices = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const type = line && typeof line === "object" ? String(line.type || "") : "";
    if (type !== "equal") {
      changedIndices.push(index);
    }
  }
  if (!changedIndices.length) return [];

  const ranges = [];
  for (const changedIndex of changedIndices) {
    const start = Math.max(0, changedIndex - contextLines);
    const end = Math.min(lines.length - 1, changedIndex + contextLines);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const hunks = [];
  for (const range of ranges) {
    let oldStart = 1;
    let newStart = 1;
    for (let i = 0; i < range.start; i += 1) {
      const type = String((lines[i] && lines[i].type) || "");
      if (type === "equal" || type === "delete") oldStart += 1;
      if (type === "equal" || type === "insert") newStart += 1;
    }
    hunks.push({
      lines: lines.slice(range.start, range.end + 1),
      oldStart,
      newStart,
    });
  }
  return hunks;
}

function normalizePatchDiffEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const file = normalizePatchPath(
    entry.file || entry.path || entry.filePath || entry.filename || entry.name || entry.to || entry.newPath || "",
  );
  const beforeRaw = typeof entry.before === "string"
    ? entry.before
    : typeof entry.old === "string"
      ? entry.old
      : typeof entry.previous === "string"
        ? entry.previous
        : "";
  const afterRaw = typeof entry.after === "string"
    ? entry.after
    : typeof entry.new === "string"
      ? entry.new
      : typeof entry.current === "string"
        ? entry.current
        : "";
  const before = clampPatchSnapshotText(beforeRaw);
  const after = clampPatchSnapshotText(afterRaw);
  if (!file && !before && !after) return null;

  const parseCount = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return 0;
    return Math.max(0, Math.floor(num));
  };

  return {
    file,
    before,
    after,
    additions: parseCount(entry.additions),
    deletions: parseCount(entry.deletions),
  };
}

function inferPatchActionFromDiff(diffEntry, fallbackEntry) {
  const fallbackAction = normalizePatchChangeType(fallbackEntry && fallbackEntry.action);
  if (fallbackAction !== "unknown") return fallbackAction;
  const diff = diffEntry && typeof diffEntry === "object" ? diffEntry : {};
  const before = String(diff.before || "");
  const after = String(diff.after || "");
  const beforeHasText = before.length > 0;
  const afterHasText = after.length > 0;
  if (beforeHasText && !afterHasText) return "deleted";
  if (!beforeHasText && afterHasText) return "added";

  const additions = Number(diff.additions || 0);
  const deletions = Number(diff.deletions || 0);
  if (deletions > 0 && additions <= 0) return "deleted";
  if (additions > 0 && deletions <= 0) return "added";
  return "modified";
}

function countPatchDiffStats(diffEntry, diffLines = []) {
  const diff = diffEntry && typeof diffEntry === "object" ? diffEntry : {};
  const additions = Number(diff.additions);
  const deletions = Number(diff.deletions);
  const hasExplicitCounts = Number.isFinite(additions) || Number.isFinite(deletions);
  if (hasExplicitCounts) {
    return {
      added: Number.isFinite(additions) && additions > 0 ? Math.floor(additions) : 0,
      removed: Number.isFinite(deletions) && deletions > 0 ? Math.floor(deletions) : 0,
    };
  }
  return countPatchLineChanges(diffLines);
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
  return `${list.length} 个文件变更`;
}

function withInferredPatchActions(entries, message, patchBlockIndex) {
  void message;
  void patchBlockIndex;
  const list = Array.isArray(entries) ? entries : [];
  return list;
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
    if (type === "tool") {
      const toolName = String((block.tool || "")).trim().toLowerCase();
      const status = normalizeBlockStatus(block.status);
      if (INTERNAL_NOISY_TOOL_NAMES.has(toolName) && status !== "error") return false;
    }
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
  normalizePatchPath,
  normalizePatchChangeType,
  patchChangeLabel,
  normalizePatchFileEntry,
  normalizePatchDiffEntry,
  inferPatchActionFromDiff,
  buildPatchLineDiff,
  splitPatchDiffHunks,
  countPatchDiffStats,
  patchFileDisplayPath,
  extractPatchFileEntries,
  summarizePatchChanges,
  withInferredPatchActions,
  extractPatchFiles,
  patchHash,
};

module.exports = {
  blockUtilsMethods,
  blockUtilsInternal,
};
