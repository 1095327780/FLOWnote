const { Modal, Notice } = require("obsidian");
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
    const { contentEl } = this;
    contentEl.addClass("oc-capture-modal");

    contentEl.createEl("h2", { text: "💡 快速捕获想法" });

    const inputEl = contentEl.createEl("textarea", {
      cls: "oc-capture-input",
      attr: { placeholder: "输入你的想法...", rows: "5" },
    });

    const statusEl = contentEl.createEl("div", { cls: "oc-capture-status" });

    const actionsEl = contentEl.createEl("div", { cls: "oc-capture-actions" });

    const cancelBtn = actionsEl.createEl("button", {
      text: "取消",
      cls: "oc-capture-btn oc-capture-btn-cancel",
    });

    const submitBtn = actionsEl.createEl("button", {
      text: "捕获",
      cls: "oc-capture-btn oc-capture-btn-submit",
    });

    cancelBtn.addEventListener("click", () => this.close());

    const doCapture = async () => {
      if (captureInFlight) return;
      const raw = inputEl.value.trim();
      if (!raw) {
        new Notice("请输入内容");
        return;
      }

      captureInFlight = true;
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = "处理中...";

      try {
        const mc = this.plugin.settings.mobileCapture;
        let finalText = raw;

        // AI cleanup if enabled and configured
        if (mc.enableAiCleanup && mc.apiKey) {
          statusEl.textContent = "🤖 AI 清理中...";
          try {
            finalText = await cleanupCapture(raw, mc);
          } catch (e) {
            console.warn("[FLOWnote] AI cleanup failed, using raw text:", e);
            statusEl.textContent = "⚠️ AI 清理失败，使用原文";
            finalText = raw;
          }
        }

        // Find or create daily note
        statusEl.textContent = "📝 写入日记...";
        const vault = this.app.vault;
        const dailyNote = await findOrCreateDailyNote(vault, mc.dailyNotePath);

        // Format and append
        const timeStr = formatTimeStr();
        const entry = formatCaptureEntry(timeStr, finalText);
        await appendToIdeaSection(vault, dailyNote, entry, mc.ideaSectionHeader);

        new Notice("✅ 想法已捕获");
        this.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        statusEl.textContent = `❌ ${msg}`;
        new Notice(`捕获失败: ${msg}`);
      } finally {
        captureInFlight = false;
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = "捕获";
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
