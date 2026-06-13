const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getDefaultNotePaths,
  migrateSettingsLocaleDefaults,
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
  assert.equal(normalizeSettings({ uiLanguage: "ru" }).uiLanguage, "ru");
  assert.equal(normalizeSettings({ uiLanguage: "ru-RU" }).uiLanguage, "ru");
});

test("normalizeSettings should fallback invalid uiLanguage to auto", () => {
  const out = normalizeSettings({ uiLanguage: "fr-FR" });
  assert.equal(out.uiLanguage, "auto");
});

test("normalizeSettings should use localized note path defaults", () => {
  const out = normalizeSettings({
    uiLanguage: "ru",
    notePaths: getDefaultNotePaths("zh-CN"),
    mobileCapture: { dailyNotePath: "01-捕获层/每日笔记" },
  });
  assert.equal(out.notePaths.dailyNotes, "01-Захват/Ежедневные заметки");
  assert.equal(out.notePaths.activeProjects, "04-Создание/Проекты");
  assert.equal(out.mobileCapture.dailyNotePath, "01-Захват/Ежедневные заметки");
});

test("normalizeSettings should use Russian defaults for fresh mobile capture", () => {
  const out = normalizeSettings({
    uiLanguage: "ru",
  }, { locale: "ru" });
  assert.equal(out.mobileCapture.dailyNotePath, "01-Захват/Ежедневные заметки");
  assert.equal(out.mobileCapture.ideaSectionHeader, "## Записи");
  assert.equal(out.metaPaths.templates, "Meta/Шаблоны");
});

test("migrateSettingsLocaleDefaults should migrate only known defaults", () => {
  const settings = {
    notePaths: {
      ...getDefaultNotePaths("zh-CN"),
      activeProjects: "Work/Projects",
    },
    mobileCapture: {
      dailyNotePath: "01-捕获层/每日笔记",
    },
  };
  migrateSettingsLocaleDefaults(settings, "zh-CN", "ru");
  assert.equal(settings.notePaths.dailyNotes, "01-Захват/Ежедневные заметки");
  assert.equal(settings.notePaths.activeProjects, "Work/Projects");
  assert.equal(settings.mobileCapture.dailyNotePath, "01-Захват/Ежедневные заметки");
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

test("normalizeSettings should preserve user custom paths and AI settings on existing installs", () => {
  const out = normalizeSettings({
    uiLanguage: "ru",
    skillsDir: "User/Skills",
    toolPermissionMode: "auto",
    notePaths: {
      dailyNotes: "My Notes/Daily",
      weeklyReviews: "My Notes/Weekly",
      monthlyReviews: "My Notes/Monthly",
      yearlyReviews: "My Notes/Yearly",
      permanentNotes: "Knowledge/Permanent",
      topicNotes: "Knowledge/Topics",
      literatureNotes: "Knowledge/Literature",
      domainPages: "Knowledge/Domains",
      activeProjects: "Work/Projects",
      archive: "Work/Archive",
    },
    metaPaths: {
      metaRoot: "System",
      templates: "System/My Templates",
      indexes: "System/My Indexes",
      indexPages: "System/My Pages",
      systemDocs: "System/Docs",
      homeViews: "System/Home",
      memory: "System/Memory",
      legacyMemory: "System/Legacy Memory",
    },
    mobileCapture: {
      dailyNotePath: "Mobile/Inbox",
      provider: "deepseek",
      apiKey: "mobile-key",
      baseUrl: "https://mobile.example/v1",
      model: "mobile-model",
    },
    agentProvider: {
      enabled: true,
      mode: "direct",
      direct: {
        providerId: "deepseek",
        providerMode: "api",
        apiKeys: { deepseek: "sk-user" },
        model: "deepseek-v4-flash",
        baseUrlOverride: "https://proxy.example/v1",
        stream: false,
      },
    },
  }, { existingInstall: true, locale: "ru" });

  assert.equal(out.skillsDir, "User/Skills");
  assert.equal(out.toolPermissionMode, "auto");
  assert.equal(out.notePaths.dailyNotes, "My Notes/Daily");
  assert.equal(out.notePaths.activeProjects, "Work/Projects");
  assert.equal(out.metaPaths.templates, "System/My Templates");
  assert.equal(out.metaPaths.memory, "System/Memory");
  assert.equal(out.mobileCapture.dailyNotePath, "Mobile/Inbox");
  assert.equal(out.mobileCapture.apiKey, "mobile-key");
  assert.equal(out.mobileCapture.baseUrl, "https://mobile.example/v1");
  assert.equal(out.mobileCapture.model, "mobile-model");
  assert.equal(out.agentProvider.mode, "direct");
  assert.equal(out.agentProvider.direct.providerId, "deepseek");
  assert.equal(out.agentProvider.direct.apiKeys.deepseek, "sk-user");
  assert.equal(out.agentProvider.direct.baseUrlOverride, "https://proxy.example/v1");
  assert.equal(out.agentProvider.direct.stream, false);
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
