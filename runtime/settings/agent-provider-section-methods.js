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

const { Setting, Notice, Platform = {} } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { bindDropdownChange } = require("./component-value-utils");
const {
  defaultAgentSettings,
  getActiveApiKey,
  setApiKeyFor,
  switchActiveProvider,
  normalizeAgentSettingsInPlace,
} = require("../agent/agent-settings");
const { normalizeToolPermissionMode } = require("../agent/permission-policy");
const { buildProviderFromSpec } = require("../agent/agent-provider-resolver");
const {
  getProviderSpec,
  listProviderSpecs,
  resolveBaseUrl,
} = require("../providers/registry");

function getEffectiveAgentProviderMode(agent, platform = Platform) {
  const persistedMode = agent && agent.mode === "opencode-legacy" ? "opencode-legacy" : "direct";
  return platform && platform.isMobile ? "direct" : persistedMode;
}

function ensureAgentProviderSettings(plugin) {
  if (!plugin.settings.agentProvider) {
    plugin.settings.agentProvider = defaultAgentSettings();
  } else {
    plugin.settings.agentProvider = normalizeAgentSettingsInPlace(plugin.settings.agentProvider);
  }
  return plugin.settings.agentProvider;
}

function getCaptureModelOptions(plugin, providerId, preset, currentModel) {
  const fetchedRoot = plugin.__flownoteMobileCaptureFetchedModels || {};
  const fetched = fetchedRoot[providerId];
  const builtin = Array.isArray(preset.models) ? preset.models : [];
  const ids = [];
  for (const id of builtin) {
    const text = String(id || "").trim();
    if (text && !ids.includes(text)) ids.push(text);
  }
  if (preset.defaultModel && !ids.includes(preset.defaultModel)) ids.unshift(preset.defaultModel);
  if (fetched && Array.isArray(fetched.models)) {
    for (const item of fetched.models) {
      const text = String((item && item.id) || "").trim();
      if (text && !ids.includes(text)) ids.push(text);
    }
  }
  const current = String(currentModel || "").trim();
  if (current && !ids.includes(current)) ids.unshift(current);
  return {
    models: ids.map((id) => ({ id, label: id })),
    fetchedAt: fetched && fetched.fetchedAt ? fetched.fetchedAt : 0,
  };
}

function hasStaticModelEntries(models) {
  return Array.isArray(models) && models.some((model) => {
    if (typeof model === "string") return model.trim();
    return model && typeof model.id === "string" && model.id.trim();
  });
}

function shouldKeepStaticModelsAfterRefreshFailure(spec) {
  if (!spec || spec.id === "ollama" || spec.userMustProvideBaseUrl) return false;
  return hasStaticModelEntries(spec.models);
}

function shouldKeepStaticCaptureModelsAfterRefreshFailure(providerId, preset) {
  if (String(providerId || "").trim().toLowerCase() === "custom") return false;
  return hasStaticModelEntries(preset && preset.models);
}

function shouldShowModelRefreshButton(spec) {
  if (!spec) return false;
  if (spec.id === "ollama") return true;
  if (spec.userMustProvideBaseUrl || spec.modelsListEndpoint || spec.modelsListPath) return true;
  if (spec.protocol === "openai-chat" && !spec.userMustProvideModels) return true;
  return !shouldKeepStaticModelsAfterRefreshFailure(spec);
}

function shouldShowCaptureModelRefreshButton(providerId, preset) {
  if (preset && preset.modelsPath) return true;
  return !shouldKeepStaticCaptureModelsAfterRefreshFailure(providerId, preset);
}

function ensureMobileCaptureSettings(plugin) {
  if (!plugin.settings.mobileCapture || typeof plugin.settings.mobileCapture !== "object") {
    plugin.settings.mobileCapture = {};
  }
  const mc = plugin.settings.mobileCapture;
  if (!mc.provider) mc.provider = "deepseek";
  if (typeof mc.apiKey !== "string") mc.apiKey = "";
  if (typeof mc.baseUrl !== "string") mc.baseUrl = "";
  if (typeof mc.model !== "string") mc.model = "";
  return mc;
}

