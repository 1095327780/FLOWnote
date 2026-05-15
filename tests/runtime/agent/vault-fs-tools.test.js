const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultMoveTool } = require("../../../runtime/agent/tools/vault-move");
const { createVaultCreateDirTool } = require("../../../runtime/agent/tools/vault-create-dir");
const { createVaultGetActiveFileTool } = require("../../../runtime/agent/tools/vault-get-active-file");

async function collect(tool, input, ctx) {
  const events = [];
  for await (const ev of tool.execute(input, ctx || {})) events.push(ev);
  return events;
}
function lastResult(events) {
  return events.filter((e) => e.type === "result").pop();
}

// ===========================================================================
// vault_move
// ===========================================================================

function fakeMoveApp(initial = {}) {
  // initial: { path: isFolder ? {children:[]} : "content" } — simplified
  const files = new Map();
  for (const [p, v] of Object.entries(initial)) files.set(p, v);
  const calls = [];
  return {
    _files: files,
    _calls: calls,
    vault: {
      getAbstractFileByPath(path) {
        if (!files.has(path)) return null;
        return { path, name: path.split("/").pop() };
      },
    },
    fileManager: {
      async renameFile(file, newPath) {
        calls.push({ from: file.path, to: newPath });
        const data = files.get(file.path);
        files.delete(file.path);
        files.set(newPath, data);
      },
    },
  };
}

test("createVaultMoveTool requires the right app surface", () => {
  assert.throws(() => createVaultMoveTool({}), /app\.vault required/);
  assert.throws(
    () => createVaultMoveTool({ app: { vault: {} } }),
    /getAbstractFileByPath required/,
  );
  assert.throws(
    () => createVaultMoveTool({ app: { vault: { getAbstractFileByPath: () => null } } }),
    /renameFile required/,
  );
});

test("vault_move is destructive and not concurrency-safe", () => {
  const tool = createVaultMoveTool({ app: fakeMoveApp() });
  assert.equal(tool.isReadOnly(), false);
  assert.equal(tool.isDestructive(), true);
  assert.equal(tool.isConcurrencySafe(), false);
});

test("vault_move.validate enforces both fields and non-identity", async () => {
  const tool = createVaultMoveTool({ app: fakeMoveApp() });
  assert.equal((await tool.validate({})).ok, false);
  assert.equal((await tool.validate({ from: "a.md" })).ok, false);
  assert.equal((await tool.validate({ from: "a.md", to: "a.md" })).ok, false);
  assert.equal((await tool.validate({ from: "a.md", to: "b.md" })).ok, true);
});

test("vault_move checkPermissions asks unless session grant exists", async () => {
  const tool = createVaultMoveTool({ app: fakeMoveApp({ "a.md": "x" }) });
  const ask = await tool.checkPermissions({ from: "a.md", to: "b.md" }, {});
  assert.equal(ask.behavior, "ask");
  const granted = await tool.checkPermissions(
    { from: "a.md", to: "b.md" },
    { grants: { "vault_move:*": "session" } },
  );
  assert.equal(granted.behavior, "allow");
});

