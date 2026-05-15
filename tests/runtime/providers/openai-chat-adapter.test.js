const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createOpenAIChatProvider,
  buildRequestBody,
  buildHeaders,
  buildEndpointUrl,
  translateOpenAIChunk,
  mapOpenAIFinishReason,
} = require("../../../runtime/providers/openai-chat-adapter");
const { PROVIDERS } = require("../../../runtime/providers/registry");

function openaiUserConfig(over = {}) {
  return {
    providerId: "openai-official",
    mode: "api",
    apiKey: "sk-openai",
    model: "gpt-5.4",
    ...over,
  };
}

function qwenUserConfig(over = {}) {
  return {
    providerId: "qwen",
    mode: "coding-plan",
    apiKey: "qwen-key",
    model: "qwen-coder-plus",
    ...over,
  };
}

async function collect(asyncIterable) {
  const out = [];
  for await (const x of asyncIterable) out.push(x);
  return out;
}

function okSseResponse(body) {
  return {
    status: 200,
    headers: {},
    text() { return Promise.resolve(body); },
  };
}

function mockRequest(seenRef, response) {
  return async (args) => {
    seenRef.value = args;
    return response;
  };
}

// ---------------------------------------------------------------------------
// Headers / URL
// ---------------------------------------------------------------------------

test("buildHeaders sets Authorization: Bearer for openai-chat providers", () => {
  const h = buildHeaders(PROVIDERS["openai-official"], openaiUserConfig());
  assert.equal(h.Authorization, "Bearer sk-openai");
  assert.equal(h["Content-Type"], "application/json");
});

test("buildEndpointUrl appends /chat/completions", () => {
  assert.equal(buildEndpointUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  assert.equal(buildEndpointUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
});

// ---------------------------------------------------------------------------
// Request body translation (Anthropic → OpenAI)
// ---------------------------------------------------------------------------

test("buildRequestBody converts a plain user message", () => {
  const body = buildRequestBody({
    model: "gpt-5.4",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 32,
  }, PROVIDERS["openai-official"]);
  assert.equal(body.model, "gpt-5.4");
  assert.equal(body.max_tokens, 32);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("buildRequestBody prepends system message when set", () => {
  const body = buildRequestBody({
    model: "gpt-5.4",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "you are a tester",
    maxTokens: 32,
  }, PROVIDERS["openai-official"]);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "you are a tester");
  assert.equal(body.messages[1].role, "user");
});

test("buildRequestBody translates tools array into OpenAI function shape", () => {
  const body = buildRequestBody({
    model: "gpt-5.4",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    tools: [{ name: "vault_read", description: "read", input_schema: { type: "object" } }],
    maxTokens: 16,
  }, PROVIDERS["openai-official"]);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "vault_read");
  assert.equal(body.tools[0].function.description, "read");
  assert.deepEqual(body.tools[0].function.parameters, { type: "object" });
});

test("buildRequestBody converts an assistant tool_use into tool_calls", () => {
  const body = buildRequestBody({
    model: "gpt-5.4",
    messages: [
      { role: "user", content: [{ type: "text", text: "read x.md" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "tu-1", name: "vault_read", input: { path: "x.md" } },
        ],
      },
    ],
    maxTokens: 16,
  }, PROVIDERS["openai-official"]);
  const assistant = body.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.content, "ok");
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].function.name, "vault_read");
  assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).path, "x.md");
});

test("buildRequestBody splits user tool_result blocks into separate role=tool messages", () => {
  const body = buildRequestBody({
    model: "gpt-5.4",
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "vault_read", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file contents..." }],
      },
    ],
    maxTokens: 16,
  }, PROVIDERS["openai-official"]);
  const toolMsg = body.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "expected a role=tool message");
  assert.equal(toolMsg.tool_call_id, "tu-1");
  assert.equal(toolMsg.content, "file contents...");
});

test("buildRequestBody passes temperature through and omits when absent", () => {
  const body = buildRequestBody({
    model: "x", messages: [], maxTokens: 4, temperature: 0.4,
  }, PROVIDERS["openai-official"]);
  assert.equal(body.temperature, 0.4);

  const body2 = buildRequestBody({
    model: "x", messages: [], maxTokens: 4,
  }, PROVIDERS["openai-official"]);
  assert.equal("temperature" in body2, false);
});

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

test("mapOpenAIFinishReason maps known reasons to Anthropic equivalents", () => {
  assert.equal(mapOpenAIFinishReason("stop"), "end_turn");
  assert.equal(mapOpenAIFinishReason("tool_calls"), "tool_use");
  assert.equal(mapOpenAIFinishReason("function_call"), "tool_use");
  assert.equal(mapOpenAIFinishReason("length"), "max_tokens");
  assert.equal(mapOpenAIFinishReason("content_filter"), "content_filter");
  assert.equal(mapOpenAIFinishReason(undefined), "end_turn");
});

// ---------------------------------------------------------------------------
// translateOpenAIChunk — convert chunks to Anthropic StreamEvents
// ---------------------------------------------------------------------------

function newState() {
  return { started: false, textStarted: false, textIndex: 0, toolCalls: {}, nextIndex: 0, stopReason: null };
}

test("translateOpenAIChunk emits message_start once on first chunk", () => {
  const state = newState();
  const out1 = [...translateOpenAIChunk({ id: "x", choices: [{ delta: { content: "hi" } }] }, state)];
  const out2 = [...translateOpenAIChunk({ id: "x", choices: [{ delta: { content: "more" } }] }, state)];
  assert.equal(out1.filter((e) => e.type === "message_start").length, 1);
  assert.equal(out2.filter((e) => e.type === "message_start").length, 0);
});

