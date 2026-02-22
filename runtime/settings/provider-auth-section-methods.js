const { Notice } = require("obsidian");

class ProviderAuthSectionMethods {
  renderProviderAuthSection(containerEl) {
    containerEl.createEl("h3", { text: "Provider 登录管理（OAuth / API Key）" });
    containerEl.createEl("p", {
      text: "用于在插件内连接官方/第三方模型 provider。完成后会写入当前插件运行时的 FLOWnote 凭据。",
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

}

const providerAuthSectionMethods = {};
for (const key of Object.getOwnPropertyNames(ProviderAuthSectionMethods.prototype)) {
  if (key === "constructor") continue;
  providerAuthSectionMethods[key] = ProviderAuthSectionMethods.prototype[key];
}

module.exports = { providerAuthSectionMethods };
