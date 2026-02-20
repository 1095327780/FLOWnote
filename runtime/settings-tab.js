const {
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  openExternal,
} = require("obsidian");

class InputPromptModal extends Modal {
  constructor(app, options, onResolve) {
    super(app);
    this.options = options || {};
    this.onResolve = typeof onResolve === "function" ? onResolve : () => {};
    this.resolved = false;
  }

  resolve(value) {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(value);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: String(this.options.title || "请输入内容") });
    if (this.options.description) contentEl.createEl("p", { text: String(this.options.description) });

    const input = contentEl.createEl("input", {
      attr: {
        type: this.options.password ? "password" : "text",
        placeholder: String(this.options.placeholder || ""),
      },
    });
    input.style.width = "100%";
    input.value = String(this.options.value || "");

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";
    actions.style.marginTop = "12px";

    const cancelBtn = actions.createEl("button", { text: String(this.options.cancelText || "取消") });
    const submitBtn = actions.createEl("button", { text: String(this.options.submitText || "确定"), cls: "mod-cta" });

    cancelBtn.addEventListener("click", () => this.resolve(null));
    submitBtn.addEventListener("click", () => this.resolve(String(input.value || "")));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.resolve(String(input.value || ""));
      }
    });

    setTimeout(() => input.focus(), 0);
  }

  onClose() {
    if (!this.resolved) this.onResolve(null);
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(app, options, onResolve) {
    super(app);
    this.options = options || {};
    this.onResolve = typeof onResolve === "function" ? onResolve : () => {};
    this.resolved = false;
  }

  resolve(value) {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(Boolean(value));
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: String(this.options.title || "确认操作") });
    if (this.options.description) contentEl.createEl("p", { text: String(this.options.description) });

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";
    actions.style.marginTop = "12px";

    const cancelBtn = actions.createEl("button", { text: String(this.options.cancelText || "取消") });
    const submitBtn = actions.createEl("button", { text: String(this.options.submitText || "确认"), cls: "mod-cta" });
    cancelBtn.addEventListener("click", () => this.resolve(false));
    submitBtn.addEventListener("click", () => this.resolve(true));
  }

  onClose() {
    if (!this.resolved) this.onResolve(false);
    this.contentEl.empty();
  }
}

class SelectPromptModal extends Modal {
  constructor(app, options, onResolve) {
    super(app);
    this.options = options || {};
    this.onResolve = typeof onResolve === "function" ? onResolve : () => {};
    this.resolved = false;
  }

  resolve(value) {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(value);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    const options = Array.isArray(this.options.options) ? this.options.options : [];

    contentEl.empty();
    contentEl.createEl("h2", { text: String(this.options.title || "请选择") });
    if (this.options.description) contentEl.createEl("p", { text: String(this.options.description) });

    const select = contentEl.createEl("select");
    select.style.width = "100%";
    select.style.marginTop = "8px";
    options.forEach((item) => {
      select.createEl("option", {
        value: String(item.value),
        text: String(item.label || item.value),
      });
    });
    if (this.options.defaultValue !== undefined && this.options.defaultValue !== null) {
      select.value = String(this.options.defaultValue);
    }

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";
    actions.style.marginTop = "12px";

    const cancelBtn = actions.createEl("button", { text: String(this.options.cancelText || "取消") });
    const submitBtn = actions.createEl("button", { text: String(this.options.submitText || "确定"), cls: "mod-cta" });
    cancelBtn.addEventListener("click", () => this.resolve(null));
    submitBtn.addEventListener("click", () => this.resolve(String(select.value || "")));
    select.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.resolve(String(select.value || ""));
      }
    });
  }

  onClose() {
    if (!this.resolved) this.onResolve(null);
    this.contentEl.empty();
  }
}

class OpenCodeSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.providerSearchQuery = "";
    this.providerAuthSnapshot = null;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "OpenCode Assistant 设置" });
    containerEl.createEl("p", {
      text: "常用情况下只需要确认鉴权方式和连接状态。其余高级项一般保持默认即可。",
    });

    const isWindows = typeof process !== "undefined" && process.platform === "win32";
    const launchStrategyValue = String(this.plugin.settings.launchStrategy || "auto");
    const launchStrategyForUi = !isWindows && launchStrategyValue === "wsl" ? "auto" : launchStrategyValue;
    new Setting(containerEl)
      .setName("OpenCode CLI 路径（可选）")
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

    this.renderProviderAuthSection(containerEl);

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

  }

  renderProviderAuthSection(containerEl) {
    containerEl.createEl("h3", { text: "Provider 登录管理（OAuth / API Key）" });
    containerEl.createEl("p", {
      text: "用于在插件内连接官方/第三方模型 provider。完成后会写入当前插件运行时的 OpenCode 凭据。",
    });

    const controls = containerEl.createDiv();
    controls.style.display = "flex";
    controls.style.alignItems = "stretch";
    controls.style.flexWrap = "wrap";
    controls.style.gap = "8px";
    controls.style.marginBottom = "8px";

    const refreshBtn = controls.createEl("button", { text: "刷新 Provider 状态" });
    const expandBtn = controls.createEl("button", { text: "全部展开" });
    const collapseBtn = controls.createEl("button", { text: "全部收起" });
    const searchInput = controls.createEl("input", {
      attr: {
        type: "search",
        placeholder: "搜索 Provider / ID / 鉴权方式 / 模型数",
      },
    });
    searchInput.style.flex = "1 1 260px";
    searchInput.style.minWidth = "220px";
    searchInput.value = String(this.providerSearchQuery || "");

    const statusEl = containerEl.createDiv({ text: "加载中..." });
    statusEl.style.fontSize = "12px";
    statusEl.style.color = "var(--text-muted)";
    statusEl.style.marginBottom = "6px";

    const listEl = containerEl.createDiv();
    listEl.style.display = "flex";
    listEl.style.flexDirection = "column";
    listEl.style.gap = "8px";
    listEl.style.marginBottom = "12px";

    const renderFromSnapshot = () => {
      listEl.empty();

      const snapshot = this.providerAuthSnapshot;
      if (!snapshot) {
        statusEl.setText("尚未加载 Provider 信息。");
        return;
      }

      const query = this.normalizeSearchText(this.providerSearchQuery);
      let entries = snapshot.providers.map((provider) => (
        this.buildProviderEntry(provider, snapshot.connectedSet, snapshot.authMap)
      ));

      if (query) {
        entries = entries.filter((entry) => this.providerEntryMatchesQuery(entry, query));
      }

      const totalProviders = snapshot.providers.length;
      const visibleCount = entries.length;
      if (!entries.length) {
        statusEl.setText(query
          ? `已加载 ${totalProviders} 个 Provider，搜索“${this.providerSearchQuery}”无结果。`
          : `已加载 ${totalProviders} 个 Provider。`);
        listEl.createDiv({
          text: query ? "没有匹配的 Provider，请尝试更换关键词。" : "当前没有可显示的 Provider。",
          cls: "setting-item-description",
        });
        return;
      }

      const connectedCount = entries.filter((entry) => entry.isConnected).length;
      statusEl.setText(`已加载 ${totalProviders} 个 Provider，当前显示 ${visibleCount} 个；已连接 ${connectedCount} 个。`);

      const regionGroups = [
        { key: "domestic", label: "国产厂商", pick: (entry) => entry.region === "domestic" },
        { key: "global", label: "海外厂商", pick: (entry) => entry.region === "global" },
      ];

      regionGroups.forEach((group) => {
        const inGroup = entries.filter(group.pick);
        if (!inGroup.length) return;

        inGroup.sort((a, b) => a.providerName.localeCompare(b.providerName));

        const groupDetails = listEl.createEl("details");
        groupDetails.open = Boolean(query) || group.key === "domestic";
        groupDetails.style.border = "1px solid var(--background-modifier-border)";
        groupDetails.style.borderRadius = "8px";
        groupDetails.style.padding = "2px 0";

        const groupSummary = groupDetails.createEl("summary", { text: `${group.label} (${inGroup.length})` });
        groupSummary.style.padding = "8px 10px";
        groupSummary.style.cursor = "pointer";
        groupSummary.style.fontWeight = "600";

        const groupBody = groupDetails.createDiv();
        groupBody.style.display = "flex";
        groupBody.style.flexDirection = "column";
        groupBody.style.gap = "6px";
        groupBody.style.padding = "4px 6px 6px";

        inGroup.forEach((entry) => {
          this.renderProviderRow({
            listEl: groupBody,
            entry,
            reload: loadProviders,
          });
        });
      });
    };

    const toggleAllDetails = (open) => {
      listEl.querySelectorAll("details").forEach((node) => {
        node.open = open;
      });
    };

    const loadProviders = async () => {
      refreshBtn.disabled = true;
      refreshBtn.setText("刷新中...");
      expandBtn.disabled = true;
      collapseBtn.disabled = true;
      statusEl.setText("正在读取 Provider 配置...");
      listEl.empty();

      try {
        const providerResult = await this.plugin.opencodeClient.listProviders();
        const authMapResult = await this.plugin.opencodeClient.listProviderAuthMethods();

        const providers = Array.isArray(providerResult && providerResult.all) ? [...providerResult.all] : [];
        const connectedSet = new Set(
          Array.isArray(providerResult && providerResult.connected) ? providerResult.connected.map((id) => String(id)) : [],
        );
        const authMap = authMapResult && typeof authMapResult === "object" ? authMapResult : {};

        providers.sort((a, b) => String(a && a.name ? a.name : a && a.id ? a.id : "")
          .localeCompare(String(b && b.name ? b.name : b && b.id ? b.id : "")));
        this.providerAuthSnapshot = { providers, connectedSet, authMap };
        if (typeof this.plugin.refreshModelCatalog === "function") {
          await this.plugin.refreshModelCatalog({
            connectedProviders: connectedSet,
            providerResult,
          });
          const view = typeof this.plugin.getAssistantView === "function" ? this.plugin.getAssistantView() : null;
          if (view && typeof view.render === "function") view.render();
        }
        renderFromSnapshot();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        statusEl.setText(`读取失败：${msg}`);
        listEl.createDiv({ text: `读取 Provider 信息失败：${msg}`, cls: "setting-item-description" });
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.setText("刷新 Provider 状态");
        expandBtn.disabled = false;
        collapseBtn.disabled = false;
      }
    };

    searchInput.addEventListener("input", () => {
      this.providerSearchQuery = String(searchInput.value || "");
      renderFromSnapshot();
    });
    expandBtn.addEventListener("click", () => toggleAllDetails(true));
    collapseBtn.addEventListener("click", () => toggleAllDetails(false));
    refreshBtn.addEventListener("click", loadProviders);
    void loadProviders();
  }

  normalizeSearchText(value) {
    return String(value || "").trim().toLowerCase();
  }

  resolveProviderRegion(provider) {
    const text = `${String(provider && provider.id ? provider.id : "")} ${String(provider && provider.name ? provider.name : "")}`
      .toLowerCase();

    const domesticHints = [
      "qwen",
      "dashscope",
      "alibaba",
      "deepseek",
      "moonshot",
      "kimi",
      "zhipu",
      "glm",
      "chatglm",
      "hunyuan",
      "tencent",
      "doubao",
      "volc",
      "bytedance",
      "minimax",
      "baidu",
      "ernie",
      "siliconflow",
      "stepfun",
      "yi",
      "01.ai",
      "智谱",
      "通义",
      "豆包",
      "百川",
      "讯飞",
      "腾讯",
      "百度",
      "阿里",
      "月之暗面",
    ];

    return domesticHints.some((hint) => text.includes(hint)) ? "domestic" : "global";
  }

  buildProviderEntry(provider, connectedSet, authMap) {
    const providerID = String(provider && provider.id ? provider.id : "").trim();
    const providerName = String(provider && provider.name ? provider.name : providerID || "unknown");
    const methodsRaw = Array.isArray(authMap && authMap[providerID]) ? authMap[providerID] : [];
    const oauthMethods = methodsRaw
      .map((m, idx) => ({ index: idx, type: String(m && m.type ? m.type : ""), label: String(m && m.label ? m.label : `OAuth ${idx + 1}`) }))
      .filter((m) => m.type === "oauth");
    const supportsApi = methodsRaw.some((m) => String(m && m.type ? m.type : "") === "api");
    const isConnected = connectedSet instanceof Set ? connectedSet.has(providerID) : false;
    const modelCount = provider && provider.models && typeof provider.models === "object"
      ? Object.keys(provider.models).length
      : 0;
    const methodText = methodsRaw.length
      ? methodsRaw.map((m) => String(m && m.label ? m.label : m && m.type ? m.type : "unknown")).join(" / ")
      : "未提供鉴权方式";
    const region = this.resolveProviderRegion(provider);

    return {
      provider,
      providerID,
      providerName,
      methodsRaw,
      oauthMethods,
      supportsApi,
      isConnected,
      modelCount,
      methodText,
      region,
    };
  }

  providerEntryMatchesQuery(entry, query) {
    if (!query) return true;
    const content = [
      entry.providerName,
      entry.providerID,
      entry.methodText,
      `模型 ${entry.modelCount}`,
      entry.isConnected ? "已连接" : "未连接",
    ]
      .join(" ")
      .toLowerCase();
    return content.includes(query);
  }

  renderProviderRow(context) {
    const { listEl, entry, reload } = context;
    const {
      providerID,
      providerName,
      methodsRaw,
      oauthMethods,
      supportsApi,
      isConnected,
      modelCount,
      methodText,
    } = entry;
    if (!providerID) return;

    const row = listEl.createDiv();
    row.style.border = "1px solid var(--background-modifier-border)";
    row.style.borderRadius = "6px";
    row.style.padding = "8px 10px";

    const titleRow = row.createDiv();
    titleRow.style.display = "flex";
    titleRow.style.alignItems = "center";
    titleRow.style.justifyContent = "space-between";
    titleRow.style.gap = "8px";

    const titleLeft = titleRow.createDiv();
    titleLeft.style.display = "flex";
    titleLeft.style.alignItems = "center";
    titleLeft.style.gap = "8px";

    titleLeft.createEl("strong", { text: providerName });
    titleLeft.createSpan({ text: `(${providerID})`, cls: "setting-item-description" });

    const statusBadge = titleRow.createSpan({
      text: isConnected ? "已连接" : "未连接",
      cls: "setting-item-description",
    });
    statusBadge.style.color = isConnected ? "var(--text-success)" : "var(--text-muted)";

    const desc = row.createDiv({ cls: "setting-item-description" });
    desc.setText(`模型数：${modelCount}；鉴权方式：${methodText}`);

    const actionRow = row.createDiv();
    actionRow.style.display = "flex";
    actionRow.style.flexWrap = "wrap";
    actionRow.style.gap = "6px";
    actionRow.style.marginTop = "8px";

    const rowStatus = row.createDiv({ cls: "setting-item-description" });
    rowStatus.style.marginTop = "6px";

    const runAction = async (button, pendingText, action) => {
      button.disabled = true;
      const originalText = button.textContent || "";
      button.setText(pendingText);
      try {
        await action();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rowStatus.setText(`操作失败：${msg}`);
        new Notice(`操作失败: ${msg}`);
      } finally {
        button.disabled = false;
        button.setText(originalText);
      }
    };

    if (oauthMethods.length) {
      const oauthBtn = actionRow.createEl("button", { text: "OAuth 登录" });
      oauthBtn.addEventListener("click", () => {
        void runAction(oauthBtn, "处理中...", async () => {
          await this.handleOauthLogin({
            providerID,
            providerName,
            oauthMethods,
            rowStatus,
          });
          if (typeof this.plugin.clearUnavailableModels === "function") {
            this.plugin.clearUnavailableModels({ providerID });
          }
          await reload();
        });
      });
    }

    if (supportsApi || !methodsRaw.length) {
      const apiBtn = actionRow.createEl("button", { text: "设置 API Key" });
      apiBtn.addEventListener("click", () => {
        void runAction(apiBtn, "保存中...", async () => {
          await this.handleApiKeySet({
            providerID,
            providerName,
            rowStatus,
          });
          if (typeof this.plugin.clearUnavailableModels === "function") {
            this.plugin.clearUnavailableModels({ providerID });
          }
          await reload();
        });
      });
    }

    if (isConnected) {
      const clearBtn = actionRow.createEl("button", { text: "清除登录" });
      clearBtn.addEventListener("click", () => {
        void runAction(clearBtn, "清除中...", async () => {
          const confirmed = await this.showConfirmModal({
            title: `清除 ${providerName} 登录`,
            description: "确认清除该 Provider 的登录凭据？",
            submitText: "清除",
          });
          if (!confirmed) return;
          await this.plugin.opencodeClient.clearProviderAuth({ providerID });
          if (typeof this.plugin.clearUnavailableModels === "function") {
            this.plugin.clearUnavailableModels({ providerID });
          }
          rowStatus.setText("已清除登录凭据。");
          new Notice(`${providerName} 凭据已清除`);
          await reload();
        });
      });
    }
  }

  async pickOauthMethod(providerName, oauthMethods) {
    if (!oauthMethods.length) return null;
    if (oauthMethods.length === 1) return oauthMethods[0];

    const options = oauthMethods.map((item) => ({
      value: String(item.index),
      label: String(item.label || `OAuth ${item.index + 1}`),
    }));
    const pickedValue = await this.showSelectModal({
      title: `选择 ${providerName} 的 OAuth 登录方式`,
      description: "请选择一种 OAuth 鉴权方式。",
      options,
      defaultValue: String(oauthMethods[0].index),
      submitText: "继续",
    });
    if (pickedValue === null) return null;

    const picked = oauthMethods.find((item) => String(item.index) === String(pickedValue));
    if (!picked) throw new Error("无效的 OAuth 方式序号");
    return picked;
  }

  async handleOauthLogin(context) {
    const { providerID, providerName, oauthMethods, rowStatus } = context;
    const picked = await this.pickOauthMethod(providerName, oauthMethods);
    if (!picked) {
      rowStatus.setText("已取消 OAuth 登录。");
      return;
    }

    rowStatus.setText("正在创建授权链接...");
    const authorization = await this.plugin.opencodeClient.authorizeProviderOauth({
      providerID,
      method: picked.index,
    });

    const authUrl = String(authorization && authorization.url ? authorization.url : "").trim();
    const mode = String(authorization && authorization.method ? authorization.method : "code").trim();
    const instructions = String(authorization && authorization.instructions ? authorization.instructions : "").trim();

    if (!authUrl) {
      throw new Error("未获取到 OAuth 授权链接");
    }

    const opened = await this.openAuthorizationUrl(authUrl);
    if (opened) {
      new Notice(`已打开 ${providerName} 授权页面`);
    } else {
      await this.copyToClipboard(authUrl);
      new Notice("无法自动打开浏览器，授权链接已复制到剪贴板。");
    }

    let code = "";
    if (mode === "code") {
      const input = await this.showInputModal({
        title: `${providerName} OAuth 回调`,
        description: instructions || "请在浏览器完成授权后粘贴 code。",
        placeholder: "粘贴授权 code",
        submitText: "提交",
      });
      if (input === null) {
        rowStatus.setText("已取消 OAuth 登录。");
        return;
      }
      code = String(input || "").trim();
      if (!code) {
        rowStatus.setText("未填写授权 code，已取消。");
        return;
      }
    } else {
      const confirmed = await this.showConfirmModal({
        title: `${providerName} OAuth 回调`,
        description: `${instructions || "请在浏览器完成授权。"}\n\n完成后点击“确认”继续。`,
        submitText: "确认",
      });
      if (!confirmed) {
        rowStatus.setText("已取消 OAuth 登录。");
        return;
      }
    }

    rowStatus.setText("正在提交 OAuth 回调...");
    await this.plugin.opencodeClient.completeProviderOauth({
      providerID,
      method: picked.index,
      code: code || undefined,
    });
    rowStatus.setText("OAuth 登录完成。");
    new Notice(`${providerName} 登录成功`);
  }

  async handleApiKeySet(context) {
    const { providerID, providerName, rowStatus } = context;
    const key = await this.showInputModal({
      title: `设置 ${providerName} API Key`,
      description: "请输入该 Provider 的 API Key（仅保存在本地 OpenCode 凭据中）。",
      placeholder: "输入 API Key",
      password: true,
      submitText: "保存",
    });
    if (key === null) {
      rowStatus.setText("已取消 API Key 设置。");
      return;
    }

    const trimmed = String(key || "").trim();
    if (!trimmed) {
      rowStatus.setText("API Key 不能为空。");
      return;
    }

    rowStatus.setText("正在保存 API Key...");
    await this.plugin.opencodeClient.setProviderApiKeyAuth({
      providerID,
      key: trimmed,
    });
    rowStatus.setText("API Key 已保存。");
    new Notice(`${providerName} API Key 已保存`);
  }

  async openAuthorizationUrl(url) {
    const value = String(url || "").trim();
    if (!value) return false;

    try {
      if (typeof openExternal === "function") {
        await openExternal(value);
        return true;
      }
    } catch {
    }

    try {
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(value, "_blank", "noopener,noreferrer");
        return true;
      }
    } catch {
    }

    return false;
  }

  async copyToClipboard(text) {
    const value = String(text || "");
    if (!value) return false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
    }
    return false;
  }

  showInputModal(options) {
    return new Promise((resolve) => {
      const modal = new InputPromptModal(this.app, options, resolve);
      modal.open();
    });
  }

  showConfirmModal(options) {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, options, resolve);
      modal.open();
    });
  }

  showSelectModal(options) {
    return new Promise((resolve) => {
      const modal = new SelectPromptModal(this.app, options, resolve);
      modal.open();
    });
  }
}

module.exports = { OpenCodeSettingsTab };
