const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runAgentLoop,
  consumeStream,
  runToolUse,
  createEffectReceipt,
} = require("../../../runtime/agent/agent-loop");
const { createExplicitSkillWorkflowContract } = require("../../../runtime/agent/execution-contract");
const { createVaultChangeRecorder } = require("../../../runtime/agent/vault-change-recorder");
const { buildTool, ToolRegistry } = require("../../../runtime/agent/tool-registry");
const { createAskUserTool } = require("../../../runtime/agent/tools/ask-user");

// ---------------------------------------------------------------------------
// MockProvider — scripts one or more turns. Each turn is an array of
// canonical StreamEvents (already normalized; adapter would have produced
// them from SSE). The provider returns turn[i] on the i-th call.
// ---------------------------------------------------------------------------

function mockProvider({ turns, userConfig = { providerId: "mock", mode: "api", apiKey: "k", model: "test" } } = {}) {
  let calls = 0;
  /** @type {Array<{turn: number, input: any}>} */
  const seen = [];
  return {
    id: "mock",
    displayName: "mock",
    spec: { id: "mock", defaultModel: "test" },
    userConfig,
    _seen: seen,
    _calls: () => calls,
    async *createMessage(input) {
      const idx = calls;
      calls += 1;
      seen.push({ turn: idx, input });
      const events = turns[idx];
      if (!events) {
        throw new Error(`MockProvider exhausted: no turn ${idx}`);
      }
      for (const ev of events) {
        yield ev;
      }
    },
    async testConnection() { return { ok: true, latencyMs: 0 }; },
    async countTokens() { return 0; },
  };
}

// Helper event builders to keep tests readable.
const ev = {
  messageStart: () => ({ type: "message_start", message: { id: "msg-x" } }),
  textBlockStart: (i) => ({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }),
  textDelta: (i, t) => ({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } }),
  blockStop: (i) => ({ type: "content_block_stop", index: i }),
  toolUseStart: (i, id, name) => ({
    type: "content_block_start",
    index: i,
    content_block: { type: "tool_use", id, name, input: {} },
  }),
  toolUseJson: (i, partial) => ({
    type: "content_block_delta",
    index: i,
    delta: { type: "input_json_delta", partial_json: partial },
  }),
  messageDelta: (stopReason) => ({ type: "message_delta", delta: { stop_reason: stopReason } }),
  messageStop: () => ({ type: "message_stop" }),
};

async function collect(asyncIterable) {
  const out = [];
  for await (const x of asyncIterable) out.push(x);
  return out;
}

function makeReadOnlyTool(name, fn) {
  return buildTool({
    name,
    description: name,
    inputSchema: { type: "object" },
    capabilities: (input) => ({
      effect: "observation",
      risk: "low",
      concurrency: "parallel",
      presentation: "read",
      targets: input && input.path ? [input.path] : [],
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, _ctx) {
      const r = await fn(input);
      yield { type: "result", content: r };
    },
  });
}

function makeWritingTool(name, fn, { checkPermissions } = {}) {
  return buildTool({
    name,
    description: name,
    inputSchema: { type: "object" },
    capabilities: (input) => ({
      effect: "vault_mutation",
      risk: input && input.mode === "overwrite" ? "high" : "medium",
      concurrency: "serial",
      presentation: "edit",
      targets: input && input.path ? [input.path] : [],
    }),
    isReadOnly: () => false,
    checkPermissions: checkPermissions || (async () => ({ behavior: "allow" })),
    async *execute(input, _ctx) {
      yield { type: "progress", message: `running ${name}` };
      const r = await fn(input);
      yield { type: "result", content: r };
    },
  });
}

function makeQuestionTool(name, fn) {
  return buildTool({
    name,
    description: name,
    inputSchema: { type: "object" },
    capabilities: () => ({
      effect: "none",
      risk: "low",
      concurrency: "serial",
      presentation: "question",
      targets: [],
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async *execute(input, _ctx) {
      const result = await fn(input);
      yield { type: "result", content: result };
    },
  });
}

function registryWith(...tools) {
  const r = new ToolRegistry();
  r.registerAll(tools);
  return r;
}

function explicitWorkflowContract() {
  return createExplicitSkillWorkflowContract({
    skillName: "ah-card",
    command: "/ah-card",
    args: "",
    completionPolicy: {
      state: "declared",
      mode: "effect",
      requiredEffects: [],
      minReceipts: null,
      errorCode: null,
    },
  });
}

function inspectWorkflowContract() {
  return createExplicitSkillWorkflowContract({
    skillName: "inspect-skill",
    command: "/inspect-skill",
    completionPolicy: {
      state: "declared",
      mode: "inspect",
      requiredEffects: [],
      minReceipts: null,
      errorCode: null,
    },
  });
}

test("runAgentLoop publishes a stable tool_start before execution completes", async () => {
  let releaseExecution;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-live", "vault_write"),
        ev.toolUseJson(0, "{\"path\":\"Live.md\"}"),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "done"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(makeWritingTool("vault_write", async () => {
    await executionGate;
    return "Wrote Live.md";
  }));
  const iterator = runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "Write Live.md" }] }],
  })[Symbol.asyncIterator]();

  let startEvent = null;
  for (let i = 0; i < 20 && !startEvent; i += 1) {
    const next = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("tool_start was delayed until execution finished")), 200)),
    ]);
    if (next.value && next.value.type === "tool_start") startEvent = next.value;
  }
  assert.equal(startEvent.toolUseId, "tu-live");
  releaseExecution();

  const remaining = await collect(iterator);
  const progress = remaining.find((event) => event.type === "tool_progress");
  assert.equal(progress.toolUseId, "tu-live");
  assert.ok(remaining.some((event) => event.type === "tool_finish" && event.toolUseId === "tu-live"));
});

// ---------------------------------------------------------------------------
// consumeStream — exercise the streaming accumulator directly
// ---------------------------------------------------------------------------

test("consumeStream accumulates text deltas across a turn", async () => {
  async function* gen() {
    yield ev.messageStart();
    yield ev.textBlockStart(0);
    yield ev.textDelta(0, "Hello");
    yield ev.textDelta(0, " world");
    yield ev.blockStop(0);
    yield ev.messageDelta("end_turn");
    yield ev.messageStop();
  }
  const r = await consumeStream(gen());
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.toolUses.length, 0);
  assert.equal(r.assistantContent.length, 1);
  assert.equal(r.assistantContent[0].type, "text");
  assert.equal(r.assistantContent[0].text, "Hello world");
});

test("consumeStream parses input_json_delta into tool_use.input", async () => {
  async function* gen() {
    yield ev.messageStart();
    yield ev.toolUseStart(0, "tu-1", "vault_read");
    yield ev.toolUseJson(0, "{\"pa");
    yield ev.toolUseJson(0, "th\":\"x.md\"}");
    yield ev.blockStop(0);
    yield ev.messageDelta("tool_use");
    yield ev.messageStop();
  }
  const r = await consumeStream(gen());
  assert.equal(r.stopReason, "tool_use");
  assert.equal(r.toolUses.length, 1);
  assert.equal(r.toolUses[0].id, "tu-1");
  assert.equal(r.toolUses[0].name, "vault_read");
  assert.deepEqual(r.toolUses[0].input, { path: "x.md" });
});

test("consumeStream preserves provider metadata on tool_use blocks", async () => {
  async function* gen() {
    yield ev.messageStart();
    yield {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tu-1",
        name: "vault_read",
        input: {},
        extra_content: { google: { thought_signature: "sig-1" } },
      },
    };
    yield ev.toolUseJson(0, "{\"path\":\"x.md\"}");
    yield ev.blockStop(0);
    yield ev.messageDelta("tool_use");
    yield ev.messageStop();
  }
  const r = await consumeStream(gen());
  assert.deepEqual(r.toolUses[0].input, { path: "x.md" });
  assert.deepEqual(r.toolUses[0].extra_content, { google: { thought_signature: "sig-1" } });
});

