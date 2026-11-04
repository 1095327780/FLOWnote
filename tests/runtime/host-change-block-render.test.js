const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { buildTurnChangeBlock } = require("../../runtime/chat/turn-change-block");

function fakeEl(tag = "div") {
  const classes = new Set();
  return {
    tag,
    children: [],
    attrs: {},
    classes,
    classList: { add: (cls) => classes.add(cls), remove: (cls) => classes.delete(cls), contains: (cls) => classes.has(cls) },
    className: "",
    text: "",
    open: false,
    empty() { this.children = []; },
    createDiv(options = {}) { return this.createEl("div", options); },
    createSpan(options = {}) { return this.createEl("span", options); },
    createEl(childTag, options = {}) {
      const child = fakeEl(childTag);
      if (options.cls) String(options.cls).split(/\s+/).forEach((cls) => child.classes.add(cls));
      if (options.text !== undefined) child.text = String(options.text);
      if (options.attr) Object.assign(child.attrs, options.attr);
      this.children.push(child);
      return child;
    },
    setAttr(name, value) { this.attrs[name] = value; },
    addClass(cls) { this.classes.add(cls); },
    setText(value) { this.text = String(value); },
    addEventListener() {},
  };
}

function allText(el) {
  return [el.text, ...el.children.map(allText)].filter(Boolean).join(" ");
}

function loadRenderMethods() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return { setIcon() {}, Notice: class {}, Platform: {}, Keymap: { isModEvent: () => false } };
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve("../../runtime/view/message/block-render-methods");
  delete require.cache[modulePath];
  try {
    return require(modulePath).blockRenderMethods;
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

test("a host-measured change block renders its own diff with real line numbers, without asking a runtime", () => {
  const methods = loadRenderMethods();
  const block = buildTurnChangeBlock({ runId: "r1", changes: [
    { path: "Daily/2026-10-20.md", op: "modified", diff: { before: "a\nold\nc", after: "a\nnew\nc", startLine: 7, added: 1, removed: 1 } },
    { path: "Inbox/Idea.md", op: "created", diff: { before: "", after: "idea", startLine: 1, added: 1, removed: 0 } },
  ] });
  let diffRequests = 0;
  const context = {
    app: { vault: { getAbstractFileByPath: (path) => ({ path }) } },
    plugin: { opencodeClient: { getSessionDiff: async () => { diffRequests += 1; return []; } } },
    resolveDisplayBlockStatus: () => "completed",
    blockStatusLabel: (status) => status,
  };
  const container = fakeEl();
  methods.renderPatchPart.call(context, container, block, false, { id: "m1" }, 0);

  const rendered = allText(container);
  assert.equal(diffRequests, 0);
  assert.match(rendered, /Daily\/2026-10-20\.md/);
  assert.match(rendered, /Inbox\/Idea\.md/);
  // The excerpt starts at line 7 of the real note (context line included).
  assert.match(rendered, /@@ -7 \+7 @@ {3}a - old \+ new {3}c/);
  // Action labels render as badges (no brackets); counts as separate +/- spans.
  assert.match(rendered, /Modified Daily\/2026-10-20\.md \+1 -1/);
  assert.match(rendered, /Added Inbox\/Idea\.md \+1 -0/);
  assert.equal(container.children[0].attrs["data-part-type"], "patch");
});
