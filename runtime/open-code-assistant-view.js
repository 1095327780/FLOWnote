const {
  ItemView,
  Notice,
  MarkdownRenderer,
  setIcon,
} = require("obsidian");
const {
  buildQuestionAnswerArrays: buildQuestionAnswerArraysRuntime,
  findPendingQuestionRequest: findPendingQuestionRequestRuntime,
  getQuestionRequestInteractionKey: getQuestionRequestInteractionKeyRuntime,
  normalizeQuestionRequest: normalizeQuestionRequestRuntime,
  questionRequestMapKey: questionRequestMapKeyRuntime,
  questionTextSignature: questionTextSignatureRuntime,
  removePendingQuestionRequest: removePendingQuestionRequestRuntime,
  tokenizeQuestionAnswer: tokenizeQuestionAnswerRuntime,
  upsertPendingQuestionRequest: upsertPendingQuestionRequestRuntime,
} = require("./question-runtime");
const { InlineAskUserQuestionPanel } = require("./inline-ask-user-question-panel");
const {
  DiagnosticsModal,
  ModelSelectorModal,
  PermissionRequestModal,
  PromptAppendModal,
} = require("./modals");
const {
  stringifyForDisplay,
  normalizeMarkdownForDisplay,
} = require("./assistant-payload-utils");

const VIEW_TYPE = "opencode-assistant-view";

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