function scheduleOllamaModelAutofetch({ plugin, agent, spec, refresh }) {
  if (!plugin || !agent || !spec || spec.id !== "ollama") return;
  if (!plugin.__flownoteFetchedModels) plugin.__flownoteFetchedModels = {};
  const fetched = plugin.__flownoteFetchedModels[spec.id];
  const currentModel = String(agent.direct && (agent.direct.model || spec.defaultModel) || "").trim();
  const fetchedHasCurrent = fetched && Array.isArray(fetched.models)
    && fetched.models.some((m) => m && m.id === currentModel);
  if (fetched && Array.isArray(fetched.models) && fetched.models.length > 0 && fetchedHasCurrent) return;
  if (!plugin.__flownoteAutoFetchingModels) plugin.__flownoteAutoFetchingModels = {};
  if (plugin.__flownoteAutoFetchingModels[spec.id]) return;
  plugin.__flownoteAutoFetchingModels[spec.id] = true;

  const run = async () => {
    try {
      const result = await refreshOllamaModelListNow({ plugin, agent, spec });
      if (result && result.modelChanged) {
        await plugin.saveSettings();
      }
      if (typeof refresh === "function") refresh();
    } catch (_e) {
      // Leave the manual refresh button available; no modal noise on render.
    } finally {
      plugin.__flownoteAutoFetchingModels[spec.id] = false;
    }
  };

  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    window.setTimeout(run, 0);
  } else {
    Promise.resolve().then(run);
  }
}

async function refreshOllamaModelListNow({ plugin, agent, spec }) {
  if (!plugin || !agent || !spec || spec.id !== "ollama") return { models: [], modelChanged: false };
  if (!plugin.__flownoteFetchedModels) plugin.__flownoteFetchedModels = {};
  const userConfig = {
    providerId: spec.id,
    mode: agent.direct.providerMode || spec.defaultMode,
    region: agent.direct.region,
    apiKey: getActiveApiKey(agent),
    model: agent.direct.model || spec.defaultModel,
    baseUrlOverride: agent.direct.baseUrlOverride || "",
    userAgentOverride: agent.direct.userAgentOverride || "",
    versionHeaderOverride: agent.direct.versionHeaderOverride || "",
    stream: false,
  };
  const provider = buildProviderFromSpec({ spec, userConfig });
  if (typeof provider.listModels !== "function") return { models: [], modelChanged: false };
  const list = await provider.listModels();
  plugin.__flownoteFetchedModels[spec.id] = { models: list, fetchedAt: Date.now() };
  const currentModel = String(agent.direct.model || spec.defaultModel || "").trim();
  const hasCurrent = list.some((m) => m && m.id === currentModel);
  const nextModel = list.length > 0 && !hasCurrent ? String(list[0].id || "") : "";
  if (nextModel) {
    agent.direct.model = nextModel;
  }
  return { models: list, modelChanged: Boolean(nextModel) };
}


