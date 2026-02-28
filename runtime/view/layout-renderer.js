const { Notice, setIcon } = require("obsidian");
const {
  normalizeSessionTitleInput: normalizeSessionTitleFromDomain,
  isPlaceholderSessionTitle: isPlaceholderSessionTitleFromDomain,
  deriveSessionTitleFromPrompt: deriveSessionTitleFromPromptFromDomain,
  resolveSessionDisplayTitle,
} = require("../domain/session-title");
const { tFromContext } = require("../i18n-runtime");

const LINKED_CONTEXT_ALLOWED_EXTENSIONS = new Set(["md", "canvas", "txt", "json", "csv", "yaml", "yml"]);
const LINKED_CONTEXT_MAX_FILES = 12;
const LINKED_CONTEXT_MAX_CHARS_PER_FILE = 9000;
const LINKED_CONTEXT_MAX_TOTAL_CHARS = 36000;
const LINKED_CONTEXT_PICKER_MAX_ITEMS = 120;

function tr(view, key, fallback, params = {}) {
  return tFromContext(view, key, fallback, params);
}

function normalizeLinkedContextPath(value) {
  return String(value || "").trim().replace(/^\/+/, "");
}

function displayNameFromPath(pathValue) {
  const path = normalizeLinkedContextPath(pathValue);
  if (!path) return "";
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function isLinkableContextFile(file) {
  if (!file || typeof file !== "object") return false;
  const ext = String(file.extension || "").trim().toLowerCase();
  if (!ext) return false;
  return LINKED_CONTEXT_ALLOWED_EXTENSIONS.has(ext);
}

function createLinkableContextEntry(file) {
  if (!file || typeof file !== "object") return null;
  const filePath = normalizeLinkedContextPath(file.path || file.file?.path || file.name || "");
  if (!filePath) return null;

  const fallbackName = displayNameFromPath(filePath);
  const basename = String(file.basename || "").trim();
  const derivedName = basename || String(file.name || "").trim() || fallbackName;
  const name = derivedName || fallbackName || filePath;
  const stat = file.stat && typeof file.stat === "object" ? file.stat : null;
  const mtime = Number(stat && stat.mtime ? stat.mtime : 0);

  return {
    path: filePath,
    name,
    mtime,
    search: `${name} ${filePath}`.toLowerCase(),
  };
}

function openSettings() {
  this.app.setting.open();
  this.app.setting.openTabById(this.plugin.manifest.id);
}

function buildIconButton(parent, icon, label, onClick, cls = "") {
  const btn = parent.createEl("button", { cls: `oc-icon-btn ${cls}`.trim() });
  setIcon(btn, icon);
  btn.setAttr("aria-label", label);
  btn.setAttr("title", label);
  btn.addEventListener("click", onClick);
  return btn;
}

function createSvgNode(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
  return node;
}

function isFreeModel(modelName) {
  const raw = String(modelName || "").trim().toLowerCase();
  if (!raw) return false;
  const modelId = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
  return /(?:^|[-_:.\/])free$/.test(modelId);
}

function extractModelProvider(modelName) {
  const raw = String(modelName || "").trim().toLowerCase();
  if (!raw) return "Unspecified Provider";
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0) return "Unspecified Provider";
  return raw.slice(0, slashIndex) || "Unspecified Provider";
}

function splitModelsByFree(models) {
  const uniq = [...new Set((Array.isArray(models) ? models : []).map((m) => String(m || "").trim()).filter(Boolean))];
  uniq.sort((a, b) => a.localeCompare(b));
  return uniq.reduce((acc, model) => {
    if (isFreeModel(model)) {
      acc.free.push(model);
      return acc;
    }
    const provider = extractModelProvider(model);
    if (!acc.byProvider[provider]) acc.byProvider[provider] = [];
    acc.byProvider[provider].push(model);
    return acc;
  }, { free: [], byProvider: {} });
}

