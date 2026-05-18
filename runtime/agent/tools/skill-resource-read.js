// skill_resource_read tool — read files bundled inside a skill folder.
//
// Claude Code skills often keep detail in `references/`, examples in
// `assets/`, or scripts in `scripts/`. FLOWnote does not execute scripts in
// the Obsidian runtime, but the model can still read those files and perform
// the equivalent work with native vault/web tools where possible.

const { buildTool } = require("../tool-registry");
const { normalizeSkillRelativePath, readFile } = require("../skill-registry");
const { byteLengthUtf8 } = require("../utils/byte-length");

const DESCRIPTION =
  "Read a file that belongs to an invoked skill, such as references/*.md, " +
  "assets/*.md, or examples. Use this when a SKILL.md mentions a relative " +
  "resource path. This is read-only and works on desktop and mobile because " +
  "it reads from the vault adapter or from the plugin's embedded skill bundle. " +
  "Do not use it for normal vault notes; use vault_read for those.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    skill: {
      type: "string",
      description: "Skill name, slug, or alias exactly as listed in Available skills.",
    },
    path: {
      type: "string",
      description: "Skill-relative resource path, e.g. references/guide.md.",
    },
    maxBytes: {
      type: "integer",
      minimum: 1,
      description: "Optional byte cap for large resources. Defaults to 65536.",
    },
  },
  required: ["skill", "path"],
};

const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 256 * 1024;

function createSkillResourceReadTool({ skillRegistry, vault } = {}) {
  if (!skillRegistry || typeof skillRegistry.get !== "function") {
    throw new Error("createSkillResourceReadTool: skillRegistry required");
  }
  if (!vault) {
    throw new Error("createSkillResourceReadTool: vault required");
  }
  return buildTool({
    name: "skill_resource_read",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (!input || typeof input.skill !== "string" || !input.skill.trim()) {
        return { ok: false, error: "Missing skill name." };
      }
      if (typeof input.path !== "string" || !input.path.trim()) {
        return { ok: false, error: "Missing resource path." };
      }
      if (!normalizeSkillRelativePath(input.path)) {
        return { ok: false, error: "Resource path must be relative and must not contain '..'." };
      }
      if (
        input.maxBytes !== undefined &&
        (!Number.isInteger(input.maxBytes) || input.maxBytes < 1)
      ) {
        return { ok: false, error: "maxBytes must be a positive integer." };
      }
      return { ok: true };
    },

    userFacingName(input) {
      const skill = input && typeof input.skill === "string" ? input.skill : "";
      const path = input && typeof input.path === "string" ? input.path : "";
      return skill && path ? `${skill}/${path}` : path || skill;
    },

    async *execute(input, _ctx) {
      const skill = skillRegistry.get(input.skill);
      const rel = normalizeSkillRelativePath(input.path);
      if (!skill) {
        yield {
          type: "result",
          content: `skill_resource_read: no skill named "${input.skill}".`,
          isError: true,
        };
        return;
      }
      if (!rel) {
        yield {
          type: "result",
          content: "skill_resource_read: resource path must be relative and must not contain '..'.",
          isError: true,
        };
        return;
      }

      const maxBytes = Math.min(input.maxBytes || DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
      let content;
      if (skill.embeddedResourceFiles && Object.prototype.hasOwnProperty.call(skill.embeddedResourceFiles, rel)) {
        content = String(skill.embeddedResourceFiles[rel] || "");
      } else if (skill.dirPath && !String(skill.dirPath).startsWith("<embedded>/")) {
        const fullPath = joinVaultPath(skill.dirPath, rel);
        try {
          content = await readFile(vault, fullPath);
        } catch {
          content = undefined;
        }
      }

      if (typeof content !== "string") {
        const available = Array.isArray(skill.resourcePaths) && skill.resourcePaths.length > 0
          ? ` Available resources: ${skill.resourcePaths.slice(0, 30).join(", ")}.`
          : "";
        yield {
          type: "result",
          content: `skill_resource_read: resource not found at "${rel}" for skill "${skill.name}".${available}`,
          isError: true,
        };
        return;
      }

      let output = content;
      if (byteLengthUtf8(output) > maxBytes) {
        output = output.slice(0, maxBytes) +
          `\n\n[skill_resource_read: content truncated at ${maxBytes} bytes]`;
      }
      yield {
        type: "result",
        content: `Skill resource: ${skill.name}/${rel}\n\n${output}`,
      };
    },
  });
}

function joinVaultPath(dirPath, relPath) {
  return `${String(dirPath || "").replace(/\/+$/, "")}/${String(relPath || "").replace(/^\/+/, "")}`;
}

module.exports = {
  createSkillResourceReadTool,
  DEFAULT_MAX_BYTES,
  HARD_MAX_BYTES,
};
