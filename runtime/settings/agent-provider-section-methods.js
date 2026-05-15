// Agent provider settings UI section.
//
// Free function — both desktop FLOWnoteSettingsTab and MobileSettingsTab
// call this. Renders the full Direct/OpenCode toggle, provider/mode/
// region/model/key controls, test button, and advanced overrides.
//
// All settings are persisted to plugin.settings.agentProvider via
// helpers from runtime/agent/agent-settings.js. Test button uses
// runtime/agent/agent-provider-resolver.buildProviderFromSpec so the
// user's currently-typed values can be tested without saving first.

const { Setting, Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const {
  defaultAgentSettings,
  getActiveApiKey,
  setApiKeyFor,
  switchActiveProvider,
  normalizeAgentSettings,
} = require("../agent/agent-settings");
const { buildProviderFromSpec } = require("../agent/agent-provider-resolver");
const {
  getProviderSpec,
  listProviderSpecs,
  resolveBaseUrl,
} = require("../providers/registry");

/**
 * Render the section into containerEl.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.containerEl
 * @param {Object} opts.plugin                       the FLOWnote plugin instance
 * @param {Object} opts.tab                          the settings tab (used for re-render)
 * @param {Function} [opts.refresh]                  custom re-render hook; defaults to tab.display()
 */
function renderAgentProviderSection({ containerEl, plugin, tab, refresh }) {
  const t = (key, fallback, params = {}) =>
    tFromContext(tab || plugin, key, fallback, params);
  const reRender = typeof refresh === "function" ? refresh : () => {
    if (tab && typeof tab.display === "function") tab.display();
  };

  // Ensure settings are normalized before reading.
  if (!plugin.settings.agentProvider) {
    plugin.settings.agentProvider = defaultAgentSettings();
  } else {
    plugin.settings.agentProvider = normalizeAgentSettings(plugin.settings.agentProvider);
  }
  const agent = plugin.settings.agentProvider;

  // -------------------------------------------------------------------------
  // Heading + intro
  // -------------------------------------------------------------------------
  new Setting(containerEl)
    .setName(t("settings.agent.heading", "AI Provider"))
    .setHeading();
  containerEl.createEl("p", {
    text: t(
      "settings.agent.intro",
      "选择一家服务商，粘贴你的 API key。支持各家的「Coding Plan 订阅」和「按量付费 API」两种模式。",
    ),
    cls: "setting-item-description",
  });

  // -------------------------------------------------------------------------
  // Mode toggle: Direct vs OpenCode legacy
  // -------------------------------------------------------------------------
  new Setting(containerEl)
    .setName(t("settings.agent.modeName", "运行方式"))
    .setDesc(t(
      "settings.agent.modeDesc",
      "Direct：直接调用各家 AI API，无需安装 OpenCode；推荐。\nOpenCode（legacy）：通过本地 OpenCode CLI 中转，与 0.4.x 行为一致。",
    ))
    .addDropdown((d) => {
      d.addOption("direct", t("settings.agent.modeDirect", "Direct（推荐）"));
      d.addOption("opencode-legacy", t("settings.agent.modeOpenCode", "OpenCode（legacy）"));
      d.setValue(agent.mode);
      d.onChange(async (v) => {
        agent.mode = v === "opencode-legacy" ? "opencode-legacy" : "direct";
        await plugin.saveSettings();
        reRender();
      });
    });

  if (agent.mode === "opencode-legacy") {
    containerEl.createEl("p", {
      text: t(
        "settings.agent.opencodeNote",
        "已选 OpenCode 模式。请在下方「CLI 路径」和「Provider 登录」继续完成 OpenCode 配置。",
      ),
      cls: "setting-item-description",
    });
    return;
  }

  // =========================================================================
  // Direct mode UI
  // =========================================================================

  // --- Provider dropdown ---------------------------------------------------
  const allSpecs = listProviderSpecs().filter(
    (s) => s.protocol === "anthropic-messages" || s.protocol === "openai-chat",
  );
  new Setting(containerEl)
    .setName(t("settings.agent.providerName", "服务商"))
    .setDesc(t("settings.agent.providerDesc", "国内 Coding Plan / 各家 API 一键切换。"))
    .addDropdown((d) => {
      for (const spec of allSpecs) {
        d.addOption(spec.id, spec.displayName);
      }
      d.setValue(agent.direct.providerId);
      d.onChange(async (v) => {
        switchActiveProvider(agent, v);
        await plugin.saveSettings();
        reRender();
      });
    });

  const spec = getProviderSpec(agent.direct.providerId);
  if (!spec) return;

  // --- Mode dropdown (only if provider has more than one mode) ------------
  const modeIds = Object.keys(spec.modes || {});
  if (modeIds.length > 1) {
    new Setting(containerEl)
      .setName(t("settings.agent.providerModeName", "套餐类型"))
      .setDesc(t(
        "settings.agent.providerModeDesc",
        "Coding Plan：使用订阅额度。Pay-per-token：按 token 计费。两者底层调用一致，由服务商根据你的 key 计费。",
      ))
      .addDropdown((d) => {
        for (const mid of modeIds) {
          const m = spec.modes[mid];
          d.addOption(mid, m.label || mid);
        }
        d.setValue(agent.direct.providerMode || spec.defaultMode);
        d.onChange(async (v) => {
          agent.direct.providerMode = v;
          // If the chosen mode has a recommended model, suggest it.
          const m = spec.modes[v];
          if (m && m.recommendedModel) agent.direct.model = m.recommendedModel;
          await plugin.saveSettings();
          reRender();
        });
      });

    // If the current mode carries a planUrl, surface it as a hint line.
    const currentMode = spec.modes[agent.direct.providerMode];
    if (currentMode && currentMode.planUrl) {
      const p = containerEl.createEl("p", { cls: "setting-item-description" });
      p.appendText(t("settings.agent.planLinkPrefix", "购买/管理套餐："));
      p.createEl("a", { text: currentMode.planUrl, href: currentMode.planUrl });
    }
  }

  // --- Region dropdown (only if provider has region split) -----------------
  if (spec.region) {
    new Setting(containerEl)
      .setName(t("settings.agent.regionName", "区域"))
      .setDesc(t(
        "settings.agent.regionDesc",
        "国内：走国内 API 节点。海外：走 .ai 节点。一般跟你的账号注册区域一致。",
      ))
      .addDropdown((d) => {
        if (spec.region.cnUrl) d.addOption("cn", t("settings.agent.regionCN", "中国大陆"));
        if (spec.region.intlUrl) d.addOption("intl", t("settings.agent.regionIntl", "海外"));
        d.setValue(agent.direct.region || spec.region.defaultRegion || "cn");
        d.onChange(async (v) => {
          agent.direct.region = v === "intl" ? "intl" : "cn";
          await plugin.saveSettings();
        });
      });
  }

  // --- Custom base URL (for openai-compat-custom) --------------------------
  if (spec.userMustProvideBaseUrl) {
    new Setting(containerEl)
      .setName(t("settings.agent.customBaseUrlName", "API 地址"))
      .setDesc(t(
        "settings.agent.customBaseUrlDesc",
        "你的 OpenAI-compatible 服务端点。完整 URL，包含版本号（如 https://...../v1）。",
      ))
      .addText((tx) => {
        tx
          .setPlaceholder("https://your-relay.example.com/v1")
          .setValue(agent.direct.baseUrlOverride || "")
          .onChange(async (v) => {
            agent.direct.baseUrlOverride = String(v || "").trim();
            await plugin.saveSettings();
          });
      });
  }

  // --- API key -------------------------------------------------------------
  const keyHolder = { value: getActiveApiKey(agent) };
  new Setting(containerEl)
    .setName(t("settings.agent.apiKeyName", "API Key"))
    .setDesc(t(
      "settings.agent.apiKeyDesc",
      "粘贴该服务商的 API Key。切换服务商时每家 key 单独保存，互不覆盖。",
    ))
    .addText((tx) => {
      const inputEl = tx.inputEl;
      if (inputEl) inputEl.type = "password";
      tx
        .setPlaceholder(t("settings.agent.apiKeyPlaceholder", "sk-..."))
        .setValue(keyHolder.value)
        .onChange(async (v) => {
          keyHolder.value = String(v || "");
          setApiKeyFor(agent, spec.id, keyHolder.value);
          await plugin.saveSettings();
        });
    });

  // --- Model dropdown ------------------------------------------------------
  if (spec.userMustProvideModels) {
    new Setting(containerEl)
      .setName(t("settings.agent.modelNameCustom", "模型名"))
      .setDesc(t(
        "settings.agent.modelDescCustom",
        "服务商使用的 model id（豆包要填 endpoint-id；其他厂家填官方 model id）。",
      ))
      .addText((tx) => {
        tx
          .setPlaceholder("model-id")
          .setValue(agent.direct.model || "")
          .onChange(async (v) => {
            agent.direct.model = String(v || "").trim();
            await plugin.saveSettings();
          });
      });
  } else if (Array.isArray(spec.models) && spec.models.length > 0) {
    new Setting(containerEl)
      .setName(t("settings.agent.modelName", "模型"))
      .setDesc(t("settings.agent.modelDesc", "选择该服务商提供的模型。"))
      .addDropdown((d) => {
        for (const m of spec.models) {
          const label = m.deprecated ? `${m.label} (deprecated)` : m.label;
          d.addOption(m.id, label);
        }
        d.setValue(agent.direct.model || spec.defaultModel);
        d.onChange(async (v) => {
          agent.direct.model = v;
          await plugin.saveSettings();
        });
      });
  }

  // --- Test button ---------------------------------------------------------
  const testHostEl = containerEl.createDiv({ cls: "flownote-test-result-host" });
  new Setting(containerEl)
    .setName(t("settings.agent.testName", "测试连接"))
    .setDesc(t(
      "settings.agent.testDesc",
      "向所选服务商发送一次极短请求，验证 URL、Key 和模型是否可用。不会消耗多少 token。",
    ))
    .addButton((b) => {
      b.setButtonText(t("settings.agent.testButton", "测试"));
      b.onClick(async () => {
        b.setDisabled(true);
        testHostEl.empty();
        testHostEl.createEl("span", { text: t("settings.agent.testRunning", "测试中…") });
        try {
          const userConfig = {
            providerId: spec.id,
            mode: agent.direct.providerMode || spec.defaultMode,
            region: agent.direct.region,
            apiKey: getActiveApiKey(agent),
            model: agent.direct.model || spec.defaultModel,
            baseUrlOverride: agent.direct.baseUrlOverride || "",
            userAgentOverride: agent.direct.userAgentOverride || "",
            versionHeaderOverride: agent.direct.versionHeaderOverride || "",
            stream: false, // simpler + faster for the test ping
          };
          if (!userConfig.apiKey) {
            throw new Error(t("settings.agent.testNoKey", "请先填写 API Key。"));
          }
          if (spec.userMustProvideBaseUrl && !userConfig.baseUrlOverride) {
            throw new Error(t("settings.agent.testNoBaseUrl", "请先填写 API 地址。"));
          }
          const baseUrl = resolveBaseUrl(spec, userConfig);
          const provider = buildProviderFromSpec({ spec, userConfig });
          const result = await provider.testConnection();
          testHostEl.empty();
          if (result.ok) {
            const ok = testHostEl.createEl("span", {
              text: t(
                "settings.agent.testOk",
                "✓ 连接成功（{ms} ms） · {url}",
                { ms: String(result.latencyMs), url: baseUrl },
              ),
            });
            ok.style.color = "var(--text-success, #2ea043)";
            new Notice(t("settings.agent.noticeTestOk", "Provider 测试成功"));
          } else {
            const err = testHostEl.createEl("span", {
              text: t(
                "settings.agent.testFail",
                "✗ 测试失败：{error}",
                { error: result.error || "unknown" },
              ),
            });
            err.style.color = "var(--text-error, #cf222e)";
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          testHostEl.empty();
          const errEl = testHostEl.createEl("span", { text: `✗ ${msg}` });
          errEl.style.color = "var(--text-error, #cf222e)";
        } finally {
          b.setDisabled(false);
        }
      });
    });

  // --- Advanced collapsible ------------------------------------------------
  const advHeader = new Setting(containerEl)
    .setName(t("settings.agent.advancedHeading", "高级（可选）"))
    .setHeading();
  containerEl.createEl("p", {
    text: t(
      "settings.agent.advancedHint",
      "通常不需要改这些。如果你的服务商要求特定 User-Agent 或 API 版本头，可在此处覆盖。",
    ),
    cls: "setting-item-description",
  });

  new Setting(containerEl)
    .setName(t("settings.agent.advBaseUrlName", "Base URL 覆盖"))
    .setDesc(t(
      "settings.agent.advBaseUrlDesc",
      "留空使用上面服务商/区域对应的默认 URL。",
    ))
    .addText((tx) => {
      tx
        .setPlaceholder(resolveBaseUrl(spec, {
          providerId: spec.id,
          mode: agent.direct.providerMode || spec.defaultMode,
          apiKey: "",
          model: "",
        }))
        .setValue(agent.direct.baseUrlOverride || "")
        .onChange(async (v) => {
          agent.direct.baseUrlOverride = String(v || "").trim();
          await plugin.saveSettings();
        });
    });

  new Setting(containerEl)
    .setName(t("settings.agent.advUserAgentName", "User-Agent 覆盖"))
    .setDesc(t(
      "settings.agent.advUserAgentDesc",
      "默认 FLOWnote (Obsidian)。如服务商文档要求特定标识，按其文档填写。",
    ))
    .addText((tx) => {
      tx
        .setPlaceholder("FLOWnote (Obsidian)")
        .setValue(agent.direct.userAgentOverride || "")
        .onChange(async (v) => {
          agent.direct.userAgentOverride = String(v || "");
          await plugin.saveSettings();
        });
    });

  if (spec.protocol === "anthropic-messages") {
    new Setting(containerEl)
      .setName(t("settings.agent.advVersionName", "Anthropic 版本头"))
      .setDesc(t(
        "settings.agent.advVersionDesc",
        "默认 anthropic-version: 2026-01-01。仅在服务商有特定要求时修改。",
      ))
      .addText((tx) => {
        tx
          .setPlaceholder("anthropic-version: 2026-01-01")
          .setValue(agent.direct.versionHeaderOverride || "")
          .onChange(async (v) => {
            agent.direct.versionHeaderOverride = String(v || "");
            await plugin.saveSettings();
          });
      });
  }

  new Setting(containerEl)
    .setName(t("settings.agent.streamName", "启用流式回复"))
    .setDesc(t(
      "settings.agent.streamDesc",
      "开启：模型回答逐字蹦出。关闭：等模型回答完成后一次性显示。移动端遇到流式问题可临时关闭。",
    ))
    .addToggle((tg) => {
      tg.setValue(agent.direct.stream !== false);
      tg.onChange(async (v) => {
        agent.direct.stream = !!v;
        await plugin.saveSettings();
      });
    });

  // Active model's hard ceiling, shown as the placeholder so the user
  // knows what "default" means in concrete terms.
  const activeModel = (spec.models || []).find((m) => m && m.id === agent.direct.model);
  const modelCeiling = (activeModel && activeModel.maxOutput) || 0;
  new Setting(containerEl)
    .setName(t("settings.agent.maxOutputName", "单次输出 token 上限（高级）"))
    .setDesc(t(
      "settings.agent.maxOutputDesc",
      "留 0 或空 = 直接用当前模型的硬上限（推荐，模型只生成需要的长度，多余不浪费）。" +
      "想限制成本时可手动填一个较小值。" +
      (modelCeiling > 0 ? `当前模型「${activeModel.label}」硬上限：${modelCeiling.toLocaleString()} tokens。` : ""),
    ))
    .addText((tx) => {
      tx
        .setPlaceholder(modelCeiling > 0 ? String(modelCeiling) : "16384")
        .setValue(agent.direct.maxOutputTokens ? String(agent.direct.maxOutputTokens) : "")
        .onChange(async (v) => {
          const n = Number(String(v || "").trim());
          agent.direct.maxOutputTokens = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
          await plugin.saveSettings();
        });
    });
}

/**
 * Mixin so the desktop tab can call `this.renderAgentProviderSection(containerEl)`.
 * Forwards to the free function.
 */
const agentProviderSectionMethods = {
  renderAgentProviderSection(containerEl) {
    renderAgentProviderSection({
      containerEl,
      plugin: this.plugin,
      tab: this,
      refresh: () => this.display(),
    });
  },
};

module.exports = {
  renderAgentProviderSection,
  agentProviderSectionMethods,
};
