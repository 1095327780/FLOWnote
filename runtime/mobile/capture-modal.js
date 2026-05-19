const { Modal, Notice, Platform, setIcon } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { resolveEffectiveLocaleFromSettings } = require("./mobile-settings-utils");
const {
  cleanupCapture,
  getChatCompletionsUrl,
  hasAiConfig,
  resolveAiConfig,
  resolveEffectiveCaptureSettings,
} = require("./mobile-ai-service");
const { enrichUrlsInText } = require("./mobile-url-summary-service");
const {
  findOrCreateDailyNote,
  appendToIdeaSection,
  formatCaptureEntry,
  formatTimeStr,
} = require("./daily-note-service");

let captureInFlight = false;

function getCaptureErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "");
}

function describeCaptureAi(ai) {
  const provider = ai && ai.preset && ai.preset.name
    ? ai.preset.name
    : String(ai && ai.providerId ? ai.providerId : "AI");
  const model = ai && ai.model ? String(ai.model) : "";
  return model ? `${provider} / ${model}` : provider;
}

function logCaptureAiFailure(plugin, error, ai) {
  const message = getCaptureErrorMessage(error);
  const endpoint = ai && ai.baseUrl
    ? getChatCompletionsUrl(ai)
    : "";
  const detail = `[mobile-capture] AI cleanup failed (${describeCaptureAi(ai)}${endpoint ? `, ${endpoint}` : ""}): ${message}`;
  if (plugin && typeof plugin.log === "function") {
    plugin.log(detail);
  }
  try {
    console.warn(detail);
  } catch (_e) {
    // Ignore console failures in constrained mobile webviews.
  }
}

