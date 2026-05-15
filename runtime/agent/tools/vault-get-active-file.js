// vault_get_active_file tool — the note currently open in the editor.
//
// Read-only. Always allowed. Returns `null` if no file is open (e.g.
// the chat view is in focus on plugin first load). Used by skills that
// want to act on "this note" without making the user paste the path.

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "Return the note currently open in the user's editor. Useful when the " +
  "user says \"summarize this\" / \"add a tag here\" / \"link this note to X\" — " +
  "call this first to get the path, then use vault_read / vault_edit / " +
  "vault_property on it. Returns null when no file is active (chat view is " +
  "focused, vault just opened, etc.).";

const INPUT_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
};

/**
 * @param {Object} deps
 * @param {Object} deps.app   Obsidian App (workspace required)
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultGetActiveFileTool({ app } = {}) {
  if (!app || !app.workspace || typeof app.workspace.getActiveFile !== "function") {
    throw new Error("createVaultGetActiveFileTool: app.workspace.getActiveFile required");
  }

  return buildTool({
    name: "vault_get_active_file",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    userFacingName() {
      return "";
    },

    async *execute(_input, _ctx) {
      let file;
      try {
        file = app.workspace.getActiveFile();
      } catch (e) {
        yield {
          type: "result",
          content: `vault_get_active_file: workspace.getActiveFile threw: ${e && e.message ? e.message : e}`,
          isError: true,
        };
        return;
      }
      if (!file) {
        yield { type: "result", content: "vault_get_active_file: no active file (no note is open)." };
        return;
      }
      const path = typeof file.path === "string" ? file.path : "";
      const basename = typeof file.basename === "string" ? file.basename : path.split("/").pop();
      const parent = file.parent && typeof file.parent.path === "string" ? file.parent.path : "";
      yield {
        type: "result",
        content: JSON.stringify({ path, basename, parent }),
      };
    },
  });
}

module.exports = {
  createVaultGetActiveFileTool,
};
