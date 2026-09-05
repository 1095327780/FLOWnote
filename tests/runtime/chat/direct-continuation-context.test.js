const test = require("node:test");
const assert = require("node:assert/strict");

const { contentFingerprint } = require("../../../runtime/agent/file-state-cache");
const {
  prepareContinuationContext,
  buildSuspensionCopy,
} = require("../../../runtime/chat/direct-continuation-context");

function suspendedMessage(checkpoint, overrides = {}) {
  return {
    id: "assistant-1",
    role: "assistant",
    text: "paused",
    execution: {
      version: 1,
      events: [
        { seq: 0, time: 1, type: "run_started", runId: "run-1", contract: checkpoint.contract },
        { seq: 1, time: 2, type: "run_suspended", runId: "run-1", checkpoint },
      ],
    },
    ...overrides,
  };
}

function checkpoint(overrides = {}) {
  return {
    version: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "original" }] }],
    effectReceipts: [{ kind: "observation", verified: true, paths: ["Notes/a.md"] }],
    contract: { id: "workflow-1", mode: "workflow" },
    completionRetries: 1,
    turns: 20,
    ...overrides,
  };
}

test("prepareContinuationContext atomically claims and restores an exact checkpoint", async () => {
  const cp = checkpoint({
    fileState: {
      version: 1,
      entries: [{
        path: "Notes/a.md",
        fingerprint: contentFingerprint("unchanged"),
        writtenInTurn: true,
      }],
    },
  });
  const claims = [];
  let persisted = 0;
  const context = await prepareContinuationContext({
    storedMessages: [suspendedMessage(cp)],
    draftId: "draft-2",
    userText: "继续",
    sessionId: "session-1",
    sessionStore: {
      claimContinuation: (...args) => { claims.push(args); return { status: "claimed" }; },
    },
    persistState: async () => { persisted += 1; },
    vault: {
      getFileByPath: (path) => ({ path }),
      cachedRead: async () => "unchanged",
    },
  });

  assert.deepEqual(claims, [["session-1", "assistant-1", "draft-2", "run-1"]]);
  assert.equal(persisted, 1);
  assert.equal(context.continuation.runId, "run-1");
  assert.equal(context.executionContract.id, "workflow-1");
  assert.deepEqual(context.effectReceipts, cp.effectReceipts);
  assert.notEqual(context.effectReceipts, cp.effectReceipts);
  assert.deepEqual(context.resumeState, {
    effectReceipts: cp.effectReceipts,
    completionRetries: 1,
    turns: 20,
    allowedToolPolicy: null,
    effectAttempts: [],
  });
  assert.equal(context.fileStateCache.get("Notes/a.md").writtenInTurn, true);
  assert.match(JSON.stringify(context.history), /FLOWNOTE_RESUME/);
  assert.match(JSON.stringify(context.history), /继续/);
});

test("prepareContinuationContext loads a referenced checkpoint after claiming and never stores its body in the execution event", async () => {
  const cp = checkpoint({ turns: 7 });
  const checkpointRef = {
    version: 1,
    id: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    path: ".obsidian/plugins/flownote/continuations/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json",
    byteLength: 456,
  };
  const released = [];
  const context = await prepareContinuationContext({
    storedMessages: [suspendedMessage(cp, { execution: {
      version: 1,
      events: [
        { seq: 0, time: 1, type: "run_started", runId: "run-1", contract: cp.contract },
        { seq: 1, time: 2, type: "run_suspended", runId: "run-1", checkpointRef },
      ],
    } })],
    draftId: "draft-2",
    userText: "continue",
    sessionId: "session-1",
    sessionStore: {
      claimContinuation: () => ({ status: "claimed" }),
      releaseContinuation: (...args) => { released.push(args); return true; },
    },
    persistState: async () => {},
    checkpointStore: { load: async (ref) => { assert.deepEqual(ref, checkpointRef); return cp; } },
  });

  assert.equal(context.resumeState.turns, 7);
  assert.deepEqual(released, []);
});

test("prepareContinuationContext releases its claim when a referenced checkpoint cannot be loaded", async () => {
  const checkpointRef = {
    version: 1,
    id: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    path: ".obsidian/plugins/flownote/continuations/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.json",
    byteLength: 456,
  };
  const released = [];
  await assert.rejects(
    prepareContinuationContext({
      storedMessages: [suspendedMessage(checkpoint(), { execution: {
        version: 1,
        events: [
          { seq: 0, time: 1, type: "run_started", runId: "run-1", contract: checkpoint().contract },
          { seq: 1, time: 2, type: "run_suspended", runId: "run-1", checkpointRef },
        ],
      } })],
      draftId: "draft-2",
      userText: "continue",
      sessionId: "session-1",
      sessionStore: {
        claimContinuation: () => ({ status: "claimed" }),
        releaseContinuation: (...args) => { released.push(args); return true; },
      },
      persistState: async () => {},
      checkpointStore: { load: async () => { throw new Error("checkpoint unavailable"); } },
    }),
    /checkpoint unavailable/,
  );
  assert.deepEqual(released, [["session-1", "assistant-1", "draft-2"]]);
});

