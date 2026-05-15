// Adapter for the `anthropic-messages` protocol.
//
// Implements the Provider interface defined in ./provider.js. Used by:
//   - anthropic-official (uses x-api-key auth)
//   - deepseek, zhipu-glm, minimax, moonshot-kimi (all use Bearer auth
//     and the /anthropic-suffixed base URL convention)
//
// Wire format: standard Anthropic Messages API.
//   POST <baseUrl>/v1/messages
//   headers: <auth>, Content-Type: application/json, [anthropic-version]
//   body: { model, messages, system?, tools?, max_tokens, temperature?, stream? }
//
// All HTTP goes through an injected `requestImpl` so we can run on
// desktop, mobile, and in tests. Production callers pass Obsidian's
// `requestUrl`. Tests pass a fake.

const { parseSseStream } = require("./sse-parser");
const { resolveBaseUrl } = require("./registry");

const DEFAULT_VERSION_HEADER = "anthropic-version: 2026-01-01";
const DEFAULT_USER_AGENT = "FLOWnote (Obsidian)";

/**
 * Build the headers for an outgoing request based on provider spec +
 * user config.
 *
 * @param {import('./provider').ProviderConfig} spec
 * @param {import('./provider').ProviderUserConfig} userConfig
 * @returns {Object<string,string>}
 */
function buildHeaders(spec, userConfig) {
  /** @type {Object<string,string>} */
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": userConfig.userAgentOverride || DEFAULT_USER_AGENT,
  };

  // Auth: `x-api-key` (raw) for Anthropic native, `Authorization: Bearer`
  // for everyone else. Driven by spec.auth, not provider id.
  const authValue = spec.auth.scheme === "bearer"
    ? `Bearer ${userConfig.apiKey || ""}`
    : (userConfig.apiKey || "");
  if (spec.auth.headerName) {
    headers[spec.auth.headerName] = authValue;
  }

  // Anthropic-version header — required by Anthropic native, ignored
  // (or accepted) by Chinese providers' compat endpoints.
  const versionLine = userConfig.versionHeaderOverride || spec.versionHeader || DEFAULT_VERSION_HEADER;
  if (versionLine) {
    const [name, ...rest] = versionLine.split(":");
    const value = rest.join(":").trim();
    if (name && value) headers[name.trim()] = value;
  }

  return headers;
}

/**
 * Strip params that a given provider silently drops anyway. Keeps the
 * model from seeing parameters that the server will ignore, and avoids
 * confusing parameter-echo behavior. Spec quirks are the source of
 * truth.
 *
 * @template T
 * @param {T} body
 * @param {import('./provider').ProviderConfig} spec
 * @returns {T}
 */
function stripUnsupportedParams(body, spec) {
  if (!spec.quirks || !Array.isArray(spec.quirks.unsupportedParams)) return body;
  if (spec.quirks.unsupportedParams.length === 0) return body;
  const out = { ...body };
  for (const key of spec.quirks.unsupportedParams) {
    if (key in out) delete out[key];
  }
  return out;
}

/**
 * Translate Anthropic Messages API body from the canonical input we
 * receive. We accept the same shape we emit, so this is mostly a
 * normalization + param strip step.
 *
 * @param {import('./provider').CreateMessageInput} input
 * @param {import('./provider').ProviderConfig} spec
 * @returns {Object}
 */
function buildRequestBody(input, spec) {
  /** @type {Object} */
  const body = {
    model: input.model,
    messages: input.messages,
    max_tokens: input.maxTokens,
  };
  if (input.system) body.system = input.system;
  if (input.tools && input.tools.length > 0) body.tools = input.tools;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  return stripUnsupportedParams(body, spec);
}

/**
 * Normalize SSE { event, parsedData } records into the canonical
 * StreamEvent union. The Anthropic Messages SSE shape is already our
 * canonical shape — we just thread `parsedData` through, dropping
 * malformed records when running in tolerant mode.
 *
 * @param {AsyncIterable<{event: string, data: string, parsedData: any}>} parsed
 * @returns {AsyncGenerator<import('./provider').StreamEvent>}
 */
async function* normalizeStreamEvents(parsed) {
  for await (const ev of parsed) {
    if (!ev.parsedData) {
      // [DONE] sentinel or malformed-but-tolerated: skip.
      continue;
    }
    yield ev.parsedData;
  }
}

