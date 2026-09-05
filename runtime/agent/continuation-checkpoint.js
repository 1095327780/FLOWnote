// Provider-neutral continuation checkpoints.
//
// A checkpoint is written only after a model turn has reached a safe boundary:
// no tool is in flight and every assistant tool_use has a matching user
// tool_result. It is intentionally separate from the execution recap: the
// recap is compact context for ordinary future turns, while this object is the
// exact conversation needed to resume one suspended workflow.

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateContinuationCheckpoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Checkpoint must be an object." };
  }
  if (value.version !== 1) return { ok: false, error: "Unsupported checkpoint version." };
  if (!Array.isArray(value.messages)) return { ok: false, error: "Checkpoint messages must be an array." };
  if (!Array.isArray(value.effectReceipts)) {
    return { ok: false, error: "Checkpoint effectReceipts must be an array." };
  }
  if (value.interactionReceipts !== undefined && !Array.isArray(value.interactionReceipts)) {
    return { ok: false, error: "Checkpoint interactionReceipts must be an array." };
  }
  if (!Number.isSafeInteger(value.completionRetries) || value.completionRetries < 0) {
    return { ok: false, error: "Checkpoint completionRetries must be a non-negative integer." };
  }
  if (!Number.isSafeInteger(value.turns) || value.turns < 0) {
    return { ok: false, error: "Checkpoint turns must be a non-negative integer." };
  }
  if (value.allowedToolPolicy !== undefined) {
    const policy = value.allowedToolPolicy;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)
      || policy.version !== 1 || typeof policy.restricted !== "boolean"
      || !Array.isArray(policy.allowedTools)
      || policy.allowedTools.some((name) => typeof name !== "string" || !name.trim())) {
      return { ok: false, error: "Checkpoint allowedToolPolicy is invalid." };
    }
  }
  if (value.effectAttempts !== undefined) {
    if (!Array.isArray(value.effectAttempts) || value.effectAttempts.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.version !== 1) return true;
      const fingerprint = String(entry.fingerprint || "");
      const hash = fingerprint.startsWith("sha256:") ? fingerprint.slice(7) : "";
      return !/^[a-f0-9]{64}$/.test(hash)
        || typeof entry.tool !== "string" || !entry.tool.trim()
        || !["prepared", "sending", "accepted_unverified", "rejected", "unknown_after_send"].includes(entry.state)
        || entry.idempotencyKey !== `flownote-${hash}`;
    })) return { ok: false, error: "Checkpoint effectAttempts are invalid." };
  }

  const unresolved = new Set();
  for (const message of value.messages) {
    if (!message || !["user", "assistant"].includes(message.role) || !Array.isArray(message.content)) {
      return { ok: false, error: "Checkpoint contains an invalid provider message." };
    }
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (message.role === "assistant" && block.type === "tool_use") {
        const id = String(block.id || "").trim();
        if (!id) return { ok: false, error: "Checkpoint contains a tool call without an id." };
        if (unresolved.has(id)) return { ok: false, error: `Checkpoint repeats unresolved tool call ${id}.` };
        unresolved.add(id);
      }
      if (message.role === "user" && block.type === "tool_result") {
        const id = String(block.tool_use_id || "").trim();
        if (!unresolved.has(id)) {
          return { ok: false, error: `Checkpoint contains a result for unknown tool call ${id || "<missing>"}.` };
        }
        unresolved.delete(id);
      }
    }
  }
  if (unresolved.size > 0) {
    return { ok: false, error: `Checkpoint has unresolved tool call ${Array.from(unresolved)[0]}.` };
  }
  try {
    JSON.stringify(value);
  } catch (_error) {
    return { ok: false, error: "Checkpoint must be JSON-serializable." };
  }
  return { ok: true, error: "" };
}

function createContinuationCheckpoint({
  conversation,
  effectReceipts,
  interactionReceipts,
  executionContract,
  completionRetries,
  turns,
  fileState,
  allowedToolPolicy,
  effectAttempts,
} = {}) {
  const checkpoint = {
    version: 1,
    messages: cloneJson(Array.isArray(conversation) ? conversation : []),
    effectReceipts: cloneJson(Array.isArray(effectReceipts) ? effectReceipts : []),
    contract: executionContract ? cloneJson(executionContract) : null,
    completionRetries: Math.max(0, Math.floor(Number(completionRetries) || 0)),
    turns: Math.max(0, Math.floor(Number(turns) || 0)),
  };
  if (Array.isArray(interactionReceipts) && interactionReceipts.length > 0) {
    checkpoint.interactionReceipts = cloneJson(interactionReceipts);
  }
  if (allowedToolPolicy) checkpoint.allowedToolPolicy = cloneJson(allowedToolPolicy);
  if (Array.isArray(effectAttempts) && effectAttempts.length > 0) checkpoint.effectAttempts = cloneJson(effectAttempts);
  if (fileState && typeof fileState === "object") checkpoint.fileState = cloneJson(fileState);
  const validation = validateContinuationCheckpoint(checkpoint);
  if (!validation.ok) throw new Error(`ContinuationCheckpoint: ${validation.error}`);
  return checkpoint;
}

function appendResumeInstruction(messages, userText) {
  const out = cloneJson(Array.isArray(messages) ? messages : []);
  const instruction = {
    type: "text",
    text:
      "[FLOWNOTE_RESUME] The user explicitly requested that this suspended workflow continue from its " +
      `checkpoint. Do not repeat verified effects. User input: ${String(userText || "continue")}`,
  };
  // Keep the resume instruction in its own user turn. OpenAI-compatible
  // providers require every tool_result to immediately follow the assistant
  // tool_calls message; mixing text into that canonical tool-result message
  // makes the adapter emit the user text before role=tool messages.
  out.push({ role: "user", content: [instruction] });
  return out;
}

function isResumeRequest(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^(继续|继续执行|接着执行|接着来|resume|continue)[.!。！]?$/.test(normalized);
}

module.exports = {
  createContinuationCheckpoint,
  validateContinuationCheckpoint,
  appendResumeInstruction,
  isResumeRequest,
};
