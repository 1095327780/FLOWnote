const { Modal, Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { cleanupCapture } = require("./mobile-ai-service");
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
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const { contentEl } = this;
    contentEl.addClass("oc-capture-modal");
    const locale = typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "zh-CN";

    contentEl.createEl("h2", { text: t("mobile.capture.title", "💡 快速捕获想法") });

    const inputEl = contentEl.createEl("textarea", {
      cls: "oc-capture-input",
      attr: { placeholder: t("mobile.capture.inputPlaceholder", "输入你的想法..."), rows: "5" },
    });

    const statusEl = contentEl.createEl("div", { cls: "oc-capture-status" });

    const actionsEl = contentEl.createEl("div", { cls: "oc-capture-actions" });

    const cancelBtn = actionsEl.createEl("button", {
      text: t("mobile.capture.cancel", "取消"),
      cls: "oc-capture-btn oc-capture-btn-cancel",
    });

    const submitBtn = actionsEl.createEl("button", {
      text: t("mobile.capture.submit", "捕获"),
      cls: "oc-capture-btn oc-capture-btn-submit",
    });

    cancelBtn.addEventListener("click", () => this.close());

    const doCapture = async () => {
      if (captureInFlight) return;
      const raw = inputEl.value.trim();
      if (!raw) {
        new Notice(t("mobile.capture.emptyInput", "请输入内容"));
        return;
      }

      captureInFlight = true;
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = t("mobile.capture.submitBusy", "处理中...");

      try {
        const mc = this.plugin.settings.mobileCapture;
        let finalText = raw;

        // AI cleanup if enabled and configured
        if (mc.enableAiCleanup && mc.apiKey) {
          statusEl.textContent = t("mobile.capture.statusAiCleanup", "🤖 AI 清理中...");
          try {
            finalText = await cleanupCapture(raw, mc, { locale });
          } catch (e) {
            statusEl.textContent = t("mobile.capture.statusAiCleanupFailed", "⚠️ AI 清理失败，使用原文");
            finalText = raw;
          }
        }

        // Find or create daily note
        statusEl.textContent = t("mobile.capture.statusWriteNote", "📝 写入日记...");
        const vault = this.app.vault;
        const dailyNote = await findOrCreateDailyNote(vault, mc.dailyNotePath, undefined, { locale });

        // Format and append
        const timeStr = formatTimeStr();
        const entry = formatCaptureEntry(timeStr, finalText, { locale });
        await appendToIdeaSection(vault, dailyNote, entry, mc.ideaSectionHeader);

        new Notice(t("notices.captureSaved", "✅ 想法已捕获"));
        this.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        statusEl.textContent = `❌ ${msg}`;
        new Notice(t("notices.captureFailed", "捕获失败: {message}", { message: msg }));
      } finally {
        captureInFlight = false;
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = t("mobile.capture.submit", "捕获");
      }
    };

    submitBtn.addEventListener("click", doCapture);

    // Ctrl/Cmd+Enter to submit
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doCapture();
      }
    });

    // Auto-focus the input
    setTimeout(() => inputEl.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { CaptureModal };
