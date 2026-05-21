const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeSettings,
  normalizeSettingsInPlace,
  normalizeMetaPaths,
  normalizeSkillSecrets,
} = require("../../runtime/settings-utils");

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

test("normalizeSettings should normalize skill secrets", () => {
  const out = normalizeSettings({
    skillSecrets: {
      WEREAD_API_KEY: "  wrk-test  ",
      badName: "ignored",
      EMPTY_TOKEN: "   ",
    },
  });
  assert.deepEqual(out.skillSecrets, { WEREAD_API_KEY: "wrk-test" });
  assert.deepEqual(normalizeSkillSecrets(null), {});
});

test("normalizeSettings should normalize tool permission mode", () => {
  assert.equal(normalizeSettings({}).toolPermissionMode, "ask");
  assert.equal(normalizeSettings({ toolPermissionMode: "dangerous" }).toolPermissionMode, "ask-dangerous");
  assert.equal(normalizeSettings({ toolPermissionMode: "full-auto" }).toolPermissionMode, "auto");
  assert.equal(normalizeSettings({ toolPermissionMode: "unknown" }).toolPermissionMode, "ask");
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

test("normalizeSettings should use English note folders for fresh English installs", () => {
  const out = normalizeSettings({}, { locale: "en", existingInstall: false });
  assert.equal(out.notePaths.dailyNotes, "01-Capture/Daily Notes");
  assert.equal(out.notePaths.permanentNotes, "02-Cultivate/Permanent Notes");
  assert.equal(out.notePaths.activeProjects, "04-Create/Projects");
  assert.equal(out.mobileCapture.dailyNotePath, "01-Capture/Daily Notes");
  assert.equal(out.mobileCapture.ideaSectionHeader, "## Records");
});

test("normalizeSettings should keep Chinese note folders for existing installs", () => {
  const out = normalizeSettings({}, { locale: "en", existingInstall: true });
  assert.equal(out.notePaths.dailyNotes, "01-捕获层/每日笔记");
  assert.equal(out.mobileCapture.dailyNotePath, "01-捕获层/每日笔记");
});

test("normalizeMetaPaths derives all Meta children from the root directory", () => {
  const out = normalizeMetaPaths({
    metaRoot: "System",
    templates: "Ignored/Templates",
    memory: "Ignored/Memory",
  });

  assert.equal(out.metaRoot, "System");
  assert.equal(out.templates, "System/模板");
  assert.equal(out.indexes, "System/索引");
  assert.equal(out.memory, "System/ai-memory");
  assert.equal(out.legacyMemory, "System/.ai-memory");
});

test("normalizeSettings should drop deprecated wsl launch settings", () => {
  const out = normalizeSettings({
    launchStrategy: "wsl",
    wslDistro: "Ubuntu",
    cliPath: "wsl:Ubuntu",
  });
  assert.equal(out.launchStrategy, "auto");
  assert.equal(out.wslDistro, "");
  assert.equal(out.cliPath, "");
});

test("normalizeSettings should preserve explicit OpenCode mode preference", () => {
  const out = normalizeSettings({
    agentProviderModePreference: "opencode-legacy",
    agentProvider: {
      mode: "direct",
      direct: { providerId: "deepseek" },
    },
  });

  assert.equal(out.agentProvider.mode, "opencode-legacy");
  assert.equal(out.agentProviderModePreference, "opencode-legacy");
});

test("normalizeSettings should mirror agentProvider mode into preference when no preference exists", () => {
  const out = normalizeSettings({
    agentProvider: {
      mode: "opencode-legacy",
      direct: { providerId: "deepseek" },
    },
  });

  assert.equal(out.agentProvider.mode, "opencode-legacy");
  assert.equal(out.agentProviderModePreference, "opencode-legacy");
});

test("normalizeSettings should keep old persisted installs on OpenCode bridge", () => {
  const out = normalizeSettings({
    skillsDir: ".opencode/skills",
    launchStrategy: "auto",
  }, { existingInstall: true });

  assert.equal(out.agentProvider.mode, "opencode-legacy");
  assert.equal(out.agentProviderModePreference, "opencode-legacy");
});

test("normalizeSettingsInPlace should preserve common nested setting references", () => {
  const raw = normalizeSettings({
    agentProvider: {
      mode: "direct",
      direct: { providerId: "zhipu-glm", providerMode: "weird" },
    },
    mobileCapture: {
      provider: "deepseek",
      linkResolver: { provider: "showapi" },
    },
  });
  const agentRef = raw.agentProvider;
  const directRef = raw.agentProvider.direct;
  const mobileRef = raw.mobileCapture;
  const resolverRef = raw.mobileCapture.linkResolver;

  raw.agentProvider.direct.providerMode = "invalid-after-load";
  const out = normalizeSettingsInPlace(raw);

  assert.equal(out, raw);
  assert.equal(out.agentProvider, agentRef);
  assert.equal(out.agentProvider.direct, directRef);
  assert.equal(out.mobileCapture, mobileRef);
  assert.equal(out.mobileCapture.linkResolver, resolverRef);
  assert.equal(out.agentProvider.direct.providerMode, "coding-plan");
});
