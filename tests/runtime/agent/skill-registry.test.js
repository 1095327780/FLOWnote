const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadSkills,
  parseFrontmatter,
  parseArgumentNames,
  parseToolList,
  substituteArguments,
  formatSkillListing,
  SkillRegistry,
} = require("../../../runtime/agent/skill-registry");
const { createSkillInvokeTool } = require("../../../runtime/agent/tools/skill-invoke");
const { createSkillResourceReadTool } = require("../../../runtime/agent/tools/skill-resource-read");

// ----- parseFrontmatter -----

test("parseFrontmatter handles scalar, quoted, list, and boolean values", () => {
  const raw = [
    "---",
    "name: ah-card",
    "description: \"Permanent note crafter\"",
    "when_to_use: when extracting a knowledge atom",
    "allowed-tools: [vault_read, vault_write]",
    "disable-model-invocation: false",
    "---",
    "",
    "Skill body lives down here.",
    "Second line.",
  ].join("\n");
  const { frontmatter, body } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, "ah-card");
  assert.equal(frontmatter.description, "Permanent note crafter");
  assert.equal(frontmatter.when_to_use, "when extracting a knowledge atom");
  assert.deepEqual(frontmatter["allowed-tools"], ["vault_read", "vault_write"]);
  assert.equal(frontmatter["disable-model-invocation"], false);
  assert.equal(body, "Skill body lives down here.\nSecond line.");
});

test("parseFrontmatter returns empty frontmatter for plain markdown", () => {
  const { frontmatter, body } = parseFrontmatter("# Hi\nnot a skill");
  assert.deepEqual(frontmatter, {});
  assert.equal(body, "# Hi\nnot a skill");
});

test("parseArgumentNames accepts list or comma-string", () => {
  assert.deepEqual(parseArgumentNames(["foo", "bar"]), ["foo", "bar"]);
  assert.deepEqual(parseArgumentNames("foo, bar baz"), ["foo", "bar", "baz"]);
  assert.deepEqual(parseArgumentNames(undefined), []);
});

test("parseFrontmatter accepts YAML-style lists and compatibility aliases", () => {
  const raw = [
    "---",
    "name: official-skill",
    "description: |",
    "  First line",
    "  second line",
    "allowed_tools:",
    "  - Read",
    "  - Bash(git diff:*)",
    "when-to-use: Use when testing official skills",
    "file-path-patterns: [books/*.md, inbox/*.md]",
    "aliases: [official, oskill]",
    "---",
    "Body",
  ].join("\n");
  const { frontmatter, body } = parseFrontmatter(raw);
  assert.equal(frontmatter.description, "First line\nsecond line");
  assert.deepEqual(frontmatter.allowed_tools, ["Read", "Bash(git diff:*)"]);
  assert.equal(frontmatter["when-to-use"], "Use when testing official skills");
  assert.deepEqual(frontmatter["file-path-patterns"], ["books/*.md", "inbox/*.md"]);
  assert.deepEqual(frontmatter.aliases, ["official", "oskill"]);
  assert.equal(body, "Body");
});

test("parseToolList keeps Bash patterns intact", () => {
  assert.deepEqual(parseToolList("Bash(git diff:*), Read Grep"), [
    "Bash(git diff:*)",
    "Read",
    "Grep",
  ]);
});

// ----- substituteArguments -----

test("substituteArguments replaces $ARGUMENTS, $1, and ${name}", () => {
  const body = "/cmd $ARGUMENTS\nfirst: $1\nname: ${who}";
  const out = substituteArguments(body, "alice extra", ["who"]);
  assert.match(out, /\/cmd alice extra/);
  assert.match(out, /first: alice/);
  assert.match(out, /name: alice/);
});

test("substituteArguments leaves placeholders alone when args are empty", () => {
  const out = substituteArguments("/cmd $ARGUMENTS\nfirst: $1", "");
  assert.match(out, /\/cmd /);
  assert.match(out, /first: \$1/);
});

// ----- loadSkills -----

function fakeVault(skills = {}) {
  // skills: { [dirPath]: <skill md text> }
  const dirs = Object.keys(skills);
  return {
    listSkillDirs: () =>
      dirs.map((d) => ({ dirPath: d, filePath: `${d}/SKILL.md` })),
    readFile: async (path) => {
      const dir = path.replace(/\/SKILL\.md$/i, "");
      return skills[dir];
    },
  };
}