class OpenCodeAssistantView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.root = null;
    this.elements = {};
    this.currentAbort = null;
    this.selectedModel = "";
    this.isSidebarCollapsed = false;
    this.questionAnswerStates = new Map();
    this.questionSubmitAt = new Map();
    this.pendingQuestionRequests = new Map();
    this.inlineQuestionWidget = null;
    this.inlineQuestionKey = "";
    this.lastQuestionResolveLogAt = 0;
    this.silentAbortBudget = 0;
    this.runtimeStatusState = { text: "", tone: "info" };
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "OpenCode 助手";
  }

  getIcon() {
    return "bot";
  }

  async onOpen() {
    this.selectedModel = this.plugin.settings.defaultModel || "";
    try {
      await this.plugin.bootstrapData();
    } catch (e) {
      new Notice(`初始化失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.render();
  }

  onClose() {
    this.clearInlineQuestionWidget(true);
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
  }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.plugin.manifest.id);
  }

  buildIconButton(parent, icon, label, onClick, cls = "") {
    const btn = parent.createEl("button", { cls: `oc-icon-btn ${cls}`.trim() });
    setIcon(btn, icon);
    btn.setAttr("aria-label", label);
    btn.setAttr("title", label);
    btn.addEventListener("click", onClick);
    return btn;
  }

  createSvgNode(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
    return node;
  }

  renderSidebarToggleIcon(button) {
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

  getSkillPrimaryDescription(skill) {
    if (!skill) return "选择技能后会显示主要功能说明。";

    const cleanInline = (line) => String(line || "")
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^>\s+/, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();

    const directRaw = String(skill.description || "").trim();
    const isBlockMarker = /^([>|][+-]?)$/.test(directRaw);
    if (!isBlockMarker && directRaw) {
      const directLines = directRaw
        .split(/\r?\n/)
        .map((line) => cleanInline(line))
        .filter((line) => line && !/^[-:| ]+$/.test(line));
      if (directLines.length) return directLines[0];
    }

    const lines = String(skill.summary || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        if (!line.startsWith("|")) return line.replace(/^[-*]\s+/, "");
        const cells = line
          .split("|")
          .map((cell) => cell.trim().replace(/^[-*]\s+/, ""))
          .filter(Boolean);
        const picked = cells.find((cell) => (
          !/^[-:]+$/.test(cell) &&
          !/^(name|名称|命令|command|技能|skill|功能|作用|描述|description)$/i.test(cell) &&
          !cell.startsWith("/")
        ));
        return picked || "";
      })
      .map((line) => cleanInline(line))
      .filter((line) => (
        line &&
        !/^#{1,6}\s/.test(line) &&
        !/^```/.test(line) &&
        !/^[-:| ]+$/.test(line)
      ));

    return lines[0] || "暂无技能说明";
  }

  scrollMessagesTo(target) {
    const messages = this.elements.messages;
    if (!messages) return;
    if (target === "top") messages.scrollTop = 0;
    else messages.scrollTop = messages.scrollHeight;
  }

  toggleSidebarCollapsed() {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
    this.render();
  }

  activeSessionLabel() {
    const st = this.plugin.sessionStore.state();
    const session = st.sessions.find((s) => s.id === st.activeSessionId);
    if (!session) return "未选择会话";
    return session.title || "未命名会话";
  }

  parseModelSlashCommand(text) {
    const input = String(text || "").trim();
    if (!input.startsWith("/")) return null;

    const raw = input.slice(1).trim();
    if (!raw) return null;

    const firstSpace = raw.indexOf(" ");
    const cmd = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim().toLowerCase();
    const args = (firstSpace >= 0 ? raw.slice(firstSpace + 1) : "").trim();

    if (!["models", "model", "modle"].includes(cmd)) return null;
    return { command: "models", args };
  }

  parseSkillSelectorSlashCommand(text) {
    const input = String(text || "").trim();
    if (!input.startsWith("/")) return null;

    const raw = input.slice(1).trim();
    if (!raw) return null;

    const firstSpace = raw.indexOf(" ");
    const cmd = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim().toLowerCase();
    if (!["skills", "skill"].includes(cmd)) return null;
    return { command: "skills" };
  }

  resolveSkillFromPrompt(userText) {
    const input = String(userText || "").trim();
    if (!input.startsWith("/")) return { skill: null, promptText: input };

    const raw = input.slice(1).trim();
    if (!raw) return { skill: null, promptText: input };

    const firstSpace = raw.indexOf(" ");
    const cmd = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim();
    const cmdLower = cmd.toLowerCase();
    if (!cmdLower) return { skill: null, promptText: input };
    if (["models", "model", "modle", "skills", "skill"].includes(cmdLower)) {
      return { skill: null, promptText: input };
    }

    const skills = this.plugin.skillService.getSkills();
    const skill = skills.find((item) => {
      const id = String(item.id || "").toLowerCase();
      const name = String(item.name || "").toLowerCase();
      return id === cmdLower || name === cmdLower;
    });

    if (!skill) return { skill: null, promptText: input };

    const rest = (firstSpace >= 0 ? raw.slice(firstSpace + 1) : "").trim();
    const promptText = rest || `请按技能 ${skill.name || skill.id} 处理当前任务。`;
    return { skill, promptText };
  }

  openSkillSelector() {
    const skills = this.plugin.skillService.getSkills();
    if (!skills.length) {
      new Notice("当前未发现可用技能，请先检查 Skills 目录设置。");
      return;
    }
    const select = this.elements.skillSelect;
    if (!select || select.disabled) {
      new Notice("技能下拉尚未初始化，请稍后再试。");
      return;
    }
    select.focus();
    if (typeof select.showPicker === "function") {
      try {
        select.showPicker();
        return;
      } catch {
      }
    }
    this.setRuntimeStatus("请从技能下拉列表中选择技能。", "info");
  }

  async refreshModelList() {
    const models = await this.plugin.opencodeClient.listModels();
    this.plugin.cachedModels = Array.isArray(models) ? models : [];
    return this.plugin.cachedModels;
  }

  async ensureActiveSession() {
    const st = this.plugin.sessionStore.state();
    if (st.activeSessionId) return st.activeSessionId;
    const session = await this.plugin.createSession("新会话");
    this.plugin.sessionStore.setActiveSession(session.id);
    await this.plugin.persistState();
    return session.id;
  }

  appendAssistantMessage(sessionId, text, error = "") {
    this.plugin.sessionStore.appendMessage(sessionId, {
      id: uid("msg"),
      role: "assistant",
      text: String(text || ""),
      error: String(error || ""),
      pending: false,
      createdAt: Date.now(),
    });
  }

  async applyModelSelection(modelID, options = {}) {
    const normalized = String(modelID || "").trim();
    const previous = String(this.selectedModel || "");
    const previousSetting = String(this.plugin.settings.defaultModel || "");

    this.selectedModel = normalized;
    this.plugin.settings.defaultModel = normalized;
    await this.plugin.saveSettings();

    if (this.elements.modelSelect) {
      this.elements.modelSelect.value = normalized;
    }

    try {
      if (normalized) {
        await this.plugin.opencodeClient.setDefaultModel({ model: normalized });
        if (!options.silentNotice) new Notice(`已切换模型：${normalized}`);
        return `已切换模型：${normalized}`;
      }

      if (!options.silentNotice) new Notice("已恢复默认模型（由 OpenCode 自动选择）");
      return "已恢复默认模型（由 OpenCode 自动选择）";
    } catch (e) {
      this.selectedModel = previous;
      this.plugin.settings.defaultModel = previousSetting;
      await this.plugin.saveSettings();
      if (this.elements.modelSelect) this.elements.modelSelect.value = previous;
      throw e;
    }
  }

  async openModelSelector(sessionId) {
    const models = this.plugin.cachedModels && this.plugin.cachedModels.length
      ? this.plugin.cachedModels
      : await this.refreshModelList();

    new ModelSelectorModal(this.app, {
      models,
      currentModel: this.selectedModel,
      onRefresh: async () => this.refreshModelList(),
      onSelect: async (picked) => {
        try {
          const text = await this.applyModelSelection(picked);
          this.appendAssistantMessage(sessionId, text, "");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.appendAssistantMessage(sessionId, `模型切换失败: ${msg}`, msg);
          new Notice(`模型切换失败: ${msg}`);
        } finally {
          await this.plugin.persistState();
          this.renderMessages();
          this.renderSidebar(this.root.querySelector(".oc-side"));
        }
      },
    }).open();
  }

  async handleModelSlashCommand(userText, parsed) {
    const sessionId = await this.ensureActiveSession();
    this.plugin.sessionStore.appendMessage(sessionId, {
      id: uid("msg"),
      role: "user",
      text: userText,
      createdAt: Date.now(),
    });

    if (!parsed.args) {
      this.appendAssistantMessage(sessionId, "已打开模型选择器。请选择一个模型。", "");
      await this.plugin.persistState();
      this.renderMessages();
      this.renderSidebar(this.root.querySelector(".oc-side"));
      await this.openModelSelector(sessionId);
      return;
    }

    try {
      const text = await this.applyModelSelection(parsed.args, { silentNotice: true });
      this.appendAssistantMessage(sessionId, text, "");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.appendAssistantMessage(sessionId, `模型切换失败: ${msg}`, msg);
      new Notice(`模型切换失败: ${msg}`);
    }

    await this.plugin.persistState();
    this.renderMessages();
    this.renderSidebar(this.root.querySelector(".oc-side"));
  }

  render() {
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

  renderHeader(header) {
    header.empty();

    const brand = header.createDiv({ cls: "oc-brand" });
    const logo = brand.createDiv({ cls: "oc-brand-logo" });
    setIcon(logo, "bot");
    brand.createDiv({ cls: "oc-brand-title", text: "OpenCode Assistant" });
  }

  renderSidebar(side) {
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

  renderMain(main) {
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

  applyStatus(result) {
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

  renderMessages() {
    const container = this.elements.messages;
    if (!container) return;
    container.empty();

    const messages = this.plugin.sessionStore.getActiveMessages();
    this.pruneQuestionAnswerStates(messages);
    if (!messages.length) {
      const welcome = container.createDiv({ cls: "oc-welcome" });
      welcome.createDiv({ cls: "oc-welcome-greeting", text: "今天想整理什么？" });
      welcome.createDiv({ cls: "oc-empty", text: "发送一条消息，或先从技能下拉中选择一个技能。" });
      this.renderInlineQuestionPanel(messages);
      return;
    }

    messages.forEach((m) => this.renderMessageItem(container, m));
    this.syncRuntimeStatusToPendingTail();
    container.scrollTop = container.scrollHeight;
    this.renderInlineQuestionPanel(messages);
  }

  renderUserActions(row, message) {
    const actions = row.createDiv({ cls: "oc-user-msg-actions" });

    const copyBtn = actions.createEl("button", { cls: "oc-inline-action" });
    setIcon(copyBtn, "copy");
    copyBtn.setAttr("aria-label", "复制消息");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(message.text || "");
      new Notice("用户消息已复制");
    });

    const retryBtn = actions.createEl("button", { cls: "oc-inline-action" });
    setIcon(retryBtn, "rotate-ccw");
    retryBtn.setAttr("aria-label", "基于此消息重试");
    retryBtn.addEventListener("click", async () => {
      await this.sendPrompt(message.text || "");
    });
  }

  attachCodeCopyButtons(container) {
    if (!container) return;
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".oc-copy-btn")) return;
      const btn = document.createElement("button");
      btn.className = "oc-copy-btn";
      btn.textContent = "复制";
      btn.addEventListener("click", async () => {
        const code = pre.querySelector("code");
        await navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
        new Notice("代码已复制");
      });
      pre.prepend(btn);
    });
  }

  ensureReasoningContainer(row, openByDefault) {
    let details = row.querySelector(".oc-message-reasoning");
    if (!details) {
      details = document.createElement("details");
      details.addClass("oc-message-reasoning");
      details.createEl("summary", { text: "思考过程（可折叠）" });
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

  ensureBlocksContainer(row) {
    let container = row.querySelector(".oc-part-list");
    if (!container) {
      container = row.createDiv({ cls: "oc-part-list" });
    }
    return container;
  }

  reorderAssistantMessageLayout(row) {
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

  normalizeBlockStatus(status) {
    const value = String(status || "").trim().toLowerCase();
    if (["completed", "running", "pending", "error"].includes(value)) return value;
    return "pending";
  }

  blockTypeLabel(type) {
    const value = String(type || "").trim();
    const map = {
      tool: "工具调用",
      subtask: "子任务",
      agent: "子代理",
      file: "文件",
      patch: "补丁",
      retry: "重试",
      compaction: "压缩",
      snapshot: "快照",
    };
    return map[value] || value || "输出";
  }

  blockStatusLabel(status) {
    const value = this.normalizeBlockStatus(status);
    if (value === "completed") return "已完成";
    if (value === "running") return "进行中";
    if (value === "error") return "失败";
    return "等待中";
  }

  toolDisplayName(block) {
    if (!block || typeof block !== "object") return "";
    if (typeof block.tool === "string" && block.tool.trim()) return block.tool.trim();
    const summary = typeof block.summary === "string" ? block.summary.trim() : "";
    const summaryMatch = summary.match(/^工具:\s*(.+)$/);
    if (summaryMatch && summaryMatch[1]) return summaryMatch[1].trim();
    const title = typeof block.title === "string" ? block.title.trim() : "";
    return title;
  }

  visibleAssistantBlocks(rawBlocks) {
    const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];
    return blocks.filter((block) => {
      if (!block || typeof block !== "object") return false;
      const type = String(block.type || "").trim().toLowerCase();
      if (!type) return false;
      if (type === "step-start" || type === "step-finish") return false;
      return true;
    });
  }

  hasReasoningBlock(rawBlocks) {
    const blocks = this.visibleAssistantBlocks(rawBlocks);
    return blocks.some((block) => String((block && block.type) || "").trim().toLowerCase() === "reasoning");
  }

  removeStandaloneReasoningContainer(row) {
    if (!row) return;
    const reasoning = row.querySelector(".oc-message-reasoning:not(.oc-part-reasoning)");
    if (reasoning && reasoning.parentElement) {
      reasoning.parentElement.removeChild(reasoning);
    }
  }

  runtimeStatusFromBlocks(rawBlocks) {
    const blocks = this.visibleAssistantBlocks(rawBlocks);
    const tools = blocks.filter((block) => block && String(block.type || "").trim().toLowerCase() === "tool");
    if (!tools.length) return null;

    const names = [...new Set(tools.map((block) => this.toolDisplayName(block)).filter(Boolean))];
    const shortNames = names.slice(0, 3).join(", ");
    const suffix = names.length > 3 ? "…" : "";
    const statusText = shortNames || "工具";
    const running = tools.some((block) => {
      const status = this.normalizeBlockStatus(block && block.status);
      return status === "running" || status === "pending";
    });
    if (running) {
      return { tone: "working", text: `正在调用：${statusText}${suffix}` };
    }

    const failed = tools.some((block) => this.normalizeBlockStatus(block && block.status) === "error");
    if (failed) {
      return { tone: "error", text: `工具执行失败：${statusText}${suffix}` };
    }

    return { tone: "working", text: `工具调用完成，正在整理回复…` };
  }

  findMessageRow(messageId) {
    if (!this.elements.messages || !messageId) return null;
    const rows = this.elements.messages.querySelectorAll(".oc-message");
    for (const row of rows) {
      if (row && row.dataset && row.dataset.messageId === messageId) return row;
    }
    return null;
  }

  parseMaybeJsonObject(raw) {
    if (typeof raw !== "string") return null;
    const text = raw.trim();
    if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  splitQuestionOptionString(raw) {
    const text = String(raw || "").trim();
    if (!text) return [];
    const byLines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (byLines.length > 1) return byLines;
    if (text.includes(" / ")) {
      return text
        .split(" / ")
        .map((part) => part.trim())
        .filter(Boolean);
    }
    if (text.includes("、")) {
      return text
        .split("、")
        .map((part) => part.trim())
        .filter(Boolean);
    }
    return [text];
  }

  normalizeQuestionOption(raw) {
    if (raw && typeof raw === "object") {
      const obj = raw;
      const label =
        (typeof obj.label === "string" && obj.label.trim()) ||
        (typeof obj.value === "string" && obj.value.trim()) ||
        (typeof obj.text === "string" && obj.text.trim()) ||
        (typeof obj.name === "string" && obj.name.trim()) ||
        "";
      const description =
        (typeof obj.description === "string" && obj.description.trim()) ||
        (typeof obj.desc === "string" && obj.desc.trim()) ||
        (typeof obj.hint === "string" && obj.hint.trim()) ||
        "";
      if (!label) return null;
      return { label, description };
    }
    const label = String(raw || "").trim();
    if (!label) return null;
    return { label, description: "" };
  }

  parseQuestionOptions(rawOptions) {
    const collected = [];
    const pushOption = (value) => {
      const normalized = this.normalizeQuestionOption(value);
      if (normalized) collected.push(normalized);
    };

    if (Array.isArray(rawOptions)) {
      rawOptions.forEach((value) => pushOption(value));
    } else if (rawOptions && typeof rawOptions === "object") {
      const obj = rawOptions;
      if (Array.isArray(obj.options)) {
        obj.options.forEach((value) => pushOption(value));
      } else if (Array.isArray(obj.choices)) {
        obj.choices.forEach((value) => pushOption(value));
      } else if (Array.isArray(obj.items)) {
        obj.items.forEach((value) => pushOption(value));
      } else {
        Object.entries(obj).forEach(([key, value]) => {
          if (typeof value === "string" && value.trim()) {
            pushOption({ label: key, description: value.trim() });
            return;
          }
          if (value === true || value === false || typeof value === "number") {
            pushOption({ label: key, description: String(value) });
            return;
          }
          pushOption(value);
        });
      }
    } else if (typeof rawOptions === "string") {
      this.splitQuestionOptionString(rawOptions).forEach((value) => pushOption(value));
    }

    const deduped = [];
    const seen = new Set();
    for (const option of collected) {
      const label = String(option.label || "").trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      deduped.push({
        label,
        description: String(option.description || "").trim(),
      });
    }
    return deduped;
  }

  normalizeQuestionItem(rawItem, index) {
    const obj = rawItem && typeof rawItem === "object"
      ? rawItem
      : { question: String(rawItem || "") };

    const question =
      (typeof obj.question === "string" && obj.question.trim()) ||
      (typeof obj.prompt === "string" && obj.prompt.trim()) ||
      (typeof obj.ask === "string" && obj.ask.trim()) ||
      (typeof obj.query === "string" && obj.query.trim()) ||
      (typeof obj.content === "string" && obj.content.trim()) ||
      (typeof obj.text === "string" && obj.text.trim()) ||
      (typeof obj.title === "string" && obj.title.trim()) ||
      (typeof obj.name === "string" && obj.name.trim()) ||
      "";
    if (!question) return null;

    const options = this.parseQuestionOptions(
      obj.options !== undefined
        ? obj.options
        : obj.choices !== undefined
          ? obj.choices
          : obj.items !== undefined
            ? obj.items
            : obj.answers !== undefined
              ? obj.answers
              : obj.selections !== undefined
                ? obj.selections
                : obj.values !== undefined
                  ? obj.values
                  : obj.select_options !== undefined
                    ? obj.select_options
                    : obj.selectOptions !== undefined
                      ? obj.selectOptions
                      : obj.candidates,
    );

    return {
      question,
      header: (typeof obj.header === "string" && obj.header.trim()) || `Q${index + 1}`,
      options,
      multiSelect: Boolean(obj.multiSelect || obj.multiple || obj.allowMultiple),
    };
  }

  normalizeQuestionInput(rawInput) {
    const parsedFromString = this.parseMaybeJsonObject(rawInput);
    const input = parsedFromString || rawInput;

    let rawQuestions = [];
    if (Array.isArray(input)) {
      rawQuestions = input;
    } else if (input && typeof input === "object") {
      if (Array.isArray(input.questions)) {
        rawQuestions = input.questions;
      } else if (typeof input.questions === "string") {
        const parsedQuestions = this.parseMaybeJsonObject(input.questions);
        if (Array.isArray(parsedQuestions)) rawQuestions = parsedQuestions;
      } else if (input.questions && typeof input.questions === "object") {
        rawQuestions = Object.values(input.questions);
      } else if (typeof input.question === "string" || typeof input.prompt === "string" || typeof input.text === "string") {
        rawQuestions = [input];
      }
    }

    const normalized = [];
    const seenQuestion = new Set();
    for (let i = 0; i < rawQuestions.length; i += 1) {
      const item = this.normalizeQuestionItem(rawQuestions[i], i);
      if (!item) continue;
      const qKey = String(item.question || "").trim();
      if (!qKey || seenQuestion.has(qKey)) continue;
      seenQuestion.add(qKey);
      normalized.push(item);
    }
    return normalized;
  }

  parseQuestionsFromDetailText(detailText) {
    const text = String(detailText || "").trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const questions = [];
    let current = null;

    const pushCurrent = () => {
      if (!current || !String(current.question || "").trim()) return;
      current.options = this.parseQuestionOptions(current.options);
      questions.push(current);
      current = null;
    };

    for (const rawLine of lines) {
      const line = String(rawLine || "").trim();
      if (!line) continue;
      if (line.startsWith("问题:")) {
        pushCurrent();
        current = {
          question: line.replace(/^问题:\s*/, "").trim(),
          header: `Q${questions.length + 1}`,
          options: [],
          multiSelect: false,
        };
        continue;
      }
      if (line.startsWith("选项:")) {
        if (!current) continue;
        const optionText = line.replace(/^选项:\s*/, "").trim();
        current.options = this.splitQuestionOptionString(optionText);
      }
    }
    pushCurrent();

    return questions.filter((item) => item && String(item.question || "").trim());
  }

  extractQuestionItemsFromBlock(block) {
    if (!block || typeof block !== "object") return [];
    const sources = [];
    if (block.toolInput !== undefined) sources.push(block.toolInput);
    if (block.raw && block.raw.state && block.raw.state.input !== undefined) sources.push(block.raw.state.input);
    if (block.raw && block.raw.input !== undefined) sources.push(block.raw.input);

    for (const source of sources) {
      const normalized = this.normalizeQuestionInput(source);
      if (normalized.length) return normalized;
    }
    if (typeof block.detail === "string" && block.detail.trim()) {
      const fromDetail = this.parseQuestionsFromDetailText(block.detail);
      if (fromDetail.length) return fromDetail;
    }
    return [];
  }

  questionTextSignature(questions) {
    return questionTextSignatureRuntime(questions);
  }

  questionRequestMapKey(sessionId, requestId) {
    return questionRequestMapKeyRuntime(sessionId, requestId);
  }

  getQuestionRequestInteractionKey(sessionId, requestId) {
    return getQuestionRequestInteractionKeyRuntime(sessionId, requestId);
  }

  normalizeQuestionRequest(raw) {
    return normalizeQuestionRequestRuntime(raw, (input) => this.normalizeQuestionInput(input));
  }

  upsertPendingQuestionRequest(raw) {
    return upsertPendingQuestionRequestRuntime(
      this.pendingQuestionRequests,
      raw,
      (input) => this.normalizeQuestionInput(input),
    );
  }

  removePendingQuestionRequest(sessionId, requestId) {
    removePendingQuestionRequestRuntime(this.pendingQuestionRequests, sessionId, requestId);
  }

  findPendingQuestionRequest(interaction) {
    return findPendingQuestionRequestRuntime(this.pendingQuestionRequests, interaction);
  }

  getQuestionInteractionKey(message, block, messageIndex = -1, blockIndex = -1) {
    const sessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim() || "active-session";
    const messageId = String(
      (message && (message.id || message.messageId || message.messageID || message.createdAt)) ||
      (messageIndex >= 0 ? `m${messageIndex}` : ""),
    ).trim();
    const blockId = String(
      (block && (block.id || (block.raw && block.raw.id) || (block.raw && block.raw.partID))) ||
      (blockIndex >= 0 ? `b${blockIndex}` : `question:${String((block && block.tool) || "question")}`),
    ).trim();
    if (!messageId || !blockId) return "";
    return `${sessionId}::${messageId}::${blockId}`;
  }

  getQuestionAnswerState(key, totalQuestions) {
    const total = Math.max(1, Number(totalQuestions) || 1);
    if (!key) return { total, answers: {}, submitted: false, sending: false };
    const existing = this.questionAnswerStates.get(key);
    if (existing && Number(existing.total) === total) {
      return existing;
    }
    const next = { total, answers: {}, submitted: false, sending: false };
    this.questionAnswerStates.set(key, next);
    return next;
  }

  buildQuestionAnswerPayload(questions, state) {
    const list = Array.isArray(questions) ? questions : [];
    const answers = state && state.answers ? state.answers : {};
    const lines = [];
    for (let index = 0; index < list.length; index += 1) {
      const question = list[index] && typeof list[index] === "object" ? list[index] : {};
      const answer = answers[index];
      if (!answer || typeof answer.value !== "string" || !answer.value.trim()) continue;
      const qid =
        (typeof question.id === "string" && question.id.trim()) ||
        `question_${index + 1}`;
      const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
      const content = custom ? `${answer.value.trim()} | ${custom}` : answer.value.trim();
      lines.push(`${qid}: ${content}`);
    }
    return lines.join("\n");
  }

  tokenizeQuestionAnswer(rawAnswer) {
    return tokenizeQuestionAnswerRuntime(rawAnswer);
  }

  buildQuestionAnswerArrays(questions, result, state) {
    return buildQuestionAnswerArraysRuntime(questions, result, state);
  }

  pruneQuestionAnswerStates(messages) {
    if (!(this.questionAnswerStates instanceof Map) || !this.questionAnswerStates.size) return;
    const activeMessages = Array.isArray(messages) ? messages : [];
    const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
    const keepKeys = new Set();
    for (let mi = 0; mi < activeMessages.length; mi += 1) {
      const message = activeMessages[mi];
      if (!message || message.role !== "assistant") continue;
      const blocks = this.visibleAssistantBlocks(message.blocks);
      for (let bi = 0; bi < blocks.length; bi += 1) {
        const block = blocks[bi];
        if (!block || block.type !== "tool" || block.tool !== "question") continue;
        const questions = this.extractQuestionItemsFromBlock(block);
        if (!questions.length) continue;
        const key = this.getQuestionInteractionKey(message, block, mi, bi);
        if (key) keepKeys.add(key);
      }
    }
    if (activeSessionId && this.pendingQuestionRequests instanceof Map) {
      for (const request of this.pendingQuestionRequests.values()) {
        if (!request || request.sessionId !== activeSessionId) continue;
        const questions = Array.isArray(request.questions) ? request.questions : [];
        if (!questions.length) continue;
        const requestKey = this.getQuestionRequestInteractionKey(activeSessionId, request.id);
        if (requestKey) keepKeys.add(requestKey);
      }
    }
    for (const key of this.questionAnswerStates.keys()) {
      if (!keepKeys.has(key)) this.questionAnswerStates.delete(key);
    }
    if (this.questionSubmitAt instanceof Map) {
      for (const key of this.questionSubmitAt.keys()) {
        if (!keepKeys.has(key)) this.questionSubmitAt.delete(key);
      }
    }
  }

  async submitQuestionAnswers(interactionKey, questions, state, directPayload = "", options = {}) {
    if (!state || state.submitted || state.sending) return;
    if (interactionKey) {
      const now = Date.now();
      const lastAt = Number(this.questionSubmitAt.get(interactionKey) || 0);
      if (now - lastAt < 1200) return;
      this.questionSubmitAt.set(interactionKey, now);
    }
    const payload = String(directPayload || "").trim() || this.buildQuestionAnswerPayload(questions, state);
    if (!payload.trim()) return;

    state.sending = true;
    state.submitted = true;
    this.renderMessages();

    try {
      const sessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
      let requestId = typeof options.requestId === "string" ? options.requestId.trim() : "";
      const providedAnswers = Array.isArray(options.questionAnswers) ? options.questionAnswers : null;

      if (!requestId) {
        const pending = this.findPendingQuestionRequest({
          key: interactionKey,
          sessionId,
          questions,
          message: options.message || null,
          block: options.block || null,
        });
        if (pending && pending.id) requestId = pending.id;
      }

      if (!requestId) {
        const listed = await this.plugin.opencodeClient.listQuestions({ signal: this.currentAbort ? this.currentAbort.signal : undefined });
        if (Array.isArray(listed)) {
          for (const req of listed) this.upsertPendingQuestionRequest(req);
        }
        const refreshed = this.findPendingQuestionRequest({
          key: interactionKey,
          sessionId,
          questions,
          message: options.message || null,
          block: options.block || null,
        });
        if (refreshed && refreshed.id) requestId = refreshed.id;
      }

      if (!requestId) {
        throw new Error("未找到可回复的 question 请求 ID");
      }

      const answers = providedAnswers && providedAnswers.length
        ? providedAnswers
        : this.buildQuestionAnswerArrays(questions, null, state);
      await this.plugin.opencodeClient.replyQuestion({
        requestId,
        sessionId,
        answers,
        signal: this.currentAbort ? this.currentAbort.signal : undefined,
      });
      this.removePendingQuestionRequest(sessionId, requestId);
      this.setRuntimeStatus("已提交问题回答，等待模型继续执行…", "info");
    } catch (e) {
      state.submitted = false;
      const msg = e instanceof Error ? e.message : String(e);
      this.setRuntimeStatus(`提交回答失败：${msg}`, "error");
    } finally {
      state.sending = false;
      if (interactionKey) this.questionAnswerStates.set(interactionKey, state);
      this.renderMessages();
    }
  }

  clearInlineQuestionWidget(silent = true) {
    if (this.inlineQuestionWidget && typeof this.inlineQuestionWidget.destroy === "function") {
      this.inlineQuestionWidget.destroy(silent);
    }
    this.inlineQuestionWidget = null;
    this.inlineQuestionKey = "";
    if (this.elements.inlineQuestionHost) {
      this.elements.inlineQuestionHost.empty();
    }
    if (this.elements.composer) {
      this.elements.composer.removeClass("is-inline-hidden");
    }
  }

  formatInlineQuestionPayload(questions, result) {
    const list = Array.isArray(questions) ? questions : [];
    const answerMap = result && typeof result === "object" ? result : {};
    const lines = [];
    for (const question of list) {
      if (!question || typeof question !== "object") continue;
      const qText = typeof question.question === "string" ? question.question.trim() : "";
      if (!qText) continue;
      const answer = typeof answerMap[qText] === "string" ? answerMap[qText].trim() : "";
      if (!answer) continue;
      if (list.length === 1) lines.push(answer);
      else lines.push(`${qText}: ${answer}`);
    }

    if (!lines.length) {
      for (const raw of Object.values(answerMap)) {
        const answer = typeof raw === "string" ? raw.trim() : "";
        if (answer) lines.push(answer);
      }
    }
    return lines.join("\n");
  }

  async submitInlineQuestionResult(interaction, result) {
    if (!interaction || !interaction.key) return;
    const state = interaction.state || this.getQuestionAnswerState(interaction.key, interaction.questions.length);
    if (state.submitted || state.sending) return;

    const payload = this.formatInlineQuestionPayload(interaction.questions, result);
    if (!String(payload || "").trim()) return;
    const questionAnswers = this.buildQuestionAnswerArrays(interaction.questions, result, state);

    await this.submitQuestionAnswers(interaction.key, interaction.questions, state, payload, {
      sessionId: interaction.sessionId,
      requestId: interaction.requestId || "",
      questionAnswers,
      message: interaction.message || null,
      block: interaction.block || null,
    });
  }

  findActiveQuestionInteraction(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
    const unresolved = [];
    for (let mi = list.length - 1; mi >= 0; mi -= 1) {
      const message = list[mi];
      if (!message || message.role !== "assistant") continue;
      const blocks = this.visibleAssistantBlocks(message.blocks);
      for (let bi = blocks.length - 1; bi >= 0; bi -= 1) {
        const block = blocks[bi];
        if (!block || block.type !== "tool" || block.tool !== "question") continue;
        const questions = this.extractQuestionItemsFromBlock(block);
        if (!questions.length) {
          unresolved.push({
            reason: "empty-questions",
            messageId: String((message && message.id) || ""),
            blockId: String((block && block.id) || ""),
            toolInputKeys: block && block.toolInput && typeof block.toolInput === "object"
              ? Object.keys(block.toolInput)
              : [],
          });
          continue;
        }
        const key = this.getQuestionInteractionKey(message, block, mi, bi);
        if (!key) {
          unresolved.push({
            reason: "missing-key",
            messageId: String((message && message.id) || ""),
            blockId: String((block && block.id) || ""),
            questionCount: questions.length,
          });
          continue;
        }
        const state = this.getQuestionAnswerState(key, questions.length);
        if (state.submitted) {
          unresolved.push({
            reason: "already-submitted",
            key,
            questionCount: questions.length,
          });
          continue;
        }
        const pendingRequest = this.findPendingQuestionRequest({
          key,
          sessionId: activeSessionId,
          message,
          block,
          questions,
        });
        return {
          key,
          sessionId: activeSessionId,
          message,
          block,
          questions,
          state,
          requestId: pendingRequest && pendingRequest.id ? pendingRequest.id : "",
        };
      }
    }

    if (activeSessionId && this.pendingQuestionRequests instanceof Map) {
      const pending = [];
      for (const request of this.pendingQuestionRequests.values()) {
        if (!request || request.sessionId !== activeSessionId) continue;
        if (!Array.isArray(request.questions) || !request.questions.length) continue;
        pending.push(request);
      }
      if (pending.length) {
        pending.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
        for (const request of pending) {
          const key = this.getQuestionRequestInteractionKey(activeSessionId, request.id);
          if (!key) continue;
          const state = this.getQuestionAnswerState(key, request.questions.length);
          if (state.submitted) continue;
          return {
            key,
            sessionId: activeSessionId,
            message: null,
            block: null,
            questions: request.questions,
            state,
            requestId: request.id,
          };
        }
      }
    }

    const now = Date.now();
    if (unresolved.length && now - Number(this.lastQuestionResolveLogAt || 0) > 1200) {
      this.lastQuestionResolveLogAt = now;
      console.log("[opencode-assistant] question interaction unresolved", unresolved.slice(0, 5));
    }
    return null;
  }

  renderInlineQuestionPanel(messages) {
    if (!this.elements.inlineQuestionHost || !this.elements.composer) return;
    if (this.inlineQuestionWidget && this.inlineQuestionWidget.rootEl && !this.inlineQuestionWidget.rootEl.isConnected) {
      this.inlineQuestionWidget = null;
      this.inlineQuestionKey = "";
    }
    const interaction = this.findActiveQuestionInteraction(messages);
    if (!interaction) {
      this.clearInlineQuestionWidget(true);
      return;
    }

    this.elements.composer.addClass("is-inline-hidden");
    if (this.inlineQuestionWidget && this.inlineQuestionKey === interaction.key) {
      return;
    }

    this.clearInlineQuestionWidget(true);
    this.inlineQuestionKey = interaction.key;
    console.log("[opencode-assistant] inline question panel", {
      key: interaction.key,
      count: Array.isArray(interaction.questions) ? interaction.questions.length : 0,
    });
    this.inlineQuestionWidget = new InlineAskUserQuestionPanel(
      this.elements.inlineQuestionHost,
      { questions: interaction.questions },
      (result) => {
        if (!result) {
          this.clearInlineQuestionWidget(true);
          this.setRuntimeStatus("已取消提问回答", "info");
          return;
        }
        void this.submitInlineQuestionResult(interaction, result);
      },
      this.currentAbort ? this.currentAbort.signal : undefined,
      {
        title: "OpenCode has a question",
        showCustomInput: true,
        immediateSelect: interaction.questions.length === 1 && Array.isArray(interaction.questions[0].options) && interaction.questions[0].options.length > 0,
      },
    );
    this.inlineQuestionWidget.render();
  }

  prefillComposerInput(text, options = {}) {
    const inputEl = this.elements.input;
    if (!inputEl) return;
    const content = String(text || "").trim();
    if (!content) return;
    const current = String(inputEl.value || "");
    inputEl.value = current && !current.endsWith("\n") ? `${current}\n${content}` : `${current}${content}`;
    inputEl.focus();
    if (options.sendNow) {
      void this.handleSend();
    }
  }

  hasVisibleQuestionToolCard() {
    const messages = this.plugin.sessionStore.getActiveMessages();
    return Boolean(this.findActiveQuestionInteraction(messages));
  }

  renderReasoningPart(container, block, messagePending) {
    const details = container.createEl("details", { cls: "oc-message-reasoning oc-part-reasoning" });
    const status = this.normalizeBlockStatus(block && block.status);
    details.addClass(`is-${status}`);
    details.setAttr("data-part-type", "reasoning");

    const summary = details.createEl("summary");
    summary.createSpan({ cls: "oc-part-reasoning-title", text: "思考过程（可折叠）" });
    summary.createSpan({
      cls: "oc-part-reasoning-status",
      text: this.blockStatusLabel(status),
    });

    const body = details.createDiv({ cls: "oc-message-reasoning-body" });
    const detailText = typeof block.detail === "string" ? block.detail : "";
    const content = normalizeMarkdownForDisplay(detailText);
    if (content) {
      MarkdownRenderer.render(this.app, content, body, "", this.plugin).then(() => {
        this.attachCodeCopyButtons(body);
      });
    } else {
      body.setText("...");
    }

    details.open = Boolean(messagePending || status === "running" || status === "pending");
  }

  renderAssistantBlocks(row, message) {
    const blocks = this.visibleAssistantBlocks(message.blocks);
    const container = this.ensureBlocksContainer(row);
    container.empty();
    if (!blocks.length) {
      container.toggleClass("is-empty", true);
      return;
    }
    container.toggleClass("is-empty", false);

    blocks.forEach((block) => {
      if (block && String(block.type || "").trim().toLowerCase() === "reasoning") {
        this.renderReasoningPart(container, block, Boolean(message && message.pending));
        return;
      }

      const card = container.createDiv({ cls: "oc-part-card" });
      const status = this.normalizeBlockStatus(block && block.status);
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
      if (title) {
        card.createDiv({ cls: "oc-part-title", text: title });
      }

      const summary = typeof block.summary === "string" ? block.summary.trim() : "";
      if (summary) {
        card.createDiv({ cls: "oc-part-summary", text: summary });
      }
      const preview = typeof block.preview === "string" ? block.preview.trim() : "";
      if (preview) {
        card.createDiv({ cls: "oc-part-preview", text: preview });
      }

      if (block && block.type === "tool" && block.tool === "question" && this.extractQuestionItemsFromBlock(block).length) {
        card.createDiv({
          cls: "oc-question-inline-note",
          text: "请在下方面板中回答。",
        });
      }

      const detail = typeof block.detail === "string" ? block.detail.trim() : "";
      if (detail) {
        const details = card.createEl("details", { cls: "oc-part-details" });
        details.createEl("summary", { text: "查看详情" });
        details.createEl("pre", { cls: "oc-part-detail", text: detail });
      }
    });
  }

  showPermissionRequestModal(permission) {
    return new Promise((resolve) => {
      const modal = new PermissionRequestModal(
        this.app,
        permission,
        (answer) => resolve(answer || null),
        stringifyForDisplay,
      );
      modal.open();
    });
  }

  showPromptAppendModal(appendText) {
    const modal = new PromptAppendModal(this.app, appendText, (value) => {
      this.prefillComposerInput(value);
    });
    modal.open();
  }

  handleToastEvent(toast) {
    const title = typeof toast.title === "string" ? toast.title.trim() : "";
    const message = typeof toast.message === "string" ? toast.message.trim() : "";
    const text = [title, message].filter(Boolean).join("：") || "OpenCode 提示";
    new Notice(text, 4000);
  }

  renderAssistantMeta(row, message) {
    const metaText = typeof message.meta === "string" ? message.meta.trim() : "";
    if (!metaText) return;
    const pre = row.createEl("pre", { cls: "oc-message-meta", text: metaText });
    if (/error|failed|失败|status=\d{3}/i.test(metaText)) {
      pre.addClass("is-error");
    }
  }

  renderMessageItem(parent, message) {
    const row = parent.createDiv({ cls: ["oc-message", `oc-message-${message.role}`] });
    row.dataset.messageId = message.id || "";
    if (message.pending) row.addClass("is-pending");

    const head = row.createDiv({ cls: "oc-msg-head" });
    head.createDiv({ cls: "oc-msg-role", text: message.role.toUpperCase() });
    if (message.error) head.createDiv({ cls: "oc-msg-error", text: message.error });

    const body = row.createDiv({ cls: "oc-message-content" });

    if (message.pending) {
      let pendingText = typeof message.text === "string" ? message.text : "";
      const hasPendingText = Boolean(String(pendingText || "").trim());
      const runtimeText = String((this.runtimeStatusState && this.runtimeStatusState.text) || "").trim();
      const runtimeTone = String((this.runtimeStatusState && this.runtimeStatusState.tone) || "info");
      const canShowRuntimeStatus = message.role === "assistant" && !hasPendingText && Boolean(runtimeText);
      body.removeClass("oc-runtime-tail", "is-info", "is-working", "is-error");
      if (canShowRuntimeStatus) {
        pendingText = runtimeText;
        body.addClass("oc-runtime-tail");
        if (runtimeTone === "error") body.addClass("is-error");
        else if (runtimeTone === "working") body.addClass("is-working");
        else body.addClass("is-info");
      }
      body.setText(pendingText);
      const hasReasoningBlocks = this.hasReasoningBlock(message.blocks);
      if (message.role === "assistant" && message.reasoning && !hasReasoningBlocks) {
        const reasoningBody = this.ensureReasoningContainer(row, true);
        if (reasoningBody) reasoningBody.textContent = message.reasoning;
      } else if (message.role === "assistant" && hasReasoningBlocks) {
        this.removeStandaloneReasoningContainer(row);
      }
      if (message.role === "assistant") {
        this.renderAssistantBlocks(row, message);
        this.renderAssistantMeta(row, message);
        this.reorderAssistantMessageLayout(row);
      }
      return;
    }

    const textForRender = normalizeMarkdownForDisplay(message.text || "");
    const hasReasoning = Boolean(message.reasoning && String(message.reasoning).trim());
    const hasReasoningBlocks = this.hasReasoningBlock(message.blocks);
    const hasBlocks = this.visibleAssistantBlocks(message.blocks).length > 0;
    const fallbackText = hasReasoning || hasBlocks ? "(结构化输出已返回，可展开下方详情查看。)" : "";
    MarkdownRenderer.render(this.app, textForRender || fallbackText, body, "", this.plugin).then(() => {
      this.attachCodeCopyButtons(body);
    });

    if (message.role === "assistant" && hasReasoning && !hasReasoningBlocks) {
      const reasoningBody = this.ensureReasoningContainer(row, !textForRender);
      if (reasoningBody) {
        const reasoningText = normalizeMarkdownForDisplay(message.reasoning || "");
        MarkdownRenderer.render(this.app, reasoningText, reasoningBody, "", this.plugin).then(() => {
          this.attachCodeCopyButtons(reasoningBody);
        });
      }
    } else if (message.role === "assistant" && hasReasoningBlocks) {
      this.removeStandaloneReasoningContainer(row);
    }
    if (message.role === "assistant") {
      this.renderAssistantBlocks(row, message);
      this.renderAssistantMeta(row, message);
      this.reorderAssistantMessageLayout(row);
    }

    if (message.role === "user") {
      this.renderUserActions(row, message);
    }
  }

  isAbortLikeError(message) {
    const text = String(message || "").toLowerCase();
    return /abort|aborted|cancelled|canceled|用户取消/.test(text);
  }

  async handleSend() {
    const input = this.elements.input;
    if (!input) return;
    const text = String(input.value || "").trim();
    if (!text) return;
    input.value = "";
    await this.sendPrompt(text);
  }

  async sendPrompt(userText, options = {}) {
    const requestOptions = options && typeof options === "object" ? options : {};
    const forceSessionId = typeof requestOptions.sessionId === "string" ? requestOptions.sessionId.trim() : "";
    const hideUserMessage = Boolean(requestOptions.hideUserMessage);

    const modelSlash = this.parseModelSlashCommand(userText);
    if (modelSlash) {
      await this.handleModelSlashCommand(userText, modelSlash);
      return;
    }

    const skillSelectorSlash = this.parseSkillSelectorSlashCommand(userText);
    if (skillSelectorSlash) {
      this.openSkillSelector();
      return;
    }

    const skillMatch = this.resolveSkillFromPrompt(userText);

    const st = this.plugin.sessionStore.state();
    let sessionId = forceSessionId || st.activeSessionId;
    if (forceSessionId && st.activeSessionId !== forceSessionId) {
      this.plugin.sessionStore.setActiveSession(forceSessionId);
      this.render();
    }

    if (!sessionId) {
      const session = await this.plugin.createSession("新会话");
      sessionId = session.id;
      this.plugin.sessionStore.setActiveSession(sessionId);
      this.render();
    }

    const userMessage = { id: uid("msg"), role: "user", text: userText, createdAt: Date.now() };
    const draftId = uid("msg");
    const draft = {
      id: draftId,
      role: "assistant",
      text: "",
      reasoning: "",
      meta: "",
      blocks: [],
      createdAt: Date.now(),
      pending: true,
      error: "",
    };
    if (!hideUserMessage) {
      this.plugin.sessionStore.appendMessage(sessionId, userMessage);
    }
    this.plugin.sessionStore.appendMessage(sessionId, draft);
    this.renderMessages();
    this.renderSidebar(this.root.querySelector(".oc-side"));

    this.currentAbort = new AbortController();
    this.setBusy(true);
    this.setRuntimeStatus("正在等待 OpenCode 响应…", "working");

    try {
      const prompt = this.plugin.skillService.buildInjectedPrompt(
        skillMatch.skill,
        this.plugin.settings.skillInjectMode,
        skillMatch.promptText || userText,
      );

      const response = await this.plugin.opencodeClient.sendMessage({
        sessionId,
        prompt,
        signal: this.currentAbort.signal,
        onToken: (partial) => {
          this.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, partial);
          if (String(partial || "").trim()) {
            this.setRuntimeStatus("正在生成回复…", "working");
          }
          const messages = this.elements.messages;
          if (!messages) return;
          const target = this.findMessageRow(draftId);
          if (target) {
            const body = target.querySelector(".oc-message-content");
            if (body) body.textContent = partial;
          }
          messages.scrollTop = messages.scrollHeight;
        },
        onReasoning: (partialReasoning) => {
          this.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, partialReasoning);
          if (String(partialReasoning || "").trim()) {
            this.setRuntimeStatus("模型思考中…", "working");
          }
          const messages = this.elements.messages;
          if (!messages) return;
          const target = this.findMessageRow(draftId);
          if (target) {
            const currentDraft = this.plugin
              .sessionStore
              .getActiveMessages()
              .find((msg) => msg && msg.id === draftId);
            const hasReasoningBlocks = this.hasReasoningBlock(currentDraft && currentDraft.blocks);
            if (hasReasoningBlocks && currentDraft) {
              this.renderAssistantBlocks(target, currentDraft);
              this.removeStandaloneReasoningContainer(target);
              this.reorderAssistantMessageLayout(target);
            } else {
              const reasoningBody = this.ensureReasoningContainer(target, true);
              if (reasoningBody) reasoningBody.textContent = partialReasoning || "...";
            }
          }
          messages.scrollTop = messages.scrollHeight;
        },
        onBlocks: (blocks) => {
          this.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, undefined, undefined, blocks);
          const runtimeStatus = this.runtimeStatusFromBlocks(blocks);
          if (runtimeStatus && runtimeStatus.text) {
            this.setRuntimeStatus(runtimeStatus.text, runtimeStatus.tone);
          }
          const messages = this.elements.messages;
          if (!messages) return;
          const target = this.findMessageRow(draftId);
          if (target) {
            const currentDraft = this.plugin
              .sessionStore
              .getActiveMessages()
              .find((msg) => msg && msg.id === draftId);
            if (currentDraft) {
              this.renderAssistantBlocks(target, currentDraft);
              this.removeStandaloneReasoningContainer(target);
              this.reorderAssistantMessageLayout(target);
            }
          }
          // Question tool arrives through streaming block updates; keep inline panel in sync in real time.
          this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
          messages.scrollTop = messages.scrollHeight;
        },
        onPermissionRequest: async (permission) => {
          this.setRuntimeStatus("等待权限确认…", "info");
          const decision = await this.showPermissionRequestModal(permission || {});
          if (!decision) return "reject";
          if (decision === "always" || decision === "once" || decision === "reject") {
            return decision;
          }
          return "reject";
        },
        onQuestionRequest: (questionRequest) => {
          const request = this.upsertPendingQuestionRequest(questionRequest || {});
          if (!request) return;
          console.log("[opencode-assistant] question requested", {
            id: request.id,
            sessionId: request.sessionId,
            count: Array.isArray(request.questions) ? request.questions.length : 0,
          });
          this.setRuntimeStatus("请在下方问题面板中回答。", "info");
          this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
        },
        onQuestionResolved: (info) => {
          const sessionIdFromEvent = String((info && info.sessionId) || "").trim();
          const requestIdFromEvent = String((info && info.requestId) || "").trim();
          if (requestIdFromEvent) {
            this.removePendingQuestionRequest(sessionIdFromEvent || sessionId, requestIdFromEvent);
          }
          this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
        },
        onPromptAppend: (appendText) => {
          this.setRuntimeStatus("等待补充输入…", "info");
          if (this.hasVisibleQuestionToolCard()) {
            this.setRuntimeStatus("请在下方问题面板中回答并提交。", "info");
            return;
          }
          this.showPromptAppendModal(appendText);
        },
        onToast: (toast) => {
          this.handleToastEvent(toast || {});
        },
      });

      this.plugin.sessionStore.finalizeAssistantDraft(
        sessionId,
        draftId,
        {
          text: response.text || "",
          reasoning: response.reasoning || "",
          meta: response.meta || "",
          blocks: Array.isArray(response.blocks) ? response.blocks : [],
        },
        /error|failed|失败|status=\d{3}/i.test(String(response.meta || "")) ? String(response.meta || "") : "",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isSilentAbort = this.silentAbortBudget > 0 && this.isAbortLikeError(msg);
      if (isSilentAbort) {
        this.silentAbortBudget = Math.max(0, Number(this.silentAbortBudget || 0) - 1);
        const existing = (this.plugin.sessionStore.state().messagesBySession[sessionId] || []).find((x) => x && x.id === draftId);
        this.plugin.sessionStore.finalizeAssistantDraft(
          sessionId,
          draftId,
          {
            text: existing && typeof existing.text === "string" ? existing.text : "",
            reasoning: existing && typeof existing.reasoning === "string" ? existing.reasoning : "",
            meta: existing && typeof existing.meta === "string" ? existing.meta : "",
            blocks: existing && Array.isArray(existing.blocks) ? existing.blocks : [],
          },
          "",
        );
        this.setRuntimeStatus("等待问题回答…", "info");
      } else {
        this.setRuntimeStatus(`请求失败：${msg}`, "error");
        this.plugin.sessionStore.finalizeAssistantDraft(sessionId, draftId, `请求失败: ${msg}`, msg);
        new Notice(msg);
      }
    } finally {
      this.currentAbort = null;
      this.setBusy(false);
      await this.plugin.persistState();
      this.renderMessages();
      this.renderSidebar(this.root.querySelector(".oc-side"));
    }
  }

  cancelSending() {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
      this.setBusy(false);
      new Notice("已取消发送");
    }
  }

  setBusy(isBusy) {
    if (this.elements.sendBtn) this.elements.sendBtn.disabled = isBusy;
    if (this.elements.cancelBtn) this.elements.cancelBtn.disabled = !isBusy;
    if (this.elements.input) this.elements.input.disabled = isBusy;
    if (this.root) {
      this.root.toggleClass("is-busy", isBusy);
    }
    if (!isBusy) {
      this.setRuntimeStatus("", "info");
    }
  }

  syncRuntimeStatusToPendingTail() {
    const container = this.elements.messages;
    if (!container) return;
    const rows = container.querySelectorAll(".oc-message-assistant.is-pending");
    if (!rows || !rows.length) return;
    const row = rows[rows.length - 1];
    if (!row) return;

    const body = row.querySelector(".oc-message-content");
    if (!body) return;

    const messageId = String((row.dataset && row.dataset.messageId) || "").trim();
    const draft = messageId
      ? this.plugin.sessionStore.getActiveMessages().find((msg) => msg && msg.id === messageId)
      : null;
    const draftText = draft && typeof draft.text === "string" ? draft.text.trim() : "";

    body.removeClass("oc-runtime-tail", "is-info", "is-working", "is-error");
    if (draftText) return;

    const statusText = String((this.runtimeStatusState && this.runtimeStatusState.text) || "").trim();
    body.setText(statusText);
    if (!statusText) return;

    body.addClass("oc-runtime-tail");
    const tone = String((this.runtimeStatusState && this.runtimeStatusState.tone) || "info");
    if (tone === "error") body.addClass("is-error");
    else if (tone === "working") body.addClass("is-working");
    else body.addClass("is-info");
  }

  setRuntimeStatus(text, tone = "info") {
    const normalizedText = String(text || "").trim();
    const normalizedTone = tone === "error" || tone === "working" ? tone : "info";
    this.runtimeStatusState = { text: normalizedText, tone: normalizedTone };
    this.syncRuntimeStatusToPendingTail();
  }
}


module.exports = {
  VIEW_TYPE,
  OpenCodeAssistantView,
};
