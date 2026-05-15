// Tool registry + buildTool() factory.
//
// Every tool the model can invoke implements the Tool shape below.
// Defaults are fail-closed (assume not safe / not read-only / not
// concurrency-safe / no auto-allow) so a tool that forgets to declare
// a flag does the safe thing.
//
// Tools are pure functions / generators — they hold no global state
// and receive everything they need via the `ctx` parameter.

const TOOL_DEFAULTS = Object.freeze({
  isEnabled:         () => true,
  isReadOnly:        () => false,
  isDestructive:     () => false,
  isConcurrencySafe: () => false,
  checkPermissions:  async () => ({ behavior: "allow" }),
  validate:          async () => ({ ok: true }),
  userFacingName:    (_input) => "",
});

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {Object} inputSchema
 * @property {(input: any, ctx: any) => boolean} [isEnabled]
 * @property {(input: any) => boolean}    [isReadOnly]
 * @property {(input: any) => boolean}    [isDestructive]
 * @property {(input: any) => boolean}    [isConcurrencySafe]
 * @property {(input: any, ctx: any) => Promise<{ behavior: 'allow'|'deny'|'ask', reason?: string, summary?: string, choices?: string[] }>} [checkPermissions]
 * @property {(input: any, ctx: any) => Promise<{ ok: boolean, error?: string }>} [validate]
 * @property {(input: any, ctx: any) => AsyncIterable<{ type: 'progress'|'result', message?: string, data?: any, content?: any, isError?: boolean }>} execute
 * @property {(input: any) => string}     [userFacingName]
 */

/**
 * Build a Tool from a partial definition. Required fields throw at build
 * time so registration bugs surface during module load, not at agent-run
 * time.
 *
 * @param {ToolDef} def
 * @returns {ToolDef}
 */
function buildTool(def) {
  if (!def || typeof def !== "object") {
    throw new Error("buildTool: def is required");
  }
  if (!def.name || typeof def.name !== "string") {
    throw new Error("buildTool: name is required");
  }
  if (!def.description || typeof def.description !== "string") {
    throw new Error(`buildTool(${def.name}): description is required`);
  }
  if (!def.inputSchema || typeof def.inputSchema !== "object") {
    throw new Error(`buildTool(${def.name}): inputSchema is required`);
  }
  if (typeof def.execute !== "function") {
    throw new Error(`buildTool(${def.name}): execute must be a function`);
  }
  return { ...TOOL_DEFAULTS, ...def };
}

/**
 * Registry of tools currently available to the agent loop. One instance
 * per session (or per skill sub-conversation, when the skill restricts
 * the tool surface).
 */
class ToolRegistry {
  constructor() {
    /** @type {Map<string, ToolDef>} */
    this._tools = new Map();
  }

  /**
   * Register a Tool. Throws on duplicate name to catch wiring mistakes.
   * @param {ToolDef} tool
   */
  register(tool) {
    if (!tool || !tool.name) throw new Error("ToolRegistry.register: tool with name required");
    if (this._tools.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool "${tool.name}"`);
    }
    this._tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools in one call. Useful when wiring a session.
   * @param {ToolDef[]} tools
   */
  registerAll(tools) {
    for (const tool of tools || []) this.register(tool);
  }

  /**
   * @param {string} name
   * @returns {ToolDef | undefined}
   */
  get(name) {
    return this._tools.get(name);
  }

  /**
   * @returns {ToolDef[]} all tools in insertion order
   */
  list() {
    return Array.from(this._tools.values());
  }

  /**
   * Subset of tools whose name appears in `allowedNames`. Used when a
   * skill declares an `allowedTools` whitelist for its sub-conversation.
   * @param {string[]} allowedNames
   * @returns {ToolDef[]}
   */
  subset(allowedNames) {
    if (!Array.isArray(allowedNames)) return this.list();
    const allowed = new Set(allowedNames);
    return this.list().filter((t) => allowed.has(t.name));
  }

  /**
   * Anthropic-compatible tool spec the agent loop sends to the model.
   * Only `name`, `description`, `input_schema` — no internal flags leak.
   * @param {ToolDef[]} [subset]
   * @returns {Array<{name: string, description: string, input_schema: Object}>}
   */
  toApiSpecs(subset) {
    const tools = Array.isArray(subset) ? subset : this.list();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  size() {
    return this._tools.size;
  }
}

module.exports = {
  TOOL_DEFAULTS,
  buildTool,
  ToolRegistry,
};
