const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Regression: the inline (composer) model picker only consulted the live model
// catalog for Ollama, so for OpenRouter — whose registry ships a single
// placeholder ("openrouter/auto") while the real catalog is hundreds of models
// from the API — the picker had nothing to switch to. The user could only
// change models from Settings. buildDirectModelOptions now merges the fetched
// catalog for any placeholder-list provider and always keeps the current model.
function loadSharedUtils() {
  const originalLoad = Module._load;
  const modulePath = require.resolve("../../runtime/view/layout/shared-utils");
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return { setIcon() {}, Notice: class {}, Platform: { isMobile: false } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  const loaded = require(modulePath);
  return {
    buildDirectModelOptions: loaded.buildDirectModelOptions,
    restore() {
      Module._load = originalLoad;
      delete require.cache[modulePath];
    },
  };
}

function makeView({ providerId, model, fetched }) {
  return {
    plugin: {
      settings: { agentProvider: { mode: "direct", direct: { providerId, model, providerMode: "api", apiKeys: {} } } },
      __flownoteFetchedModels: fetched ? { [providerId]: { models: fetched, fetchedAt: 1 } } : {},
    },
  };
}

test("OpenRouter inline picker lists the fetched catalog (more than the single placeholder)", () => {
  const fx = loadSharedUtils();
  try {
    const view = makeView({
      providerId: "openrouter",
      model: "openrouter/auto",
      fetched: [{ id: "openai/gpt-5" }, { id: "anthropic/claude-sonnet-4.6" }, { id: "meta-llama/llama-3.1-8b-instruct:free" }],
    });
    const opts = fx.buildDirectModelOptions(view);
    const ids = opts.map((o) => o.id);
    assert.ok(ids.length >= 3, `expected a switchable catalog, got ${ids.length}`);
    assert.ok(ids.includes("openai/gpt-5"));
    assert.ok(ids.includes("meta-llama/llama-3.1-8b-instruct:free"));
    // The registry placeholder + current model remain present/selectable.
    assert.ok(ids.includes("openrouter/auto"));
  } finally {
    fx.restore();
  }
});

test("the currently-selected model is always selectable even if absent from both lists", () => {
  const fx = loadSharedUtils();
  try {
    const view = makeView({
      providerId: "openrouter",
      model: "some-vendor/custom-model",
      fetched: [{ id: "openai/gpt-5" }],
    });
    const ids = fx.buildDirectModelOptions(view).map((o) => o.id);
    assert.ok(ids.includes("some-vendor/custom-model"), "current model must stay selectable");
    assert.ok(ids.includes("openai/gpt-5"));
  } finally {
    fx.restore();
  }
});

test("a curated multi-model provider keeps its static registry list (no behavior change)", () => {
  const fx = loadSharedUtils();
  try {
    const view = makeView({ providerId: "deepseek", model: "deepseek-v4-flash", fetched: null });
    const ids = fx.buildDirectModelOptions(view).map((o) => o.id);
    assert.ok(ids.length > 1, "multi-model provider should expose its full registry list");
    assert.ok(ids.includes("deepseek-v4-flash"));
  } finally {
    fx.restore();
  }
});
