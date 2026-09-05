const test = require("node:test");
const assert = require("node:assert/strict");

const { SessionStore } = require("../../runtime/session-store");

function createStoreFixture() {
  const plugin = {
    runtimeState: {
      sessions: [
        { id: "s1", title: "新会话", updatedAt: 0 },
      ],
      activeSessionId: "s1",
      messagesBySession: {
        s1: [
          {
            id: "draft-1",
            role: "assistant",
            text: "",
            reasoning: "",
            meta: "",
            blocks: [],
            pending: true,
          },
        ],
      },
      deletedSessionIds: [],
    },
  };

  return {
    plugin,
    store: new SessionStore(plugin),
  };
}

test("getSessionMessages reads a fixed session independently of the active chat", () => {
  const { store, plugin } = createStoreFixture();
  plugin.runtimeState.messagesBySession.s2 = [{ id: "other", role: "user", text: "other" }];
  plugin.runtimeState.activeSessionId = "s2";

  const messages = store.getSessionMessages("s1");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "draft-1");
});

test("appendMessage keeps a targeted continuation at the 200-message retention boundary", () => {
  const { store, plugin } = createStoreFixture();
  plugin.runtimeState.messagesBySession.s1 = Array.from({ length: 200 }, (_value, index) => ({
    id: index === 0 ? "paused-oldest" : `message-${index}`,
    role: index === 0 ? "assistant" : "user",
    text: `message ${index}`,
    status: index === 0 ? "suspended" : "completed",
    pending: false,
    ...(index === 0 ? { execution: { version: 1, events: [
      { seq: 0, time: 1, type: "run_started", runId: "run-oldest" },
      { seq: 1, time: 2, type: "run_suspended", runId: "run-oldest", checkpoint: { version: 1 } },
    ] } } : {}),
  }));

  store.appendMessage(
    "s1",
    { id: "resume-user", role: "user", text: "继续" },
    { protectedMessageIds: ["paused-oldest"] },
  );
  store.appendMessage(
    "s1",
    { id: "resume-draft", role: "assistant", text: "", pending: true },
    { protectedMessageIds: ["paused-oldest"] },
  );

  const messages = store.getSessionMessages("s1");
  assert.equal(messages.length, 200);
  assert.ok(messages.some((message) => message.id === "paused-oldest"));
  assert.deepEqual(messages.slice(-2).map((message) => message.id), ["resume-user", "resume-draft"]);
  assert.equal(
    store.claimContinuation("s1", "paused-oldest", "resume-draft", "run-oldest").status,
    "claimed",
  );
});

test("updateAssistantDraft should keep latest snapshot reasoning without duplicating prefix", () => {
  const { store, plugin } = createStoreFixture();

  store.updateAssistantDraft("s1", "draft-1", undefined, "我需要执行");
  store.updateAssistantDraft("s1", "draft-1", undefined, "我需要执行 ah-index");
  store.updateAssistantDraft("s1", "draft-1", undefined, "我需要执行 ah-index 技能");

  const draft = plugin.runtimeState.messagesBySession.s1.find((row) => row.id === "draft-1");
  assert.ok(draft);
  assert.equal(draft.reasoning, "我需要执行 ah-index 技能");
  assert.equal((draft.reasoning.match(/我需要执行/g) || []).length, 1);
});

test("updateAssistantDraft should keep streamed text cumulative instead of replacing by chunk", () => {
  const { store, plugin } = createStoreFixture();

  store.updateAssistantDraft("s1", "draft-1", "第一段");
  store.updateAssistantDraft("s1", "draft-1", "第二段");
  store.updateAssistantDraft("s1", "draft-1", "第一段第二段第三段");

  const draft = plugin.runtimeState.messagesBySession.s1.find((row) => row.id === "draft-1");
  assert.ok(draft);
  assert.equal(draft.text, "第一段第二段第三段");
});

test("finalizeAssistantDraft should persist server messageId for follow-up APIs", () => {
  const { store, plugin } = createStoreFixture();

  store.finalizeAssistantDraft("s1", "draft-1", {
    messageId: "assistant-msg-123",
    text: "done",
    reasoning: "",
    meta: "",
    blocks: [],
  });

  const draft = plugin.runtimeState.messagesBySession.s1.find((row) => row.id === "draft-1");
  assert.ok(draft);
  assert.equal(draft.messageId, "assistant-msg-123");
});

test("finalizeAssistantDraft persists typed response stats", () => {
  const { store, plugin } = createStoreFixture();
  const stats = {
    modelLabel: "DeepSeek V4 Flash",
    modelId: "deepseek-v4-flash",
    toolCount: 2,
    usage: { totalTokens: 4200 },
  };

  store.finalizeAssistantDraft("s1", "draft-1", {
    text: "done",
    blocks: [],
    stats,
  });

  assert.deepEqual(plugin.runtimeState.messagesBySession.s1[0].stats, stats);
});

