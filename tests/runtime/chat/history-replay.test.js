const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAnthropicHistory } = require("../../../runtime/chat/history-builder");
const { DirectExecutionJournal } = require("../../../runtime/chat/direct-execution-journal");
const { buildToolInputPreview, buildToolResultPreview } = require("../../../runtime/agent/tool-history-preview");
const { buildTurnChangeBlock } = require("../../../runtime/chat/turn-change-block");
const { blockUtilsMethods } = require("../../../runtime/view/message/block-utils");

async function journalFor(runId, tools) {
  const journal = new DirectExecutionJournal({ runId, now: () => 10 });
  await journal.start(null);
  for (const tool of tools) {
    await journal.consume({ type: "tool_start", toolUseId: tool.id, tool: tool.name, input: tool.input, capabilities: { effect: tool.effect, risk: "low", concurrency: "serial", presentation: "edit", targets: [] } });
    await journal.consume({ type: "tool_finish", toolUseId: tool.id, tool: tool.name, isError: !!tool.isError, content: tool.content, capabilities: { effect: tool.effect } });
  }
  await journal.consume({ type: "done" });
  return { version: 1, events: journal.events };
}

test("earlier turns are replayed as the tool calls they really made, then their final text", async () => {
  const execution = await journalFor("run-1", [
    { id: "call:1", name: "vault_read", effect: "observation", input: { path: "A.md" }, content: "x".repeat(5000) },
    { id: "call:2", name: "vault_edit", effect: "vault_mutation", input: { path: "A.md", old_string: "secret old", new_string: "secret new" }, content: 'Edited "A.md" — replaced 1 occurrence (+0 bytes).' },
  ]);
  const history = buildAnthropicHistory([
    { id: "u1", role: "user", text: "改一下 A" },
    { id: "a1", role: "assistant", text: "已修改 A.md。", execution },
    { id: "u2", role: "user", text: "current (dropped)" },
  ], "draft");

  assert.deepEqual(history.map((message) => [message.role, message.content.map((block) => block.type).join(",")]), [
    ["user", "text"],
    ["assistant", "tool_use"], ["user", "tool_result"],
    ["assistant", "tool_use"], ["user", "tool_result"],
    ["assistant", "text"],
  ]);
  const [read, , edit, editResult, final] = history.slice(1);
  assert.equal(read.content[0].id, "h2_call_1");
  assert.deepEqual(read.content[0].input, { path: "A.md" });
  assert.match(history[2].content[0].content, /5000 chars of output omitted/);
  assert.deepEqual(edit.content[0].input, { path: "A.md", old_string: "[10 chars]", new_string: "[10 chars]" });
  assert.equal(editResult.content[0].tool_use_id, edit.content[0].id);
  assert.match(editResult.content[0].content, /^Edited "A\.md"/);
  assert.equal(final.content[0].text, "已修改 A.md。");
  assert.doesNotMatch(JSON.stringify(history), /secret|flownote_execution_record/);
});

test("a turn that claimed a change without any tool call stays plain text", async () => {
  const execution = await journalFor("run-2", []);
  const history = buildAnthropicHistory([
    { id: "u1", role: "user", text: "hi" },
    { id: "a1", role: "assistant", text: "你好", execution },
  ], "draft");
  assert.deepEqual(history, [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "你好" }] },
  ]);
});

test("legacy host completion summaries are removed from the model's own history", () => {
  const history = buildAnthropicHistory([
    { id: "u1", role: "user", text: "hi" },
    { id: "a1", role: "assistant", text: "Done.\n\n**已完成并核验**\n- 修改 `A.md`\n- 新建 `B.md`" },
  ], "draft");
  assert.equal(history[1].content[0].text, "Done.");
  const kept = buildAnthropicHistory([
    { id: "a1", role: "assistant", text: "**已完成并核验** is a phrase I quote here." },
  ], "draft");
  assert.equal(kept[0].content[0].text, "**已完成并核验** is a phrase I quote here.");
});

test("an interrupted tool is replayed as unknown, not as success", async () => {
  const history = buildAnthropicHistory([
    { id: "a1", role: "assistant", text: "", execution: { version: 1, events: [
      { seq: 0, time: 1, type: "run_started", runId: "r", contract: null },
      { seq: 1, time: 2, type: "tool_started", runId: "r", toolUseId: "w", tool: "vault_write", inputPreview: { path: "N.md", content: "[3 chars]" } },
      { seq: 2, time: 3, type: "run_interrupted", runId: "r", reason: "unknown_after_reload", unresolvedToolUseIds: ["w"] },
    ] } },
  ], "draft");
  assert.equal(history[1].content[0].is_error, true);
  assert.match(history[1].content[0].content, /outcome is unknown/);
  assert.equal(history[2].content[0].text, "(no text reply)");
});

test("tool previews keep identities and drop content, headers and query strings", () => {
  assert.deepEqual(buildToolInputPreview({
    url: "https://api.example.com/v1/items?token=abc",
    method: "POST",
    headers: { Authorization: "Bearer real-token" },
    json: { note: "private" },
    path: "Inbox/a.md",
    content: "body",
    offset: 3,
    replace_all: true,
  }), {
    url: "https://api.example.com/v1/items",
    method: "POST",
    headers: "[1 fields]",
    json: "[1 fields]",
    path: "Inbox/a.md",
    content: "[4 chars]",
    offset: 3,
    replace_all: true,
  });
  assert.equal(buildToolResultPreview("HTTP 200\n{secret}", { effect: "network_mutation" }), "[17 chars of output omitted from history; call the tool again if the content is needed]");
  assert.equal(buildToolResultPreview("Wrote a.md\nmore\nlines\nhidden", { effect: "vault_mutation" }), "Wrote a.md\nmore\nlines");
});

test("the host change block lists measured changes with excerpts and is part of the answer", () => {
  assert.equal(buildTurnChangeBlock({ runId: "r", changes: [] }), null);
  const block = buildTurnChangeBlock({ runId: "r", changes: [
    { path: "A.md", op: "modified", diff: { before: "a", after: "b", startLine: 7 } },
    { path: "New", op: "created", kind: "folder" },
    { path: "Archive/Old.md", from: "Old.md", op: "renamed" },
  ] });
  assert.equal(block.type, "patch");
  assert.equal(block.phase, "final");
  assert.equal(block.source, "host_measured");
  assert.deepEqual(block.raw.files, [
    { action: "modified", path: "A.md" },
    { action: "added", path: "New", kind: "folder" },
    { action: "renamed", path: "Archive/Old.md", from: "Old.md", to: "Archive/Old.md" },
  ]);
  assert.deepEqual(block.raw.diffs, [{ file: "A.md", before: "a", after: "b", startLine: 7, additions: undefined, deletions: undefined }]);
  const presentation = blockUtilsMethods.classifyAssistantTimelineBlocks([
    { type: "tool", tool: "vault_edit" },
    { type: "stream-text", phase: "final", text: "done" },
    block,
  ]);
  assert.deepEqual(presentation.finalIndexes, [1, 2]);
  assert.deepEqual(presentation.processIndexes, [0]);
});
