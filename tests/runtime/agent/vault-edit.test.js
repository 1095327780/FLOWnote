const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultEditTool, countOccurrences } = require("../../../runtime/agent/tools/vault-edit");

function fakeVault(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    _files: files,
    getFileByPath(path) {
      return files.has(path) ? { path, name: path.split("/").pop() } : null;
    },
    async cachedRead(file) {
      if (!file || !files.has(file.path)) {
        throw new Error(`cachedRead: file "${file && file.path}" not in fake vault`);
      }
      return files.get(file.path);
    },
    async modify(file, data) {
      if (!file || !files.has(file.path)) {
        throw new Error(`modify: "${file && file.path}" not in fake vault`);
      }
      files.set(file.path, data);
    },
  };
}

async function collectExecute(tool, input, ctx) {
  const events = [];
  for await (const ev of tool.execute(input, ctx || {})) events.push(ev);
  return events;
}
function lastResult(events) {
  return events.filter((e) => e.type === "result").pop();
}

// ----- helper -----

test("countOccurrences finds non-overlapping matches", () => {
  assert.equal(countOccurrences("ababa", "aba"), 1);
  assert.equal(countOccurrences("aaaa", "aa"), 2);
  assert.equal(countOccurrences("abc", ""), 0);
  assert.equal(countOccurrences("", "x"), 0);
});

// ----- factory + flags -----

test("createVaultEditTool requires getFileByPath + cachedRead + modify", () => {
  assert.throws(() => createVaultEditTool({}), /getFileByPath/);
  assert.throws(
    () => createVaultEditTool({ vault: { getFileByPath: () => null } }),
    /cachedRead \+ modify/,
  );
});

test("vault_edit declares not-read-only, not-destructive, not-concurrency-safe", () => {
  const tool = createVaultEditTool({ vault: fakeVault() });
  assert.equal(tool.isReadOnly(), false);
  assert.equal(tool.isDestructive(), false);
  assert.equal(tool.isConcurrencySafe(), false);
});

// ----- validate -----

test("vault_edit.validate enforces required fields and identical check", async () => {
  const tool = createVaultEditTool({ vault: fakeVault() });
  assert.equal((await tool.validate({})).ok, false);
  assert.equal((await tool.validate({ path: "a.md" })).ok, false);
  assert.equal((await tool.validate({ path: "a.md", old_string: "x" })).ok, false);
  assert.equal((await tool.validate({ path: "a.md", old_string: "x", new_string: "x" })).ok, false);
  assert.equal((await tool.validate({ path: "a.md", old_string: "", new_string: "y" })).ok, false);
  assert.equal(
    (await tool.validate({ path: "a.md", old_string: "a", new_string: "b" })).ok,
    true,
  );
});

test("vault_edit.validate rejects non-boolean replace_all", async () => {
  const tool = createVaultEditTool({ vault: fakeVault() });
  const r = await tool.validate({
    path: "a.md",
    old_string: "a",
    new_string: "b",
    replace_all: "yes",
  });
  assert.equal(r.ok, false);
});

// ----- checkPermissions -----

test("vault_edit checkPermissions asks unless a session grant exists", async () => {
  const tool = createVaultEditTool({ vault: fakeVault({ "a.md": "..." }) });
  const ask = await tool.checkPermissions(
    { path: "a.md", old_string: "a", new_string: "b" },
    {},
  );
  assert.equal(ask.behavior, "ask");
  const granted = await tool.checkPermissions(
    { path: "a.md", old_string: "a", new_string: "b" },
    { grants: { "vault_edit:*": "session" } },
  );
  assert.equal(granted.behavior, "allow");
});

// ----- execute -----

test("vault_edit returns error when file is missing", async () => {
  const tool = createVaultEditTool({ vault: fakeVault() });
  const r = lastResult(
    await collectExecute(tool, { path: "missing.md", old_string: "a", new_string: "b" }),
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /not found/);
});

test("vault_edit returns error when old_string is absent", async () => {
  const vault = fakeVault({ "a.md": "hello world" });
  const tool = createVaultEditTool({ vault });
  const r = lastResult(
    await collectExecute(tool, { path: "a.md", old_string: "nope", new_string: "x" }),
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /not found/);
  // file untouched
  assert.equal(vault._files.get("a.md"), "hello world");
});

test("vault_edit refuses ambiguous matches and points to replace_all", async () => {
  const vault = fakeVault({ "a.md": "foo bar foo baz foo" });
  const tool = createVaultEditTool({ vault });
  const r = lastResult(
    await collectExecute(tool, { path: "a.md", old_string: "foo", new_string: "QUX" }),
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /appears 3 times/);
  assert.match(r.content, /replace_all/);
  // file untouched
  assert.equal(vault._files.get("a.md"), "foo bar foo baz foo");
});

test("vault_edit replaces a unique match in place", async () => {
  const vault = fakeVault({ "a.md": "Hello, world!" });
  const tool = createVaultEditTool({ vault });
  const r = lastResult(
    await collectExecute(tool, { path: "a.md", old_string: "world", new_string: "FLOWnote" }),
  );
  assert.ok(!r.isError);
  assert.match(r.content, /Edited "a.md"/);
  assert.equal(vault._files.get("a.md"), "Hello, FLOWnote!");
});

test("vault_edit replace_all swaps every occurrence", async () => {
  const vault = fakeVault({ "a.md": "foo and foo and foo" });
  const tool = createVaultEditTool({ vault });
  const r = lastResult(
    await collectExecute(tool, {
      path: "a.md",
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    }),
  );
  assert.ok(!r.isError);
  assert.match(r.content, /replaced 3 occurrences/);
  assert.equal(vault._files.get("a.md"), "bar and bar and bar");
});

test("vault_edit preserves byte-count delta in the result", async () => {
  const vault = fakeVault({ "a.md": "abc" });
  const tool = createVaultEditTool({ vault });
  const r = lastResult(
    await collectExecute(tool, { path: "a.md", old_string: "abc", new_string: "abcdef" }),
  );
  assert.match(r.content, /\(\+3 bytes\)/);
});

test("vault_edit normalizes backslashes/double slashes in path", async () => {
  const vault = fakeVault({ "a/b/c.md": "hi" });
  const tool = createVaultEditTool({ vault });
  const r = lastResult(
    await collectExecute(tool, { path: "a\\b//c.md", old_string: "hi", new_string: "bye" }),
  );
  assert.ok(!r.isError);
  assert.equal(vault._files.get("a/b/c.md"), "bye");
});