test("vault_move returns error when source missing", async () => {
  const tool = createVaultMoveTool({ app: fakeMoveApp() });
  const r = lastResult(await collect(tool, { from: "missing.md", to: "x.md" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /source not found/);
});

test("vault_move refuses when destination exists", async () => {
  const tool = createVaultMoveTool({ app: fakeMoveApp({ "a.md": "x", "b.md": "y" }) });
  const r = lastResult(await collect(tool, { from: "a.md", to: "b.md" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /already exists/);
});

test("vault_move delegates to fileManager.renameFile (so wikilinks get rewritten)", async () => {
  const app = fakeMoveApp({ "old/a.md": "x" });
  const tool = createVaultMoveTool({ app });
  const r = lastResult(await collect(tool, { from: "old/a.md", to: "new/a.md" }));
  assert.ok(!r.isError);
  assert.deepEqual(app._calls, [{ from: "old/a.md", to: "new/a.md" }]);
  assert.equal(app._files.has("new/a.md"), true);
  assert.equal(app._files.has("old/a.md"), false);
  assert.match(r.content, /Wikilinks pointing at this file have been rewritten/);
});

test("vault_move surfaces renameFile crashes as error result", async () => {
  const app = fakeMoveApp({ "a.md": "x" });
  app.fileManager.renameFile = async () => {
    throw new Error("disk full");
  };
  const tool = createVaultMoveTool({ app });
  const r = lastResult(await collect(tool, { from: "a.md", to: "b.md" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /disk full/);
});

test("vault_move normalizes backslashes and trailing slashes", async () => {
  const app = fakeMoveApp({ "a/b.md": "x" });
  const tool = createVaultMoveTool({ app });
  await collect(tool, { from: "a\\b.md", to: "c\\d.md" });
  assert.equal(app._files.has("c/d.md"), true);
});

// ===========================================================================
// vault_create_dir
// ===========================================================================

function fakeDirApp() {
  const folders = new Set();
  const calls = [];
  return {
    _folders: folders,
    _calls: calls,
    vault: {
      getAbstractFileByPath(path) {
        return folders.has(path) ? { path } : null;
      },
      async createFolder(path) {
        calls.push(path);
        folders.add(path);
      },
    },
  };
}

test("createVaultCreateDirTool requires the right vault surface", () => {
  assert.throws(() => createVaultCreateDirTool({}), /app\.vault required/);
  assert.throws(
    () => createVaultCreateDirTool({ app: { vault: {} } }),
    /createFolder required/,
  );
});

test("vault_create_dir is idempotent on existing path", async () => {
  const app = fakeDirApp();
  app._folders.add("a/b");
  const tool = createVaultCreateDirTool({ app });
  const r = lastResult(await collect(tool, { path: "a/b" }));
  assert.ok(!r.isError);
  assert.match(r.content, /already exists/);
  // createFolder was NOT called
  assert.deepEqual(app._calls, []);
});

test("vault_create_dir calls createFolder for a fresh path", async () => {
  const app = fakeDirApp();
  const tool = createVaultCreateDirTool({ app });
  const r = lastResult(await collect(tool, { path: "fresh/dir" }));
  assert.ok(!r.isError);
  assert.match(r.content, /Created folder/);
  assert.deepEqual(app._calls, ["fresh/dir"]);
});

test("vault_create_dir.validate rejects missing path", async () => {
  const app = fakeDirApp();
  const tool = createVaultCreateDirTool({ app });
  assert.equal((await tool.validate({})).ok, false);
  assert.equal((await tool.validate({ path: "" })).ok, false);
  assert.equal((await tool.validate({ path: "ok" })).ok, true);
});

test("vault_create_dir is concurrency-safe (idempotent)", () => {
  const app = fakeDirApp();
  const tool = createVaultCreateDirTool({ app });
  assert.equal(tool.isConcurrencySafe(), true);
});

test("vault_create_dir empty-after-normalize path is a no-op", async () => {
  const app = fakeDirApp();
  const tool = createVaultCreateDirTool({ app });
  const r = lastResult(await collect(tool, { path: "/" }));
  assert.match(r.content, /vault root/);
  assert.deepEqual(app._calls, []);
});

test("vault_create_dir surfaces createFolder errors", async () => {
  const app = fakeDirApp();
  app.vault.createFolder = async () => {
    throw new Error("permission denied");
  };
  const tool = createVaultCreateDirTool({ app });
  const r = lastResult(await collect(tool, { path: "x" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /permission denied/);
});

// ===========================================================================
// vault_get_active_file
// ===========================================================================

test("createVaultGetActiveFileTool requires app.workspace.getActiveFile", () => {
  assert.throws(() => createVaultGetActiveFileTool({}), /getActiveFile required/);
  assert.throws(
    () => createVaultGetActiveFileTool({ app: { workspace: {} } }),
    /getActiveFile required/,
  );
});

test("vault_get_active_file returns null-result when no file is open", async () => {
  const tool = createVaultGetActiveFileTool({
    app: { workspace: { getActiveFile: () => null } },
  });
  const r = lastResult(await collect(tool, {}));
  assert.match(r.content, /no active file/);
});

test("vault_get_active_file returns path/basename/parent for the open file", async () => {
  const tool = createVaultGetActiveFileTool({
    app: {
      workspace: {
        getActiveFile: () => ({
          path: "01-捕获层/每日笔记/2026-05-15.md",
          basename: "2026-05-15",
          parent: { path: "01-捕获层/每日笔记" },
        }),
      },
    },
  });
  const r = lastResult(await collect(tool, {}));
  const parsed = JSON.parse(r.content);
  assert.equal(parsed.path, "01-捕获层/每日笔记/2026-05-15.md");
  assert.equal(parsed.basename, "2026-05-15");
  assert.equal(parsed.parent, "01-捕获层/每日笔记");
});

test("vault_get_active_file is read-only + always-allow", async () => {
  const tool = createVaultGetActiveFileTool({
    app: { workspace: { getActiveFile: () => null } },
  });
  assert.equal(tool.isReadOnly(), true);
  assert.equal(tool.isConcurrencySafe(), true);
  const perm = await tool.checkPermissions({}, {});
  assert.equal(perm.behavior, "allow");
});

test("vault_get_active_file surfaces workspace crashes", async () => {
  const tool = createVaultGetActiveFileTool({
    app: {
      workspace: {
        getActiveFile() {
          throw new Error("workspace not ready");
        },
      },
    },
  });
  const r = lastResult(await collect(tool, {}));
  assert.equal(r.isError, true);
  assert.match(r.content, /workspace not ready/);
});
