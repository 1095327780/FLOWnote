const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runDirectAgentTurn,
  buildAnthropicHistory,
  buildDefaultToolRegistry,
  ensureSkillRegistry,
  resolveSkillRoots,
  resolveMainTurnTokenBudget,
} = require("../../../runtime/chat/direct-agent-runner");
const { ToolRegistry, buildTool } = require("../../../runtime/agent/tool-registry");
const { SkillRegistry } = require("../../../runtime/agent/skill-registry");
const { createSkillResourceReadTool } = require("../../../runtime/agent/tools/skill-resource-read");
const { saveTemplate } = require("../../../runtime/settings/template-management");
const { blockUtilsMethods } = require("../../../runtime/view/message/block-utils");
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
        getSessionMessages: () => messages.slice(),
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

test("main model turns use a bounded default and respect explicit overrides", () => {
  const provider = {
    userConfig: { model: "deepseek-v4-flash" },
    spec: {
      models: [{ id: "deepseek-v4-flash", maxOutput: 384_000 }],
    },
  };

  assert.equal(resolveMainTurnTokenBudget({ direct: { maxOutputTokens: 0 } }, provider), 32_768);
  assert.equal(resolveMainTurnTokenBudget({ direct: { maxOutputTokens: 32_000 } }, provider), 32_000);
  assert.equal(resolveMainTurnTokenBudget({ direct: { maxOutputTokens: 500_000 } }, provider), 384_000);
  assert.equal(resolveMainTurnTokenBudget({ direct: {} }, { userConfig: { model: "custom" }, spec: { models: [] } }), 16_384);
});

async function collectToolEvents(tool, input) {
  const events = [];
  for await (const event of tool.execute(input, {})) events.push(event);
  return events;
}

// ---------------------------------------------------------------------------
// buildAnthropicHistory
// ---------------------------------------------------------------------------

test("buildAnthropicHistory: returns prior turns and drops the trailing user message (caller re-appends composed version)", () => {
  const stored = [
    { id: "u1", role: "user", text: "hi" },
    { id: "a1", role: "assistant", text: "hello" },
    { id: "u2", role: "user", text: "next?" },          // ← this is the just-pushed current turn
    { id: "draft-x", role: "assistant", text: "", pending: true },
  ];
  const history = buildAnthropicHistory(stored, "draft-x");
  // The trailing user message is removed so the runner can re-append
  // the composed userText (with linked-context files) as the actual turn.
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { role: "user", content: [{ type: "text", text: "hi" }] });
  assert.deepEqual(history[1], { role: "assistant", content: [{ type: "text", text: "hello" }] });
});

test("buildAnthropicHistory: skips empty-text messages", () => {
  const stored = [
    { id: "u1", role: "user", text: "" },
    { id: "u2", role: "user", text: "real" },
  ];
  // The trailing user message is dropped; remaining "real" was the only
  // valid user msg before the trailing-drop pass, so after drop list is empty.
  const history = buildAnthropicHistory(stored, "draft");
  assert.equal(history.length, 0);
});

test("buildAnthropicHistory: keeps assistant messages even when the trailing message is an assistant", () => {
  // Edge case: somehow the last message is assistant (e.g. resumed
  // session). Don't drop it — the runner will still append the new
  // current-turn user message.
  const stored = [
    { id: "u1", role: "user", text: "hi" },
    { id: "a1", role: "assistant", text: "hello" },
  ];
  const history = buildAnthropicHistory(stored, "draft");
  assert.equal(history.length, 2);
  assert.equal(history[1].role, "assistant");
});

test("buildAnthropicHistory: carries typed execution facts into the next turn", () => {
  const execution = { version: 1, events: [
    { seq: 0, time: 1, type: "run_started", runId: "run-1", contract: { mode: "effect" } },
    { seq: 1, time: 2, type: "tool_started", runId: "run-1", toolUseId: "move-1", tool: "vault_move", capabilities: { effect: "vault_mutation", targets: ["old.md", "new.md"] } },
    { seq: 2, time: 3, type: "tool_finished", runId: "run-1", toolUseId: "move-1", isError: false, outcome: { state: "completed", code: "ok", effects: [{ kind: "vault_mutation", targets: ["old.md", "new.md"] }] } },
    { seq: 3, time: 4, type: "effect_verified", runId: "run-1", toolUseId: "move-1", receipt: { verified: true, paths: ["old.md", "new.md"] } },
    { seq: 4, time: 5, type: "completion_accepted", runId: "run-1" },
    { seq: 5, time: 6, type: "run_completed", runId: "run-1" },
  ] };
  const history = buildAnthropicHistory([
    { id: "u1", role: "user", text: "rename it" },
    { id: "a1", role: "assistant", text: "done", execution },
  ], "draft");

  const record = history[1].content[1].text;
  assert.match(record, /^<flownote_execution_record>/);
  assert.match(record, /vault_move/);
  assert.match(record, /old\.md/);
  assert.match(record, /new\.md/);
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

test("runDirectAgentTurn reads history from its bound session after the user switches chats", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  const boundMessages = [
    { id: "bound-u0", role: "user", text: "bound session context" },
    { id: "bound-a0", role: "assistant", text: "bound session answer" },
    { id: "bound-u1", role: "user", text: "continue here" },
    { id: "d1", role: "assistant", text: "", pending: true },
  ];
  const activeMessages = [
    { id: "wrong-u0", role: "user", text: "newly active chat must stay isolated" },
    { id: "wrong-a0", role: "assistant", text: "wrong session answer" },
  ];
  view.plugin.sessionStore = {
    getActiveMessages: () => activeMessages.slice(),
    getSessionMessages: (sessionId) => sessionId === "bound-session" ? boundMessages.slice() : [],
  };
  let capturedMessages = null;

  await runDirectAgentTurn({
    view,
    sessionId: "bound-session",
    draftId: "d1",
    userText: "continue here",
    handlers: collectHandlerCalls().handlers,
    skillRegistryOverride: new SkillRegistry([]),
    runAgentLoopImpl: async function* (args) {
      capturedMessages = args.messages;
      yield { type: "stream", event: ev.textDelta(0, "Done") };
      yield { type: "done" };
    },
  });

  const serialized = JSON.stringify(capturedMessages);
  assert.match(serialized, /bound session context/);
  assert.match(serialized, /bound session answer/);
  assert.doesNotMatch(serialized, /newly active chat must stay isolated/);
  assert.doesNotMatch(serialized, /wrong session answer/);
});

test("runDirectAgentTurn records an explicit skill's completion policy and streams its reply", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "/ah-card   source A / B  " });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  const skillRegistry = new SkillRegistry([{
    name: "ah-card",
    slug: "ah-card",
    description: "Turn user material into verified permanent notes in the vault.",
    body: "FULL STANDARD SKILL BODY\nInput: <$ARGUMENTS>",
    argumentNames: [],
    resourcePaths: [],
    dirPath: "<test>/ah-card",
    disableModelInvocation: true,
    userInvocable: true,
    allowedTools: ["vault_read"],
    completionPolicy: {
      state: "declared",
      mode: "effect",
      requiredEffects: ["vault_mutation"],
      minReceipts: 1,
      errorCode: null,
    },
  }]);
  let capturedLoopArgs = null;
  const { handlers, out } = collectHandlerCalls();

  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "source A / B",
    handlers,
    skillRegistryOverride: skillRegistry,
    preloadedSkillCommand: { skill: "ah-card", args: "  source A / B  ", command: "/ah-card" },
    runAgentLoopImpl: async function* (args) {
      capturedLoopArgs = args;
      yield { type: "stream", event: ev.textDelta(0, "Created the requested card.") };
      yield { type: "turn_complete", turnIndex: 0, stopReason: "end_turn" };
      yield { type: "done", turns: 1 };
    },
  });

  assert.ok(capturedLoopArgs, "main model loop should run exactly once");
  assert.equal(typeof capturedLoopArgs.stopCheck, "function");
  assert.equal(capturedLoopArgs.executionContract.mode, "workflow");
  assert.equal(capturedLoopArgs.executionContract.source, "explicit_skill");
  assert.equal(capturedLoopArgs.executionContract.completionMode, "effect");
  assert.deepEqual(capturedLoopArgs.executionContract.requiredEffects, [
    { kind: "vault_mutation", targetPaths: [] },
  ]);
  assert.equal(capturedLoopArgs.executionContract.minReceipts, 1);
  assert.deepEqual(capturedLoopArgs.allowedToolPolicy, ["vault_read"]);
  const currentTurn = capturedLoopArgs.messages.at(-1).content.map((block) => block.text || "").join("\n");
  assert.match(currentTurn, /FULL STANDARD SKILL BODY/);
  assert.match(currentTurn, /Input: <  source A \/ B  >/);
  assert.equal(response.text, "Created the requested card.");
  assert.equal(out.tokens.at(-1), "Created the requested card.");
  assert.equal(response.status, "completed");
});

