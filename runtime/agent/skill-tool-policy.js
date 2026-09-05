// Host-enforced `allowed-tools` policy for standard Skills.
//
// Skill frontmatter is data, not a prompt hint. The loop owns the effective
// policy, advertises only its tool surface, and rejects an out-of-surface call
// even if a provider fabricates one.

const POLICY_VERSION = 1;
const HOST_PROTOCOL_TOOL_NAMES = new Set([
  "skill_invoke",
  "skill_resource_read",
  "flownote_finish_skill",
]);

function normalizeAllowedToolPolicy(value, registry) {
  if (value === undefined || value === null || value === "") return unrestrictedPolicy();
  const source = Array.isArray(value) ? value : value && value.allowedTools;
  if (!Array.isArray(source)) return invalid("allowed-tools must be an array of tool names.");
  const names = [];
  for (const raw of source) {
    if (typeof raw !== "string" || !raw.trim()) return invalid("allowed-tools must contain non-empty tool names.");
    const name = raw.trim();
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return unrestrictedPolicy();
  const known = new Set(registry && typeof registry.list === "function"
    ? registry.list().map((tool) => tool.name)
    : []);
  const unknown = names.filter((name) => !known.has(name) && !HOST_PROTOCOL_TOOL_NAMES.has(name));
  if (unknown.length > 0) return invalid(`Unknown allowed tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  return { ok: true, policy: { version: POLICY_VERSION, restricted: true, allowedTools: names } };
}

function unrestrictedPolicy() {
  return { ok: true, policy: { version: POLICY_VERSION, restricted: false, allowedTools: [] } };
}

function invalid(error) {
  return { ok: false, error, policy: null };
}

function applySkillAllowedTools(currentPolicy, declaredAllowedTools, registry) {
  const declared = normalizeAllowedToolPolicy(declaredAllowedTools, registry);
  if (!declared.ok) return declared;
  const current = normalizeAllowedToolPolicy(currentPolicy, registry);
  if (!current.ok) return current;
  if (!declared.policy.restricted) return current;
  if (!current.policy.restricted) return declared;
  return {
    ok: true,
    policy: {
      version: POLICY_VERSION,
      restricted: true,
      // A dynamically loaded skill may narrow permissions, never widen the
      // envelope chosen by an explicit invoking Skill.
      allowedTools: current.policy.allowedTools.filter((name) => declared.policy.allowedTools.includes(name)),
    },
  };
}

function toolIsAllowed(policy, toolName) {
  if (HOST_PROTOCOL_TOOL_NAMES.has(toolName)) return true;
  return !policy || !policy.restricted || policy.allowedTools.includes(toolName);
}

function visibleToolSpecs(registry, policy) {
  const tools = registry && typeof registry.list === "function" ? registry.list() : [];
  return tools.filter((tool) => toolIsAllowed(policy, tool.name));
}

function policyCheckpointValue(policy) {
  const normalized = normalizeAllowedToolPolicy(policy, null);
  return normalized.ok ? normalized.policy : null;
}

module.exports = {
  POLICY_VERSION,
  HOST_PROTOCOL_TOOL_NAMES,
  normalizeAllowedToolPolicy,
  applySkillAllowedTools,
  toolIsAllowed,
  visibleToolSpecs,
  policyCheckpointValue,
};
