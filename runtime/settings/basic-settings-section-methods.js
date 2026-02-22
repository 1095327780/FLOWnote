const { Setting, Notice, Platform = {} } = require("obsidian");
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
    hint: "适合基础网页正文抓取；动态页面或强反爬页面可能失败。",
  },
  showapi: {
    id: "showapi",
    name: "ShowAPI（万维易源）",
    keyLabel: "ShowAPI AppKey",
    keyPlaceholder: "showapi appKey",
    keyUrl: "https://www.showapi.com/apiGateway/view/3262/1",
    docsUrl: "https://www.showapi.com/apiGateway/view/3262/1",
    hint: "按调用计费，部分套餐有免费额度；适合作为低门槛选项。",
  },
  gugudata: {
    id: "gugudata",
    name: "咕咕数据",
    keyLabel: "咕咕数据 AppKey",
    keyPlaceholder: "gugudata appkey",
    keyUrl: "https://www.gugudata.com/api/details/url2markdown",
    docsUrl: "https://www.gugudata.com/api/details/url2markdown",
    hint: "输出 Markdown 质量较稳定；官方建议控制请求频率。",
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

class BasicSettingsSectionMethods {
  display() {
    const { containerEl } = this;
    containerEl.empty();
    if (typeof this.setHeading === "function") this.setHeading();
    containerEl.createEl("p", {
      text: "常用情况下只需要确认连接状态和 Provider 登录。其余高级项一般保持默认即可。",
    });

    const isWindows = isWindowsUiPlatform();
    const launchStrategyValue = String(this.plugin.settings.launchStrategy || "auto");
    const launchStrategyForUi = !isWindows && launchStrategyValue === "wsl" ? "auto" : launchStrategyValue;
    new Setting(containerEl)
      .setName("FLOWnote CLI 路径（可选）")
      .setDesc("通常留空。插件会自动探测。Windows 本机请优先填写 opencode.exe 或 cli.js（不要填 opencode.cmd）；Windows + WSL 可填 wsl、wsl.exe 或 wsl:发行版名（例如 wsl:Ubuntu）。")
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
      .setName("连接启动方式")
      .setDesc(
        isWindows
          ? "自动（推荐）：按系统自动检测并记忆成功方式。手动模式下按你选择的安装方式连接。"
          : "自动（推荐）：优先使用上次成功方式；失败时自动回退到其他方式。",
      )
      .addDropdown((d) => {
        d.addOption("auto", "自动（推荐）");
        if (isWindows) {
          d.addOption("native", "Windows 本机安装")
            .addOption("wsl", "Windows WSL 安装");
        } else {
          d.addOption("native", "Mac 本机安装");
        }
        d.setValue(launchStrategyForUi).onChange(async (v) => {
          this.plugin.settings.launchStrategy = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (isWindows && this.plugin.settings.launchStrategy !== "native") {
      new Setting(containerEl)
        .setName("WSL 发行版（可选）")
        .setDesc("留空表示 WSL 默认发行版。可填 Ubuntu / Debian 等。填写后自动模式会优先尝试 WSL。")
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
      .setName("技能注入方式")
      .setDesc("当你使用 /skill 指令时，插件如何把技能内容传给模型。")
      .addDropdown((d) => {
        d.addOption("summary", "摘要注入（推荐）")
          .addOption("full", "全文注入（更完整但更重）")
          .addOption("off", "关闭注入（只发送用户输入）")
          .setValue(this.plugin.settings.skillInjectMode)
          .onChange(async (v) => {
            this.plugin.settings.skillInjectMode = v;
            await this.plugin.saveSettings();
          });
      });

    this.renderProviderAuthSection(containerEl);

    new Setting(containerEl)
      .setName("高级设置")
      .setHeading();

    new Setting(containerEl)
      .setName("实验功能：启用 SDK 传输")
      .setDesc("默认关闭。生产建议使用 compat 传输；仅在调试场景中开启 SDK。")
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
        .setName("实验传输模式")
        .setDesc("兼容模式为稳定路径；SDK 模式仅用于实验排障。")
        .addDropdown((dropdown) => {
          dropdown
            .addOption("compat", "compat（稳定）")
            .addOption("sdk", "sdk（实验）")
            .setValue(String(this.plugin.settings.transportMode || "compat"))
            .onChange(async (value) => {
              this.plugin.settings.transportMode = value === "sdk" ? "sdk" : "compat";
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName("内置 Skills 安装目录")
      .setDesc("默认 .opencode/skills。插件会自动安装内置 skills，并忽略目录中的非内置 skills。通常无需修改。")
      .addText((text) => {
        text.setValue(this.plugin.settings.skillsDir).onChange(async (v) => {
          this.plugin.settings.skillsDir = v.trim() || ".opencode/skills";
          await this.plugin.saveSettings();
          await this.plugin.reloadSkills();
        });
      });

    new Setting(containerEl)
      .setName("重新安装内置 Skills")
      .setDesc("手动覆盖安装一次内置 skills，用于修复技能缺失或文件损坏。")
      .addButton((b) => {
        b.setButtonText("立即重装").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("重装中...");
          try {
            const syncResult = await this.plugin.reloadSkills();
            if (syncResult && !syncResult.errors.length) {
              new Notice(`重装完成：${syncResult.synced}/${syncResult.total} 个技能，目录 ${syncResult.targetRoot}`);
            } else {
              const msg = syncResult && syncResult.errors.length
                ? syncResult.errors[0]
                : "未知错误";
              new Notice(`重装失败：${msg}`);
            }
          } catch (e) {
            new Notice(`重装失败: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText("立即重装");
          }
        });
      });

    new Setting(containerEl)
      .setName("连接诊断")
      .setDesc("检测 FLOWnote 可执行文件与连接状态。")
      .addButton((b) => {
        b.setButtonText("运行诊断").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("测试中...");
          try {
            const r = await this.plugin.diagnosticsService.run();
            if (r.connection.ok) new Notice(`连接正常 (${r.connection.mode})`);
            else new Notice(`连接失败: ${r.connection.error}`);
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          } finally {
            b.setDisabled(false);
            b.setButtonText("运行诊断");
          }
        });
      });

    if (this.plugin.settings.launchStrategy === "auto") {
      const remembered = typeof this.plugin.getPreferredLaunchProfile === "function"
        ? this.plugin.getPreferredLaunchProfile()
        : null;
      const rememberedText = remembered
        ? remembered.mode === "wsl"
          ? `已记忆：WSL${remembered.distro ? ` (${remembered.distro})` : ""}`
          : `已记忆：本机 ${remembered.command || "opencode"}`
        : "当前未记忆成功连接方式。";

      new Setting(containerEl)
        .setName("自动连接记忆")
        .setDesc(`${rememberedText} 成功连接后会自动更新。`)
        .addButton((b) => {
          b.setButtonText("重置记忆").onClick(async () => {
            b.setDisabled(true);
            try {
              if (typeof this.plugin.clearRememberedLaunchProfile === "function") {
                await this.plugin.clearRememberedLaunchProfile();
              }
              new Notice("已清除记忆的连接方式。");
              this.display();
            } catch (e) {
              new Notice(`重置失败: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              b.setDisabled(false);
            }
          });
        });
    }

    // --- Mobile Capture Settings (visible on all platforms for pre-configuration) ---
    this.renderMobileCaptureSection(containerEl);
  }

  renderMobileCaptureSection(containerEl) {
    let PROVIDER_PRESETS;
    try {
      PROVIDER_PRESETS = require("../mobile/mobile-ai-service").PROVIDER_PRESETS;
    } catch (_e) {
      return; // mobile module not available
    }

    new Setting(containerEl)
      .setName("移动端快速捕获")
      .setHeading();
    containerEl.createEl("p", {
      text: "在桌面端预先配置移动端捕获设置。同步到移动端后即可使用。",
      cls: "setting-item-description",
    });

    const mc = this.plugin.settings.mobileCapture;
    mc.linkResolver = normalizeLinkResolver(mc.linkResolver);
    const lr = mc.linkResolver;
    const resolverProvider = getResolverProviderPreset(lr.provider);

    new Setting(containerEl)
      .setName("AI 提供商")
      .setDesc("选择预设提供商或自定义。")
      .addDropdown((d) => {
        for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
          d.addOption(id, preset.name);
        }
        d.setValue(mc.provider).onChange(async (v) => {
          mc.provider = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("留空则跳过 AI 清理，直接记录原文。")
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
      .setName("Base URL（可选）")
      .setDesc(`留空使用预设: ${preset.baseUrl || "(无)"}`)
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
      .setName("模型名（可选）")
      .setDesc(`留空使用预设: ${preset.defaultModel || "(无)"}`)
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
      .setName("启用 AI 清理")
      .setDesc("开启后自动去除语气词。")
      .addToggle((toggle) => {
        toggle.setValue(mc.enableAiCleanup).onChange(async (v) => {
          mc.enableAiCleanup = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("启用链接摘要")
      .setDesc("优先走国内解析服务（天聚/万维易源/咕咕数据），失败后自动回退 AI，再回退纯文本。")
      .addToggle((toggle) => {
        toggle.setValue(mc.enableUrlSummary !== false).onChange(async (v) => {
          mc.enableUrlSummary = v;
          lr.enabled = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("解析服务总开关")
      .setDesc("关闭后不请求任何链接解析服务。")
      .addToggle((toggle) => {
        toggle.setValue(lr.enabled).onChange(async (v) => {
          lr.enabled = v;
          mc.enableUrlSummary = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("链接解析服务商")
      .setDesc("三选一配置即可，插件只会使用当前选中的服务商。")
      .addDropdown((d) => {
        for (const id of Object.keys(LINK_RESOLVER_PROVIDER_PRESETS)) {
          const provider = getResolverProviderPreset(id);
          d.addOption(id, provider.name);
        }
        d.setValue(resolverProvider.id).onChange(async (v) => {
          lr.provider = normalizeResolverProviderId(v);
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const resolverKeySetting = new Setting(containerEl)
      .setName(resolverProvider.keyLabel)
      .setDesc(resolverProvider.hint)
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
      descFrag.appendText("配置入口：");
      const keyLink = descFrag.createEl("a", { text: "申请/购买 Key", href: resolverProvider.keyUrl });
      keyLink.setAttr("target", "_blank");
      descFrag.appendText(" · ");
      const docLink = descFrag.createEl("a", { text: "接口文档", href: resolverProvider.docsUrl });
      docLink.setAttr("target", "_blank");
      descFrag.appendText("。若目标网页反爬或动态加载失败，将自动降级到 AI，再降级到原文保留。");
      resolverKeySetting.setDesc(descFrag);
    }

    new Setting(containerEl)
      .setName("解析超时(ms)")
      .setDesc("单次解析请求超时，默认 25000。")
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
      .setName("失败重试次数")
      .setDesc("单服务重试次数，默认 2。")
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
      .setName("最大并发")
      .setDesc("并发解析 URL 上限，默认 2。")
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
      .setName("每日笔记路径")
      .addText((text) => {
        text
          .setPlaceholder("01-捕获层/每日笔记")
          .setValue(mc.dailyNotePath)
          .onChange(async (v) => {
            mc.dailyNotePath = v.trim() || "01-捕获层/每日笔记";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("想法区域标题")
      .addText((text) => {
        text
          .setPlaceholder("### 💡 想法和灵感")
          .setValue(mc.ideaSectionHeader)
          .onChange(async (v) => {
            mc.ideaSectionHeader = v.trim() || "### 💡 想法和灵感";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("测试 AI 连接")
      .addButton((b) => {
        b.setButtonText("测试").onClick(async () => {
          if (!mc.apiKey) {
            new Notice("请先填写 API Key");
            return;
          }
          b.setDisabled(true);
          b.setButtonText("测试中...");
          try {
            const { testConnection } = require("../mobile/mobile-ai-service");
            const result = await testConnection(mc);
            new Notice(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
          } catch (e) {
            new Notice(`❌ ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText("测试");
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
