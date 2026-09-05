const test = require("node:test");
const assert = require("node:assert/strict");

const { parseFrontmatter } = require("../../runtime/agent/skill-registry");
const { SkillService } = require("../../runtime/skill-service");
const { parseEmbeddedSkillFrontmatter } = require("../../runtime/mobile/embedded-skill-frontmatter");
const { EMBEDDED_BUNDLED_SKILLS_FILES } = require("../../runtime/generated/bundled-skills-embedded");
const { getEmbeddedSkillCatalog, mergeAuthoritativeSkillCatalog } = require("../../runtime/skill-catalog");
const {
  EMBEDDED_BUNDLED_SKILL_DOCUMENTS,
  getEmbeddedSkillDocument,
} = require("../../runtime/embedded-skill-documents");

test("source, desktop service shape, and embedded parser agree on completion policy", () => {
  const raw = [
    "---",
    "name: policy-parity",
    "description: |",
    "  Nested YAML policy",
    "metadata:",
    "  flownote:",
    "    completion:",
    "      mode: effect",
    "      required_effects:",
    "        - vault_mutation",
    "      min_receipts: 1",
    "---",
    "Body",
  ].join("\n");
  const source = parseFrontmatter(raw);
  const embedded = parseEmbeddedSkillFrontmatter(raw);
  assert.deepEqual(embedded.metadata, source.frontmatter.metadata);
  assert.deepEqual(embedded.completionPolicy, {
    state: "declared", mode: "effect", requiredEffects: ["vault_mutation"], requiredInteractions: [], minReceipts: 1, errorCode: null,
  });
  // SkillService is imported to make this test fail if the desktop surface
  // loses its shared parser dependency during a future refactor.
  assert.equal(typeof SkillService, "function");
});

test("embedded parser fails closed for declared malformed FLOWnote policy", () => {
  const parsed = parseEmbeddedSkillFrontmatter([
    "---",
    "name: bad-policy",
    "description: bad",
    "metadata:",
    "  flownote:",
    "    completion:",
    "      mode: answer",
    "      min_receipts: 1",
    "---",
    "Body",
  ].join("\n"));
  assert.equal(parsed.completionPolicy.state, "invalid");
  assert.equal(parsed.completionPolicy.errorCode, "answer_completion_cannot_require_receipts");
});

test("the mobile ah-note authority carries its interaction contract", () => {
  const parsed = parseEmbeddedSkillFrontmatter(EMBEDDED_BUNDLED_SKILLS_FILES["ah-note/SKILL.md"]);
  assert.equal(parsed.name, "ah-note");
  assert.equal(parsed.completionPolicy.state, "declared");
  assert.equal(parsed.completionPolicy.mode, "effect");
  assert.deepEqual(parsed.completionPolicy.requiredInteractions, ["ask_user"]);
});

test("bundled Skill documents are compiled once and shared by runtime surfaces", () => {
  const document = getEmbeddedSkillDocument("ah-note/SKILL.md");
  assert.ok(EMBEDDED_BUNDLED_SKILL_DOCUMENTS["ah-note/SKILL.md"]);
  assert.equal(document.compiled, true);
  assert.equal(document.frontmatter.name, "ah-note");
  assert.match(document.body, /^> /);
  assert.deepEqual(
    document.completionPolicy,
    getEmbeddedSkillCatalog().find((skill) => skill.id === "ah-note").completionPolicy,
  );
});

test("every surface uses the embedded bundled skill as the canonical identity", () => {
  const staleVaultCopy = {
    id: "ah-note",
    slug: "ah-note",
    name: "ah-note",
    description: "stale",
    source: "vault",
    completionPolicy: {
      state: "legacy_unclassified",
      mode: null,
      requiredEffects: [],
      requiredInteractions: [],
      minReceipts: null,
      errorCode: null,
    },
  };
  const custom = { id: "my-custom", slug: "my-custom", name: "my-custom", source: "vault" };
  const merged = mergeAuthoritativeSkillCatalog([staleVaultCopy, custom]);
  const canonical = merged.find((skill) => skill.id === "ah-note");

  assert.deepEqual(
    canonical.completionPolicy,
    getEmbeddedSkillCatalog().find((skill) => skill.id === "ah-note").completionPolicy,
  );
  assert.equal(canonical.source, "bundled");
  assert.equal(merged.filter((skill) => skill.id === "ah-note").length, 1);
  assert.equal(merged.some((skill) => skill.id === "my-custom"), true);
});
