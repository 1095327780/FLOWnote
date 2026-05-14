const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  getProviderSpec,
  listProviderSpecs,
  getDefaultProviderId,
  resolveBaseUrl,
} = require("../../../runtime/providers/registry");

const REQUIRED_TOP_LEVEL_FIELDS = ["id", "displayName", "protocol", "modes", "defaultMode", "auth", "models", "defaultModel"];
const VALID_PROTOCOLS = new Set(["anthropic-messages", "openai-chat", "opencode-runtime"]);
const VALID_AUTH_SCHEMES = new Set(["bearer", "raw"]);

test("every provider has required top-level fields", () => {
  for (const spec of listProviderSpecs()) {
    for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
      assert.ok(field in spec, `provider "${spec.id}" missing field "${field}"`);
    }
  }
});

test("every provider has a known protocol", () => {
  for (const spec of listProviderSpecs()) {
    assert.ok(VALID_PROTOCOLS.has(spec.protocol), `provider "${spec.id}" has unknown protocol "${spec.protocol}"`);
  }
});

test("every provider has a valid auth scheme", () => {
  for (const spec of listProviderSpecs()) {
    assert.ok(VALID_AUTH_SCHEMES.has(spec.auth.scheme), `provider "${spec.id}" has unknown auth scheme "${spec.auth.scheme}"`);
  }
});

test("defaultMode points at an actual mode key", () => {
  for (const spec of listProviderSpecs()) {
    assert.ok(spec.modes[spec.defaultMode], `provider "${spec.id}" defaultMode "${spec.defaultMode}" is not in modes`);
  }
});

test("each mode has a baseUrl (empty allowed only for custom)", () => {
  for (const spec of listProviderSpecs()) {
    for (const [modeId, mode] of Object.entries(spec.modes)) {
      if (spec.userMustProvideBaseUrl) {
        // custom provider — empty base URL is fine; user fills it
        continue;
      }
      assert.ok(typeof mode.baseUrl === "string", `${spec.id}/${modeId} baseUrl must be string`);
      if (spec.id !== "opencode-legacy") {
        assert.ok(mode.baseUrl.length > 0, `${spec.id}/${modeId} baseUrl must be non-empty`);
      }
    }
  }
});

test("defaultModel exists in models[] for providers with a fixed model list", () => {
  for (const spec of listProviderSpecs()) {
    if (spec.userMustProvideModels) continue;
    if (spec.id === "opencode-legacy") continue;
    const ids = spec.models.map((m) => m.id);
    assert.ok(ids.includes(spec.defaultModel), `${spec.id} defaultModel "${spec.defaultModel}" not in models[]`);
  }
});

test("provider ids are unique in the listed order", () => {
  const seen = new Set();
  for (const spec of listProviderSpecs()) {
    assert.ok(!seen.has(spec.id), `duplicate provider id "${spec.id}"`);
    seen.add(spec.id);
  }
});

test("DEFAULT_PROVIDER_ID is a registered provider", () => {
  assert.equal(typeof DEFAULT_PROVIDER_ID, "string");
  assert.ok(PROVIDERS[DEFAULT_PROVIDER_ID], `default provider "${DEFAULT_PROVIDER_ID}" is not registered`);
});

test("DeepSeek V4 Flash is the default model for the default provider", () => {
  const spec = PROVIDERS[DEFAULT_PROVIDER_ID];
  assert.equal(spec.id, "deepseek");
  assert.equal(spec.defaultModel, "deepseek-v4-flash");
});

test("Anthropic uses x-api-key, everyone else uses Authorization", () => {
  for (const spec of listProviderSpecs()) {
    if (spec.id === "anthropic-official") {
      assert.equal(spec.auth.headerName, "x-api-key");
      assert.equal(spec.auth.scheme, "raw");
    } else if (spec.id === "opencode-legacy") {
      // opencode does its own thing — no http auth header
    } else {
      assert.equal(spec.auth.headerName, "Authorization");
      assert.equal(spec.auth.scheme, "bearer");
    }
  }
});

test("MiniMax declares the documented unsupported params", () => {
  const spec = PROVIDERS["minimax"];
  assert.ok(spec.quirks, "minimax must have quirks");
  for (const param of ["thinking", "top_k", "stop_sequences", "service_tier", "mcp_servers", "context_management", "container"]) {
    assert.ok(spec.quirks.unsupportedParams.includes(param), `minimax quirks should drop "${param}"`);
  }
  assert.equal(spec.quirks.streamingTolerant, true);
});

test("zhipu-glm and minimax both surface a Coding Plan mode with a planUrl", () => {
  for (const id of ["zhipu-glm", "minimax", "moonshot-kimi"]) {
    const spec = PROVIDERS[id];
    const mode = spec.modes["coding-plan"];
    assert.ok(mode, `${id} should have a coding-plan mode`);
    assert.ok(typeof mode.planUrl === "string" && mode.planUrl.length > 0, `${id} coding-plan should have a planUrl`);
  }
});

test("opencode-legacy is desktop-only", () => {
  const spec = PROVIDERS["opencode-legacy"];
  assert.equal(spec.desktopOnly, true);
});

test("custom OpenAI-compat is the open slot for user-supplied endpoints", () => {
  const spec = PROVIDERS["openai-compat-custom"];
  assert.equal(spec.userMustProvideBaseUrl, true);
  assert.equal(spec.userMustProvideModels, true);
});

test("getProviderSpec returns the spec for a known id and undefined otherwise", () => {
  assert.equal(getProviderSpec("deepseek").id, "deepseek");
  assert.equal(getProviderSpec("does-not-exist"), undefined);
});

test("getDefaultProviderId returns DEFAULT_PROVIDER_ID", () => {
  assert.equal(getDefaultProviderId(), DEFAULT_PROVIDER_ID);
});

test("resolveBaseUrl prefers userConfig.baseUrlOverride", () => {
  const url = resolveBaseUrl(PROVIDERS["deepseek"], {
    providerId: "deepseek",
    mode: "api",
    apiKey: "k",
    model: "deepseek-v4-flash",
    baseUrlOverride: "  https://my-relay.example.com/v1  ",
  });
  assert.equal(url, "https://my-relay.example.com/v1");
});

test("resolveBaseUrl uses region-specific URL when spec.region is defined", () => {
  const cn = resolveBaseUrl(PROVIDERS["zhipu-glm"], {
    providerId: "zhipu-glm",
    mode: "coding-plan",
    apiKey: "k",
    model: "glm-4.7-flash",
    region: "cn",
  });
  assert.equal(cn, "https://open.bigmodel.cn/api/anthropic");

  const intl = resolveBaseUrl(PROVIDERS["zhipu-glm"], {
    providerId: "zhipu-glm",
    mode: "coding-plan",
    apiKey: "k",
    model: "glm-4.7-flash",
    region: "intl",
  });
  assert.equal(intl, "https://api.z.ai/api/anthropic");
});

test("resolveBaseUrl falls back to mode.baseUrl for providers without region", () => {
  const url = resolveBaseUrl(PROVIDERS["deepseek"], {
    providerId: "deepseek",
    mode: "api",
    apiKey: "k",
    model: "deepseek-v4-flash",
  });
  assert.equal(url, "https://api.deepseek.com/anthropic");
});

test("resolveBaseUrl throws on unknown mode", () => {
  assert.throws(
    () => resolveBaseUrl(PROVIDERS["deepseek"], {
      providerId: "deepseek",
      mode: "no-such-mode",
      apiKey: "k",
      model: "deepseek-v4-flash",
    }),
    /Unknown mode/,
  );
});
