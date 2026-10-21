const test = require("node:test");
const assert = require("node:assert/strict");
const { FileStateCache } = require("../../../runtime/agent/file-state-cache");
const { createVaultReadTool } = require("../../../runtime/agent/tools/vault-read");
const { createVaultEditTool } = require("../../../runtime/agent/tools/vault-edit");
const { createVaultWriteTool } = require("../../../runtime/agent/tools/vault-write");

function vaultFor(initial) {
  let content = initial;
  return {
    getFileByPath(path) { return path === "note.md" ? { path } : null; },
    async cachedRead() { return content; },
    async read() { return content; },
    async modify(_file, next) { content = next; },
    async create(_path, next) { content = next; },
    async process(_file, update) { content = update(content); },
    current() { return content; },
    externalChange(next) { content = next; },
  };
}

async function resultOf(tool, input, ctx) {
  let result;
  for await (const event of tool.execute(input, ctx)) {
    if (event.type === "result") result = event;
  }
  return result;
}

test("a proven full read survives an exact edit without a redundant reread", async () => {
  const vault = vaultFor("front middle tail");
  const cache = new FileStateCache();
  const ctx = { fileStateCache: cache };
  await resultOf(createVaultReadTool({ vault }), { path: "note.md" }, ctx);
  const edit = createVaultEditTool({ vault });
  await resultOf(edit, { path: "note.md", old_string: "front", new_string: "start" }, ctx);
  assert.equal((await edit.validate({ path: "note.md", old_string: "tail", new_string: "end" }, ctx)).ok, true);
});

test("append credits the supplied text but does not promote an unseen original prefix", async () => {
  const vault = vaultFor("unseen old text");
  const cache = new FileStateCache();
  const ctx = { fileStateCache: cache };
  await resultOf(createVaultWriteTool({ vault }), { path: "note.md", mode: "append", content: " new supplied" }, ctx);
  assert.equal(cache.isTextVisible("note.md", "unseen"), false);
  assert.equal(cache.isTextVisible("note.md", "new supplied"), true);
  await resultOf(createVaultReadTool({ vault }), { path: "note.md" }, ctx);
  await resultOf(createVaultWriteTool({ vault }), { path: "note.md", mode: "append", content: " more" }, ctx);
  assert.equal(cache.isTextVisible("note.md", "unseen"), true);
});

test("vault_read grants visibility only for the returned page and later pages extend it", async () => {
  const vault = vaultFor("front middle tail");
  const cache = new FileStateCache();
  const read = createVaultReadTool({ vault, maxBytes: 6 });
  const ctx = { fileStateCache: cache };
  const first = await resultOf(read, { path: "note.md" }, ctx);
  assert.equal(first.data.page.truncated, true);
  assert.equal(cache.get("note.md").content, "front middle tail");
  assert.equal(cache.isTextVisible("note.md", "front"), true);
  assert.equal(cache.isTextVisible("note.md", "tail"), false);
  const edit = createVaultEditTool({ vault });
  assert.equal((await edit.validate({ path: "note.md", old_string: "tail", new_string: "end" }, ctx)).ok, false);
  await resultOf(read, { path: "note.md", byteOffset: 6 }, ctx);
  await resultOf(read, { path: "note.md", byteOffset: 12 }, ctx);
  assert.equal(cache.isTextVisible("note.md", "tail"), true);
});

test("vault_edit refuses stale evidence even when old_string still exists", async () => {
  const vault = vaultFor("before target after");
  const cache = new FileStateCache();
  cache.recordRead("note.md", vault.current());
  const edit = createVaultEditTool({ vault });
  const input = { path: "note.md", old_string: "target", new_string: "updated" };
  assert.equal((await edit.validate(input, { fileStateCache: cache })).ok, true);
  vault.externalChange("changed target after");
  const result = await resultOf(edit, input, { fileStateCache: cache });
  assert.equal(result.isError, true);
  assert.equal(vault.current(), "changed target after");
});

test("vault_edit replace_all requires every occurrence to have been visible", async () => {
  const vault = vaultFor("target hidden target");
  const cache = new FileStateCache();
  cache.recordRead("note.md", vault.current(), { visibleRanges: [[0, 6]] });
  const edit = createVaultEditTool({ vault });
  const input = { path: "note.md", old_string: "target", new_string: "updated", replace_all: true };
  assert.equal((await edit.validate(input, { fileStateCache: cache })).ok, false);
  cache.recordRead("note.md", vault.current(), { visibleRanges: [[14, 20]] });
  assert.equal((await edit.validate(input, { fileStateCache: cache })).ok, true);
});

test("vault_edit checks live content again inside process", async () => {
  const vault = vaultFor("before target after");
  const cache = new FileStateCache();
  cache.recordRead("note.md", vault.current());
  const edit = createVaultEditTool({ vault });
  const baseRead = vault.cachedRead;
  vault.cachedRead = async (...args) => {
    const prior = await baseRead(...args);
    vault.externalChange("concurrent target after");
    return prior;
  };
  const result = await resultOf(edit, { path: "note.md", old_string: "target", new_string: "updated" }, { fileStateCache: cache });
  assert.equal(result.isError, true);
  assert.equal(vault.current(), "concurrent target after");
});

test("editing a visible prefix does not promote the unseen suffix to full visibility", async () => {
  const vault = vaultFor("front unseen tail");
  const cache = new FileStateCache();
  const ctx = { fileStateCache: cache };
  const read = createVaultReadTool({ vault, maxBytes: 6 });
  await resultOf(read, { path: "note.md" }, ctx);
  const edit = createVaultEditTool({ vault });
  const first = { path: "note.md", old_string: "front", new_string: "hello" };
  assert.equal((await edit.validate(first, ctx)).ok, true);
  assert.equal((await resultOf(edit, first, ctx)).isError, undefined);
  assert.equal(vault.current(), "hello unseen tail");
  assert.equal(cache.isTextVisible("note.md", "hello"), true);
  assert.equal(cache.isTextVisible("note.md", "tail"), false);
  assert.equal((await edit.validate({ path: "note.md", old_string: "tail", new_string: "end" }, ctx)).ok, false);
});
