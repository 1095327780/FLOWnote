const { Modal, Notice, Platform } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { resolveEffectiveLocaleFromSettings } = require("./mobile-settings-utils");
const { cleanupCapture, hasAiConfig } = require("./mobile-ai-service");
const { enrichUrlsInText } = require("./mobile-url-summary-service");
const {
  findOrCreateDailyNote,
  appendToIdeaSection,
  formatCaptureEntry,
  formatTimeStr,
} = require("./daily-note-service");

let captureInFlight = false;

class CaptureModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("oc-capture-modal");
    const locale = typeof this.plugin.getEffectiveLocale === "function"
      ? this.plugin.getEffectiveLocale()
      : resolveEffectiveLocaleFromSettings(this.plugin.settings);
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);

    contentEl.createEl("div", { cls: "oc-capture-drag-handle" });
    contentEl.createEl("div", {
      cls: "oc-capture-title",
      text: t("mobile.capture.title", "💡 Quick Capture"),
    });

    const inputEl = contentEl.createEl("textarea", {
      cls: "oc-capture-input",
      attr: { placeholder: t("mobile.capture.inputPlaceholder", "Type your thought..."), rows: "4" },
    });

    const statusEl = contentEl.createEl("div", { cls: "oc-capture-status" });

    const footerEl = contentEl.createEl("div", { cls: "oc-capture-footer" });
    footerEl.createEl("span", {
      cls: "oc-capture-hint",
      text: Platform.isMobile ? "" : t("mobile.capture.hintSend", "Ctrl/Cmd + Enter to submit"),
    });
    const actionsEl = footerEl.createEl("div", { cls: "oc-capture-actions" });
    const cancelBtn = actionsEl.createEl("button", {
      text: t("mobile.capture.cancel", "Cancel"),
      cls: "oc-capture-btn oc-capture-btn-cancel",
    });
    const submitBtn = actionsEl.createEl("button", {
      text: t("mobile.capture.submit", "Capture"),
      cls: "oc-capture-btn oc-capture-btn-submit",
    });

    cancelBtn.addEventListener("click", () => this.close());

    const doCapture = async () => {
      if (captureInFlight) return;
      const raw = inputEl.value.trim();
      if (!raw) {
        new Notice(t("mobile.capture.emptyInput", "Please input content"));
        return;
      }

      captureInFlight = true;
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = t("mobile.capture.submitBusy", "Processing...");

      try {
        const mc = this.plugin.settings.mobileCapture;
        let finalText = raw;

        if (mc.enableAiCleanup && hasAiConfig(mc)) {
          statusEl.textContent = t("mobile.capture.statusAiCleanup", "🤖 Cleaning text...");
          try {
            finalText = await cleanupCapture(raw, mc, { locale });
          } catch (_error) {
            statusEl.textContent = t("mobile.capture.statusAiCleanupFailed", "⚠️ AI cleanup failed, using original text");
            finalText = raw;
          }
        }

        if (mc.enableUrlSummary !== false) {
          const hasUrl = /https?:\/\//i.test(finalText);
          if (hasUrl) {
            statusEl.textContent = t("mobile.capture.statusResolver", "🔗 Resolving URLs...");
            try {
              const enriched = await enrichUrlsInText(finalText, mc, {
                locale,
                onStatus: (hint) => {
                  if (hint) statusEl.textContent = hint;
                },
              });
              finalText = enriched.text;
              if (enriched.statusHint) statusEl.textContent = enriched.statusHint;
            } catch (error) {
              statusEl.textContent = t("mobile.capture.statusResolverFailed", "⚠️ URL resolve failed: {message}", {
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        statusEl.textContent = t("mobile.capture.statusWriteNote", "📝 Writing note...");
        const vault = this.app.vault;
        const dailyNote = await findOrCreateDailyNote(vault, mc.dailyNotePath, undefined, { locale });

        const timeStr = formatTimeStr();
        const entry = formatCaptureEntry(timeStr, finalText, { locale });
        await appendToIdeaSection(vault, dailyNote, entry, mc.ideaSectionHeader);

        new Notice(t("notices.captureSaved", "✅ Saved"));
        this.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        statusEl.textContent = `❌ ${msg}`;
        new Notice(t("notices.captureFailed", "Capture failed: {message}", { message: msg }));
      } finally {
        captureInFlight = false;
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = t("mobile.capture.submit", "Capture");
      }
    };

    submitBtn.addEventListener("click", doCapture);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doCapture();
      }
    });

    if (Platform.isMobile) {
      requestAnimationFrame(() => {
        const modalEl = contentEl.closest(".modal");
        if (!modalEl) return;

        const vv = typeof window !== "undefined" && window.visualViewport
          ? window.visualViewport
          : null;
        const ua = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
        const isLikelyIOS = Boolean(
          (Platform && (Platform.isIosApp || Platform.isIos))
          || /iPad|iPhone|iPod/i.test(ua),
        );

        let rafId = 0;
        let baselineBottom = 0;
        const listeners = [];

        const getViewportBottom = () => {
          if (vv) return Number(vv.height || 0) + Number(vv.offsetTop || 0);
          return Number(window.innerHeight || 0);
        };

        const applyKeyboardOffset = (keyboardHeight) => {
          const offset = Math.max(0, Math.round(Number(keyboardHeight) || 0));
          const inputFocused = typeof document !== "undefined" && document.activeElement === inputEl;

          if (isLikelyIOS && inputFocused) {
            modalEl.style.setProperty("top", "max(8px, env(safe-area-inset-top, 0px))", "important");
            modalEl.style.setProperty("bottom", "auto", "important");
            modalEl.toggleClass("oc-capture-top-mode", true);
            modalEl.toggleClass("oc-capture-kb-open", true);
            contentEl.style.setProperty("--oc-capture-keyboard-offset", `${offset}px`);
            return;
          }

          modalEl.toggleClass("oc-capture-top-mode", false);
          modalEl.style.setProperty("bottom", offset > 0 ? `${offset}px` : "0", "important");
          modalEl.style.setProperty("top", "auto", "important");
          modalEl.toggleClass("oc-capture-kb-open", offset > 0);
          contentEl.style.setProperty("--oc-capture-keyboard-offset", `${offset}px`);
        };

        const recalc = () => {
          const currentBottom = getViewportBottom();
          if (!baselineBottom || currentBottom > baselineBottom) baselineBottom = currentBottom;
          const keyboardHeight = Math.max(0, baselineBottom - currentBottom);
          applyKeyboardOffset(keyboardHeight);
        };

        const scheduleRecalc = (delay = 0) => {
          if (rafId) cancelAnimationFrame(rafId);
          if (delay > 0) {
            window.setTimeout(() => {
              rafId = requestAnimationFrame(recalc);
            }, delay);
            return;
          }
          rafId = requestAnimationFrame(recalc);
        };

        const bind = (target, eventName, handler, options) => {
          target.addEventListener(eventName, handler, options);
          listeners.push(() => target.removeEventListener(eventName, handler, options));
        };

        baselineBottom = getViewportBottom();
        scheduleRecalc();
        scheduleRecalc(80);
        scheduleRecalc(180);

        if (vv) {
          bind(vv, "resize", () => scheduleRecalc());
          bind(vv, "scroll", () => scheduleRecalc());
        }
        bind(window, "resize", () => {
          baselineBottom = Math.max(baselineBottom, getViewportBottom());
          scheduleRecalc();
        });
        bind(inputEl, "focus", () => scheduleRecalc(50));
        bind(inputEl, "blur", () => scheduleRecalc(120));
        bind(document, "focusin", () => scheduleRecalc(30));
        bind(document, "focusout", () => scheduleRecalc(120));

        this._vpCleanup = () => {
          if (rafId) cancelAnimationFrame(rafId);
          for (const dispose of listeners) dispose();
          modalEl.style.removeProperty("bottom");
          modalEl.style.removeProperty("top");
          modalEl.removeClass("oc-capture-kb-open");
          modalEl.removeClass("oc-capture-top-mode");
          contentEl.style.removeProperty("--oc-capture-keyboard-offset");
        };
      });
    }

    setTimeout(() => inputEl.focus(), 80);
  }

  onClose() {
    if (this._vpCleanup) {
      this._vpCleanup();
      this._vpCleanup = null;
    }
    this.contentEl.empty();
  }
}

module.exports = { CaptureModal };
