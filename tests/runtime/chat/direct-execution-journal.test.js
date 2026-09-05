const test = require("node:test");
const assert = require("node:assert/strict");

const { DirectExecutionJournal } = require("../../../runtime/chat/direct-execution-journal");
const { reduceExecutionEvents } = require("../../../runtime/agent/execution-ledger");

test("maps direct loop events into one durable typed run", async () => {
  const snapshots = [];
  const journal = new DirectExecutionJournal({
    runId: "draft-1",
    now: () => 10,
    onSnapshot: async (snapshot) => snapshots.push(snapshot),
  });

  await journal.start({ id: "contract-1", mode: "effect" });
  await journal.consume({
    type: "tool_start",
    toolUseId: "call-1",
    tool: "vault_write",
    input: { path: "x.md" },
    capabilities: { effect: "vault_mutation", risk: "medium", concurrency: "serial", presentation: "edit", targets: ["x.md"] },
  });
  await journal.consume({ type: "tool_finish", toolUseId: "call-1", tool: "vault_write", content: "copy is irrelevant", isError: false, outcome: { state: "completed" } });
  await journal.consume({ type: "effect_receipt", receipt: { toolUseId: "call-1", verified: true, paths: ["x.md"] } });
  await journal.consume({ type: "completion_retry", attempt: 1 });
  await journal.consume({ type: "done" });

  const run = reduceExecutionEvents(journal.events).runs["draft-1"];
  assert.equal(run.status, "completed");
  assert.equal(run.tools["call-1"].effect.status, "verified");
  assert.deepEqual(run.completionDecisions, ["rejected", "accepted"]);
  assert.ok(snapshots.length >= 6);
});

test("records cancellation as a terminal machine state", async () => {
  const journal = new DirectExecutionJournal({ runId: "draft-cancel", now: () => 20 });
  await journal.start(null);
  await journal.consume({ type: "cancelled", stage: "before_model" });
  const run = reduceExecutionEvents(journal.events).runs["draft-cancel"];
  assert.equal(run.cancelRequested, true);
  assert.equal(run.status, "cancelled");
});

test("records a blocked workflow without accepting completion, even when done repeats the disposition", async () => {
  const journal = new DirectExecutionJournal({ runId: "draft-blocked", now: () => 30 });
  await journal.start({ id: "skill-ah-card", mode: "workflow", source: "explicit_skill" });
  await journal.consume({
    type: "workflow_finish",
    disposition: "blocked",
    declaration: { explanation: "Choose a destination before I can continue." },
    verified: true,
  });
  await journal.consume({ type: "done", disposition: "blocked" });

  const run = reduceExecutionEvents(journal.events).runs["draft-blocked"];
  assert.equal(run.status, "blocked");
  assert.equal(run.disposition, "blocked");
  assert.equal(run.completion, null);
  assert.equal(journal.events.some((event) => event.type === "completion_accepted"), false);
});

test("accepts workflow completion only after workflow_finish is verified", async () => {
  const verified = new DirectExecutionJournal({ runId: "draft-completed", now: () => 40 });
  await verified.start({ id: "skill-ah-card", mode: "workflow" });
  await verified.consume({ type: "workflow_finish", disposition: "completed", verified: true });
  await verified.consume({ type: "done", disposition: "completed" });
  const completedRun = reduceExecutionEvents(verified.events).runs["draft-completed"];
  assert.equal(completedRun.status, "completed");
  assert.deepEqual(completedRun.completionDecisions, ["accepted"]);

  const unverified = new DirectExecutionJournal({ runId: "draft-unverified", now: () => 50 });
  await unverified.start({ id: "skill-ah-card", mode: "workflow" });
  await unverified.consume({ type: "workflow_finish", disposition: "completed", verified: false });
  const failedRun = reduceExecutionEvents(unverified.events).runs["draft-unverified"];
  assert.equal(failedRun.status, "failed");
  assert.equal(failedRun.completion, "rejected");
  assert.equal(unverified.events.some((event) => event.type === "completion_accepted"), false);
});

test("records suspension with its exact continuation reference instead of failing the run", async () => {
  const checkpointRef = {
    version: 1,
    id: `sha256:${"b".repeat(64)}`,
    path: `.obsidian/plugins/flownote/continuations/${"b".repeat(64)}.json`,
    byteLength: 2048,
  };
  const journal = new DirectExecutionJournal({ runId: "draft-suspended", now: () => 60 });
  await journal.start({ id: "skill-ah-card", mode: "workflow" });
  await journal.consume({
    type: "suspended",
    reason: "turn_boundary",
    stage: "between_turns",
    checkpointRef,
  });

  const run = reduceExecutionEvents(journal.events).runs["draft-suspended"];
  assert.equal(run.status, "suspended");
  assert.deepEqual(run.terminalDetail.checkpointRef, checkpointRef);
  assert.equal(Object.hasOwn(run.terminalDetail, "checkpoint"), false);
  assert.equal(journal.events.some((event) => event.type === "run_failed"), false);
});

