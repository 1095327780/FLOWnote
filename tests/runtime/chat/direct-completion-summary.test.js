const test = require("node:test");
const assert = require("node:assert/strict");

const { buildVerifiedCompletionSummary } = require("../../../runtime/chat/direct-completion-summary");

test("vault_create_dir completion describes the idempotent postcondition without claiming creation", () => {
  const input = {
    effectReceipts: [{
      kind: "vault_mutation",
      toolUseId: "mkdir-1",
      tool: "vault_create_dir",
      paths: ["Projects"],
      verified: true,
    }],
    toolUses: [{ id: "mkdir-1", name: "vault_create_dir", input: { path: "Projects" } }],
  };

  assert.match(buildVerifiedCompletionSummary({ ...input, locale: "zh-CN" }), /确保文件夹存在 `Projects`/);
  assert.match(buildVerifiedCompletionSummary({ ...input, locale: "en" }), /Ensured folder exists `Projects`/);
  assert.doesNotMatch(buildVerifiedCompletionSummary({ ...input, locale: "en" }), /Created folder/);
});
