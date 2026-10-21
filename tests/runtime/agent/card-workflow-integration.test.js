const test = require("node:test");
const assert = require("node:assert/strict");
const { ToolRegistry, buildTool } = require("../../../runtime/agent/tool-registry");
const { runAgentLoop } = require("../../../runtime/agent/agent-loop");
const { createCardExpandToolsTool, cardToolSurface } = require("../../../runtime/agent/card-tool-surface");
const { buildDefaultToolRegistry } = require("../../../runtime/chat/direct-agent-runner");
const { FileStateCache } = require("../../../runtime/agent/file-state-cache");
const { seedLinkedEvidence } = require("../../../runtime/chat/linked-evidence");
const { createExplicitSkillWorkflowContract } = require("../../../runtime/agent/execution-contract");
const { createVaultChangeRecorder } = require("../../../runtime/agent/vault-change-recorder");

function fakeVault() {
  const files = new Map([
    ["Memory/STATUS.md", "Pending: Insight"], ["Sources/Insight.md", "A user claim with a condition.\n## Derived\nPermanent note: \n"],
    ["Topics/Theme.md", "# Theme\n## Cards\n"], ["Related/Other.md", "A supported relationship.\n## Related\n"],
  ]);
  const folders = new Set(["Cards", "Topics", "Sources", "Related", "Memory"]);
  return { files, getFileByPath: path => files.has(path) ? { path } : null,
    getFolderByPath: path => folders.has(path) ? { path, children: [] } : null,
    getAbstractFileByPath(path) { return this.getFileByPath(path) || this.getFolderByPath(path); },
    getMarkdownFiles: () => [...files.keys()].map(path => ({ path })),
    cachedRead: async file => files.get(file.path), read: async file => files.get(file.path),
    async create(path, text) { if (files.has(path)) throw new Error("exists"); files.set(path, text); },
    async modify(file, text) { files.set(file.path, text); },
    async process(file, transform) { files.set(file.path, transform(files.get(file.path))); },
    async createFolder(path) { folders.add(path); },
  };
}
function scripted(calls, inspect) {
  let turn = 0;
  return { spec: { models: [] }, userConfig: { model: "test" }, async *createMessage(input) {
    inspect && inspect(input, turn);
    const uses = calls[turn++] || [];
    yield { type: "message_start", message: {} };
    for (let i = 0; i < uses.length; i++) {
      yield { type: "content_block_start", index: i, content_block: { type: "tool_use", ...uses[i] } };
      yield { type: "content_block_stop", index: i };
    }
    if (!uses.length) { yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "Done" } }; yield { type: "content_block_stop", index: 0 }; }
    yield { type: "message_delta", delta: { stop_reason: uses.length ? "tool_use" : "end_turn" } };
    yield { type: "message_stop" };
  } };
}
const use = (id, name, input = {}) => ({ id, name, input });
async function collect(args) { const events = []; for await (const e of runAgentLoop(args)) events.push(e); return events; }
const messages = [{ role: "user", content: [{ type: "text", text: "Execute the already confirmed fixture plan." }] }];

test("real host loop prepares, reads, commits both source updates, and verifies all targets", async () => {
  const vault = fakeVault();
  const recorder = createVaultChangeRecorder({ vault });
  const toolApp = recorder.instrumentApp({ vault });
  const registry = buildDefaultToolRegistry(toolApp, null, null, { settings: { notePaths: { permanentNotes: "Cards", topicNotes: "Topics", domainPages: "Domains" }, metaPaths: { memory: "Memory" } } }, new Date(), { includeCardTools: true });
  const card = { path: "Cards/Idea.md", content: "# A user claim with a condition\n\n[[Sources/Insight]]\n[[Topics/Theme]]\n[[Related/Other]]\n" };
  const sync = [
    { path: "Topics/Theme.md", role: "topic", old_string: "## Cards\n", new_string: "## Cards\n- [[Cards/Idea]]\n" },
    { path: "Sources/Insight.md", role: "source", old_string: "## Derived\n", new_string: "## Derived\n- [[Cards/Idea]]\n" },
    { path: "Sources/Insight.md", role: "source", old_string: "Permanent note: \n", new_string: "Permanent note: [[Cards/Idea]]\n" },
    { path: "Related/Other.md", role: "backlink", old_string: "## Related\n", new_string: "## Related\n- [[Cards/Idea]]\n" },
  ];
  const targets = [card.path, ...new Set(sync.map(item => item.path))];
  const provider = scripted([
    [use("prepare", "card_prepare", { sourcePath: "Sources/Insight.md" }), use("topic", "vault_read", { path: "Topics/Theme.md" }), use("related", "vault_read", { path: "Related/Other.md" })],
    [use("commit", "card_commit", { card, sync })],
    [],
  ]);
  const events = await collect({ registry, provider, messages, executionContract: createExplicitSkillWorkflowContract({ skillName: "ah-card", completionPolicy: { state: "declared", mode: "effect", requiredEffects: ["vault_mutation"], minReceipts: 1, errorCode: null } }),
    ctx: { fileStateCache: new FileStateCache(), cardWorkflow: true, changeRecorder: recorder }, onPermissionAsk: async () => ({ behavior: "allow" }) });
  assert.equal(events.at(-1).type, "done");
  assert.equal(vault.files.get(card.path), card.content);
  assert.equal(vault.files.get("Sources/Insight.md").match(/\[\[Cards\/Idea\]\]/g).length, 2);
  const receipt = events.find(e => e.type === "effect_receipt" && e.receipt.tool === "card_commit").receipt;
  assert.equal(receipt.verified, true);
  assert.deepEqual(receipt.paths, targets);
  const { changes } = await recorder.finalize();
  assert.deepEqual(changes.map(({ path, op }) => [path, op]), [
    ["Cards/Idea.md", "created"], ["Topics/Theme.md", "modified"], ["Sources/Insight.md", "modified"], ["Related/Other.md", "modified"],
  ]);
});

