const test = require("node:test");
const assert = require("node:assert/strict");

const {
  reconcileTerminalAssistantTimeline,
} = require("../../runtime/transports/shared/assistant-activity-timeline");

test("terminal reconciliation preserves live text/tool chronology and updates tools in place", () => {
  const live = {
    messageId: "msg-1",
    text: "先检查。\n\n已经完成。",
    blocks: [
      { id: "stream-text:msg-1:1", type: "stream-text", text: "先检查。" },
      { id: "call-1", type: "tool", tool: "vault_read", status: "running" },
      { id: "stream-text:msg-1:2", type: "stream-text", text: "继续处理。" },
      { id: "call-2", type: "tool", tool: "vault_write", status: "running" },
      { id: "stream-text:msg-1:3", type: "stream-text", text: "已经完成。" },
    ],
    completed: true,
  };
  const terminal = {
    messageId: "msg-1",
    text: "先检查。\n\n继续处理。\n\n已经完成。",
    blocks: [
      { id: "call-1", type: "tool", tool: "vault_read", status: "completed", detail: "ok" },
      { id: "call-2", type: "tool", tool: "vault_write", status: "completed", detail: "saved" },
    ],
    completed: true,
  };

  const result = reconcileTerminalAssistantTimeline(live, terminal);

  assert.deepEqual(result.blocks.map((block) => `${block.type}:${block.id}`), [
    "stream-text:stream-text:msg-1:1",
    "tool:call-1",
    "stream-text:stream-text:msg-1:2",
    "tool:call-2",
    "stream-text:stream-text:msg-1:3",
  ]);
  assert.deepEqual(result.blocks.filter((block) => block.type === "stream-text").map((block) => block.phase), [
    "process",
    "process",
    "final",
  ]);
  assert.equal(result.blocks[1].status, "completed");
  assert.equal(result.blocks[3].detail, "saved");
  assert.equal(result.text, "已经完成。");
});

test("terminal reconciliation appends a final answer after a tool when the live stream missed it", () => {
  const result = reconcileTerminalAssistantTimeline(
    {
      messageId: "msg-2",
      blocks: [
        { id: "stream-text:msg-2:1", type: "stream-text", text: "我先读取文件。" },
        { id: "call-1", type: "tool", tool: "vault_read", status: "running" },
      ],
    },
    {
      messageId: "msg-2",
      text: "我先读取文件。\n\n这是最终答案。",
      blocks: [{ id: "call-1", type: "tool", tool: "vault_read", status: "completed" }],
      completed: true,
    },
  );

  assert.deepEqual(result.blocks.map((block) => block.type), ["stream-text", "tool", "stream-text"]);
  assert.equal(result.blocks[0].phase, "process");
  assert.equal(result.blocks[2].phase, "final");
  assert.equal(result.blocks[2].text, "这是最终答案。");
  assert.equal(result.text, "这是最终答案。");
});

test("terminal-only responses use the same final timeline representation", () => {
  const result = reconcileTerminalAssistantTimeline(null, {
    messageId: "msg-3",
    text: "只返回最终答案。",
    blocks: [],
    completed: true,
  });

  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].type, "stream-text");
  assert.equal(result.blocks[0].phase, "final");
  assert.equal(result.blocks[0].text, "只返回最终答案。");
});

test("a tool missed by live frames is restored before the already streamed final answer", () => {
  const result = reconcileTerminalAssistantTimeline(
    {
      messageId: "msg-4",
      blocks: [
        { id: "p1", type: "stream-text", text: "先检查。" },
        { id: "call-1", type: "tool", tool: "vault_read", status: "completed" },
        { id: "f1", type: "stream-text", text: "已经完成。" },
      ],
    },
    {
      messageId: "msg-4",
      text: "先检查。\n\n已经完成。",
      blocks: [
        { id: "call-1", type: "tool", tool: "vault_read", status: "completed" },
        { id: "call-2", type: "tool", tool: "vault_write", status: "completed" },
      ],
      completed: true,
    },
  );

  assert.deepEqual(result.blocks.map((block) => block.id), ["p1", "call-1", "call-2", "f1"]);
  assert.equal(result.blocks.at(-1).phase, "final");
});
