const test = require("node:test");
const assert = require("node:assert/strict");

const { runAgentLoop, consumeStream } = require("../../../runtime/agent/agent-loop");
const { buildTool, ToolRegistry } = require("../../../runtime/agent/tool-registry");

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
    isReadOnly: () => false,
    checkPermissions: checkPermissions || (async () => ({ behavior: "allow" })),
    async *execute(input, _ctx) {
      yield { type: "progress", message: `running ${name}` };
      const r = await fn(input);
      yield { type: "result", content: r };
    },
  });
}

function registryWith(...tools) {
  const r = new ToolRegistry();
  r.registerAll(tools);
  return r;
}

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

test("consumeStream surfaces error events as fatalError", async () => {
  async function* gen() {
    yield { type: "error", error: { type: "http_500", message: "boom" } };
  }
  const r = await consumeStream(gen());
  assert.equal(r.fatalError.type, "http_500");
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

// ---------------------------------------------------------------------------
// runAgentLoop — max turns exceeded
// ---------------------------------------------------------------------------

test("runAgentLoop emits error when the model keeps asking past maxTurns", async () => {
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
  const err = events.find((e) => e.type === "error");
  assert.ok(err);
  assert.equal(err.error.type, "max_turns_exceeded");
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
