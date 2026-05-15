const test = require("node:test");
const assert = require("node:assert/strict");

const { createAskUserTool, validateQuestion } = require("../../../runtime/agent/tools/ask-user");

async function collect(tool, input, ctx) {
  const events = [];
  for await (const ev of tool.execute(input, ctx || {})) events.push(ev);
  return events;
}
function lastResult(events) {
  return events.filter((e) => e.type === "result").pop();
}

const GOOD_QUESTION = {
  question: "Which file should I update?",
  header: "Target",
  options: [
    { label: "daily.md", description: "Today's daily note." },
    { label: "review.md", description: "The weekly review note." },
  ],
};

// ----- validateQuestion helper -----

test("validateQuestion accepts well-formed input", () => {
  assert.equal(validateQuestion(GOOD_QUESTION, 0), null);
});

test("validateQuestion rejects header longer than 12 chars", () => {
  const bad = { ...GOOD_QUESTION, header: "this-is-too-long" };
  assert.match(validateQuestion(bad, 0), /≤12 chars/);
});

test("validateQuestion rejects fewer than 2 options", () => {
  const bad = { ...GOOD_QUESTION, options: [GOOD_QUESTION.options[0]] };
  assert.match(validateQuestion(bad, 0), /2-4 entries/);
});

test("validateQuestion rejects duplicate option labels", () => {
  const bad = {
    ...GOOD_QUESTION,
    options: [
      { label: "x", description: "a" },
      { label: "x", description: "b" },
    ],
  };
  assert.match(validateQuestion(bad, 0), /duplicate label/);
});

// ----- factory + flags -----

test("ask_user is read-only but not concurrency-safe", () => {
  const tool = createAskUserTool();
  assert.equal(tool.isReadOnly(), true);
  assert.equal(tool.isConcurrencySafe(), false);
});

// ----- validate -----

test("ask_user.validate rejects malformed inputs", async () => {
  const tool = createAskUserTool();
  assert.equal((await tool.validate({})).ok, false);
  assert.equal((await tool.validate({ questions: [] })).ok, false);
  assert.equal((await tool.validate({ questions: [{ question: "Q?", header: "H" }] })).ok, false);
});

test("ask_user.validate accepts a good payload", async () => {
  const tool = createAskUserTool();
  const r = await tool.validate({ questions: [GOOD_QUESTION] });
  assert.equal(r.ok, true);
});

// ----- execute -----

test("ask_user.execute returns error when no askUserFn is wired", async () => {
  const tool = createAskUserTool();
  const r = lastResult(await collect(tool, { questions: [GOOD_QUESTION] }, {}));
  assert.equal(r.isError, true);
  assert.match(r.content, /no askUserFn/);
});

test("ask_user.execute returns the user's answers from the bridge", async () => {
  const tool = createAskUserTool();
  const askUserFn = async () => ({
    answers: { "Which file should I update?": "daily.md" },
  });
  const r = lastResult(await collect(tool, { questions: [GOOD_QUESTION] }, { askUserFn }));
  assert.ok(!r.isError);
  assert.match(r.content, /A: daily\.md/);
});

test("ask_user.execute surfaces multi-select answers", async () => {
  const tool = createAskUserTool();
  const askUserFn = async () => ({
    answers: { "Which file should I update?": ["daily.md", "review.md"] },
  });
  const r = lastResult(await collect(tool, { questions: [GOOD_QUESTION] }, { askUserFn }));
  assert.match(r.content, /daily\.md \| review\.md/);
});

test("ask_user.execute returns error when user dismisses", async () => {
  const tool = createAskUserTool();
  const askUserFn = async () => ({ dismissed: true });
  const r = lastResult(await collect(tool, { questions: [GOOD_QUESTION] }, { askUserFn }));
  assert.equal(r.isError, true);
  assert.match(r.content, /dismissed/);
});

test("ask_user.execute surfaces UI-bridge crashes as an error result", async () => {
  const tool = createAskUserTool();
  const askUserFn = async () => {
    throw new Error("modal blew up");
  };
  const r = lastResult(await collect(tool, { questions: [GOOD_QUESTION] }, { askUserFn }));
  assert.equal(r.isError, true);
  assert.match(r.content, /modal blew up/);
});
