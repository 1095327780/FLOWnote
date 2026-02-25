const { Notice, openExternal } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const {
  InputPromptModal,
  ConfirmModal,
  SelectPromptModal,
  ConflictResolutionModal,
} = require("./modals");

class ProviderAuthActionsMethods {
  async pickOauthMethod(providerName, oauthMethods) {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    if (!oauthMethods.length) return null;
    if (oauthMethods.length === 1) return oauthMethods[0];

    const options = oauthMethods.map((item) => ({
      value: String(item.index),
      label: String(item.label || `OAuth ${item.index + 1}`),
    }));
    const pickedValue = await this.showSelectModal({
      title: t("settings.providerAuth.pickOauthTitle", "选择 {providerName} 的 OAuth 登录方式", { providerName }),
      description: t("settings.providerAuth.pickOauthDesc", "请选择一种 OAuth 鉴权方式。"),
      options,
      defaultValue: String(oauthMethods[0].index),
      submitText: t("settings.providerAuth.continue", "继续"),
    });
    if (pickedValue === null) return null;

    const picked = oauthMethods.find((item) => String(item.index) === String(pickedValue));
    if (!picked) throw new Error(t("settings.providerAuth.invalidOauthMethod", "无效的 OAuth 方式序号"));
    return picked;
  }

  async handleOauthLogin(context) {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const { providerID, providerName, oauthMethods, rowStatus } = context;
    const picked = await this.pickOauthMethod(providerName, oauthMethods);
    if (!picked) {
      rowStatus.setText(t("settings.providerAuth.oauthCanceled", "已取消 OAuth 登录。"));
      return;
    }

    rowStatus.setText(t("settings.providerAuth.oauthCreatingLink", "正在创建授权链接..."));
    const authorization = await this.plugin.opencodeClient.authorizeProviderOauth({
      providerID,
      method: picked.index,
    });

    const authUrl = String(authorization && authorization.url ? authorization.url : "").trim();
    const mode = String(authorization && authorization.method ? authorization.method : "code").trim();
    const instructions = String(authorization && authorization.instructions ? authorization.instructions : "").trim();

    if (!authUrl) {
      throw new Error(t("settings.providerAuth.oauthMissingUrl", "未获取到 OAuth 授权链接"));
    }

    const opened = await this.openAuthorizationUrl(authUrl);
    if (opened) {
      new Notice(t("settings.providerAuth.oauthOpened", "已打开 {providerName} 授权页面", { providerName }));
    } else {
      await this.copyToClipboard(authUrl);
      new Notice(t("settings.providerAuth.oauthCopied", "无法自动打开浏览器，授权链接已复制到剪贴板。"));
    }

    let code = "";
    if (mode === "code") {
      const input = await this.showInputModal({
        title: t("settings.providerAuth.oauthCallbackTitle", "{providerName} OAuth 回调", { providerName }),
        description: instructions || t("settings.providerAuth.oauthCallbackDesc", "请在浏览器完成授权后粘贴 code。"),
        placeholder: t("settings.providerAuth.oauthCallbackPlaceholder", "粘贴授权 code"),
        submitText: t("settings.providerAuth.submit", "提交"),
      });
      if (input === null) {
        rowStatus.setText(t("settings.providerAuth.oauthCanceled", "已取消 OAuth 登录。"));
        return;
      }
      code = String(input || "").trim();
      if (!code) {
        rowStatus.setText(t("settings.providerAuth.oauthCodeMissing", "未填写授权 code，已取消。"));
        return;
      }
    } else {
      const confirmed = await this.showConfirmModal({
        title: t("settings.providerAuth.oauthCallbackTitle", "{providerName} OAuth 回调", { providerName }),
        description: `${instructions || t("settings.providerAuth.oauthCompleteInBrowser", "请在浏览器完成授权。")}\n\n${t("settings.providerAuth.oauthThenConfirm", "完成后点击“确认”继续。")}`,
        submitText: t("settings.providerAuth.confirm", "确认"),
      });
      if (!confirmed) {
        rowStatus.setText(t("settings.providerAuth.oauthCanceled", "已取消 OAuth 登录。"));
        return;
      }
    }

    rowStatus.setText(t("settings.providerAuth.oauthSubmitting", "正在提交 OAuth 回调..."));
    await this.plugin.opencodeClient.completeProviderOauth({
      providerID,
      method: picked.index,
      code: code || undefined,
    });
    rowStatus.setText(t("settings.providerAuth.oauthDone", "OAuth 登录完成。"));
    new Notice(t("settings.providerAuth.oauthSuccess", "{providerName} 登录成功", { providerName }));
  }

  async handleApiKeySet(context) {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    const { providerID, providerName, rowStatus } = context;
    const key = await this.showInputModal({
      title: t("settings.providerAuth.apiKeyTitle", "设置 {providerName} API Key", { providerName }),
      description: t(
        "settings.providerAuth.apiKeyDesc",
        "请输入该 Provider 的 API Key（仅保存在本地 FLOWnote 凭据中）。",
      ),
      placeholder: t("settings.providerAuth.apiKeyPlaceholder", "输入 API Key"),
      password: true,
      submitText: t("settings.providerAuth.save", "保存"),
    });
    if (key === null) {
      rowStatus.setText(t("settings.providerAuth.apiKeyCanceled", "已取消 API Key 设置。"));
      return;
    }

    const trimmed = String(key || "").trim();
    if (!trimmed) {
      rowStatus.setText(t("settings.providerAuth.apiKeyEmpty", "API Key 不能为空。"));
      return;
    }

    rowStatus.setText(t("settings.providerAuth.apiKeySaving", "正在保存 API Key..."));
    await this.plugin.opencodeClient.setProviderApiKeyAuth({
      providerID,
      key: trimmed,
    });
    rowStatus.setText(t("settings.providerAuth.apiKeySaved", "API Key 已保存。"));
    new Notice(t("settings.providerAuth.apiKeySavedNotice", "{providerName} API Key 已保存", { providerName }));
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

  showConflictResolutionModal(options) {
    return new Promise((resolve) => {
      const modal = new ConflictResolutionModal(this.app, options, resolve);
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
