// Node-only deps — legacy SkillService is fs-backed and desktop-only.
// Mobile's `require(...)` returns `{}` (not throw), so sniff before adopting.
let fs = {};
let path = { join: (...parts) => parts.filter(Boolean).join("/") };
const { isBundledSkillConflictCopySlug } = require("./bundled-skill-slugs");
const {
  splitSkillFrontmatter,
  parseFlowNoteCompletionMetadata,
} = require("./skill-frontmatter");
const {
  getEmbeddedSkillCatalog,
  mergeAuthoritativeSkillCatalog,
  skillIdentityKeys,
} = require("./skill-catalog");
try {
  const real = require("fs");
  if (real && typeof real.existsSync === "function") fs = real;
} catch { /* mobile */ }
try {
  const real = require("path");
  if (real && typeof real.join === "function") path = real;
} catch { /* mobile */ }

const SUPPLEMENTAL_SKILL_DIRS = [
  ".flownote/skills",
  ".opencode/skills",
  ".claude/skills",
  "skills",
];

function parseFrontmatter(md) {
  const parsed = splitSkillFrontmatter(md);
  return { attrs: parsed.frontmatter, body: parsed.body, errorCode: parsed.errorCode };
}

function summarizeBody(body) {
  return body
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 18)
    .join("\n");
}

function frontmatterBoolean(attrs, key, fallback) {
  if (!attrs || attrs[key] === undefined || attrs[key] === null || attrs[key] === "") return fallback;
  if (attrs[key] === true || attrs[key] === false) return attrs[key];
  const normalized = String(attrs[key]).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function copyDirectoryRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry || String(entry.name || "").startsWith(".")) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

class SkillService {
  constructor(vaultPath, settings) {
    this.vaultPath = vaultPath;
    this.settings = settings;
    this.cache = [];
    this.allowedSkillIds = null;
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  setAllowedSkillIds(skillIds) {
    if (!skillIds) {
      this.allowedSkillIds = null;
      return;
    }
    const ids = Array.isArray(skillIds) ? skillIds : Array.from(skillIds);
    const normalized = ids.map((item) => String(item || "").trim()).filter(Boolean);
    this.allowedSkillIds = new Set(normalized);
  }

  loadSkills() {
    const userSkills = [];
    const bundledKeys = new Set(getEmbeddedSkillCatalog().flatMap(skillIdentityKeys));
    const seenIds = new Set();

    for (const rootRel of this.resolveSkillDirs()) {
      const root = path.join(this.vaultPath, rootRel);
      if (!fs.existsSync(root)) continue;

      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const e of entries) {
        if (!e || String(e.name || "").startsWith(".")) continue;
        if (!e.isDirectory()) continue;
        if (isBundledSkillConflictCopySlug(e.name)) continue;
        if (seenIds.has(e.name) || bundledKeys.has(String(e.name).toLowerCase())) continue;
        const file = path.join(root, e.name, "SKILL.md");
        if (!fs.existsSync(file)) continue;

        const raw = fs.readFileSync(file, "utf8");
        const parsed = parseFrontmatter(raw);
        const skill = {
          id: e.name,
          slug: e.name,
          name: parsed.attrs.name || e.name,
          description: parsed.attrs.description || "",
          userInvocable: frontmatterBoolean(parsed.attrs, "user-invocable", true),
          disableModelInvocation: frontmatterBoolean(parsed.attrs, "disable-model-invocation", false),
          metadata: parsed.attrs.metadata && typeof parsed.attrs.metadata === "object" && !Array.isArray(parsed.attrs.metadata)
            ? parsed.attrs.metadata
            : undefined,
          completionPolicy: parseFlowNoteCompletionMetadata(parsed.attrs, { frontmatterError: parsed.errorCode }),
          content: raw,
          summary: summarizeBody(parsed.body),
          path: file,
          source: "vault",
        };
        if (skillIdentityKeys(skill).some((key) => bundledKeys.has(key))) continue;
        userSkills.push(skill);
        seenIds.add(e.name);
      }
    }

    const skills = mergeAuthoritativeSkillCatalog(userSkills);
    this.cache = skills;
    return skills;
  }

  resolveSkillDirs() {
    const primary = this.settings && typeof this.settings.skillsDir === "string"
      ? this.settings.skillsDir
      : "";
    const seen = new Set();
    return [primary, ...SUPPLEMENTAL_SKILL_DIRS]
      .map((item) => String(item || "").replace(/\\/g, "/").replace(/\/+$/, "").trim())
      .filter((item) => {
        if (!item || seen.has(item)) return false;
        seen.add(item);
        return true;
      });
  }

  getSkills() {
    return this.cache;
  }

  buildInjectedPrompt(skill, mode, userPrompt) {
    if (!skill || mode === "off") return userPrompt;

    if (mode === "full") {
      return [
        `你当前要遵循技能 ${skill.name}。`,
        "技能文档如下：",
        skill.content,
        "用户请求如下：",
        userPrompt,
      ].join("\n\n");
    }

    return [
      `你当前要遵循技能 ${skill.name}。`,
      `技能说明：${skill.description || "无"}`,
      "技能摘要：",
      skill.summary,
      "用户请求如下：",
      userPrompt,
    ].join("\n\n");
  }
}

module.exports = {
  SkillService,
  copyDirectoryRecursive,
};
