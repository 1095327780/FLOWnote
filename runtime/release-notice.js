const AGENT_MODE_NOTICE_FLAG = "agentModeNoticeVersion";
const PRE_050_AGENT_MODE_NOTICE_FLAG = "pre050AgentModeNoticeVersion";
const LAST_PLUGIN_VERSION_FIELD = "lastPluginVersion";
const AGENT_MODE_NOTICE_MIN_VERSION = "0.5.0";

function normalizeNoticeVersion(value) {
  const version = String(value || "").trim();
  return version || "0";
}

function normalizeStoredPluginVersion(value) {
  const version = String(value || "").trim();
  return version && version !== "0" ? version : "";
}

function parseVersionParts(value) {
  const version = normalizeNoticeVersion(value)
    .replace(/^[^\d]*/, "")
    .split(/[+-]/)[0];
  const parts = version.split(".").map((part) => {
    const match = String(part || "").match(/\d+/);
    return match ? Number(match[0]) : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3).map((part) => (Number.isFinite(part) ? part : 0));
}

function compareNoticeVersions(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta < 0) return -1;
    if (delta > 0) return 1;
  }
  return 0;
}

function getRememberedPluginVersion(runtimeState) {
  const state = runtimeState && typeof runtimeState === "object" ? runtimeState : {};
  return normalizeStoredPluginVersion(state[LAST_PLUGIN_VERSION_FIELD]);
}

function rememberPluginVersion(runtimeState, version) {
  if (!runtimeState || typeof runtimeState !== "object") return false;
  const normalized = normalizeNoticeVersion(version);
  if (runtimeState[LAST_PLUGIN_VERSION_FIELD] === normalized) return false;
  runtimeState[LAST_PLUGIN_VERSION_FIELD] = normalized;
  return true;
}

function hasPersistedPluginData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  return Object.keys(raw).length > 0;
}

function looksLikePre050LegacyInstall(raw, options = {}) {
  if (!options.existingInstall) return false;
  if (normalizeStoredPluginVersion(options.previousVersion)) return false;
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const settings = root.settings && typeof root.settings === "object" && !Array.isArray(root.settings)
    ? root.settings
    : root;

  if (
    settings.agentProvider
    || settings.agentProviderModePreference
    || getRememberedPluginVersion(root.runtimeState)
  ) {
    return false;
  }

  const legacyKeys = [
    "authMode",
    "customProviderId",
    "customApiKey",
    "customBaseUrl",
    "useCustomApiKey",
    "experimentalSdkEnabled",
    "transportMode",
    "skillInjectMode",
    "prependSkillPrompt",
    "defaultProvider",
  ];
  return legacyKeys.some((key) => Object.prototype.hasOwnProperty.call(settings, key));
}

function getAgentModeNotice(runtimeState, options = {}) {
  const version = normalizeNoticeVersion(options.version);
  const flags = runtimeState && runtimeState.migrationFlags && typeof runtimeState.migrationFlags === "object"
    ? runtimeState.migrationFlags
    : {};
  if (!options.existingInstall) return null;
  if (compareNoticeVersions(version, AGENT_MODE_NOTICE_MIN_VERSION) < 0) return null;

  const seenVersion = normalizeStoredPluginVersion(flags[PRE_050_AGENT_MODE_NOTICE_FLAG] || flags[AGENT_MODE_NOTICE_FLAG]);
  if (seenVersion && compareNoticeVersions(seenVersion, AGENT_MODE_NOTICE_MIN_VERSION) >= 0) return null;

  const previousVersion = normalizeStoredPluginVersion(
    options.previousVersion || getRememberedPluginVersion(runtimeState),
  );
  const isPre050Upgrade = previousVersion
    ? compareNoticeVersions(previousVersion, AGENT_MODE_NOTICE_MIN_VERSION) < 0
    : Boolean(options.legacyPre050Install);
  if (!isPre050Upgrade) return null;

  return {
    version,
    kind: "update",
  };
}

function markAgentModeNoticeSeen(runtimeState, version) {
  if (!runtimeState || typeof runtimeState !== "object") return null;
  if (!runtimeState.migrationFlags || typeof runtimeState.migrationFlags !== "object") {
    runtimeState.migrationFlags = {};
  }
  const normalized = normalizeNoticeVersion(version);
  runtimeState.migrationFlags[AGENT_MODE_NOTICE_FLAG] = normalized;
  runtimeState.migrationFlags[PRE_050_AGENT_MODE_NOTICE_FLAG] = normalized;
  return runtimeState;
}

module.exports = {
  AGENT_MODE_NOTICE_MIN_VERSION,
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
};
