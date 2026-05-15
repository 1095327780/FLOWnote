const test = require("node:test");
const assert = require("node:assert/strict");

const {
  migrateSkillDir,
  copyDirRecursive,
  OLD_DIR,
  NEW_DIR,
} = require("../../runtime/skill-migration");

// A minimal in-memory Obsidian adapter — enough for migration logic.
function makeAdapter(initial = {}) {
  // initial: { "path": "file content" } — folders inferred from paths.
  const files = new Map();
  const folders = new Set();
  for (const [p, v] of Object.entries(initial)) {
    files.set(p, v);
    // Auto-create parent folder chain.
    let parts = p.split("/");
    parts.pop();
    while (parts.length > 0) {
      folders.add(parts.join("/"));
      parts.pop();
    }
  }
  return {
    _files: files,
    _folders: folders,
    async exists(path) {
      return files.has(path) || folders.has(path);
    },
    async list(path) {
      const prefix = path.replace(/\/+$/, "") + "/";
      const directFiles = [];
      const directSubfolders = new Set();
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        if (!rest.includes("/")) directFiles.push(f);
        else directSubfolders.add(`${prefix}${rest.split("/")[0]}`);
      }
      for (const folder of folders) {
        if (folder === path) continue;
        if (!folder.startsWith(prefix)) continue;
        const rest = folder.slice(prefix.length);
        if (!rest.includes("/")) directSubfolders.add(folder);
      }
      return {
        files: directFiles.sort(),
        folders: Array.from(directSubfolders).sort(),
      };
    },
    async read(path) {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return files.get(path);
    },
    async write(path, data) {
      files.set(path, data);
      let parts = path.split("/");
      parts.pop();
      while (parts.length > 0) {
        folders.add(parts.join("/"));
        parts.pop();
      }
    },
    async mkdir(path) {
      folders.add(path);
      const parts = path.split("/");
      parts.pop();
      while (parts.length > 0) {
        folders.add(parts.join("/"));
        parts.pop();
      }
    },
  };
}

function makePlugin(adapter, settings = {}) {
  const saved = [];
  return {
    _saved: saved,
    app: { vault: { adapter } },
    settings,
    async saveSettings() {
      saved.push(JSON.parse(JSON.stringify(settings)));
    },
  };
}

// ---------------------------------------------------------------------------
// copyDirRecursive
// ---------------------------------------------------------------------------

test("copyDirRecursive duplicates an entire directory tree", async () => {
  const adapter = makeAdapter({
    ".opencode/skills/ah/SKILL.md": "ah body",
    ".opencode/skills/ah-card/SKILL.md": "card body",
    ".opencode/skills/ah-card/references/note.md": "reference",
  });
  const copied = await copyDirRecursive(adapter, ".opencode/skills", ".flownote/skills");
  assert.equal(copied, 3);
  assert.equal(adapter._files.get(".flownote/skills/ah/SKILL.md"), "ah body");
  assert.equal(adapter._files.get(".flownote/skills/ah-card/SKILL.md"), "card body");
  assert.equal(adapter._files.get(".flownote/skills/ah-card/references/note.md"), "reference");
});

test("copyDirRecursive handles empty source directory cleanly", async () => {
  const adapter = makeAdapter({});
  await adapter.mkdir(".opencode/skills");
  const copied = await copyDirRecursive(adapter, ".opencode/skills", ".flownote/skills");
  assert.equal(copied, 0);
  assert.equal(await adapter.exists(".flownote/skills"), true);
});

test("copyDirRecursive leaves the source intact", async () => {
  const adapter = makeAdapter({
    ".opencode/skills/ah/SKILL.md": "body",
  });
  await copyDirRecursive(adapter, ".opencode/skills", ".flownote/skills");
  // Source still present
  assert.equal(adapter._files.get(".opencode/skills/ah/SKILL.md"), "body");
  // Target populated
  assert.equal(adapter._files.get(".flownote/skills/ah/SKILL.md"), "body");
});

