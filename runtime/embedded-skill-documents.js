"use strict";

// Bundled Skills are product-owned release assets. Their YAML is parsed and
// validated once by scripts/build-release.mjs; all runtime surfaces consume
// this shared projection instead of reparsing the same static text on each
// device. The fallback keeps source/dev environments compatible with an older
// generated module, while user-authored vault Skills continue to use the
// browser-safe runtime parser.

const generated = (() => {
  try { return require("./generated/bundled-skills-embedded"); } catch { return {}; }
})();
const { splitSkillFrontmatter, parseFlowNoteCompletionMetadata } = require("./skill-frontmatter");

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const EMBEDDED_BUNDLED_SKILLS_FILES = generated && generated.EMBEDDED_BUNDLED_SKILLS_FILES
  ? generated.EMBEDDED_BUNDLED_SKILLS_FILES
  : {};
const EMBEDDED_BUNDLED_SKILL_DOCUMENTS = deepFreeze(generated && generated.EMBEDDED_BUNDLED_SKILL_DOCUMENTS
  ? generated.EMBEDDED_BUNDLED_SKILL_DOCUMENTS
  : {});

function getEmbeddedSkillDocument(filePath) {
  const normalizedPath = String(filePath || "");
  if (!Object.prototype.hasOwnProperty.call(EMBEDDED_BUNDLED_SKILLS_FILES, normalizedPath)) return null;
  const raw = String(EMBEDDED_BUNDLED_SKILLS_FILES[normalizedPath] || "");
  const compiled = EMBEDDED_BUNDLED_SKILL_DOCUMENTS[normalizedPath];
  if (
    compiled
    && compiled.frontmatter
    && Number.isInteger(compiled.bodyOffset)
    && compiled.bodyOffset >= 0
    && compiled.bodyOffset <= raw.length
  ) {
    return {
      raw,
      frontmatter: compiled.frontmatter,
      body: raw.slice(Math.max(0, compiled.bodyOffset)),
      errorCode: null,
      completionPolicy: compiled.completionPolicy || parseFlowNoteCompletionMetadata(compiled.frontmatter),
      compiled: true,
    };
  }
  const parsed = splitSkillFrontmatter(raw);
  return {
    raw,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    errorCode: parsed.errorCode,
    completionPolicy: parseFlowNoteCompletionMetadata(parsed.frontmatter, { frontmatterError: parsed.errorCode }),
    compiled: false,
  };
}

module.exports = {
  EMBEDDED_BUNDLED_SKILLS_FILES,
  EMBEDDED_BUNDLED_SKILL_DOCUMENTS,
  getEmbeddedSkillDocument,
};
