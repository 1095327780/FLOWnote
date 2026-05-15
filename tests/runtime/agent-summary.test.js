const test = require("node:test");
const assert = require("node:assert/strict");

const { summarizeActiveAgent } = require("../../runtime/view/layout/agent-summary");

function makePlugin({ mode, providerId, model, apiKey } = {}) {
  return {
    settings: {
      agentProvider: {
        mode,
        direct: {
          providerId,
          model,
          apiKeys: apiKey ? { [providerId]: apiKey } : {},
        },
      },
    },
  };
}

test("summarizeActiveAgent: opencode-legacy returns OpenCode label and skips API check", () => {
  const plugin = makePlugin({ mode: "opencode-legacy" });
  const s = summarizeActiveAgent(plugin);
  assert.equal(s.mode, "opencode-legacy");
  assert.equal(s.providerLabel, "OpenCode");
  assert.equal(s.configComplete, true);
});

test("summarizeActiveAgent: direct mode with everything set is configComplete", () => {
  const plugin = makePlugin({
    mode: "direct",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    apiKey: "sk-test",
  });
  const s = summarizeActiveAgent(plugin);
  assert.equal(s.mode, "direct");
  assert.match(s.providerLabel, /DeepSeek/i);
  assert.equal(s.modelId, "deepseek-v4-flash");
  assert.ok(s.modelLabel);
  assert.equal(s.hasApiKey, true);
  assert.equal(s.configComplete, true);
  assert.equal(s.missingReason, undefined);
});

test("summarizeActiveAgent: direct mode without API key flags missingReason", () => {
  const plugin = makePlugin({
    mode: "direct",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
  });
  const s = summarizeActiveAgent(plugin);
  assert.equal(s.hasApiKey, false);
  assert.equal(s.configComplete, false);
  assert.match(s.missingReason, /API Key/);
});

test("summarizeActiveAgent: direct mode without model flags missingReason", () => {
  const plugin = makePlugin({
    mode: "direct",
    providerId: "deepseek",
    model: "",
    apiKey: "sk-test",
  });
  const s = summarizeActiveAgent(plugin);
  assert.equal(s.configComplete, false);
  assert.match(s.missingReason, /模型/);
});

test("summarizeActiveAgent: direct mode with unknown provider flags missingReason", () => {
  const plugin = makePlugin({
    mode: "direct",
    providerId: "not-a-real-provider",
    model: "x",
    apiKey: "sk-test",
  });
  const s = summarizeActiveAgent(plugin);
  assert.equal(s.configComplete, false);
  assert.match(s.missingReason, /服务商/);
});

test("summarizeActiveAgent: undefined plugin doesn't crash", () => {
  const s = summarizeActiveAgent(undefined);
  // Defaults to direct + 未配置
  assert.equal(s.mode, "direct");
  assert.equal(s.configComplete, false);
});
