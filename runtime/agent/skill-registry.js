// Skill registry — load `SKILL.md` files from a vault subdirectory and
// expose them to the agent.
//
// A skill is a folder with a `SKILL.md` file. The frontmatter declares
// the skill's identity; the body is a markdown instruction that gets
// injected into the next turn when the model calls `skill_invoke`.
//
// We deliberately keep the format compatible with what the user already
// has under `.opencode/skills/` (the OpenCode / Anthropic Agent Skills
// convention): frontmatter keys are `name`, `description`, and
// optionally `when_to_use`, `argument-hint`, `arguments`, `model`,
// `allowed-tools`, `user-invocable`, `disable-model-invocation`. We do
// NOT execute embedded shell commands — Obsidian's vault is sandboxed
// and we don't want a skill author to accidentally `rm -rf` anything.
//
// This module has zero Obsidian deps; the caller passes in a vault-like
// object with `listFiles()` and `readFile(path)` so unit tests can use
// in-memory fakes.

/**
 * @typedef {Object} SkillManifest
 * @property {string} name              kebab-case skill id (also the dir name)
 * @property {string} description       1-2 sentence "what this skill does"
 * @property {string} body              raw markdown body (no frontmatter)
 * @property {string} dirPath           vault path of the skill's directory
 * @property {string} [whenToUse]       optional "when_to_use" hint
 * @property {string} [argumentHint]    placeholder shown next to `/skill-name`
 * @property {string[]} [argumentNames] positional argument names
 * @property {string[]} [allowedTools]  whitelist; if set, skill_invoke will narrow the tool surface
 * @property {boolean} [disableModelInvocation]  hide from skill_invoke list (user-invocable only)
 * @property {boolean} [userInvocable]  default true
 */

// Per-entry hard cap for the discovery listing the model sees. Verbose
// "when_to_use" strings waste tokens on every turn without improving
// match rate, since the body is only loaded on invoke.
const MAX_LISTING_DESC_CHARS = 250;

// Front matter parsing — we accept the YAML-subset commonly used in
// Anthropic skill manifests: `key: value` and `key: [a, b, c]`. We do
// NOT pull in a full YAML dependency; the format is intentionally flat.
function parseFrontmatter(raw) {
  const out = { frontmatter: {}, body: raw };
  if (!raw.startsWith("---")) return out;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return out;
  const fmText = raw.slice(3, end).replace(/^\r?\n/, "");
  // Strip any blank lines between the closing `---` and the start of the body.
  const body = raw.slice(end + 4).replace(/^(?:\r?\n)+/, "");
  const fm = {};
  for (const rawLine of fmText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      fm[key] = value.slice(1, -1);
    } else if (value === "true" || value === "false") {
      fm[key] = value === "true";
    } else {
      fm[key] = value;
    }
  }
  return { frontmatter: fm, body };
}

