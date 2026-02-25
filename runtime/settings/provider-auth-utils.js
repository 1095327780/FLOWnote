const { tFromContext } = require("../i18n-runtime");

const ISO3_TO_ISO2 = {
  CHN: "CN",
  USA: "US",
  GBR: "GB",
  CAN: "CA",
  FRA: "FR",
  DEU: "DE",
  JPN: "JP",
  KOR: "KR",
  SGP: "SG",
  AUS: "AU",
  NLD: "NL",
  CHE: "CH",
  SWE: "SE",
  NOR: "NO",
  FIN: "FI",
  DNK: "DK",
  ITA: "IT",
  ESP: "ES",
  ISR: "IL",
  IND: "IN",
  ARE: "AE",
};

const COUNTRY_CODE_ALIASES = {
  cn: "CN",
  china: "CN",
  prc: "CN",
  中国: "CN",
  中国大陆: "CN",
  us: "US",
  usa: "US",
  america: "US",
  unitedstates: "US",
  美国: "US",
  gb: "GB",
  uk: "GB",
  british: "GB",
  unitedkingdom: "GB",
  greatbritain: "GB",
  英国: "GB",
  ca: "CA",
  canada: "CA",
  加拿大: "CA",
  fr: "FR",
  france: "FR",
  法国: "FR",
  de: "DE",
  germany: "DE",
  德国: "DE",
  jp: "JP",
  japan: "JP",
  日本: "JP",
  kr: "KR",
  korea: "KR",
  southkorea: "KR",
  韩国: "KR",
  sg: "SG",
  singapore: "SG",
  新加坡: "SG",
  au: "AU",
  australia: "AU",
  澳大利亚: "AU",
  nl: "NL",
  netherlands: "NL",
  荷兰: "NL",
  ch: "CH",
  switzerland: "CH",
  瑞士: "CH",
  se: "SE",
  sweden: "SE",
  瑞典: "SE",
  no: "NO",
  norway: "NO",
  挪威: "NO",
  fi: "FI",
  finland: "FI",
  芬兰: "FI",
  dk: "DK",
  denmark: "DK",
  丹麦: "DK",
  it: "IT",
  italy: "IT",
  意大利: "IT",
  es: "ES",
  spain: "ES",
  西班牙: "ES",
  il: "IL",
  israel: "IL",
  以色列: "IL",
  in: "IN",
  india: "IN",
  印度: "IN",
  ae: "AE",
  uae: "AE",
  unitedarabemirates: "AE",
  阿联酋: "AE",
};

const PROVIDER_COUNTRY_HINTS = [
  {
    code: "CN",
    hints: [
      "deepseek",
      "qwen",
      "dashscope",
      "alibaba",
      "moonshot",
      "kimi",
      "zhipu",
      "glm",
      "chatglm",
      "hunyuan",
      "tencent",
      "doubao",
      "volcengine",
      "volc",
      "bytedance",
      "minimax",
      "baidu",
      "ernie",
      "siliconflow",
      "stepfun",
      "yi",
      "01ai",
      "智谱",
      "通义",
      "豆包",
      "百川",
      "讯飞",
      "腾讯",
      "百度",
      "阿里",
      "月之暗面",
    ],
  },
  {
    code: "US",
    hints: [
      "openai",
      "anthropic",
      "xai",
      "grok",
      "google",
      "gemini",
      "vertex",
      "azureopenai",
      "microsoft",
      "meta",
      "groq",
      "together",
      "perplexity",
      "openrouter",
      "cohereforai",
      "fireworks",
      "replicate",
      "scale",
      "awsbedrock",
      "bedrock",
    ],
  },
  {
    code: "FR",
    hints: ["mistral", "mistralai"],
  },
  {
    code: "CA",
    hints: ["cohere"],
  },
  {
    code: "GB",
    hints: ["stability", "stabilityai"],
  },
  {
    code: "SG",
    hints: ["sea-lion", "sealion", "aisingapore"],
  },
];

const COUNTRY_NAME_FALLBACKS = {
  CN: { "zh-CN": "中国", en: "China" },
  US: { "zh-CN": "美国", en: "United States" },
  GB: { "zh-CN": "英国", en: "United Kingdom" },
  CA: { "zh-CN": "加拿大", en: "Canada" },
  FR: { "zh-CN": "法国", en: "France" },
  DE: { "zh-CN": "德国", en: "Germany" },
  JP: { "zh-CN": "日本", en: "Japan" },
  KR: { "zh-CN": "韩国", en: "South Korea" },
  SG: { "zh-CN": "新加坡", en: "Singapore" },
  AU: { "zh-CN": "澳大利亚", en: "Australia" },
  NL: { "zh-CN": "荷兰", en: "Netherlands" },
  CH: { "zh-CN": "瑞士", en: "Switzerland" },
  SE: { "zh-CN": "瑞典", en: "Sweden" },
  NO: { "zh-CN": "挪威", en: "Norway" },
  FI: { "zh-CN": "芬兰", en: "Finland" },
  DK: { "zh-CN": "丹麦", en: "Denmark" },
  IT: { "zh-CN": "意大利", en: "Italy" },
  ES: { "zh-CN": "西班牙", en: "Spain" },
  IL: { "zh-CN": "以色列", en: "Israel" },
  IN: { "zh-CN": "印度", en: "India" },
  AE: { "zh-CN": "阿联酋", en: "United Arab Emirates" },
};

function normalizeSearchToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}

function normalizeCountryCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const compact = raw.replace(/[^a-zA-Z]/g, "").toUpperCase();
  if (/^[A-Z]{2}$/.test(compact)) return compact;
  if (/^[A-Z]{3}$/.test(compact) && ISO3_TO_ISO2[compact]) return ISO3_TO_ISO2[compact];

  const byAlias = COUNTRY_CODE_ALIASES[normalizeSearchToken(raw)];
  return byAlias || "";
}