test("mobile preloaded policy repairs a stale vault manifest and canonicalizes an undefined command", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "/ah-note" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  const skillRegistry = new SkillRegistry([{
    name: "ah-note",
    slug: "ah-note",
    description: "Stale vault copy",
    body: "Ask the user to confirm today's focus.",
    userInvocable: true,
    completionPolicy: {
      state: "legacy_unclassified",
      mode: null,
      requiredEffects: [],
      requiredInteractions: [],
      minReceipts: null,
      errorCode: null,
    },
  }]);
  let capturedContract = null;

  await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "",
    handlers: collectHandlerCalls().handlers,
    skillRegistryOverride: skillRegistry,
    preloadedSkillCommand: {
      skill: "ah-note",
      args: "",
      command: "/undefined",
      completionPolicy: {
        state: "declared",
        mode: "effect",
        requiredEffects: [],
        requiredInteractions: ["ask_user"],
        minReceipts: null,
        errorCode: null,
      },
    },
    runAgentLoopImpl: async function* (args) {
      capturedContract = args.executionContract;
      yield { type: "done", disposition: "suspended", verified: true };
    },
  });

  assert.equal(capturedContract.command, "/ah-note");
  assert.equal(capturedContract.completionPolicyState, "declared");
  assert.equal(capturedContract.completionMode, "effect");
  assert.deepEqual(capturedContract.requiredInteractions, ["ask_user"]);
});

test("runDirectAgentTurn rejects an explicit skill marked user-invocable false", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  const skillRegistry = new SkillRegistry([{
    name: "internal-only",
    description: "Internal helper",
    body: "DO NOT LOAD",
    userInvocable: false,
  }]);
  let loopCalls = 0;

  await assert.rejects(
    () => runDirectAgentTurn({
      view,
      sessionId: "s1",
      draftId: "d1",
      userText: "",
      handlers: collectHandlerCalls().handlers,
      skillRegistryOverride: skillRegistry,
      preloadedSkillCommand: { skill: "internal-only", args: "", command: "/internal-only" },
      runAgentLoopImpl: async function* () {
        loopCalls += 1;
        yield { type: "done" };
      },
    }),
    (error) => error && error.code === "SKILL_NOT_USER_INVOCABLE",
  );

  assert.equal(loopCalls, 0);
});

test("runDirectAgentTurn rejects invalid completion metadata before the provider loop starts", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  const skillRegistry = new SkillRegistry([{
    name: "broken-skill",
    description: "Broken metadata",
    body: "Must never reach the model",
    userInvocable: true,
    completionPolicy: {
      state: "invalid",
      mode: null,
      requiredEffects: [],
      minReceipts: null,
      errorCode: "invalid_completion_mode",
    },
  }]);
  let providerLoopCalls = 0;

  await assert.rejects(
    () => runDirectAgentTurn({
      view,
      sessionId: "s1",
      draftId: "d1",
      userText: "",
      handlers: collectHandlerCalls().handlers,
      skillRegistryOverride: skillRegistry,
      preloadedSkillCommand: { skill: "broken-skill", args: "", command: "/broken-skill" },
      runAgentLoopImpl: async function* () {
        providerLoopCalls += 1;
        yield { type: "done" };
      },
    }),
    (error) => {
      assert.equal(error.code, "SKILL_COMPLETION_METADATA_INVALID");
      assert.equal(error.metadataErrorCode, "invalid_completion_mode");
      return true;
    },
  );

  assert.equal(providerLoopCalls, 0);
});

test("runDirectAgentTurn allows rename instructions that do not claim completion", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "怎么重命名文件？" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });

  const provider = makeFakeProvider([[
    ev.msgStart(),
    ev.textBlock(0),
    ev.textDelta(0, "You can rename a note by giving me the current and target vault-relative paths."),
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
    userText: "怎么重命名文件？",
    handlers,
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
  });

  assert.match(response.text, /current and target vault-relative paths/);
  assert.doesNotMatch(response.text, /no files were actually changed/i);
});

test("runDirectAgentTurn preserves a read-only summary that mentions past-tense verbs", async () => {
  // Regression: the guard used to fire on a bare past-tense verb in descriptive
  // prose and wipe the model's real answer on ordinary summarize/Q&A turns.
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "总结这篇笔记" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });

  const summary = "This note explains how the API was created in 2019 and later updated to support OAuth.";
  const provider = makeFakeProvider([[
    ev.msgStart(),
    ev.textBlock(0),
    ev.textDelta(0, summary),
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
    userText: "总结这篇笔记",
    handlers,
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
  });

  assert.equal(response.text, summary);
  assert.doesNotMatch(response.text, /no files were actually changed/i);
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
    capabilities: (input) => ({ effect: "observation", risk: "low", concurrency: "parallel", presentation: "read", targets: input && input.path ? [input.path] : [] }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input) {
      yield { type: "result", content: `PRIVATE_NOTE_BODY_SENTINEL from ${input.path}` };
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
  assert.equal(toolBlock.id, "tu-1");
  assert.equal(toolBlock.tool, "vault_read");
  assert.equal(toolBlock.status, "completed");
  assert.equal(toolBlock.summary, "x.md");
  assert.equal(Object.hasOwn(toolBlock, "input"), false);
  assert.equal(Object.hasOwn(toolBlock, "output"), false);
  assert.doesNotMatch(JSON.stringify(finalBlocks), /PRIVATE_NOTE_BODY_SENTINEL/);
  assert.deepEqual(toolBlock.capabilities.targets, ["x.md"]);
});