function parseArgumentNames(spec) {
  if (Array.isArray(spec)) return spec.map(String).filter(Boolean);
  if (typeof spec === "string") {
    return spec
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function truncate(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Substitute `$ARGUMENTS` (the whole arg string) and `$1`, `$2`, ... or
 * `${name}` placeholders inside the skill body. If the model passed
 * `args` as a single string, it's split on whitespace for the positional
 * substitutions; the full string is always available as `$ARGUMENTS`.
 *
 * @param {string} body
 * @param {string} argsString
 * @param {string[]} argNames
 * @returns {string}
 */
function substituteArguments(body, argsString, argNames) {
  if (typeof body !== "string") return "";
  const args = String(argsString || "");
  let out = body.replace(/\$ARGUMENTS\b/g, args);
  const parts = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const re = new RegExp(`\\$${i + 1}\\b`, "g");
    out = out.replace(re, parts[i]);
  }
  if (Array.isArray(argNames)) {
    for (let i = 0; i < argNames.length; i++) {
      const name = argNames[i];
      if (!name) continue;
      const re = new RegExp(`\\$\\{${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`, "g");
      out = out.replace(re, parts[i] || "");
    }
  }
  return out;
}

/**
 * Load every SKILL.md under `rootPath` (one level deep — each subdir
 * holds at most one SKILL.md). Quietly skips any directory that has no
 * SKILL.md or whose frontmatter is missing the required `name` field.
 *
 * @param {Object}   deps
 * @param {string}   deps.rootPath        vault-relative root, e.g. ".opencode/skills"
 * @param {Object}   deps.vault           must expose `listSkillDirs(rootPath)` or
 *                                       `getAllLoadedFiles()`/`adapter.exists`/
 *                                       `adapter.read`/`adapter.list` (Obsidian shape)
 * @returns {Promise<SkillManifest[]>}
 */
async function loadSkills({ rootPath, vault } = {}) {
  if (!rootPath || typeof rootPath !== "string") {
    throw new Error("loadSkills: rootPath required");
  }
  if (!vault) throw new Error("loadSkills: vault required");

  const skillFiles = await enumerateSkillFiles(rootPath, vault);
  const out = [];
  for (const { dirPath, filePath } of skillFiles) {
    try {
      const raw = await readFile(vault, filePath);
      if (typeof raw !== "string") continue;
      const { frontmatter, body } = parseFrontmatter(raw);
      const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : dirNameOf(dirPath);
      if (!name) continue;
      const description = typeof frontmatter.description === "string"
        ? frontmatter.description.trim()
        : "";
      const manifest = {
        name,
        description,
        body,
        dirPath,
        whenToUse: typeof frontmatter.when_to_use === "string" ? frontmatter.when_to_use : undefined,
        argumentHint:
          typeof frontmatter["argument-hint"] === "string"
            ? frontmatter["argument-hint"]
            : undefined,
        argumentNames: parseArgumentNames(frontmatter.arguments),
        allowedTools: Array.isArray(frontmatter["allowed-tools"])
          ? frontmatter["allowed-tools"]
          : typeof frontmatter["allowed-tools"] === "string"
            ? parseArgumentNames(frontmatter["allowed-tools"])
            : undefined,
        disableModelInvocation:
          frontmatter["disable-model-invocation"] === true ||
          frontmatter["disable-model-invocation"] === "true",
        userInvocable:
          frontmatter["user-invocable"] === false ||
          frontmatter["user-invocable"] === "false"
            ? false
            : true,
      };
      out.push(manifest);
    } catch {
      // Skip unreadable / malformed skill silently. A failing skill
      // should not break agent startup.
    }
  }
  // Sort by name for stable listings.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function dirNameOf(dirPath) {
  const cleaned = String(dirPath || "").replace(/\/+$/, "");
  const slash = cleaned.lastIndexOf("/");
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
}

async function enumerateSkillFiles(rootPath, vault) {
  // Preferred shape: test fakes provide `listSkillDirs(rootPath) → [{dirPath, filePath}]`.
  if (typeof vault.listSkillDirs === "function") {
    return vault.listSkillDirs(rootPath) || [];
  }
  // Obsidian shape: walk the adapter.
  if (vault.adapter && typeof vault.adapter.list === "function") {
    let entry;
    try {
      entry = await vault.adapter.list(rootPath);
    } catch {
      return [];
    }
    if (!entry || !Array.isArray(entry.folders)) return [];
    const out = [];
    for (const folder of entry.folders) {
      const filePath = `${folder.replace(/\/+$/, "")}/SKILL.md`;
      const exists =
        typeof vault.adapter.exists === "function" ? await vault.adapter.exists(filePath) : true;
      if (exists) out.push({ dirPath: folder, filePath });
    }
    return out;
  }
  // Fallback: scan getAllLoadedFiles for any path ending in /SKILL.md
  // under rootPath. Cheap and works for any vault.
  if (typeof vault.getAllLoadedFiles === "function") {
    const all = vault.getAllLoadedFiles() || [];
    const prefix = rootPath.replace(/\/+$/, "") + "/";
    const out = [];
    for (const f of all) {
      if (!f || typeof f.path !== "string") continue;
      if (!f.path.startsWith(prefix)) continue;
      if (!/\/SKILL\.md$/i.test(f.path)) continue;
      const dirPath = f.path.replace(/\/SKILL\.md$/i, "");
      out.push({ dirPath, filePath: f.path });
    }
    return out;
  }
  return [];
}

async function readFile(vault, filePath) {
  if (typeof vault.readFile === "function") {
    return await vault.readFile(filePath);
  }
  if (vault.adapter && typeof vault.adapter.read === "function") {
    return await vault.adapter.read(filePath);
  }
  if (typeof vault.getFileByPath === "function" && typeof vault.cachedRead === "function") {
    const f = vault.getFileByPath(filePath);
    if (!f) return null;
    return await vault.cachedRead(f);
  }
  throw new Error(`loadSkills: no readFile API for ${filePath}`);
}

/**
 * Build the short skill listing the model sees in its system prompt.
 * Skills with `disableModelInvocation: true` are omitted.
 *
 * @param {SkillManifest[]} skills
 * @returns {string}
 */
function formatSkillListing(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return "";
  const lines = [];
  for (const s of skills) {
    if (s.disableModelInvocation) continue;
    const desc = s.whenToUse
      ? `${s.description} — ${s.whenToUse}`
      : s.description;
    lines.push(`- ${s.name}: ${truncate(desc, MAX_LISTING_DESC_CHARS)}`);
  }
  return lines.join("\n");
}

/**
 * Manifest index keyed by name. Used by skill_invoke to look up a skill
 * at call time without re-reading the disk.
 */
class SkillRegistry {
  constructor(manifests) {
    /** @type {Map<string, SkillManifest>} */
    this._byName = new Map();
    for (const m of manifests || []) {
      if (m && m.name) this._byName.set(m.name, m);
    }
  }
  get(name) {
    return this._byName.get(String(name || ""));
  }
  list() {
    return Array.from(this._byName.values());
  }
  size() {
    return this._byName.size;
  }
  /**
   * Subset of skill manifests that the model is allowed to invoke.
   * @returns {SkillManifest[]}
   */
  modelInvocable() {
    return this.list().filter((s) => !s.disableModelInvocation);
  }
}

module.exports = {
  loadSkills,
  parseFrontmatter,
  parseArgumentNames,
  substituteArguments,
  formatSkillListing,
  SkillRegistry,
  MAX_LISTING_DESC_CHARS,
};
