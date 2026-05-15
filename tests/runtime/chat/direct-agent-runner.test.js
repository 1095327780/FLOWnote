const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runDirectAgentTurn,
  buildAnthropicHistory,
} = require("../../../runtime/chat/direct-agent-runner");
const { ToolRegistry, buildTool } = require("../../../runtime/agent/tool-registry");
const {
  defaultAgentSettings,
  setApiKeyFor,
} = require("../../../runtime/agent/agent-settings");

function makeFakeProvider(turns) {
  let calls = 0;
  return {
    id: "mock",
    displayName: "Mock",
    spec: { id: "mock", displayName: "Mock", protocol: "anthropic-messages" },
    userConfig: { providerId: "mock", mode: "api", apiKey: "k", model: "mock-1" },
    async *createMessage(_input) {
      const turn = turns[calls++];
      if (!turn) throw new Error("mock provider exhausted");
      for (const ev of turn) yield ev;
    },
  };
}

const ev = {
  msgStart: () => ({ type: "message_start", message: {} }),
  textBlock: (i) => ({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }),
  textDelta: (i, t) => ({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } }),
  blockStop: (i) => ({ type: "content_block_stop", index: i }),
  toolUseStart: (i, id, name) => ({ type: "content_block_start", index: i, content_block: { type: "tool_use", id, name, input: {} } }),
  toolUseJson: (i, p) => ({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: p } }),
  msgDelta: (sr) => ({ type: "message_delta", delta: { stop_reason: sr } }),
  msgStop: () => ({ type: "message_stop" }),
};

function fakeView() {
  const messages = [];
  return {
    app: {
      vault: {
        getFileByPath: () => null,
        cachedRead: async () => "",
        create: async () => ({}),
        modify: async () => {},
      },
    },
    plugin: {
      settings: { agentProvider: { ...defaultAgentSettings(), enabled: true } },
      sessionStore: {
        getActiveMessages: () => messages.slice(),
      },
    },
    _messages: messages,
  };
}

function collectHandlerCalls() {
  const out = { tokens: [], blocks: [], permissionRequests: [] };
  return {
    out,
    handlers: {
      onToken: (t) => { out.tokens.push(t); },
      onBlocks: (b) => { out.blocks.push(b); },
      onPermissionRequest: async (p) => { out.permissionRequests.push(p); return "once"; },
    },
  };
}

// ---------------------------------------------------------------------------
// buildAnthropicHistory
// ---------------------------------------------------------------------------

test("buildAnthropicHistory: converts user+assistant text messages, drops pending drafts and the active draft", () => {
  const stored = [
    { id: "u1", role: "user", text: "hi" },
    { id: "a1", role: "assistant", text: "hello" },
    { id: "u2", role: "user", text: "next?" },
    { id: "draft-x", role: "assistant", text: "", pending: true },
  ];
  const history = buildAnthropicHistory(stored, "draft-x");
  assert.equal(history.length, 3);
  assert.deepEqual(history[0], { role: "user", content: [{ type: "text", text: "hi" }] });
  assert.deepEqual(history[1], { role: "assistant", content: [{ type: "text", text: "hello" }] });
  assert.deepEqual(history[2], { role: "user", content: [{ type: "text", text: "next?" }] });
});

test("buildAnthropicHistory: skips empty-text messages", () => {
  const stored = [
    { id: "u1", role: "user", text: "" },
    { id: "u2", role: "user", text: "real" },
  ];
  const history = buildAnthropicHistory(stored, "draft");
  assert.equal(history.length, 1);
  assert.equal(history[0].content[0].text, "real");
});

// ---------------------------------------------------------------------------
// runDirectAgentTurn — text streaming only
// ---------------------------------------------------------------------------

test("runDirectAgentTurn streams text through onToken and returns final response", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "hi" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });

  const provider = makeFakeProvider([[
    ev.msgStart(),
    ev.textBlock(0),
    ev.textDelta(0, "Hello"),
    ev.textDelta(0, " world"),
    ev.blockStop(0),
    ev.msgDelta("end_turn"),
    ev.msgStop(),
  ]]);
  // Inject the runAgentLoop with a forced provider by wrapping it.
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");
  const runner = (args) => runAgentLoop({ ...args, provider });

  const { handlers, out } = collectHandlerCalls();
  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "hi",
    handlers,
    runAgentLoopImpl: runner,
  });

  assert.equal(response.text, "Hello world");
  assert.ok(out.tokens.length >= 2);
  assert.equal(out.tokens[out.tokens.length - 1], "Hello world");
});

