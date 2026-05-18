const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeToolPermissionMode,
  isDangerousToolUse,
  resolvePermissionDecision,
  resolvePermissionRequestDecision,
} = require("../../../runtime/agent/permission-policy");

test("normalizeToolPermissionMode keeps strict as the default", () => {
  assert.equal(normalizeToolPermissionMode(undefined), "ask");
  assert.equal(normalizeToolPermissionMode("weird"), "ask");
  assert.equal(normalizeToolPermissionMode("dangerous"), "ask-dangerous");
  assert.equal(normalizeToolPermissionMode("full-auto"), "auto");
});

test("isDangerousToolUse classifies common vault operations", () => {
  assert.equal(isDangerousToolUse({ toolName: "vault_write", input: { mode: "create" } }), false);
  assert.equal(isDangerousToolUse({ toolName: "vault_write", input: { mode: "append" } }), false);
  assert.equal(isDangerousToolUse({ toolName: "vault_write", input: { mode: "overwrite" } }), true);
  assert.equal(isDangerousToolUse({ toolName: "vault_move", input: {} }), true);
  assert.equal(isDangerousToolUse({ toolName: "vault_edit", input: { replace_all: true } }), true);
  assert.equal(isDangerousToolUse({ toolName: "vault_property", input: { op: "delete" } }), true);
});

test("isDangerousToolUse treats routine web POST as low-risk but mutating methods as dangerous", () => {
  assert.equal(isDangerousToolUse({ toolName: "web_fetch", input: { url: "https://example.com" } }), false);
  assert.equal(isDangerousToolUse({ toolName: "web_request", input: { method: "POST" } }), false);
  assert.equal(isDangerousToolUse({ toolName: "web_request", input: { method: "DELETE" } }), true);
  assert.equal(isDangerousToolUse({ toolName: "web_request", input: { method: "PATCH" } }), true);
});

test("resolvePermissionDecision applies strict, dangerous-only, and auto modes", () => {
  assert.equal(
    resolvePermissionDecision({
      mode: "ask",
      toolName: "web_fetch",
      input: {},
      permission: { behavior: "ask" },
    }).behavior,
    "ask",
  );
  assert.equal(
    resolvePermissionDecision({
      mode: "ask-dangerous",
      toolName: "web_request",
      input: { method: "POST" },
      permission: { behavior: "ask" },
    }).behavior,
    "allow",
  );
  assert.equal(
    resolvePermissionDecision({
      mode: "ask-dangerous",
      toolName: "vault_move",
      input: {},
      permission: { behavior: "ask" },
    }).behavior,
    "ask",
  );
  assert.equal(
    resolvePermissionDecision({
      mode: "auto",
      toolName: "vault_move",
      input: {},
      permission: { behavior: "ask" },
    }).behavior,
    "allow",
  );
});

test("resolvePermissionRequestDecision reads OpenCode-style permission objects", () => {
  const lowRisk = resolvePermissionRequestDecision("ask-dangerous", {
    type: "web_request",
    metadata: { method: "POST", url: "https://i.weread.qq.com/api/agent/gateway" },
  });
  assert.equal(lowRisk.behavior, "allow");

  const dangerous = resolvePermissionRequestDecision("ask-dangerous", {
    type: "vault_write",
    metadata: { mode: "overwrite", path: "x.md" },
  });
  assert.equal(dangerous.behavior, "ask");
});
