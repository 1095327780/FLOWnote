const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const {
  resolveUserExecutionAction,
  getSuspendedRunId,
} = require("../../runtime/view/message/user-execution-action");
const { SessionStore } = require("../../runtime/session-store");

function execution(terminalType, receiptKind) {
  const events = [
    { seq: 0, time: 1, type: "run_started", runId: "r1" },
    { seq: 1, time: 2, type: "tool_started", runId: "r1", toolUseId: "t1", tool: "vault_write" },
    { seq: 2, time: 3, type: "tool_finished", runId: "r1", toolUseId: "t1", isError: false },
  ];
  if (receiptKind) events.push({ seq: 3, time: 4, type: "effect_verified", runId: "r1", toolUseId: "t1", receipt: { kind: receiptKind, verified: true, paths: ["a.md"] } });
  events.push({ seq: events.length, time: 5, type: terminalType, runId: "r1", ...(terminalType === "run_suspended" ? { checkpoint: { version: 1 } } : {}) });
  return { version: 1, events };
}

test("suspended workflows expose Continue instead of replaying the original slash command", () => {
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", status: "suspended", execution: execution("run_suspended") },
  ], "u1");
  assert.deepEqual(action, {
    mode: "continue",
    assistantId: "a1",
    runId: "r1",
  });
});

test("two suspended user cards target their own assistant and suspended run", () => {
  const messages = [
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", status: "suspended", execution: execution("run_suspended") },
    { id: "u2", role: "user", text: "/ah-card" },
    { id: "a2", role: "assistant", status: "suspended", execution: execution("run_suspended").events
      ? { version: 1, events: execution("run_suspended").events.map((event) => ({ ...event, runId: "r2" })) }
      : execution("run_suspended") },
  ];
  const calls = [];
  const sessionStore = {
    state: () => ({ activeSessionId: "s1" }),
    getContinuationClaimState: (_sessionId, assistantId) => {
      calls.push([_sessionId, assistantId]);
      return { status: "available", ownerDraftId: "" };
    },
  };

  const first = resolveUserExecutionAction(messages, "u1", { sessionStore });
  const second = resolveUserExecutionAction(messages, "u2", { sessionStore });
  assert.deepEqual(first, { mode: "continue", assistantId: "a1", runId: "r1" });
  assert.deepEqual(second, { mode: "continue", assistantId: "a2", runId: "r2" });
  assert.deepEqual(calls, [["s1", "a1"], ["s1", "a2"]]);
});

test("active continuation claims expose a disabled continuing action", () => {
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", status: "suspended", execution: execution("run_suspended") },
  ], "u1", {
    sessionId: "s1",
    sessionStore: { getContinuationClaimState: () => ({ status: "active", ownerDraftId: "owner-1" }) },
  });
  assert.deepEqual(action, {
    mode: "continuing",
    assistantId: "a1",
    runId: "r1",
    disabled: true,
  });
});

test("consumed checkpoints do not show an old Continue action", () => {
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", status: "suspended", execution: execution("run_suspended") },
  ], "u1", {
    sessionId: "s1",
    sessionStore: { getContinuationClaimState: () => ({ status: "consumed", ownerDraftId: "owner-1" }) },
  });
  assert.equal(action.mode, "none");
  assert.equal(action.assistantId, "a1");
  assert.equal(action.runId, "r1");
});

test("consumed checkpoints with a verified mutation keep Inspect but never Continue", () => {
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", status: "suspended", execution: execution("run_suspended", "vault_mutation") },
  ], "u1", {
    sessionId: "s1",
    sessionStore: { getContinuationClaimState: () => ({ status: "consumed", ownerDraftId: "owner-1" }) },
  });
  assert.equal(action.mode, "inspect");
  assert.equal(action.assistantId, "a1");
});

test("failed continuation owners make a suspended checkpoint reclaimable", () => {
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", status: "suspended", execution: execution("run_suspended") },
  ], "u1", {
    sessionId: "s1",
    sessionStore: { getContinuationClaimState: () => ({ status: "reclaimable", ownerDraftId: "failed-owner" }) },
  });
  assert.deepEqual(action, { mode: "continue", assistantId: "a1", runId: "r1" });
});

test("failed runs with verified mutations expose Inspect instead of Retry", () => {
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", status: "failed", execution: execution("run_failed", "vault_mutation") },
  ], "u1");
  assert.deepEqual(action, { mode: "inspect", assistantId: "a1", runId: "" });
});

test("failed runs without verified mutations may be retried", () => {
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "hello" },
    { id: "a1", role: "assistant", status: "failed", execution: execution("run_failed") },
  ], "u1");
  assert.deepEqual(action, { mode: "retry", assistantId: "a1", runId: "" });
});