function renderOllamaMobileAiOverride({ containerEl, plugin, tab, refresh }) {
  const t = (key, fallback, params = {}) =>
    tFromContext(tab || plugin, key, fallback, params);
  let mobileAiService;
  try {
    mobileAiService = require("../mobile/mobile-ai-service");
  } catch (_e) {
    return;
  }
  const {
    PROVIDER_PRESETS,
    getAiProviderDisplayName,
    listCaptureModels,
    testConnection,
  } = mobileAiService;
  const mc = ensureMobileCaptureSettings(plugin);
  const locale = typeof plugin.getEffectiveLocale === "function" ? plugin.getEffectiveLocale() : "zh-CN";
  const preset = PROVIDER_PRESETS[mc.provider] || PROVIDER_PRESETS.deepseek;

  const note = containerEl.createDiv({ cls: "oc-settings-note oc-settings-note-warning" });
  note.createEl("div", {
    cls: "oc-settings-note-title",
    text: t("mobile.settings.ollamaDesktopWarningTitle", "电脑端正在使用 Ollama"),
  });
  note.createEl("div", {
    cls: "oc-settings-note-body",
    text: t(
      "mobile.settings.ollamaDesktopWarningBody",
      "Ollama 是电脑本机服务，手机无法直接访问电脑的 localhost。如果你需要在手机上使用 AI 聊天和快速捕获清理，请在下面配置一个手机可访问的云端接口。",
    ),
  });

  new Setting(containerEl)
    .setName(t("mobile.settings.providerName", "移动端 AI 提供商"))
    .setDesc(t("mobile.settings.providerDesc", "仅在电脑端 Agent 使用 Ollama 时生效，用于手机端聊天和快速捕获清理。"))
    .addDropdown((d) => {
      for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
        d.addOption(id, getAiProviderDisplayName(id, p.name, locale));
      }
      d.setValue(mc.provider);
      bindDropdownChange(d, async (providerId) => {
        mc.provider = providerId;
        await plugin.saveSettings();
        if (typeof refresh === "function") refresh();
      });
    });

  const apiKeySetting = new Setting(containerEl)
    .setName(t("mobile.settings.apiKeyName", "移动端 API Key"))
    .addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.style.width = "100%";
      text
        .setPlaceholder("sk-...")
        .setValue(mc.apiKey)
        .onChange(async (v) => {
          mc.apiKey = v.trim();
          await plugin.saveSettings();
        });
    });

  const descFrag = document.createDocumentFragment();
  descFrag.appendText(t("mobile.settings.apiKeyDesc", "填入手机端可访问的云端模型 API Key。留空则手机端跳过 AI 清理。"));
  if (preset.keyUrl) {
    descFrag.appendText(" ");
    const link = descFrag.createEl("a", {
      text: t("mobile.settings.providerKeyLinkPrefix", "前往 {name} 获取 →", {
        name: getAiProviderDisplayName(mc.provider, preset.name, locale),
      }),
      href: preset.keyUrl,
    });
    link.setAttr("target", "_blank");
  }
  apiKeySetting.setDesc(descFrag);

  new Setting(containerEl)
    .setName(t("mobile.settings.baseUrlName", "移动端 Base URL（可选）"))
    .setDesc(t("mobile.settings.baseUrlDesc", "留空使用预设地址。当前生效: {value}", {
      value: mc.baseUrl || preset.baseUrl || "(无)",
    }))
    .addText((text) => {
      text
        .setPlaceholder(preset.baseUrl || "https://api.example.com")
        .setValue(mc.baseUrl)
        .onChange(async (v) => {
          mc.baseUrl = v.trim();
          await plugin.saveSettings();
        });
    });

  const captureModelState = getCaptureModelOptions(plugin, mc.provider, preset, mc.model || preset.defaultModel);
  const fetchedAgeMin = captureModelState.fetchedAt
    ? Math.round((Date.now() - captureModelState.fetchedAt) / 60000)
    : null;
  const mobileModelSetting = new Setting(containerEl)
    .setName(t("mobile.settings.modelName", "移动端模型名（可选）"))
    .setDesc(
      fetchedAgeMin === null
        ? t("mobile.settings.modelDesc", "留空使用预设模型。当前生效: {value}", { value: mc.model || preset.defaultModel || "(无)" })
        : t("settings.agent.modelDescFetched", "模型列表已于 {min} 分钟前从官方接口刷新。", { min: fetchedAgeMin }),
    )
    .addDropdown((dropdown) => {
      for (const model of captureModelState.models) {
        dropdown.addOption(model.id, model.label);
      }
      dropdown.setValue(mc.model || preset.defaultModel || "");
      bindDropdownChange(dropdown, async (modelId) => {
        mc.model = String(modelId || "").trim();
        await plugin.saveSettings();
      });
    });

  if (shouldShowCaptureModelRefreshButton(mc.provider, preset)) {
    mobileModelSetting.addButton((button) => {
      button.setButtonText(t("settings.agent.modelRefresh", "刷新"));
      button.setTooltip(t("settings.agent.modelRefreshTooltip", "从官方 /v1/models 接口拉取最新模型列表（需要已填 API Key）。"));
      button.onClick(async () => {
        button.setDisabled(true);
        const originalText = button.buttonEl.textContent;
        button.setButtonText(t("settings.agent.modelRefreshLoading", "拉取中…"));
        try {
          if (!String(mc.apiKey || "").trim()) {
            throw new Error(t("settings.agent.testNoKey", "请先填写 API Key。"));
          }
          const models = await listCaptureModels(mc, { locale });
          if (!plugin.__flownoteMobileCaptureFetchedModels) {
            plugin.__flownoteMobileCaptureFetchedModels = {};
          }
          plugin.__flownoteMobileCaptureFetchedModels[mc.provider] = {
            models,
            fetchedAt: Date.now(),
          };
          if (!mc.model && models.length && models[0].id) {
            mc.model = models[0].id;
            await plugin.saveSettings();
          }
          new Notice(t("settings.agent.modelRefreshOk", "已拉取 {n} 个模型，刷新界面查看。", { n: models.length }));
          if (typeof refresh === "function") refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (shouldKeepStaticCaptureModelsAfterRefreshFailure(mc.provider, preset)) {
            new Notice(t(
              "settings.agent.modelRefreshFallbackStatic",
              "模型列表接口暂不可用，已保留内置模型列表。",
            ));
            button.setButtonText(originalText || t("settings.agent.modelRefresh", "刷新"));
            button.setDisabled(false);
            return;
          }
          new Notice(t("settings.agent.modelRefreshFailed", "拉取失败：{msg}", { msg }));
          button.setButtonText(originalText || t("settings.agent.modelRefresh", "刷新"));
          button.setDisabled(false);
        }
      });
    });
  }

  const mobileTestHostEl = containerEl.createDiv({ cls: "flownote-test-result-host" });
  new Setting(containerEl)
    .setName(t("mobile.settings.testName", "测试移动端连接"))
    .setDesc(t(
      "mobile.settings.testDesc",
      "测试手机端备用 AI 配置：{provider} / {model}。用于移动端聊天和快速捕获清理。",
      {
        provider: getAiProviderDisplayName(mc.provider, preset.name, locale),
        model: mc.model || preset.defaultModel || "(无)",
      },
    ))
    .addButton((button) => {
      button.setButtonText(t("mobile.settings.testBtn", "测试"));
      button.onClick(async () => {
        button.setDisabled(true);
        const originalText = button.buttonEl.textContent;
        button.setButtonText(t("mobile.settings.testBusy", "测试中..."));
        mobileTestHostEl.empty();
        mobileTestHostEl.createEl("span", { text: t("mobile.settings.testBusy", "测试中...") });
        try {
          const result = await testConnection(mc, { locale });
          mobileTestHostEl.empty();
          const el = mobileTestHostEl.createEl("span", {
            text: result && result.ok
              ? t("mobile.settings.testOk", "✓ 移动端 AI 连接成功")
              : t("mobile.settings.testFail", "✗ 移动端 AI 测试失败：{message}", {
                message: result && result.message ? result.message : "unknown",
              }),
          });
          el.style.color = result && result.ok
            ? "var(--text-success, #2ea043)"
            : "var(--text-error, #cf222e)";
          if (result && result.ok) {
            new Notice(t("mobile.settings.testNoticeOk", "移动端 AI 测试成功"));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          mobileTestHostEl.empty();
          const errEl = mobileTestHostEl.createEl("span", {
            text: t("mobile.settings.testFail", "✗ 移动端 AI 测试失败：{message}", { message: msg }),
          });
          errEl.style.color = "var(--text-error, #cf222e)";
        } finally {
          button.setButtonText(originalText || t("mobile.settings.testBtn", "测试"));
          button.setDisabled(false);
        }
      });
  });
}

