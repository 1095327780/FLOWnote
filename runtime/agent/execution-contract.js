// Typed task-contract preflight for direct agent turns.
//
// Natural-language assistant prose is never execution authority. Before the
// main agent loop starts, the provider gets a small control-only turn with one
// internal tool. Its structured result declares whether the user's request is
// answer-only, inspection-only, or requires a vault effect. Providers such as
// Zhipu only support automatic tool choice, so missing control calls are retried
// once and then fail closed instead of silently downgrading an action to prose.

const { consumeStream, contractIsSatisfied } = require("./agent-loop");

const CONTRACT_TOOL_NAME = "flownote_declare_task";
const CONTRACT_TOOL_SPEC = Object.freeze({
  name: CONTRACT_TOOL_NAME,
  description:
    "Declare the runtime contract for the user's request. Call this exactly once. " +
    "Use effect when the request asks FLOWnote to create, edit, append, rename, move, " +
    "delete, or otherwise change vault state; inspect for read/search/summarize tasks; " +
    "answer only when no external read or change is requested.",
  input_schema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["answer", "inspect", "effect"] },
      target_paths: {
        type: "array",
        items: { type: "string" },
        description: "Vault-relative paths named by the user. Empty when none are explicit.",
      },
      reason: { type: "string", description: "Brief reason for the selected mode." },
    },
    required: ["mode", "target_paths", "reason"],
  },
});

const CONTRACT_SYSTEM_PROMPT = [
  "You are FLOWnote's task-contract control plane.",
  `Do not answer or execute the user's request. Call ${CONTRACT_TOOL_NAME} exactly once.`,
  "Classify requested effects, not words in a hypothetical answer.",
  "A request to change any note, file, folder, daily note, or frontmatter is mode=effect.",
  "A request that needs vault reads/searches but no mutation is mode=inspect.",
  "A general question needing no external state is mode=answer.",
].join("\n");

// Explicit slash skills already carry their execution semantics in the
// standard SKILL.md body. They do not need a second model call to classify the
// task. Instead, the main model receives this internal finish tool alongside
// the ordinary vault tools and must declare how the workflow ended.
const WORKFLOW_FINISH_TOOL_NAME = "flownote_finish_skill";
const WORKFLOW_FINISH_INPUT_KEYS = new Set(["status", "mode", "target_paths", "reason"]);
// The model owns successful completion or explicit cancellation. It never owns
// a dead-end "blocked" terminal: recoverable waits must cross an interactive
// tool boundary and become a durable suspension, while capability failures are
// emitted by the host from observed tool outcomes.
const WORKFLOW_FINISH_STATUSES = new Set(["completed", "cancelled"]);
const WORKFLOW_COMPLETION_MODES = new Set(["answer", "inspect", "effect"]);
const WORKFLOW_EFFECT_RECEIPT_KINDS = new Set([
  "vault_mutation",
  "network_mutation",
  "external_side_effect",
]);
const WORKFLOW_FINISH_TOOL_SPEC = Object.freeze({
  name: WORKFLOW_FINISH_TOOL_NAME,
  description:
    "Finish the currently invoked FLOWnote skill workflow. Call this only when the skill has " +
    "completed or was cancelled. Waiting for user input must use ask_user and wait for its result; " +
    "the model must not invent a blocked terminal. A completed workflow " +
    "must declare whether it answered directly, inspected external state, or performed an effect.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["completed", "cancelled"] },
      mode: {
        type: "string",
        enum: ["answer", "inspect", "effect"],
        description: "Required only when status is completed.",
      },
      target_paths: {
        type: "array",
        items: { type: "string" },
        description: "Optional vault-relative targets that verified inspect/effect receipts must cover.",
      },
      reason: { type: "string", description: "Brief factual reason for this disposition." },
    },
    required: ["status"],
  },
});

const CONTRACT_BASE_TOKEN_BUDGET = 2048;

function contractTokenBudget(provider, attempt) {
  const modelId = provider && provider.userConfig && provider.userConfig.model;
  const models = provider && provider.spec && Array.isArray(provider.spec.models)
    ? provider.spec.models
    : [];
  const modelInfo = models.find((item) => item && item.id === modelId);
  const modelMax = Number(modelInfo && modelInfo.maxOutput);
  const requested = CONTRACT_BASE_TOKEN_BUDGET * (2 ** Math.max(0, attempt));
  return Number.isFinite(modelMax) && modelMax > 0 ? Math.min(requested, modelMax) : requested;
}

