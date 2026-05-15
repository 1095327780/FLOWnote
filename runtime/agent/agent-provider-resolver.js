// Resolves user-facing AgentSettings into a concrete Provider instance.
//
// Called by the Settings UI (for the Test button) and by the chat view
// (when starting a turn). Single source of truth for "given the user's
// configuration, which Provider should we use?"

const { getProviderSpec } = require("../providers/registry");
const { createAnthropicMessagesProvider } = require("../providers/anthropic-messages-adapter");
const { createOpenAIChatProvider } = require("../providers/openai-chat-adapter");
const { getActiveApiKey } = require("./agent-settings");

/**
 * @param {import('./agent-settings').AgentSettings} settings
 * @param {Object} [opts]
 * @param {Function} [opts.requestImpl]
 * @returns {import('../providers/provider').Provider}
 * @throws if settings.mode is opencode-legacy (not yet bridged), or if
 *         required fields are missing, or if the protocol is unknown.
 */
function resolveAgentProvider(settings, opts = {}) {
  if (!settings) throw new Error("resolveAgentProvider: settings required");
  if (settings.enabled === false) {
    throw new Error("resolveAgentProvider: agent is disabled in settings");
  }

  if (settings.mode === "opencode-legacy") {
    // Wiring the legacy OpenCode runtime as a Provider lands in M3.
    // For now, fail clearly so the caller can route to the existing
    // OpenCode code path or surface a helpful UI message.
    const err = new Error(
      "OpenCode legacy mode is not bridged through the new agent runtime yet. " +
      "Use Settings → Provider → Direct (e.g. DeepSeek) or keep using the existing chat panel.",
    );
    err.code = "OPENCODE_LEGACY_NOT_BRIDGED";
    throw err;
  }

  const direct = settings.direct || {};
  const spec = getProviderSpec(direct.providerId);
  if (!spec) {
    throw new Error(`resolveAgentProvider: unknown provider "${direct.providerId}"`);
  }

  const apiKey = getActiveApiKey(settings);
  if (!apiKey) {
    const err = new Error(`No API key configured for provider "${spec.displayName}".`);
    err.code = "MISSING_API_KEY";
    err.providerId = spec.id;
    throw err;
  }

  if (!direct.model) {
    throw new Error(`resolveAgentProvider: no model selected for provider "${spec.id}".`);
  }
  // Custom OpenAI-compat requires the user to supply a base URL.
  if (spec.userMustProvideBaseUrl) {
    const url = String(direct.baseUrlOverride || "").trim();
    if (!url) {
      const err = new Error("Custom OpenAI-compat provider requires a base URL.");
      err.code = "MISSING_BASE_URL";
      throw err;
    }
  }

  /** @type {import('../providers/provider').ProviderUserConfig} */
  const userConfig = {
    providerId: spec.id,
    mode: direct.providerMode || spec.defaultMode,
    region: direct.region,
    apiKey,
    model: direct.model,
    baseUrlOverride: direct.baseUrlOverride || "",
    userAgentOverride: direct.userAgentOverride || "",
    versionHeaderOverride: direct.versionHeaderOverride || "",
    stream: direct.stream !== false,
  };

  const requestImpl = opts.requestImpl;

  if (spec.protocol === "anthropic-messages") {
    return createAnthropicMessagesProvider({ spec, userConfig, requestImpl });
  }
  if (spec.protocol === "openai-chat") {
    return createOpenAIChatProvider({ spec, userConfig, requestImpl });
  }
  if (spec.protocol === "opencode-runtime") {
    const err = new Error("OpenCode runtime protocol is not handled by the direct resolver. Set settings.mode = 'opencode-legacy' and use the legacy chat path.");
    err.code = "WRONG_RESOLVER";
    throw err;
  }
  throw new Error(`resolveAgentProvider: unsupported protocol "${spec.protocol}"`);
}

/**
 * Build a Provider for an arbitrary spec + userConfig without going
 * through the user-settings object. Useful for the Settings UI "Test"
 * button when the user has changed fields but not yet saved.
 *
 * @param {Object} args
 * @param {import('../providers/provider').ProviderConfig} args.spec
 * @param {import('../providers/provider').ProviderUserConfig} args.userConfig
 * @param {Function} [args.requestImpl]
 * @returns {import('../providers/provider').Provider}
 */
function buildProviderFromSpec({ spec, userConfig, requestImpl }) {
  if (!spec) throw new Error("buildProviderFromSpec: spec required");
  if (spec.protocol === "anthropic-messages") {
    return createAnthropicMessagesProvider({ spec, userConfig, requestImpl });
  }
  if (spec.protocol === "openai-chat") {
    return createOpenAIChatProvider({ spec, userConfig, requestImpl });
  }
  throw new Error(`buildProviderFromSpec: unsupported protocol "${spec.protocol}"`);
}

module.exports = {
  resolveAgentProvider,
  buildProviderFromSpec,
};
