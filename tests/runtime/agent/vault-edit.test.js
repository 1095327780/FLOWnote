const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultEditTool, countOccurrences } = require("../../../runtime/agent/tools/vault-edit");
const { FileStateCache } = require("../../../runtime/agent/file-state-cache");
const { ToolRegistry } = require("../../../runtime/agent/tool-registry");
const { runToolUse, createEffectReceipt } = require("../../../runtime/agent/agent-loop");

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

test("vault_edit verifies the actual legacy memory path and its exact new content", async () => {
  const path = "Meta/.ai-memory/STATUS.md";
  const vault = fakeVault({ [path]: "before" });
  const cache = new FileStateCache();
  cache.recordRead(path, "before");
  const ctx = { fileStateCache: cache };
  const tool = createVaultEditTool({ vault });
  const input = { path, old_string: "before", new_string: "after" };

  assert.equal((await tool.validate(input, ctx)).ok, true);
  const result = lastResult(await collectExecute(tool, input, ctx));
  assert.equal(result.isError, undefined);
  assert.equal(vault._files.get(path), "after");
  assert.equal(vault._files.has("Meta/ai-memory/STATUS.md"), false);
  assert.equal((await tool.verifyEffect(input, { data: result.data }, ctx)).verified, true);
  assert.equal((await tool.verifyEffect(input, null, ctx)).verified, false);

  vault._files.set("Meta/ai-memory/STATUS.md", "after");
  vault._files.set(path, "drifted");
  assert.equal((await tool.verifyEffect(input, { data: result.data }, ctx)).verified, false);
});

for (const canonicalExists of [false, true]) {
  test(`vault_edit effect receipt targets the actual ${canonicalExists ? "canonical" : "legacy"} memory path`, async () => {
    const legacy = "Meta/.ai-memory/STATUS.md";
    const canonical = "Meta/ai-memory/STATUS.md";
    const actual = canonicalExists ? canonical : legacy;
    const vault = fakeVault(canonicalExists ? { [legacy]: "before", [canonical]: "before" } : { [legacy]: "before" });
    const cache = new FileStateCache();
    cache.recordRead(actual, "before");
    const ctx = { fileStateCache: cache };
    const registry = new ToolRegistry();
    registry.register(createVaultEditTool({ vault }));
    const toolUse = { id: "edit-memory", name: "vault_edit", input: { path: legacy, old_string: "before", new_string: "after" } };

    const result = await runToolUse(toolUse, registry, ctx, async () => ({ behavior: "allow" }));
    const receipt = await createEffectReceipt(toolUse, result, ctx);

    assert.equal(result.isError, false);
    assert.equal(result.verification.verified, true);
    assert.deepEqual(result.capabilities.targets, [actual]);
    assert.equal(receipt.verified, true);
    assert.deepEqual(receipt.paths, [actual]);
    assert.equal(vault._files.get(actual), "after");
    if (canonicalExists) assert.equal(vault._files.get(legacy), "before");
  });
}

test("vault_edit permission prompt names the legacy memory file it will actually change", async () => {
  const legacy = "Meta/.ai-memory/STATUS.md";
  const canonical = "Meta/ai-memory/STATUS.md";
  const legacyOnly = createVaultEditTool({ vault: fakeVault({ [legacy]: "before" }) });
  const input = { path: legacy, old_string: "before", new_string: "after" };
  assert.equal((await legacyOnly.checkPermissions(input, {})).summary, `edit → ${legacy}`);

  const both = createVaultEditTool({ vault: fakeVault({ [legacy]: "before", [canonical]: "before" }) });
  assert.equal((await both.checkPermissions(input, {})).summary, `edit → ${canonical}`);
});

test("vault_edit read-before-edit refusal points at the readable legacy memory file", async () => {
  const legacy = "Meta/.ai-memory/STATUS.md";
  const tool = createVaultEditTool({ vault: fakeVault({ [legacy]: "before" }) });
  const result = await tool.validate(
    { path: legacy, old_string: "before", new_string: "after" },
    { fileStateCache: new FileStateCache() },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /vault_read on "Meta\/\.ai-memory\/STATUS\.md"/);
});
