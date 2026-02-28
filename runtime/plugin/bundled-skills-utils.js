const fs = require("fs");
const path = require("path");

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

module.exports = {
  TEMPLATE_MAP_FILE,
  DEFAULT_META_TEMPLATES_DIR,
  DEFAULT_BACKUP_ROOT,
  CANCELLED_ERROR_CODE,
  walkFilesRecursive,
  normalizeSafeRelativePath,
  dedupeNormalizedPaths,
  normalizeTemplateLocaleKey,
  normalizeTemplateLocaleVariant,
  filesHaveSameContent,
  isTemplateContentValid,
  createCancelledError,
  isCancelledError,
  copyFileWithParent,
  cloneExistingPath,
};
