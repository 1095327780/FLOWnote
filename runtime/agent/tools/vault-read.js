// vault_read tool — reads a markdown note from the Obsidian vault.
//
// Read-only, concurrency-safe. Always permitted (no permission gate).
// Honors optional line-range slicing so the model can ask for the part
// of a long file it cares about.

const { buildTool } = require("../tool-registry");
const { byteLengthUtf8 } = require("../utils/byte-length");

const DESCRIPTION =
  "Read the contents of a note from the user's Obsidian vault. " +
  "Provide the path relative to the vault root (e.g. \"daily/2026-05-15.md\"). " +
  "Optionally pass `offset` and `limit` to read a slice of lines (1-indexed). " +
  "Returns the file contents as plain text. Returns an error result if the file " +
  "does not exist.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the note, relative to the vault root. Forward slashes only.",
    },
    offset: {
      type: "integer",
      description: "1-indexed starting line (inclusive). Omit to read from the beginning.",
      minimum: 1,
    },
    limit: {
      type: "integer",
      description: "Maximum number of lines to return. Omit to read until EOF.",
      minimum: 1,
    },
  },
  required: ["path"],
};

const MAX_BYTES_DEFAULT = 256 * 1024; // 256 KB — chat-context-friendly default

function defaultNormalizePath(p) {
  // Cheap normalization for non-Obsidian callers (tests). Real users get
  // Obsidian's normalizePath via the factory arg.
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * @param {Object} deps
 * @param {Object} deps.vault              Obsidian Vault (or fake) with getFileByPath + cachedRead
 * @param {Function} [deps.normalizePath]  defaults to a basic in-house normalizer
 * @param {number} [deps.maxBytes]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultReadTool({ vault, normalizePath, maxBytes } = {}) {
  if (!vault || typeof vault.getFileByPath !== "function" || typeof vault.cachedRead !== "function") {
    throw new Error("createVaultReadTool: vault with getFileByPath + cachedRead is required");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;
  const byteCap = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : MAX_BYTES_DEFAULT;

  return buildTool({
    name: "vault_read",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (!input || typeof input.path !== "string" || !input.path.trim()) {
        return { ok: false, error: "Missing path." };
      }
      if (input.offset !== undefined && !Number.isInteger(input.offset)) {
        return { ok: false, error: "offset must be an integer." };
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
      const normalized = normalize(input.path);
      const file = vault.getFileByPath(normalized);
      if (!file) {
        yield {
          type: "result",
          content: `vault_read: file not found at "${normalized}".`,
          isError: true,
        };
        return;
      }
      const raw = await vault.cachedRead(file);
      const text = typeof raw === "string" ? raw : String(raw || "");

      // Record the full file content in the session's FileStateCache
      // so vault_edit can verify read-before-edit and vault_backlinks
      // can sidestep metadataCache lag. Always record the WHOLE file
      // (not a slice) so the cache stays trustworthy for downstream
      // string-replacement / link-scanning consumers.
      if (ctx && ctx.fileStateCache && typeof ctx.fileStateCache.recordRead === "function") {
        ctx.fileStateCache.recordRead(normalized, text);
      }

      const offset = Number.isInteger(input.offset) ? input.offset : 1;
      const limit = Number.isInteger(input.limit) ? input.limit : null;

      let sliced;
      if (offset === 1 && limit === null) {
        sliced = text;
      } else {
        const lines = text.split(/\r?\n/);
        const start = Math.max(0, offset - 1);
        const end = limit === null ? lines.length : Math.min(lines.length, start + limit);
        sliced = lines.slice(start, end).join("\n");
      }

      if (byteLengthUtf8(sliced) > byteCap) {
        const truncated = sliced.slice(0, byteCap);
        yield {
          type: "result",
          content:
            `${truncated}\n\n[vault_read: content truncated at ${byteCap} bytes — ` +
            "use offset/limit to read remaining lines]",
        };
        return;
      }

      yield { type: "result", content: sliced };
    },
  });
}

module.exports = {
  createVaultReadTool,
  defaultNormalizePath,
};
