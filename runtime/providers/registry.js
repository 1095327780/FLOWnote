// Built-in provider catalog. Data only — no HTTP, no I/O.
// Adapters consume these specs to instantiate concrete Provider objects.
//
// Spec sheet for each provider is in
// docs/tech-design/0.5.0-provider-abstraction.md (Appendix A).

/** @typedef {import('./provider').ProviderConfig} ProviderConfig */

/** @type {Object<string, ProviderConfig>} */
const PROVIDERS = {
  "deepseek": {
    id: "deepseek",
    displayName: "DeepSeek",
    protocol: "anthropic-messages",
    modes: {
      "api": {
        label: "Pay-per-token API",
        baseUrl: "https://api.deepseek.com/anthropic",
      },
    },
    defaultMode: "api",
    auth: { headerName: "Authorization", scheme: "bearer" },
    models: [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 1_000_000, maxOutput: 384_000, tier: "fast", isDefault: true },
      { id: "deepseek-v4-pro",   label: "DeepSeek V4 Pro",   contextWindow: 1_000_000, maxOutput: 384_000, tier: "high" },
      { id: "deepseek-chat",     label: "DeepSeek Chat (legacy)",     contextWindow:    64_000, maxOutput:   8_192, tier: "mid",  deprecated: true, deprecationDate: "2026-07-24" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner (legacy)", contextWindow:    64_000, maxOutput:   8_192, tier: "mid",  deprecated: true, deprecationDate: "2026-07-24" },
    ],
    defaultModel: "deepseek-v4-flash",
  },

  "anthropic-official": {
    id: "anthropic-official",
    displayName: "Anthropic (官方)",
    protocol: "anthropic-messages",
    modes: {
      "api": {
        // baseUrl convention: the prefix BEFORE "/v1/messages".
        // Every anthropic-messages provider follows the same convention,
        // so the adapter always appends "/v1/messages".
        label: "Pay-per-token API",
        baseUrl: "https://api.anthropic.com",
      },
    },
    defaultMode: "api",
    auth: { headerName: "x-api-key", scheme: "raw" },
    versionHeader: "anthropic-version: 2026-01-01",
    models: [
      { id: "claude-opus-4-7",     label: "Claude Opus 4.7",     contextWindow:   200_000, maxOutput: 64_000, tier: "high" },
      { id: "claude-sonnet-4-6",   label: "Claude Sonnet 4.6",   contextWindow: 1_000_000, maxOutput: 64_000, tier: "high", isDefault: true },
      { id: "claude-haiku-4-5",    label: "Claude Haiku 4.5",    contextWindow:   200_000, maxOutput: 16_000, tier: "fast" },
    ],
    defaultModel: "claude-sonnet-4-6",
  },

  "zhipu-glm": {
    id: "zhipu-glm",
    displayName: "智谱 GLM",
    protocol: "anthropic-messages",
    modes: {
      "coding-plan": {
        label: "GLM Coding Plan",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        planUrl: "https://www.bigmodel.cn/glm-coding",
        recommendedModel: "glm-4.7-flash",
      },
      "api": {
        label: "按量付费 API",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        recommendedModel: "glm-4.7-flash",
      },
    },
    defaultMode: "coding-plan",
    auth: { headerName: "Authorization", scheme: "bearer" },
    region: {
      cnUrl: "https://open.bigmodel.cn/api/anthropic",
      intlUrl: "https://api.z.ai/api/anthropic",
      defaultRegion: "cn",
    },
    models: [
      { id: "glm-5",          label: "GLM-5",          contextWindow: 200_000, maxOutput: 32_768, tier: "high" },
      { id: "glm-4.7",        label: "GLM-4.7",        contextWindow: 200_000, maxOutput: 32_768, tier: "mid" },
      { id: "glm-4.7-flash",  label: "GLM-4.7 Flash",  contextWindow: 200_000, maxOutput: 32_768, tier: "fast", isDefault: true },
    ],
    defaultModel: "glm-4.7-flash",
  },

  "minimax": {
    id: "minimax",
    displayName: "MiniMax",
    protocol: "anthropic-messages",
    modes: {
      "coding-plan": {
        label: "MiniMax Coding Plan",
        baseUrl: "https://api.minimaxi.com/anthropic",
        planUrl: "https://platform.minimaxi.com/",
        recommendedModel: "MiniMax-M2.7-highspeed",
      },
      "api": {
        label: "按量付费 API",
        baseUrl: "https://api.minimaxi.com/anthropic",
        recommendedModel: "MiniMax-M2.7",
      },
    },
    defaultMode: "coding-plan",
    auth: { headerName: "Authorization", scheme: "bearer" },
    region: {
      cnUrl: "https://api.minimaxi.com/anthropic",
      intlUrl: "https://api.minimax.io/anthropic",
      defaultRegion: "cn",
    },
    models: [
      { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 高速", contextWindow: 245_760, maxOutput: 32_768, tier: "fast", isDefault: true },
      { id: "MiniMax-M2.7",           label: "MiniMax M2.7",      contextWindow: 245_760, maxOutput: 32_768, tier: "high" },
      { id: "MiniMax-M2.5-highspeed", label: "MiniMax M2.5 高速", contextWindow: 245_760, maxOutput: 16_384, tier: "fast" },
      { id: "MiniMax-M2.5",           label: "MiniMax M2.5",      contextWindow: 245_760, maxOutput: 16_384, tier: "mid" },
    ],
    defaultModel: "MiniMax-M2.7-highspeed",
    quirks: {
      // Per platform.minimax.io/docs/api-reference/text-anthropic-api
      // these are silently dropped by the server. We strip locally so the
      // model never sees an inconsistent state.
      unsupportedParams: [
        "thinking",
        "top_k",
        "stop_sequences",
        "service_tier",
        "mcp_servers",
        "context_management",
        "container",
      ],
      streamingTolerant: true,
    },
  },

  "moonshot-kimi": {
    id: "moonshot-kimi",
    displayName: "Moonshot Kimi",
    protocol: "anthropic-messages",
    modes: {
      "coding-plan": {
        label: "Kimi Coding Plan",
        baseUrl: "https://api.moonshot.ai/anthropic",
        planUrl: "https://platform.moonshot.ai/",
        recommendedModel: "kimi-k2.5",
      },
      "api": {
        label: "按量付费 API",
        baseUrl: "https://api.moonshot.ai/anthropic",
        recommendedModel: "kimi-k2.5",
      },
    },
    defaultMode: "coding-plan",
    auth: { headerName: "Authorization", scheme: "bearer" },
    models: [
      { id: "kimi-k2.5", label: "Kimi K2.5", contextWindow: 200_000, maxOutput: 32_768, tier: "high", isDefault: true },
    ],
    defaultModel: "kimi-k2.5",
  },

  "qwen": {
    id: "qwen",
    displayName: "通义千问 (Qwen)",
    protocol: "openai-chat",
    modes: {
      "coding-plan": {
        label: "通义灵码套餐",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        planUrl: "https://tongyi.aliyun.com/lingma",
        recommendedModel: "qwen-coder-plus",
      },
      "api": {
        label: "按量付费 API",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        recommendedModel: "qwen-flash",
      },
    },
    defaultMode: "coding-plan",
    auth: { headerName: "Authorization", scheme: "bearer" },
    models: [
      { id: "qwen-coder-plus", label: "Qwen Coder Plus", contextWindow: 131_072, maxOutput: 32_768, tier: "high", isDefault: true },
      { id: "qwen-max",        label: "Qwen Max",        contextWindow:  32_768, maxOutput:  8_192, tier: "high" },
      { id: "qwen-flash",      label: "Qwen Flash",      contextWindow:  32_768, maxOutput:  8_192, tier: "fast" },
    ],
    defaultModel: "qwen-coder-plus",
  },

  "doubao": {
    id: "doubao",
    displayName: "豆包 (Doubao / 火山方舟)",
    protocol: "openai-chat",
    modes: {
      "coding-plan": {
        label: "火山方舟订阅",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        planUrl: "https://www.volcengine.com/product/ark",
      },
      "api": {
        label: "按量付费 API",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      },
    },
    defaultMode: "api",
    auth: { headerName: "Authorization", scheme: "bearer" },
    // Doubao users must create an "endpoint ID" on the ARK console and
    // use that as the model name; we surface a free-form field rather
    // than a fixed model dropdown.
    userMustProvideModels: true,
    models: [
      { id: "doubao-pro-32k", label: "Doubao Pro 32K (示例 endpoint-id)", contextWindow: 32_768, maxOutput: 4_096, tier: "high" },
    ],
    defaultModel: "doubao-pro-32k",
  },

  "openai-official": {
    id: "openai-official",
    displayName: "OpenAI (官方)",
    protocol: "openai-chat",
    modes: {
      "api": {
        label: "Pay-per-token API",
        baseUrl: "https://api.openai.com/v1",
      },
    },
    defaultMode: "api",
    auth: { headerName: "Authorization", scheme: "bearer" },
    models: [
      { id: "gpt-5.4",        label: "GPT-5.4",        contextWindow: 400_000, maxOutput: 65_536, tier: "high", isDefault: true },
      { id: "gpt-5.4-mini",   label: "GPT-5.4 Mini",   contextWindow: 400_000, maxOutput: 32_768, tier: "fast" },
      { id: "gpt-5.4-turbo",  label: "GPT-5.4 Turbo",  contextWindow: 400_000, maxOutput: 32_768, tier: "mid" },
    ],
    defaultModel: "gpt-5.4",
  },

  "openai-compat-custom": {
    id: "openai-compat-custom",
    displayName: "自定义 OpenAI-compat",
    protocol: "openai-chat",
    modes: {
      "api": {
        label: "自定义 API",
        baseUrl: "",
      },
    },
    defaultMode: "api",
    auth: { headerName: "Authorization", scheme: "bearer" },
    userMustProvideBaseUrl: true,
    userMustProvideModels: true,
    models: [],
    defaultModel: "",
  },

  "opencode-legacy": {
    id: "opencode-legacy",
    displayName: "OpenCode (legacy)",
    protocol: "opencode-runtime",
    modes: {
      "runtime": {
        label: "OpenCode runtime",
        baseUrl: "",
      },
    },
    defaultMode: "runtime",
    auth: { headerName: "", scheme: "raw" },
    desktopOnly: true,
    models: [],
    defaultModel: "",
  },
};

const DEFAULT_PROVIDER_ID = "deepseek";

/**
 * Get a provider spec by id, or undefined if unknown.
 * @param {string} id
 * @returns {ProviderConfig | undefined}
 */
function getProviderSpec(id) {
  return PROVIDERS[id];
}

/**
 * Get every built-in provider spec in stable order.
 * @returns {ProviderConfig[]}
 */
function listProviderSpecs() {
  return Object.values(PROVIDERS);
}

/**
 * @returns {string} the id of the provider new installs should default to.
 */
function getDefaultProviderId() {
  return DEFAULT_PROVIDER_ID;
}

/**
 * Resolve the base URL for a given user config. Order:
 *   1. userConfig.baseUrlOverride (if non-empty)
 *   2. region-specific URL if spec.region is defined
 *   3. mode.baseUrl
 *
 * @param {ProviderConfig} spec
 * @param {import('./provider').ProviderUserConfig} userConfig
 * @returns {string}
 */
function resolveBaseUrl(spec, userConfig) {
  if (userConfig.baseUrlOverride && userConfig.baseUrlOverride.trim()) {
    return userConfig.baseUrlOverride.trim();
  }
  if (spec.region) {
    const region = userConfig.region || spec.region.defaultRegion;
    if (region === "intl" && spec.region.intlUrl) return spec.region.intlUrl;
    if (region === "cn" && spec.region.cnUrl) return spec.region.cnUrl;
  }
  const mode = spec.modes[userConfig.mode];
  if (!mode) {
    throw new Error(`Unknown mode "${userConfig.mode}" for provider "${spec.id}"`);
  }
  return mode.baseUrl;
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  getProviderSpec,
  listProviderSpecs,
  getDefaultProviderId,
  resolveBaseUrl,
};
