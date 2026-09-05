// Safe, bounded projection for execution facts that cross the process boundary.
//
// The direct runner keeps rich tool input/output in its in-memory UI state. This
// module is the single allow-list for the append-only journal that is copied to
// SessionStore/data.json. It deliberately records machine identities and
// verified effects, never arbitrary provider/tool payloads or human prose.

const MAX_TARGETS = 32;
const MAX_EFFECTS = 16;
const MAX_CHECKPOINT_TOOL_IDS = 64;
const MAX_FILE_STATE_ENTRIES = 64;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_PATH_LENGTH = 320;
const CHECKPOINT_REF_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

function boundedIdentifier(value, maxLength = MAX_IDENTIFIER_LENGTH) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizedPath(value) {
  const pieces = String(value || "")
    .replace(/\\+/g, "/")
    .split("/");
  const normalized = [];
  for (const piece of pieces) {
    const part = piece.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join("/").slice(0, MAX_PATH_LENGTH);
}

function projectedPaths(value) {
  const paths = Array.isArray(value) ? value : [];
  return [...new Set(paths.map(normalizedPath).filter(Boolean))].slice(0, MAX_TARGETS);
}

function projectedEffects(value) {
  const effects = Array.isArray(value) ? value : [];
  return effects.slice(0, MAX_EFFECTS).map((effect) => ({
    kind: boundedIdentifier(effect && effect.kind),
    targets: projectedPaths(effect && (effect.targets || effect.targetPaths || effect.paths)),
  }));
}

function projectContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return null;
  return {
    id: boundedIdentifier(contract.id),
    mode: boundedIdentifier(contract.mode, 48),
    completionMode: boundedIdentifier(contract.completionMode, 48),
    completionPolicyState: boundedIdentifier(contract.completionPolicyState, 64),
    verificationMode: boundedIdentifier(contract.verificationMode, 64),
    requiredEffects: projectedEffects(contract.requiredEffects),
    requiredInteractions: (Array.isArray(contract.requiredInteractions) ? contract.requiredInteractions : [])
      .map((value) => boundedIdentifier(value, 64))
      .filter(Boolean)
      .slice(0, 16),
    minReceipts: Number.isSafeInteger(contract.minReceipts) && contract.minReceipts >= 0
      ? contract.minReceipts
      : 0,
    skillName: boundedIdentifier(contract.skillName),
    command: boundedIdentifier(contract.command),
    source: boundedIdentifier(contract.source, 64),
  };
}

function projectCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return null;
  return {
    effect: boundedIdentifier(capabilities.effect, 64),
    risk: boundedIdentifier(capabilities.risk, 32),
    concurrency: boundedIdentifier(capabilities.concurrency, 32),
    presentation: boundedIdentifier(capabilities.presentation, 32),
    targets: projectedPaths(capabilities.targets || capabilities.targetPaths || capabilities.paths),
  };
}

function projectOutcome(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null;
  return {
    state: boundedIdentifier(outcome.state, 64),
    code: boundedIdentifier(outcome.code, 96),
    effects: projectedEffects(outcome.effects),
  };
}

function projectReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  return {
    toolUseId: boundedIdentifier(receipt.toolUseId),
    tool: boundedIdentifier(receipt.tool),
    kind: boundedIdentifier(receipt.kind, 64),
    paths: projectedPaths(receipt.paths || receipt.targets || receipt.targetPaths),
    verified: receipt.verified === true,
    outcome: boundedIdentifier(receipt.outcome, 96),
  };
}

function projectCheckpointRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref) || ref.version !== 1) return null;
  const id = String(ref.id || "").trim();
  const path = normalizedPath(ref.path);
  const byteLength = Number(ref.byteLength);
  const hash = CHECKPOINT_REF_ID_PATTERN.test(id) ? id.slice("sha256:".length) : "";
  if (
    !hash
    || !path.endsWith(`/continuations/${hash}.json`)
    || !Number.isSafeInteger(byteLength)
    || byteLength < 1
  ) return null;
  return { version: 1, id, path, byteLength };
}

