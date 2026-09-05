const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeToolActivity,
  toolActivityKey,
  blockActivityKey,
  blockRenderSignature,
} = require("../../runtime/view/message/tool-activity");

test("normalizes Direct and bridge tool blocks into the same user activity", () => {
  const direct = normalizeToolActivity({
    id: "call-direct",
    type: "tool",
    tool: "vault_read",
    status: "completed",
    input: { path: "Projects/Launch plan.md" },
    output: "42 lines",
    durationMs: 1250,
  });
  const bridge = normalizeToolActivity({
    id: "tool:call-bridge",
    type: "tool",
    tool: "read",
    status: "completed",
    toolInput: { filePath: "Projects/Launch plan.md" },
    toolOutput: "42 lines",
    raw: { state: { input: { filePath: "Projects/Launch plan.md" }, output: "42 lines" } },
  });

  assert.equal(direct.kind, "read");
  assert.equal(bridge.kind, "read");
  assert.equal(direct.labelKey, "vault_read");
  assert.equal(bridge.labelKey, "vault_read");
  assert.equal(direct.target, "Projects/Launch plan.md");
  assert.equal(bridge.target, "Projects/Launch plan.md");
  assert.equal(direct.icon, "file-text");
  assert.equal(direct.durationLabel, "1.3s");
});

test("keeps raw input out of the primary activity detail", () => {
  const activity = normalizeToolActivity({
    type: "tool",
    tool: "write",
    status: "completed",
    toolInput: { filePath: "Weekly.md", content: "private draft" },
    toolOutput: "Updated Weekly.md",
    detail: "输入:\n{\"content\":\"private draft\"}\n输出:\nUpdated Weekly.md",
  });

  assert.equal(activity.kind, "edit");
  assert.equal(activity.target, "Weekly.md");
  assert.equal(activity.detail, "Updated Weekly.md");
  assert.equal(activity.isMutation, true);
  assert.doesNotMatch(activity.detail, /private draft|输入/);
});

test("derives compact targets for search, command, move, and interactive tools", () => {
  assert.equal(normalizeToolActivity({ tool: "grep", input: { pattern: "release", path: "Notes" } }).target, "“release” · Notes");
  assert.equal(normalizeToolActivity({ tool: "bash", input: { command: "npm test" } }).target, "npm test");
  assert.equal(normalizeToolActivity({ tool: "vault_move", input: { from: "Old.md", to: "New.md" } }).target, "Old.md → New.md");
  assert.equal(normalizeToolActivity({ tool: "question", input: { questions: [{ question: "继续吗？" }] } }).interactive, true);
});

test("uses structured verification and stable call ids without inventing success", () => {
  const verified = normalizeToolActivity({
    id: "call-7",
    tool: "vault_write",
    status: "completed",
    input: { path: "Verified.md" },
    verified: true,
  });
  const unverified = normalizeToolActivity({
    id: "call-8",
    tool: "vault_write",
    status: "completed",
    input: { path: "Unverified.md" },
  });

  assert.equal(verified.verified, true);
  assert.equal(unverified.verified, false);
  assert.equal(toolActivityKey({ id: "call-7", tool: "vault_write" }, 3), "tool:call-7");
  assert.equal(toolActivityKey({ tool: "vault_read" }, 3), "tool:vault_read:3");
});

test("typed tool capabilities drive future-tool presentation without UI name lists", () => {
  const activity = normalizeToolActivity({
    id: "future-1",
    tool: "future_tool_not_in_ui_maps",
    status: "completed",
    capabilities: {
      effect: "external_side_effect",
      risk: "medium",
      concurrency: "serial",
      presentation: "execute",
      targets: ["remote:item"],
    },
    verified: true,
  });

  assert.equal(activity.kind, "execute");
  assert.equal(activity.isMutation, true);
  assert.equal(activity.target, "remote:item");
  assert.equal(activity.verified, true);
});

test("keeps one entry id while its render state advances", () => {
  const running = { id: "call-9", type: "tool", tool: "vault_search", status: "running", output: "1 match" };
  const completed = { ...running, status: "completed", output: "3 matches" };

  assert.equal(blockActivityKey(running, 0), blockActivityKey(completed, 0));
  assert.notEqual(blockRenderSignature(running, true), blockRenderSignature(completed, true));
});

test("does not replace a stable completed node only because its message finalized", () => {
  const completed = {
    id: "call-1",
    type: "tool",
    tool: "vault_read",
    status: "completed",
    detail: "ok",
  };

  assert.equal(blockRenderSignature(completed, true), blockRenderSignature(completed, false));
});
