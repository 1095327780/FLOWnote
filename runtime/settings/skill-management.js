// Skill management — list / read / write / delete / import skill folders
// from the user's vault under `settings.skillsDir`. Settings UI calls
// these to power the "技能管理" section.
//
// All I/O goes through vault.adapter so this works on desktop AND
// mobile, the same path the agent-side SkillRegistry uses.
//
// Skill folder layout (matches Anthropic Agent Skills convention):
//   <skillsDir>/<slug>/SKILL.md     ← required, contains frontmatter
//   <skillsDir>/<slug>/references/  ← optional
//   <skillsDir>/<slug>/scripts/     ← optional

const { parseFrontmatter, parseToolList } = require("../agent/skill-registry");

const REQUIRED_FRONTMATTER_FIELDS = ["name", "description"];
const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_IMPORTED_SKILL_SLUG = "skill";
const PORTABLE_SKILL_ROOT = "skills";
const IGNORED_IMPORT_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const SUPPLEMENTAL_SKILL_ROOTS = [
  ".flownote/skills",
  ".opencode/skills",
  ".claude/skills",
  PORTABLE_SKILL_ROOT,
];
const SECRET_REF_RE = /\$(?:\{([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|KEY))\}|([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|KEY)))/g;
const embeddedBundledSkillsModule = (() => {
  try { return require("../generated/bundled-skills-embedded"); } catch { return {}; }
})();
const EMBEDDED_BUNDLED_SKILLS_FILES =
  embeddedBundledSkillsModule && embeddedBundledSkillsModule.EMBEDDED_BUNDLED_SKILLS_FILES
    ? embeddedBundledSkillsModule.EMBEDDED_BUNDLED_SKILLS_FILES
    : {};
