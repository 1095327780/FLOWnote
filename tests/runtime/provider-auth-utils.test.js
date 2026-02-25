const test = require("node:test");
const assert = require("node:assert/strict");

const { providerAuthUtilsMethods } = require("../../runtime/settings/provider-auth-utils");

function createContext(locale = "en") {
  return {
    ...providerAuthUtilsMethods,
    plugin: {
      getEffectiveLocale: () => locale,
    },
  };
}

test("resolveProviderCountryCode should infer country from provider hints", () => {
  const ctx = createContext("en");
  assert.equal(ctx.resolveProviderCountryCode({ id: "deepseek", name: "DeepSeek" }), "CN");
  assert.equal(ctx.resolveProviderCountryCode({ id: "openai", name: "OpenAI" }), "US");
});

test("resolveProviderCountryCode should respect direct country fields", () => {
  const ctx = createContext("en");
  assert.equal(ctx.resolveProviderCountryCode({ country: "France" }), "FR");
  assert.equal(ctx.resolveProviderCountryCode({ countryCode: "jp" }), "JP");
});

test("resolveProviderCountryLabel should fallback to i18n text for unknown country", () => {
  const ctx = createContext("en");
  assert.equal(ctx.resolveProviderCountryLabel("ZZ"), "Unknown Country");
});

test("resolveProviderCountryLabel should fallback to localized static map when Intl display names unavailable", () => {
  const ctx = createContext("zh-CN");
  ctx.getCountryDisplayNames = () => null;
  assert.equal(ctx.resolveProviderCountryLabel("US"), "美国");
});

test("buildProviderEntry should include country fields and searchable metadata", () => {
  const ctx = createContext("en");
  const entry = ctx.buildProviderEntry(
    {
      id: "openai",
      name: "OpenAI",
      models: { "gpt-4.1": {} },
    },
    new Set(["openai"]),
    {},
  );

  assert.equal(entry.countryCode, "US");
  assert.equal(typeof entry.countryLabel, "string");
  assert.equal(ctx.providerEntryMatchesQuery(entry, "us"), true);
  assert.equal(ctx.providerEntryMatchesQuery(entry, "connected"), true);
});

