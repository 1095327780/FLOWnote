"use strict";

const DEFAULT_MAX_BYTES = 64 * 1024;

// Trace entries are deliberately narrow. Do not add free-form fields here:
// this file is persisted in the user's vault and must never become a prompt
// or tool-payload transcript.
const SAFE_ENUM_FIELDS = new Set([
  "provider",
  "model",
  "tool",
  "status",
  "reason",
  "stopReason",
  "stage",
  "disposition",
  "errorType",
]);

const SAFE_NUMERIC_FIELDS = new Set([
  "promptLength",
  "linkedFileCount",
  "historyLength",
  "maxOutputTokens",
  "toolCount",
  "textLength",
  "durationMs",
  "turnIndex",
  "turns",
  "attempt",
  "skippedVaultBundledCount",
]);

const SAFE_BOOLEAN_FIELDS = new Set([
  "hasLinkedFiles",
  "hasFlowNoteFileTag",
  "verified",
  "isError",
]);

const STRICT_ENUM_VALUES = Object.freeze({
  status: new Set(["pending", "running", "completed", "error", "failed", "cancelled", "blocked", "suspended"]),
  reason: new Set(["no_progress", "turn_boundary", "permission_denied", "user_input_dismissed", "workflow_suspended"]),
  stopReason: new Set(["end_turn", "tool_use", "max_tokens", "stop", "stop_sequence", "length", "content_filter", "error", "cancelled", "unknown"]),
  stage: new Set(["before_model", "model_stream", "tool_execution", "tool_control", "between_turns"]),
  disposition: new Set(["completed", "blocked", "cancelled", "suspended"]),
  errorType: new Set([
    "agent_error",
    "provider_stream_error",
    "skill_load_failed",
    "permission_ask_failed",
    "outgoing_user_shape_failed",
    "max_tokens",
  ]),
});

function safeEnum(value, field = "") {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(text)) return null;
  // Provider/model/tool labels are configuration values. Reject values that
  // look like credentials even when a caller accidentally supplies them in a
  // nominally allowlisted field.
  if (/(?:^|[-_.:])(sk|pk|api[-_]?key|access[-_]?key|secret|token|bearer|authorization)(?:[-_.:]|$)/i.test(text)) {
    return null;
  }
  if (/^[A-Za-z0-9_-]{32,}$/.test(text)) return null;
  const strictValues = STRICT_ENUM_VALUES[field];
  if (strictValues && !strictValues.has(text)) return "other";
  return text;
}

function sanitizeMetadata(metadata) {
  const safe = {};
  const source = metadata && typeof metadata === "object" ? metadata : {};

  for (const field of SAFE_NUMERIC_FIELDS) {
    const value = source[field];
    if (Number.isFinite(value) && value >= 0) safe[field] = Math.floor(value);
  }
  for (const field of SAFE_BOOLEAN_FIELDS) {
    if (typeof source[field] === "boolean") safe[field] = source[field];
  }
  for (const field of SAFE_ENUM_FIELDS) {
    const value = safeEnum(source[field], field);
    if (value) safe[field] = value;
  }
  return safe;
}

class DiagnosticTrace {
  constructor({ adapter, getEnabled, getPath, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.adapter = adapter || null;
    this.getEnabled = typeof getEnabled === "function" ? getEnabled : () => false;
    this.getPath = typeof getPath === "function" ? getPath : () => "";
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
  }

  async record(event, metadata) {
    try {
      if (!this.getEnabled() || !this.adapter || typeof this.adapter.append !== "function") return;
      const safeEvent = safeEnum(event);
      const path = this.getPath();
      if (!safeEvent || !path) return;

      const line = `${JSON.stringify({ event: safeEvent, ...sanitizeMetadata(metadata) })}\n`;
      await this.rotateIfNeeded(path, line.length);
      await this.adapter.append(path, line);
    } catch {
      // Diagnostics must never interrupt the user-visible agent flow.
    }
  }

  async rotateIfNeeded(path, incomingBytes) {
    if (typeof this.adapter.stat !== "function" || typeof this.adapter.write !== "function") return;
    let stat;
    try {
      stat = await this.adapter.stat(path);
    } catch (error) {
      // A new trace file has no stat yet. Treat the adapter's normal missing
      // file error like a zero-byte file so the first append is not dropped.
      // Other adapter failures still abort rotation and are swallowed by
      // record(), preserving the diagnostic path's best-effort semantics.
      if (error && (error.code === "ENOENT" || error.code === "ERR_FILE_NOT_FOUND")) {
        stat = null;
      } else {
        throw error;
      }
    }
    const currentSize = stat && Number.isFinite(stat.size) ? stat.size : 0;
    if (currentSize + incomingBytes > this.maxBytes) {
      await this.adapter.write(path, "");
    }
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DiagnosticTrace,
  sanitizeMetadata,
};
