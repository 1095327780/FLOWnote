const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeUiLanguage,
  normalizeSupportedLocale,
  resolveLocaleFromNavigator,
  getIntlLocale,
  getLocalizedMarkdownTokenOrder,
  createTranslator,
} = require("../../runtime/i18n-locale-utils");

test("normalizeUiLanguage should keep supported values and map aliases", () => {
  assert.equal(normalizeUiLanguage("auto"), "auto");
  assert.equal(normalizeUiLanguage("zh"), "zh-CN");
  assert.equal(normalizeUiLanguage("zh-CN"), "zh-CN");
  assert.equal(normalizeUiLanguage("en-US"), "en");
  assert.equal(normalizeUiLanguage("ru-RU"), "ru");
});

test("normalizeSupportedLocale should fallback unsupported values to en", () => {
  assert.equal(normalizeSupportedLocale("zh-TW"), "zh-CN");
  assert.equal(normalizeSupportedLocale("ru_RU"), "ru");
  assert.equal(normalizeSupportedLocale("fr-FR"), "en");
});

test("resolveLocaleFromNavigator should pick first supported locale", () => {
  const locale = resolveLocaleFromNavigator({
    languages: ["fr-FR", "zh-CN"],
    language: "fr-FR",
  });
  assert.equal(locale, "zh-CN");
});

test("resolveLocaleFromNavigator should pick ru when available", () => {
  const locale = resolveLocaleFromNavigator({
    languages: ["fr-FR", "ru-RU", "zh-CN"],
    language: "fr-FR",
  });
  assert.equal(locale, "ru");
});

test("resolveLocaleFromNavigator should fallback to en on unsupported locales", () => {
  const locale = resolveLocaleFromNavigator({
    languages: ["fr-FR", "de-DE"],
    language: "fr-FR",
  });
  assert.equal(locale, "en");
});

test("createTranslator should resolve locale, fallback, and interpolation", () => {
  const t = createTranslator({
    messages: {
      "zh-CN": { view: { welcome: "你好，{name}" } },
      en: { view: { welcome: "Hello, {name}" } },
    },
    getLocale: () => "zh-CN",
  });

  assert.equal(t("view.welcome", { name: "FLOWnote" }), "你好，FLOWnote");
  assert.equal(t("missing.key", {}, { defaultValue: "N/A" }), "N/A");
  assert.equal(t("view.welcome", { name: "FLOWnote" }, { locale: "fr-FR" }), "Hello, FLOWnote");
});

test("locale helpers should expose intl locale and markdown fallback order", () => {
  assert.equal(getIntlLocale("ru-RU"), "ru-RU");
  assert.deepEqual(getLocalizedMarkdownTokenOrder("ru"), ["ru", "base", "en", "zh-CN"]);
});
