const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runAgentLoop,
  consumeStream,
  runToolUse,
  createEffectReceipt,
} = require("../../../runtime/agent/agent-loop");
const {
  WORKFLOW_FINISH_TOOL_NAME,
  createExplicitSkillWorkflowContract,
} = require("../../../runtime/agent/execution-contract");
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

function answerWorkflowContract() {
  return createExplicitSkillWorkflowContract({
    skillName: "answer-skill",
    command: "/answer-skill",
    completionPolicy: {
      state: "declared",
      mode: "answer",
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

test("an effect skill cannot downgrade itself to answer-only completion", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "finish-1", WORKFLOW_FINISH_TOOL_NAME),
        ev.toolUseJson(0, '{"status":"completed","mode":"answer","reason":"Answered"}'),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.toolUseStart(0, "finish-cancelled", WORKFLOW_FINISH_TOOL_NAME),
        ev.toolUseJson(0, '{"status":"cancelled","reason":"Cannot perform the required effect"}'),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
    ],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "/ah-card" }] }],
    executionContract: explicitWorkflowContract(),
  }));

  assert.ok(provider._seen[0].input.tools.some((tool) => tool.name === WORKFLOW_FINISH_TOOL_NAME));
  assert.equal(events.some((event) => event.type === "tool_start" || event.type === "tool_finish"), false);
  const feedback = provider._seen[1].input.messages.at(-1).content[0];
  assert.equal(feedback.tool_use_id, "finish-1");
  assert.equal(feedback.is_error, true);
  assert.match(feedback.content, /host requires effect/i);
  assert.equal(events.find((event) => event.type === "workflow_finish").disposition, "cancelled");
  assert.equal(events.some((event) => event.disposition === "completed"), false);
  assert.equal(provider._calls(), 2);
});

