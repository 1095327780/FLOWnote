const { buildTool } = require("./tool-registry");

// Presentation only. Existing allowed-tools and permission policies still apply.
const CARD_TOOL_NAMES = new Set([
  "card_prepare", "card_commit", "card_expand_tools", "vault_read", "vault_search",
  "vault_list", "vault_edit", "vault_write", "vault_backlinks", "vault_create_dir",
  "vault_get_active_file", "ask_user", "skill_invoke", "skill_resource_read",
]);

function cardToolSurface(tools, ctx) {
  if (!ctx || !ctx.cardWorkflow) return tools.filter(tool => !["card_prepare", "card_commit", "card_expand_tools"].includes(tool.name));
  if (ctx.expandedCardTools) return tools;
  return tools.filter(tool => CARD_TOOL_NAMES.has(tool.name));
}

function updateCardToolSurface(ctx, toolUses, results) {
  for (const use of toolUses) {
    const result = results.find(item => item.id === use.id);
    if (!result || result.isError) continue;
    const data = result.outcome && result.outcome.data;
    if (use.name === "card_expand_tools" && data && data.expandedCardTools === true) ctx.expandedCardTools = true;
    if (use.name === "skill_invoke" && data && data.skillInvocation && data.skillInvocation.name === "ah-card") ctx.cardWorkflow = true;
  }
}

function createCardExpandToolsTool() {
  return buildTool({
    name: "card_expand_tools",
    description: "Make the full registered tool surface visible for the rest of this card workflow when additional abilities are needed (web, properties, tasks, moves, daily notes). Existing skill restrictions and write permissions remain in force. Call before requesting a deferred tool. This does not fetch anything or edit notes.",
    inputSchema: { type: "object", properties: {} },
    capabilities: { effect: "none", risk: "low", concurrency: "serial", presentation: "other", targets: [] },
    isReadOnly: () => true,
    async *execute() {
      yield { type: "result", content: "Full registered tools will be listed on the next model request. Existing allowed-tools and permission policies still apply.", data: { expandedCardTools: true } };
    },
  });
}

module.exports = { cardToolSurface, createCardExpandToolsTool, updateCardToolSurface };
