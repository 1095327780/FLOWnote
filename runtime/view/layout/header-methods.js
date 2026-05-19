const { Notice, setIcon, Platform = {} } = require("obsidian");
const { tr } = require("./shared-utils");
const FLOWNOTE_ICON_ID = "flownote-journal-glow";

function render() {
  if (typeof this.saveHomeScrollPosition === "function") {
    this.saveHomeScrollPosition();
  }
  this.clearInlineQuestionWidget(true);
  this.activePanel = this.activePanel === "chat" ? "chat" : "home";
  const container = this.contentEl || this.containerEl.children[1] || this.containerEl;
  container.empty();
  container.addClass("oc-root", "oc-surface");
  container.toggleClass("is-home-panel", this.activePanel === "home");
  container.toggleClass("is-chat-panel", this.activePanel === "chat");
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
  setIcon(logo, FLOWNOTE_ICON_ID);
  brand.createDiv({ cls: "oc-brand-title", text: "FLOWnote" });
  if (!(Platform && Platform.isMobile) && typeof this.renderConnectionStatus === "function") {
    const brandStatus = brand.createDiv({ cls: "oc-brand-status" });
    this.renderConnectionStatus(brandStatus);
  }

  const panelSwitch = header.createDiv({ cls: "oc-panel-switch", attr: { role: "tablist", "aria-label": "FLOWnote panel" } });
  const renderPanelButton = (panel, iconName, label) => {
    const isActive = this.activePanel === panel;
    const tab = panelSwitch.createEl("button", { cls: `oc-panel-switch-btn ${isActive ? "is-active" : ""}`.trim() });
    tab.setAttr("type", "button");
    tab.setAttr("role", "tab");
    tab.setAttr("aria-selected", isActive ? "true" : "false");
    tab.setAttr("aria-label", label);
    tab.setAttr("title", label);
    try {
      setIcon(tab, iconName);
    } catch {
    }
    tab.createSpan({ cls: "oc-header-tab-label", text: label });
    tab.addEventListener("click", () => {
      if (this.activePanel === panel) return;
      this.activePanel = panel;
      this.render();
    });
  };
  renderPanelButton("home", "layout-dashboard", "首页");
  renderPanelButton("chat", "message-square", "聊天");

  const actions = header.createDiv({ cls: "oc-header-actions" });
  actions.createDiv({
    cls: "oc-header-meta",
    text: this.activePanel === "home" ? "Dashboard" : tr(this, "view.header.runtime", "Chat Runtime"),
  });

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

  const settingsBtn = this.buildIconButton(
    actions,
    "settings",
    tr(this, "view.settings", "Settings"),
    () => {
      if (typeof this.openSettings === "function") this.openSettings();
    },
    "oc-header-btn",
  );
  settingsBtn.setAttr("type", "button");

  this.refreshHistoryMenu();
}

const headerMethods = {
  render,
  renderHeader,
};

module.exports = { headerMethods };
