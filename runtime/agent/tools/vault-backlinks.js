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

    async *execute(input, ctx) {
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

      // metadataCache lag bypass: Obsidian reindexes asynchronously,
      // so a wikilink written 1-2 seconds ago may not be in the
      // resolvedLinks map yet. We DON'T want to make the model wait
      // and retry. Instead, scan any files we WROTE this session
      // (tracked in ctx.fileStateCache) for the target path, and
      // merge them into the result. The cache has the post-write
      // content, so even brand-new wikilinks are caught.
      const recentlyWrittenHits = scanRecentWritesForLink(ctx, file);
      for (const [src, count] of recentlyWrittenHits.entries()) {
        // Don't double-count if the metadataCache already saw it.
        const existing = map.get(src) || 0;
        if (count > existing) map.set(src, count);
      }

      if (map.size === 0) {
        yield {
          type: "result",
          content: `vault_backlinks: no notes link to "${path}".`,
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

/**
 * Scan files written this session (cached in ctx.fileStateCache) for
 * wikilinks pointing at the target file. We match three common forms:
 *   [[target]]               — basename
 *   [[folder/target]]        — relative path
 *   [[folder/target.md]]     — explicit extension
 *   [[…|display]] aliases    — anything before the |
 *
 * Returns Map<sourcePath, occurrenceCount>. Empty Map if cache is absent.
 *
 * @param {Object} ctx
 * @param {Object} targetFile   { path, basename }
 * @returns {Map<string, number>}
 */
function scanRecentWritesForLink(ctx, targetFile) {
  const out = new Map();
  if (!ctx || !ctx.fileStateCache || typeof ctx.fileStateCache.recentWrites !== "function") {
    return out;
  }
  const path = String(targetFile && targetFile.path || "");
  const basename = String(targetFile && targetFile.basename || path.split("/").pop().replace(/\.md$/i, ""));
  if (!path && !basename) return out;
  const noExt = path.replace(/\.md$/i, "");
  // Build a regex matching `[[<target>]]` or `[[<target>|display]]`,
  // where `<target>` may be: basename, noExt path, or full path.
  // Escape regex specials in the candidate strings.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = Array.from(new Set([basename, noExt, path].filter(Boolean).map(escape)));
  if (candidates.length === 0) return out;
  const re = new RegExp(`\\[\\[(?:${candidates.join("|")})(?:#[^\\]|]+)?(?:\\|[^\\]]+)?\\]\\]`, "g");

  for (const entry of ctx.fileStateCache.recentWrites()) {
    if (!entry || entry.path === path) continue; // ignore self-links
    const content = typeof entry.content === "string" ? entry.content : "";
    if (!content) continue;
    re.lastIndex = 0;
    let count = 0;
    while (re.exec(content) !== null) count += 1;
    if (count > 0) out.set(entry.path, count);
  }
  return out;
}

module.exports = {
  createVaultBacklinksTool,
  collectBacklinks,
  scanRecentWritesForLink,
};
