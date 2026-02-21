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
    this.autoScrollLock = false;
    this.messagesScrollEl = null;
    this.messagesScrollHandler = null;
    this.pendingScrollRaf = 0;
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
    void this.refreshPendingQuestionRequests({ force: true, silent: false }).catch(() => {});
  }

  onClose() {
    this.clearInlineQuestionWidget(true);
    this.unbindMessagesScrollTracking();
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
      const session = await this.plugin.createSession("");
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
    this.autoScrollLock = true;
    this.autoScrollEnabled = true;
    this.renderMessages();
    this.renderSidebar(this.root.querySelector(".oc-side"));
    this.scheduleScrollMessagesToBottom(true);
  
    this.currentAbort = new AbortController();
    this.setBusy(true);
    this.setRuntimeStatus("正在等待 OpenCode 响应…", "working");
    let shouldRerenderModelPicker = false;
  
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
          this.scheduleScrollMessagesToBottom();
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
          this.scheduleScrollMessagesToBottom();
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
          this.scheduleScrollMessagesToBottom();
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
        const activeModel = String(this.selectedModel || this.plugin.settings.defaultModel || "").trim();
        if (activeModel && this.plugin && typeof this.plugin.markModelUnavailable === "function") {
          const tracked = this.plugin.markModelUnavailable(activeModel, msg);
          if (tracked && tracked.hidden) {
            shouldRerenderModelPicker = true;
            if (String(this.plugin.settings.defaultModel || "").trim() === activeModel) {
              this.selectedModel = "";
              this.plugin.settings.defaultModel = "";
              try {
                await this.plugin.saveSettings();
              } catch {
              }
            }
            new Notice(`模型可能不可用，已从列表暂时隐藏：${activeModel}`);
          }
        }
        this.setRuntimeStatus(`请求失败：${msg}`, "error");
        this.plugin.sessionStore.finalizeAssistantDraft(sessionId, draftId, `请求失败: ${msg}`, msg);
        new Notice(msg);
      }
    } finally {
      this.currentAbort = null;
      this.setBusy(false);
      await this.plugin.persistState();
      try {
        this.autoScrollEnabled = true;
        if (shouldRerenderModelPicker) {
          this.render();
          return;
        }
        this.renderMessages();
        this.renderSidebar(this.root.querySelector(".oc-side"));
        this.scheduleScrollMessagesToBottom(true);
      } finally {
        this.autoScrollLock = false;
      }
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
