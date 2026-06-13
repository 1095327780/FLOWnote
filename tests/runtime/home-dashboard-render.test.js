const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Regression: renderHomeDashboard once referenced an undeclared `homeSettings`,
// so every data producer threw a ReferenceError that resolveHomeData swallowed
// into the fallback — the dashboard silently rendered all-zeros for every user.
// This test loads home-methods with a spy home-service and asserts the data
// producers are actually invoked with a defined settings object.
function loadHomeMethodsWithSpies() {
  const calls = { dashboard: [], today: [], projects: [], recent: [], heatmap: [] };
  const homeServiceStub = {
    findOrCreateTodayDailyNote: () => null,
    getDailyActivityHeatmap: (app, settings) => { calls.heatmap.push(settings); return { cells: [] }; },
    getDashboardStats: (app, settings) => { calls.dashboard.push(settings); return { activeProjects: 0, knowledgeAssets: 0 }; },
    getTodayState: (app, settings) => { calls.today.push(settings); return {}; },
    listProjects: (app, settings) => { calls.projects.push(settings); return []; },
    listRecentFiles: (app, settings) => { calls.recent.push(settings); return []; },
    toggleTaskInFile: () => null,
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return { Notice: function () {}, setIcon() {} };
    }
    if (/home[\\/]home-service$/.test(request)) {
      return homeServiceStub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const homePath = require.resolve("../../runtime/view/layout/home-methods");
  delete require.cache[homePath];
  const { homeMethods } = require(homePath);

  return {
    homeMethods,
    calls,
    restore() {
      Module._load = originalLoad;
      delete require.cache[homePath];
    },
  };
}

function fakeEl() {
  return {
    empty() {},
    addClass() { return this; },
    removeClass() { return this; },
    createDiv() { return fakeEl(); },
    createEl() { return fakeEl(); },
    createSpan() { return fakeEl(); },
    setText() { return this; },
    setAttr() { return this; },
    appendChild() { return this; },
    addEventListener() {},
  };
}

test("renderHomeDashboard feeds producers a defined, locale-tagged settings object", () => {
  const fixture = loadHomeMethodsWithSpies();
  try {
    const view = {
      plugin: {
        getEffectiveLocale: () => "en",
        settings: { uiLanguage: "auto", notePaths: { dailyNotes: "Daily" } },
      },
      app: {},
      homeRenderRun: 0,
      bindHomeScrollTracking() {},
    };

    fixture.homeMethods.renderHomeDashboard.call(view, fakeEl());
    // Cancel the async render branch so it can't run after assertions.
    view.homeRenderRun = -1;

    // Each producer ran synchronously inside resolveHomeData. With the bug they
    // would have thrown and never been recorded.
    assert.equal(fixture.calls.dashboard.length, 1, "getDashboardStats was not invoked (ReferenceError regression)");
    const settings = fixture.calls.dashboard[0];
    assert.ok(settings && typeof settings === "object", "settings must be a defined object");
    assert.equal(settings.uiLanguage, "en", "homeSettings must carry the effective locale");
    assert.equal(settings.notePaths.dailyNotes, "Daily", "homeSettings must spread plugin settings");
    assert.equal(fixture.calls.today.length, 1);
    assert.equal(fixture.calls.projects.length, 1);
    assert.equal(fixture.calls.recent.length, 1);
    assert.equal(fixture.calls.heatmap.length, 1);
  } finally {
    fixture.restore();
  }
});
