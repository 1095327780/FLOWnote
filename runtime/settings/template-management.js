// Template management — list / read / write / reset the user-editable
// template files under `Meta/模板/`. Skills like ah-note / ah-card /
// ah-week reach for these templates at runtime; when a user changes
// the template, the final output the AI produces changes too.
//
// Source of truth: bundled-skills/template-map.json (embedded in the
// plugin bundle). Each entry maps a logical ID (e.g. "daily-note") to:
//   * metaSource — filename under settings.metaTemplatesDir
//   * fallback   — vault-relative path inside .flownote/skills/…
//                  used as the default content when the user-editable
//                  copy is missing OR when the user clicks "Reset"
//
// All I/O goes through vault.adapter so this works on desktop AND mobile.
// Fallback content is read from the embedded bundle (no fs needed) so
// reset works on mobile too.

const embeddedBundledSkillsModule = (() => {
  try {
    return require("../generated/bundled-skills-embedded");
  } catch {
    return {};
  }
})();

const EMBEDDED_BUNDLED_SKILLS_FILES = embeddedBundledSkillsModule
  && embeddedBundledSkillsModule.EMBEDDED_BUNDLED_SKILLS_FILES
  && typeof embeddedBundledSkillsModule.EMBEDDED_BUNDLED_SKILLS_FILES === "object"
  ? embeddedBundledSkillsModule.EMBEDDED_BUNDLED_SKILLS_FILES
  : null;

const DEFAULT_META_TEMPLATES_DIR = "Meta/模板";
const TEMPLATE_MAP_FILE = "template-map.json";
const { normalizeSupportedLocale } = require("../i18n-locale-utils");
const { renderSkillTemplateVariables } = require("../agent/skill-registry");
const {
  DEFAULT_NOTE_PATHS_ZH,
  DEFAULT_NOTE_PATHS_EN,
  DEFAULT_META_PATHS_ZH,
  DEFAULT_META_PATHS_EN,
  getDefaultNotePathsByLocale,
  getDefaultMetaPathsByLocale,
  normalizeNotePaths,
  normalizeMetaPaths,
} = require("../settings-utils");

function joinPath(a, b) {
  return `${String(a).replace(/\/+$/, "")}/${String(b).replace(/^\/+/, "")}`;
}

/**
 * Read the template-map.json registry. Reads from the embedded bundle
 * first (works on mobile); on desktop, falls back to the vault-side
 * mirror copy if the embed is missing.
 *
 * @param {Object} plugin
 * @returns {Promise<{entries: Array<TemplateEntry>, metaTemplatesDir: string}>}
 */
async function readTemplateMap(plugin) {
  let raw = "";
  if (EMBEDDED_BUNDLED_SKILLS_FILES && EMBEDDED_BUNDLED_SKILLS_FILES[TEMPLATE_MAP_FILE]) {
    raw = String(EMBEDDED_BUNDLED_SKILLS_FILES[TEMPLATE_MAP_FILE]);
  } else {
    // Desktop fallback: read the synced copy from the mirror dir.
    const adapter = plugin && plugin.app && plugin.app.vault && plugin.app.vault.adapter;
    if (adapter && typeof adapter.exists === "function") {
      const candidates = [
        ".flownote/bundled-skills/template-map.json",
        ".opencode/bundled-skills/template-map.json",
      ];
      for (const candidate of candidates) {
        try {
          if (await adapter.exists(candidate)) {
            raw = await adapter.read(candidate);
            break;
          }
        } catch { /* try next */ }
      }
    }
  }
  if (!raw) return { entries: [], metaTemplatesDir: DEFAULT_META_TEMPLATES_DIR };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { entries: [], metaTemplatesDir: DEFAULT_META_TEMPLATES_DIR }; }
  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  const metaTemplatesDir = typeof parsed.metaTemplatesDir === "string" && parsed.metaTemplatesDir.trim()
    ? parsed.metaTemplatesDir.trim()
    : DEFAULT_META_TEMPLATES_DIR;
  return { entries, metaTemplatesDir };
}

function resolveTemplateLocale(plugin) {
  const locale = typeof plugin?.getEffectiveLocale === "function"
    ? plugin.getEffectiveLocale()
    : plugin?.settings?.uiLanguage;
  return normalizeSupportedLocale(locale, "zh-CN");
}

function metaTemplatesDirByLocale(plugin, baseDir, locale) {
  const normalizedLocale = normalizeSupportedLocale(locale, "zh-CN");
  const defaults = getDefaultMetaPathsByLocale(normalizedLocale);
  const metaPaths = normalizeMetaPaths(plugin && plugin.settings && plugin.settings.metaPaths, defaults);
  if (metaPaths.templates) return metaPaths.templates;
  return normalizedLocale === "en"
    ? "Meta/Templates"
    : (String(baseDir || "").trim() || DEFAULT_META_TEMPLATES_DIR);
}