test("a skill with a required interaction rejects a model-owned blocked terminal and records a real question", async () => {
  const provider = mockProvider({ turns: [
    [
      ev.messageStart(),
      ev.toolUseStart(0, "write-skeleton", "vault_write"),
      ev.toolUseJson(0, '{"path":"Daily.md","content":"skeleton"}'),
      ev.blockStop(0),
      ev.toolUseStart(1, "finish-with-prose", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(1, '{"status":"blocked","reason":"Waiting for user confirmation"}'),
      ev.blockStop(1),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
    [
      ev.messageStart(),
      ev.toolUseStart(0, "ask-plan", "ask_user"),
      ev.toolUseJson(0, '{"questions":[{"question":"Should yesterday plan change?"}]}'),
      ev.blockStop(0),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
    [
      ev.messageStart(),
      ev.toolUseStart(0, "finish-after-question", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(0, '{"status":"completed","mode":"effect","reason":"Confirmed and saved"}'),
      ev.blockStop(0),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
  ] });
  const contract = createExplicitSkillWorkflowContract({
    skillName: "ah-note",
    command: "/ah-note",
    completionPolicy: {
      state: "declared",
      mode: "effect",
      requiredEffects: [],
      requiredInteractions: ["ask_user"],
      minReceipts: null,
      errorCode: null,
    },
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(
      makeWritingTool("vault_write", async () => "Created Daily.md"),
      makeQuestionTool("ask_user", async () => "User confirmed yesterday's plan"),
    ),
    messages: [{ role: "user", content: [{ type: "text", text: "/ah-note" }] }],
    executionContract: contract,
    ctx: {
      async verifyToolEffect({ toolUse }) {
        return {
          kind: "vault_mutation",
          toolUseId: toolUse.id,
          tool: toolUse.name,
          paths: [toolUse.input.path],
          verified: true,
          outcome: "verified",
        };
      },
    },
  }));

  const rejection = provider._seen[1].input.messages.at(-1).content
    .find((block) => block.tool_use_id === "finish-with-prose");
  assert.equal(rejection.is_error, true);
  assert.match(rejection.content, /invalid workflow finish declaration/i);
  assert.deepEqual(events.filter((event) => event.type === "interaction_receipt").map((event) => event.receipt.tool), ["ask_user"]);
  assert.equal(events.find((event) => event.type === "workflow_finish").disposition, "completed");
  assert.equal(provider._calls(), 3);
});

test("an empty ask_user response cannot satisfy a required interaction contract", async () => {
  const provider = mockProvider({ turns: [
    [
      ev.messageStart(),
      ev.toolUseStart(0, "ask-empty", "ask_user"),
      ev.toolUseJson(0, JSON.stringify({ questions: [{
        question: "Apply this change?",
        header: "Confirm",
        options: [
          { label: "Apply", description: "Apply the change." },
          { label: "Cancel", description: "Do not apply the change." },
        ],
      }] })),
      ev.blockStop(0),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
    [
      ev.messageStart(),
      ev.toolUseStart(0, "finish-after-empty", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(0, '{"status":"completed","mode":"answer","reason":"Done"}'),
      ev.blockStop(0),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
  ] });
  const contract = createExplicitSkillWorkflowContract({
    skillName: "confirm-first",
    command: "/confirm-first",
    completionPolicy: {
      state: "declared",
      mode: "answer",
      requiredEffects: [],
      requiredInteractions: ["ask_user"],
      minReceipts: null,
      errorCode: null,
    },
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(createAskUserTool()),
    messages: [{ role: "user", content: [{ type: "text", text: "/confirm-first" }] }],
    executionContract: contract,
    maxTurns: 2,
    ctx: {
      askUserFn: async () => ({ answers: { "Apply this change?": "" } }),
    },
  }));

  assert.equal(events.some((event) => event.type === "interaction_receipt"), false);
  assert.equal(events.some((event) => event.type === "workflow_finish"), false);
  assert.equal(events.at(-1).type, "suspended");
  assert.match(JSON.stringify(provider._seen[1].input.messages), /no answer was provided/i);
  assert.match(JSON.stringify(provider._seen[1].input.messages), /is_error/i);
});

test("an answer skill may complete without an effect receipt", async () => {
  const provider = mockProvider({ turns: [[
    ev.messageStart(),
    ev.toolUseStart(0, "finish-answer", WORKFLOW_FINISH_TOOL_NAME),
    ev.toolUseJson(0, '{"status":"completed","mode":"answer","reason":"Answered"}'),
    ev.blockStop(0),
    ev.messageDelta("tool_use"),
    ev.messageStop(),
  ]] });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "/answer-skill" }] }],
    executionContract: answerWorkflowContract(),
  }));

  assert.deepEqual(events.find((event) => event.type === "workflow_finish"), {
    type: "workflow_finish",
    disposition: "completed",
    declaration: { status: "completed", mode: "answer", reason: "Answered" },
    verified: true,
  });
  assert.equal(events.find((event) => event.type === "done").verified, true);
});

test("a workflow verifies same-turn effects before accepting its finish declaration", async () => {
  const provider = mockProvider({
    turns: [[
      ev.messageStart(),
      ev.toolUseStart(0, "finish-effect", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(0, '{"status":"completed","mode":"effect","target_paths":["Cards/new.md"],"reason":"Card saved"}'),
      ev.blockStop(0),
      ev.toolUseStart(1, "write-card", "vault_write"),
      ev.toolUseJson(1, '{"path":"Cards/new.md","content":"card"}'),
      ev.blockStop(1),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ]],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeWritingTool("vault_write", async () => "Created card")),
    messages: [{ role: "user", content: [{ type: "text", text: "/ah-card" }] }],
    executionContract: explicitWorkflowContract(),
    ctx: {
      async verifyToolEffect({ toolUse, result }) {
        return {
          kind: "vault_mutation",
          toolUseId: toolUse.id,
          tool: toolUse.name,
          paths: [toolUse.input.path],
          outcome: result.isError ? "failed" : "verified",
          verified: !result.isError,
        };
      },
    },
  }));

  assert.deepEqual(events.filter((event) => event.type === "tool_start").map((event) => event.tool), ["vault_write"]);
  assert.equal(events.find((event) => event.type === "effect_receipt").receipt.verified, true);
  assert.deepEqual(events.find((event) => event.type === "workflow_finish"), {
    type: "workflow_finish",
    disposition: "completed",
    declaration: {
      status: "completed",
      mode: "effect",
      targetPaths: ["Cards/new.md"],
      reason: "Card saved",
    },
    verified: true,
  });
  assert.equal(events.find((event) => event.type === "done").disposition, "completed");
  assert.equal(provider._calls(), 1);
});