test("consumeStream applies late tool metadata deltas", async () => {
  async function* gen() {
    yield ev.messageStart();
    yield ev.toolUseStart(0, "tu-1", "vault_read");
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "tool_metadata_delta", extra_content: { google: { thought_signature: "sig-1" } } },
    };
    yield ev.toolUseJson(0, "{\"path\":\"x.md\"}");
    yield ev.blockStop(0);
    yield ev.messageDelta("tool_use");
    yield ev.messageStop();
  }
  const r = await consumeStream(gen());
  assert.deepEqual(r.toolUses[0].input, { path: "x.md" });
  assert.deepEqual(r.toolUses[0].extra_content, { google: { thought_signature: "sig-1" } });
});

test("consumeStream surfaces error events as fatalError", async () => {
  async function* gen() {
    yield { type: "error", error: { type: "http_500", message: "boom" } };
  }
  const r = await consumeStream(gen());
  assert.equal(r.fatalError.type, "http_500");
});

test("consumeStream fails closed when streamed tool arguments are malformed", async () => {
  async function* gen() {
    yield ev.messageStart();
    yield ev.toolUseStart(0, "tu-bad-json", "vault_write");
    yield ev.toolUseJson(0, '{"path":"x.md","content":');
    yield ev.blockStop(0);
    yield ev.messageDelta("tool_use");
    yield ev.messageStop();
  }
  const r = await consumeStream(gen());
  assert.equal(r.fatalError.type, "invalid_tool_arguments");
  assert.match(r.fatalError.message, /tu-bad-json/);
  assert.equal(r.toolUses.length, 0);
});

test("consumeStream fails closed when tool_use stop reason has no tool block", async () => {
  async function* gen() {
    yield ev.messageStart();
    yield ev.textBlockStart(0);
    yield ev.textDelta(0, "已经写入完成。");
    yield ev.blockStop(0);
    yield ev.messageDelta("tool_use");
    yield ev.messageStop();
  }
  const r = await consumeStream(gen());
  assert.equal(r.fatalError.type, "missing_tool_call");
});

test("consumeStream fails closed when a provider stream ends without message_stop", async () => {
  async function* gen() {
    yield ev.messageStart();
    yield ev.textBlockStart(0);
    yield ev.textDelta(0, "partial output");
    yield ev.blockStop(0);
    yield ev.messageDelta("end_turn");
  }
  const r = await consumeStream(gen());
  assert.equal(r.fatalError.type, "incomplete_provider_stream");
});

test("consumeStream fails closed when the provider returns an empty stream", async () => {
  async function* gen() {}
  const r = await consumeStream(gen());
  assert.equal(r.fatalError.type, "incomplete_provider_stream");
  assert.equal(r.assistantContent.length, 0);
});

test("consumeStream fails closed when provider deltas arrive outside a message lifecycle", async () => {
  async function* gen() {
    yield ev.textDelta(0, "orphan text");
  }
  const r = await consumeStream(gen());
  assert.equal(r.fatalError.type, "invalid_provider_stream");
});

test("consumeStream never treats max_tokens output as a complete turn", async () => {
  async function* gen() {
    yield ev.messageStart();
    yield ev.textBlockStart(0);
    yield ev.textDelta(0, "已完成写入。");
    yield ev.blockStop(0);
    yield ev.messageDelta("max_tokens");
    yield ev.messageStop();
  }
  const r = await consumeStream(gen());
  assert.equal(r.fatalError.type, "incomplete_model_output");
});

// ---------------------------------------------------------------------------
// runAgentLoop — one turn, no tools
// ---------------------------------------------------------------------------

test("runAgentLoop with no tool_use ends after one turn", async () => {
  const provider = mockProvider({
    turns: [[
      ev.messageStart(),
      ev.textBlockStart(0),
      ev.textDelta(0, "hi"),
      ev.blockStop(0),
      ev.messageDelta("end_turn"),
      ev.messageStop(),
    ]],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  }));
  const types = events.map((e) => e.type);
  assert.ok(types.includes("turn_complete"));
  assert.ok(types.includes("done"));
  const done = events.find((e) => e.type === "done");
  assert.equal(done.turns, 1);
  assert.equal(provider._calls(), 1);
});

test("runAgentLoop exposes provider abort as a typed cancelled terminal event", async () => {
  const controller = new AbortController();
  const provider = {
    userConfig: { model: "test" },
    async *createMessage() {
      controller.abort();
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    },
  };
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [],
    signal: controller.signal,
  }));

  assert.equal(events.at(-1).type, "cancelled");
  assert.equal(events.some((event) => event.type === "done" || event.type === "error"), false);
});

test("runAgentLoop checkpoints completed tool progress when the provider stream is interrupted", async () => {
  let calls = 0;
  const provider = {
    id: "mock",
    spec: { id: "mock", defaultModel: "test" },
    userConfig: { providerId: "mock", model: "test" },
    async *createMessage() {
      calls += 1;
      if (calls === 1) {
        yield ev.messageStart();
        yield ev.toolUseStart(0, "read-before-drop", "vault_read");
        yield ev.toolUseJson(0, '{"path":"Daily.md"}');
        yield ev.blockStop(0);
        yield ev.messageDelta("tool_use");
        yield ev.messageStop();
        return;
      }
      const error = new Error("The response stream was interrupted.");
      error.code = "PROVIDER_STREAM_READ_FAILED";
      throw error;
    },
    async countTokens() { return 0; },
  };
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeReadOnlyTool("vault_read", async () => "daily contents")),
    messages: [{ role: "user", content: [{ type: "text", text: "Read my daily note" }] }],
  }));

  const suspended = events.at(-1);
  assert.equal(suspended.type, "suspended");
  assert.equal(suspended.reason, "provider_stream_interrupted");
  assert.equal(suspended.stage, "model_stream");
  assert.equal(suspended.turns, 1);
  assert.equal(suspended.checkpoint.turns, 1);
  assert.equal(suspended.checkpoint.messages.at(-1).role, "user");
  assert.equal(suspended.checkpoint.messages.at(-1).content[0].type, "tool_result");
  assert.equal(events.some((event) => event.type === "error" || event.type === "done"), false);
});

test("runAgentLoop suspends at the last complete boundary when a stream ends without message_stop", async () => {
  const provider = {
    id: "mock",
    spec: { id: "mock", defaultModel: "test" },
    userConfig: { providerId: "mock", model: "test" },
    async *createMessage() {
      yield ev.messageStart();
      yield ev.textBlockStart(0);
      yield ev.textDelta(0, "partial text that must not become durable");
      yield ev.blockStop(0);
      yield ev.messageDelta("end_turn");
    },
    async countTokens() { return 0; },
  };
  const originalMessages = [{ role: "user", content: [{ type: "text", text: "continue safely" }] }];
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: originalMessages,
  }));

  const suspended = events.at(-1);
  assert.equal(suspended.type, "suspended");
  assert.equal(suspended.reason, "provider_stream_interrupted");
  assert.equal(suspended.stage, "model_stream");
  assert.deepEqual(suspended.checkpoint.messages, originalMessages);
  assert.doesNotMatch(JSON.stringify(suspended.checkpoint), /partial text that must not become durable/);
  assert.equal(events.some((event) => event.type === "error" || event.type === "done"), false);
});