test("loadSkills returns sorted manifests with parsed metadata", async () => {
  const vault = fakeVault({
    ".opencode/skills/ah-card": "---\nname: ah-card\ndescription: Card crafter\n---\nbody-of-ah-card",
    ".opencode/skills/ah-note": "---\nname: ah-note\ndescription: Daily note\n---\nbody-of-ah-note",
  });
  const manifests = await loadSkills({ rootPath: ".opencode/skills", vault });
  assert.equal(manifests.length, 2);
  assert.deepEqual(manifests.map((m) => m.name), ["ah-card", "ah-note"]);
  assert.equal(manifests[0].body, "body-of-ah-card");
  assert.equal(manifests[1].description, "Daily note");
});

test("loadSkills tracks skill resources and frontmatter aliases", async () => {
  const vault = {
    listSkillDirs: () => [
      {
        dirPath: ".flownote/skills/wechat",
        filePath: ".flownote/skills/wechat/SKILL.md",
        resourcePaths: ["references/API.md", "assets/sample.md", "../bad.md", "SKILL.md"],
      },
    ],
    readFile: async () => [
      "---",
      "name: 微信读书",
      "description: WeRead official skill",
      "allowed_tools:",
      "  - Read",
      "  - WebFetch",
      "aliases: [weread]",
      "---",
      "body",
    ].join("\n"),
  };
  const reg = new SkillRegistry(await loadSkills({ rootPath: ".flownote/skills", vault }));
  const skill = reg.get("wechat");
  assert.equal(skill.name, "微信读书");
  assert.deepEqual(skill.allowedTools, ["Read", "WebFetch"]);
  assert.deepEqual(skill.resourcePaths, ["assets/sample.md", "references/API.md"]);
  assert.equal(reg.get("weread"), skill);
});

test("loadSkills falls back to dirname when name frontmatter is missing", async () => {
  const vault = fakeVault({
    ".opencode/skills/no-name": "---\ndescription: anonymous\n---\nbody",
  });
  const manifests = await loadSkills({ rootPath: ".opencode/skills", vault });
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].name, "no-name");
});

test("loadSkills skips unreadable directories silently", async () => {
  const vault = {
    listSkillDirs: () => [
      { dirPath: ".x/good", filePath: ".x/good/SKILL.md" },
      { dirPath: ".x/broken", filePath: ".x/broken/SKILL.md" },
    ],
    readFile: async (path) => {
      if (path.includes("broken")) throw new Error("permission denied");
      return "---\nname: good\ndescription: ok\n---\nbody";
    },
  };
  const manifests = await loadSkills({ rootPath: ".x", vault });
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].name, "good");
});

test("loadSkills throws if rootPath or vault is missing", async () => {
  await assert.rejects(() => loadSkills({}), /rootPath required/);
  await assert.rejects(() => loadSkills({ rootPath: "x" }), /vault required/);
});

// ----- SkillRegistry -----

test("SkillRegistry get/list/modelInvocable", () => {
  const reg = new SkillRegistry([
    { name: "a", description: "Alpha", body: "x" },
    { name: "b", description: "Beta",  body: "y", disableModelInvocation: true },
  ]);
  assert.equal(reg.size(), 2);
  assert.equal(reg.get("a").description, "Alpha");
  assert.equal(reg.list().length, 2);
  assert.equal(reg.modelInvocable().length, 1);
});

// ----- formatSkillListing -----

test("formatSkillListing omits user-invocable-only skills", () => {
  const text = formatSkillListing([
    { name: "a", description: "Alpha", body: "" },
    { name: "b", description: "Beta",  body: "", disableModelInvocation: true },
  ]);
  assert.match(text, /- a: Alpha/);
  assert.doesNotMatch(text, /- b: Beta/);
});

test("formatSkillListing truncates very long descriptions", () => {
  const long = "x".repeat(400);
  const text = formatSkillListing([{ name: "lng", description: long, body: "" }]);
  assert.ok(text.length < long.length + 30);
});

test("formatSkillListing appends when_to_use to description", () => {
  const text = formatSkillListing([
    { name: "x", description: "Short", whenToUse: "when uncertain", body: "" },
  ]);
  assert.match(text, /Short — when uncertain/);
});

// ----- skill_invoke tool -----

