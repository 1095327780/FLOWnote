const { Modal } = require("obsidian");

function defaultFormatForDisplay(value, maxLen = 2200) {
  if (value === undefined || value === null) return "";
  let out = "";
  if (typeof value === "string") {
    out = value;
  } else {
    try {
      out = JSON.stringify(value, null, 2);
    } catch {
      out = String(value);
    }
  }
  if (out.length <= maxLen) return out;
  return `${out.slice(0, maxLen)}\n...(${out.length - maxLen} chars truncated)`;
}

class DiagnosticsModal extends Modal {
  constructor(app, result) {
    super(app);
    this.result = result;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-diagnostics-modal");
    contentEl.createEl("h2", { text: "OpenCode 诊断" });

    if (!this.result) {
      contentEl.createEl("p", { text: "尚未运行诊断。" });
      return;
    }

    const conn = this.result.connection;
    const exe = this.result.executable;

    contentEl.createEl("h3", { text: "连接状态" });
    contentEl.createEl("p", { text: conn.ok ? `正常 (${conn.mode})` : `失败 (${conn.mode})` });
    if (conn.error) contentEl.createEl("pre", { text: conn.error });

    contentEl.createEl("h3", { text: "可执行文件探测" });
    contentEl.createEl("p", { text: exe.ok ? `找到: ${exe.path}` : "未找到" });
    if (exe.hint) contentEl.createEl("p", { text: exe.hint });

    const attempts = contentEl.createEl("details");
    attempts.createEl("summary", { text: `已尝试路径 (${(exe.attempted || []).length})` });
    attempts.createEl("pre", { text: (exe.attempted || []).join("\n") || "(无)" });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PermissionRequestModal extends Modal {
  constructor(app, permission, onResolve, formatForDisplay) {
    super(app);
    this.permission = permission || {};
    this.onResolve = onResolve;
    this.formatForDisplay = typeof formatForDisplay === "function" ? formatForDisplay : defaultFormatForDisplay;
    this.resolved = false;
  }

  resolveAndClose(value) {
    if (this.resolved) return;
    this.resolved = true;
    if (typeof this.onResolve === "function") this.onResolve(value);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-perm-modal");
    contentEl.createEl("h2", { text: "OpenCode 权限请求" });

    const title =
      (typeof this.permission.title === "string" && this.permission.title.trim()) ||
      "模型请求执行受限操作";
    contentEl.createDiv({ cls: "oc-perm-title", text: title });

    const meta = [];
    if (typeof this.permission.type === "string" && this.permission.type) {
      meta.push(`类型: ${this.permission.type}`);
    }
    if (this.permission.pattern) {
      meta.push(`模式: ${this.formatForDisplay(this.permission.pattern, 400)}`);
    }
    if (meta.length) {
      contentEl.createEl("pre", { cls: "oc-perm-meta", text: meta.join("\n") });
    }

    const details = contentEl.createEl("details", { cls: "oc-perm-details" });
    details.createEl("summary", { text: "查看完整 metadata" });
    details.createEl("pre", {
      text: this.formatForDisplay(this.permission.metadata || {}, 2400) || "(empty)",
    });

    const actions = contentEl.createDiv({ cls: "oc-perm-actions" });
    const rejectBtn = actions.createEl("button", { cls: "mod-muted", text: "拒绝" });
    const onceBtn = actions.createEl("button", { cls: "mod-cta", text: "本次允许" });
    const alwaysBtn = actions.createEl("button", { text: "始终允许(本会话)" });

    rejectBtn.addEventListener("click", () => this.resolveAndClose("reject"));
    onceBtn.addEventListener("click", () => this.resolveAndClose("once"));
    alwaysBtn.addEventListener("click", () => this.resolveAndClose("always"));
  }

  onClose() {
    if (!this.resolved && typeof this.onResolve === "function") {
      this.onResolve(null);
    }
    this.contentEl.empty();
  }
}

class PromptAppendModal extends Modal {
  constructor(app, promptText, onSubmit) {
    super(app);
    this.promptText = String(promptText || "");
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-prompt-modal");
    contentEl.createEl("h2", { text: "模型请求补充输入" });
    contentEl.createDiv({
      cls: "oc-prompt-desc",
      text: "OpenCode 通过 question/tool 触发了补充输入请求。你可以编辑后放入输入框继续。",
    });

    const input = contentEl.createEl("textarea", {
      cls: "oc-prompt-input",
      text: this.promptText,
    });

    const actions = contentEl.createDiv({ cls: "oc-prompt-actions" });
    const cancelBtn = actions.createEl("button", { cls: "mod-muted", text: "取消" });
    const useBtn = actions.createEl("button", { cls: "mod-cta", text: "填入输入框" });

    cancelBtn.addEventListener("click", () => this.close());
    useBtn.addEventListener("click", () => {
      if (typeof this.onSubmit === "function") this.onSubmit(String(input.value || ""));
      this.close();
    });

    setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ModelSelectorModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options || {};
    this.filterText = "";
    this.listEl = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-model-modal");

    contentEl.createEl("h2", { text: "选择模型" });
    contentEl.createDiv({
      cls: "oc-model-modal-subtitle",
      text: "使用官方模型列表（来自 OpenCode provider 配置）",
    });

    const search = contentEl.createEl("input", {
      cls: "oc-model-search",
      attr: { type: "text", placeholder: "搜索 provider/model…" },
    });
    search.addEventListener("input", () => {
      this.filterText = String(search.value || "").trim().toLowerCase();
      this.renderList();
    });

    const actions = contentEl.createDiv({ cls: "oc-model-modal-actions" });
    const refreshBtn = actions.createEl("button", { text: "刷新列表" });
    refreshBtn.addEventListener("click", async () => {
      if (typeof this.options.onRefresh !== "function") return;
      refreshBtn.disabled = true;
      refreshBtn.setText("刷新中...");
      try {
        const refreshed = await this.options.onRefresh();
        if (Array.isArray(refreshed)) this.options.models = refreshed;
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.setText("刷新列表");
        this.renderList();
      }
    });

    const clearBtn = actions.createEl("button", { text: "恢复默认" });
    clearBtn.addEventListener("click", async () => {
      if (typeof this.options.onSelect === "function") await this.options.onSelect("");
      this.close();
    });

    this.listEl = contentEl.createDiv({ cls: "oc-model-list" });
    this.renderList();
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();

    const models = Array.isArray(this.options.models) ? this.options.models : [];
    const filtered = models.filter((item) => {
      if (!this.filterText) return true;
      return String(item || "").toLowerCase().includes(this.filterText);
    });

    if (!filtered.length) {
      this.listEl.createDiv({ cls: "oc-model-empty", text: "未找到匹配模型" });
      return;
    }

    filtered.forEach((model) => {
      const row = this.listEl.createDiv({ cls: "oc-model-item" });
      if (model === this.options.currentModel) row.addClass("is-active");
      row.createDiv({ cls: "oc-model-item-id", text: model });
      row.createDiv({ cls: "oc-model-item-meta", text: model === this.options.currentModel ? "当前使用" : "点击切换" });

      row.addEventListener("click", async () => {
        if (typeof this.options.onSelect === "function") await this.options.onSelect(model);
        this.close();
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = {
  DiagnosticsModal,
  ModelSelectorModal,
  PermissionRequestModal,
  PromptAppendModal,
};