test("finalizeAssistantDraft treats the final payload as the authoritative snapshot", () => {
  const { store, plugin } = createStoreFixture();

  store.updateAssistantDraft("s1", "draft-1", "首先定位今日笔记并读取结构：");
  store.updateAssistantDraft("s1", "draft-1", "首先定位今日笔记并读取结构：\n我来帮你捕获这个链接到今日日记。");
  store.finalizeAssistantDraft("s1", "draft-1", {
    messageId: "assistant-msg-456",
    text: "我来帮你捕获这个链接到今日日记。",
    reasoning: "",
    meta: "",
    blocks: [],
  });

  const draft = plugin.runtimeState.messagesBySession.s1.find((row) => row.id === "draft-1");
  assert.ok(draft);
  assert.equal(draft.text, "我来帮你捕获这个链接到今日日记。");
});

test("finalizeAssistantDraft removes stale interim text when final payload is empty", () => {
  const { store, plugin } = createStoreFixture();

  store.updateAssistantDraft("s1", "draft-1", "处理中...");
  store.finalizeAssistantDraft("s1", "draft-1", {
    messageId: "assistant-msg-789",
    text: "",
    reasoning: "",
    meta: "",
    blocks: [],
  });

  const draft = plugin.runtimeState.messagesBySession.s1.find((row) => row.id === "draft-1");
  assert.ok(draft);
  assert.equal(draft.text, "");
});

test("finalizeAssistantDraft rebuilds missed tool cards from the terminal execution ledger", () => {
  const { store, plugin } = createStoreFixture();
  const events = [
    { seq: 0, time: 1, type: "run_started", runId: "draft-1" },
    {
      seq: 1,
      time: 2,
      type: "tool_started",
      runId: "draft-1",
      toolUseId: "read-1",
      tool: "vault_read",
      capabilities: { effect: "observation", presentation: "read", targets: ["Daily.md"] },
    },
    { seq: 2, time: 3, type: "tool_finished", runId: "draft-1", toolUseId: "read-1", isError: false },
    { seq: 3, time: 4, type: "run_completed", runId: "draft-1" },
  ];

  store.finalizeAssistantDraft("s1", "draft-1", {
    text: "done",
    blocks: [],
    status: "completed",
    execution: { version: 1, events },
  });

  const draft = plugin.runtimeState.messagesBySession.s1[0];
  assert.equal(draft.blocks.length, 1);
  assert.equal(draft.blocks[0].type, "tool");
  assert.equal(draft.blocks[0].tool, "vault_read");
  assert.equal(draft.blocks[0].status, "completed");
});

test("finalizeAssistantDraft updates durable tools without regrouping the activity timeline", () => {
  const { store, plugin } = createStoreFixture();
  const blocks = [
    { id: "text-1", type: "stream-text", phase: "process", text: "Inspecting." },
    { id: "read-1", type: "tool", tool: "vault_read", status: "running", summary: "Daily.md" },
    { id: "text-2", type: "stream-text", phase: "final", text: "Done." },
  ];
  const events = [
    { seq: 0, time: 1, type: "run_started", runId: "draft-1" },
    {
      seq: 1,
      time: 2,
      type: "tool_started",
      runId: "draft-1",
      toolUseId: "read-1",
      tool: "vault_read",
      capabilities: { effect: "observation", presentation: "read", targets: ["Daily.md"] },
    },
    { seq: 2, time: 3, type: "tool_finished", runId: "draft-1", toolUseId: "read-1", isError: false },
    { seq: 3, time: 4, type: "run_completed", runId: "draft-1" },
  ];

  store.finalizeAssistantDraft("s1", "draft-1", {
    text: "Done.",
    blocks,
    status: "completed",
    execution: { version: 1, events },
  });

  const draft = plugin.runtimeState.messagesBySession.s1[0];
  assert.deepEqual(draft.blocks.map((block) => block.id), ["text-1", "read-1", "text-2"]);
  assert.equal(draft.blocks[1].status, "completed");
});

test("claimContinuation blocks an active owner and exposes one typed claim state", () => {
  const { store, plugin } = createStoreFixture();
  store.appendMessage("s1", { id: "paused-1", role: "assistant", status: "suspended", pending: false });
  plugin.runtimeState.messagesBySession.s1.push({ id: "resume-a", role: "assistant", status: "running", pending: true });

  assert.equal(store.claimContinuation("s1", "paused-1", "resume-a").status, "claimed");
  assert.equal(store.claimContinuation("s1", "paused-1", "resume-a").status, "claimed");
  assert.equal(store.claimContinuation("s1", "paused-1", "resume-b").status, "active");
  assert.deepEqual(store.getContinuationClaimState("s1", "paused-1"), {
    status: "active",
    ownerDraftId: "resume-a",
  });
  assert.equal(store.getActiveMessages().find((message) => message.id === "paused-1").continuationClaimedBy, "resume-a");
});

