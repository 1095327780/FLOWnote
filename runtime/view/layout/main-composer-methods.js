const { Notice, setIcon } = require("obsidian");
const { tr } = require("./shared-utils");

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

const mainComposerMethods = {
  renderMain,
  applyStatus,
};

module.exports = { mainComposerMethods };
