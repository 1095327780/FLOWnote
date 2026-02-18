const { Notice, setIcon } = require("obsidian");
const { DiagnosticsModal } = require("../modals");

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

function renderSidebarToggleIcon(button) {
  if (!button) return;
  button.innerHTML = "";

  const svg = this.createSvgNode("svg", {
    class: "oc-side-toggle-icon",
    viewBox: "0 0 20 20",
    "aria-hidden": "true",
    focusable: "false",
  });

  svg.appendChild(this.createSvgNode("rect", {
    x: "2.75",
    y: "3.25",
    width: "14.5",
    height: "13.5",
    rx: "2",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.3",
  }));
  svg.appendChild(this.createSvgNode("line", {
    x1: "7.2",
    y1: "3.7",
    x2: "7.2",
    y2: "16.3",
    stroke: "currentColor",
    "stroke-width": "1.2",
  }));
  svg.appendChild(this.createSvgNode("path", {
    d: this.isSidebarCollapsed ? "M10.4 6.8L13.6 10L10.4 13.2" : "M12.8 6.8L9.6 10L12.8 13.2",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }));

  button.appendChild(svg);
}

function scrollMessagesTo(target) {
  const messages = this.elements.messages;
  if (!messages) return;
  if (target === "top") messages.scrollTop = 0;
  else messages.scrollTop = messages.scrollHeight;
}

function toggleSidebarCollapsed() {
  this.isSidebarCollapsed = !this.isSidebarCollapsed;
  this.render();
}

function activeSessionLabel() {
  const st = this.plugin.sessionStore.state();
  const session = st.sessions.find((s) => s.id === st.activeSessionId);
  if (!session) return "未选择会话";
  return session.title || "未命名会话";
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
}

