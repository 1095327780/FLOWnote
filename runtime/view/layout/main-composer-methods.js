const { Notice, Platform = {}, setIcon } = require("obsidian");
const { tr } = require("./shared-utils");
const { summarizeActiveAgent } = require("./agent-summary");

const OPENCODE_DOCS_URL = "https://opencode.ai/docs";

function getViewLocale(view) {
  const plugin = view && view.plugin;
  if (plugin && typeof plugin.getEffectiveLocale === "function") {
    return plugin.getEffectiveLocale() === "zh-CN" ? "zh-CN" : "en";
  }
  const raw = plugin && plugin.settings ? String(plugin.settings.uiLanguage || "") : "";
  return raw === "zh-CN" ? "zh-CN" : "en";
}

function viewText(view, zh, en) {
  return getViewLocale(view) === "zh-CN" ? zh : en;
}

function normalizeDiagnosticsResult(result) {
  const raw = result && typeof result === "object" ? result : {};
  const connection = raw.connection && typeof raw.connection === "object" ? raw.connection : {};
  const executable = raw.executable && typeof raw.executable === "object" ? raw.executable : {};
  return {
    connection: {
      ok: Boolean(connection.ok),
      mode: String(connection.mode || "sdk"),
      error: String(connection.error || "").trim(),
    },
    executable: {
      ok: Boolean(executable.ok),
      path: String(executable.path || "").trim(),
      hint: String(executable.hint || "").trim(),
    },
  };
}

function connectionCheckCommands() {
  if (typeof process !== "undefined" && process && process.platform === "win32") {
    return ["opencode --version", "where opencode"];
  }
  return ["opencode --version", "which opencode"];
}

function windowsInstallGuideCommands() {
  return [
    "node -v",
    "npm -v",
    "npm install -g opencode-ai",
    "opencode --version",
    "where opencode",
  ];
}

function isLikelyMissingOpenCode(result) {
  const normalized = normalizeDiagnosticsResult(result);
  if (!normalized.executable.ok) return true;
  const err = normalized.connection.error.toLowerCase();
  if (!err) return false;
  return /not found|command not found|enoent|executable not found|未找到|找不到/.test(err);
}

function isLikelyWindowsWslInstallIssue(result) {
  const isWindows = typeof process !== "undefined" && process && process.platform === "win32";
  if (!isWindows) return false;
  const normalized = normalizeDiagnosticsResult(result);
  const err = normalized.connection.error.toLowerCase();
  return /wsl(?:\.exe|\(|:|\/)|windows\s*\+\s*wsl/.test(err);
}

async function copyText(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
  }
  return false;
}

function renderDirectConnectionStatus(popover, view, summary) {
  const title = popover.createDiv({ cls: "oc-connection-popover-title" });
  const body = popover.createDiv({ cls: "oc-connection-popover-body" });
  const appendLine = (text) => {
    if (!text) return;
    body.createDiv({ cls: "oc-connection-popover-line", text: String(text) });
  };

  if (!summary.configComplete) {
    title.setText(viewText(view, "Direct 模式 · 未就绪", "Direct Mode · Not Ready"));
    appendLine(viewText(view, `服务商：${summary.providerLabel}`, `Provider: ${summary.providerLabel}`));
    if (summary.missingReason) appendLine(viewText(view, `待补全：${summary.missingReason}`, `Missing: ${summary.missingReason}`));
    appendLine(viewText(view, "打开 Obsidian → 设置 → FLOWnote 完成配置。", "Open Obsidian → Settings → FLOWnote to finish setup."));
    return;
  }
  title.setText(viewText(view, `${summary.providerLabel} 已就绪`, `${summary.providerLabel} Ready`));
  appendLine(viewText(view, `模型：${summary.modelLabel || summary.modelId}`, `Model: ${summary.modelLabel || summary.modelId}`));
  appendLine(viewText(
    view,
    "API Key 已配置。点击「测试连接」按钮可发起一次真实请求验证。",
    "API Key is configured. Use Test Connection in settings to verify it with a real request."
  ));
}

