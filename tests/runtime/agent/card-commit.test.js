const test = require("node:test");
const assert = require("node:assert/strict");

const { createCardCommitTool, safeNotePath } = require("../../../runtime/agent/tools/card-commit");
const { FileStateCache, contentFingerprint } = require("../../../runtime/agent/file-state-cache");
const { ToolRegistry } = require("../../../runtime/agent/tool-registry");
const { runToolUse, createEffectReceipt } = require("../../../runtime/agent/agent-loop");

function fakeVault(initial) {
  const files = new Map(Object.entries(initial || {}));
  const writes = [];
  const vault = {
    files, writes, folders: new Set(["Cards", "Topics", "Sources", "Related"]),
    getFileByPath(path) { return files.has(path) ? { path } : null; },
    getFolderByPath(path) { return this.folders.has(path) ? { path, children: [] } : null; },
    async read(file) { return files.get(file.path); },
    async create(path, content) {
      if (files.has(path)) throw new Error("already exists");
      writes.push(`create:${path}`);
      files.set(path, content);
    },
    async process(file, transform) {
      const live = files.get(file.path);
      const updated = transform(live);
      writes.push(`process:${file.path}`);
      files.set(file.path, updated);
    },
  };
  return vault;
}

function plan() {
  const card = { path: "Cards/Idea.md", content: "# Idea\n\nConfirmed text.\n" };
  const sync = [
    { path: "Topics/Theme.md", role: "topic", old_string: "## Cards\n", new_string: "## Cards\n- [[Cards/Idea]]\n" },
    { path: "Sources/Book.md", role: "source", old_string: "## Derived\n", new_string: "## Derived\n- [[Cards/Idea]]\n" },
    { path: "Sources/Book.md", role: "source", old_string: "Permanent note: \n", new_string: "Permanent note: [[Cards/Idea]]\n" },
    { path: "Related/Other.md", role: "backlink", old_string: "## Related\n", new_string: "## Related\n- [[Cards/Idea]]\n" },
  ];
  return { card, sync };
}

function setup({ visible = true } = {}) {
  const vault = fakeVault({
    "Topics/Theme.md": "# Theme\n## Cards\n",
    "Sources/Book.md": "# Book\n## Derived\nInsight\nPermanent note: \n",
    "Related/Other.md": "# Other\n## Related\n",
  });
  const cache = new FileStateCache();
  for (const [path, text] of vault.files) {
    cache.recordRead(path, text, { visibleRanges: visible ? [[0, text.length]] : [] });
  }
  return { vault, cache, ctx: { fileStateCache: cache }, input: plan() };
}

async function collect(tool, input, ctx) {
  const out = [];
  for await (const event of tool.execute(input, ctx)) out.push(event);
  return out.at(-1);
}

test("card_commit commits a new card, two ordered source edits, and all link targets", async () => {
  const { vault, ctx, input } = setup();
  const tool = createCardCommitTool({ vault });
  assert.equal((await tool.validate(input)).ok, true);
  const result = await collect(tool, input, ctx);
  assert.equal(result.isError, false);
  assert.deepEqual(result.data.verified, ["Cards/Idea.md", "Topics/Theme.md", "Sources/Book.md", "Related/Other.md"]);
  assert.deepEqual(vault.writes, [
    "create:Cards/Idea.md", "process:Topics/Theme.md", "process:Sources/Book.md", "process:Related/Other.md",
  ]);
  assert.equal(vault.files.get("Sources/Book.md").match(/\[\[Cards\/Idea\]\]/gu).length, 2);
  assert.equal((await tool.verifyEffect(input, { data: result.data }, ctx)).verified, true);
});

test("preflight rejects stale later target before creating the card", async () => {
  const { vault, ctx, input } = setup();
  vault.files.set("Related/Other.md", "external change");
  const result = await collect(createCardCommitTool({ vault }), input, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content, /read evidence is missing or stale/);
  assert.deepEqual(vault.writes, []);
});

test("preflight requires each exact old string to have been visible to the model", async () => {
  const { vault, ctx, input } = setup({ visible: false });
  const result = await collect(createCardCommitTool({ vault }), input, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content, /was not visible/);
  assert.deepEqual(vault.writes, []);
});

test("an exact confirmed link snippet is deduplicated while a second source field is still filled", async () => {
  const { vault, ctx, input } = setup();
  const source = vault.files.get("Sources/Book.md").replace(input.sync[1].old_string, input.sync[1].new_string);
  vault.files.set("Sources/Book.md", source);
  ctx.fileStateCache.recordRead("Sources/Book.md", source, { visibleRanges: [[0, source.length]] });
  const result = await collect(createCardCommitTool({ vault }), input, ctx);
  assert.equal(result.isError, false);
  assert.equal(vault.files.get("Sources/Book.md").match(/\[\[Cards\/Idea\]\]/gu).length, 2);
  assert.equal(vault.writes.filter((write) => write === "process:Sources/Book.md").length, 1);
});

