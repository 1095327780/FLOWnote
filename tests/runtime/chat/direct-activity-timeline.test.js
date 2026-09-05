const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDirectActivityTimeline,
} = require("../../../runtime/chat/direct-activity-timeline");

test("direct activity timeline keeps text and tools in first-seen order while updating tools in place", () => {
  const timeline = createDirectActivityTimeline("draft-1");

  timeline.appendText("I will inspect the note.");
  timeline.startTool({
    id: "read-1",
    name: "vault_read",
    input: { path: "Daily.md" },
    status: "running",
  });
  timeline.finishTool("read-1", { status: "done", durationMs: 12 });
  timeline.completeTurn();

  timeline.appendText("I found the target and will update it.");
  timeline.startTool({
    id: "edit-1",
    name: "vault_edit",
    input: { path: "Daily.md" },
    status: "running",
  });
  const beforeFinish = timeline.blocks();
  timeline.finishTool("edit-1", { status: "done", durationMs: 18 });
  timeline.completeTurn();

  timeline.appendText("Updated Daily.md.");
  timeline.completeTurn();
  const settled = timeline.settle("Updated Daily.md.");

  assert.deepEqual(
    settled.map((block) => `${block.type}:${block.id}`),
    [
      "stream-text:direct:draft-1:turn:0:text:0",
      "tool:read-1",
      "stream-text:direct:draft-1:turn:1:text:0",
      "tool:edit-1",
      "stream-text:direct:draft-1:turn:2:text:0",
    ],
  );
  assert.equal(settled[0].phase, "process");
  assert.equal(settled[2].phase, "process");
  assert.equal(settled[4].phase, "final");
  assert.equal(settled[4].text, "Updated Daily.md.");
  assert.equal(beforeFinish.find((block) => block.id === "edit-1").id, "edit-1");
  assert.equal(settled.find((block) => block.id === "edit-1").status, "completed");
});

test("direct activity timeline never moves a tool when a later text segment streams", () => {
  const timeline = createDirectActivityTimeline("draft-2");
  timeline.startTool({ id: "read-1", name: "vault_read", input: { path: "A.md" }, status: "running" });
  timeline.finishTool("read-1", { status: "done" });
  timeline.completeTurn();

  timeline.appendText("First half");
  const first = timeline.blocks();
  timeline.appendText(" and second half");
  const second = timeline.blocks();

  assert.equal(first[0].id, "read-1");
  assert.equal(second[0].id, "read-1");
  assert.equal(first[1].id, second[1].id);
  assert.equal(second[1].text, "First half and second half");
});

test("direct activity timeline creates a terminal fallback without regrouping earlier activity", () => {
  const timeline = createDirectActivityTimeline("draft-3");
  timeline.startTool({ id: "read-1", name: "vault_read", input: { path: "A.md" }, status: "running" });
  timeline.finishTool("read-1", { status: "done" });
  timeline.completeTurn();

  const settled = timeline.settle("The workflow paused. Continue when ready.");

  assert.deepEqual(settled.map((block) => block.type), ["tool", "stream-text"]);
  assert.equal(settled[0].id, "read-1");
  assert.equal(settled[1].phase, "final");
});
