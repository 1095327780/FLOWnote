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