test("an existing link elsewhere does not hide an ambiguous unsynced old_string", async () => {
  const { vault, ctx, input } = setup();
  const edit = input.sync[3];
  const current = `${edit.new_string}\n${edit.old_string}`;
  vault.files.set(edit.path, current);
  ctx.fileStateCache.recordRead(edit.path, current);
  const plan = { card: input.card, sync: [edit] };

  const result = await collect(createCardCommitTool({ vault }), plan, ctx);

  assert.equal(result.isError, true);
  assert.match(result.content, /old_string has 2 matches/);
  assert.deepEqual(vault.writes, []);
  assert.equal(vault.files.has(input.card.path), false);
  assert.equal(vault.files.get(edit.path), current);
});

test("a supplied after_fingerprint cannot certify an ambiguous linked state", async () => {
  const { vault, ctx, input } = setup();
  const edit = input.sync[3];
  const before = vault.files.get(edit.path);
  const current = `${edit.new_string}\n${edit.old_string}`;
  vault.files.set(edit.path, current);
  ctx.fileStateCache.recordRead(edit.path, current);
  const guarded = {
    ...edit,
    expected_fingerprint: contentFingerprint(before),
    after_fingerprint: contentFingerprint(current),
  };

  const result = await collect(createCardCommitTool({ vault }), { card: input.card, sync: [guarded] }, ctx);

  assert.equal(result.isError, true);
  assert.match(result.content, /fingerprint changed since the confirmed plan/);
  assert.deepEqual(vault.writes, []);
});

test("a confirmed card with no confirmed sync targets can be created without inventing links", async () => {
  const { vault, ctx, input } = setup();
  const cardOnly = { card: input.card, sync: [] };
  const tool = createCardCommitTool({ vault });
  assert.equal((await tool.validate(cardOnly)).ok, true);
  const result = await collect(tool, cardOnly, ctx);
  assert.equal(result.isError, false);
  assert.deepEqual(vault.writes, ["create:Cards/Idea.md"]);
  assert.equal((await tool.verifyEffect(cardOnly, { data: result.data }, ctx)).verified, true);
});

test("partial failure stops later writes and same-input retry resumes verified targets", async () => {
  const { vault, ctx, input } = setup();
  const tool = createCardCommitTool({ vault });
  const process = vault.process;
  let failOnce = true;
  vault.process = async (file, fn) => {
    if (file.path === "Sources/Book.md" && failOnce) {
      failOnce = false;
      throw new Error("disk unavailable");
    }
    return process.call(vault, file, fn);
  };
  const first = await collect(tool, input, ctx);
  assert.equal(first.isError, true);
  assert.deepEqual(first.data.verified, ["Cards/Idea.md", "Topics/Theme.md"]);
  assert.deepEqual(first.data.pending, ["Sources/Book.md", "Related/Other.md"]);
  assert.equal(vault.files.has("Related/Other.md"), true);
  assert.equal(vault.files.get("Related/Other.md"), "# Other\n## Related\n");

  const second = await collect(tool, input, ctx);
  assert.equal(second.isError, false);
  assert.deepEqual(vault.writes, [
    "create:Cards/Idea.md", "process:Topics/Theme.md", "process:Sources/Book.md", "process:Related/Other.md",
  ]);
  const third = await collect(tool, input, ctx);
  assert.equal(third.isError, false);
  assert.equal(vault.writes.length, 4);
});

test("guarded retry after tool recreation skips exact post-state and applies remaining targets", async () => {
  const { vault, ctx, input } = setup();
  const topicBefore = vault.files.get("Topics/Theme.md");
  const topicAfter = topicBefore.replace(input.sync[0].old_string, input.sync[0].new_string);
  const sourceBefore = vault.files.get("Sources/Book.md");
  const sourceAfter = sourceBefore
    .replace(input.sync[1].old_string, input.sync[1].new_string)
    .replace(input.sync[2].old_string, input.sync[2].new_string);
  const otherBefore = vault.files.get("Related/Other.md");
  const otherAfter = otherBefore.replace(input.sync[3].old_string, input.sync[3].new_string);
  const guarded = {
    card: input.card,
    sync: input.sync.map((item) => {
      const before = item.path === "Topics/Theme.md" ? topicBefore : item.path === "Sources/Book.md" ? sourceBefore : otherBefore;
      const after = item.path === "Topics/Theme.md" ? topicAfter : item.path === "Sources/Book.md" ? sourceAfter : otherAfter;
      return { ...item, expected_fingerprint: contentFingerprint(before), after_fingerprint: contentFingerprint(after) };
    }),
  };
  vault.files.set(input.card.path, input.card.content);
  vault.files.set("Topics/Theme.md", topicAfter);
  ctx.fileStateCache.recordRead("Topics/Theme.md", topicAfter, { visibleRanges: [[0, topicAfter.length]] });
  const result = await collect(createCardCommitTool({ vault }), guarded, ctx);
  assert.equal(result.isError, false);
  assert.deepEqual(vault.writes, ["process:Sources/Book.md", "process:Related/Other.md"]);
});

