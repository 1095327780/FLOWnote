#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const {
  assertBundledSkillFileParity,
  assertBundledSkillReferences,
  collectBundledSkillFileMap,
  compareBundledSkillFileMaps,
} = require("./check-bundled-skill-references.js");

function createObsidianMock() {
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this._commands = [];
      this._views = [];
      this._tabs = [];
    }
    addCommand(command) { this._commands.push(command); }
    addRibbonIcon() {}
    addSettingTab(tab) { this._tabs.push(tab); }
    registerView(type, factory) { this._views.push({ type, factory }); }
    async loadData() { return {}; }
    async saveData() {}
  }
  class Notice {}
  class Modal {}
  class PluginSettingTab {}
  class Setting {}
  return {
    Plugin,
    Notice,
    Modal,
    PluginSettingTab,
    Setting,
    Platform: { isMobile: true },
    normalizePath(value) { return String(value || ""); },
    requestUrl: async () => ({ status: 500, text: "", json: null }),
  };
}

function loadReleasePlugin(releaseMainPath, { simulateMobileProcess = false } = {}) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return createObsidianMock();
    // Obsidian mobile may expose a compatibility object for Node's process
    // module without process.env. The release bundle must remain functional in
    // that exact environment instead of silently classifying every Skill YAML
    // document as invalid frontmatter.
    if (simulateMobileProcess && request === "process") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[releaseMainPath];
  try {
    return {
      PluginClass: require(releaseMainPath),
      restore() {
        Module._load = originalLoad;
        delete require.cache[releaseMainPath];
      },
    };
  } catch (error) {
    Module._load = originalLoad;
    delete require.cache[releaseMainPath];
    throw error;
  }
}

function loadEmbeddedSkillFiles(modulePath) {
  const resolved = path.resolve(modulePath);
  delete require.cache[resolved];
  const loaded = require(resolved);
  const files = loaded && loaded.EMBEDDED_BUNDLED_SKILLS_FILES;
  assert.ok(files && typeof files === "object" && !Array.isArray(files), "generated embedded Skill map is missing");
  const declaredCount = Number(loaded.EMBEDDED_BUNDLED_SKILLS_FILE_COUNT);
  assert.equal(declaredCount, Object.keys(files).length, "generated embedded Skill file count is stale");
  return files;
}

function skillSlugsFromFiles(fileMap) {
  return [...new Set(Object.keys(fileMap || {})
    .filter((relativePath) => /^([^/]+)\/SKILL\.md$/.test(relativePath))
    .map((relativePath) => relativePath.split("/")[0]))]
    .sort((left, right) => left.localeCompare(right));
}

function assertParity(result, label) {
  if (result.missing.length || result.extra.length || result.mismatched.length || result.invalidEmbeddedPaths.length) {
    const lines = [];
    if (result.missing.length) lines.push(`missing=${result.missing.join(",")}`);
    if (result.extra.length) lines.push(`extra=${result.extra.join(",")}`);
    if (result.mismatched.length) lines.push(`changed=${result.mismatched.join(",")}`);
    if (result.invalidEmbeddedPaths.length) lines.push(`unsafe=${result.invalidEmbeddedPaths.join(",")}`);
    throw new Error(`${label} mismatch: ${lines.join(" ")}`);
  }
}

