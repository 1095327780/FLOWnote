const { PluginSettingTab, Setting, Notice, Platform = {} } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { normalizeUiLanguage } = require("../i18n-locale-utils");
const { bindDropdownChange } = require("../settings/component-value-utils");
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
  renderAgentProviderSection,
} = require("../settings/agent-provider-section-methods");
const { buildShortcutUrls } = require("./shortcut-url-utils");

const FLOWNOTE_QUICK_CAPTURE_SHORTCUT_URL = "https://www.icloud.com/shortcuts/12b0291f16ff46cfa0280e18b0859118";

function isIPhoneLike() {
  const ua = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
  return Boolean(
    (Platform && Platform.isMobile)
    || (Platform && (Platform.isIosApp || Platform.isIos))
    || /iPhone|iPad|iPod/i.test(ua),
  );
}

async function copyShortcutText(text) {
  const value = String(text || "");
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(value);
    return true;
  }
  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand && document.execCommand("copy");
    textarea.remove();
    return Boolean(ok);
  }
  return false;
}

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

    if (isIPhoneLike()) {
      this.renderShortcutSection(containerEl, t);
    }

    new Setting(containerEl)
      .setName(t("settings.language.name", "UI Language"))
      .setDesc(t("settings.language.desc", "Follows system by default. UI updates immediately after switching."))
      .addDropdown((d) => {
        d.addOption("auto", t("settings.language.optionAuto", "Follow system (recommended)"));
        d.addOption("zh-CN", t("settings.language.optionZhCN", "简体中文"));
        d.addOption("en", t("settings.language.optionEn", "English"));
        d.setValue(normalizeUiLanguage(this.plugin.settings.uiLanguage));
        bindDropdownChange(d, async (value) => {
          this.plugin.settings.uiLanguage = normalizeUiLanguage(value);
          await this.plugin.saveSettings();
          this.display();
          new Notice(t("notices.languageAppliedReloadTip", "Language updated. Command names and ribbon tooltip update after reload."));
        });
      });

    // Agent provider section — same UI on desktop and mobile.
    renderAgentProviderSection({
      containerEl,
      plugin: this.plugin,
      tab: this,
      refresh: () => this.display(),
    });

    const mc = this.plugin.settings.mobileCapture;
    mc.linkResolver = normalizeLinkResolver(mc.linkResolver);
    const lr = mc.linkResolver;
    const resolverProvider = getResolverProviderPreset(lr.provider);

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
        d.setValue(resolverProvider.id);
        bindDropdownChange(d, async (providerId) => {
          lr.provider = normalizeResolverProviderId(providerId);
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
      .setName(t("mobile.settings.headerName", "Record section header"))
      .setDesc(t("mobile.settings.headerDesc", "Heading used to store captured content."))
      .addText((text) => {
        text.setPlaceholder(defaultIdeaSectionHeaderByLocale(locale)).setValue(mc.ideaSectionHeader).onChange(async (v) => {
          mc.ideaSectionHeader = v.trim() || defaultIdeaSectionHeaderByLocale(locale);
          await this.plugin.saveSettings();
        });
      });

  }

  renderShortcutSection(containerEl, t) {
    const vaultName = buildShortcutUrls(this.plugin).vaultName || "";
    const wrap = containerEl.createDiv({ cls: "oc-settings-section" });
    const heading = wrap.createDiv({ cls: "oc-settings-section-heading" });
    heading.createEl("h3", { text: t("mobile.shortcuts.heading", "快捷指令") });
    const group = wrap.createDiv({ cls: "oc-settings-group" });

    new Setting(group)
      .setName(t("mobile.shortcuts.installName", "安装 FLOWnote 快速捕获"))
      .setDesc(t("mobile.shortcuts.installDesc", "打开共享快捷指令后点「添加快捷指令」，保存到本机即可。"))
      .addButton((button) => {
        button.setButtonText(t("mobile.shortcuts.openShortcut", "打开链接"));
        button.onClick(() => {
          window.open(FLOWNOTE_QUICK_CAPTURE_SHORTCUT_URL, "_blank");
        });
      })
      .addButton((button) => {
        button.setButtonText(t("mobile.shortcuts.copyShortcutLink", "复制链接"));
        button.onClick(async () => {
          const ok = await copyShortcutText(FLOWNOTE_QUICK_CAPTURE_SHORTCUT_URL);
          new Notice(ok
            ? t("mobile.shortcuts.copied", "已复制快捷指令 URL")
            : t("mobile.shortcuts.copyFailed", "复制失败，请手动长按复制。"));
        });
      });

    const vaultCopyText = vaultName || t("mobile.shortcuts.vaultUnknown", "请填写你的 Obsidian 笔记库名称");
    new Setting(group)
      .setName(t("mobile.shortcuts.vaultNameTitle", "当前笔记库名称"))
      .setDesc(t("mobile.shortcuts.vaultNameDesc", "在快捷指令顶部「文本」一栏填入这个名称，用来生成 obsidian:// 链接。"))
      .addText((text) => {
        text.setValue(vaultCopyText);
        text.inputEl.readOnly = true;
        text.inputEl.addClass("oc-shortcut-vault-input");
      })
      .addButton((button) => {
        button.setButtonText(t("mobile.shortcuts.copyVaultName", "复制"));
        button.onClick(async () => {
          const ok = await copyShortcutText(vaultCopyText);
          new Notice(ok
            ? t("mobile.shortcuts.vaultCopied", "已复制笔记库名称")
            : t("mobile.shortcuts.copyFailed", "复制失败，请手动长按复制。"));
        });
      });

    const hint = group.createDiv({ cls: "oc-shortcut-simple-hint" });
    hint.createSpan({
      text: t(
        "mobile.shortcuts.simpleHint",
        "使用方式：安装上面的快捷指令后，把「当前笔记库名称」复制到快捷指令最上方的「文本」操作里；之后运行快捷指令即可快速捕获并提交到 FLOWnote。",
      ),
    });
  }
}

module.exports = { MobileSettingsTab };