function renderOllamaLocalModelNotice({ containerEl, plugin, tab }) {
  const t = (key, fallback, params = {}) =>
    tFromContext(tab || plugin, key, fallback, params);
  const note = containerEl.createDiv({ cls: "oc-settings-note oc-settings-note-warning" });
  note.createEl("div", {
    cls: "oc-settings-note-title",
    text: t("settings.agent.ollamaLocalNoticeTitle", "本地 Ollama 模型建议"),
  });
  note.createEl("div", {
    cls: "oc-settings-note-body",
    text: t(
      "settings.agent.ollamaLocalNoticeBody",
      "FLOWnote 会发送技能说明、工具列表和笔记上下文。本地模型建议使用上下文窗口 16K tokens 以上、参数规模 7B/8B 以上的工具调用模型，更推荐 14B 以上。规格太小可能只会回复“我会调用工具”，但实际不会执行技能或写入笔记。",
    ),
  });
}

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
  const agent = ensureAgentProviderSettings(plugin);

  // -------------------------------------------------------------------------
  // Mode toggle: Direct vs OpenCode legacy
  //
  // Mobile has no OpenCode CLI bridge. Use direct mode for this render only
  // and hide the toggle, but don't overwrite the persisted desktop setting
  // in the shared vault data.json.
  // -------------------------------------------------------------------------
  const effectiveMode = getEffectiveAgentProviderMode(agent, Platform);
  if (!(Platform && Platform.isMobile)) {
    new Setting(containerEl)
      .setName(t("settings.agent.modeName", "运行方式"))
      .setDesc(t(
        "settings.agent.modeDesc",
        "内置 AI：在插件里配置自己的 API Key，桌面和手机都可用，不依赖 OpenCode 或终端环境。\nOpenCode 桥接：继续通过本机 OpenCode 调用模型，适合已有 OpenCode 配置或想使用其免费/实验模型的用户；配置更复杂，主要适合桌面端。",
      ))
      .addDropdown((d) => {
        d.addOption("direct", t("settings.agent.modeDirect", "内置 AI（推荐新用户 / 移动端）"));
        d.addOption("opencode-legacy", t("settings.agent.modeOpenCode", "OpenCode 桥接（兼容旧用户）"));
        d.setValue(agent.mode);
        bindDropdownChange(d, async (selectedMode) => {
          const nextMode = selectedMode === "opencode-legacy" ? "opencode-legacy" : "direct";
          agent.mode = nextMode;
          plugin.settings.agentProviderModePreference = nextMode;
          await plugin.saveSettings();
          reRender();
        });
      });
  }

  if (effectiveMode === "opencode-legacy") {
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

  // --- Tool permission policy ----------------------------------------------
  const permissionMode = normalizeToolPermissionMode(plugin.settings.toolPermissionMode);
  plugin.settings.toolPermissionMode = permissionMode;
  new Setting(containerEl)
    .setName(t("settings.agent.permissionModeName", "工具权限"))
    .setDesc(t(
      "settings.agent.permissionModeDesc",
      "控制 AI 调用工具前是否弹出确认。保守模式会保持现在的行为；仅危险操作确认会自动允许读取、搜索、创建、追加和普通 API 请求；全自动会跳过所有工具确认。",
    ))
    .addDropdown((d) => {
      d.addOption("ask", t("settings.agent.permissionModeAsk", "每次确认（最保守）"));
      d.addOption("ask-dangerous", t("settings.agent.permissionModeDangerous", "仅危险操作确认"));
      d.addOption("auto", t("settings.agent.permissionModeAuto", "全自动（高风险）"));
      d.setValue(permissionMode);
      bindDropdownChange(d, async (value) => {
        const next = normalizeToolPermissionMode(value);
        if (next === "auto" && permissionMode !== "auto") {
          const warning = t(
            "settings.agent.permissionModeAutoConfirm",
            "全自动模式会允许 AI 不再逐次确认地写入、修改、移动笔记，并向外部 API 发起请求。请只在你信任当前模型、skill 和任务时开启。确定开启？",
          );
          if (typeof window !== "undefined" && typeof window.confirm === "function") {
            const ok = window.confirm(warning);
            if (!ok) {
              d.setValue(permissionMode);
              return;
            }
          } else {
            new Notice(warning);
          }
        }
        plugin.settings.toolPermissionMode = next;
        await plugin.saveSettings();
        reRender();
      });
    });

  if (permissionMode === "auto") {
    containerEl.createEl("p", {
      cls: "setting-item-description oc-permission-risk-warning",
      text: t(
        "settings.agent.permissionModeAutoWarning",
        "风险提示：全自动模式会跳过所有工具确认，包含覆盖、移动、批量修改笔记和外部 API 请求。",
      ),
    });
  } else if (permissionMode === "ask-dangerous") {
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t(
        "settings.agent.permissionModeDangerousHint",
        "危险操作仍会确认：覆盖写入、移动/重命名、批量替换、删除属性、PUT/PATCH/DELETE API 请求。",
      ),
    });
  }

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
      bindDropdownChange(d, async (providerId) => {
        switchActiveProvider(agent, providerId);
        const nextSpec = getProviderSpec(providerId);
        if (nextSpec && nextSpec.id === "ollama") {
          await refreshOllamaModelListNow({ plugin, agent, spec: nextSpec });
        }
        await plugin.saveSettings();
        reRender();
      });
    });

  const spec = getProviderSpec(agent.direct.providerId);
  if (!spec) return;
  scheduleOllamaModelAutofetch({ plugin, agent, spec, refresh: reRender });

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
        bindDropdownChange(d, async (providerMode) => {
          agent.direct.providerMode = providerMode;
          // If the chosen mode has a recommended model, suggest it.
          const m = spec.modes[providerMode];
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
        bindDropdownChange(d, async (region) => {
          agent.direct.region = region === "intl" ? "intl" : "cn";
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
    .setName(spec.apiKeyOptional
      ? t("settings.agent.apiKeyNameOptional", "API Key（可选）")
      : t("settings.agent.apiKeyName", "API Key"))
    .setDesc(t(
      spec.apiKeyOptional ? "settings.agent.apiKeyDescOptional" : "settings.agent.apiKeyDesc",
      spec.apiKeyOptional
        ? "本地服务通常不需要 API Key；如果你的转发服务要求鉴权，可以在这里填写。"
        : "粘贴该服务商的 API Key。切换服务商时每家 key 单独保存，互不覆盖。",
    ))
    .addText((tx) => {
      const inputEl = tx.inputEl;
      if (inputEl) inputEl.type = "password";
      tx
        .setPlaceholder(spec.apiKeyOptional
          ? t("settings.agent.apiKeyPlaceholderOptional", "可留空")
          : t("settings.agent.apiKeyPlaceholder", "sk-..."))
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
    // Cached fetched models from provider.listModels(), merged with the
    // registry baseline so the user gets the latest provider-side names
    // (e.g. when a vendor releases a new tier between plugin releases).
    if (!plugin.__flownoteFetchedModels) plugin.__flownoteFetchedModels = {};
    const fetched = plugin.__flownoteFetchedModels[spec.id];
    const fetchedAt = fetched && fetched.fetchedAt;
    const fetchedAgeMin = fetchedAt ? Math.round((Date.now() - fetchedAt) / 60000) : null;
    const fetchedList = (fetched && Array.isArray(fetched.models)) ? fetched.models : [];

    // Merge: registry entries first (preserves curated labels), then any
    // fetched ids the registry doesn't know about. Ollama is different:
    // registry entries are only startup placeholders, while real usability
    // depends on the local daemon's current /v1/models response.
    const registryIds = new Set(spec.models.map((m) => m.id));
    const merged = spec.id === "ollama" && fetchedList.length > 0
      ? fetchedList.map((m) => ({ id: m.id, label: m.label || m.id }))
      : [
        ...spec.models.map((m) => ({ id: m.id, label: m.deprecated ? `${m.label} (deprecated)` : m.label })),
        ...fetchedList
          .filter((m) => !registryIds.has(m.id))
          .map((m) => ({ id: m.id, label: `${m.label || m.id}（来自接口）` })),
      ];
    const selectedModel = agent.direct.model || spec.defaultModel;
    const modelExistsInDropdown = merged.some((m) => m.id === selectedModel);
    if (selectedModel && !modelExistsInDropdown) {
      merged.unshift({
        id: selectedModel,
        label: spec.id === "ollama"
          ? t("settings.agent.modelMissingInOllamaList", "{model}（未在当前 Ollama 列表中）", { model: selectedModel })
          : selectedModel,
      });
    }

    const modelSetting = new Setting(containerEl)
      .setName(t("settings.agent.modelName", "模型"))
      .setDesc(
        fetchedAgeMin === null
          ? (spec.id === "ollama"
            ? t("settings.agent.modelDescOllama", "选择当前本机 Ollama 已安装的模型。插件会从 localhost:11434/v1/models 读取列表；点击右侧刷新可重新读取。")
            : t("settings.agent.modelDesc", "选择该服务商提供的模型。点击右侧刷新可从官方接口拉取最新列表。"))
          : (spec.id === "ollama"
            ? t("settings.agent.modelDescFetchedOllama", "模型列表已于 {min} 分钟前从本机 Ollama 刷新。", { min: fetchedAgeMin })
            : t("settings.agent.modelDescFetched", "模型列表已于 {min} 分钟前从官方接口刷新。", { min: fetchedAgeMin })),
      )
      .addDropdown((d) => {
        for (const m of merged) d.addOption(m.id, m.label);
        d.setValue(selectedModel);
        bindDropdownChange(d, async (modelId) => {
          agent.direct.model = modelId;
          await plugin.saveSettings();
        });
      });

    if (shouldShowModelRefreshButton(spec)) {
      modelSetting.addButton((b) => {
        b.setButtonText(t("settings.agent.modelRefresh", "刷新"));
        b.setTooltip(spec.id === "ollama"
          ? t("settings.agent.modelRefreshTooltipOllama", "从本机 localhost:11434/v1/models 重新读取已安装模型。")
          : spec.apiKeyOptional
          ? t("settings.agent.modelRefreshTooltipOptional", "从模型服务的 /v1/models 接口拉取本机可用模型。")
          : t("settings.agent.modelRefreshTooltip", "从官方 /v1/models 接口拉取最新模型列表（需要已填 API Key）。"));
        b.onClick(async () => {
          b.setDisabled(true);
          const originalText = b.buttonEl.textContent;
          b.setButtonText(t("settings.agent.modelRefreshLoading", "拉取中…"));
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
              stream: false,
            };
            if (!userConfig.apiKey && !spec.apiKeyOptional) {
              throw new Error(t("settings.agent.testNoKey", "请先填写 API Key。"));
            }
            const provider = buildProviderFromSpec({ spec, userConfig });
            if (typeof provider.listModels !== "function") {
              throw new Error(t("settings.agent.modelRefreshUnsupported", "当前协议不支持自动获取模型列表。"));
            }
            const list = await provider.listModels();
            plugin.__flownoteFetchedModels[spec.id] = { models: list, fetchedAt: Date.now() };
            if (spec.id === "ollama" && list.length > 0) {
              const currentModel = String(agent.direct.model || spec.defaultModel || "").trim();
              if (!list.some((m) => m && m.id === currentModel)) {
                agent.direct.model = list[0].id;
                await plugin.saveSettings();
              }
            }
            new Notice(t("settings.agent.modelRefreshOk", "已拉取 {n} 个模型，刷新界面查看。", { n: list.length }));
            // Re-render the settings tab so the dropdown picks up the new list.
            if (typeof refresh === "function") refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (shouldKeepStaticModelsAfterRefreshFailure(spec)) {
              new Notice(t(
                "settings.agent.modelRefreshFallbackStatic",
                "模型列表接口暂不可用，已保留内置模型列表。",
              ));
              b.setButtonText(originalText || t("settings.agent.modelRefresh", "刷新"));
              b.setDisabled(false);
              return;
            }
            new Notice(t("settings.agent.modelRefreshFailed", "拉取失败：{msg}", { msg }));
            b.setButtonText(originalText || t("settings.agent.modelRefresh", "刷新"));
            b.setDisabled(false);
          }
        });
      });
    }
    // Use modelSetting so eslint doesn't flag it unused.
    void modelSetting;
  }

  // --- Test button ---------------------------------------------------------
  const testHostEl = containerEl.createDiv({ cls: "flownote-test-result-host" });
  new Setting(containerEl)
    .setName(t("settings.agent.testNameForProvider", "测试 {provider} 连接", {
      provider: spec.displayName || t("settings.agent.providerName", "服务商"),
    }))
    .setDesc(t(
      "settings.agent.testDescForProvider",
      "测试当前电脑端服务商配置：{provider} / {model}。会验证 URL、Key 和模型是否可用。",
      {
        provider: spec.displayName || t("settings.agent.providerName", "服务商"),
        model: agent.direct.model || spec.defaultModel || "(无)",
      },
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
          if (!userConfig.apiKey && !spec.apiKeyOptional) {
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

  if (spec.id === "ollama") {
    renderOllamaLocalModelNotice({ containerEl, plugin, tab });
    renderOllamaMobileAiOverride({ containerEl, plugin, tab, refresh: reRender });
  }

}

/**
 * Render ONLY the advanced (base URL / UA / version header / stream /
 * maxOutputTokens) settings. Pulled out of renderAgentProviderSection
 * so the caller can wrap it in a collapsible <details> at the top
 * level — keeps the "AI 服务" card uncluttered.
 *
 * Only meaningful in direct mode; the caller should skip in opencode mode.
 */
function renderAgentProviderAdvanced({ containerEl, plugin, tab }) {
  const t = (key, fallback, params = {}) =>
    tFromContext(tab || plugin, key, fallback, params);

  if (!plugin.settings.agentProvider) {
    plugin.settings.agentProvider = defaultAgentSettings();
  } else {
    plugin.settings.agentProvider = normalizeAgentSettingsInPlace(plugin.settings.agentProvider);
  }
  const agent = plugin.settings.agentProvider;
  if (agent.mode !== "direct") return;
  const spec = getProviderSpec(agent.direct.providerId);
  if (!spec) return;

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
        "默认 anthropic-version: 2023-06-01。仅在服务商有特定要求时修改。",
      ))
      .addText((tx) => {
        tx
          .setPlaceholder("anthropic-version: 2023-06-01")
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

  const activeModel = (spec.models || []).find((m) => m && m.id === agent.direct.model);
  const modelCeiling = (activeModel && activeModel.maxOutput) || 0;
  new Setting(containerEl)
    .setName(t("settings.agent.maxOutputName", "单次输出 token 上限"))
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
  renderAgentProviderAdvanced(containerEl) {
    renderAgentProviderAdvanced({
      containerEl,
      plugin: this.plugin,
      tab: this,
    });
  },
};

module.exports = {
  renderAgentProviderSection,
  renderAgentProviderAdvanced,
  agentProviderSectionMethods,
  getEffectiveAgentProviderMode,
};