test("card expansion survives tool context copies and a suspended checkpoint", async () => {
  const registry = new ToolRegistry();
  registry.register(createCardExpandToolsTool());
  registry.register(buildTool({ name: "web_request", description: "deferred", inputSchema: { type: "object" }, capabilities: { effect: "none", risk: "low", concurrency: "serial", presentation: "web", targets: [] }, async *execute() { yield { type: "result", content: "unused" }; } }));
  let checked = false;
  const provider = scripted([[use("expand", "card_expand_tools")]], (input, turn) => {
    if (!turn) assert.equal(input.tools.some(t => t.name === "web_request"), false);
    else { assert.equal(input.tools.some(t => t.name === "web_request"), true); checked = true; }
  });
  const events = await collect({ registry, provider, messages, ctx: { cardWorkflow: true } });
  assert.equal(checked, true);
  const paused = await collect({ registry, provider: scripted([[use("expand", "card_expand_tools")]]), messages, ctx: { cardWorkflow: true }, maxTurns: 1 });
  const checkpoint = paused.at(-1).checkpoint;
  assert.deepEqual(checkpoint.cardToolSurface, { active: true, expanded: true });
  await collect({ registry, provider: scripted([], input => assert.ok(input.tools.some(t => t.name === "web_request"))), messages: checkpoint.messages,
    resumeState: { cardToolSurface: checkpoint.cardToolSurface } });
  assert.equal(events.at(-1).type, "done");
});

test("natural skill invocation makes registered card tools reachable on the next turn", async () => {
  const vault = fakeVault();
  const skillRegistry = { list: () => [], get: () => ({ name: "ah-card", body: "Create a card", dirPath: "skills/ah-card" }) };
  const registry = buildDefaultToolRegistry({ vault }, null, skillRegistry, { settings: {} }, new Date(), { includeCardTools: true });
  let checked = false;
  await collect({ registry, provider: scripted([[use("skill", "skill_invoke", { skill: "ah-card" })]], (input, turn) => {
    if (!turn) assert.equal(input.tools.some(t => t.name === "card_commit"), false);
    else { assert.ok(input.tools.some(t => t.name === "card_commit")); checked = true; }
  }), messages });
  assert.ok(checked);
  assert.equal(cardToolSurface(registry.list(), {}).some(t => t.name === "card_commit"), false);
});

test("stale attachment text is removed, while unchanged complete attachment permits reuse", async () => {
  const vault = fakeVault();
  const cache = new FileStateCache();
  const path = "Sources/Insight.md";
  const content = vault.files.get(path);
  const promptBlock = `<<<FLOWNOTE_FILE path="${path}">>>\n${content}\n<<<END_FLOWNOTE_FILE>>>`;
  const evidence = [{ path, content, visibleRanges: [[0, content.length]], promptBlock }];
  const history = [{ role: "user", content: [{ type: "text", text: promptBlock }] }];
  assert.deepEqual(await seedLinkedEvidence({ evidence, vault, cache, history }), []);
  assert.ok(cache.isTextVisible(path, "A user claim"));
  vault.files.set(path, "changed");
  const freshCache = new FileStateCache();
  assert.deepEqual(await seedLinkedEvidence({ evidence, vault, cache: freshCache, history }), [path]);
  assert.equal(freshCache.has(path), false);
  assert.equal(history[0].content[0].text.includes(content), false);
  assert.match(history[0].content[0].text, /ATTACHMENT_STALE/);
});
