const { normalizeSupportedLocale, interpolateTemplate } = require("./i18n-locale-utils");

let runtimeLocale = "en";

function setRuntimeLocale(locale) {
  runtimeLocale = normalizeSupportedLocale(locale, "en");
  return runtimeLocale;
}

function getRuntimeLocale() {
  return runtimeLocale;
}

function rt(zhText, enText, params = {}, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || runtimeLocale, "en");
  const useZh = locale === "zh-CN";
  const template = useZh
    ? String(zhText !== undefined ? zhText : enText || "")
    : String(enText !== undefined ? enText : zhText || "");
  return interpolateTemplate(template, params || {});
}

module.exports = {
  setRuntimeLocale,
  getRuntimeLocale,
  rt,
};
