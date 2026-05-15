// ask_user tool — interactive multiple-choice questions for the model.
//
// When the model is uncertain (which note to update? which template to
// use?) it can call this tool with one to four questions. The runner
// surfaces them in the chat view; the user answers; the tool result
// returns the chosen labels (and any free-text "Other" responses).
//
// This is the only tool whose execute step must round-trip through the
// UI. We keep the integration loose: the runner injects an async
// `askUserFn(payload)` via ctx. The tool stays pure and testable.

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "Ask the user one or more multiple-choice questions. Use this when you " +
  "need to disambiguate before continuing — e.g. which file to edit, which " +
  "template to use, which date to assume. Provide an array of question " +
  "objects, each with `question` (string), `header` (short label, ≤12 " +
  "chars), `options` (2-4 choices with `label` and `description`), and " +
  "optionally `multiSelect`. The user can always pick \"Other\" and supply " +
  "custom text. Avoid this for trivial yes/no choices; phrase choices so " +
  "the user can pick without rereading the conversation. If you recommend " +
  "an option, put it first and end its label with \"(Recommended)\".";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The full question to ask." },
          header: {
            type: "string",
            description: "Very short chip label (≤12 chars).",
          },
          multiSelect: {
            type: "boolean",
            description: "Allow multiple answers. Default false.",
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short, distinct option text." },
                description: {
                  type: "string",
                  description: "What picking this option means.",
                },
              },
              required: ["label", "description"],
            },
          },
        },
        required: ["question", "header", "options"],
      },
    },
  },
  required: ["questions"],
};

const HEADER_MAX = 12;

function validateQuestion(q, idx) {
  if (!q || typeof q !== "object") return `questions[${idx}] must be an object.`;
  if (typeof q.question !== "string" || q.question.trim().length === 0) {
    return `questions[${idx}].question must be a non-empty string.`;
  }
  if (typeof q.header !== "string" || q.header.length === 0) {
    return `questions[${idx}].header must be a non-empty string.`;
  }
  if (q.header.length > HEADER_MAX) {
    return `questions[${idx}].header must be ≤${HEADER_MAX} chars (got ${q.header.length}).`;
  }
  if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") {
    return `questions[${idx}].multiSelect must be a boolean.`;
  }
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
    return `questions[${idx}].options must have 2-4 entries.`;
  }
  const seenLabels = new Set();
  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i];
    if (!opt || typeof opt !== "object") {
      return `questions[${idx}].options[${i}] must be an object.`;
    }
    if (typeof opt.label !== "string" || opt.label.trim().length === 0) {
      return `questions[${idx}].options[${i}].label must be a non-empty string.`;
    }
    if (typeof opt.description !== "string" || opt.description.length === 0) {
      return `questions[${idx}].options[${i}].description must be a non-empty string.`;
    }
    if (seenLabels.has(opt.label)) {
      return `questions[${idx}].options has duplicate label "${opt.label}".`;
    }
    seenLabels.add(opt.label);
  }
  return null;
}

/**
 * @returns {import('../tool-registry').ToolDef}
 */
function createAskUserTool() {
  return buildTool({
    name: "ask_user",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    // Doesn't touch the filesystem or vault — read-only from a side-effect
    // standpoint — but DOES require the UI to be available. We mark it
    // not-concurrency-safe so multiple ask_user calls can't interleave.
    isReadOnly: () => true,
    isConcurrencySafe: () => false,

    async validate(input) {
      if (!input || !Array.isArray(input.questions)) {
        return { ok: false, error: "questions must be an array." };
      }
      if (input.questions.length < 1 || input.questions.length > 4) {
        return { ok: false, error: "questions must have 1-4 entries." };
      }
      for (let i = 0; i < input.questions.length; i++) {
        const err = validateQuestion(input.questions[i], i);
        if (err) return { ok: false, error: err };
      }
      return { ok: true };
    },

    userFacingName(input) {
      if (!input || !Array.isArray(input.questions) || input.questions.length === 0) return "";
      return input.questions[0].question;
    },

    async *execute(input, ctx) {
      const askFn = ctx && typeof ctx.askUserFn === "function" ? ctx.askUserFn : null;
      if (!askFn) {
        yield {
          type: "result",
          content:
            "ask_user: this conversation has no askUserFn wired in. The user " +
            "may be running in a non-interactive context — answer the question " +
            "yourself based on the conversation, or proceed with a sensible default.",
          isError: true,
        };
        return;
      }

      yield { type: "progress", message: `asking ${input.questions.length} question(s)` };

      let response;
      try {
        response = await askFn({ questions: input.questions });
      } catch (e) {
        yield {
          type: "result",
          content: `ask_user: UI bridge crashed: ${e && e.message ? e.message : e}`,
          isError: true,
        };
        return;
      }

      if (!response || typeof response !== "object") {
        yield {
          type: "result",
          content: "ask_user: user dismissed the question without answering.",
          isError: true,
        };
        return;
      }

      // Expected response shape:
      //   { answers: { [question]: string | string[] }, dismissed?: boolean }
      if (response.dismissed) {
        yield {
          type: "result",
          content: "ask_user: user dismissed the question. Proceed without their answer or stop.",
          isError: true,
        };
        return;
      }

      const answers = response.answers && typeof response.answers === "object" ? response.answers : {};
      // Build a human-friendly textual summary the model can quote back.
      const lines = [];
      for (const q of input.questions) {
        const a = answers[q.question];
        if (Array.isArray(a)) {
          lines.push(`Q: ${q.question}\nA: ${a.join(" | ")}`);
        } else if (typeof a === "string" && a.length > 0) {
          lines.push(`Q: ${q.question}\nA: ${a}`);
        } else {
          lines.push(`Q: ${q.question}\nA: (no answer)`);
        }
      }
      yield { type: "result", content: lines.join("\n\n") };
    },
  });
}

module.exports = {
  createAskUserTool,
  validateQuestion,
};