function appendGroupedModelOptions(selectEl, models, view) {
  const grouped = splitModelsByFree(models);

  if (grouped.free.length) {
    const freeGroup = selectEl.createEl("optgroup", {
      attr: { label: tr(view, "view.model.freeGroup", "Free Models ({count})", { count: grouped.free.length }) },
    });
    grouped.free.forEach((m) => freeGroup.createEl("option", { value: m, text: m }));
  }

  Object.entries(grouped.byProvider)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([provider, providerModels]) => {
      const providerGroup = selectEl.createEl("optgroup", {
        attr: { label: `${provider} (${providerModels.length})` },
      });
      providerModels.forEach((m) => providerGroup.createEl("option", { value: m, text: m }));
    });
}

function updateModelSelectOptions() {
  const modelSelect = this.elements && this.elements.modelSelect;
  if (!modelSelect) return;

  const selectedBefore = String(this.selectedModel || modelSelect.value || "");
  const models = Array.isArray(this.plugin && this.plugin.cachedModels) ? this.plugin.cachedModels : [];
  const normalizedModels = [...new Set(models.map((model) => String(model || "").trim()).filter(Boolean))];

  modelSelect.empty();
  modelSelect.createEl("option", { value: "", text: tr(this, "view.model.placeholder", "Model /models") });
  appendGroupedModelOptions(modelSelect, normalizedModels, this);

  const canRestoreSelection = selectedBefore && normalizedModels.includes(selectedBefore);
  modelSelect.value = canRestoreSelection ? selectedBefore : "";
  this.selectedModel = modelSelect.value;
}

function renderSidebarToggleIcon(button) {
  if (!button) return;
  button.empty();
  button.classList.toggle("is-collapsed", Boolean(this.isSidebarCollapsed));
  try {
    setIcon(button, this.isSidebarCollapsed ? "panel-left-open" : "panel-left-close");
  } catch {
    setIcon(button, this.isSidebarCollapsed ? "chevrons-right" : "chevrons-left");
  }
}

function scrollMessagesTo(target) {
  const messages = this.elements.messages;
  if (!messages) return;
  if (target === "top") {
    this.autoScrollEnabled = false;
    if (typeof this.setForceBottomWindow === "function") this.setForceBottomWindow(0);
    if (typeof this.withProgrammaticScroll === "function") {
      this.withProgrammaticScroll(messages, () => {
        messages.scrollTop = 0;
      });
      return;
    }
    messages.scrollTop = 0;
    return;
  }
  this.autoScrollEnabled = true;
  if (typeof this.scheduleScrollMessagesToBottom === "function") {
    this.scheduleScrollMessagesToBottom(true);
    return;
  }
  messages.scrollTop = messages.scrollHeight;
}

function toggleSidebarCollapsed() {
  this.isSidebarCollapsed = !this.isSidebarCollapsed;
  this.render();
}

function normalizeSessionTitle(value) {
  return normalizeSessionTitleFromDomain(value);
}

function isPlaceholderSessionTitle(title) {
  return isPlaceholderSessionTitleFromDomain(title);
}

function deriveSessionTitleFromPrompt(prompt) {
  return deriveSessionTitleFromPromptFromDomain(prompt);
}

function sessionDisplayTitle(session) {
  return resolveSessionDisplayTitle(session, tr(this, "view.session.untitled", "Untitled Session"));
}

function activeSessionLabel() {
  const st = this.plugin.sessionStore.state();
  const session = st.sessions.find((s) => s.id === st.activeSessionId);
  if (!session) return tr(this, "view.session.noneSelected", "No session selected");
  return this.sessionDisplayTitle(session);
}

function formatSessionMetaTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function render() {
  this.clearInlineQuestionWidget(true);
  const container = this.contentEl || this.containerEl.children[1] || this.containerEl;
  container.empty();
  container.addClass("oc-root", "oc-surface");
  this.root = container;

  const shell = container.createDiv({ cls: "oc-shell" });
  const header = shell.createDiv({ cls: "oc-header" });
  this.renderHeader(header);

  const body = shell.createDiv({ cls: "oc-body" });
  const main = body.createDiv({ cls: "oc-main" });

  this.elements.body = body;
  this.elements.main = main;

  this.renderMain(main);
}

