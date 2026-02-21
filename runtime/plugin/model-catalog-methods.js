const fs = require("fs");
const path = require("path");

const MODEL_CACHE_BLOCK_START = "<!-- opencode-assistant-model-cache:start -->";
const MODEL_CACHE_BLOCK_END = "<!-- opencode-assistant-model-cache:end -->";

const modelCatalogMethods = {
  normalizeModelID(modelID) {
    return String(modelID || "").trim();
  },

  extractProviderFromModelID(modelID) {
    const normalized = this.normalizeModelID(modelID).toLowerCase();
    if (!normalized) return "";
    const slashIndex = normalized.indexOf("/");
    if (slashIndex <= 0) return "";
    return normalized.slice(0, slashIndex).trim();
  },

  isFreeModelID(modelID) {
    const normalized = this.normalizeModelID(modelID).toLowerCase();
    if (!normalized) return false;
    const modelName = normalized.includes("/") ? normalized.slice(normalized.indexOf("/") + 1) : normalized;
    return /(?:^|[-_:.\/])free$/.test(modelName);
  },

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
  },

  getUnavailableModelSet() {
    const state = this.ensureModelCatalogState();
    const out = new Set();
    for (const [modelKey, meta] of state.unavailable.entries()) {
      if (!modelKey) continue;
      if (!meta || meta.hidden !== false) out.add(String(modelKey));
    }
    return out;
  },

  isHardUnsupportedModelError(message) {
    const text = String(message || "").toLowerCase();
    if (!text) return false;
    return /unsupported model|no such model|model .* not found|invalid model|unknown model|does not support model/.test(text)
      || /模型不支持|不支持该模型|模型不可用|模型不存在|无可用模型/.test(text)
      || /unauthorized|forbidden|permission denied|auth.*failed|鉴权失败|无权限/.test(text)
      || /(status=|http |请求失败 \()4(01|03|04|22)\b/.test(text)
      || /长时间无响应.*不受当前账号\/api key 支持/.test(text);
  },

  shouldTrackModelFailure(message) {
    const text = String(message || "").toLowerCase();
    if (!text) return false;
    if (this.isHardUnsupportedModelError(text)) return true;
    return /timeout|timed out|超时|无响应|no response|session\.status=busy|session\.status=idle/.test(text);
  },

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
  },

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
  },

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
  },

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
  },

  rebuildVisibleModelCache() {
    const state = this.ensureModelCatalogState();
    const visible = this.filterModelList(state.allModels, state.connectedProviders);
    state.visibleModels = visible;
    this.cachedModels = visible;
    return visible;
  },

  getTerminalOutputModelCachePath() {
    return path.join(this.getVaultPath(), "终端输出.md");
  },

  normalizeModelCachePayload(payload) {
    const raw = payload && typeof payload === "object" ? payload : {};
    const models = [...new Set(
      (Array.isArray(raw.models) ? raw.models : [])
        .map((model) => this.normalizeModelID(model))
        .filter(Boolean),
    )];
    models.sort((a, b) => a.localeCompare(b));

    const connectedProviders = [...new Set(
      (Array.isArray(raw.connectedProviders) ? raw.connectedProviders : [])
        .map((id) => String(id || "").trim().toLowerCase())
        .filter(Boolean),
    )];

    return {
      models,
      connectedProviders,
      updatedAt: Number(raw.updatedAt || 0),
    };
  },

  readModelCacheFromTerminalOutput() {
    const filePath = this.getTerminalOutputModelCachePath();
    if (!fs.existsSync(filePath)) return null;

    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    if (!text) return null;

    const startIndex = text.indexOf(MODEL_CACHE_BLOCK_START);
    if (startIndex < 0) return null;
    const endIndex = text.indexOf(MODEL_CACHE_BLOCK_END, startIndex);
    if (endIndex < 0) return null;

    const section = text.slice(startIndex + MODEL_CACHE_BLOCK_START.length, endIndex);
    const codeStart = section.indexOf("```json");
    if (codeStart < 0) return null;
    const afterCodeStart = section.slice(codeStart + "```json".length);
    const codeEnd = afterCodeStart.indexOf("```");
    if (codeEnd < 0) return null;

    const jsonText = afterCodeStart.slice(0, codeEnd).trim();
    if (!jsonText) return null;

    try {
      return this.normalizeModelCachePayload(JSON.parse(jsonText));
    } catch {
      return null;
    }
  },

  writeModelCacheToTerminalOutput(models, connectedProviders = []) {
    const normalizedModels = [...new Set(
      (Array.isArray(models) ? models : [])
        .map((model) => this.normalizeModelID(model))
        .filter(Boolean),
    )];
    if (!normalizedModels.length) return false;
    normalizedModels.sort((a, b) => a.localeCompare(b));

    const normalizedProviders = [...new Set(
      (Array.isArray(connectedProviders) ? connectedProviders : [])
        .map((id) => String(id || "").trim().toLowerCase())
        .filter(Boolean),
    )];
    normalizedProviders.sort((a, b) => a.localeCompare(b));

    const payload = {
      updatedAt: Date.now(),
      models: normalizedModels,
      connectedProviders: normalizedProviders,
    };
    const block = [
      MODEL_CACHE_BLOCK_START,
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
      MODEL_CACHE_BLOCK_END,
    ].join("\n");

    const filePath = this.getTerminalOutputModelCachePath();
    let text = "";
    if (fs.existsSync(filePath)) {
      try {
        text = fs.readFileSync(filePath, "utf8");
      } catch {
        text = "";
      }
    }

    const startIndex = text.indexOf(MODEL_CACHE_BLOCK_START);
    const endIndex = startIndex >= 0 ? text.indexOf(MODEL_CACHE_BLOCK_END, startIndex) : -1;

    let nextText = "";
    if (startIndex >= 0 && endIndex >= 0) {
      nextText = `${text.slice(0, startIndex)}${block}${text.slice(endIndex + MODEL_CACHE_BLOCK_END.length)}`;
    } else if (text.trim().length > 0) {
      nextText = `${text.replace(/\s*$/, "")}\n\n${block}\n`;
    } else {
      nextText = `${block}\n`;
    }

    try {
      fs.writeFileSync(filePath, nextText, "utf8");
      return true;
    } catch (e) {
      this.log(`write model cache failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  },

  loadModelCatalogFromTerminalOutput() {
    const cache = this.readModelCacheFromTerminalOutput();
    if (!cache || !Array.isArray(cache.models) || !cache.models.length) return [];

    const state = this.ensureModelCatalogState();
    state.allModels = cache.models.slice();
    const connected = Array.isArray(cache.connectedProviders) && cache.connectedProviders.length
      ? cache.connectedProviders
      : null;
    state.connectedProviders = this.normalizeConnectedProviders(connected);
    return this.rebuildVisibleModelCache();
  },

  notifyModelCatalogUpdated() {
    const view = this.getAssistantView();
    if (!view) return;
    try {
      if (typeof view.updateModelSelectOptions === "function") {
        view.updateModelSelectOptions();
        return;
      }
      if (typeof view.render === "function") view.render();
    } catch (e) {
      this.log(`notify model catalog failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

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

    if (cfg.cacheToTerminalOutput !== false && Array.isArray(state.allModels) && state.allModels.length) {
      const connectedForCache = state.connectedProviders instanceof Set
        ? [...state.connectedProviders]
        : [];
      this.writeModelCacheToTerminalOutput(state.allModels, connectedForCache);
    }

    if (cfg.notifyView !== false) this.notifyModelCatalogUpdated();
    return visible;
  },
};

module.exports = { modelCatalogMethods };
