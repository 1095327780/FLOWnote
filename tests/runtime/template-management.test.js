const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

// We need the template-management module to read template-map.json from
// the embedded bundled-skills mirror. Stub the embedded module with a
// minimal fixture so tests don't depend on the live bundle.
const FIXTURE_TEMPLATE_MAP = JSON.stringify({
  version: 1,
  metaTemplatesDir: "Meta/模板",
  entries: [
    {
      id: "daily-note",
      metaSource: "每日笔记模板.md",
      fallback: "ah-note/assets/每日笔记模板.md",
      targets: ["ah-note/assets/每日笔记模板.md"],
    },
    {
      id: "project-note",
      metaSource: "项目模板.md",
      fallback: "ah-project/assets/项目模板.md",
      targets: ["ah-project/assets/项目模板.md"],
    },
  ],
});
const FIXTURE_BUNDLE = {
  "template-map.json": FIXTURE_TEMPLATE_MAP,
  "ah-note/assets/每日笔记模板.md": "# Daily\n\n## 今日聚焦\n- \n",
  "ah-project/assets/项目模板.md": "# Project\n\n## Goal\n",
};

const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const EMBEDDED_PATH = path.resolve(
  __dirname, "../../runtime/generated/bundled-skills-embedded",
);

Module._load = function patched(request, parent, ...rest) {
  if (parent && typeof parent.filename === "string") {
    const resolved = (() => {
      try { return Module._resolveFilename(request, parent); } catch { return null; }
    })();
    if (resolved && resolved.startsWith(EMBEDDED_PATH)) {
      return {
        EMBEDDED_BUNDLED_SKILLS_FILES: FIXTURE_BUNDLE,
        EMBEDDED_BUNDLED_SKILLS_VERSION: "fixture",
        EMBEDDED_BUNDLED_SKILLS_FILE_COUNT: Object.keys(FIXTURE_BUNDLE).length,
      };
    }
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const {
  listTemplates,
  readTemplate,
  saveTemplate,
  resetTemplate,
  readTemplateMap,
} = require("../../runtime/settings/template-management");

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
  };
}

function makePlugin(adapter) {
  return { app: { vault: { adapter } } };
}

test("readTemplateMap returns entries + metaTemplatesDir from embedded bundle", async () => {
  const plugin = makePlugin(makeAdapter({}));
  const { entries, metaTemplatesDir } = await readTemplateMap(plugin);
  assert.equal(metaTemplatesDir, "Meta/模板");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "daily-note");
});

test("listTemplates marks templates with no user copy as default", async () => {
  const plugin = makePlugin(makeAdapter({}));
  const out = await listTemplates(plugin);
  assert.equal(out.length, 2);
  for (const item of out) {
    assert.equal(item.hasUserCopy, false);
    assert.equal(item.isCustomized, false);
  }
});

test("listTemplates marks templates as customized when user copy differs", async () => {
  const adapter = makeAdapter({
    "Meta/模板/每日笔记模板.md": "# Daily\n\nUSER OVERRIDE\n",
  });
  const out = await listTemplates(makePlugin(adapter));
  const daily = out.find((t) => t.id === "daily-note");
  assert.equal(daily.hasUserCopy, true);
  assert.equal(daily.isCustomized, true);
});

test("listTemplates marks identical user copies as synced (not customized)", async () => {
  const adapter = makeAdapter({
    "Meta/模板/每日笔记模板.md": "# Daily\n\n## 今日聚焦\n- \n",
  });
  const out = await listTemplates(makePlugin(adapter));
  const daily = out.find((t) => t.id === "daily-note");
  assert.equal(daily.hasUserCopy, true);
  assert.equal(daily.isCustomized, false);
});

test("readTemplate prefers user copy over bundled fallback", async () => {
  const adapter = makeAdapter({
    "Meta/模板/每日笔记模板.md": "USER VERSION",
  });
  const r = await readTemplate(makePlugin(adapter), "daily-note");
  assert.equal(r.source, "user");
  assert.equal(r.content, "USER VERSION");
});

test("readTemplate falls back to bundled when no user copy exists", async () => {
  const r = await readTemplate(makePlugin(makeAdapter({})), "daily-note");
  assert.equal(r.source, "bundled");
  assert.match(r.content, /今日聚焦/);
});

test("readTemplate returns null for unknown template id", async () => {
  const r = await readTemplate(makePlugin(makeAdapter({})), "no-such");
  assert.equal(r, null);
});

test("saveTemplate writes to the resolved user path + creates the dir", async () => {
  const adapter = makeAdapter({});
  await saveTemplate(makePlugin(adapter), "daily-note", "## My version\n");
  assert.equal(adapter._files.get("Meta/模板/每日笔记模板.md"), "## My version\n");
  assert.ok(adapter._folders.has("Meta/模板"));
});

test("saveTemplate propagates content to every target path so the AI reads fresh content", async () => {
  const adapter = makeAdapter({});
  const plugin = { app: { vault: { adapter } }, settings: { skillsDir: ".flownote/skills" } };
  const r = await saveTemplate(plugin, "daily-note", "USER CONTENT\n");
  assert.equal(r.targetsWritten, 1);
  assert.equal(
    adapter._files.get(".flownote/skills/ah-note/assets/每日笔记模板.md"),
    "USER CONTENT\n",
  );
});

test("saveTemplate throws on unknown id", async () => {
  await assert.rejects(
    () => saveTemplate(makePlugin(makeAdapter({})), "no-such", "x"),
    /未知模板/,
  );
});

test("resetTemplate restores bundled content into the user copy", async () => {
  const adapter = makeAdapter({
    "Meta/模板/每日笔记模板.md": "USER VERSION",
  });
  const r = await resetTemplate(makePlugin(adapter), "daily-note");
  assert.equal(r.restored, true);
  assert.match(adapter._files.get("Meta/模板/每日笔记模板.md"), /今日聚焦/);
});

test("resetTemplate returns restored=false when no bundled fallback exists", async () => {
  // Override the fixture for this test: add an entry with no fallback content.
  FIXTURE_BUNDLE["template-map.json"] = JSON.stringify({
    version: 1,
    metaTemplatesDir: "Meta/模板",
    entries: [
      ...JSON.parse(FIXTURE_TEMPLATE_MAP).entries,
      { id: "orphan", metaSource: "孤儿.md", fallback: "missing/path.md", targets: [] },
    ],
  });
  // Re-require by clearing cache so the module re-reads template-map.json.
  delete require.cache[require.resolve("../../runtime/settings/template-management")];
  const tm = require("../../runtime/settings/template-management");

  const adapter = makeAdapter({ "Meta/模板/孤儿.md": "user content" });
  const r = await tm.resetTemplate(makePlugin(adapter), "orphan");
  assert.equal(r.restored, false);

  // Restore the fixture for any later tests in this file.
  FIXTURE_BUNDLE["template-map.json"] = FIXTURE_TEMPLATE_MAP;
});

test.after(() => {
  Module._load = originalLoad;
  Module._resolveFilename = originalResolve;
});
