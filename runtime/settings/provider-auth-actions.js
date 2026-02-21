const { Notice, openExternal } = require("obsidian");
const {
  InputPromptModal,
  ConfirmModal,
  SelectPromptModal,
} = require("./modals");

class ProviderAuthActionsMethods {
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

const providerAuthActionsMethods = {};
for (const key of Object.getOwnPropertyNames(ProviderAuthActionsMethods.prototype)) {
  if (key === "constructor") continue;
  providerAuthActionsMethods[key] = ProviderAuthActionsMethods.prototype[key];
}

module.exports = { providerAuthActionsMethods };
