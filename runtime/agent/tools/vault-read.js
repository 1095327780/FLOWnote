// vault_read tool — reads a markdown note from the Obsidian vault.
//
// Read-only, concurrency-safe. Always permitted (no permission gate).
// Honors optional line-range slicing so the model can ask for the part
// of a long file it cares about.

const { buildTool } = require("../tool-registry");
const { resolveReadablePath } = require("./vault-path-aliases");
const { pageNotice } = require("./utf8-page");
const { pageReadOutput } = require("./read-output-budget");

const DESCRIPTION =
  "Read the contents of a note from the user's Obsidian vault. " +
  "Provide the path relative to the vault root (e.g. \"daily/2026-05-15.md\"). " +
  "Optionally pass `offset` and `limit` to read a slice of lines (1-indexed), " +
  "then `byteOffset` from a truncated result to continue that slice. " +
  "By default, returns as much content as the available context allows. " +
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
    byteOffset: {
      type: "integer",
      description: "UTF-8 byte offset within the selected line slice; use the next byte offset returned on truncation.",
      minimum: 0,
    },
  },
  required: ["path"],
};

function defaultNormalizePath(p) {
  // Cheap normalization for non-Obsidian callers (tests). Real users get
  // Obsidian's normalizePath via the factory arg.
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function utf16IndexAtByteOffset(text, byteOffset) {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    if (bytes === byteOffset) return index;
    const point = text.codePointAt(index);
    const width = point > 0xffff ? 2 : 1;
    bytes += new TextEncoder().encode(text.slice(index, index + width)).length;
    index += width;
  }
  return bytes === byteOffset ? text.length : -1;
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
  const byteCap = typeof maxBytes === "number" && maxBytes > 0 ? Math.max(4, Math.floor(maxBytes)) : undefined;

  return buildTool({
    name: "vault_read",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    capabilities: (input) => ({
      effect: "observation",
      risk: "low",
      concurrency: "parallel",
      presentation: "read",
      targets: input && typeof input.path === "string"
        ? [resolveReadablePath(vault, normalize(input.path))]
        : [],
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (!input || typeof input.path !== "string" || !input.path.trim()) {
        return { ok: false, error: "Missing path." };
      }
      if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 1)) {
        return { ok: false, error: "offset must be a positive integer." };
      }
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
        return { ok: false, error: "limit must be a positive integer." };
      }
      if (input.byteOffset !== undefined && (!Number.isInteger(input.byteOffset) || input.byteOffset < 0)) {
        return { ok: false, error: "byteOffset must be a non-negative integer." };
      }
      return { ok: true };
    },

    userFacingName(input) {
      return input && typeof input.path === "string" ? input.path : "";
    },

    async *execute(input, ctx) {
      const normalized = resolveReadablePath(vault, normalize(input.path));
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

      const offset = Number.isInteger(input.offset) ? input.offset : 1;
      const limit = Number.isInteger(input.limit) ? input.limit : null;

      let sliced;
      let sliceStart = 0;
      if (offset === 1 && limit === null) {
        sliced = text;
      } else {
        const lines = text.split(/\r?\n/);
        const start = Math.max(0, offset - 1);
        const end = limit === null ? lines.length : Math.min(lines.length, start + limit);
        sliced = lines.slice(start, end).join("\n");
        const lineBreaks = /\r?\n/g;
        for (let line = 0; line < start; line += 1) {
          const match = lineBreaks.exec(text);
          if (!match) { sliceStart = text.length; break; }
          sliceStart = lineBreaks.lastIndex;
        }
      }

      let page;
      try {
        page = pageReadOutput(sliced, { ctx, byteOffset: input.byteOffset || 0, maxBytes: byteCap });
      } catch (error) {
        yield { type: "result", content: `vault_read: ${error.message}`, isError: true };
        return;
      }
      const lineArgs = `${offset !== 1 ? `offset=${offset}, ` : ""}${limit !== null ? `limit=${limit}, ` : ""}`;
      const { text: pageText, ...pageMeta } = page;
      // Keep the full host text for backlinks/checkpoints, but credit only
      // bytes actually returned to the model. CRLF slices are not byte-exact
      // after line joining, so they conservatively grant no edit visibility.
      if (ctx && ctx.fileStateCache && typeof ctx.fileStateCache.recordRead === "function") {
        const pageStart = utf16IndexAtByteOffset(sliced, page.offset);
        const visibleStart = sliceStart + pageStart;
        const visible = pageStart >= 0 && text.slice(visibleStart, visibleStart + pageText.length) === pageText
          ? [[visibleStart, visibleStart + pageText.length]] : [];
        ctx.fileStateCache.recordRead(normalized, text, { visibleRanges: visible });
      }
      yield { type: "result", content: pageText + pageNotice("vault_read", page, lineArgs), data: { page: pageMeta } };
    },
  });
}

module.exports = {
  createVaultReadTool,
  defaultNormalizePath,
};
