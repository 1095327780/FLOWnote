const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadBasicSettingsWithMobilePlatform() {
  const originalLoad = Module._load;
  class SettingMock {
    setName() { return this; }
    setDesc() { return this; }
    addDropdown(callback) {
      callback({ addOption() { return this; }, setValue() { return this; }, onChange() { return this; } });
      return this;
    }
  }
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return { Setting: SettingMock, Notice: class {}, Platform: { isMobile: true } };
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve("../../runtime/settings/basic-settings-section-methods");
  const agentModePath = require.resolve("../../runtime/agent/agent-mode");
  delete require.cache[modulePath];
  delete require.cache[agentModePath];
  return {
    methods: require(modulePath).basicSettingsSectionMethods,
    restore() {
      Module._load = originalLoad;
      delete require.cache[modulePath];
      delete require.cache[agentModePath];
    },
  };
}

function fakeContainer() {
  return { empty() {}, addClass() {}, createEl() {}, createDiv() { return fakeContainer(); } };
}

test("mobile basic settings keep legacy preference but show direct advanced settings and hide OpenCode", () => {
  const fixture = loadBasicSettingsWithMobilePlatform();
  try {
    const rendered = [];
    const self = Object.assign({}, fixture.methods, {
      containerEl: fakeContainer(),
      plugin: {
        settings: {
          uiLanguage: "en",
          agentProviderModePreference: "opencode-legacy",
          agentProvider: { mode: "opencode-legacy", direct: {} },
        },
        getEffectiveLocale() { return "en"; },
        async saveSettings() {},
      },
      setHeading() {},
      renderSettingsGroup(_container, options) { options.render(fakeContainer()); },
      renderShortcutSection() {},
      renderAgentProviderSection() { rendered.push("provider"); },
      renderAgentProviderAdvanced() { rendered.push("advanced"); },
      renderCollapsibleGroup(_container, options) {
        rendered.push(options.heading);
        if (options.render) options.render(fakeContainer());
      },
      renderNotePathsSection() {},
      renderSkillManagementSection() {},
      renderTemplateManagementSection() {},
      renderMobileCaptureSection() {},
    });
    self.display();
    assert.ok(rendered.includes("provider"));
    assert.ok(rendered.includes("advanced"));
    assert.ok(!rendered.includes("OpenCode bridge configuration"));
    assert.equal(self.plugin.settings.agentProvider.mode, "opencode-legacy");
    assert.equal(self.plugin.settings.agentProviderModePreference, "opencode-legacy");
  } finally {
    fixture.restore();
  }
});
