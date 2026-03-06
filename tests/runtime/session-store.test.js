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

test("mergeReasoningText should prefer snapshot expansion over repeated concatenation", () => {
  const first = "我需要执行";
  const second = "我需要执行 ah-index";
  const third = "我需要执行 ah-index 技能来更新索引";

  const merged1 = SessionStore.mergeReasoningText(first, second);
  const merged2 = SessionStore.mergeReasoningText(merged1, third);

  assert.equal(merged2, third);
});

test("mergeDraftText should preserve streamed text growth for snapshots and chunks", () => {
  const first = "第一段内容。";
  const secondChunk = "第二段内容。";
  const secondSnapshot = "第一段内容。第二段内容。";
  const thirdSnapshot = "第一段内容。第二段内容。第三段内容。";

  const mergedChunk = SessionStore.mergeDraftText(first, secondChunk);
  assert.equal(mergedChunk, "第一段内容。第二段内容。");

  const mergedSnapshot = SessionStore.mergeDraftText(mergedChunk, secondSnapshot);
  assert.equal(mergedSnapshot, secondSnapshot);

  const mergedFinal = SessionStore.mergeDraftText(mergedSnapshot, thirdSnapshot);
  assert.equal(mergedFinal, thirdSnapshot);
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

test("finalizeAssistantDraft should keep streamed interim text when final payload is shorter", () => {
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
  assert.equal(
    draft.text,
    "首先定位今日笔记并读取结构：\n我来帮你捕获这个链接到今日日记。",
  );
});

test("finalizeAssistantDraft should not wipe streamed interim text when final payload text is empty", () => {
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
  assert.equal(draft.text, "处理中...");
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
