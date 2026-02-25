const LINK_RESOLVER_PROVIDER_IDS = ["tianapi", "showapi", "gugudata"];

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

const DEFAULT_SETTINGS = {
  uiLanguage: "auto",
  transportMode: "compat",
  experimentalSdkEnabled: false,
  cliPath: "",
  autoDetectCli: true,
  skillsDir: ".opencode/skills",
  skillInjectMode: "summary",
  defaultModel: "",
  requestTimeoutMs: 120000,
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
    ideaSectionHeader: "### 💡 想法和灵感",
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

  const transportModeRaw = String(data.transportMode || "").trim().toLowerCase();
  if (!transportModeRaw) data.transportMode = "compat";
  else if (!["sdk", "compat"].includes(transportModeRaw)) data.transportMode = "compat";
  else data.transportMode = transportModeRaw;

  if (data.prependSkillPrompt === false && !data.skillInjectMode) data.skillInjectMode = "off";
  if (data.prependSkillPrompt === true && !data.skillInjectMode) data.skillInjectMode = "summary";
  delete data.prependSkillPrompt;

  if (typeof data.experimentalSdkEnabled !== "boolean") {
    data.experimentalSdkEnabled = false;
  }

  return data;
}

function normalizeSettings(raw) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, migrateLegacySettings(raw));
  {
    const lang = String(merged.uiLanguage || "").trim().toLowerCase();
    if (lang === "auto") merged.uiLanguage = "auto";
    else if (lang === "zh-cn" || lang === "zh_cn" || lang === "zh") merged.uiLanguage = "zh-CN";
    else if (lang.startsWith("en")) merged.uiLanguage = "en";
    else merged.uiLanguage = DEFAULT_SETTINGS.uiLanguage;
  }

  if (!["sdk", "compat"].includes(String(merged.transportMode || "").trim().toLowerCase())) {
    merged.transportMode = "compat";
  }
  merged.experimentalSdkEnabled = Boolean(merged.experimentalSdkEnabled);
  if (!merged.experimentalSdkEnabled) merged.transportMode = "compat";
  if (!["summary", "full", "off"].includes(merged.skillInjectMode)) merged.skillInjectMode = "summary";
  if (!["auto", "native", "wsl"].includes(String(merged.launchStrategy || "").trim().toLowerCase())) {
    merged.launchStrategy = "auto";
  }

  merged.requestTimeoutMs = Math.max(10000, Number(merged.requestTimeoutMs) || DEFAULT_SETTINGS.requestTimeoutMs);
  merged.cliPath = String(merged.cliPath || "").trim();
  merged.skillsDir = String(merged.skillsDir || DEFAULT_SETTINGS.skillsDir).trim();
  merged.defaultModel = String(merged.defaultModel || "").trim();
  merged.transportMode = String(merged.transportMode || "compat").trim().toLowerCase();
  merged.launchStrategy = String(merged.launchStrategy || "auto").trim().toLowerCase();
  merged.wslDistro = String(merged.wslDistro || "").trim();

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
  mc.ideaSectionHeader = String(mc.ideaSectionHeader || mcDefaults.ideaSectionHeader).trim();
  mc.enableAiCleanup = typeof mc.enableAiCleanup === "boolean" ? mc.enableAiCleanup : mcDefaults.enableAiCleanup;
  mc.enableUrlSummary = typeof mc.enableUrlSummary === "boolean" ? mc.enableUrlSummary : mcDefaults.enableUrlSummary;
  mc.linkResolver = normalizeLinkResolver(mc.linkResolver);

  return merged;
}

module.exports = {
  DEFAULT_SETTINGS,
  LINK_RESOLVER_DEFAULTS,
  LINK_RESOLVER_PROVIDER_IDS,
  migrateLegacySettings,
  normalizeLinkResolver,
  normalizeProviderOrder,
  normalizeResolverProviderId,
  normalizeSettings,
};
