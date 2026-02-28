const { Notice, setIcon } = require("obsidian");
const {
  LINKED_CONTEXT_MAX_FILES,
  LINKED_CONTEXT_MAX_CHARS_PER_FILE,
  LINKED_CONTEXT_MAX_TOTAL_CHARS,
  LINKED_CONTEXT_PICKER_MAX_ITEMS,
  tr,
  normalizeLinkedContextPath,
  displayNameFromPath,
  isLinkableContextFile,
  createLinkableContextEntry,
} = require("./shared-utils");

function getLinkedContextFilePaths() {
  if (!Array.isArray(this.linkedContextFiles)) this.linkedContextFiles = [];
  const seen = new Set();
  const normalized = [];
  for (const rawPath of this.linkedContextFiles) {
    const next = normalizeLinkedContextPath(rawPath);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  this.linkedContextFiles = normalized;
  return normalized;
}

function listLinkableVaultFiles() {
  const vault = this.app && this.app.vault;
  if (!vault || typeof vault.getFiles !== "function") return [];
  const entries = vault
    .getFiles()
    .filter((file) => isLinkableContextFile(file))
    .map((file) => createLinkableContextEntry(file))
    .filter(Boolean);
  entries.sort((a, b) => String(a.path || "").localeCompare(String(b.path || ""), undefined, { sensitivity: "base" }));
  return entries;
}

function refreshLinkedContextIndicators() {
  const contextRow = this.elements && this.elements.contextRow;
  const fileIndicator = this.elements && this.elements.fileIndicator;
  const selectionIndicator = this.elements && this.elements.selectionIndicator;
  if (!contextRow || !fileIndicator || !selectionIndicator) return;

  const linkedPaths = this.getLinkedContextFilePaths();
  fileIndicator.empty();

  if (!linkedPaths.length) {
    contextRow.toggleClass("has-content", false);
    fileIndicator.style.display = "none";
    selectionIndicator.textContent = "";
    selectionIndicator.setAttr("title", "");
    return;
  }

  linkedPaths.forEach((pathValue) => {
    const chip = fileIndicator.createDiv({
      cls: "oc-context-file-chip",
      attr: { title: pathValue },
    });
    const iconEl = chip.createSpan({ cls: "oc-context-file-chip-icon" });
    setIcon(iconEl, "file-text");
    chip.createSpan({
      cls: "oc-context-file-chip-name",
      text: displayNameFromPath(pathValue),
    });
    const removeBtn = chip.createEl("button", {
      cls: "oc-context-file-chip-remove",
      text: "×",
    });
    removeBtn.setAttr("type", "button");
    removeBtn.setAttr("aria-label", tr(this, "view.context.removeFile", "Remove linked file"));
    removeBtn.setAttr("title", tr(this, "view.context.removeFile", "Remove linked file"));
    removeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.removeLinkedContextFile(pathValue);
    });
  });

  contextRow.toggleClass("has-content", true);
  fileIndicator.style.display = "flex";
  const counterText = tr(this, "view.context.fileCount", "{count} linked file(s)", { count: linkedPaths.length });
  selectionIndicator.textContent = counterText;
  selectionIndicator.setAttr("title", counterText);
}

function toggleLinkedContextFile(pathOrFile) {
  const normalizedPath = normalizeLinkedContextPath(pathOrFile && pathOrFile.path ? pathOrFile.path : pathOrFile);
  if (!normalizedPath) return;
  const linkedPaths = this.getLinkedContextFilePaths();
  const existingIndex = linkedPaths.indexOf(normalizedPath);
  if (existingIndex >= 0) {
    linkedPaths.splice(existingIndex, 1);
    this.linkedContextFiles = linkedPaths;
    this.refreshLinkedContextIndicators();
    return;
  }
  if (linkedPaths.length >= LINKED_CONTEXT_MAX_FILES) {
    new Notice(tr(this, "view.context.maxFiles", "You can link up to {count} files at once.", {
      count: LINKED_CONTEXT_MAX_FILES,
    }));
    return;
  }
  linkedPaths.push(normalizedPath);
  this.linkedContextFiles = linkedPaths;
  this.refreshLinkedContextIndicators();
}

function removeLinkedContextFile(pathValue) {
  const normalizedPath = normalizeLinkedContextPath(pathValue);
  if (!normalizedPath) return;
  const linkedPaths = this.getLinkedContextFilePaths().filter((item) => item !== normalizedPath);
  this.linkedContextFiles = linkedPaths;
  this.refreshLinkedContextIndicators();
}

