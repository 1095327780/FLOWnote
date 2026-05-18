const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AGENT_MODE_NOTICE_FLAG,
  getAgentModeNotice,
  hasPersistedPluginData,
  markAgentModeNoticeSeen,
  normalizeNoticeVersion,
} = require("../../runtime/release-notice");

test("hasPersistedPluginData distinguishes fresh install from existing data", () => {
  assert.equal(hasPersistedPluginData(null), false);
  assert.equal(hasPersistedPluginData({}), false);
  assert.equal(hasPersistedPluginData({ settings: {} }), true);
  assert.equal(hasPersistedPluginData({ sessions: [] }), true);
});

test("getAgentModeNotice returns first-install or update until current version is seen", () => {
  assert.deepEqual(getAgentModeNotice({ migrationFlags: {} }, {
    existingInstall: false,
    version: "0.4.0",
  }), { version: "0.4.0", kind: "first-install" });

  assert.deepEqual(getAgentModeNotice({ migrationFlags: {} }, {
    existingInstall: true,
    version: "0.4.0",
  }), { version: "0.4.0", kind: "update" });

  const state = { migrationFlags: { [AGENT_MODE_NOTICE_FLAG]: "0.4.0" } };
  assert.equal(getAgentModeNotice(state, { existingInstall: true, version: "0.4.0" }), null);
});

test("markAgentModeNoticeSeen stores the normalized current version", () => {
  const state = {};
  markAgentModeNoticeSeen(state, " 0.4.0 ");
  assert.equal(state.migrationFlags[AGENT_MODE_NOTICE_FLAG], "0.4.0");
  assert.equal(normalizeNoticeVersion(""), "0");
});
