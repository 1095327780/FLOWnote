console.log("[opencode-assistant] runtime main.js v0.3.37 loaded");

const {
  Notice,
  Plugin,
} = require("obsidian");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DEFAULT_VIEW_TYPE = "opencode-assistant-view";

module.exports = class OpenCodeAssistantPlugin extends Plugin {
  getViewType() {
    const type = this.runtimeModules && typeof this.runtimeModules.VIEW_TYPE === "string"
      ? this.runtimeModules.VIEW_TYPE
      : "";
    return type || DEFAULT_VIEW_TYPE;
  }

  getRuntimeModuleRoots() {
    const configDir = this.app && this.app.vault && this.app.vault.configDir
      ? String(this.app.vault.configDir)
      : ".obsidian";
    const id = this.manifest && this.manifest.id ? String(this.manifest.id) : "opencode-assistant";
    const vaultPath = this.getVaultPath();

    const roots = [
      path.join(vaultPath, configDir, "plugins", id, "runtime"),
      this.manifest && this.manifest.dir ? path.join(String(this.manifest.dir), "runtime") : "",
      typeof __dirname === "string" ? path.join(__dirname, "runtime") : "",
      typeof __dirname === "string" ? path.resolve(__dirname, "runtime") : "",
    ].filter(Boolean);

    return [...new Set(roots)];
  }

  requireRuntimeModule(moduleName) {
    const resolved = this.resolveRuntimeModulePath(moduleName);
    try {
      return require(resolved);
    } catch (error) {
      if (!this.isMissingObsidianModuleError(error)) throw error;
      return this.loadRuntimeModuleFile(resolved);
    }
  }

  isMissingObsidianModuleError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /Cannot find module ['"]obsidian['"]/.test(message);
  }

  resolveRuntimeModulePath(moduleName, fromDir = "") {
    const input = String(moduleName || "").trim();
    const attempts = [];
    const candidateSet = new Set();

    const addCandidates = (basePath) => {
      if (!basePath) return;
      candidateSet.add(basePath);
      if (!basePath.endsWith(".js")) {
        candidateSet.add(`${basePath}.js`);
      }
      candidateSet.add(path.join(basePath, "index.js"));
    };

    if (path.isAbsolute(input)) {
      addCandidates(input);
    } else if (fromDir) {
      addCandidates(path.resolve(fromDir, input));
    } else {
      const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
      addCandidates(path.join(this.getPluginRootDir(), "runtime", normalized));
      for (const root of this.getRuntimeModuleRoots()) {
        addCandidates(path.join(root, normalized));
      }
    }

    for (const candidate of candidateSet) {
      attempts.push(candidate);
      if (!fs.existsSync(candidate)) continue;
      return candidate;
    }

    throw new Error(`无法加载 runtime 模块: ${input}\n已尝试:\n${attempts.join("\n")}`);
  }

  loadRuntimeModuleFile(filePath) {
    if (!this.runtimeModuleCache) this.runtimeModuleCache = new Map();
    const resolvedFile = path.resolve(String(filePath || ""));
    if (this.runtimeModuleCache.has(resolvedFile)) {
      return this.runtimeModuleCache.get(resolvedFile).exports;
    }

    const code = fs.readFileSync(resolvedFile, "utf8");
    const runtimeModule = {
      id: resolvedFile,
      filename: resolvedFile,
      exports: {},
      loaded: false,
    };
    this.runtimeModuleCache.set(resolvedFile, runtimeModule);

    const dirname = path.dirname(resolvedFile);
    const localRequire = (request) => {
      const req = String(request || "");
      if (req === "obsidian") return require("obsidian");
      if (req.startsWith("./") || req.startsWith("../") || path.isAbsolute(req)) {
        const depPath = this.resolveRuntimeModulePath(req, dirname);
        try {
          return require(depPath);
        } catch (error) {
          if (!this.isMissingObsidianModuleError(error)) throw error;
          return this.loadRuntimeModuleFile(depPath);
        }
      }
      return require(req);
    };

    const wrapped = `(function(require, module, exports, __filename, __dirname) {\n${code}\n})`;
    const executor = vm.runInThisContext(wrapped, { filename: resolvedFile });
    executor(localRequire, runtimeModule, runtimeModule.exports, resolvedFile, dirname);
    runtimeModule.loaded = true;
    return runtimeModule.exports;
  }

  ensureRuntimeModules() {
    if (this.runtimeModules) return this.runtimeModules;

    const view = this.requireRuntimeModule("open-code-assistant-view");
    const client = this.requireRuntimeModule("open-code-client");
    const sdkTransport = this.requireRuntimeModule("sdk-transport");
    const compatTransport = this.requireRuntimeModule("compat-transport");
    const sessionStore = this.requireRuntimeModule("session-store");
    const diagnosticsService = this.requireRuntimeModule("diagnostics-service");
    const settingsTab = this.requireRuntimeModule("settings-tab");
    const executableResolver = this.requireRuntimeModule("executable-resolver");
    const skillService = this.requireRuntimeModule("skill-service");
    const settingsUtils = this.requireRuntimeModule("settings-utils");
    const stateMigrations = this.requireRuntimeModule("state-migrations");

    this.runtimeModules = {
      VIEW_TYPE: String(view && view.VIEW_TYPE ? view.VIEW_TYPE : DEFAULT_VIEW_TYPE),
      OpenCodeAssistantView: view && view.OpenCodeAssistantView ? view.OpenCodeAssistantView : null,
      OpenCodeClient: client && client.OpenCodeClient ? client.OpenCodeClient : null,
      SdkTransport: sdkTransport && sdkTransport.SdkTransport ? sdkTransport.SdkTransport : null,
      CompatTransport: compatTransport && compatTransport.CompatTransport ? compatTransport.CompatTransport : null,
      SessionStore: sessionStore && sessionStore.SessionStore ? sessionStore.SessionStore : null,
      DiagnosticsService: diagnosticsService && diagnosticsService.DiagnosticsService ? diagnosticsService.DiagnosticsService : null,
      OpenCodeSettingsTab: settingsTab && settingsTab.OpenCodeSettingsTab ? settingsTab.OpenCodeSettingsTab : null,
      ExecutableResolver: executableResolver && executableResolver.ExecutableResolver ? executableResolver.ExecutableResolver : null,
      SkillService: skillService && skillService.SkillService ? skillService.SkillService : null,
      copyDirectoryRecursive: skillService && skillService.copyDirectoryRecursive ? skillService.copyDirectoryRecursive : null,
      normalizeSettings: settingsUtils && settingsUtils.normalizeSettings ? settingsUtils.normalizeSettings : (raw) => raw || {},
      migrateLegacyMessages: stateMigrations && stateMigrations.migrateLegacyMessages ? stateMigrations.migrateLegacyMessages : (raw) => raw || {},
    };

    const requiredCtors = [
      ["OpenCodeAssistantView", this.runtimeModules.OpenCodeAssistantView],
      ["OpenCodeClient", this.runtimeModules.OpenCodeClient],
      ["SdkTransport", this.runtimeModules.SdkTransport],
      ["CompatTransport", this.runtimeModules.CompatTransport],
      ["SessionStore", this.runtimeModules.SessionStore],
      ["DiagnosticsService", this.runtimeModules.DiagnosticsService],
      ["OpenCodeSettingsTab", this.runtimeModules.OpenCodeSettingsTab],
      ["ExecutableResolver", this.runtimeModules.ExecutableResolver],
      ["SkillService", this.runtimeModules.SkillService],
      ["copyDirectoryRecursive", this.runtimeModules.copyDirectoryRecursive],
    ].filter(([, value]) => !value);

    if (requiredCtors.length) {
      throw new Error(`runtime 模块不完整: ${requiredCtors.map(([name]) => name).join(", ")}`);
    }

    return this.runtimeModules;
  }

  async onload() {
    try {
      const runtime = this.ensureRuntimeModules();
      await this.loadPersistedData();

      this.sessionStore = new runtime.SessionStore(this);

      const vaultPath = this.getVaultPath();
      this.skillService = new runtime.SkillService(vaultPath, this.settings);
      this.opencodeClient = new runtime.OpenCodeClient({
        vaultPath,
        settings: this.settings,
        logger: (line) => this.log(line),
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
          const session = await this.createSession("新会话");
          this.sessionStore.setActiveSession(session.id);
          await this.persistState();
          const view = this.getAssistantView();
          if (view) view.render();
        },
      });

      this.addSettingTab(new runtime.OpenCodeSettingsTab(this.app, this));
      await this.bootstrapData();
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

  getPluginRootDir() {
    const vaultPath = this.getVaultPath();
    const configDir = this.app && this.app.vault && this.app.vault.configDir
      ? String(this.app.vault.configDir)
      : ".obsidian";
    const id = this.manifest && this.manifest.id ? String(this.manifest.id) : "opencode-assistant";

    const candidates = [
      path.join(vaultPath, configDir, "plugins", id),
      this.manifest && this.manifest.dir ? String(this.manifest.dir) : "",
      __dirname,
      path.resolve(__dirname, ".."),
    ].filter(Boolean);

    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
    }
    return candidates[0] || __dirname;
  }

  getBundledSkillsRoot() {
    return path.join(this.getPluginRootDir(), "bundled-skills");
  }

  listBundledSkillIds(rootDir = this.getBundledSkillsRoot()) {
    if (!fs.existsSync(rootDir)) return [];

    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry && entry.isDirectory() && !String(entry.name || "").startsWith("."))
      .map((entry) => String(entry.name || "").trim())
      .filter(Boolean)
      .filter((id) => fs.existsSync(path.join(rootDir, id, "SKILL.md")))
      .sort((a, b) => a.localeCompare(b));
  }

  syncBundledSkills(vaultPath) {
    const runtime = this.ensureRuntimeModules();
    const bundledRoot = this.getBundledSkillsRoot();
    const bundledIds = this.listBundledSkillIds(bundledRoot);

    if (this.skillService) this.skillService.setAllowedSkillIds(bundledIds);
    if (!bundledIds.length) {
      return {
        synced: 0,
        total: 0,
        targetRoot: path.join(vaultPath, this.settings.skillsDir),
        bundledRoot,
        errors: [`未找到内置 skills 源目录或目录为空：${bundledRoot}`],
      };
    }

    const targetRoot = path.join(vaultPath, this.settings.skillsDir);
    fs.mkdirSync(targetRoot, { recursive: true });

    const errors = [];
    for (const skillId of bundledIds) {
      const srcDir = path.join(bundledRoot, skillId);
      const destDir = path.join(targetRoot, skillId);
      try {
        fs.rmSync(destDir, { recursive: true, force: true });
        runtime.copyDirectoryRecursive(srcDir, destDir);
      } catch (e) {
        errors.push(`${skillId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      synced: bundledIds.length - errors.length,
      total: bundledIds.length,
      targetRoot,
      bundledRoot,
      errors,
    };
  }

  getAssistantView() {
    const leaves = this.app.workspace.getLeavesOfType(this.getViewType());
    if (!leaves.length) return null;
    return leaves[0].view;
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(this.getViewType());
    if (leaves.length) {
      await this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: this.getViewType(), active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadPersistedData() {
    const runtime = this.ensureRuntimeModules();
    const raw = (await this.loadData()) || {};

    if (raw.settings || raw.runtimeState) {
      this.settings = runtime.normalizeSettings(raw.settings || {});
      this.runtimeState = runtime.migrateLegacyMessages(raw.runtimeState || { sessions: [], activeSessionId: "", messagesBySession: {} });
      return;
    }

    this.settings = runtime.normalizeSettings(raw);
    this.runtimeState = runtime.migrateLegacyMessages({ sessions: [], activeSessionId: "", messagesBySession: {} });
  }

  async saveSettings() {
    const runtime = this.ensureRuntimeModules();
    this.settings = runtime.normalizeSettings(this.settings);
    if (this.skillService) this.skillService.updateSettings(this.settings);
    if (this.opencodeClient) this.opencodeClient.updateSettings(this.settings);
    await this.persistState();
  }

  async persistState() {
    await this.saveData({ settings: this.settings, runtimeState: this.runtimeState });
  }

  async reloadSkills() {
    if (!this.skillService) return;
    const vaultPath = this.getVaultPath();
    const syncResult = this.syncBundledSkills(vaultPath);
    console.log(
      `[opencode-assistant] bundled skills reload: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
      `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
    );
    if (syncResult.errors.length) this.log(`bundled skills sync: ${syncResult.errors.join("; ")}`);
    this.skillService.loadSkills();
    const view = this.getAssistantView();
    if (view) view.render();
    return syncResult;
  }

  async createSession(title) {
    const created = await this.opencodeClient.createSession(title || "");
    const session = {
      id: created.id,
      title: created.title || title || "新会话",
      updatedAt: Date.now(),
    };

    this.sessionStore.upsertSession(session);
    await this.persistState();
    return session;
  }

  async syncSessionsFromRemote() {
    try {
      const remote = await this.opencodeClient.listSessions();
      remote.forEach((s) => {
        this.sessionStore.upsertSession({
          id: s.id,
          title: s.title || "未命名会话",
          updatedAt: (s.time && s.time.updated) || Date.now(),
        });
      });

      const st = this.sessionStore.state();
      if (!st.activeSessionId && st.sessions.length) st.activeSessionId = st.sessions[0].id;
      await this.persistState();
    } catch {
      // ignore bootstrap sync failure
    }
  }

  async bootstrapData() {
    const vaultPath = this.getVaultPath();
    const syncResult = this.syncBundledSkills(vaultPath);
    if (!syncResult.errors.length) {
      console.log(
        `[opencode-assistant] bundled skills bootstrap: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
        `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
      );
    }
    if (syncResult.errors.length) this.log(`bundled skills bootstrap sync: ${syncResult.errors.join("; ")}`);
    this.skillService.loadSkills();
    try {
      this.cachedModels = await this.opencodeClient.listModels();
    } catch {
      this.cachedModels = [];
    }
    await this.syncSessionsFromRemote();
  }
};
