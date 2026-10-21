// Provider-neutral budgeting: preserve unique evidence and task contracts.
// Only exact duplicate read results may refer to a retained canonical result.
const MIN_OUTPUT_TOKENS = 256;
const ECONOMIC_TARGET_TOKENS = 64_000;
const DUPLICATE_MARKER = "[FLOWNOTE_DUPLICATE_RESULT canonical_tool_use_id=";
const DUPLICATE_SUFFIX = "] This read result is exactly identical to that retained tool_result. Use its full text there; do not re-read solely because of this reference.";
const READ_TOOLS = new Set(["vault_read", "vault_list", "vault_search", "vault_backlinks", "vault_tags", "vault_tasks", "web_fetch"]);
const MIN_DUPLICATE_CHARS = 1200;
const TOOL_RESULT_OVERHEAD_TOKENS = 1024;
const UNKNOWN_CONTEXT_RESULT_TOKENS = 32_768;

async function prepareContextWindow({ provider, model, system, tools, conversation, requestedMaxTokens } = {}) {
  const messages = cloneJson(Array.isArray(conversation) ? conversation : []);
  const contextWindow = resolveContextWindow(provider, model) || null;
  const requested = Math.max(MIN_OUTPUT_TOKENS, Math.floor(Number(requestedMaxTokens) || MIN_OUTPUT_TOKENS));
  const safety = safetyTokens(contextWindow);
  const hardPromptTarget = contextWindow
    ? Math.max(0, contextWindow - safety - requested)
    : null;
  const referenceError = validateDuplicateReferences(messages);
  const compacted = !referenceError && deduplicateReadResults(messages);
  const promptTokens = await countPromptTokens(provider, system, tools, messages);

  const availableOutput = contextWindow ? Math.floor(contextWindow - safety - promptTokens) : requested;
  const common = {
    messages, compacted, promptTokens, contextWindow, hardPromptTarget, safetyTokens: safety,
    economicTargetTokens: ECONOMIC_TARGET_TOKENS,
    overEconomicTarget: promptTokens > ECONOMIC_TARGET_TOKENS,
  };
  if (referenceError) {
    return { ...common, ok: false, maxTokens: 0, error: {
      type: "context_reference_missing", code: "CONTEXT_REFERENCE_MISSING",
      message: referenceError,
    } };
  }
  if (availableOutput < MIN_OUTPUT_TOKENS) {
    return {
      ...common, ok: false, maxTokens: 0,
      error: {
        type: "context_window_exceeded", code: "CONTEXT_WINDOW_EXCEEDED",
        message: "Required instructions or unique evidence exceed this model's context window. No unique content was discarded.",
      },
    };
  }
  return { ...common, ok: true, maxTokens: Math.min(requested, availableOutput) };
}

// Budget every not-yet-dispatched tool call from one shared hard window. The
// caller gives each execution its own ctx.toolResultBudgetTokens. Results from
// completed earlier batches are counted before allocating the next batch.
async function allocateToolResultBudgets({
  provider, model, system, tools, conversation, requestedMaxTokens, toolUses, completedResults = [],
} = {}) {
  const completed = Array.isArray(completedResults) ? completedResults : [];
  const completedIds = new Set(completed.map((result) => String(result && result.id || "")));
  const pending = (Array.isArray(toolUses) ? toolUses : [])
    .filter((use) => use && typeof use.id === "string" && use.id && !completedIds.has(use.id));
  const budgets = {};
  if (pending.length === 0) return budgets;
  const resultBlocks = completed.filter((result) => result && result.id).map((result) => ({
    type: "tool_result", tool_use_id: result.id,
    content: typeof result.content === "string" ? result.content : JSON.stringify(result.content == null ? "" : result.content),
    is_error: !!result.isError,
  }));
  const placeholders = pending.map((use) => ({ type: "tool_result", tool_use_id: use.id, content: "", is_error: false }));
  const baseConversation = Array.isArray(conversation) ? conversation : [];
  const withResults = [...baseConversation, { role: "user", content: [...resultBlocks, ...placeholders] }];
  const contextWindow = resolveContextWindow(provider, model);
  const reserve = TOOL_RESULT_OVERHEAD_TOKENS * pending.length;
  let available;
  if (contextWindow) {
    const requested = Math.max(MIN_OUTPUT_TOKENS, Math.floor(Number(requestedMaxTokens) || MIN_OUTPUT_TOKENS));
    const baseTokens = await countPromptTokens(provider, system, tools, withResults);
    available = contextWindow - safetyTokens(contextWindow) - requested - baseTokens - reserve;
  } else {
    // Unknown model window: a bounded total allowance for tool results, not
    // a claim about provider capacity. Charge completed results first.
    const withoutCompleted = [...baseConversation, { role: "user", content: placeholders }];
    const completedCost = Math.max(0,
      await countPromptTokens(provider, system, tools, withResults)
      - await countPromptTokens(provider, system, tools, withoutCompleted));
    available = UNKNOWN_CONTEXT_RESULT_TOKENS - completedCost - reserve;
  }
  const perCall = Math.max(0, Math.floor(available / pending.length));
  for (const use of pending) budgets[use.id] = perCall;
  return budgets;
}

