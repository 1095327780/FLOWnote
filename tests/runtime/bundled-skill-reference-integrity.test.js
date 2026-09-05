const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BUNDLED_SKILL_EMBED_EXCLUSIONS,
  collectBundledSkillFiles,
  collectBundledSkillFileMap,
  collectBundledSkillReferenceProblems,
  compareBundledSkillFileMaps,
  assertBundledSkillReferences,
} = require("../../scripts/check-bundled-skill-references");

function writeFile(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("bundled skills reference only resources that will exist after locale materialization", () => {
  const bundledRoot = path.join(__dirname, "../../bundled-skills");
  assert.deepEqual(collectBundledSkillReferenceProblems(bundledRoot), []);
  assert.doesNotThrow(() => assertBundledSkillReferences(bundledRoot));
});

test("the generated embedded map contains every publishable bundled-skill file byte-for-byte", () => {
  const bundledRoot = path.join(__dirname, "../../bundled-skills");
  const embedded = require("../../runtime/generated/bundled-skills-embedded").EMBEDDED_BUNDLED_SKILLS_FILES;
  const result = compareBundledSkillFileMaps(
    collectBundledSkillFileMap(bundledRoot),
    embedded,
  );
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, []);
  assert.deepEqual(result.mismatched, []);
  assert.equal(collectBundledSkillFiles(bundledRoot).length, result.expected.length);
  assert.equal(result.expected.length, Object.keys(embedded).length);
  assert.ok(result.expected.includes("ah-read/assets/extract_weread_outline.py"));
  assert.ok(result.expected.includes("ah-card/references/article-to-cards-guide.md"));
  assert.ok(BUNDLED_SKILL_EMBED_EXCLUSIONS.files.includes(".DS_Store"));
  assert.ok(result.expected.includes("ah-inbox/assets/永久笔记模板.en.md"));
  assert.ok(result.expected.includes("ah-inbox/assets/永久笔记模板.ru.md"));
});

test("every Skill document resource reference is readable from the generated embedded map", () => {
  const bundledRoot = path.join(__dirname, "../../bundled-skills");
  const embeddedFiles = require("../../runtime/generated/bundled-skills-embedded").EMBEDDED_BUNDLED_SKILLS_FILES;
  assert.deepEqual(
    collectBundledSkillReferenceProblems(bundledRoot, { embeddedFiles }),
    [],
  );
});

test("reference integrity accepts a canonical path backed by a localized sidecar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flownote-skill-ref-"));
  try {
    writeFile(path.join(root, "ah-test", "SKILL.en.md"), "Use `references/Guide.md`.\n");
    writeFile(path.join(root, "ah-test", "references", "Guide.en.md"), "English guide\n");
    assert.deepEqual(collectBundledSkillReferenceProblems(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reference integrity scans backticks, Markdown links, YAML lists, and bare resource paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flownote-skill-ref-"));
  try {
    writeFile(
      path.join(root, "ah-test", "SKILL.md"),
      [
        "resources:",
        "  - references/guide.md",
        "  - assets/tool.py",
        "Run `scripts/build.js`.",
        "See [the guide](references/guide.md).",
        "The bare file is assets/tool.py.",
      ].join("\n"),
    );
    writeFile(path.join(root, "ah-test", "references", "guide.md"), "guide\n");
    writeFile(path.join(root, "ah-test", "assets", "tool.py"), "print('ok')\n");
    writeFile(path.join(root, "ah-test", "scripts", "build.js"), "module.exports = {}\n");
    assert.deepEqual(collectBundledSkillReferenceProblems(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reference integrity rejects dangling and localized-only links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flownote-skill-ref-"));
  try {
    writeFile(
      path.join(root, "ah-test", "SKILL.md"),
      "Read `references/missing.md` and `assets/Guide.en.md`.\n",
    );
    writeFile(path.join(root, "ah-test", "assets", "Guide.en.md"), "English guide\n");
    const problems = collectBundledSkillReferenceProblems(root);
    assert.equal(problems.length, 2);
    assert.match(problems[0].reason, /does not exist/);
    assert.match(problems[1].reason, /must use its canonical/);
    assert.throws(() => assertBundledSkillReferences(root), /missing\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reference integrity rejects path traversal in every supported reference form", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flownote-skill-ref-"));
  try {
    writeFile(
      path.join(root, "ah-test", "SKILL.md"),
      [
        "- `../references/secret.md`",
        "- [bad](references/../secret.md)",
        "resources:",
        "  - ../assets/secret.py",
      ].join("\n"),
    );
    const problems = collectBundledSkillReferenceProblems(root);
    assert.equal(problems.length, 3);
    assert.ok(problems.every((problem) => /path traversal|safe relative/.test(problem.reason)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("embedded-map comparison reports missing, extra, and changed files", () => {
  const source = new Map([
    ["ah-test/SKILL.md", Buffer.from("skill\n")],
    ["ah-test/references/guide.md", Buffer.from("guide\n")],
  ]);
  const embedded = {
    "ah-test/SKILL.md": "skill\nchanged",
    "ah-test/assets/obsolete.txt": "old\n",
  };
  const result = compareBundledSkillFileMaps(source, embedded);
  assert.deepEqual(result.missing, ["ah-test/references/guide.md"]);
  assert.deepEqual(result.extra, ["ah-test/assets/obsolete.txt"]);
  assert.deepEqual(result.mismatched, ["ah-test/SKILL.md"]);
});
