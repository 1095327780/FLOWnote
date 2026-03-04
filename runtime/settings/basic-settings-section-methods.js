const { Setting, Notice, Platform = {} } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { normalizeSupportedLocale } = require("../i18n-locale-utils");
const {
  LINK_RESOLVER_DEFAULTS,
  normalizeLinkResolver,
  normalizeResolverProviderId,
} = require("../settings-utils");

const LINK_RESOLVER_PROVIDER_PRESETS = {
  tianapi: {
    id: "tianapi",
    name: "TianAPI",
    keyLabel: "TianAPI Key",
    keyPlaceholder: "tianapi key",
    keyUrl: "https://www.tianapi.com/apiview/66",
    docsUrl: "https://www.tianapi.com/apiview/66",
    hint: "Suitable for basic webpage content extraction; dynamic or anti-crawl pages may fail.",
  },
  showapi: {
    id: "showapi",
    name: "ShowAPI",
    keyLabel: "ShowAPI AppKey",
    keyPlaceholder: "showapi appKey",
    keyUrl: "https://www.showapi.com/apiGateway/view/3262/1",
    docsUrl: "https://www.showapi.com/apiGateway/view/3262/1",
    hint: "Usage-based billing with some free quota on selected plans; good low-barrier option.",
  },
  gugudata: {
    id: "gugudata",
    name: "Gugudata",
    keyLabel: "Gugudata AppKey",
    keyPlaceholder: "gugudata appkey",
    keyUrl: "https://www.gugudata.com/api/details/url2markdown",
    docsUrl: "https://www.gugudata.com/api/details/url2markdown",
    hint: "Stable Markdown quality output; official docs recommend rate control.",
  },
};

function getResolverProviderPreset(providerId) {
  return LINK_RESOLVER_PROVIDER_PRESETS[normalizeResolverProviderId(providerId)]
    || LINK_RESOLVER_PROVIDER_PRESETS.tianapi;
}

function getResolverProviderKey(linkResolver, providerId) {
  if (providerId === "tianapi") return String(linkResolver.tianapiKey || "").trim();
  if (providerId === "showapi") return String(linkResolver.showapiAppKey || "").trim();
  if (providerId === "gugudata") return String(linkResolver.gugudataAppKey || "").trim();
  return "";
}

function setResolverProviderKey(linkResolver, providerId, nextValue) {
  const value = String(nextValue || "").trim();
  if (providerId === "tianapi") {
    linkResolver.tianapiKey = value;
    return;
  }
  if (providerId === "showapi") {
    linkResolver.showapiAppKey = value;
    return;
  }
  if (providerId === "gugudata") {
    linkResolver.gugudataAppKey = value;
  }
}

function isWindowsUiPlatform() {
  if (typeof Platform.isWin === "boolean") return Platform.isWin;
  if (typeof navigator !== "undefined" && typeof navigator.userAgent === "string") {
    return /windows/i.test(navigator.userAgent);
  }
  return false;
}

function getAiProviderDisplayName(providerId, fallbackName, t) {
  return t(`mobile.providers.${String(providerId || "").trim().toLowerCase()}`, fallbackName || String(providerId || ""));
}