test("runDirectAgentTurn projects multi-step text and tools as one stable chronological timeline", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "inspect then update" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  const { handlers, out } = collectHandlerCalls();

  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "inspect then update",
    handlers,
    runAgentLoopImpl: async function* () {
      yield { type: "stream", event: ev.textDelta(0, "Inspecting first.") };
      yield { type: "tool_start", tool: "vault_read", toolUseId: "read-1", input: { path: "A.md" } };
      yield { type: "tool_finish", tool: "vault_read", toolUseId: "read-1", content: "ok", isError: false };
      yield { type: "turn_complete", turnIndex: 0, stopReason: "tool_use" };
      yield { type: "stream", event: ev.textDelta(0, "Now updating.") };
      yield { type: "tool_start", tool: "vault_edit", toolUseId: "edit-1", input: { path: "A.md" } };
      yield { type: "tool_finish", tool: "vault_edit", toolUseId: "edit-1", content: "ok", isError: false };
      yield { type: "turn_complete", turnIndex: 1, stopReason: "tool_use" };
      yield { type: "stream", event: ev.textDelta(0, "A.md is ready.") };
      yield { type: "turn_complete", turnIndex: 2, stopReason: "end_turn" };
      yield { type: "done" };
    },
  });

  assert.equal(response.text, "A.md is ready.");
  assert.deepEqual(
    response.blocks.map((block) => `${block.type}:${block.id}`),
    [
      "stream-text:direct:d1:turn:0:text:0",
      "tool:read-1",
      "stream-text:direct:d1:turn:1:text:0",
      "tool:edit-1",
      "stream-text:direct:d1:turn:2:text:0",
    ],
  );
  const liveOrders = out.blocks.map((blocks) => blocks.map((block) => block.id));
  const editStart = liveOrders.find((ids) => ids.includes("edit-1"));
  assert.deepEqual(editStart, [
    "direct:d1:turn:0:text:0",
    "read-1",
    "direct:d1:turn:1:text:0",
    "edit-1",
  ]);
});

test("runDirectAgentTurn marks expected missing memory reads as hidden UI noise", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "/ah" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });

  const provider = makeFakeProvider([
    [
      ev.msgStart(),
      ev.toolUseStart(0, "tu-1", "vault_read"),
      ev.toolUseJson(0, "{\"path\":\"Meta/ai-memory/STATUS.md\"}"),
      ev.blockStop(0),
      ev.msgDelta("tool_use"),
      ev.msgStop(),
    ],
    [
      ev.msgStart(),
      ev.textBlock(0),
      ev.textDelta(0, "Empty state is fine."),
      ev.blockStop(0),
      ev.msgDelta("end_turn"),
      ev.msgStop(),
    ],
  ]);
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");

  const registry = new ToolRegistry();
  registry.register(buildTool({
    name: "vault_read",
    description: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    capabilities: (input) => ({ effect: "observation", risk: "low", concurrency: "parallel", presentation: "read", targets: input && input.path ? [input.path] : [] }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input) {
      yield {
        type: "result",
        isError: true,
        content: `vault_read: file not found at "${input.path}".`,
      };
    },
  }));

  const { handlers, out } = collectHandlerCalls();
  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "/ah",
    handlers,
    toolRegistryOverride: registry,
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
  });

  assert.equal(response.text, "Empty state is fine.");
  const finalBlocks = out.blocks[out.blocks.length - 1] || [];
  const toolBlock = finalBlocks.find((b) => b.type === "tool");
  assert.ok(toolBlock);
  assert.equal(toolBlock.status, "error");
  assert.equal(toolBlock.isError, true);
  assert.equal(toolBlock.hidden, true);
  assert.equal(blockUtilsMethods.visibleAssistantBlocks(finalBlocks).some((b) => b.tool === "vault_read"), false);
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
    capabilities: (input) => ({ effect: "vault_mutation", risk: "high", concurrency: "serial", presentation: "edit", targets: input && input.path ? [input.path] : [] }),
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
  // Permission objects are massaged into the OpenCode-style modal shape
  // (type/title/pattern/metadata) so the existing PermissionRequestModal
  // can render them.
  assert.equal(out.permissionRequests[0].type, "vault_write");
  assert.match(String(out.permissionRequests[0].title || ""), /vault_write/);
  assert.equal(response.text, "done");
  const finalBlocks = out.blocks[out.blocks.length - 1] || [];
  const t = finalBlocks.find((b) => b.type === "tool");
  assert.equal(t.status, "completed");
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

// ---------------------------------------------------------------------------
// M2 tool surface — buildDefaultToolRegistry registers the full set
// ---------------------------------------------------------------------------

test("buildDefaultToolRegistry registers the minimum surface with a bare vault", () => {
  const vault = {
    getFileByPath: () => null,
    cachedRead: async () => "",
    create: async () => ({}),
    modify: async () => {},
  };
  const skillRegistry = new SkillRegistry([
    { name: "ah-card", description: "Card crafter", body: "..." },
  ]);
  const registry = buildDefaultToolRegistry({ vault }, undefined, skillRegistry);
  const names = registry.list().map((t) => t.name).sort();
  // Without fileManager / metadataCache, the obsidian-native tools that
  // depend on them are skipped; vault_daily still registers because it
  // works against vault.create/modify directly.
  assert.deepEqual(names, [
    "ask_user",
    "skill_invoke",
    "skill_resource_read",
    "vault_daily",
    "vault_edit",
    "vault_list",
    "vault_read",
    "vault_search",
    "vault_write",
  ]);
});

test("buildDefaultToolRegistry registers the full obsidian-native set when app has metadataCache + fileManager + workspace", () => {
  const vault = {
    getFileByPath: () => null,
    getAbstractFileByPath: () => null,
    cachedRead: async () => "",
    create: async () => ({}),
    modify: async () => {},
    createFolder: async () => {},
    getMarkdownFiles: () => [],
  };
  const app = {
    vault,
    fileManager: { processFrontMatter: async () => {}, renameFile: async () => {} },
    metadataCache: { getTags: () => ({}), getFileCache: () => null, resolvedLinks: {} },
    workspace: { getActiveFile: () => null },
  };
  const skillRegistry = new SkillRegistry([]);
  const registry = buildDefaultToolRegistry(app, undefined, skillRegistry);
  const names = registry.list().map((t) => t.name).sort();
  assert.deepEqual(names, [
    "ask_user",
    "skill_invoke",
    "skill_resource_read",
    "vault_backlinks",
    "vault_create_dir",
    "vault_daily",
    "vault_edit",
    "vault_get_active_file",
    "vault_list",
    "vault_move",
    "vault_property",
    "vault_read",
    "vault_search",
    "vault_tags",
    "vault_tasks",
    "vault_write",
  ]);
});

