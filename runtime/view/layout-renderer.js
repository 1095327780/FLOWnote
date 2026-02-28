const { Notice, setIcon } = require("obsidian");
const {
  normalizeSessionTitleInput: normalizeSessionTitleFromDomain,
  isPlaceholderSessionTitle: isPlaceholderSessionTitleFromDomain,
  deriveSessionTitleFromPrompt: deriveSessionTitleFromPromptFromDomain,
  resolveSessionDisplayTitle,
} = require("../domain/session-title");
const { tFromContext } = require("../i18n-runtime");

function tr(view, key, fallback, params = {}) {
  return tFromContext(view, key, fallback, params);
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

function renderMain(main) {
  main.empty();

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
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      this.handleSend();
    }
  });

  const inputToolbar = inputWrapper.createDiv({ cls: "oc-input-toolbar" });
  inputToolbar.createDiv({ cls: "oc-input-meta", text: "FLOWnote Compat Runtime" });

  const actions = inputToolbar.createDiv({ cls: "oc-actions" });
  this.elements.sendBtn = actions.createEl("button", { cls: "mod-cta oc-send-btn", text: tr(this, "view.action.send", "Send") });
  this.elements.cancelBtn = actions.createEl("button", { cls: "mod-muted oc-cancel-btn", text: tr(this, "view.action.cancel", "Cancel") });
  this.elements.cancelBtn.disabled = true;

  this.elements.sendBtn.addEventListener("click", () => this.handleSend());
  this.elements.cancelBtn.addEventListener("click", () => this.cancelSending());

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
  updateModelSelectOptions,
  render,
  renderHeader,
  renderSidebar,
  renderMain,
  applyStatus,
} };
