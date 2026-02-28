const {
  normalizeUiLanguage,
  normalizeSupportedLocale,
  resolveLocaleFromNavigator,
  DEFAULT_UI_LOCALE,
} = require("../i18n-locale-utils");

const LINK_RESOLVER_PROVIDER_IDS = ["tianapi", "showapi", "gugudata"];

const LINK_RESOLVER_PROVIDER_PRESETS = {
  tianapi: {
    id: "tianapi",
    name: "TianAPI",
    keyField: "tianapiKey",
    keyLabel: "TianAPI Key",
    keyPlaceholder: "tianapi key",
    keyUrl: "https://www.tianapi.com/apiview/66",
    docsUrl: "https://www.tianapi.com/apiview/66",
    hint: "Suitable for basic webpage content extraction; dynamic or anti-crawl pages may fail.",
  },
  showapi: {
    id: "showapi",
    name: "ShowAPI",
    keyField: "showapiAppKey",
    keyLabel: "ShowAPI AppKey",
    keyPlaceholder: "showapi appKey",
    keyUrl: "https://www.showapi.com/apiGateway/view/3262/1",
    docsUrl: "https://www.showapi.com/apiGateway/view/3262/1",
    hint: "Usage-based billing with some free quota on selected plans; good low-barrier option.",
  },
  gugudata: {
    id: "gugudata",
    name: "Gugudata",
    keyField: "gugudataAppKey",
    keyLabel: "Gugudata AppKey",
    keyPlaceholder: "gugudata appkey",
    keyUrl: "https://www.gugudata.com/api/details/url2markdown",
    docsUrl: "https://www.gugudata.com/api/details/url2markdown",
    hint: "Stable Markdown quality output; official docs recommend rate control.",
  },
};

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

const MOBILE_CAPTURE_DEFAULTS = {
  provider: "deepseek",
  apiKey: "",
  baseUrl: "",
  model: "",
  dailyNotePath: "01-捕获层/每日笔记",
  ideaSectionHeader: "### 💡 想法和灵感",
  enableAiCleanup: true,
  enableUrlSummary: true,
  linkResolver: { ...LINK_RESOLVER_DEFAULTS },
};

function resolveEffectiveLocaleFromSettings(settings, navigatorLike) {
  const preferred = normalizeUiLanguage(settings && settings.uiLanguage);
  if (preferred === "auto") {
    return resolveLocaleFromNavigator(
      navigatorLike || (typeof navigator !== "undefined" ? navigator : null),
      DEFAULT_UI_LOCALE,
    );
  }
  return normalizeSupportedLocale(preferred, DEFAULT_UI_LOCALE);
}

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

function getResolverProviderPreset(providerId) {
  return LINK_RESOLVER_PROVIDER_PRESETS[normalizeResolverProviderId(providerId)]
    || LINK_RESOLVER_PROVIDER_PRESETS[LINK_RESOLVER_DEFAULTS.provider];
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

function defaultDailyNotePathByLocale(locale) {
  const normalized = normalizeSupportedLocale(locale, DEFAULT_UI_LOCALE);
  return normalized === "zh-CN" ? "01-捕获层/每日笔记" : "01-Capture/Daily Notes";
}

function defaultIdeaSectionHeaderByLocale(locale) {
  const normalized = normalizeSupportedLocale(locale, DEFAULT_UI_LOCALE);
  return normalized === "zh-CN" ? "### 💡 想法和灵感" : "### 💡 Ideas";
}

function normalizeMobileSettings(raw) {
  const data = raw && typeof raw === "object" ? { ...raw } : {};
  data.uiLanguage = normalizeUiLanguage(data.uiLanguage);
  const locale = resolveEffectiveLocaleFromSettings(data);

  const mcDefaults = {
    ...MOBILE_CAPTURE_DEFAULTS,
    dailyNotePath: defaultDailyNotePathByLocale(locale),
    ideaSectionHeader: defaultIdeaSectionHeaderByLocale(locale),
  };

  if (!data.mobileCapture || typeof data.mobileCapture !== "object") {
    data.mobileCapture = { ...mcDefaults };
  } else {
    data.mobileCapture = Object.assign({}, mcDefaults, data.mobileCapture);
  }

  const mc = data.mobileCapture;
  mc.provider = String(mc.provider || mcDefaults.provider).trim();
  mc.apiKey = String(mc.apiKey || "").trim();
  mc.baseUrl = String(mc.baseUrl || "").trim();
  mc.model = String(mc.model || "").trim();
  mc.dailyNotePath = String(mc.dailyNotePath || mcDefaults.dailyNotePath).trim();
  mc.ideaSectionHeader = String(mc.ideaSectionHeader || mcDefaults.ideaSectionHeader).trim();
  mc.enableAiCleanup = typeof mc.enableAiCleanup === "boolean" ? mc.enableAiCleanup : mcDefaults.enableAiCleanup;
  mc.enableUrlSummary = typeof mc.enableUrlSummary === "boolean" ? mc.enableUrlSummary : mcDefaults.enableUrlSummary;
  mc.linkResolver = normalizeLinkResolver(mc.linkResolver);
  return data;
}

function getResolverProviderKey(linkResolver, providerId) {
  if (providerId === "tianapi") return String(linkResolver.tianapiKey || "").trim();
  if (providerId === "showapi") return String(linkResolver.showapiAppKey || "").trim();
  if (providerId === "gugudata") return String(linkResolver.gugudataAppKey || "").trim();
  return "";
}

function setResolverProviderKey(linkResolver, providerId, nextValue) {
  const value = String(nextValue || "").trim();
  if (providerId === "tianapi") {
    linkResolver.tianapiKey = value;
    return;
  }
  if (providerId === "showapi") {
    linkResolver.showapiAppKey = value;
    return;
  }
  if (providerId === "gugudata") {
    linkResolver.gugudataAppKey = value;
  }
}

module.exports = {
  LINK_RESOLVER_PROVIDER_IDS,
  LINK_RESOLVER_PROVIDER_PRESETS,
  LINK_RESOLVER_DEFAULTS,
  MOBILE_CAPTURE_DEFAULTS,
  resolveEffectiveLocaleFromSettings,
  normalizeProviderOrder,
  normalizeResolverProviderId,
  getResolverProviderPreset,
  normalizeLinkResolver,
  defaultDailyNotePathByLocale,
  defaultIdeaSectionHeaderByLocale,
  normalizeMobileSettings,
  getResolverProviderKey,
  setResolverProviderKey,
};
