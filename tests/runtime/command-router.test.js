const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadCommandRouterWithMockObsidian() {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Notice: class NoticeMock {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("../../runtime/view/command-router");
  delete require.cache[modulePath];
  const { commandRouterMethods } = require(modulePath);

  return {
    commandRouterMethods,
    restore() {
      Module._load = originalLoad;
      delete require.cache[modulePath];
    },
  };
}

test("parseSkillSelectorSlashCommand should only open selector for bare /skill(s)", () => {
  const fixture = loadCommandRouterWithMockObsidian();
  try {
    const { parseSkillSelectorSlashCommand } = fixture.commandRouterMethods;
    assert.deepEqual(parseSkillSelectorSlashCommand("/skills"), { command: "skills" });
    assert.deepEqual(parseSkillSelectorSlashCommand("/skill"), { command: "skills" });
    assert.equal(parseSkillSelectorSlashCommand("/skills ah-init"), null);
    assert.equal(parseSkillSelectorSlashCommand("/skill ah-init 请执行"), null);
  } finally {
    fixture.restore();
  }
});

test("resolveSkillFromPrompt should support /skills <id> alias", () => {
  const fixture = loadCommandRouterWithMockObsidian();
  try {
    const { resolveSkillFromPrompt } = fixture.commandRouterMethods;
    const context = {
      plugin: {
        skillService: {
          getSkills() {
            return [
              { id: "ah-init", name: "ah-init" },
            ];
          },
        },
      },
    };

    const resolvedBare = resolveSkillFromPrompt.call(context, "/skills ah-init");
    assert.ok(resolvedBare && resolvedBare.skill);
    assert.equal(resolvedBare.skill.id, "ah-init");
    assert.equal(resolvedBare.command, "/ah-init");
    assert.match(String(resolvedBare.promptText || ""), /skill/i);

    const resolvedWithArgs = resolveSkillFromPrompt.call(context, "/skills ah-init 更新索引");
    assert.ok(resolvedWithArgs && resolvedWithArgs.skill);
    assert.equal(resolvedWithArgs.skill.id, "ah-init");
    assert.equal(resolvedWithArgs.command, "/ah-init");
    assert.equal(resolvedWithArgs.promptText, "更新索引");
  } finally {
    fixture.restore();
  }
});

test("resolveSkillFromPrompt should build a canonical command for mobile slug-only entries", () => {
  const fixture = loadCommandRouterWithMockObsidian();
  try {
    const { resolveSkillFromPrompt } = fixture.commandRouterMethods;
    const completionPolicy = {
      state: "declared",
      mode: "effect",
      requiredEffects: [],
      requiredInteractions: ["ask_user"],
      minReceipts: null,
      errorCode: null,
    };
    const context = {
      plugin: {
        skillService: null,
        __flownoteMobileSkillList: [{
          slug: "ah-note",
          name: "ah-note",
          completionPolicy,
        }],
      },
    };

    const resolved = resolveSkillFromPrompt.call(context, "/ah-note");
    assert.equal(resolved.command, "/ah-note");
    assert.equal(resolved.skill.slug, "ah-note");
    assert.deepEqual(resolved.skill.completionPolicy, completionPolicy);
  } finally {
    fixture.restore();
  }
});

test("resolveSkillFromPrompt should refresh skills before matching slash command", () => {
  const fixture = loadCommandRouterWithMockObsidian();
  try {
    const { resolveSkillFromPrompt } = fixture.commandRouterMethods;
    const state = { refreshed: false };
    const context = {
      plugin: {
        skillService: {
          loadSkills() {
            state.refreshed = true;
          },
          getSkills() {
            if (!state.refreshed) return [];
            return [{ id: "custom-skill", name: "custom-skill" }];
          },
        },
      },
    };

    const resolved = resolveSkillFromPrompt.call(context, "/custom-skill 执行");
    assert.ok(resolved && resolved.skill);
    assert.equal(resolved.skill.id, "custom-skill");
    assert.equal(resolved.command, "/custom-skill");
    assert.equal(resolved.promptText, "执行");
  } finally {
    fixture.restore();
  }
});

test("resolveSkillFromPrompt should not route a standard skill with user-invocable false", () => {
  const fixture = loadCommandRouterWithMockObsidian();
  try {
    const { resolveSkillFromPrompt } = fixture.commandRouterMethods;
    const context = {
      plugin: {
        skillService: {
          getSkills() {
            return [
              { id: "model-only", name: "model-only", userInvocable: false },
              { id: "user-only", name: "user-only", disableModelInvocation: true, userInvocable: true },
            ];
          },
        },
      },
    };

    const blocked = resolveSkillFromPrompt.call(context, "/model-only");
    assert.equal(blocked.skill, null);

    const explicit = resolveSkillFromPrompt.call(context, "/user-only");
    assert.equal(explicit.skill.id, "user-only");
  } finally {
    fixture.restore();
  }
});