// ---------------------------------------------------------------------------
// migrateSkillDir
// ---------------------------------------------------------------------------

test("migrateSkillDir skips when target already exists", async () => {
  const adapter = makeAdapter({
    ".opencode/skills/ah/SKILL.md": "old",
    ".flownote/skills/ah/SKILL.md": "new", // target already present
  });
  const plugin = makePlugin(adapter, { skillsDir: OLD_DIR });
  const result = await migrateSkillDir(plugin);
  assert.equal(result.migrated, false);
  assert.equal(result.reason, "target exists");
  // Settings untouched
  assert.equal(plugin.settings.skillsDir, OLD_DIR);
});

test("migrateSkillDir skips when source is missing", async () => {
  const adapter = makeAdapter({});
  const plugin = makePlugin(adapter, { skillsDir: OLD_DIR });
  const result = await migrateSkillDir(plugin);
  assert.equal(result.migrated, false);
  assert.equal(result.reason, "source missing");
  assert.equal(plugin.settings.skillsDir, OLD_DIR);
});

test("migrateSkillDir copies tree and auto-updates skillsDir from the OpenCode default", async () => {
  const adapter = makeAdapter({
    ".opencode/skills/ah/SKILL.md": "ah body",
    ".opencode/skills/ah-card/SKILL.md": "card body",
  });
  const plugin = makePlugin(adapter, { skillsDir: OLD_DIR });
  plugin.__flownoteSkillCache = { root: OLD_DIR, registry: {} };

  const result = await migrateSkillDir(plugin);

  assert.equal(result.migrated, true);
  assert.equal(result.copied, 2);
  assert.equal(adapter._files.get(".flownote/skills/ah/SKILL.md"), "ah body");
  // Source preserved per design doc §8.2
  assert.equal(adapter._files.get(".opencode/skills/ah/SKILL.md"), "ah body");
  // skillsDir bumped to new default
  assert.equal(plugin.settings.skillsDir, NEW_DIR);
  // Settings persisted
  assert.equal(plugin._saved.length, 1);
  // Cache invalidated
  assert.equal(plugin.__flownoteSkillCache, null);
});

test("migrateSkillDir leaves a user-customized skillsDir alone", async () => {
  const adapter = makeAdapter({
    ".opencode/skills/ah/SKILL.md": "body",
  });
  const plugin = makePlugin(adapter, { skillsDir: "my-custom/skills" });

  const result = await migrateSkillDir(plugin);
  assert.equal(result.migrated, true);
  // User had customized — we don't override.
  assert.equal(plugin.settings.skillsDir, "my-custom/skills");
  // Save NOT called — settings unchanged.
  assert.equal(plugin._saved.length, 0);
});

test("migrateSkillDir bumps an empty skillsDir to the new default", async () => {
  const adapter = makeAdapter({
    ".opencode/skills/ah/SKILL.md": "body",
  });
  const plugin = makePlugin(adapter, { skillsDir: "" });

  await migrateSkillDir(plugin);
  assert.equal(plugin.settings.skillsDir, NEW_DIR);
});

test("migrateSkillDir is idempotent on re-run", async () => {
  const adapter = makeAdapter({
    ".opencode/skills/ah/SKILL.md": "body",
  });
  const plugin = makePlugin(adapter, { skillsDir: OLD_DIR });

  const first = await migrateSkillDir(plugin);
  assert.equal(first.migrated, true);

  const second = await migrateSkillDir(plugin);
  assert.equal(second.migrated, false);
  assert.equal(second.reason, "target exists");
});

test("migrateSkillDir returns 'no plugin/vault' when called with malformed input", async () => {
  const r = await migrateSkillDir(null);
  assert.equal(r.migrated, false);
});

test("migrateSkillDir returns 'no vault adapter' when adapter missing exists()", async () => {
  const plugin = { app: { vault: { adapter: {} } }, settings: {} };
  const r = await migrateSkillDir(plugin);
  assert.equal(r.migrated, false);
  assert.equal(r.reason, "no vault adapter");
});
