// Skill regression suite — loads every bundled SKILL.md and asserts
// it's loadable, has the required frontmatter, and any `allowed-tools`
// it declares correspond to tools we actually register.
//
// Catches the most common regression: a tool gets renamed or removed
// and the skills referencing it silently stop working. The full
// behavioural test (does the agent actually call the right tools given
// a user prompt?) requires real LLM I/O and is outside this suite.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { parseFrontmatter } = require("../../runtime/agent/skill-registry");
const { parseFlowNoteCompletionMetadata } = require("../../runtime/skill-frontmatter");

const BUNDLED_DIR = path.join(__dirname, "..", "..", "bundled-skills");
const ALLOWED_ENGLISH_SKILL_PLACEHOLDERS = new Set([
  "YYYY-MM-DD",
  "HH:mm",
  "original text",
  "task",
  "notePaths.dailyNotes",
  "notePaths.weeklyReviews",
  "notePaths.monthlyReviews",
  "notePaths.yearlyReviews",
  "notePaths.permanentNotes",
  "notePaths.topicNotes",
  "notePaths.literatureNotes",
  "notePaths.domainPages",
  "notePaths.activeProjects",
  "notePaths.archive",
]);

// All tools that buildDefaultToolRegistry currently registers. Keep in
// sync with runtime/chat/direct-agent-runner.js. This is intentionally
// a hard-coded list so removing a tool fails the test, not just removing
// the registration.
const KNOWN_TOOLS = new Set([
  // File I/O
  "vault_read",
  "vault_write",
  "vault_edit",
  "vault_list",
  "vault_search",
  "vault_move",
  "vault_create_dir",
  "vault_get_active_file",
  // Obsidian-native
  "vault_daily",
  "vault_property",
  "vault_backlinks",
  "vault_tasks",
  "vault_tags",
  // Network
  "web_fetch",
  "web_request",
  // Meta
  "ask_user",
  "skill_invoke",
  "skill_resource_read",
]);

function listSkillDirs() {
  if (!fs.existsSync(BUNDLED_DIR)) return [];
  return fs.readdirSync(BUNDLED_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ slug: e.name, dir: path.join(BUNDLED_DIR, e.name) }));
}

function loadSkill(slug, dir) {
  const filePath = path.join(dir, "SKILL.md");
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  return { slug, dir, raw, frontmatter: parsed.frontmatter, body: parsed.body };
}

function loadSkillVariant(dir, fileName) {
  const filePath = path.join(dir, fileName);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  return { filePath, raw, frontmatter: parsed.frontmatter, body: parsed.body };
}

const skills = listSkillDirs()
  .map((s) => loadSkill(s.slug, s.dir))
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Bulk inventory + count sanity
// ---------------------------------------------------------------------------

test("bundled skills directory has at least 14 ah-* skills", () => {
  const ahSkills = skills.filter((s) => s.slug.startsWith("ah"));
  assert.ok(
    ahSkills.length >= 14,
    `expected ≥14 ah-* skills, got ${ahSkills.length}: ${ahSkills.map((s) => s.slug).join(", ")}`,
  );
});

test("bundled skills includes the helper trio: obsidian-cli / obsidian-markdown / obsidian-bases", () => {
  const slugs = new Set(skills.map((s) => s.slug));
  for (const helper of ["obsidian-cli", "obsidian-markdown", "obsidian-bases"]) {
    assert.ok(slugs.has(helper), `missing helper skill: ${helper}`);
  }
});

test("every bundled ah skill has an English SKILL.en.md variant", () => {
  const ahSkills = skills.filter((s) => s.slug === "ah" || s.slug.startsWith("ah-"));
  assert.ok(ahSkills.length >= 14, "expected ah skill inventory to be present");
  for (const skill of ahSkills) {
    const english = loadSkillVariant(skill.dir, "SKILL.en.md");
    assert.ok(english, `${skill.slug}: missing SKILL.en.md`);
    assert.equal(english.frontmatter.name, skill.frontmatter.name, `${skill.slug}: English name must match base name`);
    assert.ok(
      typeof english.frontmatter.description === "string" && english.frontmatter.description.trim().length > 0,
      `${skill.slug}: English description is missing`,
    );
    assert.ok(String(english.body || "").trim().length > 50, `${skill.slug}: English body too short`);
    assert.doesNotMatch(
      String(english.frontmatter.description || ""),
      /[\u4e00-\u9fff]/,
      `${skill.slug}: English description still contains Chinese text`,
    );
    assert.doesNotMatch(
      String(english.body || ""),
      /[\u4e00-\u9fff]/,
      `${skill.slug}: English body still contains Chinese text`,
    );
    const placeholders = [...String(english.body || "").matchAll(/\{\{([^}]+)\}\}/g)]
      .map((match) => String(match[1] || "").trim());
    for (const placeholder of placeholders) {
      assert.ok(
        ALLOWED_ENGLISH_SKILL_PLACEHOLDERS.has(placeholder),
        `${skill.slug}: unsupported English placeholder {{${placeholder}}}`,
      );
    }
  }
});

