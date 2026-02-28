const fs = require("fs");
const path = require("path");
const {
  DEFAULT_META_TEMPLATES_DIR,
  createCancelledError,
  isCancelledError,
} = require("./bundled-skills-utils");

async function resolveBundledSyncAction(conflict, options = {}, state = {}) {
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
}

async function syncBundledSkills(vaultPath, options = {}) {
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
}

async function syncBundledContent(vaultPath, options = {}) {
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
}

module.exports = {
  resolveBundledSyncAction,
  syncBundledSkills,
  syncBundledContent,
};
