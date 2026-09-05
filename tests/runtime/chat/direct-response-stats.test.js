const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDirectUsageAccumulator,
  compactTokenCount,
  responseStatsItems,
} = require("../../../runtime/chat/direct-response-stats");

test("direct usage accumulator sums provider snapshots once per model turn", () => {
  const usage = createDirectUsageAccumulator();
  usage.observe({ type: "message_start", message: { usage: { input_tokens: 1200 } } });
  usage.observe({ type: "message_delta", usage: { output_tokens: 80 } });
  usage.observe({ type: "message_delta", usage: { output_tokens: 120 } });
  usage.completeTurn();
  usage.observe({ type: "message_delta", usage: {
    prompt_tokens: 1500,
    completion_tokens: 200,
    total_tokens: 1700,
    prompt_tokens_details: { cached_tokens: 500 },
    completion_tokens_details: { reasoning_tokens: 40 },
  } });
  usage.completeTurn();

  assert.deepEqual(usage.snapshot(), {
    inputTokens: 2700,
    outputTokens: 320,
    totalTokens: 3020,
    cachedInputTokens: 500,
    reasoningTokens: 40,
  });
});

test("response stats stay compact and omit unavailable values", () => {
  assert.equal(compactTokenCount(999), "999");
  assert.equal(compactTokenCount(12400), "12.4k");
  assert.deepEqual(responseStatsItems({
    modelLabel: "DeepSeek V4 Flash",
    toolCount: 4,
    usage: { totalTokens: 12400 },
  }, "zh-CN"), ["DeepSeek V4 Flash", "4 次工具", "12.4k tokens"]);
  assert.deepEqual(responseStatsItems({ modelLabel: "Kimi K3", toolCount: 0 }, "en"), ["Kimi K3"]);
});
