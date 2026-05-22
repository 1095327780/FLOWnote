const embeddedBundledSkillsModule = (() => {
  try { return require("./generated/bundled-skills-embedded"); } catch { return {}; }
})();

const EMBEDDED_BUNDLED_SKILLS_FILES =
  embeddedBundledSkillsModule && embeddedBundledSkillsModule.EMBEDDED_BUNDLED_SKILLS_FILES
    ? embeddedBundledSkillsModule.EMBEDDED_BUNDLED_SKILLS_FILES
    : {};

let bundledSkillSlugCache = null;

function getBundledSkillSlugs() {
  if (bundledSkillSlugCache) return bundledSkillSlugCache;
  const slugs = new Set();
  for (const filePath of Object.keys(EMBEDDED_BUNDLED_SKILLS_FILES)) {
    if (!filePath.endsWith("/SKILL.md")) continue;
    const slug = filePath.split("/")[0];
    if (slug) slugs.add(slug);
  }
  bundledSkillSlugCache = slugs;
  return bundledSkillSlugCache;
}

function isBundledSkillSlug(slug) {
  const normalized = String(slug || "").trim();
  return Boolean(normalized && getBundledSkillSlugs().has(normalized));
}

function getConflictCopyBaseSlug(slug) {
  const normalized = String(slug || "").trim();
  const match = normalized.match(/^(.+?)[(（]([1-9]\d*)[)）]$/);
  if (!match) return "";
  return String(match[1] || "").trim();
}

function isBundledSkillConflictCopySlug(slug) {
  const base = getConflictCopyBaseSlug(slug);
  return Boolean(base && isBundledSkillSlug(base));
}

module.exports = {
  EMBEDDED_BUNDLED_SKILLS_FILES,
  getBundledSkillSlugs,
  isBundledSkillSlug,
  getConflictCopyBaseSlug,
  isBundledSkillConflictCopySlug,
};
