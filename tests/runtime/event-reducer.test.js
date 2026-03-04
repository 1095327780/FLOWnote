const test = require("node:test");
const assert = require("node:assert/strict");

const { createTransportEventReducer } = require("../../runtime/transports/shared/event-reducer");

test("event reducer should not stop on idle status when assistant reply is only partial", () => {
  const startedAt = Date.now();
  const reducer = createTransportEventReducer({
    sessionId: "ses_1",
    startedAt,
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_a",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 5 },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_t1",
        type: "text",
        sessionID: "ses_1",
        messageID: "msg_a",
        text: "partial reply",
      },
    },
  });

  reducer.consume({
    type: "session.status",
    properties: {
      sessionID: "ses_1",
      status: { type: "idle" },
    },
  });

  assert.equal(reducer.isDone(), false);
  const snap = reducer.snapshot();
  assert.equal(Boolean(snap.completed), false);
  assert.match(String(snap.text || ""), /partial/);
});

test("event reducer should wait for idle after assistant message completed", () => {
  const startedAt = Date.now();
  const reducer = createTransportEventReducer({
    sessionId: "ses_1",
    startedAt,
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_a",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 5 },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_t1",
        type: "text",
        sessionID: "ses_1",
        messageID: "msg_a",
        text: "final reply",
      },
    },
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_a",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 5, completed: startedAt + 50 },
      },
    },
  });

  assert.equal(reducer.isDone(), false);
  reducer.consume({
    type: "session.status",
    properties: {
      sessionID: "ses_1",
      status: { type: "idle" },
    },
  });
  assert.equal(reducer.isDone(), true);
  const snap = reducer.snapshot();
  assert.equal(Boolean(snap.completed), true);
});

test("event reducer should stop on idle when no message was produced", () => {
  const reducer = createTransportEventReducer({
    sessionId: "ses_1",
    startedAt: Date.now(),
  });

  reducer.consume({
    type: "session.idle",
    properties: { sessionID: "ses_1" },
  });

  assert.equal(reducer.isDone(), true);
});

test("event reducer should keep waiting when question is pending even if session turns idle", () => {
  const reducer = createTransportEventReducer({
    sessionId: "ses_1",
    startedAt: Date.now(),
  });

  reducer.consume({
    type: "question.asked",
    properties: {
      requestID: "que_1",
      sessionID: "ses_1",
      request: { id: "que_1", sessionID: "ses_1" },
    },
  });
  reducer.consume({
    type: "session.idle",
    properties: { sessionID: "ses_1" },
  });
  assert.equal(reducer.isDone(), false);

  reducer.consume({
    type: "question.replied",
    properties: {
      requestID: "que_1",
      sessionID: "ses_1",
    },
  });
  reducer.consume({
    type: "session.idle",
    properties: { sessionID: "ses_1" },
  });
  assert.equal(reducer.isDone(), true);
});

test("event reducer should reset completion state when newer assistant message starts", () => {
  const startedAt = Date.now();
  const reducer = createTransportEventReducer({
    sessionId: "ses_1",
    startedAt,
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_old",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 10, completed: startedAt + 20 },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_old_text",
        type: "text",
        sessionID: "ses_1",
        messageID: "msg_old",
        text: "old reply",
      },
    },
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_new",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 30 },
      },
    },
  });

  reducer.consume({
    type: "session.status",
    properties: {
      sessionID: "ses_1",
      status: { type: "idle" },
    },
  });
  assert.equal(reducer.isDone(), false);

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_new",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 30, completed: startedAt + 50 },
      },
    },
  });

  reducer.consume({
    type: "session.idle",
    properties: { sessionID: "ses_1" },
  });

  assert.equal(reducer.isDone(), true);
  const snap = reducer.snapshot();
  assert.equal(Boolean(snap.completed), true);
});