test("prepareContinuationContext fails closed when the checkpoint claim loses a race", async () => {
  const cp = checkpoint();
  await assert.rejects(
    prepareContinuationContext({
      storedMessages: [suspendedMessage(cp)],
      draftId: "draft-2",
      userText: "continue",
      sessionId: "session-1",
      sessionStore: { claimContinuation: () => ({ status: "active", ownerDraftId: "other" }) },
    }),
    (error) => error && error.code === "CONTINUATION_ALREADY_CLAIMED",
  );
});

test("prepareContinuationContext resumes the explicitly targeted older checkpoint", async () => {
  const older = checkpoint({ turns: 3 });
  const newer = checkpoint({ turns: 8 });
  const context = await prepareContinuationContext({
    storedMessages: [
      suspendedMessage(older, { id: "older", execution: {
        version: 1,
        events: [
          { seq: 0, time: 1, type: "run_started", runId: "run-older", contract: older.contract },
          { seq: 1, time: 2, type: "run_suspended", runId: "run-older", checkpoint: older },
        ],
      } }),
      suspendedMessage(newer, { id: "newer", execution: {
        version: 1,
        events: [
          { seq: 0, time: 3, type: "run_started", runId: "run-newer", contract: newer.contract },
          { seq: 1, time: 4, type: "run_suspended", runId: "run-newer", checkpoint: newer },
        ],
      } }),
    ],
    draftId: "draft-2",
    userText: "继续",
    continuationMessageId: "older",
    continuationRunId: "run-older",
    sessionId: "session-1",
  });

  assert.equal(context.continuation.messageId, "older");
  assert.equal(context.resumeFromRunId, "run-older");
  assert.equal(context.resumeState.turns, 3);
});

test("prepareContinuationContext releases its claim when persistence fails", async () => {
  const cp = checkpoint();
  const released = [];
  await assert.rejects(
    prepareContinuationContext({
      storedMessages: [suspendedMessage(cp)],
      draftId: "draft-2",
      userText: "continue",
      sessionId: "session-1",
      sessionStore: {
        claimContinuation: () => ({ status: "claimed" }),
        releaseContinuation: (...args) => { released.push(args); return true; },
      },
      persistState: async () => { throw new Error("disk full"); },
    }),
    /disk full/,
  );
  assert.deepEqual(released, [["session-1", "assistant-1", "draft-2"]]);
});

test("prepareContinuationContext treats checkpoint file restoration failure as drift instead of stranding the resume", async () => {
  const cp = checkpoint({
    fileState: {
      version: 1,
      entries: [{ path: "Notes/a.md", fingerprint: contentFingerprint("before"), writtenInTurn: true }],
    },
  });
  const context = await prepareContinuationContext({
    storedMessages: [suspendedMessage(cp)],
    draftId: "draft-2",
    userText: "continue",
    sessionId: "session-1",
    sessionStore: { claimContinuation: () => ({ status: "claimed" }) },
    persistState: async () => {},
    vault: null,
  });
  assert.equal(context.continuation.status, "resumable");
  assert.equal(context.fileStateCache.has("Notes/a.md"), false);
  assert.match(JSON.stringify(context.history), /FLOWNOTE_RESUME_DRIFT/);
});

test("prepareContinuationContext exposes stale and corrupt targeted checkpoints as typed errors", async () => {
  const cp = checkpoint();
  await assert.rejects(
    prepareContinuationContext({
      storedMessages: [suspendedMessage(cp, { id: "other" })],
      draftId: "draft-2",
      userText: "continue",
      continuationMessageId: "missing",
      continuationRunId: "missing-run",
    }),
    (error) => error && error.code === "CONTINUATION_NOT_FOUND",
  );
});

test("prepareContinuationContext invalidates drifted file state and appends a reread instruction", async () => {
  const cp = checkpoint({
    fileState: {
      version: 1,
      entries: [{
        path: "Notes/a.md",
        fingerprint: contentFingerprint("before"),
        writtenInTurn: false,
      }],
    },
  });
  const context = await prepareContinuationContext({
    storedMessages: [suspendedMessage(cp)],
    draftId: "draft-2",
    userText: "resume",
    sessionId: "session-1",
    vault: {
      getFileByPath: (path) => ({ path }),
      read: async () => "after",
    },
  });

  assert.equal(context.fileStateCache.has("Notes/a.md"), false);
  assert.match(JSON.stringify(context.history), /FLOWNOTE_RESUME_DRIFT/);
  assert.match(JSON.stringify(context.history), /Notes\/a\.md/);
});

test("prepareContinuationContext returns a fresh empty cache for an ordinary turn", async () => {
  const context = await prepareContinuationContext({
    storedMessages: [],
    draftId: "draft-1",
    userText: "new task",
  });

  assert.equal(context.continuation, null);
  assert.equal(context.history, null);
  assert.equal(context.executionContract, null);
  assert.equal(context.resumeState, null);
  assert.equal(context.fileStateCache.size(), 0);
});

test("buildSuspensionCopy reports verified paths without treating observations as effects", () => {
  const translate = (_locale, zh, en) => en;
  const copy = buildSuspensionCopy("en", {
    effectReceipts: [
      { kind: "observation", verified: true, paths: ["ignored.md"] },
      { kind: "vault_mutation", verified: true, paths: ["Cards/a.md", "Cards/a.md"] },
    ],
  }, translate);

  assert.match(copy, /1 verified file change/);
  assert.match(copy, /Cards\/a\.md/);
  assert.doesNotMatch(copy, /ignored\.md/);
});
