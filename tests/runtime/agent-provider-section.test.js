const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { defaultAgentSettings } = require("../../runtime/agent/agent-settings");
const { normalizeSettings } = require("../../runtime/settings-utils");

function loadAgentProviderSectionWithPlatform(platform) {
  const originalLoad = Module._load;
  const captured = { settings: [] };
  class DropdownMock {
    constructor() {
      this.options = [];
      this.value = "";
      this.selectEl = { value: "" };
      this.changeHandler = null;
    }
    addOption(value, text) {
      this.options.push({ value, text });
      return this;
    }
    setValue(value) {
      this.value = String(value || "");
      this.selectEl.value = this.value;
      return this;
    }
    getValue() {
      return String(this.selectEl.value || "");
    }
    onChange(handler) {
      this.changeHandler = handler;
      return this;
    }
  }
  class TextMock {
    constructor() {
      this.inputEl = {};
    }
    setPlaceholder() { return this; }
    setValue(value) { this.value = value; return this; }
    onChange(handler) { this.changeHandler = handler; return this; }
  }
  class ButtonMock {
    constructor() {
      this.buttonEl = { textContent: "" };
    }
    setButtonText(text) { this.buttonEl.textContent = text; return this; }
    setTooltip() { return this; }
    setDisabled() { return this; }
    onClick(handler) { this.clickHandler = handler; return this; }
  }
  class ToggleMock {
    setValue(value) { this.value = value; return this; }
    onChange(handler) { this.changeHandler = handler; return this; }
  }
  class SettingMock {
    constructor() {
      captured.settings.push(this);
    }
    setName(name) { this.name = name; return this; }
    setDesc(desc) { this.desc = desc; return this; }
    setHeading() { this.heading = true; return this; }
    addDropdown(cb) {
      this.dropdown = new DropdownMock();
      cb(this.dropdown);
      return this;
    }
    addText(cb) {
      this.text = new TextMock();
      cb(this.text);
      return this;
    }
    addButton(cb) {
      this.button = new ButtonMock();
      cb(this.button);
      return this;
    }
    addToggle(cb) {
      this.toggle = new ToggleMock();
      cb(this.toggle);
      return this;
    }
  }
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Setting: SettingMock,
        Notice: class NoticeMock {},
        Platform: platform || {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("../../runtime/settings/agent-provider-section-methods");
  delete require.cache[modulePath];
  const loaded = require(modulePath);
  return {
    ...loaded,
    captured,
    restore() {
      Module._load = originalLoad;
      delete require.cache[modulePath];
    },
  };
}

test("getEffectiveAgentProviderMode keeps persisted OpenCode mode on desktop", () => {
  const fixture = loadAgentProviderSectionWithPlatform({ isMobile: false });
  const agent = { mode: "opencode-legacy" };

  try {
    assert.equal(fixture.getEffectiveAgentProviderMode(agent, { isMobile: false }), "opencode-legacy");
    assert.equal(agent.mode, "opencode-legacy");
  } finally {
    fixture.restore();
  }
});

function fakeContainer() {
  return {
    createEl() { return fakeContainer(); },
    createDiv() { return fakeContainer(); },
    empty() {},
  };
}

test("provider dropdown persists the component value even if callback arg is stale", async () => {
  const fixture = loadAgentProviderSectionWithPlatform({ isMobile: false });
  const plugin = {
    settings: normalizeSettings({
      agentProviderModePreference: "direct",
      agentProvider: defaultAgentSettings(),
    }),
    async saveSettings() {
      this.settings = normalizeSettings(this.settings);
    },
  };

  try {
    let refreshed = false;
    fixture.renderAgentProviderSection({
      containerEl: fakeContainer(),
      plugin,
      tab: {},
      refresh: () => { refreshed = true; },
    });

    const providerSetting = fixture.captured.settings.find((setting) => setting.name === "服务商");
    assert.ok(providerSetting && providerSetting.dropdown, "provider dropdown should render");
    const agentRef = plugin.settings.agentProvider;
    const directRef = plugin.settings.agentProvider.direct;

    fixture.renderAgentProviderAdvanced({
      containerEl: fakeContainer(),
      plugin,
      tab: {},
    });
    assert.equal(plugin.settings.agentProvider, agentRef);
    assert.equal(plugin.settings.agentProvider.direct, directRef);

    providerSetting.dropdown.selectEl.value = "zhipu-glm";
    await providerSetting.dropdown.changeHandler("deepseek");

    assert.equal(plugin.settings.agentProvider.direct.providerId, "zhipu-glm");
    assert.equal(plugin.settings.agentProvider.direct.providerMode, "coding-plan");
    assert.equal(plugin.settings.agentProvider.direct.model, "glm-4.7-flash");
    assert.equal(refreshed, true);
  } finally {
    fixture.restore();
  }
});

test("getEffectiveAgentProviderMode uses direct on mobile without mutating persisted OpenCode mode", () => {
  const fixture = loadAgentProviderSectionWithPlatform({ isMobile: true });
  const agent = { mode: "opencode-legacy" };

  try {
    assert.equal(fixture.getEffectiveAgentProviderMode(agent, { isMobile: true }), "direct");
    assert.equal(agent.mode, "opencode-legacy");
  } finally {
    fixture.restore();
  }
});