test("runAgentLoop checkpoints a tool-only answer when the model returns no final text", async () => {
  const provider = mockProvider({ turns: [
    [
      ev.messageStart(),
      ev.toolUseStart(0, "read-before-empty", "vault_read"),
      ev.toolUseJson(0, '{"path":"Daily.md"}'),
      ev.blockStop(0),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
    [
      ev.messageStart(),
      ev.messageDelta("end_turn"),
      ev.messageStop(),
    ],
  ] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeReadOnlyTool("vault_read", async () => "daily contents")),
    messages: [{ role: "user", content: [{ type: "text", text: "Summarize my daily note" }] }],
  }));

  const suspended = events.at(-1);
  assert.equal(suspended.type, "suspended");
  assert.equal(suspended.reason, "empty_final_response");
  assert.equal(suspended.stage, "after_model");
  assert.equal(suspended.turns, 1);
  assert.equal(suspended.checkpoint.messages.at(-1).role, "user");
  assert.equal(suspended.checkpoint.messages.at(-1).content[0].type, "tool_result");
  assert.equal(events.some((event) => event.type === "done"), false);
});

test("a corrupted invalid workflow contract fails before the provider is called", async () => {
  const provider = mockProvider({ turns: [] });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [],
    executionContract: {
      id: "skill-corrupt",
      mode: "workflow",
      completionPolicyState: "invalid",
      completionMode: null,
      requiredEffects: [],
      minReceipts: 0,
    },
  }));

  assert.equal(provider._calls(), 0);
  assert.deepEqual(events.at(-1), {
    type: "error",
    error: {
      type: "SKILL_COMPLETION_METADATA_INVALID",
      code: "SKILL_COMPLETION_METADATA_INVALID",
      message: "The skill completion contract is invalid.",
      contractId: "skill-corrupt",
    },
  });
});

test("runAgentLoop permits a no-tool completion for an answer-only task contract", async () => {
  const provider = mockProvider({
    turns: [[
      ev.messageStart(),
      ev.textBlockStart(0),
      ev.textDelta(0, "这是解释。"),
      ev.blockStop(0),
      ev.messageDelta("end_turn"),
      ev.messageStop(),
    ]],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "解释一下" }] }],
    executionContract: { id: "contract-3", mode: "answer", requiredEffects: [] },
  }));

  assert.ok(events.some((event) => event.type === "done"));
  assert.equal(events.some((event) => event.type === "completion_retry"), false);
});

test("runAgentLoop completes an inspection after a successful observation receipt", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-read", "vault_read"),
        ev.toolUseJson(0, '{"path":"x.md"}'),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "x.md contains hello."),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeReadOnlyTool("vault_read", async () => "hello")),
    messages: [{ role: "user", content: [{ type: "text", text: "读取 x.md" }] }],
    executionContract: {
      id: "contract-inspect-success",
      mode: "inspect",
      requiredEffects: [{ kind: "observation", targetPaths: ["x.md"] }],
    },
  }));

  const receipt = events.find((event) => event.type === "effect_receipt").receipt;
  assert.equal(receipt.kind, "observation");
  assert.equal(receipt.verified, true);
  assert.ok(events.some((event) => event.type === "done"));
});

// ---------------------------------------------------------------------------
// runAgentLoop — single tool_use round trip
// ---------------------------------------------------------------------------

test("runAgentLoop dispatches a single tool_use and feeds the result back", async () => {
  const provider = mockProvider({
    turns: [
      [ // turn 0: model asks for a tool
        ev.messageStart(),
        ev.toolUseStart(0, "tu-1", "vault_read"),
        ev.toolUseJson(0, "{\"path\":\"x.md\"}"),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [ // turn 1: model wraps up after seeing the result
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "OK summary."),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(
    makeReadOnlyTool("vault_read", async (input) => `read ${input.path}`),
  );
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "Read x.md" }] }],
  }));
  const finish = events.find((e) => e.type === "tool_finish");
  assert.ok(finish);
  assert.equal(finish.tool, "vault_read");
  assert.equal(finish.isError, false);
  assert.equal(finish.content, "read x.md");

  // The second turn's outgoing input should carry the tool_result block.
  const turn1 = provider._seen[1];
  const lastMsg = turn1.input.messages[turn1.input.messages.length - 1];
  assert.equal(lastMsg.role, "user");
  assert.equal(lastMsg.content[0].type, "tool_result");
  assert.equal(lastMsg.content[0].tool_use_id, "tu-1");
  assert.equal(lastMsg.content[0].content, "read x.md");
});

test("runAgentLoop dispatches tool_use even when stop_reason is not tool_use", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-1", "vault_read"),
        ev.toolUseJson(0, "{\"path\":\"x.md\"}"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "OK summary."),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(
    makeReadOnlyTool("vault_read", async (input) => `read ${input.path}`),
  );
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "Read x.md" }] }],
  }));
  const finish = events.find((e) => e.type === "tool_finish");
  assert.ok(finish);
  assert.equal(finish.content, "read x.md");
  assert.equal(provider._calls(), 2);
});

test("runAgentLoop keeps long tool chains going when stop_reason is missing", async () => {
  const toolTurn = (id, path) => ([
    ev.messageStart(),
    ev.toolUseStart(0, id, "vault_read"),
    ev.toolUseJson(0, `{"path":"${path}"}`),
    ev.blockStop(0),
    ev.messageStop(),
  ]);
  const provider = mockProvider({
    turns: [
      toolTurn("tu-1", "a.md"),
      toolTurn("tu-2", "b.md"),
      toolTurn("tu-3", "c.md"),
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "done"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const seenPaths = [];
  const registry = registryWith(
    makeReadOnlyTool("vault_read", async (input) => {
      seenPaths.push(input.path);
      return `read ${input.path}`;
    }),
  );
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "Read files" }] }],
    maxTurns: 5,
  }));
  assert.deepEqual(seenPaths, ["a.md", "b.md", "c.md"]);
  assert.equal(events.filter((e) => e.type === "tool_finish").length, 3);
  assert.equal(provider._calls(), 4);
});

// ---------------------------------------------------------------------------
// runAgentLoop — unknown tool name
// ---------------------------------------------------------------------------

test("runAgentLoop turns an unknown tool name into an is_error tool_result", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-9", "does_not_exist"),
        ev.toolUseJson(0, "{}"),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "ok"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "use the missing tool" }] }],
  }));
  const finish = events.find((e) => e.type === "tool_finish");
  assert.equal(finish.isError, true);
  assert.match(finish.content, /Unknown tool/);
});

// ---------------------------------------------------------------------------
// runAgentLoop — permission denied
// ---------------------------------------------------------------------------

test("runAgentLoop respects checkPermissions 'deny'", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-1", "vault_write"),
        ev.toolUseJson(0, "{\"path\":\"a.md\",\"content\":\"x\"}"),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "noted"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(
    makeWritingTool(
      "vault_write",
      async () => "wrote",
      { checkPermissions: async () => ({ behavior: "deny", reason: "blocked by policy" }) },
    ),
  );
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "write a.md" }] }],
  }));
  const finish = events.find((e) => e.type === "tool_finish");
  assert.equal(finish.isError, true);
  assert.match(finish.content, /blocked by policy/);
});

// ---------------------------------------------------------------------------
// runAgentLoop — permission ask + askFn allow
// ---------------------------------------------------------------------------

test("runAgentLoop forwards 'ask' to onPermissionAsk and proceeds on allow", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-w", "vault_write"),
        ev.toolUseJson(0, "{\"path\":\"a.md\"}"),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "done"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(
    makeWritingTool(
      "vault_write",
      async () => "written",
      { checkPermissions: async () => ({ behavior: "ask", summary: "ok?" }) },
    ),
  );
  let asked = null;
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "write" }] }],
    onPermissionAsk: async (req) => { asked = req; return { behavior: "allow", persist: "session" }; },
  }));
  assert.ok(asked);
  assert.equal(asked.tool, "vault_write");
  const finish = events.find((e) => e.type === "tool_finish");
  assert.equal(finish.isError, false);
});