test("a declared skill enforces its host minimum receipt count", async () => {
  const provider = mockProvider({ turns: [
    [
      ev.messageStart(),
      ev.toolUseStart(0, "write-one", "vault_write"),
      ev.toolUseJson(0, '{"path":"Cards/one.md","content":"one"}'),
      ev.blockStop(0),
      ev.toolUseStart(1, "finish-too-soon", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(1, '{"status":"completed","mode":"effect","reason":"Only one write"}'),
      ev.blockStop(1),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
    [
      ev.messageStart(),
      ev.toolUseStart(0, "write-two", "vault_write"),
      ev.toolUseJson(0, '{"path":"Cards/two.md","content":"two"}'),
      ev.blockStop(0),
      ev.toolUseStart(1, "finish-after-two", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(1, '{"status":"completed","mode":"effect","reason":"Two verified writes"}'),
      ev.blockStop(1),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
  ] });
  const contract = createExplicitSkillWorkflowContract({
    skillName: "two-write-skill",
    command: "/two-write-skill",
    completionPolicy: {
      state: "declared",
      mode: "effect",
      requiredEffects: ["vault_mutation"],
      minReceipts: 2,
      errorCode: null,
    },
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeWritingTool("vault_write", async () => "created")),
    messages: [{ role: "user", content: [{ type: "text", text: "/two-write-skill" }] }],
    executionContract: contract,
    ctx: {
      async verifyToolEffect({ toolUse }) {
        return {
          kind: "vault_mutation",
          toolUseId: toolUse.id,
          tool: toolUse.name,
          paths: [toolUse.input.path],
          verified: true,
          outcome: "verified",
        };
      },
    },
  }));

  const firstFeedback = provider._seen[1].input.messages.at(-1).content
    .find((block) => block.tool_use_id === "finish-too-soon");
  assert.equal(firstFeedback.is_error, true);
  assert.match(firstFeedback.content, /at least 2 verified receipts/i);
  assert.equal(events.filter((event) => event.type === "effect_receipt").length, 2);
  assert.equal(events.find((event) => event.type === "workflow_finish").verified, true);
});

test("a workflow effect may be satisfied by any verified side-effect receipt", async () => {
  const provider = mockProvider({
    turns: [[
      ev.messageStart(),
      ev.toolUseStart(0, "publish-card", "publish_card"),
      ev.toolUseJson(0, '{"target":"remote:card"}'),
      ev.blockStop(0),
      ev.toolUseStart(1, "finish-publish", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(1, '{"status":"completed","mode":"effect","reason":"Published"}'),
      ev.blockStop(1),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ]],
  });
  const publishTool = buildTool({
    name: "publish_card",
    description: "publish",
    inputSchema: { type: "object" },
    capabilities: (input) => ({
      effect: "external_side_effect",
      risk: "medium",
      concurrency: "serial",
      presentation: "execute",
      targets: [input && input.target].filter(Boolean),
    }),
    async *execute() { yield { type: "result", content: "published" }; },
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(publishTool),
    messages: [{ role: "user", content: [{ type: "text", text: "/publish" }] }],
    executionContract: createExplicitSkillWorkflowContract({
      skillName: "publish",
      command: "/publish",
      completionPolicy: {
        state: "declared",
        mode: "effect",
        requiredEffects: ["external_side_effect"],
        minReceipts: 1,
        errorCode: null,
      },
    }),
    ctx: {
      toolPermissionMode: "auto",
      async verifyToolEffect({ toolUse, result, effect }) {
        return {
          kind: effect.kind,
          toolUseId: toolUse.id,
          tool: toolUse.name,
          paths: effect.targets,
          outcome: result.isError ? "failed" : "verified",
          verified: !result.isError,
        };
      },
    },
  }));

  assert.equal(events.find((event) => event.type === "effect_receipt").receipt.kind, "external_side_effect");
  assert.equal(events.find((event) => event.type === "workflow_finish").disposition, "completed");
});

test("a workflow accepts inspect completion only after a verified observation", async () => {
  const provider = mockProvider({
    turns: [[
      ev.messageStart(),
      ev.toolUseStart(0, "read-status", "vault_read"),
      ev.toolUseJson(0, '{"path":"STATUS.md"}'),
      ev.blockStop(0),
      ev.toolUseStart(1, "finish-inspect", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(1, '{"status":"completed","mode":"inspect","reason":"Status inspected"}'),
      ev.blockStop(1),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ]],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeReadOnlyTool("vault_read", async () => "status")),
    messages: [{ role: "user", content: [{ type: "text", text: "/ah-card" }] }],
    executionContract: inspectWorkflowContract(),
  }));

  assert.equal(events.find((event) => event.type === "effect_receipt").receipt.kind, "observation");
  assert.equal(events.find((event) => event.type === "workflow_finish").verified, true);
  assert.equal(events.find((event) => event.type === "done").disposition, "completed");
});

test("an inspect skill cannot complete without a verified observation receipt and may explicitly cancel", async () => {
  const provider = mockProvider({ turns: [
    [
      ev.messageStart(),
      ev.toolUseStart(0, "finish-inspect-empty", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(0, '{"status":"completed","mode":"inspect","reason":"Inspected"}'),
      ev.blockStop(0),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
    [
      ev.messageStart(),
      ev.toolUseStart(0, "finish-inspect-cancelled", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(0, '{"status":"cancelled","reason":"No observation available"}'),
      ev.blockStop(0),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ],
  ] });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "/inspect-skill" }] }],
    executionContract: inspectWorkflowContract(),
  }));

  assert.match(provider._seen[1].input.messages.at(-1).content[0].content, /verified observation receipt/i);
  assert.equal(events.find((event) => event.type === "workflow_finish").disposition, "cancelled");
});

