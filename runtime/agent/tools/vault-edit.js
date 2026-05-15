// vault_edit tool — precise string replacement inside a vault note.
//
// Designed for surgical edits (renaming a heading, fixing a sentence,
// updating a frontmatter key). For wholesale rewrites use vault_write.
//
// Invariants enforced here:
//   * old_string must be present in the file at execute time
//   * old_string must be UNIQUE unless `replace_all: true`
//   * old_string and new_string must differ
//
// Concurrency is not safe: two edits to the same note can race. We mark
// the tool accordingly so the agent loop serializes it.

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "Perform an exact string replacement inside a note in the user's Obsidian " +
  "vault. Provide `path` (relative to the vault root), `old_string`, and " +
  "`new_string`. The edit fails if `old_string` is missing, identical to " +
  "`new_string`, or appears more than once — supply additional surrounding " +
  "context to make the match unique, or set `replace_all: true` to replace " +
  "every occurrence (use for renames). For new files or wholesale rewrites, " +
  "use vault_write instead.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the note, relative to the vault root.",
    },
    old_string: {
      type: "string",
      description: "The exact text to replace. Must be present in the file.",
    },
    new_string: {
      type: "string",
      description: "The text to replace it with. Must differ from old_string.",
    },
    replace_all: {
      type: "boolean",
      description: "Replace every occurrence instead of requiring uniqueness. Default: false.",
    },
  },
  required: ["path", "old_string", "new_string"],
};

function defaultNormalizePath(p) {
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

/**
 * @param {Object} deps
 * @param {Object}   deps.vault            Obsidian Vault (or fake)
 * @param {Function} [deps.normalizePath]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultEditTool({ vault, normalizePath } = {}) {
  if (!vault || typeof vault.getFileByPath !== "function") {
    throw new Error("createVaultEditTool: vault with getFileByPath required");
  }
  if (typeof vault.cachedRead !== "function" || typeof vault.modify !== "function") {
    throw new Error("createVaultEditTool: vault must expose cachedRead + modify");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_edit",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => false,
    isDestructive: () => false, // edits are reversible by re-editing; overwrite is what we call "destructive"
    isConcurrencySafe: () => false,

    async validate(input) {
      if (!input || typeof input.path !== "string" || !input.path.trim()) {
        return { ok: false, error: "Missing path." };
      }
      if (typeof input.old_string !== "string") {
        return { ok: false, error: "old_string must be a string." };
      }
      if (typeof input.new_string !== "string") {
        return { ok: false, error: "new_string must be a string." };
      }
      if (input.old_string === input.new_string) {
        return { ok: false, error: "old_string and new_string are identical." };
      }
      if (input.old_string.length === 0) {
        return { ok: false, error: "old_string must not be empty." };
      }
      if (input.replace_all !== undefined && typeof input.replace_all !== "boolean") {
        return { ok: false, error: "replace_all must be a boolean." };
      }
      return { ok: true };
    },

    async checkPermissions(input, ctx) {
      const grants = ctx && ctx.grants ? ctx.grants : null;
      if (grants && grants["vault_edit:*"]) {
        return { behavior: "allow" };
      }
      const normalized = normalize(input.path);
      return {
        behavior: "ask",
        summary: `edit → ${normalized}`,
        choices: ["allow once", "allow for this conversation", "deny"],
      };
    },

    userFacingName(input) {
      return input && typeof input.path === "string" ? input.path : "";
    },

    async *execute(input, _ctx) {
      const normalized = normalize(input.path);
      const file = vault.getFileByPath(normalized);
      if (!file) {
        yield {
          type: "result",
          content: `vault_edit: file not found at "${normalized}". Use vault_write to create it first.`,
          isError: true,
        };
        return;
      }
      const raw = await vault.cachedRead(file);
      const current = typeof raw === "string" ? raw : String(raw || "");

      const occurrences = countOccurrences(current, input.old_string);
      if (occurrences === 0) {
        yield {
          type: "result",
          content:
            `vault_edit: old_string not found in "${normalized}". The file may have ` +
            "changed since you read it — read it again and retry with the current text.",
          isError: true,
        };
        return;
      }
      if (occurrences > 1 && !input.replace_all) {
        yield {
          type: "result",
          content:
            `vault_edit: old_string appears ${occurrences} times in "${normalized}". ` +
            "Add more surrounding context to make the match unique, or pass " +
            "replace_all: true to replace every occurrence.",
          isError: true,
        };
        return;
      }

      let updated;
      let replacedCount;
      if (input.replace_all) {
        updated = current.split(input.old_string).join(input.new_string);
        replacedCount = occurrences;
      } else {
        const idx = current.indexOf(input.old_string);
        updated =
          current.slice(0, idx) + input.new_string + current.slice(idx + input.old_string.length);
        replacedCount = 1;
      }

      yield { type: "progress", message: `edit → ${normalized}` };
      await vault.modify(file, updated);

      const delta = Buffer.byteLength(updated, "utf8") - Buffer.byteLength(current, "utf8");
      const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
      yield {
        type: "result",
        content:
          `Edited "${normalized}" — replaced ${replacedCount} occurrence` +
          `${replacedCount === 1 ? "" : "s"} (${deltaStr} bytes).`,
      };
    },
  });
}

module.exports = {
  createVaultEditTool,
  countOccurrences,
};