test("event reducer should merge snapshot-like deltas without quadratic duplication", () => {
  const startedAt = Date.now();
  const reducer = createTransportEventReducer({
    sessionId: "ses_1",
    startedAt,
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_a",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 5 },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      delta: "I need to ",
      part: {
        id: "prt_r1",
        type: "reasoning",
        sessionID: "ses_1",
        messageID: "msg_a",
        text: "I need to ",
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      // Some providers emit snapshot-like delta instead of strict append-only delta.
      delta: "I need to analyze the request.",
      part: {
        id: "prt_r1",
        type: "reasoning",
        sessionID: "ses_1",
        messageID: "msg_a",
        text: "I need to analyze the request.",
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      delta: "I need to analyze the request.\nThen implement the fix.",
      part: {
        id: "prt_r1",
        type: "reasoning",
        sessionID: "ses_1",
        messageID: "msg_a",
        text: "I need to analyze the request.\nThen implement the fix.",
      },
    },
  });

  const snap = reducer.snapshot();
  assert.equal(
    snap.reasoning,
    "I need to analyze the request.\nThen implement the fix.",
  );
});

test("event reducer should treat assistant finish field as completion signal", () => {
  const startedAt = Date.now();
  const reducer = createTransportEventReducer({
    sessionId: "ses_1",
    startedAt,
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_a",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 5 },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_t1",
        type: "text",
        sessionID: "ses_1",
        messageID: "msg_a",
        text: "final reply",
      },
    },
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_a",
        role: "assistant",
        sessionID: "ses_1",
        finish: "stop",
        time: { created: startedAt + 5 },
      },
    },
  });

  reducer.consume({
    type: "session.idle",
    properties: { sessionID: "ses_1" },
  });

  assert.equal(reducer.isDone(), true);
  const snap = reducer.snapshot();
  assert.equal(Boolean(snap.completed), true);
});

test("event reducer should emit skill block from official skill-instruction text before assistant tool steps", () => {
  const startedAt = Date.now();
  const reducer = createTransportEventReducer({
    sessionId: "ses_1",
    startedAt,
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_user",
        role: "user",
        sessionID: "ses_1",
        time: { created: startedAt + 1 },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_user_text",
        type: "text",
        sessionID: "ses_1",
        messageID: "msg_user",
        text: "<skill-instruction>\nBase directory for this skill: /Users/test/.opencode/skills/ah-month/\n</skill-instruction>",
      },
    },
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_assistant",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 5 },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_step_1",
        type: "step-start",
        sessionID: "ses_1",
        messageID: "msg_assistant",
      },
    },
  });

  const snap = reducer.snapshot();
  assert.ok(Array.isArray(snap.blocks));
  assert.equal(snap.blocks.length >= 2, true);
  assert.equal(String(snap.blocks[0].tool || "").toLowerCase(), "skill");
  assert.equal(snap.blocks[0].toolInput.skill, "ah-month");
  assert.equal(String(snap.blocks[1].type || "").toLowerCase(), "step-start");
});

test("event reducer should keep skill block when assistant message id switches", () => {
  const startedAt = Date.now();
  const reducer = createTransportEventReducer({
    sessionId: "ses_1",
    startedAt,
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_user",
        role: "user",
        sessionID: "ses_1",
        time: { created: startedAt + 1 },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_user_text",
        type: "text",
        sessionID: "ses_1",
        messageID: "msg_user",
        text: "<skill-instruction>\nBase directory for this skill: /Users/test/.opencode/skills/ah-month/\n</skill-instruction>",
      },
    },
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_assistant_1",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 10 },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_step_1",
        type: "step-start",
        sessionID: "ses_1",
        messageID: "msg_assistant_1",
      },
    },
  });

  reducer.consume({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_assistant_2",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: startedAt + 20 },
      },
    },
  });

  const snap = reducer.snapshot();
  assert.ok(Array.isArray(snap.blocks));
  assert.equal(snap.blocks.length >= 1, true);
  assert.equal(String(snap.blocks[0].tool || "").toLowerCase(), "skill");
  assert.equal(snap.blocks[0].toolInput.skill, "ah-month");
});
