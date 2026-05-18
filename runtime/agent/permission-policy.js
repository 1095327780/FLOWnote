const TOOL_PERMISSION_MODES = Object.freeze({
  ASK: "ask",
  ASK_DANGEROUS: "ask-dangerous",
  AUTO: "auto",
});

function normalizeToolPermissionMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (
    raw === "ask-dangerous" ||
    raw === "dangerous" ||
    raw === "balanced" ||
    raw === "safe-auto"
  ) {
    return TOOL_PERMISSION_MODES.ASK_DANGEROUS;
  }
  if (
    raw === "auto" ||
    raw === "full-auto" ||
    raw === "accept-all" ||
    raw === "allow-all"
  ) {
    return TOOL_PERMISSION_MODES.AUTO;
  }
  return TOOL_PERMISSION_MODES.ASK;
}

function normalizeToolName(toolOrName) {
  if (typeof toolOrName === "string") return toolOrName.trim().toLowerCase();
  return String((toolOrName && toolOrName.name) || "").trim().toLowerCase();
}

function normalizeMethod(input) {
  return String((input && input.method) || "GET").trim().toUpperCase() || "GET";
}

function explicitRisk(permission) {
  const raw = String(
    (permission && (permission.risk || permission.level || permission.severity)) || "",
  ).trim().toLowerCase();
  if (["danger", "dangerous", "destructive", "high"].includes(raw)) return "dangerous";
  if (["safe", "low", "routine", "read"].includes(raw)) return "safe";
  return "";
}

function callToolFlag(tool, flagName, input) {
  if (!tool || typeof tool[flagName] !== "function") return null;
  try {
    return !!tool[flagName](input);
  } catch (_e) {
    return null;
  }
}

function isDangerousToolUse({ tool, toolName, input, permission } = {}) {
  const risk = explicitRisk(permission);
  if (risk === "dangerous") return true;
  if (risk === "safe") return false;

  const name = normalizeToolName(toolName || tool);
  if (name === "vault_move") return true;
  if (name === "vault_write") return String((input && input.mode) || "create") === "overwrite";
  if (name === "vault_edit") return !!(input && input.replace_all);
  if (name === "vault_property") return String((input && input.op) || "get") === "delete";
  if (name === "vault_daily") return false;
  if (name === "vault_create_dir") return false;
  if (name === "web_fetch") return false;
  if (name === "web_request") {
    const method = normalizeMethod(input);
    return method === "DELETE" || method === "PATCH" || method === "PUT";
  }

  const destructive = callToolFlag(tool, "isDestructive", input);
  if (destructive === true) return true;
  const readOnly = callToolFlag(tool, "isReadOnly", input);
  if (readOnly === true) return false;

  // Unknown tools that ask for permission should stay interactive.
  return true;
}

function resolvePermissionDecision({ mode, tool, toolName, input, permission } = {}) {
  const normalized = normalizeToolPermissionMode(mode);
  if (normalized === TOOL_PERMISSION_MODES.AUTO) {
    return { behavior: "allow", reason: "auto" };
  }
  if (normalized === TOOL_PERMISSION_MODES.ASK_DANGEROUS) {
    const dangerous = isDangerousToolUse({ tool, toolName, input, permission });
    return dangerous
      ? { behavior: "ask", reason: "dangerous" }
      : { behavior: "allow", reason: "low-risk" };
  }
  return { behavior: "ask", reason: "strict" };
}

function resolvePermissionRequestDecision(mode, permission) {
  const toolName = String(
    (permission && (permission.type || permission.tool || permission.name)) || "",
  );
  const input =
    (permission && permission.metadata && typeof permission.metadata === "object" && permission.metadata) ||
    (permission && permission.input && typeof permission.input === "object" && permission.input) ||
    {};
  return resolvePermissionDecision({ mode, toolName, input, permission });
}

module.exports = {
  TOOL_PERMISSION_MODES,
  normalizeToolPermissionMode,
  isDangerousToolUse,
  resolvePermissionDecision,
  resolvePermissionRequestDecision,
};
