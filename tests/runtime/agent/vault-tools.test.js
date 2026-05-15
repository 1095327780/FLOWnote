const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultReadTool } = require("../../../runtime/agent/tools/vault-read");
const { createVaultWriteTool, VALID_MODES } = require("../../../runtime/agent/tools/vault-write");

// ---------------------------------------------------------------------------
// Fake vault helper — implements just enough of the Obsidian API for tests.
// ---------------------------------------------------------------------------

function fakeVault(initial = {}) {
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const [p, c] of Object.entries(initial)) files.set(p, c);

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
    async create(path, data) {
      if (files.has(path)) {
        throw new Error(`create: "${path}" already exists`);
      }
      files.set(path, data);
      return { path, name: path.split("/").pop() };
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
  for await (const ev of tool.execute(input, ctx)) events.push(ev);
  return events;
}

function lastResult(events) {
  return events.filter((e) => e.type === "result").pop();
}

// ---------------------------------------------------------------------------
// vault-read — factory + flags
// ---------------------------------------------------------------------------

test("createVaultReadTool: throws if vault is missing required methods", () => {
  assert.throws(() => createVaultReadTool({}), /vault with getFileByPath/);
  assert.throws(() => createVaultReadTool({ vault: {} }), /vault with getFileByPath/);
  assert.throws(
    () => createVaultReadTool({ vault: { getFileByPath: () => null } }),
    /vault with getFileByPath/,
  );
});

test("vault_read is read-only and concurrency-safe", () => {
  const tool = createVaultReadTool({ vault: fakeVault() });
  assert.equal(tool.isReadOnly(), true);
  assert.equal(tool.isConcurrencySafe(), true);
  assert.equal(tool.isDestructive(), false);
});

test("vault_read exposes the Anthropic-shaped schema with required path", () => {
  const tool = createVaultReadTool({ vault: fakeVault() });
  assert.equal(tool.name, "vault_read");
  assert.equal(tool.inputSchema.type, "object");
  assert.deepEqual(tool.inputSchema.required, ["path"]);
  assert.equal(tool.inputSchema.properties.path.type, "string");
});

// ---------------------------------------------------------------------------
// vault-read — validate
// ---------------------------------------------------------------------------

test("vault_read.validate rejects missing or empty path", async () => {
  const tool = createVaultReadTool({ vault: fakeVault() });
  assert.equal((await tool.validate({})).ok, false);
  assert.equal((await tool.validate({ path: "" })).ok, false);
  assert.equal((await tool.validate({ path: "   " })).ok, false);
});

test("vault_read.validate rejects non-integer offset / limit", async () => {
  const tool = createVaultReadTool({ vault: fakeVault() });
  const r1 = await tool.validate({ path: "a.md", offset: 1.5 });
  assert.equal(r1.ok, false);
  const r2 = await tool.validate({ path: "a.md", limit: "10" });
  assert.equal(r2.ok, false);
});

test("vault_read.validate accepts good inputs", async () => {
  const tool = createVaultReadTool({ vault: fakeVault() });
  assert.equal((await tool.validate({ path: "a.md" })).ok, true);
  assert.equal((await tool.validate({ path: "a.md", offset: 1, limit: 10 })).ok, true);
});

// ---------------------------------------------------------------------------
// vault-read — execute
// ---------------------------------------------------------------------------

test("vault_read returns file contents when the file exists", async () => {
  const tool = createVaultReadTool({ vault: fakeVault({ "notes/hi.md": "hello\nworld" }) });
  const events = await collectExecute(tool, { path: "notes/hi.md" });
  const r = lastResult(events);
  assert.equal(r.content, "hello\nworld");
  assert.ok(!r.isError);
});