test("runAgentLoop denies tools when checkPermissions asks but no askFn is configured", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-w", "vault_write"),
        ev.toolUseJson(0, "{\"path\":\"a.md\"}"),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "done"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(
    makeWritingTool(
      "vault_write",
      async () => "written",
      { checkPermissions: async () => ({ behavior: "ask", summary: "ok?" }) },
    ),
  );
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "write" }] }],
  }));
  const finish = events.find((e) => e.type === "tool_finish");
  assert.equal(finish.isError, true);
  assert.match(finish.content, /no askFn/);
});

test("runToolUse treats an already-aborted signal as an execution barrier", async () => {
  const phases = [];
  const controller = new AbortController();
  controller.abort();
  const tool = buildTool({
    name: "vault_write",
    description: "write",
    inputSchema: { type: "object" },
    capabilities: () => ({
      effect: "vault_mutation",
      risk: "medium",
      concurrency: "serial",
      presentation: "edit",
      targets: ["cancelled.md"],
    }),
    async validate() { phases.push("validate"); return { ok: true }; },
    async checkPermissions() { phases.push("permission"); return { behavior: "allow" }; },
    async *execute() { phases.push("execute"); yield { type: "result", content: "wrote" }; },
  });
  const registry = registryWith(tool);

  const result = await runToolUse(
    { id: "cancel-before-start", name: "vault_write", input: { path: "cancelled.md" } },
    registry,
    { signal: controller.signal, toolPermissionMode: "auto" },
    null,
  );

  assert.deepEqual(phases, []);
  assert.equal(result.outcome.state, "aborted");
  assert.equal(result.isError, true);
});

test("runToolUse checks cancellation again after an async permission decision", async () => {
  const phases = [];
  const controller = new AbortController();
  const tool = buildTool({
    name: "vault_write",
    description: "write",
    inputSchema: { type: "object" },
    capabilities: () => ({
      effect: "vault_mutation",
      risk: "medium",
      concurrency: "serial",
      presentation: "edit",
      targets: ["cancelled.md"],
    }),
    async checkPermissions() {
      phases.push("permission");
      controller.abort();
      return { behavior: "allow" };
    },
    async *execute() { phases.push("execute"); yield { type: "result", content: "wrote" }; },
  });
  const registry = registryWith(tool);

  const result = await runToolUse(
    { id: "cancel-after-permission", name: "vault_write", input: { path: "cancelled.md" } },
    registry,
    { signal: controller.signal, toolPermissionMode: "auto" },
    null,
  );

  assert.deepEqual(phases, ["permission"]);
  assert.equal(result.outcome.state, "aborted");
});

test("runToolUse centrally gates a declared side effect even when the tool hook allows", async () => {
  let executions = 0;
  const tool = buildTool({
    name: "future_mutation_tool",
    description: "future mutation",
    inputSchema: { type: "object" },
    capabilities: () => ({
      effect: "external_side_effect",
      risk: "medium",
      concurrency: "serial",
      presentation: "execute",
      targets: ["remote:item"],
    }),
    async checkPermissions() { return { behavior: "allow" }; },
    async *execute() { executions += 1; yield { type: "result", content: "changed" }; },
  });
  const result = await runToolUse(
    { id: "future-call", name: tool.name, input: {} },
    registryWith(tool),
    { toolPermissionMode: "ask" },
    null,
  );

  assert.equal(executions, 0);
  assert.equal(result.outcome.state, "denied");
  assert.match(result.content, /Permission required/);
});

test("effect receipts use declared typed targets, never paths parsed from result prose", async () => {
  const result = {
    id: "typed-effect",
    content: 'Human copy changed completely and mentions "wrong.md".',
    isError: false,
    capabilities: {
      effect: "vault_mutation",
      risk: "medium",
      concurrency: "serial",
      presentation: "edit",
      targets: ["right.md"],
    },
    outcome: {
      state: "completed",
      code: "ok",
      message: "done",
      effects: [{ kind: "vault_mutation", targets: ["right.md"] }],
    },
    verification: { verified: true, outcome: "verified" },
  };
  const receipt = await createEffectReceipt(
    { id: result.id, name: "future_write_tool", input: {} },
    result,
    {},
  );

  assert.deepEqual(receipt.paths, ["right.md"]);
  assert.equal(receipt.verified, true);
});

test("runAgentLoop auto-allows low-risk asks in dangerous-only permission mode", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-w", "vault_write"),
        ev.toolUseJson(0, "{\"path\":\"a.md\",\"mode\":\"append\"}"),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "done"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(
    makeWritingTool(
      "vault_write",
      async () => "written",
      { checkPermissions: async () => ({ behavior: "ask", summary: "append a.md" }) },
    ),
  );
  let asked = false;
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "append" }] }],
    ctx: { toolPermissionMode: "ask-dangerous", grants: {} },
    onPermissionAsk: async () => {
      asked = true;
      return { behavior: "deny" };
    },
  }));
  const finish = events.find((e) => e.type === "tool_finish");
  assert.equal(asked, false);
  assert.equal(finish.isError, false);
});

test("runAgentLoop still asks for dangerous tools in dangerous-only permission mode", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-w", "vault_write"),
        ev.toolUseJson(0, "{\"path\":\"a.md\",\"mode\":\"overwrite\"}"),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "done"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(
    buildTool({
      name: "vault_write",
      description: "write",
      inputSchema: { type: "object" },
      capabilities: (input) => ({ effect: "vault_mutation", risk: input && input.mode === "overwrite" ? "high" : "medium", concurrency: "serial", presentation: "edit", targets: ["a.md"] }),
      isReadOnly: () => false,
      isDestructive: (input) => input && input.mode === "overwrite",
      checkPermissions: async () => ({ behavior: "ask", summary: "overwrite a.md" }),
      async *execute() { yield { type: "result", content: "written" }; },
    }),
  );
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "overwrite" }] }],
    ctx: { toolPermissionMode: "ask-dangerous", grants: {} },
  }));
  const finish = events.find((e) => e.type === "tool_finish");
  assert.equal(finish.isError, true);
  assert.match(finish.content, /no askFn/);
});

test("runAgentLoop auto-allows dangerous tools in full-auto permission mode", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-w", "vault_write"),
        ev.toolUseJson(0, "{\"path\":\"a.md\",\"mode\":\"overwrite\"}"),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "done"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(
    buildTool({
      name: "vault_write",
      description: "write",
      inputSchema: { type: "object" },
      capabilities: () => ({ effect: "vault_mutation", risk: "high", concurrency: "serial", presentation: "edit", targets: ["a.md"] }),
      isReadOnly: () => false,
      isDestructive: () => true,
      checkPermissions: async () => ({ behavior: "ask", summary: "overwrite a.md" }),
      async *execute() { yield { type: "result", content: "written" }; },
    }),
  );
  let asked = false;
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "overwrite" }] }],
    ctx: { toolPermissionMode: "auto", grants: {} },
    onPermissionAsk: async () => {
      asked = true;
      return { behavior: "deny" };
    },
  }));
  const finish = events.find((e) => e.type === "tool_finish");
  assert.equal(asked, false);
  assert.equal(finish.isError, false);
});

// ---------------------------------------------------------------------------
// runAgentLoop — two read-only tools in one turn (parallel execution)
// ---------------------------------------------------------------------------

