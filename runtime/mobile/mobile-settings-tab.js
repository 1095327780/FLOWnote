const { PluginSettingTab, Setting, Notice } = require("obsidian");
const { PROVIDER_PRESETS, testConnection } = require("./mobile-ai-service");

class MobileSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "移动端快速捕获设置" });
    containerEl.createEl("p", {
      text: "配置 AI 服务和日记路径，用于移动端快速捕获想法。",
    });

    const mc = this.plugin.settings.mobileCapture;

    // --- AI Provider ---
    new Setting(containerEl)
      .setName("AI 提供商")
      .setDesc("选择一个预设提供商，或选择自定义填写地址。")
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

    // --- API Key ---
    new Setting(containerEl)
      .setName("API Key")
      .setDesc("对应提供商的 API 密钥。留空则跳过 AI 清理，直接记录原文。")
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
    const effectiveUrl = mc.baseUrl || preset.baseUrl || "(未设置)";
    new Setting(containerEl)
      .setName("Base URL（可选）")
      .setDesc(`留空使用预设地址。当前生效: ${effectiveUrl}`)
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
    const effectiveModel = mc.model || preset.defaultModel || "(未设置)";
    new Setting(containerEl)
      .setName("模型名（可选）")
      .setDesc(`留空使用预设模型。当前生效: ${effectiveModel}`)
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
      .setName("启用 AI 清理")
      .setDesc("开启后自动去除语气词（嗯、啊、那个等）。关闭则直接记录原文。")
      .addToggle((toggle) => {
        toggle.setValue(mc.enableAiCleanup).onChange(async (v) => {
          mc.enableAiCleanup = v;
          await this.plugin.saveSettings();
        });
      });

    // --- Daily Note Path ---
    new Setting(containerEl)
      .setName("每日笔记路径")
      .setDesc("日记文件夹的相对路径（不含文件名）。")
      .addText((text) => {
        text
          .setPlaceholder("01-捕获层/每日笔记")
          .setValue(mc.dailyNotePath)
          .onChange(async (v) => {
            mc.dailyNotePath = v.trim() || "01-捕获层/每日笔记";
            await this.plugin.saveSettings();
          });
      });

    // --- Section Header ---
    new Setting(containerEl)
      .setName("想法区域标题")
      .setDesc("日记中用于存放想法的区域标题。")
      .addText((text) => {
        text
          .setPlaceholder("### 💡 想法和灵感")
          .setValue(mc.ideaSectionHeader)
          .onChange(async (v) => {
            mc.ideaSectionHeader = v.trim() || "### 💡 想法和灵感";
            await this.plugin.saveSettings();
          });
      });

    // --- Test Connection ---
    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("验证 AI 服务是否可用。")
      .addButton((b) => {
        b.setButtonText("测试").onClick(async () => {
          if (!mc.apiKey) {
            new Notice("请先填写 API Key");
            return;
          }
          b.setDisabled(true);
          b.setButtonText("测试中...");
          try {
            const result = await testConnection(mc);
            if (result.ok) {
              new Notice(`✅ ${result.message}`);
            } else {
              new Notice(`❌ ${result.message}`);
            }
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

module.exports = { MobileSettingsTab };
