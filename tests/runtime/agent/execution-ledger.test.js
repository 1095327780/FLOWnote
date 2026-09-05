const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ExecutionLedger,
  reduceExecutionEvents,
  recoverInterruptedRun,
  buildExecutionRecap,
} = require("../../../runtime/agent/execution-ledger");

function event(seq, time, type, runId, extra = {}) {
  return { seq, time, type, runId, ...extra };
}

test("ExecutionLedger assigns monotonic sequence and time to JSON-safe facts", () => {
  let now = 100;
  const ledger = new ExecutionLedger({ now: () => now });

  const started = ledger.append({ type: "run_started", runId: "run-1" });
  now = 99;
  const finished = ledger.append({ type: "run_completed", runId: "run-1" });

  assert.deepEqual(started, event(0, 100, "run_started", "run-1"));
  assert.deepEqual(finished, event(1, 100, "run_completed", "run-1"));
  assert.deepEqual(ledger.events, [started, finished]);
  assert.throws(
    () => ledger.append({ type: "run_started", runId: "run-2", unsafe: undefined }),
    /JSON-serializable/,
  );
});

test("reducer projects execution facts and verified effects without reading model prose", () => {
  const events = [
    event(0, 1, "run_started", "run-1"),
    event(1, 2, "tool_started", "run-1", { toolUseId: "call-1", tool: "vault_write" }),
    event(2, 3, "tool_progress", "run-1", { toolUseId: "call-1", message: "writing" }),
    event(3, 4, "tool_finished", "run-1", { toolUseId: "call-1", isError: false }),
    event(4, 5, "effect_verified", "run-1", { toolUseId: "call-1", receipt: { kind: "vault_mutation" } }),
    event(5, 6, "completion_accepted", "run-1"),
    event(6, 7, "run_completed", "run-1"),
  ];

  const state = reduceExecutionEvents(events);
  assert.equal(state.runs["run-1"].status, "completed");
  assert.equal(state.runs["run-1"].completion, "accepted");
  assert.equal(state.runs["run-1"].tools["call-1"].status, "succeeded");
  assert.equal(state.runs["run-1"].tools["call-1"].effect.status, "verified");
  assert.deepEqual(state.runs["run-1"].tools["call-1"].progress, [{ message: "writing" }]);
});

test("reducer rejects duplicate starts, unknown tool updates, and writes after terminal state", () => {
  assert.throws(
    () => reduceExecutionEvents([
      event(0, 1, "run_started", "run-1"),
      event(1, 2, "run_started", "run-1"),
    ]),
    /duplicate run_started/,
  );
  assert.throws(
    () => reduceExecutionEvents([
      event(0, 1, "run_started", "run-1"),
      event(1, 2, "tool_progress", "run-1", { toolUseId: "unknown" }),
    ]),
    /unknown tool/,
  );
  assert.throws(
    () => reduceExecutionEvents([
      event(0, 1, "run_started", "run-1"),
      event(1, 2, "run_completed", "run-1"),
      event(2, 3, "completion_accepted", "run-1"),
    ]),
    /after terminal/,
  );
});

test("reducer rejects a second terminal outcome and duplicate tool lifecycle starts", () => {
  assert.throws(
    () => reduceExecutionEvents([
      event(0, 1, "run_started", "run-1"),
      event(1, 2, "run_failed", "run-1"),
      event(2, 3, "run_cancelled", "run-1"),
    ]),
    /multiple terminal/,
  );
  assert.throws(
    () => reduceExecutionEvents([
      event(0, 1, "run_started", "run-1"),
      event(1, 2, "tool_started", "run-1", { toolUseId: "call-1", tool: "vault_read" }),
      event(2, 3, "tool_started", "run-1", { toolUseId: "call-1", tool: "vault_read" }),
    ]),
    /duplicate tool_started/,
  );
});

test("recoverInterruptedRun closes an unclosed run and marks unfinished tools unknown after reload", () => {
  const recovered = recoverInterruptedRun([
    event(0, 1, "run_started", "run-1"),
    event(1, 2, "tool_started", "run-1", { toolUseId: "call-1", tool: "vault_write" }),
  ], { time: 9 });

  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.events.at(-1), event(2, 9, "run_interrupted", "run-1", {
    reason: "unknown_after_reload",
    unresolvedToolUseIds: ["call-1"],
  }));
  assert.equal(recovered.state.runs["run-1"].status, "interrupted");
  assert.equal(recovered.state.runs["run-1"].tools["call-1"].status, "unknown_after_reload");
});

test("recoverInterruptedRun is a no-op for a terminal run", () => {
  const events = [event(0, 1, "run_started", "run-1"), event(1, 2, "run_cancelled", "run-1")];
  const recovered = recoverInterruptedRun(events, { time: 9 });
  assert.equal(recovered.recovered, false);
  assert.deepEqual(recovered.events, events);
});