function safetyTokens(contextWindow) {
  return contextWindow ? Math.min(8192, Math.max(1024, Math.ceil(contextWindow * 0.01))) : 0;
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
  if (Array.isArray(tools) && tools.length > 0) envelope.push({ role: "user", content: [{ type: "text", text: JSON.stringify(tools) }] });
  envelope.push(...messages);
  const floor = estimateTokens(envelope);
  if (provider && typeof provider.countTokens === "function") {
    try {
      const value = Number(await provider.countTokens(envelope));
      if (Number.isFinite(value) && value >= 0) return Math.max(Math.ceil(value), floor);
    } catch (_error) { /* use the portable estimate */ }
  }
  return floor;
}

function estimateTokens(messages) {
  let cjk = 0;
  let other = 0;
  let astral = 0;
  for (const character of JSON.stringify(messages || [])) {
    if (/[\u2e80-\u9fff\uf900-\ufaff]/u.test(character)) cjk += 1;
    else if (character.codePointAt(0) > 0xffff) astral += 1;
    else other += 1;
  }
  // Local provider estimators count Chinese almost like ASCII. This floor
  // keeps the trigger conservative without changing provider adapters.
  return Math.ceil(cjk * 1.5 + other / 3.5 + astral * 2);
}

function completedToolPairs(messages) {
  const pairs = [];
  for (let index = 0; index + 1 < messages.length; index += 1) {
    const assistant = messages[index];
    const resultMessage = messages[index + 1];
    if (!assistant || assistant.role !== "assistant" || !resultMessage || resultMessage.role !== "user") continue;
    const calls = (assistant.content || []).filter((block) => block && block.type === "tool_use");
    const results = (resultMessage.content || []).filter((block) => block && block.type === "tool_result");
    if (calls.length === 0 || calls.length !== results.length) continue;
    const ids = new Set(calls.map((block) => String(block.id || "")));
    if (ids.has("") || ids.size !== calls.length || !results.every((block) => ids.has(String(block.tool_use_id || "")))) continue;
    pairs.push(index);
  }
  return pairs;
}

function deduplicateReadResults(messages) {
  const canonicalByCall = new Map();
  let changed = false;
  for (const index of completedToolPairs(messages)) {
    const assistant = messages[index];
    const resultMessage = messages[index + 1];
    const calls = new Map(assistant.content
      .filter((block) => block && block.type === "tool_use")
      .map((block) => [block.id, block]));
    for (const result of resultMessage.content) {
      if (!result || result.type !== "tool_result" || result.is_error
        || typeof result.content !== "string" || result.content.length < MIN_DUPLICATE_CHARS
        || parseDuplicateReference(result.content) !== null) continue;
      const call = calls.get(result.tool_use_id);
      if (!call || !READ_TOOLS.has(call.name)) continue;
      const key = `${call.name}\n${stableJson(call.input || {})}`;
      const prior = canonicalByCall.get(key) || [];
      const same = prior.find((entry) => entry.content === result.content);
      if (same) {
        result.content = `${DUPLICATE_MARKER}${encodeURIComponent(same.id)}${DUPLICATE_SUFFIX}`;
        changed = true;
      } else {
        prior.push({ id: result.tool_use_id, content: result.content });
        canonicalByCall.set(key, prior);
      }
    }
  }
  return changed;
}

function validateDuplicateReferences(messages) {
  const fullResultIds = new Set();
  const references = [];
  for (const message of messages) {
    for (const block of Array.isArray(message && message.content) ? message.content : []) {
      if (!block || block.type !== "tool_result" || typeof block.content !== "string") continue;
      const referencedId = parseDuplicateReference(block.content);
      if (referencedId !== null) references.push(referencedId);
      else fullResultIds.add(String(block.tool_use_id || ""));
    }
  }
  const missing = references.find((id) => !fullResultIds.has(id));
  return missing ? "A duplicate-result reference has no retained canonical tool_result in this conversation." : "";
}

function parseDuplicateReference(content) {
  if (typeof content !== "string" || !content.startsWith(DUPLICATE_MARKER)
    || !content.endsWith(DUPLICATE_SUFFIX)) return null;
  const encoded = content.slice(DUPLICATE_MARKER.length, -DUPLICATE_SUFFIX.length);
  if (!encoded || encoded.includes("]")) return null;
  try {
    const decoded = decodeURIComponent(encoded);
    return encodeURIComponent(decoded) === encoded ? decoded : null;
  } catch (_error) { return null; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

module.exports = {
  prepareContextWindow, allocateToolResultBudgets, resolveContextWindow, countPromptTokens, completedToolPairs,
};
