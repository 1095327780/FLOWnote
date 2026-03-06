const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SkillService } = require("../../runtime/skill-service");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flownote-skill-service-"));
  const vaultPath = path.join(root, "vault");
  const skillsRoot = path.join(vaultPath, ".opencode", "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  return { root, vaultPath, skillsRoot };
}

test("SkillService should load custom skills even when allowed ids are set", () => {
  const fixture = createFixture();
  try {
    writeFile(
      path.join(fixture.skillsRoot, "ah-init", "SKILL.md"),
      "---\nname: ah-init\ndescription: builtin\n---\n\n# Builtin\n",
    );
    writeFile(
      path.join(fixture.skillsRoot, "my-custom", "SKILL.md"),
      "---\nname: my-custom\ndescription: custom\n---\n\n# Custom\n",
    );

    const service = new SkillService(fixture.vaultPath, { skillsDir: ".opencode/skills" });
    service.setAllowedSkillIds(["ah-init"]);
    const skills = service.loadSkills();
    const ids = skills.map((item) => item.id).sort();

    assert.deepEqual(ids, ["ah-init", "my-custom"]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("SkillService should reflect disk edits after reload", () => {
  const fixture = createFixture();
  try {
    const skillPath = path.join(fixture.skillsRoot, "my-custom", "SKILL.md");
    writeFile(
      skillPath,
      "---\nname: my-custom\ndescription: first\n---\n\n# First\n",
    );

    const service = new SkillService(fixture.vaultPath, { skillsDir: ".opencode/skills" });
    service.loadSkills();
    assert.equal(service.getSkills()[0].description, "first");

    writeFile(
      skillPath,
      "---\nname: my-custom\ndescription: second\n---\n\n# Second\n",
    );
    service.loadSkills();
    assert.equal(service.getSkills()[0].description, "second");
    assert.match(String(service.getSkills()[0].content || ""), /# Second/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
