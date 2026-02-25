const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBundledSkillsMethods } = require("../../runtime/plugin/bundled-skills-methods");
const { copyDirectoryRecursive } = require("../../runtime/skill-service");

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
  writeFile(path.join(bundledRoot, "resources", "templates-default", "示例模板.md"), "fallback-template\n");
  writeFile(path.join(bundledRoot, "resources", "templates-default", "示例模板.en.md"), "fallback-template-en\n");
  writeFile(path.join(bundledRoot, "template-map.json"), JSON.stringify({
    version: 1,
    metaTemplatesDir: "Meta/模板",
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
    assert.equal(fs.existsSync(templateFileEn), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("syncBundledTemplates should switch template filenames by locale and clean stale files", async () => {
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
    assert.equal(fs.existsSync(templateFileZh), false);
    assert.equal(fs.readFileSync(templateFileEn, "utf8"), "fallback-template-en\n");
    assert.equal(Number(enResult.cleanedStaleCount || 0) > 0, true);
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
    const metaEn = path.join(fixture.vaultPath, "Meta", "模板", "Sample-Template.md");
    assert.equal(fs.existsSync(metaZh), true);
    assert.equal(fs.existsSync(metaEn), false);

    const enReset = await fixture.plugin.resetMetaTemplateBaseline(fixture.vaultPath, {
      locale: "en",
      defaultConflictAction: "replace",
    });
    assert.equal(enReset.errors.length, 0);
    assert.equal(fs.existsSync(metaEn), true);
    assert.equal(fs.existsSync(metaZh), false);
    assert.equal(fs.readFileSync(metaEn, "utf8"), "fallback-template-en\n");
    assert.equal(Number(enReset.cleanedStaleCount || 0) > 0, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
