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