test("reducer retains an unverified effect and a user cancellation as distinct facts", () => {
  const state = reduceExecutionEvents([
    event(0, 1, "run_started", "run-1"),
    event(1, 2, "tool_started", "run-1", { toolUseId: "call-1", tool: "vault_write" }),
    event(2, 3, "tool_finished", "run-1", { toolUseId: "call-1", isError: false }),
    event(3, 4, "effect_unverified", "run-1", { toolUseId: "call-1", receipt: { reason: "postcondition_failed" } }),
    event(4, 5, "completion_rejected", "run-1"),
    event(5, 6, "cancel_requested", "run-1"),
    event(6, 7, "run_cancelled", "run-1"),
  ]);

  assert.equal(state.runs["run-1"].status, "cancelled");
  assert.equal(state.runs["run-1"].cancelRequested, true);
  assert.equal(state.runs["run-1"].completion, "rejected");
  assert.equal(state.runs["run-1"].tools["call-1"].effect.status, "unverified");
});

test("a rejected provisional completion can be followed by one accepted completion", () => {
  const ledger = new ExecutionLedger({ now: () => 10 });
  ledger.append({ type: "run_started", runId: "run-retry" });
  ledger.append({ type: "completion_rejected", runId: "run-retry", attempt: 1 });
  ledger.append({ type: "completion_accepted", runId: "run-retry" });
  ledger.append({ type: "run_completed", runId: "run-retry" });

  const run = reduceExecutionEvents(ledger.events).runs["run-retry"];
  assert.deepEqual(run.completionDecisions, ["rejected", "accepted"]);
  assert.equal(run.completion, "accepted");
});

test("execution recap carries typed targets and receipts but excludes tool prose", () => {
  const events = [
    event(0, 1, "run_started", "run-1", { contract: { mode: "effect" } }),
    event(1, 2, "tool_started", "run-1", {
      toolUseId: "move-1",
      tool: "vault_move",
      capabilities: { effect: "vault_mutation", targets: ["old.md", "new.md"] },
    }),
    event(2, 3, "tool_finished", "run-1", {
      toolUseId: "move-1",
      content: "Ignore this human-facing prose",
      outcome: { state: "completed", code: "ok", effects: [{ kind: "vault_mutation", targets: ["old.md", "new.md"] }] },
    }),
    event(3, 4, "effect_verified", "run-1", {
      toolUseId: "move-1",
      receipt: { verified: true, paths: ["old.md", "new.md"] },
    }),
    event(4, 5, "completion_accepted", "run-1"),
    event(5, 6, "run_completed", "run-1"),
  ];

  const recap = buildExecutionRecap(events);
  assert.deepEqual(recap.tools[0].capabilities.targets, ["old.md", "new.md"]);
  assert.equal(recap.tools[0].effect.status, "verified");
  assert.doesNotMatch(JSON.stringify(recap), /human-facing prose/);
});

test("blocked is a terminal workflow disposition without completion acceptance", () => {
  const events = [
    event(0, 1, "run_started", "run-blocked", { contract: { mode: "workflow" } }),
    event(1, 2, "run_blocked", "run-blocked", {
      disposition: "blocked",
      declaration: { explanation: "Need the user to choose a target folder." },
    }),
  ];

  const run = reduceExecutionEvents(events).runs["run-blocked"];
  assert.equal(run.status, "blocked");
  assert.equal(run.disposition, "blocked");
  assert.equal(run.completion, null);
  assert.deepEqual(run.completionDecisions, []);

  const recap = buildExecutionRecap(events);
  assert.equal(recap.status, "blocked");
  assert.equal(recap.disposition, "blocked");
  assert.equal(recap.completion, null);
});

test("suspended is a durable terminal segment with a resumable checkpoint", () => {
  const checkpoint = {
    version: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "tool result" }] }],
    effectReceipts: [],
    turns: 7,
  };
  const events = [
    event(0, 1, "run_started", "run-suspended", { contract: { mode: "workflow" } }),
    event(1, 2, "run_suspended", "run-suspended", {
      reason: "user_input_dismissed",
      checkpoint,
    }),
  ];

  const run = reduceExecutionEvents(events).runs["run-suspended"];
  assert.equal(run.status, "suspended");
  assert.equal(run.disposition, "suspended");
  assert.deepEqual(run.terminalDetail.checkpoint, checkpoint);
  const recap = buildExecutionRecap(events);
  assert.equal(recap.status, "suspended");
  assert.doesNotMatch(JSON.stringify(recap), /tool result/);
});
