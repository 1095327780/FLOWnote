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

test("FileStateCache: snapshot stores fingerprints without duplicating file contents", () => {
  const c = new FileStateCache();
  c.recordRead("a.md", "hello");
  c.recordWrite("b.md", "world");
  const snapshot = c.snapshot();

  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.entries.map((entry) => entry.path), ["a.md", "b.md"]);
  assert.equal(snapshot.entries[0].content, undefined);
  assert.equal(typeof snapshot.entries[0].fingerprint, "string");
  assert.equal(snapshot.entries[1].writtenInTurn, true);
});

test("FileStateCache: restoreSnapshot hydrates only files that have not drifted", async () => {
  const before = new FileStateCache();
  before.recordRead("same.md", "stable");
  before.recordWrite("changed.md", "old");
  const snapshot = before.snapshot();
  const after = new FileStateCache();

  const result = await after.restoreSnapshot(snapshot, async (path) => (
    path === "same.md" ? "stable" : "external edit"
  ));

  assert.deepEqual(result.restoredPaths, ["same.md"]);
  assert.deepEqual(result.driftedPaths, ["changed.md"]);
  assert.equal(after.has("same.md"), true);
  assert.equal(after.has("changed.md"), false);
});

test("FileStateCache keeps full host text separate from model-visible ranges", async () => {
  const cache = new FileStateCache();
  cache.recordRead("note.md", "seen unseen", { visibleRanges: [[0, 4]] });
  assert.equal(cache.get("note.md").content, "seen unseen");
  assert.equal(cache.isTextVisible("note.md", "seen"), true);
  assert.equal(cache.isTextVisible("note.md", "unseen"), false);
  assert.equal(cache.matchesContent("note.md", "seen unseen"), true);
  assert.equal(cache.matchesContent("note.md", "seen changed"), false);
  cache.recordRead("note.md", "seen unseen", { visibleRanges: [[5, 11]] });
  assert.equal(cache.isTextVisible("note.md", "unseen"), true);
  const restored = new FileStateCache();
  await restored.restoreSnapshot(cache.snapshot(), async () => "seen unseen");
  assert.equal(restored.isTextVisible("note.md", "unseen"), true);
});

test("FileStateCache restores legacy snapshots without granting edit visibility", async () => {
  const cache = new FileStateCache();
  cache.recordRead("note.md", "old text", { visibleRanges: [[0, 8]] });
  const snapshot = cache.snapshot();
  snapshot.version = 1;
  const restored = new FileStateCache();
  await restored.restoreSnapshot(snapshot, async () => "old text");
  assert.equal(restored.matchesContent("note.md", "old text"), true);
  assert.equal(restored.isTextVisible("note.md", "old text"), false);
});

test("FileStateCache host writes retain full content without promoting unseen text", async () => {
  const cache = new FileStateCache();
  cache.recordHostWrite("note.md", "seen unseen");
  assert.equal(cache.get("note.md").writtenInTurn, true);
  assert.equal(cache.isTextVisible("note.md", "unseen"), false);
  const restored = new FileStateCache();
  await restored.restoreSnapshot(cache.snapshot(), async () => "seen unseen");
  assert.equal(restored.isTextVisible("note.md", "unseen"), false);
  const legacy = cache.snapshot();
  legacy.version = 1;
  const legacyRestored = new FileStateCache();
  await legacyRestored.restoreSnapshot(legacy, async () => "seen unseen");
  assert.equal(legacyRestored.isTextVisible("note.md", "unseen"), false);
});
