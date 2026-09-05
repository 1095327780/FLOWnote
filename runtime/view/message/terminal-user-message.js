const { reduceExecutionEvents } = require("../../agent/execution-ledger");
const { hasUnknownMutation } = require("./user-execution-action");

const TERMINAL_EVENT_TO_OUTCOME = Object.freeze({
  run_failed: "terminalFailed",
  run_suspended: "terminalSuspended",
  run_blocked: "terminalBlocked",
  run_cancelled: "terminalCancelled",
  run_interrupted: "terminalInterrupted",
  run_completed: "terminalMissingFinal",
});

function terminalOutcomeFromExecution(execution) {
  const events = execution && execution.version === 1 && Array.isArray(execution.events)
    ? execution.events
    : null;
  if (!events) return "";
  try {
    reduceExecutionEvents(events);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const outcome = TERMINAL_EVENT_TO_OUTCOME[events[index] && events[index].type];
      if (outcome) return outcome;
    }
  } catch (_error) {
    // Legacy or incomplete journals are not authoritative. The caller still
    // receives a clear missing-answer recovery message below.
  }
  return "";
}

/**
 * Derive the short user-facing outcome for an assistant message that has
 * activity/reasoning but no final prose. This is deliberately a projection of
 * durable state, shared by desktop and mobile renderers; it never treats tool
 * activity as a completed reply.
 */
function terminalUserMessage(message, { hasStructuredContent } = {}) {
  if (!message || message.role !== "assistant" || message.pending) return "";
  const status = String(message.status || "").trim().toLowerCase();
  const unknownMutation = status === "interrupted" && hasUnknownMutation(message.execution);
  if (String(message.text || "").trim() && !unknownMutation) return "";
  const hasContent = hasStructuredContent === undefined
    ? Boolean(String(message.reasoning || "").trim()) || (Array.isArray(message.blocks) && message.blocks.length > 0)
    : hasStructuredContent === true;
  if (!hasContent) return "";

  if (status === "failed") return "terminalFailed";
  if (status === "suspended") return "terminalSuspended";
  if (status === "blocked") return "terminalBlocked";
  if (status === "cancelled") return "terminalCancelled";
  if (status === "interrupted") {
    return unknownMutation
      ? "terminalInterruptedMutation"
      : "terminalInterrupted";
  }
  if (message.error) return "terminalFailed";

  const executionOutcome = terminalOutcomeFromExecution(message.execution);
  if (executionOutcome === "terminalInterrupted" && hasUnknownMutation(message.execution)) {
    return "terminalInterruptedMutation";
  }
  return executionOutcome || "terminalMissingFinal";
}

module.exports = {
  terminalUserMessage,
  terminalOutcomeFromExecution,
};