test("claimContinuation reclaims failed, cancelled, interrupted, or missing owners", () => {
  for (const ownerStatus of ["failed", "cancelled", "interrupted", "missing"]) {
    const { store, plugin } = createStoreFixture();
    store.appendMessage("s1", {
      id: "paused-1",
      role: "assistant",
      status: "suspended",
      pending: false,
      continuationClaimedBy: "old-owner",
    });
    if (ownerStatus !== "missing") {
      plugin.runtimeState.messagesBySession.s1.push({
        id: "old-owner",
        role: "assistant",
        status: ownerStatus,
        pending: false,
      });
    }

    const result = store.claimContinuation("s1", "paused-1", "new-owner");
    assert.equal(result.status, "claimed", ownerStatus);
    assert.equal(result.reclaimed, true, ownerStatus);
    assert.equal(store.getContinuationClaimState("s1", "paused-1").ownerDraftId, "new-owner");
  }
});

test("a completed continuation owner consumes the source checkpoint permanently", () => {
  const { store, plugin } = createStoreFixture();
  store.appendMessage("s1", {
    id: "paused-1",
    role: "assistant",
    status: "suspended",
    pending: false,
    continuationClaimedBy: "resume-a",
  });
  plugin.runtimeState.messagesBySession.s1.push({ id: "resume-a", role: "assistant", status: "completed", pending: false });

  assert.equal(store.getContinuationClaimState("s1", "paused-1").status, "consumed");
  assert.equal(store.claimContinuation("s1", "paused-1", "resume-b").status, "consumed");
});

test("releaseContinuation only releases the matching claim owner", () => {
  const { store } = createStoreFixture();
  store.appendMessage("s1", {
    id: "paused-1",
    role: "assistant",
    status: "suspended",
    pending: false,
    continuationClaimedBy: "resume-a",
  });

  assert.equal(store.releaseContinuation("s1", "paused-1", "resume-b"), false);
  assert.equal(store.releaseContinuation("s1", "paused-1", "resume-a"), true);
  assert.equal(store.getContinuationClaimState("s1", "paused-1").status, "available");
});

test("claimContinuation rejects a stale run identity even when the assistant message is still suspended", () => {
  const { store, plugin } = createStoreFixture();
  const source = {
    id: "paused-1",
    role: "assistant",
    status: "suspended",
    pending: false,
    execution: { version: 1, events: [
      { seq: 0, time: 1, type: "run_started", runId: "actual-run" },
      { seq: 1, time: 2, type: "run_suspended", runId: "actual-run", checkpoint: {
        version: 1,
        messages: [],
        effectReceipts: [],
        contract: null,
        completionRetries: 0,
        turns: 1,
      } },
    ] },
  };
  plugin.runtimeState.messagesBySession.s1.push(source);

  assert.equal(store.claimContinuation("s1", "paused-1", "resume-a", "wrong-run").status, "stale");
  assert.equal(source.continuationClaimedBy, undefined);
});

test("finalizing a continuation owner records durable consumed state on its source", () => {
  const { store, plugin } = createStoreFixture();
  plugin.runtimeState.messagesBySession.s1.push(
    { id: "paused-1", role: "assistant", status: "suspended", pending: false, continuationClaimedBy: "resume-a" },
    { id: "resume-a", role: "assistant", status: "running", pending: true },
  );

  store.finalizeAssistantDraft("s1", "resume-a", { text: "done", status: "completed" }, "");
  const source = plugin.runtimeState.messagesBySession.s1.find((message) => message.id === "paused-1");
  assert.equal(source.continuationConsumedBy, "resume-a");
  assert.equal(store.getContinuationClaimState("s1", "paused-1").status, "consumed");
});

test("updateAssistantDraft replaces stale blocks with the authoritative block snapshot", () => {
  const { store, plugin } = createStoreFixture();
  store.updateAssistantDraft("s1", "draft-1", "", "", "", [
    { id: "call-1", type: "tool", status: "running" },
    { id: "stale", type: "tool", status: "running" },
  ]);
  store.updateAssistantDraft("s1", "draft-1", "", "", "", [
    { id: "call-1", type: "tool", status: "completed" },
  ]);

  const draft = plugin.runtimeState.messagesBySession.s1[0];
  assert.deepEqual(draft.blocks, [{ id: "call-1", type: "tool", status: "completed" }]);
});

