const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveAgentProvider,
  buildProviderFromSpec,
} = require("../../../runtime/agent/agent-provider-resolver");
const {
  defaultAgentSettings,
  migrateAgentSettings,
  setApiKeyFor,
  switchActiveProvider,
} = require("../../../runtime/agent/agent-settings");
const { PROVIDERS } = require("../../../runtime/providers/registry");

const fakeRequestImpl = async () => ({ status: 200, text() { return Promise.resolve(""); } });

test("resolveAgentProvider builds an anthropic-messages Provider for DeepSeek", () => {
  const s = defaultAgentSettings();
  setApiKeyFor(s, "deepseek", "sk-deepseek");
  const provider = resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
  assert.equal(provider.id, "deepseek");
  assert.equal(provider.spec.protocol, "anthropic-messages");
  assert.equal(provider.userConfig.apiKey, "sk-deepseek");
  assert.equal(provider.userConfig.model, "deepseek-v4-flash");
});

test("persisted DeepSeek reasoning mode reaches the outgoing request body", async () => {
  const input = { model: "deepseek-v4-flash", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxTokens: 256 };
  const response = { status: 200, text: async () => JSON.stringify({ content: [], stop_reason: "end_turn", usage: {} }) };
  for (const [savedMode, expectedThinking, expectedEffort] of [
    [undefined, "enabled", "low"],
    ["high", "enabled", "high"],
    ["disabled", "disabled", undefined],
    ["invalid", "enabled", "low"],
  ]) {
    const saved = { agentProvider: { mode: "direct", direct: { providerId: "deepseek", apiKeys: { deepseek: "test-key" }, stream: false } } };
    if (savedMode !== undefined) saved.agentProvider.direct.reasoningMode = savedMode;
    migrateAgentSettings(saved);
    let requestBody;
    const provider = resolveAgentProvider(saved.agentProvider, { requestImpl: async (request) => {
      requestBody = JSON.parse(request.body);
      return response;
    } });
    for await (const _event of provider.createMessage(input)) { /* consume response */ }
    assert.equal(requestBody.model, input.model);
    assert.equal(requestBody.thinking.type, expectedThinking);
    assert.equal(requestBody.output_config && requestBody.output_config.effort, expectedEffort);
    assert.equal("budget_tokens" in requestBody, false);
  }
});

test("another Anthropic-compatible provider receives no DeepSeek thinking parameters", async () => {
  const settings = defaultAgentSettings();
  switchActiveProvider(settings, "zhipu-glm");
  settings.direct.reasoningMode = "high";
  settings.direct.stream = false;
  setApiKeyFor(settings, "zhipu-glm", "test-key");
  let requestBody;
  const provider = resolveAgentProvider(settings, { requestImpl: async (request) => {
    requestBody = JSON.parse(request.body);
    return { status: 200, text: async () => JSON.stringify({ content: [], stop_reason: "end_turn", usage: {} }) };
  } });
  for await (const _event of provider.createMessage({ model: settings.direct.model, messages: [], maxTokens: 256 })) { /* consume response */ }
  assert.equal("reasoningMode" in provider.userConfig, false);
  assert.equal("thinking" in requestBody, false);
  assert.equal("output_config" in requestBody, false);
});

test("resolveAgentProvider builds an openai-chat Provider for OpenAI official", () => {
  const s = defaultAgentSettings();
  switchActiveProvider(s, "openai-official");
  setApiKeyFor(s, "openai-official", "sk-openai");
  const provider = resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
  assert.equal(provider.id, "openai-official");
  assert.equal(provider.spec.protocol, "openai-chat");
});

test("resolveAgentProvider builds the right Provider for each preset", () => {
  const presets = [
    { id: "deepseek",          protocol: "anthropic-messages" },
    { id: "anthropic-official", protocol: "anthropic-messages" },
    { id: "zhipu-glm",         protocol: "anthropic-messages" },
    { id: "minimax",           protocol: "anthropic-messages" },
    { id: "moonshot-kimi",     protocol: "openai-chat" },
    { id: "qwen",              protocol: "openai-chat" },
    { id: "doubao",            protocol: "openai-chat" },
    { id: "openai-official",   protocol: "openai-chat" },
    { id: "openrouter",        protocol: "openai-chat" },
  ];
  for (const { id, protocol, noKey } of presets) {
    const s = defaultAgentSettings();
    switchActiveProvider(s, id);
    if (id === "doubao") s.direct.model = "ep-test";
    if (!noKey) setApiKeyFor(s, id, `k-${id}`);
    const provider = resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
    assert.equal(provider.id, id, `provider id mismatch for ${id}`);
    assert.equal(provider.spec.protocol, protocol, `protocol mismatch for ${id}`);
    assert.equal(provider.userConfig.apiKey, noKey ? "" : `k-${id}`);
  }
});

