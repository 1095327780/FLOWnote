const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { DiagnosticTrace } = require("../../runtime/diagnostic-trace");

function createAdapter({ size = 0, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async stat() {
      if (fail === "stat") throw new Error("stat failed");
      return { size };
    },
    async write(path, data) {
      if (fail === "write") throw new Error("write failed");
      calls.push({ method: "write", path, data });
      size = String(data).length;
    },
    async append(path, data) {
      if (fail === "append") throw new Error("append failed");
      calls.push({ method: "append", path, data });
      size += String(data).length;
    },
  };
}

function loadPluginClass() {
  const originalLoad = Module._load;
  class PluginMock {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }
  }
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return { Plugin: PluginMock };
    return originalLoad.call(this, request, parent, isMain);
  };
  const mainModulePath = require.resolve("../../main.js");
  delete require.cache[mainModulePath];
  return {
    PluginClass: require(mainModulePath),
    restore() {
      Module._load = originalLoad;
      delete require.cache[mainModulePath];
    },
  };
}

test("DiagnosticTrace does not create or append a trace while diagnostics are disabled", async () => {
  const adapter = createAdapter();
  const trace = new DiagnosticTrace({
    adapter,
    getEnabled: () => false,
    getPath: () => ".obsidian/plugins/flownote/agent-trace.log",
  });

  await trace.record("agent.prompt_prepared", { promptLength: 42, linkedFileCount: 1 });

  assert.deepEqual(adapter.calls, []);
});

test("DiagnosticTrace still appends the first entry when stat reports a missing trace file", async () => {
  const adapter = createAdapter();
  let statCalls = 0;
  const originalStat = adapter.stat;
  adapter.stat = async () => {
    statCalls += 1;
    if (statCalls === 1) {
      const error = new Error("trace file does not exist");
      error.code = "ENOENT";
      throw error;
    }
    return originalStat();
  };
  const trace = new DiagnosticTrace({
    adapter,
    getEnabled: () => true,
    getPath: () => ".obsidian/plugins/flownote/agent-trace.log",
  });

  await trace.record("agent.turn_started", { historyLength: 3 });

  assert.equal(statCalls, 1);
  assert.deepEqual(adapter.calls.map((call) => call.method), ["append"]);
  assert.deepEqual(JSON.parse(adapter.calls[0].data), {
    event: "agent.turn_started",
    historyLength: 3,
  });
});

test("DiagnosticTrace persists only allowlisted structural metadata", async () => {
  const adapter = createAdapter();
  const trace = new DiagnosticTrace({
    adapter,
    getEnabled: () => true,
    getPath: () => ".obsidian/plugins/flownote/agent-trace.log",
  });

  await trace.record("agent.prompt_prepared", {
    promptLength: 42,
    linkedFileCount: 1,
    prompt: "private note body",
    path: "/Users/person/Vault/private.md",
    authorization: "Bearer sk-this-must-not-appear",
    model: "deepseek-chat",
  });

  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].method, "append");
  const entry = JSON.parse(adapter.calls[0].data);
  assert.deepEqual(entry, {
    event: "agent.prompt_prepared",
    linkedFileCount: 1,
    model: "deepseek-chat",
    promptLength: 42,
  });
  assert.doesNotMatch(adapter.calls[0].data, /private note|\/Users\/person|sk-this-must-not-appear/i);
});

test("DiagnosticTrace rejects credential-like strings in nominally safe enum fields", async () => {
  const adapter = createAdapter();
  const trace = new DiagnosticTrace({
    adapter,
    getEnabled: () => true,
    getPath: () => ".obsidian/plugins/flownote/agent-trace.log",
  });

  await trace.record("agent.turn_started", {
    provider: "deepseek",
    model: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
  });

  const entry = JSON.parse(adapter.calls[0].data);
  assert.deepEqual(entry, { event: "agent.turn_started", provider: "deepseek" });
});

test("DiagnosticTrace maps model or third-party free-form status fields to structural other", async () => {
  const adapter = createAdapter();
  const trace = new DiagnosticTrace({
    adapter,
    getEnabled: () => true,
    getPath: () => ".obsidian/plugins/flownote/agent-trace.log",
  });

  await trace.record("agent.workflow_suspended", {
    reason: "privateNoteTitle",
    stage: "thirdPartyStage",
    stopReason: "customerSecret",
    disposition: "completed",
  });

  const entry = JSON.parse(adapter.calls[0].data);
  assert.deepEqual(entry, {
    event: "agent.workflow_suspended",
    reason: "other",
    stage: "other",
    stopReason: "other",
    disposition: "completed",
  });
  assert.doesNotMatch(adapter.calls[0].data, /privateNoteTitle|thirdPartyStage|customerSecret/);
});

test("DiagnosticTrace rotates before an append over its bounded size", async () => {
  const adapter = createAdapter({ size: 64 });
  const trace = new DiagnosticTrace({
    adapter,
    getEnabled: () => true,
    getPath: () => ".obsidian/plugins/flownote/agent-trace.log",
    maxBytes: 64,
  });

  await trace.record("turn.finished", { toolCount: 2, textLength: 10 });

  assert.deepEqual(adapter.calls.map((call) => call.method), ["write", "append"]);
  assert.equal(adapter.calls[0].data, "");
  assert.ok(adapter.calls[1].data.length < 64);
});

test("DiagnosticTrace swallows adapter failures so diagnostics cannot interrupt the agent", async () => {
  const adapter = createAdapter({ fail: "append" });
  const trace = new DiagnosticTrace({
    adapter,
    getEnabled: () => true,
    getPath: () => ".obsidian/plugins/flownote/agent-trace.log",
  });

  await assert.doesNotReject(() => trace.record("agent.turn_started", { historyLength: 3 }));
});

test("plugin trace wiring is opt-in and plugin.log no longer persists direct-agent prose", async () => {
  const fixture = loadPluginClass();
  try {
    const adapter = createAdapter();
    const plugin = new fixture.PluginClass({ vault: { adapter } }, { dir: ".obsidian/plugins/flownote" });
    plugin.settings = { debugLogs: false };

    plugin.log("[direct-agent] private prompt body must not be persisted");
    await plugin.traceDiagnostic("agent.prompt_prepared", { promptLength: 21, prompt: "private prompt body" });
    assert.deepEqual(adapter.calls, []);

    plugin.settings.debugLogs = true;
    await plugin.traceDiagnostic("agent.prompt_prepared", {
      promptLength: 21,
      prompt: "private prompt body",
      path: "/Users/person/Vault/private.md",
    });

    assert.equal(adapter.calls.length, 1);
    assert.doesNotMatch(adapter.calls[0].data, /private prompt|\/Users\/person/);
  } finally {
    fixture.restore();
  }
});
