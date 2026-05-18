const LINKABLE_EXTENSIONS = new Set([
  "md",
  "canvas",
  "base",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "mp3",
  "wav",
  "m4a",
  "mp4",
  "mov",
]);

const KNOWN_VAULT_ROOT_PREFIXES = [
  "01-",
  "02-",
  "03-",
  "04-",
  "Meta/",
  ".flownote/",
  ".opencode/",
  "skills/",
];

const PATH_EXTENSION_PATTERN = /\.(md|canvas|base|pdf|png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|mov)(?:#[^\s`<>\]\)\|，。；;]+)?/gi;

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function normalizeComparableFsPath(value) {
  const normalized = normalizeSlashes(value).trim();
  if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized;
}

function isAbsolutePath(value) {
  const raw = String(value || "").trim();
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(raw);
}

function findKnownVaultRootIndex(value) {
  const text = String(value || "");
  let best = -1;
  for (const prefix of KNOWN_VAULT_ROOT_PREFIXES) {
    const idx = text.indexOf(prefix);
    if (idx < 0) continue;
    if (best < 0 || idx < best) best = idx;
  }
  return best;
}

function stripMarkdownWrappers(value) {
  let out = String(value || "").trim();
  if (!out) return "";

  const markdownTarget = out.match(/^\[[^\]]+\]\(([^)]+)\)$/);
  if (markdownTarget && markdownTarget[1]) out = markdownTarget[1].trim();

  if (out.startsWith("<") && out.endsWith(">")) out = out.slice(1, -1).trim();
  while (
    (out.startsWith("`") && out.endsWith("`"))
    || (out.startsWith("\"") && out.endsWith("\""))
    || (out.startsWith("'") && out.endsWith("'"))
    || (out.startsWith("“") && out.endsWith("”"))
    || (out.startsWith("‘") && out.endsWith("’"))
    || (out.startsWith("（") && out.endsWith("）"))
    || (out.startsWith("(") && out.endsWith(")"))
    || (out.startsWith("[") && out.endsWith("]"))
    || (out.startsWith("【") && out.endsWith("】"))
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function stripTrailingPunctuation(value) {
  return String(value || "")
    .trim()
    .replace(/[，。；;、,.!?！？）)\]】》」』"'`]+$/u, "")
    .trim();
}

function splitPathFragment(value) {
  const raw = String(value || "");
  const idx = raw.indexOf("#");
  if (idx < 0) return { pathPart: raw, fragment: "" };
  return {
    pathPart: raw.slice(0, idx),
    fragment: raw.slice(idx),
  };
}

function hasSupportedExtension(pathPart) {
  const ext = String(pathPart || "").match(/\.([A-Za-z0-9]+)$/);
  if (!ext || !ext[1]) return false;
  return LINKABLE_EXTENSIONS.has(ext[1].toLowerCase());
}

function getVaultBasePathFromContext(context) {
  const adapter = context
    && context.app
    && context.app.vault
    && context.app.vault.adapter;
  if (adapter && typeof adapter.getBasePath === "function") {
    try {
      return normalizeComparableFsPath(adapter.getBasePath());
    } catch {
      return "";
    }
  }
  if (adapter && typeof adapter.basePath === "string") {
    return normalizeComparableFsPath(adapter.basePath);
  }
  return "";
}

function normalizeAbsoluteCandidate(pathValue, vaultBasePath) {
  const normalized = normalizeComparableFsPath(pathValue);
  if (!isAbsolutePath(normalized)) return normalized;

  const base = normalizeComparableFsPath(vaultBasePath);
  if (base) {
    const targetLower = normalized.toLowerCase();
    const baseLower = base.toLowerCase();
    if (targetLower === baseLower) return "";
    if (targetLower.startsWith(`${baseLower}/`)) {
      return normalized.slice(base.length + 1);
    }
  }

  const knownRootIndex = findKnownVaultRootIndex(normalized);
  if (knownRootIndex >= 0) return normalized.slice(knownRootIndex);
  return normalized.replace(/^\/+/, "");
}

function normalizeVaultPathCandidate(value, options = {}) {
  let out = stripMarkdownWrappers(value);
  if (!out) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(out)) return "";
  if (/^obsidian:/i.test(out)) return "";

  const knownRootIndex = findKnownVaultRootIndex(out);
  if (knownRootIndex > 0) out = out.slice(knownRootIndex);

  out = stripTrailingPunctuation(out)
    .replace(/^\.\//, "")
    .replace(/^[\s:：|>]+/, "");
  out = normalizeAbsoluteCandidate(out, options.vaultBasePath || "");
  out = normalizeSlashes(out).replace(/^\/+/, "").trim();
  out = stripTrailingPunctuation(out);
  if (!out) return "";

  const { pathPart, fragment } = splitPathFragment(out);
  const cleanPath = normalizeSlashes(pathPart).replace(/^\/+/, "").trim();
  if (!cleanPath || !hasSupportedExtension(cleanPath)) return "";
  if (cleanPath.includes("\0") || cleanPath.includes("<") || cleanPath.includes(">")) return "";
  if (cleanPath.split("/").some((segment) => !segment || segment === "." || segment === "..")) return "";
  return `${cleanPath}${fragment || ""}`;
}

function getVaultFile(vault, pathValue) {
  if (!vault || typeof vault.getAbstractFileByPath !== "function") return null;
  const target = vault.getAbstractFileByPath(pathValue);
  if (!target || Array.isArray(target.children)) return null;
  return target;
}

function resolveVaultPathCandidate(context, value) {
  const vault = context && context.app && context.app.vault;
  const metadataCache = context && context.app && context.app.metadataCache;
  const sourcePath = context && typeof context.getMarkdownRenderSourcePath === "function"
    ? String(context.getMarkdownRenderSourcePath() || "")
    : "";
  const normalized = normalizeVaultPathCandidate(value, {
    vaultBasePath: getVaultBasePathFromContext(context),
  });
  if (!normalized) return "";

  const { pathPart, fragment } = splitPathFragment(normalized);
  const exact = getVaultFile(vault, pathPart);
  if (exact && exact.path) return `${exact.path}${fragment || ""}`;

  if (metadataCache && typeof metadataCache.getFirstLinkpathDest === "function") {
    const byLink = metadataCache.getFirstLinkpathDest(pathPart, sourcePath);
    if (byLink && typeof byLink.path === "string" && byLink.path) {
      return `${byLink.path}${fragment || ""}`;
    }

    const basename = pathPart.split("/").pop();
    if (basename) {
      const byBasename = metadataCache.getFirstLinkpathDest(basename, sourcePath);
      if (byBasename && typeof byBasename.path === "string" && byBasename.path) {
        return `${byBasename.path}${fragment || ""}`;
      }
    }
  }

  if (vault && typeof vault.getFiles === "function") {
    const files = vault.getFiles();
    const match = Array.isArray(files)
      ? files.find((file) => file && typeof file.path === "string" && file.path === pathPart)
      : null;
    if (match && match.path) return `${match.path}${fragment || ""}`;
  }

  return "";
}

function findTextCandidateStart(text, extStart) {
  let start = Math.max(0, Number(extStart) || 0);
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === "\n" || ch === "\r" || ch === "`" || ch === "<" || ch === ">" || ch === "("
      || ch === ")" || ch === "[" || ch === "]" || ch === "【" || ch === "】") {
      break;
    }
    start -= 1;
  }
  return start;
}