test("runAgentLoop runs read-only tool_uses concurrently and reports both finishes", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "a", "vault_read"),
        ev.toolUseJson(0, "{\"path\":\"a.md\"}"),
        ev.blockStop(0),
        ev.toolUseStart(1, "b", "vault_read"),
        ev.toolUseJson(1, "{\"path\":\"b.md\"}"),
        ev.blockStop(1),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "done"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  let runningCount = 0;
  let maxConcurrent = 0;
  const tool = buildTool({
    name: "vault_read",
    description: "read",
    inputSchema: { type: "object" },
    capabilities: (input) => ({ effect: "observation", risk: "low", concurrency: "parallel", presentation: "read", targets: input && input.path ? [input.path] : [] }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input) {
      runningCount += 1;
      maxConcurrent = Math.max(maxConcurrent, runningCount);
      await new Promise((r) => setTimeout(r, 5));
      runningCount -= 1;
      yield { type: "result", content: `read ${input.path}` };
    },
  });
  const registry = new ToolRegistry();
  registry.register(tool);

  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "read both" }] }],
  }));
  const finishes = events.filter((e) => e.type === "tool_finish");
  assert.equal(finishes.length, 2);
  assert.deepEqual(finishes.map((f) => f.content).sort(), ["read a.md", "read b.md"]);
  assert.ok(maxConcurrent >= 2, "expected at least 2 concurrent read-only runs");
});

test("runAgentLoop preserves write-before-read order within one tool batch", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "w", "vault_write"),
        ev.toolUseJson(0, "{\"path\":\"a.md\",\"content\":\"new\"}"),
        ev.blockStop(0),
        ev.toolUseStart(1, "r", "vault_read"),
        ev.toolUseJson(1, "{\"path\":\"a.md\"}"),
        ev.blockStop(1),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "done"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  let fileText = "old";
  const executionOrder = [];
  const registry = registryWith(
    makeWritingTool("vault_write", async (input) => {
      executionOrder.push("write");
      fileText = input.content;
      return "written";
    }),
    makeReadOnlyTool("vault_read", async () => {
      executionOrder.push("read");
      return fileText;
    }),
  );

  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "write then read" }] }],
  }));
  assert.deepEqual(executionOrder, ["write", "read"]);
  const readFinish = events.find((e) => e.type === "tool_finish" && e.tool === "vault_read");
  assert.equal(readFinish.content, "new");
});

// ---------------------------------------------------------------------------
// runAgentLoop — resumable safety boundaries
// ---------------------------------------------------------------------------

test("runAgentLoop has no arbitrary default turn ceiling for productive workflows", async () => {
  const toolTurn = (index) => ([
    ev.messageStart(),
    ev.toolUseStart(0, `id-${index}`, "vault_read"),
    ev.toolUseJson(0, JSON.stringify({ path: `note-${index}.md` })),
    ev.blockStop(0),
    ev.messageDelta("tool_use"),
    ev.messageStop(),
  ]);
  const turns = Array.from({ length: 21 }, (_, index) => toolTurn(index));
  turns.push([
    ev.messageStart(),
    ev.textBlockStart(0),
    ev.textDelta(0, "all notes inspected"),
    ev.blockStop(0),
    ev.messageDelta("end_turn"),
    ev.messageStop(),
  ]);
  const provider = mockProvider({ turns });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeReadOnlyTool("vault_read", async (input) => input.path)),
    messages: [{ role: "user", content: [{ type: "text", text: "inspect all notes" }] }],
  }));

  assert.equal(provider._calls(), 22);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("an explicit maxTurns safety boundary produces a resumable suspension, not a failure", async () => {
  // Always returns tool_use → infinite loop without bound.
  const loopingTurn = () => ([
    ev.messageStart(),
    ev.toolUseStart(0, `id-${Math.random()}`, "vault_read"),
    ev.toolUseJson(0, "{\"path\":\"a.md\"}"),
    ev.blockStop(0),
    ev.messageDelta("tool_use"),
    ev.messageStop(),
  ]);
  const provider = mockProvider({
    turns: [loopingTurn(), loopingTurn(), loopingTurn(), loopingTurn()],
  });
  const registry = registryWith(
    makeReadOnlyTool("vault_read", async () => "..."),
  );
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    maxTurns: 2,
  }));
  const suspended = events.find((e) => e.type === "suspended");
  assert.ok(suspended);
  assert.equal(suspended.reason, "turn_boundary");
  assert.equal(suspended.turns, 2);
  assert.equal(suspended.checkpoint.version, 1);
  assert.equal(Array.isArray(suspended.checkpoint.messages), true);
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("repeating the exact same tool turn suspends on no progress instead of looping forever", async () => {
  const repeatedTurn = (id) => ([
    ev.messageStart(),
    ev.toolUseStart(0, id, "vault_read"),
    ev.toolUseJson(0, '{"path":"same.md"}'),
    ev.blockStop(0),
    ev.messageDelta("tool_use"),
    ev.messageStop(),
  ]);
  const provider = mockProvider({ turns: [
    repeatedTurn("same-1"),
    repeatedTurn("same-2"),
    repeatedTurn("same-3"),
    repeatedTurn("same-4"),
  ] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeReadOnlyTool("vault_read", async () => "unchanged")),
    messages: [{ role: "user", content: [{ type: "text", text: "inspect" }] }],
  }));

  assert.equal(provider._calls(), 4);
  assert.equal(events.at(-1).type, "suspended");
  assert.equal(events.at(-1).reason, "no_progress");
});

test("a tool suspension stops the batch before later mutations and yields a protocol-valid checkpoint", async () => {
  let writes = 0;
  const suspendTool = buildTool({
    name: "ask_user",
    description: "ask",
    inputSchema: { type: "object" },
    capabilities: {
      effect: "none",
      risk: "low",
      concurrency: "serial",
      presentation: "question",
      targets: [],
    },
    async *execute() {
      yield {
        type: "result",
        content: "Question dismissed.",
        code: "user_input_dismissed",
        control: { type: "suspend", reason: "user_input_dismissed" },
      };
    },
  });
  const provider = mockProvider({ turns: [[
    ev.messageStart(),
    ev.toolUseStart(0, "ask-1", "ask_user"),
    ev.toolUseJson(0, "{}"),
    ev.blockStop(0),
    ev.toolUseStart(1, "write-1", "vault_write"),
    ev.toolUseJson(1, '{"path":"must-not-write.md"}'),
    ev.blockStop(1),
    ev.messageDelta("tool_use"),
    ev.messageStop(),
  ]] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(
      suspendTool,
      makeWritingTool("vault_write", async () => { writes += 1; return "written"; }),
    ),
    messages: [{ role: "user", content: [{ type: "text", text: "ask then write" }] }],
  }));

  assert.equal(writes, 0);
  const suspended = events.find((event) => event.type === "suspended");
  assert.equal(suspended.reason, "user_input_dismissed");
  const checkpointText = JSON.stringify(suspended.checkpoint.messages);
  assert.match(checkpointText, /ask-1/);
  assert.match(checkpointText, /write-1/);
  assert.match(checkpointText, /not executed/i);
});

test("an interaction barrier defers a mutation even when the model placed the write first", async () => {
  let writes = 0;
  const askTool = buildTool({
    name: "ask_user",
    description: "ask",
    inputSchema: { type: "object" },
    capabilities: { effect: "none", risk: "low", concurrency: "serial", presentation: "question", targets: [] },
    async *execute() {
      yield { type: "result", content: "A: keep going" };
    },
  });
  const provider = mockProvider({ turns: [
    [
      ev.messageStart(),
      ev.toolUseStart(0, "write-first", "vault_write"),
      ev.toolUseJson(0, '{"path":"unsafe.md"}'),
      ev.blockStop(0),
      ev.toolUseStart(1, "ask-second", "ask_user"),
      ev.toolUseJson(1, "{}"),
      ev.blockStop(1),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
    [
      ev.messageStart(),
      ev.textBlockStart(0),
      ev.textDelta(0, "waiting decision handled"),
      ev.blockStop(0),
      ev.messageDelta("end_turn"),
      ev.messageStop(),
    ],
  ] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(
      makeWritingTool("vault_write", async () => { writes += 1; return "written"; }),
      askTool,
    ),
    messages: [{ role: "user", content: [{ type: "text", text: "write after asking" }] }],
  }));

  assert.equal(writes, 0);
  assert.equal(events.at(-1).type, "done");
  assert.match(JSON.stringify(provider._seen[1].input.messages), /waiting for user input/);
});

