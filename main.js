const obsidianModule = require("obsidian");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const {
  Notice,
  Plugin,
} = obsidianModule;

const DEFAULT_VIEW_TYPE = "opencode-assistant-view";
let obsidianRequireShimInstalled = false;

function installObsidianRequireShim() {
  if (obsidianRequireShimInstalled) return;
  if (!Module || typeof Module._load !== "function") return;

  const previousLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === "obsidian") return obsidianModule;
    return previousLoad.call(this, request, parent, isMain);
  };

  obsidianRequireShimInstalled = true;
}

function resolvePluginRootDir(plugin) {
  const candidates = [];
  if (plugin && plugin.manifest && plugin.manifest.dir) {
    candidates.push(String(plugin.manifest.dir));
  }

  const vaultPath = plugin && typeof plugin.getVaultPath === "function"
    ? plugin.getVaultPath()
    : "";
  const configDir = plugin && plugin.app && plugin.app.vault && plugin.app.vault.configDir
    ? String(plugin.app.vault.configDir)
    : ".obsidian";
  const pluginId = plugin && plugin.manifest && plugin.manifest.id
    ? String(plugin.manifest.id)
    : "opencode-assistant";
  if (vaultPath) {
    candidates.push(path.join(vaultPath, configDir, "plugins", pluginId));
  }
  if (typeof __dirname === "string" && __dirname) {
    candidates.push(__dirname);
  }

  for (const candidate of candidates.map((item) => String(item || "").trim()).filter(Boolean)) {
    if (fs.existsSync(path.join(candidate, "manifest.json"))) return candidate;
  }
  return candidates[0] || process.cwd();
}

function requireFromPluginRoot(plugin, relativePath) {
  const pluginRoot = resolvePluginRootDir(plugin);
  const absolutePath = path.join(pluginRoot, relativePath);
  return require(absolutePath);
}

class OpenCodeAssistantPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.__pluginFacadeMethodsLoaded = false;
  }

  ensureFacadeMethodsLoaded() {
    if (this.__pluginFacadeMethodsLoaded) return;
    installObsidianRequireShim();

    const {
      createModuleLoaderMethods,
    } = requireFromPluginRoot(this, "runtime/plugin/module-loader-methods");
    const {
      runtimeStateMethods,
    } = requireFromPluginRoot(this, "runtime/plugin/runtime-state-methods");
    const {
      modelCatalogMethods,
    } = requireFromPluginRoot(this, "runtime/plugin/model-catalog-methods");
    const {
      createBundledSkillsMethods,
    } = requireFromPluginRoot(this, "runtime/plugin/bundled-skills-methods");
    const {
      sessionBootstrapMethods,
    } = requireFromPluginRoot(this, "runtime/plugin/session-bootstrap-methods");

    const moduleLoaderMethods = createModuleLoaderMethods({
      defaultViewType: DEFAULT_VIEW_TYPE,
    });
    const bundledSkillsMethods = createBundledSkillsMethods({
      pluginDirname: resolvePluginRootDir(this),
    });

    Object.assign(
      OpenCodeAssistantPlugin.prototype,
      moduleLoaderMethods,
      runtimeStateMethods,
      modelCatalogMethods,
      bundledSkillsMethods,
      sessionBootstrapMethods,
    );

    this.__pluginFacadeMethodsLoaded = true;
  }

  async onload() {
    try {
      const manifestVersion = this.manifest && this.manifest.version ? String(this.manifest.version) : "dev";
      console.log(`[opencode-assistant] runtime main.js v${manifestVersion} loaded`);
      this.ensureFacadeMethodsLoaded();

      this.runtimeStateMigrationDirty = false;
      this.transportModeMigrationDirty = false;
      this.bootstrapInflight = null;
      this.bootstrapLocalDone = false;
      this.bootstrapRemoteDone = false;
      this.bootstrapRemoteAt = 0;

      const runtime = this.ensureRuntimeModules();
      await this.loadPersistedData();

      this.sessionStore = new runtime.SessionStore(this);

      const vaultPath = this.getVaultPath();
      this.skillService = new runtime.SkillService(vaultPath, this.settings);
      this.opencodeClient = new runtime.OpenCodeClient({
        vaultPath,
        settings: this.settings,
        logger: (line) => this.log(line),
        getPreferredLaunch: () => this.getPreferredLaunchProfile(),
        onLaunchSuccess: (profile) => this.rememberLaunchProfile(profile),
        SdkTransport: runtime.SdkTransport,
        CompatTransport: runtime.CompatTransport,
      });
      this.diagnosticsService = new runtime.DiagnosticsService(this, runtime.ExecutableResolver);

      this.registerView(this.getViewType(), (leaf) => new runtime.OpenCodeAssistantView(leaf, this));

      this.addRibbonIcon("bot", "OpenCode 助手", () => this.activateView());

      this.addCommand({
        id: "open-opencode-assistant",
        name: "打开 OpenCode 助手",
        callback: () => this.activateView(),
      });

      this.addCommand({
        id: "opencode-send-selected-text",
        name: "发送选中文本到 OpenCode 助手",
        editorCallback: async (editor) => {
          const text = editor.getSelection().trim();
          if (!text) return new Notice("请先选择文本");

          await this.activateView();
          const view = this.getAssistantView();
          if (view) await view.sendPrompt(text);
        },
      });

      this.addCommand({
        id: "opencode-new-session",
        name: "OpenCode: 新建会话",
        callback: async () => {
          const session = await this.createSession("");
          this.sessionStore.setActiveSession(session.id);
          await this.persistState();
          const view = this.getAssistantView();
          if (view) view.render();
        },
      });

      this.addSettingTab(new runtime.OpenCodeSettingsTab(this.app, this));
      await this.bootstrapData({ waitRemote: false });
      if (this.runtimeStateMigrationDirty || this.transportModeMigrationDirty) {
        this.runtimeStateMigrationDirty = false;
        this.transportModeMigrationDirty = false;
        void this.persistState().catch((e) => {
          this.log(`persist migrated runtime state failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[opencode-assistant] load failed", e);
      new Notice(`OpenCode Assistant 加载失败: ${msg}`);
    }
  }

  async onunload() {
    if (this.opencodeClient) await this.opencodeClient.stop();
    this.app.workspace.detachLeavesOfType(this.getViewType());
  }

  log(line) {
    if (!this.settings || !this.settings.debugLogs) return;
    console.log("[opencode-assistant]", line);
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    const byMethod = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
    const byField = adapter && adapter.basePath ? adapter.basePath : "";
    const resolved = byMethod || byField;
    if (!resolved) throw new Error("仅支持本地文件系统 Vault");
    return resolved;
  }
}

module.exports = OpenCodeAssistantPlugin;