test("vault_read returns an error result when the file is missing", async () => {
  const tool = createVaultReadTool({ vault: fakeVault() });
  const r = lastResult(await collectExecute(tool, { path: "does/not/exist.md" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /not found/);
});

test("vault_read normalizes backslashes and duplicated slashes", async () => {
  const tool = createVaultReadTool({ vault: fakeVault({ "a/b/c.md": "ok" }) });
  const r = lastResult(await collectExecute(tool, { path: "a\\b//c.md" }));
  assert.equal(r.content, "ok");
});

test("vault_read slices by offset/limit (1-indexed, inclusive)", async () => {
  const tool = createVaultReadTool({ vault: fakeVault({ "x.md": "1\n2\n3\n4\n5" }) });
  const r = lastResult(await collectExecute(tool, { path: "x.md", offset: 2, limit: 2 }));
  assert.equal(r.content, "2\n3");
});

test("vault_read with offset only reads from there to EOF", async () => {
  const tool = createVaultReadTool({ vault: fakeVault({ "x.md": "1\n2\n3\n4" }) });
  const r = lastResult(await collectExecute(tool, { path: "x.md", offset: 3 }));
  assert.equal(r.content, "3\n4");
});

test("vault_read truncates at the byte cap and tells the model", async () => {
  const big = "abc".repeat(100);
  const tool = createVaultReadTool({ vault: fakeVault({ "big.md": big }), maxBytes: 30 });
  const r = lastResult(await collectExecute(tool, { path: "big.md" }));
  assert.match(r.content, /content truncated/);
});

// ---------------------------------------------------------------------------
// vault-write — factory + flags
// ---------------------------------------------------------------------------

test("createVaultWriteTool requires create+modify+getFileByPath", () => {
  assert.throws(() => createVaultWriteTool({}), /getFileByPath/);
  assert.throws(
    () => createVaultWriteTool({ vault: { getFileByPath: () => null } }),
    /create \+ modify/,
  );
});

test("vault_write is not read-only; overwrite is flagged destructive", () => {
  const tool = createVaultWriteTool({ vault: fakeVault() });
  assert.equal(tool.isReadOnly(), false);
  assert.equal(tool.isDestructive({ mode: "overwrite" }), true);
  assert.equal(tool.isDestructive({ mode: "create" }), false);
  assert.equal(tool.isDestructive({ mode: "append" }), false);
});

test("vault_write schema mode enum matches VALID_MODES", () => {
  const tool = createVaultWriteTool({ vault: fakeVault() });
  assert.deepEqual(tool.inputSchema.properties.mode.enum, VALID_MODES);
  assert.deepEqual(tool.inputSchema.required.sort(), ["content", "path"]);
});

// ---------------------------------------------------------------------------
// vault-write — validate
// ---------------------------------------------------------------------------

test("vault_write.validate rejects missing path or non-string content", async () => {
  const tool = createVaultWriteTool({ vault: fakeVault() });
  assert.equal((await tool.validate({ content: "x" })).ok, false);
  assert.equal((await tool.validate({ path: "a.md", content: 42 })).ok, false);
  assert.equal((await tool.validate({ path: "a.md", content: "" })).ok, true);
  assert.equal((await tool.validate({ path: "a.md", content: "x", mode: "weird" })).ok, false);
});

// ---------------------------------------------------------------------------
// vault-write — checkPermissions
// ---------------------------------------------------------------------------

test("checkPermissions allows create on a new path silently", async () => {
  const tool = createVaultWriteTool({ vault: fakeVault() });
  const r = await tool.checkPermissions({ path: "new.md", content: "x", mode: "create" }, {});
  assert.equal(r.behavior, "allow");
});

test("checkPermissions asks when create targets an existing path", async () => {
  const tool = createVaultWriteTool({ vault: fakeVault({ "exists.md": "..." }) });
  const r = await tool.checkPermissions({ path: "exists.md", content: "x", mode: "create" }, {});
  assert.equal(r.behavior, "ask");
});

test("checkPermissions asks for overwrite (existing) and append (existing)", async () => {
  const tool = createVaultWriteTool({ vault: fakeVault({ "a.md": "..." }) });
  assert.equal((await tool.checkPermissions({ path: "a.md", content: "y", mode: "overwrite" }, {})).behavior, "ask");
  assert.equal((await tool.checkPermissions({ path: "a.md", content: "y", mode: "append" }, {})).behavior, "ask");
});

test("checkPermissions short-circuits to allow when session grant is present", async () => {
  const tool = createVaultWriteTool({ vault: fakeVault({ "a.md": "..." }) });
  const r = await tool.checkPermissions(
    { path: "a.md", content: "y", mode: "overwrite" },
    { grants: { "vault_write:*": "session" } },
  );
  assert.equal(r.behavior, "allow");
});

// ---------------------------------------------------------------------------
// vault-write — execute (each mode)
// ---------------------------------------------------------------------------

test("vault_write create: writes a new file and confirms bytes", async () => {
  const vault = fakeVault();
  const tool = createVaultWriteTool({ vault });
  const r = lastResult(await collectExecute(tool, { path: "new.md", content: "hi", mode: "create" }));
  assert.match(r.content, /Created "new.md"/);
  assert.equal(vault._files.get("new.md"), "hi");
});

test("vault_write create on existing path returns an error result", async () => {
  const vault = fakeVault({ "exists.md": "old" });
  const tool = createVaultWriteTool({ vault });
  const r = lastResult(await collectExecute(tool, { path: "exists.md", content: "new", mode: "create" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /already exists/);
  // Original content untouched
  assert.equal(vault._files.get("exists.md"), "old");
});

test("vault_write overwrite replaces content for existing files", async () => {
  const vault = fakeVault({ "a.md": "old" });
  const tool = createVaultWriteTool({ vault });
  const r = lastResult(await collectExecute(tool, { path: "a.md", content: "new", mode: "overwrite" }));
  assert.match(r.content, /Wrote "a.md"/);
  assert.equal(vault._files.get("a.md"), "new");
});

test("vault_write overwrite on missing path creates the file", async () => {
  const vault = fakeVault();
  const tool = createVaultWriteTool({ vault });
  const r = lastResult(await collectExecute(tool, { path: "fresh.md", content: "n", mode: "overwrite" }));
  assert.match(r.content, /Wrote "fresh.md"/);
  assert.equal(vault._files.get("fresh.md"), "n");
});

test("vault_write append concatenates onto existing content", async () => {
  const vault = fakeVault({ "a.md": "abc" });
  const tool = createVaultWriteTool({ vault });
  const r = lastResult(await collectExecute(tool, { path: "a.md", content: "DEF", mode: "append" }));
  assert.match(r.content, /Appended 3 bytes/);
  assert.equal(vault._files.get("a.md"), "abcDEF");
});

test("vault_write append on missing path creates the file", async () => {
  const vault = fakeVault();
  const tool = createVaultWriteTool({ vault });
  const r = lastResult(await collectExecute(tool, { path: "new.md", content: "first", mode: "append" }));
  assert.match(r.content, /Created "new.md" via append/);
  assert.equal(vault._files.get("new.md"), "first");
});

test("vault_write yields a progress event before the result", async () => {
  const vault = fakeVault();
  const tool = createVaultWriteTool({ vault });
  const events = await collectExecute(tool, { path: "n.md", content: "x", mode: "create" });
  assert.equal(events[0].type, "progress");
  assert.match(events[0].message, /create → n.md/);
});

test("vault_write.userFacingName describes the operation", () => {
  const tool = createVaultWriteTool({ vault: fakeVault() });
  assert.equal(tool.userFacingName({ path: "a.md", mode: "overwrite" }), "overwrite a.md");
  assert.equal(tool.userFacingName({ path: "x.md" }), "create x.md");
});
