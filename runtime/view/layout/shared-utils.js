const { setIcon } = require("obsidian");
const {
  normalizeSessionTitleInput: normalizeSessionTitleFromDomain,
  isPlaceholderSessionTitle: isPlaceholderSessionTitleFromDomain,
  deriveSessionTitleFromPrompt: deriveSessionTitleFromPromptFromDomain,
  resolveSessionDisplayTitle,
} = require("../../domain/session-title");
const { tFromContext } = require("../../i18n-runtime");

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

const sharedLayoutMethods = {
  openSettings,
  buildIconButton,
  createSvgNode,
  updateModelSelectOptions,
  renderSidebarToggleIcon,
  scrollMessagesTo,
  toggleSidebarCollapsed,
  normalizeSessionTitle,
  isPlaceholderSessionTitle,
  deriveSessionTitleFromPrompt,
  sessionDisplayTitle,
  activeSessionLabel,
  formatSessionMetaTime,
};

module.exports = {
  LINKED_CONTEXT_MAX_FILES,
  LINKED_CONTEXT_MAX_CHARS_PER_FILE,
  LINKED_CONTEXT_MAX_TOTAL_CHARS,
  LINKED_CONTEXT_PICKER_MAX_ITEMS,
  tr,
  normalizeLinkedContextPath,
  displayNameFromPath,
  isLinkableContextFile,
  createLinkableContextEntry,
  sharedLayoutMethods,
};
