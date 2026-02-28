const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadMobilePluginFixture() {
  const originalLoad = Module._load;
  const noticeMessages = [];

  class PluginMock {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this._commands = [];
      this._tabs = [];
      this._ribbons = [];
    }

    addRibbonIcon(icon, title, callback) {
      this._ribbons.push({ icon, title, callback });
    }

    addCommand(command) {
      this._commands.push(command);
    }

    addSettingTab(tab) {
      this._tabs.push(tab);
    }

    async loadData() {
      return {};
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

    assert.equal(plugin.__mobileMethodsLoaded, true);
    assert.equal(typeof plugin.onloadMobile, "function");
    assert.equal(typeof plugin.openCaptureModal, "function");
    assert.equal(typeof plugin.loadMobilePersistedData, "function");
    assert.equal(plugin._commands.some((cmd) => cmd && cmd.id === "mobile-quick-capture"), true);
    assert.equal(plugin._tabs.length, 1);
    assert.equal(plugin._ribbons.length, 1);
    assert.equal(fixture.noticeMessages.length, 0);
  } finally {
    fixture.restore();
  }
});
