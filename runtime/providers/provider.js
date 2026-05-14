// Type contract for the provider abstraction. Pure JSDoc — no runtime
// code lives here. Every adapter (anthropic-messages, openai-chat,
// opencode-runtime) implements the Provider interface defined below.

/**
 * @typedef {Object} ModelInfo
 * @property {string} id              model identifier sent in the request body
 * @property {string} label           UI label
 * @property {number} [contextWindow] tokens; informational
 * @property {number} [maxOutput]     tokens; informational
 * @property {'fast'|'mid'|'high'} [tier]
 * @property {boolean} [deprecated]   if true, UI warns the user
 * @property {string} [deprecationDate] ISO date string when applicable
 * @property {boolean} [isDefault]    surface as default within this provider
 */

/**
 * @typedef {Object} ModeConfig
 * @property {string} label           shown in settings UI
 * @property {string} baseUrl         HTTP base URL for this mode
 * @property {string} [planUrl]       link to purchase/manage subscription
 * @property {string} [recommendedModel]
 */

/**
 * @typedef {Object} AuthConfig
 * @property {string} headerName      e.g. 'Authorization', 'x-api-key'
 * @property {'bearer'|'raw'} scheme  'bearer' formats as "Bearer <key>"; 'raw' uses the key verbatim
 */

/**
 * @typedef {Object} RegionConfig
 * @property {string} [cnUrl]         China-region base URL when provider has a split
 * @property {string} [intlUrl]       International base URL
 * @property {'cn'|'intl'} [defaultRegion]
 */

/**
 * @typedef {Object} ProviderQuirks
 * @property {string[]} [unsupportedParams] params silently dropped before request
 * @property {boolean}  [streamingTolerant] SSE parser ignores malformed/unknown events
 * @property {string}   [requestPathOverride] non-standard request path suffix
 */

/**
 * Static spec for a provider. Lives in registry.js. Combined with a
 * user-supplied ProviderUserConfig to instantiate a Provider via an adapter.
 *
 * @typedef {Object} ProviderConfig
 * @property {string} id
 * @property {string} displayName
 * @property {'anthropic-messages'|'openai-chat'|'opencode-runtime'} protocol
 * @property {Object<string, ModeConfig>} modes  keyed by mode id, e.g. 'coding-plan' | 'api'
 * @property {string} defaultMode                 mode id picked by default in UI
 * @property {AuthConfig} auth
 * @property {string}   [versionHeader]           full header line, e.g. 'anthropic-version: 2026-01-01'
 * @property {ModelInfo[]} models
 * @property {string} defaultModel                must match a model id in `models`
 * @property {RegionConfig} [region]
 * @property {ProviderQuirks} [quirks]
 * @property {boolean} [desktopOnly]              true for opencode-legacy
 * @property {boolean} [userMustProvideModels]    true for custom OpenAI-compat
 * @property {boolean} [userMustProvideBaseUrl]   true for custom OpenAI-compat
 */

/**
 * User-supplied settings for a chosen provider.
 *
 * @typedef {Object} ProviderUserConfig
 * @property {string} providerId
 * @property {string} mode                       must match a key in spec.modes
 * @property {'cn'|'intl'} [region]              for providers with a region split
 * @property {string} apiKey
 * @property {string} model                      model id; may be from spec.models[].id or user-supplied
 * @property {string} [baseUrlOverride]          advanced: override the mode's baseUrl
 * @property {string} [userAgentOverride]        advanced: override User-Agent header
 * @property {string} [versionHeaderOverride]    advanced: override anthropic-version (or similar)
 * @property {boolean} [stream]                  default true; pass false to force non-streaming
 */

/**
 * Content block in a message. Mirrors Anthropic Messages API shape — it is
 * our canonical internal representation. Non-Anthropic protocols translate
 * to/from this at the adapter boundary.
 *
 * @typedef {Object} TextBlock
 * @property {'text'} type
 * @property {string} text
 *
 * @typedef {Object} ToolUseBlock
 * @property {'tool_use'} type
 * @property {string} id
 * @property {string} name
 * @property {Object} input
 *
 * @typedef {Object} ToolResultBlock
 * @property {'tool_result'} type
 * @property {string} tool_use_id
 * @property {string | TextBlock[]} content
 * @property {boolean} [is_error]
 *
 * @typedef {TextBlock | ToolUseBlock | ToolResultBlock} ContentBlock
 */

/**
 * @typedef {Object} ProviderMessage
 * @property {'user'|'assistant'} role
 * @property {ContentBlock[]} content
 */

/**
 * Tool advertisement sent to the model. JSON Schema for input_schema.
 *
 * @typedef {Object} ToolSpec
 * @property {string} name
 * @property {string} description
 * @property {Object} input_schema
 */

/**
 * Input to provider.createMessage.
 *
 * @typedef {Object} CreateMessageInput
 * @property {string} model
 * @property {ProviderMessage[]} messages
 * @property {string | ContentBlock[]} [system]
 * @property {ToolSpec[]} [tools]
 * @property {number} maxTokens
 * @property {number} [temperature]
 * @property {AbortSignal} [signal]
 */

/**
 * Normalized streaming event. Mirrors Anthropic's Messages SSE event
 * union. OpenAI-chat adapter translates chat-completions chunks into
 * this shape so downstream code sees one event taxonomy.
 *
 * @typedef {Object} StreamEvent
 * @property {'message_start'|'content_block_start'|'content_block_delta'|
 *           'content_block_stop'|'message_delta'|'message_stop'|
 *           'error'|'ping'} type
 * @property {number} [index]
 * @property {ContentBlock} [content_block]
 * @property {Object} [delta]
 * @property {Object} [message]
 * @property {Object} [usage]
 * @property {Object} [error]
 */

/**
 * Result of a non-stream connection test.
 *
 * @typedef {Object} TestConnectionResult
 * @property {boolean} ok
 * @property {string} [error]
 * @property {number} latencyMs
 */

/**
 * The interface every adapter returns from its factory function.
 *
 * @typedef {Object} Provider
 * @property {string} id
 * @property {string} displayName
 * @property {ProviderConfig} spec
 * @property {ProviderUserConfig} userConfig
 *
 * @property {(input: CreateMessageInput) => AsyncIterable<StreamEvent>} createMessage
 *   Yields normalized StreamEvents until the model returns stop_reason.
 *
 * @property {(messages: ProviderMessage[]) => Promise<number>} countTokens
 *   Best-effort token count. May return a local estimate if the provider
 *   doesn't expose a counter.
 *
 * @property {() => Promise<TestConnectionResult>} testConnection
 *   Used by the Settings UI "Test" button. Sends one minimal request.
 */

module.exports = {
  // Empty export — this file is types-only. Importing the module marks
  // intent and keeps node --check happy.
};
