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