async function collect(tool, input, ctx) {
  const events = [];
  for await (const ev of tool.execute(input, ctx || {})) events.push(ev);
  return events;
}
function lastResult(events) {
  return events.filter((e) => e.type === "result").pop();
}

test("skill_invoke factory rejects missing registry", () => {
  assert.throws(() => createSkillInvokeTool({}), /skillRegistry required/);
});

test("skill_invoke returns the skill body with $ARGUMENTS substituted", async () => {
  const reg = new SkillRegistry([
    {
      name: "say-hi",
      description: "Say hello",
      body: "Hello $ARGUMENTS! See $1.",
      argumentNames: ["who"],
      dirPath: ".opencode/skills/say-hi",
    },
  ]);
  const tool = createSkillInvokeTool({ skillRegistry: reg });
  const r = lastResult(await collect(tool, { skill: "say-hi", args: "World friend" }));
  assert.ok(!r.isError);
  assert.match(r.content, /Skill: say-hi/);
  assert.match(r.content, /FLOWnote skill compatibility/);
  assert.match(r.content, /Hello World friend!/);
  assert.match(r.content, /See World/);
});

test("skill_invoke advertises skill resources", async () => {
  const reg = new SkillRegistry([
    {
      name: "rich",
      description: "Rich skill",
      body: "See references/guide.md",
      dirPath: ".flownote/skills/rich",
      resourcePaths: ["references/guide.md"],
    },
  ]);
  const tool = createSkillInvokeTool({ skillRegistry: reg });
  const r = lastResult(await collect(tool, { skill: "rich" }));
  assert.match(r.content, /skill_resource_read/);
  assert.match(r.content, /references\/guide\.md/);
});

test("skill_resource_read reads vault-backed resources", async () => {
  const reg = new SkillRegistry([
    {
      name: "rich",
      description: "Rich skill",
      body: "",
      dirPath: ".flownote/skills/rich",
      resourcePaths: ["references/guide.md"],
    },
  ]);
  const vault = fakeVault({
    ".flownote/skills/rich": "---\nname: rich\ndescription: Rich\n---\n",
    ".flownote/skills/rich/references/guide.md": "guide",
  });
  const tool = createSkillResourceReadTool({ skillRegistry: reg, vault });
  const r = lastResult(await collect(tool, { skill: "rich", path: "references/guide.md" }));
  assert.ok(!r.isError);
  assert.match(r.content, /Skill resource: rich\/references\/guide\.md/);
  assert.match(r.content, /guide/);
});

test("skill_resource_read reads embedded resources and rejects traversal", async () => {
  const reg = new SkillRegistry([
    {
      name: "embedded",
      description: "Embedded",
      body: "",
      dirPath: "<embedded>/embedded",
      resourcePaths: ["references/guide.md"],
      embeddedResourceFiles: { "references/guide.md": "embedded guide" },
    },
  ]);
  const tool = createSkillResourceReadTool({ skillRegistry: reg, vault: fakeVault() });
  assert.equal((await tool.validate({ skill: "embedded", path: "../x.md" })).ok, false);
  const r = lastResult(await collect(tool, { skill: "embedded", path: "references/guide.md" }));
  assert.ok(!r.isError);
  assert.match(r.content, /embedded guide/);
});

test("skill_invoke surfaces an error when the skill is unknown", async () => {
  const reg = new SkillRegistry([]);
  const tool = createSkillInvokeTool({ skillRegistry: reg });
  const r = lastResult(await collect(tool, { skill: "missing" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /no skill named "missing"/);
});

test("skill_invoke refuses skills marked disable-model-invocation", async () => {
  const reg = new SkillRegistry([
    {
      name: "hidden",
      description: "Hidden skill",
      body: "...",
      disableModelInvocation: true,
      dirPath: ".x",
    },
  ]);
  const tool = createSkillInvokeTool({ skillRegistry: reg });
  const r = lastResult(await collect(tool, { skill: "hidden" }));
  assert.equal(r.isError, true);
  assert.match(r.content, /user-invocable only/);
});

test("skill_invoke validate rejects missing skill name", async () => {
  const reg = new SkillRegistry([]);
  const tool = createSkillInvokeTool({ skillRegistry: reg });
  assert.equal((await tool.validate({})).ok, false);
  assert.equal((await tool.validate({ skill: "" })).ok, false);
  assert.equal((await tool.validate({ skill: "x", args: 42 })).ok, false);
});
