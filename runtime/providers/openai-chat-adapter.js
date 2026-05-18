// Adapter for the `openai-chat` protocol (OpenAI Chat Completions).
//
// Used by OpenAI native, Qwen (DashScope), Doubao (ARK), and any
// custom OpenAI-compat base URL.
//
// Translates the agent loop's canonical Anthropic Messages shape to/
// from OpenAI Chat Completions on the wire, and emits normalized
// Anthropic-shape StreamEvents downstream so the rest of the runtime
// doesn't care which protocol the user picked.
//
// HTTP goes through an injected requestImpl, same pattern as the
// anthropic-messages adapter.

const { parseSseStream } = require("./sse-parser");
const { streamingFetch } = require("./streaming-fetch");
const { resolveBaseUrl } = require("./registry");

const DEFAULT_USER_AGENT = "FLOWnote (Obsidian)";

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

function buildHeaders(spec, userConfig) {
  /** @type {Object<string,string>} */
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": userConfig.userAgentOverride || DEFAULT_USER_AGENT,
  };
  const authValue = spec.auth.scheme === "bearer"
    ? `Bearer ${userConfig.apiKey || ""}`
    : (userConfig.apiKey || "");
  if (spec.auth.headerName) {
    headers[spec.auth.headerName] = authValue;
  }
  return headers;
}

/**
 * Build the /chat/completions endpoint URL.
 * Convention: baseUrl is the prefix INCLUDING the version segment
 * (e.g. .../v1) — OpenAI's standard. We append "/chat/completions".
 */
function buildEndpointUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  return `${trimmed}/chat/completions`;
}

function flattenTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => String(b.text || ""))
    .join("");
}

/**
 * Translate the canonical Anthropic Messages body into an OpenAI Chat
 * Completions body.
 *
 * - `system` (string|blocks) is prepended as messages[0] with role=system
 * - Each user/assistant message with content blocks is split into:
 *     - assistant tool_use blocks → assistant message with tool_calls
 *     - user tool_result blocks → role=tool messages keyed by tool_call_id
 *     - text blocks → role=user|assistant with content string
 * - tools schema is translated to tools[].function form
 *
 * @param {Object} input  CreateMessageInput
 * @param {Object} spec   ProviderConfig
 */
function buildRequestBody(input, spec) {
  /** @type {Array<Object>} */
  const messages = [];

  if (input.system) {
    const sysText = typeof input.system === "string" ? input.system : flattenTextContent(input.system);
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  for (const msg of input.messages || []) {
    if (msg.role === "assistant") {
      // Assistant may have text + tool_use blocks. OpenAI: one message
      // with content + tool_calls (function calls).
      const text = flattenTextContent(msg.content);
      const toolUses = (Array.isArray(msg.content) ? msg.content : []).filter((b) => b && b.type === "tool_use");
      const out = { role: "assistant" };
      if (text) out.content = text;
      if (toolUses.length > 0) {
        out.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input || {}),
          },
        }));
      }
      // OpenAI requires either content or tool_calls; if neither, skip.
      if (out.content !== undefined || out.tool_calls) {
        messages.push(out);
      }
    } else if (msg.role === "user") {
      // User may have text and/or tool_result blocks. Tool results
      // become separate role=tool messages in OpenAI.
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const toolResults = blocks.filter((b) => b && b.type === "tool_result");
      const textBits = blocks.filter((b) => b && b.type === "text");
      if (textBits.length > 0 || typeof msg.content === "string") {
        const text = typeof msg.content === "string"
          ? msg.content
          : textBits.map((b) => b.text || "").join("");
        if (text) messages.push({ role: "user", content: text });
      }
      for (const tr of toolResults) {
        const trText = typeof tr.content === "string"
          ? tr.content
          : flattenTextContent(tr.content);
        messages.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: trText || (tr.is_error ? "[error]" : ""),
        });
      }
    }
  }

  /** @type {Object} */
  const body = {
    model: input.model,
    messages,
    max_tokens: input.maxTokens,
  };
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (Array.isArray(input.tools) && input.tools.length > 0) {
    body.tools = input.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }
  // Strip provider quirks (kept for parity with the anthropic adapter).
  if (spec && spec.quirks && Array.isArray(spec.quirks.unsupportedParams)) {
    for (const key of spec.quirks.unsupportedParams) {
      if (key in body) delete body[key];
    }
  }
  return body;
}

