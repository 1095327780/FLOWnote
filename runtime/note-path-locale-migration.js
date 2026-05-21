const {
  DEFAULT_NOTE_PATHS_ZH,
  DEFAULT_NOTE_PATHS_EN,
  DEFAULT_META_PATHS_ZH,
  DEFAULT_META_PATHS_EN,
  getDefaultNotePathsByLocale,
  getDefaultMetaPathsByLocale,
  normalizeNotePaths,
  normalizeMetaPaths,
} = require("./settings-utils");
const { normalizeSupportedLocale } = require("./i18n-locale-utils");

const NOTE_PATH_KEYS = Object.keys(DEFAULT_NOTE_PATHS_ZH);
const ROOT_NOTE_PATH_KEYS = new Set(["captureRoot", "cultivateRoot", "createRoot"]);
const META_PATH_KEYS = Object.keys(DEFAULT_META_PATHS_ZH);

function normalizeVaultPath(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

function getParentPath(path) {
  const value = normalizeVaultPath(path);
  const index = value.lastIndexOf("/");
  return index > 0 ? value.slice(0, index) : "";
}

function samePath(a, b) {
  return normalizeVaultPath(a) === normalizeVaultPath(b);
}

function planNotePathLocaleMigration(settings = {}, fromLocale, toLocale) {
  const sourceLocale = normalizeSupportedLocale(fromLocale, "zh-CN");
  const targetLocale = normalizeSupportedLocale(toLocale, "en");
  const fromDefaults = getDefaultNotePathsByLocale(sourceLocale);
  const toDefaults = getDefaultNotePathsByLocale(targetLocale);
  const current = normalizeNotePaths(settings && settings.notePaths, fromDefaults);
  const items = [];
  const skippedCustomPath = [];
  const alreadyTarget = [];

  if (sourceLocale === targetLocale) {
    return {
      fromLocale: sourceLocale,
      toLocale: targetLocale,
      items,
      skippedCustomPath,
      alreadyTarget,
      count: 0,
    };
  }

  for (const key of NOTE_PATH_KEYS) {
    const source = normalizeVaultPath(fromDefaults[key]);
    const target = normalizeVaultPath(toDefaults[key]);
    const currentPath = normalizeVaultPath(current[key]);
    if (!source || !target) continue;
    if (samePath(currentPath, target)) {
      alreadyTarget.push({ key, path: target });
      continue;
    }
    if (!samePath(currentPath, source)) {
      skippedCustomPath.push({ key, current: currentPath, source, target });
      continue;
    }
    items.push({ key, source, target });
  }

  items.sort((a, b) => {
    const ar = ROOT_NOTE_PATH_KEYS.has(a.key) ? 1 : 0;
    const br = ROOT_NOTE_PATH_KEYS.has(b.key) ? 1 : 0;
    return ar - br;
  });

  return {
    fromLocale: sourceLocale,
    toLocale: targetLocale,
    items,
    skippedCustomPath,
    alreadyTarget,
    count: items.length,
  };
}

function planMetaPathLocaleMigration(settings = {}, fromLocale, toLocale) {
  if (typeof settings === "string" && (typeof fromLocale === "string" || fromLocale === undefined)) {
    toLocale = fromLocale;
    fromLocale = settings;
    settings = {};
  }
  const sourceLocale = normalizeSupportedLocale(fromLocale, "zh-CN");
  const targetLocale = normalizeSupportedLocale(toLocale, "en");
  const fromDefaults = getDefaultMetaPathsByLocale(sourceLocale);
  const toDefaults = getDefaultMetaPathsByLocale(targetLocale);
  const current = normalizeMetaPaths(settings && settings.metaPaths, fromDefaults);
  const sourceDefaults = normalizeMetaPaths({ metaRoot: current.metaRoot }, fromDefaults);
  const targetDefaults = normalizeMetaPaths({ metaRoot: current.metaRoot }, toDefaults);
  const items = [];
  const skippedCustomPath = [];
  const alreadyTarget = [];

  if (sourceLocale === targetLocale) {
    return {
      fromLocale: sourceLocale,
      toLocale: targetLocale,
      items,
      skippedCustomPath,
      alreadyTarget,
      count: 0,
    };
  }

  for (const key of META_PATH_KEYS) {
    const source = normalizeVaultPath(sourceDefaults[key]);
    const target = normalizeVaultPath(targetDefaults[key]);
    const currentPath = normalizeVaultPath(current[key]);
    if (!source || !target || samePath(source, target)) continue;
    if (samePath(currentPath, target)) {
      alreadyTarget.push({ key, path: target });
      continue;
    }
    if (!samePath(currentPath, source)) {
      skippedCustomPath.push({ key, current: currentPath, source, target });
      continue;
    }
    items.push({ key, source, target, kind: "meta" });
  }

  return {
    fromLocale: sourceLocale,
    toLocale: targetLocale,
    items,
    skippedCustomPath,
    alreadyTarget,
    count: items.length,
  };
}

function getAbstract(vault, path) {
  if (!vault || typeof vault.getAbstractFileByPath !== "function") return null;
  try {
    return vault.getAbstractFileByPath(normalizeVaultPath(path));
  } catch {
    return null;
  }
}

async function ensureFolder(vault, folderPath) {
  const path = normalizeVaultPath(folderPath);
  if (!path) return;
  if (!vault || typeof vault.createFolder !== "function") return;
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (getAbstract(vault, current)) continue;
    await vault.createFolder(current);
  }
}

