const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultChangeRecorder, describeChanges, diffExcerpt } = require("../../../runtime/agent/vault-change-recorder");

function fakeApp(initial = {}, folders = []) {
  const files = new Map(Object.entries(initial));
  const folderSet = new Set(folders);
  const listeners = new Map();
  const trigger = (type, ...args) => {
    for (const fn of listeners.get(type) || []) fn(...args);
  };
  const vault = {
    files,
    folderSet,
    trigger,
    getAbstractFileByPath(path) {
      if (files.has(path)) return { path };
      if (folderSet.has(path)) return { path, children: [] };
      return null;
    },
    getFileByPath(path) { return files.has(path) ? { path } : null; },
    async read(file) { return files.get(file.path); },
    async cachedRead(file) { return files.get(file.path); },
    async create(path, content) {
      if (files.has(path)) throw new Error("exists");
      files.set(path, content);
      trigger("create", { path });
      return { path };
    },
    async modify(file, content) {
      files.set(file.path, content);
      trigger("modify", { path: file.path });
    },
    async process(file, fn) {
      const next = fn(files.get(file.path));
      files.set(file.path, next);
      trigger("modify", { path: file.path });
      return next;
    },
    async createFolder(path) {
      if (folderSet.has(path)) throw new Error("Folder already exists.");
      folderSet.add(path);
      trigger("create", { path, children: [] });
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
      return { type, fn };
    },
    offref(ref) {
      listeners.set(ref.type, (listeners.get(ref.type) || []).filter((fn) => fn !== ref.fn));
    },
    listenerCount() {
      return [...listeners.values()].reduce((sum, list) => sum + list.length, 0);
    },
  };
  const fileManager = {
    async renameFile(file, newPath) {
      const content = files.get(file.path);
      files.delete(file.path);
      files.set(newPath, content);
      trigger("rename", { path: newPath }, file.path);
      // Obsidian rewrites links in other notes as part of a rename.
      if (files.has("Index.md")) {
        files.set("Index.md", files.get("Index.md").replace(`[[${file.path.replace(/\.md$/, "")}]]`, `[[${newPath.replace(/\.md$/, "")}]]`));
        trigger("modify", { path: "Index.md" });
      }
    },
    async processFrontMatter(file, fn) {
      const fm = {};
      fn(fm);
      files.set(file.path, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${files.get(file.path)}`);
      trigger("modify", { path: file.path });
    },
  };
  return { vault, fileManager, workspace: { name: "ws" } };
}

test("measures a real edit with an excerpted diff and attributes it to the tool", async () => {
  const app = fakeApp({ "A.md": "one\ntwo\nthree\n" });
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  recorder.start();
  const tools = recorder.instrumentApp(app);
  recorder.beginTool("t1");
  await tools.vault.process({ path: "A.md" }, (text) => text.replace("two", "TWO"));
  const perTool = await recorder.endTool("t1");
  const { changes, external } = await recorder.finalize();

  assert.deepEqual(perTool.map(({ path, op }) => ({ path, op })), [{ path: "A.md", op: "modified" }]);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].toolUseIds, ["t1"]);
  assert.equal(changes[0].diff.before.includes("two"), true);
  assert.equal(changes[0].diff.after.includes("TWO"), true);
  assert.equal(changes[0].diff.added, 1);
  assert.equal(changes[0].diff.removed, 1);
  assert.deepEqual(external, []);
  assert.equal(app.vault.listenerCount(), 0);
});

test("a write that leaves identical content is not a change", async () => {
  const app = fakeApp({ "A.md": "same" });
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  const tools = recorder.instrumentApp(app);
  recorder.beginTool("t1");
  await tools.vault.modify({ path: "A.md" }, "same");
  assert.deepEqual(await recorder.endTool("t1"), []);
  assert.deepEqual((await recorder.finalize()).changes, []);
});

test("a tool that only reports success without writing produces no measured change", async () => {
  const app = fakeApp({}, ["Projects"]);
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  recorder.instrumentApp(app);
  recorder.beginTool("mkdir-existing");
  // e.g. vault_create_dir on an existing folder returns "already exists"
  assert.deepEqual(await recorder.endTool("mkdir-existing"), []);
  assert.deepEqual((await recorder.finalize()).changes, []);
});

test("net change across a turn: A->B->A is no change, creation and folder creation are measured", async () => {
  const app = fakeApp({ "A.md": "orig" });
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  const tools = recorder.instrumentApp(app);
  recorder.beginTool("t1");
  await tools.vault.modify({ path: "A.md" }, "changed");
  await recorder.endTool("t1");
  recorder.beginTool("t2");
  await tools.vault.modify({ path: "A.md" }, "orig");
  await tools.vault.createFolder("New");
  await tools.vault.create("New/Card.md", "# Card\n");
  await recorder.endTool("t2");
  const { changes } = await recorder.finalize();
  assert.deepEqual(describeChanges(changes), [
    { path: "New", op: "created", kind: "folder" },
    { path: "New/Card.md", op: "created" },
  ]);
  assert.equal(changes[1].diff.after, "# Card\n");
});

test("rename is paired and link rewrites in other notes are attributed through vault events", async () => {
  const app = fakeApp({ "Old.md": "body", "Index.md": "see [[Old]]" });
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  recorder.start();
  const tools = recorder.instrumentApp(app);
  recorder.beginTool("mv");
  await tools.fileManager.renameFile({ path: "Old.md" }, "Archive/Old.md");
  const perTool = await recorder.endTool("mv");
  const { changes } = await recorder.finalize();
  assert.deepEqual(describeChanges(perTool), [
    { path: "Archive/Old.md", op: "renamed", from: "Old.md" },
    { path: "Index.md", op: "modified" },
  ]);
  assert.deepEqual(describeChanges(changes), [
    { path: "Archive/Old.md", op: "renamed", from: "Old.md" },
    { path: "Index.md", op: "modified" },
  ]);
});

test("direct mode keeps edits outside any tool window apart as external", async () => {
  const app = fakeApp({ "Typing.md": "a" });
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  recorder.start();
  app.files = null;
  app.vault.files.set("Typing.md", "ab");
  app.vault.trigger("modify", { path: "Typing.md" });
  const { changes, external } = await recorder.finalize();
  assert.deepEqual(changes, []);
  assert.deepEqual(describeChanges(external), [{ path: "Typing.md", op: "modified" }]);
});

test("an external runtime's writes are measured from vault events when attributed to the turn", async () => {
  const app = fakeApp({ "Daily.md": "old" });
  const recorder = createVaultChangeRecorder({ vault: app.vault, attributeUnwindowedEvents: true });
  recorder.start();
  app.vault.files.set("Daily.md", "new");
  app.vault.trigger("modify", { path: "Daily.md" });
  app.vault.files.set("Created.md", "hello");
  app.vault.trigger("create", { path: "Created.md" });
  const { changes } = await recorder.finalize({ settleMs: 1 });
  assert.deepEqual(describeChanges(changes), [
    { path: "Daily.md", op: "modified" },
    { path: "Created.md", op: "created" },
  ]);
  assert.equal(changes[1].diff.after, "hello");
});

test("frontmatter writes through fileManager are measured", async () => {
  const app = fakeApp({ "N.md": "body" });
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  const tools = recorder.instrumentApp(app);
  recorder.beginTool("prop");
  await tools.fileManager.processFrontMatter({ path: "N.md" }, (fm) => { fm.status = "done"; });
  assert.deepEqual(describeChanges(await recorder.endTool("prop")), [{ path: "N.md", op: "modified" }]);
});

test("instrumented objects pass non-mutating calls and properties through to the real objects", async () => {
  const app = fakeApp({ "A.md": "x" });
  const recorder = createVaultChangeRecorder({ vault: app.vault });
  const tools = recorder.instrumentApp(app);
  assert.equal(await tools.vault.read(tools.vault.getFileByPath("A.md")), "x");
  assert.equal(tools.workspace.name, "ws");
  assert.equal(tools.vault.files, app.vault.files);
});

test("diff excerpts keep only the changed region with line numbers", () => {
  const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 25", "LINE 25");
  const excerpt = diffExcerpt(before, after);
  assert.equal(excerpt.startLine, 22);
  assert.equal(excerpt.before.split("\n").length, 7);
  assert.match(excerpt.after, /LINE 25/);
  assert.equal(diffExcerpt("a".repeat(7000), "b".repeat(7000)), null);
});
