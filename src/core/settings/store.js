const { DEFAULT_SETTINGS } = require("./defaults");

function migrateLegacySettings(raw) {
  const data = raw || {};

  if (typeof data.useCustomApiKey === "boolean") {
    data.authMode = data.useCustomApiKey ? "custom-api-key" : "opencode-default";
    delete data.useCustomApiKey;
  }

  if (!data.transportMode) {
    data.transportMode = "sdk";
  }

  if (data.prependSkillPrompt === false && !data.skillInjectMode) {
    data.skillInjectMode = "off";
  }
  if (data.prependSkillPrompt === true && !data.skillInjectMode) {
    data.skillInjectMode = "summary";
  }
  delete data.prependSkillPrompt;

  if (!data.requestTimeoutMs || Number.isNaN(Number(data.requestTimeoutMs))) {
    data.requestTimeoutMs = DEFAULT_SETTINGS.requestTimeoutMs;
  }

  return data;
}

function normalizeSettings(raw) {
  const migrated = migrateLegacySettings(raw);
  const merged = Object.assign({}, DEFAULT_SETTINGS, migrated);

  if (!["sdk", "compat"].includes(merged.transportMode)) {
    merged.transportMode = "sdk";
  }

  if (!["summary", "full", "off"].includes(merged.skillInjectMode)) {
    merged.skillInjectMode = "summary";
  }

  if (!["opencode-default", "custom-api-key"].includes(merged.authMode)) {
    merged.authMode = "opencode-default";
  }

  merged.requestTimeoutMs = Math.max(10000, Number(merged.requestTimeoutMs) || DEFAULT_SETTINGS.requestTimeoutMs);
  merged.cliPath = String(merged.cliPath || "").trim();
  merged.skillsDir = String(merged.skillsDir || DEFAULT_SETTINGS.skillsDir).trim();
  merged.defaultModel = String(merged.defaultModel || "").trim();
  merged.customProviderId = String(merged.customProviderId || "openai").trim();
  merged.customApiKey = String(merged.customApiKey || "").trim();
  merged.customBaseUrl = String(merged.customBaseUrl || "").trim();

  return merged;
}

module.exports = {
  normalizeSettings,
};
