const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveAgentProvider,
  buildProviderFromSpec,
} = require("../../../runtime/agent/agent-provider-resolver");
const {
  defaultAgentSettings,
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
    { id: "moonshot-kimi",     protocol: "anthropic-messages" },
    { id: "qwen",              protocol: "openai-chat" },
    { id: "doubao",            protocol: "openai-chat" },
    { id: "openai-official",   protocol: "openai-chat" },
  ];
  for (const { id, protocol } of presets) {
    const s = defaultAgentSettings();
    switchActiveProvider(s, id);
    setApiKeyFor(s, id, `k-${id}`);
    const provider = resolveAgentProvider(s, { requestImpl: fakeRequestImpl });
    assert.equal(provider.id, id, `provider id mismatch for ${id}`);
    assert.equal(provider.spec.protocol, protocol, `protocol mismatch for ${id}`);
    assert.equal(provider.userConfig.apiKey, `k-${id}`);
  }
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
    userConfig: { providerId: "openai-official", mode: "api", apiKey: "k", model: "gpt-5.4" },
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