test("buildDefaultToolRegistry omits skill_invoke when no SkillRegistry is supplied", () => {
  const vault = {
    getFileByPath: () => null,
    cachedRead: async () => "",
    create: async () => ({}),
    modify: async () => {},
  };
  const registry = buildDefaultToolRegistry({ vault });
  assert.equal(registry.get("skill_invoke"), undefined);
});

test("ensureSkillRegistry loads configured root first, then common supplemental roots", async () => {
  const plugin = {
    settings: { skillsDir: "custom/skills" },
    app: {
      vault: {
        listSkillDirs(root) {
          const map = {
            "custom/skills": [
              { dirPath: "custom/skills/primary", filePath: "custom/skills/primary/SKILL.md" },
              { dirPath: "custom/skills/dup", filePath: "custom/skills/dup/SKILL.md" },
            ],
            ".claude/skills": [
              { dirPath: ".claude/skills/official", filePath: ".claude/skills/official/SKILL.md" },
              { dirPath: ".claude/skills/dup", filePath: ".claude/skills/dup/SKILL.md" },
            ],
          };
          return map[root] || [];
        },
        readFile: async (path) => {
          if (path.includes("/primary/")) return "---\nname: primary\ndescription: Primary\n---\nbody";
          if (path.includes("/official/")) return "---\nname: official\ndescription: Official\n---\nbody";
          if (path.includes("custom/skills/dup")) return "---\nname: dup\ndescription: Custom wins\n---\nbody";
          if (path.includes(".claude/skills/dup")) return "---\nname: dup\ndescription: Official dup\n---\nbody";
          throw new Error("missing");
        },
      },
    },
  };
  assert.deepEqual(resolveSkillRoots(plugin).slice(0, 4), [
    "custom/skills",
    ".flownote/skills",
    ".opencode/skills",
    ".claude/skills",
  ]);
  const registry = await ensureSkillRegistry(plugin);
  assert.equal(registry.get("primary").description, "Primary");
  assert.equal(registry.get("official").description, "Official");
  assert.equal(registry.get("dup").description, "Custom wins");
});

test("ensureSkillRegistry prefers embedded bundled skills over vault copies", async () => {
  const logs = [];
  const plugin = {
    settings: { skillsDir: ".flownote/skills" },
    log: (line) => logs.push(line),
    app: {
      vault: {
        listSkillDirs(root) {
          if (root !== ".flownote/skills") return [];
          return [
            { dirPath: ".flownote/skills/ah", filePath: ".flownote/skills/ah/SKILL.md" },
            { dirPath: ".flownote/skills/custom-one", filePath: ".flownote/skills/custom-one/SKILL.md" },
          ];
        },
        readFile: async (path) => {
          if (path.includes("/ah/")) return "---\nname: ah\ndescription: User edited builtin\n---\nwrong body";
          if (path.includes("/custom-one/")) return "---\nname: custom-one\ndescription: Custom\n---\ncustom body";
          throw new Error("missing");
        },
      },
    },
  };

  const registry = await ensureSkillRegistry(plugin);
  assert.notEqual(registry.get("ah").description, "User edited builtin");
  assert.match(registry.get("ah").filePath, /^<embedded>\/ah\/SKILL\.md$/);
  assert.equal(registry.get("custom-one").description, "Custom");
  assert.equal(logs.some((line) => /ignored 1 vault copy/.test(line)), true);
});

test("ensureSkillRegistry materializes embedded resources for the active locale", async () => {
  const plugin = {
    settings: { skillsDir: ".flownote/skills", uiLanguage: "en" },
    getEffectiveLocale: () => "en",
    app: { vault: { listSkillDirs: () => [] } },
  };

  const registry = await ensureSkillRegistry(plugin);
  const dailySkill = registry.get("ah-note");
  assert.ok(dailySkill);
  assert.match(
    dailySkill.embeddedResourceFiles["assets/每日笔记模板.md"],
    /Today's Most Important Thing/,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      dailySkill.embeddedResourceFiles,
      "assets/每日笔记模板.en.md",
    ),
    false,
  );
  const initSkill = registry.get("ah-init");
  assert.match(
    initSkill.embeddedResourceFiles["references/HOME Template.md"],
    /Knowledge Base Home/,
  );
});

test("ensureSkillRegistry keeps Russian embedded resources when the SKILL document falls back to English", async () => {
  let locale = "en";
  const plugin = {
    settings: { skillsDir: ".flownote/skills", uiLanguage: "en" },
    getEffectiveLocale: () => locale,
    app: { vault: { listSkillDirs: () => [] } },
  };

  const englishRegistry = await ensureSkillRegistry(plugin);
  assert.match(
    englishRegistry.get("ah-note").embeddedResourceFiles["assets/每日笔记模板.md"],
    /Today's Most Important Thing/,
  );
  locale = "ru";
  const registry = await ensureSkillRegistry(plugin);
  const dailySkill = registry.get("ah-note");
  assert.ok(dailySkill);
  assert.match(dailySkill.filePath, /^<embedded>\/ah-note\/SKILL\.md$/);
  assert.match(
    dailySkill.embeddedResourceFiles["assets/每日笔记模板.md"],
    /Главное сегодня/,
  );
  assert.doesNotMatch(
    dailySkill.embeddedResourceFiles["assets/每日笔记模板.md"],
    /Today's Most Important Thing/,
  );
});

test("Direct skill_resource_read prefers the user-edited template over the embedded default", async () => {
  const customPath = "Custom Meta/Templates/HOME Template.md";
  const files = new Map();
  const adapter = {
    exists: async (filePath) => files.has(filePath),
    read: async (filePath) => {
      if (!files.has(filePath)) throw new Error("missing");
      return files.get(filePath);
    },
    write: async (filePath, content) => { files.set(filePath, String(content)); },
    mkdir: async () => {},
  };
  const plugin = {
    settings: {
      skillsDir: ".flownote/skills",
      uiLanguage: "en",
      metaPaths: { templates: "Custom Meta/Templates" },
    },
    getEffectiveLocale: () => "en",
    app: {
      vault: {
        listSkillDirs: () => [],
        adapter,
      },
    },
  };

  await saveTemplate(plugin, "home-note", "# USER CUSTOM HOME TEMPLATE\n");
  assert.equal(files.get(customPath), "# USER CUSTOM HOME TEMPLATE\n");
  const registry = await ensureSkillRegistry(plugin);
  const tool = createSkillResourceReadTool({ skillRegistry: registry, vault: plugin.app.vault });
  const events = await collectToolEvents(tool, {
    skill: "ah-init",
    path: "references/HOME Template.md",
  });
  const result = events.at(-1);
  assert.equal(result.isError, undefined);
  assert.match(result.content, /USER CUSTOM HOME TEMPLATE/);
  assert.doesNotMatch(result.content, /Knowledge Base Home/);

  plugin.settings.metaPaths.templates = "Other Meta/Templates";
  await saveTemplate(plugin, "home-note", "# SECOND CUSTOM HOME TEMPLATE\n");
  const movedRegistry = await ensureSkillRegistry(plugin);
  const movedTool = createSkillResourceReadTool({ skillRegistry: movedRegistry, vault: plugin.app.vault });
  const movedResult = (await collectToolEvents(movedTool, {
    skill: "ah-init",
    path: "references/HOME Template.md",
  })).at(-1);
  assert.match(movedResult.content, /SECOND CUSTOM HOME TEMPLATE/);
  assert.doesNotMatch(movedResult.content, /USER CUSTOM HOME TEMPLATE/);
});

