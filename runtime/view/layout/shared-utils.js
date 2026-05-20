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

function isLinkableContextFolder(target) {
  if (!target || typeof target !== "object") return false;
  const pathValue = normalizeLinkedContextPath(target.path || "");
  if (!pathValue) return false;
  if (Array.isArray(target.children)) return true;
  const ext = String(target.extension || "").trim().toLowerCase();
  if (ext) return false;
  return !/\.[A-Za-z0-9_-]+$/.test(pathValue);
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

function isDirectAgentMode(view) {
  const settings = view && view.plugin && view.plugin.settings;
  const ap = settings && settings.agentProvider;
  return ap && ap.mode === "direct";
}

function isMobileRuntime() {
  try {
    const { Platform = {} } = require("obsidian");
    return Boolean(Platform.isMobile);
  } catch (_e) {
    return false;
  }
}

function getEffectiveDirectAgentSettings(view) {
  const settings = view && view.plugin && view.plugin.settings;
  const agent = settings && settings.agentProvider;
  const direct = agent && agent.direct;
  if (!agent || !direct) return { agent, direct, isMobileOllamaOverride: false };
  if (isMobileRuntime() && String(direct.providerId || "").trim() === "ollama") {
    try {
      const { buildMobileAgentSettingsOverride } = require("../../mobile/mobile-ai-service");
      const mobileOverride = buildMobileAgentSettingsOverride(settings);
      if (mobileOverride && mobileOverride.direct) {
        return { agent: mobileOverride, direct: mobileOverride.direct, isMobileOllamaOverride: true };
      }
    } catch (_e) {
      // Fall through to desktop settings. The send path will surface the
      // mobile Ollama configuration error if no reachable mobile model exists.
    }
  }
  return { agent, direct, isMobileOllamaOverride: false };
}

function getProviderFetchedModels(plugin, providerId) {
  const fetchedRoot = plugin && plugin.__flownoteFetchedModels;
  const fetched = fetchedRoot && fetchedRoot[providerId];
  return fetched && Array.isArray(fetched.models) ? fetched.models : [];
}

function scheduleDirectProviderModelAutofetch(view, spec, direct) {
  if (!view || !view.plugin || !spec || spec.id !== "ollama") return;
  if (getProviderFetchedModels(view.plugin, spec.id).length > 0) return;
  if (!view.plugin.__flownoteAutoFetchingModels) view.plugin.__flownoteAutoFetchingModels = {};
  if (view.plugin.__flownoteAutoFetchingModels[spec.id]) return;
  view.plugin.__flownoteAutoFetchingModels[spec.id] = true;

  const run = async () => {
    try {
      let resolver;
      try { resolver = require("../../agent/agent-provider-resolver"); } catch { resolver = null; }
      if (!resolver || typeof resolver.buildProviderFromSpec !== "function") return;
      const agent = (view.plugin.settings && view.plugin.settings.agentProvider) || {};
      const currentDirect = (agent && agent.direct) || direct || {};
      const provider = resolver.buildProviderFromSpec({
        spec,
        userConfig: {
          providerId: spec.id,
          mode: currentDirect.providerMode || spec.defaultMode,
          region: currentDirect.region,
          apiKey: "",
          model: currentDirect.model || spec.defaultModel,
          baseUrlOverride: currentDirect.baseUrlOverride || "",
          userAgentOverride: currentDirect.userAgentOverride || "",
          versionHeaderOverride: currentDirect.versionHeaderOverride || "",
          stream: false,
        },
      });
      if (typeof provider.listModels !== "function") return;
      const list = await provider.listModels();
      if (!view.plugin.__flownoteFetchedModels) view.plugin.__flownoteFetchedModels = {};
      view.plugin.__flownoteFetchedModels[spec.id] = { models: list, fetchedAt: Date.now() };
      const selected = String(currentDirect.model || spec.defaultModel || "").trim();
      if (list.length > 0 && !list.some((m) => m && m.id === selected)) {
        currentDirect.model = list[0].id;
        if (view.plugin.settings && view.plugin.settings.agentProvider && view.plugin.settings.agentProvider.direct) {
          view.plugin.settings.agentProvider.direct.model = list[0].id;
        }
        if (typeof view.plugin.saveSettings === "function") await view.plugin.saveSettings();
      }
      updateModelSelectOptions.call(view);
      if (typeof view.applyStatus === "function") view.applyStatus(view.latestDiagnosticsResult);
    } catch (_e) {
      // Leave the static fallback visible; settings has a manual refresh.
    } finally {
      view.plugin.__flownoteAutoFetchingModels[spec.id] = false;
    }
  };
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    window.setTimeout(run, 0);
  } else {
    Promise.resolve().then(run);
  }
}

