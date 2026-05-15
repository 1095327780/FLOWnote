// vault_tags tool — list tags in the vault or find notes by tag.
//
// Two modes:
//   * `list` (default) — top tags by count
//   * `files` — notes that carry a specific tag (frontmatter `tags:` or
//     inline `#tag`)
//
// Built on app.metadataCache.getTags() (whole-vault tag counts) +
// app.metadataCache.getFileCache(file).tags / .frontmatter.tags.
// Read-only, concurrency-safe.

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "Inspect tags across the user's vault. " +
  "Mode `list` (default) returns the top tags with note counts. " +
  "Mode `files` returns the notes that carry a specific tag — provide `tag` " +
  "(with or without leading #). " +
  "Use `limit` to cap the result size.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["list", "files"],
      description: "`list` for tag counts, `files` to find notes by tag. Default `list`.",
    },
    tag: {
      type: "string",
      description: "Required when mode=files. Leading # is optional.",
    },
    limit: {
      type: "integer",
      description: "Max rows. Default 100.",
      minimum: 1,
    },
  },
  required: [],
};

const DEFAULT_LIMIT = 100;

function normalizeTag(t) {
  if (typeof t !== "string") return "";
  const trimmed = t.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function fileHasTag(metadataCache, file, target) {
  const cache = metadataCache.getFileCache(file);
  if (!cache) return false;
  const want = target.toLowerCase();
  if (Array.isArray(cache.tags)) {
    for (const t of cache.tags) {
      if (t && typeof t.tag === "string" && t.tag.toLowerCase() === want) return true;
    }
  }
  const fmTags = cache.frontmatter && cache.frontmatter.tags;
  if (typeof fmTags === "string" && `#${fmTags}`.toLowerCase() === want) return true;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === "string" && `#${t}`.toLowerCase() === want) return true;
    }
  }
  return false;
}

function listMarkdownFiles(vault) {
  if (typeof vault.getMarkdownFiles === "function") {
    return (vault.getMarkdownFiles() || []).filter((f) => f && typeof f.path === "string");
  }
  if (typeof vault.getAllLoadedFiles === "function") {
    return (vault.getAllLoadedFiles() || []).filter(
      (f) => f && typeof f.path === "string" && /\.md$/i.test(f.path),
    );
  }
  return [];
}

/**
 * @param {Object} deps
 * @param {Object} deps.app                Obsidian App (vault + metadataCache)
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultTagsTool({ app } = {}) {
  if (!app || !app.vault) throw new Error("createVaultTagsTool: app.vault required");
  if (!app.metadataCache) throw new Error("createVaultTagsTool: app.metadataCache required");

  return buildTool({
    name: "vault_tags",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (input && input.mode !== undefined && !["list", "files"].includes(input.mode)) {
        return { ok: false, error: "mode must be `list` or `files`." };
      }
      if ((input && input.mode) === "files") {
        if (typeof input.tag !== "string" || !input.tag.trim()) {
          return { ok: false, error: "mode=files requires `tag`." };
        }
      }
      if (input && input.limit !== undefined && !Number.isInteger(input.limit)) {
        return { ok: false, error: "limit must be an integer." };
      }
      return { ok: true };
    },

    userFacingName(input) {
      const mode = (input && input.mode) || "list";
      if (mode === "files") return `files ${input && input.tag ? normalizeTag(input.tag) : ""}`;
      return "list";
    },

    async *execute(input, _ctx) {
      const mode = (input && input.mode) || "list";
      const limit = Number.isInteger(input && input.limit) ? input.limit : DEFAULT_LIMIT;

      if (mode === "list") {
        let counts;
        if (typeof app.metadataCache.getTags === "function") {
          try {
            counts = app.metadataCache.getTags() || {};
          } catch {
            counts = {};
          }
        } else {
          counts = {};
        }
        const entries = Object.entries(counts).filter(([, n]) => typeof n === "number" && n > 0);
        if (entries.length === 0) {
          yield { type: "result", content: "vault_tags: no tags found in the vault." };
          return;
        }
        entries.sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0].localeCompare(b[0]);
        });
        const truncated = entries.length > limit;
        const shown = entries.slice(0, limit);
        const lines = shown.map(([tag, n]) => `${tag} [${n}]`);
        const header = `Found ${entries.length} unique tag${entries.length === 1 ? "" : "s"}.`;
        const tail = truncated ? `\n\n[vault_tags: truncated at limit=${limit}.]` : "";
        yield { type: "result", content: `${header}\n${lines.join("\n")}${tail}` };
        return;
      }

      // mode === "files"
      const target = normalizeTag(input.tag);
      const matches = [];
      for (const f of listMarkdownFiles(app.vault)) {
        if (fileHasTag(app.metadataCache, f, target)) {
          matches.push(f.path);
          if (matches.length >= limit + 1) break; // +1 to detect truncation
        }
      }
      if (matches.length === 0) {
        yield { type: "result", content: `vault_tags: no files carry "${target}".` };
        return;
      }
      const truncated = matches.length > limit;
      const shown = truncated ? matches.slice(0, limit) : matches;
      shown.sort();
      const header = `Found ${shown.length}${truncated ? "+" : ""} file${shown.length === 1 ? "" : "s"} with "${target}".`;
      const tail = truncated ? `\n\n[vault_tags: truncated at limit=${limit}.]` : "";
      yield { type: "result", content: `${header}\n${shown.join("\n")}${tail}` };
    },
  });
}

module.exports = {
  createVaultTagsTool,
  normalizeTag,
  fileHasTag,
};
