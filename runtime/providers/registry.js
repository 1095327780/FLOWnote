// Built-in provider catalog. Data only — no HTTP, no I/O.
// Adapters consume these specs to instantiate concrete Provider objects.
//
// Keep provider specs self-contained so the public repository does not depend
// on internal planning notes.

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
    auth: { headerName: "x-api-key", scheme: "raw" },
    modelsListEndpoint: "https://api.deepseek.com/models",
    modelsListAuth: { headerName: "Authorization", scheme: "bearer" },
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
    versionHeader: "anthropic-version: 2023-06-01",
    modelsListEndpoint: "https://api.anthropic.com/v1/models",
    models: [
      { id: "claude-sonnet-4-6",          label: "Claude Sonnet 4.6", contextWindow: 1_000_000, maxOutput:  64_000, tier: "high", isDefault: true },
      { id: "claude-opus-4-7",            label: "Claude Opus 4.7",   contextWindow: 1_000_000, maxOutput: 128_000, tier: "high" },
      { id: "claude-haiku-4-5-20251001",  label: "Claude Haiku 4.5",  contextWindow:   200_000, maxOutput:  64_000, tier: "fast" },
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
        recommendedModel: "glm-5.1",
      },
      "api": {
        label: "按量付费 API",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        recommendedModel: "glm-5.1",
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
      { id: "glm-5.1",        label: "GLM-5.1",        contextWindow: 200_000, maxOutput: 128_000, tier: "high", isDefault: true },
      { id: "glm-5",          label: "GLM-5",          contextWindow: 200_000, maxOutput: 128_000, tier: "high" },
      { id: "glm-5-turbo",    label: "GLM-5 Turbo",    contextWindow: 200_000, maxOutput:  64_000, tier: "high" },
      { id: "glm-4.7",        label: "GLM-4.7",        contextWindow: 200_000, maxOutput:  32_768, tier: "mid" },
      { id: "glm-4.5-air",    label: "GLM-4.5 Air",    contextWindow: 128_000, maxOutput:  16_384, tier: "fast" },
    ],
    defaultModel: "glm-5.1",
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
    auth: { headerName: "X-Api-Key", scheme: "raw" },
    modelsListPath: "/v1/models",
    region: {
      cnUrl: "https://api.minimaxi.com/anthropic",
      intlUrl: "https://api.minimax.io/anthropic",
      defaultRegion: "cn",
    },
    models: [
      { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 高速", contextWindow: 204_800, maxOutput: 32_768, tier: "fast", isDefault: true },
      { id: "MiniMax-M2.7",           label: "MiniMax M2.7",      contextWindow: 204_800, maxOutput: 32_768, tier: "high" },
      { id: "MiniMax-M2.5-highspeed", label: "MiniMax M2.5 高速", contextWindow: 204_800, maxOutput: 16_384, tier: "fast" },
      { id: "MiniMax-M2.5",           label: "MiniMax M2.5",      contextWindow: 204_800, maxOutput: 16_384, tier: "mid" },
      { id: "MiniMax-M2.1-highspeed", label: "MiniMax M2.1 高速", contextWindow: 204_800, maxOutput: 16_384, tier: "fast" },
      { id: "MiniMax-M2.1",           label: "MiniMax M2.1",      contextWindow: 204_800, maxOutput: 16_384, tier: "mid" },
      { id: "MiniMax-M2",             label: "MiniMax M2",        contextWindow: 204_800, maxOutput: 128_000, tier: "mid" },
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
    protocol: "openai-chat",
    modes: {
      "coding-plan": {
        label: "Kimi Coding Plan",
        baseUrl: "https://api.moonshot.ai/v1",
        planUrl: "https://platform.moonshot.ai/",
        recommendedModel: "kimi-k2.6",
      },
      "api": {
        label: "按量付费 API",
        baseUrl: "https://api.moonshot.ai/v1",
        recommendedModel: "kimi-k2.6",
      },
    },
    defaultMode: "coding-plan",
    auth: { headerName: "Authorization", scheme: "bearer" },
    models: [
      { id: "kimi-k2.6", label: "Kimi K2.6", contextWindow: 256_000, maxOutput: 32_768, tier: "high", isDefault: true },
      { id: "kimi-k2.5", label: "Kimi K2.5", contextWindow: 256_000, maxOutput: 32_768, tier: "high" },
    ],
    defaultModel: "kimi-k2.6",
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
        recommendedModel: "qwen3.6-plus",
      },
      "api": {
        label: "按量付费 API",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        recommendedModel: "qwen3.6-flash",
      },
    },
    defaultMode: "coding-plan",
    auth: { headerName: "Authorization", scheme: "bearer" },
    models: [
      { id: "qwen3.6-max-preview", label: "Qwen3.6 Max Preview", contextWindow: 1_000_000, maxOutput: 64_000, tier: "high" },
      { id: "qwen3-max",           label: "Qwen3 Max",           contextWindow: 1_000_000, maxOutput: 64_000, tier: "high" },
      { id: "qwen3.6-plus",      label: "Qwen3.6 Plus",      contextWindow: 1_000_000, maxOutput: 64_000, tier: "high", isDefault: true },
      { id: "qwen3.6-flash",     label: "Qwen3.6 Flash",     contextWindow: 1_000_000, maxOutput: 64_000, tier: "fast" },
      { id: "qwen3-coder-plus",  label: "Qwen3 Coder Plus",  contextWindow: 1_000_000, maxOutput: 65_536, tier: "high" },
      { id: "qwen3-coder-flash", label: "Qwen3 Coder Flash", contextWindow: 1_000_000, maxOutput: 32_768, tier: "fast" },
      { id: "qwen-max",          label: "Qwen Max",          contextWindow:    32_768, maxOutput:  8_192, tier: "high" },
      { id: "qwen-flash",        label: "Qwen Flash",        contextWindow:    32_768, maxOutput:  8_192, tier: "fast" },
    ],
    defaultModel: "qwen3.6-plus",
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
    models: [],
    defaultModel: "",
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
      { id: "gpt-5.5",        label: "GPT-5.5",        contextWindow: 1_000_000, maxOutput: 128_000, tier: "high", isDefault: true },
      { id: "gpt-5.4",        label: "GPT-5.4",        contextWindow: 1_000_000, maxOutput: 128_000, tier: "high" },
      { id: "gpt-5.4-mini",   label: "GPT-5.4 Mini",   contextWindow:   400_000, maxOutput: 128_000, tier: "fast" },
      { id: "gpt-5.4-nano",   label: "GPT-5.4 Nano",   contextWindow:   400_000, maxOutput: 128_000, tier: "fast" },
      { id: "gpt-5.2",        label: "GPT-5.2",        contextWindow: 1_000_000, maxOutput: 128_000, tier: "high" },
    ],
    defaultModel: "gpt-5.5",
  },

  "ollama": {
    id: "ollama",
    displayName: "Ollama（本机）",
    protocol: "openai-chat",
    modes: {
      "local": {
        label: "本机 Ollama",
        baseUrl: "http://localhost:11434/v1",
      },
    },
    defaultMode: "local",
    auth: { headerName: "", scheme: "raw" },
    apiKeyOptional: true,
    models: [
      { id: "llama3.2", label: "Llama 3.2（示例，需本机已安装）", contextWindow: 128_000, tier: "mid", isDefault: true },
    ],
    defaultModel: "llama3.2",
    quirks: {
      streamingTolerant: true,
    },
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
