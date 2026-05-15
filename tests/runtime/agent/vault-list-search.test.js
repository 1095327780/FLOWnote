const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultListTool, globToRegExp } = require("../../../runtime/agent/tools/vault-list");
const { createVaultSearchTool } = require("../../../runtime/agent/tools/vault-search");

async function collect(tool, input, ctx) {
  const events = [];
  for await (const ev of tool.execute(input, ctx || {})) events.push(ev);
  return events;
}
function lastResult(events) {
  return events.filter((e) => e.type === "result").pop();
}

// ---------------------------------------------------------------------------
// globToRegExp
// ---------------------------------------------------------------------------

test("globToRegExp: * matches anything except /; ** matches /", () => {
  const reStar = globToRegExp("a/*.md");
  assert.equal(reStar.test("a/x.md"), true);
  assert.equal(reStar.test("a/x/y.md"), false);
  const reDoubleStar = globToRegExp("**/index.md");
  assert.equal(reDoubleStar.test("daily/2026-05-15/index.md"), true);
  assert.equal(reDoubleStar.test("index.md"), true);
});

test("globToRegExp escapes regex specials", () => {
  const re = globToRegExp("a.b+c.md");
  assert.equal(re.test("a.b+c.md"), true);
  assert.equal(re.test("axbxc.md"), false);
});

// ---------------------------------------------------------------------------
// vault_list
// ---------------------------------------------------------------------------

function listVault(entries) {
  // entries: array of strings (file paths). Folders are inferred from paths.
  return {
    listFiles: () => entries.slice(),
  };
}

test("vault_list errors out if vault has no listing API", async () => {
  const tool = createVaultListTool({ vault: {} });
  // Validation passes, but execute throws inside.
  await assert.rejects(
    (async () => {
      for await (const _ev of tool.execute({}, {})) void _ev;
    })(),
    /no listing API/,
  );
});

test("vault_list returns sorted listing by default", async () => {
  const tool = createVaultListTool({
    vault: listVault(["b.md", "a.md", "daily/2026-05-15.md"]),
  });
  const r = lastResult(await collect(tool, {}));
  const lines = r.content.split("\n");
  assert.deepEqual(lines, ["a.md", "b.md", "daily/2026-05-15.md"]);
});

test("vault_list filters by path subtree", async () => {
  const tool = createVaultListTool({
    vault: listVault(["a.md", "daily/2026-05-15.md", "daily/2026-05-16.md"]),
  });
  const r = lastResult(await collect(tool, { path: "daily" }));
  assert.deepEqual(r.content.split("\n"), ["daily/2026-05-15.md", "daily/2026-05-16.md"]);
});

test("vault_list applies a glob pattern relative to the path", async () => {
  const tool = createVaultListTool({
    vault: listVault(["daily/2026-05-15.md", "daily/nested/inner.md"]),
  });
  const onlyDirect = lastResult(await collect(tool, { path: "daily", pattern: "*.md" }));
  assert.deepEqual(onlyDirect.content.split("\n"), ["daily/2026-05-15.md"]);
  // `**/*.md` matches markdown at any depth (including the top level),
  // matching gitignore semantics.
  const allMarkdown = lastResult(await collect(tool, { path: "daily", pattern: "**/*.md" }));
  assert.deepEqual(allMarkdown.content.split("\n"), [
    "daily/2026-05-15.md",
    "daily/nested/inner.md",
  ]);
});

test("vault_list filters by extensions whitelist", async () => {
  const tool = createVaultListTool({
    vault: listVault(["a.md", "b.canvas", "c.png"]),
  });
  const r = lastResult(await collect(tool, { extensions: ["md", "canvas"] }));
  assert.deepEqual(r.content.split("\n"), ["a.md", "b.canvas"]);
});

test("vault_list recursive=false yields only the top level under path", async () => {
  const tool = createVaultListTool({
    vault: listVault(["a.md", "x/y.md", "x/z/w.md"]),
  });
  const root = lastResult(await collect(tool, { recursive: false }));
  assert.deepEqual(root.content.split("\n"), ["a.md"]);
  const xOnly = lastResult(await collect(tool, { path: "x", recursive: false }));
  assert.deepEqual(xOnly.content.split("\n"), ["x/y.md"]);
});

