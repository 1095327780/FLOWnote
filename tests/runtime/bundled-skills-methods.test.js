const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBundledSkillsMethods } = require("../../runtime/plugin/bundled-skills-methods");
const { copyDirectoryRecursive } = require("../../runtime/skill-service");
const { walkFilesRecursive } = require("../../runtime/plugin/bundled-skills-utils");

const CORE_TEMPLATE_STEMS = [
  "ah-note/assets/每日笔记模板",
  "ah-week/references/周报模板",
  "ah-month/references/月报模板",
  "ah-year/references/年报模板",
  "ah-project/assets/项目模板",
  "ah-read/references/文献笔记模板",
  "ah-read/assets/进度模板",
  "ah-inbox/assets/永久笔记模板",
  "ah-init/references/HOME模板",
  "ah-init/references/主题笔记模板",
  "ah-init/references/领域页模板",
];

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flownote-bundled-content-"));
  const vaultPath = path.join(root, "vault");
  const pluginRoot = path.join(vaultPath, ".obsidian", "plugins", "flownote");
  fs.mkdirSync(pluginRoot, { recursive: true });
  writeFile(path.join(pluginRoot, "manifest.json"), "{}\n");

  const bundledRoot = path.join(pluginRoot, "bundled-skills");
  writeFile(path.join(bundledRoot, "ah-test", "SKILL.md"), "---\nname: ah-test\ndescription: test\n---\n\n# Test\n");
  writeFile(path.join(bundledRoot, "ah-test", "references", "guide.md"), "# Chinese Ref\n");
  writeFile(path.join(bundledRoot, "ah-test", "references", "guide.en.md"), "# English Ref\n");
  writeFile(path.join(bundledRoot, "ah-test", "references", "guide.ru.md"), "# Russian Ref\n");
  writeFile(path.join(bundledRoot, "resources", "templates-default", "示例模板.md"), "fallback-template\n");
  writeFile(path.join(bundledRoot, "resources", "templates-default", "示例模板.en.md"), "fallback-template-en\n");
  writeFile(path.join(bundledRoot, "resources", "templates-default", "示例模板.ru.md"), "fallback-template-ru\n");
  writeFile(path.join(bundledRoot, "template-map.json"), JSON.stringify({
    version: 1,
    metaTemplatesDir: "Meta/模板",
    metaTemplatesDirs: {
      "zh-CN": "Meta/模板",
      en: "Meta/Templates",
      ru: "Meta/Шаблоны",
    },
    entries: [
      {
        id: "sample-template",
        metaSource: "示例模板.md",
        fallback: "resources/templates-default/示例模板.md",
        targets: [
          "ah-test/assets/templates/示例模板.md",
        ],
        locales: {
          en: {
            metaSource: "Sample-Template.md",
            targets: [
              "ah-test/assets/templates/Sample-Template.md",
            ],
          },
          ru: {
            metaSource: "Sample-Template.ru.md",
            targets: [
              "ah-test/assets/templates/Sample-Template.ru.md",
            ],
          },
        },
      },
    ],
  }, null, 2));

  const plugin = {
    app: { vault: { configDir: ".obsidian" } },
    manifest: {
      id: "flownote",
      dir: pluginRoot,
      version: "9.9.9",
    },
    settings: { skillsDir: ".opencode/skills" },
    runtimeState: {},
    getVaultPath: () => vaultPath,
    ensureRuntimeModules: () => ({ copyDirectoryRecursive }),
  };
  Object.assign(plugin, createBundledSkillsMethods({ pluginDirname: pluginRoot }));

  return { root, vaultPath, pluginRoot, plugin, bundledRoot };
}

test("core bundled templates should include zh base, English, and Russian variants", () => {
  const bundledRoot = path.join(__dirname, "../../bundled-skills");
  for (const stem of CORE_TEMPLATE_STEMS) {
    assert.equal(fs.existsSync(path.join(bundledRoot, `${stem}.md`)), true, `${stem}.md`);
    assert.equal(fs.existsSync(path.join(bundledRoot, `${stem}.en.md`)), true, `${stem}.en.md`);
    assert.equal(fs.existsSync(path.join(bundledRoot, `${stem}.ru.md`)), true, `${stem}.ru.md`);
  }
});

