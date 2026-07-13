const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeUiLanguage,
  normalizeSupportedLocale,
  resolveLocaleFromNavigator,
  getIntlLocale,
  getLocalizedMarkdownTokenOrder,
  toCanonicalLocalizedMarkdownPath,
  localizedMarkdownPathByToken,
  isLocalizedMarkdownVariantPath,
  resolveLocalizedMarkdownPath,
  materializeLocalizedMarkdownFiles,
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
  assert.deepEqual(getLocalizedMarkdownTokenOrder("zh-CN"), ["zh-CN", "base", "en"]);
  assert.deepEqual(getLocalizedMarkdownTokenOrder("en"), ["en", "base", "zh-CN"]);
  assert.deepEqual(getLocalizedMarkdownTokenOrder("ru"), ["ru", "en", "base", "zh-CN"]);
});

test("localized markdown helpers should materialize one canonical resource", () => {
  const files = {
    "assets/模板.md": "zh",
    "assets/模板.en.md": "en",
    "assets/模板.ru.md": "ru",
    "assets/helper.py": "print('ok')",
  };
  assert.equal(toCanonicalLocalizedMarkdownPath("assets/模板.en.md"), "assets/模板.md");
  assert.equal(localizedMarkdownPathByToken("assets/模板.md", "ru"), "assets/模板.ru.md");
  assert.equal(isLocalizedMarkdownVariantPath("assets/模板.en.md"), true);
  assert.equal(
    resolveLocalizedMarkdownPath("assets/模板.md", "ru", new Set(Object.keys(files))),
    "assets/模板.ru.md",
  );
  assert.deepEqual(materializeLocalizedMarkdownFiles(files, "en"), {
    "assets/模板.md": "en",
    "assets/helper.py": "print('ok')",
  });
});
