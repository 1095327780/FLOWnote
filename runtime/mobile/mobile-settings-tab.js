const { PluginSettingTab, Setting, Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { normalizeUiLanguage } = require("../i18n-locale-utils");
const {
  LINK_RESOLVER_PROVIDER_IDS,
  LINK_RESOLVER_DEFAULTS,
  normalizeResolverProviderId,
  getResolverProviderPreset,
  normalizeLinkResolver,
  defaultDailyNotePathByLocale,
  defaultIdeaSectionHeaderByLocale,
  getResolverProviderKey,
  setResolverProviderKey,
  resolveEffectiveLocaleFromSettings,
} = require("./mobile-settings-utils");
const {
  PROVIDER_PRESETS,
  getAiProviderDisplayName,
  testConnection,
} = require("./mobile-ai-service");

class MobileSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const locale = typeof this.plugin.getEffectiveLocale === "function"
      ? this.plugin.getEffectiveLocale()
      : resolveEffectiveLocaleFromSettings(this.plugin.settings);
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);

    if (typeof this.setHeading === "function") this.setHeading();
    containerEl.createEl("p", { text: t("settings.mobile.intro", "Configure AI service and daily note path for mobile quick capture.") });

    new Setting(containerEl)
      .setName(t("settings.language.name", "UI Language"))
      .setDesc(t("settings.language.desc", "Follows system by default. UI updates immediately after switching."))
      .addDropdown((d) => {
        d.addOption("auto", t("settings.language.optionAuto", "Follow system (recommended)"));
        d.addOption("zh-CN", t("settings.language.optionZhCN", "简体中文"));
        d.addOption("en", t("settings.language.optionEn", "English"));
        d.setValue(normalizeUiLanguage(this.plugin.settings.uiLanguage))
          .onChange(async (value) => {
            this.plugin.settings.uiLanguage = normalizeUiLanguage(value);
            await this.plugin.saveSettings();
            this.display();
            new Notice(t("notices.languageAppliedReloadTip", "Language updated. Command names and ribbon tooltip update after reload."));
          });
      });

    const mc = this.plugin.settings.mobileCapture;
    mc.linkResolver = normalizeLinkResolver(mc.linkResolver);
    const lr = mc.linkResolver;
    const preset = PROVIDER_PRESETS[mc.provider] || PROVIDER_PRESETS.deepseek;
    const resolverProvider = getResolverProviderPreset(lr.provider);

    new Setting(containerEl)
      .setName(t("mobile.settings.providerName", "AI Provider"))
      .setDesc(t("mobile.settings.providerDesc", "Choose preset provider or custom endpoint."))
      .addDropdown((d) => {
        for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
          d.addOption(id, getAiProviderDisplayName(id, p.name, locale));
        }
        d.setValue(mc.provider).onChange(async (v) => {
          mc.provider = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const apiKeySetting = new Setting(containerEl)
      .setName(t("mobile.settings.apiKeyName", "API Key"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.style.width = "100%";
        text.setPlaceholder("sk-...").setValue(mc.apiKey).onChange(async (v) => {
          mc.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });

    {
      const descFrag = document.createDocumentFragment();
      descFrag.appendText(t("mobile.settings.apiKeyDesc", "Provider API key. Leave empty to skip AI cleanup."));
      if (preset.keyUrl) {
        descFrag.appendText(" ");
        const link = descFrag.createEl("a", {
          text: t("mobile.settings.providerKeyLinkPrefix", "Get key for {name}", {
            name: getAiProviderDisplayName(mc.provider, preset.name, locale),
          }),
          href: preset.keyUrl,
        });
        link.setAttr("target", "_blank");
      }
      apiKeySetting.setDesc(descFrag);
    }

    const effectiveUrl = mc.baseUrl || preset.baseUrl || "(Not set)";
    new Setting(containerEl)
      .setName(t("mobile.settings.baseUrlName", "Base URL (optional)"))
      .setDesc(t("mobile.settings.baseUrlDesc", "Leave empty to use preset. Current: {value}", { value: effectiveUrl }))
      .addText((text) => {
        text.setPlaceholder(preset.baseUrl || "https://api.example.com").setValue(mc.baseUrl).onChange(async (v) => {
          mc.baseUrl = v.trim();
          await this.plugin.saveSettings();
        });
      });

    const effectiveModel = mc.model || preset.defaultModel || "(Not set)";
    new Setting(containerEl)
      .setName(t("mobile.settings.modelName", "Model (optional)"))
      .setDesc(t("mobile.settings.modelDesc", "Leave empty to use preset. Current: {value}", { value: effectiveModel }))
      .addText((text) => {
        text.setPlaceholder(preset.defaultModel || "model-name").setValue(mc.model).onChange(async (v) => {
          mc.model = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.aiCleanupName", "Enable AI cleanup"))
      .setDesc(t("mobile.settings.aiCleanupDesc", "Auto remove filler words from capture text."))
      .addToggle((toggle) => {
        toggle.setValue(mc.enableAiCleanup).onChange(async (v) => {
          mc.enableAiCleanup = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.urlSummaryName", "Enable URL summary"))
      .setDesc(t("mobile.settings.urlSummaryDesc", "Resolve URLs and append inline summary."))
      .addToggle((toggle) => {
        toggle.setValue(mc.enableUrlSummary !== false).onChange(async (v) => {
          mc.enableUrlSummary = v;
          if (mc.linkResolver && typeof mc.linkResolver === "object") {
            mc.linkResolver.enabled = v;
          }
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.resolverSwitchName", "Enable resolver"))
      .setDesc(t("mobile.settings.resolverSwitchDesc", "Enable external URL resolver providers."))
      .addToggle((toggle) => {
        toggle.setValue(lr.enabled).onChange(async (v) => {
          lr.enabled = v;
          mc.enableUrlSummary = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.resolverProviderName", "Resolver provider"))
      .setDesc(t("mobile.settings.resolverProviderDesc", "Choose URL resolver provider."))
      .addDropdown((d) => {
        for (const id of LINK_RESOLVER_PROVIDER_IDS) {
          const provider = getResolverProviderPreset(id);
          d.addOption(id, t(`settings.mobileCapture.resolverProvider.${id}.name`, provider.name));
        }
        d.setValue(resolverProvider.id).onChange(async (v) => {
          lr.provider = normalizeResolverProviderId(v);
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const resolverKeySetting = new Setting(containerEl)
      .setName(t(`settings.mobileCapture.resolverProvider.${resolverProvider.id}.keyLabel`, resolverProvider.keyLabel))
      .setDesc(t(`settings.mobileCapture.resolverHint.${resolverProvider.id}`, resolverProvider.hint))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(resolverProvider.keyPlaceholder)
          .setValue(getResolverProviderKey(lr, resolverProvider.id))
          .onChange(async (v) => {
            setResolverProviderKey(lr, resolverProvider.id, v);
            await this.plugin.saveSettings();
          });
      });

    {
      const descFrag = document.createDocumentFragment();
      descFrag.appendText(t("mobile.settings.resolverEntryPrefix", "Resolver setup:"));
      const keyLink = descFrag.createEl("a", {
        text: t("mobile.settings.resolverBuyKey", "Get API key"),
        href: resolverProvider.keyUrl,
      });
      keyLink.setAttr("target", "_blank");
      descFrag.appendText(" · ");
      const docLink = descFrag.createEl("a", {
        text: t("mobile.settings.resolverDocs", "Docs"),
        href: resolverProvider.docsUrl,
      });
      docLink.setAttr("target", "_blank");
      descFrag.appendText(t("mobile.settings.resolverEntrySuffix", " Configure and test before capture."));
      resolverKeySetting.setDesc(descFrag);
    }

    new Setting(containerEl)
      .setName(t("mobile.settings.timeoutName", "Resolver timeout (ms)"))
      .setDesc(t("mobile.settings.timeoutDesc", "Timeout for each resolver request."))
      .addText((text) => {
        text.setPlaceholder("25000").setValue(String(lr.timeoutMs)).onChange(async (v) => {
          lr.timeoutMs = Math.max(5000, Number(v) || LINK_RESOLVER_DEFAULTS.timeoutMs);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.retriesName", "Resolver retries"))
      .setDesc(t("mobile.settings.retriesDesc", "Retry count when resolver fails."))
      .addText((text) => {
        text.setPlaceholder("2").setValue(String(lr.retries)).onChange(async (v) => {
          lr.retries = Math.min(5, Math.max(0, Number(v) || LINK_RESOLVER_DEFAULTS.retries));
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.concurrencyName", "Resolver concurrency"))
      .setDesc(t("mobile.settings.concurrencyDesc", "Concurrent URL resolver requests."))
      .addText((text) => {
        text.setPlaceholder("2").setValue(String(lr.maxConcurrency)).onChange(async (v) => {
          lr.maxConcurrency = Math.min(5, Math.max(1, Number(v) || LINK_RESOLVER_DEFAULTS.maxConcurrency));
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.dailyPathName", "Daily note path"))
      .setDesc(t("mobile.settings.dailyPathDesc", "Relative folder path for daily notes."))
      .addText((text) => {
        text.setPlaceholder(defaultDailyNotePathByLocale(locale)).setValue(mc.dailyNotePath).onChange(async (v) => {
          mc.dailyNotePath = v.trim() || defaultDailyNotePathByLocale(locale);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.headerName", "Idea section header"))
      .setDesc(t("mobile.settings.headerDesc", "Heading used to store captured ideas."))
      .addText((text) => {
        text.setPlaceholder(defaultIdeaSectionHeaderByLocale(locale)).setValue(mc.ideaSectionHeader).onChange(async (v) => {
          mc.ideaSectionHeader = v.trim() || defaultIdeaSectionHeaderByLocale(locale);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.testName", "Test AI connection"))
      .setDesc(t("mobile.settings.testDesc", "Verify current AI provider configuration."))
      .addButton((b) => {
        b.setButtonText(t("mobile.settings.testBtn", "Test")).onClick(async () => {
          if (!mc.apiKey) {
            new Notice(t("notices.needApiKeyFirst", "Please fill API key first"));
            return;
          }
          b.setDisabled(true);
          b.setButtonText(t("mobile.settings.testBusy", "Testing..."));
          try {
            const result = await testConnection(mc, { locale });
            new Notice(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
          } catch (e) {
            new Notice(`❌ ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText(t("mobile.settings.testBtn", "Test"));
          }
        });
      });
  }
}

module.exports = { MobileSettingsTab };
