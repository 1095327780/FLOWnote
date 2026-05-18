// vault_write tool — create, overwrite, or append to a markdown note.
//
// Always declared non-read-only. `overwrite` on an existing file flagged
// destructive. Permission gate asks the user for any write that touches
// an existing file (unless the session has already granted blanket
// permission via permission-mode = acceptAll).

const { buildTool } = require("../tool-registry");
const { byteLengthUtf8 } = require("../utils/byte-length");

const DESCRIPTION =
  "Write content to a note in the user's Obsidian vault. " +
  "Modes: `create` (fails if file exists), `overwrite` (replaces contents), " +
  "`append` (adds to the end of an existing file, creating it if missing). " +
  "Provide `path` relative to the vault root and `content` as plain text. " +
  "Returns a confirmation string with bytes written.";

const VALID_MODES = ["create", "overwrite", "append"];

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the note, relative to the vault root.",
    },
    content: {
      type: "string",
      description: "The text to write. May be empty for `create`/`overwrite`.",
    },
    mode: {
      type: "string",
      enum: VALID_MODES,
      description:
        "`create` fails if the file already exists. `overwrite` replaces the file. " +
        "`append` adds to the end, creating the file if needed. Default: `create`.",
    },
  },
  required: ["path", "content"],
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
 * @param {Object}   deps.vault             Obsidian Vault (or fake)
 * @param {Function} [deps.normalizePath]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultWriteTool({ vault, normalizePath } = {}) {
  if (!vault || typeof vault.getFileByPath !== "function") {
    throw new Error("createVaultWriteTool: vault with getFileByPath required");
  }
  if (typeof vault.create !== "function" || typeof vault.modify !== "function") {
    throw new Error("createVaultWriteTool: vault must expose create + modify");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_write",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: (input) => input && input.mode === "overwrite",
    // Writes touch the filesystem and must be serialized to avoid races.
    isConcurrencySafe: () => false,

    async validate(input) {
      if (!input || typeof input.path !== "string" || !input.path.trim()) {
        return { ok: false, error: "Missing path." };
      }
      if (typeof input.content !== "string") {
        return { ok: false, error: "content must be a string." };
      }
      if (input.mode !== undefined && !VALID_MODES.includes(input.mode)) {
        return { ok: false, error: `mode must be one of ${VALID_MODES.join(", ")}` };
      }
      return { ok: true };
    },

    async checkPermissions(input, ctx) {
      const grants = ctx && ctx.grants ? ctx.grants : null;
      if (grants && grants["vault_write:*"]) {
        return { behavior: "allow" };
      }
      const mode = (input && input.mode) || "create";
      const normalized = normalize(input.path);
      const existing = vault.getFileByPath(normalized);

      // create on a new path → allow silently (no risk of overwriting)
      if (mode === "create" && !existing) {
        return { behavior: "allow" };
      }
      // anything touching an existing file → ask
      return {
        behavior: "ask",
        summary: `${mode} → ${normalized}`,
        choices: ["allow once", "allow for this conversation", "deny"],
      };
    },

    userFacingName(input) {
      const mode = (input && input.mode) || "create";
      const path = input && typeof input.path === "string" ? input.path : "?";
      return `${mode} ${path}`;
    },

    async *execute(input, ctx) {
      const mode = input.mode || "create";
      const normalized = normalize(input.path);
      const content = input.content;
      const existing = vault.getFileByPath(normalized);
      const recordWrite = (finalContent) => {
        if (ctx && ctx.fileStateCache && typeof ctx.fileStateCache.recordWrite === "function") {
          ctx.fileStateCache.recordWrite(normalized, finalContent);
        }
      };

      yield { type: "progress", message: `${mode} → ${normalized}` };

      if (mode === "create") {
        if (existing) {
          yield {
            type: "result",
            content: `vault_write: file already exists at "${normalized}". Use mode=overwrite to replace.`,
            isError: true,
          };
          return;
        }
        await vault.create(normalized, content);
        recordWrite(content);
        yield {
          type: "result",
          content: `Created "${normalized}" (${byteLengthUtf8(content)} bytes).`,
        };
        return;
      }

      if (mode === "overwrite") {
        if (existing) {
          await vault.modify(existing, content);
        } else {
          await vault.create(normalized, content);
        }
        recordWrite(content);
        yield {
          type: "result",
          content: `Wrote "${normalized}" (${byteLengthUtf8(content)} bytes).`,
        };
        return;
      }

      // mode === "append"
      if (existing) {
        const current = await vault.cachedRead(existing);
        const joined = `${current || ""}${content}`;
        await vault.modify(existing, joined);
        recordWrite(joined);
        yield {
          type: "result",
          content: `Appended ${byteLengthUtf8(content)} bytes to "${normalized}".`,
        };
        return;
      }
      await vault.create(normalized, content);
      recordWrite(content);
      yield {
        type: "result",
        content: `Created "${normalized}" via append (${byteLengthUtf8(content)} bytes).`,
      };
    },
  });
}

module.exports = {
  createVaultWriteTool,
  VALID_MODES,
};
