// End-of-turn audit: reconcile what the model says it changed with what the
// host measured.
//
// The model's prose is never execution authority. When the model ends a turn,
// a small control call extracts every change the final message claims and
// maps each claim to a host-measured change. The comparison itself is
// deterministic. An unbacked claim is returned to the model as internal
// feedback so it either performs the change with tools or states plainly
// what was not done; users never see this check.

const { consumeStream } = require("./provider-stream-consumer");

const AUDIT_TOOL_NAME = "flownote_report_turn";
const MESSAGE_KINDS = new Set(["reports_done", "asks_user", "reports_blocker", "answer_only"]);
const MAX_REQUEST_CHARS = 4000;
const MAX_FINAL_CHARS = 8000;
const MAX_PREVIOUS_CHARS = 1500;
const MAX_LISTED_CHANGES = 60;
const AUDIT_BASE_TOKEN_BUDGET = 2048;

const AUDIT_TOOL_SPEC = Object.freeze({
  name: AUDIT_TOOL_NAME,
  description: "Report which vault changes the assistant's final message claims, and which measured change backs each claim.",
  input_schema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        description:
          "Every statement in the final message asserting that a vault note, file, folder or property WAS " +
          "created, written, saved, edited, appended, moved, renamed or deleted during this turn. Exclude plans, " +
          "offers, suggestions, questions, drafts or content shown only in chat, descriptions of existing state, " +
          "and changes from earlier turns.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "Short quote of the claim from the final message." },
            backed_by: {
              type: "integer",
              description: "Index of the host-measured change that makes this claim true, or -1 if none does.",
            },
          },
          required: ["text", "backed_by"],
        },
      },
      message_kind: {
        type: "string",
        enum: [...MESSAGE_KINDS],
        description:
          "reports_done: says requested work is finished; asks_user: ends by asking the user for input or " +
          "confirmation; reports_blocker: says something could not be done; answer_only: answers without " +
          "reporting vault work.",
      },
    },
    required: ["claims", "message_kind"],
  },
});

const AUDIT_SYSTEM_PROMPT = [
  "You are FLOWnote's turn auditor. You do not answer the user and you do not judge quality.",
  `Call ${AUDIT_TOOL_NAME} exactly once.`,
  "List only claims the final message makes about vault changes completed in this turn.",
  "A claim is backed only when one of the host-measured changes makes it true: the same note or a clearly",
  "matching path, and the same kind of change. If no change was measured, every claim has backed_by -1.",
  "When the message claims several changes, list each separately.",
].join("\n");

function clip(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

function describeMeasuredChange(change, index) {
  const op = String(change && change.op || "changed");
  const kind = change && change.kind === "folder" ? " folder" : "";
  const from = change && change.from ? ` (from ${change.from})` : "";
  return `[${index}] ${op}${kind} ${change && change.path}${from}`;
}

function measuredChangeList(changes) {
  const list = Array.isArray(changes) ? changes.slice(0, MAX_LISTED_CHANGES) : [];
  if (!list.length) return "(none — no file or folder was created, changed, moved or deleted in this turn)";
  return list.map(describeMeasuredChange).join("\n");
}

function auditTokenBudget(provider, attempt) {
  const modelId = provider && provider.userConfig && provider.userConfig.model;
  const models = provider && provider.spec && Array.isArray(provider.spec.models) ? provider.spec.models : [];
  const modelInfo = models.find((item) => item && item.id === modelId);
  const modelMax = Number(modelInfo && modelInfo.maxOutput);
  const requested = AUDIT_BASE_TOKEN_BUDGET * (2 ** Math.max(0, attempt));
  return Number.isFinite(modelMax) && modelMax > 0 ? Math.min(requested, modelMax) : requested;
}

function normalizeAuditReport(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.claims)) return null;
  const kind = String(input.message_kind || "");
  if (!MESSAGE_KINDS.has(kind)) return null;
  const claims = [];
  for (const claim of input.claims) {
    if (!claim || typeof claim !== "object") return null;
    const backedBy = Number(claim.backed_by);
    claims.push({
      text: String(claim.text || "").trim().slice(0, 300),
      backedBy: Number.isInteger(backedBy) ? backedBy : -1,
    });
  }
  return { claims, messageKind: kind };
}

/**
 * @returns {Promise<{ok: true, report: Object} | {ok: false, error: string}>}
 */
