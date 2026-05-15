// Agent runtime settings shape, defaults, and migration.
//
// Persisted as `plugin.settings.agentProvider`. Loaded by the resolver
// (`agent-provider-resolver.js`) to construct a Provider at runtime.

const { getProviderSpec, getDefaultProviderId, listProviderSpecs } = require("../providers/registry");

/**
 * @typedef {Object} AgentDirectSettings
 * @property {string}  providerId          e.g. 'deepseek'
 * @property {string}  providerMode        e.g. 'api' | 'coding-plan'
 * @property {'cn'|'intl'|undefined} region for providers with a region split
 * @property {Object<string,string>} apiKeys  per-provider keys keyed by providerId
 * @property {string}  model               selected model id
 * @property {string}  baseUrlOverride
 * @property {string}  userAgentOverride
 * @property {string}  versionHeaderOverride
 * @property {boolean} stream              default true
 */

/**
 * @typedef {Object} AgentSettings
 * @property {boolean} enabled             master switch — false means agent UI is hidden
 * @property {'direct'|'opencode-legacy'} mode
 * @property {AgentDirectSettings} direct
 */

const DEFAULT_DIRECT = Object.freeze({
  providerId: "deepseek",
  providerMode: "api",
  region: undefined,
  apiKeys: {},
  model: "deepseek-v4-flash",
  baseUrlOverride: "",
  userAgentOverride: "",
  versionHeaderOverride: "",
  stream: true,
  // 0 / negative / undefined → use the active model's maxOutput from
  // registry. Positive integer overrides that.
  maxOutputTokens: 0,
});

const DEFAULT_AGENT_SETTINGS = Object.freeze({
  enabled: true,
  mode: "direct",
  direct: DEFAULT_DIRECT,
});

/**
 * Produce the default settings for a fresh install.
 *
 * @returns {AgentSettings}
 */
function defaultAgentSettings() {
  return {
    enabled: true,
    mode: "direct",
    direct: {
      providerId: "deepseek",
      providerMode: "api",
      region: undefined,
      apiKeys: {},
      model: "deepseek-v4-flash",
      baseUrlOverride: "",
      userAgentOverride: "",
      versionHeaderOverride: "",
      stream: true,
      maxOutputTokens: 0,
    },
  };
}

/**
 * Migrate an existing 0.4.x plugin-settings object into a shape that
 * contains `agentProvider`. Idempotent: running twice is a no-op.
 *
 * - If `pluginSettings.agentProvider` already exists, normalize it
 *   (filling in any missing fields with defaults) and return.
 * - Otherwise, choose `mode` based on whether the user appears to have
 *   an OpenCode setup already (cliPath, or any OpenCode auth metadata):
 *     - has OpenCode config       → mode = 'opencode-legacy'
 *     - fresh / no OpenCode config → mode = 'direct'
 *
 * @param {Object} pluginSettings
 * @returns {Object} the (possibly modified) settings object — same reference
 */
function migrateAgentSettings(pluginSettings) {
  if (!pluginSettings || typeof pluginSettings !== "object") {
    return { agentProvider: defaultAgentSettings() };
  }
  if (!pluginSettings.agentProvider) {
    const hasOpenCodeFootprint = looksLikeExistingOpenCodeUser(pluginSettings);
    pluginSettings.agentProvider = defaultAgentSettings();
    if (hasOpenCodeFootprint) {
      pluginSettings.agentProvider.mode = "opencode-legacy";
    }
    return pluginSettings;
  }
  pluginSettings.agentProvider = normalizeAgentSettings(pluginSettings.agentProvider);
  return pluginSettings;
}

function looksLikeExistingOpenCodeUser(pluginSettings) {
  const cliPath = String(pluginSettings.cliPath || "").trim();
  if (cliPath) return true;
  // Other signals: launchStrategy explicitly set, provider-auth state etc.
  if (pluginSettings.launchStrategy && pluginSettings.launchStrategy !== "auto") return true;
  if (pluginSettings.providerAuth && typeof pluginSettings.providerAuth === "object") return true;
  return false;
}

/**
 * Fill in missing fields and coerce wrong types. Always returns a fresh
 * object (does not mutate input).
 *
 * @param {Object} raw
 * @returns {AgentSettings}
 */
