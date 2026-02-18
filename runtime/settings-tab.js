const { PluginSettingTab, Setting, Notice } = require("obsidian");
class OpenCodeSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "OpenCode Assistant 设置" });
    containerEl.createEl("p", {
      text: "常用情况下只需要确认鉴权方式和连接状态。其余高级项一般保持默认即可。",
    });

    new Setting(containerEl)
      .setName("OpenCode CLI 路径（可选）")
      .setDesc("通常留空。插件会自动探测；只有诊断提示“找不到 opencode”时再填写绝对路径。")
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
      .setName("鉴权方式")
      .setDesc("默认使用 OpenCode 本机登录状态。仅在你要改用自有 API Key 时切换为“自定义 API Key”。")
      .addDropdown((d) => {
        d.addOption("opencode-default", "默认（OpenCode 本机登录）")
          .addOption("custom-api-key", "自定义 API Key（高级）")
          .setValue(this.plugin.settings.authMode)
          .onChange(async (v) => {
            this.plugin.settings.authMode = v;
            await this.plugin.saveSettings();
            this.display();
          });
      });

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

    if (this.plugin.settings.authMode === "custom-api-key") {
      new Setting(containerEl)
        .setName("Provider ID")
        .setDesc("例如 openai。需与 OpenCode 中 provider 标识一致。")
        .addText((text) => {
          text.setPlaceholder("openai");
          text.setValue(this.plugin.settings.customProviderId).onChange(async (v) => {
            this.plugin.settings.customProviderId = v.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("API Key")
        .setDesc("仅在本地保存，用于该 Vault 的插件请求。")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setValue(this.plugin.settings.customApiKey).onChange(async (v) => {
            this.plugin.settings.customApiKey = v.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Base URL（可选）")
        .setDesc("只有使用代理网关或自建兼容接口时才需要填写。")
        .addText((text) => {
          text.setPlaceholder("https://api.openai.com/v1");
          text.setValue(this.plugin.settings.customBaseUrl).onChange(async (v) => {
            this.plugin.settings.customBaseUrl = v.trim();
            await this.plugin.saveSettings();
          });
        });
    }

    containerEl.createEl("h3", { text: "高级设置" });

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
      .setDesc("检测 OpenCode 可执行文件与连接状态。")
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
  }
}


module.exports = { OpenCodeSettingsTab };
