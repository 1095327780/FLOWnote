const LINK_RESOLVER_PROVIDER_IDS = ["tianapi", "showapi", "gugudata"];
const { normalizeToolPermissionMode } = require("./agent/permission-policy");
const { normalizeSupportedLocale } = require("./i18n-locale-utils");

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

// Default folder locations used by bundled skills. Users override these
// in settings → "笔记位置"; skill bodies/resources are rendered with the
// live `settings.notePaths` before the model sees them.
const DEFAULT_NOTE_PATHS_ZH = {
  captureRoot:      "01-捕获层",
  inbox:            "01-捕获层/收集箱",
  dailyNotes:       "01-捕获层/每日笔记",
  highlights:       "01-捕获层/划线笔记",
  weeklyReviews:    "01-捕获层/周记",
  monthlyReviews:   "01-捕获层/月记",
  yearlyReviews:    "01-捕获层/年记",
  cultivateRoot:    "02-培养层",
  permanentNotes:   "02-培养层/永久笔记",
  topicNotes:       "02-培养层/主题笔记",
  literatureNotes:  "02-培养层/文献笔记",
  domainPages:      "03-连接层",
  createRoot:       "04-创造层",
  activeProjects:   "04-创造层/项目",
  archive:          "04-创造层/归档",
};

const DEFAULT_NOTE_PATHS_EN = {
  captureRoot:      "01-Capture",
  inbox:            "01-Capture/Inbox",
  dailyNotes:       "01-Capture/Daily Notes",
  highlights:       "01-Capture/Highlights",
  weeklyReviews:    "01-Capture/Weekly Reviews",
  monthlyReviews:   "01-Capture/Monthly Reviews",
  yearlyReviews:    "01-Capture/Yearly Reviews",
  cultivateRoot:    "02-Cultivate",
  permanentNotes:   "02-Cultivate/Permanent Notes",
  topicNotes:       "02-Cultivate/Topic Notes",
  literatureNotes:  "02-Cultivate/Literature Notes",
  domainPages:      "03-Connect",
  createRoot:       "04-Create",
  activeProjects:   "04-Create/Projects",
  archive:          "04-Create/Archives",
};

const DEFAULT_NOTE_PATHS = DEFAULT_NOTE_PATHS_ZH;

const DEFAULT_META_PATHS_ZH = {
  metaRoot:      "Meta",
  templates:     "Meta/模板",
  indexes:       "Meta/索引",
  indexPages:    "Meta/索引页",
  systemDocs:    "Meta/系统文档",
  homeViews:     "Meta/Home视图",
  memory:        "Meta/ai-memory",
  legacyMemory:  "Meta/.ai-memory",
};

const DEFAULT_META_PATHS_EN = {
  metaRoot:      "Meta",
  templates:     "Meta/Templates",
  indexes:       "Meta/Indexes",
  indexPages:    "Meta/Index Pages",
  systemDocs:    "Meta/System Docs",
  homeViews:     "Meta/Home Views",
  memory:        "Meta/ai-memory",
  legacyMemory:  "Meta/.ai-memory",
};

const DEFAULT_META_PATHS = DEFAULT_META_PATHS_ZH;

