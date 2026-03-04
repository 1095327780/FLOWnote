const { Notice, setIcon } = require("obsidian");
const { tr } = require("./shared-utils");

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
  if (isLikelyMissingOpenCode(result)) return false;
  const normalized = normalizeDiagnosticsResult(result);
  const err = normalized.connection.error.toLowerCase();
  return /wsl|failed to fetch|econnrefused|err_connection_refused|127\.0\.0\.1|connection/i.test(err);
}

function renderConnectionStatusPopoverContent(view, result) {
  const popover = view.elements && view.elements.statusPopover;
  if (!popover) return;
  const hasResult = Boolean(result && typeof result === "object" && result.connection && result.executable);
  const normalized = normalizeDiagnosticsResult(result);
  popover.empty();

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

  const appendCheckCommands = () => {
    connectionCheckCommands().forEach((cmd) => appendCommand(cmd));
  };

  if (!hasResult) {
    title.setText("正在检测 OpenCode 连接状态");
    appendLine("点击绿色状态点会自动刷新连接状态。");
    appendLine("如果长时间无法连接，可先检查本机安装：");
    appendCheckCommands();
    return;
  }

  if (normalized.connection.ok) {
    title.setText("OpenCode成功连接");
    appendLine(`连接模式：${normalized.connection.mode.toUpperCase()}`);
    if (normalized.executable.path) appendLine(`执行路径：${normalized.executable.path}`);
    return;
  }

  if (isLikelyMissingOpenCode(normalized)) {
    title.setText("OpenCode连接失败：未检测到可用安装");
    appendLine("请先在终端检查 OpenCode 是否安装正常：");
    appendCheckCommands();
    if (normalized.executable.hint) appendLine(`提示：${normalized.executable.hint}`);
    if (normalized.connection.error) appendLine(`错误：${normalized.connection.error}`);
    return;
  }

  if (isLikelyWindowsWslInstallIssue(normalized)) {
    title.setText("OpenCode连接失败：可能是 Windows + WSL 安装导致");
    appendLine("请改为在 Windows 本机用 Node.js 安装 OpenCode：");
    appendCommand("node -v");
    appendCommand("npm -v");
    appendCommand("npm install -g @opencode-ai/opencode");
    appendCommand("opencode --version");
    appendCommand("where opencode");
    appendLine("安装后重启 Obsidian，再点击状态点刷新连接。");
    if (normalized.connection.error) appendLine(`错误：${normalized.connection.error}`);
    return;
  }

  title.setText("OpenCode连接失败");
  appendLine("可先执行以下命令检查连接：");
  appendCheckCommands();
  if (normalized.connection.error) appendLine(`错误：${normalized.connection.error}`);
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

  const settingsBtn = this.buildIconButton(toolbarRight, "settings", tr(this, "view.settings", "Settings"), () => this.openSettings());
  settingsBtn.addClass("oc-toolbar-btn");

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
  this.elements.sendBtn.setAttr("title", tr(this, "view.action.sendShortcut", "Send (Ctrl/Cmd + Enter)"));
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
  renderMain,
  applyStatus,
};

module.exports = { mainComposerMethods };