test("skill allowed-tools narrows the next API tool surface and rejects a forged out-of-policy call", async () => {
  let reads = 0;
  let writes = 0;
  const invoke = makeReadOnlyTool("skill_invoke", async () => "loaded");
  invoke.resolveSkillAllowedTools = () => ["vault_read"];
  const provider = mockProvider({ turns: [
    [
      ev.messageStart(), ev.toolUseStart(0, "skill-1", "skill_invoke"),
      ev.toolUseJson(0, '{"skill":"read-only"}'), ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
    ],
    [
      ev.messageStart(), ev.toolUseStart(0, "forged-write", "vault_write"),
      ev.toolUseJson(0, '{"path":"unsafe.md"}'), ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
    ],
    [ev.messageStart(), ev.textBlockStart(0), ev.textDelta(0, "blocked"), ev.blockStop(0), ev.messageDelta("end_turn"), ev.messageStop()],
  ] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(
      invoke,
      makeReadOnlyTool("vault_read", async () => { reads += 1; return "read"; }),
      makeWritingTool("vault_write", async () => { writes += 1; return "written"; }),
    ),
    messages: [{ role: "user", content: [{ type: "text", text: "use skill" }] }],
  }));

  assert.deepEqual(provider._seen[1].input.tools.map((tool) => tool.name).sort(), ["skill_invoke", "vault_read"]);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  const blocked = events.find((event) => event.type === "tool_finish" && event.toolUseId === "forged-write");
  assert.equal(blocked.isError, true);
  assert.equal(blocked.outcome.code, "skill_tool_not_allowed");
});

test("initial skill policy preserves host protocol tools and rejects unknown declarations before provider use", async () => {
  const invoke = makeReadOnlyTool("skill_invoke", async () => "loaded");
  const resource = makeReadOnlyTool("skill_resource_read", async () => "resource");
  const provider = mockProvider({ turns: [[
    ev.messageStart(), ev.textBlockStart(0), ev.textDelta(0, "done"), ev.blockStop(0), ev.messageDelta("end_turn"), ev.messageStop(),
  ]] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(invoke, resource, makeReadOnlyTool("vault_read", async () => "read"), makeWritingTool("vault_write", async () => "write")),
    messages: [{ role: "user", content: [{ type: "text", text: "/skill" }] }],
    allowedToolPolicy: ["vault_read"],
    executionContract: explicitWorkflowContract(),
  }));
  assert.deepEqual(provider._seen[0].input.tools.map((tool) => tool.name).sort(), [
    "skill_invoke", "skill_resource_read", "vault_read",
  ]);
  assert.equal(events.at(-1).type, "done");

  const invalidProvider = mockProvider({ turns: [] });
  const invalidEvents = await collect(runAgentLoop({
    provider: invalidProvider,
    registry: registryWith(invoke),
    messages: [],
    allowedToolPolicy: ["does_not_exist"],
  }));
  assert.equal(invalidProvider._calls(), 0);
  assert.equal(invalidEvents[0].error.code, "SKILL_ALLOWED_TOOL_INVALID");
});

test("a suspension checkpoint restores its saved tool policy ahead of caller defaults", async () => {
  const invoke = makeReadOnlyTool("skill_invoke", async () => "loaded");
  invoke.resolveSkillAllowedTools = () => ["vault_read"];
  const first = mockProvider({ turns: [[
    ev.messageStart(), ev.toolUseStart(0, "skill-1", "skill_invoke"),
    ev.toolUseJson(0, '{"skill":"read-only"}'), ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
  ]] });
  const registry = registryWith(invoke, makeReadOnlyTool("vault_read", async () => "read"), makeWritingTool("vault_write", async () => "write"));
  const firstEvents = await collect(runAgentLoop({
    provider: first, registry, messages: [], maxTurns: 1,
  }));
  const checkpoint = firstEvents.at(-1).checkpoint;
  assert.deepEqual(checkpoint.allowedToolPolicy, { version: 1, restricted: true, allowedTools: ["vault_read"] });

  const resumed = mockProvider({ turns: [[
    ev.messageStart(), ev.textBlockStart(0), ev.textDelta(0, "continued"), ev.blockStop(0), ev.messageDelta("end_turn"), ev.messageStop(),
  ]] });
  await collect(runAgentLoop({
    provider: resumed,
    registry,
    messages: checkpoint.messages,
    allowedToolPolicy: ["vault_write"],
    resumeState: {
      effectReceipts: checkpoint.effectReceipts,
      completionRetries: checkpoint.completionRetries,
      turns: checkpoint.turns,
      allowedToolPolicy: checkpoint.allowedToolPolicy,
    },
  }));
  assert.deepEqual(resumed._seen[0].input.tools.map((tool) => tool.name).sort(), ["skill_invoke", "vault_read"]);
});

test("a dynamically invoked skill with an unknown allowed tool fails closed as a typed tool result", async () => {
  const invoke = makeReadOnlyTool("skill_invoke", async () => "loaded");
  invoke.resolveSkillAllowedTools = () => ["not_a_real_tool"];
  const provider = mockProvider({ turns: [
    [
      ev.messageStart(), ev.toolUseStart(0, "skill-1", "skill_invoke"),
      ev.toolUseJson(0, '{"skill":"broken"}'), ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
    ],
    [ev.messageStart(), ev.textBlockStart(0), ev.textDelta(0, "stopped"), ev.blockStop(0), ev.messageDelta("end_turn"), ev.messageStop()],
  ] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(invoke, makeReadOnlyTool("vault_read", async () => "read")),
    messages: [],
  }));
  const rejected = events.find((event) => event.type === "tool_finish" && event.toolUseId === "skill-1");
  assert.equal(rejected.isError, true);
  assert.equal(rejected.outcome.code, "skill_allowed_tool_invalid");
  assert.match(rejected.content, /Unknown allowed tool/);
});

for (const declared of [[], ["vault_write"]]) {
  test(`an empty Skill policy intersection stays restricted after loading ${JSON.stringify(declared)}`, async () => {
    let writes = 0;
    const invoke = makeReadOnlyTool("skill_invoke", async () => "loaded");
    invoke.resolveSkillAllowedTools = (input) => input.skill === "search" ? ["vault_search"] : declared;
    const toolTurn = (id, name, input) => [
      ev.messageStart(), ev.toolUseStart(0, id, name), ev.toolUseJson(0, JSON.stringify(input)),
      ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
    ];
    const provider = mockProvider({ turns: [
      toolTurn("narrow", "skill_invoke", { skill: "search" }),
      toolTurn("reload", "skill_invoke", { skill: "next" }),
      toolTurn("forged-write", "vault_write", { path: "unsafe.md" }),
    ] });
    const events = await collect(runAgentLoop({
      provider,
      registry: registryWith(
        invoke,
        makeReadOnlyTool("vault_read", async () => "read"),
        makeReadOnlyTool("vault_search", async () => "search"),
        makeWritingTool("vault_write", async () => { writes += 1; return "written"; }),
      ),
      messages: [], allowedToolPolicy: ["vault_read"], maxTurns: 3,
    }));
    assert.equal(writes, 0);
    assert.deepEqual(provider._seen[2].input.tools.map((tool) => tool.name), ["skill_invoke"]);
    const rejected = events.find((event) => event.type === "tool_finish" && event.toolUseId === "forged-write");
    assert.equal(rejected.outcome.code, "skill_tool_not_allowed");
  });
}

