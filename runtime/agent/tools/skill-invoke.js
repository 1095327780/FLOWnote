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
const { byteLengthUtf8 } = require("../utils/byte-length");

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
const MAX_RESOURCE_HINTS = 40;

const CLAUDE_CODE_COMPATIBILITY_HINT = [
  "--- FLOWnote skill compatibility ---",
  "This skill may have been written for Claude Code. Translate tool names as follows:",
  "Read/LS/Glob/Grep -> vault_read/vault_list/vault_search, Write/Edit/MultiEdit -> vault_write/vault_edit, WebFetch -> web_fetch for pages or web_request for API POST/custom headers, AskUserQuestion -> ask_user, Skill -> skill_invoke.",
  "Translate curl/http API calls to web_request. Use secret placeholders such as `$WEREAD_API_KEY`; FLOWnote substitutes them from settings. If a secret is missing, ask the user to fill FLOWnote Settings -> Skill management rather than asking for shell export commands.",
  "If the skill references a file under its own references/, assets/, examples/, or scripts/ folder, call skill_resource_read with the relative path.",
  "Bash/shell/script hooks are not executed inside Obsidian direct mode, especially on mobile. Read the script/resource if useful, then perform the equivalent with vault_*, web_fetch, or web_request. If there is no native equivalent, say that this step requires the desktop OpenCode bridge or external tooling.",
].join("\n");

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
      if (byteLengthUtf8(body) > MAX_BODY_BYTES) {
        body = body.slice(0, MAX_BODY_BYTES) + "\n\n[skill_invoke: body truncated — split this skill into smaller pieces]";
      }
      yield { type: "progress", message: `loaded skill: ${name}` };
      const resourceHint = formatResourceHint(skill);
      const header =
        `Skill: ${skill.name}\n` +
        (skill.slug && skill.slug !== skill.name ? `Slug: ${skill.slug}\n` : "") +
        `Source: ${skill.dirPath}\n` +
        (Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0
          ? `Allowed tools declared by skill: ${skill.allowedTools.join(", ")}\n`
          : "") +
        (argsStr ? `Arguments: ${argsStr}\n` : "") +
        (resourceHint ? `${resourceHint}\n` : "") +
        `\n${CLAUDE_CODE_COMPATIBILITY_HINT}\n\n--- skill body ---\n`;
      yield { type: "result", content: header + body };
    },
  });
}

function formatResourceHint(skill) {
  const resources = Array.isArray(skill && skill.resourcePaths) ? skill.resourcePaths : [];
  if (resources.length === 0) return "";
  const shown = resources.slice(0, MAX_RESOURCE_HINTS);
  const suffix = resources.length > shown.length ? `\n  ... ${resources.length - shown.length} more` : "";
  return [
    "Skill resources available via skill_resource_read:",
    ...shown.map((p) => `  - ${p}`),
  ].join("\n") + suffix;
}

module.exports = {
  createSkillInvokeTool,
  MAX_BODY_BYTES,
  MAX_RESOURCE_HINTS,
};
