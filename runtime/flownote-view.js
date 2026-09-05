const {
  ItemView,
  Notice,
} = require("obsidian");
const {
  AskUserQuestionModal,
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
const { resolveMobileKeyboardState } = require("./mobile/keyboard-state");

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
    this.activePanel = "home";
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
    this.homeScrollState = { top: 0, left: 0, statsLeft: 0 };
    this.homeScrollEl = null;
    this.homeScrollHandler = null;
    this.homeStatsScrollEl = null;
    this.homeStatsScrollHandler = null;
    this.pendingHomeScrollRaf = 0;
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
    this._setupMobileKeyboardTracking();
  }

  onClose() {
    if (typeof this.saveHomeScrollPosition === "function") {
      this.saveHomeScrollPosition();
    }
    this.clearInlineQuestionWidget(true);
    if (typeof this.closeLinkedContextFilePicker === "function") {
      this.closeLinkedContextFilePicker();
    }
    if (typeof this.unbindHomeScrollTracking === "function") {
      this.unbindHomeScrollTracking();
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
    if (typeof this._mobileKeyboardCleanup === "function") {
      this._mobileKeyboardCleanup();
      this._mobileKeyboardCleanup = null;
    }
  }

  /**
   * Mobile keyboard tracking. iOS / Android soft keyboards shrink the
   * visual viewport independently from the layout viewport. Obsidian owns
   * the leaf/composer placement; FLOWnote only tracks whether the keyboard
   * is open so its closed-keyboard navbar/safe-area padding can be removed.
   * It must never translate the composer or measure overlap itself, because
   * that would apply a second layout correction after the host has resized.
   *
   * Pattern adapted from runtime/mobile/capture-modal.js (the only piece
   * of UX that was already battle-tested on the actual iOS keyboard).
   */
  _setupMobileKeyboardTracking() {
    let isMobile = false;
    try { isMobile = require("obsidian").Platform && require("obsidian").Platform.isMobile; } catch { /* desktop */ }
    if (!isMobile) return;
    const root = this.root || this.contentEl;
    if (!root) return;
    const vv = typeof window !== "undefined" && window.visualViewport ? window.visualViewport : null;
    const hostCandidates = Array.from(new Set([
      root,
      root.parentElement,
      this.containerEl,
    ].filter((candidate) => candidate && typeof candidate === "object")));
    let baselineBottom = 0;
    let rafId = 0;
    let resizeObserver = null;
    const hostBaselines = new Map();
    const timerIds = new Set();
    const disposers = [];

    // "Is the on-screen keyboard logically up?" is best derived from focus
    // (does the document currently have an input/textarea/contenteditable
    // focused?) rather than purely from viewport height — Obsidian iOS has
    // a window where the bottom toolbar slides BACK in BEFORE the
    // visualViewport.height fully restores, leaving viewport math thinking
    // a small keyboard is still up. Without this guard the composer's
    // is-kb-open class never clears → padding-bottom stays at 0 → the
    // composer overlaps Obsidian's bottom navbar.
    const isEditorFocused = () => {
      const el = typeof document !== "undefined" ? document.activeElement : null;
      if (!el) return false;
      if (typeof root.contains !== "function") return false;
      if (!root.contains(el)) return false;
      const composer = this.elements && this.elements.composer;
      const inlineQuestionHost = this.elements && this.elements.inlineQuestionHost;
      const inComposer = composer && typeof composer.contains === "function" && composer.contains(el);
      const inInlineQuestion = inlineQuestionHost
        && typeof inlineQuestionHost.contains === "function"
        && inlineQuestionHost.contains(el);
      if (!inComposer && !inInlineQuestion) return false;
      const tag = String(el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const getViewportBottom = () => {
      if (vv) return Number(vv.height || 0) + Number(vv.offsetTop || 0);
      return Number(window.innerHeight || 0);
    };
    const readHostHeight = (host) => Math.max(0, Number(host && host.clientHeight ? host.clientHeight : 0));
    const resetHostBaselines = () => {
      for (const host of hostCandidates) hostBaselines.set(host, readHostHeight(host));
    };
    const getHostSignal = (allowBaselineGrowth) => {
      let best = { hostBaselineHeight: 0, hostHeight: 0, shrink: 0 };
      for (const host of hostCandidates) {
        const hostHeight = readHostHeight(host);
        let hostBaselineHeight = Number(hostBaselines.get(host) || 0);
        if (!hostBaselineHeight || (allowBaselineGrowth && hostHeight > hostBaselineHeight)) {
          hostBaselineHeight = hostHeight;
          hostBaselines.set(host, hostBaselineHeight);
        }
        const shrink = Math.max(0, hostBaselineHeight - hostHeight);
        if (shrink > best.shrink || best.hostBaselineHeight === 0) {
          best = { hostBaselineHeight, hostHeight, shrink };
        }
      }
      return best;
    };
    const recalc = () => {
      const current = getViewportBottom();
      const focused = isEditorFocused();
      const { hostBaselineHeight, hostHeight } = getHostSignal(!focused);
      const layoutBottom = Math.max(
        Number(window.innerHeight || 0),
        Number(typeof document !== "undefined" && document.documentElement ? document.documentElement.clientHeight : 0),
        current,
      );
      if (!baselineBottom || layoutBottom > baselineBottom) baselineBottom = layoutBottom;
      const { open } = resolveMobileKeyboardState({
        editableFocused: focused,
        viewportBaselineBottom: baselineBottom,
        viewportBottom: current,
        hostBaselineHeight,
        hostHeight,
      });
      root.toggleClass("is-kb-open", open);
    };
    const schedule = (delay = 0) => {
      if (rafId) cancelAnimationFrame(rafId);
      if (delay > 0) {
        const timerId = window.setTimeout(() => {
          timerIds.delete(timerId);
          rafId = requestAnimationFrame(recalc);
        }, delay);
        timerIds.add(timerId);
      } else {
        rafId = requestAnimationFrame(recalc);
      }
    };
    const bind = (target, event, handler, options) => {
      target.addEventListener(event, handler, options);
      disposers.push(() => target.removeEventListener(event, handler, options));
    };

    baselineBottom = getViewportBottom();
    resetHostBaselines();
    schedule();
    schedule(80);
    schedule(220);

    if (vv) {
      bind(vv, "resize", () => schedule());
      bind(vv, "scroll", () => schedule());
    }
    bind(window, "resize", () => {
      baselineBottom = Math.max(baselineBottom, getViewportBottom());
      schedule();
    });
    bind(window, "orientationchange", () => {
      if (!isEditorFocused()) {
        baselineBottom = getViewportBottom();
        resetHostBaselines();
      }
      schedule(0);
      schedule(160);
    });
    if (hostCandidates.length > 0 && typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => schedule());
      for (const host of hostCandidates) resizeObserver.observe(host);
    }
    // Focus changes inside the composer (textarea / picker search input)
    // are the most reliable signal for "keyboard about to appear / leave".
    // On focusout we run a few staggered recalcs so the viewport math
    // settles AND the focused-element check clears the class immediately.
    bind(document, "focusin", () => schedule(40));
    bind(document, "focusout", () => {
      schedule(0);
      schedule(120);
      schedule(360);
    });

    this._mobileKeyboardCleanup = () => {
      if (rafId) cancelAnimationFrame(rafId);
      for (const timerId of timerIds) window.clearTimeout(timerId);
      timerIds.clear();
      for (const dispose of disposers) dispose();
      if (resizeObserver) resizeObserver.disconnect();
      root.removeClass("is-kb-open");
    };
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

  showPermissionRequestModal(permission, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
        resolve(answer || null);
      };
      const modal = new PermissionRequestModal(
        this.app,
        permission,
        finish,
        stringifyForDisplay,
        typeof this.plugin.t === "function" ? this.plugin.t.bind(this.plugin) : null,
      );
      const onAbort = () => modal.resolveAndClose(null);
      if (signal && signal.aborted) return onAbort();
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });
      modal.open();
    });
  }

  showAskUserModal(payload, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
        resolve(answer || { dismissed: true });
      };
      const modal = new AskUserQuestionModal(
        this.app,
        payload,
        finish,
        typeof this.plugin.t === "function" ? this.plugin.t.bind(this.plugin) : null,
      );
      const onAbort = () => modal.resolveAndClose({ dismissed: true, cancelled: true });
      if (signal && signal.aborted) return onAbort();
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });
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
      if (this.elements.cancelBtn) this.elements.cancelBtn.disabled = true;
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
