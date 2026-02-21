const { Notice, setIcon } = require("obsidian");

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
  if (!raw) return "未标注厂商";
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0) return "未标注厂商";
  return raw.slice(0, slashIndex) || "未标注厂商";
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

function appendGroupedModelOptions(selectEl, models) {
  const grouped = splitModelsByFree(models);

  if (grouped.free.length) {
    const freeGroup = selectEl.createEl("optgroup", { attr: { label: `免费模型 (${grouped.free.length})` } });
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
  modelSelect.createEl("option", { value: "", text: "模型 /models" });
  appendGroupedModelOptions(modelSelect, normalizedModels);

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
    messages.scrollTop = 0;
    return;
  }
  this.autoScrollEnabled = true;
  messages.scrollTop = messages.scrollHeight;
}

function toggleSidebarCollapsed() {
  this.isSidebarCollapsed = !this.isSidebarCollapsed;
  this.render();
}

function normalizeSessionTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isPlaceholderSessionTitle(title) {
  const normalized = normalizeSessionTitle(title).toLowerCase();
  if (!normalized) return true;
  return normalized === "新会话"
    || normalized === "未命名会话"
    || normalized === "new session"
    || normalized === "untitled"
    || normalized === "untitled session";
}

function deriveSessionTitleFromPrompt(prompt) {
  let text = normalizeSessionTitle(prompt);
  if (!text) return "";

  if (text.startsWith("/")) {
    const firstSpace = text.indexOf(" ");
    if (firstSpace > 1) {
      const rest = normalizeSessionTitle(text.slice(firstSpace + 1));
      text = rest || text.slice(1);
    } else {
      text = text.slice(1);
    }
  }

  text = text.replace(/^[\s:：\-—]+/, "");
  if (!text) return "";
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

function sessionDisplayTitle(session) {
  if (!session || typeof session !== "object") return "未命名会话";
  const current = normalizeSessionTitle(session.title);
  if (current && !isPlaceholderSessionTitle(current)) return current;
  const inferred = deriveSessionTitleFromPrompt(session.lastUserPrompt || "");
  return inferred || current || "未命名会话";
}

function activeSessionLabel() {
  const st = this.plugin.sessionStore.state();
  const session = st.sessions.find((s) => s.id === st.activeSessionId);
  if (!session) return "未选择会话";
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
  brand.createDiv({ cls: "oc-brand-title", text: "OpenCode Assistant" });

  const actions = header.createDiv({ cls: "oc-header-actions" });
  actions.createDiv({ cls: "oc-header-meta", text: "Chat Runtime" });
}

function renderSidebar(side) {
  side.empty();
  side.toggleClass("is-collapsed", this.isSidebarCollapsed);

  const header = side.createDiv({ cls: "oc-side-header" });
  header.createEl("h3", { text: "会话" });

  const sideActions = header.createDiv({ cls: "oc-side-actions" });
  const toggleBtn = sideActions.createEl("button", { cls: "oc-side-toggle" });
  toggleBtn.setAttr("type", "button");
  toggleBtn.setAttr("aria-label", this.isSidebarCollapsed ? "展开会话列表" : "收起会话列表");
  toggleBtn.setAttr("title", this.isSidebarCollapsed ? "展开会话列表" : "收起会话列表");
  this.renderSidebarToggleIcon(toggleBtn);
  toggleBtn.addEventListener("click", () => this.toggleSidebarCollapsed());

  if (this.isSidebarCollapsed) {
    return;
  }

  const addBtn = sideActions.createEl("button", { cls: "oc-side-add" });
  addBtn.setAttr("type", "button");
  addBtn.setAttr("aria-label", "新建会话");
  addBtn.setAttr("title", "新建会话");
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
  side.createDiv({ cls: "oc-side-count", text: `${sessions.length} 个会话` });
  const list = side.createDiv({ cls: "oc-session-list" });

  if (!sessions.length) {
    list.createDiv({ cls: "oc-empty", text: "暂无会话，点击“+”开始。" });
    return;
  }

  sessions.forEach((s) => {
    const displayTitle = this.sessionDisplayTitle(s);
    const item = list.createDiv({ cls: "oc-session-item", attr: { title: displayTitle } });
    if (s.id === active) item.addClass("is-active");
    item.addEventListener("click", async () => {
      this.plugin.sessionStore.setActiveSession(s.id);
      await this.plugin.persistState();
      this.render();
    });

    const actions = item.createDiv({ cls: "oc-session-item-actions" });

    const renameBtn = actions.createEl("button", { cls: "oc-session-item-action" });
    renameBtn.setAttr("type", "button");
    renameBtn.setAttr("aria-label", "重命名会话");
    renameBtn.setAttr("title", "重命名");
    setIcon(renameBtn, "pencil");
    renameBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = window.prompt("重命名会话", displayTitle);
      if (next === null) return;
      const normalized = normalizeSessionTitle(next);
      if (!normalized) {
        new Notice("会话名称不能为空");
        return;
      }
      const renamed = this.plugin.sessionStore.renameSession(s.id, normalized);
      if (!renamed) {
        new Notice("未找到要重命名的会话");
        return;
      }
      await this.plugin.persistState();
      this.render();
    });

    const deleteBtn = actions.createEl("button", { cls: "oc-session-item-action is-danger" });
    deleteBtn.setAttr("type", "button");
    deleteBtn.setAttr("aria-label", "删除会话");
    deleteBtn.setAttr("title", "删除会话");
    setIcon(deleteBtn, "trash-2");
    deleteBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const confirmed = window.confirm(`确认删除会话「${displayTitle}」？`);
      if (!confirmed) return;
      const removed = typeof this.plugin.deleteSession === "function"
        ? await this.plugin.deleteSession(s.id)
        : this.plugin.sessionStore.removeSession(s.id);
      if (!removed) {
        new Notice("删除失败：未找到该会话");
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
    text: "兼容 OpenCode 会话、技能注入、模型切换与诊断。",
  });
}

