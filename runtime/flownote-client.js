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
    if (!options || typeof options.SdkTransport !== "function") {
      throw new Error(rt(
        "FLOWnoteClient 需要注入 SdkTransport 构造器",
        "FLOWnoteClient requires injected SdkTransport constructor",
      ));
    }
    this.SdkTransport = options.SdkTransport;
    this.settings = options.settings;
    this.logger = options.logger || (() => {});
    this.sdk = new this.SdkTransport(options);
    this.lastMode = "sdk";
    this.lastError = "";
  }

  updateSettings(settings) {
    this.settings = settings;
    this.sdk.updateSettings(settings);
  }

  primary() {
    return this.sdk;
  }

  async withTransport(actionName, fn) {
    const primary = this.primary();
    const primaryMode = "sdk";
    try {
      const out = await fn(primary);
      this.logger(`action=${actionName} mode=${primaryMode} ok`);
      this.lastMode = primaryMode;
      this.lastError = "";
      return out;
    } catch (e1) {
      this.logger(`action=${actionName} mode=${primaryMode} err=${e1 instanceof Error ? e1.message : String(e1)}`);
      this.lastError = e1 instanceof Error ? e1.message : String(e1);
      throw e1;
    }
  }

  testConnection() {
    return this.withTransport("testConnection", (t) => t.testConnection());
  }
  listSessions() {
    return this.withTransport("listSessions", (t) => t.listSessions());
  }
  listSessionMessages(options = {}) {
    return this.withTransport("listSessionMessages", (t) => t.listSessionMessages(options));
  }
  getSessionDiff(options = {}) {
    return this.withTransport("getSessionDiff", (t) => t.getSessionDiff(options));
  }
  createSession(title) {
    return this.withTransport("createSession", (t) => t.createSession(title));
  }
  listModels() {
    return this.withTransport("listModels", (t) => t.listModels());
  }
  setDefaultModel(options) {
    return this.withTransport("setDefaultModel", (t) => t.setDefaultModel(options));
  }
  sendMessage(options) {
    return this.withTransport("sendMessage", (t) => t.sendMessage(options));
  }
  listQuestions(options = {}) {
    return this.withTransport("listQuestions", (t) => t.listQuestions(options));
  }
  replyQuestion(options) {
    return this.withTransport("replyQuestion", (t) => t.replyQuestion(options));
  }
  replyPermission(options) {
    return this.withTransport("replyPermission", (t) => t.replyPermission(options));
  }
  listProviders() {
    return this.withTransport("listProviders", (t) => t.listProviders());
  }
  listProviderAuthMethods() {
    return this.withTransport("listProviderAuthMethods", (t) => t.listProviderAuthMethods());
  }
  authorizeProviderOauth(options) {
    return this.withTransport("authorizeProviderOauth", (t) => t.authorizeProviderOauth(options));
  }
  completeProviderOauth(options) {
    return this.withTransport("completeProviderOauth", (t) => t.completeProviderOauth(options));
  }
  setProviderApiKeyAuth(options) {
    return this.withTransport("setProviderApiKeyAuth", (t) => t.setProviderApiKeyAuth(options));
  }
  clearProviderAuth(options) {
    return this.withTransport("clearProviderAuth", (t) => t.clearProviderAuth(options));
  }
  async stop() {
    await this.sdk.stop();
  }
}


module.exports = { FLOWnoteClient };