function renderConnectionStatusPopoverContent(view, result) {
  const popover = view.elements && view.elements.statusPopover;
  if (!popover) return;
  popover.empty();

  // Direct mode: connection state is entirely about the agent provider
  // (API key + model + reachability). The OpenCode probe is irrelevant.
  const summary = view && view.plugin ? summarizeActiveAgent(view.plugin) : null;
  if (summary && summary.mode === "direct") {
    renderDirectConnectionStatus(popover, view, summary);
    return;
  }

  const hasResult = Boolean(result && typeof result === "object" && result.connection && result.executable);
  const normalized = normalizeDiagnosticsResult(result);

  const title = popover.createDiv({ cls: "oc-connection-popover-title" });
  const body = popover.createDiv({ cls: "oc-connection-popover-body" });

  const appendLine = (text) => {
    if (!text) return;
    body.createDiv({ cls: "oc-connection-popover-line", text: String(text) });
  };

  const appendCommand = (cmd) => {
    if (!cmd) return;
    const line = body.createDiv({ cls: "oc-connection-popover-line" });
    line.createEl("code", { text: String(cmd) });
  };
  const appendLink = (label, url) => {
    if (!label || !url) return;
    const line = body.createDiv({ cls: "oc-connection-popover-line" });
    const anchor = line.createEl("a", { cls: "oc-copyable-link", text: String(label), href: String(url) });
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  };
  const appendCopyableDetails = (text) => {
    const value = String(text || "").trim();
    if (!value) return;
    const panel = body.createDiv({ cls: "oc-copyable-panel oc-copyable-panel--compact" });
    const actions = panel.createDiv({ cls: "oc-copyable-actions" });
    const copyBtn = actions.createEl("button", { text: viewText(view, "复制详情", "Copy Details") });
    copyBtn.type = "button";
    copyBtn.addEventListener("click", async () => {
      const copied = await copyText(value);
      new Notice(copied
        ? viewText(view, "详情已复制", "Details copied")
        : viewText(view, "复制失败，请手动选择文本复制", "Copy failed. Select the text manually."));
    });
    const area = panel.createEl("textarea", {
      cls: "oc-copyable-textarea",
      attr: {
        readonly: "true",
        spellcheck: "false",
        "aria-label": viewText(view, "连接诊断详情", "Connection diagnostics"),
      },
    });
    area.value = value;
    area.rows = Math.min(12, Math.max(4, value.split(/\r?\n/).length));
    area.addEventListener("focus", () => area.select());
    area.addEventListener("click", () => area.select());
  };

  const appendCheckCommands = () => {
    connectionCheckCommands().forEach((cmd) => appendCommand(cmd));
  };
  const appendWindowsInstallGuide = () => {
    appendLine(viewText(view, "请在 Windows 本机用 Node.js 安装 OpenCode，不要使用 WSL：", "Install OpenCode with Node.js on native Windows, not WSL:"));
    windowsInstallGuideCommands().forEach((cmd) => appendCommand(cmd));
    appendLink(viewText(view, "官方安装文档", "Official install docs"), OPENCODE_DOCS_URL);
  };

  if (!hasResult) {
    title.setText(viewText(view, "正在检测 OpenCode 连接状态", "Checking OpenCode Connection"));
    appendLine(viewText(view, "点击绿色状态点会自动刷新连接状态。", "Click the status dot to refresh the connection."));
    appendLine(viewText(view, "如果长时间无法连接，可先检查本机安装：", "If it stays disconnected, check the local installation first:"));
    appendCheckCommands();
    return;
  }

  if (normalized.connection.ok) {
    title.setText(viewText(view, "OpenCode成功连接", "OpenCode Connected"));
    appendLine(viewText(view, `连接模式：${normalized.connection.mode.toUpperCase()}`, `Connection mode: ${normalized.connection.mode.toUpperCase()}`));
    if (normalized.executable.path) appendLine(viewText(view, `执行路径：${normalized.executable.path}`, `Executable path: ${normalized.executable.path}`));
    return;
  }

  if (isLikelyMissingOpenCode(normalized)) {
    title.setText(viewText(view, "OpenCode连接失败：未检测到可用安装", "OpenCode Connection Failed: No Usable Install Found"));
    if (typeof process !== "undefined" && process && process.platform === "win32") {
      appendWindowsInstallGuide();
      appendLine(viewText(view, "安装后重启 Obsidian，再点击状态点刷新连接。", "Restart Obsidian after installing, then click the status dot to refresh."));
    } else {
      appendLine(viewText(view, "请先在终端检查 OpenCode 是否安装正常：", "Check whether OpenCode is installed correctly in a terminal:"));
      appendCheckCommands();
    }
    appendCopyableDetails([
      normalized.executable.hint ? viewText(view, `提示：${normalized.executable.hint}`, `Hint: ${normalized.executable.hint}`) : "",
      normalized.connection.error ? viewText(view, `错误：${normalized.connection.error}`, `Error: ${normalized.connection.error}`) : "",
    ].filter(Boolean).join("\n\n"));
    return;
  }

  if (isLikelyWindowsWslInstallIssue(normalized)) {
    title.setText(viewText(view, "OpenCode连接失败：检测到 WSL 安装", "OpenCode Connection Failed: WSL Install Detected"));
    appendLine(viewText(view, "请改用 Windows 本机 Node.js 安装。", "Install with native Windows Node.js instead."));
    appendWindowsInstallGuide();
    appendLine(viewText(view, "安装后重启 Obsidian，再点击状态点刷新连接。", "Restart Obsidian after installing, then click the status dot to refresh."));
    appendCopyableDetails(normalized.connection.error ? viewText(view, `错误：${normalized.connection.error}`, `Error: ${normalized.connection.error}`) : "");
    return;
  }

  title.setText(viewText(view, "OpenCode连接失败", "OpenCode Connection Failed"));
  appendLine(viewText(view, "可先执行以下命令检查连接：", "Run these commands to check the connection:"));
  appendCheckCommands();
  appendCopyableDetails(normalized.connection.error ? viewText(view, `错误：${normalized.connection.error}`, `Error: ${normalized.connection.error}`) : "");
}

