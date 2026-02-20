const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractAssistantPayloadFromEnvelope,
  formatSessionStatusText,
  hasTerminalPayload,
  payloadLooksInProgress,
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

test("extractAssistantPayloadFromEnvelope should collapse snapshot-like reasoning updates", () => {
  const payload = extractAssistantPayloadFromEnvelope({
    info: { role: "assistant" },
    parts: [
      { type: "reasoning", id: "r1", text: "先做 A" },
      { type: "reasoning", id: "r1", text: "先做 A\n再做 B" },
      { type: "reasoning", id: "r2", text: "独立推理段" },
    ],
  });

  assert.equal(payload.reasoning, "先做 A\n再做 B\n\n独立推理段");
});

test("extractAssistantPayloadFromEnvelope should keep latest text snapshot for same part", () => {
  const payload = extractAssistantPayloadFromEnvelope({
    info: { role: "assistant" },
    parts: [
      { type: "text", id: "t1", text: "hello" },
      { type: "text", id: "t1", text: "hello world" },
    ],
  });

  assert.equal(payload.text, "hello world");
});

test("payloadLooksInProgress should be false for completed tool with final text", () => {
  const payload = {
    text: "最终回答",
    reasoning: "",
    meta: "",
    blocks: [
      { type: "tool", status: "completed", title: "search" },
    ],
  };
  assert.equal(payloadLooksInProgress(payload), false);
  assert.equal(hasTerminalPayload(payload), true);
});

test("payloadLooksInProgress should stay true for running tool without final text", () => {
  const payload = {
    text: "",
    reasoning: "",
    meta: "",
    blocks: [
      { type: "tool", status: "running", title: "search" },
      { type: "step-finish", summary: "tool-calls" },
    ],
  };
  assert.equal(payloadLooksInProgress(payload), true);
  assert.equal(hasTerminalPayload(payload), false);
});

test("extractAssistantPayloadFromEnvelope should append auth hint for 401 model errors", () => {
  const payload = extractAssistantPayloadFromEnvelope({
    info: {
      role: "assistant",
      error: {
        name: "APIError",
        data: {
          message: "APIError status=401: Unauthorized: {\"error\":{\"message\":\"User not found.\",\"code\":401}}",
        },
      },
    },
    parts: [],
  });

  assert.match(payload.text, /模型返回错误：APIError/);
  assert.match(payload.text, /鉴权失败/);
  assert.match(payload.text, /WSL/);
});

test("extractAssistantPayloadFromEnvelope should surface info.error even when role is non-assistant", () => {
  const payload = extractAssistantPayloadFromEnvelope({
    info: {
      role: "system",
      error: "APIError status=401: Unauthorized: User not found.",
    },
    parts: [],
  });

  assert.match(payload.text, /模型返回错误/);
  assert.match(payload.text, /401/);
  assert.match(payload.text, /鉴权失败/);
  assert.equal(payload.reasoning, "");
  assert.equal(Array.isArray(payload.blocks), true);
});

test("formatSessionStatusText should support nested status payload shape", () => {
  const text = formatSessionStatusText({
    sessionID: "ses_1",
    status: {
      type: "retry",
      attempt: 2,
      message: "queueing",
    },
  });
  assert.equal(text, "retry(attempt=2, message=queueing)");
});
