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
});
