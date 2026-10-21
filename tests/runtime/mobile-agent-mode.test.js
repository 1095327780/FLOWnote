const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { getEffectiveAgentMode } = require("../../runtime/agent/agent-mode");
const { sessionBootstrapMethods } = require("../../runtime/plugin/session-bootstrap-methods");
const { runDirectAgentTurn } = require("../../runtime/chat/direct-agent-runner");
const { defaultAgentSettings, setApiKeyFor } = require("../../runtime/agent/agent-settings");
const { SkillRegistry } = require("../../runtime/agent/skill-registry");
const { ToolRegistry } = require("../../runtime/agent/tool-registry");

async function withMobile(callback) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "obsidian") return { Platform: { isMobile: true } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return await callback(); } finally { Module._load = originalLoad; }
}

test("mobile always uses direct while desktop retains its saved mode", () => {
  for (const mode of [undefined, "direct", "opencode-legacy"]) {
    const settings = { mode };
    assert.equal(getEffectiveAgentMode(settings, { isMobile: true }), "direct");
    assert.equal(getEffectiveAgentMode(settings, { isMobile: false }), mode === "opencode-legacy" ? mode : "direct");
    assert.equal(settings.mode, mode);
  }
});

test("mobile creates local sessions and skips OpenCode bootstrap even with a stale client", async () => withMobile(async () => {
  const plugin = {
    settings: { agentProvider: { mode: "opencode-legacy" } },
    opencodeClient: { createSession: async () => { throw new Error("mobile called OpenCode"); } },
    sessionStore: { upsertSession(session) { plugin.created = session; } },
    persistState: async () => {},
    refreshModelCatalog: async () => { throw new Error("mobile refreshed OpenCode models"); },
    syncSessionsFromRemote: async () => { throw new Error("mobile synced OpenCode sessions"); },
    notifyModelCatalogUpdated() { this.modelPickerUpdated = true; },
  };
  const session = await sessionBootstrapMethods.createSession.call(plugin, "mobile chat");
  assert.match(session.id, /^local-/);
  assert.equal(plugin.created.title, "mobile chat");
  await sessionBootstrapMethods.runBootstrapRemote.call(plugin);
  assert.equal(plugin.bootstrapRemoteDone, true);
  assert.equal(plugin.modelPickerUpdated, true);
  assert.equal(plugin.settings.agentProvider.mode, "opencode-legacy");
}));

test("mobile resolves a synced legacy provider using a runtime-only direct override", async () => withMobile(async () => {
  const agentProvider = defaultAgentSettings();
  agentProvider.mode = "opencode-legacy";
  setApiKeyFor(agentProvider, "deepseek", "test-key");
  const before = JSON.stringify(agentProvider);
  let resolvedProvider;
  const response = await runDirectAgentTurn({
    view: {
      app: { vault: {} },
      plugin: {
        settings: { agentProvider },
        sessionStore: { getSessionMessages: () => [] },
      },
    },
    sessionId: "local-mobile",
    draftId: "draft-mobile",
    userText: "hello",
    handlers: {},
    toolRegistryOverride: new ToolRegistry(),
    skillRegistryOverride: new SkillRegistry([]),
    executionContractOverride: { id: "mobile-answer", mode: "answer", requiredEffects: [] },
    runAgentLoopImpl: async function* (args) {
      resolvedProvider = args.provider;
      yield { type: "stream", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "mobile response" } } };
      yield { type: "done" };
    },
  });
  assert.equal(resolvedProvider.spec.id, "deepseek");
  assert.equal(response.text, "mobile response");
  assert.equal(JSON.stringify(agentProvider), before);
}));

test("mobile without a cloud API key reports configuration instead of a legacy-mode error", async () => withMobile(async () => {
  const agentProvider = { ...defaultAgentSettings(), mode: "opencode-legacy" };
  await assert.rejects(runDirectAgentTurn({
    view: { plugin: { settings: { agentProvider } } },
  }), /No API key configured/);
  assert.equal(agentProvider.mode, "opencode-legacy");
}));
