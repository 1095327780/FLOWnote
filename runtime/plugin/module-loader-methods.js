const fs = require("fs");
const path = require("path");

function createModuleLoaderMethods(options = {}) {
  const pluginDirname = String(options.pluginDirname || "");
  const defaultViewType = String(options.defaultViewType || "opencode-assistant-view");
  const obsidianModule = options && options.obsidianModule ? options.obsidianModule : null;
  const pluginRequire = options && typeof options.pluginRequire === "function"
    ? options.pluginRequire
    : require;

  return {
    getViewType() {
      const type = this.runtimeModules && typeof this.runtimeModules.VIEW_TYPE === "string"
        ? this.runtimeModules.VIEW_TYPE
        : "";
      return type || defaultViewType;
    },

    getRuntimeModuleRoots() {
      const configDir = this.app && this.app.vault && this.app.vault.configDir
        ? String(this.app.vault.configDir)
        : ".obsidian";
      const id = this.manifest && this.manifest.id ? String(this.manifest.id) : "opencode-assistant";
      const vaultPath = this.getVaultPath();

      const roots = [
        path.join(vaultPath, configDir, "plugins", id, "runtime"),
        this.manifest && this.manifest.dir ? path.join(String(this.manifest.dir), "runtime") : "",
        pluginDirname ? path.join(pluginDirname, "runtime") : "",
        pluginDirname ? path.resolve(pluginDirname, "runtime") : "",
      ].filter(Boolean);

      return [...new Set(roots)];
    },

    requireRuntimeModule(moduleName) {
      const resolved = this.resolveRuntimeModulePath(moduleName);
      try {
        return pluginRequire(resolved);
      } catch (error) {
        if (!this.isMissingObsidianModuleError(error)) throw error;
        return this.loadRuntimeModuleFile(resolved);
      }
    },

    isMissingObsidianModuleError(error) {
      const message = error instanceof Error ? error.message : String(error || "");
      return /Cannot find module ['"]obsidian['"]/.test(message);
    },

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
    },

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
        if (req === "obsidian") {
          if (obsidianModule) return obsidianModule;
          return pluginRequire("obsidian");
        }
        if (req.startsWith("./") || req.startsWith("../") || path.isAbsolute(req)) {
          const depPath = this.resolveRuntimeModulePath(req, dirname);
          try {
            return pluginRequire(depPath);
          } catch (error) {
            if (!this.isMissingObsidianModuleError(error)) throw error;
            return this.loadRuntimeModuleFile(depPath);
          }
        }
        return pluginRequire(req);
      };

      const executor = new Function(
        "require",
        "module",
        "exports",
        "__filename",
        "__dirname",
        `${code}\n//# sourceURL=${resolvedFile.replace(/\\/g, "/")}`,
      );
      executor(localRequire, runtimeModule, runtimeModule.exports, resolvedFile, dirname);
      runtimeModule.loaded = true;
      return runtimeModule.exports;
    },

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
        VIEW_TYPE: String(view && view.VIEW_TYPE ? view.VIEW_TYPE : defaultViewType),
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
    },
  };
}

module.exports = { createModuleLoaderMethods };
