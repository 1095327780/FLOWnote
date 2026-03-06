const { normalizeMarkdownForDisplay } = require("../../assistant-payload-utils");
const { MARKDOWN_RENDER_STATE } = require("./markdown-methods");
const { domUtils } = require("./dom-utils");
const { blockUtilsMethods, blockUtilsInternal } = require("./block-utils");
const { tFromContext } = require("../../i18n-runtime");

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
  normalizePatchPath,
  normalizePatchChangeType,
  extractPatchFileEntries,
  summarizePatchChanges,
  patchChangeLabel,
  patchFileDisplayPath,
  normalizePatchDiffEntry,
  inferPatchActionFromDiff,
  buildPatchLineDiff,
  splitPatchDiffHunks,
  countPatchDiffStats,
} = blockUtilsInternal;

const PATCH_CONTEXT_LINES = 3;
const PATCH_MAX_MATRIX_CELLS = 120000;
const PATCH_MAX_RENDERED_LINES = 320;
const PATCH_DIFF_CACHE_MAX_ENTRIES = 32;
const PATCH_DIFF_CACHE_MAX_ITEMS_PER_MESSAGE = 24;
const FILE_MUTATION_TOOL_NAMES = new Set(["write", "edit", "multiedit"]);

function clampRenderText(value, maxLen = 12000) {
  const raw = String(value || "");
  const limit = Math.max(512, Number(maxLen) || 12000);
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}\n\n...(truncated ${raw.length - limit} chars)`;
}

function normalizeComparablePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function isAbsolutePath(pathValue) {
  const raw = String(pathValue || "").trim();
  if (!raw) return false;
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(raw);
}

function normalizeComparableFsPath(pathValue) {
  const normalized = String(pathValue || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized;
}

function getVaultBasePath(view) {
  const vault = view && view.app && view.app.vault;
  const adapter = vault && vault.adapter;
  const getBasePath = adapter && typeof adapter.getBasePath === "function"
    ? adapter.getBasePath.bind(adapter)
    : null;
  if (!getBasePath) return "";
  return normalizeComparableFsPath(getBasePath());
}

function isPathInsideDirectory(pathValue, directory) {
  const target = normalizeComparableFsPath(pathValue).toLowerCase();
  const base = normalizeComparableFsPath(directory).toLowerCase();
  if (!target || !base) return false;
  return target === base || target.startsWith(`${base}/`);
}

function getCurrentPluginAbsoluteDir(view) {
  const basePath = getVaultBasePath(view);
  if (!basePath) return "";

  const plugin = view && view.plugin && typeof view.plugin === "object" ? view.plugin : null;
  const manifest = plugin && plugin.manifest && typeof plugin.manifest === "object" ? plugin.manifest : {};
  const manifestDir = String(manifest.dir || "").trim();
  const pluginId = String(manifest.id || "").trim();

  if (manifestDir) {
    const candidate = isAbsolutePath(manifestDir)
      ? normalizeComparableFsPath(manifestDir)
      : normalizeComparableFsPath(`${basePath}/${manifestDir}`);
    if (candidate) return candidate;
  }
  if (pluginId) return normalizeComparableFsPath(`${basePath}/.obsidian/plugins/${pluginId}`);
  return "";
}

function getCurrentPluginVaultRelativeDir(view) {
  const plugin = view && view.plugin && typeof view.plugin === "object" ? view.plugin : null;
  const manifest = plugin && plugin.manifest && typeof plugin.manifest === "object" ? plugin.manifest : {};
  const manifestDir = String(manifest.dir || "").trim().replace(/\\/g, "/");
  const pluginId = String(manifest.id || "").trim();

  if (manifestDir) {
    if (isAbsolutePath(manifestDir)) {
      const asRelative = resolveAbsolutePathToVaultPath(view, manifestDir);
      if (asRelative) return normalizePatchPath(asRelative).replace(/^\/+/, "");
    } else if (manifestDir.includes("/")) {
      return normalizePatchPath(manifestDir).replace(/^\/+/, "");
    } else if (pluginId) {
      return `.obsidian/plugins/${pluginId}`;
    }
  }
  if (pluginId) return `.obsidian/plugins/${pluginId}`;
  return "";
}

function isPathInsideCurrentPluginDirectory(view, pathValue) {
  const target = normalizeComparableFsPath(pathValue);
  if (!target || !isAbsolutePath(target)) return false;
  const pluginDir = getCurrentPluginAbsoluteDir(view);
  if (!pluginDir) return false;
  return isPathInsideDirectory(target, pluginDir);
}

function resolveAbsolutePathToVaultPath(view, absolutePath) {
  const basePath = getVaultBasePath(view);
  const inputPath = normalizeComparableFsPath(absolutePath);
  if (!basePath || !inputPath) return "";
  const baseLower = basePath.toLowerCase();
  const inputLower = inputPath.toLowerCase();
  const prefix = `${baseLower}/`;
  if (!inputLower.startsWith(prefix)) return "";
  return normalizePatchPath(inputPath.slice(basePath.length + 1));
}

function collectComparablePatchPaths(view, pathValue) {
  const raw = normalizePatchPath(pathValue).replace(/\\/g, "/");
  if (!raw) return [];
  const keys = new Set();
  keys.add(normalizeComparablePath(raw));

  if (isAbsolutePath(raw)) {
    const relative = resolveAbsolutePathToVaultPath(view, raw);
    if (relative) keys.add(normalizeComparablePath(relative));
  } else {
    keys.add(normalizeComparablePath(raw.replace(/^\/+/, "")));
  }

  return Array.from(keys).filter(Boolean);
}

function resolvePatchLinkPath(view, rawPath) {
  const vault = view && view.app && view.app.vault;
  if (!vault || typeof vault.getAbstractFileByPath !== "function") return "";
  const normalized = normalizePatchPath(rawPath).replace(/\\/g, "/");
  if (!normalized) return "";

  const tryPath = (candidate) => {
    const pathValue = normalizePatchPath(candidate).replace(/^\/+/, "");
    if (!pathValue) return "";
    const target = vault.getAbstractFileByPath(pathValue);
    if (target && !Array.isArray(target.children)) {
      return normalizePatchPath(target.path || pathValue);
    }
    return "";
  };

  const direct = tryPath(normalized);
  if (direct) return direct;

  const relative = isAbsolutePath(normalized)
    ? resolveAbsolutePathToVaultPath(view, normalized)
    : normalized.replace(/^\/+/, "");
  const resolvedRelative = tryPath(relative);
  if (resolvedRelative) return resolvedRelative;

  const metadataCache = view && view.app && view.app.metadataCache;
  if (metadataCache && typeof metadataCache.getFirstLinkpathDest === "function") {
    const sourcePath = typeof view.getMarkdownRenderSourcePath === "function"
      ? String(view.getMarkdownRenderSourcePath() || "")
      : "";
    const byLink = metadataCache.getFirstLinkpathDest(relative, sourcePath);
    if (byLink && typeof byLink.path === "string" && byLink.path) {
      return normalizePatchPath(byLink.path);
    }
    const basename = String(relative || normalized).split("/").pop();
    if (basename) {
      const byBasename = metadataCache.getFirstLinkpathDest(basename, sourcePath);
      if (byBasename && typeof byBasename.path === "string" && byBasename.path) {
        return normalizePatchPath(byBasename.path);
      }
    }
  }

  if (typeof vault.getFiles === "function") {
    const rel = String(relative || normalized).replace(/^\/+/, "");
    const basename = rel.split("/").pop();
    const allFiles = vault.getFiles();
    const match = allFiles.find((file) => {
      if (!file || typeof file.path !== "string") return false;
      const filePath = normalizePatchPath(file.path).replace(/\\/g, "/");
      if (!filePath) return false;
      if (rel && filePath === rel) return true;
      if (rel && filePath.endsWith(`/${rel}`)) return true;
      if (basename && filePath.endsWith(`/${basename}`)) return true;
      return false;
    });
    if (match && typeof match.path === "string" && match.path) {
      return normalizePatchPath(match.path);
    }
  }
  return "";
}

function resolvePatchPathInfo(view, displayPath, targetPath) {
  const rawDisplayPath = normalizePatchPath(displayPath).replace(/\\/g, "/");
  const rawTargetPath = normalizePatchPath(targetPath || rawDisplayPath).replace(/\\/g, "/");
  const relativeDisplay = isAbsolutePath(rawDisplayPath)
    ? resolveAbsolutePathToVaultPath(view, rawDisplayPath)
    : rawDisplayPath.replace(/^\/+/, "");
  const linkPath = resolvePatchLinkPath(view, rawTargetPath);
  return {
    rawPath: rawDisplayPath || rawTargetPath,
    displayPath: relativeDisplay || rawDisplayPath || rawTargetPath,
    linkPath,
    isLinkable: Boolean(linkPath),
  };
}

function ensurePatchDiffStateStore(view) {
  if (!(view.patchDiffCache instanceof Map)) view.patchDiffCache = new Map();
  if (!(view.patchDiffInflight instanceof Map)) view.patchDiffInflight = new Map();
}

function getActiveSessionId(view) {
  return String(
    view
    && view.plugin
    && view.plugin.sessionStore
    && typeof view.plugin.sessionStore.state === "function"
      ? view.plugin.sessionStore.state().activeSessionId || ""
      : "",
  ).trim();
}

function prunePatchDiffCache(view, keepKey = "") {
  ensurePatchDiffStateStore(view);
  if (view.patchDiffCache.size <= PATCH_DIFF_CACHE_MAX_ENTRIES) return;

  for (const candidateKey of view.patchDiffCache.keys()) {
    if (view.patchDiffCache.size <= PATCH_DIFF_CACHE_MAX_ENTRIES) break;
    if (candidateKey === keepKey) continue;
    if (view.patchDiffInflight.has(candidateKey)) continue;
    view.patchDiffCache.delete(candidateKey);
  }

  for (const candidateKey of view.patchDiffCache.keys()) {
    if (view.patchDiffCache.size <= PATCH_DIFF_CACHE_MAX_ENTRIES) break;
    if (candidateKey === keepKey) continue;
    view.patchDiffCache.delete(candidateKey);
  }
}

function setPatchDiffCacheEntry(view, key, value) {
  ensurePatchDiffStateStore(view);
  if (view.patchDiffCache.has(key)) view.patchDiffCache.delete(key);
  view.patchDiffCache.set(key, value);
  prunePatchDiffCache(view, key);
}

function resolvePatchMessageId(message, raw) {
  const candidates = [
    raw && raw.messageID,
    raw && raw.messageId,
    message && message.messageID,
    message && message.messageId,
    message && message.remoteMessageId,
    message && message.serverMessageId,
    message && message.sdkMessageId,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized) continue;
    return normalized;
  }
  return "";
}

function getPatchDiffRequest(view, block, message) {
  const raw = block && block.raw && typeof block.raw === "object" ? block.raw : {};
  const sessionId = String(
    raw.sessionID
    || raw.sessionId
    || "",
  ).trim();
  const messageId = resolvePatchMessageId(message, raw);
  if (!sessionId || !messageId) return null;
  return {
    key: `${sessionId}::msg:${messageId}`,
    sessionId,
    messageId,
  };
}

function rerenderPatchMessage(view, messageId) {
  const targetId = String(messageId || "").trim();
  if (!targetId || !view || !view.plugin || !view.plugin.sessionStore) return;
  const row = typeof view.findMessageRow === "function" ? view.findMessageRow(targetId) : null;
  if (!row) return;
  const messages = view.plugin.sessionStore.getActiveMessages();
  const message = Array.isArray(messages) ? messages.find((item) => item && item.id === targetId) : null;
  if (!message) return;
  const parent = row.parentElement;
  if (parent && typeof view.renderMessageItem === "function") {
    const nextSibling = row.nextSibling;
    row.remove();
    view.renderMessageItem(parent, message);
    const inserted = parent.lastElementChild;
    if (inserted && nextSibling && inserted !== nextSibling) {
      parent.insertBefore(inserted, nextSibling);
    }
    return;
  }
  view.renderAssistantBlocks(row, message);
  view.renderAssistantMeta(row, message);
  view.reorderAssistantMessageLayout(row);
}

function requestPatchDiff(view, block, message) {
  const plugin = view && view.plugin;
  const client = plugin && plugin.opencodeClient;
  if (!client || typeof client.getSessionDiff !== "function") return;
  const request = getPatchDiffRequest(view, block, message);
  if (!request || !request.key) return;
  const { key, sessionId, messageId } = request;

  ensurePatchDiffStateStore(view);
  const cached = view.patchDiffCache.get(key);
  if (cached && cached.status === "pending") return;
  if (cached && cached.status === "ready") return;
  if (view.patchDiffInflight.has(key)) return;

  setPatchDiffCacheEntry(view, key, {
    status: "pending",
    items: [],
    error: "",
    fetchedAt: 0,
  });

  const task = Promise.resolve()
    .then(async () => {
      const payload = await client.getSessionDiff({
        sessionId,
        messageId,
      });
      return (Array.isArray(payload) ? payload : [])
        .map((entry) => normalizePatchDiffEntry(entry))
        .filter(Boolean)
        .slice(0, PATCH_DIFF_CACHE_MAX_ITEMS_PER_MESSAGE);
    })
    .then((normalized) => {
      const activeSessionId = getActiveSessionId(view);
      if (activeSessionId && activeSessionId !== sessionId) return;
      setPatchDiffCacheEntry(view, key, {
        status: "ready",
        items: normalized,
        error: "",
        fetchedAt: Date.now(),
      });
    })
    .catch((error) => {
      const activeSessionId = getActiveSessionId(view);
      if (activeSessionId && activeSessionId !== sessionId) return;
      setPatchDiffCacheEntry(view, key, {
        status: "error",
        items: [],
        error: error instanceof Error ? error.message : String(error || ""),
        fetchedAt: Date.now(),
      });
    })
    .finally(() => {
      view.patchDiffInflight.delete(key);
      rerenderPatchMessage(view, message && message.id);
    });

  view.patchDiffInflight.set(key, task);
}

function buildPatchRenderItems(view, patchEntries, diffEntries) {
  const entries = Array.isArray(patchEntries) ? patchEntries : [];
  const diffs = Array.isArray(diffEntries) ? diffEntries : [];

  const diffByKey = new Map();
  diffs.forEach((diff) => {
    if (isHiddenPatchDiff(view, diff)) return;
    for (const key of collectComparablePatchPaths(view, diff.file)) {
      if (!diffByKey.has(key)) diffByKey.set(key, diff);
    }
  });

  const used = new Set();
  const items = [];
  entries.forEach((entry) => {
    if (isHiddenPatchEntry(view, entry)) return;
    const candidates = [
      ...(collectComparablePatchPaths(view, entry && entry.path)),
      ...(collectComparablePatchPaths(view, entry && entry.to)),
      ...(collectComparablePatchPaths(view, entry && entry.from)),
    ];
    let matchedDiff = null;
    for (const key of candidates) {
      if (!key) continue;
      const target = diffByKey.get(key);
      if (target) {
        matchedDiff = target;
        used.add(target);
        break;
      }
    }
    items.push({ entry, diff: matchedDiff });
  });

  diffs.forEach((diff) => {
    if (isHiddenPatchDiff(view, diff)) return;
    if (used.has(diff)) return;
    items.push({ entry: null, diff });
  });

  return items;
}

function pathContainsDotPrefixedFolder(view, pathValue) {
  const normalized = normalizePatchPath(pathValue).replace(/\\/g, "/").trim();
  if (!normalized) return false;
  if (isPathInsideCurrentPluginDirectory(view, normalized)) return false;
  const relativeLike = isAbsolutePath(normalized)
    ? (resolveAbsolutePathToVaultPath(view, normalized) || normalized)
    : normalized.replace(/^\/+/, "");
  if (isPathInsideDirectory(relativeLike, getCurrentPluginVaultRelativeDir(view))) return false;
  const segments = String(relativeLike).split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === "..") continue;
    if (segment.startsWith(".")) return true;
  }
  return false;
}

function isHiddenPatchEntry(view, entry) {
  const item = entry && typeof entry === "object" ? entry : {};
  return pathContainsDotPrefixedFolder(view, item.path)
    || pathContainsDotPrefixedFolder(view, item.to)
    || pathContainsDotPrefixedFolder(view, item.from);
}

function isHiddenPatchDiff(view, diff) {
  const item = diff && typeof diff === "object" ? diff : {};
  return pathContainsDotPrefixedFolder(view, item.file);
}

function resolvePatchDisplayPaths(entry, diff) {
  const displayPathRaw = entry
    ? patchFileDisplayPath(entry)
    : normalizePatchPath(diff && diff.file);
  const targetPathRaw = entry
    ? (entry.to || entry.path || entry.from || displayPathRaw)
    : normalizePatchPath(diff && diff.file);
  return {
    displayPathRaw,
    targetPathRaw,
  };
}

function collectPatchSummaryPaths(view, items) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const entry = item && item.entry ? item.entry : null;
    const diff = item && item.diff ? item.diff : null;
    const { displayPathRaw, targetPathRaw } = resolvePatchDisplayPaths(entry, diff);
    const displayPath = displayPathRaw || tFromContext(view, "view.block.pathMissing", "(path missing)");
    if (!displayPath && !targetPathRaw) continue;
    const pathInfo = resolvePatchPathInfo(view, displayPath, targetPathRaw);
    const dedupeKey = String(pathInfo.linkPath || pathInfo.displayPath || displayPath).trim();
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      label: pathInfo.displayPath || displayPath,
      pathInfo,
    });
  }
  return out;
}

function renderPatchPath(container, text, pathInfo, view) {
  const label = String(text || "");
  const info = pathInfo && typeof pathInfo === "object" ? pathInfo : {};
  if (!info.isLinkable) {
    container.createSpan({ cls: "oc-patch-file-path", text: label });
    return;
  }
  const anchor = container.createEl("a", {
    cls: "oc-patch-file-path oc-patch-file-link internal-link",
    text: label,
    attr: {
      href: info.linkPath,
      "data-href": info.linkPath,
      title: info.rawPath || label,
    },
  });
  if (view && view.app && view.app.workspace && typeof view.app.workspace.openLinkText === "function") {
    anchor.addEventListener("click", (evt) => {
      if (!evt || (evt.button !== 0 && evt.button !== 1)) return;
      evt.preventDefault();
      evt.stopPropagation();
      const modEvent = typeof Keymap !== "undefined" && Keymap && typeof Keymap.isModEvent === "function"
        ? Keymap.isModEvent(evt)
        : Boolean(evt.metaKey || evt.ctrlKey);
      const sourcePath = typeof view.getMarkdownRenderSourcePath === "function"
        ? String(view.getMarkdownRenderSourcePath() || "")
        : "";
      const openInNewLeaf = Boolean(modEvent || evt.button === 1);
      void view.app.workspace.openLinkText(info.linkPath, sourcePath, openInNewLeaf);
    });
  }
}

function renderPatchFallbackFileList(container, entries, view) {
  const list = container.createDiv({ cls: "oc-tool-file-list" });
  entries.forEach((entry) => {
    const action = normalizePatchChangeType(entry && entry.action);
    const label = patchChangeLabel.call(view, action);
    const displayPath = patchFileDisplayPath(entry) || tFromContext(view, "view.block.pathMissing", "(path missing)");
    const targetPath = entry && (entry.to || entry.path || entry.from) ? (entry.to || entry.path || entry.from) : displayPath;
    const pathInfo = resolvePatchPathInfo(view, displayPath, targetPath);

    const item = list.createDiv({ cls: "oc-tool-file-item" });
    item.setAttr("data-change-type", action || "unknown");
    item.setAttr("title", pathInfo.rawPath || displayPath);
    item.createSpan({ cls: "oc-patch-file-action", text: `[${label}] ` });
    renderPatchPath(item, pathInfo.displayPath || displayPath, pathInfo, view);
  });
  if (typeof view.attachInternalLinkHandlers === "function") {
    view.attachInternalLinkHandlers(list);
  }
}

function renderPatchHunkLine(container, line) {
  const item = line && typeof line === "object" ? line : {};
  const type = String(item.type || "equal");
  const row = container.createDiv({ cls: "oc-patch-line" });
  row.setAttr("data-line-type", type);
  row.addClass(`is-${type}`);

  const prefix = row.createSpan({ cls: "oc-patch-line-prefix" });
  if (type === "insert") prefix.setText("+");
  else if (type === "delete") prefix.setText("-");
  else if (type === "omitted") prefix.setText("…");
  else prefix.setText(" ");

  row.createSpan({
    cls: "oc-patch-line-text",
    text: String(item.text || " "),
  });
}

function renderPatchDiffDetails(content, view, items) {
  if (!items.length) return false;

  const files = content.createDiv({ cls: "oc-patch-files" });
  items.forEach((item) => {
    const entry = item && item.entry ? item.entry : null;
    const diff = item && item.diff ? item.diff : null;
    const action = normalizePatchChangeType(entry && entry.action) !== "unknown"
      ? normalizePatchChangeType(entry && entry.action)
      : inferPatchActionFromDiff(diff, entry);
    const actionLabel = patchChangeLabel.call(view, action);
    const { displayPathRaw, targetPathRaw } = resolvePatchDisplayPaths(entry, diff);
    const displayPath = displayPathRaw || tFromContext(view, "view.block.pathMissing", "(path missing)");
    const pathInfo = resolvePatchPathInfo(view, displayPath, targetPathRaw);

    const fileDetails = files.createDiv({ cls: "oc-patch-file-details" });
    const summary = fileDetails.createDiv({ cls: "oc-patch-file-summary" });
    summary.createSpan({ cls: "oc-patch-file-action", text: `[${actionLabel}]` });

    const pathWrap = summary.createSpan({ cls: "oc-patch-file-summary-path" });
    renderPatchPath(pathWrap, pathInfo.displayPath || displayPath, pathInfo, view);
    summary.setAttr("title", pathInfo.rawPath || displayPath);

    const fileBody = fileDetails.createDiv({ cls: "oc-patch-file-body" });
    if (!diff) {
      fileBody.createDiv({
        cls: "oc-tool-result-text",
        text: tFromContext(view, "view.block.patchNoDiffForFile", "No line-level diff for this file."),
      });
      return;
    }

    const diffRender = buildPatchLineDiff(diff.before, diff.after, {
      maxMatrixCells: PATCH_MAX_MATRIX_CELLS,
      maxRenderedLines: PATCH_MAX_RENDERED_LINES,
    });
    const lines = Array.isArray(diffRender.lines) ? diffRender.lines : [];
    const stats = countPatchDiffStats(diff, lines);
    const statsText = `${stats.added > 0 ? `+${stats.added}` : "+0"} ${stats.removed > 0 ? `-${stats.removed}` : "-0"}`;
    summary.createSpan({ cls: "oc-patch-file-stats", text: statsText });

    const hunks = splitPatchDiffHunks(lines, { contextLines: PATCH_CONTEXT_LINES });
    if (!hunks.length) {
      fileBody.createDiv({
        cls: "oc-tool-result-text",
        text: tFromContext(view, "view.block.patchNoLineChanges", "No line changes detected."),
      });
    } else {
      hunks.forEach((hunk, hunkIndex) => {
        if (hunkIndex > 0) {
          fileBody.createDiv({ cls: "oc-patch-hunk-separator", text: "..." });
        }
        const hunkEl = fileBody.createDiv({ cls: "oc-patch-hunk" });
        hunkEl.createDiv({
          cls: "oc-patch-hunk-header",
          text: `@@ -${Number(hunk.oldStart || 1)} +${Number(hunk.newStart || 1)} @@`,
        });
        for (const line of hunk.lines) {
          renderPatchHunkLine(hunkEl, line);
        }
      });
    }

    if (diffRender.truncated) {
      const suffix = diffRender.matrixLimited
        ? tFromContext(view, "view.block.patchLargeFileFallback", "Large file fallback mode enabled.")
        : tFromContext(view, "view.block.patchLineTruncated", "Diff output was truncated.");
      fileBody.createDiv({
        cls: "oc-patch-truncated-note",
        text: `${suffix} ${tFromContext(view, "view.block.patchHiddenLines", "{count} lines hidden.", { count: Number(diffRender.hiddenLineCount || 0) })}`,
      });
    }
  });

  if (typeof view.attachInternalLinkHandlers === "function") {
    view.attachInternalLinkHandlers(files);
  }
  return true;
}

function renderReasoningPart(container, block, messagePending) {
  const details = container.createEl("details", { cls: "oc-thinking-block oc-part-reasoning" });
  const status = this.resolveDisplayBlockStatus(block, messagePending);
  details.addClass(`is-${status}`);
  details.setAttr("data-part-type", "reasoning");

  const summary = details.createEl("summary", { cls: "oc-thinking-header" });
  summary.createSpan({ cls: "oc-thinking-label", text: tFromContext(this, "view.block.reasoningShort", "Thought") });
  summary.createSpan({
    cls: "oc-thinking-state",
    text: this.blockStatusLabel(status),
  });

  const body = details.createDiv({ cls: "oc-thinking-content" });
  const detailText = clampRenderText(typeof block.detail === "string" ? block.detail : "", 16000);
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
    setNodeText(body, tFromContext(this, "view.block.empty", "..."));
  }

  details.open = Boolean(messagePending && (status === "running" || status === "pending"));
}

function pickToolInputForRender(block) {
  if (!block || typeof block !== "object") return null;
  if (block.toolInput && typeof block.toolInput === "object") return block.toolInput;
  if (block.raw && block.raw.state && block.raw.state.input && typeof block.raw.state.input === "object") {
    return block.raw.state.input;
  }
  if (block.raw && block.raw.input && typeof block.raw.input === "object") return block.raw.input;
  return null;
}

function extractQuotedPathFromText(text) {
  const raw = String(text || "");
  if (!raw) return "";
  const patterns = [
    /"(?:filePath|file_path|path|target_path)"\s*:\s*"([^"]+)"/i,
    /\b(?:Updated|Wrote|Read)\s+([A-Za-z]:[\\/][^\n]+|\/[^\n]+)/i,
    /([A-Za-z]:[\\/][^\s"']+|\/[^\s"']+)/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match && match[1]) return normalizePatchPath(match[1]);
  }
  return "";
}

function inferToolFilePath(block, toolName, summaryText, detailText) {
  const normalizedTool = String(toolName || "").trim().toLowerCase();
  const input = pickToolInputForRender(block);
  const fromInput = normalizePatchPath(
    input && (
      input.filePath
      || input.file_path
      || input.path
      || input.target_path
      || input.targetPath
      || input.filename
      || input.file
    ),
  );
  if (fromInput) return fromInput;

  if (!["read", "write", "edit", "multiedit", "todowrite"].includes(normalizedTool)) return "";
  const fromSummary = extractQuotedPathFromText(summaryText);
  if (fromSummary) return fromSummary;
  return extractQuotedPathFromText(detailText);
}

function stripToolPathFromSummary(summaryText, filePath) {
  const summary = String(summaryText || "").trim();
  const path = String(filePath || "").trim();
  if (!summary) return "";
  if (!path) return summary;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = summary
    .replace(new RegExp(escaped, "ig"), "")
    .replace(/\s{2,}/g, " ")
    .replace(/[·•\-:\s]+$/, "")
    .trim();
  return stripped || summary;
}

function pickToolOutputForRender(block) {
  if (!block || typeof block !== "object") return "";
  if (typeof block.toolOutput === "string" && block.toolOutput.trim()) return block.toolOutput;
  const raw = block.raw && typeof block.raw === "object" ? block.raw : {};
  const state = raw.state && typeof raw.state === "object" ? raw.state : {};
  if (typeof state.output === "string" && state.output.trim()) return state.output;
  if (typeof raw.output === "string" && raw.output.trim()) return raw.output;
  return "";
}

function inferMutationActionFromText(toolName, text) {
  const normalizedTool = String(toolName || "").trim().toLowerCase();
  const raw = String(text || "");
  if (/\b(deleted|removed|remove)\b/i.test(raw)) return "deleted";
  if (/\b(renamed|rename|moved|move)\b/i.test(raw)) return "renamed";
  if (/\b(created|create|added|add)\b/i.test(raw)) return "added";
  if (normalizedTool === "write") return "modified";
  return "modified";
}

function isMutationToolCall(block, toolName, filePath, detailText, summaryText) {
  const normalizedTool = String(toolName || "").trim().toLowerCase();
  if (!filePath) return false;
  if (FILE_MUTATION_TOOL_NAMES.has(normalizedTool)) return true;
  const combined = [
    String(summaryText || ""),
    String(detailText || ""),
    String(pickToolOutputForRender(block) || ""),
  ].join("\n");
  return /\b(updated|modified|created|wrote|deleted|removed|patched|renamed)\b/i.test(combined);
}

function findMatchingDiffEntryForPath(view, diffEntries, pathValue) {
  const targetKeys = new Set(collectComparablePatchPaths(view, pathValue));
  if (!targetKeys.size) return null;
  for (const diff of Array.isArray(diffEntries) ? diffEntries : []) {
    for (const key of collectComparablePatchPaths(view, diff && diff.file)) {
      if (targetKeys.has(key)) return diff;
    }
  }
  return null;
}

function buildMutationFallbackEntry(toolName, filePath, detailText, summaryText) {
  const path = normalizePatchPath(filePath);
  if (!path) return null;
  return {
    action: inferMutationActionFromText(toolName, `${summaryText || ""}\n${detailText || ""}`),
    path,
  };
}

function collectToolLocalDiffEntries(block, view) {
  const metadata = block && block.metadata && typeof block.metadata === "object"
    ? block.metadata
    : {};
  const rawEntries = [];
  const filediff = metadata.filediff && typeof metadata.filediff === "object" ? metadata.filediff : null;
  if (filediff) rawEntries.push(filediff);

  const filediffs = Array.isArray(metadata.filediffs) ? metadata.filediffs : [];
  for (const item of filediffs) rawEntries.push(item);

  const normalized = [];
  for (const entry of rawEntries) {
    const diff = normalizePatchDiffEntry(entry);
    if (!diff) continue;
    if (isHiddenPatchDiff(view, diff)) continue;
    normalized.push(diff);
  }
  return normalized;
}

function renderToolPart(container, block, messagePending, message) {
  const status = this.resolveDisplayBlockStatus(block, messagePending);
  const toolName = this.toolDisplayName(block) || tFromContext(this, "view.block.tool", "tool");
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
  const detailText = clampRenderText(String((block && block.detail) || "").trim(), 12000);

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
  const linkedFilePathRaw = inferToolFilePath(block, normalizedToolName, summaryText, detailText);
  const linkedFilePath = pathContainsDotPrefixedFolder(this, linkedFilePathRaw) ? "" : linkedFilePathRaw;
  const linkedPathInfo = linkedFilePath
    ? resolvePatchPathInfo(this, linkedFilePath, linkedFilePath)
    : null;
  const summaryLabel = stripToolPathFromSummary(summaryText, linkedFilePath);
  summaryEl.setText(summaryLabel);

  if (linkedPathInfo && linkedPathInfo.displayPath) {
    if (summaryLabel) {
      header.createSpan({ cls: "oc-patch-summary-divider", text: "·" });
    }
    const pathWrap = header.createSpan({ cls: "oc-patch-summary-path oc-tool-summary-path" });
    renderPatchPath(pathWrap, linkedPathInfo.displayPath, linkedPathInfo, this);
  }

  const statusEl = header.createSpan({ cls: "oc-tool-status" });
  applyToolStatusIcon(statusEl, status);

  const content = details.createDiv({ cls: "oc-tool-content" });
  const shouldRenderMutationCard = isMutationToolCall(block, normalizedToolName, linkedFilePath, detailText, summaryText);

  if (shouldRenderMutationCard) {
    details.addClass("oc-tool-patch");
    content.addClass("oc-tool-patch-content");

    const localDiffEntries = collectToolLocalDiffEntries(block, this);
    const hasLocalDiff = localDiffEntries.length > 0;

    let diffState = null;
    if (!hasLocalDiff) {
      ensurePatchDiffStateStore(this);
      const patchRequest = getPatchDiffRequest(this, block, message);
      const patchKey = patchRequest && patchRequest.key ? patchRequest.key : "";
      diffState = patchKey ? this.patchDiffCache.get(patchKey) : null;
      if (!messagePending && patchKey && !diffState) {
        requestPatchDiff(this, block, message);
        diffState = this.patchDiffCache.get(patchKey) || null;
      }
    }

    const sessionDiffEntries = diffState && diffState.status === "ready" && Array.isArray(diffState.items)
      ? diffState.items.filter((diff) => !isHiddenPatchDiff(this, diff))
      : [];
    const diffEntries = hasLocalDiff ? localDiffEntries : sessionDiffEntries;
    const matchedDiff = findMatchingDiffEntryForPath(this, diffEntries, linkedFilePath)
      || (diffEntries.length === 1 ? diffEntries[0] : null);
    const fallbackEntry = buildMutationFallbackEntry(normalizedToolName, linkedFilePath, detailText, summaryText);
    const renderItems = matchedDiff || fallbackEntry ? [{ entry: fallbackEntry, diff: matchedDiff }] : [];
    const renderedDiff = renderItems.length
      ? renderPatchDiffDetails(content, this, renderItems)
      : false;

    if (!renderedDiff && fallbackEntry) {
      renderPatchFallbackFileList(content, [fallbackEntry], this);
    } else if (!renderedDiff) {
      content.createDiv({ cls: "oc-tool-result-text", text: tFromContext(this, "view.block.patchNoDetail", "No patch details detected") });
    }

    if (!hasLocalDiff && diffState && diffState.status === "pending") {
      content.createDiv({
        cls: "oc-tool-result-text oc-patch-load-status",
        text: tFromContext(this, "view.block.patchLoadingDiff", "Loading line-level diff..."),
      });
    }
    if (!hasLocalDiff && diffState && diffState.status === "error") {
      content.createDiv({
        cls: "oc-tool-result-text oc-patch-load-status is-warning",
        text: tFromContext(this, "view.block.patchDiffFallback", "Line-level diff unavailable; showing file list."),
      });
    }
    return;
  }

  if (questionItems.length) {
    content.createDiv({
      cls: "oc-question-inline-note",
      text: tFromContext(this, "view.question.answerInPanel", "Please answer in the panel below."),
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
    content.createDiv({ cls: "oc-tool-result-text", text: tFromContext(this, "view.block.noResult", "No result yet") });
  }
}

function renderPatchPart(container, block, messagePending, message, blockIndex) {
  void blockIndex;
  const status = this.resolveDisplayBlockStatus(block, messagePending);
  const detailText = clampRenderText(String((block && block.detail) || "").trim(), 12000);
  const entries = extractPatchFileEntries(block, detailText).filter((entry) => !isHiddenPatchEntry(this, entry));

  ensurePatchDiffStateStore(this);
  const patchRequest = getPatchDiffRequest(this, block, message);
  const patchKey = patchRequest && patchRequest.key ? patchRequest.key : "";
  let diffState = patchKey ? this.patchDiffCache.get(patchKey) : null;
  if (!messagePending && patchKey && !diffState) {
    requestPatchDiff(this, block, message);
    diffState = this.patchDiffCache.get(patchKey) || null;
  }

  const diffEntries = diffState && diffState.status === "ready" && Array.isArray(diffState.items)
    ? diffState.items.filter((diff) => !isHiddenPatchDiff(this, diff))
    : [];
  const renderItems = buildPatchRenderItems(this, entries, diffEntries);
  if (!messagePending && diffState && diffState.status === "ready" && !renderItems.length) return;
  const changeSummary = summarizePatchChanges(entries);
  const summaryText = changeSummary
    || (renderItems.length ? `${renderItems.length} 个文件变更` : "")
    || tFromContext(this, "view.block.patchLabel", "File change");
  const summaryPaths = collectPatchSummaryPaths(this, renderItems);

  const details = container.createEl("details", { cls: "oc-tool-call oc-tool-patch" });
  details.addClass(`is-${status}`);
  details.setAttr("data-part-type", "patch");
  details.setAttr("data-tool-name", "patch");
  details.open = messagePending ? (status === "running" || status === "error") : status === "error";

  const header = details.createEl("summary", { cls: "oc-tool-header" });
  const iconEl = header.createSpan({ cls: "oc-tool-icon" });
  safeSetIcon(iconEl, "git-commit-horizontal");
  header.createSpan({ cls: "oc-tool-name", text: tFromContext(this, "view.block.patchLabel", "File change") });
  header.createSpan({ cls: "oc-tool-summary", text: summaryText });
  if (summaryPaths.length) {
    header.createSpan({ cls: "oc-patch-summary-divider", text: "·" });
    const summaryPathWrap = header.createSpan({ cls: "oc-patch-summary-path" });
    const primaryPath = summaryPaths.find((item) => item && item.pathInfo && item.pathInfo.isLinkable) || summaryPaths[0];
    renderPatchPath(summaryPathWrap, primaryPath.label, primaryPath.pathInfo, this);
    if (summaryPaths.length > 1) {
      header.createSpan({ cls: "oc-patch-summary-more", text: `+${summaryPaths.length - 1}` });
    }
  }
  const expandEl = header.createSpan({ cls: "oc-patch-expand-indicator" });
  safeSetIcon(expandEl, "chevron-right");
  const statusEl = header.createSpan({ cls: "oc-tool-status" });
  applyToolStatusIcon(statusEl, status);

  const content = details.createDiv({ cls: "oc-tool-content oc-tool-patch-content" });
  const renderedDiff = diffEntries.length
    ? renderPatchDiffDetails(content, this, renderItems)
    : false;
  if (!renderedDiff && entries.length) {
    renderPatchFallbackFileList(content, entries, this);
  } else if (!renderedDiff) {
    content.createDiv({ cls: "oc-tool-result-text", text: tFromContext(this, "view.block.patchNoDetail", "No patch details detected") });
  }

  if (diffState && diffState.status === "pending") {
    content.createDiv({
      cls: "oc-tool-result-text oc-patch-load-status",
      text: tFromContext(this, "view.block.patchLoadingDiff", "Loading line-level diff..."),
    });
  }
  if (diffState && diffState.status === "error") {
    content.createDiv({
      cls: "oc-tool-result-text oc-patch-load-status is-warning",
      text: tFromContext(this, "view.block.patchDiffFallback", "Line-level diff unavailable; showing file list."),
    });
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

  const summary = clampRenderText(typeof block.summary === "string" ? block.summary.trim() : "", 2400);
  if (summary) card.createDiv({ cls: "oc-part-summary", text: summary });

  const preview = clampRenderText(typeof block.preview === "string" ? block.preview.trim() : "", 3200);
  if (preview) card.createDiv({ cls: "oc-part-preview", text: preview });

  const detail = clampRenderText(typeof block.detail === "string" ? block.detail.trim() : "", 12000);
  if (detail) {
    const details = card.createEl("details", { cls: "oc-part-details" });
    details.createEl("summary", { text: tFromContext(this, "view.block.viewDetail", "View details") });
    details.createEl("pre", { cls: "oc-part-detail", text: detail });
  }
}

function renderStreamTextPart(container, block, messagePending) {
  const card = container.createDiv({ cls: "oc-stream-text-part" });
  const status = this.resolveDisplayBlockStatus(block, messagePending);
  card.addClass(`is-${status}`);
  card.setAttr("data-part-type", "stream-text");

  const body = card.createDiv({ cls: "oc-stream-text-content" });
  const markdown = normalizeMarkdownForDisplay(
    clampRenderText(
      typeof block.detail === "string" && block.detail
        ? block.detail
        : (typeof block.text === "string" ? block.text : ""),
      16000,
    ),
  );
  if (markdown.trim()) {
    this.renderMarkdownSafely(body, markdown, () => {
      this.enhanceCodeBlocks(body);
    });
  } else {
    body.setText("...");
  }
}

function renderAssistantBlocks(row, message) {
  const messagePending = Boolean(message && message.pending);
  const blocks = this
    .visibleAssistantBlocks(message.blocks)
    .filter((block) => {
      const type = String((block && block.type) || "").trim().toLowerCase();
      if (type !== "stream-text") return true;
      return messagePending;
    });
  const container = this.ensureBlocksContainer(row);
  container.empty();
  if (!blocks.length) {
    container.toggleClass("is-empty", true);
    return;
  }
  container.toggleClass("is-empty", false);

  blocks.forEach((block, blockIndex) => {
    const type = String((block && block.type) || "").trim().toLowerCase();
    if (type === "reasoning") {
      this.renderReasoningPart(container, block, messagePending);
      return;
    }
    if (type === "tool") {
      this.renderToolPart(container, block, messagePending, message);
      return;
    }
    if (type === "patch") {
      this.renderPatchPart(container, block, messagePending, message, blockIndex);
      return;
    }
    if (type === "stream-text") {
      this.renderStreamTextPart(container, block, messagePending);
      return;
    }

    this.renderGenericPart(container, block, messagePending);
  });
}

function renderAssistantMeta(row, message) {
  const metaText = clampRenderText(typeof message.meta === "string" ? message.meta.trim() : "", 8000);
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
  renderStreamTextPart,
  renderGenericPart,
  renderAssistantBlocks,
  renderAssistantMeta,
};

module.exports = { blockRenderMethods };