function clearLinkedContextFiles(options = {}) {
  const linkedPaths = this.getLinkedContextFilePaths();
  if (!linkedPaths.length) {
    if (options && options.closePicker) {
      this.closeLinkedContextFilePicker();
    }
    return;
  }
  this.linkedContextFiles = [];
  this.refreshLinkedContextIndicators();
  if (options && options.closePicker) {
    this.closeLinkedContextFilePicker();
  }
}

function ensureLinkedContextPickerState() {
  if (!this.linkedContextFilePicker || typeof this.linkedContextFilePicker !== "object") {
    this.linkedContextFilePicker = {
      visible: false,
      mode: "button",
      mentionStart: -1,
      query: "",
      selectedIndex: 0,
      entries: [],
      filtered: [],
      lastLoadAt: 0,
      rootEl: null,
      searchEl: null,
      listEl: null,
      emptyEl: null,
    };
  }
  return this.linkedContextFilePicker;
}

function ensureLinkedContextPickerDocumentBinding() {
  if (this.linkedContextFilePickerDocumentBound) return;
  this.linkedContextFilePickerDocumentBound = true;

  this.registerDomEvent(document, "click", (event) => {
    const picker = this.ensureLinkedContextPickerState();
    if (!picker.visible) return;
    const target = event && event.target ? event.target : null;
    if (!(target instanceof Node)) return;
    if (picker.rootEl && picker.rootEl.contains(target)) return;
    if (this.elements && this.elements.attachFileBtn && this.elements.attachFileBtn.contains(target)) return;
    this.closeLinkedContextFilePicker();
  });
}

function closeLinkedContextFilePicker(options = {}) {
  const picker = this.ensureLinkedContextPickerState();
  picker.visible = false;
  picker.mode = "button";
  picker.mentionStart = -1;
  picker.query = "";
  picker.selectedIndex = 0;
  picker.filtered = [];
  if (picker.rootEl && picker.rootEl.isConnected) {
    picker.rootEl.remove();
  }
  picker.rootEl = null;
  picker.searchEl = null;
  picker.listEl = null;
  picker.emptyEl = null;

  if (options && options.focusInput && this.elements && this.elements.input) {
    this.elements.input.focus();
  }
}

function detectLinkedContextMentionQuery() {
  const inputEl = this.elements && this.elements.input;
  if (!inputEl) return null;

  const text = String(inputEl.value || "");
  const cursor = Number(inputEl.selectionStart || 0);
  const beforeCursor = text.slice(0, cursor);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex < 0) return null;

  const charBefore = atIndex > 0 ? beforeCursor.charAt(atIndex - 1) : " ";
  if (atIndex > 0 && !/\s/.test(charBefore)) return null;

  const token = beforeCursor.slice(atIndex + 1);
  if (/\s/.test(token)) return null;

  return {
    start: atIndex,
    cursor,
    query: token,
  };
}

function syncLinkedContextPickerFromInputMention() {
  const picker = this.ensureLinkedContextPickerState();
  const mention = this.detectLinkedContextMentionQuery();
  if (!mention) {
    if (picker.visible && picker.mode === "mention") {
      this.closeLinkedContextFilePicker();
    }
    return;
  }

  const now = Date.now();
  const shouldReloadEntries = !Array.isArray(picker.entries)
    || !picker.entries.length
    || !picker.visible
    || picker.mode !== "mention"
    || (now - Number(picker.lastLoadAt || 0)) > 5000;

  if (shouldReloadEntries) {
    picker.entries = this.listLinkableVaultFiles();
    picker.lastLoadAt = now;
  }
  if (!picker.entries.length) {
    if (picker.visible && picker.mode === "mention") {
      this.closeLinkedContextFilePicker();
    }
    return;
  }

  const isDifferentQuery = picker.query !== mention.query;
  picker.mode = "mention";
  picker.mentionStart = mention.start;
  picker.query = mention.query;
  picker.visible = true;
  if (isDifferentQuery || !picker.filtered.length) {
    picker.selectedIndex = 0;
  }

  this.ensureLinkedContextPickerDocumentBinding();
  this.renderLinkedContextFilePicker();
}