function resolveTemplateEntryByLocale(raw, locale) {
  const base = raw && typeof raw === "object" ? raw : {};
  const normalizedLocale = normalizeSupportedLocale(locale, "zh-CN");
  const variant = base.locales && typeof base.locales === "object"
    ? base.locales[normalizedLocale]
    : null;
  const targets = Array.isArray(variant && variant.targets) && variant.targets.length
    ? variant.targets
    : base.targets;
  return {
    id: String(base.id || "").trim(),
    metaSource: String((variant && variant.metaSource) || base.metaSource || "").trim(),
    fallback: String((variant && variant.fallback) || base.fallback || "").trim(),
    targets: Array.isArray(targets)
      ? targets.map((t) => String(t || "").trim()).filter(Boolean)
      : [],
  };
}

/**
 * Read the bundled fallback content for a template. Returns "" if the
 * fallback path doesn't resolve in the embedded bundle. This is the
 * portable equivalent of fs.readFileSync(fallback) — works on mobile.
 *
 * @param {string} fallbackPath  vault-relative path from template-map.json
 * @returns {string}
 */
function buildTemplateVariables(plugin, locale) {
  const settings = plugin && plugin.settings && typeof plugin.settings === "object"
    ? plugin.settings
    : {};
  const noteDefaults = getDefaultNotePathsByLocale(locale);
  const metaDefaults = getDefaultMetaPathsByLocale(locale);
  const notePaths = normalizeNotePaths(settings.notePaths, noteDefaults);
  const metaPaths = normalizeMetaPaths(settings.metaPaths, metaDefaults);
  const skillsDir = String(settings.skillsDir || ".flownote/skills").replace(/\\/g, "/").replace(/\/+$/, "").trim() || ".flownote/skills";
  const defaultPathReplacements = [];
  for (const defaults of [DEFAULT_NOTE_PATHS_ZH, DEFAULT_NOTE_PATHS_EN]) {
    for (const key of Object.keys(defaults || {})) {
      defaultPathReplacements.push({ from: defaults[key], to: notePaths[key] });
    }
  }
  for (const defaults of [DEFAULT_META_PATHS_ZH, DEFAULT_META_PATHS_EN]) {
    for (const key of Object.keys(defaults || {})) {
      defaultPathReplacements.push({ from: defaults[key], to: metaPaths[key] });
    }
  }
  return { notePaths, metaPaths, skillsDir, defaultPathReplacements };
}

function readEmbeddedFallback(fallbackPath, plugin = null, locale = "zh-CN") {
  if (!EMBEDDED_BUNDLED_SKILLS_FILES) return "";
  const key = String(fallbackPath || "").replace(/^\/+/, "");
  if (!key) return "";
  // The embedded bundle keys are relative to bundled-skills/ root, so
  // the fallback path matches verbatim ("ah-note/assets/每日笔记模板.md").
  const raw = EMBEDDED_BUNDLED_SKILLS_FILES[key]
    ? String(EMBEDDED_BUNDLED_SKILLS_FILES[key])
    : "";
  return plugin ? renderSkillTemplateVariables(raw, buildTemplateVariables(plugin, locale)) : raw;
}

/**
 * Enumerate every template in the registry along with its current
 * user-editable state. Each item has:
 *   id              — registry ID (e.g. "daily-note")
 *   metaSource      — filename under metaTemplatesDir
 *   userPath        — full vault-relative path of the user copy
 *   fallback        — bundled fallback path (for "reset")
 *   hasUserCopy     — boolean: file exists under Meta/模板/
 *   isCustomized    — boolean: user file differs from bundled fallback
 *
 * @param {Object} plugin
 * @returns {Promise<Array<TemplateListItem>>}
 */
function skillsRoot(plugin) {
  const v = String((plugin && plugin.settings && plugin.settings.skillsDir) || "").trim();
  return v || ".flownote/skills";
}