test("reload after an unknown mutation offers inspection and never replays the write", () => {
  let vaultContent = "seed\nentry\n";
  const plugin = {
    runtimeState: {
      sessions: [{ id: "s1", title: "test", updatedAt: 1 }],
      activeSessionId: "s1",
      deletedSessionIds: [],
      messagesBySession: { s1: [
        { id: "u1", role: "user", text: "append entry", createdAt: 1 },
        {
          id: "a1",
          role: "assistant",
          text: "",
          blocks: [{ id: "write-1", type: "tool", tool: "vault_write", status: "running" }],
          pending: true,
          status: "running",
          execution: { version: 1, events: [
            { seq: 0, time: 1, type: "run_started", runId: "run-1" },
            {
              seq: 1,
              time: 2,
              type: "tool_started",
              runId: "run-1",
              toolUseId: "write-1",
              tool: "vault_write",
              capabilities: {
                effect: "vault_mutation",
                risk: "medium",
                concurrency: "serial",
                presentation: "edit",
                targets: ["Daily.md"],
              },
            },
          ] },
        },
      ] },
    },
  };
  const sessionStore = new SessionStore(plugin);
  assert.equal(sessionStore.recoverInterruptedExecutions(3), 1);

  const action = resolveUserExecutionAction(
    sessionStore.getActiveMessages(),
    "u1",
    { sessionStore, sessionId: "s1" },
  );
  assert.deepEqual(action, {
    mode: "inspect",
    assistantId: "a1",
    runId: "",
    uncertain: true,
  });

  const messageListMethods = loadMessageListMethods();
  let sendCount = 0;
  let inspectCount = 0;
  const view = {
    plugin: { sessionStore, getEffectiveLocale: () => "en" },
    sendPrompt: async () => {
      sendCount += 1;
      vaultContent += "entry\n";
    },
    findMessageRow: () => ({ scrollIntoView() { inspectCount += 1; } }),
  };
  const row = fakeEl();
  messageListMethods.renderUserActions.call(view, row, plugin.runtimeState.messagesBySession.s1[0]);
  const inspectButton = row.children[0].children.find(
    (child) => child.attrs["aria-label"] === "Check operation result before retrying",
  );
  assert.ok(inspectButton);
  inspectButton.listeners.click();
  assert.equal(inspectCount, 1);
  assert.equal(sendCount, 0);
  assert.equal(vaultContent, "seed\nentry\n");
});

test("reload after an interrupted read-only tool remains retryable", () => {
  const assistant = {
    id: "a1",
    role: "assistant",
    pending: false,
    status: "interrupted",
    execution: { version: 1, events: [
      { seq: 0, time: 1, type: "run_started", runId: "run-1" },
      {
        seq: 1,
        time: 2,
        type: "tool_started",
        runId: "run-1",
        toolUseId: "read-1",
        tool: "vault_read",
        capabilities: { effect: "observation", presentation: "read", targets: ["Daily.md"] },
      },
      { seq: 2, time: 3, type: "run_interrupted", runId: "run-1", reason: "unknown_after_reload" },
    ] },
  };
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "read note" },
    assistant,
  ], "u1");
  assert.deepEqual(action, { mode: "retry", assistantId: "a1", runId: "" });
});

test("ordinary retry does not carry continuation IDs", () => {
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "hello" },
  ], "u1");
  assert.deepEqual(action, { mode: "retry", assistantId: "", runId: "" });
});

test("stale continuation metadata does not fall back to replay retry", () => {
  const action = resolveUserExecutionAction([
    { id: "u1", role: "user", text: "/ah-card" },
    {
      id: "a1",
      role: "assistant",
      status: "completed",
      continuationClaimedBy: "old-owner",
      execution: execution("run_completed"),
    },
  ], "u1", {
    sessionId: "s1",
    sessionStore: { getContinuationClaimState: () => ({ status: "stale", ownerDraftId: "" }) },
  });
  assert.equal(action.mode, "none");
});

test("suspended ledger run ID comes from the terminal run_suspended event", () => {
  assert.equal(getSuspendedRunId(execution("run_suspended")), "r1");
  assert.equal(getSuspendedRunId(execution("run_failed")), "");
});

