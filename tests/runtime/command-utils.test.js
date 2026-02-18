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
