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
          const session = await this.createSession("");
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

  normalizeModelID(modelID) {
    return String(modelID || "").trim();
  }

  extractProviderFromModelID(modelID) {
    const normalized = this.normalizeModelID(modelID).toLowerCase();
    if (!normalized) return "";
    const slashIndex = normalized.indexOf("/");
    if (slashIndex <= 0) return "";
    return normalized.slice(0, slashIndex).trim();
  }

  isFreeModelID(modelID) {
    const normalized = this.normalizeModelID(modelID).toLowerCase();
    if (!normalized) return false;
    const modelName = normalized.includes("/") ? normalized.slice(normalized.indexOf("/") + 1) : normalized;
    return /(?:^|[-_:.\/])free$/.test(modelName);
  }

  ensureModelCatalogState() {
    if (!this.modelCatalog || typeof this.modelCatalog !== "object") {
      this.modelCatalog = {};
    }
    if (!Array.isArray(this.modelCatalog.allModels)) this.modelCatalog.allModels = [];
    if (!Array.isArray(this.modelCatalog.visibleModels)) this.modelCatalog.visibleModels = [];
    if (!(this.modelCatalog.unavailable instanceof Map)) this.modelCatalog.unavailable = new Map();
    if (!(this.modelCatalog.connectedProviders instanceof Set) && this.modelCatalog.connectedProviders !== null) {
      this.modelCatalog.connectedProviders = null;
    }
    if (this.modelCatalog.connectedProviders === undefined) this.modelCatalog.connectedProviders = null;
    return this.modelCatalog;
  }

  getUnavailableModelSet() {
    const state = this.ensureModelCatalogState();
    const out = new Set();
    for (const [modelKey, meta] of state.unavailable.entries()) {
      if (!modelKey) continue;
      if (!meta || meta.hidden !== false) out.add(String(modelKey));
    }
    return out;
  }

  isHardUnsupportedModelError(message) {
    const text = String(message || "").toLowerCase();
    if (!text) return false;
    return /unsupported model|no such model|model .* not found|invalid model|unknown model|does not support model/.test(text)
      || /模型不支持|不支持该模型|模型不可用|模型不存在|无可用模型/.test(text)
      || /unauthorized|forbidden|permission denied|auth.*failed|鉴权失败|无权限/.test(text)
      || /(status=|http |请求失败 \()4(01|03|04|22)\b/.test(text)
      || /长时间无响应.*不受当前账号\/api key 支持/.test(text);
  }

  shouldTrackModelFailure(message) {
    const text = String(message || "").toLowerCase();
    if (!text) return false;
    if (this.isHardUnsupportedModelError(text)) return true;
    return /timeout|timed out|超时|无响应|no response|session\.status=busy|session\.status=idle/.test(text);
  }

  markModelUnavailable(modelID, reason) {
    const normalized = this.normalizeModelID(modelID);
    if (!normalized) return { hidden: false, attempts: 0, model: "" };
    if (!this.shouldTrackModelFailure(reason)) return { hidden: false, attempts: 0, model: normalized };

    const state = this.ensureModelCatalogState();
    const key = normalized.toLowerCase();
    const previous = state.unavailable.get(key) || {};
    const attempts = Math.max(0, Number(previous.attempts || 0)) + 1;
    const hidden = this.isHardUnsupportedModelError(reason) || attempts >= 2;

    state.unavailable.set(key, {
      model: normalized,
      attempts,
      hidden,
      reason: String(reason || ""),
      updatedAt: Date.now(),
    });

    if (hidden) this.rebuildVisibleModelCache();
    return { hidden, attempts, model: normalized };
  }

  clearUnavailableModels(options = {}) {
    const state = this.ensureModelCatalogState();
    const providerID = this.extractProviderFromModelID(options.providerID || "");
    if (!providerID) {
      state.unavailable.clear();
      this.rebuildVisibleModelCache();
      return;
    }

    for (const [modelKey, meta] of state.unavailable.entries()) {
      const targetProvider = this.extractProviderFromModelID(meta && meta.model ? meta.model : modelKey);
      if (targetProvider === providerID) state.unavailable.delete(modelKey);
    }
    this.rebuildVisibleModelCache();
  }

  normalizeConnectedProviders(connectedProviders) {
    let out = null;
    if (connectedProviders instanceof Set) {
      out = new Set(
        [...connectedProviders]
          .map((id) => String(id || "").trim().toLowerCase())
          .filter(Boolean),
      );
    } else if (Array.isArray(connectedProviders)) {
      out = new Set(
        connectedProviders
          .map((id) => String(id || "").trim().toLowerCase())
          .filter(Boolean),
      );
    }

    const customProviderID = String(this.settings && this.settings.customProviderId ? this.settings.customProviderId : "")
      .trim()
      .toLowerCase();
    if (customProviderID && this.settings && this.settings.authMode === "custom-api-key") {
      if (!(out instanceof Set)) out = new Set();
      out.add(customProviderID);
    }

    return out;
  }

  filterModelList(models, connectedProviders) {
    const uniq = [...new Set(
      (Array.isArray(models) ? models : [])
        .map((model) => this.normalizeModelID(model))
        .filter(Boolean),
    )];
    uniq.sort((a, b) => a.localeCompare(b));

    const unavailable = this.getUnavailableModelSet();
    const hasConnectedFilter = connectedProviders instanceof Set;

    return uniq.filter((modelID) => {
      const key = modelID.toLowerCase();
      if (unavailable.has(key)) return false;
      if (this.isFreeModelID(modelID)) return true;
      if (!hasConnectedFilter) return true;
      const providerID = this.extractProviderFromModelID(modelID);
      if (!providerID) return true;
      return connectedProviders.has(providerID);
    });
  }

  rebuildVisibleModelCache() {
    const state = this.ensureModelCatalogState();
    const visible = this.filterModelList(state.allModels, state.connectedProviders);
    state.visibleModels = visible;
    this.cachedModels = visible;
    return visible;
  }

  async refreshModelCatalog(options = {}) {
    const state = this.ensureModelCatalogState();
    const cfg = options && typeof options === "object" ? options : {};

    if (cfg.resetUnavailable) this.clearUnavailableModels();

    let incomingModels = Array.isArray(cfg.models) ? cfg.models : null;
    if (!incomingModels) {
      try {
        incomingModels = await this.opencodeClient.listModels();
      } catch (e) {
        this.log(`refresh models failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (Array.isArray(incomingModels)) {
      state.allModels = incomingModels
        .map((model) => this.normalizeModelID(model))
        .filter(Boolean);
    }

    let connectedProviders = null;
    if (cfg.connectedProviders instanceof Set || Array.isArray(cfg.connectedProviders)) {
      connectedProviders = cfg.connectedProviders;
    } else if (cfg.providerResult && Array.isArray(cfg.providerResult.connected)) {
      connectedProviders = cfg.providerResult.connected;
    } else {
      try {
        const providerResult = await this.opencodeClient.listProviders();
        if (providerResult && Array.isArray(providerResult.connected)) {
          connectedProviders = providerResult.connected;
        }
      } catch (e) {
        this.log(`refresh providers failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    state.connectedProviders = this.normalizeConnectedProviders(connectedProviders);
    const visible = this.rebuildVisibleModelCache();
    const currentDefaultModel = this.normalizeModelID(this.settings && this.settings.defaultModel ? this.settings.defaultModel : "");
    if (currentDefaultModel && !visible.includes(currentDefaultModel)) {
      this.settings.defaultModel = "";
    }
    return visible;
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
      if (!Array.isArray(this.runtimeState.deletedSessionIds)) this.runtimeState.deletedSessionIds = [];
      this.ensureModelCatalogState();
      return;
    }

    this.settings = runtime.normalizeSettings(raw);
    this.runtimeState = runtime.migrateLegacyMessages({ sessions: [], activeSessionId: "", messagesBySession: {} });
    if (!Array.isArray(this.runtimeState.deletedSessionIds)) this.runtimeState.deletedSessionIds = [];
    this.ensureModelCatalogState();
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

    if (this.runtimeState && Array.isArray(this.runtimeState.deletedSessionIds)) {
      this.runtimeState.deletedSessionIds = this.runtimeState.deletedSessionIds.filter((id) => id !== session.id);
    }

    this.sessionStore.upsertSession(session);
    await this.persistState();
    return session;
  }

  async deleteSession(sessionId) {
    if (!this.sessionStore || typeof this.sessionStore.removeSession !== "function") return false;
    const removed = this.sessionStore.removeSession(sessionId);
    if (!removed) return false;
    await this.persistState();
    return true;
  }

  async syncSessionsFromRemote() {
    try {
      const remote = await this.opencodeClient.listSessions();
      const deletedSet = new Set(
        Array.isArray(this.runtimeState && this.runtimeState.deletedSessionIds)
          ? this.runtimeState.deletedSessionIds
          : [],
      );
      remote.forEach((s) => {
        if (!s || deletedSet.has(s.id)) return;
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
    await this.refreshModelCatalog();
    await this.syncSessionsFromRemote();
  }
};
