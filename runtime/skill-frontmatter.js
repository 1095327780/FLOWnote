"use strict";

// Agent Skills use YAML frontmatter. Keep decoding in one dependency-free
// runtime module (other than the deliberately bundled `yaml` package) so the
// vault scanner, desktop legacy service, and embedded mobile fallback cannot
// silently disagree about nested metadata.
const YAML = require("yaml");

const HOST_EFFECT_KINDS = Object.freeze([
  "observation",
  "vault_mutation",
  "network_mutation",
  "external_side_effect",
]);
const COMPLETION_MODES = new Set(["effect", "inspect", "answer"]);
const HOST_EFFECT_KIND_SET = new Set(HOST_EFFECT_KINDS);
const HOST_INTERACTION_KINDS = Object.freeze(["ask_user"]);
const HOST_INTERACTION_KIND_SET = new Set(HOST_INTERACTION_KINDS);

function splitSkillFrontmatter(rawText) {
  const raw = String(rawText || "");
  if (!/^---[ \t]*(?:\r?\n|$)/.test(raw)) {
    return { frontmatter: {}, body: raw, errorCode: null };
  }
  const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { frontmatter: {}, body: raw, errorCode: "invalid_frontmatter" };
  const body = raw.slice(match[0].length).replace(/^(?:\r?\n)+/, "");
  let document;
  try {
    document = YAML.parseDocument(match[1] || "", { prettyErrors: false, uniqueKeys: true });
  } catch {
    // A parser/runtime failure is not evidence that the user's Skill document
    // is malformed. Keep it fail-closed, but preserve the correct fault domain
    // so diagnostics do not blame frontmatter for a host compatibility issue.
    return { frontmatter: {}, body, errorCode: "frontmatter_parser_failure" };
  }
  if (document.errors && document.errors.length > 0) {
    return { frontmatter: {}, body, errorCode: "invalid_frontmatter" };
  }
  let value;
  try {
    value = document.toJS({ mapAsMap: false });
  } catch {
    return { frontmatter: {}, body, errorCode: "frontmatter_parser_failure" };
  }
  if (!isPlainObject(value)) return { frontmatter: {}, body, errorCode: "invalid_frontmatter" };
  // Preserve the old public manifest contract for the discovery fields while
  // leaving nested metadata values exactly as decoded by YAML.
  if (typeof value.description === "string") value.description = value.description.trimEnd();
  return { frontmatter: value, body, errorCode: null };
}

function parseFlowNoteCompletionMetadata(frontmatter, options = {}) {
  const legacy = completionResult("legacy_unclassified", null, [], [], null, null);
  if (options && options.frontmatterError) {
    return completionResult("invalid", null, [], [], null, String(options.frontmatterError));
  }
  if (!isPlainObject(frontmatter)) return legacy;
  const metadata = frontmatter.metadata;
  if (metadata === undefined) return legacy;
  if (!isPlainObject(metadata)) return invalid("invalid_metadata_schema");
  const flownote = metadata.flownote;
  if (flownote === undefined) return legacy;
  if (!isPlainObject(flownote)) return invalid("invalid_flownote_metadata");
  const completion = flownote.completion;
  if (completion === undefined) return legacy;
  if (!isPlainObject(completion)) return invalid("invalid_completion_schema");
  const keys = Object.keys(completion);
  if (keys.some((key) => !["mode", "required_effects", "required_interactions", "min_receipts"].includes(key))) {
    return invalid("unknown_completion_field");
  }
  if (typeof completion.mode !== "string" || !COMPLETION_MODES.has(completion.mode)) {
    return invalid("invalid_completion_mode");
  }
  let requiredEffects = [];
  if (completion.required_effects !== undefined) {
    if (!Array.isArray(completion.required_effects)
      || completion.required_effects.some((kind) => typeof kind !== "string" || !HOST_EFFECT_KIND_SET.has(kind))) {
      return invalid("invalid_required_effect");
    }
    requiredEffects = [...new Set(completion.required_effects)];
  }
  let requiredInteractions = [];
  if (completion.required_interactions !== undefined) {
    if (!Array.isArray(completion.required_interactions)
      || completion.required_interactions.some((kind) => (
        typeof kind !== "string" || !HOST_INTERACTION_KIND_SET.has(kind)
      ))) {
      return invalid("invalid_required_interaction");
    }
    requiredInteractions = [...new Set(completion.required_interactions)];
  }
  if (completion.min_receipts !== undefined
    && (!Number.isInteger(completion.min_receipts) || completion.min_receipts < 0)) {
    return invalid("invalid_min_receipts");
  }
  // An answer must not masquerade as an effect policy; effects are only
  // meaningful to inspect/effect contracts.
  if (completion.mode === "answer" && (
    requiredEffects.length > 0
    || requiredInteractions.length > 0
    || completion.min_receipts !== undefined
  )) {
    return invalid("answer_completion_cannot_require_receipts");
  }
  return completionResult(
    "declared",
    completion.mode,
    requiredEffects,
    requiredInteractions,
    completion.min_receipts === undefined ? null : completion.min_receipts,
    null,
  );
}

function completionResult(state, mode, requiredEffects, requiredInteractions, minReceipts, errorCode) {
  return Object.freeze({ state, mode, requiredEffects, requiredInteractions, minReceipts, errorCode });
}

function invalid(errorCode) {
  return completionResult("invalid", null, [], [], null, errorCode);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  HOST_EFFECT_KINDS,
  HOST_INTERACTION_KINDS,
  splitSkillFrontmatter,
  parseFlowNoteCompletionMetadata,
};
