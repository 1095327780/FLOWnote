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
    cacheReported: true,
    reasoningReported: true,
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


test("DeepSeek native cache and Anthropic cache billing are normalized without double counting", () => {
  const native = createDirectUsageAccumulator();
  native.observe({usage: {prompt_tokens:10000, completion_tokens:100, prompt_cache_hit_tokens:9000, prompt_cache_miss_tokens:1000}});
  native.completeTurn();
  assert.equal(native.snapshot().inputTokens,10000);
  assert.equal(native.snapshot().cachedInputTokens,9000);
  assert.equal(native.snapshot().totalTokens,10100);
  const anthropic = createDirectUsageAccumulator();
  anthropic.observe({type:"message_start",message:{usage:{input_tokens:1000,cache_read_input_tokens:9000,cache_creation_input_tokens:500,output_tokens:0}}});
  anthropic.observe({type:"message_delta",usage:{output_tokens:100}});
  anthropic.observe({type:"message_delta",usage:{output_tokens:100}});
  anthropic.completeTurn();
  assert.equal(anthropic.snapshot().inputTokens,10500);
  assert.equal(anthropic.snapshot().totalTokens,10600);
  assert.equal(anthropic.requestCount(),1);
});

test("stats distinguish unreported cache from known zero and label reasoning as output subset", () => {
  const unknown = responseStatsItems({requestCount:2,usage:{inputTokens:100,outputTokens:50}},"zh-CN");
  assert.ok(unknown.includes("缓存未报告"));
  const known = responseStatsItems({usage:{inputTokens:100,outputTokens:50,cacheReported:true,cachedInputTokens:0,reasoningTokens:30}},"zh-CN");
  assert.ok(known.includes("缓存命中 0"));
  assert.ok(known.includes("其中思考 30"));
});
