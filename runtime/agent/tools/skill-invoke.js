// skill_invoke tool — let the model load a SKILL.md as turn-1 guidance.
//
// Skill bodies are intentionally executed inline (not via a sub-agent),
// because Obsidian users don't expect the chat to "fork" — they want one
// linear conversation. Calling skill_invoke yields a result whose
// content is the skill's full markdown body (after `$ARGUMENTS` / `$1`
// substitution). The model then continues the same turn with that
// guidance available.

const { buildTool } = require("../tool-registry");
const { substituteArguments } = require("../skill-registry");

const DESCRIPTION =
  "Load a vault skill so its instructions become available for the rest of " +
  "the response. Available skills are listed in the system prompt under " +
  "\"Available skills:\". Provide `skill` (the name) and optionally `args` (a " +
  "string passed to the skill — usually the slash-command argument). Returns " +
  "the skill's markdown body with arguments substituted; follow those " +
  "instructions instead of restating them.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    skill: {
      type: "string",
      description: "Name of the skill, exactly as listed in \"Available skills\".",
    },
    args: {
      type: "string",
      description: "Optional argument string passed to the skill (e.g. a date, a title).",
    },
  },
  required: ["skill"],
};

const MAX_BODY_BYTES = 64 * 1024; // 64 KB; skills longer than this are a smell

/**
 * @param {Object} deps
 * @param {import('../skill-registry').SkillRegistry} deps.skillRegistry
 * @returns {import('../tool-registry').ToolDef}
 */
function createSkillInvokeTool({ skillRegistry } = {}) {
  if (!skillRegistry || typeof skillRegistry.get !== "function") {
    throw new Error("createSkillInvokeTool: skillRegistry required");
  }
  return buildTool({
    name: "skill_invoke",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (!input || typeof input.skill !== "string" || !input.skill.trim()) {
        return { ok: false, error: "Missing skill name." };
      }
      if (input.args !== undefined && typeof input.args !== "string") {
        return { ok: false, error: "args must be a string if provided." };
      }
      return { ok: true };
    },

    userFacingName(input) {
      const name = input && typeof input.skill === "string" ? input.skill : "";
      const args = input && typeof input.args === "string" ? input.args : "";
      return args ? `${name} ${args}` : name;
    },

    async *execute(input, _ctx) {
      const name = input.skill.trim();
      const skill = skillRegistry.get(name);
      if (!skill) {
        const available = skillRegistry.modelInvocable
          ? skillRegistry.modelInvocable().map((s) => s.name).slice(0, 20).join(", ")
          : "";
        yield {
          type: "result",
          content:
            `skill_invoke: no skill named "${name}". ` +
            (available ? `Available: ${available}.` : "No skills are currently loaded."),
          isError: true,
        };
        return;
      }
      if (skill.disableModelInvocation) {
        yield {
          type: "result",
          content: `skill_invoke: skill "${name}" is user-invocable only and cannot be called by the model.`,
          isError: true,
        };
        return;
      }
      const argsStr = typeof input.args === "string" ? input.args : "";
      let body = substituteArguments(skill.body, argsStr, skill.argumentNames || []);
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        body = body.slice(0, MAX_BODY_BYTES) + "\n\n[skill_invoke: body truncated — split this skill into smaller pieces]";
      }
      yield { type: "progress", message: `loaded skill: ${name}` };
      const header =
        `Skill: ${skill.name}\n` +
        `Source: ${skill.dirPath}\n` +
        (argsStr ? `Arguments: ${argsStr}\n` : "") +
        `\n--- skill body ---\n`;
      yield { type: "result", content: header + body };
    },
  });
}

module.exports = {
  createSkillInvokeTool,
  MAX_BODY_BYTES,
};