function stableFingerprint(value) {
  const text = JSON.stringify(value || null);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function projectCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
  const messages = Array.isArray(checkpoint.messages) ? checkpoint.messages : [];
  const toolUseIds = [];
  for (const message of messages) {
    for (const block of Array.isArray(message && message.content) ? message.content : []) {
      if (block && block.type === "tool_use") toolUseIds.push(boundedIdentifier(block.id));
    }
  }
  const fileEntries = checkpoint.fileState && checkpoint.fileState.version === 1
    && Array.isArray(checkpoint.fileState.entries)
    ? checkpoint.fileState.entries.slice(0, MAX_FILE_STATE_ENTRIES).map((entry) => ({
      path: normalizedPath(entry && entry.path),
      fingerprint: boundedIdentifier(entry && entry.fingerprint, 96),
      writtenInTurn: entry && entry.writtenInTurn === true,
    })).filter((entry) => entry.path && entry.fingerprint)
    : [];
  return {
    version: Number.isSafeInteger(checkpoint.version) ? checkpoint.version : 1,
    projection: "identity_only",
    fingerprint: stableFingerprint(checkpoint),
    messageCount: messages.length,
    toolUseIds: [...new Set(toolUseIds.filter(Boolean))].slice(0, MAX_CHECKPOINT_TOOL_IDS),
    effectReceipts: (Array.isArray(checkpoint.effectReceipts) ? checkpoint.effectReceipts : [])
      .map(projectReceipt).filter(Boolean).slice(0, MAX_EFFECTS),
    contract: projectContract(checkpoint.contract),
    completionRetries: Number.isSafeInteger(checkpoint.completionRetries) && checkpoint.completionRetries >= 0
      ? checkpoint.completionRetries
      : 0,
    turns: Number.isSafeInteger(checkpoint.turns) && checkpoint.turns >= 0 ? checkpoint.turns : 0,
    fileState: { version: 1, entries: fileEntries },
  };
}

function projectDurableExecutionFact(fact) {
  const source = fact && typeof fact === "object" ? fact : {};
  switch (source.type) {
    case "run_started":
      return { type: "run_started", contract: projectContract(source.contract), resumeFromRunId: boundedIdentifier(source.resumeFromRunId) || undefined };
    case "tool_started":
      return {
        type: "tool_started",
        toolUseId: boundedIdentifier(source.toolUseId),
        tool: boundedIdentifier(source.tool),
        capabilities: projectCapabilities(source.capabilities),
      };
    case "tool_finished":
      return {
        type: "tool_finished",
        toolUseId: boundedIdentifier(source.toolUseId),
        isError: source.isError === true,
        outcome: projectOutcome(source.outcome),
      };
    case "effect_verified":
    case "effect_unverified":
      return { type: source.type, toolUseId: boundedIdentifier(source.toolUseId), receipt: projectReceipt(source.receipt) };
    case "completion_rejected":
      return { type: "completion_rejected", final: source.final === true, attempt: Number.isSafeInteger(source.attempt) ? source.attempt : undefined };
    case "completion_accepted":
      return { type: "completion_accepted" };
    case "cancel_requested":
      return { type: "cancel_requested", stage: boundedIdentifier(source.stage, 64) || undefined };
    case "run_cancelled":
      return { type: "run_cancelled", stage: boundedIdentifier(source.stage, 64) || undefined, disposition: boundedIdentifier(source.disposition, 32) || undefined, verified: source.verified === true ? true : undefined };
    case "run_suspended":
      return {
        type: "run_suspended",
        reason: boundedIdentifier(source.reason, 96) || undefined,
        stage: boundedIdentifier(source.stage, 64) || undefined,
        turns: Number.isSafeInteger(source.turns) && source.turns >= 0 ? source.turns : undefined,
        checkpointRef: projectCheckpointRef(source.checkpointRef) || undefined,
      };
    case "run_blocked":
      return { type: "run_blocked", disposition: "blocked", verified: source.verified === true ? true : undefined };
    case "run_completed":
      return { type: "run_completed", disposition: "completed", verified: source.verified === true ? true : undefined };
    case "run_failed":
      return { type: "run_failed", code: boundedIdentifier(source.code, 96) || "execution_failed" };
    default:
      return { type: boundedIdentifier(source.type, 64) };
  }
}

module.exports = {
  projectDurableExecutionFact,
  projectContract,
  projectCapabilities,
  projectOutcome,
  projectReceipt,
  projectCheckpointRef,
  projectCheckpoint,
};