const EXECUTION_FALLBACK_COPY = Object.freeze({
  incomplete: {
    zh: "⚠️ 未完成：本次请求没有产生可验证的读取或更改，因此 FLOWnote 未将其标记为成功。请重试；若持续出现，请切换模型。",
    en: "⚠️ Not completed: this request produced no verifiable read or change, so FLOWnote did not mark it as successful. Retry, or switch models if it keeps happening.",
  },
  verified: {
    zh: "操作已完成。",
    en: "The operation is complete.",
  },
});

const EXECUTION_MODE_RANK = Object.freeze({ answer: 0, inspect: 1, effect: 2 });
const EXPLICIT_MUTATION_PATTERN = /(?:写入|保存(?:到|至|进)?|创建|新建|修改|编辑|追加|重命名|移动|删除|移除|归档|更新|设置|\bwrite\b|\bsave\b|\bcreate\b|\bupdate\b|\bedit\b|\bappend\b|\brename\b|\bmove\b|\bdelete\b|\bremove\b|\barchive\b)/iu;
const VAULT_TARGET_PATTERN = /(?:笔记|日记|周记|月记|年记|卡片|清单|收件箱|文件夹|文件|知识库|属性|frontmatter|\bnote\b|\bdaily\s+note\b|\bjournal\b|\binbox\b|\bfile\b|\bfolder\b|\bvault\b|\.md(?:\b|$)|\bзаметк\w*\b|\bдневник\w*\b)/iu;
const HOW_TO_PATTERN = /(?:如何|怎么|怎样|为什么|为何|教程|\bhow\s+to\b|\bhow\s+(?:do|can|should|would)\b|\bexplain\b|\bwhy\b|\bкак\b)/iu;
const QUESTION_ONLY_PATTERN = /(?:是什么|什么意思|最佳方式|是否|能否|可否|有没有|应该(?:如何|怎么)|\bwhat\b|\bwhich\b|\bshould\s+i\b|\bis\s+it\b|\bare\s+there\b|\bbest\s+way\b)/iu;
const DIRECT_REQUEST_SIGNAL_PATTERN = /(?:帮我|请(?:你)?|把|将|替我|麻烦|给我|\bplease\b|\bcan\s+you\b|\bcould\s+you\b|\bwould\s+you\b)/iu;
const NEGATED_ACTION_PATTERN = /(?:不要|别|无需|不用|\bdo\s+not\b|\bdon't\b|\bdo\s+not\s+need\b|\bне\s+(?:надо\s+)?(?:запис|сохран|добав)\w*\b)/iu;
const IMPLICIT_VAULT_CAPTURE_PATTERN = /(?:记一?下|记下来|记录一?下|记录下来|存(?:到|至|进)今天(?:的)?日记|收进(?:我的)?(?:笔记|收件箱)|\bmake\s+(?:a\s+)?note\s+of\b|\bjot(?:\s+this)?\s+down\b|\bremember\s+this\b|\bsave\b[^.?!\n]{0,120}\b(?:daily\s+note|journal)\b|(?:^|\s)запиши(?:\s|:|$)|(?:^|\s)зафиксируй(?:\s|:|$)|(?:^|\s)сохрани(?:\s|:)[^.?!\n]{0,120}дневник\w*|(?:^|\s)добавь(?:\s|:)[^.?!\n]{0,120}(?:дневник|заметк)\w*)/iu;

function extractExplicitVaultPaths(value) {
  const text = String(value || "");
  const matches = [];
  const pattern = /(?:^|[\s`'"“‘(（])([^\s`'"“”‘’<>()[\]（）]+\.md)(?=$|[\s`'"“”‘’<>()[\]（）,，.。!！?？;；:：])/giu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const path = normalizePath(match[1]);
    if (path && !matches.includes(path)) matches.push(path);
  }
  return matches;
}

/**
 * Conservative host-owned intent floor for explicit vault mutations.
 *
 * This does not classify arbitrary prose. It recognizes only an imperative
 * mutation paired with a concrete vault target and deliberately excludes
 * how-to/explanatory questions. The model may still upgrade the contract, but
 * it cannot downgrade this minimum to answer/inspect.
 */
function deriveHostExecutionMinimum(value) {
  const text = String(value || "").trim();
  if (!text || HOW_TO_PATTERN.test(text) || NEGATED_ACTION_PATTERN.test(text)) return null;
  if (QUESTION_ONLY_PATTERN.test(text) && !DIRECT_REQUEST_SIGNAL_PATTERN.test(text)) return null;
  if (IMPLICIT_VAULT_CAPTURE_PATTERN.test(text)) {
    return {
      mode: "effect",
      targetPaths: extractExplicitVaultPaths(text),
      source: "implicit_vault_capture",
    };
  }
  if (!EXPLICIT_MUTATION_PATTERN.test(text) || !VAULT_TARGET_PATTERN.test(text)) return null;
  return {
    mode: "effect",
    targetPaths: extractExplicitVaultPaths(text),
    source: "explicit_vault_mutation",
  };
}

function enforceHostContractMinimum(contract, minimum) {
  if (!contract || typeof contract !== "object" || !minimum || typeof minimum !== "object") return contract;
  const contractRank = EXECUTION_MODE_RANK[String(contract.mode || "")];
  const minimumMode = String(minimum.mode || "");
  const minimumRank = EXECUTION_MODE_RANK[minimumMode];
  if (!Number.isInteger(contractRank) || !Number.isInteger(minimumRank) || contractRank >= minimumRank) {
    return contract;
  }
  const targetPaths = [...new Set(
    (Array.isArray(minimum.targetPaths) ? minimum.targetPaths : [])
      .map(normalizePath)
      .filter(Boolean),
  )];
  const next = {
    ...contract,
    mode: minimumMode,
    source: `${String(contract.source || "model_control_tool")}+host_minimum`,
    hostMinimum: {
      mode: minimumMode,
      targetPaths,
      source: String(minimum.source || "host"),
    },
  };
  if (minimumMode === "effect") {
    next.requiredEffects = [{ kind: "vault_mutation", targetPaths }];
  } else if (minimumMode === "inspect") {
    next.requiredEffects = [{ kind: "observation", targetPaths }];
  }
  return next;
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
}

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
  if (state !== "declared" || !WORKFLOW_COMPLETION_MODES.has(mode)) {
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

function normalizeWorkflowFinishDeclaration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (Object.keys(input).some((key) => !WORKFLOW_FINISH_INPUT_KEYS.has(key))) return null;
  if (input.reason !== undefined && typeof input.reason !== "string") return null;
  if (
    input.target_paths !== undefined
    && (!Array.isArray(input.target_paths) || input.target_paths.some((path) => typeof path !== "string"))
  ) return null;
  const status = String(input.status || "");
  if (!WORKFLOW_FINISH_STATUSES.has(status)) return null;
  const hasMode = Object.prototype.hasOwnProperty.call(input, "mode");
  const rawMode = hasMode ? String(input.mode) : "";
  const hasTargetPaths = Object.prototype.hasOwnProperty.call(input, "target_paths");
  const targetPaths = hasTargetPaths
    ? [...new Set(input.target_paths.map(normalizePath).filter(Boolean))]
    : [];
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (status === "completed") {
    if (!WORKFLOW_COMPLETION_MODES.has(rawMode)) return null;
    return {
      status,
      mode: rawMode,
      ...(hasTargetPaths ? { targetPaths } : {}),
      reason,
    };
  }
  if (hasMode) return null;
  return {
    status,
    mode: null,
    ...(hasTargetPaths ? { targetPaths } : {}),
    reason,
  };
}

function validateWorkflowFinish(declaration, receipts, contract, interactionReceipts = []) {
  if (!declaration) return { ok: false, error: "Invalid workflow finish declaration." };
  if (declaration.status === "cancelled") {
    return { ok: true, error: "", verified: true };
  }

  const policyState = String((contract && contract.completionPolicyState) || "legacy_unclassified");
  const isStandardCompatibility = policyState === "legacy_unclassified";
  if (!isStandardCompatibility && policyState !== "declared") {
    return { ok: false, error: "Skill completion metadata is invalid." };
  }

  const requiredInteractions = Array.isArray(contract && contract.requiredInteractions)
    ? contract.requiredInteractions
    : [];
  const verifiedInteractions = (Array.isArray(interactionReceipts) ? interactionReceipts : [])
    .filter((receipt) => receipt && receipt.verified === true);
  for (const requiredTool of requiredInteractions) {
    if (!verifiedInteractions.some((receipt) => String(receipt.tool || "") === requiredTool)) {
      return {
        ok: false,
        error: `Cannot finish before a verified ${requiredTool} interaction required by the skill.`,
      };
    }
  }
  const requiredMode = String((contract && contract.completionMode) || "");
  if (!isStandardCompatibility && declaration.mode !== requiredMode) {
    return {
      ok: false,
      error: `Cannot complete as ${declaration.mode}; the host requires ${requiredMode} completion for this skill.`,
    };
  }

  const verified = (Array.isArray(receipts) ? receipts : [])
    .filter((receipt) => receipt && receipt.verified === true);
  const verifiedEffects = verified.filter((receipt) => WORKFLOW_EFFECT_RECEIPT_KINDS.has(receipt.kind));
  const verifiedObservations = verified.filter((receipt) => receipt.kind === "observation");
  const targetPaths = (Array.isArray(declaration.targetPaths) ? declaration.targetPaths : [])
    .map(normalizePath)
    .filter(Boolean);
  const standardVerification = isStandardCompatibility
    ? { state: "verified", policy: "standard_skill_protocol" }
    : null;

  // Standard SKILL.md files do not need FLOWnote-private frontmatter. Their
  // structured finish declaration is checked against what the host actually
  // observed. A workflow may not conceal a mutation as an answer/inspection,
  // and inspect/effect completion still requires a matching receipt.
  if (isStandardCompatibility && verifiedEffects.length > 0 && declaration.mode !== "effect") {
    return { ok: false, error: "Verified side effects exist; the workflow must declare effect completion." };
  }
  if (
    isStandardCompatibility
    && verifiedEffects.length === 0
    && verifiedObservations.length > 0
    && declaration.mode === "answer"
  ) {
    return { ok: false, error: "Verified observations exist; the workflow must declare inspect completion." };
  }
  if (declaration.mode === "answer") {
    return targetPaths.length === 0
      ? {
        ok: true,
        error: "",
        verified: true,
        ...(standardVerification ? { verification: standardVerification } : {}),
      }
      : { ok: false, error: "Answer completion cannot declare target_paths." };
  }

  const modeMatching = declaration.mode === "inspect"
    ? verifiedObservations
    : verifiedEffects;
  if (modeMatching.length === 0) {
    return declaration.mode === "inspect"
      ? { ok: false, error: "Cannot complete as inspect without a verified observation receipt." }
      : { ok: false, error: "Cannot complete as effect without a verified effect receipt." };
  }

  const requiredEffects = Array.isArray(contract && contract.requiredEffects)
    ? contract.requiredEffects
    : [];
  for (const requirement of requiredEffects) {
    const kind = String((requirement && requirement.kind) || "");
    if (!kind) continue;
    const matchingKind = verified.filter((receipt) => receipt.kind === kind);
    if (matchingKind.length === 0) {
      return { ok: false, error: `Cannot complete without a verified ${kind} receipt required by the host.` };
    }
    const requiredPaths = (Array.isArray(requirement && requirement.targetPaths)
      ? requirement.targetPaths
      : []).map(normalizePath).filter(Boolean);
    const coveredPaths = new Set(matchingKind.flatMap((receipt) => (
      Array.isArray(receipt.paths) ? receipt.paths.map(normalizePath).filter(Boolean) : []
    )));
    const missingPaths = requiredPaths.filter((path) => !coveredPaths.has(path));
    if (missingPaths.length > 0) {
      return {
        ok: false,
        error: `Cannot complete; no verified ${kind} receipt covers: ${missingPaths.join(", ")}.`,
      };
    }
  }

  const minimum = Math.max(1, Number.isInteger(contract && contract.minReceipts) ? contract.minReceipts : 1);
  const receiptPool = requiredEffects.length > 0
    ? verified.filter((receipt) => requiredEffects.some((requirement) => requirement.kind === receipt.kind))
    : modeMatching;
  if (receiptPool.length < minimum) {
    return {
      ok: false,
      error: `Cannot complete; the host requires at least ${minimum} verified receipt${minimum === 1 ? "" : "s"}.`,
    };
  }

  if (targetPaths.length > 0) {
    const coveredPaths = new Set(modeMatching.flatMap((receipt) => (
      Array.isArray(receipt.paths) ? receipt.paths.map(normalizePath).filter(Boolean) : []
    )));
    const missingPaths = targetPaths.filter((path) => !coveredPaths.has(path));
    if (missingPaths.length > 0) {
      return {
        ok: false,
        error: `Cannot complete as ${declaration.mode}; no verified receipt covers: ${missingPaths.join(", ")}.`,
      };
    }
  }
  return {
    ok: true,
    error: "",
    verified: true,
    ...(standardVerification ? { verification: standardVerification } : {}),
  };
}

function normalizeContractInput(input, userText) {
  if (!input || typeof input !== "object") return null;
  const mode = String(input.mode || "");
  if (!new Set(["answer", "inspect", "effect"]).has(mode)) return null;
  if (!Array.isArray(input.target_paths) || typeof input.reason !== "string") return null;
  const targetPaths = [...new Set(input.target_paths.map(normalizePath).filter(Boolean))];
  return {
    id: stableContractId(userText),
    mode,
    requiredEffects: mode === "effect"
      ? [{ kind: "vault_mutation", targetPaths }]
      : mode === "inspect"
        ? [{ kind: "observation", targetPaths }]
        : [],
    reason: input.reason.trim(),
    source: "model_control_tool",
  };
}

/**
 * @param {Object} args
 * @param {Object} args.provider
 * @param {string} args.userText
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.maxAttempts]
 * @returns {Promise<Object>}
 */
async function resolveExecutionContract({ provider, userText, signal, maxAttempts = 2 }) {
  if (!provider || typeof provider.createMessage !== "function") {
    throw new Error("resolveExecutionContract: provider with createMessage required");
  }
  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  const model = (provider.userConfig && provider.userConfig.model)
    || (provider.spec && provider.spec.defaultModel);
  let lastFailure = "missing control tool";
  let previousTruncated = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const retryNote = attempt > 0
      ? previousTruncated
        ? "\n\nThe previous control response was truncated. Emit the tool call immediately without extended reasoning."
        : "\n\nThe previous control response did not contain a valid task declaration. Emit only the tool call now."
      : "";
    const input = {
      model,
      system: CONTRACT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: `${String(userText || "")}${retryNote}` }] }],
      tools: [CONTRACT_TOOL_SPEC],
      maxTokens: contractTokenBudget(provider, attempt),
      temperature: 0,
    };
    if (signal) input.signal = signal;
    const result = await consumeStream(provider.createMessage(input));
    if (result.fatalError) {
      previousTruncated = result.stopReason === "max_tokens"
        || result.fatalError.type === "incomplete_model_output";
      if (previousTruncated && attempt + 1 < attempts) {
        lastFailure = "truncated control output";
        continue;
      }
      const error = new Error(result.fatalError.message || result.fatalError.type || "Provider stream error.");
      error.code = result.fatalError.type || "PROVIDER_STREAM_ERROR";
      throw error;
    }
    const declarations = result.toolUses.filter((toolUse) => toolUse.name === CONTRACT_TOOL_NAME);
    if (declarations.length === 1 && result.toolUses.length === 1) {
      const contract = normalizeContractInput(declarations[0].input, userText);
      if (contract) return contract;
      lastFailure = "invalid control tool arguments";
    } else {
      lastFailure = declarations.length === 0 ? "missing control tool" : "multiple control tools";
    }
  }

  const error = new Error(`Unable to establish a typed task contract: ${lastFailure}.`);
  error.code = "TASK_CONTRACT_MISSING";
  throw error;
}

