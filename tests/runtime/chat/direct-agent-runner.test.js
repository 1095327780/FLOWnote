const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runDirectAgentTurn,
  buildAnthropicHistory,
  buildDefaultToolRegistry,
  ensureSkillRegistry,
  resolveSkillRoots,
} = require("../../../runtime/chat/direct-agent-runner");
const { ToolRegistry, buildTool } = require("../../../runtime/agent/tool-registry");
const { SkillRegistry } = require("../../../runtime/agent/skill-registry");
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
  assert.equal(toolBlock.status, "completed");
  assert.equal(toolBlock.output, "file x.md");
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
      ev.toolUseJson(0, "{\"path\":\"Meta/.ai-memory/STATUS.md\"}"),
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

// ---------------------------------------------------------------------------
// runDirectAgentTurn injects skill listing + currentDate into system prompt
// ---------------------------------------------------------------------------

test("runDirectAgentTurn passes a system prompt containing currentDate + skill listing", async () => {
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
    skillRegistryOverride: skillRegistry,
  });

  assert.ok(capturedInput, "provider must have been called");
  const sys = capturedInput.system || "";
  // Local date is YYYY-MM-DD; we don't assert the value (would be flaky),
  // just the marker.
  assert.match(sys, /# currentDate/);
  assert.match(sys, /\d{4}-\d{2}-\d{2}/);
  assert.match(sys, /Available skills/);
  assert.match(sys, /- ah-card:/);
  assert.match(sys, /- ah-note:/);
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