test("translateOpenAIChunk emits content_block_start then deltas for text", () => {
  const state = newState();
  const all = [
    ...translateOpenAIChunk({ choices: [{ delta: { content: "Hello" } }] }, state),
    ...translateOpenAIChunk({ choices: [{ delta: { content: " world" } }] }, state),
  ];
  const types = all.map((e) => e.type);
  assert.deepEqual(types.filter((t) => t.startsWith("content_block_")), [
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
  ]);
});

test("translateOpenAIChunk handles tool_calls with streamed argument JSON", () => {
  const state = newState();
  const events = [
    ...translateOpenAIChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "vault_read", arguments: "{\"pa" } }] } }] }, state),
    ...translateOpenAIChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"x.md\"}" } }] } }] }, state),
    ...translateOpenAIChunk({ choices: [{ finish_reason: "tool_calls" }] }, state),
  ];

  const starts = events.filter((e) => e.type === "content_block_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].content_block.type, "tool_use");
  assert.equal(starts[0].content_block.id, "call-1");
  assert.equal(starts[0].content_block.name, "vault_read");

  const deltas = events.filter((e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta");
  assert.equal(deltas.length, 2);
  assert.equal(deltas.map((d) => d.delta.partial_json).join(""), "{\"path\":\"x.md\"}");

  const msgDelta = events.find((e) => e.type === "message_delta");
  assert.equal(msgDelta.delta.stop_reason, "tool_use");
});

test("translateOpenAIChunk closes text block before message_stop", () => {
  const state = newState();
  const events = [
    ...translateOpenAIChunk({ choices: [{ delta: { content: "hi" } }] }, state),
    ...translateOpenAIChunk({ choices: [{ finish_reason: "stop" }] }, state),
  ];
  const types = events.map((e) => e.type);
  // text starts, deltas, text stops, message_delta, message_stop
  assert.ok(types.includes("content_block_start"));
  assert.ok(types.includes("content_block_stop"));
  assert.equal(types[types.length - 1], "message_stop");
});

// ---------------------------------------------------------------------------
// End-to-end createMessage with a scripted SSE response
// ---------------------------------------------------------------------------

const OPENAI_SSE_FIXTURE =
  "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n" +
  "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"}}]}\n\n" +
  "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"}}]}\n\n" +
  "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"finish_reason\":\"stop\"}]}\n\n" +
  "data: [DONE]\n\n";

test("createMessage end-to-end streams Anthropic-shaped events", async () => {
  const seen = { value: null };
  const provider = createOpenAIChatProvider({
    spec: PROVIDERS["openai-official"],
    userConfig: openaiUserConfig(),
    requestImpl: mockRequest(seen, okSseResponse(OPENAI_SSE_FIXTURE)),
  });
  const events = await collect(provider.createMessage({
    model: "gpt-5.4",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 32,
  }));
  const types = events.map((e) => e.type);
  assert.equal(types[0], "message_start");
  assert.ok(types.includes("content_block_start"));
  assert.ok(types.includes("content_block_delta"));
  assert.ok(types.includes("content_block_stop"));
  assert.ok(types.includes("message_delta"));
  assert.equal(types[types.length - 1], "message_stop");
  // Verify URL was built correctly
  assert.equal(seen.value.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(seen.value.headers.Authorization, "Bearer sk-openai");
});

test("createMessage non-streaming mode synthesizes the canonical event sequence", async () => {
  const provider = createOpenAIChatProvider({
    spec: PROVIDERS["openai-official"],
    userConfig: openaiUserConfig({ stream: false }),
    requestImpl: async () => ({
      status: 200,
      text() {
        return Promise.resolve(JSON.stringify({
          id: "m1",
          choices: [{
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          }],
          usage: { total_tokens: 10 },
        }));
      },
    }),
  });
  const events = await collect(provider.createMessage({
    model: "gpt-5.4",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 16,
  }));
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});

test("createMessage on error response yields a single error event", async () => {
  const provider = createOpenAIChatProvider({
    spec: PROVIDERS["openai-official"],
    userConfig: openaiUserConfig({ apiKey: "bad" }),
    requestImpl: async () => ({
      status: 401,
      text() { return Promise.resolve("{\"error\":{\"message\":\"unauthorized\"}}"); },
    }),
  });
  const events = await collect(provider.createMessage({
    model: "gpt-5.4",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 16,
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error.type, /^http_401$/);
});

test("createMessage carries the Qwen base URL when the user picks Qwen", async () => {
  const seen = { value: null };
  const provider = createOpenAIChatProvider({
    spec: PROVIDERS.qwen,
    userConfig: qwenUserConfig(),
    requestImpl: mockRequest(seen, okSseResponse(OPENAI_SSE_FIXTURE)),
  });
  await collect(provider.createMessage({
    model: "qwen-coder-plus",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 16,
  }));
  assert.equal(seen.value.url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
});

test("factory rejects mismatched protocol", () => {
  assert.throws(() => createOpenAIChatProvider({
    spec: PROVIDERS.deepseek,
    userConfig: { providerId: "deepseek", mode: "api", apiKey: "k", model: "deepseek-v4-flash" },
  }), /protocol must be openai-chat/);
});
