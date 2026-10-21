const test = require("node:test");
const assert = require("node:assert/strict");

const { createExplicitSkillWorkflowContract } = require("../../../runtime/agent/execution-contract");

test("explicit standard skills create a local workflow contract", () => {
  const contract = createExplicitSkillWorkflowContract({
    skillName: "ah-card",
    command: "/ah-card",
    args: "",
    completionPolicy: {
      state: "declared",
      mode: "effect",
      requiredEffects: ["vault_mutation"],
      requiredInteractions: ["ask_user"],
      minReceipts: 2,
      errorCode: null,
    },
  });

  assert.equal(contract.mode, "workflow");
  assert.equal(contract.source, "explicit_skill");
  assert.equal(contract.skillName, "ah-card");
  assert.equal(contract.command, "/ah-card");
  assert.equal(contract.args, "");
  assert.equal(contract.completionMode, "effect");
  assert.deepEqual(contract.requiredEffects, [{ kind: "vault_mutation", targetPaths: [] }]);
  assert.deepEqual(contract.requiredInteractions, ["ask_user"]);
  assert.equal(contract.minReceipts, 2);
  assert.equal(contract.completionPolicyState, "declared");
  assert.match(contract.id, /^skill-/);
});

test("invalid skill completion metadata fails closed with a stable host error code", () => {
  assert.throws(
    () => createExplicitSkillWorkflowContract({
      skillName: "broken-skill",
      command: "/broken-skill",
      completionPolicy: {
        state: "invalid",
        mode: null,
        requiredEffects: [],
        minReceipts: null,
        errorCode: "invalid_completion_mode",
      },
    }),
    (error) => {
      assert.equal(error.code, "SKILL_COMPLETION_METADATA_INVALID");
      assert.equal(error.metadataErrorCode, "invalid_completion_mode");
      return true;
    },
  );
});

test("standard skills without FLOWnote metadata use the host protocol compatibility contract", () => {
  const contract = createExplicitSkillWorkflowContract({
    skillName: "third-party-skill",
    command: "/third-party-skill",
    completionPolicy: {
      state: "legacy_unclassified",
      mode: null,
      requiredEffects: [],
      minReceipts: null,
      errorCode: null,
    },
  });

  assert.equal(contract.completionPolicyState, "legacy_unclassified");
  assert.equal(contract.completionMode, null);
  assert.equal(contract.verificationMode, "standard_protocol");
});
