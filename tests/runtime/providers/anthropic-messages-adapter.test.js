const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAnthropicMessagesProvider,
  buildHeaders,
  buildRequestBody,
  buildEndpointUrl,
  stripUnsupportedParams,
} = require("../../../runtime/providers/anthropic-messages-adapter");
const { PROVIDERS } = require("../../../runtime/providers/registry");

function deepseekUserConfig(over = {}) {
  return {
    providerId: "deepseek",
    mode: "api",
    apiKey: "sk-test-deepseek",
    model: "deepseek-v4-flash",
    ...over,
  };
}

function anthropicUserConfig(over = {}) {
  return {
    providerId: "anthropic-official",
    mode: "api",
    apiKey: "sk-ant-test",
    model: "claude-sonnet-4-6",
    ...over,
  };
}

function minimaxUserConfig(over = {}) {
  return {
    providerId: "minimax",
    mode: "coding-plan",
    apiKey: "mm-test",
    model: "MiniMax-M2.7-highspeed",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Header building
// ---------------------------------------------------------------------------

test("buildHeaders sets Bearer auth for DeepSeek", () => {
  const h = buildHeaders(PROVIDERS.deepseek, deepseekUserConfig());
  assert.equal(h.Authorization, "Bearer sk-test-deepseek");
  assert.equal(h["Content-Type"], "application/json");
  assert.equal(h["anthropic-version"], "2026-01-01"); // default version header applies
});

test("buildHeaders sets x-api-key (raw) for Anthropic official, with version header", () => {
  const h = buildHeaders(PROVIDERS["anthropic-official"], anthropicUserConfig());
  assert.equal(h["x-api-key"], "sk-ant-test");
  assert.equal(h["Authorization"], undefined);
  assert.equal(h["anthropic-version"], "2026-01-01");
});

test("buildHeaders honors versionHeaderOverride", () => {
  const h = buildHeaders(PROVIDERS["anthropic-official"], anthropicUserConfig({
    versionHeaderOverride: "anthropic-version: 2025-12-31",
  }));
  assert.equal(h["anthropic-version"], "2025-12-31");
});

test("buildHeaders honors userAgentOverride", () => {
  const h = buildHeaders(PROVIDERS.deepseek, deepseekUserConfig({
    userAgentOverride: "FLOWnote/0.5.0-dev (Obsidian iOS)",
  }));
  assert.equal(h["User-Agent"], "FLOWnote/0.5.0-dev (Obsidian iOS)");
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

test("buildRequestBody passes through model, messages, system, tools, max_tokens", () => {
  const body = buildRequestBody({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "you are a tester",
    tools: [{ name: "vault_read", description: "read", input_schema: { type: "object" } }],
    maxTokens: 1024,
    temperature: 0.3,
  }, PROVIDERS.deepseek);

  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.system, "you are a tester");
  assert.equal(body.temperature, 0.3);
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  assert.equal(body.tools.length, 1);
});

test("buildRequestBody omits system when not provided", () => {
  const body = buildRequestBody({
    model: "x",
    messages: [],
    maxTokens: 16,
  }, PROVIDERS.deepseek);
  assert.equal("system" in body, false);
  assert.equal("temperature" in body, false);
  assert.equal("tools" in body, false);
});

test("stripUnsupportedParams removes MiniMax's documented dropped params", () => {
  const body = {
    model: "MiniMax-M2.7",
    messages: [],
    max_tokens: 16,
    thinking: { type: "enabled" },
    top_k: 5,
    stop_sequences: ["END"],
    service_tier: "auto",
    mcp_servers: [],
    context_management: {},
    container: {},
    keep_me: true,
  };
  const stripped = stripUnsupportedParams(body, PROVIDERS.minimax);
  assert.equal(stripped.thinking, undefined);
  assert.equal(stripped.top_k, undefined);
  assert.equal(stripped.stop_sequences, undefined);
  assert.equal(stripped.service_tier, undefined);
  assert.equal(stripped.mcp_servers, undefined);
  assert.equal(stripped.context_management, undefined);
  assert.equal(stripped.container, undefined);
  assert.equal(stripped.keep_me, true);
  // input not mutated:
  assert.equal(body.thinking.type, "enabled");
});

test("stripUnsupportedParams is a no-op when provider has no quirks list", () => {
  const body = { model: "x", thinking: { type: "enabled" } };
  const out = stripUnsupportedParams(body, PROVIDERS.deepseek);
  assert.equal(out.thinking.type, "enabled");
});

// ---------------------------------------------------------------------------
// Endpoint URL
// ---------------------------------------------------------------------------

test("buildEndpointUrl appends /v1/messages and strips trailing slashes", () => {
  assert.equal(buildEndpointUrl("https://api.anthropic.com"),       "https://api.anthropic.com/v1/messages");
  assert.equal(buildEndpointUrl("https://api.anthropic.com/"),      "https://api.anthropic.com/v1/messages");
  assert.equal(buildEndpointUrl("https://api.deepseek.com/anthropic"), "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(buildEndpointUrl("https://api.deepseek.com/anthropic//"), "https://api.deepseek.com/anthropic/v1/messages");
});

// ---------------------------------------------------------------------------
// createMessage end-to-end with a fake requestImpl
// ---------------------------------------------------------------------------

const SSE_FIXTURE =
  "event: message_start\n" +
  "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg-1\"}}\n\n" +
  "event: content_block_start\n" +
  "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n" +
  "event: content_block_delta\n" +
  "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n" +
  "event: content_block_delta\n" +
  "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\n" +
  "event: content_block_stop\n" +
  "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n" +
  "event: message_delta\n" +
  "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n" +
  "event: message_stop\n" +
  "data: {\"type\":\"message_stop\"}\n\n";

function mockRequest(seenRef, response) {
  return async (args) => {
    seenRef.value = args;
    return response;
  };
}

function okSseResponse(body) {
  return {
    status: 200,
    headers: {},
    text() { return Promise.resolve(body); },
  };
}

async function collect(asyncIterable) {
  const out = [];
  for await (const x of asyncIterable) out.push(x);
  return out;
}

test("createMessage streams normalized events through the SSE fixture", async () => {
  const seen = { value: null };
  const provider = createAnthropicMessagesProvider({
    spec: PROVIDERS.deepseek,
    userConfig: deepseekUserConfig(),
    requestImpl: mockRequest(seen, okSseResponse(SSE_FIXTURE)),
  });
  const events = await collect(provider.createMessage({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 256,
  }));

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});

test("createMessage sends the correct URL, method, auth, and body", async () => {
  const seen = { value: null };
  const provider = createAnthropicMessagesProvider({
    spec: PROVIDERS.deepseek,
    userConfig: deepseekUserConfig(),
    requestImpl: mockRequest(seen, okSseResponse(SSE_FIXTURE)),
  });
  await collect(provider.createMessage({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 256,
  }));

  assert.equal(seen.value.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(seen.value.method, "POST");
  assert.equal(seen.value.headers.Authorization, "Bearer sk-test-deepseek");
  assert.equal(seen.value.headers["Content-Type"], "application/json");

  const parsed = JSON.parse(seen.value.body);
  assert.equal(parsed.model, "deepseek-v4-flash");
  assert.equal(parsed.max_tokens, 256);
  assert.equal(parsed.stream, true);
});

test("createMessage drops unsupported params for MiniMax", async () => {
  const seen = { value: null };
  const provider = createAnthropicMessagesProvider({
    spec: PROVIDERS.minimax,
    userConfig: minimaxUserConfig(),
    requestImpl: mockRequest(seen, okSseResponse(SSE_FIXTURE)),
  });
  // simulate someone trying to slip "thinking" in via input — even though
  // our typed CreateMessageInput doesn't include it, the strip step
  // belongs in the adapter as a defensive layer.
  await collect(provider.createMessage({
    model: "MiniMax-M2.7-highspeed",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 256,
    // @ts-expect-error: deliberately violating types
    thinking: { type: "enabled" },
    top_k: 5,
  }));

  const parsed = JSON.parse(seen.value.body);
  assert.equal(parsed.thinking, undefined);
  assert.equal(parsed.top_k, undefined);
});

test("createMessage on non-2xx yields a single error event and stops", async () => {
  const errResponse = {
    status: 401,
    headers: {},
    text() { return Promise.resolve("{\"type\":\"error\",\"error\":{\"type\":\"invalid_api_key\"}}"); },
  };
  const provider = createAnthropicMessagesProvider({
    spec: PROVIDERS.deepseek,
    userConfig: deepseekUserConfig({ apiKey: "bad" }),
    requestImpl: async () => errResponse,
  });
  const events = await collect(provider.createMessage({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 16,
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.ok(events[0].error.type.startsWith("http_"));
});

test("createMessage non-streaming mode synthesizes the full event sequence", async () => {
  const fullMessage = {
    id: "msg-1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    usage: { output_tokens: 5 },
  };
  const provider = createAnthropicMessagesProvider({
    spec: PROVIDERS.deepseek,
    userConfig: deepseekUserConfig({ stream: false }),
    requestImpl: async () => ({
      status: 200,
      text() { return Promise.resolve(JSON.stringify(fullMessage)); },
    }),
  });
  const events = await collect(provider.createMessage({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 256,
  }));
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});

test("createMessage on Anthropic-official uses x-api-key (not Bearer)", async () => {
  const seen = { value: null };
  const provider = createAnthropicMessagesProvider({
    spec: PROVIDERS["anthropic-official"],
    userConfig: anthropicUserConfig(),
    requestImpl: mockRequest(seen, okSseResponse(SSE_FIXTURE)),
  });
  await collect(provider.createMessage({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 16,
  }));
  assert.equal(seen.value.headers["x-api-key"], "sk-ant-test");
  assert.equal(seen.value.headers["Authorization"], undefined);
  assert.equal(seen.value.url, "https://api.anthropic.com/v1/messages");
});

test("factory rejects mismatched protocol", () => {
  assert.throws(() => createAnthropicMessagesProvider({
    spec: PROVIDERS["openai-official"],
    userConfig: { providerId: "openai-official", mode: "api", apiKey: "x", model: "gpt-5.4" },
  }), /protocol must be anthropic-messages/);
});

test("factory rejects missing providerId in userConfig", () => {
  assert.throws(() => createAnthropicMessagesProvider({
    spec: PROVIDERS.deepseek,
    userConfig: { mode: "api", apiKey: "x", model: "deepseek-v4-flash" },
  }), /providerId is required/);
});

test("countTokens returns a non-zero estimate for text content", async () => {
  const provider = createAnthropicMessagesProvider({
    spec: PROVIDERS.deepseek,
    userConfig: deepseekUserConfig(),
    requestImpl: async () => okSseResponse(""),
  });
  const n = await provider.countTokens([
    { role: "user", content: [{ type: "text", text: "hello world this is a test" }] },
  ]);
  assert.ok(n > 0);
  assert.ok(n < 100);
});

test("countTokens estimates more aggressively for CJK content", async () => {
  const provider = createAnthropicMessagesProvider({
    spec: PROVIDERS.deepseek,
    userConfig: deepseekUserConfig(),
    requestImpl: async () => okSseResponse(""),
  });
  const latin = await provider.countTokens([
    { role: "user", content: [{ type: "text", text: "x".repeat(100) }] },
  ]);
  const cjk = await provider.countTokens([
    { role: "user", content: [{ type: "text", text: "中".repeat(100) }] },
  ]);
  assert.ok(cjk >= latin, `CJK estimate (${cjk}) should be >= latin estimate (${latin})`);
});
