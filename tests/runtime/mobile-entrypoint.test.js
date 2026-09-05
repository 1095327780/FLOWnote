const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadMobilePluginFixture(options = {}) {
  const originalLoad = Module._load;
  const noticeMessages = [];
  const persistedData = options.persistedData || {};

  class PluginMock {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this._commands = [];
      this._tabs = [];
      this._ribbons = [];
      this._views = [];
      this._protocols = [];
    }

    addRibbonIcon(icon, title, callback) {
      this._ribbons.push({ icon, title, callback });
    }

    registerView(type, factory) {
      this._views.push({ type, factory });
    }

    registerObsidianProtocolHandler(action, handler) {
      this._protocols.push({ action, handler });
    }

    addCommand(command) {
      this._commands.push(command);
    }

    addSettingTab(tab) {
      this._tabs.push(tab);
    }

    async loadData() {
      return persistedData;
    }

    async saveData() {}
  }

  class NoticeMock {
    constructor(message) {
      noticeMessages.push(String(message || ""));
    }
  }

  class ModalMock {
    constructor(app) {
      this.app = app;
      this.contentEl = {
        addClass() {},
        createEl() {
          return {
            addEventListener() {},
            setAttr() {},
            createEl() { return this; },
            createDiv() { return this; },
            toggleClass() {},
            style: { setProperty() {}, removeProperty() {} },
            empty() {},
            closest() { return null; },
          };
        },
        empty() {},
      };
    }

    open() {}
    close() {}
  }

  class PluginSettingTabMock {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = {
        empty() {},
        createEl() {
          return {
            createEl() { return this; },
            createDiv() { return this; },
            setAttr() {},
          };
        },
      };
    }
  }

  class SettingMock {
    constructor() {}
    setName() { return this; }
    setDesc() { return this; }
    addDropdown(cb) {
      cb({ addOption() { return this; }, setValue() { return this; }, onChange() { return this; } });
      return this;
    }
    addText(cb) {
      cb({
        inputEl: { type: "", style: {} },
        setPlaceholder() { return this; },
        setValue() { return this; },
        onChange() { return this; },
      });
      return this;
    }
    addToggle(cb) {
      cb({ setValue() { return this; }, onChange() { return this; } });
      return this;
    }
    addButton(cb) {
      cb({ setButtonText() { return this; }, setDisabled() { return this; }, onClick() { return this; } });
      return this;
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Plugin: PluginMock,
        Notice: NoticeMock,
        Modal: ModalMock,
        PluginSettingTab: PluginSettingTabMock,
        Setting: SettingMock,
        Platform: { isMobile: true },
        normalizePath(pathValue) { return String(pathValue || ""); },
        requestUrl: async () => ({ status: 500, text: "", json: null }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const mainPath = require.resolve("../../main.js");
  delete require.cache[mainPath];
  const PluginClass = require(mainPath);

  return {
    PluginClass,
    noticeMessages,
    restore() {
      Module._load = originalLoad;
      delete require.cache[mainPath];
    },
  };
}

test("mobile onload should use mixin entrypoint and register mobile surfaces", async () => {
  const fixture = loadMobilePluginFixture();
  try {
    const templaterDataPath = ".obsidian/plugins/templater-obsidian/data.json";
    let templaterData = JSON.stringify({
      user_scripts_folder: "Meta/Scripts",
    });
    const app = {
      vault: {
        adapter: {
          basePath: "/tmp/vault",
          async exists(path) {
            return path === templaterDataPath;
          },
          async read(path) {
            if (path !== templaterDataPath) throw new Error(`missing: ${path}`);
            return templaterData;
          },
          async write(path, data) {
            if (path !== templaterDataPath) throw new Error(`unexpected write: ${path}`);
            templaterData = data;
          },
          async list() {
            return { files: [], folders: [] };
          },
        },
        configDir: ".obsidian",
      },
      workspace: {
        detachLeavesOfType() {},
      },
    };
    const manifest = {
      id: "flownote",
      dir: process.cwd(),
      version: "0.0.0-test",
    };

    const plugin = new fixture.PluginClass(app, manifest);
    await plugin.onload();

    assert.equal(plugin.__mobileMethodsLoaded, true);
    assert.equal(typeof plugin.onloadMobile, "function");
    assert.equal(typeof plugin.openCaptureModal, "function");
    assert.equal(typeof plugin.loadMobilePersistedData, "function");
    // Stage 1 (capture-only) MUST always register. The fixture's mocked
    // `obsidian` lacks ItemView etc., so Stage 2 (full assistant) fails
    // harmlessly, but the capture ribbon + command and a fallback
    // settings tab (MobileSettingsTab) stay alive — that's the contract
    // mobile users depend on after the desktop unification.
    assert.equal(plugin._commands.some((cmd) => cmd && cmd.id === "mobile-quick-capture"), true);
    const quickCaptureCommand = plugin._commands.find((cmd) => cmd && cmd.id === "mobile-quick-capture");
    const assistantCommand = plugin._commands.find((cmd) => cmd && cmd.id === "flownote-open-assistant");
    assert.equal(quickCaptureCommand.icon, "sparkles");
    assert.equal(assistantCommand.icon, "message-square");
    assert.equal(typeof assistantCommand.callback, "function");
    assert.deepEqual(plugin._protocols.map((entry) => entry.action).sort(), [
      "flownote-capture",
      "flownote-chat",
      "flownote-new-session",
      "flownote-open",
    ]);
    assert.equal(plugin._ribbons.length >= 1, true);
    assert.equal(plugin._tabs.length, 1, "fallback settings tab must register when Stage 2 fails");
    assert.equal(fixture.noticeMessages.length, 0);
    assert.equal(
      JSON.parse(templaterData).user_scripts_folder,
      "",
      "legacy Templater config must be repaired before mobile Stage 2 can fail",
    );
  } finally {
    fixture.restore();
  }
});

test("mobile onload should register commands using persisted English after restart", async () => {
  const fixture = loadMobilePluginFixture({
    persistedData: {
      settings: {
        uiLanguage: "en",
        mobileCapture: {},
      },
    },
  });
  try {
    const app = {
      vault: {
        adapter: { basePath: "/tmp/vault" },
        configDir: ".obsidian",
      },
      workspace: {
        detachLeavesOfType() {},
      },
    };
    const manifest = {
      id: "flownote",
      dir: process.cwd(),
      version: "0.0.0-test",
    };

    const plugin = new fixture.PluginClass(app, manifest);
    await plugin.onload();

    const quickCaptureCommand = plugin._commands.find((cmd) => cmd && cmd.id === "mobile-quick-capture");
    const assistantCommand = plugin._commands.find((cmd) => cmd && cmd.id === "flownote-open-assistant");
    assert.equal(quickCaptureCommand.name, "Quick Idea Capture");
    assert.equal(assistantCommand.name, "FLOWnote Assistant");
    assert.equal(plugin._ribbons.some((entry) => entry.title === "Quick Idea Capture"), true);
    assert.equal(plugin._ribbons.some((entry) => entry.title === "FLOWnote Assistant"), true);
  } finally {
    fixture.restore();
  }
});

test("mobile full runtime commands should expose toolbar icons and open chat after new session", async () => {
  const fixture = loadMobilePluginFixture();
  try {
    let activateViewCalls = 0;
    let renderCalls = 0;
    let activeSessionId = "";
    const app = {
      vault: {
        adapter: { basePath: "/tmp/vault" },
        configDir: ".obsidian",
      },
      workspace: {
        detachLeavesOfType() {},
      },
    };
    const manifest = {
      id: "flownote",
      dir: process.cwd(),
      version: "0.0.0-test",
    };

    const plugin = new fixture.PluginClass(app, manifest);
    await plugin.onload();
    plugin.settings = { skillsDir: "skills", uiLanguage: "zh-CN" };
    plugin.ensureRuntimeModules = () => ({
      migrateSkillDir: async () => null,
      SessionStore: class {
        setActiveSession(id) {
          activeSessionId = id;
        }
      },
      FLOWnoteAssistantView: class {
        constructor() {}
      },
      FLOWnoteSettingsTab: class {
        constructor() {}
      },
    });
    plugin.getEffectiveLocale = () => "zh-CN";
    plugin.getViewType = () => "flownote-view";
    plugin.createSession = async () => ({ id: "session-1" });
    plugin.persistState = async () => {};
    plugin.activateView = async () => { activateViewCalls += 1; };
    plugin.getAssistantView = () => ({ render: () => { renderCalls += 1; } });

    await plugin.bootstrapMobileFullRuntime();

    const sendSelectedCommand = plugin._commands.find((cmd) => cmd && cmd.id === "flownote-send-selected-text");
    const newSessionCommand = plugin._commands.find((cmd) => cmd && cmd.id === "flownote-new-session");
    assert.equal(sendSelectedCommand.icon, "arrow-up");
    assert.equal(newSessionCommand.icon, "plus");

    await newSessionCommand.callback();

    assert.equal(activeSessionId, "session-1");
    assert.equal(activateViewCalls, 1);
    assert.equal(renderCalls, 1);
  } finally {
    fixture.restore();
  }
});
