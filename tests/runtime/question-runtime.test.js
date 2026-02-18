const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildQuestionAnswerArrays,
  findPendingQuestionRequest,
  normalizeQuestionRequest,
  questionRequestMapKey,
  upsertPendingQuestionRequest,
} = require("../../runtime/question-runtime");

function normalizeQuestionInput(input) {
  if (!input || !Array.isArray(input.questions)) return [];
  return input.questions.map((q) => ({
    question: String(q.question || "").trim(),
    options: Array.isArray(q.options) ? q.options : [],
  })).filter((q) => q.question);
}

test("questionRequestMapKey should return stable key", () => {
  assert.equal(questionRequestMapKey("s1", "r1"), "s1::r1");
  assert.equal(questionRequestMapKey("", "r1"), "");
});

test("normalizeQuestionRequest should normalize request payload", () => {
  const req = normalizeQuestionRequest(
    {
      id: "req-1",
      sessionID: "session-1",
      questions: {
        questions: [{ question: "选择模式？", options: [{ label: "A" }, { label: "B" }] }],
      },
      tool: { messageID: "msg-1", callID: "tool-1" },
    },
    normalizeQuestionInput,
  );

  assert.ok(req);
  assert.equal(req.id, "req-1");
  assert.equal(req.sessionId, "session-1");
  assert.equal(req.questions.length, 1);
  assert.equal(req.tool.callID, "tool-1");
});

test("buildQuestionAnswerArrays should merge selection and custom answer", () => {
  const questions = [{ question: "Q1", options: [{ label: "A" }, { label: "B" }] }];
  const state = { answers: { 0: { value: "A", custom: "补充" } } };

  const out = buildQuestionAnswerArrays(questions, {}, state);
  assert.deepEqual(out, [["A", "补充"]]);
});

test("findPendingQuestionRequest should match by tool call id first", () => {
  const pending = new Map();
  upsertPendingQuestionRequest(
    pending,
    {
      id: "req-2",
      sessionID: "session-2",
      questions: { questions: [{ question: "Q2" }] },
      tool: { callID: "call-2", messageID: "msg-2" },
    },
    normalizeQuestionInput,
  );

  const found = findPendingQuestionRequest(pending, {
    sessionId: "session-2",
    block: { id: "call-2" },
    message: { id: "msg-2" },
    questions: [{ question: "Q2" }],
  });

  assert.ok(found);
  assert.equal(found.id, "req-2");
});