test("setAssistantExecution restores every durable tool block even when live UI frames were skipped", () => {
  const { store, plugin } = createStoreFixture();
  plugin.runtimeState.messagesBySession.s1[0].blocks = [
    { id: "read-1", type: "tool", tool: "vault_read", status: "completed", summary: "Daily.md" },
  ];
  store.setAssistantExecution("s1", "draft-1", [
    { seq: 0, time: 1, type: "run_started", runId: "draft-1" },
    {
      seq: 1,
      time: 2,
      type: "tool_started",
      runId: "draft-1",
      toolUseId: "read-1",
      tool: "vault_read",
      capabilities: { effect: "observation", risk: "low", concurrency: "parallel", presentation: "read", targets: ["Daily.md"] },
    },
    { seq: 2, time: 3, type: "tool_finished", runId: "draft-1", toolUseId: "read-1", isError: false },
    {
      seq: 3,
      time: 4,
      type: "tool_started",
      runId: "draft-1",
      toolUseId: "list-2",
      tool: "vault_list",
      capabilities: { effect: "observation", risk: "low", concurrency: "parallel", presentation: "read", targets: ["Projects"] },
    },
    { seq: 4, time: 5, type: "tool_finished", runId: "draft-1", toolUseId: "list-2", isError: true, outcome: { state: "failed", code: "tool_error", effects: [] } },
  ]);

  const draft = plugin.runtimeState.messagesBySession.s1[0];
  assert.equal(draft.blocks.filter((block) => block.type === "tool").length, 2);
  assert.deepEqual(draft.blocks.filter((block) => block.type === "tool").map((block) => block.id), ["read-1", "list-2"]);
  assert.equal(draft.blocks.find((block) => block.id === "read-1").summary, "Daily.md");
  assert.equal(draft.blocks.find((block) => block.id === "list-2").status, "error");
  assert.equal(draft.blocks.find((block) => block.id === "list-2").summary, "Projects");
});

test("recoverInterruptedExecutions marks open durable runs interrupted after reload", () => {
  const { plugin } = createStoreFixture();
  plugin.runtimeState.messagesBySession.s1[0].execution = {
    version: 1,
    events: [
      { seq: 0, time: 1, type: "run_started", runId: "draft-1" },
      { seq: 1, time: 2, type: "tool_started", runId: "draft-1", toolUseId: "call-1", tool: "vault_write" },
    ],
  };

  const store = new SessionStore(plugin);
  const recovered = store.recoverInterruptedExecutions(3);
  const draft = plugin.runtimeState.messagesBySession.s1[0];
  assert.equal(recovered, 1);
  assert.equal(draft.status, "interrupted");
  assert.equal(draft.pending, false);
  assert.equal(draft.execution.events.at(-1).type, "run_interrupted");
});

test("recoverInterruptedExecutions never upgrades a legacy pending draft to completed", () => {
  const { store, plugin } = createStoreFixture();
  assert.equal(store.recoverInterruptedExecutions(3), 1);
  assert.equal(plugin.runtimeState.messagesBySession.s1[0].status, "interrupted");
  assert.equal(plugin.runtimeState.messagesBySession.s1[0].pending, false);
});

test("isPlaceholderTitle should treat timestamped default titles as placeholder", () => {
  assert.equal(SessionStore.isPlaceholderTitle("New session - 2026-02-21T03:59:31.476Z"), true);
  assert.equal(SessionStore.isPlaceholderTitle("未命名会话 - 2026/02/21"), true);
});

test("setSessionMessages should derive session title from latest user message when current title is placeholder", () => {
  const { store, plugin } = createStoreFixture();
  const changed = store.setSessionMessages("s1", [
    {
      id: "u1",
      role: "user",
      text: "请帮我整理今天的会议纪要并提炼三条行动项",
      createdAt: 1739990000000,
    },
    {
      id: "a1",
      role: "assistant",
      text: "好的，我会按会议目标、结论、行动项输出。",
      createdAt: 1739990001000,
    },
  ]);

  assert.equal(changed, true);
  assert.equal(plugin.runtimeState.messagesBySession.s1.length, 2);
  assert.equal(plugin.runtimeState.sessions[0].lastUserPrompt, "请帮我整理今天的会议纪要并提炼三条行动项");
  assert.equal(plugin.runtimeState.sessions[0].title, "请帮我整理今天的会议纪要并提炼三条行动项");
});

test("appendMessage should normalize linkedContextFiles for user message", () => {
  const { store, plugin } = createStoreFixture();
  store.appendMessage("s1", {
    id: "u2",
    role: "user",
    text: "hello",
    linkedContextFiles: [" /Project/alpha.md ", "Project/alpha.md", "Work/todo.md", ""],
    createdAt: 1740000000000,
  });

  const latest = plugin.runtimeState.messagesBySession.s1[plugin.runtimeState.messagesBySession.s1.length - 1];
  assert.ok(latest);
  assert.deepEqual(latest.linkedContextFiles, ["Project/alpha.md", "Work/todo.md"]);
});
