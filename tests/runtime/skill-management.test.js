const test = require("node:test");
const assert = require("node:assert/strict");

const {
  listSkills,
  readSkill,
  saveSkill,
  deleteSkill,
  validateSlug,
  renderSkillMarkdown,
} = require("../../runtime/settings/skill-management");

// Adapter fake matching the surface we use: list, exists, read, write, mkdir, remove, rmdir.
function makeAdapter(initial = {}) {
  const files = new Map();
  const folders = new Set();
  for (const [p, content] of Object.entries(initial)) {
    files.set(p, content);
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
    async exists(p) { return files.has(p) || folders.has(p); },
    async list(path) {
      const prefix = String(path).replace(/\/+$/, "") + "/";
      const directFiles = [];
      const directFolders = new Set();
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        if (!rest.includes("/")) directFiles.push(f);
        else directFolders.add(`${prefix.slice(0, -1)}/${rest.split("/")[0]}`);
      }
      for (const folder of folders) {
        if (folder === path) continue;
        if (!folder.startsWith(prefix)) continue;
        const rest = folder.slice(prefix.length);
        if (!rest.includes("/")) directFolders.add(folder);
      }
      return { files: directFiles.sort(), folders: Array.from(directFolders).sort() };
    },
    async read(p) {
      if (!files.has(p)) throw new Error(`no ${p}`);
      return files.get(p);
    },
    async write(p, data) {
      files.set(p, data);
      let parts = p.split("/");
      parts.pop();
      while (parts.length > 0) {
        folders.add(parts.join("/"));
        parts.pop();
      }
    },
    async mkdir(p) { folders.add(p); },
    async remove(p) { files.delete(p); },
    async rmdir(p) { folders.delete(p); },
  };
}

function makePlugin(adapter, skillsDir = ".flownote/skills") {
  return {
    app: { vault: { adapter } },
    settings: { skillsDir },
  };
}

// ---------------------------------------------------------------------------
// validateSlug
// ---------------------------------------------------------------------------

test("validateSlug accepts lowercase-hyphen slugs", () => {
  assert.equal(validateSlug("ah-card").ok, true);
  assert.equal(validateSlug("ah").ok, true);
  assert.equal(validateSlug("v2").ok, true);
});

test("validateSlug rejects uppercase, spaces, dots, and empty", () => {
  assert.equal(validateSlug("").ok, false);
  assert.equal(validateSlug("Ah-Card").ok, false);
  assert.equal(validateSlug("ah card").ok, false);
  assert.equal(validateSlug("ah.card").ok, false);
  assert.equal(validateSlug("-leading-hyphen").ok, false);
});

// ---------------------------------------------------------------------------
// renderSkillMarkdown
// ---------------------------------------------------------------------------

