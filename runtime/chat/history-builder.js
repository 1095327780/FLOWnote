const { buildExecutionRecap, reduceExecutionEvents } = require("../agent/execution-ledger");
const {
  isResumeRequest,
  validateContinuationCheckpoint,
} = require("../agent/continuation-checkpoint");

function executionRecordText(message) {
  const execution = message && message.execution;
  if (!execution || execution.version !== 1 || !Array.isArray(execution.events)) return "";
  try {
    const recap = buildExecutionRecap(execution.events);
    if (!recap) return "";
    return `<flownote_execution_record>${JSON.stringify(recap)}</flownote_execution_record>`;
  } catch (_error) {
    return "";
  }
}

/**
 * Convert persisted session messages to provider-neutral Anthropic content.
 * Assistant execution facts travel as a compact immutable record so later
 * requests such as “undo that rename” do not depend on model prose.
 */
function buildAnthropicHistory(storedMessages, draftId) {
  const out = [];
  for (const msg of storedMessages || []) {
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    if (msg.id === draftId) continue;
    if (msg.role === "assistant" && msg.pending) continue;
    const text = String(msg.text || "");
    const executionRecord = msg.role === "assistant" ? executionRecordText(msg) : "";
    if (!text && !executionRecord) continue;
    const content = [];
    if (text) content.push({ type: "text", text });
    if (executionRecord) content.push({ type: "text", text: executionRecord });
    out.push({ role: msg.role, content });
  }
  // mountPendingDraft already persisted the raw current input. The caller
  // appends the composed version carrying linked-context file blocks.
  if (out.length > 0 && out[out.length - 1].role === "user") out.pop();
  return out;
}

function normalizeContinuationLookupOptions(draftIdOrOptions, userText) {
  if (draftIdOrOptions && typeof draftIdOrOptions === "object") {
    return {
      draftId: String(draftIdOrOptions.draftId || "").trim(),
      userText: String(draftIdOrOptions.userText || ""),
      continuationMessageId: String(draftIdOrOptions.continuationMessageId || "").trim(),
      continuationRunId: String(draftIdOrOptions.continuationRunId || "").trim(),
    };
  }
  return {
    draftId: String(draftIdOrOptions || "").trim(),
    userText: String(userText || ""),
    continuationMessageId: "",
    continuationRunId: "",
  };
}

function inspectContinuationMessage(message, continuationRunId = "") {
  const messageId = String((message && message.id) || "").trim();
  const events = message && message.execution && message.execution.version === 1
    ? message.execution.events
    : null;
  if (!Array.isArray(events)) return { status: "corrupt", messageId, reason: "execution_missing" };
  let state;
  try {
    state = reduceExecutionEvents(events);
  } catch (error) {
    return {
      status: "corrupt",
      messageId,
      reason: "execution_invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const runs = Object.values(state.runs);
  const run = continuationRunId
    ? runs.find((candidate) => candidate && candidate.id === continuationRunId)
    : runs.at(-1);
  if (!run) return { status: "not_found", messageId, runId: continuationRunId, reason: "run_not_found" };
  if (run.status !== "suspended") {
    return { status: "stale", messageId, runId: run.id, reason: `run_${run.status || "not_suspended"}` };
  }
  const checkpointRef = run.terminalDetail && run.terminalDetail.checkpointRef;
  const checkpoint = run.terminalDetail && run.terminalDetail.checkpoint;
  if (!checkpointRef) {
    const validation = validateContinuationCheckpoint(checkpoint);
    if (!validation.ok) {
      return { status: "corrupt", messageId, runId: run.id, reason: "checkpoint_invalid", error: validation.error };
    }
  } else if (!checkpointRef || typeof checkpointRef !== "object" || Array.isArray(checkpointRef)) {
    return { status: "corrupt", messageId, runId: run.id, reason: "checkpoint_ref_invalid" };
  }
  const consumedBy = String(message.continuationConsumedBy || "").trim();
  if (consumedBy) {
    return {
      status: "stale",
      runId: run.id,
      messageId,
      claimedBy: String(message.continuationClaimedBy || "").trim(),
      consumedBy,
      reason: "continuation_consumed",
    };
  }
  const claimedBy = String(message.continuationClaimedBy || "").trim();
  return {
    status: claimedBy ? "claimed" : "resumable",
    runId: run.id,
    messageId,
    claimedBy,
    ...(checkpointRef
      ? { checkpointRef: JSON.parse(JSON.stringify(checkpointRef)) }
      : { checkpoint: JSON.parse(JSON.stringify(checkpoint)) }),
  };
}

function findResumableContinuation(storedMessages, draftIdOrOptions, userText) {
  const options = normalizeContinuationLookupOptions(draftIdOrOptions, userText);
  const targeted = Boolean(options.continuationMessageId || options.continuationRunId);
  if (!targeted && !isResumeRequest(options.userText)) {
    return { status: "not_found", reason: "not_resume_request" };
  }
  const messages = Array.isArray(storedMessages) ? storedMessages : [];
  if (targeted) {
    const message = messages.find((candidate) => (
      candidate
      && candidate.role === "assistant"
      && String(candidate.id || "") === options.continuationMessageId
    ));
    if (!message) {
      return {
        status: "not_found",
        messageId: options.continuationMessageId,
        runId: options.continuationRunId,
        reason: "message_not_found",
      };
    }
    return inspectContinuationMessage(message, options.continuationRunId);
  }

  let fallback = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.id === options.draftId || message.pending || message.role !== "assistant") continue;
    if (!message.execution) continue;
    const result = inspectContinuationMessage(message);
    if (result.status === "resumable") return result;
    if (!fallback && ["claimed", "corrupt", "stale"].includes(result.status)) fallback = result;
  }
  return fallback || { status: "not_found", reason: "checkpoint_not_found" };
}

module.exports = {
  buildAnthropicHistory,
  executionRecordText,
  findResumableContinuation,
};