test("a standard skill without private metadata completes through the host protocol", async () => {
  const provider = mockProvider({ turns: [[
    ev.messageStart(),
    ev.toolUseStart(0, "finish-legacy", WORKFLOW_FINISH_TOOL_NAME),
    ev.toolUseJson(0, '{"status":"completed","mode":"answer","reason":"Legacy answer"}'),
    ev.blockStop(0),
    ev.messageDelta("tool_use"),
    ev.messageStop(),
  ]] });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "/third-party" }] }],
    executionContract: createExplicitSkillWorkflowContract({
      skillName: "third-party",
      command: "/third-party",
    }),
  }));

  assert.deepEqual(events.find((event) => event.type === "workflow_finish"), {
    type: "workflow_finish",
    disposition: "completed",
    declaration: { status: "completed", mode: "answer", reason: "Legacy answer" },
    verified: true,
    verification: { state: "verified", policy: "standard_skill_protocol" },
  });
  const done = events.find((event) => event.type === "done");
  assert.equal(done.disposition, "completed");
  assert.equal(done.verified, true);
  assert.deepEqual(done.verification, { state: "verified", policy: "standard_skill_protocol" });
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

test("an unverified workflow finish is returned to the model as an internal tool error", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "finish-unverified", WORKFLOW_FINISH_TOOL_NAME),
        ev.toolUseJson(0, '{"status":"completed","mode":"effect","reason":"Claimed write"}'),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.toolUseStart(0, "finish-cancelled", WORKFLOW_FINISH_TOOL_NAME),
        ev.toolUseJson(0, '{"status":"cancelled","reason":"No writable target"}'),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
    ],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "/ah-card" }] }],
    executionContract: explicitWorkflowContract(),
  }));

  const feedback = provider._seen[1].input.messages.at(-1).content;
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].type, "tool_result");
  assert.equal(feedback[0].tool_use_id, "finish-unverified");
  assert.equal(feedback[0].is_error, true);
  assert.match(feedback[0].content, /verified effect receipt/i);
  assert.equal(events.some((event) => event.type === "tool_start" || event.type === "tool_finish"), false);
  assert.deepEqual(events.find((event) => event.type === "workflow_finish"), {
    type: "workflow_finish",
    disposition: "cancelled",
    declaration: { status: "cancelled", mode: null, reason: "No writable target" },
    verified: true,
  });
  assert.equal(events.find((event) => event.type === "done").disposition, "cancelled");
});