function buildDirectModelOptions(view) {
  // Pulls models from the active direct-mode provider's registry entry.
  // Avoids depending on OpenCode's catalog so the bottom selector
  // reflects what the agent will actually use this turn.
  let registry;
  try { registry = require("../../providers/registry"); } catch { return []; }
  const { direct } = getEffectiveDirectAgentSettings(view);
  if (!direct) return [];
  const spec = registry.getProviderSpec(direct.providerId || "");
  if (!spec || !Array.isArray(spec.models)) return [];
  if (spec.id === "ollama") {
    const fetched = getProviderFetchedModels(view.plugin, spec.id);
    if (fetched.length > 0) {
      return fetched.map((m) => ({ id: m.id, label: m.label || m.id }));
    }
    scheduleDirectProviderModelAutofetch(view, spec, direct);
  }
  return spec.models.map((m) => ({
    id: m.id,
    label: m.label || m.id,
  }));
}

function updateModelSelectOptions() {
  const modelSelect = this.elements && this.elements.modelSelect;
  if (!modelSelect) return;

  // Direct mode: source the dropdown from the active provider's
  // registry. The OpenCode-style "provider/model" optgroup grouping
  // doesn't apply — there's exactly one provider active.
  if (isDirectAgentMode(this)) {
    const opts = buildDirectModelOptions(this);
    const { direct } = getEffectiveDirectAgentSettings(this);
    if (!direct) return;
    const currentModel = String(direct.model || "");
    modelSelect.empty();
    if (opts.length === 0) {
      modelSelect.createEl("option", { value: "", text: tr(this, "view.model.placeholder", "Model") });
    } else {
      for (const m of opts) {
        modelSelect.createEl("option", { value: m.id, text: m.label });
      }
    }
    const has = opts.some((m) => m.id === currentModel);
    modelSelect.value = has ? currentModel : (opts[0] ? opts[0].id : "");
    this.selectedModel = modelSelect.value;
    syncInlineModelSelectLabel.call(this);
    return;
  }

  const selectedBefore = String(this.selectedModel || modelSelect.value || "");
  const models = Array.isArray(this.plugin && this.plugin.cachedModels) ? this.plugin.cachedModels : [];
  const normalizedModels = [...new Set(models.map((model) => String(model || "").trim()).filter(Boolean))];

  modelSelect.empty();
  modelSelect.createEl("option", { value: "", text: tr(this, "view.model.placeholder", "Model") });
  appendGroupedModelOptions(modelSelect, normalizedModels, this);

  const canRestoreSelection = selectedBefore && normalizedModels.includes(selectedBefore);
  modelSelect.value = canRestoreSelection ? selectedBefore : "";
  this.selectedModel = modelSelect.value;
  syncInlineModelSelectLabel.call(this);
}

function syncInlineModelSelectLabel() {
  const modelSelect = this.elements && this.elements.modelSelect;
  const modelSelectText = this.elements && this.elements.modelSelectText;
  if (!modelSelect || !modelSelectText) return;

  // Direct mode label: "<Provider> / <Model label>" — gives the user
  // an at-a-glance signal of where chat traffic is being routed.
  if (isDirectAgentMode(this)) {
    let registry;
    try { registry = require("../../providers/registry"); } catch { registry = null; }
    const { direct } = getEffectiveDirectAgentSettings(this);
    const spec = registry ? registry.getProviderSpec(direct.providerId || "") : null;
    const providerLabel = (spec && spec.displayName) || direct.providerId || "?";
    const option = modelSelect.options && modelSelect.selectedIndex >= 0
      ? modelSelect.options[modelSelect.selectedIndex]
      : null;
    const modelLabel = String((option && option.text) || direct.model || "").trim() || tr(this, "view.model.placeholder", "Model");
    const displayText = `${providerLabel} / ${modelLabel}`;
    modelSelectText.textContent = displayText;
    modelSelectText.setAttribute("title", displayText);
    return;
  }

  const option = modelSelect.options && modelSelect.selectedIndex >= 0
    ? modelSelect.options[modelSelect.selectedIndex]
    : null;
  const displayText = String((option && option.text) || "").trim() || tr(this, "view.model.placeholder", "Model");
  modelSelectText.textContent = displayText;
  modelSelectText.setAttribute("title", displayText);
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
  isLinkableContextFolder,
  createLinkableContextEntry,
  sharedLayoutMethods,
};
