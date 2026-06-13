const { Setting, Notice, Platform = {} } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { UI_LANGUAGE_OPTIONS, normalizeSupportedLocale } = require("../i18n-locale-utils");
const { bindDropdownChange } = require("./component-value-utils");
const {
  LINK_RESOLVER_DEFAULTS,
  getDefaultDailyNotePath,
  getDefaultNotePaths,
  migrateSettingsLocaleDefaults,
  normalizeLinkResolver,
  normalizeResolverProviderId,
} = require("../settings-utils");
const {
  planNotePathLocaleMigration,
  planMetaPathLocaleMigration,
  applyNotePathLocaleMigration,
  applyMetaPathLocaleMigration,
  mergeMigrationResults,
  summarizeNotePathMigrationResult,
} = require("../note-path-locale-migration");
const { buildShortcutUrls } = require("../mobile/shortcut-url-utils");

const FLOWNOTE_QUICK_CAPTURE_SHORTCUT_URL = "https://www.icloud.com/shortcuts/12b0291f16ff46cfa0280e18b0859118";

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

async function copyShortcutText(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_e) {
    // Fall back to a best-effort legacy copy path below.
  }
  try {
    if (typeof document === "undefined") return false;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch (_e) {
    return false;
  }
}

class BasicSettingsSectionMethods {
  display() {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const { containerEl } = this;
    containerEl.empty();
    if (typeof this.setHeading === "function") this.setHeading();
    containerEl.addClass("oc-settings-root");

    // Detect current mode so we can show only the relevant config.
    const agent = (this.plugin.settings && this.plugin.settings.agentProvider) || {};
    const mode = agent.mode === "opencode-legacy" ? "opencode-legacy" : "direct";

    // ===== CORE GROUPS (always visible) =====

    // --- Group: 界面语言 ---
    this.renderSettingsGroup(containerEl, {
      heading: t("settings.language.name", "界面语言"),
      render: (group) => {
        new Setting(group)
          .setName(t("settings.language.name", "界面语言"))
          .setDesc(t("settings.language.desc",
            "默认跟随设备语言。切换后界面即时刷新；命令名与 Ribbon 提示重载后生效。"))
          .addDropdown((dropdown) => {
            for (const option of UI_LANGUAGE_OPTIONS) {
              const key = option === "zh-CN"
                ? "optionZhCN"
                : option === "en"
                  ? "optionEn"
                  : option === "ru"
                    ? "optionRu"
                    : "optionAuto";
              const fallback = option === "zh-CN"
                ? "简体中文"
                : option === "en"
                  ? "English"
                  : option === "ru"
                    ? "Русский"
                    : "跟随系统（推荐）";
              dropdown.addOption(option, t(`settings.language.${key}`, fallback));
            }
            dropdown.setValue(String(this.plugin.settings.uiLanguage || "auto"));
            bindDropdownChange(dropdown, async (selectedLanguage) => {
                const previousLocale = normalizeSupportedLocale(
                  typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "en",
                  "en",
                );
                this.plugin.settings.uiLanguage = String(selectedLanguage || "auto");
                const nextLocale = normalizeSupportedLocale(
                  typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "en",
                  "en",
                );
                migrateSettingsLocaleDefaults(this.plugin.settings, previousLocale, nextLocale);
                await this.plugin.saveSettings();
                if (typeof this.plugin.refreshLocaleUi === "function") this.plugin.refreshLocaleUi();
                this.display();
                new Notice(t(
                  "notices.languageAppliedReloadTip",
                  "界面语言已更新。命令名和 Ribbon 提示将在重载插件后生效。",
                ));
                if (previousLocale === nextLocale) return;
                const explicitLocale = selectedLanguage === "zh-CN" || selectedLanguage === "en";
                if (!explicitLocale) return;
                const languageLabel = nextLocale === "zh-CN"
                  ? t("settings.language.optionZhCN", "简体中文")
                  : nextLocale === "ru"
                    ? t("settings.language.optionRu", "Русский")
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
                if (typeof this.promptAndRunNotePathLocaleMigration === "function") {
                  await this.promptAndRunNotePathLocaleMigration(previousLocale, nextLocale, t);
                }
              });
          });
      },
    });

    this.renderShortcutSection(containerEl, t);

    // --- Group: AI 服务（运行方式 + provider 配置 + opencode provider auth） ---
    // The renderAgentProviderSection already builds its own internal
    // header + content. We wrap it inside a styled group container so it
    // visually matches the rest, but skip our own group-heading because
    // the section renders its own.
    this.renderSettingsGroup(containerEl, {
      heading: t("settings.agent.heading", "AI 服务"),
      intro: t("settings.agent.intro",
        "选择运行方式与服务商。新用户默认使用内置 AI；从旧版本升级会保留 OpenCode 桥接，避免原有工作流中断。"),
      suppressInnerHeading: true,
      render: (group) => {
        if (typeof this.renderAgentProviderSection === "function") {
          // Pass the group as containerEl. The section method internally
          // already builds setName / addDropdown etc, which will inherit
          // our group CSS.
          this.renderAgentProviderSection(group);
        }
        // OpenCode-only provider auth (login per provider) — only show
        // when the user has actually chosen the legacy bridge.
        if (mode === "opencode-legacy" && !Platform.isMobile
          && typeof this.renderProviderAuthSection === "function") {
          this.renderProviderAuthSection(group);
        }
      },
    });

    // --- Collapsible: AI 高级（可选） — only in direct mode ---
    if (mode === "direct" && typeof this.renderAgentProviderAdvanced === "function") {
      this.renderCollapsibleGroup(containerEl, {
        heading: t("settings.agent.advancedHeading", "AI 高级（可选）"),
        openByDefault: false,
        render: (group) => { this.renderAgentProviderAdvanced(group); },
      });
    }

    // --- Collapsible: 笔记位置 ---
    this.renderCollapsibleGroup(containerEl, {
      heading: t("settings.notePaths.heading", "笔记位置"),
      openByDefault: false,
      render: (group) => { this.renderNotePathsSection(group, t); },
    });

    // --- Collapsible: 技能管理 ---
    if (typeof this.renderSkillManagementSection === "function") {
      this.renderCollapsibleGroup(containerEl, {
        heading: t("settings.skills.heading", "技能管理"),
        openByDefault: false,
        render: (group) => { this.renderSkillManagementSection(group); },
      });
    }

    // --- Collapsible: 模板管理 ---
    if (typeof this.renderTemplateManagementSection === "function") {
      this.renderCollapsibleGroup(containerEl, {
        heading: t("settings.templates.heading", "模板管理"),
        openByDefault: false,
        render: (group) => { this.renderTemplateManagementSection(group); },
      });
    }

    // --- Collapsible: 移动端快速捕获 ---
    if (typeof this.renderMobileCaptureSection === "function") {
      this.renderCollapsibleGroup(containerEl, {
        heading: t("settings.mobileCapture.heading", "移动端快速捕获"),
        openByDefault: false,
        render: (group) => { this.renderMobileCaptureSection(group); },
      });
    }

    // ===== COLLAPSIBLE SECTIONS (advanced, default closed) =====

    // --- Collapsible: OpenCode 桥接配置 (only in legacy mode) ---
    if (mode === "opencode-legacy" && !Platform.isMobile) {
      this.renderCollapsibleGroup(containerEl, {
        heading: t("settings.opencode.heading", "OpenCode 桥接配置"),
        intro: t("settings.opencode.intro",
          "选择「OpenCode 桥接」运行方式才需要配置。CLI 路径留空可让插件自动探测。"),
        openByDefault: false,
        render: (group) => {
          const isWindows = isWindowsUiPlatform();
          const launchStrategyValue = String(this.plugin.settings.launchStrategy || "auto");
          const launchStrategyForUi = launchStrategyValue === "native" ? "native" : "auto";

          new Setting(group)
            .setName(t("settings.basic.cliPathName", "FLOWnote CLI 路径（可选）"))
            .setDesc(t("settings.basic.cliPathDesc",
              "通常留空。插件会自动探测。Windows 请先安装 Node.js，再 npm install -g opencode-ai。"))
            .addText((text) => {
              text.setPlaceholder("/Users/xxx/.opencode/bin/opencode")
                .setValue(this.plugin.settings.cliPath)
                .onChange(async (v) => {
                  this.plugin.settings.cliPath = v.trim();
                  await this.plugin.saveSettings();
                });
            });

          new Setting(group)
            .setName(t("settings.basic.launchStrategyName", "连接启动方式"))
            .setDesc(isWindows
              ? t("settings.basic.launchStrategyDescWindows",
                "自动（推荐）：自动检测并记忆成功的本机连接方式。")
              : t("settings.basic.launchStrategyDesc",
                "自动（推荐）：优先使用上次成功方式；失败时自动回退。"))
            .addDropdown((d) => {
              d.addOption("auto", t("settings.basic.launchAuto", "自动（推荐）"));
              if (isWindows) {
                d.addOption("native", t("settings.basic.launchNativeWindows", "Windows 本机安装"));
              } else {
                d.addOption("native", t("settings.basic.launchNativeMac", "Mac 本机安装"));
              }
              d.setValue(launchStrategyForUi);
              bindDropdownChange(d, async (launchStrategy) => {
                this.plugin.settings.launchStrategy = launchStrategy;
                await this.plugin.saveSettings();
                this.display();
              });
            });

          new Setting(group)
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
              ? this.plugin.getPreferredLaunchProfile() : null;
            const rememberedText = remembered
              ? t("settings.basic.autoMemoryRememberedNative", "已记忆：本机 {command}",
                { command: remembered.command || "opencode" })
              : t("settings.basic.autoMemoryNone", "当前未记忆成功连接方式。");
            new Setting(group)
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
                    new Notice(t("settings.basic.autoMemoryResetFailed", "重置失败: {message}",
                      { message: e instanceof Error ? e.message : String(e) }));
                  } finally {
                    b.setDisabled(false);
                  }
                });
              });
          }
        },
      });
    }

    // --- Collapsible: 高级设置 (default closed) ---
    this.renderCollapsibleGroup(containerEl, {
      heading: t("settings.basic.advancedHeading", "高级设置"),
      intro: t("settings.basic.advancedIntro",
        "高级选项。一般保持默认即可——除非你需要重装内置内容、改 skills 路径，或排查问题。"),
      openByDefault: false,
      render: (group) => {
        if (!Platform.isMobile) {
          new Setting(group)
            .setName(t("settings.basic.sendWithEnterName", "Enter 发送消息"))
            .setDesc(t("settings.basic.sendWithEnterDesc", "开启后按 Enter 直接发送，Shift+Enter 换行。"))
            .addToggle((toggle) => {
              toggle.setValue(Boolean(this.plugin.settings.sendWithEnter)).onChange(async (v) => {
                this.plugin.settings.sendWithEnter = v;
                await this.plugin.saveSettings();
              });
            });

          new Setting(group)
            .setName(t("settings.basic.skillsDirName", "内置 Skills 安装目录"))
            .setDesc(t("settings.basic.skillsDirDesc",
              "默认 .flownote/skills。插件会自动安装/更新内置 skills。"))
            .addText((text) => {
              text.setValue(this.plugin.settings.skillsDir).onChange(async (v) => {
                this.plugin.settings.skillsDir = v.trim() || ".flownote/skills";
                await this.plugin.saveSettings();
                if (typeof this.plugin.reloadSkills === "function") await this.plugin.reloadSkills();
                this.plugin.__flownoteSkillCache = null;
              });
            });

          new Setting(group)
            .setName(t("settings.basic.reinstallSkillsName", "重新安装内置 Skills 与模板"))
            .setDesc(t("settings.basic.reinstallSkillsDesc",
              "按当前界面语言安装/更新内置 skills，并同步模板。"))
            .addButton((b) => {
              b.setButtonText(t("settings.basic.reinstallSkillsNow", "立即重装")).onClick(async () => {
                await this.reinstallBundledContentWithPrompt(b, {
                  replaceAll: true, skipConflictPrompt: true,
                });
              });
            });

          new Setting(group)
            .setName(t("settings.basic.resetTemplateBaselineName", "重置模板基线"))
            .setDesc(t("settings.basic.resetTemplateBaselineDesc",
              "仅当你需要恢复默认模板时使用。"))
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
                    new Notice(t("settings.basic.resetTemplateBaselineCanceled",
                      "已取消模板重置。已处理 {synced}/{total}。", resetResult));
                  } else if (!resetResult.errors.length) {
                    new Notice(t("settings.basic.resetTemplateBaselineSuccess",
                      "模板重置完成：{synced}/{total}", resetResult));
                  } else {
                    new Notice(t("settings.basic.resetTemplateBaselineFailed",
                      "模板重置失败：{message}", { message: resetResult.errors[0] }));
                  }
                } catch (e) {
                  new Notice(t("settings.basic.resetTemplateBaselineFailed",
                    "模板重置失败：{message}",
                    { message: e instanceof Error ? e.message : String(e) }));
                } finally {
                  b.setDisabled(false);
                  b.setButtonText(t("settings.basic.resetTemplateBaselineNow", "重置模板"));
                }
              });
            });
        }
      },
    });
  }

  /**
   * Render a styled group of settings: bold h3 heading + ONE bordered
   * container holding setting-items separated by horizontal dividers.
   * Per-setting descriptions live inline via native setDesc(); we no
   * longer emit a framed "intro callout" at the top of each group.
   *
   * @param {HTMLElement} parent
   * @param {{ heading: string, render: (group: HTMLElement) => void }} opts
   */
  renderSettingsGroup(parent, opts) {
    const wrap = parent.createDiv({ cls: "oc-settings-section" });
    const heading = wrap.createDiv({ cls: "oc-settings-section-heading" });
    heading.createEl("h3", { text: String(opts.heading || "") });
    const group = wrap.createDiv({ cls: "oc-settings-group" });
    if (typeof opts.render === "function") opts.render(group);
  }

  /**
   * Same shape as renderSettingsGroup but wrapped in a <details>
   * element so the user can collapse/expand. Default closed.
   */
  renderCollapsibleGroup(parent, opts) {
    const wrap = parent.createEl("details", { cls: "oc-settings-collapsible" });
    const summary = wrap.createEl("summary", { cls: "oc-settings-collapsible-summary" });
    summary.createDiv({ cls: "oc-settings-collapsible-summary-text", text: String(opts.heading || "") });
    const group = wrap.createDiv({ cls: "oc-settings-group" });

    let rendered = false;
    const renderOnce = () => {
      if (rendered || typeof opts.render !== "function") return;
      rendered = true;
      try {
        const result = opts.render(group);
        if (result && typeof result.catch === "function") {
          result.catch((e) => {
            if (this.plugin && typeof this.plugin.log === "function") {
              this.plugin.log(`settings collapsible render failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          });
        }
      } catch (e) {
        if (this.plugin && typeof this.plugin.log === "function") {
          this.plugin.log(`settings collapsible render failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };

    if (opts.openByDefault) {
      wrap.open = true;
      renderOnce();
    } else {
      wrap.open = false;
      wrap.addEventListener("toggle", () => {
        if (wrap.open) renderOnce();
      });
    }
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
    const mc = this.plugin.settings.mobileCapture;
    const locale = typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : "en";
    mc.linkResolver = normalizeLinkResolver(mc.linkResolver);
    const lr = mc.linkResolver;
    const resolverProvider = getResolverProviderPreset(lr.provider);

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
        d.setValue(resolverProvider.id);
        bindDropdownChange(d, async (providerId) => {
          lr.provider = normalizeResolverProviderId(providerId);
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
        const defaultDailyPath = getDefaultDailyNotePath(locale);
        text
          .setPlaceholder(defaultDailyPath)
          .setValue(mc.dailyNotePath)
          .onChange(async (v) => {
            mc.dailyNotePath = v.trim() || defaultDailyPath;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("mobile.settings.headerName", "记录区标题"))
      .addText((text) => {
        text
          .setPlaceholder(locale === "zh-CN" ? "## 记录" : locale === "ru" ? "## Записи" : "## Records")
          .setValue(mc.ideaSectionHeader)
          .onChange(async (v) => {
            mc.ideaSectionHeader = v.trim() || (locale === "zh-CN" ? "## 记录" : locale === "ru" ? "## Записи" : "## Records");
            await this.plugin.saveSettings();
          });
      });

  }

  renderShortcutSection(containerEl, t) {
    const vaultName = buildShortcutUrls(this.plugin).vaultName || "";
    this.renderSettingsGroup(containerEl, {
      heading: t("mobile.shortcuts.heading", "快捷指令"),
      render: (group) => {
        new Setting(group)
          .setName(t("mobile.shortcuts.installName", "安装 FLOWnote 快速捕获"))
          .setDesc(t(
            "mobile.shortcuts.installDesc",
            "打开共享快捷指令后点「添加快捷指令」，保存到本机即可。",
          ))
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
          .setDesc(t(
            "mobile.shortcuts.vaultNameDesc",
            "在快捷指令顶部「文本」一栏填入这个名称，用来生成 obsidian:// 链接。",
          ))
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
      },
    });
  }

  async promptAndRunNotePathLocaleMigration(previousLocale, nextLocale, t) {
    if (typeof this.showConfirmModal !== "function") return null;
    const notePlan = planNotePathLocaleMigration(this.plugin.settings || {}, previousLocale, nextLocale);
    const metaPlan = planMetaPathLocaleMigration(this.plugin.settings, previousLocale, nextLocale);
    const allItems = [
      ...(Array.isArray(notePlan && notePlan.items) ? notePlan.items.map((item) => ({ ...item, kind: "note" })) : []),
      ...(Array.isArray(metaPlan && metaPlan.items) ? metaPlan.items : []),
    ];
    if (!allItems.length) {
      if (notePlan && notePlan.skippedCustomPath && notePlan.skippedCustomPath.length) {
        new Notice(t(
          "settings.language.migrationNoDefaultPaths",
          "语言已切换，但没有可自动迁移的默认目录；你自定义过的笔记位置已保持不变。",
        ));
      }
      return null;
    }

    const targetLanguage = nextLocale === "zh-CN"
      ? t("settings.language.optionZhCN", "简体中文")
      : t("settings.language.optionEn", "English");
    const firstConfirm = await this.showConfirmModal({
      title: t("settings.language.migrationPromptTitle", "是否迁移笔记目录？"),
      description: t(
        "settings.language.migrationPromptDesc",
        "FLOWnote 可以把仍使用默认名称的笔记目录和 Meta 系统目录迁移为 {language} 目录。自定义路径不会处理；已存在的目标目录不会覆盖或合并。",
        { language: targetLanguage },
      ),
      submitText: t("settings.language.migrationPromptConfirm", "继续查看"),
      cancelText: t("settings.language.migrationPromptCancel", "不迁移"),
    });
    if (!firstConfirm) return null;

    const preview = allItems
      .slice(0, 8)
      .map((item) => `${item.source} → ${item.target}`)
      .join("\n");
    const more = allItems.length > 8
      ? `\n${t("settings.language.migrationPreviewMore", "还有 {count} 个目录…", { count: allItems.length - 8 })}`
      : "";
    const secondConfirm = await this.showConfirmModal({
      title: t("settings.language.migrationSecondTitle", "二次确认：迁移目录"),
      description: t(
        "settings.language.migrationSecondDesc",
        "即将迁移 {count} 个默认目录到 {language}。\n\n{preview}{more}\n\n不会覆盖已存在目录；迁移失败的项目会保留原路径。确认执行？",
        {
          count: allItems.length,
          language: targetLanguage,
          preview,
          more,
        },
      ),
      submitText: t("settings.language.migrationSecondConfirm", "确认迁移目录"),
      cancelText: t("settings.language.migrationSecondCancel", "取消"),
    });
    if (!secondConfirm) return null;

    const noteResult = await applyNotePathLocaleMigration(this.app, this.plugin.settings, notePlan);
    if (!this.plugin.settings.metaPaths || typeof this.plugin.settings.metaPaths !== "object") {
      this.plugin.settings.metaPaths = {};
    }
    const metaResult = await applyMetaPathLocaleMigration(this.app, this.plugin.settings, metaPlan);
    const result = mergeMigrationResults(noteResult, metaResult);
    this.plugin.__flownoteSkillCache = null;
    await this.plugin.saveSettings();
    const summary = summarizeNotePathMigrationResult(result);
    new Notice(t(
      "settings.language.migrationResult",
      "目录迁移完成：已迁移 {migrated}，源目录不存在 {skippedMissingSource}，目标已存在 {skippedTargetExists}，自定义路径跳过 {skippedCustomPath}，错误 {errors}。",
      summary,
    ));
    this.display();
    return result;
  }

  renderNotePathsSection(containerEl, t) {
    const locale = normalizeSupportedLocale(
      typeof this.plugin.getEffectiveLocale === "function" ? this.plugin.getEffectiveLocale() : this.plugin.settings.uiLanguage,
      "zh-CN",
    );
    const DEFAULT_NOTE_PATHS = getDefaultNotePaths(locale);
    if (!this.plugin.settings.notePaths) {
      this.plugin.settings.notePaths = { ...localeDefaults };
    }
    if (!this.plugin.settings.metaPaths) {
      this.plugin.settings.metaPaths = { ...metaLocaleDefaults };
    }
    const paths = this.plugin.settings.notePaths;
    const metaPaths = this.plugin.settings.metaPaths;

    const fields = [
      ["dailyNotes", "每日笔记"],
      ["weeklyReviews", "周记 / 周回顾"],
      ["monthlyReviews", "月记 / 月报"],
      ["yearlyReviews", "年记 / 年报"],
      ["permanentNotes", "永久笔记"],
      ["topicNotes", "主题笔记（📍）"],
      ["literatureNotes", "文献笔记（《》）"],
      ["domainPages", "领域页所在层（🌱）"],
      ["activeProjects", "进行中项目"],
      ["archive", "归档"],
    ];

    for (const [key, fallbackLabel] of fields) {
      const defaultValue = DEFAULT_NOTE_PATHS[key];
      new Setting(containerEl)
        .setName(t(`settings.notePaths.${key}`, fallbackLabel))
        .setDesc(t(
          "settings.notePaths.fieldDesc",
          "默认：{default}",
          { default: defaultValue },
        ))
        .addText((text) => {
          text
            .setPlaceholder(defaultValue)
            .setValue(paths[key] && paths[key] !== defaultValue ? paths[key] : "")
            .onChange(async (raw) => {
              const v = String(raw || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
              const previousPath = String(paths[key] || defaultValue).replace(/\\/g, "/").replace(/\/+$/, "").trim() || defaultValue;
              paths[key] = v || defaultValue;
              if (key === "dailyNotes") {
                const nextPath = paths[key];
                const mc = this.plugin.settings.mobileCapture && typeof this.plugin.settings.mobileCapture === "object"
                  ? this.plugin.settings.mobileCapture
                  : (this.plugin.settings.mobileCapture = {});
                const oldDefault = localeDefaults.dailyNotes;
                const currentMobilePath = String(mc.dailyNotePath || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
                if (!currentMobilePath || currentMobilePath === previousPath || currentMobilePath === oldDefault) {
                  mc.dailyNotePath = nextPath;
                }
              }
              await this.plugin.saveSettings();
              // Invalidate the agent's cached system prompt so the next
              // turn picks up the new path immediately.
              this.plugin.__flownoteSkillCache = null;
            });
        });
    }

    const renderDerivedMetaSummary = () => {
      const existing = containerEl.querySelector(".oc-meta-paths-derived");
      if (existing) existing.remove();
      const latest = deriveMetaPathsFromRoot(metaPaths.metaRoot, metaLocaleDefaults);
      Object.assign(metaPaths, latest);
      const wrap = containerEl.createDiv({ cls: "oc-meta-paths-derived" });
      wrap.createEl("div", {
        cls: "setting-item-description",
        text: t(
          "settings.notePaths.metaDerivedDesc",
          "Meta 内部目录会随根目录自动生成：{paths}",
          {
            paths: metaPreviewKeys
              .map((key) => latest[key])
              .filter(Boolean)
              .join("、"),
          },
        ),
      });
    };

    {
      const defaultValue = metaLocaleDefaults.metaRoot;
      new Setting(containerEl)
        .setName(locale === "en" ? "Meta root" : "Meta 根目录")
        .setDesc(t(
          "settings.notePaths.fieldDesc",
          "默认：{default}",
          { default: defaultValue },
        ))
        .addText((text) => {
          text
            .setPlaceholder(defaultValue)
            .setValue(metaPaths.metaRoot && metaPaths.metaRoot !== defaultValue ? metaPaths.metaRoot : "")
            .onChange(async (raw) => {
              const v = String(raw || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
              Object.assign(metaPaths, deriveMetaPathsFromRoot(v || defaultValue, metaLocaleDefaults));
              await this.plugin.saveSettings();
              this.plugin.__flownoteSkillCache = null;
              renderDerivedMetaSummary();
            });
        });
      renderDerivedMetaSummary();
    }
  }

}

const basicSettingsSectionMethods = {};
for (const key of Object.getOwnPropertyNames(BasicSettingsSectionMethods.prototype)) {
  if (key === "constructor") continue;
  basicSettingsSectionMethods[key] = BasicSettingsSectionMethods.prototype[key];
}

module.exports = { basicSettingsSectionMethods };
