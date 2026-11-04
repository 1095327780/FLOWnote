// Real-provider protocol smoke. Synthetic in-memory notes only; not a content-quality A/B.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { resolveAgentProvider } = require("../runtime/agent/agent-provider-resolver");
const { buildDefaultToolRegistry } = require("../runtime/chat/direct-agent-runner");
const { runAgentLoop } = require("../runtime/agent/agent-loop");
const { FileStateCache } = require("../runtime/agent/file-state-cache");
const { createExplicitSkillWorkflowContract } = require("../runtime/agent/execution-contract");
const { createDirectUsageAccumulator } = require("../runtime/chat/direct-response-stats");
const { meterProvider } = require("../runtime/chat/metered-provider");
const { cardToolSurface } = require("../runtime/agent/card-tool-surface");

async function main() {
  const root = path.resolve(__dirname, "..");
  const data = JSON.parse(fs.readFileSync(path.join(root, "data.json"), "utf8"));
  const settings = structuredClone(data.settings.agentProvider);
  assert.equal(settings.direct.providerId, "deepseek", "This smoke is scoped to the existing DeepSeek configuration.");
  // The configured model/effort is preserved. Only fixture notes enter the API.
  const source = "我发现，明确写出适用条件能减少过度推广结论。因为相同方法在不同场景可能有不同结果，我先标出场景和反例，再考虑迁移。\n## 本书衍生的永久笔记\n永久笔记: \n";
  const files = new Map([["Memory/STATUS.md", "待制卡：适用条件"], ["Sources/Insight.md", source],
    ["Topics/Theme.md", "# 条件与迁移\n## 卡片\n"], ["Related/Other.md", "条件改变时，既有经验需要重新验证。\n## 相关笔记\n"]]);
  const folders = new Set(["Cards", "Memory", "Sources", "Topics", "Related", "Domains"]);
  const vault = {
    getFileByPath: p => files.has(p) ? { path: p } : null,
    getFolderByPath: p => folders.has(p) ? { path: p, children: [] } : null,
    getAbstractFileByPath(p) { return this.getFileByPath(p) || this.getFolderByPath(p); },
    getMarkdownFiles: () => [...files.keys()].map(p => ({ path: p })),
    cachedRead: async f => files.get(f.path), read: async f => files.get(f.path),
    async create(p, text) { if (files.has(p)) throw new Error("exists"); files.set(p, text); },
    async modify(f, text) { files.set(f.path, text); },
    async process(f, transform) { files.set(f.path, transform(files.get(f.path))); },
    async createFolder(p) { folders.add(p); },
  };
  const card = { path: "Cards/写出适用条件能减少过度推广结论.md", content:
    "# 写出适用条件能减少过度推广结论\n\n## 核心观点\n\n我先标出场景和反例，再考虑迁移。\n\n## 详细说明\n\n### 为什么成立\n相同方法在不同场景可能有不同结果。\n\n### 具体实现\n先标出场景和反例，再考虑迁移。\n\n### 边界与适用条件\n条件改变时，既有经验需要重新验证。\n\n## 相关笔记\n- [[Topics/Theme]] - 补充：梳理适用条件。\n- [[Related/Other]] - 支持：条件改变需要重新验证。\n\n## 参考来源\n- [[Sources/Insight]]\n" };
  const link = `[[${card.path.slice(0, -3)}]]`;
  const sync = [
    { path: "Topics/Theme.md", role: "topic", old_string: "## 卡片\n", new_string: `## 卡片\n- ${link}\n` },
    { path: "Sources/Insight.md", role: "source", old_string: "## 本书衍生的永久笔记\n", new_string: `## 本书衍生的永久笔记\n- ${link}\n` },
    { path: "Sources/Insight.md", role: "source", old_string: "永久笔记: \n", new_string: `永久笔记: ${link}\n` },
    { path: "Related/Other.md", role: "backlink", old_string: "## 相关笔记\n", new_string: `## 相关笔记\n- ${link}\n` },
  ];
  const plugin = { settings: { notePaths: { permanentNotes: "Cards", topicNotes: "Topics", literatureNotes: "Sources", domainPages: "Domains" }, metaPaths: { memory: "Memory" } } };
  const registry = buildDefaultToolRegistry({ vault }, null, null, plugin, new Date(), { includeCardTools: true });
  const usage = createDirectUsageAccumulator();
  const provider = meterProvider(resolveAgentProvider(settings, { requestImpl: async args => fetch(args.url, {
    method: args.method, headers: args.headers, body: args.body, signal: AbortSignal.timeout(90000),
  }) }), usage);
  const targets = [card.path, ...new Set(sync.map(item => item.path))];
  const events = [];
  const startedAt = Date.now();
  for await (const e of runAgentLoop({ provider, registry, maxTurns: 8, maxTokensPerTurn: 32768,
    system: "You are running an isolated host-protocol smoke. All notes and user confirmations are synthetic test fixtures. Preserve the supplied confirmed plan exactly; this test does not ask you to generate a card or infer relationships. Read source and sync targets before writes. Use card_prepare, vault_read, card_commit, then flownote_finish_skill with all verified targets. Never report partial writes as complete.",
    messages: [{ role: "user", content: [{ type: "text", text:
      "The fixture author has already confirmed this exact draft and relationship plan. First call card_prepare with sourcePath=Sources/Insight.md, then read Topics/Theme.md and Related/Other.md. Then commit exactly the following JSON and finish in effect mode. Do not use individual write/edit tools for this smoke.\n" + JSON.stringify({ card, sync }) }] }],
    executionContract: createExplicitSkillWorkflowContract({ skillName: "ah-card", completionPolicy: { state: "declared", mode: "effect", requiredEffects: ["vault_mutation"], minReceipts: 1, errorCode: null } }),
    ctx: { cardWorkflow: true, fileStateCache: new FileStateCache() }, onPermissionAsk: async () => ({ behavior: "allow" }),
  })) events.push(e);
  const terminal = events.at(-1);
  const checks = { completed: terminal && terminal.type === "done" && terminal.verified === true,
    exactCard: files.get(card.path) === card.content,
    sourceBothFields: files.get("Sources/Insight.md").split(link).length - 1 === 2,
    sourceOriginalPreserved: files.get("Sources/Insight.md").startsWith(source.split("\n")[0]),
    topicLinked: files.get("Topics/Theme.md").includes(link), relatedLinked: files.get("Related/Other.md").includes(link),
    batchReceipt: events.some(e => e.type === "effect_receipt" && e.receipt.tool === "card_commit" && e.receipt.verified && targets.every(p => e.receipt.paths.includes(p))) };
  const specs = tools => JSON.stringify(registry.toApiSpecs(tools)).length;
  const report = { kind: "real-provider protocol smoke; exact fixture preservation only; no generated-content quality A/B",
    provider: settings.direct.providerId, requestedModel: settings.direct.model, elapsedMs: Date.now() - startedAt,
    checks, terminal: terminal && terminal.type, usage: usage.snapshot(), usageReported: usage.snapshotReported(), requests: usage.requests(),
    toolCalls: events.filter(e => e.type === "tool_start").map(e => e.tool),
    schemas: { broadCharacters: specs(registry.list()), cardCharacters: specs(cardToolSurface(registry.list(), { cardWorkflow: true })) },
    toolErrors: events.filter(e => e.type === "tool_finish" && e.isError).map(e => ({ tool: e.tool, output: e.content })),
    output: events.filter(e => e.type === "stream" && e.event.type === "content_block_delta" && e.event.delta && e.event.delta.type === "text_delta").map(e => e.event.delta.text).join("") };
  const out = path.join(root, "output/pi-card-implementation-20261004/live-smoke.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: out, checks, elapsedMs: report.elapsedMs, requests: usage.requestCount(), usage: report.usage }));
  assert.ok(Object.values(checks).every(Boolean), "One or more isolated smoke checks failed; inspect the saved evidence.");
}
main().catch(error => { console.error(error.code || error.name || "SMOKE_FAILED"); process.exitCode = 1; });