test("a workflow finish with mismatched target paths returns an internal tool error", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "write-actual", "vault_write"),
        ev.toolUseJson(0, '{"path":"Cards/actual.md","content":"card"}'),
        ev.blockStop(0),
        ev.toolUseStart(1, "finish-mismatch", WORKFLOW_FINISH_TOOL_NAME),
        ev.toolUseJson(1, '{"status":"completed","mode":"effect","target_paths":["Cards/expected.md"],"reason":"Saved"}'),
        ev.blockStop(1),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.toolUseStart(0, "finish-after-mismatch", WORKFLOW_FINISH_TOOL_NAME),
        ev.toolUseJson(0, '{"status":"cancelled","reason":"Expected target was not changed"}'),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
    ],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeWritingTool("vault_write", async () => "Created actual card")),
    messages: [{ role: "user", content: [{ type: "text", text: "/ah-card" }] }],
    executionContract: explicitWorkflowContract(),
    ctx: {
      async verifyToolEffect({ toolUse, result }) {
        return {
          kind: "vault_mutation",
          toolUseId: toolUse.id,
          tool: toolUse.name,
          paths: [toolUse.input.path],
          outcome: result.isError ? "failed" : "verified",
          verified: !result.isError,
        };
      },
    },
  }));

  const feedback = provider._seen[1].input.messages.at(-1).content
    .find((block) => block.tool_use_id === "finish-mismatch");
  assert.equal(feedback.is_error, true);
  assert.match(feedback.content, /Cards\/expected\.md/);
  assert.equal(events.find((event) => event.type === "workflow_finish").disposition, "cancelled");
  assert.equal(provider._calls(), 2);
});

test("a workflow retries once and fails closed when the model never declares a finish", async () => {
  const noFinish = [
    ev.messageStart(),
    ev.textBlockStart(0),
    ev.textDelta(0, "I am done."),
    ev.blockStop(0),
    ev.messageDelta("end_turn"),
    ev.messageStop(),
  ];
  const provider = mockProvider({ turns: [noFinish, noFinish] });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "/ah-card" }] }],
    executionContract: explicitWorkflowContract(),
    maxCompletionRetries: 1,
  }));

  assert.equal(events.filter((event) => event.type === "completion_retry").length, 1);
  assert.match(
    provider._seen[1].input.messages.at(-1).content[0].text,
    new RegExp(WORKFLOW_FINISH_TOOL_NAME),
  );
  assert.equal(events.find((event) => event.type === "error").error.type, "completion_contract_failed");
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(provider._calls(), 2);
});

test("a cancelled workflow remains cancelled instead of being reported as completed", async () => {
  const provider = mockProvider({
    turns: [[
      ev.messageStart(),
      ev.toolUseStart(0, "finish-cancelled", WORKFLOW_FINISH_TOOL_NAME),
      ev.toolUseJson(0, '{"status":"cancelled","reason":"User stopped the workflow"}'),
      ev.blockStop(0),
      ev.messageDelta("tool_use"),
      ev.messageStop(),
    ]],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "/ah-card" }] }],
    executionContract: explicitWorkflowContract(),
  }));

  const finish = events.find((event) => event.type === "workflow_finish");
  assert.equal(finish.disposition, "cancelled");
  assert.equal(finish.declaration.status, "cancelled");
  assert.equal(events.find((event) => event.type === "done").disposition, "cancelled");
  assert.equal(events.some((event) => event.disposition === "completed"), false);
});