test("real bundled skills install a complete localized resource graph", async () => {
  const bundledRoot = path.join(__dirname, "../../bundled-skills");
  for (const [locale, dailyMarker] of [
    ["en", "Today's Most Important Thing"],
    ["ru", "Главное сегодня"],
  ]) {
    const fixture = createFixture();
    try {
      fixture.plugin.getBundledSkillsRoot = () => bundledRoot;
      const bundledIds = fixture.plugin.listBundledSkillIds(bundledRoot);
      const result = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
        force: true,
        locale,
        syncTemplates: true,
        defaultConflictAction: "replace",
      });

      assert.deepEqual(result.errors, [], `${locale} install errors`);
      assert.equal(result.synced, bundledIds.length, `${locale} installed skill count`);
      assert.equal(result.stampUpdated, true, `${locale} install stamp`);

      const targetRoot = path.join(fixture.vaultPath, ".opencode", "skills");
      const localeVariants = bundledIds.flatMap((skillId) =>
        walkFilesRecursive(path.join(targetRoot, skillId))
          .filter((relPath) => /\.(?:zh-CN|en|ru)\.md$/.test(relPath))
          .map((relPath) => `${skillId}/${relPath}`));
      assert.deepEqual(localeVariants, [], `${locale} must not expose locale sidecars`);

      const templateMap = fixture.plugin.loadBundledTemplateMap(bundledRoot);
      for (const entry of templateMap.entries) {
        const localized = fixture.plugin.resolveTemplateEntryByLocale(entry, locale);
        const targetContents = localized.targets.map((relPath) =>
          fs.readFileSync(path.join(targetRoot, relPath), "utf8"));
        assert.equal(targetContents.length >= 1, true, `${entry.id} (${locale}) target count`);
        assert.equal(
          targetContents.every((content) => content === targetContents[0]),
          true,
          `${entry.id} (${locale}) canonical target and aliases must match`,
        );
      }

      const dailyTemplate = fs.readFileSync(
        path.join(targetRoot, "ah-note", "assets", "每日笔记模板.md"),
        "utf8",
      );
      assert.match(dailyTemplate, new RegExp(dailyMarker), `${locale} daily template`);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("syncBundledContent should install bundled skill and fallback template", async () => {
  const fixture = createFixture();
  try {
    const result = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
      defaultConflictAction: "skip",
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.synced, 1);
    assert.equal(result.total, 1);
    assert.equal(result.syncedTemplates, 1);
    assert.equal(result.totalTemplates, 1);

    const skillFile = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "SKILL.md");
    const templateFile = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "templates", "示例模板.md");
    assert.equal(fs.existsSync(skillFile), true);
    assert.equal(fs.existsSync(templateFile), true);
    assert.equal(fs.readFileSync(templateFile, "utf8"), "fallback-template\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should prefer Meta template over fallback", async () => {
  const fixture = createFixture();
  try {
    writeFile(path.join(fixture.vaultPath, "Meta", "模板", "示例模板.md"), "meta-template\n");

    const result = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
      defaultConflictAction: "skip",
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.syncedTemplates, 1);

    const templateFile = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "templates", "示例模板.md");
    assert.equal(fs.readFileSync(templateFile, "utf8"), "meta-template\n");
    assert.deepEqual(result.templates.fallbackUsed, []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should allow skip/replace conflicts for templates", async () => {
  const fixture = createFixture();
  try {
    await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
      defaultConflictAction: "skip",
    });

    const templateFile = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "templates", "示例模板.md");
    writeFile(templateFile, "custom-template\n");

    const skipped = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
      resolveConflict: async () => "skip",
      defaultConflictAction: "skip",
    });
    assert.equal(fs.readFileSync(templateFile, "utf8"), "custom-template\n");
    assert.equal(skipped.templates.skippedCount > 0, true);

    const replaced = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
      resolveConflict: async (conflict) => (conflict.kind === "skill" ? "skip" : "replace"),
      defaultConflictAction: "skip",
      backupDir: ".opencode/test-backups",
    });
    assert.equal(fs.readFileSync(templateFile, "utf8"), "fallback-template\n");
    assert.equal(replaced.templates.replacedCount > 0, true);
    assert.equal(Boolean(replaced.templates.backupRoot), true);
    assert.equal(fs.existsSync(replaced.templates.backupRoot), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should install locale-specific SKILL.md and switch on locale change", async () => {
  const fixture = createFixture();
  try {
    writeFile(path.join(fixture.bundledRoot, "ah-test", "SKILL.zh-CN.md"), "---\nname: ah-test\ndescription: 中文\n---\n\n# 中文版\n");
    writeFile(path.join(fixture.bundledRoot, "ah-test", "SKILL.en.md"), "---\nname: ah-test\ndescription: English\n---\n\n# English\n");

    const first = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "skip",
    });
    assert.equal(first.errors.length, 0);
    const installedSkill = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "SKILL.md");
    assert.equal(fs.readFileSync(installedSkill, "utf8").includes("# English"), true);
    assert.equal(String(first.stamp || "").includes("locale=en"), true);
    assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "SKILL.en.md")), false);
    assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "SKILL.zh-CN.md")), false);

    const second = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: false,
      locale: "zh-CN",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });
    assert.equal(second.errors.length, 0);
    assert.equal(second.synced, 1);
    assert.equal(fs.readFileSync(installedSkill, "utf8").includes("# 中文版"), true);
    assert.equal(String(second.stamp || "").includes("locale=zh-CN"), true);
    assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "SKILL.en.md")), false);
    assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "SKILL.zh-CN.md")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should preserve existing skills and templates with default skip behavior", async () => {
  const fixture = createFixture();
  try {
    await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
      defaultConflictAction: "replace",
    });

    const skillFile = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "SKILL.md");
    const templateFile = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "templates", "示例模板.md");
    writeFile(skillFile, "custom skill\n");
    writeFile(templateFile, "custom template\n");

    const result = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.skills.skippedCount, 1);
    assert.equal(result.templates.skippedCount, 1);
    assert.equal(fs.readFileSync(skillFile, "utf8"), "custom skill\n");
    assert.equal(fs.readFileSync(templateFile, "utf8"), "custom template\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should not stamp a locale that was skipped", async () => {
  const fixture = createFixture();
  try {
    const installed = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });
    assert.equal(installed.stampUpdated, true);
    const zhStamp = fixture.plugin.runtimeState.bundledSkillsStamp;

    const skipped = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: false,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "skip",
    });
    assert.equal(skipped.skills.skippedCount, 1);
    assert.equal(skipped.stampUpdated, false);
    assert.equal(fixture.plugin.runtimeState.bundledSkillsStamp, zhStamp);

    const retried = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: false,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "skip",
    });
    assert.equal(retried.skills.skipped, false, "an unapplied locale must be attempted again");
    assert.equal(retried.skills.skippedCount, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should update existing bundled skill in place", async () => {
  const fixture = createFixture();
  try {
    const first = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });
    assert.equal(first.errors.length, 0);

    const skillDir = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test");
    const skillFile = path.join(skillDir, "SKILL.md");
    const userSidecar = path.join(skillDir, "user-sidecar.md");
    writeFile(userSidecar, "user note\n");
    writeFile(path.join(fixture.bundledRoot, "ah-test", "SKILL.md"), "---\nname: ah-test\ndescription: updated\n---\n\n# Updated\n");

    const second = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });
    assert.equal(second.errors.length, 0);
    assert.equal(second.skills.replacedCount, 1);
    assert.equal(fs.readFileSync(skillFile, "utf8").includes("# Updated"), true);
    assert.equal(fs.readFileSync(userSidecar, "utf8"), "user note\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should localize references to canonical path by locale", async () => {
  const fixture = createFixture();
  try {
    const enResult = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "skip",
    });
    assert.equal(enResult.errors.length, 0);
    const refFile = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "references", "guide.md");
    assert.equal(fs.readFileSync(refFile, "utf8"), "# English Ref\n");
    assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "references", "guide.en.md")), false);
    assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "references", "guide.zh-CN.md")), false);

    const zhResult = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });
    assert.equal(zhResult.errors.length, 0);
    assert.equal(fs.readFileSync(refFile, "utf8"), "# Chinese Ref\n");
    assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "references", "guide.en.md")), false);
    assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "references", "guide.zh-CN.md")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should localize assets/ templates to canonical path by locale", async () => {
  // Regression for issue #10: localized templates live directly under a skill's
  // assets/ (e.g. ah-note/assets/每日笔记模板.{md,en,ru}.md), NOT under assets/templates/.
  // applyBundledSkillLocaleResources must localize them onto the canonical base
  // before removeLocalizedMarkdownVariants deletes the locale-suffixed copies, or
  // the daily-note consumer falls through to the Chinese base regardless of locale.
  const fixture = createFixture();
  try {
    writeFile(path.join(fixture.bundledRoot, "ah-test", "assets", "每日笔记模板.md"), "# 中文模板\n");
    writeFile(path.join(fixture.bundledRoot, "ah-test", "assets", "每日笔记模板.en.md"), "# English Template\n");
    writeFile(path.join(fixture.bundledRoot, "ah-test", "assets", "每日笔记模板.ru.md"), "# Russian Template\n");

    const canonicalTemplate = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "每日笔记模板.md");
    const enVariant = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "每日笔记模板.en.md");
    const ruVariant = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "每日笔记模板.ru.md");

    const enResult = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "skip",
    });
    assert.equal(enResult.errors.length, 0);
    assert.equal(fs.readFileSync(canonicalTemplate, "utf8"), "# English Template\n");
    assert.equal(fs.existsSync(enVariant), false);
    assert.equal(fs.existsSync(ruVariant), false);

    const ruResult = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "ru",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });
    assert.equal(ruResult.errors.length, 0);
    assert.equal(fs.readFileSync(canonicalTemplate, "utf8"), "# Russian Template\n");
    assert.equal(fs.existsSync(enVariant), false);
    assert.equal(fs.existsSync(ruVariant), false);

    const zhResult = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });
    assert.equal(zhResult.errors.length, 0);
    assert.equal(fs.readFileSync(canonicalTemplate, "utf8"), "# 中文模板\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should localize bundled markdown in any resource directory", async () => {
  const fixture = createFixture();
  try {
    writeFile(path.join(fixture.bundledRoot, "ah-test", "playbooks", "guide.md"), "# 中文指南\n");
    writeFile(path.join(fixture.bundledRoot, "ah-test", "playbooks", "guide.en.md"), "# English Guide\n");
    writeFile(path.join(fixture.bundledRoot, "ah-test", "playbooks", "guide.ru.md"), "# Russian Guide\n");

    const result = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });

    assert.equal(result.errors.length, 0);
    const installedGuide = path.join(
      fixture.vaultPath,
      ".opencode",
      "skills",
      "ah-test",
      "playbooks",
      "guide.md",
    );
    assert.equal(fs.readFileSync(installedGuide, "utf8"), "# English Guide\n");
    assert.equal(fs.existsSync(installedGuide.replace(/\.md$/, ".en.md")), false);
    assert.equal(fs.existsSync(installedGuide.replace(/\.md$/, ".ru.md")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should only remove locale variants managed by the bundle", async () => {
  const fixture = createFixture();
  try {
    await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });

    const userSidecar = path.join(
      fixture.vaultPath,
      ".opencode",
      "skills",
      "ah-test",
      "notes",
      "user-sidecar.en.md",
    );
    writeFile(userSidecar, "user-owned locale note\n");

    const result = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "ru",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });

    assert.equal(result.errors.length, 0);
    assert.equal(fs.readFileSync(userSidecar, "utf8"), "user-owned locale note\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should publish from staging and preserve the last good install on failure", async () => {
  const fixture = createFixture();
  try {
    const first = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });
    assert.equal(first.errors.length, 0);
    const installedSkill = path.join(
      fixture.vaultPath,
      ".opencode",
      "skills",
      "ah-test",
      "SKILL.md",
    );
    const lastGoodContent = fs.readFileSync(installedSkill, "utf8");
    const lastGoodStamp = fixture.plugin.runtimeState.bundledSkillsStamp;

    fixture.plugin.ensureRuntimeModules = () => ({
      copyDirectoryRecursive(_srcDir, stageDir) {
        writeFile(path.join(stageDir, "SKILL.md"), "partial install\n");
        throw new Error("injected copy failure");
      },
    });
    const failed = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });

    assert.match(failed.errors.join("\n"), /injected copy failure/);
    assert.equal(failed.stampUpdated, false);
    assert.equal(fixture.plugin.runtimeState.bundledSkillsStamp, lastGoodStamp);
    assert.equal(fs.readFileSync(installedSkill, "utf8"), lastGoodContent);
    const targetRoot = path.dirname(path.dirname(installedSkill));
    assert.deepEqual(
      fs.readdirSync(targetRoot).filter((name) => name.startsWith(".flownote-stage-")),
      [],
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledContent should remove stale bundle-owned files but preserve user sidecars", async () => {
  const fixture = createFixture();
  try {
    const oldBundledFile = path.join(fixture.bundledRoot, "ah-test", "references", "old-guide.md");
    writeFile(oldBundledFile, "old bundled guide\n");
    await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });

    const skillDir = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test");
    const installedOldFile = path.join(skillDir, "references", "old-guide.md");
    const userSidecar = path.join(skillDir, "references", "my-notes.md");
    assert.equal(fs.existsSync(installedOldFile), true);
    writeFile(userSidecar, "keep me\n");
    fs.rmSync(oldBundledFile);

    const updated = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "en",
      syncTemplates: false,
      defaultConflictAction: "replace",
    });
    assert.equal(updated.errors.length, 0);
    assert.equal(fs.existsSync(installedOldFile), false);
    assert.equal(fs.readFileSync(userSidecar, "utf8"), "keep me\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("bundled template registry should keep runtime targets stable across locales", () => {
  const templateMap = require("../../bundled-skills/template-map.json");
  for (const entry of templateMap.entries) {
    for (const [locale, variant] of Object.entries(entry.locales || {})) {
      const targets = Array.isArray(variant.targets) && variant.targets.length
        ? variant.targets
        : entry.targets;
      assert.deepEqual(
        targets.slice(0, entry.targets.length),
        entry.targets,
        `${entry.id} (${locale}) must write canonical targets before compatibility aliases`,
      );
    }
  }
});