function normalizeVaultFolderPath(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

function joinVaultFolderPath(root, child) {
  const base = normalizeVaultFolderPath(root);
  const suffix = normalizeVaultFolderPath(child);
  if (!base) return suffix;
  if (!suffix) return base;
  return `${base}/${suffix}`;
}

function getMetaPathSuffix(defaultPaths, key) {
  const defaults = defaultPaths && typeof defaultPaths === "object" ? defaultPaths : DEFAULT_META_PATHS;
  if (key === "metaRoot") return "";
  const root = normalizeVaultFolderPath(defaults.metaRoot || DEFAULT_META_PATHS.metaRoot);
  const path = normalizeVaultFolderPath(defaults[key]);
  if (!path) return "";
  if (root && path === root) return "";
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

function deriveMetaPathsFromRoot(metaRoot, defaults = DEFAULT_META_PATHS) {
  const base = defaults && typeof defaults === "object" ? defaults : DEFAULT_META_PATHS;
  const root = normalizeVaultFolderPath(metaRoot) || normalizeVaultFolderPath(base.metaRoot) || DEFAULT_META_PATHS.metaRoot;
  const out = {};
  for (const key of Object.keys(DEFAULT_META_PATHS_ZH)) {
    out[key] = key === "metaRoot"
      ? root
      : joinVaultFolderPath(root, getMetaPathSuffix(base, key));
  }
  return out;
}

function getDefaultNotePathsByLocale(locale) {
  return normalizeSupportedLocale(locale || "zh-CN", "zh-CN") === "en"
    ? { ...DEFAULT_NOTE_PATHS_EN }
    : { ...DEFAULT_NOTE_PATHS_ZH };
}

function getDefaultMetaPathsByLocale(locale) {
  return normalizeSupportedLocale(locale || "zh-CN", "zh-CN") === "en"
    ? { ...DEFAULT_META_PATHS_EN }
    : { ...DEFAULT_META_PATHS_ZH };
}

function normalizeNotePaths(raw, defaults = DEFAULT_NOTE_PATHS) {
  const data = raw && typeof raw === "object" ? raw : {};
  const base = defaults && typeof defaults === "object" ? defaults : DEFAULT_NOTE_PATHS;
  const out = { ...base };
  for (const key of Object.keys(DEFAULT_NOTE_PATHS_ZH)) {
    const v = String(data[key] || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
    out[key] = v || base[key] || DEFAULT_NOTE_PATHS_ZH[key];
  }
  return out;
}

function normalizeMetaPaths(raw, defaults = DEFAULT_META_PATHS) {
  const data = raw && typeof raw === "object" ? raw : {};
  const base = defaults && typeof defaults === "object" ? defaults : DEFAULT_META_PATHS;
  return deriveMetaPathsFromRoot(data.metaRoot || base.metaRoot, base);
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
  metaPaths: { ...DEFAULT_META_PATHS },
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
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const hasExplicitNotePaths = Boolean(source.notePaths && typeof source.notePaths === "object");
  const hasExplicitMetaPaths = Boolean(source.metaPaths && typeof source.metaPaths === "object");
  const hasExplicitMobileCapture = Boolean(source.mobileCapture && typeof source.mobileCapture === "object");
  const localeDefaults = getDefaultNotePathsByLocale(options && options.locale);
  const metaLocaleDefaults = getDefaultMetaPathsByLocale(options && options.locale);
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
  merged.notePaths = normalizeNotePaths(
    hasExplicitNotePaths ? merged.notePaths : null,
    !hasExplicitNotePaths && !(options && options.existingInstall)
      ? localeDefaults
      : DEFAULT_NOTE_PATHS,
  );
  merged.metaPaths = normalizeMetaPaths(
    hasExplicitMetaPaths ? merged.metaPaths : null,
    !hasExplicitMetaPaths && !(options && options.existingInstall)
      ? metaLocaleDefaults
      : DEFAULT_META_PATHS,
  );

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
  const mobileLocale = (options && options.existingInstall)
    ? "zh-CN"
    : normalizeSupportedLocale(options && options.locale, "zh-CN");
  const localizedMcDefaults = {
    ...mcDefaults,
    dailyNotePath: mobileLocale === "en" ? DEFAULT_NOTE_PATHS_EN.dailyNotes : mcDefaults.dailyNotePath,
    ideaSectionHeader: mobileLocale === "en" ? "## Records" : mcDefaults.ideaSectionHeader,
  };
  if (!hasExplicitMobileCapture) {
    merged.mobileCapture = { ...localizedMcDefaults };
  } else {
    merged.mobileCapture = Object.assign({}, localizedMcDefaults, merged.mobileCapture);
  }
  const mc = merged.mobileCapture;
  mc.provider = String(mc.provider || localizedMcDefaults.provider).trim();
  mc.apiKey = String(mc.apiKey || "").trim();
  mc.baseUrl = String(mc.baseUrl || "").trim();
  mc.model = String(mc.model || "").trim();
  mc.dailyNotePath = String(mc.dailyNotePath || localizedMcDefaults.dailyNotePath).trim();
  if (mc.dailyNotePath === "01-捕获层/记录") mc.dailyNotePath = "01-捕获层/每日笔记";
  if (mc.dailyNotePath === "01-Capture/Records") mc.dailyNotePath = "01-Capture/Daily Notes";
  mc.ideaSectionHeader = String(mc.ideaSectionHeader || localizedMcDefaults.ideaSectionHeader).trim();
  mc.enableAiCleanup = typeof mc.enableAiCleanup === "boolean" ? mc.enableAiCleanup : localizedMcDefaults.enableAiCleanup;
  mc.enableUrlSummary = typeof mc.enableUrlSummary === "boolean" ? mc.enableUrlSummary : localizedMcDefaults.enableUrlSummary;
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
  DEFAULT_NOTE_PATHS_ZH,
  DEFAULT_NOTE_PATHS_EN,
  DEFAULT_META_PATHS,
  DEFAULT_META_PATHS_ZH,
  DEFAULT_META_PATHS_EN,
  LINK_RESOLVER_DEFAULTS,
  LINK_RESOLVER_PROVIDER_IDS,
  getDefaultNotePathsByLocale,
  getDefaultMetaPathsByLocale,
  deriveMetaPathsFromRoot,
  migrateLegacySettings,
  normalizeLinkResolver,
  normalizeNotePaths,
  normalizeMetaPaths,
  normalizeProviderOrder,
  normalizeResolverProviderId,
  normalizeSkillSecrets,
  normalizeAgentProviderModePreference,
  normalizeSettings,
  normalizeSettingsInPlace,
  replaceObjectInPlace,
};