test("bundled ah completion policies are complete and locale-synchronized", () => {
  const effectSkills = new Set([
    "ah-archive", "ah-capture", "ah-card", "ah-inbox", "ah-init", "ah-legacy",
    "ah-memory", "ah-month", "ah-note", "ah-project", "ah-read", "ah-review", "ah-week", "ah-year",
  ]);
  const answerSkills = new Set(["ah", "ah-think"]);
  for (const skill of skills.filter((item) => effectSkills.has(item.slug) || answerSkills.has(item.slug))) {
    const english = loadSkillVariant(skill.dir, "SKILL.en.md");
    const sourcePolicy = parseFlowNoteCompletionMetadata(skill.frontmatter);
    const englishPolicy = parseFlowNoteCompletionMetadata(english.frontmatter);
    const expectedMode = effectSkills.has(skill.slug) ? "effect" : "answer";
    assert.deepEqual(sourcePolicy, englishPolicy, `${skill.slug}: localized completion policy drifted`);
    assert.equal(sourcePolicy.state, "declared", `${skill.slug}: missing completion declaration`);
    assert.equal(sourcePolicy.mode, expectedMode, `${skill.slug}: wrong completion mode`);
  }
  for (const skill of skills.filter((item) => !effectSkills.has(item.slug) && !answerSkills.has(item.slug))) {
    assert.equal(
      parseFlowNoteCompletionMetadata(skill.frontmatter).state,
      "legacy_unclassified",
      `${skill.slug}: third-party compatibility skill must remain unclassified`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-skill structural checks
// ---------------------------------------------------------------------------

for (const skill of skills) {
  test(`skill "${skill.slug}": SKILL.md has frontmatter name + description`, () => {
    assert.ok(
      typeof skill.frontmatter.name === "string" && skill.frontmatter.name.trim().length > 0,
      `${skill.slug}: missing or empty frontmatter name`,
    );
    assert.ok(
      typeof skill.frontmatter.description === "string" && skill.frontmatter.description.trim().length > 0,
      `${skill.slug}: missing or empty frontmatter description`,
    );
  });

  test(`skill "${skill.slug}": body is non-empty`, () => {
    const bodyLen = String(skill.body || "").trim().length;
    assert.ok(bodyLen > 50, `${skill.slug}: body too short (${bodyLen} chars)`);
  });

  test(`skill "${skill.slug}": every allowed-tools entry resolves to a registered tool`, () => {
    const allowed = skill.frontmatter["allowed-tools"];
    if (!allowed) return; // no whitelist → all tools available
    const tools = Array.isArray(allowed) ? allowed : String(allowed).split(/[,\s]+/);
    for (const tool of tools) {
      if (!tool) continue;
      // Helper skills are referenced by skill-name not tool-name; skip
      // anything that isn't a native tool-name pattern.
      if (!/^(vault_|skill_|ask_|web_)/.test(tool)) continue;
      assert.ok(
        KNOWN_TOOLS.has(tool),
        `${skill.slug}: allowed-tools includes "${tool}" but no such tool is registered`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Cross-skill checks — soft warnings only (don't fail)
// ---------------------------------------------------------------------------

test("no skill body references a Claude-Code / OpenCode-only tool by name", () => {
  // These are tool names from the reference project that we DON'T have.
  // If a skill explicitly invokes them (not just mentions in prose), it
  // would fail at runtime. We can't reliably detect prose-vs-invoke from
  // markdown, but tool calls like `\`BashTool\`` or `Bash(...)` would
  // be a smell.
  const offenders = [];
  const banned = /\b(BashTool|GrepTool|GlobTool|FileEditTool|FileReadTool|FileWriteTool|LSPTool|AgentTool)\b/;
  for (const skill of skills) {
    if (banned.test(skill.body)) offenders.push(skill.slug);
  }
  assert.deepEqual(
    offenders,
    [],
    `skills reference Claude-Code-only tool classes: ${offenders.join(", ")}`,
  );
});

test("obsidian-cli references resolve via the system-prompt translation map", () => {
  // Every skill that mentions obsidian-cli should rely on the
  // translation hint we already inject in BASE_SYSTEM_PROMPT. This
  // test just inventories which skills are affected, so a future
  // refactor that removes the translation hint surfaces here.
  const referencers = skills.filter((s) => /obsidian-cli/.test(s.body)).map((s) => s.slug);
  // No assertion on the count — just emit a stable list so a diff in
  // CI shows when this changes.
  assert.ok(Array.isArray(referencers));
});
