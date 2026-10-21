// Completion policy of an explicitly invoked Skill.
//
// FLOWnote no longer predicts, before a turn, whether a request "should"
// change the vault, and the model no longer declares how a workflow ended.
// What changed is measured by the host (vault-change-recorder) and reconciled
// with the model's final message when it stops (turn-audit). This module only
// records what an explicit Skill's metadata requires, for that check.

const COMPLETION_MODES = new Set(["answer", "inspect", "effect"]);

const EXECUTION_FALLBACK_COPY = Object.freeze({
  verified: {
    zh: "操作已完成。",
    en: "The operation is complete.",
  },
});

function stableContractId(text) {
  let hash = 0x811c9dc5;
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `task-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function createExplicitSkillWorkflowContract({ skillName, command, args, completionPolicy } = {}) {
  const normalizedSkillName = String(skillName || "").trim();
  const normalizedCommand = String(command || (normalizedSkillName ? `/${normalizedSkillName}` : "")).trim();
  const normalizedArgs = args === undefined || args === null ? "" : String(args);
  const policy = normalizeSkillCompletionPolicy(completionPolicy);
  if (policy.state === "invalid") {
    const error = new Error(
      `Skill /${normalizedSkillName || "unknown"} has invalid completion metadata (${policy.errorCode}).`,
    );
    error.code = "SKILL_COMPLETION_METADATA_INVALID";
    error.metadataErrorCode = policy.errorCode;
    throw error;
  }
  return {
    id: stableContractId(`${normalizedCommand}\n${normalizedArgs}`).replace(/^task-/, "skill-"),
    mode: "workflow",
    completionMode: policy.mode,
    completionPolicyState: policy.state,
    verificationMode: policy.state === "declared" ? "host_verified" : "standard_protocol",
    requiredEffects: policy.requiredEffects.map((kind) => ({ kind, targetPaths: [] })),
    requiredInteractions: policy.requiredInteractions.slice(),
    minReceipts: policy.state === "declared" && policy.mode !== "answer"
      ? Math.max(1, policy.minReceipts === null ? 1 : policy.minReceipts)
      : 0,
    skillName: normalizedSkillName,
    command: normalizedCommand,
    args: normalizedArgs,
    source: "explicit_skill",
  };
}

function normalizeSkillCompletionPolicy(input) {
  if (input === undefined || input === null) {
    return { state: "legacy_unclassified", mode: null, requiredEffects: [], requiredInteractions: [], minReceipts: null, errorCode: null };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { state: "invalid", mode: null, requiredEffects: [], requiredInteractions: [], minReceipts: null, errorCode: "invalid_policy_projection" };
  }
  const state = String(input.state || "");
  if (state === "legacy_unclassified") {
    return { state, mode: null, requiredEffects: [], requiredInteractions: [], minReceipts: null, errorCode: null };
  }
  const mode = String(input.mode || "");
  const requiredEffects = Array.isArray(input.requiredEffects)
    ? [...new Set(input.requiredEffects.filter((kind) => typeof kind === "string" && kind.trim()).map((kind) => kind.trim()))]
    : [];
  const requiredInteractions = Array.isArray(input.requiredInteractions)
    ? [...new Set(input.requiredInteractions
      .filter((kind) => typeof kind === "string" && kind.trim())
      .map((kind) => kind.trim()))]
    : [];
  const minReceipts = Number.isInteger(input.minReceipts) && input.minReceipts >= 0
    ? input.minReceipts
    : null;
  if (state !== "declared" || !COMPLETION_MODES.has(mode)) {
    return {
      state: "invalid",
      mode: null,
      requiredEffects: [],
      requiredInteractions: [],
      minReceipts: null,
      errorCode: String(input.errorCode || "invalid_policy_projection"),
    };
  }
  if (requiredInteractions.some((kind) => kind !== "ask_user")) {
    return {
      state: "invalid",
      mode: null,
      requiredEffects: [],
      requiredInteractions: [],
      minReceipts: null,
      errorCode: "invalid_required_interaction",
    };
  }
  return { state, mode, requiredEffects, requiredInteractions, minReceipts, errorCode: null };
}

module.exports = {
  EXECUTION_FALLBACK_COPY,
  createExplicitSkillWorkflowContract,
  normalizeSkillCompletionPolicy,
};