class BasicSettingsSectionMethods {
  display() {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const { containerEl } = this;
    containerEl.empty();
    if (typeof this.setHeading === "function") this.setHeading();
    containerEl.createEl("p", {
      text: t(
        "settings.basic.intro",
        "常用情况下只需要确认连接状态和 Provider 登录。其余高级项一般保持默认即可。",
      ),
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
            const previousLocale = normalizeSupportedLocale(
              typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "en",
              "en",
            );
            this.plugin.settings.uiLanguage = String(value || "auto");
            await this.plugin.saveSettings();
            if (typeof this.plugin.refreshLocaleUi === "function") this.plugin.refreshLocaleUi();
            const nextLocale = normalizeSupportedLocale(
              typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "en",
              "en",
            );
            this.display();
            new Notice(t(
              "notices.languageAppliedReloadTip",
              "界面语言已更新。命令名和 Ribbon 提示将在重载插件后生效。",
            ));
            if (previousLocale === nextLocale) return;
            const languageLabel = nextLocale === "zh-CN"
              ? t("settings.language.optionZhCN", "简体中文")
              : t("settings.language.optionEn", "English");
            if (typeof this.showConfirmModal !== "function") return;
            const shouldReinstall = await this.showConfirmModal({
              title: t("settings.language.reinstallPromptTitle", "重装对应语言 Skills？"),
              description: t(
                "settings.language.reinstallPromptDesc",
                "当前语言已切换为 {language}。是否现在重装对应语言版本的内置 Skills 与模板？",
                { language: languageLabel },
              ),
              submitText: t("settings.language.reinstallPromptConfirm", "立即重装"),
              cancelText: t("settings.language.reinstallPromptCancel", "稍后"),
            });
            if (!shouldReinstall) return;
            await this.reinstallBundledContentWithPrompt(null, {
              locale: nextLocale,
              replaceAll: true,
              skipConflictPrompt: true,
            });
          });
      });

    const isWindows = isWindowsUiPlatform();
    const launchStrategyValue = String(this.plugin.settings.launchStrategy || "auto");
    const launchStrategyForUi = !isWindows && launchStrategyValue === "wsl" ? "auto" : launchStrategyValue;
    new Setting(containerEl)
      .setName(t("settings.basic.cliPathName", "FLOWnote CLI 路径（可选）"))
      .setDesc(t(
        "settings.basic.cliPathDesc",
        "通常留空。插件会自动探测。Windows 本机请优先填写 opencode.exe 或 cli.js（不要填 opencode.cmd）；Windows + WSL 可填 wsl、wsl.exe 或 wsl:发行版名（例如 wsl:Ubuntu）。",
      ))
      .addText((text) => {
        text
          .setPlaceholder("/Users/xxx/.opencode/bin/opencode")
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (v) => {
            this.plugin.settings.cliPath = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings.basic.launchStrategyName", "连接启动方式"))
      .setDesc(
        isWindows
          ? t(
            "settings.basic.launchStrategyDescWindows",
            "自动（推荐）：按系统自动检测并记忆成功方式。手动模式下按你选择的安装方式连接。",
          )
          : t(
            "settings.basic.launchStrategyDesc",
            "自动（推荐）：优先使用上次成功方式；失败时自动回退到其他方式。",
          ),
      )
      .addDropdown((d) => {
        d.addOption("auto", t("settings.basic.launchAuto", "自动（推荐）"));
        if (isWindows) {
          d.addOption("native", t("settings.basic.launchNativeWindows", "Windows 本机安装"))
            .addOption("wsl", t("settings.basic.launchWsl", "Windows WSL 安装"));
        } else {
          d.addOption("native", t("settings.basic.launchNativeMac", "Mac 本机安装"));
        }
        d.setValue(launchStrategyForUi).onChange(async (v) => {
          this.plugin.settings.launchStrategy = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (isWindows && this.plugin.settings.launchStrategy !== "native") {
      new Setting(containerEl)
        .setName(t("settings.basic.wslDistroName", "WSL 发行版（可选）"))
        .setDesc(t(
          "settings.basic.wslDistroDesc",
          "留空表示 WSL 默认发行版。可填 Ubuntu / Debian 等。填写后自动模式会优先尝试 WSL。",
        ))
        .addText((text) => {
          text
            .setPlaceholder("Ubuntu")
            .setValue(String(this.plugin.settings.wslDistro || ""))
            .onChange(async (v) => {
              this.plugin.settings.wslDistro = v.trim();
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName(t("settings.basic.skillInjectModeName", "技能注入方式"))
      .setDesc(t("settings.basic.skillInjectModeDesc", "当你使用 /skill 指令时，插件如何把技能内容传给模型。"))
      .addDropdown((d) => {
        d.addOption("summary", t("settings.basic.skillInjectModeSummary", "摘要注入（推荐）"))
          .addOption("full", t("settings.basic.skillInjectModeFull", "全文注入（更完整但更重）"))
          .addOption("off", t("settings.basic.skillInjectModeOff", "关闭注入（只发送用户输入）"))
          .setValue(this.plugin.settings.skillInjectMode)
          .onChange(async (v) => {
            this.plugin.settings.skillInjectMode = v;
            await this.plugin.saveSettings();
          });
      });

    this.renderProviderAuthSection(containerEl);

    new Setting(containerEl)
      .setName(t("settings.basic.advancedHeading", "高级设置"))
      .setHeading();

    new Setting(containerEl)
      .setName(t("settings.basic.experimentalSdkName", "实验功能：启用 SDK 传输"))
      .setDesc(t(
        "settings.basic.experimentalSdkDesc",
        "默认关闭。生产建议使用 compat 传输；仅在调试场景中开启 SDK。",
      ))
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.experimentalSdkEnabled))
          .onChange(async (value) => {
            this.plugin.settings.experimentalSdkEnabled = Boolean(value);
            if (!this.plugin.settings.experimentalSdkEnabled) {
              this.plugin.settings.transportMode = "compat";
            }
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.experimentalSdkEnabled) {
      new Setting(containerEl)
        .setName(t("settings.basic.transportModeName", "实验传输模式"))
        .setDesc(t("settings.basic.transportModeDesc", "兼容模式为稳定路径；SDK 模式仅用于实验排障。"))
        .addDropdown((dropdown) => {
          dropdown
            .addOption("compat", t("settings.basic.transportModeCompat", "compat（稳定）"))
            .addOption("sdk", t("settings.basic.transportModeSdk", "sdk（实验）"))
            .setValue(String(this.plugin.settings.transportMode || "compat"))
            .onChange(async (value) => {
              this.plugin.settings.transportMode = value === "sdk" ? "sdk" : "compat";
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName(t("settings.basic.skillsDirName", "内置 Skills 安装目录"))
      .setDesc(t(
        "settings.basic.skillsDirDesc",
        "默认 .opencode/skills。插件会自动安装内置 skills，并忽略目录中的非内置 skills。通常无需修改。",
      ))
      .addText((text) => {
        text.setValue(this.plugin.settings.skillsDir).onChange(async (v) => {
          this.plugin.settings.skillsDir = v.trim() || ".opencode/skills";
          await this.plugin.saveSettings();
          await this.plugin.reloadSkills();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.basic.reinstallSkillsName", "重新安装内置 Skills 与模板"))
      .setDesc(t(
        "settings.basic.reinstallSkillsDesc",
        "按当前界面语言安装/更新内置 skills，并将 Meta/模板 同步到各 skill 资源目录。遇到同名冲突会询问替换或忽略。",
      ))
      .addButton((b) => {
        b.setButtonText(t("settings.basic.reinstallSkillsNow", "立即重装")).onClick(async () => {
          await this.reinstallBundledContentWithPrompt(b, {
            replaceAll: true,
            skipConflictPrompt: true,
          });
        });
      });

    new Setting(containerEl)
      .setName(t("settings.basic.resetTemplateBaselineName", "重置模板基线"))
      .setDesc(t(
        "settings.basic.resetTemplateBaselineDesc",
        "仅当你需要恢复默认模板时使用。会把内置模板写回 Meta/模板（冲突可逐项替换或忽略）。",
      ))
      .addButton((b) => {
        b.setButtonText(t("settings.basic.resetTemplateBaselineNow", "重置模板")).onClick(async () => {
          b.setDisabled(true);
          b.setButtonText(t("settings.basic.resetTemplateBaselineBusy", "重置中..."));
          try {
            const resetResult = await this.plugin.resetTemplateBaseline({
              resolveConflict: (conflict) => this.promptBundledConflictResolution(conflict),
              defaultConflictAction: "skip",
            });
            if (resetResult.cancelled) {
              new Notice(t(
                "settings.basic.resetTemplateBaselineCanceled",
                "已取消模板重置。已处理 {synced}/{total}。",
                resetResult,
              ));
            } else if (!resetResult.errors.length) {
              new Notice(t(
                "settings.basic.resetTemplateBaselineSuccess",
                "模板重置完成：{synced}/{total}，目录 {metaRoot}",
                resetResult,
              ));
            } else {
              const msg = resetResult.errors[0];
              new Notice(t("settings.basic.resetTemplateBaselineFailed", "模板重置失败：{message}", { message: msg }));
            }
          } catch (e) {
            new Notice(t(
              "settings.basic.resetTemplateBaselineFailed",
              "模板重置失败：{message}",
              { message: e instanceof Error ? e.message : String(e) },
            ));
          } finally {
            b.setDisabled(false);
            b.setButtonText(t("settings.basic.resetTemplateBaselineNow", "重置模板"));
          }
        });
      });

    new Setting(containerEl)
      .setName(t("settings.basic.diagnosticsName", "连接诊断"))
      .setDesc(t("settings.basic.diagnosticsDesc", "检测 FLOWnote 可执行文件与连接状态。"))
      .addButton((b) => {
        b.setButtonText(t("settings.basic.diagnosticsRun", "运行诊断")).onClick(async () => {
          b.setDisabled(true);
          b.setButtonText(t("settings.basic.diagnosticsBusy", "测试中..."));
          try {
            const r = await this.plugin.diagnosticsService.run();
            if (r.connection.ok) new Notice(t("settings.basic.diagnosticsOk", "连接正常 ({mode})", r.connection));
            else new Notice(t("settings.basic.diagnosticsFailed", "连接失败: {error}", r.connection));
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          } finally {
            b.setDisabled(false);
            b.setButtonText(t("settings.basic.diagnosticsRun", "运行诊断"));
          }
        });
      });

    if (this.plugin.settings.launchStrategy === "auto") {
      const remembered = typeof this.plugin.getPreferredLaunchProfile === "function"
        ? this.plugin.getPreferredLaunchProfile()
        : null;
      const rememberedText = remembered
        ? remembered.mode === "wsl"
          ? t("settings.basic.autoMemoryRememberedWsl", "已记忆：WSL{distro}", {
            distro: remembered.distro ? ` (${remembered.distro})` : "",
          })
          : t("settings.basic.autoMemoryRememberedNative", "已记忆：本机 {command}", {
            command: remembered.command || "opencode",
          })
        : t("settings.basic.autoMemoryNone", "当前未记忆成功连接方式。");

      new Setting(containerEl)
        .setName(t("settings.basic.autoMemoryName", "自动连接记忆"))
        .setDesc(t("settings.basic.autoMemoryDesc", "{rememberedText} 成功连接后会自动更新。", { rememberedText }))
        .addButton((b) => {
          b.setButtonText(t("settings.basic.autoMemoryReset", "重置记忆")).onClick(async () => {
            b.setDisabled(true);
            try {
              if (typeof this.plugin.clearRememberedLaunchProfile === "function") {
                await this.plugin.clearRememberedLaunchProfile();
              }
              new Notice(t("settings.basic.autoMemoryResetDone", "已清除记忆的连接方式。"));
              this.display();
            } catch (e) {
              new Notice(t(
                "settings.basic.autoMemoryResetFailed",
                "重置失败: {message}",
                { message: e instanceof Error ? e.message : String(e) },
              ));
            } finally {
              b.setDisabled(false);
            }
          });
        });
    }

    // --- Mobile Capture Settings (visible on all platforms for pre-configuration) ---
    this.renderMobileCaptureSection(containerEl);
  }

  async reinstallBundledContentWithPrompt(buttonEl, options = {}) {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const button = buttonEl && typeof buttonEl.setDisabled === "function" ? buttonEl : null;
    const locale = normalizeSupportedLocale(
      options && options.locale
        ? options.locale
        : (typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "en"),
      "en",
    );
    const replaceAll = Boolean(options && options.replaceAll);
    const skipConflictPrompt = Boolean(options && options.skipConflictPrompt);
    const syncMetaTemplates = !Object.prototype.hasOwnProperty.call(options || {}, "syncMetaTemplates")
      || Boolean(options.syncMetaTemplates);
    if (button) {
      button.setDisabled(true);
      button.setButtonText(t("settings.basic.reinstallSkillsBusy", "重装中..."));
    }
    try {
      const syncResult = await this.plugin.reloadSkills({
        force: true,
        syncTemplates: true,
        locale,
        resolveConflict: skipConflictPrompt
          ? null
          : (conflict) => this.promptBundledConflictResolution(conflict),
        defaultConflictAction: replaceAll ? "replace" : "skip",
      });
      if (syncResult.cancelled) {
        new Notice(t(
          "settings.basic.reinstallSkillsCanceled",
          "已取消重装。已处理 skills {synced}/{total}，templates {syncedTemplates}/{totalTemplates}。",
          syncResult,
        ));
        return;
      }
      if (syncResult.errors.length) {
        const msg = syncResult.errors[0] || t("settings.basic.unknownError", "未知错误");
        new Notice(t("settings.basic.reinstallSkillsFailed", "重装失败：{message}", { message: msg }));
        return;
      }

      let metaResult = null;
      if (syncMetaTemplates) {
        metaResult = await this.plugin.resetTemplateBaseline({
          locale,
          resolveConflict: skipConflictPrompt
            ? null
            : (conflict) => this.promptBundledConflictResolution(conflict),
          defaultConflictAction: replaceAll ? "replace" : "skip",
        });
        if (metaResult.cancelled) {
          new Notice(t(
            "settings.basic.resetTemplateBaselineCanceled",
            "已取消模板重置。已处理 {synced}/{total}。",
            metaResult,
          ));
          return;
        }
        if (metaResult.errors.length) {
          const msg = metaResult.errors[0] || t("settings.basic.unknownError", "未知错误");
          new Notice(t(
            "settings.basic.resetTemplateBaselineFailed",
            "模板重置失败：{message}",
            { message: msg },
          ));
          return;
        }
      }

      const successPayload = {
        ...syncResult,
        syncedMetaTemplates: Number(metaResult && metaResult.synced ? metaResult.synced : 0),
        totalMetaTemplates: Number(metaResult && metaResult.total ? metaResult.total : 0),
      };
      new Notice(t(
        "settings.basic.reinstallSkillsSuccessWithMeta",
        "重装完成：skills {synced}/{total}，templates {syncedTemplates}/{totalTemplates}，meta {syncedMetaTemplates}/{totalMetaTemplates}，目录 {targetRoot}",
        successPayload,
      ));
    } catch (e) {
      new Notice(t(
        "settings.basic.reinstallSkillsFailed",
        "重装失败：{message}",
        { message: e instanceof Error ? e.message : String(e) },
      ));
    } finally {
      if (button) {
        button.setDisabled(false);
        button.setButtonText(t("settings.basic.reinstallSkillsNow", "立即重装"));
      }
    }
  }

  async promptBundledConflictResolution(conflict) {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const kind = String(conflict && conflict.kind ? conflict.kind : "");
    const kindText = kind === "skill"
      ? t("settings.basic.conflictKindSkill", "技能")
      : kind === "template"
        ? t("settings.basic.conflictKindTemplate", "模板")
        : t("settings.basic.conflictKindMetaTemplate", "Meta 模板");
    const title = t("settings.basic.contentConflictTitle", "发现同名冲突");
    const description = t(
      "settings.basic.contentConflictDesc",
      "{kind} `{id}` 已存在。请选择处理方式。",
      { kind: kindText, id: String(conflict && conflict.id ? conflict.id : "unknown") },
    );
    const contextLines = [
      t("settings.basic.contentConflictTarget", "目标：{path}", {
        path: String(conflict && conflict.targetPath ? conflict.targetPath : ""),
      }),
      t("settings.basic.contentConflictSource", "来源：{path}", {
        path: String(conflict && conflict.sourcePath ? conflict.sourcePath : ""),
      }),
    ].filter((line) => String(line || "").trim());
    return this.showConflictResolutionModal({
      title,
      description,
      context: contextLines.join("\n"),
      replaceText: t("settings.basic.conflictReplace", "替换"),
      skipText: t("settings.basic.conflictSkip", "忽略"),
      replaceAllText: t("settings.basic.conflictReplaceAll", "全部替换"),
      skipAllText: t("settings.basic.conflictSkipAll", "全部忽略"),
      cancelText: t("settings.basic.conflictCancel", "取消"),
    });
  }

  renderMobileCaptureSection(containerEl) {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    let PROVIDER_PRESETS;
    try {
      PROVIDER_PRESETS = require("../mobile/mobile-ai-service").PROVIDER_PRESETS;
    } catch (_e) {
      return; // mobile module not available
    }

    new Setting(containerEl)
      .setName(t("settings.mobileCapture.heading", "移动端快速捕获"))
      .setHeading();
    containerEl.createEl("p", {
      text: t("settings.mobileCapture.intro", "在桌面端预先配置移动端捕获设置。同步到移动端后即可使用。"),
      cls: "setting-item-description",
    });

    const mc = this.plugin.settings.mobileCapture;
    const locale = typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "en";
    mc.linkResolver = normalizeLinkResolver(mc.linkResolver);
    const lr = mc.linkResolver;
    const resolverProvider = getResolverProviderPreset(lr.provider);

    new Setting(containerEl)
      .setName(t("mobile.settings.providerName", "AI 提供商"))
      .setDesc(t("mobile.settings.providerDesc", "选择预设提供商或自定义。"))
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

    new Setting(containerEl)
      .setName(t("mobile.settings.apiKeyName", "API Key"))
      .setDesc(t("mobile.settings.apiKeyDesc", "留空则跳过 AI 清理，直接记录原文。"))
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(mc.apiKey)
          .onChange(async (v) => {
            mc.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    const preset = PROVIDER_PRESETS[mc.provider] || PROVIDER_PRESETS.deepseek;

    new Setting(containerEl)
      .setName(t("mobile.settings.baseUrlName", "Base URL（可选）"))
      .setDesc(t("mobile.settings.baseUrlDesc", "留空使用预设: {value}", { value: preset.baseUrl || "(无)" }))
      .addText((text) => {
        text
          .setPlaceholder(preset.baseUrl || "https://api.example.com")
          .setValue(mc.baseUrl)
          .onChange(async (v) => {
            mc.baseUrl = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.modelName", "模型名（可选）"))
      .setDesc(t("mobile.settings.modelDesc", "留空使用预设: {value}", { value: preset.defaultModel || "(无)" }))
      .addText((text) => {
        text
          .setPlaceholder(preset.defaultModel || "")
          .setValue(mc.model)
          .onChange(async (v) => {
            mc.model = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.aiCleanupName", "启用 AI 清理"))
      .setDesc(t("mobile.settings.aiCleanupDesc", "开启后自动去除语气词。"))
      .addToggle((toggle) => {
        toggle.setValue(mc.enableAiCleanup).onChange(async (v) => {
          mc.enableAiCleanup = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.urlSummaryName", "启用链接摘要"))
      .setDesc(t(
        "mobile.settings.urlSummaryDesc",
        "优先走国内解析服务（天聚/万维易源/咕咕数据），失败后自动回退 AI，再回退纯文本。",
      ))
      .addToggle((toggle) => {
        toggle.setValue(mc.enableUrlSummary !== false).onChange(async (v) => {
          mc.enableUrlSummary = v;
          lr.enabled = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.resolverSwitchName", "解析服务总开关"))
      .setDesc(t("mobile.settings.resolverSwitchDesc", "关闭后不请求任何链接解析服务。"))
      .addToggle((toggle) => {
        toggle.setValue(lr.enabled).onChange(async (v) => {
          lr.enabled = v;
          mc.enableUrlSummary = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.resolverProviderName", "链接解析服务商"))
      .setDesc(t("mobile.settings.resolverProviderDesc", "三选一配置即可，插件只会使用当前选中的服务商。"))
      .addDropdown((d) => {
        for (const id of Object.keys(LINK_RESOLVER_PROVIDER_PRESETS)) {
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
      .setName(t(
        `settings.mobileCapture.resolverProvider.${resolverProvider.id}.keyLabel`,
        resolverProvider.keyLabel,
      ))
      .setDesc(t(
        `settings.mobileCapture.resolverHint.${resolverProvider.id}`,
        resolverProvider.hint,
      ))
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(resolverProvider.keyPlaceholder)
          .setValue(getResolverProviderKey(lr, resolverProvider.id))
          .onChange(async (v) => {
            setResolverProviderKey(lr, resolverProvider.id, v);
            await this.plugin.saveSettings();
          });
      });
    {
      const descFrag = document.createDocumentFragment();
      descFrag.appendText(t("mobile.settings.resolverEntryPrefix", "配置入口："));
      const keyLink = descFrag.createEl("a", { text: t("mobile.settings.resolverBuyKey", "申请/购买 Key"), href: resolverProvider.keyUrl });
      keyLink.setAttr("target", "_blank");
      descFrag.appendText(" · ");
      const docLink = descFrag.createEl("a", { text: t("mobile.settings.resolverDocs", "接口文档"), href: resolverProvider.docsUrl });
      docLink.setAttr("target", "_blank");
      descFrag.appendText(t(
        "mobile.settings.resolverEntrySuffix",
        "。若目标网页反爬或动态加载失败，将自动降级到 AI，再降级到原文保留。",
      ));
      resolverKeySetting.setDesc(descFrag);
    }

    new Setting(containerEl)
      .setName(t("mobile.settings.timeoutName", "解析超时(ms)"))
      .setDesc(t("mobile.settings.timeoutDesc", "单次解析请求超时，默认 25000。"))
      .addText((text) => {
        text
          .setPlaceholder("25000")
          .setValue(String(lr.timeoutMs))
          .onChange(async (v) => {
            lr.timeoutMs = Math.max(5000, Number(v) || LINK_RESOLVER_DEFAULTS.timeoutMs);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.retriesName", "失败重试次数"))
      .setDesc(t("mobile.settings.retriesDesc", "单服务重试次数，默认 2。"))
      .addText((text) => {
        text
          .setPlaceholder("2")
          .setValue(String(lr.retries))
          .onChange(async (v) => {
            lr.retries = Math.min(5, Math.max(0, Number(v) || LINK_RESOLVER_DEFAULTS.retries));
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.concurrencyName", "最大并发"))
      .setDesc(t("mobile.settings.concurrencyDesc", "并发解析 URL 上限，默认 2。"))
      .addText((text) => {
        text
          .setPlaceholder("2")
          .setValue(String(lr.maxConcurrency))
          .onChange(async (v) => {
            lr.maxConcurrency = Math.min(5, Math.max(1, Number(v) || LINK_RESOLVER_DEFAULTS.maxConcurrency));
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.dailyPathName", "每日笔记路径"))
      .addText((text) => {
        text
          .setPlaceholder(locale === "zh-CN" ? "01-捕获层/每日笔记" : "01-Capture/Daily Notes")
          .setValue(mc.dailyNotePath)
          .onChange(async (v) => {
            mc.dailyNotePath = v.trim() || (locale === "zh-CN" ? "01-捕获层/每日笔记" : "01-Capture/Daily Notes");
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.headerName", "记录区标题"))
      .addText((text) => {
        text
          .setPlaceholder(locale === "zh-CN" ? "## 记录" : "## Records")
          .setValue(mc.ideaSectionHeader)
          .onChange(async (v) => {
            mc.ideaSectionHeader = v.trim() || (locale === "zh-CN" ? "## 记录" : "## Records");
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.testName", "测试 AI 连接"))
      .addButton((b) => {
        b.setButtonText(t("mobile.settings.testBtn", "测试")).onClick(async () => {
          if (!mc.apiKey) {
            new Notice(t("notices.needApiKeyFirst", "请先填写 API Key"));
            return;
          }
          b.setDisabled(true);
          b.setButtonText(t("mobile.settings.testBusy", "测试中..."));
          try {
            const { testConnection } = require("../mobile/mobile-ai-service");
            const locale = typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "zh-CN";
            const result = await testConnection(mc, { locale });
            new Notice(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
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

const basicSettingsSectionMethods = {};
for (const key of Object.getOwnPropertyNames(BasicSettingsSectionMethods.prototype)) {
  if (key === "constructor") continue;
  basicSettingsSectionMethods[key] = BasicSettingsSectionMethods.prototype[key];
}

module.exports = { basicSettingsSectionMethods };
