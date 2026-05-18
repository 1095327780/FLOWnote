const { Modal: ObsidianModal } = require("obsidian");
const { interpolateTemplate } = require("./i18n-runtime");
const { describePermissionAction } = require("./permission-action-description");

const Modal = ObsidianModal || class {
  constructor(app) {
    this.app = app;
    this.contentEl = null;
  }

  open() {}
  close() {}
};

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
    const rawToolId = String(this.permission.type || "").trim();
    if (rawToolId) {
      const normalizedId = rawToolId.toLowerCase();
      const localized = tr(this.t, `view.tools.${normalizedId}`, rawToolId);
      const toolLabel = localized && localized !== `view.tools.${normalizedId}` ? localized : rawToolId;
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

// Modal: edit a skill's frontmatter fields + body. Used by the
// settings-tab Skill Management section. Resolves with the edited
// SkillDoc (or null on cancel). All state lives on the form inputs —
// no derived state — so cancel is a true no-op.
class SkillEditorModal extends Modal {
  constructor(app, options, onResolve, t) {
    super(app);
    this.options = options || {};
    this.onResolve = onResolve;
    this.t = t;
    this.resolved = false;
    this.initial = options.skill || null;
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
    contentEl.addClass("oc-skill-editor-modal");

    const isEdit = !!this.initial;
    contentEl.createEl("h2", {
      text: tr(this.t, isEdit ? "modals.skillEditor.titleEdit" : "modals.skillEditor.titleCreate",
        isEdit ? "编辑技能" : "新建技能"),
    });
    contentEl.createDiv({
      cls: "oc-skill-editor-subtitle",
      text: tr(this.t, "modals.skillEditor.subtitle",
        "此处只编辑技能根目录里的 SKILL.md；references、assets、scripts 等资源文件会保留在技能文件夹中，可通过设置页导入完整目录。"),
    });

    const slugInput = this._field(contentEl, {
      label: tr(this.t, "modals.skillEditor.slug", "技能 ID（文件夹名）"),
      hint: tr(this.t, "modals.skillEditor.slugHint",
        "只能小写字母、数字、连字符。一旦保存就是该技能的唯一身份，改 ID 等同于重命名。"),
      value: isEdit ? this.initial.slug : "",
      disabled: false,
    });
    const nameInput = this._field(contentEl, {
      label: tr(this.t, "modals.skillEditor.name", "技能名称"),
      hint: tr(this.t, "modals.skillEditor.nameHint", "显示给 AI 看的名字，可以是中文。"),
      value: isEdit ? this.initial.name : "",
    });
    const descInput = this._field(contentEl, {
      label: tr(this.t, "modals.skillEditor.description", "技能描述"),
      hint: tr(this.t, "modals.skillEditor.descriptionHint",
        "一两句话告诉 AI 这个技能干啥、什么时候用。AI 会在系统提示里看到这一段。"),
      value: isEdit ? this.initial.description : "",
      multiline: true,
      rows: 3,
    });
    const whenInput = this._field(contentEl, {
      label: tr(this.t, "modals.skillEditor.whenToUse", "触发场景（可选）"),
      hint: tr(this.t, "modals.skillEditor.whenToUseHint",
        "比 description 更具体的触发条件。比如「用户说『继续制卡』时」。"),
      value: isEdit && this.initial.whenToUse ? this.initial.whenToUse : "",
      multiline: true,
      rows: 2,
    });
    const toolsInput = this._field(contentEl, {
      label: tr(this.t, "modals.skillEditor.allowedTools", "允许使用的工具（可选）"),
      hint: tr(this.t, "modals.skillEditor.allowedToolsHint",
        "逗号分隔。留空表示不限制。例：vault_read, vault_write, vault_edit"),
      value: isEdit && Array.isArray(this.initial.allowedTools)
        ? this.initial.allowedTools.join(", ")
        : "",
    });
    const bodyLabel = contentEl.createDiv({ cls: "oc-skill-editor-field-label" });
    bodyLabel.setText(tr(this.t, "modals.skillEditor.body", "技能正文（Markdown）"));
    contentEl.createDiv({
      cls: "oc-skill-editor-field-hint",
      text: tr(this.t, "modals.skillEditor.bodyHint",
        "AI 调用这个技能时会读到这部分。写清楚工作流、参数、注意事项。"),
    });
    const bodyArea = contentEl.createEl("textarea", { cls: "oc-skill-editor-body" });
    bodyArea.rows = 16;
    bodyArea.value = isEdit ? this.initial.body : "";

    const actions = contentEl.createDiv({ cls: "oc-skill-editor-actions" });
    const cancelBtn = actions.createEl("button", { cls: "mod-muted", text: tr(this.t, "modals.cancel", "取消") });
    const saveBtn = actions.createEl("button", { cls: "mod-cta", text: tr(this.t, "modals.skillEditor.save", "保存") });

    cancelBtn.addEventListener("click", () => this.resolveAndClose(null));
    saveBtn.addEventListener("click", () => {
      const slug = String(slugInput.value || "").trim();
      const name = String(nameInput.value || "").trim();
      const description = String(descInput.value || "").trim();
      const whenToUse = String(whenInput.value || "").trim();
      const toolsRaw = String(toolsInput.value || "").trim();
      const body = String(bodyArea.value || "");
      const allowedTools = toolsRaw
        ? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      this.resolveAndClose({
        slug,
        name,
        description,
        whenToUse: whenToUse || undefined,
        allowedTools,
        body,
      });
    });
  }

  _field(container, { label, hint, value, multiline, rows, disabled }) {
    const lab = container.createDiv({ cls: "oc-skill-editor-field-label" });
    lab.setText(label);
    if (hint) {
      container.createDiv({ cls: "oc-skill-editor-field-hint", text: hint });
    }
    let input;
    if (multiline) {
      input = container.createEl("textarea", { cls: "oc-skill-editor-input" });
      input.rows = rows || 3;
    } else {
      input = container.createEl("input", { cls: "oc-skill-editor-input", attr: { type: "text" } });
    }
    if (disabled) input.disabled = true;
    input.value = value || "";
    return input;
  }

  onClose() {
    if (!this.resolved && typeof this.onResolve === "function") {
      this.onResolve(null);
      this.resolved = true;
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

class TemplateEditorModal extends Modal {
  constructor(app, payload, onResolve, t) {
    super(app);
    this.payload = payload || {};
    this.onResolve = onResolve;
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
    contentEl.addClass("oc-template-editor-modal");

    contentEl.createEl("h2", {
      text: tr(this.t, "modals.templateEditor.title", "编辑模板：{name}", {
        name: this.payload.name || this.payload.id || "",
      }),
    });

    const subtitle = contentEl.createDiv({ cls: "oc-template-editor-subtitle" });
    subtitle.setText(tr(this.t, "modals.templateEditor.subtitle",
      "模板路径：{path}", { path: this.payload.userPath || "" }));

    if (this.payload.source === "bundled") {
      contentEl.createDiv({
        cls: "oc-template-editor-hint",
        text: tr(this.t, "modals.templateEditor.hintFromBundled",
          "当前显示的是插件内置默认。保存后会写入到 {path}，之后由你掌控。",
          { path: this.payload.userPath || "" }),
      });
    }

    const bodyArea = contentEl.createEl("textarea", { cls: "oc-template-editor-body" });
    bodyArea.rows = 22;
    bodyArea.value = String(this.payload.content || "");

    const actions = contentEl.createDiv({ cls: "oc-template-editor-actions" });
    const cancelBtn = actions.createEl("button", {
      cls: "mod-muted",
      text: tr(this.t, "modals.cancel", "取消"),
    });
    const saveBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: tr(this.t, "modals.templateEditor.save", "保存"),
    });

    cancelBtn.addEventListener("click", () => this.resolveAndClose(null));
    saveBtn.addEventListener("click", () => {
      this.resolveAndClose(String(bodyArea.value || ""));
    });
  }

  onClose() {
    if (!this.resolved && typeof this.onResolve === "function") {
      this.onResolve(null);
      this.resolved = true;
    }
    this.contentEl.empty();
  }
}

class AgentModeNoticeModal extends Modal {
  constructor(app, options = {}, onResolve, t) {
    super(app);
    this.options = options || {};
    this.onResolve = onResolve;
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
    if (!contentEl) return;
    contentEl.empty();
    contentEl.addClass("oc-release-modal");

    const isUpdate = this.options.kind === "update";
    const currentMode = this.options.currentMode === "opencode-legacy" ? "opencode-legacy" : "direct";
    contentEl.createEl("h2", {
      text: tr(this.t, "modals.agentModeNotice.title", "FLOWnote AI 运行方式"),
    });
    contentEl.createDiv({
      cls: "oc-release-subtitle",
      text: isUpdate && currentMode === "opencode-legacy"
        ? tr(
          this.t,
          "modals.agentModeNotice.updateIntro",
          "这次更新不会改变你原来的工作流。为了避免升级后中断，已保留 OpenCode 桥接模式；你也可以随时切换到内置 AI 模式。",
        )
        : isUpdate
          ? tr(
            this.t,
            "modals.agentModeNotice.updateIntroPreserveChoice",
            "这次更新不会主动覆盖你已经选择的运行方式。你可以随时在内置 AI 模式和 OpenCode 桥接模式之间切换。",
          )
        : tr(
          this.t,
          "modals.agentModeNotice.firstIntro",
          "首次安装已默认使用内置 AI 模式。你可以在设置中随时切换运行方式。",
        ),
    });

    const cards = contentEl.createDiv({ cls: "oc-release-mode-grid" });
    this.renderModeCard(cards, {
      title: tr(this.t, "modals.agentModeNotice.directTitle", "内置 AI 模式"),
      badge: tr(this.t, "modals.agentModeNotice.directBadge", "推荐新用户 / 移动端"),
      items: [
        tr(this.t, "modals.agentModeNotice.directApiKey", "在插件里配置自己的 API Key，直接调用模型服务。"),
        tr(this.t, "modals.agentModeNotice.directMobile", "桌面端和手机端都能使用智能对话与技能流程。"),
        tr(this.t, "modals.agentModeNotice.directNoExternal", "不依赖 OpenCode、终端或本机额外环境。"),
      ],
    });
    this.renderModeCard(cards, {
      title: tr(this.t, "modals.agentModeNotice.opencTitle", "OpenCode 桥接模式"),
      badge: tr(this.t, "modals.agentModeNotice.opencBadge", "兼容旧用户 / 高级"),
      items: [
        tr(this.t, "modals.agentModeNotice.opencFreeModels", "继续通过本机 OpenCode 调用模型，适合已有 OpenCode 配置的用户。"),
        tr(this.t, "modals.agentModeNotice.opencModels", "如果你想使用 OpenCode 提供的免费或实验模型，可以选择它。"),
        tr(this.t, "modals.agentModeNotice.opencSetup", "配置更复杂，主要适合桌面端，需要本机环境可用。"),
      ],
    });

    contentEl.createDiv({
      cls: "oc-release-switch-hint",
      text: tr(
        this.t,
        "modals.agentModeNotice.switchHint",
        "切换位置：设置 → FLOWnote → AI 服务 → 运行方式。",
      ),
    });

    const actions = contentEl.createDiv({ cls: "oc-release-actions" });
    const settingsBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: tr(this.t, "modals.agentModeNotice.openSettings", "去设置"),
    });
    const okBtn = actions.createEl("button", {
      cls: "mod-muted",
      text: tr(this.t, "modals.agentModeNotice.ok", "知道了"),
    });
    settingsBtn.addEventListener("click", () => this.resolveAndClose("settings"));
    okBtn.addEventListener("click", () => this.resolveAndClose("ok"));
  }

  renderModeCard(parent, payload) {
    const card = parent.createDiv({ cls: "oc-release-mode-card" });
    const header = card.createDiv({ cls: "oc-release-mode-header" });
    header.createDiv({ cls: "oc-release-mode-title", text: payload.title });
    header.createDiv({ cls: "oc-release-mode-badge", text: payload.badge });
    const list = card.createEl("ul");
    for (const item of payload.items || []) {
      list.createEl("li", { text: item });
    }
  }

  onClose() {
    if (!this.resolved && typeof this.onResolve === "function") {
      this.resolved = true;
      this.onResolve("dismissed");
    }
    if (this.contentEl) this.contentEl.empty();
  }
}

module.exports = {
  AgentModeNoticeModal,
  AskUserQuestionModal,
  // Re-exported for back-compat — actual impl lives in
  // ./permission-action-description.js so it can be unit-tested without
  // an Obsidian shim.
  describePermissionAction,
  DiagnosticsModal,
  ModelSelectorModal,
  PermissionRequestModal,
  PromptAppendModal,
  SkillEditorModal,
  TemplateEditorModal,
};
