const test = require("node:test");
const assert = require("node:assert/strict");

const { runtimeStatusMethods } = require("../../runtime/view/runtime-status");

function statusContext() {
  return {
    visibleAssistantBlocks: (blocks) => Array.isArray(blocks) ? blocks : [],
    normalizeBlockStatus: (value) => String(value || "pending"),
    toolDisplayName: (block) => block.tool,
    plugin: { getEffectiveLocale: () => "en" },
  };
}

test("runtime status names only the currently running tool", () => {
  const ctx = statusContext();
  const result = runtimeStatusMethods.runtimeStatusFromBlocks.call(ctx, [
    { type: "tool", tool: "vault_read", status: "completed" },
    { type: "tool", tool: "vault_write", status: "running" },
  ]);

  assert.equal(result.tone, "working");
  assert.match(result.text, /vault_write/);
  assert.doesNotMatch(result.text, /vault_read/);
});

test("preparing the final response remains an animated working state", () => {
  const ctx = statusContext();
  const reasoningDone = runtimeStatusMethods.runtimeStatusFromBlocks.call(ctx, [
    { type: "reasoning", status: "completed" },
  ]);
  const toolDone = runtimeStatusMethods.runtimeStatusFromBlocks.call(ctx, [
    { type: "tool", tool: "vault_read", status: "completed" },
  ]);

  assert.equal(reasoningDone.tone, "working");
  assert.equal(toolDone.tone, "working");
});

test("a recovered historical tool failure never pollutes current turn status", () => {
  const ctx = statusContext();
  const result = runtimeStatusMethods.runtimeStatusFromBlocks.call(ctx, [
    { type: "tool", tool: "vault_read", status: "error" },
    { type: "tool", tool: "vault_read", status: "completed" },
  ]);

  assert.equal(result.tone, "working");
  assert.match(result.text, /preparing/i);
  assert.doesNotMatch(result.text, /failed/i);
});

test("a failed attempt projects animated recovery while the turn is pending", () => {
  const ctx = statusContext();
  const result = runtimeStatusMethods.runtimeStatusFromBlocks.call(ctx, [
    { type: "tool", tool: "vault_read", status: "error" },
  ]);

  assert.equal(result.tone, "working");
  assert.match(result.text, /another approach/i);
  assert.doesNotMatch(result.text, /failed/i);
});

test("streaming text after a tool failure becomes the current status", () => {
  const ctx = statusContext();
  const result = runtimeStatusMethods.runtimeStatusFromBlocks.call(ctx, [
    { type: "tool", tool: "vault_read", status: "error" },
    { type: "stream-text", phase: "streaming", status: "running", text: "Working" },
  ]);

  assert.equal(result.tone, "working");
  assert.match(result.text, /generating/i);
  assert.doesNotMatch(result.text, /failed/i);
});

function fakeStatusRow(messageId) {
  const bodyAttributes = new Map();
  const body = {
    removeClass() {},
    addClass() {},
    setAttribute(name, value) { bodyAttributes.set(name, value); },
    removeAttribute(name) { bodyAttributes.delete(name); },
  };
  let status = null;
  const row = {
    dataset: { messageId },
    querySelector(selector) {
      if (selector === ".oc-message-content") return body;
      if (selector === ".oc-runtime-status") return status;
      return null;
    },
    createDiv() {
      const attributes = new Map();
      const classes = new Set(["oc-runtime-status"]);
      status = {
        parentElement: row,
        text: "",
        setText(value) { this.text = value; },
        addClass(value) { classes.add(value); },
        removeClass(...values) { values.forEach((value) => classes.delete(value)); },
        setAttribute(name, value) { attributes.set(name, value); },
        remove() { status = null; },
        attributes,
        classes,
      };
      return status;
    },
  };
  return { row, bodyAttributes, getStatus: () => status };
}

test("activity rail keeps an independent pending runtime status", () => {
  const fixture = fakeStatusRow("draft-1");
  const ctx = {
    ...statusContext(),
    elements: { messages: { querySelectorAll: () => [fixture.row] } },
    plugin: {
      ...statusContext().plugin,
      sessionStore: {
        getActiveMessages: () => [{
          id: "draft-1",
          pending: true,
          text: "",
          blocks: [{ type: "tool", tool: "vault_read", status: "running" }],
        }],
      },
    },
    runtimeStatusState: { text: "Running: vault_read", tone: "working" },
  };

  runtimeStatusMethods.syncRuntimeStatusToPendingMessage.call(ctx);
  const status = fixture.getStatus();
  assert.equal(status.text, "Running: vault_read");
  assert.equal(status.attributes.get("role"), "status");
  assert.equal(status.attributes.get("aria-live"), "polite");
  assert.equal(status.classes.has("is-working"), true);
  assert.deepEqual(Object.fromEntries(fixture.bodyAttributes), {});
});

test("streamed assistant text is never exposed as an aria-live region", () => {
  const fixture = fakeStatusRow("draft-stream");
  fixture.bodyAttributes.set("role", "status");
  fixture.bodyAttributes.set("aria-live", "polite");
  fixture.bodyAttributes.set("aria-atomic", "true");
  const ctx = {
    ...statusContext(),
    elements: { messages: { querySelectorAll: () => [fixture.row] } },
    plugin: {
      ...statusContext().plugin,
      sessionStore: {
        getActiveMessages: () => [{ id: "draft-stream", pending: true, text: "partial token", blocks: [] }],
      },
    },
    runtimeStatusState: { text: "Generating response...", tone: "working" },
  };

  runtimeStatusMethods.syncRuntimeStatusToPendingMessage.call(ctx);
  assert.deepEqual(Object.fromEntries(fixture.bodyAttributes), {});
  assert.deepEqual(Object.fromEntries(fixture.getStatus().attributes), {
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
});
