// vault_property tool — read / set / delete YAML frontmatter properties.
//
// Wraps `app.fileManager.processFrontMatter(file, fn)`, which is the
// Obsidian-supported path for mutating frontmatter in place. It handles
// quoting, list values, and reconstruction of the `---` block without
// touching the note body.
//
// We expose a small enum of operations rather than a free-form patch so
// the model can't accidentally clobber the whole frontmatter block.

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "Read, set, or delete a YAML frontmatter property on a note. " +
  "Operations: `get` (returns the value or `null` if absent), " +
  "`set` (creates or replaces the property; pass `value` — string, number, boolean, or string-array), " +
  "`delete` (removes the property). Provide `path` (vault-relative) and `name` (property key). " +
  "Use this for things like status / tags / due-date / source — anything in the YAML block.";

const VALID_OPS = ["get", "set", "delete"];

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the note, relative to the vault root.",
    },
    name: {
      type: "string",
      description: "Property key (frontmatter field name).",
    },
    op: {
      type: "string",
      enum: VALID_OPS,
      description: "`get`, `set`, or `delete`. Default `get`.",
    },
    value: {
      description: "Required for `set`. May be string, number, boolean, or string[].",
    },
  },
  required: ["path", "name"],
};

function defaultNormalizePath(p) {
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function coerceValue(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (Array.isArray(v)) {
    // String-array only — Obsidian's tags/aliases use this shape.
    return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  }
  // Reject objects — frontmatter nesting is supported by YAML but rare
  // and easy to mis-author from the model. If the user really wants
  // nested objects they should edit the note text directly.
  return undefined;
}

/**
 * @param {Object} deps
 * @param {Object}   deps.app             Obsidian App (vault + fileManager)
 * @param {Function} [deps.normalizePath]
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultPropertyTool({ app, normalizePath } = {}) {
  if (!app || !app.vault) throw new Error("createVaultPropertyTool: app.vault required");
  if (!app.fileManager || typeof app.fileManager.processFrontMatter !== "function") {
    throw new Error("createVaultPropertyTool: app.fileManager.processFrontMatter required");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_property",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: (input) => !input || !input.op || input.op === "get",
    isDestructive: () => false,
    isConcurrencySafe: (input) => !input || !input.op || input.op === "get",

    async validate(input) {
      if (!input || typeof input.path !== "string" || !input.path.trim()) {
        return { ok: false, error: "Missing path." };
      }
      if (typeof input.name !== "string" || !input.name.trim()) {
        return { ok: false, error: "Missing property name." };
      }
      if (input.op !== undefined && !VALID_OPS.includes(input.op)) {
        return { ok: false, error: `op must be one of ${VALID_OPS.join(", ")}` };
      }
      if ((input.op || "get") === "set") {
        if (input.value === undefined) {
          return { ok: false, error: "set requires `value`." };
        }
        if (coerceValue(input.value) === undefined) {
          return {
            ok: false,
            error: "value must be string, number, boolean, or string-array (no nested objects).",
          };
        }
      }
      return { ok: true };
    },

    async checkPermissions(input, ctx) {
      const op = (input && input.op) || "get";
      if (op === "get") return { behavior: "allow" };
      const grants = ctx && ctx.grants ? ctx.grants : null;
      if (grants && grants["vault_property:*"]) return { behavior: "allow" };
      return {
        behavior: "ask",
        summary: `${op} ${input.name} → ${normalize(input.path)}`,
        choices: ["allow once", "allow for this conversation", "deny"],
      };
    },

    userFacingName(input) {
      const op = (input && input.op) || "get";
      return `${op} ${input && input.name ? input.name : "?"}`;
    },

    async *execute(input, _ctx) {
      const path = normalize(input.path);
      const file = app.vault.getFileByPath(path);
      if (!file) {
        yield {
          type: "result",
          content: `vault_property: file not found at "${path}".`,
          isError: true,
        };
        return;
      }
      const op = input.op || "get";
      const name = input.name;

      if (op === "get") {
        let value = null;
        await app.fileManager.processFrontMatter(file, (fm) => {
          value = Object.prototype.hasOwnProperty.call(fm, name) ? fm[name] : null;
        });
        yield {
          type: "result",
          content:
            value === null
              ? `(no value: "${name}" is not set on "${path}")`
              : JSON.stringify(value),
        };
        return;
      }

      if (op === "set") {
        const coerced = coerceValue(input.value);
        yield { type: "progress", message: `set ${name} → ${path}` };
        await app.fileManager.processFrontMatter(file, (fm) => {
          fm[name] = coerced;
        });
        yield {
          type: "result",
          content: `Set "${name}" on "${path}" to ${JSON.stringify(coerced)}.`,
        };
        return;
      }

      // op === "delete"
      yield { type: "progress", message: `delete ${name} → ${path}` };
      let existed = false;
      await app.fileManager.processFrontMatter(file, (fm) => {
        existed = Object.prototype.hasOwnProperty.call(fm, name);
        delete fm[name];
      });
      yield {
        type: "result",
        content: existed
          ? `Removed "${name}" from "${path}".`
          : `"${name}" was not present on "${path}" — nothing to delete.`,
      };
    },
  });
}

module.exports = {
  createVaultPropertyTool,
  coerceValue,
  VALID_OPS,
};
