const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { normalizeSupportedLocale } = require("../i18n-locale-utils");

const TEMPLATE_MAP_FILE = "template-map.json";
const DEFAULT_META_TEMPLATES_DIR = path.join("Meta", "模板");
const DEFAULT_BACKUP_ROOT = path.join(".opencode", "backups", "bundled-content");
const CANCELLED_ERROR_CODE = "BUNDLED_CONTENT_SYNC_CANCELLED";

function walkFilesRecursive(rootDir, currentDir = rootDir, output = []) {
  if (!rootDir || !currentDir || !fs.existsSync(currentDir)) return output;
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry || String(entry.name || "").startsWith(".")) continue;
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFilesRecursive(rootDir, absPath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    output.push(path.relative(rootDir, absPath));
  }
  return output;
}

function normalizeSafeRelativePath(value) {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!normalized) return "";
  if (path.isAbsolute(normalized)) return "";
  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) return "";
  return normalized;
}

function dedupeNormalizedPaths(paths = []) {
  const seen = new Set();
  const output = [];
  for (const value of paths) {
    const normalized = normalizeSafeRelativePath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeTemplateLocaleKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered === "zh-cn" || lowered.startsWith("zh")) return "zh-CN";
  if (lowered === "en" || lowered.startsWith("en")) return "en";
  return "";
}

function normalizeTemplateLocaleVariant(variant) {
  if (!variant || typeof variant !== "object") return null;
  const metaSource = normalizeSafeRelativePath(variant.metaSource);
  const fallbackPath = normalizeSafeRelativePath(variant.fallback);
  const targets = dedupeNormalizedPaths(Array.isArray(variant.targets) ? variant.targets : []);
  if (!metaSource && !fallbackPath && !targets.length) return null;
  return {
    ...(metaSource ? { metaSource } : {}),
    ...(fallbackPath ? { fallback: fallbackPath } : {}),
    ...(targets.length ? { targets } : {}),
  };
}

function toFileBuffer(value) {
  try {
    return fs.readFileSync(value);
  } catch {
    return null;
  }
}

function filesHaveSameContent(fileA, fileB) {
  const bufA = toFileBuffer(fileA);
  const bufB = toFileBuffer(fileB);
  if (!bufA || !bufB) return false;
  return Buffer.compare(bufA, bufB) === 0;
}

function isTemplateContentValid(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return String(text || "").trim().length > 0;
  } catch {
    return false;
  }
}

function createCancelledError(stage = "unknown") {
  const err = new Error("bundled content sync cancelled");
  err.code = CANCELLED_ERROR_CODE;
  err.stage = stage;
  return err;
}

function isCancelledError(err) {
  return Boolean(err && typeof err === "object" && err.code === CANCELLED_ERROR_CODE);
}

function copyFileWithParent(srcFile, destFile) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.copyFileSync(srcFile, destFile);
}

function cloneExistingPath(srcPath, backupPath) {
  if (!fs.existsSync(srcPath)) return false;
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.cpSync(srcPath, backupPath, { recursive: true });
  } else {
    fs.copyFileSync(srcPath, backupPath);
  }
  return true;
}