function normalizeAgentSettings(raw) {
  const defaults = defaultAgentSettings();
  const out = { ...defaults, ...(raw || {}) };
  if (out.mode !== "direct" && out.mode !== "opencode-legacy") out.mode = defaults.mode;
  out.enabled = out.enabled !== false; // default true

  const directIn = raw && raw.direct && typeof raw.direct === "object" ? raw.direct : {};
  const direct = { ...defaults.direct, ...directIn };
  // Coerce apiKeys to plain string→string map
  direct.apiKeys = {};
  if (directIn.apiKeys && typeof directIn.apiKeys === "object") {
    for (const [k, v] of Object.entries(directIn.apiKeys)) {
      if (typeof v === "string") direct.apiKeys[k] = v;
    }
  }
  // Make sure providerId is a known provider; fall back to default if not.
  if (!getProviderSpec(direct.providerId)) {
    direct.providerId = getDefaultProviderId();
    direct.providerMode = "api";
    direct.model = getProviderSpec(direct.providerId).defaultModel;
  }
  // Make sure mode is one this provider supports.
  const spec = getProviderSpec(direct.providerId);
  if (spec && !spec.modes[direct.providerMode]) {
    direct.providerMode = spec.defaultMode;
  }
  // String fields
  direct.baseUrlOverride = String(direct.baseUrlOverride || "");
  direct.userAgentOverride = String(direct.userAgentOverride || "");
  direct.versionHeaderOverride = String(direct.versionHeaderOverride || "");
  if (typeof direct.stream !== "boolean") direct.stream = true;
  // maxOutputTokens: 0 / non-positive / not-a-number → 0 ("use model default")
  const moRaw = Number(direct.maxOutputTokens);
  direct.maxOutputTokens = Number.isFinite(moRaw) && moRaw > 0 ? Math.floor(moRaw) : 0;
  // Drop any legacy direct.skillRoot — skill directory is now shared with
  // settings.skillsDir (the slash-command source of truth) to avoid users
  // having to configure two paths.
  delete direct.skillRoot;
  // Region coercion
  if (direct.region !== "cn" && direct.region !== "intl") direct.region = undefined;

  out.direct = direct;
  return out;
}

/**
 * Read the API key stored for the currently-selected provider.
 *
 * @param {AgentSettings} settings
 * @returns {string}
 */
function getActiveApiKey(settings) {
  if (!settings || !settings.direct) return "";
  const id = settings.direct.providerId;
  return String((settings.direct.apiKeys && settings.direct.apiKeys[id]) || "");
}

/**
 * Mutate the settings object to store an API key for a given provider id.
 *
 * @param {AgentSettings} settings
 * @param {string} providerId
 * @param {string} key
 */
function setApiKeyFor(settings, providerId, key) {
  if (!settings.direct) settings.direct = defaultAgentSettings().direct;
  if (!settings.direct.apiKeys) settings.direct.apiKeys = {};
  settings.direct.apiKeys[providerId] = String(key || "");
}

/**
 * Switch the active provider. Resets mode/region/model to the new
 * provider's defaults so the UI is always in a consistent state.
 *
 * @param {AgentSettings} settings
 * @param {string} providerId
 */
function switchActiveProvider(settings, providerId) {
  const spec = getProviderSpec(providerId);
  if (!spec) throw new Error(`switchActiveProvider: unknown provider "${providerId}"`);
  if (!settings.direct) settings.direct = defaultAgentSettings().direct;
  settings.direct.providerId = providerId;
  settings.direct.providerMode = spec.defaultMode;
  settings.direct.model = spec.defaultModel;
  // Region: leave existing if applicable, else reset
  if (spec.region) {
    if (settings.direct.region !== "cn" && settings.direct.region !== "intl") {
      settings.direct.region = spec.region.defaultRegion || undefined;
    }
  } else {
    settings.direct.region = undefined;
  }
}

module.exports = {
  DEFAULT_AGENT_SETTINGS,
  defaultAgentSettings,
  migrateAgentSettings,
  normalizeAgentSettings,
  getActiveApiKey,
  setApiKeyFor,
  switchActiveProvider,
};
