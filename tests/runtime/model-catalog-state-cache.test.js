const test = require("node:test");
const assert = require("node:assert/strict");

const { modelCatalogMethods } = require("../../runtime/plugin/model-catalog-methods");

function createFixture() {
  const fixture = {
    runtimeState: {},
    settings: { defaultModel: "" },
    log() {},
    getAssistantView() {
      return null;
    },
  };
  Object.assign(fixture, modelCatalogMethods);
  return fixture;
}

test("model catalog cache should be persisted in runtimeState", () => {
  const fixture = createFixture();

  const wrote = fixture.writeModelCacheToRuntimeState(
    ["openai/gpt-4o", "opencode/minimax-m2.5-free"],
    ["openai"],
  );
  assert.equal(wrote, true);
  assert.ok(fixture.runtimeState.modelCatalogCache);

  const cache = fixture.readModelCacheFromRuntimeState();
  assert.ok(cache);
  assert.deepEqual(cache.models, ["openai/gpt-4o", "opencode/minimax-m2.5-free"]);
  assert.deepEqual(cache.connectedProviders, ["openai"]);
});

test("model catalog terminal output aliases should resolve to runtimeState cache", () => {
  const fixture = createFixture();

  fixture.writeModelCacheToTerminalOutput(["openai/gpt-4.1"], ["openai"]);
  const models = fixture.loadModelCatalogFromTerminalOutput();

  assert.deepEqual(models, ["openai/gpt-4.1"]);
  assert.deepEqual(fixture.cachedModels, ["openai/gpt-4.1"]);
});
