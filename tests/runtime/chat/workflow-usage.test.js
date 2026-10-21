const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveWorkflowUsageId, workflowUsageSummary } = require("../../../runtime/chat/workflow-usage");
const { meterProvider } = require("../../../runtime/chat/metered-provider");
const { createDirectUsageAccumulator } = require("../../../runtime/chat/direct-response-stats");
const { responseStatsItems } = require("../../../runtime/chat/direct-response-stats");

test("workflow continuity follows an exact host resume link, not adjacent chat text", () => {
  const storedMessages = [{ id: "first", stats: { runId: "first", workflowId: "s:first" } }];
  assert.equal(resolveWorkflowUsageId({ storedMessages, sessionId: "s", runId: "next", resumeFromRunId: "first" }), "s:first");
  assert.equal(resolveWorkflowUsageId({ storedMessages, sessionId: "s", runId: "new" }), "s:new");
});

test("workflow totals deduplicate requests and preserve unknown cache usage and partial responses", () => {
  const first = { runId: "a", workflowId: "s:a", requestIndex: 0, requestId: "a:0", inputTokens: 100, outputTokens: 10, cachedInputTokens: 80, cacheReported: true, responseComplete: true };
  const storedMessages = [{ stats: { runId: "a", workflowId: "s:a", requestUsage: [first] } },
    { stats: { runId: "a", workflowId: "s:a", requestUsage: [first] } },
    { stats: { runId: "other", workflowId: "s:other", requestUsage: [first] } }];
  const summary = workflowUsageSummary({ storedMessages, workflowId: "s:a", runId: "b", requests: [
    { requestIndex: 0, inputTokens: 200, outputTokens: 20, reasoningTokens: 10, responseComplete: false },
  ] });
  assert.equal(summary.totals.requestCount, 2);
  assert.equal(summary.totals.inputTokens, 300);
  assert.equal(summary.totals.outputTokens, 30);
  assert.equal(summary.totals.reasoningTokens, 10);
  assert.equal(summary.totals.unreportedCacheRequests, 1);
  assert.equal(summary.totals.incompleteResponses, 1);
  assert.equal(summary.requests[1].uncachedInputTokens, null);
});

test("meter records requested/reported models and wall time and awaits durable usage on failure", async () => {
  const usage = createDirectUsageAccumulator();
  let clock = 100;
  let saved;
  const metered = meterProvider({ id: "deepseek", userConfig: { model: "alias" }, async *createMessage() {
    yield { type: "message_start", message: { model: "actual-version", usage: { input_tokens: 9, cache_read_input_tokens: 3 } } };
    clock = 250;
    throw new Error("interrupted");
  } }, usage, { now: () => clock, onComplete: async record => { await Promise.resolve(); saved = record; } });
  await assert.rejects(async () => { for await (const event of metered.createMessage({})) {} }, /interrupted/);
  assert.equal(saved.requestedModel, "alias");
  assert.equal(saved.reportedModel, "actual-version");
  assert.equal(saved.durationMs, 150);
  assert.equal(saved.startedAt, 100);
  assert.equal(saved.responseComplete, false);
  assert.equal(saved.inputTokens, 12);
});

test("missing output and input fields remain unknown in request accounting and display", () => {
  const usage = createDirectUsageAccumulator();
  usage.observe({ type: "message_start", message: { usage: { input_tokens: 12 } } });
  usage.completeTurn();
  const reported = usage.snapshotReported();
  assert.equal(reported.allInputReported, true);
  assert.equal(reported.allOutputReported, false);
  const items = responseStatsItems({ requestCount: 1, usage: usage.snapshot(), usageReported: reported });
  assert.ok(items.includes("Output Unknown"));
  assert.equal(items.includes("Output 0"), false);
  const summary = workflowUsageSummary({ workflowId: "w", runId: "r", requests: [
    { requestIndex: 0, cachedInputTokens: 50, cacheReported: true, inputTokens: 0, reported: { input: false } },
  ] });
  assert.equal(summary.requests[0].uncachedInputTokens, null);
  assert.equal(summary.totals.unreportedInputRequests, 1);
});
