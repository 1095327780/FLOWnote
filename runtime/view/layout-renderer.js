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
  body.toggleClass("is-side-collapsed", this.isSidebarCollapsed);
  const side = body.createDiv({ cls: "oc-side" });
  const main = body.createDiv({ cls: "oc-main" });

  this.elements.body = body;
  this.elements.side = side;
  this.elements.main = main;

  this.renderSidebar(side);
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
}

function renderSidebar(side) {
  side.empty();
  side.toggleClass("is-collapsed", this.isSidebarCollapsed);

  const header = side.createDiv({ cls: "oc-side-header" });
  header.createEl("h3", { text: tr(this, "view.session.heading", "Sessions") });

  const sideActions = header.createDiv({ cls: "oc-side-actions" });
  const toggleBtn = sideActions.createEl("button", { cls: "oc-side-toggle" });
  toggleBtn.setAttr("type", "button");
  toggleBtn.setAttr("aria-label", this.isSidebarCollapsed
    ? tr(this, "view.session.expandList", "Expand session list")
    : tr(this, "view.session.collapseList", "Collapse session list"));
  toggleBtn.setAttr("title", this.isSidebarCollapsed
    ? tr(this, "view.session.expandList", "Expand session list")
    : tr(this, "view.session.collapseList", "Collapse session list"));
  this.renderSidebarToggleIcon(toggleBtn);
  toggleBtn.addEventListener("click", () => this.toggleSidebarCollapsed());

  if (this.isSidebarCollapsed) {
    return;
  }

  const addBtn = sideActions.createEl("button", { cls: "oc-side-add" });
  addBtn.setAttr("type", "button");
  addBtn.setAttr("aria-label", tr(this, "view.session.new", "New session"));
  addBtn.setAttr("title", tr(this, "view.session.new", "New session"));
  try {
    setIcon(addBtn, "plus");
  } catch {
    addBtn.setText("+");
  }
  addBtn.addEventListener("click", async () => {
    try {
      const session = await this.plugin.createSession("");
      this.plugin.sessionStore.setActiveSession(session.id);
      await this.plugin.persistState();
      this.render();
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
    }
  });

  const sessions = this.plugin.sessionStore.state().sessions;
  const active = this.plugin.sessionStore.state().activeSessionId;
  side.createDiv({
    cls: "oc-side-count",
    text: tr(this, "view.session.count", "{count} sessions", { count: sessions.length }),
  });
  const list = side.createDiv({ cls: "oc-session-list" });

  if (!sessions.length) {
    list.createDiv({ cls: "oc-empty", text: tr(this, "view.session.empty", "No sessions yet. Click \"+\" to start.") });
    return;
  }

  sessions.forEach((s) => {
    const displayTitle = this.sessionDisplayTitle(s);
    const item = list.createDiv({ cls: "oc-session-item", attr: { title: displayTitle } });
    if (s.id === active) item.addClass("is-active");
    item.addEventListener("click", async () => {
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

    const actions = item.createDiv({ cls: "oc-session-item-actions" });

    const renameBtn = actions.createEl("button", { cls: "oc-session-item-action" });
    renameBtn.setAttr("type", "button");
    renameBtn.setAttr("aria-label", tr(this, "view.session.rename", "Rename session"));
    renameBtn.setAttr("title", tr(this, "view.session.rename", "Rename session"));
    setIcon(renameBtn, "pencil");
    renameBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = window.prompt(tr(this, "view.session.renamePrompt", "Rename session"), displayTitle);
      if (next === null) return;
      const normalized = normalizeSessionTitle(next);
      if (!normalized) {
        new Notice(tr(this, "view.session.renameEmpty", "Session name cannot be empty"));
        return;
      }
      const renamed = this.plugin.sessionStore.renameSession(s.id, normalized);
      if (!renamed) {
        new Notice(tr(this, "view.session.renameMissing", "Session to rename was not found"));
        return;
      }
      await this.plugin.persistState();
      this.render();
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
      this.render();
    });

    item.createDiv({ cls: "oc-session-title", text: displayTitle });
    if (s.lastUserPrompt) {
      item.createDiv({ cls: "oc-session-preview", text: s.lastUserPrompt, attr: { title: s.lastUserPrompt } });
    }

    item.createDiv({ cls: "oc-session-meta", text: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "" });
  });

  side.createDiv({
    cls: "oc-side-footer",
    text: tr(this, "view.session.footer", "FLOWnote sessions, skills, model switch, and diagnostics."),
  });
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
  contextFooter.createDiv({
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
  updateModelSelectOptions,
  render,
  renderHeader,
  renderSidebar,
  renderMain,
  applyStatus,
} };