class CaptureModal extends Modal {
  constructor(app, plugin, options = {}) {
    super(app);
    this.plugin = plugin;
    this.initialText = typeof options.initialText === "string" ? options.initialText : "";
    this.autoSubmit = Boolean(options.autoSubmit);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("oc-capture-modal");
    this.modalEl?.addClass?.("oc-modal-capture");
    const locale = typeof this.plugin.getEffectiveLocale === "function"
      ? this.plugin.getEffectiveLocale()
      : resolveEffectiveLocaleFromSettings(this.plugin.settings);
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const initialCaptureSettings = resolveEffectiveCaptureSettings(this.plugin.settings);
    const initialAi = resolveAiConfig(initialCaptureSettings);
    const aiReady = hasAiConfig(this.plugin.settings);

    contentEl.createEl("div", { cls: "oc-capture-drag-handle" });

    const headerEl = contentEl.createEl("div", { cls: "oc-capture-header" });
    const markEl = headerEl.createEl("div", { cls: "oc-capture-mark" });
    const markIconEl = markEl.createSpan({ cls: "oc-capture-mark-icon" });
    try { setIcon(markIconEl, "sparkles"); } catch (_e) { markIconEl.textContent = "✦"; }

    const headingEl = headerEl.createEl("div", { cls: "oc-capture-heading" });
    headingEl.createEl("div", {
      cls: "oc-capture-title",
      text: t("mobile.capture.title", "快速捕获"),
    });
    headingEl.createEl("div", {
      cls: "oc-capture-subtitle",
      text: t("mobile.capture.subtitle", "清理口语，写入今日日记"),
    });
    const aiChipEl = headerEl.createEl("div", {
      cls: `oc-capture-ai-chip ${aiReady ? "is-ready" : "is-muted"}`,
      text: aiReady
        ? t("mobile.capture.aiReady", "{provider} 清理", { provider: initialAi.preset.name || initialAi.providerId })
        : t("mobile.capture.aiOff", "原文记录"),
    });

    const inputEl = contentEl.createEl("textarea", {
      cls: "oc-capture-input",
      attr: { placeholder: t("mobile.capture.inputPlaceholder", "Type your thought..."), rows: "4" },
    });
    if (this.initialText) inputEl.value = this.initialText;

    const statusEl = contentEl.createEl("div", { cls: "oc-capture-status" });

    const footerEl = contentEl.createEl("div", { cls: "oc-capture-footer" });
    footerEl.createEl("span", {
      cls: "oc-capture-hint",
      text: Platform.isMobile ? "" : t("mobile.capture.hintSend", "Ctrl/Cmd + Enter to submit"),
    });
    const actionsEl = footerEl.createEl("div", { cls: "oc-capture-actions" });
    const cancelBtn = actionsEl.createEl("button", {
      text: t("mobile.capture.cancel", "Cancel"),
      cls: "oc-capture-btn oc-capture-btn-cancel mod-muted",
    });
    const submitBtn = actionsEl.createEl("button", {
      text: t("mobile.capture.submit", "Capture"),
      cls: "oc-capture-btn oc-capture-btn-submit mod-cta",
    });
    cancelBtn.type = "button";
    submitBtn.type = "button";

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
        const mc = resolveEffectiveCaptureSettings(this.plugin.settings);
        let finalText = raw;
        const currentAi = resolveAiConfig(mc);

        if (mc.enableAiCleanup && hasAiConfig(mc)) {
          statusEl.textContent = t("mobile.capture.statusAiCleanupDetail", "AI 清理中：{provider}", {
            provider: describeCaptureAi(currentAi),
          });
          aiChipEl.textContent = t("mobile.capture.aiRunning", "{provider} 处理中", {
            provider: currentAi.preset.name || currentAi.providerId,
          });
          aiChipEl.removeClass("is-muted");
          aiChipEl.addClass("is-ready");
          try {
            finalText = await cleanupCapture(raw, mc, { locale });
            aiChipEl.textContent = t("mobile.capture.aiReady", "{provider} 清理", {
              provider: currentAi.preset.name || currentAi.providerId,
            });
          } catch (error) {
            const message = getCaptureErrorMessage(error);
            logCaptureAiFailure(this.plugin, error, currentAi);
            statusEl.textContent = t("mobile.capture.statusAiCleanupFailedDetail", "AI 清理失败，已使用原文：{message}", {
              message,
            });
            aiChipEl.textContent = t("mobile.capture.aiFailed", "AI 回退原文");
            aiChipEl.removeClass("is-ready");
            aiChipEl.addClass("is-muted");
            finalText = raw;
          }
        } else {
          statusEl.textContent = t("mobile.capture.statusAiUnavailable", "未启用 AI 清理，按原文写入。");
          aiChipEl.textContent = t("mobile.capture.aiOff", "原文记录");
          aiChipEl.removeClass("is-ready");
          aiChipEl.addClass("is-muted");
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
        const dailyNote = await findOrCreateDailyNote(vault, mc.dailyNotePath, undefined, {
          locale,
          skillsDir: this.plugin
            && this.plugin.settings
            && typeof this.plugin.settings.skillsDir === "string"
            ? this.plugin.settings.skillsDir
            : ".opencode/skills",
        });

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
          const effectiveOffset = inputFocused ? offset : 0;
          const visibleHeight = vv
            ? Math.round(Number(vv.height || 0))
            : Math.round(Number(window.innerHeight || 0));
          const visibleTop = vv
            ? Math.max(0, Math.round(Number(vv.offsetTop || 0)))
            : 0;
          const topOffset = visibleTop + 8;

          modalEl.toggleClass("oc-capture-top-mode", false);
          modalEl.style.setProperty("bottom", "auto", "important");
          modalEl.style.setProperty("top", `${topOffset}px`, "important");
          modalEl.style.setProperty("left", "8px", "important");
          modalEl.style.setProperty("right", "8px", "important");
          modalEl.style.setProperty("width", "auto", "important");
          modalEl.style.setProperty("max-width", "none", "important");
          modalEl.toggleClass("oc-capture-kb-open", effectiveOffset > 0);
          modalEl.style.setProperty("--oc-capture-keyboard-offset", `${effectiveOffset}px`);
          modalEl.style.setProperty("--oc-capture-visible-height", `${visibleHeight}px`);
          contentEl.style.setProperty("--oc-capture-keyboard-offset", `${effectiveOffset}px`);
          contentEl.style.setProperty("--oc-capture-visible-height", `${visibleHeight}px`);
        };

        const recalc = () => {
          const currentBottom = getViewportBottom();
          const layoutBottom = Math.max(
            Number(window.innerHeight || 0),
            Number(document && document.documentElement ? document.documentElement.clientHeight : 0),
            currentBottom,
          );
          if (!baselineBottom || layoutBottom > baselineBottom) baselineBottom = layoutBottom;
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
          modalEl.style.removeProperty("left");
          modalEl.style.removeProperty("right");
          modalEl.style.removeProperty("width");
          modalEl.style.removeProperty("max-width");
          modalEl.removeClass("oc-capture-kb-open");
          modalEl.removeClass("oc-capture-top-mode");
          modalEl.style.removeProperty("--oc-capture-keyboard-offset");
          modalEl.style.removeProperty("--oc-capture-visible-height");
          contentEl.style.removeProperty("--oc-capture-keyboard-offset");
          contentEl.style.removeProperty("--oc-capture-visible-height");
        };
      });
    }

    setTimeout(() => {
      inputEl.focus();
      if (this.autoSubmit && inputEl.value.trim()) {
        void doCapture();
      }
    }, this.autoSubmit ? 120 : 80);
  }

  onClose() {
    if (this._vpCleanup) {
      this._vpCleanup();
      this._vpCleanup = null;
    }
    this.modalEl?.removeClass?.("oc-modal-capture");
    this.contentEl.empty();
  }
}

module.exports = { CaptureModal };
