const { Modal } = require("obsidian");

class InputPromptModal extends Modal {
  constructor(app, options, onResolve) {
    super(app);
    this.options = options || {};
    this.onResolve = typeof onResolve === "function" ? onResolve : () => {};
    this.resolved = false;
  }

  resolve(value) {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(value);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: String(this.options.title || "Input") });
    if (this.options.description) contentEl.createEl("p", { text: String(this.options.description) });

    const input = contentEl.createEl("input", {
      attr: {
        type: this.options.password ? "password" : "text",
        placeholder: String(this.options.placeholder || ""),
      },
    });
    input.style.width = "100%";
    input.value = String(this.options.value || "");

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";
    actions.style.marginTop = "12px";

    const cancelBtn = actions.createEl("button", { text: String(this.options.cancelText || "Cancel") });
    const submitBtn = actions.createEl("button", { text: String(this.options.submitText || "Confirm"), cls: "mod-cta" });

    cancelBtn.addEventListener("click", () => this.resolve(null));
    submitBtn.addEventListener("click", () => this.resolve(String(input.value || "")));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.resolve(String(input.value || ""));
      }
    });

    setTimeout(() => input.focus(), 0);
  }

  onClose() {
    if (!this.resolved) this.onResolve(null);
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(app, options, onResolve) {
    super(app);
    this.options = options || {};
    this.onResolve = typeof onResolve === "function" ? onResolve : () => {};
    this.resolved = false;
  }

  resolve(value) {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(Boolean(value));
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: String(this.options.title || "Confirm Action") });
    if (this.options.description) contentEl.createEl("p", { text: String(this.options.description) });

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";
    actions.style.marginTop = "12px";

    const cancelBtn = actions.createEl("button", { text: String(this.options.cancelText || "Cancel") });
    const submitBtn = actions.createEl("button", { text: String(this.options.submitText || "Confirm"), cls: "mod-cta" });
    cancelBtn.addEventListener("click", () => this.resolve(false));
    submitBtn.addEventListener("click", () => this.resolve(true));
  }

  onClose() {
    if (!this.resolved) this.onResolve(false);
    this.contentEl.empty();
  }
}

class SelectPromptModal extends Modal {
  constructor(app, options, onResolve) {
    super(app);
    this.options = options || {};
    this.onResolve = typeof onResolve === "function" ? onResolve : () => {};
    this.resolved = false;
  }

  resolve(value) {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(value);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    const options = Array.isArray(this.options.options) ? this.options.options : [];

    contentEl.empty();
    contentEl.createEl("h2", { text: String(this.options.title || "Select") });
    if (this.options.description) contentEl.createEl("p", { text: String(this.options.description) });

    const select = contentEl.createEl("select");
    select.style.width = "100%";
    select.style.marginTop = "8px";
    options.forEach((item) => {
      select.createEl("option", {
        value: String(item.value),
        text: String(item.label || item.value),
      });
    });
    if (this.options.defaultValue !== undefined && this.options.defaultValue !== null) {
      select.value = String(this.options.defaultValue);
    }

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";
    actions.style.marginTop = "12px";

    const cancelBtn = actions.createEl("button", { text: String(this.options.cancelText || "Cancel") });
    const submitBtn = actions.createEl("button", { text: String(this.options.submitText || "Confirm"), cls: "mod-cta" });
    cancelBtn.addEventListener("click", () => this.resolve(null));
    submitBtn.addEventListener("click", () => this.resolve(String(select.value || "")));
    select.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.resolve(String(select.value || ""));
      }
    });
  }

  onClose() {
    if (!this.resolved) this.onResolve(null);
    this.contentEl.empty();
  }
}

class ConflictResolutionModal extends Modal {
  constructor(app, options, onResolve) {
    super(app);
    this.options = options || {};
    this.onResolve = typeof onResolve === "function" ? onResolve : () => {};
    this.resolved = false;
  }

  resolve(value) {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(String(value || "cancel"));
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: String(this.options.title || "Resolve Conflict") });
    if (this.options.description) contentEl.createEl("p", { text: String(this.options.description) });
    if (this.options.context) {
      const pre = contentEl.createEl("pre", { text: String(this.options.context) });
      pre.style.whiteSpace = "pre-wrap";
      pre.style.wordBreak = "break-all";
      pre.style.maxHeight = "240px";
      pre.style.overflow = "auto";
    }

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";
    actions.style.marginTop = "12px";

    const skipBtn = actions.createEl("button", { text: String(this.options.skipText || "Skip") });
    const skipAllBtn = actions.createEl("button", { text: String(this.options.skipAllText || "Skip All") });
    const replaceBtn = actions.createEl("button", { text: String(this.options.replaceText || "Replace"), cls: "mod-cta" });
    const replaceAllBtn = actions.createEl("button", { text: String(this.options.replaceAllText || "Replace All") });
    const cancelBtn = actions.createEl("button", { text: String(this.options.cancelText || "Cancel") });

    skipBtn.addEventListener("click", () => this.resolve("skip"));
    skipAllBtn.addEventListener("click", () => this.resolve("skip_all"));
    replaceBtn.addEventListener("click", () => this.resolve("replace"));
    replaceAllBtn.addEventListener("click", () => this.resolve("replace_all"));
    cancelBtn.addEventListener("click", () => this.resolve("cancel"));
  }

  onClose() {
    if (!this.resolved) this.onResolve("cancel");
    this.contentEl.empty();
  }
}

module.exports = {
  InputPromptModal,
  ConfirmModal,
  SelectPromptModal,
  ConflictResolutionModal,
};
