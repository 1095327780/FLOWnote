const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultSearchTool } = require("../../../runtime/agent/tools/vault-search");
const { estimateTextTokens } = require("../../../runtime/agent/tools/read-output-budget");

function mutableVault(initial = {}) {
  const files = new Map(Object.entries(initial));
  const failures = new Set();
  let reads = 0;
  return {
    files,
    failures,
    get reads() { return reads; },
    getAllLoadedFiles() {
      // Return the current vault view on every call, just as Obsidian does.
      return [...files.keys()].map((path) => ({ path }));
    },
    async cachedRead(file) {
      reads += 1;
      if (failures.has(file.path)) throw new Error("simulated read failure");
      if (!files.has(file.path)) throw new Error("deleted during search");
      return files.get(file.path);
    },
  };
}

async function search(tool, input, ctx = {}) {
  const validation = await tool.validate(input);
  assert.equal(validation.ok, true, validation.error);
  const events = [];
  for await (const event of tool.execute(input, ctx)) events.push(event);
  assert.equal(events.length, 1);
  return events[0];
}

test("vault_search finds a body hit after the old 200-file prefix", async () => {
  const files = {};
  for (let n = 0; n < 250; n += 1) files[`note-${String(n).padStart(3, "0")}.md`] = "unrelated";
  files["z-last.md"] = "title unrelated\nneedle in the body";
  const vault = mutableVault(files);
  const result = await search(createVaultSearchTool({ vault }), { query: "needle" });
  assert.match(result.content, /z-last\.md:2: needle in the body/);
  assert.equal(result.data.eligible_files, 251);
  assert.equal(result.data.files_scanned, 251);
  assert.equal(result.data.complete, true);
  assert.equal(vault.reads, 251);
});

test("vault_search output stays bounded while 1K, 10K and 50K unrelated notes are added", async () => {
  for (const count of [1000, 10000, 50000]) {
    const files = {};
    for (let n = 0; n < count; n += 1) files[`note-${String(n).padStart(5, "0")}.md`] = "ordinary body";
    files["z-target.md"] = "heading\nneedle evidence";
    const vault = mutableVault(files);
    const result = await search(createVaultSearchTool({ vault }), { query: "needle" });
    assert.match(result.content, /z-target\.md:2: needle evidence/);
    assert.equal(result.data.files_scanned, count + 1);
    assert.equal(result.data.matches_returned, 1);
    assert.equal(result.data.next_cursor, null);
    assert.ok(result.content.length < 500, `result at ${count} notes was ${result.content.length} chars`);
  }
});

test("vault_search reads beyond 512 KiB and reflects edits and deletes without an index", async () => {
  const vault = mutableVault({ "large.md": `${"x".repeat(600 * 1024)}\nneedle late` });
  const tool = createVaultSearchTool({ vault });
  const first = await search(tool, { query: "needle" });
  assert.match(first.content, /large\.md:2: needle late/);
  vault.files.set("large.md", "edited body without target");
  const second = await search(tool, { query: "needle" });
  assert.equal(second.data.matches_returned, 0);
  vault.files.delete("large.md");
  const third = await search(tool, { query: "needle" });
  assert.equal(third.data.eligible_files, 0);
  assert.equal(third.data.complete, true);
});

test("a late hit on a very long line remains visible in its bounded snippet", async () => {
  const vault = mutableVault({ "long.md": `${"x".repeat(600 * 1024)}needle evidence` });
  const result = await search(createVaultSearchTool({ vault }), { query: "needle" });
  assert.match(result.content, /long\.md:1: …x+needle evidence/);
  assert.ok(result.content.length < 1000);
});

test("vault_search paginates matching lines and validates cursor scope", async () => {
  const vault = mutableVault({
    "a.md": "needle a1\nneedle a2\nneedle a3",
    "b.md": "needle b1\nneedle b2",
  });
  const tool = createVaultSearchTool({ vault });
  const first = await search(tool, { query: "needle", max_matches: 2 });
  assert.equal(first.data.matches_returned, 2);
  assert.equal(first.data.remaining_matches_in_scanned_files, 3);
  assert.ok(first.data.next_cursor);
  const wrongQuery = await tool.validate({ query: "other", cursor: first.data.next_cursor });
  assert.equal(wrongQuery.ok, false);
  const second = await search(tool, { query: "needle", max_matches: 2, cursor: first.data.next_cursor });
  assert.match(second.content, /a\.md:3: needle a3/);
  assert.match(second.content, /b\.md:1: needle b1/);
  const third = await search(tool, { query: "needle", max_matches: 2, cursor: second.data.next_cursor });
  assert.match(third.content, /b\.md:2: needle b2/);
  assert.equal(third.data.next_cursor, null);
  assert.equal(third.data.complete, true);
});

