const {
  projectCapabilities,
  projectOutcome,
} = require("../agent/durable-execution-projection");

function toRendererStatus(status, isError) {
  if (isError) return "error";
  if (status === "running") return "running";
  if (status === "done") return "completed";
  if (status === "pending") return "pending";
  return "pending";
}

function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== "object") return "";
  const bounded = (value, maxLength = 240) => String(value || "").trim().slice(0, maxLength);
  const safeUrl = (value) => {
    const raw = bounded(value, 2048);
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      return bounded(`${parsed.origin}${parsed.pathname}`, 240);
    } catch (_error) {
      return bounded(raw.split(/[?#]/, 1)[0], 240);
    }
  };
  if (toolName === "vault_read") {
    const path = typeof input.path === "string" ? bounded(input.path) : "";
    if (!path) return "";
    if (typeof input.offset === "number" || typeof input.limit === "number") {
      return `${path} (lines ${input.offset || 1}-${input.limit ? (input.offset || 1) + input.limit - 1 : "end"})`;
    }
    return path;
  }
  if (toolName === "vault_write") {
    const path = typeof input.path === "string" ? bounded(input.path) : "";
    const mode = typeof input.mode === "string" ? bounded(input.mode, 32) : "create";
    return path ? `${mode} → ${path}` : mode;
  }
  if (toolName === "vault_edit") return typeof input.path === "string" ? bounded(input.path) : "";
  if (toolName === "vault_list") {
    const path = typeof input.path === "string" && input.path ? bounded(input.path) : "/";
    return input.pattern ? bounded(`${path} (${bounded(input.pattern, 120)})`) : path;
  }
  if (toolName === "vault_search") {
    const query = typeof input.query === "string" ? bounded(input.query, 120) : "";
    return input.path ? bounded(`"${query}" in ${bounded(input.path)}`) : `"${query}"`;
  }
  if (toolName === "vault_daily") {
    const mode = typeof input.mode === "string" ? input.mode : "read";
    const date = typeof input.date === "string" ? input.date : "today";
    return `${mode} ${date}`;
  }
  if (toolName === "vault_property") {
    const op = typeof input.op === "string" ? input.op : "get";
    return `${op} ${input.name || "?"} → ${input.path || "?"}`;
  }
  if (toolName === "vault_backlinks") return typeof input.path === "string" ? bounded(input.path) : "";
  if (toolName === "vault_tasks") {
    const status = typeof input.status === "string" ? input.status : "open";
    const path = typeof input.path === "string" && input.path ? input.path : "/";
    return `${status} in ${path}`;
  }
  if (toolName === "vault_tags") {
    const mode = typeof input.mode === "string" ? input.mode : "list";
    return mode === "files" ? `files ${input.tag || ""}` : "list";
  }
  if (toolName === "vault_move") {
    const from = typeof input.from === "string" ? input.from : "?";
    const to = typeof input.to === "string" ? input.to : "?";
    return `${from} → ${to}`;
  }
  if (toolName === "vault_create_dir") return typeof input.path === "string" ? input.path : "";
  if (toolName === "vault_get_active_file") return "";
  if (toolName === "skill_invoke") return typeof input.skill === "string" ? bounded(input.skill, 160) : "";
  if (toolName === "skill_resource_read") {
    const skill = typeof input.skill === "string" ? input.skill : "";
    const path = typeof input.path === "string" ? input.path : "";
    return skill && path ? `${skill}/${path}` : path || skill;
  }
  if (toolName === "ask_user") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    return questions.length
      ? bounded(`${questions.length} question(s): ${questions[0].header || questions[0].question || ""}`)
      : "";
  }
  if (toolName === "web_fetch") return typeof input.url === "string" ? safeUrl(input.url) : "";
  if (toolName === "web_request") {
    const method = typeof input.method === "string" && input.method ? input.method.toUpperCase() : "GET";
    return typeof input.url === "string" ? bounded(`${method} ${safeUrl(input.url)}`) : method;
  }
  return "";
}

function normalizeToolPath(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

function isExpectedInternalToolNoise(toolUse) {
  if (!toolUse || String(toolUse.name || "").trim().toLowerCase() !== "vault_read") return false;
  const path = normalizeToolPath(toolUse.input && toolUse.input.path);
  const isMemoryProbe = path === "Meta/ai-memory/STATUS.md"
    || path.startsWith("Meta/ai-memory/")
    || path === "Meta/.ai-memory/STATUS.md"
    || path.startsWith("Meta/.ai-memory/");
  if (!isMemoryProbe) return false;
  if (!toolUse.isError) return true;
  return /^vault_read:\s+file not found at /i.test(String(toolUse.output || "").trim());
}

/**
 * Render only the compact, durable block projection copied into SessionStore.
 * Raw tool input/output remains in the turn-local execution state.
 */
function projectDirectToolBlock(toolUse, receipt) {
  const status = toRendererStatus(toolUse && toolUse.status, toolUse && toolUse.isError);
  const summary = String(summarizeToolInput(toolUse && toolUse.name, toolUse && toolUse.input) || "").slice(0, 240);
  const hidden = isExpectedInternalToolNoise(toolUse);
  const safeOutcome = projectOutcome(toolUse && toolUse.outcome);
  return {
    id: String(toolUse && toolUse.id || ""),
    type: "tool",
    tool: String(toolUse && toolUse.name || ""),
    status,
    summary,
    detail: toolUse && toolUse.isError && safeOutcome && safeOutcome.code ? safeOutcome.code : "",
    capabilities: projectCapabilities(toolUse && toolUse.capabilities),
    outcome: safeOutcome,
    isError: !!(toolUse && toolUse.isError),
    verified: receipt ? receipt.verified === true : undefined,
    hidden,
    internal: hidden,
    durationMs: toolUse && toolUse.durationMs,
  };
}

function renderBlocks(state) {
  const blocks = [];
  if (state.text && state.text.length > 0) blocks.push({ type: "stream-text", text: state.text });
  for (const toolUse of state.toolUses) {
    const receipt = state.effectReceipts.find((item) => item && item.toolUseId === toolUse.id);
    blocks.push(projectDirectToolBlock(toolUse, receipt));
  }
  return blocks;
}

module.exports = {
  renderBlocks,
  summarizeToolInput,
  isExpectedInternalToolNoise,
  toRendererStatus,
  projectDirectToolBlock,
};
