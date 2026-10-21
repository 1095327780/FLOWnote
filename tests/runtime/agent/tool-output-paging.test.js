const test = require("node:test");
const assert = require("node:assert/strict");

const { utf8Page } = require("../../../runtime/agent/tools/utf8-page");
const { pageReadOutput, estimateTextTokens, FALLBACK_MAX_BYTES } = require("../../../runtime/agent/tools/read-output-budget");
const { createVaultReadTool } = require("../../../runtime/agent/tools/vault-read");
const { createVaultDailyTool } = require("../../../runtime/agent/tools/vault-daily");
const { createWebFetchTool } = require("../../../runtime/agent/tools/web-fetch");
const { createWebRequestTool } = require("../../../runtime/agent/tools/web-request");
const { createSkillResourceReadTool } = require("../../../runtime/agent/tools/skill-resource-read");
const { createSkillInvokeTool, MAX_BODY_BYTES } = require("../../../runtime/agent/tools/skill-invoke");

async function result(tool, input, ctx) {
  let last;
  for await (const item of tool.execute(input, ctx)) if (item.type === "result") last = item;
  return last;
}

test("UTF-8 pages rebuild Chinese and emoji content exactly at byte boundaries", () => {
  const source = "甲🙂乙🚀".repeat(50);
  let offset = 0;
  let rebuilt = "";
  do {
    const page = utf8Page(source, offset, 7);
    assert.ok(Buffer.byteLength(page.text, "utf8") <= 7);
    assert.ok(page.nextOffset > offset);
    rebuilt += page.text;
    offset = page.nextOffset;
    if (!page.truncated) break;
  } while (true);
  assert.equal(rebuilt, source);
  assert.equal(offset, Buffer.byteLength(source, "utf8"));
  assert.throws(() => utf8Page("🙂", 1, 4), /boundary/);
});

test("vault_read returns a 73 KiB note in one call when context permits and caches the full source", async () => {
  const source = "字🙂".repeat(11000);
  const seen = [];
  const vault = { getFileByPath: (path) => ({ path }), cachedRead: async () => source };
  const tool = createVaultReadTool({ vault });
  const ctx = { toolResultBudgetTokens: 50000, fileStateCache: { recordRead: (...args) => seen.push(args) } };
  const page = await result(tool, { path: "large.md" }, ctx);
  assert.equal(page.content, source);
  assert.equal(page.data.page.truncated, false);
  assert.ok(Buffer.byteLength(source, "utf8") > 73 * 1024);
  assert.deepEqual(seen[0], ["large.md", source, { visibleRanges: [[0, source.length]] }]);
});

test("a small context budget pages a UTF-8 note without losing characters", async () => {
  const source = "字🙂".repeat(500);
  const vault = { getFileByPath: (path) => ({ path }), cachedRead: async () => source };
  const tool = createVaultReadTool({ vault });
  const ctx = { toolResultBudgetTokens: 90 };
  let offset = 0;
  let rebuilt = "";
  do {
    const page = await result(tool, { path: "large.md", byteOffset: offset }, ctx);
    const body = page.content.split("\n\n[vault_read:")[0];
    assert.ok(estimateTextTokens(body) <= 90);
    assert.ok(page.data.page.nextOffset > offset);
    rebuilt += body;
    offset = page.data.page.nextOffset;
    if (!page.data.page.truncated) break;
  } while (true);
  assert.equal(rebuilt, source);
  assert.equal(offset, Buffer.byteLength(source, "utf8"));
});

test("read output rejects a budget too small for one character", () => {
  assert.throws(() => pageReadOutput("🙂", { ctx: { toolResultBudgetTokens: 1 } }), /too small/);
});

test("vault_daily read honors date with byte offset and limit", async () => {
  const source = "日🙂记".repeat(20);
  const vault = {
    getFileByPath: (path) => path === "2026-05-15.md" ? { path } : null,
    cachedRead: async () => source,
    create: async () => {}, modify: async () => {},
  };
  const tool = createVaultDailyTool({ app: { vault }, now: () => new Date(2026, 4, 15, 12) });
  let offset = 0;
  let rebuilt = "";
  do {
    const page = await result(tool, { mode: "read", date: "2026-05-15", offset, limit: 7 });
    rebuilt += page.content.split("\n\n[vault_daily:")[0];
    offset = page.data.page.nextOffset;
    if (!page.data.page.truncated) break;
  } while (true);
  assert.equal(rebuilt, source);
  assert.equal((await tool.validate({ mode: "append", offset: 1 })).ok, false);
});

test("vault_daily returns a long note in one read when context permits", async () => {
  const source = "字🙂".repeat(11000);
  const vault = {
    getFileByPath: (path) => path === "2026-05-15.md" ? { path } : null,
    cachedRead: async () => source,
    create: async () => {}, modify: async () => {},
  };
  const tool = createVaultDailyTool({ app: { vault }, now: () => new Date(2026, 4, 15, 12) });
  const page = await result(tool, { mode: "read", date: "2026-05-15" }, { toolResultBudgetTokens: 50000 });
  assert.equal(page.content, source);
  assert.equal(page.data.page.truncated, false);
});

