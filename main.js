const obsidianModule = require("obsidian");
const { setRuntimeLocale } = (() => {
  try {
    return require("./runtime/runtime-locale-state");
  } catch (_e) {
    return { setRuntimeLocale: () => "en" };
  }
})();
const {
  Modal = class {},
  Notice = class {},
  Plugin = class {},
  Platform = { isMobile: false },
  PluginSettingTab = class {},
  Setting = class {},
  normalizePath = (value) => String(value || ""),
  requestUrl = async () => ({ status: 500, text: "", json: null }),
} = obsidianModule;

function resolveRuntimeModuleAbsolutePath(relativePath) {
  let fsMod;
  let pathMod;
  try {
    fsMod = require("fs");
    pathMod = require("path");
  } catch (_error) {
    return "";
  }

  const relative = String(relativePath || "").replace(/^\/+/, "");
  if (!relative) return "";
  const candidates = [];
  if (typeof __dirname === "string" && __dirname) candidates.push(__dirname);
  if (typeof process !== "undefined" && process && typeof process.cwd === "function") {
    const cwd = String(process.cwd() || "");
    if (cwd) {
      candidates.push(cwd);
      candidates.push(pathMod.join(cwd, ".obsidian", "plugins", "flownote"));
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const modulePath = pathMod.join(normalized, "runtime", `${relative}.js`);
    if (fsMod.existsSync(modulePath)) return modulePath;
  }
  return "";
}

function requireRuntimeModuleSafe(relativePath) {
  try {
    return require(`./runtime/${String(relativePath || "").replace(/^\/+/, "")}`);
  } catch (primaryError) {
    const fallbackPath = resolveRuntimeModuleAbsolutePath(relativePath);
    if (fallbackPath) return require(fallbackPath);
    throw primaryError;
  }
}

function fallbackNormalizeUiLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "auto") return "auto";
  if (raw === "zh-cn" || raw === "zh_cn" || raw === "zh") return "zh-CN";
  if (raw.startsWith("en")) return "en";
  return "auto";
}

function fallbackNormalizeSupportedLocale(value, fallback = "en") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "zh-cn" || raw === "zh_cn" || raw === "zh" || raw.startsWith("zh-")) return "zh-CN";
  if (raw.startsWith("en")) return "en";
  if (fallback === null || fallback === undefined) return "en";
  return String(fallback);
}

function fallbackResolveLocaleFromNavigator(navigatorLike, fallback = "en") {
  const nav = navigatorLike && typeof navigatorLike === "object" ? navigatorLike : null;
  const candidates = [];
  if (nav && Array.isArray(nav.languages)) {
    for (const item of nav.languages) {
      if (typeof item === "string" && item.trim()) candidates.push(item.trim());
    }
  }
  if (nav && typeof nav.language === "string" && nav.language.trim()) {
    candidates.push(nav.language.trim());
  }
  if (!candidates.length) return fallbackNormalizeSupportedLocale(fallback, fallback);
  for (const locale of candidates) {
    const normalized = fallbackNormalizeSupportedLocale(locale, "");
    if (normalized === "zh-CN" || normalized === "en") return normalized;
  }
  return fallbackNormalizeSupportedLocale(fallback, fallback);
}

