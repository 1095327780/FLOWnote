function isObject(value) {
  return Boolean(value) && typeof value === "object";
}

function extractNestedStatusObject(status) {
  if (!isObject(status)) return null;
  if (isObject(status.status)) return status.status;
  if (isObject(status.state)) return status.state;
  return null;
}

function extractSessionStatusType(status) {
  if (!isObject(status)) return "";
  if (typeof status.type === "string" && status.type.trim()) return status.type.trim().toLowerCase();
  if (typeof status.status === "string" && status.status.trim()) return status.status.trim().toLowerCase();
  if (typeof status.state === "string" && status.state.trim()) return status.state.trim().toLowerCase();
  const nested = extractNestedStatusObject(status);
  if (nested && typeof nested.type === "string" && nested.type.trim()) return nested.type.trim().toLowerCase();
  if (nested && typeof nested.status === "string" && nested.status.trim()) return nested.status.trim().toLowerCase();
  if (nested && typeof nested.state === "string" && nested.state.trim()) return nested.state.trim().toLowerCase();
  return "";
}

function extractSessionStatusHint(status) {
  if (!isObject(status)) return "";
  const nested = extractNestedStatusObject(status);
  const text = [
    extractSessionStatusType(status),
    typeof status.message === "string" ? status.message : "",
    typeof status.error === "string" ? status.error : "",
    typeof status.reason === "string" ? status.reason : "",
    nested && typeof nested.message === "string" ? nested.message : "",
    nested && typeof nested.error === "string" ? nested.error : "",
    nested && typeof nested.reason === "string" ? nested.reason : "",
  ]
    .filter(Boolean)
    .join(" ");
  return String(text || "").trim();
}

function isSessionStatusActive(status) {
  const type = extractSessionStatusType(status);
  if (type && ["busy", "retry", "running", "queued", "in_progress", "in-progress", "processing"].includes(type)) {
    return true;
  }
  const hint = extractSessionStatusHint(status);
  if (!hint) return false;
  return /(busy|retry|running|queued|in[ -]?progress|processing|thinking|generating|waiting)/i.test(hint);
}

function isSessionStatusTerminal(status) {
  const type = extractSessionStatusType(status);
  if (
    type
    && [
      "idle",
      "done",
      "completed",
      "complete",
      "failed",
      "error",
      "aborted",
      "cancelled",
      "timeout",
      "stopped",
    ].includes(type)
  ) {
    return true;
  }
  const hint = extractSessionStatusHint(status);
  if (!hint) return false;
  return /(idle|done|completed|complete|failed|error|aborted|cancelled|timeout|stopped|no pending)/i.test(hint);
}

function isAssistantMessageCompletedInfo(info) {
  if (!isObject(info)) return false;
  const completedAt = isObject(info.time)
    ? Number(info.time.completed || 0)
    : 0;
  if (completedAt > 0) return true;
  return String(info.finish || "").trim().length > 0;
}

function isAssistantMessageEnvelopeCompleted(envelope) {
  const info = isObject(envelope) && isObject(envelope.info) ? envelope.info : null;
  if (!info) return false;
  const role = String(info.role || "").trim().toLowerCase();
  if (role && role !== "assistant") return false;
  return isAssistantMessageCompletedInfo(info);
}

function extractSessionIdFromEventProperties(properties) {
  const props = isObject(properties) ? properties : {};
  if (typeof props.sessionID === "string" && props.sessionID.trim()) return props.sessionID.trim();
  if (typeof props.sessionId === "string" && props.sessionId.trim()) return props.sessionId.trim();
  if (typeof props.id === "string" && props.id.trim()) return props.id.trim();

  const info = isObject(props.info) ? props.info : null;
  if (!info) return "";
  if (typeof info.sessionID === "string" && info.sessionID.trim()) return info.sessionID.trim();
  if (typeof info.sessionId === "string" && info.sessionId.trim()) return info.sessionId.trim();
  if (typeof info.id === "string" && info.id.trim()) return info.id.trim();
  return "";
}

function extractSessionStatusFromEventProperties(properties) {
  const props = isObject(properties) ? properties : {};
  if (isObject(props.status) || typeof props.status === "string") return props.status;

  const info = isObject(props.info) ? props.info : null;
  if (!info) return null;
  if (isObject(info.status) || typeof info.status === "string") return info.status;
  if (isObject(info.state) || typeof info.state === "string") return info.state;
  return null;
}

module.exports = {
  extractSessionStatusType,
  extractSessionStatusHint,
  isSessionStatusActive,
  isSessionStatusTerminal,
  isAssistantMessageCompletedInfo,
  isAssistantMessageEnvelopeCompleted,
  extractSessionIdFromEventProperties,
  extractSessionStatusFromEventProperties,
};