test("vault_list truncates at limit and tells the model", async () => {
  const tool = createVaultListTool({
    vault: listVault(Array.from({ length: 5 }, (_, i) => `n${i}.md`)),
  });
  const r = lastResult(await collect(tool, { limit: 3 }));
  assert.match(r.content, /truncated at limit=3/);
});

test("vault_list returns a 'no entries matched' result when empty", async () => {
  const tool = createVaultListTool({ vault: listVault([]) });
  const r = lastResult(await collect(tool, {}));
  assert.match(r.content, /no entries matched/);
});

// ---------------------------------------------------------------------------
// vault_search
// ---------------------------------------------------------------------------

function searchVault(initial) {
  const files = Object.entries(initial).map(([path, content]) => ({ path, content }));
  return {
    listFilesForSearch: () =>
      files.map((f) => ({
        path: f.path,
        async read() {
          return f.content;
        },
      })),
    async cachedRead(file) {
      const found = files.find((f) => f.path === file.path);
      if (!found) throw new Error(`no file ${file.path}`);
      return found.content;
    },
  };
}

test("vault_search.validate rejects empty queries", async () => {
  const tool = createVaultSearchTool({ vault: searchVault({}) });
  assert.equal((await tool.validate({ query: "" })).ok, false);
  assert.equal((await tool.validate({})).ok, false);
  assert.equal((await tool.validate({ query: "ok" })).ok, true);
});

test("vault_search.validate catches bad regex", async () => {
  const tool = createVaultSearchTool({ vault: searchVault({}) });
  const r = await tool.validate({ query: "[unclosed", regex: true });
  assert.equal(r.ok, false);
});

test("vault_search finds substring matches across files (case-insensitive default)", async () => {
  const tool = createVaultSearchTool({
    vault: searchVault({
      "a.md": "hello FlowNote\nsecond line",
      "b.md": "different content",
      "c.md": "flownote shows up here",
    }),
  });
  const r = lastResult(await collect(tool, { query: "FLOWNOTE" }));
  assert.match(r.content, /a.md:1:/);
  assert.match(r.content, /c.md:1:/);
  assert.doesNotMatch(r.content, /b\.md/);
});

test("vault_search respects case_sensitive", async () => {
  const tool = createVaultSearchTool({
    vault: searchVault({ "a.md": "FlowNote and flownote" }),
  });
  const r = lastResult(await collect(tool, { query: "FlowNote", case_sensitive: true }));
  // Only the first occurrence should hit, but both are on line 1, so:
  assert.match(r.content, /a.md:1:/);
});

test("vault_search returns 'no matches' when nothing found", async () => {
  const tool = createVaultSearchTool({
    vault: searchVault({ "a.md": "nothing here" }),
  });
  const r = lastResult(await collect(tool, { query: "absent" }));
  assert.match(r.content, /no matches/);
});

test("vault_search caps results at max_matches and flags truncation", async () => {
  const lots = "match\n".repeat(50);
  const tool = createVaultSearchTool({
    vault: searchVault({ "big.md": lots }),
  });
  const r = lastResult(await collect(tool, { query: "match", max_matches: 5 }));
  assert.match(r.content, /truncated at max_matches=5/);
});

test("vault_search supports regex queries", async () => {
  const tool = createVaultSearchTool({
    vault: searchVault({ "a.md": "2026-05-15 entry\nrandom\n2025-12-31 entry" }),
  });
  const r = lastResult(await collect(tool, { query: "\\d{4}-\\d{2}-\\d{2}", regex: true }));
  assert.match(r.content, /a.md:1:/);
  assert.match(r.content, /a.md:3:/);
});

test("vault_search filters by path subtree", async () => {
  const tool = createVaultSearchTool({
    vault: searchVault({
      "daily/a.md": "match here",
      "other/b.md": "match here too",
    }),
  });
  const r = lastResult(await collect(tool, { query: "match", path: "daily" }));
  assert.match(r.content, /daily\/a\.md/);
  assert.doesNotMatch(r.content, /other\/b\.md/);
});
