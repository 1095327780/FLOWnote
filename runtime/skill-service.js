const fs = require("fs");
const path = require("path");

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { attrs: {}, body: md };

  const attrs = {};
  const lines = m[1].split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const i = line.indexOf(":");
    if (i <= 0) continue;

    const key = line.slice(0, i).trim();
    const rawValue = line.slice(i + 1).trim();

    const blockScalar = rawValue.match(/^([>|])([+-])?$/);
    if (blockScalar) {
      const block = [];
      idx += 1;
      while (idx < lines.length) {
        const next = lines[idx];
        if (!/^\s+/.test(next)) {
          idx -= 1;
          break;
        }
        block.push(next.replace(/^\s+/, ""));
        idx += 1;
      }
      attrs[key] = block.join("\n").trim();
      continue;
    }

    attrs[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }

  return { attrs, body: md.slice(m[0].length) };
}

function summarizeBody(body) {
  return body
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 18)
    .join("\n");
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
    const normalized = ids
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    this.allowedSkillIds = new Set(normalized);
  }

  loadSkills() {
    const root = path.join(this.vaultPath, this.settings.skillsDir);
    if (!fs.existsSync(root)) {
      this.cache = [];
      return this.cache;
    }

    const entries = fs.readdirSync(root, { withFileTypes: true });
    const allow = this.allowedSkillIds instanceof Set
      ? this.allowedSkillIds
      : null;
    const skills = [];

    for (const e of entries) {
      if (!e || String(e.name || "").startsWith(".")) continue;
      if (!e.isDirectory()) continue;
      if (allow && !allow.has(e.name)) continue;
      const file = path.join(root, e.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;

      const raw = fs.readFileSync(file, "utf8");
      const parsed = parseFrontmatter(raw);
      skills.push({
        id: e.name,
        name: parsed.attrs.name || e.name,
        description: parsed.attrs.description || "",
        metadata: parsed.attrs,
        content: raw,
        summary: summarizeBody(parsed.body),
        path: file,
      });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = skills;
    return skills;
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
