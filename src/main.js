const { Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const fs = require("fs");
const path = require("path");
const { normalizeSettings } = require("./core/settings/store");
const { OpenCodeClient } = require("./core/opencode/opencode-client");
const { SkillService } = require("./core/skills/skill-service");
const { DiagnosticsService } = require("./features/diagnostics/diagnostics-service");
const { SessionStore } = require("./features/sessions/session-store");
const { VIEW_TYPE, OpenCodeAssistantView } = require("./features/chat/view");

function copyDirectoryRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry || String(entry.name || "").startsWith(".")) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

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
          .onChange(async (value) => {
            this.plugin.settings.cliPath = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("鉴权方式")
      .setDesc("默认使用 OpenCode 本机登录状态。仅在你要改用自有 API Key 时切换为“自定义 API Key”。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("opencode-default", "默认（OpenCode 本机登录）")
          .addOption("custom-api-key", "自定义 API Key（高级）")
          .setValue(this.plugin.settings.authMode)
          .onChange(async (value) => {
            this.plugin.settings.authMode = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("技能注入方式")
      .setDesc("当你使用 /skill 指令时，插件如何把技能内容传给模型。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("summary", "摘要注入（推荐）")
          .addOption("full", "全文注入（更完整但更重）")
          .addOption("off", "关闭注入（只发送用户输入）")
          .setValue(this.plugin.settings.skillInjectMode)
          .onChange(async (value) => {
            this.plugin.settings.skillInjectMode = value;
            await this.plugin.saveSettings();
          });
      });

    if (this.plugin.settings.authMode === "custom-api-key") {
      new Setting(containerEl)
        .setName("Provider ID")
        .setDesc("例如 openai。需与 OpenCode 中 provider 标识一致。")
        .addText((text) => {
          text.setPlaceholder("openai");
          text.setValue(this.plugin.settings.customProviderId).onChange(async (value) => {
            this.plugin.settings.customProviderId = value.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("API Key")
        .setDesc("仅在本地保存，用于该 Vault 的插件请求。")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setValue(this.plugin.settings.customApiKey).onChange(async (value) => {
            this.plugin.settings.customApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Base URL（可选）")
        .setDesc("只有使用代理网关或自建兼容接口时才需要填写。")
        .addText((text) => {
          text.setPlaceholder("https://api.openai.com/v1");
          text.setValue(this.plugin.settings.customBaseUrl).onChange(async (value) => {
            this.plugin.settings.customBaseUrl = value.trim();
            await this.plugin.saveSettings();
          });
        });
    }

    containerEl.createEl("h3", { text: "高级设置" });

    new Setting(containerEl)
      .setName("内置 Skills 安装目录")
      .setDesc("默认 .opencode/skills。插件会自动安装内置 skills，并忽略目录中的非内置 skills。通常无需修改。")
      .addText((text) => {
        text.setValue(this.plugin.settings.skillsDir).onChange(async (value) => {
          this.plugin.settings.skillsDir = value.trim() || ".opencode/skills";
          await this.plugin.saveSettings();
          await this.plugin.reloadSkills();
        });
      });

    new Setting(containerEl)
      .setName("重新安装内置 Skills")
      .setDesc("手动覆盖安装一次内置 skills，用于修复技能缺失或文件损坏。")
      .addButton((button) => {
        button.setButtonText("立即重装").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("重装中...");
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
          } catch (error) {
            new Notice(`重装失败: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            button.setDisabled(false);
            button.setButtonText("立即重装");
          }
        });
      });

    new Setting(containerEl)
      .setName("连接诊断")
      .setDesc("检测 OpenCode 可执行文件与连接状态。")
      .addButton((button) => {
        button.setButtonText("运行诊断").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("测试中...");
          try {
            const result = await this.plugin.diagnosticsService.run();
            if (result.connection.ok) {
              new Notice(`连接正常 (${result.connection.mode})`);
            } else {
              new Notice(`连接失败: ${result.connection.error}`);
            }
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          } finally {
            button.setDisabled(false);
            button.setButtonText("运行诊断");
          }
        });
      });
  }
}

module.exports = class OpenCodeAssistantPlugin extends Plugin {
  async onload() {
    try {
      await this.loadPersistedData();

      this.sessionStore = new SessionStore(this);

      const vaultPath = this.getVaultPath();
      this.skillService = new SkillService(vaultPath, this.settings);
      this.opencodeClient = new OpenCodeClient({
        vaultPath,
        settings: this.settings,
        logger: (line) => this.log(line),
      });
      this.diagnosticsService = new DiagnosticsService(this);

      this.registerView(VIEW_TYPE, (leaf) => new OpenCodeAssistantView(leaf, this));

      this.addRibbonIcon("bot", "OpenCode 助手", () => {
        this.activateView();
      });

      this.addCommand({
        id: "open-opencode-assistant",
        name: "打开 OpenCode 助手",
        callback: () => this.activateView(),
      });

      this.addCommand({
        id: "opencode-send-selected-text",
        name: "发送选中文本到 OpenCode 助手",
        editorCallback: async (editor) => {
          const text = editor.getSelection().trim();
          if (!text) {
            new Notice("请先选择文本");
            return;
          }

          await this.activateView();
          const view = this.getAssistantView();
          if (view) {
            await view.sendPrompt(text);
          }
        },
      });

      this.addCommand({
        id: "opencode-new-session",
        name: "OpenCode: 新建会话",
        callback: async () => {
          const session = await this.createSession("新会话");
          this.sessionStore.setActiveSession(session.id);
          await this.persistState();

          const view = this.getAssistantView();
          if (view) view.render();
        },
      });

      this.addSettingTab(new OpenCodeSettingsTab(this.app, this));

      await this.bootstrapData();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[opencode-assistant] load failed", error);
      new Notice(`OpenCode Assistant 加载失败: ${msg}`);
    }
  }

  async onunload() {
    await this.opencodeClient.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  log(line) {
    if (!this.settings.debugLogs) return;
    console.log("[opencode-assistant]", line);
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    const byMethod = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
    const byField = adapter && adapter.basePath ? adapter.basePath : "";
    const resolved = byMethod || byField;
    if (!resolved) {
      throw new Error("仅支持本地文件系统 Vault");
    }
    return resolved;
  }

  getPluginRootDir() {
    const vaultPath = this.getVaultPath();
    const configDir = this.app && this.app.vault && this.app.vault.configDir
      ? String(this.app.vault.configDir)
      : ".obsidian";
    const id = this.manifest && this.manifest.id ? String(this.manifest.id) : "opencode-assistant";

    const candidates = [
      path.join(vaultPath, configDir, "plugins", id),
      this.manifest && this.manifest.dir ? String(this.manifest.dir) : "",
      __dirname,
      path.resolve(__dirname, ".."),
    ].filter(Boolean);

    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
    }
    return candidates[0] || __dirname;
  }

  getBundledSkillsRoot() {
    return path.join(this.getPluginRootDir(), "bundled-skills");
  }

  listBundledSkillIds(rootDir = this.getBundledSkillsRoot()) {
    if (!fs.existsSync(rootDir)) return [];

    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry && entry.isDirectory() && !String(entry.name || "").startsWith("."))
      .map((entry) => String(entry.name || "").trim())
      .filter(Boolean)
      .filter((id) => fs.existsSync(path.join(rootDir, id, "SKILL.md")))
      .sort((a, b) => a.localeCompare(b));
  }

  syncBundledSkills(vaultPath) {
    const bundledRoot = this.getBundledSkillsRoot();
    const bundledIds = this.listBundledSkillIds(bundledRoot);

    this.skillService.setAllowedSkillIds(bundledIds);
    if (!bundledIds.length) {
      return {
        synced: 0,
        total: 0,
        targetRoot: path.join(vaultPath, this.settings.skillsDir),
        bundledRoot,
        errors: [`未找到内置 skills 源目录或目录为空：${bundledRoot}`],
      };
    }

    const targetRoot = path.join(vaultPath, this.settings.skillsDir);
    fs.mkdirSync(targetRoot, { recursive: true });

    const errors = [];
    for (const skillId of bundledIds) {
      const srcDir = path.join(bundledRoot, skillId);
      const destDir = path.join(targetRoot, skillId);
      try {
        fs.rmSync(destDir, { recursive: true, force: true });
        copyDirectoryRecursive(srcDir, destDir);
      } catch (error) {
        errors.push(`${skillId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      synced: bundledIds.length - errors.length,
      total: bundledIds.length,
      targetRoot,
      bundledRoot,
      errors,
    };
  }

  getAssistantView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (!leaves.length) return null;
    return leaves[0].view;
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) {
      await this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadPersistedData() {
    const raw = (await this.loadData()) || {};

    if (raw.settings || raw.runtimeState) {
      this.settings = normalizeSettings(raw.settings || {});
      this.runtimeState = raw.runtimeState || { sessions: [], activeSessionId: "", messagesBySession: {} };
      return;
    }

    this.settings = normalizeSettings(raw);
    this.runtimeState = { sessions: [], activeSessionId: "", messagesBySession: {} };
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    this.skillService.updateSettings(this.settings);
    this.opencodeClient.updateSettings(this.settings);
    await this.persistState();
  }

  async persistState() {
    await this.saveData({
      settings: this.settings,
      runtimeState: this.runtimeState,
    });
  }

  async reloadSkills() {
    const vaultPath = this.getVaultPath();
    const syncResult = this.syncBundledSkills(vaultPath);
    console.log(
      `[opencode-assistant] bundled skills reload: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
      `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
    );
    if (syncResult.errors.length) this.log(`bundled skills sync: ${syncResult.errors.join("; ")}`);
    this.skillService.loadSkills();
    const view = this.getAssistantView();
    if (view) view.render();
    return syncResult;
  }

  async createSession(title) {
    const created = await this.opencodeClient.createSession(title || "");
    const session = {
      id: created.id,
      title: created.title || title || "新会话",
      updatedAt: Date.now(),
    };

    this.sessionStore.upsertSession(session);
    await this.persistState();
    return session;
  }

  async syncSessionsFromRemote() {
    try {
      const remote = await this.opencodeClient.listSessions();
      remote.forEach((s) => {
        this.sessionStore.upsertSession({
          id: s.id,
          title: s.title || "未命名会话",
          updatedAt: s.time?.updated || Date.now(),
        });
      });

      const state = this.sessionStore.getState();
      if (!state.activeSessionId && state.sessions.length) {
        state.activeSessionId = state.sessions[0].id;
      }

      await this.persistState();
    } catch (error) {
      this.log(`sync sessions failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async bootstrapData() {
    const vaultPath = this.getVaultPath();
    const syncResult = this.syncBundledSkills(vaultPath);
    if (!syncResult.errors.length) {
      console.log(
        `[opencode-assistant] bundled skills bootstrap: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
        `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
      );
    }
    if (syncResult.errors.length) this.log(`bundled skills bootstrap sync: ${syncResult.errors.join("; ")}`);
    this.skillService.loadSkills();

    try {
      this.cachedModels = await this.opencodeClient.listModels();
    } catch {
      this.cachedModels = [];
    }

    await this.syncSessionsFromRemote();
  }
};
