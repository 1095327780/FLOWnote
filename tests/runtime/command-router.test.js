const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadCommandRouterWithMockObsidian(platform = { isMobile: false }) {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Notice: class NoticeMock {},
        Platform: platform,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("../../runtime/view/command-router");
  const agentModePath = require.resolve("../../runtime/agent/agent-mode");
  delete require.cache[modulePath];
  delete require.cache[agentModePath];
  const { commandRouterMethods } = require(modulePath);

  return {
    commandRouterMethods,
    restore() {
      Module._load = originalLoad;
      delete require.cache[modulePath];
      delete require.cache[agentModePath];
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

test("mobile legacy preference selects a direct model without touching OpenCode", async () => {
  const fixture = loadCommandRouterWithMockObsidian({ isMobile: true });
  try {
    const { applyModelSelection } = fixture.commandRouterMethods;
    let saved = 0;
    const plugin = {
      settings: {
        agentProviderModePreference: "opencode-legacy",
        agentProvider: {
          mode: "opencode-legacy",
          direct: { providerId: "deepseek", model: "deepseek-v4-flash", apiKeys: {} },
        },
      },
      opencodeClient: { setDefaultModel() { throw new Error("must not call OpenCode"); } },
      async saveSettings() { saved += 1; },
    };
    const select = {
      value: "",
      options: [{ value: "deepseek-chat" }],
      selectedIndex: 0,
    };
    const view = {
      plugin,
      selectedModel: "deepseek-v4-flash",
      elements: { modelSelect: select, modelSelectText: { setAttribute() {}, textContent: "" } },
      applyStatus() {},
    };
    await applyModelSelection.call(view, "deepseek-chat", { silentNotice: true });
    assert.equal(plugin.settings.agentProvider.direct.model, "deepseek-chat");
    assert.equal(plugin.settings.agentProvider.mode, "opencode-legacy");
    assert.equal(plugin.settings.agentProviderModePreference, "opencode-legacy");
    assert.equal(saved, 1);
  } finally {
    fixture.restore();
  }
});

test("mobile legacy preference refreshes the direct picker without OpenCode", async () => {
  const fixture = loadCommandRouterWithMockObsidian({ isMobile: true });
  try {
    let updated = 0;
    const view = {
      plugin: {
        settings: { agentProvider: { mode: "opencode-legacy", direct: {} } },
        opencodeClient: { listModels() { throw new Error("must not call OpenCode"); } },
      },
      updateModelSelectOptions() { updated += 1; },
    };
    const result = await fixture.commandRouterMethods.refreshModelList.call(view);
    assert.deepEqual(result, []);
    assert.equal(updated, 1);
  } finally {
    fixture.restore();
  }
});

test("desktop legacy preference still refreshes models through OpenCode", async () => {
  const fixture = loadCommandRouterWithMockObsidian({ isMobile: false });
  try {
    let calls = 0;
    const view = {
      plugin: {
        settings: { agentProvider: { mode: "opencode-legacy", direct: {} } },
        opencodeClient: {
          async listModels() { calls += 1; return ["openai/gpt-5"]; },
        },
      },
      updateModelSelectOptions() {},
    };
    const result = await fixture.commandRouterMethods.refreshModelList.call(view);
    assert.deepEqual(result, ["openai/gpt-5"]);
    assert.equal(calls, 1);
  } finally {
    fixture.restore();
  }
});