function closeConnectionStatusPopover(view) {
  const popover = view.elements && view.elements.statusPopover;
  if (!popover) return;
  popover.removeClass("is-open");
  if (view.elements && view.elements.statusDot) {
    view.elements.statusDot.setAttribute("aria-expanded", "false");
  }
}

function openConnectionStatusPopover(view) {
  const popover = view.elements && view.elements.statusPopover;
  if (!popover) return;
  popover.addClass("is-open");
  if (view.elements && view.elements.statusDot) {
    view.elements.statusDot.setAttribute("aria-expanded", "true");
  }
}

async function refreshConnectionStatusPopover(view, force = true) {
  const diagnosticsService = view && view.plugin ? view.plugin.diagnosticsService : null;
  if (!diagnosticsService || typeof diagnosticsService.runCached !== "function") {
    renderConnectionStatusPopoverContent(view, null);
    return;
  }
  const result = await diagnosticsService.runCached(0, Boolean(force));
  view.applyStatus(result);
  renderConnectionStatusPopoverContent(view, result);
}

function renderConnectionStatus(container) {
  const connectionIndicator = container.createDiv({ cls: "oc-connection-indicator" });
  this.elements.statusDot = connectionIndicator.createDiv({ cls: "oc-connection-dot warn" });
  this.elements.statusDot.setAttr("role", "button");
  this.elements.statusDot.setAttr("tabindex", "0");
  this.elements.statusDot.setAttr("aria-haspopup", "dialog");
  this.elements.statusDot.setAttr("aria-expanded", "false");
  this.elements.statusDot.setAttribute("aria-label", tr(this, "view.connection.unknown", "Connection status unknown"));
  this.elements.statusDot.setAttribute("title", tr(this, "view.connection.unknown", "Connection status unknown"));
  this.elements.statusPopover = connectionIndicator.createDiv({ cls: "oc-connection-popover" });
  renderConnectionStatusPopoverContent(this, this.latestDiagnosticsResult || null);

  const toggleConnectionPopover = () => {
    const popover = this.elements && this.elements.statusPopover;
    if (!popover) return;
    if (popover.hasClass("is-open")) {
      closeConnectionStatusPopover(this);
      return;
    }
    openConnectionStatusPopover(this);
    renderConnectionStatusPopoverContent(this, this.latestDiagnosticsResult || null);
    void refreshConnectionStatusPopover(this, true).catch((error) => {
      if (this.plugin && typeof this.plugin.log === "function") {
        this.plugin.log(`refresh connection popover failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      renderConnectionStatusPopoverContent(this, this.latestDiagnosticsResult || null);
    });
  };

  const onDotActivate = (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleConnectionPopover();
  };
  this.elements.statusDot.addEventListener("click", onDotActivate);
  this.elements.statusDot.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      onDotActivate(event);
    }
  });
  connectionIndicator.addEventListener("click", (event) => event.stopPropagation());
  if (!this.connectionPopoverDocumentBound) {
    this.connectionPopoverDocumentBound = true;
    this.registerDomEvent(document, "click", () => {
      closeConnectionStatusPopover(this);
    });
  }
}

function renderMain(main) {
  main.empty();
  this.activePanel = this.activePanel === "chat" ? "chat" : "home";
  if (typeof this.closeLinkedContextFilePicker === "function") {
    this.closeLinkedContextFilePicker();
  }

  const toolbar = main.createDiv({ cls: "oc-toolbar" });
  const toolbarLeft = toolbar.createDiv({ cls: "oc-toolbar-left" });
  toolbar.createDiv({ cls: "oc-toolbar-right" });

  if (Platform && Platform.isMobile) {
    this.renderConnectionStatus(toolbarLeft);
  } else {
    toolbar.addClass("oc-toolbar-desktop-hidden");
  }

  if (this.activePanel !== "chat") {
    this.unbindMessagesScrollTracking();
    this.elements.messages = null;
    this.elements.inlineQuestionHost = null;
    this.elements.currentSessionLabel = null;
    this.elements.composer = null;
    this.elements.input = null;
    this.elements.inputContainer = null;
    this.elements.inputWrapper = null;
    this.elements.contextRow = null;
    this.elements.fileIndicator = null;
    this.elements.selectionIndicator = null;
    this.elements.attachFileBtn = null;
    this.elements.modelSelect = null;
    this.elements.modelSelectText = null;
    this.elements.cancelBtn = null;
    this.elements.sendBtn = null;
    const homeWrapper = main.createDiv({ cls: "oc-home-wrapper" });
    this.renderHomeDashboard(homeWrapper);
    return;
  }

  if (typeof this.unbindHomeScrollTracking === "function") {
    this.unbindHomeScrollTracking();
  }

  const messagesWrapper = main.createDiv({ cls: "oc-messages-wrapper" });
  this.elements.messages = messagesWrapper.createDiv({ cls: "oc-messages oc-messages-focusable", attr: { tabindex: "0" } });
  this.bindMessagesScrollTracking();
  this.elements.inlineQuestionHost = messagesWrapper.createDiv({ cls: "oc-inline-question-host" });
  this.renderMessages();

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
    attr: { placeholder: tr(this, "view.input.placeholder", "Type your message...") },
  });
  this.elements.input.addEventListener("keydown", (ev) => {
    if (typeof this.handleLinkedContextInputKeydown === "function" && this.handleLinkedContextInputKeydown(ev)) {
      return;
    }
    if (ev.key === "Escape" && !ev.isComposing && this.currentAbort) {
      ev.preventDefault();
      ev.stopPropagation();
      this.cancelSending();
      return;
    }
    const isEnter = ev.key === "Enter" || ev.code === "Enter" || ev.keyCode === 13;
    if (!isEnter) return;
    const sendWithEnter = Boolean(this.plugin && this.plugin.settings && this.plugin.settings.sendWithEnter);
    if (sendWithEnter) {
      if (ev.shiftKey) return;
      if (!ev.isComposing) {
        ev.preventDefault();
        this.handleSend();
      }
    } else {
      if ((ev.metaKey || ev.ctrlKey) && !ev.isComposing) {
        ev.preventDefault();
        this.handleSend();
      }
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
  const bindLinkedContextDropEvents = (targetEl) => {
    if (!targetEl || typeof targetEl.addEventListener !== "function") return;
    targetEl.addEventListener("dragenter", (event) => {
      if (typeof this.handleLinkedContextInputDragOver === "function") {
        this.handleLinkedContextInputDragOver(event);
      }
    });
    targetEl.addEventListener("dragover", (event) => {
      if (typeof this.handleLinkedContextInputDragOver === "function") {
        this.handleLinkedContextInputDragOver(event);
      }
    });
    targetEl.addEventListener("dragleave", (event) => {
      if (typeof this.handleLinkedContextInputDragLeave === "function") {
        this.handleLinkedContextInputDragLeave(event);
      }
    });
    targetEl.addEventListener("drop", (event) => {
      if (typeof this.handleLinkedContextInputDrop === "function") {
        this.handleLinkedContextInputDrop(event);
      }
    });
  };
  bindLinkedContextDropEvents(inputContainer);
  bindLinkedContextDropEvents(this.elements.input);

  const inputToolbar = inputWrapper.createDiv({ cls: "oc-input-toolbar" });
  const inputToolbarLeft = inputToolbar.createDiv({ cls: "oc-input-toolbar-left" });
  const inputToolbarRight = inputToolbar.createDiv({ cls: "oc-actions oc-actions-right" });

  this.elements.attachFileBtn = inputToolbarLeft.createEl("button", { cls: "mod-muted oc-context-link-btn" });
  this.elements.attachFileBtn.setAttr("type", "button");
  this.elements.attachFileBtn.setAttr("aria-label", tr(this, "view.context.attach", "Link Obsidian file context (@)"));
  this.elements.attachFileBtn.setAttr("title", tr(this, "view.context.attach", "Link Obsidian file context (@)"));
  try {
    setIcon(this.elements.attachFileBtn, "plus");
  } catch {
    this.elements.attachFileBtn.setText("+");
  }
  this.elements.attachFileBtn.addEventListener("click", () => this.openLinkedContextFilePicker());

  const modelSelectWrap = inputToolbarLeft.createDiv({ cls: "oc-model-select-inline-wrap" });
  const modelSelectText = modelSelectWrap.createSpan({
    cls: "oc-model-select-inline-text",
    text: tr(this, "view.model.placeholder", "Model"),
  });
  modelSelectWrap.createSpan({ cls: "oc-model-select-inline-caret", text: "▾" });
  const modelSelect = modelSelectWrap.createEl("select", {
    cls: "oc-model-select-inline",
    attr: { "aria-label": tr(this, "view.model.selectTitle", "Select model") },
  });
  this.elements.modelSelect = modelSelect;
  this.elements.modelSelectText = modelSelectText;
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

  this.elements.cancelBtn = inputToolbarRight.createEl("button", { cls: "mod-muted oc-cancel-btn", text: tr(this, "view.action.cancel", "Cancel") });
  this.elements.sendBtn = inputToolbarRight.createEl("button", { cls: "mod-cta oc-send-btn" });
  this.elements.sendBtn.setAttr("type", "button");
  this.elements.sendBtn.setAttr("aria-label", tr(this, "view.action.send", "Send"));
  const sendShortcutTip = Boolean(this.plugin && this.plugin.settings && this.plugin.settings.sendWithEnter)
    ? tr(this, "view.action.sendShortcutEnter", "Send (Enter)")
    : tr(this, "view.action.sendShortcut", "Send (Ctrl/Cmd + Enter)");
  this.elements.sendBtn.setAttr("title", sendShortcutTip);
  try {
    setIcon(this.elements.sendBtn, "arrow-up");
  } catch {
    this.elements.sendBtn.setText("↑");
  }
  this.elements.cancelBtn.setAttr("type", "button");
  this.elements.cancelBtn.setAttr("aria-label", tr(this, "view.action.cancel", "Cancel"));
  this.elements.cancelBtn.disabled = true;

  this.elements.sendBtn.addEventListener("click", () => this.handleSend());
  this.elements.cancelBtn.addEventListener("click", () => this.cancelSending());
  this.refreshLinkedContextIndicators();

  this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
  const diagnosticsService = this.plugin && this.plugin.diagnosticsService;
  if (diagnosticsService) {
    const cached = diagnosticsService.getLastResult();
    if (cached) {
      this.applyStatus(cached);
      renderConnectionStatusPopoverContent(this, cached);
    }
    if (typeof diagnosticsService.runCached === "function") {
      void diagnosticsService.runCached(10_000, false)
        .then((result) => {
          if (result) {
            this.applyStatus(result);
            renderConnectionStatusPopoverContent(this, result);
          }
        })
        .catch((error) => {
          if (this.plugin && typeof this.plugin.log === "function") {
            this.plugin.log(`view diagnostics refresh failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
    }
  }
}

function applyStatus(result) {
  const dot = this.elements.statusDot;
  if (!dot) return;
  this.latestDiagnosticsResult = result && typeof result === "object" ? result : null;

  dot.removeClass("ok", "error", "warn");

  // Direct mode: dot color reflects agent config readiness, not OpenCode.
  const summary = this.plugin ? summarizeActiveAgent(this.plugin) : null;
  if (summary && summary.mode === "direct") {
    if (summary.configComplete) {
      dot.addClass("ok");
      const label = `${summary.providerLabel} · ${summary.modelLabel || summary.modelId}`;
      dot.setAttribute("aria-label", label);
      dot.setAttribute("title", label);
    } else {
      dot.addClass("warn");
      const label = `${summary.providerLabel} · ${summary.missingReason || viewText(this, "未就绪", "Not ready")}`;
      dot.setAttribute("aria-label", label);
      dot.setAttribute("title", label);
    }
    return;
  }

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

const mainComposerMethods = {
  renderConnectionStatus,
  renderMain,
  applyStatus,
};

module.exports = { mainComposerMethods };
