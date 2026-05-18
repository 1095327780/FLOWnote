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
 * @property {string} [slug]            folder name; used as a stable alias
 * @property {string} dirPath           vault path of the skill's directory
 * @property {string[]} [aliases]       alternate names accepted by skill_invoke
 * @property {string} [whenToUse]       optional "when_to_use" hint
 * @property {string} [argumentHint]    placeholder shown next to `/skill-name`
 * @property {string[]} [argumentNames] positional argument names
 * @property {string[]} [allowedTools]  declared tool permissions from the skill frontmatter
 * @property {string[]} [resourcePaths] skill-relative files available via skill_resource_read
 * @property {Object<string,string>} [embeddedResourceFiles] skill-relative files compiled into the plugin
 * @property {string} [version]
 * @property {string} [model]
 * @property {string} [context]
 * @property {string} [agent]
 * @property {string[]} [paths]
 * @property {boolean} [disableModelInvocation]  hide from skill_invoke list (user-invocable only)
 * @property {boolean} [userInvocable]  default true
 */

// Per-entry hard cap for the discovery listing the model sees. Verbose
// "when_to_use" strings waste tokens on every turn without improving
// match rate, since the body is only loaded on invoke.
const MAX_LISTING_DESC_CHARS = 250;
const MAX_RESOURCE_LISTING = 200;

// Front matter parsing — we accept the YAML-subset commonly used in
// Anthropic skill manifests: `key: value` and `key: [a, b, c]`. We do
// NOT pull in a full YAML dependency; the format is intentionally flat.
function parseFrontmatter(raw) {
  const out = { frontmatter: {}, body: raw };
  if (!raw.startsWith("---")) return out;
  const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) return out;
  const fmText = match[1] || "";
  // Strip any blank lines between the closing `---` and the start of the body.
  const body = raw.slice(match[0].length).replace(/^(?:\r?\n)+/, "");
  const fm = {};
  const lines = fmText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\s/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key) continue;

    if (value === "|" || value === ">") {
      const block = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() && !/^\s/.test(next)) break;
        block.push(next.replace(/^\s{2}/, ""));
      }
      fm[key] = value === ">" ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trimEnd();
      i = j - 1;
      continue;
    }

    if (value === "") {
      const list = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j].replace(/\s+$/, "");
        if (!next.trim()) continue;
        const item = next.match(/^\s*-\s*(.*)$/);
        if (item) {
          list.push(parseFrontmatterScalar(item[1].trim()));
          continue;
        }
        if (/^\s/.test(next)) continue;
        break;
      }
      if (list.length > 0) {
        fm[key] = list.map(String).filter(Boolean);
        i = j - 1;
        continue;
      }
    }

    fm[key] = parseFrontmatterScalar(value);
  }
  return { frontmatter: fm, body };
}

function parseFrontmatterScalar(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitDelimitedList(value.slice(1, -1), { splitOnSpace: false })
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);
  }
  const stripped = stripQuotes(value);
  if (stripped === "true" || stripped === "false") return stripped === "true";
  return stripped;
}