function locateNormalizedPathInRaw(raw, normalizedPath) {
  const { pathPart, fragment } = splitPathFragment(normalizedPath);
  const normalizedRaw = normalizeSlashes(raw);
  const pathIndex = normalizedRaw.indexOf(pathPart);
  if (pathIndex < 0) return null;
  return {
    start: pathIndex,
    end: pathIndex + pathPart.length + (fragment || "").length,
  };
}

function extractVaultPathMatchesFromText(text, options = {}) {
  const rawText = String(text || "");
  if (!rawText) return [];

  const matches = [];
  const seen = new Set();
  PATH_EXTENSION_PATTERN.lastIndex = 0;
  let match;
  while ((match = PATH_EXTENSION_PATTERN.exec(rawText))) {
    const rawStart = findTextCandidateStart(rawText, match.index);
    const rawEnd = match.index + String(match[0] || "").length;
    const rawCandidate = rawText.slice(rawStart, rawEnd);
    const normalized = normalizeVaultPathCandidate(rawCandidate, options);
    if (!normalized) continue;

    const located = locateNormalizedPathInRaw(rawCandidate, normalized);
    if (!located) continue;
    const start = rawStart + located.start;
    const end = rawStart + located.end;
    if (end <= start) continue;

    const key = `${start}:${end}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      start,
      end,
      path: normalized,
      text: rawText.slice(start, end),
    });
  }

  return matches;
}

module.exports = {
  extractVaultPathMatchesFromText,
  normalizeVaultPathCandidate,
  resolveVaultPathCandidate,
  splitPathFragment,
};
