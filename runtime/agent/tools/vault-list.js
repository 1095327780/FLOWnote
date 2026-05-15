// vault_list tool — enumerate files (and optionally folders) in the vault.
//
// Read-only, concurrency-safe. Returns a newline-separated list of paths
// relative to the vault root, sorted lexically. Supports:
//   * `path` — limit to a subtree (default: vault root)
//   * `pattern` — glob (* and **) against the path tail
//   * `extensions` — case-insensitive whitelist (e.g. ["md", "canvas"])
//   * `recursive` — defaults true; set false for one-level listings
//   * `include_folders` — defaults false; folders are noisy for the model
//   * `limit` — max entries returned; truncation noted in the result

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "List files (and optionally folders) inside the user's Obsidian vault. " +
  "Defaults to a full recursive listing of markdown files at the vault root. " +
  "Use `path` to scope to a subtree, `pattern` for glob filters (e.g. " +
  "\"daily/*.md\" or \"**/index.md\"), `extensions` for an extension whitelist, " +
  "or `recursive: false` for a single-level listing. Returns paths relative to " +
  "the vault root, one per line.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Folder path relative to the vault root. Omit or pass \"\" for the whole vault.",
    },
    pattern: {
      type: "string",
      description: "Optional glob pattern. Supports * (any chars except /) and ** (any chars).",
    },
    extensions: {
      type: "array",
      items: { type: "string" },
      description: "Optional list of extensions (without the dot) to keep. Case-insensitive.",
    },
    recursive: {
      type: "boolean",
      description: "Recurse into subfolders. Default true.",
    },
    include_folders: {
      type: "boolean",
      description: "Include folder entries in the listing. Default false.",
    },
    limit: {
      type: "integer",
      description: "Maximum number of entries to return. Default 500.",
      minimum: 1,
    },
  },
  required: [],
};

const DEFAULT_LIMIT = 500;

function defaultNormalizePath(p) {
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

// Convert a glob pattern to a RegExp. We keep the implementation small —
// `*` matches anything except `/`, `**` matches anything including `/`.
// Special case: a leading `**/` is treated as gitignore-style — it also
// matches the zero-depth case (so `**/foo.md` matches `foo.md`).
function globToRegExp(pattern) {
  // Escape regex specials except *, ?, and /
  let re = "";
  let i = 0;
  // Leading `**/` → optional prefix.
  if (pattern.startsWith("**/")) {
    re += "(?:.*/)?";
    i = 3;
  }
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      // `/**/` inside the pattern → also optional segment.
      if (pattern.slice(i, i + 4) === "**/") {
        re += "(?:.*/)?";
        i += 4;
        continue;
      }
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function extOf(path) {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash) return "";
  return path.slice(dot + 1).toLowerCase();
}

/**
 * Walk the vault using whatever API surface the supplied `vault` exposes.
 * Real Obsidian provides `getAllLoadedFiles()` returning a flat array of
 * `TFile`/`TFolder` objects with `.path` and `children`. We also accept a
 * fake vault that exposes `listFiles(): string[]` for tests.
 */
function listAllEntries(vault) {
  if (typeof vault.listFiles === "function") {
    // Test/fake interface. Returns plain string paths.
    const entries = vault.listFiles() || [];
    return entries.map((p) => ({ path: String(p), isFolder: false }));
  }
  if (typeof vault.getAllLoadedFiles === "function") {
    const all = vault.getAllLoadedFiles() || [];
    return all
      .filter((f) => f && typeof f.path === "string")
      .map((f) => ({
        path: f.path,
        // TFolder has a `.children` array (TFile does not).
        isFolder: Array.isArray(f.children),
      }));
  }
  if (typeof vault.getMarkdownFiles === "function") {
    const md = vault.getMarkdownFiles() || [];
    return md
      .filter((f) => f && typeof f.path === "string")
      .map((f) => ({ path: f.path, isFolder: false }));
  }
  throw new Error("vault_list: vault has no listing API (getAllLoadedFiles / getMarkdownFiles / listFiles)");
}

/**
 * @param {Object} deps
 * @param {Object}   deps.vault
 * @param {Function} [deps.normalizePath]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultListTool({ vault, normalizePath } = {}) {
  if (!vault) throw new Error("createVaultListTool: vault required");
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_list",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (input && input.path !== undefined && typeof input.path !== "string") {
        return { ok: false, error: "path must be a string." };
      }
      if (input && input.pattern !== undefined && typeof input.pattern !== "string") {
        return { ok: false, error: "pattern must be a string." };
      }
      if (input && input.extensions !== undefined && !Array.isArray(input.extensions)) {
        return { ok: false, error: "extensions must be an array of strings." };
      }
      if (input && input.recursive !== undefined && typeof input.recursive !== "boolean") {
        return { ok: false, error: "recursive must be a boolean." };
      }
      if (input && input.include_folders !== undefined && typeof input.include_folders !== "boolean") {
        return { ok: false, error: "include_folders must be a boolean." };
      }
      if (input && input.limit !== undefined && !Number.isInteger(input.limit)) {
        return { ok: false, error: "limit must be an integer." };
      }
      return { ok: true };
    },

    userFacingName(input) {
      const parts = [];
      if (input && input.path) parts.push(input.path);
      if (input && input.pattern) parts.push(input.pattern);
      return parts.join(" ");
    },

    async *execute(input, _ctx) {
      const root = normalize(input && input.path ? input.path : "");
      const recursive = input && input.recursive !== undefined ? input.recursive : true;
      const includeFolders = !!(input && input.include_folders);
      const limit = Number.isInteger(input && input.limit) ? input.limit : DEFAULT_LIMIT;
      const extSet = Array.isArray(input && input.extensions)
        ? new Set(input.extensions.map((e) => String(e).toLowerCase().replace(/^\./, "")))
        : null;
      const patternRe = input && input.pattern ? globToRegExp(input.pattern) : null;

      const all = listAllEntries(vault);
      const rootPrefix = root === "" ? "" : `${root}/`;

      const out = [];
      let truncated = false;
      for (const entry of all) {
        if (entry.isFolder && !includeFolders) continue;
        // Scope to root
        if (root !== "" && entry.path !== root && !entry.path.startsWith(rootPrefix)) continue;
        // One-level only?
        if (!recursive) {
          const tail = root === "" ? entry.path : entry.path.slice(rootPrefix.length);
          if (tail.includes("/")) continue;
        }
        // Extension filter (files only)
        if (extSet && !entry.isFolder) {
          if (!extSet.has(extOf(entry.path))) continue;
        }
        // Glob filter — applied to the path tail relative to root
        if (patternRe) {
          const tail = root === "" ? entry.path : entry.path.slice(rootPrefix.length);
          if (!patternRe.test(tail)) continue;
        }
        out.push(entry.isFolder ? `${entry.path}/` : entry.path);
        if (out.length >= limit) {
          truncated = true;
          break;
        }
      }
      out.sort();

      if (out.length === 0) {
        yield { type: "result", content: "vault_list: no entries matched." };
        return;
      }

      const tail = truncated
        ? `\n\n[vault_list: truncated at limit=${limit}. Narrow the path/pattern to see more.]`
        : "";
      yield { type: "result", content: `${out.join("\n")}${tail}` };
    },
  });
}

module.exports = {
  createVaultListTool,
  globToRegExp,
};
