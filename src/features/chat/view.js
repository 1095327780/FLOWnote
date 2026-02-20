const { ItemView, Notice, MarkdownRenderer, Modal, setIcon } = require("obsidian");

const VIEW_TYPE = "opencode-assistant-view";

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function splitThinkingTag(text) {
  const raw = String(text || "");
  const match = raw.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (!match) {
    return { text: raw, thinking: "" };
  }

  return {
    text: raw.replace(/<thinking>[\s\S]*?<\/thinking>/i, "").trim(),
    thinking: String(match[1] || "").trim(),
  };
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

class DiagnosticsModal extends Modal {
  constructor(app, result) {
    super(app);
    this.result = result;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-diagnostics-modal");
    contentEl.createEl("h2", { text: "OpenCode 诊断" });

    if (!this.result) {
      contentEl.createEl("p", { text: "尚未运行诊断。" });
      return;
    }

    const conn = this.result.connection;
    const exe = this.result.executable;

    contentEl.createEl("h3", { text: "连接状态" });
    contentEl.createEl("p", { text: conn.ok ? `正常 (${conn.mode})` : `失败 (${conn.mode})` });
    if (conn.error) {
      contentEl.createEl("pre", { text: conn.error });
    }

    contentEl.createEl("h3", { text: "可执行文件探测" });
    contentEl.createEl("p", { text: exe.ok ? `找到: ${exe.path}` : "未找到" });
    if (exe.hint) {
      contentEl.createEl("p", { text: exe.hint });
    }

    const attempts = contentEl.createEl("details");
    attempts.createEl("summary", { text: `已尝试路径 (${(exe.attempted || []).length})` });
    attempts.createEl("pre", { text: (exe.attempted || []).join("\n") || "(无)" });
  }

  onClose() {
    this.contentEl.empty();
  }
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
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`初始化失败: ${msg}`);
    }
    this.render();
  }

  onClose() {}

  buildIconButton(parent, icon, ariaLabel, onClick) {
    const btn = parent.createEl("button", { cls: "oc-icon-btn" });
    btn.setAttr("aria-label", ariaLabel);
    btn.setAttr("type", "button");
    setIcon(btn, icon);
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

  getSkillBriefDescription(skill) {
    const primary = String(this.getSkillPrimaryDescription(skill) || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!primary || primary === "暂无技能说明") return "";

    let brief = primary;
    const namePrefix = String(skill && skill.name ? skill.name : "").trim();
    if (namePrefix && brief.toLowerCase().startsWith(namePrefix.toLowerCase())) {
      brief = brief.slice(namePrefix.length).trim();
      brief = brief.replace(/^[(（][^)）]+[)）]\s*[-—:：]?\s*/, "");
      brief = brief.replace(/^[-—:：\s]+/, "");
    }

    if (!brief) brief = primary;
    const delimiters = ["：", ":", "。", "；", ";", "，", ",", "（", "("];
    let cutIndex = brief.length;
    delimiters.forEach((delimiter) => {
      const index = brief.indexOf(delimiter);
      if (index > 0 && index < cutIndex) cutIndex = index;
    });
    brief = brief.slice(0, cutIndex).trim();
    if (brief.length > 24) brief = `${brief.slice(0, 24)}…`;
    return brief;
  }

  openSettings() {
    this.plugin.app.setting.open();
    this.plugin.app.setting.openTabById(this.plugin.manifest.id);
  }

  scrollMessagesTo(where) {
    const messages = this.elements.messages;
    if (!messages) return;
    if (where === "top") {
      messages.scrollTop = 0;
      return;
    }
    messages.scrollTop = messages.scrollHeight;
  }

  toggleSidebarCollapsed() {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
    this.render();
  }

  activeSessionLabel() {
    const state = this.plugin.sessionStore.getState();
    const activeId = state.activeSessionId;
    if (!activeId) return "未选择";
    const active = (state.sessions || []).find((session) => session.id === activeId);
    return active && active.title ? active.title : activeId;
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
    if (!cmdLower || ["skills", "skill", "models", "model", "modle"].includes(cmdLower)) {
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

  render() {
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
        const session = await this.plugin.createSession("新会话");
        this.plugin.sessionStore.setActiveSession(session.id);
        await this.plugin.persistState();
        this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    });

    const state = this.plugin.sessionStore.getState();
    const sessions = state.sessions;
    const active = state.activeSessionId;
    side.createDiv({ cls: "oc-side-count", text: `${sessions.length} 个会话` });
    const list = side.createDiv({ cls: "oc-session-list" });

    if (!sessions.length) {
      list.createDiv({ cls: "oc-empty", text: "暂无会话，点击“+”开始。" });
      return;
    }

    sessions.forEach((session) => {
      const item = list.createDiv({ cls: "oc-session-item" });
      if (session.id === active) item.addClass("is-active");
      item.addEventListener("click", async () => {
        this.plugin.sessionStore.setActiveSession(session.id);
        await this.plugin.persistState();
        this.render();
      });

      item.createDiv({ cls: "oc-session-title", text: session.title || "未命名会话" });
      if (session.lastUserPrompt) {
        item.createDiv({ cls: "oc-session-preview", text: session.lastUserPrompt });
      }
      item.createDiv({
        cls: "oc-session-meta",
        text: session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "",
      });
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

    const connectionIndicator = toolbarLeft.createDiv({ cls: "oc-connection-indicator" });
    this.elements.statusDot = connectionIndicator.createDiv({ cls: "oc-connection-dot warn" });
    this.elements.statusDot.setAttribute("aria-label", "连接状态未知");
    this.elements.statusDot.setAttribute("title", "连接状态未知");

    const settingsBtn = this.buildIconButton(toolbarRight, "settings", "设置", () => this.openSettings());
    settingsBtn.addClass("oc-toolbar-btn");

    const messagesWrapper = main.createDiv({ cls: "oc-messages-wrapper" });
    this.elements.messages = messagesWrapper.createDiv({
      cls: "oc-messages oc-messages-focusable",
      attr: { tabindex: "0" },
    });
    this.renderMessages();

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
    const navRow = composer.createDiv({ cls: "oc-input-nav-row" });
    const quick = navRow.createDiv({ cls: "oc-quick" });

    const modelPicker = quick.createDiv({ cls: "oc-model-picker" });
    const modelSelect = modelPicker.createEl("select", { cls: "oc-model-select" });
    this.elements.modelSelect = modelSelect;
    modelSelect.createEl("option", { value: "", text: "模型 /models" });
    const models = this.plugin.cachedModels || [];
    appendGroupedModelOptions(modelSelect, models);
    if (this.selectedModel) modelSelect.value = this.selectedModel;
    modelSelect.addEventListener("change", async () => {
      this.selectedModel = modelSelect.value;
      this.plugin.settings.defaultModel = this.selectedModel;
      await this.plugin.saveSettings();
    });

    const skillPicker = quick.createDiv({ cls: "oc-skill-picker" });
    const skillSelect = skillPicker.createEl("select", { cls: "oc-skill-select" });
    this.elements.skillSelect = skillSelect;
    skillSelect.setAttr("title", "选择技能");
    skillSelect.createEl("option", { value: "", text: "技能 /skills" });

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

    const skills = this.plugin.skillService.getSkills();
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
      text: "支持会话切换、技能/模型下拉、Provider 登录管理与错误恢复。可通过 /skills、/model 快速切换；模型无响应时会给出报错并自动隐藏不可用项。",
    });

    this.plugin.diagnosticsService.run().then((result) => this.applyStatus(result));
  }

  applyStatus(result) {
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

  setRuntimeStatus(text, tone = "info") {
    const normalizedText = String(text || "").trim();
    const normalizedTone = tone === "error" || tone === "working" ? tone : "info";
    this.runtimeStatusState = { text: normalizedText, tone: normalizedTone };
    this.syncRuntimeStatusToPendingTail();
  }

  renderMessages() {
    const container = this.elements.messages;
    if (!container) return;
    container.empty();

    const messages = this.plugin.sessionStore.getActiveMessages();
    if (!messages.length) {
      const welcome = container.createDiv({ cls: "oc-welcome" });
      welcome.createDiv({ cls: "oc-welcome-greeting", text: "今天想整理什么？" });
      welcome.createDiv({ cls: "oc-empty", text: "发送一条消息，或先从技能下拉中选择一个技能。" });
      return;
    }

    messages.forEach((message) => this.renderMessageItem(container, message));
    this.syncRuntimeStatusToPendingTail();
    container.scrollTop = container.scrollHeight;
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

  ensureReasoningContainer(row) {
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
    details.open = true;
    return details.querySelector(".oc-message-reasoning-body");
  }

  renderMessageItem(parent, message) {
    const row = parent.createDiv({ cls: ["oc-message", `oc-message-${message.role}`] });
    row.dataset.messageId = message.id || "";
    if (message.pending) row.addClass("is-pending");

    const head = row.createDiv({ cls: "oc-msg-head" });
    head.createDiv({ cls: "oc-msg-role", text: message.role.toUpperCase() });
    if (message.error) {
      head.createDiv({ cls: "oc-msg-error", text: message.error });
    }

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
      return;
    }

    const split = splitThinkingTag(message.text || "");
    MarkdownRenderer.render(this.app, split.text, body, "", this.plugin).then(() => {
      this.attachCodeCopyButtons(body);
    });

    if (message.role === "assistant" && split.thinking) {
      const reasoningBody = this.ensureReasoningContainer(row);
      if (reasoningBody) {
        MarkdownRenderer.render(this.app, split.thinking, reasoningBody, "", this.plugin).then(() => {
          this.attachCodeCopyButtons(reasoningBody);
        });
      }
    }

    if (message.role === "user") {
      this.renderUserActions(row, message);
    }
  }

  async handleSend() {
    const input = this.elements.input;
    if (!input) return;
    const text = String(input.value || "").trim();
    if (!text) return;
    input.value = "";
    await this.sendPrompt(text);
  }

  async sendPrompt(userText) {
    const skillSelectorSlash = this.parseSkillSelectorSlashCommand(userText);
    if (skillSelectorSlash) {
      this.openSkillSelector();
      return;
    }

    const skillMatch = this.resolveSkillFromPrompt(userText);

    const state = this.plugin.sessionStore.getState();
    let sessionId = state.activeSessionId;

    if (!sessionId) {
      const session = await this.plugin.createSession("新会话");
      sessionId = session.id;
      this.plugin.sessionStore.setActiveSession(sessionId);
      this.render();
    }

    const userMessage = {
      id: uid("msg"),
      role: "user",
      text: userText,
      createdAt: Date.now(),
    };

    const draftId = uid("msg");
    const draft = {
      id: draftId,
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      pending: true,
      error: "",
    };

    this.plugin.sessionStore.appendMessage(sessionId, userMessage);
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
          this.setRuntimeStatus("正在生成回复…", "working");

          const messages = this.elements.messages;
          if (!messages) return;
          const nodes = messages.querySelectorAll(".oc-message");
          const target = nodes[nodes.length - 1];
          if (target) {
            const body = target.querySelector(".oc-message-content");
            if (body) body.textContent = partial;
          }
          messages.scrollTop = messages.scrollHeight;
        },
      });

      this.plugin.sessionStore.finalizeAssistantDraft(sessionId, draftId, response.text || "", "");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.setRuntimeStatus(`请求失败: ${msg}`, "error");
      this.plugin.sessionStore.finalizeAssistantDraft(sessionId, draftId, `请求失败: ${msg}`, msg);
      new Notice(msg);
    } finally {
      this.currentAbort = null;
      this.setBusy(false);
      await this.plugin.persistState();
      this.renderMessages();
      this.renderSidebar(this.root.querySelector(".oc-side"));
    }
  }

  cancelSending() {
    if (!this.currentAbort) return;
    this.currentAbort.abort();
    this.currentAbort = null;
    this.setBusy(false);
    new Notice("已取消发送");
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
}

module.exports = {
  VIEW_TYPE,
  OpenCodeAssistantView,
};
