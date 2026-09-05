"use strict";

const {
  splitSkillFrontmatter,
  parseFlowNoteCompletionMetadata,
} = require("../skill-frontmatter");

function parseEmbeddedSkillFrontmatter(rawText) {
  const parsed = splitSkillFrontmatter(rawText);
  const attrs = parsed.frontmatter;
  return {
    name: typeof attrs.name === "string" ? attrs.name : "",
    description: typeof attrs.description === "string" ? attrs.description : "",
    userInvocable: attrs["user-invocable"] !== false,
    disableModelInvocation: attrs["disable-model-invocation"] === true,
    metadata: attrs.metadata && typeof attrs.metadata === "object" && !Array.isArray(attrs.metadata)
      ? attrs.metadata
      : undefined,
    completionPolicy: parseFlowNoteCompletionMetadata(attrs, { frontmatterError: parsed.errorCode }),
  };
}

module.exports = { parseEmbeddedSkillFrontmatter };
