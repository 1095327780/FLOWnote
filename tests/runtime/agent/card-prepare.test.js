const test = require("node:test");
const assert = require("node:assert/strict");
const { createCardPrepareTool } = require("../../../runtime/agent/tools/card-prepare");
const { FileStateCache } = require("../../../runtime/agent/file-state-cache");
const { estimateTextTokens } = require("../../../runtime/agent/tools/read-output-budget");

function setup(overrides = {}) {
  const contents = new Map([["Custom/status.md", "Pending card"], ["Source.md", "User words\nA condition and a counterexample."]]);
  const vault = {
    getFileByPath: path => contents.has(path) ? { path } : null,
    cachedRead: async file => contents.get(file.path),
    getMarkdownFiles: () => [...contents.keys()].map(path => ({ path })),
  };
  const tool = createCardPrepareTool({ vault, paths: { statusPath: "Custom/status.md", topicNotes: "Topics", domainPages: "Domains", permanentNotes: "Cards" }, ...overrides });
  return { tool, contents, vault };
}
async function result(tool, input, ctx = {}) { const events = []; for await (const e of tool.execute(input, ctx)) events.push(e); return events.at(-1); }

test("preparation uses configured paths, returns full source and status without semantic classification", async () => {
  const { tool } = setup();
  const cache = new FileStateCache();
  const r = await result(tool, { sourcePath: "Source.md" }, { fileStateCache: cache });
  const data = JSON.parse(r.content);
  assert.equal(data.paths.permanentNotes, "Cards");
  assert.equal(data.evidence[1].text, "User words\nA condition and a counterexample.");
  assert.equal(data.evidence[1].truncated, false);
  assert.ok(cache.has("Source.md"));
  assert.match(data.nextSteps, /not verified/);
});

test("late topic catalog entries remain reachable after the first batch", async () => {
  const { tool, contents } = setup();
  for (let i = 0; i < 220; i++) contents.set(`Topics/${String(i).padStart(3, "0")}.md`, "irrelevant");
  const first = JSON.parse((await result(tool, {})).content);
  const last = JSON.parse((await result(tool, { catalogOffset: 200 })).content);
  assert.equal(first.catalog.total, 220);
  assert.equal(first.catalog.nextOffset, 50);
  assert.equal(last.catalog.entries.at(-1).path, "Topics/219.md");
  assert.equal(last.catalog.nextOffset, null);
  assert.equal(last.catalog.snapshot, false);
});

test("budgeted source preserves truncation and recovery and never establishes full-read evidence", async () => {
  const { tool, contents } = setup();
  contents.set("Source.md", "来源限定和反例🙂".repeat(5000));
  const cache = new FileStateCache();
  const r = await result(tool, { sourcePath: "Source.md" }, { fileStateCache: cache, toolResultBudgetTokens: 1500 });
  assert.equal(r.isError, undefined);
  assert.ok(estimateTextTokens(r.content) <= 1500);
  const source = JSON.parse(r.content).evidence[1];
  assert.equal(source.truncated, true);
  assert.equal(source.continueWith.tool, "vault_read");
  assert.ok(source.continueWith.byteOffset > 0);
  assert.equal(cache.has("Source.md"), false);
});

test("read errors and missing source are explicit", async () => {
  const { tool, vault } = setup();
  vault.cachedRead = async () => { throw new Error("not readable"); };
  const r = JSON.parse((await result(tool, { sourcePath: "Missing.md" })).content);
  assert.equal(r.evidence[0].error, "not readable");
  assert.equal(r.evidence[1].missing, true);
});

test("unsafe paths and malformed offsets fail validation", async () => {
  const { tool } = setup();
  for (const sourcePath of ["../Source.md", "/Source.md", ".obsidian/data.md", "A/../Source.md", "secret.json"]) {
    assert.equal((await tool.validate({ sourcePath })).ok, false, sourcePath);
  }
  assert.equal((await tool.validate({ catalogOffset: -1 })).ok, false);
});

test("too little context creates no false read state", async () => {
  const { tool } = setup();
  const cache = new FileStateCache();
  const r = await result(tool, { sourcePath: "Source.md" }, { fileStateCache: cache, toolResultBudgetTokens: 10 });
  assert.equal(r.isError, true);
  assert.equal(cache.size(), 0);
});

test("configured legacy memory STATUS is resolved without rejecting its supported alias", async () => {
  const { vault, contents } = setup();
  contents.set("Meta/.ai-memory/STATUS.md", "Legacy pending card");
  const tool = createCardPrepareTool({ vault, paths: { statusPath: "Meta/.ai-memory/STATUS.md" } });
  const r = JSON.parse((await result(tool, {})).content);
  assert.equal(r.evidence[0].path, "Meta/.ai-memory/STATUS.md");
  assert.equal(r.evidence[0].text, "Legacy pending card");
});
