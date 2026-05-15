// vault_move tool — rename / move a note or folder.
//
// Uses `app.fileManager.renameFile(file, newPath)` which is the
// Obsidian-supported path: it automatically rewrites every wikilink
// pointing at the moved file (or recursively, every link into a moved
// folder). This is the ONLY reason this tool exists — a naive
// read+create+delete would orphan all the backlinks.

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "Move or rename a note or folder. Pass `from` (vault-relative path) and " +
  "`to` (vault-relative path). Works on files AND folders — moving a folder " +
  "moves every note inside. " +
  "Obsidian automatically updates wikilinks pointing at the moved file(s), " +
  "so use this instead of vault_write + vault_write to a new path. " +
  "Errors if `to` already exists.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    from: {
      type: "string",
      description: "Current path (vault-relative, forward slashes).",
    },
    to: {
      type: "string",
      description: "Destination path (vault-relative). Must not exist yet.",
    },
  },
  required: ["from", "to"],
};

function defaultNormalizePath(p) {
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * @param {Object} deps
 * @param {Object}   deps.app              Obsidian App (vault + fileManager)
 * @param {Function} [deps.normalizePath]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultMoveTool({ app, normalizePath } = {}) {
  if (!app || !app.vault) throw new Error("createVaultMoveTool: app.vault required");
  if (typeof app.vault.getAbstractFileByPath !== "function") {
    throw new Error("createVaultMoveTool: vault.getAbstractFileByPath required");
  }
  if (!app.fileManager || typeof app.fileManager.renameFile !== "function") {
    throw new Error("createVaultMoveTool: app.fileManager.renameFile required");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_move",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: () => true, // hard to undo: links get rewritten across the vault
    isConcurrencySafe: () => false,

    async validate(input) {
      if (!input || typeof input.from !== "string" || !input.from.trim()) {
        return { ok: false, error: "Missing `from`." };
      }
      if (typeof input.to !== "string" || !input.to.trim()) {
        return { ok: false, error: "Missing `to`." };
      }
      if (normalize(input.from) === normalize(input.to)) {
        return { ok: false, error: "`from` and `to` resolve to the same path." };
      }
      return { ok: true };
    },

    async checkPermissions(input, ctx) {
      const grants = ctx && ctx.grants ? ctx.grants : null;
      if (grants && grants["vault_move:*"]) return { behavior: "allow" };
      return {
        behavior: "ask",
        summary: `${normalize(input.from)} → ${normalize(input.to)}`,
        choices: ["allow once", "allow for this conversation", "deny"],
      };
    },

    userFacingName(input) {
      const from = input && typeof input.from === "string" ? input.from : "?";
      const to = input && typeof input.to === "string" ? input.to : "?";
      return `${from} → ${to}`;
    },

    async *execute(input, _ctx) {
      const from = normalize(input.from);
      const to = normalize(input.to);
      const source = app.vault.getAbstractFileByPath(from);
      if (!source) {
        yield {
          type: "result",
          content: `vault_move: source not found at "${from}".`,
          isError: true,
        };
        return;
      }
      const dest = app.vault.getAbstractFileByPath(to);
      if (dest) {
        yield {
          type: "result",
          content: `vault_move: destination "${to}" already exists. Remove it first or pick a different target.`,
          isError: true,
        };
        return;
      }
      yield { type: "progress", message: `move ${from} → ${to}` };
      try {
        await app.fileManager.renameFile(source, to);
      } catch (e) {
        yield {
          type: "result",
          content: `vault_move: renameFile failed: ${e && e.message ? e.message : e}`,
          isError: true,
        };
        return;
      }
      yield {
        type: "result",
        content: `Moved "${from}" → "${to}". Wikilinks pointing at this file have been rewritten automatically.`,
      };
    },
  });
}

module.exports = {
  createVaultMoveTool,
};