function handleLinkedContextInputKeydown(event) {
  const picker = this.ensureLinkedContextPickerState();
  if (!picker.visible || picker.mode !== "mention") return false;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    this.moveLinkedContextPickerSelection(1);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    this.moveLinkedContextPickerSelection(-1);
    return true;
  }
  if ((event.key === "Enter" || event.key === "Tab") && !event.isComposing) {
    event.preventDefault();
    if (Array.isArray(picker.filtered) && picker.filtered.length) {
      this.selectLinkedContextPickerEntry(picker.selectedIndex, { close: true, fromMention: true });
      return true;
    }
    this.closeLinkedContextFilePicker({ focusInput: true });
    return true;
  }
  if (event.key === "Escape" && !event.isComposing) {
    event.preventDefault();
    this.closeLinkedContextFilePicker({ focusInput: true });
    return true;
  }
  return false;
}

function filterLinkedContextPickerEntries(picker) {
  const query = String(picker.query || "").trim().toLowerCase();
  const linkedSet = new Set(this.getLinkedContextFilePaths());
  const base = Array.isArray(picker.entries) ? picker.entries.slice() : [];

  const filtered = base
    .filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (!query) return true;
      return String(entry.search || "").includes(query);
    })
    .sort((a, b) => {
      const aName = String(a.name || "").toLowerCase();
      const bName = String(b.name || "").toLowerCase();
      const aStarts = query ? aName.startsWith(query) : false;
      const bStarts = query ? bName.startsWith(query) : false;
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      const aLinked = linkedSet.has(a.path);
      const bLinked = linkedSet.has(b.path);
      if (aLinked && !bLinked) return -1;
      if (!aLinked && bLinked) return 1;

      const aMtime = Number(a.mtime || 0);
      const bMtime = Number(b.mtime || 0);
      if (aMtime !== bMtime) return bMtime - aMtime;
      return String(a.path || "").localeCompare(String(b.path || ""), undefined, { sensitivity: "base" });
    })
    .slice(0, LINKED_CONTEXT_PICKER_MAX_ITEMS);

  picker.filtered = filtered;
  if (!filtered.length) {
    picker.selectedIndex = 0;
    return;
  }
  const maxIndex = filtered.length - 1;
  picker.selectedIndex = Math.max(0, Math.min(maxIndex, Number(picker.selectedIndex || 0)));
}

function moveLinkedContextPickerSelection(delta) {
  const picker = this.ensureLinkedContextPickerState();
  if (!picker.visible || !Array.isArray(picker.filtered) || !picker.filtered.length) return;
  const maxIndex = picker.filtered.length - 1;
  picker.selectedIndex = Math.max(0, Math.min(maxIndex, Number(picker.selectedIndex || 0) + Number(delta || 0)));
  this.renderLinkedContextFilePickerList();
}

function selectLinkedContextPickerEntry(index, options = {}) {
  const picker = this.ensureLinkedContextPickerState();
  const item = Array.isArray(picker.filtered) ? picker.filtered[index] : null;
  if (!item || !item.path) return;

  const fromMention = Boolean(options && options.fromMention);
  if (fromMention && this.elements && this.elements.input) {
    const inputEl = this.elements.input;
    const text = String(inputEl.value || "");
    let start = Number(picker.mentionStart || -1);
    let end = Number(inputEl.selectionStart || 0);

    if (start < 0 || end < start || text.charAt(start) !== "@") {
      const mention = this.detectLinkedContextMentionQuery();
      if (mention) {
        start = mention.start;
        end = mention.cursor;
      }
    }

    if (start >= 0 && end >= start) {
      const before = text.slice(0, start);
      const after = text.slice(end).replace(/^\s+/, "");
      const needsSpace = Boolean(before && after && !/\s$/.test(before));
      const next = `${before}${needsSpace ? " " : ""}${after}`;
      const nextCursor = before.length + (needsSpace ? 1 : 0);
      inputEl.value = next;
      inputEl.selectionStart = inputEl.selectionEnd = nextCursor;
    }
  }

  this.toggleLinkedContextFile(item.path);
  const closeAfterSelect = options && Object.prototype.hasOwnProperty.call(options, "close")
    ? Boolean(options.close)
    : true;
  if (closeAfterSelect) {
    this.closeLinkedContextFilePicker({ focusInput: true });
  } else {
    this.renderLinkedContextFilePickerList();
  }
}