async function resolveTurnExecutionContract({
  override, resolver, hasInjectedLoop, provider, userText, signal,
}) {
  const minimum = deriveHostExecutionMinimum(userText);
  if (override) return enforceHostContractMinimum(override, minimum);
  const selected = resolver || (!hasInjectedLoop ? resolveExecutionContract : null);
  const resolved = selected
    ? await selected({ provider, userText, signal, maxAttempts: 2 })
    : null;
  return enforceHostContractMinimum(resolved, minimum);
}

function createExecutionState(contract) {
  return {
    text: "",
    provisionalText: "",
    toolUses: [],
    effectReceipts: [],
    effectVerified: !contract || contract.mode === "answer",
    completionFailure: null,
  };
}

function acceptAssistantDelta(state, contract, deltaText) {
  if (contract && contract.mode !== "answer" && !state.effectVerified) {
    state.provisionalText += deltaText;
    return false;
  }
  state.text += deltaText;
  return true;
}

function recordExecutionReceipt(state, contract, receipt) {
  if (receipt) state.effectReceipts.push(receipt);
  if (contract && contract.mode === "workflow") return;
  state.effectVerified = contractIsSatisfied(contract, state.effectReceipts);
  if (state.effectVerified) state.provisionalText = "";
}

function executionContractLog(contract) {
  if (!contract) return "";
  const targets = (contract.requiredEffects || [])
    .flatMap((effect) => effect && Array.isArray(effect.targetPaths) ? effect.targetPaths : []);
  return `task contract id=${contract.id || "?"} mode=${contract.mode} targets=${targets.length}`;
}

module.exports = {
  CONTRACT_TOOL_NAME,
  CONTRACT_TOOL_SPEC,
  WORKFLOW_FINISH_TOOL_NAME,
  WORKFLOW_FINISH_TOOL_SPEC,
  EXECUTION_FALLBACK_COPY,
  resolveExecutionContract,
  resolveTurnExecutionContract,
  normalizeContractInput,
  createExplicitSkillWorkflowContract,
  normalizeWorkflowFinishDeclaration,
  validateWorkflowFinish,
  createExecutionState,
  acceptAssistantDelta,
  recordExecutionReceipt,
  executionContractLog,
  contractTokenBudget,
  deriveHostExecutionMinimum,
  enforceHostContractMinimum,
  extractExplicitVaultPaths,
};
