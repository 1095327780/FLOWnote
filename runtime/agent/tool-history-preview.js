// Bounded, content-free record of a tool call for later conversation turns.
//
// Later turns replay earlier tool calls as real tool_use / tool_result
// blocks instead of flattening them into prose. That keeps one fact visible
// to the model: files change only through tool calls. The record is persisted
// with the session, so it keeps identities only: paths, modes and other short
// control fields survive, while note content, request bodies, headers and
// read output are reduced to their length.

const IDENTITY_FIELDS = new Set([
  "path", "paths", "from", "to", "source", "destination", "dest", "target", "file", "folder", "dir",
  "new_path", "newPath", "old_path", "oldPath", "url", "method", "mode", "replace_all", "offset", "limit",
  "byteOffset", "maxBytes", "query", "glob", "pattern", "name", "skill", "skill_name", "command",
  "key", "property", "date", "role", "status", "recursive",
]);
const MAX_IDENTITY_CHARS = 240;
const MAX_ARRAY_ITEMS = 12;
const MAX_DEPTH = 3;
const MAX_INPUT_JSON_CHARS = 1500;
const MAX_RESULT_CHARS = 300;

function lengthMarker(value) {
  return `[${String(value).length} chars]`;
}

function identityString(key, value) {
  let text = String(value);
  // Query strings may carry tokens; keep the endpoint only.
  if (key === "url") text = text.replace(/[?#].*$/u, "");
  return text.length > MAX_IDENTITY_CHARS ? `${text.slice(0, MAX_IDENTITY_CHARS)}…` : text;
}

function previewValue(value, key, depth) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return IDENTITY_FIELDS.has(key) ? identityString(key, value) : lengthMarker(value);
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => previewValue(item, key, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} items]`);
    return items;
  }
  if (value && typeof value === "object") {
    if (key === "headers" || key === "json" || key === "body") return `[${Object.keys(value).length} fields]`;
    const out = {};
    for (const childKey of Object.keys(value).slice(0, 24)) {
      if (value[childKey] === undefined) continue;
      out[childKey] = previewValue(value[childKey], childKey, depth + 1);
    }
    return out;
  }
  return null;
}

function buildToolInputPreview(input) {
  const preview = previewValue(input && typeof input === "object" && !Array.isArray(input) ? input : {}, "", 0);
  if (JSON.stringify(preview).length <= MAX_INPUT_JSON_CHARS) return preview;
  return { _preview: "[arguments omitted]" };
}

/**
 * Successful local vault mutations keep their short host receipt ("Edited X
 * …"); errors, network and read results are omitted because they may carry
 * remote or note content.
 */
function buildToolResultPreview(content, { isError = false, effect = "none" } = {}) {
  const text = typeof content === "string" ? content : JSON.stringify(content === undefined ? "" : content);
  if (isError) return `Tool failed (${text.length} chars of error output omitted from history).`;
  if (effect === "vault_mutation") {
    const firstLines = text.split("\n").slice(0, 3).join("\n");
    return firstLines.length > MAX_RESULT_CHARS ? `${firstLines.slice(0, MAX_RESULT_CHARS)}…` : firstLines;
  }
  return `[${text.length} chars of output omitted from history; call the tool again if the content is needed]`;
}

function isBoundedPreview(value) {
  try {
    return JSON.stringify(value).length <= MAX_INPUT_JSON_CHARS + 64;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  buildToolInputPreview,
  buildToolResultPreview,
  isBoundedPreview,
  MAX_RESULT_CHARS,
};