test("host result budget shrinks pages while preserving every later match", async () => {
  const vault = mutableVault({ "a.md": Array.from({ length: 25 }, (_, i) => `needle ${i} ${"detail ".repeat(24)}`).join("\n") });
  const tool = createVaultSearchTool({ vault });
  const budget = 700;
  let cursor;
  let total = 0;
  let pages = 0;
  do {
    const result = await search(tool, { query: "needle", max_matches: 25, ...(cursor ? { cursor } : {}) },
      { toolResultBudgetTokens: budget });
    assert.ok(estimateTextTokens(result.content) <= budget);
    assert.ok(result.data.matches_returned >= 1);
    assert.equal(result.data.matching_lines_in_scanned_portion, 25 - total);
    total += result.data.matches_returned;
    cursor = result.data.next_cursor;
    pages += 1;
    assert.ok(pages <= 25, "pagination must advance");
  } while (cursor);
  assert.equal(total, 25);
  assert.ok(pages > 1);
});

test("too-small host result budget fails without claiming coverage", async () => {
  const tool = createVaultSearchTool({ vault: mutableVault({ "a.md": "needle" }) });
  const result = await search(tool, { query: "needle" }, { toolResultBudgetTokens: 10 });
  assert.equal(result.isError, true);
  assert.equal(result.data, undefined);
  assert.match(result.content, /budget cannot hold one match/);
});

test("cancellation during scanning stops without a partial completion result", async () => {
  const controller = new AbortController();
  const vault = mutableVault({ "a.md": "needle", "b.md": "needle" });
  const originalRead = vault.cachedRead.bind(vault);
  vault.cachedRead = async (file) => {
    const content = await originalRead(file);
    if (file.path === "a.md") controller.abort();
    return content;
  };
  const tool = createVaultSearchTool({ vault });
  await assert.rejects(async () => {
    for await (const _event of tool.execute({ query: "needle" }, { signal: controller.signal })) {}
  }, { name: "AbortError" });
});

test("explicit max_files leaves a visible and resumable unread scope", async () => {
  const vault = mutableVault({
    "a.md": "unrelated",
    "b.md": "unrelated",
    "c.md": "needle late",
  });
  const tool = createVaultSearchTool({ vault });
  const first = await search(tool, { query: "needle", max_files: 2 });
  assert.equal(first.data.files_scanned, 2);
  assert.equal(first.data.unread_candidates, 1);
  assert.equal(first.data.complete, false);
  assert.match(first.content, /next_cursor:/);
  const second = await search(tool, { query: "needle", max_files: 2, cursor: first.data.next_cursor });
  assert.match(second.content, /c\.md:1: needle late/);
  assert.equal(second.data.complete, true);
});

test("vault_search reports read failures without claiming complete coverage", async () => {
  const vault = mutableVault({ "a.md": "needle a", "b.md": "needle b", "c.md": "needle c" });
  vault.failures.add("b.md");
  const tool = createVaultSearchTool({ vault });
  const result = await search(tool, { query: "needle" });
  assert.equal(result.data.files_scanned, 3);
  assert.equal(result.data.read_failures, 1);
  assert.equal(result.data.complete, false);
  assert.match(result.content, /b\.md: simulated read failure/);
  assert.match(result.content, /a\.md:1:/);
  assert.match(result.content, /c\.md:1:/);
});

test("read failures remain visible through the final page", async () => {
  const vault = mutableVault({ "a.md": "needle", "b.md": "needle" });
  vault.failures.add("a.md");
  const tool = createVaultSearchTool({ vault });
  const first = await search(tool, { query: "needle", max_files: 1 });
  assert.equal(first.data.read_failures_across_pages, 1);
  const last = await search(tool, { query: "needle", max_files: 1, cursor: first.data.next_cursor });
  assert.match(last.content, /b\.md:1:/);
  assert.equal(last.data.read_failures, 0);
  assert.equal(last.data.read_failures_across_pages, 1);
  assert.equal(last.data.complete, false);
});

test("vault_search keeps regex and path filtering semantics", async () => {
  const vault = mutableVault({
    "daily/a.md": "2026-10-04",
    "daily/deep/b.md": "2026-10-05",
    "other/c.md": "2026-10-06",
    "daily/d.canvas": "2026-10-07",
  });
  const tool = createVaultSearchTool({ vault });
  const result = await search(tool, {
    query: "2026-10-0[4-7]",
    regex: true,
    path: "daily",
    pattern: "**/*.md",
  });
  assert.match(result.content, /daily\/a\.md:1:/);
  assert.match(result.content, /daily\/deep\/b\.md:1:/);
  assert.doesNotMatch(result.content, /other\/c\.md|daily\/d\.canvas/);
  assert.equal(result.data.eligible_files, 2);
  const canvas = await search(tool, {
    query: "2026-10-07",
    path: "daily",
    extensions: ["canvas"],
  });
  assert.match(canvas.content, /daily\/d\.canvas:1:/);
  assert.equal(canvas.data.eligible_files, 1);
});
