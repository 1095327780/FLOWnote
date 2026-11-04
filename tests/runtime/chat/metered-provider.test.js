const test = require("node:test");
const assert = require("node:assert/strict");

const { meterProvider } = require("../../../runtime/chat/metered-provider");
const { createDirectUsageAccumulator } = require("../../../runtime/chat/direct-response-stats");

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("metered provider counts preflight and main requests once using cumulative usage snapshots", async () => {
  const usage = createDirectUsageAccumulator();
  const records = [];
  let phase = "contract";
  let calls = 0;
  const provider = {
    async *createMessage() {
      calls += 1;
      if (calls === 1) {
        yield { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } } };
        yield { type: "message_delta", usage: { output_tokens: 4 } };
        yield { type: "message_delta", usage: { output_tokens: 7 } };
      } else {
        yield { type: "message_start", message: { usage: { input_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } } };
        yield { type: "message_delta", usage: { output_tokens: 10 } };
      }
      yield { type: "message_stop" };
    },
  };
  const metered = meterProvider(provider, usage, {
    getPhase: () => phase,
    onComplete: (record) => records.push(record),
  });

  await collect(metered.createMessage({}));
  phase = "main";
  await collect(metered.createMessage({}));

  assert.equal(usage.requestCount(), 2);
  assert.deepEqual(records.map(({ phase: p, responseComplete, requestIndex }) => [p, responseComplete, requestIndex]), [
    ["contract", true, 0], ["main", true, 1],
  ]);
  assert.deepEqual(records.map((record) => [record.inputTokens, record.outputTokens, record.cachedInputTokens]), [
    [1050, 7, 900], [1000, 10, 800],
  ]);
  assert.equal(usage.snapshot().inputTokens, 2050);
  assert.equal(usage.snapshot().outputTokens, 17);
  assert.equal(usage.snapshot().totalTokens, 2067);
});

test("metered provider records observed usage and attempt on interruption and provider failure", async () => {
  const usage = createDirectUsageAccumulator();
  let calls = 0;
  const provider = {
    async *createMessage() {
      calls += 1;
      yield { type: "message_start", message: { usage: { input_tokens: calls * 100 } } };
      if (calls === 1) {
        yield { type: "message_delta", usage: { output_tokens: 3 } };
        throw new Error("read interrupted");
      }
      yield { type: "error", error: { type: "http_503", message: "unavailable" } };
    },
  };
  const metered = meterProvider(provider, usage, { getPhase: () => "contract" });

  await assert.rejects(() => collect(metered.createMessage({})), /read interrupted/);
  assert.deepEqual(await collect(metered.createMessage({})), [
    { type: "message_start", message: { usage: { input_tokens: 200 } } },
    { type: "error", error: { type: "http_503", message: "unavailable" } },
  ]);
  assert.deepEqual(usage.requests().map((record) => ({
    index: record.requestIndex,
    phase: record.phase,
    complete: record.responseComplete,
    input: record.inputTokens,
    output: record.outputTokens,
  })), [
    { index: 0, phase: "contract", complete: false, input: 100, output: 3 },
    { index: 1, phase: "contract", complete: false, input: 200, output: 0 },
  ]);
  assert.equal(usage.requestCount(), 2);
  assert.equal(usage.snapshot().totalTokens, 303);
});
