const { rt } = (() => {
  try {
    return require("./runtime-locale-state");
  } catch (_e) {
    return {
      rt: (_zh, en, params = {}) => String(en || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k) => {
        const value = params[k];
        return value === undefined || value === null ? "" : String(value);
      }),
    };
  }
})();

class FLOWnoteClient {
  constructor(options) {
    if (!options || typeof options.SdkTransport !== "function" || typeof options.CompatTransport !== "function") {
      throw new Error(rt(
        "FLOWnoteClient 需要注入 SdkTransport 和 CompatTransport 构造器",
        "FLOWnoteClient requires injected SdkTransport and CompatTransport constructors",
      ));
    }
    this.SdkTransport = options.SdkTransport;
    this.CompatTransport = options.CompatTransport;
    this.settings = options.settings;
    this.logger = options.logger || (() => {});
    this.sdk = new this.SdkTransport(options);
    this.compat = new this.CompatTransport(options);
    this.lastMode = "compat";
    this.lastError = "";
  }

  updateSettings(settings) {
    this.settings = settings;
    this.sdk.updateSettings(settings);
    this.compat.updateSettings(settings);
  }

  isExperimentalSdkEnabled() {
    if (!this.settings || typeof this.settings !== "object") return false;
    if (!Boolean(this.settings.experimentalSdkEnabled)) return false;
    return String(this.settings.transportMode || "").trim().toLowerCase() === "sdk";
  }

  primary() {
    if (this.isExperimentalSdkEnabled()) {
      return this.sdk;
    }
    return this.compat;
  }

  fallback() {
    if (this.isExperimentalSdkEnabled()) return this.compat;
    return null;
  }

  async withTransport(actionName, fn) {
    const primary = this.primary();
    const primaryMode = primary === this.sdk ? "sdk" : "compat";
    try {
      const out = await fn(primary);
      this.logger(`action=${actionName} mode=${primaryMode} ok`);
      this.lastMode = primaryMode;
      this.lastError = "";
      return out;
    } catch (e1) {
      const fb = this.fallback();
      if (!fb) {
        this.logger(`action=${actionName} mode=${primaryMode} err=${e1 instanceof Error ? e1.message : String(e1)}`);
        this.lastError = e1 instanceof Error ? e1.message : String(e1);
        throw e1;
      }

      const fallbackMode = fb === this.sdk ? "sdk" : "compat";
      try {
        const out = await fn(fb);
        this.lastMode = fallbackMode;
        this.lastError = "";
        return out;
      } catch (e2) {
        this.lastError = [
          rt(
            "[{actionName}] {mode}失败: {message}",
            "[{actionName}] {mode} failed: {message}",
            {
              actionName,
              mode: primaryMode.toUpperCase(),
              message: e1 instanceof Error ? e1.message : String(e1),
            },
          ),
          rt(
            "[{actionName}] {mode}失败: {message}",
            "[{actionName}] {mode} failed: {message}",
            {
              actionName,
              mode: fallbackMode.toUpperCase(),
              message: e2 instanceof Error ? e2.message : String(e2),
            },
          ),
        ].join(" | ");
        throw e2;
      }
    }
  }

  testConnection() {
    return this.withTransport("testConnection", (t) => t.testConnection());
  }
  listSessions() {
    return this.withTransport("listSessions", (t) => t.listSessions());
  }
  listSessionMessages(options = {}) {
    return this.withTransport("listSessionMessages", (t) => {
      if (typeof t.listSessionMessages === "function") return t.listSessionMessages(options);
      if (typeof t.fetchSessionMessages === "function") {
        return t.fetchSessionMessages(String(options.sessionId || ""), options).then((result) => {
          if (result && Array.isArray(result.list)) return result.list;
          return [];
        });
      }
      throw new Error(rt(
        "当前传输层不支持会话消息列表读取。",
        "Current transport does not support reading session message list.",
      ));
    });
  }
  createSession(title) {
    return this.withTransport("createSession", (t) => t.createSession(title));
  }
  listModels() {
    return this.withTransport("listModels", (t) => t.listModels());
  }
  setDefaultModel(options) {
    return this.withTransport("setDefaultModel", (t) => {
      if (typeof t.setDefaultModel === "function") return t.setDefaultModel(options);
      if (typeof t.switchModel === "function") return t.switchModel(options);
      return { ok: true, model: String(options && options.model ? options.model : "") };
    });
  }
  switchModel(options) {
    return this.setDefaultModel(options);
  }
  sendMessage(options) {
    return this.withTransport("sendMessage", (t) => t.sendMessage(options));
  }
  listQuestions(options = {}) {
    return this.withTransport("listQuestions", (t) => {
      if (typeof t.listQuestions === "function") return t.listQuestions(options);
      return [];
    });
  }
  replyQuestion(options) {
    return this.withTransport("replyQuestion", (t) => {
      if (typeof t.replyQuestion === "function") return t.replyQuestion(options);
      return { ok: false };
    });
  }
  replyPermission(options) {
    return this.withTransport("replyPermission", (t) => {
      if (typeof t.replyPermission === "function") return t.replyPermission(options);
      return { ok: false };
    });
  }
  listProviders() {
    return this.withTransport("listProviders", (t) => {
      if (typeof t.listProviders === "function") return t.listProviders();
      return { all: [], connected: [], default: {} };
    });
  }
  listProviderAuthMethods() {
    return this.withTransport("listProviderAuthMethods", (t) => {
      if (typeof t.listProviderAuthMethods === "function") return t.listProviderAuthMethods();
      return {};
    });
  }
  authorizeProviderOauth(options) {
    return this.withTransport("authorizeProviderOauth", (t) => {
      if (typeof t.authorizeProviderOauth === "function") return t.authorizeProviderOauth(options);
      throw new Error(rt(
        "当前传输层不支持 Provider OAuth 授权。",
        "Current transport does not support Provider OAuth authorization.",
      ));
    });
  }
  completeProviderOauth(options) {
    return this.withTransport("completeProviderOauth", (t) => {
      if (typeof t.completeProviderOauth === "function") return t.completeProviderOauth(options);
      throw new Error(rt(
        "当前传输层不支持 Provider OAuth 回调。",
        "Current transport does not support Provider OAuth callback.",
      ));
    });
  }
  setProviderApiKeyAuth(options) {
    return this.withTransport("setProviderApiKeyAuth", (t) => {
      if (typeof t.setProviderApiKeyAuth === "function") return t.setProviderApiKeyAuth(options);
      throw new Error(rt(
        "当前传输层不支持 Provider API Key 设置。",
        "Current transport does not support Provider API key setup.",
      ));
    });
  }
  clearProviderAuth(options) {
    return this.withTransport("clearProviderAuth", (t) => {
      if (typeof t.clearProviderAuth === "function") return t.clearProviderAuth(options);
      throw new Error(rt(
        "当前传输层不支持 Provider 凭据清除。",
        "Current transport does not support clearing Provider credentials.",
      ));
    });
  }
  async stop() {
    await this.sdk.stop();
    await this.compat.stop();
  }
}


module.exports = { FLOWnoteClient };
