const { Modal } = require("obsidian");
const { interpolateTemplate } = require("./i18n-runtime");
const { describePermissionAction } = require("./permission-action-description");

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

    // Header — short, plain-language framing. NO "FLOWnote Permission Request"
    // jargon. The user is being asked one question: do you want to allow this?
    contentEl.createEl("h2", {
      text: tr(this.t, "modals.permission.title", "AI 想做一个改动"),
    });
    contentEl.createDiv({
      cls: "oc-perm-subtitle",
      text: tr(
        this.t,
        "modals.permission.subtitle",
        "AI 助手即将改动你的笔记。确认一下你是否同意：",
      ),
    });

    // Main action sentence — built per-tool, in user language.
    const action = describePermissionAction(this.permission, this.t);
    contentEl.createDiv({ cls: "oc-perm-action", text: action });

    // Technical details collapsed by default — for power users / debugging.
    const details = contentEl.createEl("details", { cls: "oc-perm-details" });
    details.createEl("summary", {
      text: tr(this.t, "modals.permission.detailsToggle", "技术细节（一般不用看）"),
    });
    const toolLabel = String(this.permission.type || "");
    if (toolLabel) {
      details.createDiv({
        cls: "oc-perm-detail-row",
        text: tr(this.t, "modals.permission.tool", "工具：{value}", { value: toolLabel }),
      });
    }
    details.createEl("pre", {
      text: this.formatForDisplay(this.permission.metadata || {}, 2400) ||
        tr(this.t, "modals.empty", "(空)"),
    });

    // Buttons — plain language, no "(Session)" jargon.
    const actions = contentEl.createDiv({ cls: "oc-perm-actions" });
    const rejectBtn = actions.createEl("button", {
      cls: "mod-muted",
      text: tr(this.t, "modals.permission.reject", "拒绝"),
    });
    const onceBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: tr(this.t, "modals.permission.once", "本次允许"),
    });
    const alwaysBtn = actions.createEl("button", {
      text: tr(this.t, "modals.permission.always", "本次会话内一直允许"),
    });

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

class AskUserQuestionModal extends Modal {
  constructor(app, payload, onResolve, t) {
    super(app);
    this.payload = payload || { questions: [] };
    this.onResolve = onResolve;
    this.t = t;
    this.resolved = false;
    // Per-question state: { selectedLabels: Set<string>, otherText: string }
    this.state = (this.payload.questions || []).map(() => ({
      selectedLabels: new Set(),
      otherText: "",
      otherChecked: false,
    }));
  }

  resolveAndClose(answers) {
    if (this.resolved) return;
    this.resolved = true;
    if (typeof this.onResolve === "function") this.onResolve(answers);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-ask-modal");
    contentEl.createEl("h2", { text: tr(this.t, "modals.ask.title", "FLOWnote 想问你") });

    const questions = Array.isArray(this.payload.questions) ? this.payload.questions : [];
    questions.forEach((q, qIdx) => {
      const block = contentEl.createDiv({ cls: "oc-ask-question" });
      block.createEl("h3", { text: q.question || "" });
      if (q.header) {
        block.createDiv({ cls: "oc-ask-header", text: `[${q.header}]` });
      }
      const opts = Array.isArray(q.options) ? q.options : [];
      const isMulti = !!q.multiSelect;
      const inputType = isMulti ? "checkbox" : "radio";
      const groupName = `oc-ask-q-${qIdx}`;

      opts.forEach((opt) => {
        const row = block.createDiv({ cls: "oc-ask-option" });
        const labelEl = row.createEl("label");
        const input = labelEl.createEl("input", { attr: { type: inputType, name: groupName } });
        labelEl.createSpan({ cls: "oc-ask-option-label", text: opt.label || "" });
        if (opt.description) {
          row.createDiv({ cls: "oc-ask-option-desc", text: opt.description });
        }
        input.addEventListener("change", () => {
          const st = this.state[qIdx];
          if (isMulti) {
            if (input.checked) st.selectedLabels.add(opt.label);
            else st.selectedLabels.delete(opt.label);
          } else {
            st.selectedLabels.clear();
            if (input.checked) st.selectedLabels.add(opt.label);
          }
        });
      });

      // "Other" — free-text fallback.
      const otherRow = block.createDiv({ cls: "oc-ask-option oc-ask-other" });
      const otherLabel = otherRow.createEl("label");
      const otherInput = otherLabel.createEl("input", {
        attr: { type: inputType, name: groupName },
      });
      otherLabel.createSpan({ cls: "oc-ask-option-label", text: tr(this.t, "modals.ask.other", "其它（自己写）") });
      const textInput = otherRow.createEl("textarea", {
        cls: "oc-ask-other-text",
        attr: { placeholder: tr(this.t, "modals.ask.otherPlaceholder", "在这里写你的回答…") },
      });
      otherInput.addEventListener("change", () => {
        const st = this.state[qIdx];
        st.otherChecked = otherInput.checked;
        if (!isMulti && otherInput.checked) {
          st.selectedLabels.clear();
        }
      });
      textInput.addEventListener("input", () => {
        this.state[qIdx].otherText = String(textInput.value || "");
      });
    });

    const actions = contentEl.createDiv({ cls: "oc-ask-actions" });
    const cancelBtn = actions.createEl("button", {
      cls: "mod-muted",
      text: tr(this.t, "modals.ask.dismiss", "跳过"),
    });
    const okBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: tr(this.t, "modals.ask.submit", "提交"),
    });
    cancelBtn.addEventListener("click", () => this.resolveAndClose({ dismissed: true }));
    okBtn.addEventListener("click", () => {
      const answers = {};
      questions.forEach((q, qIdx) => {
        const st = this.state[qIdx];
        const isMulti = !!q.multiSelect;
        const picked = Array.from(st.selectedLabels);
        if (st.otherChecked && st.otherText.trim()) picked.push(st.otherText.trim());
        if (isMulti) {
          answers[q.question] = picked;
        } else {
          answers[q.question] = picked[0] || "";
        }
      });
      this.resolveAndClose({ answers });
    });
  }

  onClose() {
    if (!this.resolved && typeof this.onResolve === "function") {
      this.onResolve({ dismissed: true });
      this.resolved = true;
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
  AskUserQuestionModal,
  // Re-exported for back-compat — actual impl lives in
  // ./permission-action-description.js so it can be unit-tested without
  // an Obsidian shim.
  describePermissionAction,
  DiagnosticsModal,
  ModelSelectorModal,
  PermissionRequestModal,
  PromptAppendModal,
};
