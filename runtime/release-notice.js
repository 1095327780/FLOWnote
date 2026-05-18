const AGENT_MODE_NOTICE_FLAG = "agentModeNoticeVersion";

function normalizeNoticeVersion(value) {
  const version = String(value || "").trim();
  return version || "0";
}

function hasPersistedPluginData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  return Object.keys(raw).length > 0;
}

function getAgentModeNotice(runtimeState, options = {}) {
  const version = normalizeNoticeVersion(options.version);
  const flags = runtimeState && runtimeState.migrationFlags && typeof runtimeState.migrationFlags === "object"
    ? runtimeState.migrationFlags
    : {};
  if (String(flags[AGENT_MODE_NOTICE_FLAG] || "") === version) return null;
  return {
    version,
    kind: options.existingInstall ? "update" : "first-install",
  };
}

function markAgentModeNoticeSeen(runtimeState, version) {
  if (!runtimeState || typeof runtimeState !== "object") return null;
  if (!runtimeState.migrationFlags || typeof runtimeState.migrationFlags !== "object") {
    runtimeState.migrationFlags = {};
  }
  runtimeState.migrationFlags[AGENT_MODE_NOTICE_FLAG] = normalizeNoticeVersion(version);
  return runtimeState;
}

module.exports = {
  AGENT_MODE_NOTICE_FLAG,
  getAgentModeNotice,
  hasPersistedPluginData,
  markAgentModeNoticeSeen,
  normalizeNoticeVersion,
};
