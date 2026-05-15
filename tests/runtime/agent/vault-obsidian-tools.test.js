const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createVaultDailyTool,
  formatDate,
  parseISODate,
  buildDailyPath,
} = require("../../../runtime/agent/tools/vault-daily");
const {
  createVaultPropertyTool,
  coerceValue,
} = require("../../../runtime/agent/tools/vault-property");
const {
  createVaultBacklinksTool,
  collectBacklinks,
} = require("../../../runtime/agent/tools/vault-backlinks");
const {
  createVaultTasksTool,
  snippet,
} = require("../../../runtime/agent/tools/vault-tasks");
const {
  createVaultTagsTool,
  normalizeTag,
  fileHasTag,
} = require("../../../runtime/agent/tools/vault-tags");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fakeVault(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    _files: files,
    getFileByPath(path) {
      return files.has(path) ? { path, name: path.split("/").pop() } : null;
    },
    async cachedRead(file) {
      if (!file || !files.has(file.path)) throw new Error(`no ${file && file.path}`);
      return files.get(file.path);
    },
    async create(path, data) {
      if (files.has(path)) throw new Error(`exists: ${path}`);
      files.set(path, data);
      return { path };
    },
    async modify(file, data) {
      files.set(file.path, data);
    },
    getMarkdownFiles() {
      return Array.from(files.keys()).map((p) => ({ path: p, name: p.split("/").pop() }));
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

// ===========================================================================
// vault_daily
// ===========================================================================

test("formatDate handles YYYY/MM/DD + bracket escapes + weekday tokens", () => {
  const d = new Date(2026, 4, 15, 12, 0, 0); // 2026-05-15 (Fri)
  assert.equal(formatDate(d, "YYYY-MM-DD"), "2026-05-15");
  assert.equal(formatDate(d, "YYYY/MM/DD"), "2026/05/15");
  assert.equal(formatDate(d, "YYYY[年]MM[月]DD[日]"), "2026年05月15日");
  assert.equal(formatDate(d, "YYYY-MM-DD dddd"), "2026-05-15 星期五");
});

test("parseISODate accepts valid YYYY-MM-DD, rejects garbage", () => {
  assert.ok(parseISODate("2026-05-15") instanceof Date);
  assert.equal(parseISODate("2026-13-01"), null);
  assert.equal(parseISODate("2026/05/15"), null);
  assert.equal(parseISODate("today"), null);
});

test("buildDailyPath joins folder + format + .md correctly", () => {
  const d = new Date(2026, 4, 15, 12, 0, 0);
  assert.equal(buildDailyPath("", "YYYY-MM-DD", d), "2026-05-15.md");
  assert.equal(buildDailyPath("daily", "YYYY-MM-DD", d), "daily/2026-05-15.md");
  assert.equal(buildDailyPath("daily/", "YYYY/MM/DD", d), "daily/2026/05/15.md");
});

function fakeApp({ vault, dnOptions, dnEnabled = true } = {}) {
  return {
    vault: vault || fakeVault(),
    internalPlugins: {
      plugins: {
        "daily-notes": {
          enabled: dnEnabled,
          instance: { options: dnOptions || { folder: "", format: "YYYY-MM-DD", template: "" } },
        },
      },
    },
  };
}

test("createVaultDailyTool requires app + vault", () => {
  assert.throws(() => createVaultDailyTool({}), /app\.vault required/);
});

test("vault_daily read returns error when today's note doesn't exist", async () => {
  const tool = createVaultDailyTool({
    app: fakeApp({ vault: fakeVault() }),
    now: () => new Date(2026, 4, 15, 12, 0, 0),
  });
  const r = lastResult(await collect(tool, { mode: "read" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /does not exist/);
});

test("vault_daily read returns the existing note", async () => {
  const tool = createVaultDailyTool({
    app: fakeApp({ vault: fakeVault({ "2026-05-15.md": "today's body" }) }),
    now: () => new Date(2026, 4, 15, 12, 0, 0),
  });
  const r = lastResult(await collect(tool, { mode: "read" }));
  assert.equal(r.content, "today's body");
});

test("vault_daily honors daily-notes plugin folder + format", async () => {
  const vault = fakeVault({ "daily/2026-05-15.md": "found" });
  const tool = createVaultDailyTool({
    app: fakeApp({
      vault,
      dnOptions: { folder: "daily", format: "YYYY-MM-DD", template: "" },
    }),
    now: () => new Date(2026, 4, 15, 12, 0, 0),
  });
  const r = lastResult(await collect(tool, { mode: "read" }));
  assert.equal(r.content, "found");
});

test("vault_daily append creates the note when missing and seeds from template", async () => {
  const vault = fakeVault({ "tpl/daily.md": "## Default header\n" });
  const tool = createVaultDailyTool({
    app: fakeApp({
      vault,
      dnOptions: { folder: "", format: "YYYY-MM-DD", template: "tpl/daily" },
    }),
    now: () => new Date(2026, 4, 15, 12, 0, 0),
  });
  const r = lastResult(await collect(tool, { mode: "append", content: "- new line" }));
  assert.ok(!r.isError);
  assert.match(vault._files.get("2026-05-15.md"), /Default header/);
  assert.match(vault._files.get("2026-05-15.md"), /- new line/);
});

test("vault_daily append onto existing note adds a newline if needed", async () => {
  const vault = fakeVault({ "2026-05-15.md": "first line" });
  const tool = createVaultDailyTool({
    app: fakeApp({ vault }),
    now: () => new Date(2026, 4, 15, 12, 0, 0),
  });
  await collect(tool, { mode: "append", content: "second line" });
  assert.equal(vault._files.get("2026-05-15.md"), "first line\nsecond line");
});

test("vault_daily create refuses when note exists", async () => {
  const vault = fakeVault({ "2026-05-15.md": "exists" });
  const tool = createVaultDailyTool({
    app: fakeApp({ vault }),
    now: () => new Date(2026, 4, 15, 12, 0, 0),
  });
  const r = lastResult(await collect(tool, { mode: "create" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /already exists/);
});

test("vault_daily.validate rejects bad date / mode", async () => {
  const tool = createVaultDailyTool({ app: fakeApp() });
  assert.equal((await tool.validate({ mode: "weird" })).ok, false);
  assert.equal((await tool.validate({ date: "yesterday" })).ok, false);
  assert.equal((await tool.validate({})).ok, true);
});

// ===========================================================================
// vault_property
// ===========================================================================

function fakePropertyApp(files = {}) {
  // files: { path: { frontmatter, body } }
  const store = new Map();
  for (const [path, { frontmatter = {}, body = "" }] of Object.entries(files)) {
    store.set(path, { frontmatter: { ...frontmatter }, body });
  }
  return {
    _store: store,
    vault: {
      getFileByPath(path) {
        return store.has(path) ? { path } : null;
      },
    },
    fileManager: {
      async processFrontMatter(file, fn) {
        const entry = store.get(file.path);
        if (!entry) throw new Error("no such file");
        fn(entry.frontmatter);
      },
    },
  };
}

test("coerceValue accepts scalars + string arrays, rejects nested objects", () => {
  assert.equal(coerceValue("a"), "a");
  assert.equal(coerceValue(7), 7);
  assert.equal(coerceValue(true), true);
  assert.deepEqual(coerceValue(["x", "y"]), ["x", "y"]);
  assert.equal(coerceValue({ nested: 1 }), undefined);
});

test("vault_property factory rejects missing fileManager", () => {
  assert.throws(
    () => createVaultPropertyTool({ app: { vault: {} } }),
    /processFrontMatter required/,
  );
});

test("vault_property get returns null when key is absent", async () => {
  const tool = createVaultPropertyTool({
    app: fakePropertyApp({ "a.md": { frontmatter: {} } }),
  });
  const r = lastResult(await collect(tool, { path: "a.md", name: "status", op: "get" }));
  assert.match(r.content, /no value/);
});

test("vault_property get returns the value", async () => {
  const tool = createVaultPropertyTool({
    app: fakePropertyApp({ "a.md": { frontmatter: { status: "done" } } }),
  });
  const r = lastResult(await collect(tool, { path: "a.md", name: "status", op: "get" }));
  assert.equal(JSON.parse(r.content), "done");
});

test("vault_property set writes through processFrontMatter", async () => {
  const app = fakePropertyApp({ "a.md": { frontmatter: { status: "draft" } } });
  const tool = createVaultPropertyTool({ app });
  await collect(tool, { path: "a.md", name: "status", op: "set", value: "done" });
  assert.equal(app._store.get("a.md").frontmatter.status, "done");
});

test("vault_property delete removes the key", async () => {
  const app = fakePropertyApp({ "a.md": { frontmatter: { tags: ["x"] } } });
  const tool = createVaultPropertyTool({ app });
  await collect(tool, { path: "a.md", name: "tags", op: "delete" });
  assert.equal("tags" in app._store.get("a.md").frontmatter, false);
});

test("vault_property checkPermissions: get is allow, set/delete ask", async () => {
  const app = fakePropertyApp({ "a.md": { frontmatter: {} } });
  const tool = createVaultPropertyTool({ app });
  const g = await tool.checkPermissions({ path: "a.md", name: "x", op: "get" }, {});
  assert.equal(g.behavior, "allow");
  const s = await tool.checkPermissions({ path: "a.md", name: "x", op: "set", value: "y" }, {});
  assert.equal(s.behavior, "ask");
});

test("vault_property validate rejects set without value or with bad value", async () => {
  const tool = createVaultPropertyTool({ app: fakePropertyApp({ "a.md": { frontmatter: {} } }) });
  assert.equal((await tool.validate({ path: "a.md", name: "x", op: "set" })).ok, false);
  assert.equal(
    (await tool.validate({ path: "a.md", name: "x", op: "set", value: { nested: 1 } })).ok,
    false,
  );
});

// ===========================================================================
// vault_backlinks
// ===========================================================================

test("collectBacklinks reads from getBacklinksForFile if present", () => {
  const cache = {
    getBacklinksForFile: () => ({
      data: { "src1.md": [{ key: "" }, { key: "" }], "src2.md": [{ key: "" }] },
    }),
  };
  const map = collectBacklinks(cache, { path: "target.md" });
  assert.deepEqual(Array.from(map.entries()).sort(), [
    ["src1.md", 2],
    ["src2.md", 1],
  ]);
});

test("collectBacklinks falls back to resolvedLinks", () => {
  const cache = {
    resolvedLinks: {
      "src1.md": { "target.md": 3, "other.md": 1 },
      "src2.md": { "target.md": 1 },
      "src3.md": { "other.md": 5 },
    },
  };
  const map = collectBacklinks(cache, { path: "target.md" });
  assert.deepEqual(Array.from(map.entries()).sort(), [
    ["src1.md", 3],
    ["src2.md", 1],
  ]);
});

test("createVaultBacklinksTool requires metadataCache", () => {
  assert.throws(
    () => createVaultBacklinksTool({ app: { vault: { getFileByPath: () => null } } }),
    /metadataCache required/,
  );
});

test("vault_backlinks returns empty result for unreferenced notes", async () => {
  const app = {
    vault: { getFileByPath: () => ({ path: "a.md" }) },
    metadataCache: { resolvedLinks: {} },
  };
  const tool = createVaultBacklinksTool({ app });
  const r = lastResult(await collect(tool, { path: "a.md" }));
  assert.match(r.content, /no notes link to/);
});

test("vault_backlinks lists sources sorted by count then alphabetically", async () => {
  const app = {
    vault: { getFileByPath: () => ({ path: "target.md" }) },
    metadataCache: {
      resolvedLinks: {
        "z.md": { "target.md": 1 },
        "a.md": { "target.md": 1 },
        "many.md": { "target.md": 5 },
      },
    },
  };
  const tool = createVaultBacklinksTool({ app });
  const r = lastResult(await collect(tool, { path: "target.md" }));
  const lines = r.content.split("\n").slice(1); // strip header
  assert.equal(lines[0], "many.md [5]");
  assert.equal(lines[1], "a.md [1]");
  assert.equal(lines[2], "z.md [1]");
});

// ===========================================================================
// vault_tasks
// ===========================================================================

test("snippet strips leading list marker + checkbox", () => {
  assert.equal(snippet("- [ ] do the thing"), "do the thing");
  assert.equal(snippet("  - [x] done"), "done");
  assert.equal(snippet("* [/] doing"), "doing");
});

function fakeTasksApp(files) {
  // files: { path: { body, listItems: [{ task, line }] } }
  const store = new Map();
  for (const [path, entry] of Object.entries(files)) store.set(path, entry);
  return {
    vault: {
      getMarkdownFiles() {
        return Array.from(store.keys()).map((p) => ({ path: p }));
      },
      async cachedRead(file) {
        return store.get(file.path).body;
      },
    },
    metadataCache: {
      getFileCache(file) {
        const entry = store.get(file.path);
        if (!entry) return null;
        return {
          listItems: entry.listItems.map((li) => ({
            task: li.task,
            position: { start: { line: li.line } },
          })),
        };
      },
    },
  };
}

test("vault_tasks lists open tasks by default", async () => {
  const app = fakeTasksApp({
    "a.md": {
      body: "- [ ] open one\n- [x] done one\n- [ ] open two",
      listItems: [
        { task: " ", line: 0 },
        { task: "x", line: 1 },
        { task: " ", line: 2 },
      ],
    },
  });
  const tool = createVaultTasksTool({ app });
  const r = lastResult(await collect(tool, {}));
  assert.match(r.content, /\[ \] open one/);
  assert.match(r.content, /\[ \] open two/);
  assert.doesNotMatch(r.content, /\[x\] done one/);
});

test("vault_tasks status=done filters to checked", async () => {
  const app = fakeTasksApp({
    "a.md": {
      body: "- [ ] open\n- [x] done",
      listItems: [
        { task: " ", line: 0 },
        { task: "x", line: 1 },
      ],
    },
  });
  const tool = createVaultTasksTool({ app });
  const r = lastResult(await collect(tool, { status: "done" }));
  assert.match(r.content, /\[x\] done/);
  assert.doesNotMatch(r.content, /open/);
});

test("vault_tasks status=all returns everything", async () => {
  const app = fakeTasksApp({
    "a.md": {
      body: "- [ ] open\n- [x] done",
      listItems: [
        { task: " ", line: 0 },
        { task: "x", line: 1 },
      ],
    },
  });
  const tool = createVaultTasksTool({ app });
  const r = lastResult(await collect(tool, { status: "all" }));
  assert.match(r.content, /open/);
  assert.match(r.content, /done/);
});

test("vault_tasks returns 'no tasks' when nothing matches", async () => {
  const app = fakeTasksApp({
    "a.md": {
      body: "- [x] done",
      listItems: [{ task: "x", line: 0 }],
    },
  });
  const tool = createVaultTasksTool({ app });
  const r = lastResult(await collect(tool, { status: "open" }));
  assert.match(r.content, /no open tasks/);
});

test("vault_tasks scopes by path", async () => {
  const app = fakeTasksApp({
    "daily/a.md": {
      body: "- [ ] in daily",
      listItems: [{ task: " ", line: 0 }],
    },
    "other/b.md": {
      body: "- [ ] elsewhere",
      listItems: [{ task: " ", line: 0 }],
    },
  });
  const tool = createVaultTasksTool({ app });
  const r = lastResult(await collect(tool, { path: "daily" }));
  assert.match(r.content, /daily\/a\.md/);
  assert.doesNotMatch(r.content, /other\/b\.md/);
});

// ===========================================================================
// vault_tags
// ===========================================================================

test("normalizeTag enforces a leading #", () => {
  assert.equal(normalizeTag("idea"), "#idea");
  assert.equal(normalizeTag("#idea"), "#idea");
  assert.equal(normalizeTag(""), "");
});

test("fileHasTag matches frontmatter array, frontmatter string, and inline tags", () => {
  const fmArrayCache = { frontmatter: { tags: ["idea", "draft"] } };
  const fmStringCache = { frontmatter: { tags: "idea" } };
  const inlineCache = { tags: [{ tag: "#idea" }] };
  assert.ok(fileHasTag({ getFileCache: () => fmArrayCache }, {}, "#idea"));
  assert.ok(fileHasTag({ getFileCache: () => fmStringCache }, {}, "#idea"));
  assert.ok(fileHasTag({ getFileCache: () => inlineCache }, {}, "#idea"));
  assert.ok(!fileHasTag({ getFileCache: () => fmArrayCache }, {}, "#other"));
});

test("vault_tags list returns tags sorted by count desc", async () => {
  const app = {
    vault: { getMarkdownFiles: () => [] },
    metadataCache: {
      getTags: () => ({ "#a": 3, "#b": 5, "#c": 5 }),
      getFileCache: () => null,
    },
  };
  const tool = createVaultTagsTool({ app });
  const r = lastResult(await collect(tool, {}));
  const lines = r.content.split("\n").slice(1);
  assert.equal(lines[0], "#b [5]");
  assert.equal(lines[1], "#c [5]");
  assert.equal(lines[2], "#a [3]");
});

test("vault_tags files mode returns notes carrying the tag", async () => {
  const files = [
    { path: "a.md", cache: { frontmatter: { tags: ["idea"] } } },
    { path: "b.md", cache: { frontmatter: { tags: ["draft"] } } },
    { path: "c.md", cache: { tags: [{ tag: "#idea" }] } },
  ];
  const app = {
    vault: {
      getMarkdownFiles: () => files.map((f) => ({ path: f.path })),
    },
    metadataCache: {
      getTags: () => ({ "#idea": 2, "#draft": 1 }),
      getFileCache(file) {
        return files.find((f) => f.path === file.path).cache;
      },
    },
  };
  const tool = createVaultTagsTool({ app });
  const r = lastResult(await collect(tool, { mode: "files", tag: "idea" }));
  assert.match(r.content, /a\.md/);
  assert.match(r.content, /c\.md/);
  assert.doesNotMatch(r.content, /b\.md/);
});

test("vault_tags validate requires tag for mode=files", async () => {
  const tool = createVaultTagsTool({
    app: { vault: {}, metadataCache: { getTags: () => ({}) } },
  });
  assert.equal((await tool.validate({ mode: "files" })).ok, false);
  assert.equal((await tool.validate({ mode: "files", tag: "" })).ok, false);
  assert.equal((await tool.validate({ mode: "files", tag: "ok" })).ok, true);
});

test("vault_tags list returns 'no tags' when registry is empty", async () => {
  const tool = createVaultTagsTool({
    app: { vault: { getMarkdownFiles: () => [] }, metadataCache: { getTags: () => ({}) } },
  });
  const r = lastResult(await collect(tool, {}));
  assert.match(r.content, /no tags/);
});
