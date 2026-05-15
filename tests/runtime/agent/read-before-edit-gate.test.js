// Tests for the read-before-edit gate on vault_edit and the
// metadataCache-lag bypass on vault_backlinks. Both use the shared
// FileStateCache passed through ctx — these tests pin the contract.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultEditTool } = require("../../../runtime/agent/tools/vault-edit");
const { createVaultReadTool } = require("../../../runtime/agent/tools/vault-read");
const { createVaultWriteTool } = require("../../../runtime/agent/tools/vault-write");
const {
  createVaultBacklinksTool,
  scanRecentWritesForLink,
} = require("../../../runtime/agent/tools/vault-backlinks");
const { FileStateCache } = require("../../../runtime/agent/file-state-cache");

function fakeVault(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    _files: files,
    getFileByPath(path) {
      return files.has(path) ? { path, name: path.split("/").pop() } : null;
    },
    async cachedRead(file) {
      if (!files.has(file.path)) throw new Error(`no ${file.path}`);
      return files.get(file.path);
    },
    async create(path, data) {
      if (files.has(path)) throw new Error(`exists ${path}`);
      files.set(path, data);
      return { path };
    },
    async modify(file, data) {
      files.set(file.path, data);
    },
  };
}

async function collect(tool, input, ctx) {
  const events = [];
  for await (const ev of tool.execute(input, ctx || {})) events.push(ev);
  return events;
}
function lastResult(events) {
  return events.filter((e) => e.type === "result").pop();
}

// ---------------------------------------------------------------------
// vault_edit read-before-edit gate
// ---------------------------------------------------------------------

test("vault_edit refuses an edit on a file that was not read this session", async () => {
  const cache = new FileStateCache();
  const tool = createVaultEditTool({ vault: fakeVault({ "a.md": "hello world" }) });
  const v = await tool.validate(
    { path: "a.md", old_string: "hello", new_string: "hi" },
    { fileStateCache: cache },
  );
  assert.equal(v.ok, false);
  assert.match(v.error, /vault_read on "a\.md" first/);
});

test("vault_edit allows the edit after vault_read populates the cache", async () => {
  const cache = new FileStateCache();
  const vault = fakeVault({ "a.md": "hello world" });
  const ctx = { fileStateCache: cache };

  const reader = createVaultReadTool({ vault });
  await collect(reader, { path: "a.md" }, ctx);

  const editor = createVaultEditTool({ vault });
  const v = await editor.validate(
    { path: "a.md", old_string: "hello", new_string: "hi" },
    ctx,
  );
  assert.equal(v.ok, true);

  const r = lastResult(await collect(editor, { path: "a.md", old_string: "hello", new_string: "hi" }, ctx));
  assert.ok(!r.isError);
  assert.equal(vault._files.get("a.md"), "hi world");
});

test("vault_edit also accepts a file that was vault_write-created earlier this session", async () => {
  const cache = new FileStateCache();
  const vault = fakeVault();
  const ctx = { fileStateCache: cache };

  const writer = createVaultWriteTool({ vault });
  await collect(writer, { path: "fresh.md", content: "abc def", mode: "create" }, ctx);

  const editor = createVaultEditTool({ vault });
  const v = await editor.validate(
    { path: "fresh.md", old_string: "abc", new_string: "XYZ" },
    ctx,
  );
  assert.equal(v.ok, true);
});

test("vault_edit gate is BYPASSED when no cache is in ctx (back-compat)", async () => {
  const tool = createVaultEditTool({ vault: fakeVault({ "a.md": "hi" }) });
  const v = await tool.validate(
    { path: "a.md", old_string: "hi", new_string: "bye" },
    {},
  );
  assert.equal(v.ok, true);
});

test("vault_edit updates the cache content after a successful edit", async () => {
  const cache = new FileStateCache();
  const vault = fakeVault({ "a.md": "old text" });
  const ctx = { fileStateCache: cache };

  await collect(createVaultReadTool({ vault }), { path: "a.md" }, ctx);
  await collect(
    createVaultEditTool({ vault }),
    { path: "a.md", old_string: "old", new_string: "new" },
    ctx,
  );

  const entry = cache.get("a.md");
  assert.equal(entry.content, "new text");
  assert.equal(entry.writtenInTurn, true);
});

