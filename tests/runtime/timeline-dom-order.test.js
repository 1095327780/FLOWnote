const test = require("node:test");
const assert = require("node:assert/strict");

const { placeActivitySlot } = require("../../runtime/view/message/timeline-dom-order");

function node(name, classes = []) {
  return {
    name,
    parentElement: null,
    classList: { contains: (value) => classes.includes(value) },
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const index = this.parentElement.children.indexOf(this);
      return this.parentElement.children[index + 1] || null;
    },
  };
}

function container(...children) {
  const host = {
    children: [],
    insertions: 0,
    get firstElementChild() { return this.children[0] || null; },
    insertBefore(child, before) {
      this.insertions += 1;
      const current = this.children.indexOf(child);
      if (current >= 0) this.children.splice(current, 1);
      const target = before ? this.children.indexOf(before) : -1;
      if (target >= 0) this.children.splice(target, 0, child);
      else this.children.push(child);
      child.parentElement = this;
    },
  };
  for (const child of children) {
    host.children.push(child);
    child.parentElement = host;
  }
  return host;
}

test("stable timeline slots are not detached and reinserted on every stream delta", () => {
  const summary = node("summary", ["oc-process-disclosure"]);
  const first = node("first", ["oc-part-slot"]);
  const second = node("second", ["oc-part-slot"]);
  const host = container(summary, first, second);

  assert.equal(placeActivitySlot(host, first, null), false);
  assert.equal(placeActivitySlot(host, second, first), false);
  assert.equal(host.insertions, 0);
  assert.deepEqual(host.children.map((child) => child.name), ["summary", "first", "second"]);
});

test("a genuinely missing timeline slot is inserted at its chronological position", () => {
  const summary = node("summary", ["oc-process-disclosure"]);
  const first = node("first", ["oc-part-slot"]);
  const final = node("final", ["oc-part-slot"]);
  const missingTool = node("tool", ["oc-part-slot"]);
  const host = container(summary, first, final);

  assert.equal(placeActivitySlot(host, missingTool, first), true);
  assert.equal(host.insertions, 1);
  assert.deepEqual(host.children.map((child) => child.name), ["summary", "first", "tool", "final"]);
});
