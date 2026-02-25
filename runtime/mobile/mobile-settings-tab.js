const { PluginSettingTab, Setting, Notice } = require("obsidian");
const { PROVIDER_PRESETS, testConnection } = require("./mobile-ai-service");
const { tFromContext } = require("../i18n-runtime");

function getAiProviderDisplayName(providerId, fallbackName, t) {
  return t(`mobile.providers.${String(providerId || "").trim().toLowerCase()}`, fallbackName || String(providerId || ""));
}

class MobileSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const { containerEl } = this;
    containerEl.empty();

    if (typeof this.setHeading === "function") this.setHeading();
    containerEl.createEl("p", {
      text: t("settings.mobile.intro", "配置 AI 服务和日记路径，用于移动端快速捕获想法。"),
    });

    new Setting(containerEl)
      .setName(t("settings.language.name", "界面语言"))
      .setDesc(t(
        "settings.language.desc",
        "默认跟随设备语言。切换后界面即时刷新；命令名与 Ribbon 提示重载后生效。",
      ))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("auto", t("settings.language.optionAuto", "跟随系统（推荐）"))
          .addOption("zh-CN", t("settings.language.optionZhCN", "简体中文"))
          .addOption("en", t("settings.language.optionEn", "English"))
          .setValue(String(this.plugin.settings.uiLanguage || "auto"))
          .onChange(async (value) => {
            this.plugin.settings.uiLanguage = String(value || "auto");
            await this.plugin.saveSettings();
            this.display();
            new Notice(t(
              "notices.languageAppliedReloadTip",
              "界面语言已更新。命令名和 Ribbon 提示将在重载插件后生效。",
            ));
          });
      });

    const mc = this.plugin.settings.mobileCapture;
    const locale = typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "zh-CN";

    // --- AI Provider ---
    new Setting(containerEl)
      .setName(t("mobile.settings.providerName", "AI 提供商"))
      .setDesc(t("mobile.settings.providerDesc", "选择一个预设提供商，或选择自定义填写地址。"))
      .addDropdown((d) => {
        for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
          d.addOption(id, getAiProviderDisplayName(id, preset.name, t));
        }
        d.setValue(mc.provider).onChange(async (v) => {
          mc.provider = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    // --- API Key ---
    new Setting(containerEl)
      .setName(t("mobile.settings.apiKeyName", "API Key"))
      .setDesc(t("mobile.settings.apiKeyDesc", "对应提供商的 API 密钥。留空则跳过 AI 清理，直接记录原文。"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.style.width = "100%";
        text
          .setPlaceholder("sk-...")
          .setValue(mc.apiKey)
          .onChange(async (v) => {
            mc.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // --- Base URL ---
    const preset = PROVIDER_PRESETS[mc.provider] || PROVIDER_PRESETS.deepseek;
    const effectiveUrl = mc.baseUrl || preset.baseUrl || "(Not set)";
    new Setting(containerEl)
      .setName(t("mobile.settings.baseUrlName", "Base URL（可选）"))
      .setDesc(t("mobile.settings.baseUrlDesc", "留空使用预设地址。当前生效: {value}", { value: effectiveUrl }))
      .addText((text) => {
        text
          .setPlaceholder(preset.baseUrl || "https://api.example.com")
          .setValue(mc.baseUrl)
          .onChange(async (v) => {
            mc.baseUrl = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // --- Model ---
    const effectiveModel = mc.model || preset.defaultModel || "(Not set)";
    new Setting(containerEl)
      .setName(t("mobile.settings.modelName", "模型名（可选）"))
      .setDesc(t("mobile.settings.modelDesc", "留空使用预设模型。当前生效: {value}", { value: effectiveModel }))
      .addText((text) => {
        text
          .setPlaceholder(preset.defaultModel || "model-name")
          .setValue(mc.model)
          .onChange(async (v) => {
            mc.model = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // --- AI Cleanup Toggle ---
    new Setting(containerEl)
      .setName(t("mobile.settings.aiCleanupName", "启用 AI 清理"))
      .setDesc(t("mobile.settings.aiCleanupDesc", "开启后自动去除语气词（嗯、啊、那个等）。关闭则直接记录原文。"))
      .addToggle((toggle) => {
        toggle.setValue(mc.enableAiCleanup).onChange(async (v) => {
          mc.enableAiCleanup = v;
          await this.plugin.saveSettings();
        });
      });

    // --- Daily Note Path ---
    new Setting(containerEl)
      .setName(t("mobile.settings.dailyPathName", "每日笔记路径"))
      .setDesc(t("mobile.settings.dailyPathDesc", "日记文件夹的相对路径（不含文件名）。"))
      .addText((text) => {
        text
          .setPlaceholder(locale === "zh-CN" ? "01-捕获层/每日笔记" : "01-Capture/Daily Notes")
          .setValue(mc.dailyNotePath)
          .onChange(async (v) => {
            mc.dailyNotePath = v.trim() || (locale === "zh-CN" ? "01-捕获层/每日笔记" : "01-Capture/Daily Notes");
            await this.plugin.saveSettings();
          });
      });

    // --- Section Header ---
    new Setting(containerEl)
      .setName(t("mobile.settings.headerName", "想法区域标题"))
      .setDesc(t("mobile.settings.headerDesc", "日记中用于存放想法的区域标题。"))
      .addText((text) => {
        text
          .setPlaceholder(locale === "zh-CN" ? "### 💡 想法和灵感" : "### 💡 Ideas")
          .setValue(mc.ideaSectionHeader)
          .onChange(async (v) => {
            mc.ideaSectionHeader = v.trim() || (locale === "zh-CN" ? "### 💡 想法和灵感" : "### 💡 Ideas");
            await this.plugin.saveSettings();
          });
      });

    // --- Test Connection ---
    new Setting(containerEl)
      .setName(t("mobile.settings.testName", "测试连接"))
      .setDesc(t("mobile.settings.testDesc", "验证 AI 服务是否可用。"))
      .addButton((b) => {
        b.setButtonText(t("mobile.settings.testBtn", "测试")).onClick(async () => {
          if (!mc.apiKey) {
            new Notice(t("notices.needApiKeyFirst", "请先填写 API Key"));
            return;
          }
          b.setDisabled(true);
          b.setButtonText(t("mobile.settings.testBusy", "测试中..."));
          try {
            const result = await testConnection(mc, { locale });
            if (result.ok) {
              new Notice(`✅ ${result.message}`);
            } else {
              new Notice(`❌ ${result.message}`);
            }
          } catch (e) {
            new Notice(`❌ ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText(t("mobile.settings.testBtn", "测试"));
          }
        });
      });
  }
}

module.exports = { MobileSettingsTab };
