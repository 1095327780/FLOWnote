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

    assert.ok(ids.includes("ah-init"));
    assert.ok(ids.includes("my-custom"));
    assert.equal(ids.filter((id) => id === "ah-init").length, 1);
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
    assert.equal(service.getSkills().find((skill) => skill.id === "my-custom").description, "first");

    writeFile(
      skillPath,
      "---\nname: my-custom\ndescription: second\n---\n\n# Second\n",
    );
    service.loadSkills();
    assert.equal(service.getSkills().find((skill) => skill.id === "my-custom").description, "second");
    assert.match(String(service.getSkills().find((skill) => skill.id === "my-custom").content || ""), /# Second/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("SkillService should expose standard user/model invocation flags", () => {
  const fixture = createFixture();
  try {
    writeFile(
      path.join(fixture.skillsRoot, "user-only", "SKILL.md"),
      "---\nname: user-only\ndescription: explicit only\nuser-invocable: false\ndisable-model-invocation: true\n---\n\n# User only\n",
    );

    const service = new SkillService(fixture.vaultPath, { skillsDir: ".opencode/skills" });
    const skill = service.loadSkills().find((item) => item.id === "user-only");

    assert.equal(skill.userInvocable, false);
    assert.equal(skill.disableModelInvocation, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("SkillService uses the shared nested YAML decoder and completion policy", () => {
  const fixture = createFixture();
  try {
    writeFile(
      path.join(fixture.skillsRoot, "completion", "SKILL.md"),
      [
        "---",
        "name: completion",
        "description: >-",
        "  Shared decoder",
        "metadata:",
        "  flownote:",
        "    completion:",
        "      mode: inspect",
        "      required_effects: [observation]",
        "      min_receipts: 1",
        "---",
        "# Completion",
      ].join("\n"),
    );
    const skill = new SkillService(fixture.vaultPath, { skillsDir: ".opencode/skills" })
      .loadSkills()
      .find((item) => item.id === "completion");
    assert.deepEqual(skill.metadata.flownote.completion, {
      mode: "inspect", required_effects: ["observation"], min_receipts: 1,
    });
    assert.deepEqual(skill.completionPolicy, {
      state: "declared", mode: "inspect", requiredEffects: ["observation"], requiredInteractions: [], minReceipts: 1, errorCode: null,
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("SkillService should load supplemental Claude-style skill directories", () => {
  const fixture = createFixture();
  try {
    writeFile(
      path.join(fixture.skillsRoot, "primary", "SKILL.md"),
      "---\nname: primary\ndescription: primary\n---\n\n# Primary\n",
    );
    writeFile(
      path.join(fixture.vaultPath, ".claude", "skills", "official", "SKILL.md"),
      "---\nname: official\ndescription: official\n---\n\n# Official\n",
    );

    const service = new SkillService(fixture.vaultPath, { skillsDir: ".opencode/skills" });
    const ids = service.loadSkills().map((item) => item.id).sort();

    assert.ok(ids.includes("official"));
    assert.ok(ids.includes("primary"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("SkillService should ignore iCloud conflict copies of bundled skills", () => {
  const fixture = createFixture();
  try {
    writeFile(
      path.join(fixture.skillsRoot, "ah-capture", "SKILL.md"),
      "---\nname: ah-capture\ndescription: builtin\n---\n\n# Builtin\n",
    );
    writeFile(
      path.join(fixture.skillsRoot, "ah-capture(1)", "SKILL.md"),
      "---\nname: ah-capture\ndescription: duplicate\n---\n\n# Duplicate\n",
    );
    writeFile(
      path.join(fixture.skillsRoot, "my-custom(1)", "SKILL.md"),
      "---\nname: custom\ndescription: custom copy\n---\n\n# Custom\n",
    );

    const service = new SkillService(fixture.vaultPath, { skillsDir: ".opencode/skills" });
    const ids = service.loadSkills().map((item) => item.id).sort();

    assert.ok(ids.includes("ah-capture"));
    assert.ok(ids.includes("my-custom(1)"));
    assert.equal(ids.includes("ah-capture(1)"), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("bundled skill identity and completion policy override stale vault copies", () => {
  const fixture = createFixture();
  try {
    writeFile(
      path.join(fixture.vaultPath, ".flownote", "skills", "ah-note", "SKILL.md"),
      "---\nname: ah-note\ndescription: stale vault copy\n---\n\n# Old ah-note\n",
    );

    const skills = new SkillService(fixture.vaultPath, { skillsDir: ".flownote/skills" }).loadSkills();
    const ahNote = skills.find((skill) => skill.id === "ah-note");

    assert.ok(ahNote);
    assert.equal(ahNote.source, "bundled");
    assert.notEqual(ahNote.description, "stale vault copy");
    assert.equal(ahNote.completionPolicy.state, "declared");
    assert.equal(ahNote.completionPolicy.mode, "effect");
    assert.deepEqual(ahNote.completionPolicy.requiredInteractions, ["ask_user"]);
    assert.equal(skills.filter((skill) => skill.id === "ah-note").length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
