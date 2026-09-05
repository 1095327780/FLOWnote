const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ContinuationCheckpointStore,
  canonicalJson,
  sha256Hex,
  sha256HexAsync,
} = require("../../../runtime/chat/continuation-checkpoint-store");

function checkpoint(overrides = {}) {
  return {
    version: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "checkpoint body" }] }],
    effectReceipts: [],
    contract: { id: "skill-ah-card", mode: "workflow" },
    completionRetries: 0,
    turns: 4,
    ...overrides,
  };
}

function makeAdapter(initial = {}) {
  const files = new Map(Object.entries(initial));
  const modified = new Map(Array.from(files.keys(), (key) => [key, 1]));
  const folders = new Set([".obsidian", ".obsidian/plugins", ".obsidian/plugins/flownote"]);
  return {
    _files: files,
    _folders: folders,
    async exists(path) { return files.has(path) || folders.has(path); },
    async mkdir(path) { folders.add(path); },
    async read(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    async write(path, text) { files.set(path, text); modified.set(path, Date.now()); },
    async remove(path) { files.delete(path); modified.delete(path); },
    async list(path) {
      const prefix = `${path.replace(/\/+$/, "")}/`;
      return {
        files: Array.from(files.keys()).filter((file) => file.startsWith(prefix)),
        folders: [],
      };
    },
    async stat(path) {
      if (!files.has(path)) return null;
      return { type: "file", size: new TextEncoder().encode(files.get(path)).length, mtime: modified.get(path) || 1 };
    },
  };
}

function makeStore(adapter) {
  return new ContinuationCheckpointStore({
    vault: { adapter },
    manifest: { dir: ".obsidian/plugins/flownote" },
  });
}

test("uses portable SHA-256 content hashes", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("async checkpoint hashing preserves the portable content address", async () => {
  assert.equal(await sha256HexAsync("abc"), sha256Hex("abc"));
});

test("stores a single content-addressed checkpoint outside session data and restores it after a new store instance", async () => {
  const sentinel = `CHECKPOINT_SECRET_${"x".repeat(4096)}`;
  const adapter = makeAdapter();
  const ref = await makeStore(adapter).store(checkpoint({
    messages: [{ role: "user", content: [{ type: "text", text: sentinel }] }],
  }));

  assert.deepEqual(Object.keys(ref).sort(), ["byteLength", "id", "path", "version"]);
  assert.match(ref.id, /^sha256:[a-f0-9]{64}$/);
  assert.match(ref.path, /^\.obsidian\/plugins\/flownote\/continuations\/[a-f0-9]{64}\.json$/);
  assert.ok(ref.byteLength > sentinel.length);
  assert.ok(JSON.stringify(ref).length < 256);
  assert.doesNotMatch(JSON.stringify(ref), /CHECKPOINT_SECRET/);

  const restored = await makeStore(adapter).load(ref);
  assert.equal(restored.messages[0].content[0].text, sentinel);
  assert.equal(adapter._files.size, 1);
});

test("deduplicates identical checkpoints at the same stable content address", async () => {
  const adapter = makeAdapter();
  const store = makeStore(adapter);
  const first = await store.store(checkpoint());
  const second = await store.store(checkpoint());
  assert.deepEqual(second, first);
  assert.equal(adapter._files.size, 1);
});

test("fails closed for missing, tampered, and schema-invalid checkpoint files", async () => {
  const adapter = makeAdapter();
  const store = makeStore(adapter);
  const ref = await store.store(checkpoint());

  await assert.rejects(store.load({ ...ref, path: ".obsidian/plugins/flownote/continuations/other.json" }), /reference/i);
  adapter._files.delete(ref.path);
  await assert.rejects(store.load(ref), /unavailable/i);

  const freshRef = await store.store(checkpoint({ turns: 5 }));
  adapter._files.set(freshRef.path, JSON.stringify({ ...checkpoint({ turns: 5 }), turns: -1 }));
  await assert.rejects(store.load(freshRef), (error) => error && error.code === "CHECKPOINT_INTEGRITY_INVALID");

  const invalid = { ...checkpoint({ turns: -1 }) };
  const invalidText = canonicalJson(invalid);
  const invalidHash = sha256Hex(invalidText);
  const invalidRef = {
    version: 1,
    id: `sha256:${invalidHash}`,
    path: `.obsidian/plugins/flownote/continuations/${invalidHash}.json`,
    byteLength: new TextEncoder().encode(invalidText).length,
  };
  adapter._files.set(invalidRef.path, invalidText);
  await assert.rejects(store.load(invalidRef), (error) => error && error.code === "CHECKPOINT_INVALID");
});

test("removes a stored checkpoint best effort without making continuation cleanup fatal", async () => {
  const adapter = makeAdapter();
  const store = makeStore(adapter);
  const ref = await store.store(checkpoint());
  assert.equal(await store.remove(ref), true);
  assert.equal(await store.remove(ref), false);
});

test("mark-and-sweep keeps shared live refs and removes only unreferenced checkpoint blobs", async () => {
  const adapter = makeAdapter();
  const store = makeStore(adapter);
  const sharedA = await store.store(checkpoint({ turns: 5 }));
  const sharedB = await store.store(checkpoint({ turns: 5 }));
  const orphan = await store.store(checkpoint({ turns: 6 }));

  const first = await store.sweep([sharedA, sharedB], { minimumAgeMs: 0, now: Date.now() });
  assert.equal(first.removed, 1);
  assert.equal(first.kept, 1);
  assert.equal(adapter._files.has(sharedA.path), true);
  assert.equal(adapter._files.has(orphan.path), false);

  const last = await store.sweep([], { minimumAgeMs: 0, now: Date.now() });
  assert.equal(last.removed, 1);
  assert.equal(adapter._files.has(sharedA.path), false);
});

test("sweep grace period protects a newly written blob that may not be committed to session state yet", async () => {
  const adapter = makeAdapter();
  const store = makeStore(adapter);
  const ref = await store.store(checkpoint({ turns: 7 }));

  const result = await store.sweep([], { minimumAgeMs: 60_000, now: Date.now() });

  assert.equal(result.removed, 0);
  assert.equal(result.deferred, 1);
  assert.equal(adapter._files.has(ref.path), true);
});
