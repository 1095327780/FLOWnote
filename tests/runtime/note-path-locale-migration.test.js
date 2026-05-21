const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_NOTE_PATHS_ZH,
  DEFAULT_NOTE_PATHS_EN,
} = require("../../runtime/settings-utils");
const {
  planNotePathLocaleMigration,
  planMetaPathLocaleMigration,
  applyNotePathLocaleMigration,
  applyMetaPathLocaleMigration,
  mergeMigrationResults,
  summarizeNotePathMigrationResult,
} = require("../../runtime/note-path-locale-migration");

function makeFolder(path, children = []) {
  return { path, children };
}

function makeApp(initial = {}) {
  const entries = new Map();
  for (const [path, value] of Object.entries(initial)) {
    entries.set(path, value && typeof value === "object" ? value : makeFolder(path));
  }
  const app = {
    vault: {
      getAbstractFileByPath(path) {
        return entries.get(path) || null;
      },
      async createFolder(path) {
        if (!entries.has(path)) entries.set(path, makeFolder(path));
      },
    },
    fileManager: {
      async renameFile(file, targetPath) {
        entries.delete(file.path);
        file.path = targetPath;
        entries.set(targetPath, file);
      },
    },
    entries,
  };
  return app;
}

test("planNotePathLocaleMigration only includes paths still at locale defaults", () => {
  const settings = {
    notePaths: {
      ...DEFAULT_NOTE_PATHS_ZH,
      activeProjects: "Custom/Projects",
    },
  };
  const plan = planNotePathLocaleMigration(settings, "zh-CN", "en");

  assert.equal(plan.count, Object.keys(DEFAULT_NOTE_PATHS_ZH).length - 1);
  assert.equal(plan.items.some((item) => item.key === "activeProjects"), false);
  assert.deepEqual(plan.skippedCustomPath.map((item) => item.key), ["activeProjects"]);
});

test("planNotePathLocaleMigration is a no-op when locale does not change", () => {
  const plan = planNotePathLocaleMigration({ notePaths: DEFAULT_NOTE_PATHS_ZH }, "zh-CN", "zh-CN");
  assert.equal(plan.count, 0);
  assert.deepEqual(plan.items, []);
});

test("applyNotePathLocaleMigration renames default folders and updates note paths", async () => {
  const app = makeApp({
    "01-捕获层/每日笔记": makeFolder("01-捕获层/每日笔记", [{ path: "01-捕获层/每日笔记/2026-05-20.md" }]),
  });
  const settings = {
    notePaths: { ...DEFAULT_NOTE_PATHS_ZH },
    mobileCapture: { dailyNotePath: DEFAULT_NOTE_PATHS_ZH.dailyNotes, ideaSectionHeader: "## 记录" },
  };
  const plan = {
    fromLocale: "zh-CN",
    toLocale: "en",
    items: [{ key: "dailyNotes", source: DEFAULT_NOTE_PATHS_ZH.dailyNotes, target: DEFAULT_NOTE_PATHS_EN.dailyNotes }],
    skippedCustomPath: [],
  };

  const result = await applyNotePathLocaleMigration(app, settings, plan);

  assert.equal(app.entries.has("01-Capture"), true);
  assert.equal(app.entries.has("01-Capture/Daily Notes"), true);
  assert.equal(app.entries.has("01-捕获层/每日笔记"), false);
  assert.equal(settings.notePaths.dailyNotes, DEFAULT_NOTE_PATHS_EN.dailyNotes);
  assert.equal(settings.mobileCapture.dailyNotePath, DEFAULT_NOTE_PATHS_EN.dailyNotes);
  assert.equal(settings.mobileCapture.ideaSectionHeader, "## Records");
  assert.equal(result.migrated.length, 1);
});

test("applyNotePathLocaleMigration updates missing default sources without moving files", async () => {
  const app = makeApp({});
  const settings = {
    notePaths: { ...DEFAULT_NOTE_PATHS_ZH },
    mobileCapture: { dailyNotePath: DEFAULT_NOTE_PATHS_ZH.dailyNotes },
  };
  const plan = {
    fromLocale: "zh-CN",
    toLocale: "en",
    items: [{ key: "dailyNotes", source: DEFAULT_NOTE_PATHS_ZH.dailyNotes, target: DEFAULT_NOTE_PATHS_EN.dailyNotes }],
    skippedCustomPath: [],
  };

  const result = await applyNotePathLocaleMigration(app, settings, plan);

  assert.equal(settings.notePaths.dailyNotes, DEFAULT_NOTE_PATHS_EN.dailyNotes);
  assert.equal(settings.mobileCapture.dailyNotePath, DEFAULT_NOTE_PATHS_EN.dailyNotes);
  assert.deepEqual(result.skippedMissingSource.map((item) => item.key), ["dailyNotes"]);
  assert.equal(result.migrated.length, 0);
});

