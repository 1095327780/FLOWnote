const SUPPORTED_UI_LOCALES = ["zh-CN", "en", "ru"];
const DEFAULT_UI_LOCALE = "en";
const UI_LANGUAGE_OPTIONS = ["auto", ...SUPPORTED_UI_LOCALES];
const INTL_LOCALE_BY_UI_LOCALE = {
  "zh-CN": "zh-CN",
  en: "en-US",
  ru: "ru-RU",
};

function normalizeLocaleInput(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

function normalizeSupportedLocaleToken(raw) {
  if (!raw) return "";
  for (const loc of SUPPORTED_UI_LOCALES) {
    if (raw === loc.toLowerCase()) return loc;
  }
  for (const loc of SUPPORTED_UI_LOCALES) {
    const base = loc.toLowerCase().split("-")[0];
    if (raw === base || raw.startsWith(`${base}-`)) return loc;
  }
  return "";
}

function normalizeUiLanguage(value) {
  const raw = normalizeLocaleInput(value);
  if (raw === "auto") return "auto";
  return normalizeSupportedLocaleToken(raw) || "auto";
}

function normalizeSupportedLocale(value, fallback = DEFAULT_UI_LOCALE) {
  const raw = normalizeLocaleInput(value);
  const normalized = normalizeSupportedLocaleToken(raw);
  if (normalized) return normalized;
  if (fallback === null || fallback === undefined) return DEFAULT_UI_LOCALE;
  const fallbackNormalized = normalizeSupportedLocaleToken(normalizeLocaleInput(fallback));
  return fallbackNormalized || String(fallback);
}

function resolveLocaleFromNavigator(navigatorLike, fallback = DEFAULT_UI_LOCALE) {
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
  if (!candidates.length) return normalizeSupportedLocale(fallback, fallback);
  for (const locale of candidates) {
    const normalized = normalizeSupportedLocale(locale, "");
    if (SUPPORTED_UI_LOCALES.includes(normalized)) return normalized;
  }
  return normalizeSupportedLocale(fallback, fallback);
}

function getMessageByPath(messages, path) {
  if (!messages || typeof messages !== "object") return undefined;
  const keys = String(path || "").split(".");
  let cursor = messages;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function interpolateTemplate(message, params = {}) {
  const template = String(message || "");
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return "";
    const value = params[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

function getIntlLocale(locale, fallback = DEFAULT_UI_LOCALE) {
  const normalized = normalizeSupportedLocale(locale, fallback);
  return INTL_LOCALE_BY_UI_LOCALE[normalized] || INTL_LOCALE_BY_UI_LOCALE[DEFAULT_UI_LOCALE];
}

function getLocalizedMarkdownTokenOrder(locale, fallback = DEFAULT_UI_LOCALE) {
  const normalized = normalizeSupportedLocale(locale, fallback);
  if (normalized === "zh-CN") return ["zh-CN", "base", "en"];
  if (normalized === "en") return ["en", "base", "zh-CN"];
  return [normalized, "en", "base", "zh-CN"];
}

function createTranslator(options = {}) {
  const messages = options.messages && typeof options.messages === "object" ? options.messages : {};
  const getLocale = typeof options.getLocale === "function"
    ? options.getLocale
    : () => DEFAULT_UI_LOCALE;
  const fallbackLocale = normalizeSupportedLocale(options.fallbackLocale || DEFAULT_UI_LOCALE);

  return function t(key, params = {}, runtimeOptions = {}) {
    const locale = normalizeSupportedLocale(runtimeOptions.locale || getLocale(), fallbackLocale);
    const defaultValue = Object.prototype.hasOwnProperty.call(runtimeOptions, "defaultValue")
      ? runtimeOptions.defaultValue
      : key;
    const fromLocale = getMessageByPath(messages[locale], key);
    const fromFallback = getMessageByPath(messages[fallbackLocale], key);
    const selected = fromLocale !== undefined ? fromLocale : fromFallback !== undefined ? fromFallback : defaultValue;
    if (typeof selected !== "string") return String(selected);
    return interpolateTemplate(selected, params);
  };
}

module.exports = {
  SUPPORTED_UI_LOCALES,
  DEFAULT_UI_LOCALE,
  UI_LANGUAGE_OPTIONS,
  normalizeUiLanguage,
  normalizeSupportedLocale,
  resolveLocaleFromNavigator,
  getMessageByPath,
  interpolateTemplate,
  getIntlLocale,
  getLocalizedMarkdownTokenOrder,
  createTranslator,
};