function renderMain(main) {
  main.empty();

  const toolbar = main.createDiv({ cls: "oc-toolbar" });
  const toolbarLeft = toolbar.createDiv({ cls: "oc-toolbar-left" });
  const toolbarRight = toolbar.createDiv({ cls: "oc-toolbar-right" });

  const connectionIndicator = toolbarLeft.createDiv({ cls: "oc-connection-indicator" });
  this.elements.statusDot = connectionIndicator.createDiv({ cls: "oc-connection-dot warn" });
  this.elements.statusDot.setAttribute("aria-label", "连接状态未知");
  this.elements.statusDot.setAttribute("title", "连接状态未知");

  const settingsBtn = this.buildIconButton(toolbarRight, "settings", "设置", () => this.openSettings());
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
  topBtn.setAttr("aria-label", "滚动到顶部");
  topBtn.setAttr("title", "回到顶部");
  try {
    setIcon(topBtn, "chevron-up");
  } catch {
    topBtn.setText("↑");
  }
  topBtn.addEventListener("click", () => this.scrollMessagesTo("top"));
  const bottomBtn = navSidebar.createEl("button", { cls: "oc-nav-btn oc-nav-btn-bottom" });
  bottomBtn.setAttr("type", "button");
  bottomBtn.setAttr("aria-label", "滚动到底部");
  bottomBtn.setAttr("title", "到底部");
  try {
    setIcon(bottomBtn, "chevron-down");
  } catch {
    bottomBtn.setText("↓");
  }
  bottomBtn.addEventListener("click", () => this.scrollMessagesTo("bottom"));

  const contextFooter = main.createDiv({ cls: "oc-context-footer" });
  contextFooter.createDiv({ cls: "oc-context-session", text: `当前会话：${this.activeSessionLabel()}` });

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
      new Notice(`模型切换失败: ${msg}`);
    }
  });

  const skillPicker = quick.createDiv({ cls: "oc-skill-picker" });
  const skillSelect = skillPicker.createEl("select", { cls: "oc-skill-select" });
  this.elements.skillSelect = skillSelect;
  skillSelect.setAttr("title", "选择技能");
  skillSelect.createEl("option", { value: "", text: "技能 /skills" });

  const skills = this.plugin.skillService.getSkills();
  const setSkillSelectTitle = (skill) => {
    if (!skill) {
      skillSelect.setAttr("title", "选择技能");
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
    skillSelect.setAttr("title", "当前未发现可用技能，请检查 Skills 目录设置。");
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
      this.setRuntimeStatus(`已填入技能命令：/${picked.id}`, "info");
    });
  }

  navRow.createDiv({ cls: "oc-nav-row-meta", text: "Ctrl/Cmd + Enter 发送" });

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
    attr: { placeholder: "输入消息…支持技能注入和模型切换" },
  });
  this.elements.input.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      this.handleSend();
    }
  });

  const inputToolbar = inputWrapper.createDiv({ cls: "oc-input-toolbar" });
  inputToolbar.createDiv({ cls: "oc-input-meta", text: "OpenCode Compat Runtime" });

  const actions = inputToolbar.createDiv({ cls: "oc-actions" });
  this.elements.sendBtn = actions.createEl("button", { cls: "mod-cta oc-send-btn", text: "发送" });
  this.elements.cancelBtn = actions.createEl("button", { cls: "mod-muted oc-cancel-btn", text: "取消" });
  this.elements.cancelBtn.disabled = true;

  this.elements.sendBtn.addEventListener("click", () => this.handleSend());
  this.elements.cancelBtn.addEventListener("click", () => this.cancelSending());

  composer.createDiv({
    cls: "oc-hint",
    text: "支持会话切换、技能/模型下拉、Provider 登录管理与错误恢复。可通过 /skills、/model 快速切换；模型无响应时会给出报错并自动隐藏不可用项。",
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
    dot.setAttribute("aria-label", "连接状态未知");
    dot.setAttribute("title", "连接状态未知");
    return;
  }

  if (result.connection.ok) {
    dot.addClass("ok");
    const label = `连接正常 (${result.connection.mode})`;
    dot.setAttribute("aria-label", label);
    dot.setAttribute("title", label);
    return;
  }

  dot.addClass("error");
  const label = `连接异常 (${result.connection.mode})`;
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