async function listTemplates(plugin) {
  const adapter = plugin && plugin.app && plugin.app.vault && plugin.app.vault.adapter;
  if (!adapter) return [];
  const locale = resolveTemplateLocale(plugin);
  const { entries, metaTemplatesDir } = await readTemplateMap(plugin);
  const localizedMetaTemplatesDir = metaTemplatesDirByLocale(plugin, metaTemplatesDir, locale);
  const root = skillsRoot(plugin);
  const out = [];
  for (const raw of entries) {
    const entry = resolveTemplateEntryByLocale(raw, locale);
    const { id, metaSource, fallback, targets } = entry;
    if (!id || !metaSource) continue;
    const userPath = joinPath(localizedMetaTemplatesDir, metaSource);
    const skillTargetPaths = targets.map((t) => joinPath(root, t));
    let hasUserCopy = false;
    try { hasUserCopy = await adapter.exists(userPath); } catch { hasUserCopy = false; }
    let isCustomized = false;
    if (hasUserCopy && fallback) {
      try {
        const userContent = await adapter.read(userPath);
        const bundledContent = readEmbeddedFallback(fallback, plugin, locale);
        isCustomized = bundledContent && userContent.trim() !== bundledContent.trim();
      } catch { /* treat as not customized */ }
    }
    out.push({
      id,
      metaSource,
      userPath,
      fallback,
      targets: skillTargetPaths,
      hasUserCopy,
      isCustomized: Boolean(isCustomized),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Read a single template's effective content. If the user has a copy
 * under Meta/模板/, that takes priority; otherwise fall back to the
 * bundled default. Returns null if neither resolves.
 *
 * @param {Object} plugin
 * @param {string} id
 * @returns {Promise<{ id: string, content: string, source: "user" | "bundled", userPath: string, fallback: string } | null>}
 */
async function readTemplate(plugin, id) {
  const list = await listTemplates(plugin);
  const item = list.find((t) => t.id === id);
  if (!item) return null;
  const adapter = plugin.app.vault.adapter;
  if (item.hasUserCopy) {
    try {
      const content = await adapter.read(item.userPath);
      return { id: item.id, content, source: "user", userPath: item.userPath, fallback: item.fallback };
    } catch { /* fall through */ }
  }
  const locale = resolveTemplateLocale(plugin);
  const bundled = readEmbeddedFallback(item.fallback, plugin, locale);
  if (!bundled) return null;
  return { id: item.id, content: bundled, source: "bundled", userPath: item.userPath, fallback: item.fallback };
}

/**
 * Write a template to its user-editable path (Meta/模板/<metaSource>)
 * AND propagate to every skill-side target path so the AI reads the
 * new content on its next turn.
 *
 * Why both: skills like ah-note read the template via a fixed path
 * relative to the skill folder (e.g. `assets/每日笔记模板.md`). On
 * desktop, the bundled-skills startup sync copies Meta → targets, but
 * (a) that only runs at startup and (b) doesn't run on mobile at all.
 * Writing both keeps the edit-to-effect feedback loop instant on every
 * platform.
 *
 * @param {Object} plugin
 * @param {string} id
 * @param {string} content
 * @returns {Promise<{ userPath: string, targetsWritten: number }>}
 */
async function saveTemplate(plugin, id, content) {
  const list = await listTemplates(plugin);
  const item = list.find((t) => t.id === id);
  if (!item) throw new Error(`未知模板 ID: ${id}`);
  const adapter = plugin.app.vault.adapter;
  const data = String(content ?? "");

  await writeWithParents(adapter, item.userPath, data);
  let targetsWritten = 0;
  for (const target of item.targets || []) {
    try {
      await writeWithParents(adapter, target, data);
      targetsWritten += 1;
    } catch { /* skip unwritable target — non-fatal */ }
  }
  return { userPath: item.userPath, targetsWritten };
}

async function writeWithParents(adapter, filePath, data) {
  const parts = filePath.split("/");
  parts.pop();
  // Walk down creating every intermediate dir; mkdir is idempotent.
  for (let i = 1; i <= parts.length; i += 1) {
    const dir = parts.slice(0, i).join("/");
    if (!dir) continue;
    try { await adapter.mkdir(dir); } catch { /* exists */ }
  }
  await adapter.write(filePath, data);
}

/**
 * Restore the bundled default into the user copy. Works on mobile
 * because the default is pulled from the embedded bundle, not from
 * the filesystem.
 *
 * @param {Object} plugin
 * @param {string} id
 * @returns {Promise<{ userPath: string, restored: boolean }>}
 */
async function resetTemplate(plugin, id) {
  const list = await listTemplates(plugin);
  const item = list.find((t) => t.id === id);
  if (!item) throw new Error(`未知模板 ID: ${id}`);
  const locale = resolveTemplateLocale(plugin);
  const bundled = readEmbeddedFallback(item.fallback, plugin, locale);
  if (!bundled) {
    return { userPath: item.userPath, restored: false };
  }
  await saveTemplate(plugin, id, bundled);
  return { userPath: item.userPath, restored: true };
}

module.exports = {
  listTemplates,
  readTemplate,
  saveTemplate,
  resetTemplate,
  readTemplateMap,
  readEmbeddedFallback,
  DEFAULT_META_TEMPLATES_DIR,
};
