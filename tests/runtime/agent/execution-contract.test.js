const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WORKFLOW_FINISH_TOOL_NAME,
  WORKFLOW_FINISH_TOOL_SPEC,
  createExplicitSkillWorkflowContract,
  createExecutionState,
  normalizeWorkflowFinishDeclaration,
  recordExecutionReceipt,
  deriveHostExecutionMinimum,
  enforceHostContractMinimum,
  resolveTurnExecutionContract,
  validateWorkflowFinish,
} = require("../../../runtime/agent/execution-contract");

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

test("standard skill answer completion is verified without requiring private metadata", () => {
  const contract = createExplicitSkillWorkflowContract({
    skillName: "third-party-answer",
    command: "/third-party-answer",
  });

  assert.deepEqual(
    validateWorkflowFinish(
      { status: "completed", mode: "answer", reason: "Answered" },
      [],
      contract,
    ),
    {
      ok: true,
      error: "",
      verified: true,
      verification: { state: "verified", policy: "standard_skill_protocol" },
    },
  );
});

test("standard skill inspect and effect completion still require matching host receipts", () => {
  const contract = createExplicitSkillWorkflowContract({
    skillName: "third-party-workflow",
    command: "/third-party-workflow",
  });

  assert.match(
    validateWorkflowFinish(
      { status: "completed", mode: "inspect", reason: "Read it" },
      [],
      contract,
    ).error,
    /verified observation receipt/,
  );
  assert.equal(
    validateWorkflowFinish(
      { status: "completed", mode: "inspect", reason: "Read it" },
      [{ kind: "observation", verified: true, paths: ["Note.md"] }],
      contract,
    ).verified,
    true,
  );
  assert.match(
    validateWorkflowFinish(
      { status: "completed", mode: "effect", reason: "Saved it" },
      [{ kind: "observation", verified: true, paths: ["Note.md"] }],
      contract,
    ).error,
    /verified effect receipt/,
  );
  assert.equal(
    validateWorkflowFinish(
      { status: "completed", mode: "effect", reason: "Saved it" },
      [{ kind: "vault_mutation", verified: true, paths: ["Note.md"] }],
      contract,
    ).verified,
    true,
  );
});

test("standard skill cannot hide an observed mutation behind answer or inspect completion", () => {
  const contract = createExplicitSkillWorkflowContract({
    skillName: "third-party-workflow",
    command: "/third-party-workflow",
  });
  const receipts = [{ kind: "vault_mutation", verified: true, paths: ["Note.md"] }];

  assert.match(
    validateWorkflowFinish(
      { status: "completed", mode: "answer", reason: "Just an answer" },
      receipts,
      contract,
    ).error,
    /must declare effect/,
  );
  assert.match(
    validateWorkflowFinish(
      { status: "completed", mode: "inspect", reason: "Only inspected" },
      receipts,
      contract,
    ).error,
    /must declare effect/,
  );
});

test("an interaction-required skill cannot invent blocked or complete before asking the user", () => {
  const contract = createExplicitSkillWorkflowContract({
    skillName: "ah-note",
    command: "/ah-note",
    completionPolicy: {
      state: "declared",
      mode: "effect",
      requiredEffects: [],
      requiredInteractions: ["ask_user"],
      minReceipts: null,
      errorCode: null,
    },
  });
  const effectReceipts = [{ kind: "vault_mutation", verified: true, paths: ["Daily.md"] }];

  assert.equal(
    normalizeWorkflowFinishDeclaration({ status: "blocked", reason: "Waiting for confirmation" }),
    null,
  );
  assert.match(
    validateWorkflowFinish(
      { status: "completed", mode: "effect", reason: "Done" },
      effectReceipts,
      contract,
      [],
    ).error,
    /ask_user interaction/i,
  );
  assert.equal(
    validateWorkflowFinish(
      { status: "completed", mode: "effect", reason: "Done" },
      effectReceipts,
      contract,
      [{ tool: "ask_user", toolUseId: "ask-1", verified: true }],
    ).verified,
    true,
  );
});

test("workflow finish declarations have a strict internal tool schema", () => {
  assert.equal(WORKFLOW_FINISH_TOOL_NAME, "flownote_finish_skill");
  assert.equal(WORKFLOW_FINISH_TOOL_SPEC.name, WORKFLOW_FINISH_TOOL_NAME);
  assert.deepEqual(WORKFLOW_FINISH_TOOL_SPEC.input_schema.required, ["status"]);
  assert.deepEqual(
    WORKFLOW_FINISH_TOOL_SPEC.input_schema.properties.status.enum,
    ["completed", "cancelled"],
  );
  assert.deepEqual(
    WORKFLOW_FINISH_TOOL_SPEC.input_schema.properties.mode.enum,
    ["answer", "inspect", "effect"],
  );
  assert.deepEqual(WORKFLOW_FINISH_TOOL_SPEC.input_schema.properties.target_paths.items, { type: "string" });

  assert.deepEqual(
    normalizeWorkflowFinishDeclaration({
      status: "completed",
      mode: "effect",
      target_paths: ["/Cards\\new.md", "Cards/new.md"],
      reason: "Saved",
    }),
    { status: "completed", mode: "effect", targetPaths: ["Cards/new.md"], reason: "Saved" },
  );
  assert.equal(normalizeWorkflowFinishDeclaration({ status: "blocked", reason: "Needs a path" }), null);
  assert.equal(normalizeWorkflowFinishDeclaration({ status: "completed" }), null);
  assert.equal(normalizeWorkflowFinishDeclaration({ status: "blocked", mode: "effect" }), null);
  assert.equal(normalizeWorkflowFinishDeclaration({ status: "done", mode: "answer" }), null);
  assert.equal(normalizeWorkflowFinishDeclaration({ status: "completed", mode: "answer", reason: 7 }), null);
  assert.equal(normalizeWorkflowFinishDeclaration({ status: "completed", mode: "answer", invented: true }), null);
});

