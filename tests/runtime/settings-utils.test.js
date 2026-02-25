const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeSettings } = require("../../runtime/settings-utils");

test("normalizeSettings should default to compat and disable sdk by default", () => {
  const out = normalizeSettings({ transportMode: "sdk" });
  assert.equal(out.experimentalSdkEnabled, false);
  assert.equal(out.transportMode, "compat");
});

test("normalizeSettings should keep sdk mode when experimental flag is enabled", () => {
  const out = normalizeSettings({
    transportMode: "sdk",
    experimentalSdkEnabled: true,
  });
  assert.equal(out.experimentalSdkEnabled, true);
  assert.equal(out.transportMode, "sdk");
});

test("normalizeSettings should normalize invalid transport values to compat", () => {
  const out = normalizeSettings({
    transportMode: "invalid",
    experimentalSdkEnabled: true,
  });
  assert.equal(out.transportMode, "compat");
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
