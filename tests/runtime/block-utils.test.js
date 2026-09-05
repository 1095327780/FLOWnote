const test = require("node:test");
const assert = require("node:assert/strict");

const { blockUtilsMethods } = require("../../runtime/view/message/block-utils");

test("visibleAssistantBlocks should hide noisy internal background tools unless they fail", () => {
  const out = blockUtilsMethods.visibleAssistantBlocks([
    { type: "tool", tool: "background_output", status: "running" },
    { type: "tool", tool: "background_cancel", status: "completed" },
    { type: "tool", tool: "background_output", status: "error" },
    { type: "tool", tool: "bash", status: "running" },
  ]);

  assert.equal(Array.isArray(out), true);
  assert.equal(out.length, 2);
  assert.equal(out.some((row) => row && row.tool === "background_output" && row.status === "error"), true);
  assert.equal(out.some((row) => row && row.tool === "bash"), true);
});

test("visibleAssistantBlocks should still hide step lifecycle blocks", () => {
  const out = blockUtilsMethods.visibleAssistantBlocks([
    { type: "step-start", status: "running" },
    { type: "step-finish", status: "completed" },
    { type: "reasoning", status: "running" },
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0].type, "reasoning");
});

test("visibleAssistantBlocks should hide explicitly hidden tool blocks even when they are errors", () => {
  const out = blockUtilsMethods.visibleAssistantBlocks([
    { type: "tool", tool: "vault_read", status: "error", hidden: true },
    { type: "tool", tool: "vault_read", status: "error" },
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0].hidden, undefined);
});

test("a non-pending message never upgrades an unfinished tool to completed", () => {
  const ctx = { ...blockUtilsMethods };
  assert.equal(ctx.resolveDisplayBlockStatus({ status: "running" }, false), "unknown");
  assert.equal(ctx.resolveDisplayBlockStatus({ status: "pending" }, false), "unknown");
  assert.equal(ctx.resolveDisplayBlockStatus({ status: "completed" }, false), "completed");
});

test("timeline final text remains the authoritative visible answer after completion", () => {
  const blocks = [
    { id: "process", type: "stream-text", phase: "process", text: "Inspecting." },
    { id: "tool", type: "tool", status: "completed" },
    { id: "final", type: "stream-text", phase: "final", text: "Done." },
  ];

  assert.equal(blockUtilsMethods.hasTimelineFinalBlock(blocks), true);
  assert.equal(blockUtilsMethods.hasTimelineFinalBlock([{ type: "stream-text", text: "legacy" }]), false);
});

test("timeline presentation folds process entries without changing their chronological array", () => {
  const blocks = [
    { id: "p1", type: "stream-text", phase: "process", text: "Inspecting." },
    { id: "t1", type: "tool", status: "completed" },
    { id: "p2", type: "stream-text", phase: "process", text: "Updating." },
    { id: "t2", type: "tool", status: "completed" },
    { id: "f1", type: "stream-text", phase: "final", text: "Done." },
  ];

  const presentation = blockUtilsMethods.classifyAssistantTimelineBlocks(blocks);

  assert.equal(presentation.hasFinal, true);
  assert.deepEqual(presentation.processIndexes, [0, 1, 2, 3]);
  assert.deepEqual(presentation.finalIndexes, [4]);
  assert.equal(presentation.toolCount, 2);
  assert.deepEqual(blocks.map((block) => block.id), ["p1", "t1", "p2", "t2", "f1"]);
});

test("assistant layout keeps stats and copy controls below the final answer", () => {
  const row = {
    children: [],
    querySelector(selector) {
      return this.children.find((child) => child.selector === selector) || null;
    },
    appendChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      this.children.push(child);
      child.parentElement = this;
    },
  };
  const child = (selector) => ({ selector, parentElement: row });
  row.children = [
    child(".oc-msg-head"),
    child(".oc-message-meta"),
    child(".oc-message-content"),
    child(".oc-part-list"),
    child(".oc-assistant-msg-actions"),
  ];

  blockUtilsMethods.reorderAssistantMessageLayout(row);

  assert.deepEqual(row.children.map((item) => item.selector), [
    ".oc-msg-head",
    ".oc-part-list",
    ".oc-message-content",
    ".oc-message-meta",
    ".oc-assistant-msg-actions",
  ]);
});