/**
 * Make the URL for the /v1/messages endpoint, given a baseUrl that
 * does NOT include /v1/messages.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function buildEndpointUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  return `${trimmed}/v1/messages`;
}

/**
 * Default request implementation — wraps Obsidian's `requestUrl`. Lazy
 * require so non-Obsidian test environments don't blow up at import.
 *
 * @returns {(args: {url, method, headers, body}) => Promise<{status, headers, body, arrayBuffer}>}
 */
function defaultRequestImpl() {
  // eslint-disable-next-line global-require
  const { requestUrl } = require("obsidian");
  return (args) => requestUrl({
    url: args.url,
    method: args.method,
    headers: args.headers,
    body: args.body,
    throw: false,
  });
}

/**
 * Factory: build a Provider bound to a spec + userConfig.
 *
 * @param {Object} args
 * @param {import('./provider').ProviderConfig} args.spec
 * @param {import('./provider').ProviderUserConfig} args.userConfig
 * @param {Function} [args.requestImpl] async (args) => response
 * @returns {import('./provider').Provider}
 */
function createAnthropicMessagesProvider({ spec, userConfig, requestImpl }) {
  if (!spec) throw new Error("createAnthropicMessagesProvider: spec is required");
  if (spec.protocol !== "anthropic-messages") {
    throw new Error(`createAnthropicMessagesProvider: spec.protocol must be anthropic-messages (got ${spec.protocol})`);
  }
  if (!userConfig || !userConfig.providerId) {
    throw new Error("createAnthropicMessagesProvider: userConfig.providerId is required");
  }
  const doRequest = typeof requestImpl === "function" ? requestImpl : null;

  function getRequest() {
    if (doRequest) return doRequest;
    return defaultRequestImpl();
  }

  /**
   * Stream events from the upstream SSE response.
   * @param {import('./provider').CreateMessageInput} input
   */
  async function* createMessage(input) {
    const baseUrl = resolveBaseUrl(spec, userConfig);
    const url = buildEndpointUrl(baseUrl);
    const headers = buildHeaders(spec, userConfig);
    const wantsStream = userConfig.stream !== false;
    const body = JSON.stringify({ ...buildRequestBody(input, spec), stream: wantsStream });

    const response = await getRequest()({ url, method: "POST", headers, body });
    const status = response && typeof response.status === "number" ? response.status : 0;
    if (status < 200 || status >= 300) {
      const text = response && typeof response.text === "function"
        ? await response.text()
        : (response && response.body) || "";
      const errorPayload = {
        type: "error",
        error: { type: `http_${status}`, message: typeof text === "string" ? text.slice(0, 500) : String(text) },
      };
      yield /** @type {any} */ (errorPayload);
      return;
    }

    if (!wantsStream) {
      // Non-streaming response: a single Anthropic message object.
      const data = await readResponseAsJson(response);
      yield { type: "message_start", message: data };
      if (Array.isArray(data && data.content)) {
        for (let i = 0; i < data.content.length; i++) {
          const block = data.content[i];
          yield { type: "content_block_start", index: i, content_block: block };
          yield { type: "content_block_stop", index: i };
        }
      }
      yield {
        type: "message_delta",
        delta: { stop_reason: data && data.stop_reason, stop_sequence: data && data.stop_sequence },
        usage: data && data.usage,
      };
      yield { type: "message_stop" };
      return;
    }

    const chunks = responseToChunks(response);
    const tolerant = !!(spec.quirks && spec.quirks.streamingTolerant);
    const parsed = parseSseStream(chunks, { tolerant });
    yield* normalizeStreamEvents(parsed);
  }

  /**
   * Send a minimal request to validate connectivity + credentials.
   */
  async function testConnection() {
    const started = Date.now();
    try {
      const out = [];
      for await (const ev of createMessage({
        model: userConfig.model || spec.defaultModel,
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        maxTokens: 16,
      })) {
        out.push(ev);
        if (ev && ev.type === "error") {
          return { ok: false, error: ev.error && ev.error.message, latencyMs: Date.now() - started };
        }
        if (ev && ev.type === "message_stop") break;
      }
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  }

  /**
   * Fetch the live model list. Anthropic native doesn't have a public
   * list endpoint, but the Chinese providers using this protocol
   * (DeepSeek, MiniMax, Moonshot) do — they expose `/v1/models` on
   * their OpenAI-compat sibling endpoint. We use `spec.modelsListEndpoint`
   * if defined, otherwise derive from the Anthropic-compat base URL by
   * stripping the trailing `/anthropic` and appending `/v1/models`.
   *
   * Throws "not supported" if neither path is available, so the settings
   * UI can fall back to the hardcoded registry list cleanly.
   */
  async function listModels() {
    let url = spec.modelsListEndpoint;
    if (!url) {
      const base = resolveBaseUrl(spec, userConfig).replace(/\/+$/, "");
      const stripped = base.replace(/\/anthropic$/, "");
      if (stripped === base) {
        throw new Error("listModels: provider does not advertise a model-list endpoint");
      }
      url = `${stripped}/v1/models`;
    }
    const headers = buildHeaders(spec, userConfig);
    // /v1/models is an OpenAI-shape endpoint — use Bearer auth even if
    // the spec was configured with x-api-key for the Messages endpoint.
    if (spec.auth.scheme !== "bearer") {
      delete headers[spec.auth.headerName];
      headers.Authorization = `Bearer ${userConfig.apiKey || ""}`;
    }
    const res = await requestImpl({ url, method: "GET", headers });
    const status = res && typeof res.status === "number" ? res.status : 0;
    if (status < 200 || status >= 300) {
      throw new Error(`listModels: ${status} from ${url}`);
    }
    let body = res && res.json;
    if (!body && res && typeof res.text === "string") {
      try { body = JSON.parse(res.text); } catch { body = null; }
    }
    const data = body && Array.isArray(body.data) ? body.data : [];
    /** @type {Array<{id: string, label: string}>} */
    const out = [];
    for (const m of data) {
      if (!m || typeof m.id !== "string" || !m.id) continue;
      out.push({ id: m.id, label: m.id });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  /**
   * Best-effort local token estimate. Anthropic exposes a server-side
   * counter but it's an extra round-trip; for v0.5.0 we approximate.
   *
   * @param {import('./provider').ProviderMessage[]} messages
   */
  async function countTokens(messages) {
    let chars = 0;
    let cjk = 0;
    for (const msg of messages || []) {
      for (const block of msg.content || []) {
        const text = block && block.type === "text" ? String(block.text || "") : JSON.stringify(block || "");
        for (const ch of text) {
          chars++;
          if (ch.charCodeAt(0) > 0x2E80) cjk++;
        }
      }
    }
    // Rough: 3.5 chars/token for CJK-heavy, 4 chars/token otherwise.
    const cjkRatio = chars === 0 ? 0 : cjk / chars;
    const divisor = 4 - cjkRatio * 0.5;
    return Math.ceil(chars / divisor);
  }

  return {
    id: spec.id,
    displayName: spec.displayName,
    spec,
    userConfig,
    createMessage,
    countTokens,
    testConnection,
    listModels,
  };
}

// ---------------------------------------------------------------------------
// Response helpers — written so they work for both Obsidian's requestUrl
// shape (synchronous .text / .arrayBuffer) and a generic fetch-style
// Response, since we want adapter tests to use whichever shape is easiest.
// ---------------------------------------------------------------------------

async function readResponseAsJson(response) {
  if (response && typeof response.json === "function") {
    try { return await response.json(); } catch { /* fall through */ }
  }
  if (response && typeof response.text === "function") {
    const text = await response.text();
    try { return JSON.parse(text); } catch { return null; }
  }
  if (response && typeof response.body === "string") {
    try { return JSON.parse(response.body); } catch { return null; }
  }
  if (response && response.json) return response.json; // Obsidian convenience
  return null;
}

/**
 * Convert a request response into an AsyncIterable<string> of body chunks.
 *
 * For Obsidian's `requestUrl` (non-streaming), the entire body lands in
 * `response.text` or `response.body`. We split it into pseudo-chunks so the
 * SSE parser is happy. Once we wire up real streaming we'll branch here on
 * whether `response.body` is a ReadableStream-like object.
 *
 * @param {*} response
 * @returns {AsyncIterable<string>}
 */
function responseToChunks(response) {
  return (async function* () {
    if (response && response.body && typeof response.body[Symbol.asyncIterator] === "function") {
      for await (const chunk of response.body) {
        yield typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      }
      return;
    }
    let text = "";
    if (response && typeof response.text === "function") {
      text = await response.text();
    } else if (response && typeof response.body === "string") {
      text = response.body;
    } else if (response && typeof response.body === "object" && response.body !== null && typeof response.body.toString === "function") {
      text = response.body.toString();
    } else if (response && typeof response.text === "string") {
      text = response.text;
    }
    if (text) yield text;
  })();
}

module.exports = {
  createAnthropicMessagesProvider,
  // Exported for tests:
  buildHeaders,
  buildRequestBody,
  buildEndpointUrl,
  stripUnsupportedParams,
};
