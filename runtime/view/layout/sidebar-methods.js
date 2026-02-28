const { Notice, setIcon } = require("obsidian");
const { tr } = require("./shared-utils");

function renderSidebar(side) {
  if (!side) return;
  side.empty();
  const sessions = this.plugin.sessionStore.state().sessions;
  const active = this.plugin.sessionStore.state().activeSessionId;

  const header = side.createDiv({ cls: "oc-history-header" });
  header.createSpan({ text: tr(this, "view.session.heading", "Sessions") });
  header.createSpan({
    cls: "oc-history-count",
    text: tr(this, "view.session.count", "{count} sessions", { count: sessions.length }),
  });

  const list = side.createDiv({ cls: "oc-history-list" });

  if (!sessions.length) {
    list.createDiv({ cls: "oc-history-empty", text: tr(this, "view.session.empty", "No sessions yet. Click \"+\" to start.") });
    return;
  }

  sessions.forEach((s) => {
    const displayTitle = this.sessionDisplayTitle(s);
    const item = list.createDiv({ cls: "oc-session-item", attr: { title: displayTitle } });
    if (s.id === active) item.addClass("is-active");
    item.addEventListener("click", async () => {
      if (item.hasClass("is-renaming")) return;
      this.closeHistoryMenu();
      this.plugin.sessionStore.setActiveSession(s.id);
      this.render();
      try {
        if (typeof this.plugin.ensureSessionMessagesLoaded === "function") {
          await this.plugin.ensureSessionMessagesLoaded(s.id, { force: false });
        }
      } catch (error) {
        this.plugin.log(
          `load session history failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.plugin.persistState();
      this.render();
    });

    const iconEl = item.createDiv({ cls: "oc-session-item-icon" });
    setIcon(iconEl, s.id === active ? "message-square-dot" : "message-square");

    const content = item.createDiv({ cls: "oc-session-item-content" });
    const titleEl = content.createDiv({ cls: "oc-session-title", text: displayTitle });
    titleEl.setAttr("title", displayTitle);

    if (s.lastUserPrompt) {
      content.createDiv({ cls: "oc-session-preview", text: s.lastUserPrompt, attr: { title: s.lastUserPrompt } });
    }

    content.createDiv({
      cls: "oc-session-meta",
      text: s.id === active
        ? tr(this, "view.session.currentShort", "Current session")
        : this.formatSessionMetaTime(s.updatedAt),
    });

    const actions = item.createDiv({ cls: "oc-session-item-actions" });

    const renameBtn = actions.createEl("button", { cls: "oc-session-item-action" });
    renameBtn.setAttr("type", "button");
    renameBtn.setAttr("aria-label", tr(this, "view.session.rename", "Rename session"));
    renameBtn.setAttr("title", tr(this, "view.session.rename", "Rename session"));
    setIcon(renameBtn, "pencil");
    renameBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (item.hasClass("is-renaming")) return;

      item.addClass("is-renaming");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "oc-session-rename-input";
      input.value = displayTitle;
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      const stop = (ev) => ev.stopPropagation();
      input.addEventListener("click", stop);
      input.addEventListener("mousedown", stop);

      let finished = false;
      const finishRename = async (commit) => {
        if (finished) return;
        finished = true;
        item.removeClass("is-renaming");

        if (!commit) {
          this.render();
          return;
        }

        const normalized = this.normalizeSessionTitle(input.value || "");
        if (!normalized) {
          new Notice(tr(this, "view.session.renameEmpty", "Session name cannot be empty"));
          this.render();
          return;
        }

        const renamed = this.plugin.sessionStore.renameSession(s.id, normalized);
        if (!renamed) {
          new Notice(tr(this, "view.session.renameMissing", "Session to rename was not found"));
          this.render();
          return;
        }

        await this.plugin.persistState();
        this.refreshHistoryMenu();
        this.refreshCurrentSessionContext();
      };

      input.addEventListener("blur", () => {
        void finishRename(true);
      }, { once: true });

      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.isComposing) {
          ev.preventDefault();
          input.blur();
          return;
        }
        if (ev.key === "Escape" && !ev.isComposing) {
          ev.preventDefault();
          void finishRename(false);
        }
      });
    });

    const deleteBtn = actions.createEl("button", { cls: "oc-session-item-action is-danger" });
    deleteBtn.setAttr("type", "button");
    deleteBtn.setAttr("aria-label", tr(this, "view.session.delete", "Delete session"));
    deleteBtn.setAttr("title", tr(this, "view.session.delete", "Delete session"));
    setIcon(deleteBtn, "trash-2");
    deleteBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const confirmed = window.confirm(tr(this, "view.session.deleteConfirm", "Delete session \"{title}\"?", { title: displayTitle }));
      if (!confirmed) return;
      const removed = typeof this.plugin.deleteSession === "function"
        ? await this.plugin.deleteSession(s.id)
        : this.plugin.sessionStore.removeSession(s.id);
      if (!removed) {
        new Notice(tr(this, "view.session.deleteFailed", "Delete failed: session not found"));
        return;
      }
      if (typeof this.plugin.deleteSession !== "function") {
        await this.plugin.persistState();
      }
      this.closeHistoryMenu();
      this.render();
    });
  });
}

function closeHistoryMenu() {
  const menu = this.elements && this.elements.historyMenu;
  if (!menu) return;
  menu.removeClass("visible");
}

function toggleHistoryMenu() {
  const menu = this.elements && this.elements.historyMenu;
  if (!menu) return;
  const isVisible = menu.hasClass("visible");
  if (isVisible) {
    menu.removeClass("visible");
    return;
  }
  this.refreshHistoryMenu();
  menu.addClass("visible");
}

function refreshHistoryMenu() {
  const menu = this.elements && this.elements.historyMenu;
  if (!menu) return;
  this.renderSidebar(menu);
}

function refreshCurrentSessionContext() {
  const labelEl = this.elements && this.elements.currentSessionLabel;
  if (!labelEl) return;
  labelEl.textContent = tr(this, "view.session.current", "Current session: {title}", { title: this.activeSessionLabel() });
}

const sidebarMethods = {
  renderSidebar,
  closeHistoryMenu,
  toggleHistoryMenu,
  refreshHistoryMenu,
  refreshCurrentSessionContext,
};

module.exports = { sidebarMethods };