test("workflow receipts stay provisional until a valid finish declaration", () => {
  const contract = createExplicitSkillWorkflowContract({ skillName: "ah-card", command: "/ah-card" });
  const state = createExecutionState(contract);
  state.provisionalText = "claimed complete";

  recordExecutionReceipt(state, contract, {
    kind: "observation",
    tool: "vault_read",
    verified: true,
  });

  assert.equal(state.effectReceipts.length, 1);
  assert.equal(state.effectVerified, false);
  assert.equal(state.provisionalText, "claimed complete");
});

test("host intent floor recognizes explicit vault mutations without treating how-to questions as effects", () => {
  assert.deepEqual(
    deriveHostExecutionMinimum("把总结写入 A.md"),
    { mode: "effect", targetPaths: ["A.md"], source: "explicit_vault_mutation" },
  );
  assert.deepEqual(
    deriveHostExecutionMinimum("Please rename Notes/old.md to Notes/new.md"),
    {
      mode: "effect",
      targetPaths: ["Notes/old.md", "Notes/new.md"],
      source: "explicit_vault_mutation",
    },
  );
  assert.deepEqual(
    deriveHostExecutionMinimum("帮我新建一篇项目笔记"),
    { mode: "effect", targetPaths: [], source: "explicit_vault_mutation" },
  );
  assert.equal(deriveHostExecutionMinimum("如何把总结写入 A.md？"), null);
  assert.equal(deriveHostExecutionMinimum("Explain how to delete Notes/old.md"), null);
  assert.equal(deriveHostExecutionMinimum("请帮我总结这篇文章"), null);
  assert.equal(deriveHostExecutionMinimum("设置笔记的最佳方式是什么？"), null);
  assert.equal(deriveHostExecutionMinimum("What is the best way to edit a note?"), null);
  assert.equal(deriveHostExecutionMinimum("Should I delete Notes/old.md?"), null);
  assert.deepEqual(
    deriveHostExecutionMinimum("可以帮我删除 A.md 吗？"),
    { mode: "effect", targetPaths: ["A.md"], source: "explicit_vault_mutation" },
  );
  for (const request of [
    "帮我记一下：今天完成了发布",
    "把上面这段整理后存到今天的日记里",
    "Please make a note of this: the release is complete",
    "Save the summary to today's daily note",
    "Запиши: сегодня завершён релиз",
    "Сохрани это в сегодняшний дневник",
  ]) {
    assert.deepEqual(
      deriveHostExecutionMinimum(request),
      { mode: "effect", targetPaths: [], source: "implicit_vault_capture" },
      request,
    );
  }
  for (const question of [
    "怎么记一下比较好？",
    "What is the best way to make a note?",
    "Should I save this to my daily note?",
    "Как лучше записать это в дневник?",
  ]) {
    assert.equal(deriveHostExecutionMinimum(question), null, question);
  }
});

test("host minimum can only upgrade a model contract and carries explicit target paths", () => {
  const upgraded = enforceHostContractMinimum(
    { id: "task-1", mode: "answer", requiredEffects: [], source: "model_control_tool" },
    { mode: "effect", targetPaths: ["A.md"], source: "explicit_vault_mutation" },
  );
  assert.equal(upgraded.mode, "effect");
  assert.deepEqual(upgraded.requiredEffects, [{ kind: "vault_mutation", targetPaths: ["A.md"] }]);
  assert.equal(upgraded.source, "model_control_tool+host_minimum");
  assert.equal(upgraded.hostMinimum.source, "explicit_vault_mutation");

  const alreadyStrict = enforceHostContractMinimum(
    { id: "task-2", mode: "effect", requiredEffects: [{ kind: "vault_mutation", targetPaths: ["B.md"] }] },
    { mode: "answer", targetPaths: [], source: "ui_answer" },
  );
  assert.equal(alreadyStrict.mode, "effect");
  assert.deepEqual(alreadyStrict.requiredEffects, [{ kind: "vault_mutation", targetPaths: ["B.md"] }]);
});

test("host capture intent overrides a model classifier that incorrectly returns answer", async () => {
  for (const userText of [
    "帮我记一下：今天完成了发布",
    "把上面这段整理后存到今天的日记里",
  ]) {
    const contract = await resolveTurnExecutionContract({
      resolver: async () => ({
        id: "model-answer",
        mode: "answer",
        requiredEffects: [],
        source: "model_control_tool",
      }),
      provider: {},
      userText,
    });
    assert.equal(contract.mode, "effect", userText);
    assert.deepEqual(contract.requiredEffects, [{ kind: "vault_mutation", targetPaths: [] }]);
    assert.equal(contract.hostMinimum.source, "implicit_vault_capture");
  }
});
