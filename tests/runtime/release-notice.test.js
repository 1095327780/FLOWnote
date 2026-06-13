const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AGENT_MODE_NOTICE_FLAG,
  LAST_PLUGIN_VERSION_FIELD,
  PRE_050_AGENT_MODE_NOTICE_FLAG,
  compareNoticeVersions,
  getAgentModeNotice,
  getRememberedPluginVersion,
  hasPersistedPluginData,
  looksLikePre050LegacyInstall,
  markAgentModeNoticeSeen,
  normalizeNoticeVersion,
  rememberPluginVersion,
} = require("../../runtime/release-notice");

test("hasPersistedPluginData distinguishes fresh install from existing data", () => {
  assert.equal(hasPersistedPluginData(null), false);
  assert.equal(hasPersistedPluginData({}), false);
  assert.equal(hasPersistedPluginData({ settings: {} }), true);
  assert.equal(hasPersistedPluginData({ sessions: [] }), true);
});

test("getAgentModeNotice does not show on fresh installs or normal 0.5.x upgrades", () => {
  assert.equal(getAgentModeNotice({ migrationFlags: {} }, {
    existingInstall: false,
    version: "0.5.10",
  }), null);

  assert.equal(getAgentModeNotice({ migrationFlags: {}, lastPluginVersion: "0.5.0" }, {
    existingInstall: true,
    version: "0.5.10",
  }), null);

  assert.equal(getAgentModeNotice({ migrationFlags: {}, lastPluginVersion: "0.5.9" }, {
    existingInstall: true,
    version: "0.5.10",
  }), null);
});

test("getAgentModeNotice shows once for pre-0.5.0 upgrades", () => {
  assert.deepEqual(getAgentModeNotice({ migrationFlags: {}, lastPluginVersion: "0.4.9" }, {
    existingInstall: true,
    version: "0.5.10",
  }), { version: "0.5.10", kind: "update" });

  const state = { migrationFlags: {}, lastPluginVersion: "0.4.9" };
  markAgentModeNoticeSeen(state, "0.5.10");
  assert.equal(getAgentModeNotice(state, {
    existingInstall: true,
    version: "0.5.10",
    previousVersion: "0.4.9",
  }), null);

  const oldFlagState = { migrationFlags: { [AGENT_MODE_NOTICE_FLAG]: "0.5.10" }, lastPluginVersion: "0.4.9" };
  assert.equal(getAgentModeNotice(oldFlagState, {
    existingInstall: true,
    version: "0.5.10",
  }), null);
});

test("getAgentModeNotice only treats absent previous versions as legacy when shape is explicit", () => {
  assert.equal(getAgentModeNotice({ migrationFlags: {} }, {
    existingInstall: true,
    version: "0.5.10",
  }), null);

  assert.deepEqual(getAgentModeNotice({ migrationFlags: {} }, {
    existingInstall: true,
    version: "0.5.10",
    legacyPre050Install: true,
  }), { version: "0.5.10", kind: "update" });

  assert.equal(looksLikePre050LegacyInstall({
    settings: {
      agentProvider: { mode: "direct" },
      customApiKey: "sk-old",
    },
  }, { existingInstall: true }), false);
  assert.equal(looksLikePre050LegacyInstall({
    settings: {
      customApiKey: "sk-old",
    },
  }, { existingInstall: true }), true);
});

test("markAgentModeNoticeSeen and rememberPluginVersion store normalized versions", () => {
  const state = {};
  markAgentModeNoticeSeen(state, " 0.4.0 ");
  assert.equal(state.migrationFlags[AGENT_MODE_NOTICE_FLAG], "0.4.0");
  assert.equal(state.migrationFlags[PRE_050_AGENT_MODE_NOTICE_FLAG], "0.4.0");
  assert.equal(rememberPluginVersion(state, " 0.5.10 "), true);
  assert.equal(rememberPluginVersion(state, "0.5.10"), false);
  assert.equal(state[LAST_PLUGIN_VERSION_FIELD], "0.5.10");
  assert.equal(getRememberedPluginVersion(state), "0.5.10");
  assert.equal(normalizeNoticeVersion(""), "0");
});

test("compareNoticeVersions supports semver-like upgrade comparisons", () => {
  assert.equal(compareNoticeVersions("0.4.9", "0.5.0"), -1);
  assert.equal(compareNoticeVersions("0.5.0", "0.5.0"), 0);
  assert.equal(compareNoticeVersions("0.5.10", "0.5.9"), 1);
  assert.equal(compareNoticeVersions("v0.5.10-beta.1", "0.5.9"), 1);
});
