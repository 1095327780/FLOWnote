const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractAssistantPayloadFromEnvelope,
  hasTerminalPayload,
  normalizeMarkdownForDisplay,
  chooseRicherResponse,
} = require("../../runtime/assistant-payload-utils");

test("normalizeMarkdownForDisplay should trim noisy spacing", () => {
  const input = "  hello  \n\n\n- a\n\n- b  ";
  const out = normalizeMarkdownForDisplay(input);
  assert.equal(out, "hello\n- a\n- b");
});

test("extractAssistantPayloadFromEnvelope should collect text and reasoning", () => {
  const payload = extractAssistantPayloadFromEnvelope({
    info: { role: "assistant" },
    parts: [
      { type: "text", text: "结果内容" },
      { type: "reasoning", text: "推理片段" },
    ],
  });

  assert.equal(payload.text, "结果内容");
  assert.equal(payload.reasoning, "推理片段");
  assert.ok(Array.isArray(payload.blocks));
  assert.equal(payload.blocks.length, 1);
  assert.equal(payload.blocks[0].type, "reasoning");
});

test("chooseRicherResponse should keep terminal content over in-progress payload", () => {
  const terminal = {
    messageId: "m1",
    text: "最终回答",
    reasoning: "",
    meta: "",
    blocks: [{ type: "step-finish", summary: "done" }],
  };
  const inProgress = {
    messageId: "m1",
    text: "",
    reasoning: "thinking",
    meta: "",
    blocks: [{ type: "tool", summary: "tool" }, { type: "step-finish", summary: "tool-calls" }],
  };

  const picked = chooseRicherResponse(inProgress, terminal);
  assert.equal(picked.text, "最终回答");
  assert.equal(hasTerminalPayload(picked), true);
});