test("resuming an empty Skill policy intersection never restores ordinary tool permissions", async () => {
  let writes = 0;
  const invoke = makeReadOnlyTool("skill_invoke", async () => "loaded");
  invoke.resolveSkillAllowedTools = () => ["vault_search"];
  const registry = registryWith(
    invoke,
    makeReadOnlyTool("vault_read", async () => "read"),
    makeReadOnlyTool("vault_search", async () => "search"),
    makeWritingTool("vault_write", async () => { writes += 1; return "written"; }),
  );
  const first = mockProvider({ turns: [[
    ev.messageStart(), ev.toolUseStart(0, "narrow", "skill_invoke"), ev.toolUseJson(0, "{}"),
    ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
  ]] });
  const firstEvents = await collect(runAgentLoop({
    provider: first, registry, messages: [], allowedToolPolicy: ["vault_read"], maxTurns: 1,
  }));
  const checkpoint = JSON.parse(JSON.stringify(firstEvents.at(-1).checkpoint));
  assert.deepEqual(checkpoint.allowedToolPolicy, { version: 1, restricted: true, allowedTools: [] });
  const resumed = mockProvider({ turns: [[
    ev.messageStart(), ev.toolUseStart(0, "forged-write", "vault_write"),
    ev.toolUseJson(0, '{"path":"unsafe.md"}'), ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
  ]] });
  const events = await collect(runAgentLoop({
    provider: resumed, registry, messages: checkpoint.messages, resumeState: checkpoint,
    allowedToolPolicy: ["vault_write"], maxTurns: 1,
  }));
  assert.equal(writes, 0);
  assert.deepEqual(resumed._seen[0].input.tools.map((tool) => tool.name), ["skill_invoke"]);
  assert.equal(events.find((event) => event.type === "tool_finish").outcome.code, "skill_tool_not_allowed");
});

test("a non-empty Skill policy survives a JSON checkpoint round trip and keeps resume restricted", async () => {
  const { validateContinuationCheckpoint } = require("../../../runtime/agent/continuation-checkpoint");
  let writes = 0;
  const registry = registryWith(
    makeReadOnlyTool("vault_read", async () => "read"),
    makeReadOnlyTool("vault_search", async () => "search"),
    makeWritingTool("vault_write", async () => { writes += 1; return "written"; }),
  );
  const first = mockProvider({ turns: [[
    ev.messageStart(), ev.toolUseStart(0, "read", "vault_read"), ev.toolUseJson(0, '{"path":"a.md"}'),
    ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
  ]] });
  const firstEvents = await collect(runAgentLoop({
    provider: first, registry, messages: [], allowedToolPolicy: ["vault_read"], maxTurns: 1,
  }));
  const checkpoint = JSON.parse(JSON.stringify(firstEvents.at(-1).checkpoint));
  assert.equal(validateContinuationCheckpoint(checkpoint).ok, true);
  assert.deepEqual(checkpoint.allowedToolPolicy, { version: 1, restricted: true, allowedTools: ["vault_read"] });

  const resumed = mockProvider({ turns: [[
    ev.messageStart(), ev.toolUseStart(0, "forged-write", "vault_write"),
    ev.toolUseJson(0, '{"path":"unsafe.md"}'), ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
  ]] });
  // A resume request carries no explicit Skill, so the caller default is
  // unrestricted. The saved checkpoint policy must still win.
  const events = await collect(runAgentLoop({
    provider: resumed, registry, messages: checkpoint.messages, resumeState: checkpoint, maxTurns: 1,
  }));
  assert.equal(writes, 0);
  assert.deepEqual(resumed._seen[0].input.tools.map((tool) => tool.name), ["vault_read"]);
  assert.equal(events.find((event) => event.type === "tool_finish").outcome.code, "skill_tool_not_allowed");
  assert.equal(Object.hasOwn(require("../../../runtime/agent/skill-tool-policy"), "policyCheckpointValue"), false);
});

test("an undeclared empty allowed-tools list remains unrestricted", () => {
  const { normalizeAllowedToolPolicy } = require("../../../runtime/agent/skill-tool-policy");
  assert.deepEqual(normalizeAllowedToolPolicy([], new ToolRegistry()).policy, {
    version: 1, restricted: false, allowedTools: [],
  });
});

test("runAgentLoop refuses an oversized unique history before provider dispatch", async () => {
  const provider = mockProvider({ turns: [[
    ev.messageStart(), ev.textBlockStart(0), ev.textDelta(0, "done"), ev.blockStop(0), ev.messageDelta("end_turn"), ev.messageStop(),
  ]] });
  provider.spec.models = [{ id: "test", contextWindow: 5_000, maxOutput: 2_000 }];
  provider.countTokens = async (messages) => Math.ceil(JSON.stringify(messages).length / 4);
  const messages = [
    { role: "user", content: [{ type: "text", text: "inspect notes" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "old-read", name: "vault_read", input: { path: "old.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "old-read", content: "old".repeat(12_000) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "recent-read-1", name: "vault_read", input: { path: "recent-1.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "recent-read-1", content: "short" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "recent-read-2", name: "vault_read", input: { path: "recent-2.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "recent-read-2", content: "short" }] },
    { role: "user", content: [{ type: "text", text: "RECENT_CONTEXT" }] },
  ];

  const events = await collect(runAgentLoop({ provider, registry: new ToolRegistry(), messages, maxTokensPerTurn: 2_000 }));
  assert.equal(provider._seen.length, 0);
  assert.equal(events.at(-1).error.code, "CONTEXT_WINDOW_EXCEEDED");
  assert.equal(messages[2].content[0].content, "old".repeat(12_000));
});

test("long workflows preserve unique evidence across a continuation without replaying tools", async () => {
  const toolTurn = (index) => ([
    ev.messageStart(), ev.toolUseStart(0, `read-${index}`, "vault_read"),
    ev.toolUseJson(0, JSON.stringify({ path: `note-${index}.md` })),
    ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
  ]);
  const finalTurn = [
    ev.messageStart(), ev.textBlockStart(0), ev.textDelta(0, "review complete"),
    ev.blockStop(0), ev.messageDelta("end_turn"), ev.messageStop(),
  ];
  const firstProvider = mockProvider({ turns: Array.from({ length: 25 }, (_, index) => toolTurn(index)) });
  firstProvider.spec.models = [{ id: "test", contextWindow: 1_000_000, maxOutput: 384_000 }];
  const executed = [];
  const registry = registryWith(makeReadOnlyTool("vault_read", async ({ path }) => {
    executed.push(path);
    return `${path}:` + "evidence ".repeat(1500);
  }));
  const instruction = "Review every note and preserve the user's original instruction.";
  const first = await collect(runAgentLoop({
    provider: firstProvider, registry,
    messages: [{ role: "user", content: [{ type: "text", text: instruction }] }],
    maxTokensPerTurn: 384_000, maxTurns: 25,
  }));
  const suspended = first.at(-1);
  assert.equal(suspended.type, "suspended");
  assert.equal(suspended.reason, "turn_boundary");
  assert.equal(first.filter((event) => event.type === "context_usage").length, 25);
  assert.equal(first.some((event) => event.type === "context_usage" && event.compacted), false);
  assert.equal(first.some((event) => event.type === "context_usage" && event.overEconomicTarget), true);

  const resumedProvider = mockProvider({ turns: [
    ...Array.from({ length: 5 }, (_, index) => toolTurn(index + 25)), finalTurn,
  ] });
  resumedProvider.spec.models = firstProvider.spec.models;
  const resumed = await collect(runAgentLoop({
    provider: resumedProvider, registry,
    messages: suspended.checkpoint.messages,
    resumeState: { turns: suspended.checkpoint.turns },
    maxTokensPerTurn: 384_000,
  }));
  assert.equal(resumed.at(-1).type, "done");
  assert.deepEqual(executed, Array.from({ length: 30 }, (_, index) => `note-${index}.md`));
  const usage = resumed.filter((event) => event.type === "context_usage");
  assert.equal(usage.length, 6);
  assert.ok(usage.every((event) => event.promptTokens < event.contextWindow - event.maxTokens));
  assert.ok(usage.every((event) => event.contextWindow === 1_000_000 && event.maxTokens === 384_000));
  assert.ok(usage.every((event) => !Object.hasOwn(event, "messages")));
  const lastInput = resumedProvider._seen.at(-1).input.messages;
  assert.equal(lastInput[0].content[0].text, instruction);
  assert.doesNotMatch(JSON.stringify(lastInput), /FLOWNOTE_CONTEXT_PROJECTION/);
  for (let index = 0; index < 30; index += 1) {
    const result = lastInput.flatMap((message) => message.content || []).find((block) => block.tool_use_id === `read-${index}`);
    assert.equal(result.content, `note-${index}.md:` + "evidence ".repeat(1500));
  }
  assert.match(JSON.stringify(lastInput), /note-29\.md/);
  assert.equal(lastInput.at(-1).content[0].content.includes("evidence"), true);
});

// ---------------------------------------------------------------------------
// runAgentLoop — invalid arguments
// ---------------------------------------------------------------------------

test("runAgentLoop throws when provider is missing", async () => {
  await assert.rejects(
    () => runAgentLoop({ registry: new ToolRegistry(), messages: [] }).next(),
    /provider with createMessage required/,
  );
});

test("runAgentLoop throws when registry is missing", async () => {
  const provider = mockProvider({ turns: [] });
  await assert.rejects(
    () => runAgentLoop({ provider, messages: [] }).next(),
    /registry required/,
  );
});

test("runAgentLoop throws when messages is not an array", async () => {
  const provider = mockProvider({ turns: [] });
  await assert.rejects(
    () => runAgentLoop({ provider, registry: new ToolRegistry(), messages: undefined }).next(),
    /messages array required/,
  );
});

// ---------------------------------------------------------------------------
// End-of-turn host check and measured receipts
// ---------------------------------------------------------------------------

function textTurn(text) {
  return [ev.messageStart(), ev.textBlockStart(0), ev.textDelta(0, text), ev.blockStop(0), ev.messageDelta("end_turn"), ev.messageStop()];
}

function toolTurn(id, name, input) {
  return [
    ev.messageStart(), ev.toolUseStart(0, id, name), ev.toolUseJson(0, JSON.stringify(input)),
    ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
  ];
}

test("a rejected stop check returns internal feedback to the model, which then acts", async () => {
  let writes = 0;
  const provider = mockProvider({ turns: [
    textTurn("已写入 x.md。"),
    toolTurn("w1", "vault_write", { path: "x.md", content: "hello" }),
    textTurn("已写入 x.md。"),
  ] });
  const checks = [];
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeWritingTool("vault_write", async () => { writes += 1; return "Wrote x.md"; })),
    messages: [{ role: "user", content: [{ type: "text", text: "写入 x.md" }] }],
    stopCheck: async (turn) => {
      checks.push(turn);
      return checks.length === 1
        ? { allow: false, feedback: "[FLOWNOTE_HOST_CHECK] no change was measured", issues: [{ type: "unbacked_claims" }] }
        : { allow: true };
    },
  }));

  assert.equal(writes, 1);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].provider, provider);
  assert.equal(checks[0].finalContent[0].text, "已写入 x.md。");
  const retry = events.find((event) => event.type === "completion_retry");
  assert.deepEqual(retry.issues, ["unbacked_claims"]);
  const secondRequest = provider._seen[1].input.messages;
  assert.equal(secondRequest.at(-2).content[0].text, "已写入 x.md。");
  assert.match(secondRequest.at(-1).content[0].text, /FLOWNOTE_HOST_CHECK/);
  assert.equal(events.at(-1).type, "done");
});

