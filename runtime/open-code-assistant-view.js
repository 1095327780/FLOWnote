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
const { commandRouterMethods } = require("./view/command-router");
const { layoutRendererMethods } = require("./view/layout-renderer");
const { messageRendererMethods } = require("./view/message-renderer");
const { questionFlowMethods } = require("./view/question-flow");
const { runtimeStatusMethods } = require("./view/runtime-status");

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
      await this.plugin.bootstrapData({ waitRemote: false });
    } catch (e) {
      new Notice(`初始化失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.render();
    const activeSessionId = String(this.plugin.sessionStore.state().activeSessionId || "").trim();
    if (activeSessionId && typeof this.plugin.ensureSessionMessagesLoaded === "function") {
      void this.plugin
        .ensureSessionMessagesLoaded(activeSessionId, { force: false })
        .then(async (changed) => {
          if (!changed) return;
          await this.plugin.persistState();
          this.render();
        })
        .catch((error) => {
          this.plugin.log(`initial session history hydrate failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    void this.refreshPendingQuestionRequests({ force: true, silent: false }).catch(() => {});
  }

  onClose() {
    this.clearInlineQuestionWidget(true);
    this.unbindMessagesScrollTracking();
    this.forceBottomUntil = 0;
    this.lastManualScrollIntentAt = 0;
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
}

Object.assign(
  OpenCodeAssistantView.prototype,
  commandRouterMethods,
  layoutRendererMethods,
  messageRendererMethods,
  questionFlowMethods,
  runtimeStatusMethods,
);

module.exports = {
  VIEW_TYPE,
  OpenCodeAssistantView,
};
