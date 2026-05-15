// vault_create_dir tool — recursively create a folder inside the vault.
//
// Mirrors `mkdir -p` semantics. Obsidian's vault.createFolder will create
// any intermediate folders that don't exist yet. Calling on an existing
// path is a no-op (returns a friendly "already exists" message instead of
// throwing) so skill flows that ensure-folder-then-write don't need a
// pre-check.

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "Create a folder in the user's Obsidian vault. Recursive — intermediate " +
  "directories are created as needed (like `mkdir -p`). No-op + success " +
  "message if the folder already exists. Use this before vault_write/" +
  "vault_daily/vault_property when a skill is laying out a new directory " +
  "structure (e.g. a new project folder under 04-创造层/).";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Folder path (vault-relative, forward slashes).",
    },
  },
  required: ["path"],
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
 * @param {Object}   deps.app             Obsidian App (vault required)
 * @param {Function} [deps.normalizePath]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultCreateDirTool({ app, normalizePath } = {}) {
  if (!app || !app.vault) throw new Error("createVaultCreateDirTool: app.vault required");
  if (typeof app.vault.createFolder !== "function") {
    throw new Error("createVaultCreateDirTool: vault.createFolder required");
  }
  if (typeof app.vault.getAbstractFileByPath !== "function") {
    throw new Error("createVaultCreateDirTool: vault.getAbstractFileByPath required");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_create_dir",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => true, // idempotent

    async validate(input) {
      if (!input || typeof input.path !== "string" || !input.path.trim()) {
        return { ok: false, error: "Missing path." };
      }
      return { ok: true };
    },

    userFacingName(input) {
      return input && typeof input.path === "string" ? input.path : "";
    },

    async *execute(input, _ctx) {
      const path = normalize(input.path);
      if (!path) {
        yield {
          type: "result",
          content: "vault_create_dir: path resolves to vault root — nothing to create.",
        };
        return;
      }
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing) {
        yield { type: "result", content: `vault_create_dir: "${path}" already exists.` };
        return;
      }
      yield { type: "progress", message: `mkdir -p ${path}` };
      try {
        await app.vault.createFolder(path);
      } catch (e) {
        yield {
          type: "result",
          content: `vault_create_dir: createFolder failed: ${e && e.message ? e.message : e}`,
          isError: true,
        };
        return;
      }
      yield { type: "result", content: `Created folder "${path}".` };
    },
  });
}

module.exports = {
  createVaultCreateDirTool,
};
