function createModuleLoaderMethods(options = {}) {
  const defaultViewType = String(options.defaultViewType || "opencode-assistant-view");

  return {
    getViewType() {
      const type = this.runtimeModules && typeof this.runtimeModules.VIEW_TYPE === "string"
        ? this.runtimeModules.VIEW_TYPE
        : "";
      return type || defaultViewType;
    },

    ensureRuntimeModules() {
      if (this.runtimeModules) return this.runtimeModules;

      const view = require("../open-code-assistant-view");
      const client = require("../open-code-client");
      const sdkTransport = require("../sdk-transport");
      const compatTransport = require("../compat-transport");
      const sessionStore = require("../session-store");
      const diagnosticsService = require("../diagnostics-service");
      const settingsTab = require("../settings-tab");
      const executableResolver = require("../executable-resolver");
      const skillService = require("../skill-service");
      const settingsUtils = require("../settings-utils");
      const stateMigrations = require("../state-migrations");

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
