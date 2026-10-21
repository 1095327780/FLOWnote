// skill_resource_read tool — read files bundled inside a skill folder.
//
// Claude Code skills often keep detail in `references/`, examples in
// `assets/`, or scripts in `scripts/`. FLOWnote does not execute scripts in
// the Obsidian runtime, but the model can still read those files and perform
// the equivalent work with native vault/web tools where possible.

const { buildTool } = require("../tool-registry");
const { normalizeSkillRelativePath, readFile, renderSkillTemplateVariables } = require("../skill-registry");
const { pageNotice } = require("./utf8-page");
const { pageReadOutput, FALLBACK_MAX_BYTES } = require("./read-output-budget");

const DESCRIPTION =
  "Read a file that belongs to an invoked skill, such as references/*.md, " +
  "assets/*.md, or examples. Use this when a SKILL.md mentions a relative " +
  "resource path. This is read-only and works on desktop and mobile because " +
  "it reads from the vault adapter or from the plugin's embedded skill bundle. " +
  "By default, returns as much as the available context allows; use maxBytes " +
  "for a smaller slice and byteOffset to continue. " +
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
      minimum: 4,
      description: "Optional byte cap for the returned resource text.",
    },
    byteOffset: { type: "integer", minimum: 0, description: "UTF-8 byte offset in the rendered resource; use nextOffset from the prior result." },
  },
  required: ["skill", "path"],
};

const DEFAULT_MAX_BYTES = FALLBACK_MAX_BYTES;
const HARD_MAX_BYTES = 256 * 1024;

function createSkillResourceReadTool({ skillRegistry, vault, skillTemplateVariables } = {}) {
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
    capabilities: (input) => ({
      effect: "observation",
      risk: "low",
      concurrency: "parallel",
      presentation: "skill",
      targets: input && typeof input.path === "string"
        ? [`${typeof input.skill === "string" ? `${input.skill}/` : ""}${input.path}`]
        : [],
    }),
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
        (!Number.isInteger(input.maxBytes) || input.maxBytes < 4)
      ) {
        return { ok: false, error: "maxBytes must be an integer of at least 4." };
      }
      if (input.byteOffset !== undefined && (!Number.isInteger(input.byteOffset) || input.byteOffset < 0)) {
        return { ok: false, error: "byteOffset must be a non-negative integer." };
      }
      return { ok: true };
    },

    userFacingName(input) {
      const skill = input && typeof input.skill === "string" ? input.skill : "";
      const path = input && typeof input.path === "string" ? input.path : "";
      return skill && path ? `${skill}/${path}` : path || skill;
    },

    async *execute(input, ctx) {
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

      const maxBytes = input.maxBytes === undefined ? undefined : Math.min(input.maxBytes, HARD_MAX_BYTES);
      let content;
      const overridePath = skill.vaultResourceOverrides
        && Object.prototype.hasOwnProperty.call(skill.vaultResourceOverrides, rel)
        ? skill.vaultResourceOverrides[rel]
        : "";
      if (overridePath) {
        try {
          content = await readFile(vault, overridePath);
        } catch {
          content = undefined;
        }
      }
      if (typeof content !== "string") {
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

      const output = renderSkillTemplateVariables(content, skillTemplateVariables);
      let page;
      try {
        page = pageReadOutput(output, { ctx, byteOffset: input.byteOffset || 0, maxBytes });
      } catch (error) {
        yield { type: "result", content: `skill_resource_read: ${error.message}`, isError: true };
        return;
      }
      const { text: pageText, ...pageMeta } = page;
      yield {
        type: "result",
        content: `Skill resource: ${skill.name}/${rel}\n\n${pageText}${pageNotice("skill_resource_read", page, `skill=${skill.name}, path=${rel}, `)}`,
        data: { page: pageMeta },
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
