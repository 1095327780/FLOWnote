const { reduceExecutionEvents } = require("../../agent/execution-ledger");

function hasVerifiedMutation(execution) {
  const events = execution && execution.version === 1 && Array.isArray(execution.events)
    ? execution.events
    : null;
  if (!events) return false;
  try {
    const state = reduceExecutionEvents(events);
    return Object.values(state.runs).some((run) => Object.values(run.tools || {}).some((tool) => (
      tool && tool.effect && tool.effect.status === "verified"
      && tool.effect.receipt && tool.effect.receipt.kind !== "observation"
    )));
  } catch (_error) {
    return false;
  }
}

const LEGACY_MUTATION_TOOLS = new Set([
  "vault_write",
  "vault_edit",
  "vault_move",
  "vault_create_dir",
  "vault_daily",
  "vault_property",
  "web_request",
]);

function toolMayHaveMutated(tool) {
  if (!tool || String(tool.status || "") !== "unknown_after_reload") return false;
  const effect = String(tool.capabilities && tool.capabilities.effect || "").trim();
  if (effect) return effect !== "none" && effect !== "observation";
  return LEGACY_MUTATION_TOOLS.has(String(tool.tool || "").trim());
}

function hasUnknownMutation(execution) {
  const events = execution && execution.version === 1 && Array.isArray(execution.events)
    ? execution.events
    : null;
  if (!events) return false;
  try {
    const state = reduceExecutionEvents(events);
    return Object.values(state.runs).some((run) => (
      Object.values(run.tools || {}).some((tool) => toolMayHaveMutated(tool))
    ));
  } catch (_error) {
    return false;
  }
}

function getSuspendedRunId(execution) {
  const events = execution && execution.version === 1 && Array.isArray(execution.events)
    ? execution.events
    : null;
  if (!events) return "";
  try {
    const state = reduceExecutionEvents(events);
    const runs = Object.values(state.runs || {});
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      if (run && (run.status === "suspended" || run.disposition === "suspended")) {
        return String(run.id || "").trim();
      }
    }
  } catch (_error) {
    // A malformed/legacy ledger is not resumable. The user can still inspect
    // verified mutations below, but the UI must never invent a continuation.
  }
  return "";
}

function normalizeResolverOptions(options, legacySessionId = "") {
  if (options && typeof options.getContinuationClaimState === "function" && !options.sessionStore) {
    options = { sessionStore: options, sessionId: legacySessionId };
  }
  if (!options || typeof options !== "object") return { sessionStore: null, sessionId: "" };
  const sessionStore = options.sessionStore || null;
  let sessionId = String(options.sessionId || "").trim();
  if (!sessionId && sessionStore && typeof sessionStore.state === "function") {
    try {
      sessionId = String((sessionStore.state() || {}).activeSessionId || "").trim();
    } catch (_error) {
      sessionId = "";
    }
  }
  return { sessionStore, sessionId };
}

function continuationClaimState(sessionStore, sessionId, assistantId) {
  if (!sessionStore || typeof sessionStore.getContinuationClaimState !== "function") {
    return { status: "available", ownerDraftId: "" };
  }
  if (!sessionId || !assistantId) return { status: "stale", ownerDraftId: "" };
  try {
    const state = sessionStore.getContinuationClaimState(sessionId, assistantId);
    if (!state || typeof state !== "object") return { status: "stale", ownerDraftId: "" };
    return {
      status: String(state.status || "stale").trim().toLowerCase(),
      ownerDraftId: String(state.ownerDraftId || "").trim(),
    };
  } catch (_error) {
    return { status: "stale", ownerDraftId: "" };
  }
}

function baseAction(mode, assistantId = "", runId = "", extra = {}) {
  return {
    mode,
    assistantId: String(assistantId || ""),
    runId: String(runId || ""),
    ...extra,
  };
}

function resolveUserExecutionAction(messages, userMessageId, options = {}, legacySessionId = "") {
  const list = Array.isArray(messages) ? messages : [];
  const index = list.findIndex((message) => message && message.id === userMessageId);
  if (index < 0) return baseAction("retry");
  const assistant = list.slice(index + 1).find((message) => message && message.role === "assistant");
  if (!assistant) return baseAction("retry");
  const assistantId = String(assistant.id || "");
  const runId = getSuspendedRunId(assistant.execution);
  const status = String(assistant.status || "").trim().toLowerCase();
  if (status === "suspended") {
    const { sessionStore, sessionId } = normalizeResolverOptions(options, legacySessionId);
    // A suspended status without a valid ledger run is not a resumable
    // checkpoint. Keep the action surface truthful: inspect verified effects,
    // otherwise render no recovery action at all.
    if (!runId) {
      return hasVerifiedMutation(assistant.execution)
        ? baseAction("inspect", assistantId)
        : baseAction("none", assistantId);
    }
    const claim = continuationClaimState(sessionStore, sessionId, assistantId);
    if (claim.status === "available" || claim.status === "reclaimable") {
      return baseAction("continue", assistantId, runId);
    }
    if (claim.status === "active") {
      return baseAction("continuing", assistantId, runId, {
        disabled: true,
      });
    }
    return hasVerifiedMutation(assistant.execution)
      ? baseAction("inspect", assistantId, runId)
      : baseAction("none", assistantId, runId);
  }
  const hasContinuationMetadata = Boolean(
    String(assistant.continuationClaimedBy || "").trim()
    || String(assistant.continuationConsumedBy || "").trim(),
  );
  if (hasContinuationMetadata) {
    const { sessionStore, sessionId } = normalizeResolverOptions(options, legacySessionId);
    const claim = continuationClaimState(sessionStore, sessionId, assistantId);
    if (claim.status === "consumed" || claim.status === "stale") {
      if (hasVerifiedMutation(assistant.execution)) return baseAction("inspect", assistantId, runId);
      if (hasUnknownMutation(assistant.execution)) {
        return baseAction("inspect", assistantId, runId, { uncertain: true });
      }
      return baseAction("none", assistantId, runId);
    }
  }
  if (hasVerifiedMutation(assistant.execution)) {
    return baseAction("inspect", assistantId, runId);
  }
  if (hasUnknownMutation(assistant.execution)) {
    return baseAction("inspect", assistantId, runId, { uncertain: true });
  }
  return baseAction("retry", assistantId, runId);
}

module.exports = {
  resolveUserExecutionAction,
  hasVerifiedMutation,
  hasUnknownMutation,
  getSuspendedRunId,
};