const TEXT_IMPORT_EXTENSIONS = new Set([
  "",
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".lua",
  ".mjs",
  ".md",
  ".mdx",
  ".php",
  ".pl",
  ".ps1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

/**
 * @typedef {Object} SkillDoc
 * @property {string} slug           folder name (immutable; used as identity)
 * @property {string} name           frontmatter `name` (defaults to slug)
 * @property {string} description
 * @property {string} [whenToUse]
 * @property {string[]} [allowedTools]
 * @property {string} body
 * @property {string} dirPath        vault-relative dir
 * @property {string} filePath       vault-relative SKILL.md
 */

function defaultSkillsRoot(plugin) {
  const root = String((plugin && plugin.settings && plugin.settings.skillsDir) || "").trim();
  return root || ".flownote/skills";
}

function joinPath(a, b) {
  return `${String(a).replace(/\/+$/, "")}/${String(b).replace(/^\/+/, "")}`;
}

function parentPath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

/**
 * Validate a candidate slug for a new skill folder. Allows lowercase
 * letters, digits, hyphens. Frontmatter `name` can be free-form; the
 * slug is the folder name and must be filesystem-safe across platforms.
 *
 * @param {string} slug
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validateSlug(slug) {
  const s = String(slug || "").trim();
  if (!s) return { ok: false, error: "slug 不能为空" };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) {
    return {
      ok: false,
      error: "slug 只能包含小写字母、数字、连字符；必须以字母或数字开头",
    };
  }
  if (s.length > 64) return { ok: false, error: "slug 长度不能超过 64 字符" };
  return { ok: true };
}

/**
 * Enumerate all skill folders under `settings.skillsDir` and return
 * parsed SkillDoc objects, sorted by name. Quietly skips malformed
 * entries (no SKILL.md, no `name` frontmatter) so the UI never crashes
 * because of a single bad folder.
 *
 * @param {Object} plugin
 * @returns {Promise<SkillDoc[]>}
 */
async function listSkills(plugin) {
  const root = defaultSkillsRoot(plugin);
  return listSkillsUnderRoot(plugin, root);
}

async function listSkillsUnderRoot(plugin, root) {
  const adapter = plugin && plugin.app && plugin.app.vault && plugin.app.vault.adapter;
  if (!adapter || typeof adapter.list !== "function") return [];
  let listing;
  try { listing = await adapter.list(root); } catch { return []; }
  if (!listing || !Array.isArray(listing.folders)) return [];

  const out = [];
  for (const folder of listing.folders) {
    const filePath = joinPath(folder, "SKILL.md");
    let exists = false;
    try { exists = await adapter.exists(filePath); } catch { exists = false; }
    if (!exists) continue;
    try {
      const raw = await adapter.read(filePath);
      const { frontmatter, body } = parseFrontmatter(raw);
      const slug = folder.split("/").pop() || folder;
      const name = String(frontmatter.name || slug).trim();
      const description = String(frontmatter.description || "").trim();
      out.push({
        slug,
        name,
        description,
        whenToUse: frontmatter.when_to_use || frontmatter["when-to-use"] || frontmatter.whenToUse
          ? String(frontmatter.when_to_use || frontmatter["when-to-use"] || frontmatter.whenToUse)
          : undefined,
        allowedTools: parseToolList(frontmatter["allowed-tools"] || frontmatter.allowed_tools || frontmatter.allowedTools),
        body: body || "",
        dirPath: folder,
        filePath,
        sourceRoot: root,
        readOnly: false,
      });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function resolveAvailableSkillRoots(plugin) {
  const roots = [defaultSkillsRoot(plugin), ...SUPPLEMENTAL_SKILL_ROOTS];
  const seen = new Set();
  return roots
    .map((root) => String(root || "").replace(/\\/g, "/").replace(/\/+$/, "").trim())
    .filter((root) => {
      if (!root || seen.has(root)) return false;
      seen.add(root);
      return true;
    });
}

/**
 * List skills for the settings UI. Unlike listSkills(), this scans all
 * known vault roots and embedded bundled skills so mobile users don't
 * see an empty manager when the primary dotfolder failed to sync.
 *
 * @param {Object} plugin
 * @returns {Promise<SkillDoc[]>}
 */
async function listSkillManagementEntries(plugin) {
  const primaryRoot = defaultSkillsRoot(plugin);
  const bySlug = new Map();
  for (const root of resolveAvailableSkillRoots(plugin)) {
    const skills = await listSkillsUnderRoot(plugin, root);
    for (const skill of skills) {
      const slug = String(skill.slug || "").trim();
      if (!slug || bySlug.has(slug)) continue;
      bySlug.set(slug, {
        ...skill,
        sourceRoot: root,
        readOnly: root !== primaryRoot,
      });
    }
  }
  for (const embedded of listEmbeddedSkillDocs()) {
    if (!embedded.slug || bySlug.has(embedded.slug)) continue;
    bySlug.set(embedded.slug, embedded);
  }
  return Array.from(bySlug.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listEmbeddedSkillDocs() {
  const out = [];
  const seen = new Set();
  for (const filePath of Object.keys(EMBEDDED_BUNDLED_SKILLS_FILES)) {
    if (!filePath.endsWith("/SKILL.md")) continue;
    const slug = filePath.split("/")[0];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    try {
      const raw = String(EMBEDDED_BUNDLED_SKILLS_FILES[filePath] || "");
      const { frontmatter, body } = parseFrontmatter(raw);
      out.push({
        slug,
        name: String(frontmatter.name || slug).trim(),
        description: String(frontmatter.description || "").trim(),
        whenToUse: frontmatter.when_to_use || frontmatter["when-to-use"] || frontmatter.whenToUse
          ? String(frontmatter.when_to_use || frontmatter["when-to-use"] || frontmatter.whenToUse)
          : undefined,
        allowedTools: parseToolList(frontmatter["allowed-tools"] || frontmatter.allowed_tools || frontmatter.allowedTools),
        body: body || "",
        dirPath: `<embedded>/${slug}`,
        filePath: `<embedded>/${slug}/SKILL.md`,
        sourceRoot: "<embedded>",
        readOnly: true,
        embedded: true,
      });
    } catch { /* skip malformed embedded skill */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function resolveSecretScanRoots(plugin) {
  return resolveAvailableSkillRoots(plugin);
}

function extractSkillSecretRefsFromText(text) {
  const out = new Set();
  const raw = String(text || "");
  SECRET_REF_RE.lastIndex = 0;
  let match;
  while ((match = SECRET_REF_RE.exec(raw))) {
    const name = match[1] || match[2];
    if (name) out.add(name);
  }
  return Array.from(out).sort();
}

/**
 * Scan installed skill docs for env-style secret placeholders, e.g.
 * `$WEREAD_API_KEY`. The settings UI uses this to render password
 * fields only when a skill actually needs one.
 *
 * @param {Object} plugin
 * @returns {Promise<string[]>}
 */
async function listSkillSecretRefs(plugin) {
  const refs = new Set();
  for (const root of resolveSecretScanRoots(plugin)) {
    const skills = await listSkillsUnderRoot(plugin, root);
    for (const skill of skills) {
      for (const name of extractSkillSecretRefsFromText([
        skill.name,
        skill.description,
        skill.whenToUse || "",
        skill.body || "",
      ].join("\n"))) {
        refs.add(name);
      }
    }
  }
  return Array.from(refs).sort();
}

/**
 * Read a single skill by slug. Returns null if not found.
 *
 * @param {Object} plugin
 * @param {string} slug
 * @returns {Promise<SkillDoc | null>}
 */
async function readSkill(plugin, slug) {
  const list = await listSkills(plugin);
  return list.find((s) => s.slug === slug) || null;
}

/**
 * Render a SkillDoc as the SKILL.md file body. Frontmatter fields are
 * written in a stable order — name first, then description, then
 * optional fields — so future diffs are clean.
 *
 * @param {SkillDoc & { allowedTools?: string[], whenToUse?: string }} doc
 * @returns {string}
 */
function renderSkillMarkdown(doc) {
  const fm = [];
  fm.push(`name: ${yamlScalar(doc.name)}`);
  fm.push(`description: ${yamlScalar(doc.description || "")}`);
  if (doc.whenToUse) fm.push(`when_to_use: ${yamlScalar(doc.whenToUse)}`);
  if (Array.isArray(doc.allowedTools) && doc.allowedTools.length > 0) {
    fm.push(`allowed-tools: [${doc.allowedTools.map((t) => yamlScalar(t)).join(", ")}]`);
  }
  const body = typeof doc.body === "string" ? doc.body : "";
  return `---\n${fm.join("\n")}\n---\n\n${body.replace(/^\s+/, "")}\n`;
}

function yamlScalar(value) {
  const s = String(value || "");
  // Quote if contains newline, leading/trailing whitespace, colon, special
  // YAML tokens, or a comma (lists). Otherwise leave bare.
  if (s === "" || /[\n:#&*!|>%@`?"']/.test(s) || /^\s|\s$/.test(s) || /^[-?\[\]{}]/.test(s) || s === "true" || s === "false" || /^-?\d/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Create or overwrite a skill folder + its SKILL.md.
 * `existingSlug` (optional) lets the caller rename a skill: if provided
 * and differs from `doc.slug`, the old folder is deleted after the new
 * one is written.
 *
 * Validates slug + required frontmatter fields. Throws on bad input.
 *
 * @param {Object} plugin
 * @param {SkillDoc} doc
 * @param {string} [existingSlug]
 * @returns {Promise<{filePath: string, created: boolean, renamed: boolean}>}
 */
async function saveSkill(plugin, doc, existingSlug) {
  if (!doc || typeof doc !== "object") throw new Error("saveSkill: doc required");
  const slugCheck = validateSlug(doc.slug);
  if (!slugCheck.ok) throw new Error(slugCheck.error);
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    const v = doc[field === "name" ? "name" : field];
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`${field} 不能为空`);
    }
  }
  const adapter = plugin.app.vault.adapter;
  if (!adapter) throw new Error("saveSkill: no vault adapter");

  const root = defaultSkillsRoot(plugin);
  const dirPath = joinPath(root, doc.slug);
  const filePath = joinPath(dirPath, "SKILL.md");
  const renaming = !!(existingSlug && existingSlug !== doc.slug);

  // Guard against collisions when creating or renaming.
  const targetExists = await adapter.exists(filePath);
  if (targetExists && (!existingSlug || renaming)) {
    throw new Error(`已存在同名技能 "${doc.slug}"`);
  }

  if (renaming) {
    const oldDir = joinPath(root, existingSlug);
    const oldExists = await adapter.exists(oldDir).catch(() => false);
    if (oldExists) {
      await moveFolderRecursive(adapter, oldDir, dirPath);
    } else {
      await ensureDirectoryPath(adapter, dirPath);
    }
  } else {
    await ensureDirectoryPath(adapter, dirPath);
  }
  const content = renderSkillMarkdown(doc);
  await adapter.write(filePath, content);

  await refreshSkillCaches(plugin);

  return { filePath, created: !targetExists, renamed: renaming };
}

/**
 * Delete a skill folder. Returns false if the folder didn't exist.
 *
 * @param {Object} plugin
 * @param {string} slug
 * @returns {Promise<boolean>}
 */
async function deleteSkill(plugin, slug) {
  const slugCheck = validateSlug(slug);
  if (!slugCheck.ok) throw new Error(slugCheck.error);
  const adapter = plugin.app.vault.adapter;
  const root = defaultSkillsRoot(plugin);
  const dir = joinPath(root, slug);
  const exists = await adapter.exists(dir);
  if (!exists) return false;
  await deleteFolderRecursive(adapter, dir);
  await refreshSkillCaches(plugin);
  return true;
}

/**
 * Import one or more complete skill folders from a browser FileList.
 *
 * The selected folder may be:
 *   - a single skill folder containing SKILL.md at its root;
 *   - a skills root containing many <slug>/SKILL.md folders;
 *   - a wrapper such as .claude/skills or .opencode/skills.
 *
 * Existing target skill folders are skipped by default. Pass
 * `{ overwrite: true }` from trusted UI if an explicit replace flow is
 * added later.
 *
 * @param {Object} plugin
 * @param {FileList | File[] | Array<Object>} fileList
 * @param {{ overwrite?: boolean }} [options]
 * @returns {Promise<{
 *   targetRoot: string,
 *   imported: number,
 *   skipped: number,
 *   files: number,
 *   importedSkills: Array<{slug: string, dirPath: string}>,
 *   skippedSkills: Array<{slug: string, reason: string}>,
 *   errors: string[]
 * }>}
 */
async function importSkillsFromFileList(plugin, fileList, options = {}) {
  const adapter = plugin && plugin.app && plugin.app.vault && plugin.app.vault.adapter;
  if (!adapter) throw new Error("importSkillsFromFileList: no vault adapter");
  if (typeof adapter.write !== "function" || typeof adapter.mkdir !== "function") {
    throw new Error("当前环境不支持写入技能文件");
  }

  const root = defaultSkillsRoot(plugin);
  const plan = discoverSkillImportsFromFileList(fileList);
  const result = {
    targetRoot: root,
    mirrorRoot: shouldMirrorToPortableRoot(root) ? PORTABLE_SKILL_ROOT : "",
    imported: 0,
    skipped: 0,
    mirrored: 0,
    files: 0,
    importedSkills: [],
    skippedSkills: [],
    errors: [...plan.errors],
  };

  if (plan.imports.length === 0) return result;

  await ensureDirectoryPath(adapter, root);

  for (const skillImport of plan.imports) {
    const targetDir = joinPath(root, skillImport.slug);
    let targetExists = false;
    try { targetExists = await adapter.exists(targetDir); } catch { targetExists = false; }
    if (targetExists && !options.overwrite) {
      result.skipped += 1;
      result.skippedSkills.push({
        slug: skillImport.slug,
        reason: "已存在同名技能，未覆盖",
      });
      continue;
    }

    try {
      if (targetExists && options.overwrite) {
        await deleteFolderRecursive(adapter, targetDir);
      }
      await ensureDirectoryPath(adapter, targetDir);
      for (const entry of skillImport.files) {
        const targetPath = joinPath(targetDir, entry.relativePath);
        await ensureDirectoryPath(adapter, parentPath(targetPath));
        const payload = await readImportFilePayload(entry.file, entry.relativePath);
        if (payload.binary) {
          if (typeof adapter.writeBinary !== "function") {
            throw new Error(`当前环境不支持写入二进制文件：${entry.relativePath}`);
          }
          await adapter.writeBinary(targetPath, payload.data);
        } else {
          await adapter.write(targetPath, payload.data);
        }
        result.files += 1;
      }
      result.imported += 1;
      result.importedSkills.push({ slug: skillImport.slug, dirPath: targetDir });
      if (result.mirrorRoot) {
        const mirrored = await mirrorImportedSkillToPortableRoot(adapter, targetDir, skillImport.slug, options);
        if (mirrored) result.mirrored += 1;
      }
    } catch (e) {
      result.errors.push(`${skillImport.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (result.imported > 0) {
    await refreshSkillCaches(plugin);
  }
  return result;
}

function shouldMirrorToPortableRoot(root) {
  const normalized = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
  if (!normalized || normalized === PORTABLE_SKILL_ROOT) return false;
  return normalized.split("/").some((part) => part.startsWith("."));
}

async function mirrorImportedSkillToPortableRoot(adapter, sourceDir, slug, options = {}) {
  if (!adapter || !slug || !sourceDir) return false;
  const targetDir = joinPath(PORTABLE_SKILL_ROOT, slug);
  let exists = false;
  try { exists = await adapter.exists(targetDir); } catch { exists = false; }
  if (exists && !options.overwrite) return false;
  if (exists && options.overwrite) {
    await deleteFolderRecursive(adapter, targetDir);
  }
  await copyFolderRecursive(adapter, sourceDir, targetDir);
  return true;
}

/**
 * Build an import plan from browser File objects. Kept pure/sync so unit
 * tests can exercise skill-root discovery without touching Obsidian.
 *
 * @param {FileList | File[] | Array<Object>} fileList
 * @returns {{ imports: Array<{ slug: string, sourceRoot: string, files: Array<{ relativePath: string, file: Object }> }>, ignored: number, errors: string[] }}
 */
function discoverSkillImportsFromFileList(fileList) {
  const rawFiles = Array.from(fileList || []);
  const errors = [];
  const entries = [];
  let ignored = 0;

  for (const file of rawFiles) {
    const normalized = normalizeImportFilePath(file);
    if (!normalized) {
      ignored += 1;
      continue;
    }
    entries.push({
      file,
      originalPath: normalized.path,
      segments: normalized.segments,
    });
  }

  if (entries.length === 0) {
    return {
      imports: [],
      ignored,
      errors: rawFiles.length > 0 ? ["未找到可导入的技能文件"] : [],
    };
  }

  const stripped = stripCommonDirectoryRoot(entries);
  const relativeEntries = stripped.entries.map((entry) => ({
    ...entry,
    path: entry.segments.join("/"),
  }));
  const rootSegmentsList = findSkillRootSegments(relativeEntries);

  if (rootSegmentsList.length === 0) {
    return {
      imports: [],
      ignored,
      errors: ["所选文件夹中没有找到 SKILL.md"],
    };
  }

  const usedSlugs = new Set();
  const imports = [];
  for (const rootSegments of rootSegmentsList) {
    const sourceRoot = rootSegments.join("/");
    const sourceName = rootSegments.length > 0
      ? rootSegments[rootSegments.length - 1]
      : stripped.selectedRootName;
    const slug = uniqueSlug(sanitizeSkillSlug(sourceName), usedSlugs);
    const files = [];
    for (const entry of relativeEntries) {
      if (!startsWithSegments(entry.segments, rootSegments)) continue;
      const relSegments = entry.segments.slice(rootSegments.length);
      if (relSegments.length === 0 || shouldIgnoreImportSegments(relSegments)) {
        ignored += 1;
        continue;
      }
      files.push({
        relativePath: relSegments.join("/"),
        file: entry.file,
      });
    }
    if (!files.some((f) => f.relativePath === SKILL_FILE_NAME)) {
      errors.push(`${sourceRoot || sourceName || slug}: 缺少 SKILL.md`);
      continue;
    }
    imports.push({ slug, sourceRoot, files });
  }

  return { imports, ignored, errors };
}

function normalizeImportFilePath(file) {
  const fromDirectoryPicker = file && typeof file.webkitRelativePath === "string"
    ? file.webkitRelativePath
    : "";
  const raw = fromDirectoryPicker.trim()
    || (file && typeof file.name === "string" ? file.name : "");
  const segments = normalizeImportPathSegments(raw);
  if (!segments || shouldIgnoreImportSegments(segments)) return null;
  return { path: segments.join("/"), segments };
}

function normalizeImportPathSegments(path) {
  const raw = String(path || "").replace(/\\/g, "/").trim();
  if (!raw) return null;
  const segments = raw.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.includes("\0")) return null;
  }
  return segments;
}

function shouldIgnoreImportSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return true;
  if (segments.includes("__MACOSX")) return true;
  const fileName = segments[segments.length - 1];
  return IGNORED_IMPORT_FILE_NAMES.has(fileName);
}

function stripCommonDirectoryRoot(entries) {
  const dirSegments = entries
    .map((entry) => entry.segments.slice(0, -1))
    .filter((segments) => segments.length > 0);
  if (dirSegments.length === 0) {
    return {
      entries: entries.map((entry) => ({ ...entry, segments: [...entry.segments] })),
      selectedRootName: "",
    };
  }

  let prefix = [...dirSegments[0]];
  for (const segments of dirSegments.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < segments.length && prefix[i] === segments[i]) i += 1;
    prefix = prefix.slice(0, i);
  }

  if (prefix.length === 0) {
    const first = entries[0] && entries[0].segments && entries[0].segments[0];
    return {
      entries: entries.map((entry) => ({ ...entry, segments: [...entry.segments] })),
      selectedRootName: first || "",
    };
  }

  return {
    entries: entries.map((entry) => ({
      ...entry,
      segments: entry.segments.slice(prefix.length),
    })),
    selectedRootName: prefix[prefix.length - 1] || "",
  };
}

function findSkillRootSegments(entries) {
  const keys = new Set();
  const roots = [];
  for (const entry of entries) {
    if (!entry.segments || entry.segments[entry.segments.length - 1] !== SKILL_FILE_NAME) continue;
    const root = entry.segments.slice(0, -1);
    const key = root.join("/");
    if (keys.has(key)) continue;
    keys.add(key);
    roots.push(root);
  }

  roots.sort((a, b) => a.length - b.length || a.join("/").localeCompare(b.join("/")));
  const filtered = [];
  for (const root of roots) {
    if (filtered.some((parent) => startsWithSegments(root, parent))) continue;
    filtered.push(root);
  }
  return filtered;
}

function startsWithSegments(segments, prefix) {
  if (!Array.isArray(segments) || !Array.isArray(prefix)) return false;
  if (prefix.length > segments.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (segments[i] !== prefix[i]) return false;
  }
  return true;
}

function sanitizeSkillSlug(value) {
  const source = String(value || "").trim().toLowerCase();
  const cleaned = source
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  const slug = cleaned || DEFAULT_IMPORTED_SKILL_SLUG;
  return validateSlug(slug).ok ? slug : DEFAULT_IMPORTED_SKILL_SLUG;
}

function uniqueSlug(baseSlug, used) {
  const base = validateSlug(baseSlug).ok ? baseSlug : DEFAULT_IMPORTED_SKILL_SLUG;
  let slug = base;
  let i = 2;
  while (used.has(slug)) {
    const suffix = `-${i}`;
    const trimmedBase = base.slice(0, Math.max(1, 64 - suffix.length)).replace(/-+$/g, "")
      || DEFAULT_IMPORTED_SKILL_SLUG;
    slug = `${trimmedBase}${suffix}`;
    i += 1;
  }
  used.add(slug);
  return slug;
}

async function ensureDirectoryPath(adapter, dirPath) {
  const parts = String(dirPath || "").split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    try { await adapter.mkdir(cur); } catch { /* exists or unsupported parent */ }
  }
}

async function moveFolderRecursive(adapter, fromDir, toDir) {
  await ensureDirectoryPath(adapter, parentPath(toDir));
  if (typeof adapter.rename === "function") {
    try {
      await adapter.rename(fromDir, toDir);
      return;
    } catch { /* fall back to copy + delete */ }
  }
  await copyFolderRecursive(adapter, fromDir, toDir);
  try { await deleteFolderRecursive(adapter, fromDir); } catch { /* best effort */ }
}

async function copyFolderRecursive(adapter, fromDir, toDir) {
  await ensureDirectoryPath(adapter, toDir);
  let entry;
  try { entry = await adapter.list(fromDir); } catch { return; }
  for (const filePath of entry.files || []) {
    const relative = filePath.slice(String(fromDir).replace(/\/+$/, "").length + 1);
    const targetPath = joinPath(toDir, relative);
    await ensureDirectoryPath(adapter, parentPath(targetPath));
    const shouldReadText = isProbablyTextImportFile(relative, null) || typeof adapter.readBinary !== "function";
    if (shouldReadText) {
      const content = await adapter.read(filePath);
      await adapter.write(targetPath, content);
    } else {
      const content = await adapter.readBinary(filePath);
      if (typeof adapter.writeBinary === "function") await adapter.writeBinary(targetPath, content);
      else await adapter.write(targetPath, String(content || ""));
    }
  }
  for (const folderPath of entry.folders || []) {
    const relative = folderPath.slice(String(fromDir).replace(/\/+$/, "").length + 1);
    await copyFolderRecursive(adapter, folderPath, joinPath(toDir, relative));
  }
}

async function readImportFilePayload(file, relativePath) {
  if (isProbablyTextImportFile(relativePath, file) || typeof file.arrayBuffer !== "function") {
    return { binary: false, data: await readImportFileText(file) };
  }
  return { binary: true, data: await file.arrayBuffer() };
}

async function readImportFileText(file) {
  if (file && typeof file.text === "function") return file.text();
  if (file && typeof file.arrayBuffer === "function") {
    const buffer = await file.arrayBuffer();
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(buffer);
    }
  }
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
      reader.readAsText(file);
    });
  }
  throw new Error("当前环境不支持读取该文件");
}

function isProbablyTextImportFile(relativePath, file) {
  const path = String(relativePath || "");
  const fileName = path.split("/").pop() || "";
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  if (TEXT_IMPORT_EXTENSIONS.has(ext)) return true;
  const type = String((file && file.type) || "").toLowerCase();
  return type.startsWith("text/")
    || type.includes("json")
    || type.includes("javascript")
    || type.includes("xml")
    || type.includes("yaml");
}

async function refreshSkillCaches(plugin) {
  // Drop the agent-side SkillRegistry cache so the next turn picks up
  // the change. Same hook used by the dir-migration.
  if (plugin) {
    plugin.__flownoteSkillCache = null;
    // Re-warm the mobile slash-command list. Best-effort.
    if (plugin.app && plugin.app.vault && plugin.app.vault.adapter) {
      try { plugin.__flownoteMobileSkillList = await listSkills(plugin); } catch { /* ignore */ }
    }
  }
  // Also reload the legacy SkillService (slash-command source).
  if (plugin && typeof plugin.reloadSkills === "function") {
    try { await plugin.reloadSkills(); } catch { /* ignore */ }
  }
}

async function deleteFolderRecursive(adapter, dirPath) {
  /** @type {string[]} */
  const stack = [dirPath];
  /** @type {string[]} */
  const dirsToDelete = [];
  while (stack.length > 0) {
    const cur = stack.pop();
    dirsToDelete.push(cur);
    let entry;
    try { entry = await adapter.list(cur); } catch { continue; }
    if (!entry) continue;
    for (const f of entry.files || []) {
      try { await adapter.remove(f); } catch { /* best effort */ }
    }
    for (const sub of entry.folders || []) stack.push(sub);
  }
  // Delete folders deepest-first.
  for (const d of dirsToDelete.reverse()) {
    try { await adapter.rmdir(d, false); } catch { /* best effort */ }
  }
}

module.exports = {
  listSkills,
  readSkill,
  saveSkill,
  deleteSkill,
  importSkillsFromFileList,
  discoverSkillImportsFromFileList,
  listSkillManagementEntries,
  listSkillSecretRefs,
  extractSkillSecretRefsFromText,
  renderSkillMarkdown,
  validateSlug,
  sanitizeSkillSlug,
  defaultSkillsRoot,
  PORTABLE_SKILL_ROOT,
};
