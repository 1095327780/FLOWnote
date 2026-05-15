// Tests for provider.listModels() — the dynamic /v1/models fetch
// surfaced on both protocol adapters. The settings UI calls this on
// "刷新模型列表" to keep the model dropdown current without code
// changes when a vendor adds a model.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAnthropicMessagesProvider,
} = require("../../runtime/providers/anthropic-messages-adapter");
const {
  createOpenAIChatProvider,
} = require("../../runtime/providers/openai-chat-adapter");

function makeRequestRecorder(responses) {
  const calls = [];
  let i = 0;
  const requestImpl = async (args) => {
    calls.push(args);
    const next = responses[i++];
    if (!next) throw new Error(`requestImpl: no more queued responses (call ${i})`);
    return next;
  };
  return { calls, requestImpl };
}

// ---------------------------------------------------------------------
// openai-chat-adapter: listModels hits <baseUrl>/models
// ---------------------------------------------------------------------

test("openai-chat listModels: GET <baseUrl>/models, parses {data:[{id}]}", async () => {
  const spec = {
    id: "test-openai",
    displayName: "Test",
    protocol: "openai-chat",
    auth: { headerName: "Authorization", scheme: "bearer" },
    modes: { api: { label: "API", baseUrl: "https://api.example.com/v1" } },
    defaultMode: "api",
    models: [],
  };
  const userConfig = { providerId: "test-openai", mode: "api", apiKey: "sk-test" };
  const { calls, requestImpl } = makeRequestRecorder([
    {
      status: 200,
      json: { data: [{ id: "gpt-foo" }, { id: "gpt-bar" }] },
    },
  ]);
  const provider = createOpenAIChatProvider({ spec, userConfig, requestImpl });

  const out = await provider.listModels();
  assert.equal(calls[0].url, "https://api.example.com/v1/models");
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].headers.Authorization, /Bearer sk-test/);
  // Sorted alphabetically
  assert.deepEqual(out.map((m) => m.id), ["gpt-bar", "gpt-foo"]);
});

test("openai-chat listModels: non-2xx response throws with status", async () => {
  const spec = {
    id: "t",
    displayName: "T",
    protocol: "openai-chat",
    auth: { headerName: "Authorization", scheme: "bearer" },
    modes: { api: { label: "API", baseUrl: "https://api.example.com/v1" } },
    defaultMode: "api",
    models: [],
  };
  const userConfig = { providerId: "t", mode: "api", apiKey: "k" };
  const { requestImpl } = makeRequestRecorder([{ status: 401, json: { error: "bad key" } }]);
  const provider = createOpenAIChatProvider({ spec, userConfig, requestImpl });
  await assert.rejects(() => provider.listModels(), /401/);
});

test("openai-chat listModels: skips entries with no id", async () => {
  const spec = {
    id: "t",
    displayName: "T",
    protocol: "openai-chat",
    auth: { headerName: "Authorization", scheme: "bearer" },
    modes: { api: { label: "API", baseUrl: "https://api.example.com/v1" } },
    defaultMode: "api",
    models: [],
  };
  const userConfig = { providerId: "t", mode: "api", apiKey: "k" };
  const { requestImpl } = makeRequestRecorder([
    {
      status: 200,
      json: { data: [{ id: "valid" }, {}, { id: "" }, null, { id: "another" }] },
    },
  ]);
  const provider = createOpenAIChatProvider({ spec, userConfig, requestImpl });
  const out = await provider.listModels();
  assert.deepEqual(out.map((m) => m.id), ["another", "valid"]);
});

// ---------------------------------------------------------------------
// anthropic-messages-adapter: listModels uses sibling /v1/models
// ---------------------------------------------------------------------

test("anthropic-messages listModels: strips /anthropic, appends /v1/models", async () => {
  const spec = {
    id: "deepseek-test",
    displayName: "DeepSeek Test",
    protocol: "anthropic-messages",
    auth: { headerName: "Authorization", scheme: "bearer" },
    modes: { api: { label: "API", baseUrl: "https://api.deepseek.com/anthropic" } },
    defaultMode: "api",
    versionHeader: "anthropic-version: 2026-01-01",
    models: [],
  };
  const userConfig = { providerId: "deepseek-test", mode: "api", apiKey: "sk-deepseek" };
  const { calls, requestImpl } = makeRequestRecorder([
    {
      status: 200,
      json: { data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] },
    },
  ]);
  const provider = createAnthropicMessagesProvider({ spec, userConfig, requestImpl });
  const out = await provider.listModels();
  // Strips /anthropic → /v1/models
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/models");
  assert.match(calls[0].headers.Authorization, /Bearer sk-deepseek/);
  assert.deepEqual(out.map((m) => m.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

test("anthropic-messages listModels: uses modelsListEndpoint override when set", async () => {
  const spec = {
    id: "weird",
    displayName: "Weird",
    protocol: "anthropic-messages",
    auth: { headerName: "Authorization", scheme: "bearer" },
    modes: { api: { label: "API", baseUrl: "https://api.weird.com/messages" } }, // no /anthropic
    defaultMode: "api",
    modelsListEndpoint: "https://catalog.weird.com/list",
    models: [],
  };
  const userConfig = { providerId: "weird", mode: "api", apiKey: "k" };
  const { calls, requestImpl } = makeRequestRecorder([
    {
      status: 200,
      json: { data: [{ id: "x" }] },
    },
  ]);
  const provider = createAnthropicMessagesProvider({ spec, userConfig, requestImpl });
  await provider.listModels();
  assert.equal(calls[0].url, "https://catalog.weird.com/list");
});

test("anthropic-messages listModels: throws 'not supported' when neither endpoint nor /anthropic suffix", async () => {
  const spec = {
    id: "no-list",
    displayName: "Anthropic-native-style",
    protocol: "anthropic-messages",
    auth: { headerName: "x-api-key", scheme: "raw" },
    modes: { api: { label: "API", baseUrl: "https://api.anthropic.com/v1" } },
    defaultMode: "api",
    models: [],
  };
  const userConfig = { providerId: "no-list", mode: "api", apiKey: "k" };
  const { requestImpl } = makeRequestRecorder([]);
  const provider = createAnthropicMessagesProvider({ spec, userConfig, requestImpl });
  await assert.rejects(() => provider.listModels(), /does not advertise/);
});

test("anthropic-messages listModels: switches x-api-key spec to Bearer auth for /v1/models call", async () => {
  // Anthropic-native uses x-api-key for /v1/messages but if a vendor
  // happens to also expose a /v1/models endpoint (some don't), we need
  // to send Bearer for it. Verified here on a hypothetical custom spec.
  const spec = {
    id: "anth-custom",
    displayName: "Custom Anthropic-compat with list endpoint",
    protocol: "anthropic-messages",
    auth: { headerName: "x-api-key", scheme: "raw" },
    modes: { api: { label: "API", baseUrl: "https://api.anth.com/anthropic" } },
    defaultMode: "api",
    models: [],
  };
  const userConfig = { providerId: "anth-custom", mode: "api", apiKey: "secret-key" };
  const { calls, requestImpl } = makeRequestRecorder([
    { status: 200, json: { data: [{ id: "m1" }] } },
  ]);
  const provider = createAnthropicMessagesProvider({ spec, userConfig, requestImpl });
  await provider.listModels();
  assert.equal(calls[0].headers["x-api-key"], undefined);
  assert.equal(calls[0].headers.Authorization, "Bearer secret-key");
});