test("process checks live content again and reports only verified partial writes", async () => {
  const { vault, ctx, input } = setup();
  const process = vault.process;
  vault.process = async (file, fn) => {
    if (file.path === "Topics/Theme.md") vault.files.set(file.path, "external concurrent edit");
    return process.call(vault, file, fn);
  };
  const result = await collect(createCardCommitTool({ vault }), input, ctx);
  assert.equal(result.isError, true);
  assert.deepEqual(result.data.verified, ["Cards/Idea.md"]);
  assert.deepEqual(vault.writes, ["create:Cards/Idea.md"]);
  assert.equal(vault.files.get("Sources/Book.md"), "# Book\n## Derived\nInsight\nPermanent note: \n");
});

test("a process that writes then throws is reported as attempted and unverified", async () => {
  const { vault, ctx, input } = setup();
  const process = vault.process;
  vault.process = async (file, fn) => {
    await process.call(vault, file, fn);
    if (file.path === "Topics/Theme.md") throw new Error("post-write failure");
  };
  const result = await collect(createCardCommitTool({ vault }), input, ctx);
  assert.equal(result.isError, true);
  assert.deepEqual(result.data.verified, ["Cards/Idea.md"]);
  assert.equal(result.data.attempted, "Topics/Theme.md");
  assert.equal(result.data.observation, "desired_state_observed_unverified");
  assert.equal(result.data.recovery.length, 3);
  assert.deepEqual(vault.writes, ["create:Cards/Idea.md", "process:Topics/Theme.md"]);
});

test("cancellation after card creation stops before linked-note writes", async () => {
  const { vault, ctx, input } = setup();
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const create = vault.create;
  vault.create = async (path, content) => {
    await create.call(vault, path, content);
    controller.abort();
  };
  const result = await collect(createCardCommitTool({ vault }), input, ctx);
  assert.equal(result.isError, true);
  assert.deepEqual(result.data.verified, ["Cards/Idea.md"]);
  assert.deepEqual(vault.writes, ["create:Cards/Idea.md"]);
});

test("synced note retains only model-visible spans in FileStateCache", async () => {
  const vault = fakeVault({ "Topics/Theme.md": "# Theme\n## Cards\nprivate tail" });
  const cache = new FileStateCache();
  const before = vault.files.get("Topics/Theme.md");
  const old = "## Cards\n";
  const start = before.indexOf(old);
  cache.recordRead("Topics/Theme.md", before, { visibleRanges: [[start, start + old.length]] });
  const input = {
    card: { path: "Cards/Idea.md", content: "# Idea\n" },
    sync: [{ path: "Topics/Theme.md", role: "topic", old_string: old, new_string: "## Cards\n- [[Cards/Idea]]\n" }],
  };
  const tool = createCardCommitTool({ vault });
  const result = await collect(tool, input, { fileStateCache: cache });
  assert.equal(result.isError, false);
  assert.equal(cache.isTextVisible("Topics/Theme.md", "- [[Cards/Idea]]"), true);
  assert.equal(cache.isTextVisible("Topics/Theme.md", "private tail"), false);
  assert.equal((await tool.verifyEffect(input, { data: result.data }, { fileStateCache: cache })).verified, true);
  assert.equal(cache.isTextVisible("Topics/Theme.md", "private tail"), false);
});

test("path, role, link and existing-card safety are validated", async () => {
  const { vault, ctx, input } = setup();
  const tool = createCardCommitTool({ vault });
  for (const path of [".obsidian/plugins/x.md", "../outside.md", "/absolute.md", "Cards\\Idea.md", "Cards/file.json", "Cards//Idea.md"]) {
    assert.equal(safeNotePath(path), null);
  }
  assert.equal((await tool.validate({ ...input, card: { ...input.card, path: ".obsidian/data.md" } })).ok, false);
  assert.equal((await tool.validate({ ...input, sync: [input.sync[1], input.sync[0]] })).ok, false);
  assert.equal((await tool.validate({ ...input, sync: [{ ...input.sync[0], new_string: "## Cards\n- [[Other]]\n" }] })).ok, false);
  vault.files.set(input.card.path, "unrelated content");
  const result = await collect(tool, input, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content, /already exists with different content/);
  assert.deepEqual(vault.writes, []);
});

test("card_commit uses normal tool permission and verified effect receipt", async () => {
  const { vault, ctx, input } = setup();
  const tool = createCardCommitTool({ vault });
  assert.equal((await tool.checkPermissions(input, ctx)).behavior, "ask");
  const registry = new ToolRegistry();
  registry.register(tool);
  const denied = await runToolUse({ id: "one", name: "card_commit", input }, registry, ctx, null);
  assert.equal(denied.isError, true);
  assert.equal(vault.writes.length, 0);
  const allowed = await runToolUse({ id: "two", name: "card_commit", input }, registry, ctx, async () => ({ behavior: "allow" }));
  assert.equal(allowed.isError, false);
  assert.equal(allowed.verification.verified, true);
  const effect = await createEffectReceipt({ id: "two", name: "card_commit", input }, allowed, ctx);
  assert.equal(effect.verified, true);
  assert.deepEqual(effect.paths, ["Cards/Idea.md", "Topics/Theme.md", "Sources/Book.md", "Related/Other.md"]);
});