test("renderSkillMarkdown emits frontmatter in stable order + quotes risky scalars", () => {
  const md = renderSkillMarkdown({
    slug: "ah-card",
    name: "AH 卡片",
    description: "Permanent note crafter",
    whenToUse: "用户说\"制卡\"时", // embedded quotes → must be quoted
    allowedTools: ["vault_read", "vault_write"],
    body: "# Body\nstuff",
  });
  assert.match(md, /^---/);
  assert.match(md, /name: AH 卡片/);
  assert.match(md, /description: Permanent note crafter/);
  assert.match(md, /when_to_use: "用户说.*制卡.*时"/);
  assert.match(md, /allowed-tools: \[vault_read, vault_write\]/);
  assert.match(md, /# Body/);
});

test("renderSkillMarkdown omits optional fields when absent", () => {
  const md = renderSkillMarkdown({
    slug: "x",
    name: "X",
    description: "Short",
    body: "",
  });
  assert.doesNotMatch(md, /when_to_use/);
  assert.doesNotMatch(md, /allowed-tools/);
});

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

test("listSkills returns parsed skills sorted by name", async () => {
  const adapter = makeAdapter({
    ".flownote/skills/ah-card/SKILL.md":
      `---\nname: AH 卡片\ndescription: 制卡技能\n---\nbody-a`,
    ".flownote/skills/ah-note/SKILL.md":
      `---\nname: 0AH 笔记\ndescription: 日记技能\n---\nbody-b`,
  });
  const plugin = makePlugin(adapter);
  const out = await listSkills(plugin);
  assert.equal(out.length, 2);
  // "0AH 笔记" sorts before "AH 卡片"
  assert.equal(out[0].slug, "ah-note");
  assert.equal(out[1].slug, "ah-card");
  assert.equal(out[0].description, "日记技能");
});

test("listSkills skips folders without SKILL.md", async () => {
  const adapter = makeAdapter({
    ".flownote/skills/ah-card/SKILL.md": `---\nname: A\ndescription: D\n---\nbody`,
    ".flownote/skills/empty/README.md": "junk",
  });
  const plugin = makePlugin(adapter);
  const out = await listSkills(plugin);
  assert.equal(out.length, 1);
  assert.equal(out[0].slug, "ah-card");
});

test("listSkills returns [] when skillsDir doesn't exist", async () => {
  const adapter = makeAdapter({});
  const plugin = makePlugin(adapter);
  const out = await listSkills(plugin);
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// readSkill
// ---------------------------------------------------------------------------

test("readSkill returns the requested skill", async () => {
  const adapter = makeAdapter({
    ".flownote/skills/ah-card/SKILL.md": `---\nname: AH\ndescription: D\n---\nbody`,
  });
  const plugin = makePlugin(adapter);
  const s = await readSkill(plugin, "ah-card");
  assert.equal(s.slug, "ah-card");
  assert.equal(s.name, "AH");
});

test("readSkill returns null for unknown slug", async () => {
  const adapter = makeAdapter({
    ".flownote/skills/x/SKILL.md": `---\nname: X\ndescription: D\n---`,
  });
  const plugin = makePlugin(adapter);
  const s = await readSkill(plugin, "missing");
  assert.equal(s, null);
});

// ---------------------------------------------------------------------------
// saveSkill
// ---------------------------------------------------------------------------

test("saveSkill creates a new skill folder + SKILL.md", async () => {
  const adapter = makeAdapter({});
  const plugin = makePlugin(adapter);
  const r = await saveSkill(plugin, {
    slug: "new-skill",
    name: "新技能",
    description: "干新事",
    body: "step 1",
  });
  assert.equal(r.created, true);
  const written = adapter._files.get(".flownote/skills/new-skill/SKILL.md");
  assert.ok(written);
  assert.match(written, /name: 新技能/);
  assert.match(written, /step 1/);
});

test("saveSkill overwriting via existingSlug keeps the same path", async () => {
  const adapter = makeAdapter({
    ".flownote/skills/old/SKILL.md": `---\nname: old\ndescription: d\n---\nbody`,
  });
  const plugin = makePlugin(adapter);
  await saveSkill(plugin,
    { slug: "old", name: "old", description: "updated", body: "new" },
    "old",
  );
  const written = adapter._files.get(".flownote/skills/old/SKILL.md");
  assert.match(written, /description: updated/);
  assert.match(written, /new/);
});

test("saveSkill rename moves content + deletes old folder", async () => {
  const adapter = makeAdapter({
    ".flownote/skills/old/SKILL.md": `---\nname: old\ndescription: d\n---\nbody`,
  });
  const plugin = makePlugin(adapter);
  const r = await saveSkill(plugin,
    { slug: "renamed", name: "renamed", description: "d", body: "body" },
    "old",
  );
  assert.equal(r.renamed, true);
  assert.equal(adapter._files.has(".flownote/skills/renamed/SKILL.md"), true);
  assert.equal(adapter._files.has(".flownote/skills/old/SKILL.md"), false);
});

test("saveSkill refuses creation when target slug already exists", async () => {
  const adapter = makeAdapter({
    ".flownote/skills/exists/SKILL.md": `---\nname: x\ndescription: y\n---`,
  });
  const plugin = makePlugin(adapter);
  await assert.rejects(
    () => saveSkill(plugin, { slug: "exists", name: "x", description: "y", body: "" }),
    /已存在同名技能/,
  );
});

test("saveSkill validates required fields", async () => {
  const adapter = makeAdapter({});
  const plugin = makePlugin(adapter);
  await assert.rejects(
    () => saveSkill(plugin, { slug: "x", name: "", description: "d", body: "" }),
    /name 不能为空/,
  );
  await assert.rejects(
    () => saveSkill(plugin, { slug: "Bad-Slug", name: "X", description: "d", body: "" }),
    /小写字母/,
  );
});

test("saveSkill clears agent-side skill cache so the next turn re-scans", async () => {
  const adapter = makeAdapter({});
  const plugin = makePlugin(adapter);
  plugin.__flownoteSkillCache = { foo: "stale" };
  await saveSkill(plugin, { slug: "x", name: "X", description: "d", body: "" });
  assert.equal(plugin.__flownoteSkillCache, null);
});

// ---------------------------------------------------------------------------
// deleteSkill
// ---------------------------------------------------------------------------

test("deleteSkill removes the folder + its contents", async () => {
  const adapter = makeAdapter({
    ".flownote/skills/x/SKILL.md": `---\nname: x\ndescription: d\n---\nbody`,
    ".flownote/skills/x/references/note.md": "ref content",
  });
  const plugin = makePlugin(adapter);
  const ok = await deleteSkill(plugin, "x");
  assert.equal(ok, true);
  assert.equal(adapter._files.has(".flownote/skills/x/SKILL.md"), false);
  assert.equal(adapter._files.has(".flownote/skills/x/references/note.md"), false);
});

test("deleteSkill returns false when the folder doesn't exist", async () => {
  const adapter = makeAdapter({});
  const plugin = makePlugin(adapter);
  const ok = await deleteSkill(plugin, "no-such-skill");
  assert.equal(ok, false);
});
