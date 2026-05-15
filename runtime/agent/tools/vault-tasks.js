// vault_tasks tool — list checkbox tasks across the vault.
//
// Built on `app.metadataCache.getFileCache(file).listItems`, which
// Obsidian populates with one entry per `- [ ] ...` / `- [x] ...` line.
// Each entry exposes `task` (the marker char) and `position.start.line`.
//
// Read-only, concurrency-safe.

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "List checkbox tasks (`- [ ]` / `- [x]`) across the vault. " +
  "Optional `path` scopes to a subtree (a folder or a single note). " +
  "Optional `status`: `open` (default, unchecked only), `done` (checked only), or `all`. " +
  "Returns up to `limit` lines as `path:line: [marker] text`. Pair with vault_read once " +
  "you know which note to inspect more carefully.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Scope to a subtree (folder) or single note. Omit for the whole vault.",
    },
    status: {
      type: "string",
      enum: ["open", "done", "all"],
      description: "`open` (default), `done`, or `all`.",
    },
    limit: {
      type: "integer",
      description: "Maximum task lines to return. Default 200.",
      minimum: 1,
    },
  },
  required: [],
};

const DEFAULT_LIMIT = 200;

function defaultNormalizePath(p) {
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function markerFor(task) {
  // Obsidian stores the marker char ("x", " ", "/", "-", etc.). " " is open.
  if (typeof task !== "string") return " ";
  if (task === "") return " ";
  return task;
}

function isOpen(marker) {
  return marker === " ";
}

function snippet(line) {
  // Strip leading list marker + checkbox so the snippet shows just the task text.
  return String(line || "")
    .replace(/^\s*[-*+]\s+\[.\]\s*/, "")
    .slice(0, 200);
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
 * @param {Function} [deps.normalizePath]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultTasksTool({ app, normalizePath } = {}) {
  if (!app || !app.vault) throw new Error("createVaultTasksTool: app.vault required");
  if (!app.metadataCache || typeof app.metadataCache.getFileCache !== "function") {
    throw new Error("createVaultTasksTool: app.metadataCache.getFileCache required");
  }
  if (typeof app.vault.cachedRead !== "function") {
    throw new Error("createVaultTasksTool: vault.cachedRead required");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_tasks",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (input && input.path !== undefined && typeof input.path !== "string") {
        return { ok: false, error: "path must be a string." };
      }
      if (input && input.status !== undefined && !["open", "done", "all"].includes(input.status)) {
        return { ok: false, error: "status must be open / done / all." };
      }
      if (input && input.limit !== undefined && !Number.isInteger(input.limit)) {
        return { ok: false, error: "limit must be an integer." };
      }
      return { ok: true };
    },

    userFacingName(input) {
      const path = input && input.path ? input.path : "/";
      const status = (input && input.status) || "open";
      return `${status} in ${path}`;
    },

    async *execute(input, _ctx) {
      const root = normalize((input && input.path) || "");
      const status = (input && input.status) || "open";
      const limit = Number.isInteger(input && input.limit) ? input.limit : DEFAULT_LIMIT;

      const all = listMarkdownFiles(app.vault);
      const rootPrefix = root === "" ? "" : `${root}/`;
      const scoped = all.filter((f) => {
        if (root === "") return true;
        return f.path === root || f.path.startsWith(rootPrefix);
      });
      scoped.sort((a, b) => a.path.localeCompare(b.path));

      const lines = [];
      let truncated = false;
      let filesWith = 0;

      outer: for (const file of scoped) {
        const cache = app.metadataCache.getFileCache(file);
        if (!cache || !Array.isArray(cache.listItems)) continue;
        const tasksInFile = cache.listItems.filter((li) => li && typeof li.task === "string");
        if (tasksInFile.length === 0) continue;
        let body = null;
        let bodyLines = null;
        let added = 0;
        for (const li of tasksInFile) {
          const marker = markerFor(li.task);
          if (status === "open" && !isOpen(marker)) continue;
          if (status === "done" && isOpen(marker)) continue;
          if (body === null) {
            const raw = await app.vault.cachedRead(file);
            body = typeof raw === "string" ? raw : String(raw || "");
            bodyLines = body.split(/\r?\n/);
          }
          const lineNum = li.position && li.position.start && li.position.start.line;
          if (typeof lineNum !== "number") continue;
          const text = snippet(bodyLines[lineNum] || "");
          lines.push(`${file.path}:${lineNum + 1}: [${marker}] ${text}`);
          added += 1;
          if (lines.length >= limit) {
            truncated = true;
            break outer;
          }
        }
        if (added > 0) filesWith += 1;
      }

      if (lines.length === 0) {
        yield {
          type: "result",
          content: `vault_tasks: no ${status === "all" ? "" : status + " "}tasks found in ${scoped.length} file(s).`,
        };
        return;
      }
      const header = `Found ${lines.length} ${status} task${lines.length === 1 ? "" : "s"} across ${filesWith} file${filesWith === 1 ? "" : "s"}.`;
      const tail = truncated ? `\n\n[vault_tasks: truncated at limit=${limit}. Narrow with \`path\`.]` : "";
      yield { type: "result", content: `${header}\n${lines.join("\n")}${tail}` };
    },
  });
}

module.exports = {
  createVaultTasksTool,
  snippet,
  markerFor,
  isOpen,
};