// ---------------------------------------------------------------------------
// runDirectAgentTurn injects skill listing + currentDate into system prompt
// ---------------------------------------------------------------------------

test("runDirectAgentTurn keeps current time in the current user message and skills in the stable system prompt", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "hi" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });

  // Capture what the provider was actually called with.
  let capturedInput = null;
  const provider = {
    id: "mock",
    displayName: "Mock",
    spec: { id: "mock", displayName: "Mock", protocol: "anthropic-messages", models: [] },
    userConfig: { providerId: "mock", mode: "api", apiKey: "k", model: "mock-1" },
    async *createMessage(input) {
      capturedInput = input;
      yield ev.msgStart();
      yield ev.textBlock(0);
      yield ev.textDelta(0, "ok");
      yield ev.blockStop(0);
      yield ev.msgDelta("end_turn");
      yield ev.msgStop();
    },
  };
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");
  const skillRegistry = new SkillRegistry([
    { name: "ah-card", description: "Card crafter", body: "Body of ah-card." },
    { name: "ah-note", description: "Daily note", body: "Body of ah-note." },
  ]);
  const { handlers } = collectHandlerCalls();

  await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "hi",
    handlers,
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
    runTurnAuditImpl: async () => ({ ok: true, report: { claims: [], messageKind: "answer_only" } }),
    skillRegistryOverride: skillRegistry,
  });

  assert.ok(capturedInput, "provider must have been called");
  const sys = capturedInput.system || "";
  // Local date is YYYY-MM-DD; we don't assert the value (would be flaky),
  // just the marker.
  assert.doesNotMatch(sys, /# currentDate/);
  const currentTurn = capturedInput.messages.at(-1).content.map(b => b.text || "").join("\n");
  assert.match(currentTurn, /FLOWNOTE_CURRENT_TIME/);
  assert.match(currentTurn, /\d{4}-\d{2}-\d{2}/);
  assert.match(sys, /Available skills/);
  assert.match(sys, /- ah-card:/);
  assert.match(sys, /- ah-note:/);
});

test("runDirectAgentTurn preloads explicit slash skill instructions into the current direct turn", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "/ah-capture hello" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });

  let capturedInput = null;
  const provider = {
    id: "mock",
    displayName: "Mock",
    spec: { id: "mock", displayName: "Mock", protocol: "anthropic-messages", models: [] },
    userConfig: { providerId: "mock", mode: "api", apiKey: "k", model: "mock-1" },
    async *createMessage(input) {
      capturedInput = input;
      yield ev.msgStart();
      yield ev.textBlock(0);
      yield ev.textDelta(0, "ok");
      yield ev.blockStop(0);
      yield ev.msgDelta("end_turn");
      yield ev.msgStop();
    },
  };
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");
  const skillRegistry = new SkillRegistry([
    {
      name: "ah-capture",
      slug: "ah-capture",
      description: "Capture text",
      body: "CAPTURE BODY\nInput: $ARGUMENTS\nDaily path: {{notePaths.dailyNotes}}/{{YYYY-MM-DD}}.md\nTime: {{HH:mm}}",
      argumentNames: [],
      resourcePaths: [],
      dirPath: "<test>/ah-capture",
    },
  ]);
  const { handlers } = collectHandlerCalls();

  await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "hello",
    handlers,
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
    runTurnAuditImpl: async () => ({ ok: true, report: { claims: [], messageKind: "answer_only" } }),
    skillRegistryOverride: skillRegistry,
    preloadedSkillCommand: {
      skill: "ah-capture",
      args: "hello",
      command: "/ah-capture",
    },
  });

  assert.ok(capturedInput, "provider must have been called");
  assert.equal(capturedInput.tools.some((tool) => tool.name === "flownote_finish_skill"), false);
  const currentTurn = capturedInput.messages[capturedInput.messages.length - 1];
  const text = currentTurn.content.map((block) => block.text || "").join("\n");
  assert.match(text, /preloaded skill: ah-capture/);
  assert.match(text, /CAPTURE BODY/);
  assert.match(text, /Input: hello/);
  assert.match(text, /Daily path: 01-Capture\/Daily Notes\/\d{4}-\d{2}-\d{2}\.md/);
  assert.match(text, /Time: \d{2}:\d{2}/);
  assert.match(text, /Treat Arguments as the skill input|请把 Arguments 当作该技能的输入/);
});

// ---------------------------------------------------------------------------
// ask_user handler bridge: chat-orchestrator-style onAskUser is invoked
// ---------------------------------------------------------------------------

test("runDirectAgentTurn routes ask_user tool calls through handlers.onAskUser", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "decide" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });

  const provider = makeFakeProvider([
    [
      ev.msgStart(),
      ev.toolUseStart(0, "tu-1", "ask_user"),
      ev.toolUseJson(
        0,
        JSON.stringify({
          questions: [
            {
              question: "Which one?",
              header: "Pick",
              options: [
                { label: "A", description: "first" },
                { label: "B", description: "second" },
              ],
            },
          ],
        }),
      ),
      ev.blockStop(0),
      ev.msgDelta("tool_use"),
      ev.msgStop(),
    ],
    [
      ev.msgStart(),
      ev.textBlock(0),
      ev.textDelta(0, "got A"),
      ev.blockStop(0),
      ev.msgDelta("end_turn"),
      ev.msgStop(),
    ],
  ]);
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");

  const askCalls = [];
  const handlers = {
    onToken: () => {},
    onBlocks: () => {},
    onPermissionRequest: async () => "once",
    onAskUser: async (payload) => {
      askCalls.push(payload);
      return { answers: { "Which one?": "A" } };
    },
  };

  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "decide",
    handlers,
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
  });

  assert.equal(askCalls.length, 1);
  assert.equal(askCalls[0].questions[0].question, "Which one?");
  assert.equal(response.text, "got A");
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

test("runDirectAgentTurn returns typed compact stats with real provider token usage", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  const { handlers } = collectHandlerCalls();

  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "hi",
    handlers,
    runAgentLoopImpl: async function* () {
      yield { type: "stream", event: { type: "message_start", message: { usage: { input_tokens: 1000 } } } };
      yield { type: "stream", event: ev.textDelta(0, "Done") };
      yield { type: "stream", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 200 } } };
      yield { type: "turn_complete", turnIndex: 0, stopReason: "end_turn" };
      yield { type: "done" };
    },
  });

  assert.equal(response.stats.modelLabel, "DeepSeek V4 Flash");
  assert.equal(response.stats.toolCount, 0);
  assert.equal(response.stats.requestCount, 1);
  assert.equal(response.stats.requestUsage.length, 1);
  assert.equal(response.stats.requestUsage[0].requestIndex, 0);
  assert.deepEqual(response.stats.usage, {
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  });
});

