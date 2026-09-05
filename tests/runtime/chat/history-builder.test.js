const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findResumableContinuation,
} = require("../../../runtime/chat/history-builder");

function suspendedExecution(checkpoint, runId = "old-run") {
  return { version: 1, events: [
    { seq: 0, time: 1, type: "run_started", runId, contract: checkpoint.contract },
    { seq: 1, time: 2, type: "run_suspended", runId, reason: "turn_boundary", checkpoint },
  ] };
}

function suspendedExecutionRef(checkpointRef, runId = "old-run") {
  return { version: 1, events: [
    { seq: 0, time: 1, type: "run_started", runId, contract: checkpoint.contract },
    { seq: 1, time: 2, type: "run_suspended", runId, reason: "turn_boundary", checkpointRef },
  ] };
}

const checkpoint = {
  version: 1,
  messages: [{ role: "user", content: [{ type: "text", text: "checkpoint" }] }],
  effectReceipts: [],
  contract: { id: "skill-ah-card", mode: "workflow", source: "explicit_skill" },
  completionRetries: 0,
  turns: 20,
};

test("findResumableContinuation returns the latest suspended checkpoint for an explicit continue request", () => {
  const found = findResumableContinuation([
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", text: "已暂停", status: "suspended", execution: suspendedExecution(checkpoint) },
    { id: "u2", role: "user", text: "继续" },
    { id: "draft", role: "assistant", pending: true },
  ], { draftId: "draft", userText: "继续" });

  assert.equal(found.status, "resumable");
  assert.equal(found.runId, "old-run");
  assert.equal(found.messageId, "a1");
  assert.deepEqual(found.checkpoint, checkpoint);
});

test("findResumableContinuation treats a checkpoint reference as resumable without treating it as corrupt", () => {
  const checkpointRef = {
    version: 1,
    id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    path: ".obsidian/plugins/flownote/continuations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
    byteLength: 123,
  };
  const found = findResumableContinuation([
    { id: "a1", role: "assistant", status: "suspended", execution: suspendedExecutionRef(checkpointRef) },
  ], { draftId: "draft", userText: "continue" });

  assert.equal(found.status, "resumable");
  assert.deepEqual(found.checkpointRef, checkpointRef);
  assert.equal(Object.hasOwn(found, "checkpoint"), false);
});

test("findResumableContinuation does not hijack unrelated user work", () => {
  const found = findResumableContinuation([
    { id: "a1", role: "assistant", status: "suspended", execution: suspendedExecution(checkpoint) },
  ], { draftId: "draft", userText: "帮我写一篇新笔记" });
  assert.equal(found.status, "not_found");
});

test("findResumableContinuation targets the requested assistant and run even when a newer checkpoint exists", () => {
  const older = { ...checkpoint, turns: 4 };
  const newer = { ...checkpoint, turns: 9 };
  const found = findResumableContinuation([
    { id: "older", role: "assistant", status: "suspended", execution: suspendedExecution(older, "run-older") },
    { id: "newer", role: "assistant", status: "suspended", execution: suspendedExecution(newer, "run-newer") },
  ], {
    draftId: "draft",
    userText: "继续",
    continuationMessageId: "older",
    continuationRunId: "run-older",
  });

  assert.equal(found.status, "resumable");
  assert.equal(found.messageId, "older");
  assert.equal(found.runId, "run-older");
  assert.equal(found.checkpoint.turns, 4);
});

test("manual continue skips newer completed, claimed, and ordinary messages to find the latest available checkpoint", () => {
  const found = findResumableContinuation([
    { id: "available", role: "assistant", status: "suspended", execution: suspendedExecution(checkpoint, "run-available") },
    { id: "claimed", role: "assistant", status: "suspended", continuationClaimedBy: "active-owner", execution: suspendedExecution(checkpoint, "run-claimed") },
    { id: "ordinary", role: "assistant", status: "completed", text: "hello" },
  ], { draftId: "draft", userText: "continue" });

  assert.equal(found.status, "resumable");
  assert.equal(found.messageId, "available");
});

test("targeted lookup returns typed claimed, stale, corrupt, and not_found outcomes", () => {
  const completedExecution = { version: 1, events: [
    { seq: 0, time: 1, type: "run_started", runId: "done-run", contract: checkpoint.contract },
    { seq: 1, time: 2, type: "run_completed", runId: "done-run" },
  ] };
  const messages = [
    { id: "claimed", role: "assistant", status: "suspended", continuationClaimedBy: "owner", execution: suspendedExecution(checkpoint, "claimed-run") },
    { id: "consumed", role: "assistant", status: "suspended", continuationClaimedBy: "owner", continuationConsumedBy: "owner", execution: suspendedExecution(checkpoint, "consumed-run") },
    { id: "stale", role: "assistant", status: "completed", execution: completedExecution },
    { id: "corrupt", role: "assistant", status: "suspended", execution: { version: 1, events: [{ broken: true }] } },
  ];

  assert.equal(findResumableContinuation(messages, { userText: "continue", continuationMessageId: "claimed" }).status, "claimed");
  assert.equal(findResumableContinuation(messages, { userText: "continue", continuationMessageId: "consumed" }).status, "stale");
  assert.equal(findResumableContinuation(messages, { userText: "continue", continuationMessageId: "stale", continuationRunId: "done-run" }).status, "stale");
  assert.equal(findResumableContinuation(messages, { userText: "continue", continuationMessageId: "corrupt" }).status, "corrupt");
  assert.equal(findResumableContinuation(messages, { userText: "continue", continuationMessageId: "missing" }).status, "not_found");
});
