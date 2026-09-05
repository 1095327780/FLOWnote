"use strict";

// One catalog projection for every user-facing Skill entrypoint. Bundled
// Skills are versioned with the plugin and therefore own their identities;
// vault Skills may extend the catalog but cannot silently replace a bundled
// workflow with a stale synced copy.

const {
  EMBEDDED_BUNDLED_SKILLS_FILES,
  getEmbeddedSkillDocument,
} = require("./embedded-skill-documents");

function frontmatterBoolean(attrs, key, fallback) {
  if (!attrs || attrs[key] === undefined || attrs[key] === null || attrs[key] === "") return fallback;
  if (attrs[key] === true || attrs[key] === false) return attrs[key];
  const normalized = String(attrs[key]).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function summarizeSkillBody(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 18)
    .join("\n");
}

function skillIdentityKeys(skill) {
  const keys = [];
  for (const value of [
    skill && skill.id,
    skill && skill.slug,
    skill && skill.name,
    ...((skill && skill.aliases) || []),
  ]) {
    const normalized = String(value || "").trim().replace(/^\/+/, "").toLowerCase();
    if (normalized && !keys.includes(normalized)) keys.push(normalized);
  }
  return keys;
}

function getEmbeddedSkillCatalog() {
  const catalog = [];
  for (const filePath of Object.keys(EMBEDDED_BUNDLED_SKILLS_FILES).sort()) {
    if (!filePath.endsWith("/SKILL.md")) continue;
    const slug = filePath.slice(0, -"/SKILL.md".length);
    if (!slug || slug.includes("/")) continue;
    const document = getEmbeddedSkillDocument(filePath);
    if (!document) continue;
    const raw = document.raw;
    const attrs = document.frontmatter || {};
    catalog.push({
      id: slug,
      slug,
      name: typeof attrs.name === "string" && attrs.name.trim() ? attrs.name.trim() : slug,
      description: typeof attrs.description === "string" ? attrs.description : "",
      userInvocable: frontmatterBoolean(attrs, "user-invocable", true),
      disableModelInvocation: frontmatterBoolean(attrs, "disable-model-invocation", false),
      metadata: attrs.metadata && typeof attrs.metadata === "object" && !Array.isArray(attrs.metadata)
        ? attrs.metadata
        : undefined,
      completionPolicy: document.completionPolicy,
      content: raw,
      summary: summarizeSkillBody(document.body),
      path: `<embedded>/${slug}/SKILL.md`,
      source: "bundled",
    });
  }
  return catalog;
}

function mergeAuthoritativeSkillCatalog(userSkills) {
  const result = [];
  const claimed = new Set();
  const append = (skill) => {
    if (!skill || typeof skill !== "object") return false;
    const keys = skillIdentityKeys(skill);
    if (keys.length === 0 || keys.some((key) => claimed.has(key))) return false;
    result.push(skill);
    for (const key of keys) claimed.add(key);
    return true;
  };

  for (const skill of getEmbeddedSkillCatalog()) append(skill);
  for (const skill of Array.isArray(userSkills) ? userSkills : []) append(skill);
  result.sort((left, right) => String(left.name || left.id || "").localeCompare(String(right.name || right.id || "")));
  return result;
}

module.exports = {
  EMBEDDED_BUNDLED_SKILLS_FILES,
  getEmbeddedSkillCatalog,
  mergeAuthoritativeSkillCatalog,
  skillIdentityKeys,
  summarizeSkillBody,
};
