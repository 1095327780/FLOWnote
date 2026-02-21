const DEFAULT_SETTINGS = {
  transportMode: "compat",
  experimentalSdkEnabled: false,
  cliPath: "",
  autoDetectCli: true,
  skillsDir: ".opencode/skills",
  skillInjectMode: "summary",
  defaultModel: "",
  authMode: "opencode-default",
  customProviderId: "openai",
  customApiKey: "",
  customBaseUrl: "",
  requestTimeoutMs: 120000,
  enableStreaming: true,
  debugLogs: false,
  opencodeHomeDir: ".opencode-runtime",
  launchStrategy: "auto",
  wslDistro: "",
};

function migrateLegacySettings(raw) {
  const data = raw && typeof raw === "object" ? { ...raw } : {};

  if (typeof data.useCustomApiKey === "boolean") {
    data.authMode = data.useCustomApiKey ? "custom-api-key" : "opencode-default";
    delete data.useCustomApiKey;
  }

  const transportModeRaw = String(data.transportMode || "").trim().toLowerCase();
  if (!transportModeRaw) data.transportMode = "compat";
  else if (!["sdk", "compat"].includes(transportModeRaw)) data.transportMode = "compat";
  else data.transportMode = transportModeRaw;

  if (data.prependSkillPrompt === false && !data.skillInjectMode) data.skillInjectMode = "off";
  if (data.prependSkillPrompt === true && !data.skillInjectMode) data.skillInjectMode = "summary";
  delete data.prependSkillPrompt;

  if (typeof data.experimentalSdkEnabled !== "boolean") {
    data.experimentalSdkEnabled = false;
  }

  return data;
}

function normalizeSettings(raw) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, migrateLegacySettings(raw));

  if (!["sdk", "compat"].includes(String(merged.transportMode || "").trim().toLowerCase())) {
    merged.transportMode = "compat";
  }
  merged.experimentalSdkEnabled = Boolean(merged.experimentalSdkEnabled);
  if (!merged.experimentalSdkEnabled) merged.transportMode = "compat";
  if (!["summary", "full", "off"].includes(merged.skillInjectMode)) merged.skillInjectMode = "summary";
  if (!["opencode-default", "custom-api-key"].includes(merged.authMode)) merged.authMode = "opencode-default";
  if (!["auto", "native", "wsl"].includes(String(merged.launchStrategy || "").trim().toLowerCase())) {
    merged.launchStrategy = "auto";
  }

  merged.requestTimeoutMs = Math.max(10000, Number(merged.requestTimeoutMs) || DEFAULT_SETTINGS.requestTimeoutMs);
  merged.cliPath = String(merged.cliPath || "").trim();
  merged.skillsDir = String(merged.skillsDir || DEFAULT_SETTINGS.skillsDir).trim();
  merged.defaultModel = String(merged.defaultModel || "").trim();
  merged.customProviderId = String(merged.customProviderId || "openai").trim();
  merged.customApiKey = String(merged.customApiKey || "").trim();
  merged.customBaseUrl = String(merged.customBaseUrl || "").trim();
  merged.transportMode = String(merged.transportMode || "compat").trim().toLowerCase();
  merged.launchStrategy = String(merged.launchStrategy || "auto").trim().toLowerCase();
  merged.wslDistro = String(merged.wslDistro || "").trim();

  return merged;
}

module.exports = {
  DEFAULT_SETTINGS,
  migrateLegacySettings,
  normalizeSettings,
};