function fallbackGetMessageByPath(messages, path) {
  if (!messages || typeof messages !== "object") return undefined;
  const keys = String(path || "").split(".");
  let cursor = messages;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function fallbackInterpolateTemplate(message, params = {}) {
  const template = String(message || "");
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return "";
    const value = params[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

const localeUtilsModule = (() => {
  try {
    return requireRuntimeModuleSafe("i18n-locale-utils");
  } catch {
    return {};
  }
})();
const i18nMessagesModule = (() => {
  try {
    return requireRuntimeModuleSafe("i18n-messages");
  } catch {
    return {};
  }
})();

const DEFAULT_UI_LOCALE = typeof localeUtilsModule.DEFAULT_UI_LOCALE === "string"
  ? localeUtilsModule.DEFAULT_UI_LOCALE
  : "en";
const normalizeUiLanguage = typeof localeUtilsModule.normalizeUiLanguage === "function"
  ? localeUtilsModule.normalizeUiLanguage
  : fallbackNormalizeUiLanguage;
const normalizeSupportedLocale = typeof localeUtilsModule.normalizeSupportedLocale === "function"
  ? localeUtilsModule.normalizeSupportedLocale
  : fallbackNormalizeSupportedLocale;
const resolveLocaleFromNavigator = typeof localeUtilsModule.resolveLocaleFromNavigator === "function"
  ? localeUtilsModule.resolveLocaleFromNavigator
  : fallbackResolveLocaleFromNavigator;
const getMessageByPath = typeof localeUtilsModule.getMessageByPath === "function"
  ? localeUtilsModule.getMessageByPath
  : fallbackGetMessageByPath;
const interpolateTemplate = typeof localeUtilsModule.interpolateTemplate === "function"
  ? localeUtilsModule.interpolateTemplate
  : fallbackInterpolateTemplate;
const I18N_MESSAGES = i18nMessagesModule && typeof i18nMessagesModule.I18N_MESSAGES === "object"
  ? i18nMessagesModule.I18N_MESSAGES
  : { "zh-CN": {}, en: {} };

const DEFAULT_VIEW_TYPE = "flownote-view";

function i18nLookup(locale, key, params = {}, options = {}) {
  const normalizedLocale = normalizeSupportedLocale(locale, DEFAULT_UI_LOCALE);
  const fallbackLocale = normalizeSupportedLocale(options.fallbackLocale || DEFAULT_UI_LOCALE, DEFAULT_UI_LOCALE);
  const defaultValue = Object.prototype.hasOwnProperty.call(options, "defaultValue")
    ? options.defaultValue
    : key;
  const fromLocale = getMessageByPath(I18N_MESSAGES[normalizedLocale], key);
  const fromFallback = getMessageByPath(I18N_MESSAGES[fallbackLocale], key);
  const message = fromLocale !== undefined ? fromLocale : fromFallback !== undefined ? fromFallback : defaultValue;
  if (typeof message !== "string") return String(message);
  return interpolateTemplate(message, params);
}

function resolveEffectiveLocaleFromSettings(settings, navigatorLike) {
  const preferred = normalizeUiLanguage(settings && settings.uiLanguage);
  if (preferred === "auto") {
    return resolveLocaleFromNavigator(navigatorLike || (typeof navigator !== "undefined" ? navigator : null), DEFAULT_UI_LOCALE);
  }
  return normalizeSupportedLocale(preferred, DEFAULT_UI_LOCALE);
}

/* =========================================================================
 * Mobile runtime methods are loaded from runtime/mobile/mobile-capture-methods.js
 * ========================================================================= */

/* =========================================================================
 * Plugin class
 * ========================================================================= */

function resolveFacadeModuleAbsolutePath(plugin, relativePath) {
  let fsMod;
  let pathMod;
  try {
    fsMod = require("fs");
    pathMod = require("path");
  } catch (_error) {
    return "";
  }

  const candidates = [];
  if (plugin && plugin.manifest && plugin.manifest.dir) {
    candidates.push(String(plugin.manifest.dir));
  }
  const adapter = plugin && plugin.app && plugin.app.vault ? plugin.app.vault.adapter : null;
  const byMethod = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
  const byField = adapter && adapter.basePath ? adapter.basePath : "";
  const basePath = byMethod || byField;
  const configDir = plugin && plugin.app && plugin.app.vault && plugin.app.vault.configDir
    ? String(plugin.app.vault.configDir)
    : ".obsidian";
  const pluginId = plugin && plugin.manifest && plugin.manifest.id
    ? String(plugin.manifest.id)
    : "flownote";
  if (basePath) {
    candidates.push(pathMod.join(basePath, configDir, "plugins", pluginId));
  }
  if (typeof __dirname === "string" && __dirname) {
    candidates.push(__dirname);
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const modulePath = pathMod.join(normalized, "runtime", `${String(relativePath || "").replace(/^\/+/, "")}.js`);
    if (fsMod.existsSync(modulePath)) return modulePath;
  }
  return "";
}

function requireFacadeModule(plugin, relativePath) {
  try {
    switch (relativePath) {
      case "plugin/module-loader-methods":
        return require("./runtime/plugin/module-loader-methods");
      case "plugin/runtime-state-methods":
        return require("./runtime/plugin/runtime-state-methods");
      case "plugin/model-catalog-methods":
        return require("./runtime/plugin/model-catalog-methods");
      case "plugin/bundled-skills-methods":
        return require("./runtime/plugin/bundled-skills-methods");
      case "plugin/session-bootstrap-methods":
        return require("./runtime/plugin/session-bootstrap-methods");
      case "mobile/mobile-capture-methods":
        return require("./runtime/mobile/mobile-capture-methods");
      default:
        throw new Error(`unknown facade module: ${relativePath}`);
    }
  } catch (primaryError) {
    const fallbackPath = resolveFacadeModuleAbsolutePath(plugin, relativePath);
    if (fallbackPath) return requireFacadeModuleFromAbsolutePath(fallbackPath);
    throw primaryError;
  }
}

const OBSIDIAN_REQUIRE_SHIM_KEY = "__flownoteObsidianRequireShim";

function ensureObsidianRequireShim() {
  let moduleLoader = null;
  try {
    moduleLoader = require("module");
  } catch (_error) {
    return false;
  }
  if (!moduleLoader || typeof moduleLoader._load !== "function") return false;
  if (moduleLoader[OBSIDIAN_REQUIRE_SHIM_KEY]) return true;

  const originalLoad = moduleLoader._load;
  const patchedLoad = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return obsidianModule;
    return originalLoad.call(this, request, parent, isMain);
  };

  moduleLoader._load = patchedLoad;
  moduleLoader[OBSIDIAN_REQUIRE_SHIM_KEY] = {
    originalLoad,
    patchedLoad,
  };
  return true;
}

function removeObsidianRequireShim() {
  let moduleLoader = null;
  try {
    moduleLoader = require("module");
  } catch (_error) {
    return;
  }
  if (!moduleLoader || typeof moduleLoader._load !== "function") return;

  const state = moduleLoader[OBSIDIAN_REQUIRE_SHIM_KEY];
  if (!state || typeof state !== "object") return;
  if (moduleLoader._load === state.patchedLoad && typeof state.originalLoad === "function") {
    moduleLoader._load = state.originalLoad;
  }
  delete moduleLoader[OBSIDIAN_REQUIRE_SHIM_KEY];
}

function requireFacadeModuleFromAbsolutePath(modulePath) {
  ensureObsidianRequireShim();
  return require(modulePath);
}

class FLOWnoteAssistantPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.__pluginFacadeMethodsLoaded = false;
    this.__mobileMethodsLoaded = false;
  }

  getDeviceLocale() {
    return resolveLocaleFromNavigator(typeof navigator !== "undefined" ? navigator : null, DEFAULT_UI_LOCALE);
  }

  getEffectiveLocale() {
    return resolveEffectiveLocaleFromSettings(this.settings || {}, typeof navigator !== "undefined" ? navigator : null);
  }

  t(key, params = {}, options = {}) {
    const locale = options && options.locale ? options.locale : this.getEffectiveLocale();
    return i18nLookup(locale, key, params, options);
  }

  refreshLocaleUi() {
    try {
      setRuntimeLocale(this.getEffectiveLocale());
    } catch {
    }
    try {
      if (typeof this.getAssistantView === "function") {
        const view = this.getAssistantView();
        if (view && typeof view.render === "function") view.render();
      }
    } catch {
    }
  }

  ensureFacadeMethodsLoaded() {
    if (this.__pluginFacadeMethodsLoaded) return;

    const {
      createModuleLoaderMethods,
    } = requireFacadeModule(this, "plugin/module-loader-methods");
    const {
      runtimeStateMethods,
    } = requireFacadeModule(this, "plugin/runtime-state-methods");
    const {
      modelCatalogMethods,
    } = requireFacadeModule(this, "plugin/model-catalog-methods");
    const {
      createBundledSkillsMethods,
    } = requireFacadeModule(this, "plugin/bundled-skills-methods");
    const {
      sessionBootstrapMethods,
    } = requireFacadeModule(this, "plugin/session-bootstrap-methods");

    const moduleLoaderMethods = createModuleLoaderMethods({
      defaultViewType: DEFAULT_VIEW_TYPE,
    });
    const bundledSkillsMethods = createBundledSkillsMethods({
      pluginDirname: this.manifest && this.manifest.dir
        ? String(this.manifest.dir)
        : (typeof __dirname === "string" ? __dirname : ""),
    });

    Object.assign(
      FLOWnoteAssistantPlugin.prototype,
      moduleLoaderMethods,
      runtimeStateMethods,
      modelCatalogMethods,
      bundledSkillsMethods,
      sessionBootstrapMethods,
    );

    this.__pluginFacadeMethodsLoaded = true;
  }

  ensureMobileMethodsLoaded() {
    if (this.__mobileMethodsLoaded) return;
    const { mobileCaptureMethodsMixin } = requireFacadeModule(this, "mobile/mobile-capture-methods");
    Object.assign(
      FLOWnoteAssistantPlugin.prototype,
      mobileCaptureMethodsMixin || {},
    );
    this.__mobileMethodsLoaded = true;
  }

  async onload() {
    if (Platform.isMobile) {
      this.ensureMobileMethodsLoaded();
      await this.onloadMobile();
      return;
    }

    try {
      this.ensureFacadeMethodsLoaded();

      this.runtimeStateMigrationDirty = false;
      this.transportModeMigrationDirty = false;
      this.bootstrapInflight = null;
      this.bootstrapLocalDone = false;
      this.bootstrapRemoteDone = false;
      this.bootstrapRemoteAt = 0;

      const runtime = this.ensureRuntimeModules();
      await this.loadPersistedData();
      setRuntimeLocale(this.getEffectiveLocale());

      this.sessionStore = new runtime.SessionStore(this);

      const vaultPath = this.getVaultPath();
      this.skillService = new runtime.SkillService(vaultPath, this.settings);
      this.opencodeClient = new runtime.FLOWnoteClient({
        vaultPath,
        settings: this.settings,
        logger: (line) => this.log(line),
        getPreferredLaunch: () => this.getPreferredLaunchProfile(),
        onLaunchSuccess: (profile) => this.rememberLaunchProfile(profile),
        SdkTransport: runtime.SdkTransport,
        CompatTransport: runtime.CompatTransport,
      });
      this.diagnosticsService = new runtime.DiagnosticsService(this, runtime.ExecutableResolver);

      this.registerView(this.getViewType(), (leaf) => new runtime.FLOWnoteAssistantView(leaf, this));

      this.addRibbonIcon("bot", "FLOWnote", () => this.activateView());

      this.addCommand({
        id: "open-flownote",
        name: this.t("commands.open"),
        callback: () => this.activateView(),
      });

      this.addCommand({
        id: "flownote-send-selected-text",
        name: this.t("commands.sendSelectedText"),
        editorCallback: async (editor) => {
          const text = editor.getSelection().trim();
          if (!text) return new Notice(this.t("notices.pickTextFirst"));

          await this.activateView();
          const view = this.getAssistantView();
          if (view) await view.sendPrompt(text);
        },
      });

      this.addCommand({
        id: "flownote-new-session",
        name: this.t("commands.newSession"),
        callback: async () => {
          const session = await this.createSession("");
          this.sessionStore.setActiveSession(session.id);
          await this.persistState();
          const view = this.getAssistantView();
          if (view) view.render();
        },
      });

      this.addSettingTab(new runtime.FLOWnoteSettingsTab(this.app, this));
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
      console.error("[FLOWnote] load failed", e);
      new Notice(this.t("notices.pluginLoadFailed", { message: msg }));
    }
  }

  async onunload() {
    if (this.opencodeClient) await this.opencodeClient.stop();
    if (typeof this.getViewType === "function") {
      this.app.workspace.detachLeavesOfType(this.getViewType());
    }
    removeObsidianRequireShim();
  }

  log(line) {
    if (!this.settings || !this.settings.debugLogs) return;
    console.log("[FLOWnote]", line);
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    const byMethod = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
    const byField = adapter && adapter.basePath ? adapter.basePath : "";
    const resolved = byMethod || byField;
    if (!resolved) throw new Error(this.t("errors.localFsOnly"));
    return resolved;
  }

  /* --- Mobile-only compatibility wrappers --- */

  async _onloadMobile() {
    this.ensureMobileMethodsLoaded();
    if (typeof this.onloadMobile === "function") {
      await this.onloadMobile();
    }
  }

  _openCaptureModal() {
    this.ensureMobileMethodsLoaded();
    if (typeof this.openCaptureModal === "function") {
      this.openCaptureModal();
    }
  }

  async _loadMobileData() {
    this.ensureMobileMethodsLoaded();
    if (typeof this.loadMobilePersistedData === "function") {
      await this.loadMobilePersistedData();
    }
  }

  async saveSettings() {
    // On desktop this method is overridden by the session-bootstrap mixin.
    // This fallback runs on mobile and remains compatible with mixin methods.
    if (Platform.isMobile && typeof this.saveMobileSettings === "function") {
      await this.saveMobileSettings();
      return;
    }
    const raw = (await this.loadData()) || {};
    raw.settings = this.settings;
    await this.saveData(raw);
    setRuntimeLocale(this.getEffectiveLocale());
  }
}

module.exports = FLOWnoteAssistantPlugin;