/**
 * Translate an OpenAI streaming chunk into one-or-more Anthropic
 * StreamEvents. Maintains state in `state` so callers can carry it
 * across chunks.
 *
 * State shape:
 *   {
 *     started:        boolean   // emitted message_start?
 *     textStarted:    boolean   // emitted content_block_start for index 0?
 *     textIndex:      number    // index of the text block (always 0 when present)
 *     toolCalls:      { [openaiIndex]: { id, name, argsBuffer, anthropicIndex } }
 *     nextIndex:      number    // next assistant block index to assign
 *     stopReason:     string | null
 *   }
 */
function* translateOpenAIChunk(chunk, state) {
  if (!chunk || typeof chunk !== "object") return;
  if (!state.started) {
    state.started = true;
    yield { type: "message_start", message: { id: chunk.id || "openai-msg" } };
  }
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const choice of choices) {
    if (choice.finish_reason) {
      // Close any open blocks before emitting message_delta.
      if (state.textStarted) {
        yield { type: "content_block_stop", index: state.textIndex };
        state.textStarted = false;
      }
      for (const k of Object.keys(state.toolCalls || {})) {
        const tc = state.toolCalls[k];
        try { tc.input = JSON.parse(tc.argsBuffer || "{}"); } catch { tc.input = {}; }
        yield {
          type: "content_block_stop",
          index: tc.anthropicIndex,
        };
      }
      state.stopReason = mapOpenAIFinishReason(choice.finish_reason);
      yield {
        type: "message_delta",
        delta: { stop_reason: state.stopReason },
        usage: chunk.usage,
      };
      yield { type: "message_stop" };
      continue;
    }
    const delta = choice.delta || {};
    // Text content
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!state.textStarted) {
        state.textIndex = state.nextIndex;
        state.nextIndex += 1;
        state.textStarted = true;
        yield {
          type: "content_block_start",
          index: state.textIndex,
          content_block: { type: "text", text: "" },
        };
      }
      yield {
        type: "content_block_delta",
        index: state.textIndex,
        delta: { type: "text_delta", text: delta.content },
      };
    }
    // Tool calls
    if (Array.isArray(delta.tool_calls)) {
      for (const tcDelta of delta.tool_calls) {
        const oi = typeof tcDelta.index === "number" ? tcDelta.index : 0;
        let tc = state.toolCalls[oi];
        if (!tc) {
          tc = {
            id: tcDelta.id || `call-${oi}`,
            name: (tcDelta.function && tcDelta.function.name) || "",
            argsBuffer: "",
            anthropicIndex: state.nextIndex,
          };
          state.toolCalls[oi] = tc;
          state.nextIndex += 1;
          yield {
            type: "content_block_start",
            index: tc.anthropicIndex,
            content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
          };
        }
        // Subsequent partial-name updates (rare but possible)
        if (tcDelta.function && typeof tcDelta.function.name === "string" && !tc.name) {
          tc.name = tcDelta.function.name;
        }
        if (tcDelta.function && typeof tcDelta.function.arguments === "string") {
          tc.argsBuffer += tcDelta.function.arguments;
          yield {
            type: "content_block_delta",
            index: tc.anthropicIndex,
            delta: { type: "input_json_delta", partial_json: tcDelta.function.arguments },
          };
        }
      }
    }
  }
}

function mapOpenAIFinishReason(reason) {
  if (reason === "stop") return "end_turn";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "content_filter";
  return reason || "end_turn";
}

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
  if (response && response.json) return response.json;
  return null;
}

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
    } else if (response && typeof response.text === "string") {
      text = response.text;
    }
    if (text) yield text;
  })();
}

/**
 * Factory: OpenAI-chat Provider.
 *
 * @param {Object} args
 * @param {import('./provider').ProviderConfig} args.spec
 * @param {import('./provider').ProviderUserConfig} args.userConfig
 * @param {Function} [args.requestImpl]
 * @returns {import('./provider').Provider}
 */