test("syncBundledContent should use Russian resources and templates without requiring Russian SKILL.md", async () => {
  const fixture = createFixture();
  try {
    writeFile(path.join(fixture.bundledRoot, "ah-test", "SKILL.en.md"), "---\nname: ah-test\ndescription: English\n---\n\n# English\n");

    const result = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "ru",
      syncTemplates: true,
      defaultConflictAction: "skip",
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.locale, "ru");

    const installedSkill = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "SKILL.md");
    const refFile = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "references", "guide.md");
    const templateFile = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "templates", "Sample-Template.ru.md");

    assert.equal(fs.readFileSync(installedSkill, "utf8").includes("# English"), true);
    assert.equal(fs.readFileSync(refFile, "utf8"), "# Russian Ref\n");
    assert.equal(fs.existsSync(path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "references", "guide.ru.md")), false);
    assert.equal(fs.readFileSync(templateFile, "utf8"), "fallback-template-ru\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledTemplates should prefer en fallback before base meta and keep zh base meta priority", async () => {
  const fixture = createFixture();
  try {
    writeFile(path.join(fixture.vaultPath, "Meta", "模板", "示例模板.md"), "meta-template-base\n");

    const enResult = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "en",
      syncTemplates: true,
      defaultConflictAction: "skip",
    });
    assert.equal(enResult.errors.length, 0);
    const templateFileEn = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "templates", "Sample-Template.md");
    assert.equal(fs.readFileSync(templateFileEn, "utf8"), "fallback-template-en\n");

    const zhResult = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
      defaultConflictAction: "replace",
    });
    assert.equal(zhResult.errors.length, 0);
    const templateFileZh = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "templates", "示例模板.md");
    assert.equal(fs.readFileSync(templateFileZh, "utf8"), "meta-template-base\n");
    assert.equal(fs.existsSync(templateFileEn), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledTemplates should keep stale locale files by default and clean only when requested", async () => {
  const fixture = createFixture();
  try {
    const zhResult = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
      defaultConflictAction: "replace",
    });
    assert.equal(zhResult.errors.length, 0);

    const templateFileZh = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "templates", "示例模板.md");
    const templateFileEn = path.join(fixture.vaultPath, ".opencode", "skills", "ah-test", "assets", "templates", "Sample-Template.md");
    assert.equal(fs.existsSync(templateFileZh), true);
    assert.equal(fs.existsSync(templateFileEn), false);

    const enResult = await fixture.plugin.syncBundledTemplates(fixture.vaultPath, {
      locale: "en",
      defaultConflictAction: "replace",
    });
    assert.equal(enResult.errors.length, 0);
    assert.equal(fs.existsSync(templateFileEn), true);
    assert.equal(fs.existsSync(templateFileZh), true);
    assert.equal(fs.readFileSync(templateFileEn, "utf8"), "fallback-template-en\n");
    assert.equal(Number(enResult.cleanedStaleCount || 0), 0);

    const cleanResult = await fixture.plugin.syncBundledTemplates(fixture.vaultPath, {
      locale: "en",
      defaultConflictAction: "replace",
      cleanStale: true,
    });
    assert.equal(cleanResult.errors.length, 0);
    assert.equal(fs.existsSync(templateFileZh), false);
    assert.equal(Number(cleanResult.cleanedStaleCount || 0) > 0, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledTemplates should render path variables before installing templates", async () => {
  const fixture = createFixture();
  try {
    writeFile(
      path.join(fixture.bundledRoot, "resources", "templates-default", "示例模板.md"),
      "Daily={{notePaths.dailyNotes}} Memory={{metaPaths.memory}} Skills={{skillsDir}}\n",
    );
    fixture.plugin.settings.notePaths = { dailyNotes: "Custom/Daily" };
    fixture.plugin.settings.metaPaths = { metaRoot: "Custom" };
    fixture.plugin.settings.skillsDir = ".custom/skills";

    const result = await fixture.plugin.syncBundledContent(fixture.vaultPath, {
      force: true,
      locale: "zh-CN",
      syncTemplates: true,
      defaultConflictAction: "replace",
    });
    assert.equal(result.errors.length, 0);

    const templateFile = path.join(fixture.vaultPath, ".custom", "skills", "ah-test", "assets", "templates", "示例模板.md");
    assert.equal(
      fs.readFileSync(templateFile, "utf8"),
      "Daily=Custom/Daily Memory=Custom/ai-memory Skills=.custom/skills\n",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resetMetaTemplateBaseline should switch Meta template filename by locale", async () => {
  const fixture = createFixture();
  try {
    const zhReset = await fixture.plugin.resetMetaTemplateBaseline(fixture.vaultPath, {
      locale: "zh-CN",
      defaultConflictAction: "replace",
    });
    assert.equal(zhReset.errors.length, 0);

    const metaZh = path.join(fixture.vaultPath, "Meta", "模板", "示例模板.md");
    const metaEn = path.join(fixture.vaultPath, "Meta", "Templates", "Sample-Template.md");
    assert.equal(fs.existsSync(metaZh), true);
    assert.equal(fs.existsSync(metaEn), false);

    const enReset = await fixture.plugin.resetMetaTemplateBaseline(fixture.vaultPath, {
      locale: "en",
      defaultConflictAction: "replace",
    });
    assert.equal(enReset.errors.length, 0);
    assert.equal(fs.existsSync(metaEn), true);
    assert.equal(fs.existsSync(metaZh), true);
    assert.equal(fs.readFileSync(metaEn, "utf8"), "fallback-template-en\n");
    assert.equal(Number(enReset.cleanedStaleCount || 0), 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
