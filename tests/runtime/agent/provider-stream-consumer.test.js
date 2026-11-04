const test = require("node:test");
const assert = require("node:assert/strict");

const { consumeStream } = require("../../../runtime/agent/provider-stream-consumer");
const { runAgentLoop } = require("../../../runtime/agent/agent-loop");
const { buildTool, ToolRegistry } = require("../../../runtime/agent/tool-registry");

async function* events(items) {
  for (const item of items) yield item;
}

async function collect(stream) {
  const out = [];
  for await (const item of stream) out.push(item);
  return out;
}

const firstTurn = [
  { type: "message_start", message: { id: "first" } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private " } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "complete" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "sealed-payload" } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool-1", name: "lookup", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"key":"x"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
];

test("consumer retains complete thinking and signature while preserving redacted blocks", async () => {
  const result = await consumeStream(events(firstTurn));
  assert.equal(result.fatalError, null);
  assert.deepEqual(result.assistantContent[0], {
    type: "thinking", thinking: "private reasoning", signature: "sig-complete",
  });
  assert.deepEqual(result.assistantContent[1], { type: "redacted_thinking", data: "sealed-payload" });
  assert.deepEqual(result.toolUses, [{ type: "tool_use", id: "tool-1", name: "lookup", input: { key: "x" } }]);
});

test("tool continuation resends signed thinking without adding it to the user answer", async () => {
  const inputs = [];
  const provider = {
    id: "deepseek",
    spec: { id: "deepseek", defaultModel: "deepseek-v4-flash" },
    userConfig: { providerId: "deepseek", model: "deepseek-v4-flash" },
    async *createMessage(input) {
      inputs.push(input);
      yield* events(inputs.length === 1 ? firstTurn : [
        { type: "message_start", message: { id: "second" } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Public answer" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ]);
    },
    async countTokens() { return 0; },
  };
  const registry = new ToolRegistry();
  registry.register(buildTool({
    name: "lookup",
    description: "Read a value",
    inputSchema: { type: "object" },
    capabilities: () => ({ effect: "observation", risk: "low", concurrency: "parallel", presentation: "read", targets: [] }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute() { yield { type: "result", content: "found" }; },
  }));

  const output = await collect(runAgentLoop({
    provider,
    registry,
    messages: [{ role: "user", content: [{ type: "text", text: "Find x" }] }],
    maxTurns: 2,
  }));
  assert.ok(output.some((item) => item.type === "done"));
  assert.equal(inputs.length, 2);
  const priorAssistant = inputs[1].messages.find((message) => message.role === "assistant");
  assert.deepEqual(priorAssistant.content[0], {
    type: "thinking", thinking: "private reasoning", signature: "sig-complete",
  });
  assert.deepEqual(priorAssistant.content[1], { type: "redacted_thinking", data: "sealed-payload" });
  assert.deepEqual(priorAssistant.content[2], { type: "tool_use", id: "tool-1", name: "lookup", input: { key: "x" } });
  const userFacingText = output
    .filter((item) => item.type === "stream" && item.event && item.event.delta && item.event.delta.type === "text_delta")
    .map((item) => item.event.delta.text)
    .join("");
  assert.equal(userFacingText, "Public answer");
  assert.equal(userFacingText.includes("private reasoning"), false);
});
