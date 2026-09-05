// Provider-neutral prompt budgeting for long-running direct workflows.
//
// The model catalog owns the real context/output limits. We preserve recent
// turns and protocol boundaries, compact only completed historical turns, and
// reduce the requested output only when retained context leaves no other safe
// option. No arbitrary turn-count ceiling is involved.

const DEFAULT_SAFETY_TOKENS = 1024;
const MAX_SAFETY_TOKENS = 8192;
const MIN_OUTPUT_TOKENS = 256;
const RECENT_MESSAGES = 8;

async function prepareContextWindow({ provider, model, system, tools, conversation, requestedMaxTokens } = {}) {
  const source = cloneJson(Array.isArray(conversation) ? conversation : []);
  const contextWindow = resolveContextWindow(provider, model);
  const requested = Math.max(MIN_OUTPUT_TOKENS, Math.floor(Number(requestedMaxTokens) || MIN_OUTPUT_TOKENS));
  if (!contextWindow) {
    return { ok: true, messages: source, maxTokens: requested, compacted: false, promptTokens: null, contextWindow: null };
  }

  const safety = Math.min(MAX_SAFETY_TOKENS, Math.max(DEFAULT_SAFETY_TOKENS, Math.ceil(contextWindow * 0.01)));
  const targetPromptTokens = Math.max(2048, contextWindow - Math.min(requested, contextWindow - safety) - safety);
  let messages = source;
  let promptTokens = await countPromptTokens(provider, system, tools, messages);
  let compacted = false;

  if (promptTokens > targetPromptTokens) {
    messages = compactHistoricalMessages(messages, RECENT_MESSAGES, false);
    compacted = true;
    promptTokens = await countPromptTokens(provider, system, tools, messages);
  }
  if (promptTokens > targetPromptTokens) {
    messages = dropCompletedHistoryPrefix(messages, RECENT_MESSAGES);
    promptTokens = await countPromptTokens(provider, system, tools, messages);
  }
  if (promptTokens > targetPromptTokens) {
    // The newest user turn remains exact; every completed turn before it may
    // be reduced to a protocol-safe deterministic recap.
    messages = compactHistoricalMessages(messages, 1, true);
    promptTokens = await countPromptTokens(provider, system, tools, messages);
  }

  const availableOutput = Math.floor(contextWindow - safety - promptTokens);
  if (availableOutput < MIN_OUTPUT_TOKENS) {
    return {
      ok: false,
      error: {
        type: "context_window_exceeded",
        code: "CONTEXT_WINDOW_EXCEEDED",
        message: "The current request and required protocol state exceed this model's context window.",
      },
      messages,
      maxTokens: 0,
      compacted,
      promptTokens,
      contextWindow,
    };
  }
  return {
    ok: true,
    messages,
    maxTokens: Math.min(requested, availableOutput),
    compacted,
    promptTokens,
    contextWindow,
  };
}

function resolveContextWindow(provider, model) {
  const models = provider && provider.spec && Array.isArray(provider.spec.models) ? provider.spec.models : [];
  const active = models.find((item) => item && item.id === model);
  const value = Number(active && active.contextWindow);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

async function countPromptTokens(provider, system, tools, messages) {
  const envelope = [];
  const systemText = typeof system === "string" ? system : JSON.stringify(system || "");
  if (systemText) envelope.push({ role: "user", content: [{ type: "text", text: systemText }] });
  if (Array.isArray(tools) && tools.length > 0) {
    envelope.push({ role: "user", content: [{ type: "text", text: JSON.stringify(tools) }] });
  }
  envelope.push(...cloneJson(messages));
  if (provider && typeof provider.countTokens === "function") {
    try {
      const value = Number(await provider.countTokens(envelope));
      if (Number.isFinite(value) && value >= 0) return Math.ceil(value);
    } catch (_error) { /* use the portable estimate */ }
  }
  return estimateTokens(envelope);
}

function estimateTokens(messages) {
  let chars = 0;
  for (const message of Array.isArray(messages) ? messages : []) chars += JSON.stringify(message || {}).length;
  return Math.ceil(chars / 3.5);
}

function compactHistoricalMessages(messages, keepRecent = RECENT_MESSAGES, aggressive = false) {
  const out = cloneJson(messages);
  const cutoff = Math.max(0, out.length - Math.max(0, keepRecent));
  for (let index = 0; index < cutoff; index += 1) {
    const message = out[index];
    message.content = (Array.isArray(message.content) ? message.content : []).map((block) => compactBlock(block, aggressive));
  }
  return out;
}

function compactBlock(block, aggressive) {
  if (!block || typeof block !== "object") return block;
  const textLimit = aggressive ? 160 : 640;
  if (block.type === "text") return { ...block, text: boundedText(block.text, textLimit, "historical text") };
  if (block.type === "tool_result") {
    return { ...block, content: boundedText(block.content, textLimit, "historical tool result") };
  }
  if (block.type === "tool_use") {
    return { ...block, input: compactToolInput(block.input, aggressive ? 96 : 256) };
  }
  return block;
}

function compactToolInput(value, limit) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, 12)) {
    if (typeof child === "string") out[key] = boundedText(child, limit, "tool input");
    else if (typeof child === "number" || typeof child === "boolean" || child === null) out[key] = child;
    else if (Array.isArray(child)) out[key] = child.slice(0, 8).map((item) => typeof item === "string" ? boundedText(item, 96, "list item") : item);
    else out[key] = "[historical object omitted]";
  }
  return out;
}

function boundedText(value, limit, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value === undefined ? "" : value);
  if (text.length <= limit) return text;
  const head = Math.max(1, Math.floor(limit * 0.7));
  const tail = Math.max(1, limit - head);
  return `${text.slice(0, head)}\n[FLOWNOTE_RECAP: ${label} omitted ${text.length - limit} chars]\n${text.slice(-tail)}`;
}

function dropCompletedHistoryPrefix(messages, keepRecent = RECENT_MESSAGES) {
  const source = cloneJson(messages);
  const maximumCut = Math.max(0, source.length - Math.max(1, keepRecent));
  let cut = 0;
  for (let index = maximumCut; index > 0; index -= 1) {
    const candidate = source[index];
    if (candidate && candidate.role === "user" && !hasToolResult(candidate)) { cut = index; break; }
  }
  if (cut === 0) return source;
  const removed = source.slice(0, cut);
  const toolNames = [...new Set(removed.flatMap((message) => (
    (Array.isArray(message.content) ? message.content : [])
      .filter((block) => block && block.type === "tool_use" && block.name)
      .map((block) => String(block.name))
  )))].slice(0, 20);
  const recap = {
    role: "user",
    content: [{
      type: "text",
      text: `[FLOWNOTE_CONTEXT_RECAP] ${removed.length} completed historical message(s) were compacted by the host.`
        + (toolNames.length ? ` Historical tools: ${toolNames.join(", ")}.` : "")
        + " Verified execution receipts and the active task contract remain in host state; do not infer unverified effects from this recap.",
    }],
  };
  return [recap, ...source.slice(cut)];
}

function hasToolResult(message) {
  return (Array.isArray(message && message.content) ? message.content : []).some((block) => block && block.type === "tool_result");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  prepareContextWindow,
  resolveContextWindow,
  countPromptTokens,
  compactHistoricalMessages,
  dropCompletedHistoryPrefix,
};