test("web_fetch continues cached extracted text without fetching again", async () => {
  const source = "中文🙂".repeat(400);
  let calls = 0;
  const tool = createWebFetchTool({ requestUrl: async () => {
    calls += 1;
    return { status: 200, headers: { "content-type": "text/plain" }, text: source };
  } });
  const url = "https://example.com/read";
  const first = await result(tool, { url, maxBytes: 1024 });
  const second = await result(tool, { url, maxBytes: 1024, byteOffset: first.data.page.nextOffset });
  assert.equal(calls, 1);
  assert.equal(first.data.page.totalBytes, Buffer.byteLength(source, "utf8"));
  assert.equal(second.data.page.offset, first.data.page.nextOffset);
});

test("web tools return the full response when the context permits", async () => {
  const source = "字🙂".repeat(11000);
  const requestUrl = async () => ({ status: 200, headers: { "content-type": "text/plain" }, text: source });
  const ctx = { toolResultBudgetTokens: 50000 };
  const fetchPage = await result(createWebFetchTool({ requestUrl }), { url: "https://example.com/read" }, ctx);
  const requestPage = await result(createWebRequestTool({ requestUrl }), { url: "https://example.com/api" }, ctx);
  for (const page of [fetchPage, requestPage]) {
    assert.equal(page.data.page.nextOffset, Buffer.byteLength(source, "utf8"));
    assert.equal(page.data.page.totalBytes, Buffer.byteLength(source, "utf8"));
    assert.equal(page.data.page.truncated, false);
  }
});

test("missing host budget falls back to 128 KiB, and explicit byte caps remain effective", async () => {
  const source = "A".repeat(FALLBACK_MAX_BYTES + 200);
  const requestUrl = async () => ({ status: 200, headers: { "content-type": "text/plain" }, text: source });
  const tool = createWebFetchTool({ requestUrl });
  const first = await result(tool, { url: "https://example.com/read" });
  assert.equal(first.data.page.nextOffset, FALLBACK_MAX_BYTES);
  assert.equal(first.data.page.truncated, true);
  const capped = await result(tool, { url: "https://example.com/read", byteOffset: first.data.page.nextOffset, maxBytes: 1024 });
  assert.equal(capped.data.page.nextOffset, source.length);
  assert.equal(capped.data.page.truncated, false);
});

test("web_request continues a cached POST response without replay", async () => {
  const source = "接口🙂".repeat(400);
  let calls = 0;
  const tool = createWebRequestTool({ requestUrl: async () => {
    calls += 1;
    return { status: 200, headers: { "content-type": "text/plain" }, text: source };
  } });
  const input = { url: "https://example.com/api", method: "POST", json: { action: "list" }, maxBytes: 1024 };
  const first = await result(tool, input);
  const second = await result(tool, { ...input, byteOffset: first.data.page.nextOffset });
  assert.equal(calls, 1);
  assert.equal(second.code, "cached_response");
  assert.equal(second.data.originalCode, "accepted_unverified");
  assert.equal(second.data.page.offset, first.data.page.nextOffset);
});

test("skill resource pages rebuild the rendered text and skill invocation respects UTF-8 cap", async () => {
  const source = "参考🙂".repeat(1000);
  const skill = { name: "demo", dirPath: "<embedded>/demo", embeddedResourceFiles: { "references/a.md": source }, resourcePaths: ["references/a.md"], body: "规🙂".repeat(30000) };
  const registry = { get: () => skill };
  const resourceTool = createSkillResourceReadTool({ skillRegistry: registry, vault: {} });
  const defaultPage = await result(resourceTool, { skill: "demo", path: "references/a.md" });
  assert.equal(defaultPage.data.page.nextOffset, Buffer.byteLength(source, "utf8"));
  assert.equal(defaultPage.data.page.truncated, false);
  let offset = 0;
  let rebuilt = "";
  do {
    const page = await result(resourceTool, { skill: "demo", path: "references/a.md", maxBytes: 7, byteOffset: offset });
    rebuilt += page.content.split("\n\n[skill_resource_read:")[0].split("\n\n").slice(1).join("\n\n");
    offset = page.data.page.nextOffset;
    if (!page.data.page.truncated) break;
  } while (true);
  assert.equal(rebuilt, source);
  const invoke = await result(createSkillInvokeTool({ skillRegistry: registry }), { skill: "demo" });
  const body = invoke.content.split("--- skill body ---\n")[1].split("\n\n[skill_invoke:")[0];
  assert.ok(Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES);
  assert.ok(!body.endsWith("�"));
});

test("skill_resource_read returns a long resource in one call when context permits", async () => {
  const source = "字🙂".repeat(11000);
  const skill = { name: "demo", dirPath: "<embedded>/demo", embeddedResourceFiles: { "references/long.md": source } };
  const tool = createSkillResourceReadTool({ skillRegistry: { get: () => skill }, vault: {} });
  const page = await result(tool, { skill: "demo", path: "references/long.md" }, { toolResultBudgetTokens: 50000 });
  assert.equal(page.content, `Skill resource: demo/references/long.md\n\n${source}`);
  assert.equal(page.data.page.truncated, false);
});
