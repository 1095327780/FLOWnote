const TOOL_ALIASES = Object.freeze({
  read: "vault_read",
  write: "vault_write",
  edit: "vault_edit",
  multiedit: "vault_edit",
  ls: "vault_list",
  glob: "vault_list",
  grep: "vault_search",
  skill: "skill_invoke",
  question: "ask_user",
  todo_write: "vault_tasks",
  todowrite: "vault_tasks",
});

const TOOL_KINDS = Object.freeze({
  vault_read: "read",
  vault_list: "list",
  vault_search: "search",
  vault_write: "edit",
  vault_edit: "edit",
  vault_move: "edit",
  vault_create_dir: "edit",
  vault_daily: "note",
  vault_property: "note",
  vault_backlinks: "search",
  vault_tasks: "search",
  vault_tags: "search",
  vault_get_active_file: "read",
  skill_invoke: "skill",
  skill_resource_read: "read",
  ask_user: "question",
  web_fetch: "web",
  web_request: "web",
  web_search: "web",
  bash: "execute",
});

const TOOL_ICONS = Object.freeze({
  read: "file-text",
  list: "folder-tree",
  search: "search",
  edit: "file-pen",
  note: "notebook-pen",
  skill: "sparkles",
  question: "circle-help",
  web: "globe",
  execute: "terminal-square",
});

const MUTATION_TOOLS = new Set([
  "vault_write",
  "vault_edit",
  "vault_move",
  "vault_create_dir",
]);

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function canonicalToolName(value) {
  const raw = String(value || "tool").trim().toLowerCase() || "tool";
  return TOOL_ALIASES[raw] || raw;
}

function pickToolInput(block) {
  const raw = objectValue(block && block.raw) || {};
  const state = objectValue(raw.state) || {};
  return objectValue(block && block.toolInput)
    || objectValue(block && block.input)
    || objectValue(state.input)
    || objectValue(raw.input)
    || {};
}

function pickCapabilities(block) {
  const raw = objectValue(block && block.raw) || {};
  const value = objectValue(block && block.capabilities) || objectValue(raw.capabilities);
  return value && typeof value.effect === "string" && typeof value.presentation === "string"
    ? value
    : null;
}

function pickToolOutput(block, status) {
  const raw = objectValue(block && block.raw) || {};
  const state = objectValue(raw.state) || {};
  const error = String(
    (block && block.toolError)
    || state.error
    || raw.error
    || "",
  ).trim();
  if (status === "error" && error) return error;
  const output = String(
    (block && block.toolOutput)
    || (block && block.output)
    || state.output
    || raw.output
    || "",
  ).trim();
  if (output) return output;
  return String((block && block.detail) || "").trim();
}

function normalizeStatus(value) {
  const status = String(value || "pending").trim().toLowerCase();
  if (status === "done" || status === "success") return "completed";
  if (status === "failed") return "error";
  return ["pending", "running", "completed", "error", "unknown"].includes(status) ? status : "pending";
}

function pathFromInput(input) {
  return String(
    input.filePath
    || input.file_path
    || input.path
    || input.target_path
    || input.targetPath
    || input.filename
    || input.file
    || "",
  ).trim();
}

function compactTarget(toolName, input, capabilities) {
  const declaredTargets = capabilities && Array.isArray(capabilities.targets)
    ? capabilities.targets.map((target) => String(target || "").trim()).filter(Boolean)
    : [];
  if (toolName === "vault_move") {
    const from = String(input.from || "").trim();
    const to = String(input.to || "").trim();
    return from && to ? `${from} → ${to}` : from || to;
  }
  if (["vault_search", "vault_backlinks", "vault_tasks", "vault_tags"].includes(toolName)) {
    const query = String(input.query || input.pattern || input.tag || "").trim();
    const scope = String(input.path || "").trim();
    if (query && scope) return `“${query}” · ${scope}`;
    if (query) return `“${query}”`;
  }
  if (toolName === "bash") return String(input.description || input.command || input.cmd || "").trim();
  if (["web_fetch", "web_request"].includes(toolName)) return String(input.url || input.uri || "").trim();
  if (toolName === "web_search") return String(input.query || input.keyword || "").trim();
  if (toolName === "skill_invoke" || toolName === "skill_resource_read") {
    const skill = String(input.skill || input.name || "").trim();
    const path = String(input.path || "").trim();
    return skill && path ? `${skill} · ${path}` : skill || path;
  }
  if (toolName === "ask_user") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    return String((questions[0] && questions[0].question) || "").trim();
  }
  return pathFromInput(input) || declaredTargets.join(" → ");
}

function durationMsFromBlock(block) {
  const direct = Number(block && block.durationMs);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
  const raw = objectValue(block && block.raw) || {};
  const state = objectValue(raw.state) || {};
  const time = objectValue(state.time) || objectValue(raw.time) || {};
  const start = Number(time.start || time.created || 0);
  const end = Number(time.end || time.completed || 0);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round(end - start) : 0;
}

function formatDuration(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function mutationFromInput(toolName, input) {
  if (MUTATION_TOOLS.has(toolName)) return true;
  if (toolName === "vault_daily") return String(input.mode || "read") !== "read";
  if (toolName === "vault_property") return String(input.op || "get") !== "get";
  return false;
}

function normalizeToolActivity(block) {
  const rawName = String((block && block.tool) || (block && block.title) || "tool").trim() || "tool";
  const toolName = canonicalToolName(rawName);
  const capabilities = pickCapabilities(block);
  const kind = (capabilities && capabilities.presentation) || TOOL_KINDS[toolName] || "other";
  const input = pickToolInput(block);
  const status = normalizeStatus(block && block.status);
  const isMutation = capabilities
    ? !["none", "observation"].includes(capabilities.effect)
    : mutationFromInput(toolName, input);
  const durationMs = durationMsFromBlock(block);
  const explicitVerified = block && typeof block.verified === "boolean" ? block.verified : null;
  return {
    id: String((block && (block.id || block.callId)) || "").trim(),
    rawName,
    toolName,
    labelKey: toolName,
    kind,
    icon: TOOL_ICONS[kind] || "wrench",
    status,
    target: compactTarget(toolName, input, capabilities),
    path: pathFromInput(input),
    detail: pickToolOutput(block, status),
    error: status === "error",
    durationMs,
    durationLabel: formatDuration(durationMs),
    isMutation,
    verified: isMutation ? explicitVerified === true : status === "completed",
    interactive: kind === "question",
    capabilities,
    input,
  };
}

function toolActivityKey(block, index = 0) {
  const rawId = String((block && (block.id || block.callId)) || "").trim();
  if (rawId) return rawId.startsWith("tool:") ? rawId : `tool:${rawId}`;
  const toolName = canonicalToolName(block && block.tool);
  return `tool:${toolName}:${Math.max(0, Number(index) || 0)}`;
}

function blockActivityKey(block, index = 0) {
  const type = String((block && block.type) || "part").trim().toLowerCase() || "part";
  if (type === "tool") return toolActivityKey(block, index);
  const rawId = String((block && (block.id || block.callId)) || "").trim();
  return rawId ? `${type}:${rawId}` : `${type}:${Math.max(0, Number(index) || 0)}`;
}

function blockRenderSignature(block, _messagePending) {
  try {
    return JSON.stringify(block);
  } catch (_error) {
    return `${String((block && block.status) || "")}:${String((block && block.detail) || "")}`;
  }
}

module.exports = {
  canonicalToolName,
  normalizeToolActivity,
  toolActivityKey,
  blockActivityKey,
  blockRenderSignature,
  formatDuration,
};
