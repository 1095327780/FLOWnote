const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("Skill frontmatter distinguishes malformed YAML from parser runtime failure", () => {
  const modulePath = require.resolve("../../runtime/skill-frontmatter");
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "yaml") {
      return {
        parseDocument() {
          throw new TypeError("mobile host shim is incomplete");
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { splitSkillFrontmatter } = require(modulePath);
    const parsed = splitSkillFrontmatter("---\nname: demo\n---\nBody");
    assert.equal(parsed.errorCode, "frontmatter_parser_failure");
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }

  const { splitSkillFrontmatter } = require(modulePath);
  const malformed = splitSkillFrontmatter("---\nname: [unterminated\n---\nBody");
  assert.equal(malformed.errorCode, "invalid_frontmatter");
});
