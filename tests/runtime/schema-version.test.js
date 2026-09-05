const test = require("node:test");
const assert = require("node:assert/strict");

const { sessionBootstrapMethods } = require("../../runtime/plugin/session-bootstrap-methods");

test("persistState should include schemaVersion", async () => {
  let saved = null;
  const plugin = {
    settings: { debugLogs: false },
    runtimeState: {
      sessions: [],
      activeSessionId: "",
      messagesBySession: {},
      deletedSessionIds: [],
      modelCatalogCache: null,
    },
    async saveData(payload) {
      saved = payload;
    },
  };

  Object.assign(plugin, sessionBootstrapMethods);

  await plugin.persistState();

  assert.ok(saved && typeof saved === "object");
  assert.equal(saved.schemaVersion, 1);
  assert.ok(saved.settings);
  assert.ok(saved.runtimeState);
  assert.equal(saved.runtimeRevision, 1);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flushTasks = () => new Promise((resolve) => setImmediate(resolve));

test("persistState serializes immutable revisions instead of racing mutable state", async () => {
  const gates = [deferred(), deferred()];
  const saved = [];
  const plugin = {
    settings: { marker: "first" },
    runtimeState: { sessions: [], activeSessionId: "", messagesBySession: {}, marker: 1 },
    async saveData(payload) {
      const index = saved.length;
      saved.push(payload);
      await gates[index].promise;
    },
  };
  Object.assign(plugin, sessionBootstrapMethods);

  const first = plugin.persistState();
  plugin.settings.marker = "second";
  plugin.runtimeState.marker = 2;
  const second = plugin.persistState();
  await flushTasks();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].runtimeRevision, 1);
  assert.equal(saved[0].settings.marker, "first");
  assert.equal(saved[0].runtimeState.marker, 1);

  gates[0].resolve();
  await first;
  await flushTasks();
  assert.equal(saved.length, 2);
  assert.equal(saved[1].runtimeRevision, 2);
  assert.equal(saved[1].settings.marker, "second");
  assert.equal(saved[1].runtimeState.marker, 2);

  gates[1].resolve();
  await second;
  assert.equal(plugin.committedRuntimeRevision, 2);
});

test("a failed state commit does not poison later queued revisions", async () => {
  let calls = 0;
  const plugin = {
    settings: {},
    runtimeState: { sessions: [], activeSessionId: "", messagesBySession: {} },
    async saveData() {
      calls += 1;
      if (calls === 1) throw new Error("disk full");
    },
  };
  Object.assign(plugin, sessionBootstrapMethods);

  const failed = plugin.persistState();
  const recovered = plugin.persistState();

  await assert.rejects(failed, /disk full/);
  await recovered;
  assert.equal(calls, 2);
  assert.equal(plugin.committedRuntimeRevision, 2);
});
