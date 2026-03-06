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

test("event reducer should consume message.part.delta updates for text parts", () => {
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
        text: "",
      },
    },
  });

  reducer.consume({
    type: "message.part.delta",
    properties: {
      sessionID: "ses_1",
      messageID: "msg_a",
      partID: "prt_t1",
      field: "text",
      delta: "正在处理",
    },
  });

  reducer.consume({
    type: "message.part.delta",
    properties: {
      sessionID: "ses_1",
      messageID: "msg_a",
      partID: "prt_t1",
      field: "text",
      delta: "正在处理你的请求",
    },
  });

  const snap = reducer.snapshot();
  assert.equal(snap.text, "正在处理你的请求");
});

test("event reducer should append short token deltas instead of replacing previous text", () => {
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
        text: "",
      },
    },
  });

  reducer.consume({
    type: "message.part.delta",
    properties: {
      sessionID: "ses_1",
      messageID: "msg_a",
      partID: "prt_t1",
      field: "text",
      delta: "K",
    },
  });

  reducer.consume({
    type: "message.part.delta",
    properties: {
      sessionID: "ses_1",
      messageID: "msg_a",
      partID: "prt_t1",
      field: "text",
      delta: "ubernetes",
    },
  });

  reducer.consume({
    type: "message.part.delta",
    properties: {
      sessionID: "ses_1",
      messageID: "msg_a",
      partID: "prt_t1",
      field: "text",
      delta: " Architecture",
    },
  });

  const snap = reducer.snapshot();
  assert.equal(snap.text, "Kubernetes Architecture");
});

test("event reducer should append short deltas from message.part.updated before full snapshot arrives", () => {
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
      delta: "K",
      part: {
        id: "prt_r1",
        type: "reasoning",
        sessionID: "ses_1",
        messageID: "msg_a",
        text: "",
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      delta: "ubernetes",
      part: {
        id: "prt_r1",
        type: "reasoning",
        sessionID: "ses_1",
        messageID: "msg_a",
        text: "",
      },
    },
  });

  const snap = reducer.snapshot();
  assert.equal(snap.reasoning, "Kubernetes");
});

test("event reducer should interleave stream text blocks with tool blocks by event order", () => {
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
        id: "tool_1",
        type: "tool",
        callID: "tool_1",
        sessionID: "ses_1",
        messageID: "msg_a",
        tool: "read",
        state: { status: "completed", output: "ok" },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      delta: "第一段中间输出",
      part: {
        id: "text_1",
        type: "text",
        sessionID: "ses_1",
        messageID: "msg_a",
        text: "",
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "tool_2",
        type: "tool",
        callID: "tool_2",
        sessionID: "ses_1",
        messageID: "msg_a",
        tool: "write",
        state: { status: "running" },
      },
    },
  });

  reducer.consume({
    type: "message.part.delta",
    properties: {
      sessionID: "ses_1",
      messageID: "msg_a",
      partID: "text_1",
      field: "text",
      delta: "第二段中间输出",
    },
  });

  const snap = reducer.snapshot();
  const types = (Array.isArray(snap.blocks) ? snap.blocks : []).map((block) => String(block && block.type ? block.type : ""));
  assert.deepEqual(types, ["tool", "stream-text", "tool", "stream-text"]);
  assert.equal(String(snap.blocks[1].detail || ""), "第一段中间输出");
  assert.equal(String(snap.blocks[3].detail || ""), "第二段中间输出");
});

test("event reducer should merge tool part updates by callID even when part id changes", () => {
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
        id: "part_tool_running",
        type: "tool",
        sessionID: "ses_1",
        messageID: "msg_a",
        callID: "call_1",
        tool: "background_output",
        state: {
          status: "running",
          input: { task_id: "task_1" },
          time: { start: startedAt + 10 },
        },
      },
    },
  });

  reducer.consume({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part_tool_completed",
        type: "tool",
        sessionID: "ses_1",
        messageID: "msg_a",
        callID: "call_1",
        tool: "background_output",
        state: {
          status: "completed",
          title: "Background output",
          input: { task_id: "task_1" },
          output: "done",
          metadata: {},
          time: { start: startedAt + 10, end: startedAt + 30 },
        },
      },
    },
  });

  const snap = reducer.snapshot();
  const tools = (Array.isArray(snap.blocks) ? snap.blocks : [])
    .filter((block) => block && String(block.type || "").toLowerCase() === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, "tool:call_1");
  assert.equal(tools[0].status, "completed");
});

test("event reducer should adopt assistant message id from reasoning part when message.updated is delayed", () => {
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
        id: "prt_reasoning_1",
        type: "reasoning",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        text: "思考中",
      },
    },
  });

  const snap = reducer.snapshot();
  assert.equal(snap.messageId, "msg_assistant");
  assert.equal(snap.reasoning, "思考中");
});
