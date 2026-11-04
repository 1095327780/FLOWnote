const test = require("node:test");
const assert = require("node:assert/strict");

const {
  prepareContextWindow, allocateToolResultBudgets, countPromptTokens,
} = require("../../../runtime/agent/context-budget-manager");
const { validateContinuationCheckpoint } = require("../../../runtime/agent/continuation-checkpoint");

function provider(contextWindow = 1_000_000) {
  return {
    spec: { models: [{ id: "test-model", contextWindow, maxOutput: 384_000 }] },
    async countTokens(messages) { return Math.ceil(JSON.stringify(messages).length / 4); },
  };
}

function readPair(id, input, content, is_error = false) {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: "vault_read", input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
  ];
}

test("short context remains exact and reports hard-window and economic metadata", async () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const result = await prepareContextWindow({
    provider: provider(10_000), model: "test-model", system: "system", tools: [],
    conversation: messages, requestedMaxTokens: 4_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.compacted, false);
  assert.equal(result.maxTokens, 4_000);
  assert.equal(result.hardPromptTarget, 4_976);
  assert.equal(result.safetyTokens, 1_024);
  assert.equal(result.economicTargetTokens, 64_000);
  assert.deepEqual(result.messages, messages);
});

test("unique large read evidence stays exact above the economic target", async () => {
  const unique = "独特证据".repeat(15_000);
  const instruction = "Compare the full evidence before answering.";
  const messages = [
    { role: "user", content: [{ type: "text", text: instruction }] },
    ...readPair("one", { path: "A.md" }, unique),
    ...readPair("two", { path: "B.md" }, "different ".repeat(12_000)),
  ];
  const result = await prepareContextWindow({
    provider: provider(), model: "test-model", system: "system", tools: [],
    conversation: messages, requestedMaxTokens: 384_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.compacted, false);
  assert.equal(result.overEconomicTarget, true);
  assert.deepEqual(result.messages, messages);
});

test("exact repeated reads reference the first retained full result and never mutate assistant blocks", async () => {
  const body = "evidence ".repeat(6_000);
  const signed = { type: "tool_use", id: "first", name: "vault_read", input: { path: "A.md", offset: 1 }, extra_content: { google: { thought_signature: "sig" } } };
  const messages = [
    { role: "user", content: [{ type: "text", text: "Read the note" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "signed" }, signed] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "first", content: body }] },
    ...readPair("second", { offset: 1, path: "A.md" }, body),
    ...readPair("third", { path: "A.md", offset: 1 }, body),
  ];
  const result = await prepareContextWindow({
    provider: provider(), model: "test-model", system: "system", tools: [],
    conversation: messages, requestedMaxTokens: 384_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.equal(result.messages[2].content[0].content, body);
  assert.match(result.messages[4].content[0].content, /canonical_tool_use_id=first/);
  assert.match(result.messages[6].content[0].content, /canonical_tool_use_id=first/);
  assert.deepEqual(result.messages.filter((message) => message.role === "assistant"), messages.filter((message) => message.role === "assistant"));
  assert.equal(validateContinuationCheckpoint({
    version: 1, messages: result.messages, effectReceipts: [], contract: null,
    completionRetries: 0, turns: 3,
  }).ok, true);
  const again = await prepareContextWindow({
    provider: provider(), model: "test-model", system: "system", tools: [],
    conversation: result.messages, requestedMaxTokens: 384_000,
  });
  assert.equal(again.compacted, false);
  assert.deepEqual(again.messages, result.messages);
});

test("different calls or bodies, errors, skills, and mutation receipts are never deduplicated", async () => {
  const body = "same ".repeat(10_000);
  const messages = [
    { role: "user", content: [{ type: "text", text: "do work" }] },
    ...readPair("a", { path: "A.md" }, body),
    ...readPair("b", { path: "B.md" }, body),
    ...readPair("c", { path: "A.md" }, `${body}different`),
    ...readPair("d", { path: "A.md" }, body, true),
    { role: "assistant", content: [{ type: "tool_use", id: "skill", name: "skill_invoke", input: { skill: "a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "skill", content: body }] },
    { role: "assistant", content: [{ type: "tool_use", id: "write", name: "vault_write", input: { path: "A.md", content: body } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "write", content: body }] },
  ];
  const result = await prepareContextWindow({ provider: provider(), model: "test-model", system: "", tools: [], conversation: messages, requestedMaxTokens: 384_000 });
  assert.equal(result.ok, true);
  assert.equal(result.compacted, false);
  assert.deepEqual(result.messages, messages);
});

test("parallel read results can reference a canonical from the same completed tool batch", async () => {
  const body = "parallel evidence ".repeat(2000);
  const messages = [
    { role: "assistant", content: [
      { type: "tool_use", id: "left", name: "vault_read", input: { path: "A.md" } },
      { type: "tool_use", id: "right", name: "vault_read", input: { path: "A.md" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "left", content: body },
      { type: "tool_result", tool_use_id: "right", content: body },
    ] },
  ];
  const result = await prepareContextWindow({ provider: provider(), model: "test-model", system: "", tools: [], conversation: messages, requestedMaxTokens: 384_000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.messages[0], messages[0]);
  assert.equal(result.messages[1].content[0].content, body);
  assert.match(result.messages[1].content[1].content, /canonical_tool_use_id=left/);
});

test("a duplicate reference without its canonical result fails clearly", async () => {
  const messages = readPair("later", { path: "A.md" },
    "[FLOWNOTE_DUPLICATE_RESULT canonical_tool_use_id=missing] This read result is exactly identical to that retained tool_result. Use its full text there; do not re-read solely because of this reference.");
  const result = await prepareContextWindow({ provider: provider(), model: "test-model", system: "", tools: [], conversation: messages, requestedMaxTokens: 384_000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONTEXT_REFERENCE_MISSING");
});

test("a note containing a duplicate-marker prefix remains ordinary evidence unless the full host reference matches", async () => {
  const body = "[FLOWNOTE_DUPLICATE_RESULT canonical_tool_use_id=missing] This is text in a note, not a host reference.";
  const messages = readPair("read", { path: "A.md" }, body);
  const result = await prepareContextWindow({ provider: provider(), model: "test-model", system: "", tools: [], conversation: messages, requestedMaxTokens: 384_000 });
  assert.equal(result.ok, true);
  assert.equal(result.messages[1].content[0].content, body);
});

test("hard overflow reports an error without dropping unique user or read content", async () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Preserve this exact task." }] },
    ...readPair("one", { path: "A.md" }, "unique".repeat(20_000)),
  ];
  const result = await prepareContextWindow({ provider: provider(5_000), model: "test-model", system: "system", tools: [], conversation: messages, requestedMaxTokens: 2_000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONTEXT_WINDOW_EXCEEDED");
  assert.deepEqual(result.messages, messages);
});

test("CJK-heavy instructions use a conservative floor even if the provider undercounts", async () => {
  const undercounting = provider();
  undercounting.countTokens = async () => 100;
  const message = { role: "user", content: [{ type: "text", text: "核查".repeat(25_000) }] };
  const result = await prepareContextWindow({ provider: undercounting, model: "test-model", system: "", tools: [], conversation: [message], requestedMaxTokens: 384_000 });
  assert.equal(result.ok, true);
  assert.equal(result.compacted, false);
  assert.ok(result.promptTokens > 64_000);
  assert.equal(result.overEconomicTarget, true);
  assert.deepEqual(result.messages, [message]);
});

test("astral Unicode keeps the same conservative weight as the read pager", async () => {
  const undercounting = provider();
  undercounting.countTokens = async () => 0;
  const message = { role: "user", content: [{ type: "text", text: "🧪".repeat(35_000) }] };
  const result = await prepareContextWindow({ provider: undercounting, model: "test-model", system: "", tools: [], conversation: [message], requestedMaxTokens: 384_000 });
  assert.equal(result.ok, true);
  assert.ok(result.promptTokens >= 70_000);
  assert.equal(result.overEconomicTarget, true);
});

test("known-window result budgets share hard headroom across pending parallel reads", async () => {
  const active = provider(100_000);
  const conversation = [
    { role: "user", content: [{ type: "text", text: "Read both notes" }] },
    { role: "assistant", content: [
      { type: "tool_use", id: "a", name: "vault_read", input: { path: "A.md" } },
      { type: "tool_use", id: "b", name: "vault_read", input: { path: "B.md" } },
      { type: "tool_use", id: "c", name: "vault_read", input: { path: "C.md" } },
    ] },
  ];
  const toolUses = ["a", "b", "c"].map((id) => ({ id, name: "vault_read" }));
  const first = await allocateToolResultBudgets({ provider: active, model: "test-model", system: "system", tools: [], conversation, requestedMaxTokens: 20_000, toolUses });
  assert.deepEqual(Object.keys(first), ["a", "b", "c"]);
  assert.ok(first.a > 0 && first.a === first.b && first.b === first.c);
  const completedResults = [{ id: "a", content: "x".repeat(20_000), isError: false }];
  const next = await allocateToolResultBudgets({ provider: active, model: "test-model", system: "system", tools: [], conversation, requestedMaxTokens: 20_000, toolUses: toolUses.slice(1), completedResults });
  assert.deepEqual(Object.keys(next), ["b", "c"]);
  assert.ok(next.b < first.b * 1.5);
  const placeholders = toolUses.map((use) => ({ type: "tool_result", tool_use_id: use.id, content: "", is_error: false }));
  const counted = await countPromptTokens(active, "system", [], [...conversation, { role: "user", content: placeholders }]);
  assert.ok(counted + 20_000 + 1024 * 3 + first.a + first.b + first.c <= 100_000 - 1024);
});

test("unknown-window budget is bounded and exhausted headroom returns zero", async () => {
  const unknown = { spec: { models: [] }, countTokens: async (messages) => Math.ceil(JSON.stringify(messages).length / 4) };
  const uses = [{ id: "a" }, { id: "b" }];
  const conversation = [{ role: "assistant", content: uses.map(({ id }) => ({ type: "tool_use", id, name: "vault_read", input: { path: `${id}.md` } })) }];
  const budgets = await allocateToolResultBudgets({ provider: unknown, model: "missing", system: "", tools: [], conversation, requestedMaxTokens: 1000, toolUses: uses });
  assert.ok(budgets.a > 0 && budgets.a === budgets.b && budgets.a * 2 <= 32_768 - 2048);
  const exhausted = await allocateToolResultBudgets({ provider: provider(5_000), model: "test-model", system: "x".repeat(10_000), tools: [], conversation, requestedMaxTokens: 4_000, toolUses: uses });
  assert.deepEqual(exhausted, { a: 0, b: 0 });
});