function createBundledSkillsMethods(options = {}) {
  const pluginDirname = String(options.pluginDirname || "");

  return {
    resolveBundledSkillLocale(localeHint) {
      const fallbackLocale = typeof this.getEffectiveLocale === "function"
        ? this.getEffectiveLocale()
        : "en";
      return normalizeSupportedLocale(localeHint || fallbackLocale, "en");
    },

    toCanonicalLocalizedMdPath(filePath) {
      const value = String(filePath || "");
      if (!value.endsWith(".md")) return value;
      if (value.endsWith(".zh-CN.md")) return `${value.slice(0, -".zh-CN.md".length)}.md`;
      if (value.endsWith(".en.md")) return `${value.slice(0, -".en.md".length)}.md`;
      return value;
    },

    localizedMdPathByToken(basePath, token) {
      const canonical = this.toCanonicalLocalizedMdPath(basePath);
      if (!canonical.endsWith(".md")) return canonical;
      if (token === "base") return canonical;
      if (token === "zh-CN" || token === "en") return `${canonical.slice(0, -".md".length)}.${token}.md`;
      return canonical;
    },

    resolveLocalizedMarkdownSource(basePath, locale, options = {}) {
      const normalizedLocale = normalizeSupportedLocale(locale, "en");
      const defaultOrder = normalizedLocale === "zh-CN"
        ? ["zh-CN", "base", "en"]
        : ["en", "base", "zh-CN"];
      const order = Array.isArray(options.order) && options.order.length
        ? options.order
        : defaultOrder;
      for (const token of order) {
        const candidate = this.localizedMdPathByToken(basePath, token);
        if (!candidate || !fs.existsSync(candidate)) continue;
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // ignore and continue
        }
      }
      return "";
    },

    applyBundledSkillLocaleResources(srcDir, destDir, locale) {
      if (!srcDir || !destDir) return { applied: 0 };
      const relFiles = walkFilesRecursive(srcDir);
      const canonicalTargets = new Set();
      for (const relPath of relFiles) {
        const normalizedRel = String(relPath || "").replace(/\\/g, "/");
        if (!normalizedRel.endsWith(".md")) continue;
        const isReference = normalizedRel.startsWith("references/");
        const isTemplate = normalizedRel.startsWith("assets/templates/");
        if (!isReference && !isTemplate) continue;
        canonicalTargets.add(this.toCanonicalLocalizedMdPath(normalizedRel));
      }

      let applied = 0;
      for (const canonicalRel of canonicalTargets) {
        const sourcePath = this.resolveLocalizedMarkdownSource(path.join(srcDir, canonicalRel), locale);
        if (!sourcePath) continue;
        copyFileWithParent(sourcePath, path.join(destDir, canonicalRel));
        applied += 1;
      }
      return { applied };
    },

    removeLocalizedMarkdownVariants(rootDir) {
      if (!rootDir || !fs.existsSync(rootDir)) return { removed: 0 };
      const relFiles = walkFilesRecursive(rootDir);
      let removed = 0;
      for (const relPath of relFiles) {
        const normalizedRel = String(relPath || "").replace(/\\/g, "/");
        if (!normalizedRel.endsWith(".en.md") && !normalizedRel.endsWith(".zh-CN.md")) continue;
        const absPath = path.join(rootDir, normalizedRel);
        try {
          if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
            fs.rmSync(absPath, { force: true });
            removed += 1;
          }
        } catch {
          // ignore a single file deletion failure and continue
        }
      }
      return { removed };
    },

    resolveBundledSkillDocSource(skillDir, locale) {
      if (!skillDir) return "";
      const normalizedLocale = normalizeSupportedLocale(locale, "en");
      const order = normalizedLocale === "zh-CN"
        ? ["zh-CN", "base", "en"]
        : ["en", "base", "zh-CN"];
      return this.resolveLocalizedMarkdownSource(path.join(skillDir, "SKILL.md"), normalizedLocale, { order });
    },

    applyBundledSkillLocaleDoc(srcDir, destDir, locale) {
      const sourcePath = this.resolveBundledSkillDocSource(srcDir, locale);
      if (!sourcePath) {
        return {
          ok: false,
          error: `未找到可用的 SKILL 文件（locale=${locale}）`,
        };
      }

      const targetPath = path.join(destDir, "SKILL.md");
      copyFileWithParent(sourcePath, targetPath);
      return { ok: true, sourcePath, targetPath };
    },

    getPluginRootDir() {
      const vaultPath = this.getVaultPath();
      const configDir = this.app && this.app.vault && this.app.vault.configDir
        ? String(this.app.vault.configDir)
        : ".obsidian";
      const id = this.manifest && this.manifest.id ? String(this.manifest.id) : "flownote";

      const candidates = [
        path.join(vaultPath, configDir, "plugins", id),
        this.manifest && this.manifest.dir ? String(this.manifest.dir) : "",
        pluginDirname,
        pluginDirname ? path.resolve(pluginDirname, "..") : "",
      ].filter(Boolean);

      for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
      }
      return candidates[0] || pluginDirname;
    },

    getBundledSkillsRoot() {
      return path.join(this.getPluginRootDir(), "bundled-skills");
    },

    getBundledTemplateMapPath(rootDir = this.getBundledSkillsRoot()) {
      return path.join(rootDir, TEMPLATE_MAP_FILE);
    },

    getBundledSkillsContentSignature(rootDir = this.getBundledSkillsRoot(), skillIds = []) {
      if (!rootDir || !fs.existsSync(rootDir)) return "";
      const ids = [...new Set(
        (Array.isArray(skillIds) ? skillIds : [])
          .map((id) => String(id || "").trim())
          .filter(Boolean),
      )].sort((a, b) => a.localeCompare(b));
      if (!ids.length) return "";

      const hash = crypto.createHash("sha1");
      for (const skillId of ids) {
        const skillDir = path.join(rootDir, skillId);
        if (!fs.existsSync(skillDir)) continue;
        const relFiles = walkFilesRecursive(skillDir).sort((a, b) => a.localeCompare(b));
        hash.update(`${skillId}\n`);
        for (const relFile of relFiles) {
          const absFile = path.join(skillDir, relFile);
          try {
            hash.update(`${relFile}\n`);
            hash.update(fs.readFileSync(absFile));
          } catch (_e) {
            // Ignore a single file read failure and continue hashing others.
          }
        }
      }
      return hash.digest("hex");
    },

    getBundledSkillsStamp(skillIds = [], contentSignature = "") {
      const version = this.manifest && this.manifest.version ? String(this.manifest.version) : "0";
      const ids = [...new Set(
        (Array.isArray(skillIds) ? skillIds : [])
          .map((id) => String(id || "").trim())
          .filter(Boolean),
      )].sort((a, b) => a.localeCompare(b));
      const signature = String(contentSignature || "").trim();
      return `${version}:${ids.join(",")}:${signature}`;
    },

    hasSyncedBundledSkills(targetRoot, bundledIds) {
      if (!targetRoot || !fs.existsSync(targetRoot)) return false;
      return bundledIds.every((skillId) =>
        fs.existsSync(path.join(targetRoot, skillId, "SKILL.md")));
    },

    shouldSyncBundledSkills(targetRoot, bundledIds, stamp, force = false) {
      if (force) return true;
      const st = this.runtimeState && typeof this.runtimeState === "object" ? this.runtimeState : {};
      const previousStamp = String(st.bundledSkillsStamp || "");
      if (!previousStamp || previousStamp !== String(stamp || "")) return true;
      return !this.hasSyncedBundledSkills(targetRoot, bundledIds);
    },

    listBundledSkillIds(rootDir = this.getBundledSkillsRoot()) {
      if (!fs.existsSync(rootDir)) return [];

      return fs.readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry && entry.isDirectory() && !String(entry.name || "").startsWith("."))
        .map((entry) => String(entry.name || "").trim())
        .filter(Boolean)
        .filter((id) => fs.existsSync(path.join(rootDir, id, "SKILL.md")))
        .sort((a, b) => a.localeCompare(b));
    },

    loadBundledTemplateMap(rootDir = this.getBundledSkillsRoot()) {
      const mapPath = this.getBundledTemplateMapPath(rootDir);
      const fallback = {
        path: mapPath,
        version: 1,
        metaTemplatesDir: DEFAULT_META_TEMPLATES_DIR,
        entries: [],
      };
      if (!fs.existsSync(mapPath)) return fallback;

      try {
        const raw = fs.readFileSync(mapPath, "utf8");
        const parsed = JSON.parse(raw);
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        const normalizedEntries = entries
          .map((entry, index) => {
            const id = String(entry && entry.id ? entry.id : `template-${index + 1}`).trim();
            const metaSource = normalizeSafeRelativePath(entry && entry.metaSource);
            const fallbackPath = normalizeSafeRelativePath(entry && entry.fallback);
            const targets = dedupeNormalizedPaths(Array.isArray(entry && entry.targets) ? entry.targets : []);
            const locales = {};
            if (entry && entry.locales && typeof entry.locales === "object") {
              for (const [rawLocale, variant] of Object.entries(entry.locales)) {
                const locale = normalizeTemplateLocaleKey(rawLocale);
                if (!locale) continue;
                const normalizedVariant = normalizeTemplateLocaleVariant(variant);
                if (!normalizedVariant) continue;
                locales[locale] = {
                  ...(locales[locale] || {}),
                  ...normalizedVariant,
                };
              }
            }
            if (!id || !metaSource || !fallbackPath || !targets.length) return null;
            return {
              id,
              metaSource,
              fallback: fallbackPath,
              targets,
              locales,
            };
          })
          .filter(Boolean);
        const metaTemplatesDir = normalizeSafeRelativePath(parsed.metaTemplatesDir)
          || DEFAULT_META_TEMPLATES_DIR;

        return {
          path: mapPath,
          version: Number(parsed.version || 1),
          metaTemplatesDir,
          entries: normalizedEntries,
        };
      } catch (e) {
        return {
          ...fallback,
          errors: [`template-map 解析失败：${e instanceof Error ? e.message : String(e)}`],
        };
      }
    },

    resolveTemplateEntryByLocale(entry, locale = "en") {
      if (!entry || typeof entry !== "object") {
        return {
          id: "",
          metaSource: "",
          fallback: "",
          targets: [],
          staleTargets: [],
          staleMetaSources: [],
        };
      }

      const normalizedLocale = this.resolveBundledSkillLocale(locale);
      const localeVariant = entry.locales && typeof entry.locales === "object"
        ? entry.locales[normalizedLocale]
        : null;

      const metaSource = normalizeSafeRelativePath(localeVariant && localeVariant.metaSource)
        || normalizeSafeRelativePath(entry.metaSource);
      const fallbackPath = normalizeSafeRelativePath(localeVariant && localeVariant.fallback)
        || normalizeSafeRelativePath(entry.fallback);
      const targets = dedupeNormalizedPaths(
        Array.isArray(localeVariant && localeVariant.targets) && localeVariant.targets.length
          ? localeVariant.targets
          : entry.targets,
      );

      const allTargets = dedupeNormalizedPaths([
        ...(Array.isArray(entry.targets) ? entry.targets : []),
        ...Object.values(entry.locales && typeof entry.locales === "object" ? entry.locales : {})
          .flatMap((variant) => (Array.isArray(variant && variant.targets) ? variant.targets : [])),
      ]);

      const allMetaSources = dedupeNormalizedPaths([
        entry.metaSource,
        ...Object.values(entry.locales && typeof entry.locales === "object" ? entry.locales : {})
          .map((variant) => variant && variant.metaSource),
      ]);

      return {
        id: String(entry.id || "").trim(),
        locale: normalizedLocale,
        metaSource,
        fallback: fallbackPath,
        targets,
        staleTargets: allTargets.filter((target) => !targets.includes(target)),
        staleMetaSources: allMetaSources.filter((meta) => meta !== metaSource),
      };
    },

    getBundledContentBackupRoot(vaultPath, options = {}) {
      const root = normalizeSafeRelativePath(options.backupDir || "") || DEFAULT_BACKUP_ROOT;
      const ts = options.timestamp || new Date().toISOString().replace(/[:.]/g, "-");
      return path.join(vaultPath, root, ts);
    },

    backupPathIfNeeded(srcPath, backupRoot, backupRelativePath) {
      if (!srcPath || !backupRoot || !fs.existsSync(srcPath)) return false;
      const normalizedRel = normalizeSafeRelativePath(backupRelativePath)
        || path.basename(srcPath);
      const backupPath = path.join(backupRoot, normalizedRel);
      return cloneExistingPath(srcPath, backupPath);
    },

    resolveTemplateSource(vaultPath, bundledRoot, templateMap, entry, locale = "en") {
      const normalizedLocale = this.resolveBundledSkillLocale(locale);
      const localizedEntry = this.resolveTemplateEntryByLocale(entry, normalizedLocale);
      const metaRoot = path.join(vaultPath, templateMap.metaTemplatesDir || DEFAULT_META_TEMPLATES_DIR);
      const metaBase = path.join(metaRoot, localizedEntry.metaSource);
      const fallbackBase = path.join(bundledRoot, localizedEntry.fallback);

      const metaOrders = normalizedLocale === "zh-CN"
        ? [["zh-CN", "base", "en"]]
        : [["en"], ["base", "zh-CN"]];
      const fallbackOrders = normalizedLocale === "zh-CN"
        ? [["zh-CN", "base", "en"]]
        : [["en"], ["base", "zh-CN"]];

      const tryResolve = (basePath, sourceType, orders) => {
        for (const order of orders) {
          const resolved = this.resolveLocalizedMarkdownSource(basePath, normalizedLocale, { order });
          if (!resolved || !fs.existsSync(resolved) || !isTemplateContentValid(resolved)) continue;
          return { sourceType, sourcePath: resolved };
        }
        return null;
      };

      const firstMeta = tryResolve(metaBase, "meta", [metaOrders[0]]);
      if (firstMeta) {
        return {
          ok: true,
          entry: localizedEntry,
          sourceType: "meta",
          sourcePath: firstMeta.sourcePath,
          metaRoot,
          fallbackPath: fallbackBase,
        };
      }

      const firstFallback = tryResolve(fallbackBase, "fallback", [fallbackOrders[0]]);
      if (firstFallback) {
        return {
          ok: true,
          entry: localizedEntry,
          sourceType: "fallback",
          sourcePath: firstFallback.sourcePath,
          metaRoot,
          fallbackPath: fallbackBase,
          missingMeta: !this.resolveLocalizedMarkdownSource(metaBase, normalizedLocale, { order: metaOrders[0] }),
          invalidMeta: Boolean(
            this.resolveLocalizedMarkdownSource(metaBase, normalizedLocale, { order: metaOrders[0] })
            && !isTemplateContentValid(this.resolveLocalizedMarkdownSource(metaBase, normalizedLocale, { order: metaOrders[0] })),
          ),
        };
      }

      const secondaryMeta = metaOrders.length > 1 ? tryResolve(metaBase, "meta", [metaOrders[1]]) : null;
      if (secondaryMeta) {
        return {
          ok: true,
          entry: localizedEntry,
          sourceType: "meta",
          sourcePath: secondaryMeta.sourcePath,
          metaRoot,
          fallbackPath: fallbackBase,
        };
      }

      const secondaryFallback = fallbackOrders.length > 1
        ? tryResolve(fallbackBase, "fallback", [fallbackOrders[1]])
        : null;
      if (secondaryFallback) {
        return {
          ok: true,
          entry: localizedEntry,
          sourceType: "fallback",
          sourcePath: secondaryFallback.sourcePath,
          metaRoot,
          fallbackPath: fallbackBase,
          missingMeta: !this.resolveLocalizedMarkdownSource(metaBase, normalizedLocale),
          invalidMeta: Boolean(
            this.resolveLocalizedMarkdownSource(metaBase, normalizedLocale)
            && !isTemplateContentValid(this.resolveLocalizedMarkdownSource(metaBase, normalizedLocale)),
          ),
        };
      }

      const metaCandidates = [
        this.localizedMdPathByToken(metaBase, "zh-CN"),
        this.localizedMdPathByToken(metaBase, "base"),
        this.localizedMdPathByToken(metaBase, "en"),
      ];
      const fallbackCandidates = [
        this.localizedMdPathByToken(fallbackBase, "zh-CN"),
        this.localizedMdPathByToken(fallbackBase, "base"),
        this.localizedMdPathByToken(fallbackBase, "en"),
      ];
      const metaDesc = metaCandidates.filter(Boolean).join(" | ");
      const fallbackDesc = fallbackCandidates.filter(Boolean).join(" | ");
      return {
        ok: false,
        entry: localizedEntry,
        metaRoot,
        metaSource: metaBase,
        fallbackPath: fallbackBase,
        error: `模板源缺失：${localizedEntry.id}（Meta: ${metaDesc}，Fallback: ${fallbackDesc}）`,
      };
    },

    async resolveBundledSyncAction(conflict, options = {}, state = {}) {
      if (state.globalAction === "replace") return "replace";
      if (state.globalAction === "skip") return "skip";

      const defaultAction = ["replace", "skip"].includes(String(options.defaultConflictAction || ""))
        ? String(options.defaultConflictAction)
        : "skip";
      const resolver = options && typeof options.resolveConflict === "function"
        ? options.resolveConflict
        : null;
      if (!resolver) return defaultAction;

      let choice = null;
      try {
        choice = await resolver(conflict);
      } catch {
        choice = null;
      }

      const normalized = String(choice || "").trim().toLowerCase();
      if (normalized === "replace_all") {
        state.globalAction = "replace";
        return "replace";
      }
      if (normalized === "skip_all") {
        state.globalAction = "skip";
        return "skip";
      }
      if (normalized === "replace") return "replace";
      if (normalized === "skip") return "skip";
      if (normalized === "cancel") throw createCancelledError(conflict && conflict.kind ? conflict.kind : "unknown");
      return defaultAction;
    },

    async syncBundledSkills(vaultPath, options = {}) {
      const runtime = this.ensureRuntimeModules();
      const force = Boolean(options && options.force);
      const skillLocale = this.resolveBundledSkillLocale(options.locale);
      const bundledRoot = this.getBundledSkillsRoot();
      const bundledIds = this.listBundledSkillIds(bundledRoot);
      const signature = this.getBundledSkillsContentSignature(bundledRoot, bundledIds);
      const stamp = `${this.getBundledSkillsStamp(bundledIds, signature)}:locale=${skillLocale}`;

      if (this.skillService) this.skillService.setAllowedSkillIds(bundledIds);
      if (!bundledIds.length) {
        return {
          synced: 0,
          total: 0,
          skippedCount: 0,
          replacedCount: 0,
          conflictCount: 0,
          backupCount: 0,
          targetRoot: path.join(vaultPath, this.settings.skillsDir),
          bundledRoot,
          locale: skillLocale,
          stamp,
          skipped: false,
          stampUpdated: false,
          cancelled: false,
          backupRoot: "",
          errors: [`未找到内置 skills 源目录或目录为空：${bundledRoot}`],
        };
      }

      const targetRoot = path.join(vaultPath, this.settings.skillsDir);
      fs.mkdirSync(targetRoot, { recursive: true });
      const shouldSync = this.shouldSyncBundledSkills(targetRoot, bundledIds, stamp, force);
      if (!shouldSync) {
        return {
          synced: 0,
          total: bundledIds.length,
          skippedCount: 0,
          replacedCount: 0,
          conflictCount: 0,
          backupCount: 0,
          targetRoot,
          bundledRoot,
          locale: skillLocale,
          stamp,
          skipped: true,
          stampUpdated: false,
          cancelled: false,
          backupRoot: "",
          errors: [],
        };
      }

      const errors = [];
      const conflicts = [];
      const conflictState = {};
      let synced = 0;
      let replacedCount = 0;
      let skippedCount = 0;
      let backupCount = 0;
      let backupRoot = "";

      try {
        for (const skillId of bundledIds) {
          const srcDir = path.join(bundledRoot, skillId);
          const destDir = path.join(targetRoot, skillId);

          let action = "replace";
          if (fs.existsSync(destDir)) {
            action = await this.resolveBundledSyncAction({
              kind: "skill",
              id: skillId,
              sourcePath: srcDir,
              targetPath: destDir,
            }, options, conflictState);
            conflicts.push({ kind: "skill", id: skillId, action, targetPath: destDir });
          }

          if (action === "skip") {
            skippedCount += 1;
            continue;
          }

          try {
            if (fs.existsSync(destDir)) {
              if (!backupRoot) backupRoot = this.getBundledContentBackupRoot(vaultPath, options);
              const backed = this.backupPathIfNeeded(destDir, backupRoot, path.join("skills", skillId));
              if (backed) backupCount += 1;
              fs.rmSync(destDir, { recursive: true, force: true });
              replacedCount += 1;
            }
            runtime.copyDirectoryRecursive(srcDir, destDir);
            const localizedDoc = this.applyBundledSkillLocaleDoc(srcDir, destDir, skillLocale);
            if (!localizedDoc.ok) {
              errors.push(`${skillId}: ${localizedDoc.error}`);
              continue;
            }
            this.applyBundledSkillLocaleResources(srcDir, destDir, skillLocale);
            this.removeLocalizedMarkdownVariants(destDir);
            synced += 1;
          } catch (e) {
            errors.push(`${skillId}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        if (isCancelledError(e)) {
          return {
            synced,
            total: bundledIds.length,
            skippedCount,
            replacedCount,
            conflictCount: conflicts.length,
            backupCount,
            targetRoot,
            bundledRoot,
            locale: skillLocale,
            stamp,
            skipped: false,
            stampUpdated: false,
            cancelled: true,
            cancelledStage: e.stage,
            backupRoot,
            conflicts,
            errors,
          };
        }
        errors.push(e instanceof Error ? e.message : String(e));
      }

      const hasRuntimeState = this.runtimeState && typeof this.runtimeState === "object";
      let stampUpdated = false;
      if (!errors.length && hasRuntimeState) {
        this.runtimeState.bundledSkillsStamp = stamp;
        stampUpdated = true;
      }

      return {
        synced,
        total: bundledIds.length,
        skippedCount,
        replacedCount,
        conflictCount: conflicts.length,
        backupCount,
        targetRoot,
        bundledRoot,
        locale: skillLocale,
        stamp,
        skipped: false,
        stampUpdated,
        cancelled: false,
        backupRoot,
        conflicts,
        errors,
      };
    },

    async syncBundledTemplates(vaultPath, options = {}) {
      const skillLocale = this.resolveBundledSkillLocale(options.locale);
      const bundledRoot = this.getBundledSkillsRoot();
      const templateMap = this.loadBundledTemplateMap(bundledRoot);
      const targetRoot = String(options.targetRoot || "")
        || path.join(vaultPath, this.settings.skillsDir);
      const metaRoot = path.join(vaultPath, templateMap.metaTemplatesDir || DEFAULT_META_TEMPLATES_DIR);
      const entries = Array.isArray(templateMap.entries) ? templateMap.entries : [];

      const errors = Array.isArray(templateMap.errors) ? [...templateMap.errors] : [];
      if (!entries.length) {
        return {
          synced: 0,
          total: 0,
          skippedCount: 0,
          replacedCount: 0,
          conflictCount: 0,
          backupCount: 0,
          fallbackUsed: [],
          missingMeta: [],
          skipped: true,
          cancelled: false,
          locale: skillLocale,
          targetRoot,
          bundledRoot,
          mapPath: templateMap.path,
          metaRoot,
          backupRoot: "",
          errors,
        };
      }

      fs.mkdirSync(targetRoot, { recursive: true });

      let synced = 0;
      let skippedCount = 0;
      let replacedCount = 0;
      let backupCount = 0;
      let backupRoot = "";
      const conflicts = [];
      const conflictState = {};
      const fallbackUsed = new Set();
      const missingMeta = new Set();
      let cleanedStaleCount = 0;
      const total = entries.reduce((sum, entry) => {
        const localizedEntry = this.resolveTemplateEntryByLocale(entry, skillLocale);
        return sum + localizedEntry.targets.length;
      }, 0);

      try {
        for (const entry of entries) {
          const source = this.resolveTemplateSource(vaultPath, bundledRoot, templateMap, entry, skillLocale);
          if (!source.ok) {
            errors.push(source.error);
            continue;
          }
          if (source.sourceType === "fallback") fallbackUsed.add(entry.id);
          if (source.missingMeta || source.invalidMeta) missingMeta.add(entry.id);

          for (const targetRelativePath of source.entry.targets) {
            const destFile = path.join(targetRoot, targetRelativePath);
            const exists = fs.existsSync(destFile);
            if (exists && filesHaveSameContent(destFile, source.sourcePath)) {
              continue;
            }

            let action = "replace";
            if (exists) {
              action = await this.resolveBundledSyncAction({
                kind: "template",
                id: entry.id,
                sourceType: source.sourceType,
                sourcePath: source.sourcePath,
                targetPath: destFile,
                targetRelativePath,
                metaSourcePath: path.join(source.metaRoot, source.entry.metaSource),
              }, options, conflictState);
              conflicts.push({ kind: "template", id: entry.id, action, targetPath: destFile });
            }

            if (action === "skip") {
              skippedCount += 1;
              continue;
            }

            try {
              if (exists) {
                if (!backupRoot) backupRoot = this.getBundledContentBackupRoot(vaultPath, options);
                const backed = this.backupPathIfNeeded(destFile, backupRoot, path.join("templates", targetRelativePath));
                if (backed) backupCount += 1;
                replacedCount += 1;
              }
              copyFileWithParent(source.sourcePath, destFile);
              synced += 1;
            } catch (e) {
              errors.push(`${entry.id}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          for (const staleRelativePath of source.entry.staleTargets) {
            const staleFile = path.join(targetRoot, staleRelativePath);
            if (!fs.existsSync(staleFile)) continue;
            try {
              if (!backupRoot) backupRoot = this.getBundledContentBackupRoot(vaultPath, options);
              const backed = this.backupPathIfNeeded(staleFile, backupRoot, path.join("templates", staleRelativePath));
              if (backed) backupCount += 1;
              fs.rmSync(staleFile, { force: true });
              cleanedStaleCount += 1;
            } catch (e) {
              errors.push(`${entry.id}: 清理旧模板失败 ${staleRelativePath} -> ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      } catch (e) {
        if (isCancelledError(e)) {
          return {
            synced,
            total,
            skippedCount,
            replacedCount,
            conflictCount: conflicts.length,
            backupCount,
            cleanedStaleCount,
            fallbackUsed: [...fallbackUsed],
            missingMeta: [...missingMeta],
            skipped: false,
            cancelled: true,
            cancelledStage: e.stage,
            locale: skillLocale,
            targetRoot,
            bundledRoot,
            mapPath: templateMap.path,
            metaRoot,
            backupRoot,
            conflicts,
            errors,
          };
        }
        errors.push(e instanceof Error ? e.message : String(e));
      }

      return {
        synced,
        total,
        skippedCount,
        replacedCount,
        conflictCount: conflicts.length,
        backupCount,
        cleanedStaleCount,
        fallbackUsed: [...fallbackUsed],
        missingMeta: [...missingMeta],
        skipped: false,
        cancelled: false,
        locale: skillLocale,
        targetRoot,
        bundledRoot,
        mapPath: templateMap.path,
        metaRoot,
        backupRoot,
        conflicts,
        errors,
      };
    },

    async resetMetaTemplateBaseline(vaultPath, options = {}) {
      const skillLocale = this.resolveBundledSkillLocale(options.locale);
      const bundledRoot = this.getBundledSkillsRoot();
      const templateMap = this.loadBundledTemplateMap(bundledRoot);
      const metaRoot = path.join(vaultPath, templateMap.metaTemplatesDir || DEFAULT_META_TEMPLATES_DIR);
      const entries = Array.isArray(templateMap.entries) ? templateMap.entries : [];

      const errors = Array.isArray(templateMap.errors) ? [...templateMap.errors] : [];
      if (!entries.length) {
        return {
          synced: 0,
          total: 0,
          skippedCount: 0,
          replacedCount: 0,
          conflictCount: 0,
          backupCount: 0,
          skipped: true,
          cancelled: false,
          locale: skillLocale,
          metaRoot,
          mapPath: templateMap.path,
          backupRoot: "",
          errors,
        };
      }

      fs.mkdirSync(metaRoot, { recursive: true });
      const uniqueEntries = [];
      const seen = new Set();
      for (const entry of entries) {
        const localizedEntry = this.resolveTemplateEntryByLocale(entry, skillLocale);
        if (!localizedEntry.metaSource || !localizedEntry.fallback || !localizedEntry.targets.length) continue;
        if (seen.has(localizedEntry.metaSource)) continue;
        seen.add(localizedEntry.metaSource);
        uniqueEntries.push({ original: entry, localized: localizedEntry });
      }

      let synced = 0;
      let skippedCount = 0;
      let replacedCount = 0;
      let backupCount = 0;
      let cleanedStaleCount = 0;
      let backupRoot = "";
      const conflicts = [];
      const conflictState = {};

      try {
        for (const pair of uniqueEntries) {
          const entry = pair.original;
          const localizedEntry = pair.localized;
          const srcFile = this.resolveLocalizedMarkdownSource(
            path.join(bundledRoot, localizedEntry.fallback),
            skillLocale,
          );
          if (!fs.existsSync(srcFile) || !isTemplateContentValid(srcFile)) {
            errors.push(`模板基线缺失：${entry.id} -> ${srcFile}`);
            continue;
          }

          const destFile = path.join(metaRoot, localizedEntry.metaSource);
          const exists = fs.existsSync(destFile);
          if (!exists || !filesHaveSameContent(srcFile, destFile)) {
            let action = "replace";
            if (exists) {
              action = await this.resolveBundledSyncAction({
                kind: "meta-template",
                id: entry.id,
                sourcePath: srcFile,
                targetPath: destFile,
                targetRelativePath: localizedEntry.metaSource,
              }, options, conflictState);
              conflicts.push({ kind: "meta-template", id: entry.id, action, targetPath: destFile });
            }

            if (action === "skip") {
              skippedCount += 1;
              continue;
            }

            try {
              if (exists) {
                if (!backupRoot) backupRoot = this.getBundledContentBackupRoot(vaultPath, options);
                const backed = this.backupPathIfNeeded(destFile, backupRoot, path.join("meta-templates", localizedEntry.metaSource));
                if (backed) backupCount += 1;
                replacedCount += 1;
              }
              copyFileWithParent(srcFile, destFile);
              synced += 1;
            } catch (e) {
              errors.push(`${entry.id}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          for (const staleMetaRelativePath of localizedEntry.staleMetaSources) {
            const staleFile = path.join(metaRoot, staleMetaRelativePath);
            if (!fs.existsSync(staleFile)) continue;
            try {
              if (!backupRoot) backupRoot = this.getBundledContentBackupRoot(vaultPath, options);
              const backed = this.backupPathIfNeeded(
                staleFile,
                backupRoot,
                path.join("meta-templates", staleMetaRelativePath),
              );
              if (backed) backupCount += 1;
              fs.rmSync(staleFile, { force: true });
              cleanedStaleCount += 1;
            } catch (e) {
              errors.push(`${entry.id}: 清理旧模板失败 ${staleMetaRelativePath} -> ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      } catch (e) {
        if (isCancelledError(e)) {
          return {
            synced,
            total: uniqueEntries.length,
            skippedCount,
            replacedCount,
            conflictCount: conflicts.length,
            backupCount,
            cleanedStaleCount,
            skipped: false,
            cancelled: true,
            cancelledStage: e.stage,
            locale: skillLocale,
            metaRoot,
            mapPath: templateMap.path,
            backupRoot,
            conflicts,
            errors,
          };
        }
        errors.push(e instanceof Error ? e.message : String(e));
      }

      return {
        synced,
        total: uniqueEntries.length,
        skippedCount,
        replacedCount,
        conflictCount: conflicts.length,
        backupCount,
        cleanedStaleCount,
        skipped: false,
        cancelled: false,
        locale: skillLocale,
        metaRoot,
        mapPath: templateMap.path,
        backupRoot,
        conflicts,
        errors,
      };
    },

    async syncBundledContent(vaultPath, options = {}) {
      const force = Boolean(options && options.force);
      const syncTemplates = options && Object.prototype.hasOwnProperty.call(options, "syncTemplates")
        ? Boolean(options.syncTemplates)
        : true;

      const skillResult = await this.syncBundledSkills(vaultPath, options);
      if (skillResult.cancelled) {
        return {
          synced: Number(skillResult.synced || 0),
          total: Number(skillResult.total || 0),
          targetRoot: skillResult.targetRoot,
          bundledRoot: skillResult.bundledRoot,
          locale: skillResult.locale,
          stamp: skillResult.stamp,
          stampUpdated: false,
          skipped: false,
          cancelled: true,
          cancelledStage: skillResult.cancelledStage || "skill",
          backupRoot: skillResult.backupRoot || "",
          skills: skillResult,
          templates: null,
          errors: Array.isArray(skillResult.errors) ? skillResult.errors : [],
        };
      }

      const templateOptions = {
        ...options,
        force,
        targetRoot: skillResult.targetRoot || path.join(vaultPath, this.settings.skillsDir),
      };
      const templateResult = syncTemplates
        ? await this.syncBundledTemplates(vaultPath, templateOptions)
        : {
          synced: 0,
          total: 0,
          skippedCount: 0,
          replacedCount: 0,
          conflictCount: 0,
          backupCount: 0,
          fallbackUsed: [],
          missingMeta: [],
          skipped: true,
          cancelled: false,
          targetRoot: templateOptions.targetRoot,
          bundledRoot: this.getBundledSkillsRoot(),
          mapPath: this.getBundledTemplateMapPath(),
          metaRoot: path.join(vaultPath, DEFAULT_META_TEMPLATES_DIR),
          backupRoot: "",
          errors: [],
        };

      const cancelled = Boolean(templateResult && templateResult.cancelled);
      const errors = [
        ...(Array.isArray(skillResult.errors) ? skillResult.errors : []),
        ...(Array.isArray(templateResult.errors) ? templateResult.errors : []),
      ];

      return {
        synced: Number(skillResult.synced || 0),
        total: Number(skillResult.total || 0),
        syncedTemplates: Number(templateResult.synced || 0),
        totalTemplates: Number(templateResult.total || 0),
        targetRoot: skillResult.targetRoot,
        bundledRoot: skillResult.bundledRoot,
        locale: skillResult.locale,
        templateMapPath: templateResult.mapPath,
        stamp: skillResult.stamp,
        stampUpdated: Boolean(skillResult.stampUpdated),
        skipped: Boolean(skillResult.skipped) && Boolean(templateResult.skipped),
        cancelled,
        cancelledStage: cancelled ? (templateResult.cancelledStage || "template") : "",
        backupRoot: skillResult.backupRoot || templateResult.backupRoot || "",
        skills: skillResult,
        templates: templateResult,
        errors,
      };
    },
  };
}

module.exports = { createBundledSkillsMethods };