async function runTurnAudit({ provider, signal, userRequest, previousAssistantText, finalText, changes, maxAttempts = 2 }) {
  if (!provider || typeof provider.createMessage !== "function") return { ok: false, error: "provider_unavailable" };
  const model = (provider.userConfig && provider.userConfig.model) || (provider.spec && provider.spec.defaultModel);
  const body = [
    previousAssistantText
      ? `<previous_assistant_message>\n${clip(previousAssistantText, MAX_PREVIOUS_CHARS)}\n</previous_assistant_message>`
      : "",
    `<user_request>\n${clip(userRequest, MAX_REQUEST_CHARS)}\n</user_request>`,
    `<assistant_final_message>\n${clip(finalText, MAX_FINAL_CHARS)}\n</assistant_final_message>`,
    `<host_measured_changes>\n${measuredChangeList(changes)}\n</host_measured_changes>`,
  ].filter(Boolean).join("\n\n");
  let lastError = "missing_report";
  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
    if (signal && signal.aborted) return { ok: false, error: "aborted" };
    const retryNote = attempt > 0 ? "\n\nEmit only the tool call now, without extended reasoning." : "";
    const input = {
      model,
      system: AUDIT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: body + retryNote }] }],
      tools: [AUDIT_TOOL_SPEC],
      maxTokens: auditTokenBudget(provider, attempt),
      temperature: 0,
    };
    if (signal) input.signal = signal;
    let result;
    try {
      result = await consumeStream(provider.createMessage(input));
    } catch (error) {
      lastError = String((error && (error.code || error.message)) || "audit_request_failed");
      continue;
    }
    if (result.fatalError) {
      lastError = String(result.fatalError.type || "audit_stream_failed");
      continue;
    }
    const calls = result.toolUses.filter((toolUse) => toolUse.name === AUDIT_TOOL_NAME);
    if (calls.length !== 1) {
      lastError = calls.length ? "multiple_reports" : "missing_report";
      continue;
    }
    const report = normalizeAuditReport(calls[0].input);
    if (report) return { ok: true, report };
    lastError = "invalid_report";
  }
  return { ok: false, error: lastError };
}

/**
 * Deterministic reconciliation of an audit report with measured changes.
 *
 * @param {Object} args
 * @param {Object} args.report               normalized audit report
 * @param {Array}  args.changes              host-measured changes
 * @param {boolean} [args.requiresChange]    the explicit Skill declares an effect
 * @param {string[]} [args.requiredInteractions]
 * @param {Array}  [args.interactionReceipts]
 */
function evaluateTurnReport({ report, changes, requiresChange = false, requiredInteractions = [], interactionReceipts = [] }) {
  const count = Array.isArray(changes) ? changes.length : 0;
  const issues = [];
  const unbacked = report.claims.filter((claim) => !(claim.backedBy >= 0 && claim.backedBy < count));
  if (unbacked.length) issues.push({ type: "unbacked_claims", claims: unbacked });
  const settledWithoutUser = report.messageKind === "reports_done" || report.messageKind === "answer_only";
  if (requiresChange && count === 0 && settledWithoutUser && !unbacked.length) {
    issues.push({ type: "required_change_missing" });
  }
  const askedUser = (Array.isArray(interactionReceipts) ? interactionReceipts : [])
    .some((receipt) => receipt && receipt.verified === true);
  if ((requiredInteractions || []).includes("ask_user") && !askedUser && report.messageKind === "reports_done") {
    issues.push({ type: "required_interaction_missing" });
  }
  return { allow: issues.length === 0, issues };
}

function buildHostCheckMessage({ changes, issues, skillCommand }) {
  const lines = [
    "[FLOWNOTE_HOST_CHECK]",
    "Host-measured vault changes in this turn:",
    measuredChangeList(changes),
  ];
  for (const issue of issues) {
    if (issue.type === "unbacked_claims") {
      lines.push(
        "",
        "Your last message states changes that the host did not observe:",
        ...issue.claims.map((claim) => `- "${claim.text}"`),
        "Vault content changes only through tool calls, and these did not happen. If the user asked for them,",
        "make them now with the appropriate tools. If you cannot, tell the user plainly which change was not",
        "made and why. Never state or imply a change that did not happen.",
      );
    } else if (issue.type === "required_change_missing") {
      lines.push(
        "",
        `${skillCommand || "This skill"} must change the vault, but nothing changed in this turn. Perform the`,
        "change now with tools, ask the user if required information is missing, or explain the blocker.",
      );
    } else if (issue.type === "required_interaction_missing") {
      lines.push(
        "",
        `${skillCommand || "This skill"} must confirm with the user through ask_user before it completes. Ask now.`,
      );
    }
  }
  lines.push(
    "",
    "The user sees only the answer you give after this note, plus the host's list of changed files. Give that",
    "answer directly: state what is actually done now. Do not mention this check or your earlier message.",
  );
  return lines.join("\n");
}

module.exports = {
  AUDIT_TOOL_NAME,
  AUDIT_TOOL_SPEC,
  runTurnAudit,
  evaluateTurnReport,
  buildHostCheckMessage,
  normalizeAuditReport,
  measuredChangeList,
};