function renderSidebar(side) {
  side.empty();
  side.toggleClass("is-collapsed", this.isSidebarCollapsed);

  const header = side.createDiv({ cls: "oc-side-header" });
  header.createEl("h3", { text: "会话" });

  const sideActions = header.createDiv({ cls: "oc-side-actions" });
  const toggleBtn = sideActions.createEl("button", { cls: "oc-side-toggle" });
  toggleBtn.setAttr("aria-label", this.isSidebarCollapsed ? "展开会话列表" : "收起会话列表");
  toggleBtn.setAttr("title", this.isSidebarCollapsed ? "展开会话列表" : "收起会话列表");
  this.renderSidebarToggleIcon(toggleBtn);
  toggleBtn.addEventListener("click", () => this.toggleSidebarCollapsed());

  if (this.isSidebarCollapsed) {
    return;
  }

  const addBtn = sideActions.createEl("button", { cls: "oc-side-add", text: "新建" });
  addBtn.addEventListener("click", async () => {
    try {
      const session = await this.plugin.createSession("新会话");
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
    list.createDiv({ cls: "oc-empty", text: "暂无会话，点击“新建”开始。" });
    return;
  }

  sessions.forEach((s) => {
    const item = list.createDiv({ cls: "oc-session-item" });
    if (s.id === active) item.addClass("is-active");
    item.addEventListener("click", async () => {
      this.plugin.sessionStore.setActiveSession(s.id);
      await this.plugin.persistState();
      this.render();
    });

    item.createDiv({ cls: "oc-session-title", text: s.title || "未命名会话" });
    if (s.lastUserPrompt) {
      item.createDiv({ cls: "oc-session-preview", text: s.lastUserPrompt });
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

  this.elements.statusPill = toolbarLeft.createDiv({ cls: "oc-status-pill", text: "Checking..." });

  const modelSelect = toolbarLeft.createEl("select", { cls: "oc-select" });
  this.elements.modelSelect = modelSelect;
  modelSelect.createEl("option", { value: "", text: "模型: 默认（官方）" });
  (this.plugin.cachedModels || []).forEach((m) => modelSelect.createEl("option", { value: m, text: `模型: ${m}` }));
  if (this.selectedModel) modelSelect.value = this.selectedModel;
  modelSelect.addEventListener("change", async () => {
    try {
      await this.applyModelSelection(modelSelect.value);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      modelSelect.value = this.selectedModel || "";
      new Notice(`模型切换失败: ${msg}`);
    }
  });

  const retryBtn = toolbarRight.createEl("button", { cls: "oc-toolbar-btn", text: "重试上条" });
  retryBtn.addEventListener("click", async () => {
    const active = this.plugin.sessionStore.state().activeSessionId;
    const messages = this.plugin.sessionStore.state().messagesBySession[active] || [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return new Notice("没有可重试的用户消息");
    await this.sendPrompt(lastUser.text);
  });

  const diagBtn = toolbarRight.createEl("button", { cls: "oc-toolbar-btn", text: "诊断" });
  diagBtn.addEventListener("click", async () => {
    const result = await this.plugin.diagnosticsService.run();
    new DiagnosticsModal(this.app, result).open();
    this.applyStatus(result);
  });

  const settingsBtn = this.buildIconButton(toolbarRight, "settings", "设置", () => this.openSettings());
  settingsBtn.addClass("oc-toolbar-btn");

  const messagesWrapper = main.createDiv({ cls: "oc-messages-wrapper" });
  this.elements.messages = messagesWrapper.createDiv({ cls: "oc-messages oc-messages-focusable", attr: { tabindex: "0" } });
  this.elements.inlineQuestionHost = messagesWrapper.createDiv({ cls: "oc-inline-question-host" });
  this.renderMessages();

  const navSidebar = messagesWrapper.createDiv({ cls: "oc-nav-sidebar visible" });
  const topBtn = navSidebar.createEl("button", { cls: "oc-nav-btn oc-nav-btn-top" });
  setIcon(topBtn, "chevrons-up");
  topBtn.addEventListener("click", () => this.scrollMessagesTo("top"));
  const bottomBtn = navSidebar.createEl("button", { cls: "oc-nav-btn oc-nav-btn-bottom" });
  setIcon(bottomBtn, "chevrons-down");
  bottomBtn.addEventListener("click", () => this.scrollMessagesTo("bottom"));

  const contextFooter = main.createDiv({ cls: "oc-context-footer" });
  contextFooter.createDiv({ cls: "oc-context-session", text: `当前会话：${this.activeSessionLabel()}` });

  const composer = main.createDiv({ cls: "oc-composer" });
  this.elements.composer = composer;
  const navRow = composer.createDiv({ cls: "oc-input-nav-row" });
  const quick = navRow.createDiv({ cls: "oc-quick" });

  const skillPicker = quick.createDiv({ cls: "oc-skill-picker" });
  const skillSelect = skillPicker.createEl("select", { cls: "oc-skill-select" });
  this.elements.skillSelect = skillSelect;
  skillSelect.createEl("option", { value: "", text: "技能 /skills" });

  const skillDescription = skillPicker.createDiv({
    cls: "oc-skill-select-desc",
    text: "选择技能后会显示主要功能说明。",
  });
  this.elements.skillDescription = skillDescription;

  const skills = this.plugin.skillService.getSkills();
  skills.forEach((skill) => {
    const mainFeature = this.getSkillPrimaryDescription(skill);
    skillSelect.createEl("option", {
      value: skill.id,
      text: `${skill.name || skill.id} (/${skill.id}) - ${mainFeature}`,
    });
  });

  if (!skills.length) {
    skillSelect.disabled = true;
    skillDescription.setText("当前未发现可用技能，请检查 Skills 目录设置。");
  } else {
    skillSelect.addEventListener("change", () => {
      const selectedId = String(skillSelect.value || "");
      const picked = skills.find((skill) => String(skill.id) === selectedId);
      if (!picked) {
        skillDescription.setText("选择技能后会显示主要功能说明。");
        return;
      }

      skillDescription.setText(this.getSkillPrimaryDescription(picked));
      if (this.elements.input) {
        this.elements.input.value = `/${picked.id} `;
        this.elements.input.focus();
      }
      this.setRuntimeStatus(`已填入技能命令：/${picked.id}`, "info");
    });
  }

  const modelCmdBtn = quick.createEl("button", { cls: "oc-quick-btn", text: "模型 /models" });
  modelCmdBtn.addEventListener("click", async () => {
    const sessionId = await this.ensureActiveSession();
    await this.openModelSelector(sessionId);
  });
  navRow.createDiv({ cls: "oc-nav-row-meta", text: "Ctrl/Cmd + Enter 发送" });

  const inputWrapper = composer.createDiv({ cls: "oc-input-wrapper" });
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
    text: "支持会话切换、技能命令、模型切换、连接诊断和错误恢复。可通过技能下拉或 /skills 快速填入命令，/models、/model、/modle 会触发模型选择器。若看到 ENOENT，请在设置页填入 OpenCode 绝对路径。",
  });

  this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
  this.plugin.diagnosticsService.run().then((r) => this.applyStatus(r));
}

function applyStatus(result) {
  if (!this.elements.statusPill) return;
  this.elements.statusPill.removeClass("ok", "error", "warn");

  if (!result || !result.connection) {
    this.elements.statusPill.addClass("warn");
    this.elements.statusPill.setText("Unknown");
    return;
  }

  if (result.connection.ok) {
    this.elements.statusPill.addClass("ok");
    this.elements.statusPill.setText(`Connected (${result.connection.mode})`);
    return;
  }

  this.elements.statusPill.addClass("error");
  this.elements.statusPill.setText("Connection Error");
}

module.exports = { layoutRendererMethods: {
  openSettings,
  buildIconButton,
  createSvgNode,
  renderSidebarToggleIcon,
  scrollMessagesTo,
  toggleSidebarCollapsed,
  activeSessionLabel,
  render,
  renderHeader,
  renderSidebar,
  renderMain,
  applyStatus,
} };