test("applyNotePathLocaleMigration does not overwrite existing target folders", async () => {
  const app = makeApp({
    "01-捕获层/每日笔记": makeFolder("01-捕获层/每日笔记", [{ path: "old.md" }]),
    "01-Capture/Daily Notes": makeFolder("01-Capture/Daily Notes", [{ path: "new.md" }]),
  });
  const settings = { notePaths: { ...DEFAULT_NOTE_PATHS_ZH } };
  const plan = {
    fromLocale: "zh-CN",
    toLocale: "en",
    items: [{ key: "dailyNotes", source: DEFAULT_NOTE_PATHS_ZH.dailyNotes, target: DEFAULT_NOTE_PATHS_EN.dailyNotes }],
    skippedCustomPath: [],
  };

  const result = await applyNotePathLocaleMigration(app, settings, plan);

  assert.equal(app.entries.has("01-捕获层/每日笔记"), true);
  assert.equal(app.entries.has("01-Capture/Daily Notes"), true);
  assert.equal(settings.notePaths.dailyNotes, DEFAULT_NOTE_PATHS_ZH.dailyNotes);
  assert.deepEqual(result.skippedTargetExists.map((item) => item.key), ["dailyNotes"]);
});

test("planMetaPathLocaleMigration includes default Meta system folders", () => {
  const plan = planMetaPathLocaleMigration("zh-CN", "en");
  assert.equal(plan.items.some((item) => item.source === "Meta/模板" && item.target === "Meta/Templates"), true);
  assert.equal(plan.items.some((item) => item.source === "Meta/索引" && item.target === "Meta/Indexes"), true);
});

test("planMetaPathLocaleMigration keeps a custom Meta root and migrates derived children", () => {
  const plan = planMetaPathLocaleMigration({
    metaPaths: { metaRoot: "System" },
  }, "zh-CN", "en");

  assert.equal(plan.items.some((item) => item.source === "System/模板" && item.target === "System/Templates"), true);
  assert.equal(plan.items.some((item) => item.source === "System/索引" && item.target === "System/Indexes"), true);
  assert.equal(plan.items.some((item) => item.key === "metaRoot"), false);
});

test("applyMetaPathLocaleMigration renames Meta folders without touching targets that exist", async () => {
  const app = makeApp({
    "Meta/模板": makeFolder("Meta/模板", [{ path: "Meta/模板/每日笔记模板.md" }]),
    "Meta/索引": makeFolder("Meta/索引", [{ path: "Meta/索引/kb-manifest.md" }]),
    "Meta/Indexes": makeFolder("Meta/Indexes", [{ path: "Meta/Indexes/kb-manifest.md" }]),
  });
  const plan = {
    fromLocale: "zh-CN",
    toLocale: "en",
    items: [
      { key: "templates", source: "Meta/模板", target: "Meta/Templates" },
      { key: "indexes", source: "Meta/索引", target: "Meta/Indexes" },
    ],
  };

  const result = await applyMetaPathLocaleMigration(app, plan);

  assert.equal(app.entries.has("Meta/Templates"), true);
  assert.equal(app.entries.has("Meta/模板"), false);
  assert.equal(app.entries.has("Meta/索引"), true);
  assert.equal(app.entries.has("Meta/Indexes"), true);
  assert.deepEqual(result.migrated.map((item) => item.key), ["templates"]);
  assert.deepEqual(result.skippedTargetExists.map((item) => item.key), ["indexes"]);
});

test("mergeMigrationResults combines note and Meta migration summaries", () => {
  const merged = mergeMigrationResults(
    { migrated: [{ key: "dailyNotes" }], skippedMissingSource: [], skippedTargetExists: [], skippedCustomPath: [], errors: [] },
    { migrated: [{ key: "templates" }], skippedMissingSource: [{ key: "indexes" }], skippedTargetExists: [], skippedCustomPath: [], errors: [] },
  );
  assert.deepEqual(summarizeNotePathMigrationResult(merged), {
    migrated: 2,
    skippedMissingSource: 1,
    skippedTargetExists: 0,
    skippedCustomPath: 0,
    errors: 0,
  });
});

test("summarizeNotePathMigrationResult returns counts for UI notices", () => {
  const summary = summarizeNotePathMigrationResult({
    migrated: [{}],
    skippedMissingSource: [{}, {}],
    skippedTargetExists: [],
    skippedCustomPath: [{}],
    errors: [{}],
  });
  assert.deepEqual(summary, {
    migrated: 1,
    skippedMissingSource: 2,
    skippedTargetExists: 0,
    skippedCustomPath: 1,
    errors: 1,
  });
});
