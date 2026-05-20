const MEMORY_LEGACY_ROOT = "Meta/.ai-memory";
const MEMORY_CANONICAL_ROOT = "Meta/ai-memory";

function normalizeSlashes(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function toCanonicalMemoryPath(path) {
  const normalized = normalizeSlashes(path);
  if (normalized === MEMORY_LEGACY_ROOT) return MEMORY_CANONICAL_ROOT;
  if (normalized.startsWith(`${MEMORY_LEGACY_ROOT}/`)) {
    return `${MEMORY_CANONICAL_ROOT}/${normalized.slice(MEMORY_LEGACY_ROOT.length + 1)}`;
  }
  return normalized;
}

function isMemoryPath(path) {
  const normalized = normalizeSlashes(path);
  return normalized === MEMORY_CANONICAL_ROOT
    || normalized.startsWith(`${MEMORY_CANONICAL_ROOT}/`)
    || normalized === MEMORY_LEGACY_ROOT
    || normalized.startsWith(`${MEMORY_LEGACY_ROOT}/`);
}

function resolveReadablePath(vault, normalizedPath) {
  const canonical = toCanonicalMemoryPath(normalizedPath);
  if (canonical !== normalizedPath) {
    try {
      if (vault && typeof vault.getFileByPath === "function" && vault.getFileByPath(canonical)) {
        return canonical;
      }
      if (vault && typeof vault.getFileByPath === "function" && vault.getFileByPath(normalizedPath)) {
        return normalizedPath;
      }
    } catch {
      // Fall through to canonical path.
    }
    return canonical;
  }
  return normalizedPath;
}

function resolveWritablePath(normalizedPath) {
  return toCanonicalMemoryPath(normalizedPath);
}

module.exports = {
  MEMORY_LEGACY_ROOT,
  MEMORY_CANONICAL_ROOT,
  isMemoryPath,
  resolveReadablePath,
  resolveWritablePath,
  toCanonicalMemoryPath,
};