test("runAgentLoop retries an effect-required task until a verified receipt exists", async () => {
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "已经写入 new.md。"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-write", "vault_write"),
        ev.toolUseJson(0, '{"path":"new.md","content":"hello","mode":"create"}'),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      [
        ev.messageStart(),
        ev.textBlockStart(0),
        ev.textDelta(0, "写入已验证。"),
        ev.blockStop(0),
        ev.messageDelta("end_turn"),
        ev.messageStop(),
      ],
    ],
  });
  const registry = registryWith(makeWritingTool("vault_write", async () => "Created new.md"));
  const events = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "写入 new.md" }] }],
    executionContract: {
      id: "contract-1",
      mode: "effect",
      requiredEffects: [{ kind: "vault_mutation", targetPaths: ["new.md"] }],
    },
    ctx: {
      async verifyToolEffect({ toolUse, result }) {
        return {
          kind: "vault_mutation",
          toolUseId: toolUse.id,
          tool: toolUse.name,
          paths: [toolUse.input.path],
          outcome: result.isError ? "failed" : "verified",
          verified: !result.isError,
        };
      },
    },
  }));

  assert.equal(events.filter((event) => event.type === "completion_retry").length, 1);
  const receipt = events.find((event) => event.type === "effect_receipt");
  assert.equal(receipt.receipt.verified, true);
  assert.ok(events.some((event) => event.type === "done"));
  assert.equal(provider._calls(), 3);
});

test("runAgentLoop fails closed after the effect completion retry budget is exhausted", async () => {
  const falseDoneTurn = [
    ev.messageStart(),
    ev.textBlockStart(0),
    ev.textDelta(0, "已经完成。"),
    ev.blockStop(0),
    ev.messageDelta("end_turn"),
    ev.messageStop(),
  ];
  const provider = mockProvider({ turns: [falseDoneTurn, falseDoneTurn] });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "修改文件" }] }],
    executionContract: {
      id: "contract-2",
      mode: "effect",
      requiredEffects: [{ kind: "vault_mutation", targetPaths: [] }],
    },
    maxCompletionRetries: 1,
  }));

  assert.equal(events.filter((event) => event.type === "completion_retry").length, 1);
  const error = events.find((event) => event.type === "error");
  assert.equal(error.error.type, "completion_contract_failed");
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(provider._calls(), 2);
});

test("runAgentLoop does not accept a successful tool result when its postcondition fails", async () => {
  const falseDone = [
    ev.messageStart(),
    ev.textBlockStart(0),
    ev.textDelta(0, "写入完成。"),
    ev.blockStop(0),
    ev.messageDelta("end_turn"),
    ev.messageStop(),
  ];
  const provider = mockProvider({
    turns: [
      [
        ev.messageStart(),
        ev.toolUseStart(0, "tu-write-unverified", "vault_write"),
        ev.toolUseJson(0, '{"path":"x.md","content":"expected"}'),
        ev.blockStop(0),
        ev.messageDelta("tool_use"),
        ev.messageStop(),
      ],
      falseDone,
      falseDone,
    ],
  });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(makeWritingTool("vault_write", async () => "Wrote x.md")),
    messages: [{ role: "user", content: [{ type: "text", text: "写入 x.md" }] }],
    executionContract: {
      id: "contract-postcondition",
      mode: "effect",
      requiredEffects: [{ kind: "vault_mutation", targetPaths: ["x.md"] }],
    },
    ctx: {
      async verifyToolEffect({ toolUse }) {
        return {
          kind: "vault_mutation",
          toolUseId: toolUse.id,
          tool: toolUse.name,
          paths: ["x.md"],
          verified: false,
          outcome: "postcondition_failed",
        };
      },
    },
  }));

  assert.equal(events.find((event) => event.type === "tool_finish").isError, false);
  assert.equal(events.find((event) => event.type === "effect_receipt").receipt.verified, false);
  assert.equal(events.find((event) => event.type === "error").error.type, "completion_contract_failed");
  assert.equal(events.some((event) => event.type === "done"), false);
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

