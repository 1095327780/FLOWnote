const test = require("node:test");
const assert = require("node:assert/strict");

const { prepareContextWindow } = require("../../../runtime/agent/context-budget-manager");
const { validateContinuationCheckpoint } = require("../../../runtime/agent/continuation-checkpoint");

function provider(contextWindow = 10_000) {
  return {
    spec: { models: [{ id: "test-model", contextWindow, maxOutput: 4_000 }] },
    async countTokens(messages) {
      return Math.ceil(JSON.stringify(messages).length / 4);
    },
  };
}

test("small conversations keep their exact messages and requested model output budget", async () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const result = await prepareContextWindow({
    provider: provider(),
    model: "test-model",
    system: "system",
    tools: [],
    conversation: messages,
    requestedMaxTokens: 4_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.compacted, false);
  assert.equal(result.maxTokens, 4_000);
  assert.deepEqual(result.messages, messages);
});

test("long completed history compacts before the provider call while preserving recent work and tool boundaries", async () => {
  const oldPayload = "x".repeat(28_000);
  const messages = [
    { role: "user", content: [{ type: "text", text: "old request" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "vault_read", input: { path: "A.md", noise: oldPayload } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: oldPayload }] },
    { role: "assistant", content: [{ type: "text", text: oldPayload }] },
    { role: "user", content: [{ type: "text", text: "RECENT_MARKER" }] },
    { role: "assistant", content: [{ type: "text", text: "working" }] },
  ];
  const result = await prepareContextWindow({
    provider: provider(),
    model: "test-model",
    system: "system",
    tools: [{ name: "vault_read", description: "read", input_schema: { type: "object" } }],
    conversation: messages,
    requestedMaxTokens: 4_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.ok(result.maxTokens >= 256);
  assert.match(JSON.stringify(result.messages), /RECENT_MARKER/);
  assert.ok(JSON.stringify(result.messages).length < JSON.stringify(messages).length / 3);
  assert.equal(validateContinuationCheckpoint({
    version: 1,
    messages: result.messages,
    effectReceipts: [],
    contract: null,
    completionRetries: 0,
    turns: 1,
  }).ok, true);
});

test("an oversized current turn fails before calling the provider instead of sending an invalid request", async () => {
  const result = await prepareContextWindow({
    provider: provider(4_000),
    model: "test-model",
    system: "system",
    tools: [],
    conversation: [{ role: "user", content: [{ type: "text", text: "z".repeat(40_000) }] }],
    requestedMaxTokens: 2_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONTEXT_WINDOW_EXCEEDED");
});