function renderLinkedContextFilePickerList() {
  const picker = this.ensureLinkedContextPickerState();
  if (!picker.visible || !picker.listEl || !picker.rootEl) return;

  this.filterLinkedContextPickerEntries(picker);
  picker.listEl.empty();

  if (!picker.filtered.length) {
    picker.listEl.createDiv({
      cls: "oc-context-file-picker-empty",
      text: tr(this, "view.context.picker.empty", "No matching files."),
    });
    return;
  }

  const linkedSet = new Set(this.getLinkedContextFilePaths());
  picker.filtered.forEach((entry, index) => {
    const item = picker.listEl.createDiv({
      cls: "oc-context-file-picker-item",
      attr: { title: entry.path },
    });
    if (index === picker.selectedIndex) item.addClass("is-selected");
    if (linkedSet.has(entry.path)) item.addClass("is-linked");

    const textWrap = item.createDiv({ cls: "oc-context-file-picker-item-text" });
    textWrap.createDiv({ cls: "oc-context-file-picker-item-name", text: entry.name || displayNameFromPath(entry.path) || entry.path });
    textWrap.createDiv({ cls: "oc-context-file-picker-item-path", text: entry.path });

    if (linkedSet.has(entry.path)) {
      item.createDiv({ cls: "oc-context-file-picker-item-meta", text: tr(this, "view.context.picker.linked", "Linked") });
    }

    item.addEventListener("mouseenter", () => {
      if (picker.selectedIndex === index) return;
      picker.selectedIndex = index;
      const previousSelected = picker.listEl ? picker.listEl.querySelector(".oc-context-file-picker-item.is-selected") : null;
      if (previousSelected && previousSelected !== item) {
        previousSelected.classList.remove("is-selected");
      }
      item.classList.add("is-selected");
    });
    item.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      this.selectLinkedContextPickerEntry(index, { close: true, fromMention: picker.mode === "mention" });
    });
  });
}

function renderLinkedContextFilePicker() {
  const picker = this.ensureLinkedContextPickerState();
  if (!picker.visible) {
    this.closeLinkedContextFilePicker();
    return;
  }

  const inputWrapper = this.elements && this.elements.inputWrapper;
  if (!inputWrapper) return;

  if (!picker.rootEl || !picker.rootEl.isConnected) {
    picker.rootEl = inputWrapper.createDiv({ cls: "oc-context-file-picker" });
    picker.rootEl.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    picker.rootEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    picker.searchEl = picker.rootEl.createEl("input", {
      cls: "oc-context-file-picker-search",
      attr: {
        type: "text",
        placeholder: tr(this, "view.context.picker.search", "Search Obsidian files..."),
      },
    });

    picker.searchEl.addEventListener("input", () => {
      picker.query = String(picker.searchEl.value || "");
      picker.selectedIndex = 0;
      this.renderLinkedContextFilePickerList();
    });

    picker.searchEl.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.moveLinkedContextPickerSelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.moveLinkedContextPickerSelection(-1);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.isComposing) {
        event.preventDefault();
        this.selectLinkedContextPickerEntry(picker.selectedIndex, { close: true, fromMention: picker.mode === "mention" });
        return;
      }
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        this.closeLinkedContextFilePicker({ focusInput: true });
      }
    });

    picker.listEl = picker.rootEl.createDiv({ cls: "oc-context-file-picker-list" });
  }

  const mentionMode = picker.mode === "mention";
  if (picker.rootEl) {
    picker.rootEl.toggleClass("is-mention-mode", mentionMode);
  }

  if (picker.searchEl) {
    picker.searchEl.value = String(picker.query || "");
    picker.searchEl.style.display = mentionMode ? "none" : "";
  }
  this.renderLinkedContextFilePickerList();
}

function openLinkedContextFilePicker() {
  const picker = this.ensureLinkedContextPickerState();
  if (picker.visible) {
    if (picker.mode === "mention") {
      picker.mode = "button";
      picker.mentionStart = -1;
      picker.query = "";
      picker.selectedIndex = 0;
      if (!Array.isArray(picker.entries) || !picker.entries.length) {
        picker.entries = this.listLinkableVaultFiles();
      }
      this.renderLinkedContextFilePicker();
      if (picker.searchEl) picker.searchEl.focus();
      return;
    }
    this.closeLinkedContextFilePicker({ focusInput: true });
    return;
  }

  const entries = this.listLinkableVaultFiles();
  if (!entries.length) {
    new Notice(tr(this, "view.context.noFiles", "No linkable vault files found."));
    return;
  }

  picker.entries = entries;
  picker.lastLoadAt = Date.now();
  picker.mode = "button";
  picker.mentionStart = -1;
  picker.query = "";
  picker.selectedIndex = 0;
  picker.visible = true;
  this.ensureLinkedContextPickerDocumentBinding();
  this.renderLinkedContextFilePicker();
  if (picker.searchEl) picker.searchEl.focus();
}