function createOpenAIChatProvider({ spec, userConfig, requestImpl }) {
  if (!spec) throw new Error("createOpenAIChatProvider: spec is required");
  if (spec.protocol !== "openai-chat") {
    throw new Error(`createOpenAIChatProvider: spec.protocol must be openai-chat (got ${spec.protocol})`);
  }
  if (!userConfig || !userConfig.providerId) {
    throw new Error("createOpenAIChatProvider: userConfig.providerId is required");
  }
  const doRequest = typeof requestImpl === "function" ? requestImpl : null;
  function getRequest() {
    return doRequest || defaultRequestImpl();
  }

  async function* createMessage(input) {
    const baseUrl = resolveBaseUrl(spec, userConfig);
    const url = buildEndpointUrl(baseUrl);
    const headers = buildHeaders(spec, userConfig);
    const wantsStream = userConfig.stream !== false;
    const body = JSON.stringify({ ...buildRequestBody(input, spec), stream: wantsStream });

    // Streaming path: go through fetch() so we can read the body as a
    // ReadableStream. requestUrl buffers the entire response which kills
    // live token output. fetch is subject to CORS but most OpenAI-shaped
    // APIs (OpenAI, DeepSeek, Moonshot, Zhipu, Groq, …) expose CORS
    // headers. If fetch fails we fall back to the buffered path so the
    // chat still completes — just without live streaming.
    let response;
    if (wantsStream && !doRequest) {
      try {
        response = await streamingFetch({ url, method: "POST", headers, body, signal: input && input.signal });
      } catch (e) {
        response = await getRequest()({ url, method: "POST", headers, body });
      }
    } else {
      response = await getRequest()({ url, method: "POST", headers, body });
    }
    const status = response && typeof response.status === "number" ? response.status : 0;
    if (status < 200 || status >= 300) {
      const text = response && typeof response.text === "function"
        ? await response.text()
        : (response && response.body) || "";
      yield {
        type: "error",
        error: { type: `http_${status}`, message: typeof text === "string" ? text.slice(0, 500) : String(text) },
      };
      return;
    }

    if (!wantsStream) {
      const data = await readResponseAsJson(response);
      const message = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
      yield { type: "message_start", message: { id: data && data.id } };
      let idx = 0;
      if (typeof message.content === "string" && message.content) {
        yield { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } };
        yield {
          type: "content_block_delta",
          index: idx,
          delta: { type: "text_delta", text: message.content },
        };
        yield { type: "content_block_stop", index: idx };
        idx += 1;
      }
      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          yield {
            type: "content_block_start",
            index: idx,
            content_block: {
              type: "tool_use",
              id: tc.id,
              name: tc.function && tc.function.name,
              input: safeJsonParse(tc.function && tc.function.arguments),
            },
          };
          yield { type: "content_block_stop", index: idx };
          idx += 1;
        }
      }
      const stopReason = mapOpenAIFinishReason(data && data.choices && data.choices[0] && data.choices[0].finish_reason);
      yield {
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: data && data.usage,
      };
      yield { type: "message_stop" };
      return;
    }

    const tolerant = !!(spec.quirks && spec.quirks.streamingTolerant);
    const sseEvents = parseSseStream(responseToChunks(response), { tolerant });
    /** @type {Object} */
    const state = { started: false, textStarted: false, textIndex: 0, toolCalls: {}, nextIndex: 0, stopReason: null };
    for await (const ev of sseEvents) {
      if (!ev.parsedData) continue;
      for (const out of translateOpenAIChunk(ev.parsedData, state)) {
        yield out;
      }
    }
  }

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
   * Fetch the live model list from <baseUrl>/models (OpenAI convention
   * — every OpenAI-compat provider exposes it). Returns an array of
   * { id, label } objects ready to merge into the dropdown.
   *
   * Throws on transport / auth errors so the settings UI can surface
   * the failure rather than silently falling back to the registry.
   */
  async function listModels() {
    const url = `${resolveBaseUrl(spec, userConfig).replace(/\/+$/, "")}/models`;
    const res = await requestImpl({
      url,
      method: "GET",
      headers: buildHeaders(spec, userConfig),
    });
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

function safeJsonParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = {
  createOpenAIChatProvider,
  // Exported for tests:
  buildRequestBody,
  buildHeaders,
  buildEndpointUrl,
  translateOpenAIChunk,
  mapOpenAIFinishReason,
};
