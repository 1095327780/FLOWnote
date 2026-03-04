const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeSettings } = require("../../runtime/settings-utils");

test("normalizeSettings should remove legacy transport flags by default", () => {
  const out = normalizeSettings({});
  assert.equal(Object.prototype.hasOwnProperty.call(out, "experimentalSdkEnabled"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "transportMode"), false);
});

test("normalizeSettings should drop legacy transport flags from persisted input", () => {
  const out = normalizeSettings({
    transportMode: "compat",
    experimentalSdkEnabled: false,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(out, "experimentalSdkEnabled"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "transportMode"), false);
});

test("normalizeSettings should drop legacy plugin-side auth fields", () => {
  const out = normalizeSettings({
    authMode: "custom-api-key",
    customProviderId: "openai",
    customApiKey: "sk-test",
    customBaseUrl: "https://example.com/v1",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(out, "authMode"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "customProviderId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "customApiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "customBaseUrl"), false);
});

test("normalizeSettings should default uiLanguage to auto", () => {
  const out = normalizeSettings({});
  assert.equal(out.uiLanguage, "auto");
});

test("normalizeSettings should normalize uiLanguage aliases", () => {
  assert.equal(normalizeSettings({ uiLanguage: "zh" }).uiLanguage, "zh-CN");
  assert.equal(normalizeSettings({ uiLanguage: "zh_cn" }).uiLanguage, "zh-CN");
  assert.equal(normalizeSettings({ uiLanguage: "en-US" }).uiLanguage, "en");
});

test("normalizeSettings should fallback invalid uiLanguage to auto", () => {
  const out = normalizeSettings({ uiLanguage: "fr-FR" });
  assert.equal(out.uiLanguage, "auto");
});