function fakeEl() {
  const node = {
    children: [],
    attrs: {},
    listeners: {},
    classList: { add() {} },
    createDiv(options = {}) {
      const child = fakeEl();
      child.cls = options.cls || "";
      this.children.push(child);
      return child;
    },
    createEl(tagName, options = {}) {
      const child = fakeEl();
      child.tagName = tagName;
      child.cls = options.cls || "";
      this.children.push(child);
      return child;
    },
    setAttr(name, value) {
      this.attrs[name] = String(value);
      return this;
    },
    setText(value) {
      this.text = String(value || "");
      return this;
    },
    addClass(name) {
      this.className = `${this.className || ""} ${name}`.trim();
      return this;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    querySelector() { return null; },
  };
  return node;
}

function loadMessageListMethods() {
  const originalLoad = Module._load;
  const modulePath = require.resolve("../../runtime/view/message/message-list-methods");
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return { Notice: class {}, Platform: {}, setIcon() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  const loaded = require(modulePath);
  Module._load = originalLoad;
  delete require.cache[modulePath];
  return loaded.messageListMethods;
}

test("renderUserActions sends a targeted continuation for each suspended card", async () => {
  const messageListMethods = loadMessageListMethods();
  const sent = [];
  const messages = [
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", status: "suspended", execution: execution("run_suspended") },
    { id: "u2", role: "user", text: "/ah-card again" },
    { id: "a2", role: "assistant", status: "suspended", execution: { version: 1, events: execution("run_suspended").events.map((event) => ({ ...event, runId: "r2" })) } },
  ];
  const sessionStore = {
    state: () => ({ activeSessionId: "s1" }),
    getActiveMessages: () => messages,
    getContinuationClaimState: () => ({ status: "available", ownerDraftId: "" }),
  };
  const view = {
    plugin: { sessionStore, getEffectiveLocale: () => "zh-CN" },
    sendPrompt: async (...args) => { sent.push(args); },
  };

  for (const message of [messages[0], messages[2]]) {
    const row = fakeEl();
    messageListMethods.renderUserActions.call(view, row, message);
    const actionButton = row.children[0].children.find((child) => child.attrs["aria-label"] === "Continue suspended workflow");
    assert.ok(actionButton, `missing continue button for ${message.id}`);
    await actionButton.listeners.click();
  }

  assert.deepEqual(sent, [
    ["继续", { sessionId: "s1", continuationMessageId: "a1", continuationRunId: "r1" }],
    ["继续", { sessionId: "s1", continuationMessageId: "a2", continuationRunId: "r2" }],
  ]);
});

test("renderUserActions disables an active continuation and keeps ordinary retry plain", async () => {
  const messageListMethods = loadMessageListMethods();
  const sent = [];
  const messages = [
    { id: "u1", role: "user", text: "/ah-card" },
    { id: "a1", role: "assistant", status: "suspended", execution: execution("run_suspended") },
    { id: "u2", role: "user", text: "try again" },
    { id: "a2", role: "assistant", status: "failed", execution: execution("run_failed") },
  ];
  const sessionStore = {
    state: () => ({ activeSessionId: "s1" }),
    getActiveMessages: () => messages,
    getContinuationClaimState: (_sessionId, assistantId) => assistantId === "a1"
      ? { status: "active", ownerDraftId: "owner-1" }
      : { status: "stale", ownerDraftId: "" },
  };
  const view = {
    plugin: { sessionStore, getEffectiveLocale: () => "en" },
    sendPrompt: async (...args) => { sent.push(args); },
  };

  const activeRow = fakeEl();
  messageListMethods.renderUserActions.call(view, activeRow, messages[0]);
  const activeButton = activeRow.children[0].children.find((child) => child.tagName === "button" && child.attrs["aria-label"] === "Continuing suspended workflow");
  assert.ok(activeButton);
  assert.equal(activeButton.disabled, true);
  assert.equal(activeButton.listeners.click, undefined);

  const retryRow = fakeEl();
  messageListMethods.renderUserActions.call(view, retryRow, messages[2]);
  const retryButton = retryRow.children[0].children.find((child) => child.attrs["aria-label"] === "Retry from this message");
  assert.ok(retryButton);
  await retryButton.listeners.click();
  assert.deepEqual(sent, [["try again"]]);
});

test("assistant copy is a message-level footer action sourced from the final timeline answer", () => {
  const messageListMethods = loadMessageListMethods();
  const row = fakeEl();
  let copiedSource = "";
  const view = {
    plugin: { getEffectiveLocale: () => "zh-CN" },
    addTextCopyButton(parent, sourceText) {
      copiedSource = sourceText;
      const button = parent.createEl("button", { cls: "oc-text-copy-btn" });
      button.setAttr("aria-label", "Copy message");
    },
  };

  messageListMethods.renderAssistantActions.call(view, row, {
    role: "assistant",
    text: "legacy fallback",
    blocks: [
      { type: "stream-text", phase: "process", detail: "working" },
      { type: "stream-text", phase: "final", detail: "final answer" },
    ],
  });

  assert.equal(row.children.length, 1);
  assert.equal(row.children[0].cls, "oc-assistant-msg-actions");
  assert.equal(row.children[0].children[0].cls, "oc-text-copy-btn");
  assert.equal(row.children[0].children[0].attrs["aria-label"], "Copy message");
  assert.equal(copiedSource, "final answer");
});