class ProviderAuthUtilsMethods {
  normalizeSearchText(value) {
    return String(value || "").trim().toLowerCase();
  }

  resolveProviderCountryCode(provider) {
    const directHints = [
      provider && provider.countryCode,
      provider && provider.country_code,
      provider && provider.country,
      provider && provider.region,
      provider && provider.vendorCountry,
      provider && provider.vendor_country,
      provider && provider.location && provider.location.countryCode,
      provider && provider.location && provider.location.country,
      provider && provider.vendor && provider.vendor.countryCode,
      provider && provider.vendor && provider.vendor.country,
      provider && provider.meta && provider.meta.countryCode,
      provider && provider.meta && provider.meta.country,
      provider && provider.meta && provider.meta.region,
      provider && provider.company && provider.company.countryCode,
      provider && provider.company && provider.company.country,
    ];

    for (const hint of directHints) {
      const countryCode = normalizeCountryCode(hint);
      if (countryCode) return countryCode;
    }

    const hintText = normalizeSearchToken([
      provider && provider.id,
      provider && provider.name,
      provider && provider.displayName,
      provider && provider.vendor && provider.vendor.name,
      provider && provider.company && provider.company.name,
    ].filter(Boolean).join(" "));

    for (const item of PROVIDER_COUNTRY_HINTS) {
      if (!item || !Array.isArray(item.hints)) continue;
      if (item.hints.some((hint) => hintText.includes(normalizeSearchToken(hint)))) return item.code;
    }

    return "ZZ";
  }

  getCountryDisplayLocale() {
    if (this.plugin && typeof this.plugin.getEffectiveLocale === "function") {
      const locale = String(this.plugin.getEffectiveLocale() || "").trim().toLowerCase();
      if (locale.startsWith("zh")) return "zh-CN";
    }
    return "en";
  }

  getCountryDisplayNames() {
    if (typeof Intl === "undefined" || typeof Intl.DisplayNames !== "function") return null;
    const locale = this.getCountryDisplayLocale();
    if (this.__countryDisplayNames && this.__countryDisplayNamesLocale === locale) {
      return this.__countryDisplayNames;
    }
    try {
      this.__countryDisplayNames = new Intl.DisplayNames([locale], { type: "region" });
      this.__countryDisplayNamesLocale = locale;
      return this.__countryDisplayNames;
    } catch {
      this.__countryDisplayNames = null;
      this.__countryDisplayNamesLocale = locale;
      return null;
    }
  }

  resolveProviderCountryLabel(countryCode) {
    const normalizedCode = normalizeCountryCode(countryCode) || "ZZ";
    if (normalizedCode === "ZZ") {
      return tFromContext(this, "settings.providerAuth.groupUnknownCountry", "Unknown Country");
    }

    const displayNames = this.getCountryDisplayNames();
    if (displayNames && typeof displayNames.of === "function") {
      try {
        const label = displayNames.of(normalizedCode);
        if (label && String(label).trim()) return String(label);
      } catch {
      }
    }

    const locale = this.getCountryDisplayLocale();
    const fallback = COUNTRY_NAME_FALLBACKS[normalizedCode];
    if (!fallback) return normalizedCode;
    if (locale === "zh-CN") return fallback["zh-CN"] || fallback.en || normalizedCode;
    return fallback.en || fallback["zh-CN"] || normalizedCode;
  }

  buildProviderEntry(provider, connectedSet, authMap) {
    const providerID = String(provider && provider.id ? provider.id : "").trim();
    const providerName = String(provider && provider.name ? provider.name : providerID || "unknown");
    const methodsRaw = Array.isArray(authMap && authMap[providerID]) ? authMap[providerID] : [];
    const oauthMethods = methodsRaw
      .map((m, idx) => ({ index: idx, type: String(m && m.type ? m.type : ""), label: String(m && m.label ? m.label : `OAuth ${idx + 1}`) }))
      .filter((m) => m.type === "oauth");
    const supportsApi = methodsRaw.some((m) => String(m && m.type ? m.type : "") === "api");
    const isConnected = connectedSet instanceof Set ? connectedSet.has(providerID) : false;
    const modelCount = provider && provider.models && typeof provider.models === "object"
      ? Object.keys(provider.models).length
      : 0;
    const methodText = methodsRaw.length
      ? methodsRaw.map((m) => String(m && m.label ? m.label : m && m.type ? m.type : "unknown")).join(" / ")
      : tFromContext(this, "settings.providerAuth.noAuthMethods", "No auth methods");
    const countryCode = this.resolveProviderCountryCode(provider);
    const countryLabel = this.resolveProviderCountryLabel(countryCode);

    return {
      provider,
      providerID,
      providerName,
      methodsRaw,
      oauthMethods,
      supportsApi,
      isConnected,
      modelCount,
      methodText,
      countryCode,
      countryLabel,
    };
  }

  providerEntryMatchesQuery(entry, query) {
    if (!query) return true;
    const content = [
      entry.providerName,
      entry.providerID,
      entry.methodText,
      entry.countryLabel,
      entry.countryCode,
      `model ${entry.modelCount}`,
      entry.isConnected ? "connected" : "disconnected",
    ]
      .join(" ")
      .toLowerCase();
    return content.includes(query);
  }

}

const providerAuthUtilsMethods = {};
for (const key of Object.getOwnPropertyNames(ProviderAuthUtilsMethods.prototype)) {
  if (key === "constructor") continue;
  providerAuthUtilsMethods[key] = ProviderAuthUtilsMethods.prototype[key];
}

module.exports = { providerAuthUtilsMethods };