test("stop-check feedback is bounded and never turns an answer into an error", async () => {
  const provider = mockProvider({ turns: [textTurn("done 1"), textTurn("done 2"), textTurn("done 3"), textTurn("unused")] });
  let calls = 0;
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(),
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    stopCheck: async () => { calls += 1; return { allow: false, feedback: "fix it" }; },
  }));
  assert.equal(calls, 2);
  assert.equal(provider._calls(), 3);
  assert.equal(events.filter((event) => event.type === "completion_retry").length, 2);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("a failing stop check lets a finished answer stand", async () => {
  const provider = mockProvider({ turns: [textTurn("answer")] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(),
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    stopCheck: async () => { throw new Error("audit offline"); },
  }));
  assert.equal(events.at(-1).type, "done");
});

function recordingVaultApp(initial) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    app: {
      vault: {
        getAbstractFileByPath: (path) => (files.has(path) ? { path } : null),
        getFileByPath: (path) => (files.has(path) ? { path } : null),
        read: async (file) => files.get(file.path),
        modify: async (file, content) => { files.set(file.path, content); },
        create: async (path, content) => { files.set(path, content); return { path }; },
      },
    },
  };
}

test("a successful mutation receipt names the measured path; a no-op success is not verified", async () => {
  const { app, files } = recordingVaultApp({ "Meta/.ai-memory/STATUS.md": "old" });
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  const tools = recorder.instrumentApp(app);
  const verifiedTool = (name, run) => buildTool({
    name,
    description: name,
    inputSchema: { type: "object" },
    capabilities: () => ({ effect: "vault_mutation", risk: "medium", concurrency: "serial", presentation: "edit", targets: ["Meta/ai-memory/STATUS.md"] }),
    isReadOnly: () => false,
    checkPermissions: async () => ({ behavior: "allow" }),
    verifyEffect: async () => ({ verified: true, outcome: "verified" }),
    async *execute() {
      await run();
      yield { type: "result", content: "ok", effects: [{ kind: "vault_mutation", targets: ["Meta/ai-memory/STATUS.md"] }] };
    },
  });
  const registry = registryWith(
    verifiedTool("real_edit", () => tools.vault.modify({ path: "Meta/.ai-memory/STATUS.md" }, "new")),
    verifiedTool("noop_edit", async () => {}),
  );
  const provider = mockProvider({ turns: [
    toolTurn("e1", "real_edit", {}),
    toolTurn("e2", "noop_edit", {}),
    textTurn("done"),
  ] });
  const events = await collect(runAgentLoop({
    provider, registry, messages: [], ctx: { changeRecorder: recorder },
  }));
  const receipts = events.filter((event) => event.type === "effect_receipt").map((event) => event.receipt);
  assert.equal(files.get("Meta/.ai-memory/STATUS.md"), "new");
  assert.equal(receipts[0].verified, true);
  assert.deepEqual(receipts[0].paths, ["Meta/.ai-memory/STATUS.md"]);
  assert.equal(receipts[1].verified, false);
  assert.equal(receipts[1].outcome, "no_observed_change");
});

test("a mutation tool that declares parallel concurrency is still measured serially", async () => {
  const { app } = recordingVaultApp({});
  app.vault.getFolderByPath = () => null;
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  const parallelMkdir = buildTool({
    name: "mkdir_existing",
    description: "mkdir",
    inputSchema: { type: "object" },
    capabilities: () => ({ effect: "vault_mutation", risk: "low", concurrency: "parallel", presentation: "edit", targets: ["Existing"] }),
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: "allow" }),
    verifyEffect: async () => ({ verified: true, outcome: "verified" }),
    async *execute() { yield { type: "result", content: "already exists" }; },
  });
  const provider = mockProvider({ turns: [toolTurn("m1", "mkdir_existing", {}), textTurn("done")] });
  const events = await collect(runAgentLoop({
    provider, registry: registryWith(parallelMkdir), messages: [], ctx: { changeRecorder: recorder },
  }));
  const receipt = events.find((event) => event.type === "effect_receipt").receipt;
  assert.equal(receipt.verified, false);
  assert.equal(receipt.outcome, "no_observed_change");
});