// ---------------------------------------------------------------------------
// runDirectAgentTurn — single tool use round trip
// ---------------------------------------------------------------------------

test("runDirectAgentTurn surfaces tool_start / tool_finish through onBlocks", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "read x.md" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });

  const provider = makeFakeProvider([
    [
      ev.msgStart(),
      ev.toolUseStart(0, "tu-1", "vault_read"),
      ev.toolUseJson(0, "{\"path\":\"x.md\"}"),
      ev.blockStop(0),
      ev.msgDelta("tool_use"),
      ev.msgStop(),
    ],
    [
      ev.msgStart(),
      ev.textBlock(0),
      ev.textDelta(0, "Got it."),
      ev.blockStop(0),
      ev.msgDelta("end_turn"),
      ev.msgStop(),
    ],
  ]);
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");

  // Override the registry with a fake vault tool that returns canned text.
  const registry = new ToolRegistry();
  registry.register(buildTool({
    name: "vault_read",
    description: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input) {
      yield { type: "result", content: `file ${input.path}` };
    },
  }));

  const { handlers, out } = collectHandlerCalls();
  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "read x.md",
    handlers,
    toolRegistryOverride: registry,
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
  });

  assert.equal(response.text, "Got it.");
  // Find the final blocks emit — should contain the running→done tool entry
  const finalBlocks = out.blocks[out.blocks.length - 1] || [];
  const toolBlock = finalBlocks.find((b) => b.type === "tool");
  assert.ok(toolBlock, "expected a tool block in onBlocks");
  assert.equal(toolBlock.tool, "vault_read");
  assert.equal(toolBlock.status, "done");
  assert.equal(toolBlock.output, "file x.md");
});

// ---------------------------------------------------------------------------
// runDirectAgentTurn — permission ask forwards to handlers.onPermissionRequest
// ---------------------------------------------------------------------------

test("runDirectAgentTurn routes permission 'ask' to view handlers", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");

  const provider = makeFakeProvider([
    [
      ev.msgStart(),
      ev.toolUseStart(0, "tu-w", "vault_write"),
      ev.toolUseJson(0, "{\"path\":\"a.md\",\"content\":\"x\",\"mode\":\"overwrite\"}"),
      ev.blockStop(0),
      ev.msgDelta("tool_use"),
      ev.msgStop(),
    ],
    [
      ev.msgStart(),
      ev.textBlock(0),
      ev.textDelta(0, "done"),
      ev.blockStop(0),
      ev.msgDelta("end_turn"),
      ev.msgStop(),
    ],
  ]);
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");

  const registry = new ToolRegistry();
  registry.register(buildTool({
    name: "vault_write",
    description: "write",
    inputSchema: { type: "object" },
    isReadOnly: () => false,
    checkPermissions: async () => ({ behavior: "ask", summary: "overwrite a.md" }),
    async *execute() { yield { type: "result", content: "ok" }; },
  }));

  const { handlers, out } = collectHandlerCalls();
  // onPermissionRequest returns "once" → allow
  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "write a.md",
    handlers,
    toolRegistryOverride: registry,
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
  });

  assert.equal(out.permissionRequests.length, 1);
  assert.equal(out.permissionRequests[0].tool, "vault_write");
  assert.equal(response.text, "done");
  const finalBlocks = out.blocks[out.blocks.length - 1] || [];
  const t = finalBlocks.find((b) => b.type === "tool");
  assert.equal(t.status, "done");
});

// ---------------------------------------------------------------------------
// runDirectAgentTurn — surfaces resolver errors
// ---------------------------------------------------------------------------

test("runDirectAgentTurn surfaces MISSING_API_KEY when key is empty", async () => {
  const view = fakeView();
  view._messages.push({ id: "u1", role: "user", text: "hi" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  const { handlers } = collectHandlerCalls();

  await assert.rejects(
    () => runDirectAgentTurn({
      view,
      sessionId: "s1",
      draftId: "d1",
      userText: "hi",
      handlers,
    }),
    /No API key configured/,
  );
});

test("runDirectAgentTurn meta line carries provider + model + tool count", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  const provider = makeFakeProvider([[
    ev.msgStart(),
    ev.textBlock(0),
    ev.textDelta(0, "ok"),
    ev.blockStop(0),
    ev.msgDelta("end_turn"),
    ev.msgStop(),
  ]]);
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");
  const { handlers } = collectHandlerCalls();
  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "hi",
    handlers,
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
  });
  assert.match(response.meta, /DeepSeek/);
  assert.match(response.meta, /deepseek-v4-flash/);
});
