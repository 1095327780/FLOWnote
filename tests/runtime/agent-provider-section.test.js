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
    assert.equal(plugin.settings.agentProvider.direct.model, "glm-5.1");
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

test("isOllamaCloudModelId distinguishes ollama.com cloud models from local ones", () => {
  const fixture = loadAgentProviderSectionWithPlatform({ isMobile: false });
  try {
    for (const id of ["gpt-oss:120b-cloud", "deepseek-v3.1:671b-cloud", "qwen3-coder:480b-cloud", "glm-4.6:cloud"]) {
      assert.equal(fixture.isOllamaCloudModelId(id), true, id);
    }
    for (const id of ["llama3.2", "qwen2.5-coder:7b", "deepseek-r1:8b", "mistral"]) {
      assert.equal(fixture.isOllamaCloudModelId(id), false, id);
    }
  } finally {
    fixture.restore();
  }
});

test("adoptOllamaModelFromList never silently selects a cloud model", async () => {
  // Regression: refreshOllamaModelListNow used to set agent.direct.model = list[0],
  // which could be an ollama.com cloud model → the next chat failed with a
  // sign-in/subscription error the user read as "升级订阅".
  const fixture = loadAgentProviderSectionWithPlatform({ isMobile: false });
  try {
    // Saved model not installed; list has a cloud model FIRST, then a local one.
    {
      const agent = { direct: { model: "llama3.2" } };
      let saved = 0;
      const plugin = { saveSettings: async () => { saved += 1; } };
      const list = [{ id: "gpt-oss:120b-cloud" }, { id: "qwen2.5-coder:7b" }];
      const changed = await fixture.adoptOllamaModelFromList({ plugin, agent, list });
      assert.equal(changed, true);
      assert.equal(agent.direct.model, "qwen2.5-coder:7b", "must adopt the LOCAL model, not the cloud one");
      assert.equal(saved, 1);
    }
    // Saved model not installed; ONLY cloud models available → leave it untouched.
    {
      const agent = { direct: { model: "llama3.2" } };
      let saved = 0;
      const plugin = { saveSettings: async () => { saved += 1; } };
      const list = [{ id: "gpt-oss:120b-cloud" }, { id: "deepseek-v3.1:671b-cloud" }];
      const changed = await fixture.adoptOllamaModelFromList({ plugin, agent, list });
      assert.equal(changed, false);
      assert.equal(agent.direct.model, "llama3.2", "must NOT trap the user on a cloud model");
      assert.equal(saved, 0);
    }
    // Saved model is installed → no change at all.
    {
      const agent = { direct: { model: "qwen2.5-coder:7b" } };
      let saved = 0;
      const plugin = { saveSettings: async () => { saved += 1; } };
      const list = [{ id: "qwen2.5-coder:7b" }, { id: "gpt-oss:120b-cloud" }];
      const changed = await fixture.adoptOllamaModelFromList({ plugin, agent, list });
      assert.equal(changed, false);
      assert.equal(agent.direct.model, "qwen2.5-coder:7b");
      assert.equal(saved, 0);
    }
  } finally {
    fixture.restore();
  }
});
