const test = require("node:test");
const assert = require("node:assert/strict");

const {
  availableCommandSet,
  findLatestAssistantMessage,
  parseCommandModel,
  parseModel,
  parseSlashCommand,
  resolveCommandFromSet,
} = require("../../runtime/transports/shared/command-utils");

test("parseModel should parse provider/model format", () => {
  assert.deepEqual(parseModel("openai/gpt-4.1"), { providerID: "openai", modelID: "gpt-4.1" });
  assert.equal(parseModel("gpt-4.1"), undefined);
  assert.equal(parseCommandModel("openai/gpt-4.1"), "openai/gpt-4.1");
});

test("parseSlashCommand should parse command and arguments", () => {
  assert.deepEqual(parseSlashCommand("/models gpt-4.1"), { command: "models", arguments: "gpt-4.1" });
  assert.deepEqual(parseSlashCommand("/skills"), { command: "skills", arguments: "" });
  assert.equal(parseSlashCommand("hello"), null);
});

test("resolveCommandFromSet should support alias fallback", () => {
  const names = availableCommandSet([{ name: "/models" }]);
  assert.deepEqual(resolveCommandFromSet("modle", names), { use: true, command: "models" });
  assert.deepEqual(resolveCommandFromSet("unknown", names), { use: false, command: "unknown" });
});

test("findLatestAssistantMessage should pick newest assistant message", () => {
  const latest = findLatestAssistantMessage(
    [
      { info: { role: "assistant", time: { created: 1000 }, id: "a1" } },
      { info: { role: "assistant", time: { created: 2000 }, id: "a2" } },
      { info: { role: "user", time: { created: 3000 }, id: "u1" } },
    ],
    900,
  );

  assert.ok(latest);
  assert.equal(latest.info.id, "a2");
});

test("findLatestAssistantMessage should not drop assistant message when created timestamp is missing", () => {
  const latest = findLatestAssistantMessage(
    [
      { info: { role: "assistant", time: { created: 0 }, id: "a-missing-time" } },
      { info: { role: "user", time: { created: 9999999999999 }, id: "u1" } },
    ],
    Date.now(),
  );

  assert.ok(latest);
  assert.equal(latest.info.id, "a-missing-time");
});

test("findLatestAssistantMessage should support second-based timestamps", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const latest = findLatestAssistantMessage(
    [
      { info: { role: "assistant", time: { created: nowSeconds - 3 }, id: "a1" } },
      { info: { role: "assistant", time: { created: nowSeconds }, id: "a2" } },
    ],
    Date.now() - 5000,
  );

  assert.ok(latest);
  assert.equal(latest.info.id, "a2");
});

test("findLatestAssistantMessage should support wrapped message shape", () => {
  const latest = findLatestAssistantMessage(
    [
      { message: { id: "a1", role: "assistant", time: { created: 1000 } } },
      { message: { id: "a2", role: "assistant", time: { created: 2000 } } },
      { message: { id: "u1", role: "user", time: { created: 3000 } } },
    ],
    900,
  );

  assert.ok(latest);
  assert.equal(latest.message.id, "a2");
});

test("findLatestAssistantMessage should accept assistant type field when role is missing", () => {
  const latest = findLatestAssistantMessage(
    [
      { info: { id: "a1", type: "assistant", time: { created: 1000 } } },
      { info: { id: "u1", type: "user", time: { created: 2000 } } },
    ],
    900,
  );

  assert.ok(latest);
  assert.equal(latest.info.id, "a1");
});

test("findLatestAssistantMessage should fallback to message with error when assistant role is missing", () => {
  const latest = findLatestAssistantMessage(
    [
      { info: { id: "u1", role: "user", time: { created: 1000 } } },
      { info: { id: "e1", time: { created: 2000 }, error: { name: "APIError", data: { message: "bad" } } } },
    ],
    900,
  );

  assert.ok(latest);
  assert.equal(latest.info.id, "e1");
});
