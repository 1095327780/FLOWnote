function finiteTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

// Anthropic input_tokens excludes cache read/write tokens; OpenAI prompt_tokens includes them.
// Missing usage is kept distinct from an explicitly reported zero cache hit.
function normalizeUsage(rawUsage) {
  const u = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const prompt = u.prompt_tokens_details || u.input_tokens_details || {};
  const completion = u.completion_tokens_details || u.output_tokens_details || {};
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(u, key);
  const cached = u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? u.cached_input_tokens ?? prompt.cached_tokens;
  const cacheWrite = u.cache_creation_input_tokens;
  if (has("prompt_tokens")) out.inputTokens = finiteTokenCount(u.prompt_tokens);
  else if (has("input_tokens")) out.inputTokens = finiteTokenCount(u.input_tokens)
    + finiteTokenCount(u.cache_read_input_tokens) + finiteTokenCount(cacheWrite);
  if (has("output_tokens") || has("completion_tokens")) out.outputTokens = finiteTokenCount(u.output_tokens ?? u.completion_tokens);
  if (has("total_tokens")) out.totalTokens = finiteTokenCount(u.total_tokens);
  if (cached !== undefined) { out.cachedInputTokens = finiteTokenCount(cached); out.cacheReported = true; }
  if (cacheWrite !== undefined) out.cacheWriteInputTokens = finiteTokenCount(cacheWrite);
  const reasoning = u.reasoning_tokens ?? completion.reasoning_tokens;
  if (reasoning !== undefined) { out.reasoningTokens = finiteTokenCount(reasoning); out.reasoningReported = true; }
  return out;
}

function createEmptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
}

function addUsage(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "boolean") target[key] = !!target[key] || value;
    else target[key] = finiteTokenCount(target[key]) + finiteTokenCount(value);
  }
}

function createDirectUsageAccumulator() {
  const totals = createEmptyUsage();
  let current = createEmptyUsage();
  let reported = { input: false, output: false, cache: false, reasoning: false };
  let requests = 0;
  let active = false;
  const records = [];
  const observe = (event) => {
    if (!event || typeof event !== "object") return;
    const rawUsage = event.usage || (event.message && event.message.usage);
    if (!active && (event.type === "message_start" || rawUsage)) { requests++; active = true; }
    if (!rawUsage || typeof rawUsage !== "object") return;
    const normalized = normalizeUsage(rawUsage);
    if (normalized.inputTokens !== undefined) reported.input = true;
    if (normalized.outputTokens !== undefined) reported.output = true;
    if (normalized.cacheReported) reported.cache = true;
    if (normalized.reasoningReported) reported.reasoning = true;
    Object.assign(current, normalized);
  };
  const completeTurn = (metadata = {}) => {
    if (current.totalTokens <= 0) current.totalTokens = current.inputTokens + current.outputTokens;
    const record = active ? { ...metadata, requestIndex: requests - 1, ...current, reported: { ...reported } } : null;
    if (record) records.push(record);
    addUsage(totals, current);
    current = createEmptyUsage();
    reported = { input: false, output: false, cache: false, reasoning: false };
    active = false;
    return record;
  };
  const snapshot = () => {
    const out = { ...totals };
    const pending = { ...current };
    if (pending.totalTokens <= 0) pending.totalTokens = pending.inputTokens + pending.outputTokens;
    addUsage(out, pending);
    return out;
  };
  const snapshotReported = () => {
    const flags = [...records.map(record => record.reported), ...(active ? [reported] : [])];
    return { allInputReported: flags.length > 0 && flags.every(flag => flag.input),
      allOutputReported: flags.length > 0 && flags.every(flag => flag.output) };
  };
  return { observe, completeTurn, snapshot, snapshotReported, requestCount: () => requests, requests: () => records.map((record) => ({ ...record, reported: { ...record.reported } })) };
}

function compactTokenCount(value) {
  const count = finiteTokenCount(value);
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const valueInThousands = count / 1000;
    return `${valueInThousands >= 100 ? Math.round(valueInThousands) : valueInThousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const valueInMillions = count / 1_000_000;
  return `${valueInMillions >= 100 ? Math.round(valueInMillions) : valueInMillions.toFixed(1).replace(/\.0$/, "")}m`;
}

function responseStatsItems(stats, locale = "en") {
  const source = stats && typeof stats === "object" ? stats : {};
  const items = [];
  const modelLabel = String(source.modelLabel || source.modelId || "").trim();
  if (modelLabel) items.push(modelLabel);
  const toolCount = finiteTokenCount(source.toolCount);
  if (toolCount > 0) {
    items.push(String(locale || "").toLowerCase().startsWith("zh")
      ? `${toolCount} 次工具`
      : `${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  }
  const usage = source.usage && typeof source.usage === "object" ? source.usage : {};
  const reported = source.usageReported || null;
  const zh = String(locale).startsWith("zh");
  const requests = finiteTokenCount(source.requestCount);
  if (requests) items.push(zh ? `${requests} 次请求` : `${requests} requests`);
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    const display = (value, complete) => complete || !reported ? compactTokenCount(value)
      : value > 0 ? `≥${compactTokenCount(value)}` : zh ? "未报告" : "Unknown";
    items.push(`${zh ? "输入" : "Input"} ${display(usage.inputTokens, reported && reported.allInputReported)}`);
    items.push(`${zh ? "输出" : "Output"} ${display(usage.outputTokens, reported && reported.allOutputReported)}`);
    if (usage.cacheReported || usage.cachedInputTokens > 0) items.push(`${zh ? "缓存命中" : "Cached"} ${compactTokenCount(usage.cachedInputTokens)}`);
    else items.push(zh ? "缓存未报告" : "Cache not reported");
    if (usage.reasoningReported || usage.reasoningTokens > 0) items.push(`${zh ? "其中思考" : "Reasoning"} ${compactTokenCount(usage.reasoningTokens)}`);
  } else if (usage.totalTokens > 0) items.push(`${compactTokenCount(usage.totalTokens)} tokens`);
  else if (reported) items.push(zh ? "用量未报告" : "Usage not reported");
  const compactions = (source.contextRequests || []).filter((item) => item && item.compacted).length;
  if (compactions) items.push(zh ? `压缩 ${compactions} 次` : `${compactions} compactions`);
  return items;
}

module.exports = {
  createDirectUsageAccumulator,
  compactTokenCount,
  responseStatsItems,
};
