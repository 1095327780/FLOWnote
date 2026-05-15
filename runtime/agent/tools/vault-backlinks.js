// vault_backlinks tool — list notes that link to a target note.
//
// Built on top of `app.metadataCache`. Tries the public-ish
// `getBacklinksForFile` first; falls back to scanning `resolvedLinks` (a
// reverse map of source → target → count maintained by Obsidian).
//
// Read-only, concurrency-safe. Cheap — no file I/O, the cache is in RAM.

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "List the notes that link TO a given note (i.e. its backlinks). " +
  "Provide `path` (vault-relative, the LINK TARGET). " +
  "Returns up to `limit` paths sorted by link count then alphabetically, " +
  "one per line, with the per-source reference count in brackets. " +
  "Empty result is normal for new or unreferenced notes.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Target note (the link destination). Vault-relative path.",
    },
    limit: {
      type: "integer",
      description: "Max sources to return. Default 100.",
      minimum: 1,
    },
  },
  required: ["path"],
};

const DEFAULT_LIMIT = 100;

function defaultNormalizePath(p) {
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Collect { sourcePath → count } for the target. Tries the modern API,
 * falls back to the resolvedLinks reverse-scan.
 *
 * Exported for testing.
 *
 * @param {Object} metadataCache
 * @param {Object} targetFile
 * @returns {Map<string, number>}
 */
function collectBacklinks(metadataCache, targetFile) {
  const out = new Map();
  if (!metadataCache || !targetFile) return out;
  // Modern API (Obsidian ≥1.0.0). Returns a Map-like with `.data` of
  // source path → array of link references.
  if (typeof metadataCache.getBacklinksForFile === "function") {
    try {
      const bl = metadataCache.getBacklinksForFile(targetFile);
      if (bl && bl.data && typeof bl.data === "object") {
        for (const [src, refs] of Object.entries(bl.data)) {
          const count = Array.isArray(refs) ? refs.length : 1;
          if (count > 0) out.set(src, count);
        }
        return out;
      }
      // Some versions return a plain object map directly.
      if (bl && typeof bl === "object" && !Array.isArray(bl)) {
        for (const [src, refs] of Object.entries(bl)) {
          if (src === "data") continue;
          const count = Array.isArray(refs) ? refs.length : typeof refs === "number" ? refs : 1;
          if (count > 0) out.set(src, count);
        }
        if (out.size > 0) return out;
      }
    } catch {
      // Fall through to resolvedLinks scan.
    }
  }
  // Fallback: resolvedLinks is a public field — { sourcePath: { targetPath: count } }.
  const resolved = metadataCache.resolvedLinks;
  if (!resolved || typeof resolved !== "object") return out;
  for (const [src, targets] of Object.entries(resolved)) {
    if (!targets || typeof targets !== "object") continue;
    const count = targets[targetFile.path];
    if (typeof count === "number" && count > 0) out.set(src, count);
  }
  return out;
}

/**
 * @param {Object} deps
 * @param {Object} deps.app                Obsidian App (vault + metadataCache)
 * @param {Function} [deps.normalizePath]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultBacklinksTool({ app, normalizePath } = {}) {
  if (!app || !app.vault || typeof app.vault.getFileByPath !== "function") {
    throw new Error("createVaultBacklinksTool: app.vault.getFileByPath required");
  }
  if (!app.metadataCache) {
    throw new Error("createVaultBacklinksTool: app.metadataCache required");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_backlinks",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (!input || typeof input.path !== "string" || !input.path.trim()) {
        return { ok: false, error: "Missing path." };
      }
      if (input.limit !== undefined && !Number.isInteger(input.limit)) {
        return { ok: false, error: "limit must be an integer." };
      }
      return { ok: true };
    },

    userFacingName(input) {
      return input && typeof input.path === "string" ? input.path : "";
    },

    async *execute(input, _ctx) {
      const path = normalize(input.path);
      const file = app.vault.getFileByPath(path);
      if (!file) {
        yield {
          type: "result",
          content: `vault_backlinks: file not found at "${path}".`,
          isError: true,
        };
        return;
      }
      const limit = Number.isInteger(input.limit) ? input.limit : DEFAULT_LIMIT;
      const map = collectBacklinks(app.metadataCache, file);
      if (map.size === 0) {
        yield {
          type: "result",
          content:
            `vault_backlinks: no notes link to "${path}".\n\n` +
            "Note: Obsidian's metadataCache reindexes asynchronously, so a wikilink " +
            "written in the past few seconds may not show here yet. If you JUST wrote " +
            "a file with a `[[link]]` to this path, trust the write and don't retry — " +
            "use vault_search (which reads file content directly) if you need confirmation.",
        };
        return;
      }
      const sorted = Array.from(map.entries())
        .sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0].localeCompare(b[0]);
        });
      const truncated = sorted.length > limit;
      const shown = sorted.slice(0, limit);
      const lines = shown.map(([src, count]) => `${src} [${count}]`);
      const header = `Found ${sorted.length} source${sorted.length === 1 ? "" : "s"} linking to "${path}".`;
      const tail = truncated ? `\n\n[vault_backlinks: truncated at limit=${limit}.]` : "";
      yield { type: "result", content: `${header}\n${lines.join("\n")}${tail}` };
    },
  });
}

module.exports = {
  createVaultBacklinksTool,
  collectBacklinks,
};
