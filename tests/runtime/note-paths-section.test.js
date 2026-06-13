const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Regression: renderNotePathsSection referenced four symbols that the locale
// refactor deleted (localeDefaults, metaLocaleDefaults, metaPreviewKeys, and
// deriveMetaPathsFromRoot — the last also dropped from settings-utils exports).
// Rendering the "Note locations" settings section therefore threw a
// ReferenceError, so the Meta-root field and meta preview never appeared.
function loadSettingsSection() {
  const originalLoad = Module._load;
  const captured = { settings: [] };

  class TextMock {
    setPlaceholder() { return this; }
    setValue() { return this; }
    onChange() { return this; }
  }
  class SettingMock {
    constructor() { captured.settings.push(this); }
    setName(name) { this.name = name; return this; }
    setDesc(desc) { this.desc = desc; return this; }
    setHeading() { this.heading = true; return this; }
    addText(cb) { this.text = new TextMock(); cb(this.text); return this; }
    addDropdown(cb) { this.dropdown = { addOption() { return this; }, setValue() { return this; }, onChange() { return this; } }; cb(this.dropdown); return this; }
    addButton(cb) { this.button = { setButtonText() { return this; }, setTooltip() { return this; }, setDisabled() { return this; }, onClick() { return this; } }; cb(this.button); return this; }
    addToggle(cb) { this.toggle = { setValue() { return this; }, onChange() { return this; } }; cb(this.toggle); return this; }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return { Setting: SettingMock, Notice: class {}, Platform: {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("../../runtime/settings/basic-settings-section-methods");
  delete require.cache[modulePath];
  const { basicSettingsSectionMethods } = require(modulePath);
  return {
    methods: basicSettingsSectionMethods,
    captured,
    restore() {
      Module._load = originalLoad;
      delete require.cache[modulePath];
    },
  };
}

function fakeContainer() {
  return {
    createEl() { return fakeContainer(); },
    createDiv() { return fakeContainer(); },
    createSpan() { return fakeContainer(); },
    querySelector() { return null; },
    remove() {},
    empty() {},
  };
}

function runRender(fixture, locale) {
  const plugin = {
    getEffectiveLocale: () => locale,
    settings: {},
    async saveSettings() {},
  };
  const self = Object.assign({}, fixture.methods, { plugin, display() {} });
  const t = (key, fallback) => fallback;
  self.renderNotePathsSection(fakeContainer(), t);
  return plugin;
}

test("renderNotePathsSection renders without throwing (en) and shows the Meta root field", () => {
  const fixture = loadSettingsSection();
  try {
    const plugin = runRender(fixture, "en");
    const metaRoot = fixture.captured.settings.find((s) => s.name === "Meta root");
    assert.ok(metaRoot, "Meta root setting should render");
    // metaPaths defaulted in-place and derived without ReferenceError.
    assert.ok(plugin.settings.metaPaths && typeof plugin.settings.metaPaths === "object");
    assert.ok(plugin.settings.metaPaths.templates, "derived meta templates path should be populated");
  } finally {
    fixture.restore();
  }
});

test("renderNotePathsSection renders without throwing (zh-CN) and shows the Meta root field", () => {
  const fixture = loadSettingsSection();
  try {
    runRender(fixture, "zh-CN");
    const metaRoot = fixture.captured.settings.find((s) => s.name === "Meta 根目录");
    assert.ok(metaRoot, "Meta 根目录 setting should render");
  } finally {
    fixture.restore();
  }
});

test("renderNotePathsSection renders without throwing (ru)", () => {
  const fixture = loadSettingsSection();
  try {
    const plugin = runRender(fixture, "ru");
    assert.ok(plugin.settings.metaPaths.templates);
  } finally {
    fixture.restore();
  }
});
