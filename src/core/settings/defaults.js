const DEFAULT_SETTINGS = {
  transportMode: "sdk",
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
};

module.exports = {
  DEFAULT_SETTINGS,
};