test("persists a bounded, safe projection instead of raw tool input or output", async () => {
  const snapshots = [];
  const sentinelInput = `INPUT_SECRET_${"x".repeat(500_000)}`;
  const sentinelOutput = `OUTPUT_SECRET_${"y".repeat(500_000)}`;
  const journal = new DirectExecutionJournal({
    runId: "safe-projection",
    now: () => 70,
    onSnapshot: async (snapshot) => snapshots.push(snapshot),
  });

  await journal.start({
    id: "skill-ah-card",
    mode: "workflow",
    args: sentinelInput,
    requiredEffects: [{ kind: "vault_mutation", targetPaths: ["/Cards/../Cards/a.md"] }],
  });
  await journal.consume({
    type: "tool_start",
    toolUseId: "call-secret",
    tool: "vault_write",
    input: { path: "Cards/a.md", content: sentinelInput },
    capabilities: {
      effect: "vault_mutation",
      risk: "medium",
      concurrency: "serial",
      presentation: "edit",
      targets: ["/Cards/../Cards/a.md"],
      untrusted: sentinelInput,
    },
  });
  await journal.consume({
    type: "tool_progress",
    toolUseId: "call-secret",
    message: sentinelOutput,
    data: { raw: sentinelOutput },
  });
  await journal.consume({
    type: "tool_finish",
    toolUseId: "call-secret",
    tool: "vault_write",
    isError: true,
    content: sentinelOutput,
    outcome: {
      state: "failed",
      code: "write_conflict",
      message: sentinelOutput,
      data: { output: sentinelOutput },
      effects: [{ kind: "vault_mutation", targets: ["/Cards/../Cards/a.md"], detail: sentinelOutput }],
    },
  });
  await journal.consume({
    type: "effect_receipt",
    receipt: {
      toolUseId: "call-secret",
      tool: "vault_write",
      kind: "vault_mutation",
      paths: ["/Cards/../Cards/a.md"],
      verified: true,
      outcome: "verified",
      detail: sentinelOutput,
    },
  });
  await journal.consume({ type: "done" });

  const serialized = JSON.stringify(journal.events);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 12 * 1024);
  assert.doesNotMatch(serialized, /INPUT_SECRET|OUTPUT_SECRET/);
  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every((snapshot) => {
    const json = JSON.stringify(snapshot);
    return Buffer.byteLength(json, "utf8") <= 12 * 1024
      && !json.includes("INPUT_SECRET")
      && !json.includes("OUTPUT_SECRET");
  }));

  const run = reduceExecutionEvents(journal.events).runs["safe-projection"];
  assert.equal(run.tools["call-secret"].tool, "vault_write");
  assert.deepEqual(run.tools["call-secret"].capabilities.targets, ["Cards/a.md"]);
  assert.deepEqual(run.tools["call-secret"].outcome, {
    state: "failed",
    code: "write_conflict",
    effects: [{ kind: "vault_mutation", targets: ["Cards/a.md"] }],
  });
  assert.equal(run.tools["call-secret"].effect.status, "verified");
  assert.deepEqual(run.tools["call-secret"].effect.receipt.paths, ["Cards/a.md"]);
});

test("stores a checkpoint reference without checkpoint body when one is supplied", async () => {
  const checkpoint = {
    version: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "CHECKPOINT_SECRET" }] }],
    effectReceipts: [],
    completionRetries: 0,
    turns: 4,
  };
  const journal = new DirectExecutionJournal({ runId: "checkpoint-ref", now: () => 80 });
  await journal.start({ id: "skill-ah-card", mode: "workflow" });
  await journal.consume({
    type: "suspended",
    reason: "turn_boundary",
    checkpoint,
    checkpointRef: {
      version: 1,
      id: `sha256:${"a".repeat(64)}`,
      path: `.obsidian/plugins/flownote/continuations/${"a".repeat(64)}.json`,
      byteLength: 4096,
    },
  });

  const terminal = journal.events.at(-1);
  assert.equal(terminal.type, "run_suspended");
  assert.deepEqual(terminal.checkpointRef, {
    version: 1,
    id: `sha256:${"a".repeat(64)}`,
    path: `.obsidian/plugins/flownote/continuations/${"a".repeat(64)}.json`,
    byteLength: 4096,
  });
  assert.equal(Object.hasOwn(terminal, "checkpoint"), false);
  assert.doesNotMatch(JSON.stringify(journal.events), /CHECKPOINT_SECRET/);
});

test("new durable suspension writes reject a raw checkpoint without a valid reference", async () => {
  const journal = new DirectExecutionJournal({ runId: "raw-checkpoint", now: () => 90 });
  await journal.start({ id: "skill-ah-card", mode: "workflow" });

  await assert.rejects(
    journal.consume({
      type: "suspended",
      reason: "turn_boundary",
      checkpoint: { version: 1, messages: [], effectReceipts: [], completionRetries: 0, turns: 1 },
    }),
    (error) => error && error.code === "CONTINUATION_CHECKPOINT_REFERENCE_REQUIRED",
  );
  assert.equal(journal.events.some((event) => event.type === "run_suspended"), false);
});
