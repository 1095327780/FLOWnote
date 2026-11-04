const { buildExecutionRecap, reduceExecutionEvents } = require("../agent/execution-ledger");
const {
  isResumeRequest,
  validateContinuationCheckpoint,
} = require("../agent/continuation-checkpoint");

const MAX_REPLAYED_TOOLS_PER_MESSAGE = 24;
const LEGACY_HOST_SUMMARY_HEADINGS = [
  "**已完成并核验**", "**已完成检查**",
  "**Completed and verified**", "**Inspection complete**",
  "**Выполнено и проверено**", "**Проверка завершена**",
];

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

// Earlier versions appended a host-written completion summary to the model's
// text. Keep it out of the model's own history so it is never imitated.
function stripLegacyHostSummary(text) {
  const value = String(text || "");
  for (const heading of LEGACY_HOST_SUMMARY_HEADINGS) {
    const at = value.lastIndexOf(`\n\n${heading}\n`);
    const start = at >= 0 ? at : (value.startsWith(`${heading}\n`) ? 0 : -1);
    if (start < 0) continue;
    const tail = value.slice(start).trim().split("\n").slice(1);
    if (tail.length && tail.every((line) => /^- /.test(line.trim()))) return value.slice(0, start).trim();
  }
  return value;
}

function sanitizeToolUseId(prefix, id) {
  return `${prefix}_${String(id || "tool").replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 96);
}

/**
 * Real tool_use / tool_result pairs for a stored assistant message, or null
 * when the message predates recorded argument previews.
 */
function executionReplay(message, prefix) {
  const execution = message && message.execution;
  if (!execution || execution.version !== 1 || !Array.isArray(execution.events)) return null;
  let state;
  try {
    state = reduceExecutionEvents(execution.events);
  } catch (_error) {
    return null;
  }
  const tools = Object.values(state.runs).flatMap((run) => Object.values(run.tools || {}));
  if (!tools.length) return [];
  if (tools.some((tool) => !tool.inputPreview || typeof tool.inputPreview !== "object")) return null;
  return tools.slice(-MAX_REPLAYED_TOOLS_PER_MESSAGE).map((tool) => {
    const finished = tool.status === "succeeded" || tool.status === "failed";
    const attempt = tool.effectAttempt;
    if (attempt && attempt.state === "unknown_after_send") {
      return {
        id: sanitizeToolUseId(prefix, tool.id),
        name: tool.tool,
        input: tool.inputPreview,
        isError: true,
        result: `${attempt.method} ${attempt.endpoint} was sent, but its result was never recorded; the external change may `
          + "already have taken effect. Do not resend it or a similar change to this service unless the user explicitly "
          + "confirms after checking the service; FLOWnote will ask the user before sending one.",
      };
    }
    return {
      id: sanitizeToolUseId(prefix, tool.id),
      name: tool.tool,
      input: tool.inputPreview,
      isError: !finished || tool.status === "failed",
      result: finished
        ? String(tool.resultPreview || (tool.status === "failed" ? "Tool failed." : "Done."))
        : "Interrupted before the result was recorded; the outcome is unknown.",
    };
  });
}

/**
 * Convert persisted session messages to provider-neutral Anthropic content.
 * Earlier assistant turns are replayed as the tool calls they really made,
 * followed by their final text; messages from older versions fall back to
 * their text plus a compact execution record.
 */
function buildAnthropicHistory(storedMessages, draftId) {
  const out = [];
  let index = 0;
  for (const msg of storedMessages || []) {
    index += 1;
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    if (msg.id === draftId) continue;
    if (msg.role === "assistant" && msg.pending) continue;
    if (msg.role === "user") {
      const text = String(msg.text || "");
      if (text) out.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }
    const text = stripLegacyHostSummary(msg.text);
    const replay = executionReplay(msg, `h${index}`);
    if (replay && replay.length) {
      for (const tool of replay) {
        out.push({ role: "assistant", content: [{ type: "tool_use", id: tool.id, name: tool.name, input: tool.input }] });
        out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: tool.result, is_error: tool.isError }] });
      }
      out.push({ role: "assistant", content: [{ type: "text", text: text || "(no text reply)" }] });
      continue;
    }
    const executionRecord = replay ? "" : executionRecordText(msg);
    if (!text && !executionRecord) continue;
    const content = [];
    if (text) content.push({ type: "text", text });
    if (executionRecord) content.push({ type: "text", text: executionRecord });
    out.push({ role: "assistant", content });
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