test("runDirectAgentTurn meters the main reply and the end-of-turn audit without counting repeated snapshots twice", async () => {
  const view = fakeView();
  view.plugin.settings.agentProvider.direct.stream = true;
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "test-key");
  const requests = [];
  const { handlers } = collectHandlerCalls();
  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "Explain x",
    handlers,
    skillRegistryOverride: new SkillRegistry([]),
    toolRegistryOverride: new ToolRegistry(),
    requestImpl: async (request) => {
      const body = JSON.parse(request.body);
      const isAudit = (body.tools || []).some((tool) => tool.name === "flownote_report_turn");
      requests.push(isAudit ? "audit" : "main");
      const data = isAudit ? [
        { type: "message_start", message: { usage: { input_tokens: 50, cache_read_input_tokens: 450, cache_creation_input_tokens: 20 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "report-1", name: "flownote_report_turn", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"claims":[],"message_kind":"answer_only"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
        { type: "message_stop" },
      ] : [
        { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Public explanation" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } },
        { type: "message_stop" },
      ];
      const sse = data.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return { status: 200, headers: {}, text: async () => sse };
    },
  });

  assert.deepEqual(requests, ["main", "audit"]);
  assert.equal(response.text, "Public explanation");
  assert.equal(response.stats.requestCount, 2);
  assert.deepEqual(response.stats.requestUsage.map(({ phase, responseComplete, requestIndex }) => [phase, responseComplete, requestIndex]), [
    ["main", true, 0], ["audit", true, 1],
  ]);
  assert.equal(response.stats.usage.inputTokens, 1520);
  assert.equal(response.stats.usage.cachedInputTokens, 1350);
  assert.equal(response.stats.usage.cacheWriteInputTokens, 20);
  assert.equal(response.stats.usage.outputTokens, 33);
  assert.equal(response.stats.usage.totalTokens, 1553);
});

test("runDirectAgentTurn keeps complete text from a non-streaming Anthropic-compatible response", async () => {
  const view = fakeView();
  view.plugin.settings.agentProvider.direct.stream = false;
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "test-key");
  const { handlers } = collectHandlerCalls();
  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "Explain x",
    handlers,
    skillRegistryOverride: new SkillRegistry([]),
    toolRegistryOverride: new ToolRegistry(),
    requestImpl: async (request) => {
      const isAudit = (JSON.parse(request.body).tools || []).some((tool) => tool.name === "flownote_report_turn");
      return {
        status: 200,
        text: async () => JSON.stringify(isAudit ? {
          content: [{ type: "tool_use", id: "report-1", name: "flownote_report_turn", input: { claims: [], message_kind: "answer_only" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0 },
        } : {
          content: [{ type: "text", text: "Complete buffered answer" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 5 },
        }),
      };
    },
  });

  assert.equal(response.text, "Complete buffered answer");
  assert.equal(response.stats.requestCount, 2);
  assert.equal(response.stats.usage.inputTokens, 100);
  assert.equal(response.stats.usage.cachedInputTokens, 60);
  assert.equal(response.stats.usage.outputTokens, 5);
  assert.deepEqual(response.stats.requestUsage.map(({ phase, responseComplete }) => [phase, responseComplete]), [
    ["main", true], ["audit", true],
  ]);
});

test("runDirectAgentTurn returns a suspended response with verified partial-effect recovery copy", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "/ah-card" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  const { handlers } = collectHandlerCalls();
  const contract = { id: "skill-ah-card", mode: "workflow", source: "explicit_skill" };
  const checkpoint = {
    version: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "CHECKPOINT_PRIVATE_BODY" }] }],
    effectReceipts: [{ kind: "vault_mutation", verified: true, paths: ["Cards/a.md"] }],
    contract,
    completionRetries: 0,
    turns: 20,
  };
  const checkpointRef = {
    version: 1,
    id: `sha256:${"b".repeat(64)}`,
    path: `.obsidian/plugins/flownote/continuations/${"b".repeat(64)}.json`,
    byteLength: 8192,
  };
  const storedCheckpoints = [];

  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "/ah-card",
    handlers,
    checkpointStoreOverride: {
      store: async (value) => {
        storedCheckpoints.push(value);
        return checkpointRef;
      },
    },
    runAgentLoopImpl: async function* () {
      yield {
        type: "tool_start",
        tool: "vault_write",
        toolUseId: "write-1",
        input: { path: "Cards/a.md" },
        capabilities: { effect: "vault_mutation", risk: "medium", concurrency: "serial", presentation: "edit", targets: ["Cards/a.md"] },
      };
      yield { type: "tool_finish", tool: "vault_write", toolUseId: "write-1", content: "written", isError: false, outcome: { state: "completed" } };
      yield { type: "effect_receipt", receipt: { kind: "vault_mutation", toolUseId: "write-1", verified: true, paths: ["Cards/a.md"] } };
      yield { type: "suspended", reason: "turn_boundary", stage: "between_turns", turns: 20, checkpoint };
    },
  });

  assert.equal(response.status, "suspended");
  assert.match(response.text, /paused|已暂停/i);
  assert.match(response.text, /Cards\/a\.md/);
  assert.doesNotMatch(response.text, /request failed|请求失败/i);
  assert.deepEqual(storedCheckpoints, [checkpoint]);
  assert.doesNotMatch(JSON.stringify(response.execution), /CHECKPOINT_PRIVATE_BODY/);
  assert.deepEqual(response.execution.events.at(-1).checkpointRef, checkpointRef);
  assert.equal(Object.hasOwn(response.execution.events.at(-1), "checkpoint"), false);
});

test("runDirectAgentTurn presents a provider interruption as the same resumable state on every platform", async () => {
  const view = fakeView();
  view.plugin.getEffectiveLocale = () => "zh-CN";
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  view._messages.push({ id: "u1", role: "user", text: "分析笔记" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  const { handlers } = collectHandlerCalls();
  const checkpoint = {
    version: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "PRIVATE_BODY" }] }],
    effectReceipts: [],
    contract: null,
    completionRetries: 0,
    turns: 2,
  };
  const checkpointRef = {
    version: 1,
    id: `sha256:${"c".repeat(64)}`,
    path: `.obsidian/plugins/flownote/continuations/${"c".repeat(64)}.json`,
    byteLength: 4096,
  };

  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d1",
    userText: "分析笔记",
    handlers,
    checkpointStoreOverride: { store: async () => checkpointRef },
    runAgentLoopImpl: async function* () {
      yield { type: "suspended", reason: "provider_stream_interrupted", stage: "model_stream", turns: 2, checkpoint };
    },
  });

  assert.equal(response.status, "suspended");
  assert.match(response.text, /连接中断/);
  assert.match(response.text, /继续/);
  assert.doesNotMatch(response.text, /provider|stream|structured|工具调用/i);
});