function stripQuotes(value) {
  const s = String(value || "");
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function splitDelimitedList(value, opts = {}) {
  const splitOnSpace = opts.splitOnSpace !== false;
  const out = [];
  let current = "";
  let quote = "";
  let parens = 0;
  for (const char of String(value || "")) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      parens += 1;
      current += char;
      continue;
    }
    if (char === ")" && parens > 0) {
      parens -= 1;
      current += char;
      continue;
    }
    if ((char === "," || (splitOnSpace && /\s/.test(char))) && parens === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
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

function parseStringList(spec) {
  if (Array.isArray(spec)) {
    return spec.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof spec === "string") {
    return splitDelimitedList(spec, { splitOnSpace: false })
      .map((s) => stripQuotes(s).trim())
      .filter(Boolean);
  }
  return [];
}

function parseToolList(spec) {
  if (spec === undefined || spec === null || spec === "") return undefined;
  const chunks = Array.isArray(spec) ? spec.map(String) : [String(spec)];
  const tools = [];
  for (const chunk of chunks) {
    tools.push(...splitDelimitedList(chunk, { splitOnSpace: true }).map(stripQuotes));
  }
  return tools.map((s) => String(s).trim()).filter(Boolean);
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function coerceString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coerceBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (value === true || value === false) return value;
  const s = String(value).trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return defaultValue;
}

function buildSkillManifest({ frontmatter, body, dirPath, filePath, resourcePaths, embeddedResourceFiles } = {}) {
  const slug = dirNameOf(dirPath || (filePath ? String(filePath).replace(/\/SKILL\.md$/i, "") : ""));
  const name = coerceString(firstDefined(frontmatter, ["name"])) || slug;
  const description = coerceString(firstDefined(frontmatter, ["description"])) || "";
  const allowedTools = parseToolList(firstDefined(frontmatter, ["allowed-tools", "allowed_tools", "allowedTools"]));
  const aliases = parseStringList(firstDefined(frontmatter, ["aliases", "alias"]));
  const paths = parseStringList(firstDefined(frontmatter, ["paths", "file-path-patterns", "file_path_patterns", "filePathPatterns"]));
  return {
    name,
    slug,
    description,
    body: body || "",
    dirPath,
    filePath,
    aliases,
    whenToUse: coerceString(firstDefined(frontmatter, ["when_to_use", "when-to-use", "whenToUse"])),
    argumentHint: coerceString(firstDefined(frontmatter, ["argument-hint", "argument_hint", "argumentHint"])),
    argumentNames: parseArgumentNames(firstDefined(frontmatter, ["arguments", "argNames", "argumentNames"])),
    allowedTools,
    resourcePaths: normalizeResourcePaths(resourcePaths),
    embeddedResourceFiles: embeddedResourceFiles && typeof embeddedResourceFiles === "object"
      ? embeddedResourceFiles
      : undefined,
    version: coerceString(firstDefined(frontmatter, ["version"])),
    model: coerceString(firstDefined(frontmatter, ["model"])),
    context: coerceString(firstDefined(frontmatter, ["context"])),
    agent: coerceString(firstDefined(frontmatter, ["agent"])),
    paths: paths.length > 0 ? paths : undefined,
    disableModelInvocation: coerceBoolean(
      firstDefined(frontmatter, ["disable-model-invocation", "disable_model_invocation", "disableModelInvocation"]),
      false,
    ),
    userInvocable: coerceBoolean(
      firstDefined(frontmatter, ["user-invocable", "user_invocable", "userInvocable"]),
      true,
    ),
  };
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
  for (const entry of skillFiles) {
    const { dirPath, filePath } = entry || {};
    try {
      const raw = await readFile(vault, filePath);
      if (typeof raw !== "string") continue;
      const { frontmatter, body } = parseFrontmatter(raw);
      const resourcePaths = Array.isArray(entry.resourcePaths)
        ? entry.resourcePaths
        : Array.isArray(entry.resources)
          ? entry.resources
          : await enumerateSkillResources(dirPath, vault);
      const manifest = buildSkillManifest({
        frontmatter,
        body,
        dirPath,
        filePath,
        resourcePaths,
      });
      if (!manifest.name) continue;
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

function normalizeSkillRelativePath(path) {
  const raw = String(path || "").trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) return null;
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function normalizeResourcePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths || []) {
    const rel = normalizeSkillRelativePath(p);
    if (!rel || /^SKILL\.md$/i.test(rel)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
    if (out.length >= MAX_RESOURCE_LISTING) break;
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function relativeToSkillDir(dirPath, filePath) {
  const dir = String(dirPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const file = String(filePath || "").replace(/\\/g, "/");
  const prefix = `${dir}/`;
  if (!file.startsWith(prefix)) return null;
  return normalizeSkillRelativePath(file.slice(prefix.length));
}

async function enumerateSkillResources(dirPath, vault) {
  if (!dirPath || !vault) return [];
  if (typeof vault.listSkillResources === "function") {
    return normalizeResourcePaths(await vault.listSkillResources(dirPath));
  }
  if (vault.adapter && typeof vault.adapter.list === "function") {
    return normalizeResourcePaths(await enumerateAdapterResources(vault.adapter, dirPath));
  }
  if (typeof vault.getAllLoadedFiles === "function") {
    const out = [];
    const prefix = dirPath.replace(/\/+$/, "") + "/";
    const all = vault.getAllLoadedFiles() || [];
    for (const f of all) {
      if (!f || typeof f.path !== "string") continue;
      if (!f.path.startsWith(prefix)) continue;
      const rel = relativeToSkillDir(dirPath, f.path);
      if (rel && !/^SKILL\.md$/i.test(rel)) out.push(rel);
    }
    return normalizeResourcePaths(out);
  }
  return [];
}

async function enumerateAdapterResources(adapter, dirPath) {
  const out = [];
  const stack = [String(dirPath || "").replace(/\/+$/, "")];
  const seenFolders = new Set();
  while (stack.length > 0 && out.length < MAX_RESOURCE_LISTING) {
    const cur = stack.pop();
    if (!cur || seenFolders.has(cur)) continue;
    seenFolders.add(cur);
    let entry;
    try {
      entry = await adapter.list(cur);
    } catch {
      continue;
    }
    for (const file of entry && Array.isArray(entry.files) ? entry.files : []) {
      const rel = relativeToSkillDir(dirPath, file);
      if (rel && !/^SKILL\.md$/i.test(rel)) out.push(rel);
      if (out.length >= MAX_RESOURCE_LISTING) break;
    }
    for (const folder of entry && Array.isArray(entry.folders) ? entry.folders : []) {
      if (stack.length + seenFolders.size > 1000) break;
      stack.push(folder);
    }
  }
  return out;
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
    /** @type {SkillManifest[]} */
    this._manifests = [];
    for (const m of manifests || []) {
      if (!m || !m.name) continue;
      this._manifests.push(m);
      this._indexName(m.name, m, true);
      this._indexName(m.slug, m, false);
      for (const alias of m.aliases || []) this._indexName(alias, m, false);
    }
  }
  _indexName(name, manifest, primary) {
    const key = normalizeSkillLookupName(name);
    if (!key) return;
    if (primary || !this._byName.has(key)) this._byName.set(key, manifest);
  }
  get(name) {
    return this._byName.get(normalizeSkillLookupName(name));
  }
  list() {
    return this._manifests.slice();
  }
  size() {
    return this._manifests.length;
  }
  /**
   * Subset of skill manifests that the model is allowed to invoke.
   * @returns {SkillManifest[]}
   */
  modelInvocable() {
    return this.list().filter((s) => !s.disableModelInvocation);
  }
}

function normalizeSkillLookupName(name) {
  return String(name || "").trim().replace(/^\/+/, "");
}

module.exports = {
  loadSkills,
  parseFrontmatter,
  parseArgumentNames,
  parseToolList,
  buildSkillManifest,
  normalizeSkillRelativePath,
  normalizeResourcePaths,
  readFile,
  substituteArguments,
  formatSkillListing,
  SkillRegistry,
  MAX_LISTING_DESC_CHARS,
  MAX_RESOURCE_LISTING,
};
