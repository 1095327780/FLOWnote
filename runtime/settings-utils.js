const LINK_RESOLVER_PROVIDER_IDS = ["tianapi", "showapi", "gugudata"];
const { normalizeToolPermissionMode } = require("./agent/permission-policy");

const LINK_RESOLVER_DEFAULTS = {
  enabled: true,
  provider: "tianapi",
  providerOrder: [...LINK_RESOLVER_PROVIDER_IDS],
  tianapiKey: "",
  showapiAppKey: "",
  gugudataAppKey: "",
  timeoutMs: 25000,
  retries: 2,
  maxConcurrency: 2,
  fallbackMode: "ai_then_plain",
};

function normalizeProviderOrder(raw, defaults = LINK_RESOLVER_DEFAULTS.providerOrder) {
  const incoming = Array.isArray(raw)
    ? raw
    : String(raw || "")
      .split(/[,\s>，]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  const normalized = [];
  for (const item of incoming) {
    const id = String(item || "").trim().toLowerCase();
    if (!LINK_RESOLVER_PROVIDER_IDS.includes(id)) continue;
    if (normalized.includes(id)) continue;
    normalized.push(id);
  }
  return normalized.length ? normalized : [...defaults];
}

function normalizeResolverProviderId(raw, fallback = LINK_RESOLVER_DEFAULTS.provider) {
  const id = String(raw || "").trim().toLowerCase();
  if (LINK_RESOLVER_PROVIDER_IDS.includes(id)) return id;
  const normalizedFallback = String(fallback || "").trim().toLowerCase();
  if (LINK_RESOLVER_PROVIDER_IDS.includes(normalizedFallback)) return normalizedFallback;
  return LINK_RESOLVER_PROVIDER_IDS[0];
}

function normalizeLinkResolver(raw) {
  const lr = raw && typeof raw === "object"
    ? Object.assign({}, LINK_RESOLVER_DEFAULTS, raw)
    : { ...LINK_RESOLVER_DEFAULTS };
  lr.enabled = typeof lr.enabled === "boolean" ? lr.enabled : LINK_RESOLVER_DEFAULTS.enabled;
  lr.providerOrder = normalizeProviderOrder(lr.providerOrder);
  lr.provider = normalizeResolverProviderId(lr.provider, lr.providerOrder[0]);
  lr.tianapiKey = String(lr.tianapiKey || "").trim();
  lr.showapiAppKey = String(lr.showapiAppKey || "").trim();
  lr.gugudataAppKey = String(lr.gugudataAppKey || "").trim();
  lr.timeoutMs = Math.max(5000, Number(lr.timeoutMs) || LINK_RESOLVER_DEFAULTS.timeoutMs);
  lr.retries = Math.min(5, Math.max(0, Number.isFinite(Number(lr.retries)) ? Number(lr.retries) : LINK_RESOLVER_DEFAULTS.retries));
  lr.maxConcurrency = Math.min(
    5,
    Math.max(1, Number.isFinite(Number(lr.maxConcurrency)) ? Number(lr.maxConcurrency) : LINK_RESOLVER_DEFAULTS.maxConcurrency),
  );
  lr.fallbackMode = lr.fallbackMode === "ai_then_plain" ? "ai_then_plain" : LINK_RESOLVER_DEFAULTS.fallbackMode;
  return lr;
}

// Default folder locations the bundled skills expect. Users override
// these in settings → "笔记位置". The agent system prompt is rebuilt
// per turn with whatever values are live in `settings.notePaths`, so a
// path change takes effect immediately (no restart, no skill rewrite).
const DEFAULT_NOTE_PATHS = {
  dailyNotes:       "01-捕获层/每日笔记",
  weeklyReviews:    "01-捕获层/周记",
  monthlyReviews:   "01-捕获层/月记",
  yearlyReviews:    "01-捕获层/年记",
  permanentNotes:   "02-培养层/永久笔记",
  topicNotes:       "02-培养层/主题笔记",
  literatureNotes:  "02-培养层/文献笔记",
  domainPages:      "03-连接层",
  activeProjects:   "04-创造层/项目",
  archive:          "04-创造层/归档",
};

function normalizeNotePaths(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const out = { ...DEFAULT_NOTE_PATHS };
  for (const key of Object.keys(DEFAULT_NOTE_PATHS)) {
    const v = String(data[key] || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
    out[key] = v || DEFAULT_NOTE_PATHS[key];
  }
  return out;
}

const DEFAULT_SETTINGS = {
  uiLanguage: "auto",
  cliPath: "",
  autoDetectCli: true,
  skillsDir: ".opencode/skills",
  skillSecrets: {},
  toolPermissionMode: "ask",
  defaultModel: "",
  agentProviderModePreference: "",
  notePaths: { ...DEFAULT_NOTE_PATHS },
  requestTimeoutMs: 120000,
  sendWithEnter: false,
  enableStreaming: true,
  debugLogs: true,
  opencodeHomeDir: ".opencode-runtime",
  launchStrategy: "auto",
  wslDistro: "",
  mobileCapture: {
    provider: "deepseek",
    apiKey: "",
    baseUrl: "",
    model: "",
    dailyNotePath: "01-捕获层/每日笔记",
    ideaSectionHeader: "## 记录",
    enableAiCleanup: true,
    enableUrlSummary: true,
    linkResolver: { ...LINK_RESOLVER_DEFAULTS },
  },
};

function migrateLegacySettings(raw) {
  const data = raw && typeof raw === "object" ? { ...raw } : {};

  delete data.useCustomApiKey;
  delete data.authMode;
  delete data.customProviderId;
  delete data.customApiKey;
  delete data.customBaseUrl;
  delete data.transportMode;
  delete data.experimentalSdkEnabled;

  // skillInjectMode is retired — injection is always full text now.
  // Tolerate the legacy key in stored data and drop it on next save.
  delete data.skillInjectMode;
  delete data.prependSkillPrompt;

  return data;
}

function normalizeSkillSecrets(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key || "").trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    const secret = String(value || "").trim();
    if (secret) out[name] = secret;
  }
  return out;
}

