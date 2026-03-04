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
