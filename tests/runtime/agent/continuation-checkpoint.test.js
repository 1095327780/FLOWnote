const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createContinuationCheckpoint,
  validateContinuationCheckpoint,
  appendResumeInstruction,
  isResumeRequest,
} = require("../../../runtime/agent/continuation-checkpoint");

function pairedConversation() {
  return [
    { role: "user", content: [{ type: "text", text: "/ah-card" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "vault_read", input: { path: "a.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "A" }] },
  ];
}

test("creates a JSON checkpoint only at a protocol-valid tool boundary", () => {
  const checkpoint = createContinuationCheckpoint({
    conversation: pairedConversation(),
    effectReceipts: [{ verified: true, paths: ["a.md"] }],
    interactionReceipts: [{ tool: "ask_user", toolUseId: "ask-1", verified: true }],
    executionContract: { id: "skill-ah-card", mode: "workflow" },
    completionRetries: 1,
    turns: 4,
  });

  assert.equal(validateContinuationCheckpoint(checkpoint).ok, true);
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.turns, 4);
  assert.deepEqual(checkpoint.interactionReceipts, [
    { tool: "ask_user", toolUseId: "ask-1", verified: true },
  ]);
  assert.notEqual(checkpoint.messages, pairedConversation());
});

test("rejects a checkpoint with an unresolved tool call", () => {
  const invalid = {
    version: 1,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "write-1", name: "vault_write", input: {} }] },
    ],
    effectReceipts: [],
    contract: null,
    completionRetries: 0,
    turns: 1,
  };
  const result = validateContinuationCheckpoint(invalid);
  assert.equal(result.ok, false);
  assert.match(result.error, /write-1/);
});

test("resume instructions follow the trailing tool-result message as a new user turn", () => {
  const messages = appendResumeInstruction(pairedConversation(), "继续");
  assert.equal(messages.length, 4);
  assert.equal(messages.at(-2).role, "user");
  assert.deepEqual(messages.at(-2).content.map((block) => block.type), ["tool_result"]);
  assert.equal(messages.at(-1).role, "user");
  assert.deepEqual(messages.at(-1).content.map((block) => block.type), ["text"]);
  assert.match(messages.at(-1).content.at(-1).text, /FLOWNOTE_RESUME/);
});

test("resume intent is explicit and does not consume unrelated new work", () => {
  assert.equal(isResumeRequest("继续"), true);
  assert.equal(isResumeRequest("继续执行"), true);
  assert.equal(isResumeRequest("resume"), true);
  assert.equal(isResumeRequest("重新执行 /ah-card"), false);
  assert.equal(isResumeRequest("顺便帮我写日报"), false);
});

test("external mutation attempts survive suspension without persisting request payloads", () => {
  const hash = "a".repeat(64);
  const checkpoint = createContinuationCheckpoint({
    conversation: pairedConversation(),
    effectReceipts: [],
    executionContract: { id: "workflow", mode: "workflow" },
    completionRetries: 0,
    turns: 2,
    effectAttempts: [{
      version: 1,
      fingerprint: `sha256:${hash}`,
      tool: "web_request",
      state: "unknown_after_send",
      idempotencyKey: `flownote-${hash}`,
    }],
  });

  assert.equal(validateContinuationCheckpoint(checkpoint).ok, true);
  assert.equal(checkpoint.effectAttempts[0].state, "unknown_after_send");
  assert.deepEqual(Object.keys(checkpoint.effectAttempts[0]).sort(), [
    "fingerprint", "idempotencyKey", "state", "tool", "version",
  ]);
});
