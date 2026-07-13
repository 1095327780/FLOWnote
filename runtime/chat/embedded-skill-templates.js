const { normalizeSupportedLocale } = require("../i18n-locale-utils");
const { getDefaultMetaPathsByLocale, normalizeMetaPaths } = require("../settings-utils");

function readTemplateMap(embeddedFiles) {
  try {
    return JSON.parse(String(embeddedFiles && embeddedFiles["template-map.json"] || ""));
  } catch {
    return null;
  }
}

function localizedTemplateEntry(entry, locale) {
  const variant = entry && entry.locales && typeof entry.locales === "object"
    ? entry.locales[locale]
    : null;
  return {
    variant,
    targets: Array.isArray(variant && variant.targets) && variant.targets.length
      ? variant.targets
      : Array.isArray(entry && entry.targets) ? entry.targets : [],
  };
}

function addEmbeddedTemplateAliases(resourcesBySlug, locale, embeddedFiles) {
  const templateMap = readTemplateMap(embeddedFiles);
  if (!templateMap) return;
  const normalizedLocale = normalizeSupportedLocale(locale, "en");
  for (const entry of Array.isArray(templateMap.entries) ? templateMap.entries : []) {
    const { variant, targets } = localizedTemplateEntry(entry, normalizedLocale);
    const fallback = String((variant && variant.fallback) || entry.fallback || "").replace(/^\/+/, "");
    const slash = fallback.indexOf("/");
    if (slash === -1) continue;
    const sourceSlug = fallback.slice(0, slash);
    const sourceRel = fallback.slice(slash + 1);
    const sourceFiles = resourcesBySlug[sourceSlug];
    if (!sourceFiles || !Object.prototype.hasOwnProperty.call(sourceFiles, sourceRel)) continue;
    for (const rawTarget of targets) {
      const target = String(rawTarget || "").replace(/^\/+/, "");
      const targetSlash = target.indexOf("/");
      if (targetSlash === -1 || target.slice(0, targetSlash) !== sourceSlug) continue;
      const targetRel = target.slice(targetSlash + 1);
      if (targetRel) sourceFiles[targetRel] = sourceFiles[sourceRel];
    }
  }
}

function addEmbeddedTemplateVaultOverrides(manifests, plugin, locale, embeddedFiles) {
  const templateMap = readTemplateMap(embeddedFiles);
  if (!templateMap) return;
  const normalizedLocale = normalizeSupportedLocale(locale, "en");
  const defaults = getDefaultMetaPathsByLocale(normalizedLocale);
  const metaPaths = normalizeMetaPaths(plugin && plugin.settings && plugin.settings.metaPaths, defaults);
  const templatesRoot = String(metaPaths.templates || defaults.templates || "").replace(/^\/+|\/+$/g, "");
  if (!templatesRoot || templatesRoot.split("/").includes("..")) return;
  const manifestsBySlug = new Map(
    (Array.isArray(manifests) ? manifests : [])
      .filter((manifest) => manifest && manifest.slug)
      .map((manifest) => [manifest.slug, manifest]),
  );
  for (const entry of Array.isArray(templateMap.entries) ? templateMap.entries : []) {
    const { variant, targets } = localizedTemplateEntry(entry, normalizedLocale);
    const metaSource = String((variant && variant.metaSource) || entry.metaSource || "").replace(/^\/+/, "");
    if (!metaSource || metaSource.split("/").includes("..")) continue;
    const userTemplatePath = `${templatesRoot}/${metaSource}`;
    for (const rawTarget of targets) {
      const target = String(rawTarget || "").replace(/^\/+/, "");
      const slash = target.indexOf("/");
      if (slash === -1) continue;
      const manifest = manifestsBySlug.get(target.slice(0, slash));
      const rel = target.slice(slash + 1);
      if (!manifest || !rel || rel.split("/").includes("..")) continue;
      manifest.vaultResourceOverrides = { ...(manifest.vaultResourceOverrides || {}), [rel]: userTemplatePath };
    }
  }
}

module.exports = { addEmbeddedTemplateAliases, addEmbeddedTemplateVaultOverrides };
