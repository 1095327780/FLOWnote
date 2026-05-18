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
    this._setupMobileKeyboardTracking();
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
    if (typeof this._mobileKeyboardCleanup === "function") {
      this._mobileKeyboardCleanup();
      this._mobileKeyboardCleanup = null;
    }
  }

  /**
   * Mobile keyboard tracking. iOS / Android soft keyboards shrink the
   * visual viewport instead of resizing the window — without this hook
   * the composer disappears behind the keyboard. We listen on
   * `window.visualViewport` and expose the keyboard height as a CSS var
   * `--oc-kb-offset` on the view's root, plus toggle `.is-kb-open` so
   * styles can shift the layout (e.g. shrink the message area).
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
    let baselineBottom = 0;
    let rafId = 0;
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
      const tag = String(el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const getViewportBottom = () => {
      if (vv) return Number(vv.height || 0) + Number(vv.offsetTop || 0);
      return Number(window.innerHeight || 0);
    };
    const apply = (kbHeight) => {
      // Hard rule: keyboard cannot be up if nothing is focused. This is
      // the primary fix for "keyboard dismissed → composer overlaps the
      // Obsidian navbar". Even if the viewport math suggests a residual
      // offset (e.g. while the toolbar is still re-animating in), we
      // force-clear the state when no editable is focused.
      const focused = isEditorFocused();
      const offset = focused ? Math.max(0, Math.round(Number(kbHeight) || 0)) : 0;
      root.style.setProperty("--oc-kb-offset", `${offset}px`);
      root.toggleClass("is-kb-open", offset > 0);
    };
    const recalc = () => {
      const current = getViewportBottom();
      if (!baselineBottom || current > baselineBottom) baselineBottom = current;
      apply(Math.max(0, baselineBottom - current));
    };
    const schedule = (delay = 0) => {
      if (rafId) cancelAnimationFrame(rafId);
      if (delay > 0) {
        window.setTimeout(() => { rafId = requestAnimationFrame(recalc); }, delay);
      } else {
        rafId = requestAnimationFrame(recalc);
      }
    };
    const bind = (target, event, handler, options) => {
      target.addEventListener(event, handler, options);
      disposers.push(() => target.removeEventListener(event, handler, options));
    };

    baselineBottom = getViewportBottom();
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
      for (const dispose of disposers) dispose();
      root.style.removeProperty("--oc-kb-offset");
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

  showAskUserModal(payload) {
    return new Promise((resolve) => {
      const modal = new AskUserQuestionModal(
        this.app,
        payload,
        (answer) => resolve(answer || { dismissed: true }),
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
