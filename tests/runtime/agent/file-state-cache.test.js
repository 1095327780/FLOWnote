const test = require("node:test");
const assert = require("node:assert/strict");

const { FileStateCache } = require("../../../runtime/agent/file-state-cache");

test("FileStateCache: empty by default", () => {
  const c = new FileStateCache();
  assert.equal(c.size(), 0);
  assert.equal(c.has("a.md"), false);
  assert.equal(c.get("a.md"), undefined);
});

test("FileStateCache: recordRead is reflected in has/get and NOT marked writtenInTurn", () => {
  const c = new FileStateCache();
  c.recordRead("a.md", "hello");
  assert.equal(c.has("a.md"), true);
  const e = c.get("a.md");
  assert.equal(e.content, "hello");
  assert.equal(e.writtenInTurn, false);
  assert.ok(e.readAt > 0);
});

test("FileStateCache: recordWrite marks writtenInTurn=true", () => {
  const c = new FileStateCache();
  c.recordWrite("a.md", "world");
  assert.equal(c.get("a.md").writtenInTurn, true);
});

test("FileStateCache: recordWrite after recordRead promotes the entry to writtenInTurn", () => {
  const c = new FileStateCache();
  c.recordRead("a.md", "v1");
  c.recordWrite("a.md", "v2");
  const e = c.get("a.md");
  assert.equal(e.content, "v2");
  assert.equal(e.writtenInTurn, true);
});

test("FileStateCache: recentWrites returns only files written, not just read", () => {
  const c = new FileStateCache();
  c.recordRead("a.md", "x");
  c.recordWrite("b.md", "y");
  c.recordWrite("c.md", "z");
  const paths = c.recentWrites().map((e) => e.path).sort();
  assert.deepEqual(paths, ["b.md", "c.md"]);
});

test("FileStateCache: silently ignores invalid inputs", () => {
  const c = new FileStateCache();
  c.recordRead("", "x");
  c.recordRead("a.md", null);
  c.recordWrite(undefined, "y");
  assert.equal(c.size(), 0);
});