test("suspension fails closed as a typed failed run when durable checkpoint storage is unavailable", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  const snapshots = [];
  const { handlers } = collectHandlerCalls();
  handlers.onExecutionSnapshot = async (events) => snapshots.push(events);
  const contract = { id: "skill-safe-suspend", mode: "workflow", source: "explicit_skill" };
  const checkpoint = {
    version: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "PRIVATE_CHECKPOINT_BODY" }] }],
    effectReceipts: [],
    contract,
    completionRetries: 0,
    turns: 8,
  };

  await assert.rejects(
    () => runDirectAgentTurn({
      view,
      sessionId: "s1",
      draftId: "d1",
      userText: "/safe-suspend",
      handlers,
      runAgentLoopImpl: async function* () {
        yield { type: "suspended", reason: "no_progress", stage: "between_turns", turns: 8, checkpoint };
      },
    }),
    (error) => error && error.code === "CONTINUATION_CHECKPOINT_STORE_UNAVAILABLE",
  );

  const serialized = JSON.stringify(snapshots);
  assert.match(serialized, /run_failed/);
  assert.match(serialized, /CONTINUATION_CHECKPOINT_STORE_UNAVAILABLE/);
  assert.doesNotMatch(serialized, /PRIVATE_CHECKPOINT_BODY/);
});

test("runDirectAgentTurn leaves a consumed checkpoint intact until the caller durably commits the final message", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  const contract = { id: "skill-third-party", mode: "workflow", source: "explicit_skill" };
  const checkpoint = {
    version: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "private resume body" }] }],
    effectReceipts: [],
    contract,
    completionRetries: 0,
    turns: 21,
  };
  const checkpointRef = {
    version: 1,
    id: `sha256:${"c".repeat(64)}`,
    path: `.obsidian/plugins/flownote/continuations/${"c".repeat(64)}.json`,
    byteLength: 1024,
  };
  view._messages.push({ id: "u1", role: "user", text: "/third-party" });
  view._messages.push({
    id: "a1",
    role: "assistant",
    text: "paused",
    status: "suspended",
    execution: { version: 1, events: [
      { seq: 0, time: 1, type: "run_started", runId: "old-run", contract },
      { seq: 1, time: 2, type: "run_suspended", runId: "old-run", checkpointRef },
    ] },
  });
  view._messages.push({ id: "u2", role: "user", text: "继续" });
  view._messages.push({ id: "d2", role: "assistant", text: "", pending: true });
  const loaded = [];
  const removed = [];
  const snapshots = [];
  let captured = null;
  const { handlers } = collectHandlerCalls();
  view.plugin.sessionStore.state = () => ({ messagesBySession: { s1: view._messages } });
  handlers.onExecutionSnapshot = async (events) => {
    snapshots.push(events);
    if (events.at(-1).type === "run_completed") {
      // Mirrors SessionStore.setAssistantExecution: the old owner is marked
      // consumed in memory before the orchestrator commits the final message.
      view._messages.find((message) => message.id === "a1").continuationConsumedBy = "d2";
    }
  };

  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d2",
    userText: "继续",
    continuationMessageId: "a1",
    continuationRunId: "old-run",
    handlers,
    checkpointStoreOverride: {
      load: async (ref) => { loaded.push(ref); return checkpoint; },
      remove: async (ref) => { removed.push(ref); return true; },
    },
    runAgentLoopImpl: async function* (args) {
      captured = args;
      yield { type: "done", turns: 1 };
    },
  });

  assert.deepEqual(loaded, [checkpointRef]);
  assert.equal(captured.resumeState.turns, 21);
  assert.match(JSON.stringify(captured.messages), /FLOWNOTE_RESUME/);
  assert.equal(response.status, "completed");
  assert.ok(snapshots.some((events) => events.at(-1).type === "run_completed"));
  assert.deepEqual(removed, []);
});

