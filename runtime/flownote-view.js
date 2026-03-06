const {
  ItemView,
  Notice,
} = require("obsidian");
const {
  PermissionRequestModal,
  PromptAppendModal,
} = require("./modals");
const {
  stringifyForDisplay,
} = require("./assistant-payload-utils");
const { runSendPrompt } = require("./chat/chat-orchestrator");
const { tFromContext } = require("./i18n-runtime");
const { commandRouterMethods } = require("./view/command-router");
const { layoutRendererMethods } = require("./view/layout-renderer");
const { messageRendererMethods } = require("./view/message-renderer");
const { questionFlowMethods } = require("./view/question-flow");
const { runtimeStatusMethods } = require("./view/runtime-status");

const VIEW_TYPE = "flownote-view";
const FLOWNOTE_ICON_ID = "flownote-journal-glow";

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

class FLOWnoteAssistantView extends ItemView {
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
    this.silentAbortBudget = 0;
    this.runtimeStatusState = { text: "", tone: "info" };
    this.autoScrollEnabled = true;
    this.messagesScrollEl = null;
    this.messagesScrollHandler = null;
    this.messagesIntentHandler = null;
    this.messagesKeyDownHandler = null;
    this.pendingScrollRaf = 0;
    this.ignoreMessageScrollEventsUntil = 0;
    this.forceBottomUntil = 0;
    this.lastManualScrollIntentAt = 0;
    this.linkedContextFiles = [];
    this.patchDiffCache = new Map();
    this.patchDiffInflight = new Map();
    this.patchDiffCacheSessionId = "";
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "FLOWnote";
  }

  getIcon() {
    return FLOWNOTE_ICON_ID;
  }

  async onOpen() {
    this.selectedModel = this.plugin.settings.defaultModel || "";
    this.render();
  }

  onClose() {
    this.clearInlineQuestionWidget(true);
    if (typeof this.closeLinkedContextFilePicker === "function") {
      this.closeLinkedContextFilePicker();
    }
    this.unbindMessagesScrollTracking();
    this.forceBottomUntil = 0;
    this.lastManualScrollIntentAt = 0;
    this.patchDiffCacheSessionId = "";
    this.patchDiffCache.clear();
    this.patchDiffInflight.clear();
    this.questionAnswerStates.clear();
    this.questionSubmitAt.clear();
    this.pendingQuestionRequests.clear();
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
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

  showPermissionRequestModal(permission) {
    return new Promise((resolve) => {
      const modal = new PermissionRequestModal(
        this.app,
        permission,
        (answer) => resolve(answer || null),
        stringifyForDisplay,
        typeof this.plugin.t === "function" ? this.plugin.t.bind(this.plugin) : null,
      );
      modal.open();
    });
  }

  showPromptAppendModal(appendText) {
    const modal = new PromptAppendModal(this.app, appendText, (value) => {
      this.prefillComposerInput(value);
    }, typeof this.plugin.t === "function" ? this.plugin.t.bind(this.plugin) : null);
    modal.open();
  }

  handleToastEvent(toast) {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const title = typeof toast.title === "string" ? toast.title.trim() : "";
    const message = typeof toast.message === "string" ? toast.message.trim() : "";
    const text = [title, message].filter(Boolean).join(": ") || t("view.toastFallback", "FLOWnote 提示");
    new Notice(text, 4000);
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
    return runSendPrompt(this, userText, options);
  }

  cancelSending() {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
      this.setBusy(false);
      new Notice(t("view.sendCanceled", "已取消发送"));
    }
  }

  setBusy(isBusy) {
    if (this.elements.sendBtn) this.elements.sendBtn.disabled = isBusy;
    if (this.elements.cancelBtn) this.elements.cancelBtn.disabled = !isBusy;
    if (this.elements.attachFileBtn) this.elements.attachFileBtn.disabled = isBusy;
    if (this.elements.modelSelect) this.elements.modelSelect.disabled = isBusy;
    if (this.elements.input) this.elements.input.disabled = isBusy;
    if (isBusy && typeof this.closeLinkedContextFilePicker === "function") {
      this.closeLinkedContextFilePicker();
    }
    if (this.root) {
      this.root.toggleClass("is-busy", isBusy);
    }
    if (!isBusy) {
      this.setRuntimeStatus("", "info");
    }
  }
}

Object.assign(
  FLOWnoteAssistantView.prototype,
  commandRouterMethods,
  layoutRendererMethods,
  messageRendererMethods,
  questionFlowMethods,
  runtimeStatusMethods,
);

module.exports = {
  VIEW_TYPE,
  FLOWnoteAssistantView,
};