async function inspectReleaseBundle({
  releaseDir = path.join(process.cwd(), "release"),
  bundledRoot = path.join(path.resolve(releaseDir), "..", "bundled-skills"),
  embeddedModulePath = path.join(path.resolve(releaseDir), "..", "runtime", "generated", "bundled-skills-embedded.js"),
} = {}) {
  const resolvedReleaseDir = path.resolve(releaseDir);
  const releaseMainPath = path.join(resolvedReleaseDir, "main.js");
  assert.equal(fs.existsSync(releaseMainPath), true, `missing release bundle: ${releaseMainPath}`);

  const sourceRoot = path.resolve(bundledRoot);
  const sourceFiles = collectBundledSkillFileMap(sourceRoot);
  const embeddedFiles = loadEmbeddedSkillFiles(embeddedModulePath);
  const parity = compareBundledSkillFileMaps(sourceFiles, embeddedFiles);
  assertParity(parity, "source bundled-skills vs generated embedded map");
  assertBundledSkillFileParity(sourceRoot, embeddedFiles);
  assertBundledSkillReferences(sourceRoot, { embeddedFiles });
  const expectedMobileSkillSlugs = skillSlugsFromFiles(embeddedFiles);
  assert.ok(expectedMobileSkillSlugs.length > 0, "embedded map contains no canonical SKILL.md files");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flownote-release-bundle-"));
  const pluginDir = path.join(root, ".obsidian", "plugins", "flownote");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), "{}\n", "utf8");
  let fixture = null;

  try {
    fixture = loadReleasePlugin(releaseMainPath, { simulateMobileProcess: true });
    const { PluginClass } = fixture;
    assert.equal(typeof PluginClass, "function", "release/main.js must export the plugin class");
    const plugin = new PluginClass({
      vault: {
        configDir: ".obsidian",
        adapter: { basePath: root },
      },
      workspace: {},
    }, {
      id: "flownote",
      dir: pluginDir,
      version: "smoke",
    });
    plugin.settings = { skillsDir: ".flownote/skills" };

    // Desktop/offline path: the bundle must materialize every publishable
    // resource, not just a few historically important templates.
    plugin.ensureFacadeMethodsLoaded();
    const embeddedRoot = plugin.getBundledSkillsRoot();
    const materializedFiles = collectBundledSkillFileMap(embeddedRoot);
    const materializedParity = compareBundledSkillFileMaps(sourceFiles, materializedFiles);
    assertParity(materializedParity, "release materialized embedded Skill mirror");

    // Mobile path: only the release bundle is available; every canonical
    // bundled SKILL.md must be discoverable before a vault scan completes.
    plugin.ensureMobileMethodsLoaded();
    plugin.ensureRuntimeModules = () => ({
      SessionStore: class { recoverInterruptedExecutions() { return 0; } },
      FLOWnoteAssistantView: class {},
      FLOWnoteSettingsTab: class {},
    });
    plugin.getEffectiveLocale = () => "en";
    plugin.getViewType = () => "flownote-view";
    plugin.persistState = async () => {};
    await plugin.bootstrapMobileFullRuntime();
    const mobileSkillSlugs = Array.isArray(plugin.__flownoteMobileSkillList)
      ? plugin.__flownoteMobileSkillList
        .map((entry) => entry && entry.slug)
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
      : [];
    assert.deepEqual(mobileSkillSlugs, expectedMobileSkillSlugs, "release bundle mobile fallback is missing standard skills");
    const invalidMobileSkills = Array.isArray(plugin.__flownoteMobileSkillList)
      ? plugin.__flownoteMobileSkillList
        .filter((entry) => entry && entry.completionPolicy && entry.completionPolicy.state === "invalid")
        .map((entry) => `${entry.slug}:${entry.completionPolicy.errorCode || "unknown"}`)
      : [];
    assert.deepEqual(
      invalidMobileSkills,
      [],
      "release bundle must parse standard Skill completion metadata with the mobile process shim",
    );
    const ahNote = plugin.__flownoteMobileSkillList.find((entry) => entry && entry.slug === "ah-note");
    assert.deepEqual(
      ahNote && ahNote.completionPolicy,
      {
        state: "declared",
        mode: "effect",
        requiredEffects: [],
        requiredInteractions: ["ask_user"],
        minReceipts: null,
        errorCode: null,
      },
      "mobile /ah-note must preserve its interaction contract",
    );

    return {
      embeddedFileCount: Object.keys(embeddedFiles).length,
      expectedFileCount: parity.expected.length,
      mobileSkillSlugs,
      expectedMobileSkillSlugs,
      ahNoteCompletionPolicy: ahNote && ahNote.completionPolicy,
      invalidMobileSkills,
      parity,
      materializedParity,
    };
  } finally {
    if (fixture) fixture.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = {
  inspectReleaseBundle,
  skillSlugsFromFiles,
};

if (require.main === module) {
  inspectReleaseBundle()
    .then((result) => {
      console.log(`[check-release-bundle] OK embeddedFiles=${result.embeddedFileCount} mobileSkills=${result.mobileSkillSlugs.length}`);
    })
    .catch((error) => {
      console.error(`[check-release-bundle] FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