async function applyNotePathLocaleMigration(app, settings, plan) {
  const vault = app && app.vault;
  const fileManager = app && app.fileManager;
  const result = {
    migrated: [],
    skippedMissingSource: [],
    skippedTargetExists: [],
    skippedCustomPath: Array.isArray(plan && plan.skippedCustomPath) ? [...plan.skippedCustomPath] : [],
    errors: [],
  };
  if (!settings || typeof settings !== "object") {
    result.errors.push({ key: "", source: "", target: "", message: "settings unavailable" });
    return result;
  }
  if (!settings.notePaths || typeof settings.notePaths !== "object") settings.notePaths = {};
  if (!vault || typeof vault.getAbstractFileByPath !== "function") {
    result.errors.push({ key: "", source: "", target: "", message: "vault.getAbstractFileByPath unavailable" });
    return result;
  }
  if (!fileManager || typeof fileManager.renameFile !== "function") {
    result.errors.push({ key: "", source: "", target: "", message: "fileManager.renameFile unavailable" });
    return result;
  }

  const items = Array.isArray(plan && plan.items) ? plan.items : [];
  for (const item of items) {
    const key = String(item && item.key || "");
    const source = normalizeVaultPath(item && item.source);
    const target = normalizeVaultPath(item && item.target);
    if (!key || !source || !target) continue;

    const sourceFile = getAbstract(vault, source);
    if (!sourceFile) {
      settings.notePaths[key] = target;
      result.skippedMissingSource.push({ key, source, target });
      continue;
    }

    const targetFile = getAbstract(vault, target);
    if (targetFile) {
      if (ROOT_NOTE_PATH_KEYS.has(key)) settings.notePaths[key] = target;
      result.skippedTargetExists.push({ key, source, target });
      continue;
    }

    if (!Array.isArray(sourceFile.children)) {
      result.errors.push({ key, source, target, message: "source is not a folder" });
      continue;
    }

    try {
      await ensureFolder(vault, getParentPath(target));
      await fileManager.renameFile(sourceFile, target);
      settings.notePaths[key] = target;
      result.migrated.push({ key, source, target });
    } catch (error) {
      result.errors.push({
        key,
        source,
        target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const fromDefaults = getDefaultNotePathsByLocale(plan && plan.fromLocale);
  const toDefaults = getDefaultNotePathsByLocale(plan && plan.toLocale);
  const mc = settings.mobileCapture && typeof settings.mobileCapture === "object" ? settings.mobileCapture : null;
  if (mc && samePath(mc.dailyNotePath, fromDefaults.dailyNotes)) {
    mc.dailyNotePath = toDefaults.dailyNotes;
  }
  if (mc && String(mc.ideaSectionHeader || "").trim() === "## 记录" && plan && plan.toLocale === "en") {
    mc.ideaSectionHeader = "## Records";
  }
  if (mc && String(mc.ideaSectionHeader || "").trim() === "## Records" && plan && plan.toLocale === "zh-CN") {
    mc.ideaSectionHeader = "## 记录";
  }

  return result;
}

async function applyMetaPathLocaleMigration(app, settingsOrPlan, maybePlan) {
  const settings = maybePlan ? settingsOrPlan : null;
  const plan = maybePlan || settingsOrPlan;
  const vault = app && app.vault;
  const fileManager = app && app.fileManager;
  const result = {
    migrated: [],
    skippedMissingSource: [],
    skippedTargetExists: [],
    skippedCustomPath: Array.isArray(plan && plan.skippedCustomPath) ? [...plan.skippedCustomPath] : [],
    errors: [],
  };
  if (!vault || typeof vault.getAbstractFileByPath !== "function") {
    result.errors.push({ key: "", source: "", target: "", message: "vault.getAbstractFileByPath unavailable" });
    return result;
  }
  if (!fileManager || typeof fileManager.renameFile !== "function") {
    result.errors.push({ key: "", source: "", target: "", message: "fileManager.renameFile unavailable" });
    return result;
  }

  const items = Array.isArray(plan && plan.items) ? plan.items : [];
  for (const item of items) {
    const key = String(item && item.key || "");
    const source = normalizeVaultPath(item && item.source);
    const target = normalizeVaultPath(item && item.target);
    if (!key || !source || !target) continue;

    const sourceFile = getAbstract(vault, source);
    if (!sourceFile) {
      result.skippedMissingSource.push({ key, source, target });
      if (settings && settings.metaPaths && typeof settings.metaPaths === "object") {
        settings.metaPaths[key] = target;
      }
      continue;
    }

    const targetFile = getAbstract(vault, target);
    if (targetFile) {
      result.skippedTargetExists.push({ key, source, target });
      continue;
    }

    if (!Array.isArray(sourceFile.children)) {
      result.errors.push({ key, source, target, message: "source is not a folder" });
      continue;
    }

    try {
      await ensureFolder(vault, getParentPath(target));
      await fileManager.renameFile(sourceFile, target);
      result.migrated.push({ key, source, target });
      if (settings && settings.metaPaths && typeof settings.metaPaths === "object") {
        settings.metaPaths[key] = target;
      }
    } catch (error) {
      result.errors.push({
        key,
        source,
        target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

function mergeMigrationResults(...results) {
  const output = {
    migrated: [],
    skippedMissingSource: [],
    skippedTargetExists: [],
    skippedCustomPath: [],
    errors: [],
  };
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    for (const key of Object.keys(output)) {
      if (Array.isArray(result[key])) output[key].push(...result[key]);
    }
  }
  return output;
}

function summarizeNotePathMigrationResult(result) {
  const data = result && typeof result === "object" ? result : {};
  return {
    migrated: Array.isArray(data.migrated) ? data.migrated.length : 0,
    skippedMissingSource: Array.isArray(data.skippedMissingSource) ? data.skippedMissingSource.length : 0,
    skippedTargetExists: Array.isArray(data.skippedTargetExists) ? data.skippedTargetExists.length : 0,
    skippedCustomPath: Array.isArray(data.skippedCustomPath) ? data.skippedCustomPath.length : 0,
    errors: Array.isArray(data.errors) ? data.errors.length : 0,
  };
}

module.exports = {
  NOTE_PATH_KEYS,
  META_PATH_KEYS,
  DEFAULT_META_PATHS_ZH,
  DEFAULT_META_PATHS_EN,
  getDefaultMetaPathsByLocale,
  normalizeVaultPath,
  planNotePathLocaleMigration,
  planMetaPathLocaleMigration,
  applyNotePathLocaleMigration,
  applyMetaPathLocaleMigration,
  mergeMigrationResults,
  summarizeNotePathMigrationResult,
};
