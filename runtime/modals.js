const { Modal } = require("obsidian");
const { interpolateTemplate } = require("./i18n-runtime");

function tr(tFn, key, fallback, params = {}) {
  if (typeof tFn === "function") return tFn(key, params, { defaultValue: fallback });
  return interpolateTemplate(fallback, params);
}

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
  constructor(app, result, t) {
    super(app);
    this.result = result;
    this.t = t;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-diagnostics-modal");
    contentEl.createEl("h2", { text: tr(this.t, "modals.diagnostics.title", "FLOWnote Diagnostics") });

    if (!this.result) {
      contentEl.createEl("p", { text: tr(this.t, "modals.diagnostics.notRun", "Diagnostics has not run yet.") });
      return;
    }

    const conn = this.result.connection;
    const exe = this.result.executable;

    contentEl.createEl("h3", { text: tr(this.t, "modals.diagnostics.connection", "Connection") });
    contentEl.createEl("p", {
      text: conn.ok
        ? tr(this.t, "modals.diagnostics.connectionOk", "OK ({mode})", conn)
        : tr(this.t, "modals.diagnostics.connectionFailed", "Failed ({mode})", conn),
    });
    if (conn.error) contentEl.createEl("pre", { text: conn.error });

    contentEl.createEl("h3", { text: tr(this.t, "modals.diagnostics.executable", "Executable Detection") });
    contentEl.createEl("p", {
      text: exe.ok
        ? tr(this.t, "modals.diagnostics.executableFound", "Found: {path}", exe)
        : tr(this.t, "modals.diagnostics.executableMissing", "Not found"),
    });
    if (exe.hint) contentEl.createEl("p", { text: exe.hint });

    const attempts = contentEl.createEl("details");
    attempts.createEl("summary", {
      text: tr(this.t, "modals.diagnostics.attempted", "Attempted Paths ({count})", { count: (exe.attempted || []).length }),
    });
    attempts.createEl("pre", { text: (exe.attempted || []).join("\n") || tr(this.t, "modals.none", "(none)") });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PermissionRequestModal extends Modal {
  constructor(app, permission, onResolve, formatForDisplay, t) {
    super(app);
    this.permission = permission || {};
    this.onResolve = onResolve;
    this.formatForDisplay = typeof formatForDisplay === "function" ? formatForDisplay : defaultFormatForDisplay;
    this.t = t;
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
    contentEl.createEl("h2", { text: tr(this.t, "modals.permission.title", "FLOWnote Permission Request") });

    const title =
      (typeof this.permission.title === "string" && this.permission.title.trim()) ||
      tr(this.t, "modals.permission.defaultTitle", "Model requested a restricted operation");
    contentEl.createDiv({ cls: "oc-perm-title", text: title });

    const meta = [];
    if (typeof this.permission.type === "string" && this.permission.type) {
      meta.push(tr(this.t, "modals.permission.type", "Type: {value}", { value: this.permission.type }));
    }
    if (this.permission.pattern) {
      meta.push(tr(this.t, "modals.permission.pattern", "Pattern: {value}", {
        value: this.formatForDisplay(this.permission.pattern, 400),
      }));
    }
    if (meta.length) {
      contentEl.createEl("pre", { cls: "oc-perm-meta", text: meta.join("\n") });
    }

    const details = contentEl.createEl("details", { cls: "oc-perm-details" });
    details.createEl("summary", { text: tr(this.t, "modals.permission.metadata", "View full metadata") });
    details.createEl("pre", {
      text: this.formatForDisplay(this.permission.metadata || {}, 2400) || tr(this.t, "modals.empty", "(empty)"),
    });

    const actions = contentEl.createDiv({ cls: "oc-perm-actions" });
    const rejectBtn = actions.createEl("button", { cls: "mod-muted", text: tr(this.t, "modals.permission.reject", "Reject") });
    const onceBtn = actions.createEl("button", { cls: "mod-cta", text: tr(this.t, "modals.permission.once", "Allow Once") });
    const alwaysBtn = actions.createEl("button", { text: tr(this.t, "modals.permission.always", "Always Allow (Session)") });

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
  constructor(app, promptText, onSubmit, t) {
    super(app);
    this.promptText = String(promptText || "");
    this.onSubmit = onSubmit;
    this.t = t;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-prompt-modal");
    contentEl.createEl("h2", { text: tr(this.t, "modals.append.title", "Model Requested Additional Input") });
    contentEl.createDiv({
      cls: "oc-prompt-desc",
      text: tr(
        this.t,
        "modals.append.desc",
        "FLOWnote requested more input via question/tool. You can edit and insert into the input box.",
      ),
    });

    const input = contentEl.createEl("textarea", {
      cls: "oc-prompt-input",
      text: this.promptText,
    });

    const actions = contentEl.createDiv({ cls: "oc-prompt-actions" });
    const cancelBtn = actions.createEl("button", { cls: "mod-muted", text: tr(this.t, "modals.cancel", "Cancel") });
    const useBtn = actions.createEl("button", { cls: "mod-cta", text: tr(this.t, "modals.append.useInput", "Insert into Input") });

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

    const tFn = this.options && typeof this.options.t === "function" ? this.options.t : null;
    contentEl.createEl("h2", { text: tr(tFn, "modals.model.title", "Select Model") });
    contentEl.createDiv({
      cls: "oc-model-modal-subtitle",
      text: tr(tFn, "modals.model.subtitle", "Use official model list from FLOWnote provider configuration"),
    });

    const search = contentEl.createEl("input", {
      cls: "oc-model-search",
      attr: { type: "text", placeholder: tr(tFn, "modals.model.search", "Search provider/model...") },
    });
    search.addEventListener("input", () => {
      this.filterText = String(search.value || "").trim().toLowerCase();
      this.renderList();
    });

    const actions = contentEl.createDiv({ cls: "oc-model-modal-actions" });
    const refreshBtn = actions.createEl("button", { text: tr(tFn, "modals.model.refresh", "Refresh List") });
    refreshBtn.addEventListener("click", async () => {
      if (typeof this.options.onRefresh !== "function") return;
      refreshBtn.disabled = true;
      refreshBtn.setText(tr(tFn, "modals.model.refreshing", "Refreshing..."));
      try {
        const refreshed = await this.options.onRefresh();
        if (Array.isArray(refreshed)) this.options.models = refreshed;
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.setText(tr(tFn, "modals.model.refresh", "Refresh List"));
        this.renderList();
      }
    });

    const clearBtn = actions.createEl("button", { text: tr(tFn, "modals.model.resetDefault", "Reset Default") });
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
      const tFn = this.options && typeof this.options.t === "function" ? this.options.t : null;
      this.listEl.createDiv({ cls: "oc-model-empty", text: tr(tFn, "modals.model.notFound", "No matching models") });
      return;
    }

    filtered.forEach((model) => {
      const row = this.listEl.createDiv({ cls: "oc-model-item" });
      if (model === this.options.currentModel) row.addClass("is-active");
      row.createDiv({ cls: "oc-model-item-id", text: model });
      const tFn = this.options && typeof this.options.t === "function" ? this.options.t : null;
      row.createDiv({
        cls: "oc-model-item-meta",
        text: model === this.options.currentModel
          ? tr(tFn, "modals.model.current", "Current")
          : tr(tFn, "modals.model.clickToSwitch", "Click to switch"),
      });

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