function normalizeSettings(raw, options = {}) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, migrateLegacySettings(raw));
  const incomingAgentModePreference = normalizeAgentProviderModePreference(
    merged.agentProviderModePreference,
  );
  {
    const lang = String(merged.uiLanguage || "").trim().toLowerCase();
    if (lang === "auto") merged.uiLanguage = "auto";
    else if (lang === "zh-cn" || lang === "zh_cn" || lang === "zh") merged.uiLanguage = "zh-CN";
    else if (lang.startsWith("en")) merged.uiLanguage = "en";
    else merged.uiLanguage = DEFAULT_SETTINGS.uiLanguage;
  }

  merged.sendWithEnter = typeof merged.sendWithEnter === "boolean" ? merged.sendWithEnter : DEFAULT_SETTINGS.sendWithEnter;
  if (!["auto", "native"].includes(String(merged.launchStrategy || "").trim().toLowerCase())) {
    merged.launchStrategy = "auto";
  }
  merged.notePaths = normalizeNotePaths(merged.notePaths);

  merged.requestTimeoutMs = Math.max(10000, Number(merged.requestTimeoutMs) || DEFAULT_SETTINGS.requestTimeoutMs);
  merged.cliPath = String(merged.cliPath || "").trim();
  if (/^wsl(?::|:\/\/|$|\.exe$)/i.test(merged.cliPath)) merged.cliPath = "";
  merged.skillsDir = String(merged.skillsDir || DEFAULT_SETTINGS.skillsDir).trim();
  merged.skillSecrets = normalizeSkillSecrets(merged.skillSecrets);
  merged.toolPermissionMode = normalizeToolPermissionMode(merged.toolPermissionMode);
  merged.defaultModel = String(merged.defaultModel || "").trim();
  merged.launchStrategy = String(merged.launchStrategy || "auto").trim().toLowerCase();
  if (merged.launchStrategy === "wsl") merged.launchStrategy = "auto";
  merged.wslDistro = "";

  // --- mobileCapture normalization ---
  const mcDefaults = DEFAULT_SETTINGS.mobileCapture;
  if (!merged.mobileCapture || typeof merged.mobileCapture !== "object") {
    merged.mobileCapture = { ...mcDefaults };
  } else {
    merged.mobileCapture = Object.assign({}, mcDefaults, merged.mobileCapture);
  }
  const mc = merged.mobileCapture;
  mc.provider = String(mc.provider || mcDefaults.provider).trim();
  mc.apiKey = String(mc.apiKey || "").trim();
  mc.baseUrl = String(mc.baseUrl || "").trim();
  mc.model = String(mc.model || "").trim();
  mc.dailyNotePath = String(mc.dailyNotePath || mcDefaults.dailyNotePath).trim();
  if (mc.dailyNotePath === "01-捕获层/记录") mc.dailyNotePath = "01-捕获层/每日笔记";
  if (mc.dailyNotePath === "01-Capture/Records") mc.dailyNotePath = "01-Capture/Daily Notes";
  mc.ideaSectionHeader = String(mc.ideaSectionHeader || mcDefaults.ideaSectionHeader).trim();
  mc.enableAiCleanup = typeof mc.enableAiCleanup === "boolean" ? mc.enableAiCleanup : mcDefaults.enableAiCleanup;
  mc.enableUrlSummary = typeof mc.enableUrlSummary === "boolean" ? mc.enableUrlSummary : mcDefaults.enableUrlSummary;
  mc.linkResolver = normalizeLinkResolver(mc.linkResolver);

  // --- agentProvider normalization + migration ---
  // Wraps migrateAgentSettings; idempotent and safe to call on every load.
  try {
    // eslint-disable-next-line global-require
    const { migrateAgentSettings } = require("./agent/agent-settings");
    migrateAgentSettings(merged, {
      existingInstall: Boolean(options && options.existingInstall),
    });
  } catch (_e) {
    // module missing in unusual contexts (tests of unrelated code); fall through.
  }
  if (merged.agentProvider && typeof merged.agentProvider === "object") {
    if (incomingAgentModePreference) {
      merged.agentProvider.mode = incomingAgentModePreference;
    }
    merged.agentProviderModePreference = normalizeAgentProviderModePreference(merged.agentProvider.mode) || "direct";
  } else {
    merged.agentProviderModePreference = incomingAgentModePreference;
  }

  return merged;
}

function replaceObjectInPlace(target, source) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return source;
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (
      existing
      && typeof existing === "object"
      && !Array.isArray(existing)
      && value
      && typeof value === "object"
      && !Array.isArray(value)
    ) {
      replaceObjectInPlace(existing, value);
    } else {
      target[key] = Array.isArray(value) ? value.slice() : value;
    }
  }
  return target;
}

function normalizeSettingsInPlace(raw, options = {}) {
  const normalized = normalizeSettings(raw, options);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return normalized;
  return replaceObjectInPlace(raw, normalized);
}

function normalizeAgentProviderModePreference(value) {
  const mode = String(value || "").trim();
  if (mode === "direct" || mode === "opencode-legacy") return mode;
  return "";
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_NOTE_PATHS,
  LINK_RESOLVER_DEFAULTS,
  LINK_RESOLVER_PROVIDER_IDS,
  migrateLegacySettings,
  normalizeLinkResolver,
  normalizeNotePaths,
  normalizeProviderOrder,
  normalizeResolverProviderId,
  normalizeSkillSecrets,
  normalizeAgentProviderModePreference,
  normalizeSettings,
  normalizeSettingsInPlace,
  replaceObjectInPlace,
};