function renderHeader(header) {
  header.empty();

  const brand = header.createDiv({ cls: "oc-brand" });
  const logo = brand.createDiv({ cls: "oc-brand-logo" });
  setIcon(logo, "bot");
  brand.createDiv({ cls: "oc-brand-title", text: "FLOWnote" });

  const actions = header.createDiv({ cls: "oc-header-actions" });
  actions.createDiv({ cls: "oc-header-meta", text: tr(this, "view.header.runtime", "Chat Runtime") });

  const newBtn = this.buildIconButton(
    actions,
    "plus",
    tr(this, "view.session.new", "New session"),
    async () => {
      try {
        const session = await this.plugin.createSession("");
        this.plugin.sessionStore.setActiveSession(session.id);
        await this.plugin.persistState();
        this.closeHistoryMenu();
        this.render();
      } catch (e) {
        new Notice(e instanceof Error ? e.message : String(e));
      }
    },
    "oc-header-btn",
  );
  newBtn.setAttr("type", "button");

  const historyContainer = actions.createDiv({ cls: "oc-history-container" });
  const historyBtn = historyContainer.createEl("button", {
    cls: "oc-icon-btn oc-header-btn oc-history-toggle",
  });
  setIcon(historyBtn, "history");
  historyBtn.setAttr("type", "button");
  historyBtn.setAttr("aria-label", tr(this, "view.session.history", "Session history"));
  historyBtn.setAttr("title", tr(this, "view.session.history", "Session history"));

  const historyMenu = historyContainer.createDiv({ cls: "oc-history-menu" });
  historyMenu.addEventListener("click", (event) => event.stopPropagation());
  this.elements.historyMenu = historyMenu;

  historyBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    this.toggleHistoryMenu();
  });

  if (!this.historyMenuDocumentBound) {
    this.historyMenuDocumentBound = true;
    this.registerDomEvent(document, "click", () => this.closeHistoryMenu());
  }

  this.refreshHistoryMenu();
}

