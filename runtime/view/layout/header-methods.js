const { Notice, setIcon } = require("obsidian");
const { tr } = require("./shared-utils");

function render() {
  this.clearInlineQuestionWidget(true);
  const container = this.contentEl || this.containerEl.children[1] || this.containerEl;
  container.empty();
  container.addClass("oc-root", "oc-surface");
  this.root = container;

  const shell = container.createDiv({ cls: "oc-shell" });
  const header = shell.createDiv({ cls: "oc-header" });
  this.renderHeader(header);

  const body = shell.createDiv({ cls: "oc-body" });
  const main = body.createDiv({ cls: "oc-main" });

  this.elements.body = body;
  this.elements.main = main;

  this.renderMain(main);
}

function renderHeader(header) {
  header.empty();

  const brand = header.createDiv({ cls: "oc-brand" });
  const logo = brand.createDiv({ cls: "oc-brand-logo" });
  setIcon(logo, "bot");
  brand.createDiv({ cls: "oc-brand-title", text: "FLOWnote" });

  const actions = header.createDiv({ cls: "oc-header-actions" });
  actions.createDiv({ cls: "oc-header-meta", text: tr(this, "view.header.runtime", "Chat Runtime") });

  const newBtn = this.buildIconButton(
    actions,
    "plus",
    tr(this, "view.session.new", "New session"),
    async () => {
      try {
        const session = await this.plugin.createSession("");
        this.plugin.sessionStore.setActiveSession(session.id);
        await this.plugin.persistState();
        this.closeHistoryMenu();
        this.render();
      } catch (e) {
        new Notice(e instanceof Error ? e.message : String(e));
      }
    },
    "oc-header-btn",
  );
  newBtn.setAttr("type", "button");

  const historyContainer = actions.createDiv({ cls: "oc-history-container" });
  const historyBtn = historyContainer.createEl("button", {
    cls: "oc-icon-btn oc-header-btn oc-history-toggle",
  });
  setIcon(historyBtn, "history");
  historyBtn.setAttr("type", "button");
  historyBtn.setAttr("aria-label", tr(this, "view.session.history", "Session history"));
  historyBtn.setAttr("title", tr(this, "view.session.history", "Session history"));

  const historyMenu = historyContainer.createDiv({ cls: "oc-history-menu" });
  historyMenu.addEventListener("click", (event) => event.stopPropagation());
  this.elements.historyMenu = historyMenu;

  historyBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    this.toggleHistoryMenu();
  });

  if (!this.historyMenuDocumentBound) {
    this.historyMenuDocumentBound = true;
    this.registerDomEvent(document, "click", () => this.closeHistoryMenu());
  }

  this.refreshHistoryMenu();
}

const headerMethods = {
  render,
  renderHeader,
};

module.exports = { headerMethods };