test("resolveAgentProvider allows Ollama without API key", () => {
  const s = defaultAgentSettings();
  switchActiveProvider(s, "ollama");
  const provider = resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
  assert.equal(provider.id, "ollama");
  assert.equal(provider.userConfig.apiKey, "");
  assert.equal(provider.userConfig.model, "llama3.2");
});

test("resolveAgentProvider throws MISSING_API_KEY when key not set", () => {
  const s = defaultAgentSettings();
  // no setApiKeyFor — key absent
  try {
    resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
    assert.fail("expected throw");
  } catch (e) {
    assert.equal(e.code, "MISSING_API_KEY");
    assert.equal(e.providerId, "deepseek");
  }
});

test("resolveAgentProvider throws OPENCODE_LEGACY_NOT_BRIDGED in opencode-legacy mode", () => {
  const s = defaultAgentSettings();
  s.mode = "opencode-legacy";
  try {
    resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
    assert.fail("expected throw");
  } catch (e) {
    assert.equal(e.code, "OPENCODE_LEGACY_NOT_BRIDGED");
  }
});

test("resolveAgentProvider throws when enabled is false", () => {
  const s = defaultAgentSettings();
  s.enabled = false;
  setApiKeyFor(s, "deepseek", "k");
  assert.throws(() => resolveAgentProvider(s, { requestImpl: fakeRequestImpl }), /disabled/);
});

test("resolveAgentProvider throws MISSING_BASE_URL for custom OpenAI-compat with no base URL", () => {
  const s = defaultAgentSettings();
  switchActiveProvider(s, "openai-compat-custom");
  setApiKeyFor(s, "openai-compat-custom", "k");
  s.direct.model = "custom-model";
  try {
    resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
    assert.fail("expected throw");
  } catch (e) {
    assert.equal(e.code, "MISSING_BASE_URL");
  }
});

test("resolveAgentProvider returns a working Provider for custom OpenAI-compat when base URL is set", () => {
  const s = defaultAgentSettings();
  switchActiveProvider(s, "openai-compat-custom");
  setApiKeyFor(s, "openai-compat-custom", "k");
  s.direct.model = "custom-model";
  s.direct.baseUrlOverride = "https://my-relay.example.com/v1";
  const p = resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
  assert.equal(p.id, "openai-compat-custom");
  assert.equal(p.userConfig.baseUrlOverride, "https://my-relay.example.com/v1");
});

test("buildProviderFromSpec dispatches by protocol", () => {
  const a = buildProviderFromSpec({
    spec: PROVIDERS.deepseek,
    userConfig: { providerId: "deepseek", mode: "api", apiKey: "k", model: "deepseek-v4-flash" },
    requestImpl: fakeRequestImpl,
  });
  assert.equal(a.spec.protocol, "anthropic-messages");

  const b = buildProviderFromSpec({
    spec: PROVIDERS["openai-official"],
    userConfig: { providerId: "openai-official", mode: "api", apiKey: "k", model: "gpt-5.5" },
    requestImpl: fakeRequestImpl,
  });
  assert.equal(b.spec.protocol, "openai-chat");
});

test("buildProviderFromSpec throws on opencode-runtime spec", () => {
  assert.throws(
    () => buildProviderFromSpec({
      spec: PROVIDERS["opencode-legacy"],
      userConfig: { providerId: "opencode-legacy", mode: "runtime", apiKey: "", model: "" },
    }),
    /unsupported protocol/,
  );
});

test("resolveAgentProvider threads region and stream choice through to userConfig", () => {
  const s = defaultAgentSettings();
  switchActiveProvider(s, "zhipu-glm");
  s.direct.region = "intl";
  s.direct.stream = false;
  setApiKeyFor(s, "zhipu-glm", "k");
  const p = resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
  assert.equal(p.userConfig.region, "intl");
  assert.equal(p.userConfig.stream, false);
});

test("resolveAgentProvider throws if no settings object provided", () => {
  assert.throws(() => resolveAgentProvider(null), /settings required/);
});
