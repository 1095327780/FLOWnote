const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isLiveStreamTextBlock,
  syncLiveStreamTextSlot,
} = require("../../runtime/view/message/live-stream-text");

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...items) { items.forEach((item) => values.add(item)); },
    remove(...items) { items.forEach((item) => values.delete(item)); },
    contains(item) { return values.has(item); },
  };
}

test("pending stream text updates one stable node synchronously", () => {
  const body = { textContent: "" };
  const card = { classList: classList(["is-pending"]) };
  const slot = {
    querySelector(selector) {
      if (selector === ".oc-stream-text-part") return card;
      if (selector === ".oc-stream-text-content") return body;
      return null;
    },
  };
  const first = { type: "stream-text", phase: "streaming", status: "running", text: "正在" };
  const second = { ...first, text: "正在逐字输出" };

  assert.equal(isLiveStreamTextBlock(first, true), true);
  assert.equal(syncLiveStreamTextSlot(slot, first, "running"), true);
  assert.equal(body.textContent, "正在");
  assert.equal(syncLiveStreamTextSlot(slot, second, "running"), true);
  assert.equal(body.textContent, "正在逐字输出");
  assert.equal(card.classList.contains("is-streaming"), true);
  assert.equal(card.classList.contains("is-running"), true);
});

test("completed process or final text waits for one terminal Markdown render", () => {
  assert.equal(isLiveStreamTextBlock({ type: "stream-text", phase: "process", status: "completed" }, true), false);
  assert.equal(isLiveStreamTextBlock({ type: "stream-text", phase: "final", status: "completed" }, true), false);
  assert.equal(isLiveStreamTextBlock({ type: "stream-text", phase: "streaming", status: "running" }, false), false);
});
