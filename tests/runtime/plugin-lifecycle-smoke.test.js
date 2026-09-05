const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadPluginWithMockObsidian() {
  const originalLoad = Module._load;
  const noticeMessages = [];

  class PluginMock {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this._views = [];
      this._commands = [];
      this._tabs = [];
    }

    registerView(type, factory) {
      this._views.push({ type, factory });
    }

    addRibbonIcon() {}

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

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Plugin: PluginMock,
        Notice: NoticeMock,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const mainModulePath = require.resolve("../../main.js");
  delete require.cache[mainModulePath];
  const PluginClass = require(mainModulePath);

  return {
    PluginClass,
    noticeMessages,
    restore() {
      Module._load = originalLoad;
      delete require.cache[mainModulePath];
    },
  };
}

test("plugin onload/onunload should work in minimal mocked environment", async () => {
  const fixture = loadPluginWithMockObsidian();
  try {
    let detachType = "";
    let clientStopped = 0;
    let bootstrapCalls = 0;
    let diagnosticsRefreshCalls = 0;
    let layoutReadyCallback = null;
    const templaterDataPath = ".obsidian/plugins/templater-obsidian/data.json";
    let templaterData = JSON.stringify({
      user_scripts_folder: "Meta/Scripts",
      trigger_on_file_creation: true,
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
        detachLeavesOfType(type) {
          detachType = String(type || "");
        },
        onLayoutReady(callback) {
          layoutReadyCallback = callback;
        },
      },
    };
    const manifest = {
      id: "flownote",
      dir: process.cwd(),
      version: "0.3.21",
    };

    const plugin = new fixture.PluginClass(app, manifest);
    plugin.ensureFacadeMethodsLoaded = () => {};
    plugin.getViewType = () => "flownote-view";
    plugin.ensureRuntimeModules = () => ({
      SessionStore: class {
        constructor() {}
        recoverInterruptedExecutions() { return 0; }
      },
      SkillService: class {
        constructor() {}
      },
      FLOWnoteClient: class {
        constructor() {}
        async stop() {
          clientStopped += 1;
        }
      },
      DiagnosticsService: class {
        constructor() {}
      },
      FLOWnoteAssistantView: class {
        constructor() {}
      },
      FLOWnoteSettingsTab: class {
        constructor() {}
      },
      SdkTransport: class {},
      ExecutableResolver: class {},
    });
    plugin.loadPersistedData = async () => {
      plugin.settings = {
        debugLogs: false,
        skillsDir: ".opencode/skills",
      };
      plugin.runtimeState = {
        sessions: [],
        activeSessionId: "",
        messagesBySession: {},
        deletedSessionIds: [],
      };
    };
    plugin.getVaultPath = () => "/tmp/vault";
    plugin.bootstrapData = async () => {
      bootstrapCalls += 1;
      return { localDone: true, remoteDone: false };
    };
    plugin.refreshDiagnosticsStatus = async () => {
      diagnosticsRefreshCalls += 1;
      return null;
    };
    plugin.persistState = async () => {};
    plugin.log = () => {};

    await plugin.onload();
    await plugin.onunload();

    assert.equal(detachType, "flownote-view");
    assert.equal(clientStopped, 1);
    assert.equal(bootstrapCalls, 1);
    assert.equal(diagnosticsRefreshCalls, 1);
    assert.equal(fixture.noticeMessages.length, 0);
    assert.equal(JSON.parse(templaterData).user_scripts_folder, "");
    assert.equal(JSON.parse(templaterData).trigger_on_file_creation, true);

    templaterData = JSON.stringify({
      user_scripts_folder: "Meta/Scripts",
      trigger_on_file_creation: true,
    });
    let templaterSaveCalls = 0;
    const loadedTemplater = {
      settings: {
        user_scripts_folder: "Meta/Scripts",
      },
      async save_settings() {
        templaterSaveCalls += 1;
        templaterData = JSON.stringify({
          user_scripts_folder: loadedTemplater.settings.user_scripts_folder,
          trigger_on_file_creation: true,
        });
      },
    };
    app.plugins = {
      getPlugin(id) {
        return id === "templater-obsidian" ? loadedTemplater : null;
      },
    };

    assert.equal(typeof layoutReadyCallback, "function");
    await layoutReadyCallback();
    assert.equal(loadedTemplater.settings.user_scripts_folder, "");
    assert.equal(templaterSaveCalls, 1);
    assert.equal(JSON.parse(templaterData).user_scripts_folder, "");
  } finally {
    fixture.restore();
  }
});
