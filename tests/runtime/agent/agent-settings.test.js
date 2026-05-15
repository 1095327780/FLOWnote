const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_AGENT_SETTINGS,
  defaultAgentSettings,
  migrateAgentSettings,
  normalizeAgentSettings,
  getActiveApiKey,
  setApiKeyFor,
  switchActiveProvider,
} = require("../../../runtime/agent/agent-settings");

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

test("defaultAgentSettings: deepseek + V4 Flash + direct mode + enabled", () => {
  const s = defaultAgentSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.mode, "direct");
  assert.equal(s.direct.providerId, "deepseek");
  assert.equal(s.direct.providerMode, "api");
  assert.equal(s.direct.model, "deepseek-v4-flash");
  assert.equal(s.direct.stream, true);
  assert.deepEqual(s.direct.apiKeys, {});
});

test("DEFAULT_AGENT_SETTINGS is frozen and matches the factory output shape", () => {
  // Frozen at the top level (deeper freezing not strictly required)
  assert.equal(Object.isFrozen(DEFAULT_AGENT_SETTINGS), true);
  const fresh = defaultAgentSettings();
  assert.equal(fresh.mode, DEFAULT_AGENT_SETTINGS.mode);
  assert.equal(fresh.direct.providerId, DEFAULT_AGENT_SETTINGS.direct.providerId);
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

test("migrateAgentSettings: fresh install with no agentProvider gets direct mode", () => {
  const settings = {};
  migrateAgentSettings(settings);
  assert.equal(settings.agentProvider.mode, "direct");
  assert.equal(settings.agentProvider.direct.providerId, "deepseek");
});

test("migrateAgentSettings: existing OpenCode user (cliPath set) migrates to opencode-legacy", () => {
  const settings = { cliPath: "/Users/x/.opencode/bin/opencode", launchStrategy: "auto" };
  migrateAgentSettings(settings);
  assert.equal(settings.agentProvider.mode, "opencode-legacy");
});

test("migrateAgentSettings: explicit launchStrategy other than auto also signals OpenCode user", () => {
  const settings = { cliPath: "", launchStrategy: "native" };
  migrateAgentSettings(settings);
  assert.equal(settings.agentProvider.mode, "opencode-legacy");
});

test("migrateAgentSettings: providerAuth metadata also signals OpenCode user", () => {
  const settings = { providerAuth: { anthropic: { kind: "api" } } };
  migrateAgentSettings(settings);
  assert.equal(settings.agentProvider.mode, "opencode-legacy");
});

test("migrateAgentSettings: idempotent — running twice leaves shape intact", () => {
  const settings = {};
  migrateAgentSettings(settings);
  const first = JSON.stringify(settings);
  migrateAgentSettings(settings);
  assert.equal(JSON.stringify(settings), first);
});

test("migrateAgentSettings: existing agentProvider is normalized (missing fields filled)", () => {
  const settings = {
    agentProvider: {
      mode: "direct",
      direct: { providerId: "deepseek" }, // missing most fields
    },
  };
  migrateAgentSettings(settings);
  assert.equal(settings.agentProvider.direct.model, "deepseek-v4-flash");
  assert.equal(settings.agentProvider.direct.providerMode, "api");
  assert.equal(settings.agentProvider.enabled, true);
});

test("migrateAgentSettings: unknown providerId falls back to the default provider", () => {
  const settings = {
    agentProvider: { mode: "direct", direct: { providerId: "not-real" } },
  };
  migrateAgentSettings(settings);
  assert.equal(settings.agentProvider.direct.providerId, "deepseek");
});

test("migrateAgentSettings: invalid mode falls back to direct", () => {
  const settings = { agentProvider: { mode: "weird" } };
  migrateAgentSettings(settings);
  assert.equal(settings.agentProvider.mode, "direct");
});

test("migrateAgentSettings: handles null/undefined gracefully", () => {
  const out = migrateAgentSettings(null);
  assert.equal(out.agentProvider.mode, "direct");
});

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

test("normalizeAgentSettings: drops region values that aren't cn/intl", () => {
  const n = normalizeAgentSettings({ mode: "direct", direct: { providerId: "zhipu-glm", region: "europe" } });
  assert.equal(n.direct.region, undefined);
});

test("normalizeAgentSettings: keeps valid region", () => {
  const n = normalizeAgentSettings({ mode: "direct", direct: { providerId: "zhipu-glm", region: "intl" } });
  assert.equal(n.direct.region, "intl");
});

test("normalizeAgentSettings: rejects non-string apiKey values", () => {
  const n = normalizeAgentSettings({
    mode: "direct",
    direct: { providerId: "deepseek", apiKeys: { deepseek: "ok", zhipu: 42, minimax: null } },
  });
  assert.equal(n.direct.apiKeys.deepseek, "ok");
  assert.equal("zhipu" in n.direct.apiKeys, false);
  assert.equal("minimax" in n.direct.apiKeys, false);
});

test("normalizeAgentSettings: invalid providerMode falls back to provider's default", () => {
  const n = normalizeAgentSettings({
    mode: "direct",
    direct: { providerId: "zhipu-glm", providerMode: "weird" },
  });
  assert.equal(n.direct.providerMode, "coding-plan"); // zhipu-glm's default
});

// ---------------------------------------------------------------------------
// helpers: getActiveApiKey / setApiKeyFor / switchActiveProvider
// ---------------------------------------------------------------------------

test("getActiveApiKey returns the key stored for the current provider", () => {
  const s = defaultAgentSettings();
  s.direct.apiKeys.deepseek = "sk-ds";
  s.direct.apiKeys["zhipu-glm"] = "sk-glm";
  s.direct.providerId = "zhipu-glm";
  assert.equal(getActiveApiKey(s), "sk-glm");
});

test("getActiveApiKey returns empty string when no key set", () => {
  const s = defaultAgentSettings();
  assert.equal(getActiveApiKey(s), "");
});

test("setApiKeyFor stores per-provider keys without affecting others", () => {
  const s = defaultAgentSettings();
  setApiKeyFor(s, "deepseek", "sk-1");
  setApiKeyFor(s, "moonshot-kimi", "sk-2");
  assert.equal(s.direct.apiKeys.deepseek, "sk-1");
  assert.equal(s.direct.apiKeys["moonshot-kimi"], "sk-2");
});

test("switchActiveProvider resets mode/model and preserves keys", () => {
  const s = defaultAgentSettings();
  setApiKeyFor(s, "deepseek", "sk-ds");
  setApiKeyFor(s, "zhipu-glm", "sk-glm");
  switchActiveProvider(s, "zhipu-glm");
  assert.equal(s.direct.providerId, "zhipu-glm");
  assert.equal(s.direct.providerMode, "coding-plan");
  assert.equal(s.direct.model, "glm-4.7-flash");
  // keys preserved
  assert.equal(s.direct.apiKeys.deepseek, "sk-ds");
  assert.equal(s.direct.apiKeys["zhipu-glm"], "sk-glm");
});

test("switchActiveProvider throws for unknown provider", () => {
  const s = defaultAgentSettings();
  assert.throws(() => switchActiveProvider(s, "not-a-real-provider"), /unknown provider/);
});

test("switchActiveProvider sets region default when provider has region split", () => {
  const s = defaultAgentSettings();
  switchActiveProvider(s, "zhipu-glm");
  assert.equal(s.direct.region, "cn");
});

test("switchActiveProvider clears region when provider has no split", () => {
  const s = defaultAgentSettings();
  s.direct.region = "cn";
  switchActiveProvider(s, "moonshot-kimi"); // no region split
  assert.equal(s.direct.region, undefined);
});
