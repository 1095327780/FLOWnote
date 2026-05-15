// vault_search tool — substring/regex search across the vault.
//
// Read-only, concurrency-safe. Reads files lazily via Vault.cachedRead.
// Hard caps are in place so a careless search can't exhaust memory:
//   * `max_files` — most files to open
//   * `max_matches` — most match lines to return
//   * Per-file byte cap so a single huge note can't dominate the budget.

const { buildTool } = require("../tool-registry");
const { globToRegExp } = require("./vault-list");

const DESCRIPTION =
  "Search note contents inside the user's Obsidian vault. Provide `query` " +
  "(a substring by default, or a regex if `regex: true`). Returns up to " +
  "`max_matches` matching lines as `path:line: text`. Scope the search with " +
  "`path` (subtree), `pattern` (glob), or `extensions`. Pass `case_sensitive: " +
  "true` for an exact-case match. Pair this with vault_read once you know " +
  "which note to open.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "What to look for. Plain substring unless `regex: true`.",
    },
    regex: {
      type: "boolean",
      description: "Treat `query` as a JavaScript regular expression. Default false.",
    },
    case_sensitive: {
      type: "boolean",
      description: "Default false (case-insensitive).",
    },
    path: {
      type: "string",
      description: "Scope to a subtree of the vault.",
    },
    pattern: {
      type: "string",
      description: "Optional glob pattern against the path tail (e.g. \"daily/*.md\").",
    },
    extensions: {
      type: "array",
      items: { type: "string" },
      description: "Only search files with these extensions. Defaults to [\"md\"].",
    },
    max_files: {
      type: "integer",
      description: "Maximum number of files to scan. Default 200.",
      minimum: 1,
    },
    max_matches: {
      type: "integer",
      description: "Maximum match lines to return. Default 100.",
      minimum: 1,
    },
  },
  required: ["query"],
};

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_MATCHES = 100;
const PER_FILE_BYTE_CAP = 512 * 1024; // 512 KB — searching binary blobs is pointless

function defaultNormalizePath(p) {
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function extOf(path) {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash) return "";
  return path.slice(dot + 1).toLowerCase();
}

function listMarkdownFiles(vault) {
  if (typeof vault.getMarkdownFiles === "function") {
    return (vault.getMarkdownFiles() || []).filter((f) => f && typeof f.path === "string");
  }
  if (typeof vault.getAllLoadedFiles === "function") {
    return (vault.getAllLoadedFiles() || []).filter(
      (f) => f && typeof f.path === "string" && !Array.isArray(f.children),
    );
  }
  if (typeof vault.listFilesForSearch === "function") {
    // Test/fake interface: returns [{ path, read() }] tuples.
    return vault.listFilesForSearch() || [];
  }
  throw new Error("vault_search: vault has no file enumeration API");
}

function snippetForLine(line) {
  // Trim leading whitespace and clamp to ~200 chars for readability.
  const trimmed = line.replace(/^\s+/, "");
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/**
 * @param {Object} deps
 * @param {Object} deps.vault
 * @param {Function} [deps.normalizePath]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultSearchTool({ vault, normalizePath } = {}) {
  if (!vault) throw new Error("createVaultSearchTool: vault required");
  if (typeof vault.cachedRead !== "function") {
    throw new Error("createVaultSearchTool: vault.cachedRead required");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_search",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (!input || typeof input.query !== "string" || input.query.length === 0) {
        return { ok: false, error: "query must be a non-empty string." };
      }
      if (input.regex) {
        try {
          // Validate now so the model gets a clear error rather than a stack trace.
          // eslint-disable-next-line no-new
          new RegExp(input.query);
        } catch (e) {
          return { ok: false, error: `Invalid regex: ${e && e.message ? e.message : e}` };
        }
      }
      return { ok: true };
    },

    userFacingName(input) {
      return input && typeof input.query === "string" ? input.query : "";
    },

    async *execute(input, _ctx) {
      const root = normalize(input.path || "");
      const caseSensitive = !!input.case_sensitive;
      const useRegex = !!input.regex;
      const maxFiles = Number.isInteger(input.max_files) ? input.max_files : DEFAULT_MAX_FILES;
      const maxMatches = Number.isInteger(input.max_matches) ? input.max_matches : DEFAULT_MAX_MATCHES;
      const extSet = Array.isArray(input.extensions) && input.extensions.length
        ? new Set(input.extensions.map((e) => String(e).toLowerCase().replace(/^\./, "")))
        : new Set(["md"]);
      const patternRe = input.pattern ? globToRegExp(input.pattern) : null;

      let matcher;
      if (useRegex) {
        matcher = new RegExp(input.query, caseSensitive ? "" : "i");
      } else if (caseSensitive) {
        matcher = (s) => s.indexOf(input.query) !== -1;
      } else {
        const needle = input.query.toLowerCase();
        matcher = (s) => s.toLowerCase().indexOf(needle) !== -1;
      }

      const allFiles = listMarkdownFiles(vault);
      const rootPrefix = root === "" ? "" : `${root}/`;
      const candidates = [];
      for (const f of allFiles) {
        if (root !== "" && f.path !== root && !f.path.startsWith(rootPrefix)) continue;
        if (!extSet.has(extOf(f.path))) continue;
        if (patternRe) {
          const tail = root === "" ? f.path : f.path.slice(rootPrefix.length);
          if (!patternRe.test(tail)) continue;
        }
        candidates.push(f);
        if (candidates.length >= maxFiles) break;
      }
      candidates.sort((a, b) => a.path.localeCompare(b.path));

      const lines = [];
      let totalMatches = 0;
      let filesScanned = 0;
      let filesWithMatches = 0;
      let truncated = false;

      for (const f of candidates) {
        if (totalMatches >= maxMatches) {
          truncated = true;
          break;
        }
        filesScanned += 1;
        const raw = typeof f.read === "function" ? await f.read() : await vault.cachedRead(f);
        let text = typeof raw === "string" ? raw : String(raw || "");
        if (Buffer.byteLength(text, "utf8") > PER_FILE_BYTE_CAP) {
          text = text.slice(0, PER_FILE_BYTE_CAP);
        }
        const fileLines = text.split(/\r?\n/);
        let matchInFile = false;
        for (let i = 0; i < fileLines.length; i++) {
          const line = fileLines[i];
          let hit;
          if (typeof matcher === "function") {
            hit = matcher(line);
          } else {
            hit = matcher.test(line);
          }
          if (!hit) continue;
          lines.push(`${f.path}:${i + 1}: ${snippetForLine(line)}`);
          matchInFile = true;
          totalMatches += 1;
          if (totalMatches >= maxMatches) {
            truncated = true;
            break;
          }
        }
        if (matchInFile) filesWithMatches += 1;
      }

      if (lines.length === 0) {
        yield {
          type: "result",
          content: `vault_search: no matches in ${filesScanned} file${filesScanned === 1 ? "" : "s"}.`,
        };
        return;
      }
      const header = `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"} ` +
        `in ${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"} ` +
        `(scanned ${filesScanned}).`;
      const tail = truncated
        ? `\n\n[vault_search: truncated at max_matches=${maxMatches}. Narrow the query or scope.]`
        : "";
      yield { type: "result", content: `${header}\n${lines.join("\n")}${tail}` };
    },
  });
}

module.exports = {
  createVaultSearchTool,
};
