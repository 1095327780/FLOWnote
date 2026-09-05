function finiteTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeUsage(rawUsage) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details
    : {};
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details
    : {};
  return {
    inputTokens: finiteTokenCount(usage.input_tokens || usage.prompt_tokens),
    outputTokens: finiteTokenCount(usage.output_tokens || usage.completion_tokens),
    totalTokens: finiteTokenCount(usage.total_tokens),
    cachedInputTokens: finiteTokenCount(
      usage.cache_read_input_tokens
      || usage.cached_input_tokens
      || promptDetails.cached_tokens,
    ),
    reasoningTokens: finiteTokenCount(
      usage.reasoning_tokens
      || completionDetails.reasoning_tokens,
    ),
  };
}

function createEmptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
}

function addUsage(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += finiteTokenCount(source && source[key]);
  }
}

function createDirectUsageAccumulator() {
  const totals = createEmptyUsage();
  let current = createEmptyUsage();

  const observe = (event) => {
    if (!event || typeof event !== "object") return;
    const rawUsage = event.usage || (event.message && event.message.usage);
    if (!rawUsage || typeof rawUsage !== "object") return;
    const next = normalizeUsage(rawUsage);
    for (const key of Object.keys(current)) {
      if (next[key] > 0) current[key] = next[key];
    }
  };

  const completeTurn = () => {
    if (current.totalTokens <= 0) {
      current.totalTokens = current.inputTokens + current.outputTokens;
    }
    addUsage(totals, current);
    current = createEmptyUsage();
  };

  const snapshot = () => {
    const out = { ...totals };
    const pending = { ...current };
    if (pending.totalTokens <= 0) pending.totalTokens = pending.inputTokens + pending.outputTokens;
    addUsage(out, pending);
    return out;
  };

  return { observe, completeTurn, snapshot };
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
  const totalTokens = finiteTokenCount(usage.totalTokens);
  if (totalTokens > 0) items.push(`${compactTokenCount(totalTokens)} tokens`);
  return items;
}

module.exports = {
  createDirectUsageAccumulator,
  compactTokenCount,
  responseStatsItems,
};