test("runDirectAgentTurn resumes the exact checkpoint with its saved skill policy", async () => {
  const view = fakeView();
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  const contract = { id: "skill-ah-card", mode: "workflow", source: "explicit_skill" };
  const checkpoint = {
    version: 1,
    messages: [
      { role: "user", content: [{ type: "text", text: "[preloaded skill: ah-card]" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "vault_read", input: { path: "Inbox/a.md" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "source" }] },
    ],
    effectReceipts: [{ kind: "observation", toolUseId: "read-1", verified: true, paths: ["Inbox/a.md"] }],
    contract,
    completionRetries: 0,
    turns: 20,
    allowedToolPolicy: { version: 1, restricted: true, allowedTools: ["vault_read"] },
  };
  view._messages.push({ id: "u1", role: "user", text: "/ah-card" });
  view._messages.push({
    id: "a1",
    role: "assistant",
    text: "paused",
    status: "suspended",
    execution: { version: 1, events: [
      { seq: 0, time: 1, type: "run_started", runId: "old-run", contract },
      { seq: 1, time: 2, type: "run_suspended", runId: "old-run", reason: "turn_boundary", checkpoint },
    ] },
  });
  const newerCheckpoint = { ...checkpoint, turns: 99 };
  view._messages.push({
    id: "a2",
    role: "assistant",
    text: "newer paused",
    status: "suspended",
    execution: { version: 1, events: [
      { seq: 0, time: 3, type: "run_started", runId: "newer-run", contract },
      { seq: 1, time: 4, type: "run_suspended", runId: "newer-run", reason: "turn_boundary", checkpoint: newerCheckpoint },
    ] },
  });
  view._messages.push({ id: "u2", role: "user", text: "继续" });
  view._messages.push({ id: "d2", role: "assistant", text: "", pending: true });
  const { handlers } = collectHandlerCalls();
  let captured = null;

  const response = await runDirectAgentTurn({
    view,
    sessionId: "s1",
    draftId: "d2",
    userText: "继续",
    continuationMessageId: "a1",
    continuationRunId: "old-run",
    handlers,
    runAgentLoopImpl: async function* (args) {
      captured = args;
      yield { type: "done", turns: 1 };
    },
  });

  assert.equal(captured.executionContract.id, "skill-ah-card");
  assert.deepEqual(captured.resumeState.effectReceipts, checkpoint.effectReceipts);
  assert.equal(captured.resumeState.turns, 20);
  assert.deepEqual(captured.resumeState.allowedToolPolicy, checkpoint.allowedToolPolicy);
  assert.match(JSON.stringify(captured.messages), /FLOWNOTE_RESUME/);
  assert.match(JSON.stringify(captured.messages), /read-1/);
  assert.equal(response.status, "completed");
});


// ---------------------------------------------------------------------------
// Measured changes and end-of-turn reconciliation
// ---------------------------------------------------------------------------

function measuredVaultView(initialFiles = {}, folders = ["Inbox"]) {
  const view = fakeView();
  const files = new Map(Object.entries(initialFiles));
  const folderSet = new Set(folders);
  const listeners = [];
  view.app.vault = {
    files,
    getFileByPath: (path) => (files.has(path) ? { path, name: path.split("/").pop() } : null),
    getFolderByPath: (path) => (folderSet.has(path) ? { path, children: [] } : null),
    getAbstractFileByPath(path) { return this.getFileByPath(path) || this.getFolderByPath(path); },
    read: async (file) => files.get(file.path),
    cachedRead: async (file) => files.get(file.path),
    async create(path, content) { files.set(path, content); return { path }; },
    async modify(file, content) { files.set(file.path, content); },
    async process(file, fn) { const next = fn(files.get(file.path)); files.set(file.path, next); return next; },
    on(type, fn) { const ref = { type, fn }; listeners.push(ref); return ref; },
    offref(ref) { listeners.splice(listeners.indexOf(ref), 1); },
    listenerCount: () => listeners.length,
  };
  setApiKeyFor(view.plugin.settings.agentProvider, "deepseek", "k");
  return view;
}

const textTurn = (text) => [ev.msgStart(), ev.textBlock(0), ev.textDelta(0, text), ev.blockStop(0), ev.msgDelta("end_turn"), ev.msgStop()];

test("an unbacked completion claim goes back to the model; only the answer after the real write is published", async () => {
  const view = measuredVaultView();
  view._messages.push({ id: "u1", role: "user", text: "把这句话存到 Inbox/Note.md" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");
  const provider = makeFakeProvider([
    textTurn("已把内容保存到 Inbox/Note.md。"),
    [ev.msgStart(), ev.toolUseStart(0, "w1", "vault_write"), ev.toolUseJson(0, '{"path":"Inbox/Note.md","content":"那句话\\n"}'), ev.blockStop(0), ev.msgDelta("tool_use"), ev.msgStop()],
    textTurn("已保存到 Inbox/Note.md。"),
  ]);
  const audits = [];
  const { handlers, out } = collectHandlerCalls();
  const response = await runDirectAgentTurn({
    view, sessionId: "s1", draftId: "d1", userText: "把这句话存到 Inbox/Note.md", handlers,
    skillRegistryOverride: new SkillRegistry([]),
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
    runTurnAuditImpl: async (input) => {
      audits.push(input);
      return { ok: true, report: { claims: [{ text: "已保存到 Inbox/Note.md", backedBy: input.changes.length ? 0 : -1 }], messageKind: "reports_done" } };
    },
  });

  assert.equal(view.app.vault.files.get("Inbox/Note.md"), "那句话\n");
  assert.equal(audits.length, 2);
  assert.deepEqual(audits[0].changes, []);
  assert.deepEqual(audits[1].changes, [{ path: "Inbox/Note.md", op: "created" }]);
  assert.equal(response.text, "已保存到 Inbox/Note.md。");
  assert.deepEqual(response.changes, [{ path: "Inbox/Note.md", op: "created" }]);
  const finalTexts = response.blocks.filter((block) => block.type === "stream-text" && block.phase === "final").map((block) => block.text);
  assert.deepEqual(finalTexts, ["已保存到 Inbox/Note.md。"]);
  assert.ok(response.blocks.some((block) => block.type === "stream-text" && block.phase === "process" && /已把内容保存/.test(block.text)));
  const changeBlock = response.blocks.at(-1);
  assert.equal(changeBlock.source, "host_measured");
  assert.deepEqual(changeBlock.raw.files, [{ action: "added", path: "Inbox/Note.md" }]);
  assert.ok(out.tokens.includes(""), "the retracted claim is cleared from the live bubble");
  assert.equal(view.app.vault.listenerCount(), 0);
  const receipt = response.execution.events.find((event) => event.type === "effect_verified");
  assert.deepEqual(receipt.receipt.paths, ["Inbox/Note.md"]);
});

test("a pure answer produces no change block and is not rewritten", async () => {
  const view = measuredVaultView();
  view._messages.push({ id: "u1", role: "user", text: "什么是卡片笔记？" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  const { runAgentLoop } = require("../../../runtime/agent/agent-loop");
  const provider = makeFakeProvider([textTurn("卡片笔记是……")]);
  const response = await runDirectAgentTurn({
    view, sessionId: "s1", draftId: "d1", userText: "什么是卡片笔记？", handlers: collectHandlerCalls().handlers,
    skillRegistryOverride: new SkillRegistry([]),
    runAgentLoopImpl: (args) => runAgentLoop({ ...args, provider }),
    runTurnAuditImpl: async () => ({ ok: true, report: { claims: [], messageKind: "answer_only" } }),
  });
  assert.equal(response.text, "卡片笔记是……");
  assert.deepEqual(response.changes, []);
  assert.equal(response.blocks.some((block) => block.type === "patch"), false);
});

test("a failed run still reports the files it really changed", async () => {
  const view = measuredVaultView();
  view._messages.push({ id: "u1", role: "user", text: "x" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  await assert.rejects(
    () => runDirectAgentTurn({
      view, sessionId: "s1", draftId: "d1", userText: "x", handlers: collectHandlerCalls().handlers,
      skillRegistryOverride: new SkillRegistry([]),
      runAgentLoopImpl: async function* (args) {
        await args.ctx.app.vault.create("Inbox/Partial.md", "partial");
        yield { type: "error", error: { type: "provider_stream_error", message: "boom" } };
      },
    }),
    (error) => {
      assert.deepEqual(error.flownoteChangeBlock.raw.files, [{ action: "added", path: "Inbox/Partial.md" }]);
      return true;
    },
  );
  assert.equal(view.app.vault.listenerCount(), 0);
});

test("an explicit effect skill that reports completion without any change is sent back to the model", async () => {
  const view = measuredVaultView();
  view._messages.push({ id: "u1", role: "user", text: "/ah-capture idea" });
  view._messages.push({ id: "d1", role: "assistant", text: "", pending: true });
  const skillRegistry = new SkillRegistry([{
    name: "ah-capture", slug: "ah-capture", description: "Capture", body: "BODY", argumentNames: [], resourcePaths: [],
    dirPath: "<test>/ah-capture", userInvocable: true,
    completionPolicy: { state: "declared", mode: "effect", requiredEffects: [], requiredInteractions: [], minReceipts: null, errorCode: null },
  }]);
  let verdict = null;
  await runDirectAgentTurn({
    view, sessionId: "s1", draftId: "d1", userText: "idea", handlers: collectHandlerCalls().handlers,
    skillRegistryOverride: skillRegistry,
    preloadedSkillCommand: { skill: "ah-capture", args: "idea", command: "/ah-capture" },
    runTurnAuditImpl: async () => ({ ok: true, report: { claims: [], messageKind: "reports_done" } }),
    runAgentLoopImpl: async function* (args) {
      verdict = await args.stopCheck({ finalContent: [{ type: "text", text: "已记录。" }], interactionReceipts: [] });
      yield { type: "done", turns: 1 };
    },
  });
  assert.equal(verdict.allow, false);
  assert.match(verdict.feedback, /\/ah-capture must change the vault, but nothing changed/);
});
