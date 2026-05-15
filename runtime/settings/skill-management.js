// Skill management — list / read / write / delete SKILL.md folders
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

const { parseFrontmatter } = require("../agent/skill-registry");

const REQUIRED_FRONTMATTER_FIELDS = ["name", "description"];

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
  const adapter = plugin && plugin.app && plugin.app.vault && plugin.app.vault.adapter;
  if (!adapter || typeof adapter.list !== "function") return [];
  const root = defaultSkillsRoot(plugin);
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
        whenToUse: frontmatter.when_to_use ? String(frontmatter.when_to_use) : undefined,
        allowedTools: Array.isArray(frontmatter["allowed-tools"]) ? frontmatter["allowed-tools"] : undefined,
        body: body || "",
        dirPath: folder,
        filePath,
      });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
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

  await adapter.mkdir(dirPath).catch(() => {});
  const content = renderSkillMarkdown(doc);
  await adapter.write(filePath, content);

  if (renaming) {
    const oldDir = joinPath(root, existingSlug);
    try { await deleteFolderRecursive(adapter, oldDir); } catch { /* best effort */ }
  }

  // Drop the agent-side SkillRegistry cache so the next turn picks up
  // the change. Same hook used by the dir-migration.
  if (plugin) plugin.__flownoteSkillCache = null;
  // Also reload the legacy SkillService (slash-command source).
  if (plugin && typeof plugin.reloadSkills === "function") {
    try { await plugin.reloadSkills(); } catch { /* ignore */ }
  }

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
  if (plugin) plugin.__flownoteSkillCache = null;
  if (plugin && typeof plugin.reloadSkills === "function") {
    try { await plugin.reloadSkills(); } catch { /* ignore */ }
  }
  return true;
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
  renderSkillMarkdown,
  validateSlug,
  defaultSkillsRoot,
};
