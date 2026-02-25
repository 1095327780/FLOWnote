const SUPPORTED_UI_LOCALES = ["zh-CN", "en"];
const DEFAULT_UI_LOCALE = "en";
const UI_LANGUAGE_OPTIONS = ["auto", ...SUPPORTED_UI_LOCALES];

function normalizeUiLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "auto") return "auto";
  if (raw === "zh-cn" || raw === "zh_cn" || raw === "zh") return "zh-CN";
  if (raw.startsWith("en")) return "en";
  return "auto";
}

function normalizeSupportedLocale(value, fallback = DEFAULT_UI_LOCALE) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "zh-cn" || raw === "zh_cn" || raw === "zh" || raw.startsWith("zh-")) return "zh-CN";
  if (raw.startsWith("en")) return "en";
  if (fallback === null || fallback === undefined) return DEFAULT_UI_LOCALE;
  return String(fallback);
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
  createTranslator,
};