test("runAgentLoop also requires a receipt for an inspection task", async () => {
  const falseRead = [
    ev.messageStart(),
    ev.textBlockStart(0),
    ev.textDelta(0, "我已经读取 x.md，内容为空。"),
    ev.blockStop(0),
    ev.messageDelta("end_turn"),
    ev.messageStop(),
  ];
  const provider = mockProvider({ turns: [falseRead, falseRead] });
  const events = await collect(runAgentLoop({
    provider,
    registry: new ToolRegistry(),
    messages: [{ role: "user", content: [{ type: "text", text: "读取 x.md" }] }],
    executionContract: {
      id: "contract-inspect",
      mode: "inspect",
      requiredEffects: [{ kind: "observation", targetPaths: ["x.md"] }],
    },
    maxCompletionRetries: 1,
  }));

  assert.equal(events.filter((event) => event.type === "completion_retry").length, 1);
  assert.equal(events.find((event) => event.type === "error").error.type, "completion_contract_failed");
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

test("a dismissed interaction takes precedence over a same-turn workflow finish declaration", async () => {
  const askTool = buildTool({
    name: "ask_user",
    description: "ask",
    inputSchema: { type: "object" },
    capabilities: { effect: "none", risk: "low", concurrency: "serial", presentation: "question", targets: [] },
    async *execute() {
      yield {
        type: "result",
        content: "dismissed",
        code: "user_input_dismissed",
        control: { type: "suspend", reason: "user_input_dismissed" },
      };
    },
  });
  const provider = mockProvider({ turns: [[
    ev.messageStart(),
    ev.toolUseStart(0, "finish-too-early", WORKFLOW_FINISH_TOOL_NAME),
    ev.toolUseJson(0, '{"status":"completed","mode":"answer"}'),
    ev.blockStop(0),
    ev.toolUseStart(1, "ask-1", "ask_user"),
    ev.toolUseJson(1, "{}"),
    ev.blockStop(1),
    ev.messageDelta("tool_use"),
    ev.messageStop(),
  ]] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(askTool),
    messages: [{ role: "user", content: [{ type: "text", text: "/ah-card" }] }],
    executionContract: explicitWorkflowContract(),
  }));

  assert.equal(events.some((event) => event.type === "workflow_finish"), false);
  assert.equal(events.at(-1).type, "suspended");
  assert.equal(events.at(-1).reason, "user_input_dismissed");
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
    ev.messageStart(), ev.toolUseStart(0, "finish", WORKFLOW_FINISH_TOOL_NAME),
    ev.toolUseJson(0, '{"status":"cancelled","reason":"test"}'), ev.blockStop(0), ev.messageDelta("tool_use"), ev.messageStop(),
  ]] });
  const events = await collect(runAgentLoop({
    provider,
    registry: registryWith(invoke, resource, makeReadOnlyTool("vault_read", async () => "read"), makeWritingTool("vault_write", async () => "write")),
    messages: [{ role: "user", content: [{ type: "text", text: "/skill" }] }],
    allowedToolPolicy: ["vault_read"],
    executionContract: explicitWorkflowContract(),
  }));
  assert.deepEqual(provider._seen[0].input.tools.map((tool) => tool.name).sort(), [
    "flownote_finish_skill", "skill_invoke", "skill_resource_read", "vault_read",
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

test("runAgentLoop budgets long history against the active model context before provider dispatch", async () => {
  const provider = mockProvider({ turns: [[
    ev.messageStart(), ev.textBlockStart(0), ev.textDelta(0, "done"), ev.blockStop(0), ev.messageDelta("end_turn"), ev.messageStop(),
  ]] });
  provider.spec.models = [{ id: "test", contextWindow: 5_000, maxOutput: 2_000 }];
  provider.countTokens = async (messages) => Math.ceil(JSON.stringify(messages).length / 4);
  const messages = [
    { role: "user", content: [{ type: "text", text: "old".repeat(12_000) }] },
    { role: "assistant", content: [{ type: "text", text: "old answer".repeat(4_000) }] },
    { role: "user", content: [{ type: "text", text: "RECENT_CONTEXT" }] },
  ];

  await collect(runAgentLoop({ provider, registry: new ToolRegistry(), messages, maxTokensPerTurn: 2_000 }));

  const sent = provider._seen[0].input;
  assert.match(JSON.stringify(sent.messages), /RECENT_CONTEXT/);
  assert.ok(JSON.stringify(sent.messages).length < JSON.stringify(messages).length / 3);
  assert.ok(sent.maxTokens >= 256 && sent.maxTokens <= 2_000);
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
