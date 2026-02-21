const obsidianModule = require("obsidian");
const {
  Notice,
  Plugin,
} = obsidianModule;
const fs = require("fs");
const path = require("path");

const DEFAULT_VIEW_TYPE = "opencode-assistant-view";

function uniqueNonEmpty(items) {
  return [...new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )];
}

class OpenCodeAssistantPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.__pluginFacadeMethodsLoaded = false;
  }

  getPluginRootCandidatesForFacade() {
    const manifestDir = this.manifest && this.manifest.dir ? String(this.manifest.dir) : "";
    const manifestId = this.manifest && this.manifest.id ? String(this.manifest.id) : "opencode-assistant";
    const configDir = this.app && this.app.vault && this.app.vault.configDir
      ? String(this.app.vault.configDir)
      : ".obsidian";

    let vaultPath = "";
    try {
      vaultPath = this.getVaultPath();
    } catch {
      vaultPath = "";
    }

    return uniqueNonEmpty([
      manifestDir,
      manifestDir && vaultPath && !path.isAbsolute(manifestDir)
        ? path.resolve(vaultPath, manifestDir)
        : "",
      vaultPath ? path.join(vaultPath, configDir, "plugins", manifestId) : "",
      typeof __dirname === "string" ? __dirname : "",
      typeof __dirname === "string" ? path.resolve(__dirname) : "",
      typeof __dirname === "string" ? path.resolve(__dirname, "..") : "",
    ]);
  }

  resolvePluginRootForFacade() {
    const candidates = this.getPluginRootCandidatesForFacade();
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
    }
    return candidates[0] || "";
  }

  requirePluginRuntimeModule(relativePath) {
    const rel = String(relativePath || "").replace(/^\/+/, "");
    const roots = this.getPluginRootCandidatesForFacade();
    const attempts = [];

    for (const root of roots) {
      const absPath = path.join(root, rel);
      const candidates = [absPath, `${absPath}.js`];
      for (const candidate of candidates) {
        attempts.push(candidate);
        if (!fs.existsSync(candidate)) continue;
        return require(candidate);
      }
    }

    try {
      return require(`./${rel}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法加载模块 ${rel}\n尝试路径:\n${attempts.join("\n")}\n原因: ${detail}`);
    }
  }

  ensureFacadeMethodsLoaded() {
    if (this.__pluginFacadeMethodsLoaded) return;

    const {
      createModuleLoaderMethods,
    } = this.requirePluginRuntimeModule("runtime/plugin/module-loader-methods");
    const {
      runtimeStateMethods,
    } = this.requirePluginRuntimeModule("runtime/plugin/runtime-state-methods");
    const {
      modelCatalogMethods,
    } = this.requirePluginRuntimeModule("runtime/plugin/model-catalog-methods");
    const {
      createBundledSkillsMethods,
    } = this.requirePluginRuntimeModule("runtime/plugin/bundled-skills-methods");
    const {
      sessionBootstrapMethods,
    } = this.requirePluginRuntimeModule("runtime/plugin/session-bootstrap-methods");

    const pluginRootDir = this.resolvePluginRootForFacade();
    const moduleLoaderMethods = createModuleLoaderMethods({
      pluginDirname: pluginRootDir,
      defaultViewType: DEFAULT_VIEW_TYPE,
      obsidianModule,
      pluginRequire: require,
    });
    const bundledSkillsMethods = createBundledSkillsMethods({
      pluginDirname: pluginRootDir,
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
