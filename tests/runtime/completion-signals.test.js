const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAssistantMessageCompletedInfo,
  isAssistantMessageEnvelopeCompleted,
  extractSessionIdFromEventProperties,
  extractSessionStatusType,
  isSessionStatusActive,
  isSessionStatusTerminal,
} = require("../../runtime/transports/shared/completion-signals");

test("isAssistantMessageCompletedInfo should detect completed timestamp and finish reason", () => {
  assert.equal(
    isAssistantMessageCompletedInfo({
      time: { created: 1, completed: 2 },
    }),
    true,
  );
  assert.equal(
    isAssistantMessageCompletedInfo({
      time: { created: 1 },
      finish: "stop",
    }),
    true,
  );
  assert.equal(
    isAssistantMessageCompletedInfo({
      time: { created: 1 },
    }),
    false,
  );
});

test("isAssistantMessageEnvelopeCompleted should only accept assistant role", () => {
  assert.equal(
    isAssistantMessageEnvelopeCompleted({
      info: {
        role: "assistant",
        time: { created: 1, completed: 2 },
      },
    }),
    true,
  );
  assert.equal(
    isAssistantMessageEnvelopeCompleted({
      info: {
        role: "user",
        time: { created: 1, completed: 2 },
      },
    }),
    false,
  );
});

test("extractSessionIdFromEventProperties should support direct and info-based shapes", () => {
  assert.equal(extractSessionIdFromEventProperties({ sessionID: "ses_1" }), "ses_1");
  assert.equal(extractSessionIdFromEventProperties({ sessionId: "ses_2" }), "ses_2");
  assert.equal(
    extractSessionIdFromEventProperties({
      info: { id: "ses_3" },
    }),
    "ses_3",
  );
});

test("session status helpers should normalize nested states", () => {
  assert.equal(extractSessionStatusType({ status: { type: "BUSY" } }), "busy");
  assert.equal(extractSessionStatusType({ state: "idle" }), "idle");
  assert.equal(isSessionStatusActive({ status: { type: "busy" } }), true);
  assert.equal(isSessionStatusTerminal({ status: { type: "idle" } }), true);
  assert.equal(isSessionStatusTerminal({ status: { type: "retry" } }), false);
});
