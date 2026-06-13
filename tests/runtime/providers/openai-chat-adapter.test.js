const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createOpenAIChatProvider,
  buildRequestBody,
  buildHeaders,
  buildEndpointUrl,
  formatProviderHttpError,
  translateOpenAIChunk,
  mapOpenAIFinishReason,
} = require("../../../runtime/providers/openai-chat-adapter");
const { PROVIDERS } = require("../../../runtime/providers/registry");

function openaiUserConfig(over = {}) {
  return {
    providerId: "openai-official",
    mode: "api",
    apiKey: "sk-openai",
    model: "gpt-5.5",
    ...over,
  };
}

function qwenUserConfig(over = {}) {
  return {
    providerId: "qwen",
    mode: "coding-plan",
    apiKey: "qwen-key",
    model: "qwen3.6-plus",
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

test("buildHeaders omits Authorization for Ollama when API key is empty", () => {
  const h = buildHeaders(PROVIDERS.ollama, {
    providerId: "ollama",
    mode: "local",
    apiKey: "",
    model: "llama3.2",
  });
  assert.equal(h.Authorization, undefined);
  assert.equal(h["Content-Type"], "application/json");
});

test("buildEndpointUrl appends /chat/completions", () => {
  assert.equal(buildEndpointUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  assert.equal(buildEndpointUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
  assert.equal(buildEndpointUrl("http://localhost:11434/v1"), "http://localhost:11434/v1/chat/completions");
});

// ---------------------------------------------------------------------------
// Request body translation (Anthropic → OpenAI)
// ---------------------------------------------------------------------------

test("buildRequestBody converts a plain user message", () => {
  const body = buildRequestBody({
    model: "gpt-5.5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 32,
  }, PROVIDERS["openai-official"]);
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.max_tokens, 32);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("buildRequestBody prepends system message when set", () => {
  const body = buildRequestBody({
    model: "gpt-5.5",
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
    model: "gpt-5.5",
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
    model: "gpt-5.5",
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

test("buildRequestBody preserves OpenAI-compatible tool metadata", () => {
  const body = buildRequestBody({
    model: "gemini-3-pro-preview",
    messages: [
      { role: "user", content: [{ type: "text", text: "read x.md" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "vault_read",
            input: { path: "x.md" },
            extra_content: { google: { thought_signature: "sig-1" } },
          },
        ],
      },
    ],
    maxTokens: 16,
  }, PROVIDERS["openai-compat-custom"]);
  const assistant = body.messages.find((m) => m.role === "assistant");
  assert.deepEqual(assistant.tool_calls[0].extra_content, { google: { thought_signature: "sig-1" } });
});

test("buildRequestBody splits user tool_result blocks into separate role=tool messages", () => {
  const body = buildRequestBody({
    model: "gpt-5.5",
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

test("translateOpenAIChunk preserves Gemini extra_content on streamed tool calls", () => {
  const state = newState();
  const events = [
    ...translateOpenAIChunk({
      choices: [{
        delta: {
          tool_calls: [{
            id: "call-1",
            function: { name: "vault_read", arguments: "{}" },
            extra_content: { google: { thought_signature: "sig-1" } },
          }],
        },
      }],
    }, state),
    ...translateOpenAIChunk({ choices: [{ finish_reason: "tool_calls" }] }, state),
  ];

  const start = events.find((e) => e.type === "content_block_start");
  assert.equal(start.content_block.id, "call-1");
  assert.deepEqual(start.content_block.extra_content, { google: { thought_signature: "sig-1" } });
});

test("translateOpenAIChunk merges late Gemini extra_content metadata deltas", () => {
  const state = newState();
  const events = [
    ...translateOpenAIChunk({
      choices: [{
        delta: { tool_calls: [{ id: "call-1", function: { name: "vault_read", arguments: "{\"path\"" } }] },
      }],
    }, state),
    ...translateOpenAIChunk({
      choices: [{
        delta: {
          tool_calls: [{
            id: "call-1",
            function: { arguments: ":\"x.md\"}" },
            extra_content: { google: { thought_signature: "sig-1" } },
          }],
        },
      }],
    }, state),
  ];

  const metadataDelta = events.find((e) => e.type === "content_block_delta" && e.delta.type === "tool_metadata_delta");
  assert.deepEqual(metadataDelta.delta.extra_content, { google: { thought_signature: "sig-1" } });
});

test("translateOpenAIChunk separates missing-index tool calls by id", () => {
  const state = newState();
  const events = [
    ...translateOpenAIChunk({
      choices: [{
        delta: {
          tool_calls: [
            { id: "call-a", function: { name: "vault_read", arguments: "{}" } },
            { id: "call-b", function: { name: "vault_write", arguments: "{}" } },
          ],
        },
      }],
    }, state),
  ];

  const starts = events.filter((e) => e.type === "content_block_start");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map((e) => e.content_block.id), ["call-a", "call-b"]);
  assert.deepEqual(starts.map((e) => e.content_block.name), ["vault_read", "vault_write"]);
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
    model: "gpt-5.5",
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
    model: "gpt-5.5",
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
    model: "gpt-5.5",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxTokens: 16,
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error.type, /^http_401$/);
});

test("formatProviderHttpError explains Ollama models without tool support", () => {
  const message = formatProviderHttpError({
    spec: PROVIDERS.ollama,
    status: 400,
    text: JSON.stringify({
      error: {
        message: "registry.ollama.ai/library/deepseek-r1:8b does not support tools",
        type: "invalid_request_error",
      },
    }),
  });
  assert.match(message, /does not support tools/);
  assert.match(message, /当前模型不支持工具调用，请更换支持工具调用的模型。/);
  assert.doesNotMatch(message, /电脑卡顿|Ollama 没启动/);
});

test("formatProviderHttpError explains Ollama cloud sign-in / subscription errors", () => {
  // A cloud model (e.g. one auto-selected from the local /v1/models list) returns
  // a sign-in/subscription error; surface an actionable hint, not the raw text.
  for (const raw of [
    "you must sign in at ollama.com to use cloud models",
    "this model requires an Ollama subscription",
    "unauthorized: cloud model requires an account",
  ]) {
    const message = formatProviderHttpError({
      spec: PROVIDERS.ollama,
      status: 401,
      text: JSON.stringify({ error: { message: raw } }),
    });
    assert.match(message, /云端模型|ollama\.com/);
    assert.match(message, /本机已安装|不带 -cloud/);
    assert.match(message, new RegExp(raw.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("formatProviderHttpError explains OpenRouter credit / auth errors", () => {
  for (const raw of [
    "Insufficient credits. Add more at openrouter.ai/credits",
    "This request requires more credits, or a higher tier",
    "No auth credentials found",
  ]) {
    const message = formatProviderHttpError({
      spec: PROVIDERS.openrouter,
      status: 402,
      text: JSON.stringify({ error: { message: raw } }),
    });
    assert.match(message, /OpenRouter/);
    assert.match(message, /额度|:free/);
    assert.match(message, new RegExp(raw.slice(0, 10).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("formatProviderHttpError explains missing Ollama models", () => {
  const message = formatProviderHttpError({
    spec: PROVIDERS.ollama,
    status: 404,
    text: JSON.stringify({
      error: {
        message: "model 'qwen2.5-coder:7b' not found",
        type: "not_found_error",
      },
    }),
  });
  assert.match(message, /当前 Ollama 未找到这个模型/);
  assert.match(message, /qwen2.5-coder:7b/);
});

test("formatProviderHttpError explains Gemini thought_signature errors", () => {
  const message = formatProviderHttpError({
    spec: PROVIDERS["openai-compat-custom"],
    status: 400,
    text: JSON.stringify({
      error: {
        message: "Function call is missing a thought_signature in functionCall parts",
        type: "invalid_request_error",
      },
    }),
  });
  assert.match(message, /Gemini 的 OpenAI 兼容层/);
  assert.match(message, /thought_signature/);
  assert.match(message, /tools\/function calling/);
});

test("createMessage carries the Qwen base URL when the user picks Qwen", async () => {
  const seen = { value: null };
  const provider = createOpenAIChatProvider({
    spec: PROVIDERS.qwen,
    userConfig: qwenUserConfig(),
    requestImpl: mockRequest(seen, okSseResponse(OPENAI_SSE_FIXTURE)),
  });
  await collect(provider.createMessage({
    model: "qwen3.6-plus",
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

test("translateOpenAIChunk does not split args into a phantom tool call when continuations lack index and id", () => {
  // Some OpenAI-compatible gateways send the tool-call `id` only on the first
  // delta and then continuation deltas carrying neither `index` nor `id`. The
  // argument fragments must accumulate onto the SAME tool call, not spawn a
  // second empty-named one. (Regression for resolveToolCallStateKey.)
  const state = newState();
  const events = [
    ...translateOpenAIChunk({ id: "x", choices: [{ delta: { tool_calls: [{ id: "call_abc", function: { name: "vault_write", arguments: "" } }] } }] }, state),
    ...translateOpenAIChunk({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"path":"a.md"' } }] } }] }, state),
    ...translateOpenAIChunk({ choices: [{ delta: { tool_calls: [{ function: { arguments: ',"content":"hi"}' } }] } }] }, state),
    ...translateOpenAIChunk({ choices: [{ finish_reason: "tool_calls" }] }, state),
  ];

  const toolStarts = events.filter((e) => e.type === "content_block_start" && e.content_block && e.content_block.type === "tool_use");
  assert.equal(toolStarts.length, 1, "exactly one tool_use block should open");

  const keys = Object.keys(state.toolCalls);
  assert.equal(keys.length, 1, "no phantom tool call should be created");
  const tc = state.toolCalls[keys[0]];
  assert.equal(tc.name, "vault_write");
  assert.equal(tc.argsBuffer, '{"path":"a.md","content":"hi"}');
  assert.deepEqual(JSON.parse(tc.argsBuffer), { path: "a.md", content: "hi" });
});

test("translateOpenAIChunk still keys parallel indexed tool calls independently", () => {
  const state = newState();
  const events = [
    ...translateOpenAIChunk({ id: "x", choices: [{ delta: { tool_calls: [
      { index: 0, id: "c0", function: { name: "vault_read", arguments: '{"a":1}' } },
      { index: 1, id: "c1", function: { name: "vault_write", arguments: '{"b":2}' } },
    ] } }] }, state),
    ...translateOpenAIChunk({ choices: [{ finish_reason: "tool_calls" }] }, state),
  ];
  const toolStarts = events.filter((e) => e.type === "content_block_start" && e.content_block && e.content_block.type === "tool_use");
  assert.equal(toolStarts.length, 2);
});