// ---------------------------------------------------------------------
// vault_backlinks merges recent-writes from FileStateCache
// ---------------------------------------------------------------------

function backlinksApp({ existingPaths = [], metadataLinks = {} }) {
  const fileByPath = (path) => {
    if (!existingPaths.includes(path)) return null;
    return { path, basename: path.split("/").pop().replace(/\.md$/i, "") };
  };
  return {
    vault: { getFileByPath: fileByPath },
    metadataCache: { resolvedLinks: metadataLinks },
  };
}

test("scanRecentWritesForLink finds [[basename]] in recently-written files", () => {
  const cache = new FileStateCache();
  cache.recordWrite("src.md", "intro\n> 出处：[[target]]\nmore");
  const map = scanRecentWritesForLink(
    { fileStateCache: cache },
    { path: "02-培养层/永久笔记/target.md", basename: "target" },
  );
  assert.equal(map.get("src.md"), 1);
});

test("scanRecentWritesForLink finds [[full/path]] and [[full/path.md]] variants", () => {
  const cache = new FileStateCache();
  cache.recordWrite("a.md", "[[02-培养层/永久笔记/target]]");
  cache.recordWrite("b.md", "[[02-培养层/永久笔记/target.md]]");
  const map = scanRecentWritesForLink(
    { fileStateCache: cache },
    { path: "02-培养层/永久笔记/target.md", basename: "target" },
  );
  assert.equal(map.get("a.md"), 1);
  assert.equal(map.get("b.md"), 1);
});

test("scanRecentWritesForLink handles aliased links like [[target|display]]", () => {
  const cache = new FileStateCache();
  cache.recordWrite("src.md", "see [[target|the target note]] for details");
  const map = scanRecentWritesForLink(
    { fileStateCache: cache },
    { path: "target.md", basename: "target" },
  );
  assert.equal(map.get("src.md"), 1);
});

test("scanRecentWritesForLink ignores files that were only READ, not written", () => {
  const cache = new FileStateCache();
  cache.recordRead("read-only.md", "[[target]]");
  cache.recordWrite("written.md", "[[target]]");
  const map = scanRecentWritesForLink(
    { fileStateCache: cache },
    { path: "target.md", basename: "target" },
  );
  assert.equal(map.has("read-only.md"), false);
  assert.equal(map.get("written.md"), 1);
});

test("scanRecentWritesForLink skips self-links", () => {
  const cache = new FileStateCache();
  cache.recordWrite("target.md", "self [[target]] inside the same file");
  const map = scanRecentWritesForLink(
    { fileStateCache: cache },
    { path: "target.md", basename: "target" },
  );
  assert.equal(map.size, 0);
});

test("scanRecentWritesForLink returns empty map with no cache", () => {
  const map = scanRecentWritesForLink({}, { path: "x.md", basename: "x" });
  assert.equal(map.size, 0);
});

test("vault_backlinks merges metadataCache results AND recent writes", async () => {
  const cache = new FileStateCache();
  cache.recordWrite("recent.md", "see [[target]]");

  const tool = createVaultBacklinksTool({
    app: backlinksApp({
      existingPaths: ["target.md"],
      // an "old" link the metadataCache already knew about
      metadataLinks: { "old.md": { "target.md": 1 } },
    }),
  });
  const r = lastResult(await collect(tool, { path: "target.md" }, { fileStateCache: cache }));
  assert.match(r.content, /old\.md/);
  assert.match(r.content, /recent\.md/);
});

test("vault_backlinks falls back gracefully when no cache is in ctx", async () => {
  const tool = createVaultBacklinksTool({
    app: backlinksApp({
      existingPaths: ["target.md"],
      metadataLinks: { "old.md": { "target.md": 1 } },
    }),
  });
  const r = lastResult(await collect(tool, { path: "target.md" }, {}));
  assert.match(r.content, /old\.md/);
});