async function buildLinkedContextPromptBlock(options = {}) {
  const candidatePaths = options && Array.isArray(options.linkedPaths) ? options.linkedPaths : this.getLinkedContextFilePaths();
  const linkedPaths = candidatePaths
    .map((pathValue) => normalizeLinkedContextPath(pathValue))
    .filter(Boolean);
  if (!linkedPaths.length) return "";

  const vault = this.app && this.app.vault;
  if (!vault || typeof vault.getAbstractFileByPath !== "function") return "";

  const sections = [
    "Additional context from user-linked Obsidian files (@):",
    "Use these files as reference context when answering the request.",
  ];
  let totalChars = 0;
  let included = 0;
  let skipped = 0;

  for (const pathValue of linkedPaths) {
    const target = vault.getAbstractFileByPath(pathValue);
    if (!target || typeof target.path !== "string") {
      skipped += 1;
      continue;
    }

    let rawText = "";
    try {
      rawText = typeof vault.cachedRead === "function"
        ? await vault.cachedRead(target)
        : await vault.read(target);
    } catch {
      skipped += 1;
      continue;
    }

    const content = String(rawText || "");
    const remain = LINKED_CONTEXT_MAX_TOTAL_CHARS - totalChars;
    if (remain <= 0) {
      skipped += 1;
      continue;
    }

    const allowed = Math.min(remain, LINKED_CONTEXT_MAX_CHARS_PER_FILE);
    const snippet = content.slice(0, allowed);
    const truncated = content.length > snippet.length;
    totalChars += snippet.length;
    included += 1;

    sections.push(``);
    sections.push(`<<<FLOWNOTE_FILE path="${target.path}">>>`);
    sections.push(snippet);
    if (truncated) {
      sections.push(`[Truncated to ${snippet.length} chars]`);
    }
    sections.push("<<<END_FLOWNOTE_FILE>>>");
  }

  if (!included) return "";
  if (skipped > 0) {
    sections.push(``);
    sections.push(`[Note] ${skipped} linked file(s) were skipped due to read errors or size limits.`);
  }

  return sections.join("\n");
}

async function composePromptWithLinkedFiles(basePrompt, options = {}) {
  const prompt = String(basePrompt || "");
  if (!prompt) return prompt;
  const candidatePaths = options && Array.isArray(options.linkedPaths) ? options.linkedPaths : this.getLinkedContextFilePaths();
  const linkedPaths = candidatePaths
    .map((pathValue) => normalizeLinkedContextPath(pathValue))
    .filter(Boolean);
  if (!linkedPaths.length) return prompt;

  try {
    const contextBlock = await this.buildLinkedContextPromptBlock({ linkedPaths });
    if (!contextBlock) return prompt;
    return `${contextBlock}\n\nUser request:\n${prompt}`;
  } catch (error) {
    if (this.plugin && typeof this.plugin.log === "function") {
      this.plugin.log(`compose linked context prompt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return prompt;
  }
}

const linkedContextMethods = {
  getLinkedContextFilePaths,
  listLinkableVaultFiles,
  refreshLinkedContextIndicators,
  toggleLinkedContextFile,
  removeLinkedContextFile,
  clearLinkedContextFiles,
  ensureLinkedContextPickerState,
  ensureLinkedContextPickerDocumentBinding,
  closeLinkedContextFilePicker,
  detectLinkedContextMentionQuery,
  syncLinkedContextPickerFromInputMention,
  handleLinkedContextInputKeydown,
  filterLinkedContextPickerEntries,
  moveLinkedContextPickerSelection,
  selectLinkedContextPickerEntry,
  renderLinkedContextFilePickerList,
  renderLinkedContextFilePicker,
  openLinkedContextFilePicker,
  buildLinkedContextPromptBlock,
  composePromptWithLinkedFiles,
};

module.exports = { linkedContextMethods };