function renderSidebar(side) {
  if (!side) return;
  side.empty();
  const sessions = this.plugin.sessionStore.state().sessions;
  const active = this.plugin.sessionStore.state().activeSessionId;

  const header = side.createDiv({ cls: "oc-history-header" });
  header.createSpan({ text: tr(this, "view.session.heading", "Sessions") });
  header.createSpan({
    cls: "oc-history-count",
    text: tr(this, "view.session.count", "{count} sessions", { count: sessions.length }),
  });

  const list = side.createDiv({ cls: "oc-history-list" });

  if (!sessions.length) {
    list.createDiv({ cls: "oc-history-empty", text: tr(this, "view.session.empty", "No sessions yet. Click \"+\" to start.") });
    return;
  }

  sessions.forEach((s) => {
    const displayTitle = this.sessionDisplayTitle(s);
    const item = list.createDiv({ cls: "oc-session-item", attr: { title: displayTitle } });
    if (s.id === active) item.addClass("is-active");
    item.addEventListener("click", async () => {
      if (item.hasClass("is-renaming")) return;
      this.closeHistoryMenu();
      this.plugin.sessionStore.setActiveSession(s.id);
      this.render();
      try {
        if (typeof this.plugin.ensureSessionMessagesLoaded === "function") {
          await this.plugin.ensureSessionMessagesLoaded(s.id, { force: false });
        }
      } catch (error) {
        this.plugin.log(
          `load session history failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.plugin.persistState();
      this.render();
    });

    const iconEl = item.createDiv({ cls: "oc-session-item-icon" });
    setIcon(iconEl, s.id === active ? "message-square-dot" : "message-square");

    const content = item.createDiv({ cls: "oc-session-item-content" });
    const titleEl = content.createDiv({ cls: "oc-session-title", text: displayTitle });
    titleEl.setAttr("title", displayTitle);

    if (s.lastUserPrompt) {
      content.createDiv({ cls: "oc-session-preview", text: s.lastUserPrompt, attr: { title: s.lastUserPrompt } });
    }

    content.createDiv({
      cls: "oc-session-meta",
      text: s.id === active
        ? tr(this, "view.session.currentShort", "Current session")
        : this.formatSessionMetaTime(s.updatedAt),
    });

    const actions = item.createDiv({ cls: "oc-session-item-actions" });

    const renameBtn = actions.createEl("button", { cls: "oc-session-item-action" });
    renameBtn.setAttr("type", "button");
    renameBtn.setAttr("aria-label", tr(this, "view.session.rename", "Rename session"));
    renameBtn.setAttr("title", tr(this, "view.session.rename", "Rename session"));
    setIcon(renameBtn, "pencil");
    renameBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (item.hasClass("is-renaming")) return;

      item.addClass("is-renaming");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "oc-session-rename-input";
      input.value = displayTitle;
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      const stop = (ev) => ev.stopPropagation();
      input.addEventListener("click", stop);
      input.addEventListener("mousedown", stop);

      let finished = false;
      const finishRename = async (commit) => {
        if (finished) return;
        finished = true;
        item.removeClass("is-renaming");

        if (!commit) {
          this.render();
          return;
        }

        const normalized = normalizeSessionTitle(input.value || "");
        if (!normalized) {
          new Notice(tr(this, "view.session.renameEmpty", "Session name cannot be empty"));
          this.render();
          return;
        }

        const renamed = this.plugin.sessionStore.renameSession(s.id, normalized);
        if (!renamed) {
          new Notice(tr(this, "view.session.renameMissing", "Session to rename was not found"));
          this.render();
          return;
        }

        await this.plugin.persistState();
        this.refreshHistoryMenu();
        this.refreshCurrentSessionContext();
      };

      input.addEventListener("blur", () => {
        void finishRename(true);
      }, { once: true });

      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.isComposing) {
          ev.preventDefault();
          input.blur();
          return;
        }
        if (ev.key === "Escape" && !ev.isComposing) {
          ev.preventDefault();
          void finishRename(false);
        }
      });
    });

    const deleteBtn = actions.createEl("button", { cls: "oc-session-item-action is-danger" });
    deleteBtn.setAttr("type", "button");
    deleteBtn.setAttr("aria-label", tr(this, "view.session.delete", "Delete session"));
    deleteBtn.setAttr("title", tr(this, "view.session.delete", "Delete session"));
    setIcon(deleteBtn, "trash-2");
    deleteBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const confirmed = window.confirm(tr(this, "view.session.deleteConfirm", "Delete session \"{title}\"?", { title: displayTitle }));
      if (!confirmed) return;
      const removed = typeof this.plugin.deleteSession === "function"
        ? await this.plugin.deleteSession(s.id)
        : this.plugin.sessionStore.removeSession(s.id);
      if (!removed) {
        new Notice(tr(this, "view.session.deleteFailed", "Delete failed: session not found"));
        return;
      }
      if (typeof this.plugin.deleteSession !== "function") {
        await this.plugin.persistState();
      }
      this.closeHistoryMenu();
      this.render();
    });
  });
}

function closeHistoryMenu() {
  const menu = this.elements && this.elements.historyMenu;
  if (!menu) return;
  menu.removeClass("visible");
}

function toggleHistoryMenu() {
  const menu = this.elements && this.elements.historyMenu;
  if (!menu) return;
  const isVisible = menu.hasClass("visible");
  if (isVisible) {
    menu.removeClass("visible");
    return;
  }
  this.refreshHistoryMenu();
  menu.addClass("visible");
}

function refreshHistoryMenu() {
  const menu = this.elements && this.elements.historyMenu;
  if (!menu) return;
  this.renderSidebar(menu);
}

function refreshCurrentSessionContext() {
  const labelEl = this.elements && this.elements.currentSessionLabel;
  if (!labelEl) return;
  labelEl.textContent = tr(this, "view.session.current", "Current session: {title}", { title: this.activeSessionLabel() });
}

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

function renderMain(main) {
  main.empty();
  if (typeof this.closeLinkedContextFilePicker === "function") {
    this.closeLinkedContextFilePicker();
  }

  const toolbar = main.createDiv({ cls: "oc-toolbar" });
  const toolbarLeft = toolbar.createDiv({ cls: "oc-toolbar-left" });
  const toolbarRight = toolbar.createDiv({ cls: "oc-toolbar-right" });

  const connectionIndicator = toolbarLeft.createDiv({ cls: "oc-connection-indicator" });
  this.elements.statusDot = connectionIndicator.createDiv({ cls: "oc-connection-dot warn" });
  this.elements.statusDot.setAttribute("aria-label", tr(this, "view.connection.unknown", "Connection status unknown"));
  this.elements.statusDot.setAttribute("title", tr(this, "view.connection.unknown", "Connection status unknown"));

  const settingsBtn = this.buildIconButton(toolbarRight, "settings", tr(this, "view.settings", "Settings"), () => this.openSettings());
  settingsBtn.addClass("oc-toolbar-btn");

  const messagesWrapper = main.createDiv({ cls: "oc-messages-wrapper" });
  this.elements.messages = messagesWrapper.createDiv({ cls: "oc-messages oc-messages-focusable", attr: { tabindex: "0" } });
  this.bindMessagesScrollTracking();
  this.elements.inlineQuestionHost = messagesWrapper.createDiv({ cls: "oc-inline-question-host" });
  this.renderMessages();
  void this.refreshPendingQuestionRequests({ silent: true }).catch(() => {});

  const navSidebar = messagesWrapper.createDiv({ cls: "oc-nav-sidebar visible" });
  const topBtn = navSidebar.createEl("button", { cls: "oc-nav-btn oc-nav-btn-top" });
  topBtn.setAttr("type", "button");
  topBtn.setAttr("aria-label", tr(this, "view.scroll.top", "Scroll to top"));
  topBtn.setAttr("title", tr(this, "view.scroll.topShort", "Top"));
  try {
    setIcon(topBtn, "chevron-up");
  } catch {
    topBtn.setText("↑");
  }
  topBtn.addEventListener("click", () => this.scrollMessagesTo("top"));
  const bottomBtn = navSidebar.createEl("button", { cls: "oc-nav-btn oc-nav-btn-bottom" });
  bottomBtn.setAttr("type", "button");
  bottomBtn.setAttr("aria-label", tr(this, "view.scroll.bottom", "Scroll to bottom"));
  bottomBtn.setAttr("title", tr(this, "view.scroll.bottomShort", "Bottom"));
  try {
    setIcon(bottomBtn, "chevron-down");
  } catch {
    bottomBtn.setText("↓");
  }
  bottomBtn.addEventListener("click", () => this.scrollMessagesTo("bottom"));

  const contextFooter = main.createDiv({ cls: "oc-context-footer" });
  this.elements.currentSessionLabel = contextFooter.createDiv({
    cls: "oc-context-session",
    text: tr(this, "view.session.current", "Current session: {title}", { title: this.activeSessionLabel() }),
  });

  const composer = main.createDiv({ cls: "oc-composer" });
  this.elements.composer = composer;
  const navRow = composer.createDiv({ cls: "oc-input-nav-row" });
  const quick = navRow.createDiv({ cls: "oc-quick" });

  const modelPicker = quick.createDiv({ cls: "oc-model-picker" });
  const modelSelect = modelPicker.createEl("select", { cls: "oc-model-select" });
  this.elements.modelSelect = modelSelect;
  this.updateModelSelectOptions();
  modelSelect.addEventListener("change", async () => {
    try {
      await this.applyModelSelection(modelSelect.value);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      modelSelect.value = this.selectedModel || "";
      new Notice(tr(this, "view.model.switchFailed", "Model switch failed: {message}", { message: msg }));
    }
  });

  const skillPicker = quick.createDiv({ cls: "oc-skill-picker" });
  const skillSelect = skillPicker.createEl("select", { cls: "oc-skill-select" });
  this.elements.skillSelect = skillSelect;
  skillSelect.setAttr("title", tr(this, "view.skill.selectTitle", "Select skill"));
  skillSelect.createEl("option", { value: "", text: tr(this, "view.skill.placeholder", "Skill /skills") });

  const skills = this.plugin.skillService.getSkills();
  const setSkillSelectTitle = (skill) => {
    if (!skill) {
      skillSelect.setAttr("title", tr(this, "view.skill.selectTitle", "Select skill"));
      return;
    }
    const label = String(skill.name || skill.id || "").trim() || String(skill.id || "");
    const mainFeature = this.getSkillPrimaryDescription(skill);
    const detail = [label, `/${skill.id}`, mainFeature].filter(Boolean).join(" - ");
    skillSelect.setAttr("title", detail || "选择技能");
  };

  skills.forEach((skill) => {
    const label = String(skill.name || skill.id || "").trim() || String(skill.id || "");
    const mainFeature = this.getSkillPrimaryDescription(skill);
    const briefFeature = this.getSkillBriefDescription(skill);
    skillSelect.createEl("option", {
      value: skill.id,
      text: briefFeature ? `${label} - ${briefFeature}` : label,
      attr: { title: [label, `/${skill.id}`, mainFeature].filter(Boolean).join(" - ") },
    });
  });

  if (!skills.length) {
    skillSelect.disabled = true;
    skillSelect.setAttr("title", tr(this, "view.skill.noneFound", "No available skills found. Check Skills directory."));
  } else {
    skillSelect.addEventListener("change", () => {
      const selectedId = String(skillSelect.value || "");
      const picked = skills.find((skill) => String(skill.id) === selectedId);
      if (!picked) {
        setSkillSelectTitle(null);
        return;
      }

      setSkillSelectTitle(picked);
      if (this.elements.input) {
        this.elements.input.value = `/${picked.id} `;
        this.elements.input.focus();
      }
      this.setRuntimeStatus(tr(this, "view.skill.commandFilled", "Skill command inserted: /{id}", { id: picked.id }), "info");
    });
  }

  navRow.createDiv({ cls: "oc-nav-row-meta", text: tr(this, "view.shortcut.send", "Ctrl/Cmd + Enter to send") });

  const inputContainer = composer.createDiv({ cls: "oc-input-container" });
  const inputWrapper = inputContainer.createDiv({ cls: "oc-input-wrapper" });
  this.elements.inputContainer = inputContainer;
  this.elements.inputWrapper = inputWrapper;
  const contextRow = inputWrapper.createDiv({ cls: "oc-context-row" });
  const fileIndicator = contextRow.createDiv({ cls: "oc-file-indicator" });
  const selectionIndicator = contextRow.createDiv({
    cls: "oc-selection-indicator",
    text: "",
  });
  contextRow.toggleClass("has-content", false);
  fileIndicator.empty();
  selectionIndicator.empty();
  this.elements.contextRow = contextRow;
  this.elements.fileIndicator = fileIndicator;
  this.elements.selectionIndicator = selectionIndicator;

  this.elements.input = inputWrapper.createEl("textarea", {
    cls: "oc-input",
    attr: { placeholder: tr(this, "view.input.placeholder", "Type a message... supports skill injection and model switching") },
  });
  this.elements.input.addEventListener("keydown", (ev) => {
    if (typeof this.handleLinkedContextInputKeydown === "function" && this.handleLinkedContextInputKeydown(ev)) {
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      this.handleSend();
    }
  });
  this.elements.input.addEventListener("input", () => {
    if (typeof this.syncLinkedContextPickerFromInputMention === "function") {
      this.syncLinkedContextPickerFromInputMention();
    }
  });
  this.elements.input.addEventListener("click", () => {
    if (typeof this.syncLinkedContextPickerFromInputMention === "function") {
      this.syncLinkedContextPickerFromInputMention();
    }
  });

  const inputToolbar = inputWrapper.createDiv({ cls: "oc-input-toolbar" });
  inputToolbar.createDiv({ cls: "oc-input-meta", text: "FLOWnote Compat Runtime" });

  const actions = inputToolbar.createDiv({ cls: "oc-actions" });
  this.elements.attachFileBtn = actions.createEl("button", { cls: "mod-muted oc-context-link-btn", text: "@" });
  this.elements.attachFileBtn.setAttr("type", "button");
  this.elements.attachFileBtn.setAttr("aria-label", tr(this, "view.context.attach", "Link Obsidian file context"));
  this.elements.attachFileBtn.setAttr("title", tr(this, "view.context.attach", "Link Obsidian file context"));
  this.elements.attachFileBtn.addEventListener("click", () => this.openLinkedContextFilePicker());

  this.elements.sendBtn = actions.createEl("button", { cls: "mod-cta oc-send-btn", text: tr(this, "view.action.send", "Send") });
  this.elements.cancelBtn = actions.createEl("button", { cls: "mod-muted oc-cancel-btn", text: tr(this, "view.action.cancel", "Cancel") });
  this.elements.cancelBtn.disabled = true;

  this.elements.sendBtn.addEventListener("click", () => this.handleSend());
  this.elements.cancelBtn.addEventListener("click", () => this.cancelSending());
  this.refreshLinkedContextIndicators();

  composer.createDiv({
    cls: "oc-hint",
    text: tr(
      this,
      "view.hint",
      "Supports session switching, skill/model dropdowns, provider auth, and error recovery. Use /skills and /model for quick switch.",
    ),
  });

  this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
  const diagnosticsService = this.plugin && this.plugin.diagnosticsService;
  if (diagnosticsService) {
    const cached = diagnosticsService.getLastResult();
    if (cached) this.applyStatus(cached);
    diagnosticsService
      .runCached(15000, false)
      .then((r) => this.applyStatus(r))
      .catch(() => {
      });
  }
}

function applyStatus(result) {
  const dot = this.elements.statusDot;
  if (!dot) return;

  dot.removeClass("ok", "error", "warn");

  if (!result || !result.connection) {
    dot.addClass("warn");
    dot.setAttribute("aria-label", tr(this, "view.connection.unknown", "Connection status unknown"));
    dot.setAttribute("title", tr(this, "view.connection.unknown", "Connection status unknown"));
    return;
  }

  if (result.connection.ok) {
    dot.addClass("ok");
    const label = tr(this, "view.connection.ok", "Connected ({mode})", result.connection);
    dot.setAttribute("aria-label", label);
    dot.setAttribute("title", label);
    return;
  }

  dot.addClass("error");
  const label = tr(this, "view.connection.error", "Connection error ({mode})", result.connection);
  dot.setAttribute("aria-label", label);
  dot.setAttribute("title", label);
}

module.exports = { layoutRendererMethods: {
  openSettings,
  buildIconButton,
  createSvgNode,
  renderSidebarToggleIcon,
  scrollMessagesTo,
  toggleSidebarCollapsed,
  normalizeSessionTitle,
  isPlaceholderSessionTitle,
  deriveSessionTitleFromPrompt,
  sessionDisplayTitle,
  activeSessionLabel,
  formatSessionMetaTime,
  closeHistoryMenu,
  toggleHistoryMenu,
  refreshHistoryMenu,
  refreshCurrentSessionContext,
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
  updateModelSelectOptions,
  render,
  renderHeader,
  renderSidebar,
  renderMain,
  applyStatus,
} };
