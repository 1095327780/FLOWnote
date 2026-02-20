const test = require("node:test");
const assert = require("node:assert/strict");

const { pollAssistantPayload } = require("../../runtime/transports/shared/finalizer");

test("pollAssistantPayload should keep waiting for unknown status until quiet timeout", async () => {
  const result = await pollAssistantPayload({
    quietTimeoutMs: 40,
    maxTotalMs: 80,
    noMessageTimeoutMs: 10,
    sleep: async () => {},
    getLatest: async () => null,
    getSessionStatus: async () => ({}),
  });

  assert.equal(result.messageId, "");
  assert.equal(String(result.payload && result.payload.text || ""), "");
  assert.equal(result.timedOut, true);
});

test("pollAssistantPayload should stop after no-message timeout when status API is unavailable", async () => {
  const started = Date.now();
  const result = await pollAssistantPayload({
    quietTimeoutMs: 15000,
    maxTotalMs: 60000,
    noMessageTimeoutMs: 30,
    sleep: async () => {},
    getLatest: async () => null,
  });

  assert.equal(result.messageId, "");
  assert.equal(String(result.payload && result.payload.text || ""), "");
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - started < 2000);
});

test("pollAssistantPayload should keep waiting when session is busy even if no-message timeout is reached", async () => {
  const result = await pollAssistantPayload({
    quietTimeoutMs: 40,
    maxTotalMs: 80,
    noMessageTimeoutMs: 10,
    sleep: async () => {},
    getLatest: async () => null,
    getSessionStatus: async () => ({ type: "busy" }),
  });

  assert.equal(result.messageId, "");
  assert.equal(String(result.payload && result.payload.text || ""), "");
  assert.equal(result.timedOut, true);
});

test("pollAssistantPayload should surface auth failures from session status", async () => {
  const result = await pollAssistantPayload({
    quietTimeoutMs: 15000,
    maxTotalMs: 60000,
    noMessageTimeoutMs: 1000,
    sleep: async () => {},
    getLatest: async () => null,
    getSessionStatus: async () => ({
      type: "retry",
      attempt: 1,
      message: "APIError status=401: Unauthorized: User not found.",
    }),
  });

  assert.match(String(result.payload && result.payload.text || ""), /401|Unauthorized|User not found/i);
  assert.match(String(result.payload && result.payload.meta || ""), /401|Unauthorized|User not found/i);
  assert.equal(result.timedOut, false);
});

test("pollAssistantPayload should stop when session becomes idle without payload", async () => {
  let statusCalls = 0;
  const result = await pollAssistantPayload({
    quietTimeoutMs: 15000,
    maxTotalMs: 60000,
    noMessageTimeoutMs: 1000,
    sleep: async () => {},
    getLatest: async () => null,
    getSessionStatus: async () => {
      statusCalls += 1;
      return statusCalls >= 2 ? { type: "idle" } : { type: "busy" };
    },
  });

  assert.equal(result.messageId, "");
  assert.equal(String(result.payload && result.payload.text || ""), "");
  assert.equal(result.timedOut, false);
});

test("pollAssistantPayload should not exit too early when idle appears before first assistant message", async () => {
  let latestCalls = 0;
  const result = await pollAssistantPayload({
    quietTimeoutMs: 15000,
    maxTotalMs: 60000,
    noMessageTimeoutMs: 12000,
    sleep: async () => {},
    getLatest: async () => {
      latestCalls += 1;
      if (latestCalls < 6) return null;
      return {
        messageId: "msg_a1",
        createdAt: Date.now(),
        payload: {
          text: "pong",
          reasoning: "",
          meta: "",
          blocks: [{ type: "step-finish", summary: "stop" }],
        },
        completed: true,
      };
    },
    getSessionStatus: async () => ({ type: "idle" }),
  });

  assert.equal(result.messageId, "msg_a1");
  assert.equal(String(result.payload && result.payload.text || ""), "pong");
  assert.equal(result.timedOut, false);
});

test("pollAssistantPayload should not stop on first partial text when requireTerminal=false", async () => {
  let latestCalls = 0;
  const result = await pollAssistantPayload({
    quietTimeoutMs: 15000,
    maxTotalMs: 60000,
    noMessageTimeoutMs: 12000,
    requireTerminal: false,
    sleep: async () => {},
    getLatest: async () => {
      latestCalls += 1;
      if (latestCalls === 1) {
        return {
          messageId: "msg_a1",
          createdAt: Date.now(),
          payload: { text: "hello", reasoning: "", meta: "", blocks: [] },
          completed: false,
        };
      }
      return {
        messageId: "msg_a1",
        createdAt: Date.now(),
        payload: { text: "hello world", reasoning: "", meta: "", blocks: [] },
        completed: true,
      };
    },
    getSessionStatus: async () => ({ type: "busy" }),
  });

  assert.ok(latestCalls >= 2);
  assert.equal(result.messageId, "msg_a1");
  assert.equal(String(result.payload && result.payload.text || ""), "hello world");
  assert.equal(result.timedOut, false);
});
